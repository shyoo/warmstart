import type { QuotaWindow } from '@shared/protocol.js'
import { windowHighWater } from '@shared/tasks.js'
import { db, rows } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { sessionsForWorker } from './sessions.js'
import { lastQuota, lastRateLimit, windowsForPool, windowExpired } from './quota.js'
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

/**
 * The cost of saving everything this worker holds right now.
 *
 * ⚠️ No longer "always knowable", and M5 is why. A provider whose cache cannot be priced, or that has
 * no compaction to run, has no saving cost to reserve for - so it contributes nothing, and
 * `unpriced` counts how many sessions were skipped. A caller that saw only the total would read a
 * small number as *cheap to save* when it actually means *nobody knows*.
 */
export function requiredReserve(workerId: string): {
  tokens: number
  sessions: number
  unpriced: number
} {
  const sessions = sessionsForWorker(workerId)
  let tokens = 0
  let unpriced = 0
  for (const session of sessions) {
    const model = costModel(adapter(session.adapterId).info.policy.costModelId)
    const cost = model.costOfCompact({ contextTokens: session.contextTokens, model: session.model })
    if (cost === null) {
      unpriced++
      continue
    }
    tokens += cost
  }
  return { tokens: Math.round(tokens), sessions: sessions.length, unpriced }
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

/**
 * How full is the window the sessions on this worker are actually drawing on?
 *
 * ⛔ **The rung that made the reserve reachable at all.** `remainingTokens` needs a learned
 * percent→token conversion (R2), the `calibration` table on this install is *empty*, and so every
 * worker holding a session has reported `unknown` since the reserve was written — which meant move 5
 * of the cache clock, "the reserve is at risk, compact now regardless", had never once fired.
 * Measured 2026-08-31 (t73): at 17:31 ClaudeThird read **92%** of its five-hour window, the routing
 * gate held t71 rather than dispatching it, and session `ef5e90dc` sat idle on that same account
 * holding **401,341** tokens of context which had never been compacted in nine and a half hours.
 * The `compactions` table was empty; `clock_events` had not gained a row in five days.
 *
 * ⚠️ **A percentage is not a token count, and this does not pretend otherwise.** It cannot say
 * whether what is left covers what saving costs - `remainingTokens` stays null and `requiredTokens`
 * keeps its own meaning. It says the one thing a percentage *can* say: this account is at the point
 * where the fleet has already stopped giving it new work, so whatever it is still holding should be
 * saved while there is window left to pay for saving it.
 *
 * ⚠️ **Per pool, via the sessions themselves.** Antigravity meters Gemini apart from Claude/GPT, so
 * a full Claude window says nothing about a live Gemini session; the worst window any live session
 * on this worker draws from is the one that decides. A stale sample and a window whose reset has
 * already passed are both refused, exactly as the dispatch gate refuses them - a number nobody
 * re-read may not move a decision.
 */
export function windowPressure(
  workerId: string
): { percent: number; label: string; threshold: number; sampledAt: number } | null {
  const quota = lastQuota(workerId)
  if (!quota || quota.stale || quota.windows.length === 0) return null

  const pools = new Set<string | null>()
  for (const session of sessionsForWorker(workerId)) pools.add(poolOf(session))
  if (pools.size === 0) return null

  let worst: { window: QuotaWindow; threshold: number; deficit: number } | null = null
  for (const pool of pools) {
    const windows = windowsForPool(quota.windows, pool)
    for (const window of windows) {
      if (!window || windowExpired(window)) continue
      const threshold = windowHighWater(window)
      const deficit = window.percent - threshold
      if (!worst || deficit > worst.deficit) {
        worst = { window, threshold, deficit }
      }
    }
  }
  return worst
    ? {
        percent: worst.window.percent,
        label: worst.window.label || worst.window.id,
        threshold: worst.threshold,
        sampledAt: quota.sampledAt
      }
    : null
}

/**
 * Which metered pool a session's model draws on, or `null` where the provider meters only one.
 *
 * ⚠️ Read from the cost model rather than inferred from the model's name, for the reason `poolFor`
 * in the scheduler gives: `claude-*` and `gemini-*` look like a rule until a vendor breaks it.
 */
function poolOf(session: { adapterId: string; model: string | null }): string | null {
  if (!session.model) return null
  try {
    return costModel(adapter(session.adapterId).info.policy.costModelId).modelSpec(session.model)
      ?.pool ?? null
  } catch {
    return null
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

  // ⛔ Before the token rungs, and it may overrule a satisfied one. `remaining` is derived from a
  // learned conversion that half this fleet has no samples for, and where it *is* known it answers
  // "does the window cover one compaction" - not "is this account still being given work". At the
  // high-water mark the answer to the second question is no, and a session left uncompacted there is
  // one the fleet has decided not to touch again until the window resets.
  const pressure = windowPressure(workerId)
  if (pressure && pressure.percent >= pressure.threshold) {
    return {
      workerId,
      verdict: 'at_risk',
      requiredTokens: required,
      remainingTokens: remaining,
      liveSessions: sessions,
      reason:
        `${Math.round(pressure.percent)}% of its ${pressure.label} window used - at or past the ` +
        `${pressure.threshold}% mark where this fleet stops sending it work, so the ` +
        `${sessions} session(s) it still holds should be saved now` +
        (remaining === null ? ` (${basis}, so this is the percentage rung)` : '')
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
