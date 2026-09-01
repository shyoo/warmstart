import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Session, Turn } from '@shared/protocol.js'
import { db } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { clearClockMove, getSession } from './sessions.js'
import { emit } from './events.js'
import { addMessage, creditTurn } from './tasks.js'
import { fillPostTokens, noteCompactionLanded } from './compaction.js'
import { clearDispatchFailure } from './workers.js'
import type { StreamUsage } from './stream.js'
import { log } from './log.js'

/**
 * The metering layer.
 *
 * This is where agentyard learns what a session actually cost, and it has to be exact - every
 * scheduling gate downstream is arithmetic over these numbers. Three traps, all avoidable, all
 * documented in docs/cost-model.md §6 and all handled below:
 *
 *  1. **Sum `usage.iterations[]`, not the top-level counts.** A compaction's own sampling iteration
 *     is excluded from the top level, so a naive reader undercounts exactly the events that matter
 *     most.
 *  2. **Read `ephemeral_1h` and `ephemeral_5m` separately** - they price at 2.0x and 1.25x.
 *  3. **Never compare counts across tokenizer generations** - 4.7+ produces ~30% more tokens for the
 *     same text, so the model id is stored with every turn and estimates are discarded, not scaled,
 *     when it changes.
 *
 * ⛔ Nothing here reads the terminal. The transcript is the source of truth; the TUI is for humans.
 */

interface AssistantRecord {
  type: 'assistant'
  timestamp: string
  requestId?: string
  effort?: string
  gitBranch?: string
  version?: string
  message?: {
    model?: string
    usage?: UsageBlock
  }
}

interface UsageBlock {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
  output_tokens_details?: { thinking_tokens?: number }
  iterations?: UsageBlock[]
}

interface CompactRecord {
  type: 'system'
  subtype?: string
  timestamp: string
  compactMetadata?: { trigger?: string; preTokens?: number; durationMs?: number }
}

/** Everything else in the file - user turns, hooks, titles - carries only a timestamp we care about. */
interface OtherRecord {
  type: string
  timestamp?: string
}

type TranscriptRecord = AssistantRecord | CompactRecord | OtherRecord

function isAssistant(r: TranscriptRecord): r is AssistantRecord {
  return r.type === 'assistant'
}

function isCompactBoundary(r: TranscriptRecord): r is CompactRecord {
  return r.type === 'system' && (r as CompactRecord).subtype === 'compact_boundary'
}

interface Totals {
  input: number
  output: number
  thinking: number
  cacheRead: number
  cacheWrite1h: number
  cacheWrite5m: number
}

/**
 * Sums one usage block. When `iterations[]` is present it is authoritative and the top level is
 * ignored entirely - mixing the two double-counts.
 */
export function sumUsage(usage: UsageBlock): Totals {
  const parts = usage.iterations?.length ? usage.iterations : [usage]
  const t: Totals = { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0 }
  for (const p of parts) {
    t.input += p.input_tokens ?? 0
    t.output += p.output_tokens ?? 0
    t.cacheRead += p.cache_read_input_tokens ?? 0
    const oneHour = p.cache_creation?.ephemeral_1h_input_tokens
    const fiveMin = p.cache_creation?.ephemeral_5m_input_tokens
    if (oneHour === undefined && fiveMin === undefined) {
      // Older records carry only the undifferentiated total. Attribute it to the default TTL rather
      // than dropping it; losing a cache write understates cost far more than mispricing one.
      t.cacheWrite1h += p.cache_creation_input_tokens ?? 0
    } else {
      t.cacheWrite1h += oneHour ?? 0
      t.cacheWrite5m += fiveMin ?? 0
    }
  }
  // thinking_tokens is reported once per turn, not per iteration.
  t.thinking = usage.output_tokens_details?.thinking_tokens ?? 0
  return t
}

/** What the model was holding when it answered: everything it read plus everything it wrote in. */
export function contextOf(t: Totals): number {
  return t.input + t.cacheRead + t.cacheWrite1h + t.cacheWrite5m
}

