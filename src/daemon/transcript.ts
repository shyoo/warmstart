import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Session, Turn } from '@shared/protocol.js'
import { db } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import {
  clearClockMove,
  closeSession,
  getSession,
  lastRequestEvidenceAt,
  promptSentAt
} from './sessions.js'
import { emit } from './events.js'
import { addMessage, creditTurn, runForSession } from './tasks.js'
import {
  compactionAwaited,
  compactionLanded,
  fillPostTokens,
  noteCompactionLanded
} from './compaction.js'
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

/**
 * Claude Code inserts zero-token assistant placeholders to keep its JSONL conversation alternating.
 * They are transcript structure, not a model response, so they must never become a session's
 * observed model or effort.
 */
function isSyntheticAssistant(r: AssistantRecord): boolean {
  return r.message?.model === '<synthetic>'
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
    meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null; ts?: number }
  ): void
}

/** One metered turn, as an adapter reads it out of its own CLI's transcript. */
export type TranscriptTurn = Omit<Turn, 'sessionId' | 'requestStartedAt'>

/**
 * What one line of a transcript turned out to be.
 *
 * ⛔ `other` still carries a timestamp, and dropping it would be a real loss: the tailer uses the
 * *previous* record's time as the earliest plausible start of the next request, which is what the
 * cache clock counts from.
 */
export type TranscriptDecoded =
  | { kind: 'turn'; turn: TranscriptTurn }
  | {
      kind: 'compact'
      ts: number
      preTokens: number | null
      durationMs: number | null
      trigger: string | null
    }
  | { kind: 'other'; ts: number | null }

/**
 * Read one record of **this CLI's** transcript.
 *
 * ⛔ There is no shared transcript format, exactly as there is no shared stream format. Claude Code
 * writes `{"type":"assistant","message":{"usage":{…}}}`; Muse Code writes an envelope keyed on
 * `payload_type` with the usage nested under `payload.event.usage`, in microseconds, using a token
 * convention where `input_tokens` **includes** the cached prefix rather than excluding it. A reader
 * keyed on one vendor's shape meters *nothing* from another — silently, and an unmetered run reports
 * as costing nothing rather than as unknown, which is the expensive direction.
 *
 * ⚠️ Optional. An adapter that does not supply one is read with Claude Code's shape, which is what
 * every adapter declaring `metering: 'transcript'` used before 2026-09-06 and what `claude-code`
 * still uses.
 */
