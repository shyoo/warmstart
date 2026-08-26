import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Session, Turn } from '@shared/protocol.js'
import { db } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { getSession } from './sessions.js'
import { creditTurn } from './tasks.js'
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
  onCompact(sessionId: string, meta: { preTokens: number | null; durationMs: number | null }): void
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
    const stamp = (rec as OtherRecord).timestamp
    const ts = stamp ? Date.parse(stamp) : Date.now()

    if (isCompactBoundary(rec)) {
      this.events.onCompact(this.sessionId, {
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

/** Persist a turn and roll the session's cache clock forward from it. */
export function recordTurn(turn: Turn): void {
  const session = getSession(turn.sessionId)
  if (!session) return
  const model = costModelFor(session.adapterId)

  db()
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
    )

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
}

export function recordCompaction(
  sessionId: string,
  meta: { preTokens: number | null; durationMs: number | null }
): void {
  db().prepare('update sessions set tokens_since_compact = 0 where id = ?').run(sessionId)
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

  db()
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
      null,
      session.model ? (model.modelSpec(session.model)?.tokenizer ?? null) : null,
      model.id
    )

  db()
    .prepare(
      'update sessions set tokens_since_compact = tokens_since_compact + ? where id = ?'
    )
    .run(usage.input + usage.output + usage.cacheWrite, session.id)

  creditTurn(session.id, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite
  })

  log.debug(
    `metered ${usage.input + usage.output} tokens from the stream on ${session.id.slice(0, 8)}`
  )
}
