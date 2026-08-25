import { db, rows } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { sessionsForWorker } from './sessions.js'
import { lastRateLimit } from './quota.js'
import { log } from './log.js'

/**
 * The compaction reserve, and everything that depends on knowing how much window is left.
 *
 * ⛔ **`/compact` fails at true 100%.** A worker that reaches exhaustion while holding a large session
 * strands that context: it cannot be compacted, cannot continue, and its cache expires long before
 * the window resets. Running out of room to *finish* a task is recoverable. Running out of room to
 * *save* one is not.
 *
 * So the reserve is a **standing gate**, checked continuously rather than only at assignment:
 *
 * ```
 * worker.remaining  >=  Σ over live sessions of (0.1·C + 5·S)
 * ```
 *
 * ⚠️ And the honest part: on Claude Code there is no free live percentage, so `remaining` is often
 * **unknown**. This module says so rather than guessing. An unknown reserve is a different state from
 * a satisfied one, and the scheduler is told which it is.
 */

export type ReserveVerdict = 'ok' | 'at_risk' | 'unknown'

export interface ReserveState {
  workerId: string
  verdict: ReserveVerdict
  /** Input-token-equivalents needed to compact everything this worker is currently holding. */
  requiredTokens: number
  /** What we believe is left, or null when nothing trustworthy says. */
  remainingTokens: number | null
  liveSessions: number
  reason: string
}

/** The cost of saving everything this worker holds right now. Always knowable - it is our own data. */
export function requiredReserve(workerId: string): { tokens: number; sessions: number } {
  const sessions = sessionsForWorker(workerId)
  let tokens = 0
  for (const session of sessions) {
    const model = costModel(adapter(session.adapterId).info.policy.costModelId)
    tokens += model.costOfCompact({ contextTokens: session.contextTokens, model: session.model })
  }
  return { tokens: Math.round(tokens), sessions: sessions.length }
}

/**
 * Tokens this worker has spent inside its current rolling window, summed from the transcripts we
 * metered ourselves. Exact, and available even when no percentage is.
 *
 * ⚠️ Not the same as "what the vendor counts" - server-side work that never reaches a transcript, the
 * auto-mode classifier among it, is invisible here. It is a **floor**, not a total, and callers must
 * treat it as one.
 */
export function tokensSpentInWindow(workerId: string, windowStartedAt: number): number {
  const row = db()
    .prepare(
      `select coalesce(sum(t.input_tokens + t.output_tokens + t.cache_read_tokens
                           + t.cache_write_1h_tokens + t.cache_write_5m_tokens), 0) as total
         from turns t
         join sessions s on s.id = t.session_id
        where s.worker_id = ? and t.ts >= ?`
    )
    .get(workerId, windowStartedAt) as { total: number }
  return row.total
}

/** The learned percent→token conversion, if enough samples exist for this exact combination. */
export function tokensPerPercent(
  workerId: string,
  model: string,
  tokenizer: string
): { value: number; samples: number } | null {
  const row = db()
    .prepare(
      'select tokens_per_percent, samples from calibration where worker_id = ? and model = ? and tokenizer = ?'
    )
    .get(workerId, model, tokenizer) as { tokens_per_percent: number; samples: number } | undefined
  if (!row || row.samples < 3) return null
  return { value: row.tokens_per_percent, samples: row.samples }
}

/**
 * Record a calibration sample.
 *
 * ⛔ Only ever called when **exactly one session was active on that worker** across the sampled span.
 * Two sessions make the percentage a sum and the attribution a guess. Token attribution *to a task*
 * is always exact from its own transcript; only this calibration needs the isolation.
 */
export function recordCalibration(input: {
  workerId: string
  model: string
  tokenizer: string
  tokens: number
  percentDelta: number
}): void {
  if (input.percentDelta <= 0 || input.tokens <= 0) return
  const observed = input.tokens / input.percentDelta

  const existing = db()
    .prepare('select tokens_per_percent, samples from calibration where worker_id = ? and model = ? and tokenizer = ?')
    .get(input.workerId, input.model, input.tokenizer) as
    | { tokens_per_percent: number; samples: number }
    | undefined

  // A rolling mean rather than a replacement: one odd window should move the estimate, not become it.
  const samples = (existing?.samples ?? 0) + 1
  const value = existing
    ? existing.tokens_per_percent + (observed - existing.tokens_per_percent) / samples
    : observed

  db()
    .prepare(
      `insert into calibration (worker_id, model, tokenizer, tokens_per_percent, samples, updated_at)
       values (?,?,?,?,?,?)
       on conflict(worker_id, model, tokenizer) do update set
         tokens_per_percent = excluded.tokens_per_percent,
         samples = excluded.samples,
         updated_at = excluded.updated_at`
    )
    .run(input.workerId, input.model, input.tokenizer, value, samples, Date.now())
  log.info(
    `calibration ${input.workerId.slice(0, 8)}/${input.model}: ` +
      `${Math.round(value)} tokens per percent (${samples} samples)`
  )
}