export interface TailerEvents {
  onTurn(turn: Turn): void
  onCompact(
    sessionId: string,
    meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null }
  ): void
}

export class TranscriptTailer {
  private offset = 0
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private reading = false
  /**
   * The transcript records when a response was written, not when its request went out. The cache
   * TTL runs from the request *start*, so the previous record's timestamp is used as the earliest
   * plausible start. That is deliberately pessimistic - it expires the cache a little early rather
   * than a little late, and only the late direction loses money.
   */
  private previousTs: number | null = null

  constructor(
    private readonly sessionId: string,
    private readonly path: string,
    private readonly events: TailerEvents
  ) {}

  start(): void {
    if (this.timer) return
    // fs.watch misses appends on some Windows and network filesystems, so it is an accelerator on
    // top of a poll, never the only trigger.
    this.timer = setInterval(() => void this.drain(), 1500)
    this.timer.unref?.()
    this.attachWatcher()
    void this.drain()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  private attachWatcher(): void {
    if (this.watcher || !existsSync(this.path)) return
    try {
      this.watcher = watch(this.path, () => void this.drain())
    } catch {
      // Polling still covers us.
    }
  }

  private async drain(): Promise<void> {
    if (this.reading) return
    if (!existsSync(this.path)) return
    this.attachWatcher()

    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return
    }
    // A shrinking file means it was replaced. Start over rather than reading from a stale offset.
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return

    this.reading = true
    const from = this.offset
    try {
      const stream = createReadStream(this.path, { start: from, encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      let consumed = 0
      for await (const line of rl) {
        consumed += Buffer.byteLength(line, 'utf8') + 1
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.handle(JSON.parse(trimmed))
        } catch {
          // A partial final line is normal while the agent is writing. The next pass re-reads it.
          consumed -= Buffer.byteLength(line, 'utf8') + 1
          break
        }
      }
      this.offset = from + consumed
    } catch (err) {
      log.warn(`transcript read failed for ${this.sessionId.slice(0, 8)}:`, err)
    } finally {
      this.reading = false
    }
  }

  private handle(record: unknown): void {
    const rec = record as TranscriptRecord
    const stamp = rec.timestamp
    const ts = stamp ? Date.parse(stamp) : Date.now()

    if (isCompactBoundary(rec)) {
      this.events.onCompact(this.sessionId, {
        trigger: rec.compactMetadata?.trigger ?? null,
        preTokens: rec.compactMetadata?.preTokens ?? null,
        durationMs: rec.compactMetadata?.durationMs ?? null
      })
      this.previousTs = ts
      return
    }

    if (!isAssistant(rec) || !rec.message?.usage) {
      if (stamp) this.previousTs = ts
      return
    }

    const totals = sumUsage(rec.message.usage)
    const turn: Turn = {
      sessionId: this.sessionId,
      requestId: rec.requestId ?? null,
      ts,
      requestStartedAt: this.previousTs ?? ts,
      model: rec.message.model ?? null,
      effort: rec.effort ?? null,
      gitBranch: rec.gitBranch ?? null,
      inputTokens: totals.input,
      outputTokens: totals.output,
      thinkingTokens: totals.thinking,
      cacheReadTokens: totals.cacheRead,
      cacheWrite1hTokens: totals.cacheWrite1h,
      cacheWrite5mTokens: totals.cacheWrite5m,
      contextTokens: contextOf(totals)
    }
    this.previousTs = ts
    this.events.onTurn(turn)
  }
}

/**
 * Persist a turn and roll the session's cache clock forward from it.
 *
 * Returns **whether this turn was new**. ⛔ The caller must not bill a turn this returns false for.
 *
 * ⚠️ A transcript can carry the same usage record more than once - measured 2026-08-26 on claude
 * 2.1.223: one 41-turn session wrote **72 usage records with 41 unique request ids**. The unique
 * index on (session_id, request_id) always absorbed that, so `turns` was exact; everything
 * downstream that *accumulated* was not. That run's row read 3,154,302 cache-read tokens against an
 * actual 1,848,902, its task's budget read 3.3M of spend that never happened, and
 * `tokens_since_compact` - which the compaction reserve and the cache clock both read - was nearly
 * double. A counter that only ever adds cannot be made correct by the row that dedupes beside it.
 */
export function recordTurn(turn: Turn): boolean {
  const session = getSession(turn.sessionId)
  if (!session) return false
  const model = costModelFor(session.adapterId)

  const inserted = db()
    .prepare(
      `insert or ignore into turns
         (session_id, request_id, ts, request_started_at, model, effort, git_branch,
          input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
          cache_write_1h_tokens, cache_write_5m_tokens, context_tokens, tokenizer, cost_model_id)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      turn.sessionId,
      turn.requestId,
      turn.ts,
      turn.requestStartedAt,
      turn.model,
      turn.effort,
      turn.gitBranch,
      turn.inputTokens,
      turn.outputTokens,
      turn.thinkingTokens,
      turn.cacheReadTokens,
      turn.cacheWrite1hTokens,
      turn.cacheWrite5mTokens,
      turn.contextTokens,
      turn.model ? (model.modelSpec(turn.model)?.tokenizer ?? null) : null,
      model.id
    ).changes

  // ⛔ Everything below this line accumulates. A replayed record must reach none of it - and that
  // includes the session's own clock, because a duplicate arriving out of order would roll
  // `last_request_started_at` backwards and expire a cache that is still warm.
  if (inserted === 0) return false

  const expiry = model.cacheExpiryFor({
    contextTokens: turn.contextTokens,
    lastRequestStartedAt: turn.requestStartedAt
  })
  db()
    .prepare(
      `update sessions
          set context_tokens = ?, last_request_started_at = ?, cache_expires_at = ?,
              tokens_since_compact = tokens_since_compact + ?, effort = coalesce(?, effort),
              model = coalesce(?, model)
        where id = ?`
    )
    .run(
      turn.contextTokens,
      turn.requestStartedAt,
      expiry,
      turn.inputTokens + turn.outputTokens + turn.cacheWrite1hTokens + turn.cacheWrite5mTokens,
      turn.effort,
      turn.model,
      turn.sessionId
    )

  // ⛔ The first turn after a compaction is the only thing that ever measures what the compaction
  // left behind. The boundary record carries a `preTokens` and no counterpart, so until this runs
  // the "after" half of every compaction on this session is genuinely unknown - and is reported as
  // unknown rather than filled in from an estimate.
  if (turn.contextTokens !== null) fillPostTokens(turn.sessionId, turn.contextTokens)

  // ⛔ Proof, not a guess: this account just produced a real assistant turn, so whatever held it out
  // of dispatch is over. A clean exit would not do - a process can exit 0 having done nothing, which
  // is the exact failure the quarantine exists to catch.
  clearDispatchFailure(session.workerId)

  announce(turn.sessionId)
  return true
}

/**
 * Say that the session moved.
 *
 * ⛔ **A mutation is only half done when the row is written** - events.ts says so, and this is the
 * write that ignored it. `context_tokens`, `last_request_started_at` and `cache_expires_at` all
 * change here, and nothing announced any of it: a `turn` event went out, which is about the *turn*,
 * so every holder of a `Session` object kept the copy it was handed when the session opened. The
 * fleet strip drew an empty cache bar, `no turn yet` and `--:--` for a session 77 turns deep while
 * the task pane one panel over showed 82k from a fresher copy of the same row (session e1419ce6,
 * measured 2026-08-28).
 *
 * ⚠️ Re-read from the store rather than patching a copy. The caller's `session` is the row as it was
 * before any of this, and broadcasting that would replace a fresh copy somewhere with a stale one -
 * the same bug, pointed the other way.
 */
function announce(sessionId: string): void {
  const session = getSession(sessionId)
  if (session) emit({ type: 'session.changed', session })
}

export function recordCompaction(
  sessionId: string,
  meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null }
): void {
  db().prepare('update sessions set tokens_since_compact = 0 where id = ?').run(sessionId)
  // ⛔ The proof arrived, so the outstanding request is retired here - at the one place that has
  // seen a real `compact_boundary` record. Leaving it set would hold the session in `in_flight`
  // until the settle window ran out and then count it as ignored: a compaction that worked,
  // recorded as one that failed, and two more of them before the clock gave up.
  clearClockMove(sessionId)

  // ⚠️ The boundary is the *only* moment this is knowable, so the ledger is closed here rather than
  // anywhere more convenient. `postTokens` stays null until a turn measures it - see fillPostTokens.
  const record = noteCompactionLanded(sessionId, meta)
  if (record?.taskId) {
    addMessage(
      record.taskId,
      'system',
      `Compacted${record.preTokens ? ` from ${Math.round(record.preTokens / 1000)}k tokens` : ''}` +
        `${record.durationMs ? ` in ${Math.round(record.durationMs / 1000)}s` : ''}. ` +
        (record.trigger === 'clock'
          ? 'The cache clock asked for this.'
          : record.trigger === 'agent'
            ? 'The agent asked for this itself.'
            : 'The CLI did this on its own when the context filled.')
    )
  }

  log.info(
    `session ${sessionId.slice(0, 8)} compacted` +
      (meta.preTokens ? ` from ${meta.preTokens} tokens` : '') +
      (meta.durationMs ? ` in ${Math.round(meta.durationMs / 1000)}s` : '')
  )
}

function costModelFor(adapterId: string) {
  return costModel(adapter(adapterId).info.policy.costModelId)
}

/**
 * Record a turn agentyard saw on the wire rather than in a file.
 *
 * ⛔ For adapters whose `metering` is `stream` — Antigravity has no transcript agentyard can read,
 * and Codex writes one in a shape `parseTranscriptLine` does not understand (R10). Without this they
 * would run and report **zero**, which reads as free rather than as unknown, and every budget, gate
 * and estimate downstream would believe it.
 *
 * ⚠️ Deliberately less than the transcript path gives:
 *
 *  - No `requestStartedAt`, so no cache expiry is derived. The cache clock leaves these sessions
 *    alone anyway, because neither provider prices a steerable cache (D24) — so nothing is lost that
 *    was going to be used.
 *  - Only what was seen. A daemon that restarted mid-run misses the turns nobody was attached for,
 *    which is why `metering: 'stream'` is reported as a caveat in Doctor rather than as equivalent.
 */
export function creditStreamTurn(session: Session, usage: StreamUsage): void {
  const model = costModelFor(session.adapterId)
  const ts = Date.now()

  const inserted = db()
    .prepare(
      `insert or ignore into turns
         (session_id, request_id, ts, request_started_at, model, effort, git_branch,
          input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
          cache_write_1h_tokens, cache_write_5m_tokens, context_tokens, tokenizer, cost_model_id)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      session.id,
      // The CLIs do not expose a request id, so the timestamp is the uniqueness key. It is only there
      // to stop the same record being counted twice if a chunk is replayed.
      `stream-${ts}`,
      ts,
      null,
      session.model,
      session.effort,
      null,
      usage.input,
      usage.output,
      usage.thinking,
      usage.cacheRead,
      usage.cacheWrite,
      0,
      usage.input,
      session.model ? (model.modelSpec(session.model)?.tokenizer ?? null) : null,
      model.id
    ).changes

  // Same rule as the transcript path: a replayed chunk reaches the row and stops there.
  if (inserted === 0) return

  db()
    .prepare(
      'update sessions set context_tokens = ?, tokens_since_compact = tokens_since_compact + ? where id = ?'
    )
    .run(usage.input, usage.input + usage.output + usage.cacheWrite, session.id)

  creditTurn(session.id, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite
  })

  // The same proof as the transcript path, for the adapters metered from their stream instead.
  clearDispatchFailure(session.workerId)

  announce(session.id)

  log.debug(
    `metered ${usage.input + usage.output} tokens from the stream on ${session.id.slice(0, 8)}`
  )
}
