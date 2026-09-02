import { db, row, rows } from './db.js'
import { log } from './log.js'
import type { Compaction } from '@shared/tasks.js'

/**
 * The record of a compaction: that one was asked for, that one landed, and what it bought.
 *
 * ⛔ **Written because the answer to "did it compact?" was a log line nobody could reach.** The
 * clock sent `/compact` on a session's input channel and moved on. `tokens_since_compact` went to
 * zero when the boundary arrived, which is a side effect, not a record - it says a compaction
 * happened *at some point* and nothing about which one, when, why, or whether the thing the
 * operator switched on that morning had anything to do with it. Measured 2026-08-31: `autoCompact`
 * on since 07:48Z, and by the end of the day the operator still had to ask whether it had ever run.
 * It had not.
 *
 * ⚠️ **Asked and landed are two rows' worth of truth in one row, and both halves matter.** A
 * compaction that was requested and never happened is the interesting case - it is HANDOFF R6, the
 * open question of whether `/compact` is even honoured as a user message on the `stream` transport -
 * and a table that only recorded successes would answer that question with silence forever.
 */
export function noteCompactionAsked(args: {
  sessionId: string
  taskId: string | null
  reason: string
  preTokens: number | null
}): number {
  const now = Date.now()
  const info = db()
    .prepare(
      `insert into compactions (session_id, task_id, trigger, reason, pre_tokens, asked_at, ts)
       values (?,?,?,?,?,?,?)`
    )
    .run(args.sessionId, args.taskId, 'clock', args.reason, args.preTokens, now, now)
  return Number(info.lastInsertRowid)
}

/**
 * A `compact_boundary` arrived. Close the request it answers, or open a row for one nobody made.
 *
 * ⚠️ **An unmatched boundary is recorded, not discarded.** The CLI compacts on its own when a
 * context fills, and an agent can be told to. Those are the compactions this fleet did *not* buy,
 * and leaving them out would make the ledger read as though the clock were the only thing shrinking
 * contexts - flattering, and wrong. `trigger` keeps them apart.
 */
export function noteCompactionLanded(
  sessionId: string,
  meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null; ts?: number }
): Compaction | null {
  const ts = meta.ts ?? Date.now()

  // ⛔ Deduplicate replayed compact_boundary records from the transcript.
  // When a session is resumed, TranscriptTailer reads the transcript from offset 0. Any
  // compact_boundary records from prior runs are already recorded in `compactions`.
  if (meta.ts !== undefined) {
    const existing = row<{ id: number }>(
      db()
        .prepare(
          `select id from compactions
            where session_id = ? and (landed_at = ? or (asked_at is null and ts = ?))`
        )
        .get(sessionId, meta.ts, meta.ts)
    )
    if (existing) return null
  }

  const open = row<{ id: number; pre_tokens: number | null; asked_at: number }>(
    db()
      .prepare(
        `select id, pre_tokens, asked_at from compactions
          where session_id = ? and landed_at is null and asked_at is not null
          order by asked_at desc limit 1`
      )
      .get(sessionId)
  )

  // ⚠️ Only match an open request if the boundary did not occur in the past before the ask.
  if (open && (meta.ts === undefined || meta.ts >= open.asked_at - 5000)) {
    db()
      .prepare(
        `update compactions set landed_at = ?, ts = ?, duration_ms = ?, pre_tokens = coalesce(pre_tokens, ?)
          where id = ?`
      )
      .run(ts, ts, meta.durationMs, meta.preTokens, open.id)
    return getCompaction(open.id)
  }

  const info = db()
    .prepare(
      `insert into compactions (session_id, task_id, trigger, reason, pre_tokens, duration_ms,
                                landed_at, ts)
       values (?,?,?,?,?,?,?,?)`
    )
    .run(
      sessionId,
      taskIdForSession(sessionId),
      meta.trigger === 'manual' ? 'agent' : 'auto',
      meta.trigger === 'manual'
        ? 'the agent compacted its own context'
        : 'the CLI compacted on its own when the context filled',
      meta.preTokens,
      meta.durationMs,
      ts,
      ts
    )
  return getCompaction(Number(info.lastInsertRowid))
}

/**
 * Who is waiting for the *next* compaction on a session to land.
 *
 * ⛔ **In memory, one-shot, and never a substitute for the ledger.** The `compactions` table records
 * that a compaction was asked for and whether it landed; this answers a different question, and only
 * for as long as the daemon runs: *something is holding a prompt back until this session is smaller*.
 * The one caller is the resume path in `scheduler.ts`, which sends `/compact` into a conversation it
 * has just revived and must not send the task's own prompt until the boundary has arrived — a prompt
 * delivered mid-compaction is a prompt the agent reads out of the summary rather than out of the
 * message.
 *
 * ⚠️ Every waiter carries its own timeout and unsubscribes itself. Whether `/compact` is honoured on
 * the `stream` transport is still unmeasured (HANDOFF R6), so a waiter that only ever fired on
 * success would strand the run that registered it forever.
 */
const waitingForCompaction = new Map<string, Set<() => void>>()

/** Register a one-shot listener. Returns the unsubscribe, which is safe to call twice. */
export function onCompactionLanded(sessionId: string, listener: () => void): () => void {
  const listeners = waitingForCompaction.get(sessionId) ?? new Set<() => void>()
  listeners.add(listener)
  waitingForCompaction.set(sessionId, listeners)
  return () => {
    const current = waitingForCompaction.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) waitingForCompaction.delete(sessionId)
  }
}