/**
 * What is left on this worker, in tokens, or null.
 *
 * Three rungs, most trustworthy first, and the rung is reported rather than hidden:
 *   1. a **fresh** percentage plus a calibration for this exact (worker, model, tokenizer)
 *   2. nothing usable — a live `rate_limit_event` gives a *status* and a reset time but no size
 *   3. nothing at all
 */
export function remainingTokens(workerId: string): { tokens: number | null; basis: string } {
  const quotaRow = db()
    .prepare(
      `select percent, sampled_at from quota_samples
        where worker_id = ? and window_id in ('session','5h') and percent > 0
        order by sampled_at desc limit 1`
    )
    .get(workerId) as { percent: number; sampled_at: number } | undefined

  const fresh = quotaRow && Date.now() - quotaRow.sampled_at < 15 * 60 * 1000
  if (!fresh) return { tokens: null, basis: 'no fresh percentage' }

  const modelRow = db()
    .prepare(
      `select t.model as model, t.tokenizer as tokenizer
         from turns t join sessions s on s.id = t.session_id
        where s.worker_id = ? and t.model is not null
        order by t.ts desc limit 1`
    )
    .get(workerId) as { model: string; tokenizer: string | null } | undefined
  if (!modelRow?.model) return { tokens: null, basis: 'no metered turn to calibrate against' }

  const calibration = tokensPerPercent(workerId, modelRow.model, modelRow.tokenizer ?? 'unknown')
  if (!calibration) return { tokens: null, basis: 'percent→token conversion not learned yet' }

  const remainingPercent = Math.max(0, 100 - quotaRow.percent)
  return {
    tokens: Math.round(remainingPercent * calibration.value),
    basis: `${Math.round(remainingPercent)}% × ${Math.round(calibration.value)} tok/% (${calibration.samples} samples)`
  }
}

export function reserveState(workerId: string): ReserveState {
  const { tokens: required, sessions } = requiredReserve(workerId)
  const { tokens: remaining, basis } = remainingTokens(workerId)

  if (sessions === 0) {
    return {
      workerId,
      verdict: 'ok',
      requiredTokens: 0,
      remainingTokens: remaining,
      liveSessions: 0,
      reason: 'nothing to save'
    }
  }

  if (remaining === null) {
    // ⚠️ Unknown is not "fine". It is reported as its own verdict so the scheduler can be cautious
    // rather than confident, and so the UI never renders a reassuring green on a guess.
    const rate = lastRateLimit(workerId)
    return {
      workerId,
      verdict: 'unknown',
      requiredTokens: required,
      remainingTokens: null,
      liveSessions: sessions,
      reason:
        `${basis}` +
        (rate ? ` · last live status: ${rate.status}` : '') +
        ` · would need ${required} tokens to save ${sessions} session(s)`
    }
  }

  return {
    workerId,
    verdict: remaining >= required ? 'ok' : 'at_risk',
    requiredTokens: required,
    remainingTokens: remaining,
    liveSessions: sessions,
    reason: `${remaining} left vs ${required} needed to save ${sessions} session(s) · ${basis}`
  }
}

/** Every worker with live sessions, for the watchdog and the UI. */
export function reserveStates(workerIds: string[]): ReserveState[] {
  return workerIds.map(reserveState)
}

export function recentClockEvents(limit = 50): Array<{
  sessionId: string
  move: string
  reason: string
  contextTokens: number | null
  estimatedCost: number | null
  ts: number
}> {
  return rows<{
    session_id: string
    move: string
    reason: string
    context_tokens: number | null
    estimated_cost: number | null
    ts: number
  }>(db().prepare('select * from clock_events order by ts desc limit ?').all(limit)).map((r) => ({
    sessionId: r.session_id,
    move: r.move,
    reason: r.reason,
    contextTokens: r.context_tokens,
    estimatedCost: r.estimated_cost,
    ts: r.ts
  }))
}
