import { db, row, rows } from './db.js'
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
  meta: { preTokens: number | null; durationMs: number | null; trigger?: string | null }
): Compaction | null {
  const now = Date.now()
  const open = row<{ id: number; pre_tokens: number | null }>(
    db()
      .prepare(
        `select id, pre_tokens from compactions
          where session_id = ? and landed_at is null and asked_at is not null
          order by asked_at desc limit 1`
      )
      .get(sessionId)
  )

  if (open) {
    db()
      .prepare(
        `update compactions set landed_at = ?, duration_ms = ?, pre_tokens = coalesce(pre_tokens, ?)
          where id = ?`
      )
      .run(now, meta.durationMs, meta.preTokens, open.id)
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
      now,
      now
    )
  return getCompaction(Number(info.lastInsertRowid))
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