export type TranscriptDecoder = (record: unknown) => TranscriptDecoded | null

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
    private readonly events: TailerEvents,
    /** ⚠️ Absent means Claude Code's shape — see `TranscriptDecoder`. */
    private readonly decode?: TranscriptDecoder | undefined
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
    if (this.decode) {
      this.handleDecoded(record)
      return
    }
    const rec = record as TranscriptRecord
    const stamp = rec.timestamp
    const parsedTs = stamp ? Date.parse(stamp) : NaN
    const ts = !Number.isNaN(parsedTs) ? parsedTs : Date.now()

    if (isCompactBoundary(rec)) {
      this.events.onCompact(this.sessionId, {
        trigger: rec.compactMetadata?.trigger ?? null,
        preTokens: rec.compactMetadata?.preTokens ?? null,
        durationMs: rec.compactMetadata?.durationMs ?? null,
        ts
      })
      this.previousTs = ts
      return
    }

    if (!isAssistant(rec) || !rec.message?.usage || isSyntheticAssistant(rec)) {
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

  /**
   * The same bookkeeping, for an adapter that reads its own transcript.
   *
   * ⛔ `previousTs` is kept here rather than in the decoder, because it is a fact about *this file
   * being read in order* and not about the vendor's format — every adapter would otherwise have to
   * reimplement the one piece of it that is subtle, and the cache clock reads the result.
   */
  private handleDecoded(record: unknown): void {
    let decoded: TranscriptDecoded | null
    try {
      decoded = this.decode?.(record) ?? null
    } catch (err) {
      log.warn(`transcript decode failed for ${this.sessionId.slice(0, 8)}:`, err)
      return
    }
    if (!decoded) return

    if (decoded.kind === 'other') {
      if (decoded.ts !== null) this.previousTs = decoded.ts
      return
    }
    if (decoded.kind === 'compact') {
      this.events.onCompact(this.sessionId, {
        trigger: decoded.trigger,
        preTokens: decoded.preTokens,
        durationMs: decoded.durationMs,
        ts: decoded.ts
      })
      this.previousTs = decoded.ts
      return
    }
    this.events.onTurn({
      sessionId: this.sessionId,
      requestStartedAt: this.previousTs ?? decoded.turn.ts,
      ...decoded.turn
    })
    this.previousTs = decoded.turn.ts
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
  // Defense in depth for callers other than TranscriptTailer. Claude Code's synthetic entries carry
  // a zero-valued `usage` object, so truthiness alone does not distinguish them from real turns.
  if (turn.model === '<synthetic>') return false
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
  meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null; ts?: number }
): boolean {
  // ⛔ The boundary is the *only* moment this is knowable, so the ledger is closed here rather than
  // anywhere more convenient. `postTokens` stays null until a turn measures it - see fillPostTokens.
  //
  // ⛔ Closed or inserted FIRST: if this boundary is a replayed duplicate from an earlier run (e.g.
  // when a resumed session tails its transcript from offset 0), noteCompactionLanded returns null
  // and we must NOT reset tokens_since_compact, clear clock move, post duplicate messages, or fire
  // compactionLanded listeners.
  const record = noteCompactionLanded(sessionId, meta)
  if (!record) return false

  db().prepare('update sessions set tokens_since_compact = 0 where id = ?').run(sessionId)
  // ⛔ The proof arrived, so the outstanding request is retired here - at the one place that has
  // seen a real `compact_boundary` record. Leaving it set would hold the session in `in_flight`
  // until the settle window ran out and then count it as ignored: a compaction that worked,
  // recorded as one that failed, and two more of them before the clock gave up.
  clearClockMove(sessionId)

  if (record.taskId) {
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

  // ⛔ Last, and only once everything above has been written. A listener is something that was
  // *waiting* for this — the resume path holds a task's prompt back until the conversation is
  // smaller — so it must not be woken into a half-recorded state where the row it would read still
  // says the compaction is outstanding.
  // Capture this before waking the one-shot listeners, which remove themselves. The resume path is
  // waiting specifically so it can send the task prompt after the boundary; it owns what follows
  // and must not be mistaken for a clock interruption of an already-running work turn.
  const awaited = compactionAwaited(sessionId)
  compactionLanded(sessionId)

  // A slash command takes over the current turn. When the cache clock injects `/compact` into an
  // open run, the boundary is therefore the end of what that process can usefully do: Claude is
  // back at its input loop, while the run is still waiting for a `task_complete` that the displaced
  // work turn can no longer send. t182 (2026-09-03) remained `running` in exactly that state after
  // its compaction had visibly finished. Close only clock-issued compactions on open runs; an agent
  // compacting its own context, an automatic CLI boundary, and move 7 between runs must continue.
  if (record.trigger === 'clock' && !awaited && runForSession(sessionId)) {
    log.info(`session ${sessionId.slice(0, 8)} finished its clock compaction; closing the interrupted run`)
    closeSession(sessionId)
  }
  return true
}

function costModelFor(adapterId: string) {
  return costModel(adapter(adapterId).info.policy.costModelId)
}

/**
 * The newest moment a model request is known to have been under way, given both signals.
 *
 * ⛔ **The last mid-turn record beats the prompt that opened the turn.** For an adapter that reports
 * usage once per turn, the prompt time is the *first* request of however many the turn made; for
 * `codex exec`, which takes one prompt and then works unattended, that is the only one the fleet
 * ever saw. `lastRequestEvidenceAt` is stamped by every mid-turn stream record, each of which only
 * exists because a model answered — which, on a provider whose reads refresh the TTL, is the prefix
 * being renewed for free.
 *
 * ⚠️ `Math.max` rather than a plain preference: a turn whose records all arrived before the prompt
 * went down the pipe is a turn from the *previous* prompt on a reused session, and letting that
 * stale stamp win would wind the clock backwards.
 */
export function newestRequestStart(
  prompted: number | null,
  evidence: number | null,
  fallback: number
): number {
  if (prompted === null && evidence === null) return fallback
  return Math.max(prompted ?? 0, evidence ?? 0)
}

/**
 * Wind a live session's cache clock forward while its turn is still running.
 *
 * ⭐ **The half of t224 that `creditStreamTurn` cannot do.** That function is the turn's *last* word
 * and runs once, at the end; a `codex exec` turn can outlive the 30-minute prefix it is actively
 * reusing several times over before it gets there. In between, the row said the cache had lapsed
 * while codex was refreshing it on every request — so the fleet strip counted down to zero on a
 * working session, and the routing score's `warm` term read 0 for an account holding the hottest
 * prefix in the fleet.
 *
 * ⛔ **Only where the provider says a read refreshes the TTL.** `read_refreshes_ttl` is the whole
 * licence for this: it is what makes an observed request equivalent to a renewal. Anthropic declares
 * it too, but claude-code is metered from its transcript — which carries a real `requestStartedAt`
 * per turn and writes one every few seconds of a run — so this path is restricted to `metering:
 * 'stream'` adapters and never races the transcript for ownership of the same column.
 *
 * ⛔ **Never a first write.** `coalesce`-style caution is not enough here: a session that has not yet
 * completed a turn has no measured prefix, and inventing an expiry for one would tell routing an
 * unproven cache is warm. The clock is only ever pushed *forward* from a value some completed turn
 * already established — `where ... and cache_expires_at is not null and cache_expires_at < ?`.
 *
 * ⚠️ Throttled to `CLOCK_TOUCH_MS`. The precision that buys is far finer than the 30-minute window it
 * describes, and it keeps a chatty stream from writing the same row hundreds of times a minute.
 *
 * ⚠️ `last_request_started_at` is also the fleet's *silence* signal — the stall watchdog and
 * `finishReplyOverdue` both read it to mean "no request is in flight". Moving it here agrees with
 * them rather than fighting them: a session emitting records is demonstrably not silent, and it was
 * precisely this column being stuck at the run's opening prompt that `quietSince` had to work around
 * with `runStartedAt` after t105 was accused of 947 minutes of silence ninety seconds in.
 */
export function touchCacheClock(session: Session, at: number): void {
  if (adapter(session.adapterId).info.capabilities.metering !== 'stream') return
  const model = costModelFor(session.adapterId)
  const ttlMs = model.cacheTtlMs()
  if (ttlMs === null || !model.readRefreshesTtl) return

  const expiry = at + ttlMs

  const moved = db()
    .prepare(
      `update sessions
          set last_request_started_at = ?, cache_expires_at = ?
        where id = ?
          and cache_expires_at is not null
          and cache_expires_at < ?`
    )
    .run(at, expiry, session.id, expiry - CLOCK_TOUCH_MS).changes

  // ⛔ Only when the row actually moved. The throttle above means most calls change nothing, and
  // announcing those would push a session event per stream record to every attached window.
  if (moved > 0) announce(session.id)
}

/**
 * How stale the stored clock must be before an observed request rewrites it.
 *
 * ⚠️ A minute against a 30-minute window is ~3% of the TTL — well inside the noise of not knowing
 * exactly when the last request left — and it bounds the writes to one per session per minute
 * however loud the stream is.
 */
const CLOCK_TOUCH_MS = 60 * 1000

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
 *  - **No per-request start time.** A stream reports usage when the *turn* ends and never says when
 *    the last request inside it began, so `turns.request_started_at` stays null here — that column
 *    means one thing and this path cannot answer it.
 *  - Only what was seen. A daemon that restarted mid-run misses the turns nobody was attached for,
 *    which is why `metering: 'stream'` is reported as a caveat in Doctor rather than as equivalent.
 *
 * ⛔ **But it does now wind the session's cache clock, and for three years it did not.** The old note
 * here reasoned that no expiry was needed because "the cache clock leaves these sessions alone
 * anyway, since neither provider prices a steerable cache" — which is true and answers a different
 * question. `cache_expires_at` is read by two things that have nothing to do with spending: the fleet
 * strip's countdown, and the routing score's `warm` term. Leaving it null told both of them that a
 * codex conversation has no prompt cache at all. Measured 2026-09-02: session `bffdc5d2` finished
 * t123 holding 175,626 tokens of context with `last_request_started_at` null, so twenty minutes later
 * the retry scored CodexFirst at `warm 0 · affinity 0 · cold 1` and went to a Claude account that had
 * never seen the task. See `openai.codex.2026-08.json` § cache.
 *
 * ⚠️ **Every cost model with a TTL counts from the request, and a stream reports usage when the
 * *turn* ends** — it never says when the last request inside it began, unlike a transcript, which
 * carries `requestStartedAt` per turn. Stamping the moment the usage record arrives would overstate
 * the remaining TTL by roughly one response length, in the unsafe direction, and it is the same trap
 * cost-model.md §1 records for Anthropic arriving by a different road. There the fix was to read the
 * right field; here there is no right field on the wire, so the time is taken from **our own side of
 * the pipe** instead — `promptSentAt`, stamped when this session was last handed a prompt. ⛔ Still
 * not exact: on a multi-request turn it is the *first* request, so a long turn's later requests are
 * counted as older than they are — again the safe direction. Narrowing it means metering codex from
 * its rollout, which carries per-request timing (HANDOFF R10). See cost-model.md §1c.
 *
 * ⚠️ Where no TTL is declared at all, `cacheExpiryFor` returns null and nothing below changes.
 *
 * @param contextTokens - The context window fill level at the end of the turn's *last* model
 *   invocation. Distinct from `usage.input`, which is the cumulative sum of input tokens across
 *   **every** model call inside the turn (i.e. the total billed input, not the window level).
 *   For multi-step adapters like Antigravity, `usage.input` grows without bound across a long run
 *   while the actual context size stays near the model's declared limit; conflating the two makes
 *   the session gauge show `2.0M/1.0M`. When omitted, `usage.input` is used as before (correct
 *   for single-request adapters like Codex where the two are identical for a given turn).
 */
export function creditStreamTurn(session: Session, usage: StreamUsage, contextTokens?: number): void {
  const model = costModelFor(session.adapterId)
  const ts = Date.now()
  /**
   * ⭐ **When the newest request of this turn began, which is what the cache TTL is measured from.**
   *
   * ⛔ This used to be `null`, and the justification written here was that no provider metered from
   * its stream prices a steerable cache, so nothing would read it. That confused *pricing* a cache
   * with *having* one. Codex caches - its own `turn.completed` reports `cached_input_tokens` - and
   * the prefix lapses on a clock like any other; what it lacks is a lever to extend it. With no
   * `last_request_started_at` the row's `cache_expires_at` stayed null forever, so the fleet strip
   * drew an empty countdown for every codex session and routing scored each one as holding no cache
   * at all. Nothing here spends a token; it records a fact that was being thrown away.
   *
   * ⛔ **And then it was `promptSentAt`, which is wrong by the length of the whole turn** (t224).
   * The note here read *"on a multi-request turn it is the first request, so a long turn's later
   * requests are counted as older than they are — again the safe direction"*. That is only safe while
   * a turn is shorter than the TTL. `codex exec` takes **one** prompt, works for as long as the task
   * needs, and reports usage once at the end, so every request after the first was invisible: a
   * 90-minute codex run stamped an expiry 30 minutes after the prompt it opened with, i.e. an hour
   * *in the past*, at the exact moment its prefix was hottest. OpenAI's window is a sliding one —
   * *"a cached prefix remains eligible for reuse for 30 minutes after its most recent write or
   * reuse"* — so each of those invisible requests had been refreshing it for free the whole time.
   * The fleet then scored the account `warm 0 · cold 1` and sent the follow-up somewhere that had to
   * pay `1.25·C` to rebuild what was already sitting warm. See `requestAnchor` and `touchCacheClock`.
   *
   * ⚠️ Still the request, not the moment the result came back. A four-minute turn has already spent
   * four minutes of its window, exactly as `cacheExpiryFor` says, which is why the anchor is the last
   * *mid-turn* record and never the terminal one. `ts` is the fallback for a turn credited against a
   * session that is no longer live - a late record, where treating the prefix as fresher than it is
   * would be the wrong way to be wrong, but is the only number left.
   */
  const startedAt = newestRequestStart(promptSentAt(session.id), lastRequestEvidenceAt(session.id), ts)
  // ⚠️ `contextTokens` is the fill level of the model's context window when the turn ended, which
  // is a different question from what the turn cost. A run that made several model calls spends the
  // sum of their prompts and *holds* only the last one, so `usage.input` overstates the window by a
  // factor of the call count — see `streamusage.ts`, where both numbers are worked out and where the
  // measurement behind this sentence is recorded. When the run emitted no per-call usage there is
  // nothing better to say than `usage.input`, clamped to the window so a single wrong reading cannot
  // draw a bar past full.
  const win = session.contextWindow ?? (session.model ? (model.modelSpec(session.model)?.context_window ?? null) : null)
  const fallback = win ? Math.min(usage.input, win) : usage.input
  const ctxTokens = contextTokens ?? fallback
  // ⛔ The context level, not the turn's input. A prompt cache's TTL is priced off how much prefix
  // is being held, and the prefix is what the window holds — not the total prompted across a run.
  const expiry = model.cacheExpiryFor({ contextTokens: ctxTokens, lastRequestStartedAt: startedAt })

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
      startedAt,
      session.model,
      session.effort,
      null,
      usage.input,
      usage.output,
      usage.thinking,
      usage.cacheRead,
      usage.cacheWrite,
      0,
      ctxTokens,
      session.model ? (model.modelSpec(session.model)?.tokenizer ?? null) : null,
      model.id
    ).changes

  // Same rule as the transcript path: a replayed chunk reaches the row and stops there.
  if (inserted === 0) return

  // ⚠️ `coalesce(?, cache_expires_at)` rather than a bare write: a provider with no declared TTL
  // must be left exactly as it was, not have a null stamped over a value some other path set.
  db()
    .prepare(
      `update sessions
          set context_tokens = ?, tokens_since_compact = tokens_since_compact + ?,
              last_request_started_at = ?, cache_expires_at = coalesce(?, cache_expires_at)
        where id = ?`
    )
    .run(
      ctxTokens,
      usage.input + usage.output + usage.cacheWrite,
      // ⛔ `startedAt`, not `ts`: the request start is what a TTL is measured from, and it is the
      // same number the row above was inserted with. Writing the response end here would have made
      // the session row disagree with its own newest turn.
      startedAt,
      expiry,
      session.id
    )

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
