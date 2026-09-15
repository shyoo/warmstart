import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 72 — a clock ask that named no task gets its session's own back.
 *
 * ⛔ t446 (2026-09-14): the cache clock compacted t445's idle session at 17:18, between runs, and
 * attributed the ask with `runForSession` — open runs only — so the row recorded `task_id` null.
 * The boundary landed at 17:21 into a row no thread reads, while the preemption ask it superseded
 * sat on t445's thread reading "failed" forever. Eleven asks fleet-wide were orphaned the same way.
 */

let dir: string
let db: typeof import('./db.js')
let compaction: typeof import('./compaction.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-compactiontask-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  compaction = await import('./compaction.js')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const SESSION = 'd2b03c3d-3f39-482d-80ff-bc625811c550'
const TASK = 'c211a178-f08c-4fb8-b872-09b15186f0b1'

function seed(): void {
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?, 446, 'x', 'completed', '{}', '{}', '{}', 1000, 1000) on conflict(id) do nothing`
    )
    .run(TASK)
  db.db()
    .prepare(
      `insert into runs (id, task_id, session_id, worker_id, started_at, kind)
       values ('run-1', ?, ?, 'worker-1', 1000, 'work') on conflict(id) do nothing`
    )
    .run(TASK, SESSION)
  // The orphan, as the old attribution wrote it: asked between runs, no open run, null task.
  db.db()
    .prepare(
      `insert into compactions (session_id, task_id, trigger, reason, pre_tokens, asked_at, landed_at, ts)
       values (?, null, 'clock', 'compaction reserve at risk', 180273, 2000, 3000, 3000)`
    )
    .run(SESSION)
}

function taskOfOrphans(): Array<string | null> {
  return (
    db
      .db()
      .prepare('select task_id from compactions where session_id = ?')
      .all(SESSION) as Array<{ task_id: string | null }>
  ).map((r) => r.task_id)
}

describe('attributing orphaned clock asks to their session', () => {
  it('gives the landed ask back to the task whose thread should show it', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    seed()
    expect(taskOfOrphans()).toEqual([null])

    // ⚠️ Rewound by a fragment of the migration's own text, never by a number.
    db.db().exec(`pragma user_version = ${db.versionBefore("where task_id is null and trigger")}`)
    db.closeDb()
    db.openDb(file)

    expect(taskOfOrphans()).toEqual([TASK])
    expect(compaction.compactionsForTask(TASK).map((c) => c.sessionId)).toContain(SESSION)
  })

  it('is replay-safe: running it again over its own result changes nothing', () => {
    const file = join(dir, 'replay.db')
    db.db().exec(`pragma user_version = ${db.versionBefore("where task_id is null and trigger")}`)
    db.closeDb()
    db.openDb(file)

    expect(taskOfOrphans()).toEqual([TASK])
  })
})