/**
 * A boundary arrived on this session. Wake everyone waiting, once.
 *
 * ⛔ The map entry is dropped *before* the listeners run: one of them re-registering, or throwing,
 * must not leave a stale set behind that a later boundary would fire a second time.
 */
export function compactionLanded(sessionId: string): void {
  const listeners = waitingForCompaction.get(sessionId)
  if (!listeners) return
  waitingForCompaction.delete(sessionId)
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      log.warn(`a compaction listener on ${sessionId.slice(0, 8)} threw:`, err)
    }
  }
}

/**
 * The size a compaction actually left behind, from the first turn that measured one.
 *
 * ⛔ Called from the turn path rather than the boundary path because **the boundary record does not
 * carry it**. `compactMetadata` reports `preTokens` and stops; what the context became is not known
 * until something reads it back. Filling this in at boundary time would mean writing down the size
 * before the compaction that produced it had been measured.
 *
 * ⚠️ Only the most recent landed row, and only once. A later turn grows the context again, and that
 * growth is not the compaction's result.
 */
export function fillPostTokens(sessionId: string, contextTokens: number): void {
  db()
    .prepare(
      `update compactions set post_tokens = ?
        where id = (select id from compactions
                     where session_id = ? and landed_at is not null and post_tokens is null
                     order by landed_at desc limit 1)`
    )
    .run(contextTokens, sessionId)
}

/**
 * How long a `/compact` this fleet asked for may excuse a session's silence.
 *
 * ⛔ Bounded on purpose, and bounded well above how long a compaction takes. A compaction is one
 * expensive turn - measured at 1-2 minutes on `claude-code`, t105 on 2026-09-02 took 2m08s - and
 * five minutes is long enough that a healthy one is never cut off, short enough that a `/compact`
 * which is never honoured cannot silence the stall watchdog for the rest of the run. The unlanded
 * row stays on the record either way; what expires is only its excuse.
 */
export const COMPACTION_GRACE_MS = 5 * 60 * 1000

/**
 * Is this session in the middle of a compaction we asked for?
 *
 * ⛔ **The one silence that is a session working as instructed.** `/compact` goes down the session's
 * own input channel and the CLI answers it with a turn that reports nothing until the boundary
 * arrives - so for a minute or two the run looks exactly like the thing the stall watchdog exists to
 * catch: no turn, and a process tree doing very little that CPU can see. Measured on t105,
 * 2026-09-02: the compaction was issued at 06:51:03 and the boundary arrived at 06:53:11, and at
 * 06:52:15 the watchdog told the operator the task *"looks stuck rather than slow"* about a session
 * that was doing precisely what it had been told to do.
 *
 * ⚠️ Asked-and-unlanded only, and only inside the grace window. A landed compaction is not in
 * flight, and one asked for half an hour ago is evidence of nothing.
 */
export function compactionInFlight(
  sessionId: string,
  now = Date.now(),
  graceMs = COMPACTION_GRACE_MS
): boolean {
  const open = row<{ asked_at: number | null }>(
    db()
      .prepare(
        `select asked_at from compactions
          where session_id = ? and landed_at is null and asked_at is not null
          order by asked_at desc limit 1`
      )
      .get(sessionId)
  )
  if (!open?.asked_at) return false
  return now - open.asked_at <= graceMs
}

/**
 * When this session last finished compacting, if it ever has.
 *
 * ⚠️ Read by the stall watchdog as proof of work: a boundary is a turn the session demonstrably
 * completed, so the silence that matters starts there rather than at whatever request preceded it -
 * which on a resumed conversation can be hours old and belong to another run entirely.
 */
export function lastCompactionLandedAt(sessionId: string): number | null {
  const last = row<{ landed_at: number | null }>(
    db()
      .prepare(
        `select landed_at from compactions
          where session_id = ? and landed_at is not null
          order by landed_at desc limit 1`
      )
      .get(sessionId)
  )
  return last?.landed_at ?? null
}

export function getCompaction(id: number): Compaction | null {
  return toCompaction(
    row<CompactionRow>(db().prepare('select * from compactions where id = ?').get(id))
  )
}

export function compactionsForTask(taskId: string): Compaction[] {
  return rows<CompactionRow>(
    db().prepare('select * from compactions where task_id = ? order by ts asc').all(taskId)
  )
    .map(toCompaction)
    .filter((c): c is Compaction => c !== null)
}

interface CompactionRow {
  id: number
  session_id: string
  task_id: string | null
  trigger: string
  reason: string | null
  pre_tokens: number | null
  post_tokens: number | null
  duration_ms: number | null
  asked_at: number | null
  landed_at: number | null
  ts: number
}

function toCompaction(r: CompactionRow | null): Compaction | null {
  return r
    ? {
        id: r.id,
        sessionId: r.session_id,
        taskId: r.task_id,
        trigger: r.trigger as Compaction['trigger'],
        reason: r.reason,
        preTokens: r.pre_tokens,
        postTokens: r.post_tokens,
        durationMs: r.duration_ms,
        askedAt: r.asked_at,
        landedAt: r.landed_at,
        ts: r.ts
      }
    : null
}

function taskIdForSession(sessionId: string): string | null {
  const r = row<{ task_id: string | null }>(
    db()
      .prepare('select task_id from runs where session_id = ? order by started_at desc limit 1')
      .get(sessionId)
  )
  return r?.task_id ?? null
}
