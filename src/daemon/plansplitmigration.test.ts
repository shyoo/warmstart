import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The retrospective half of the Plan & Split clock fix.
 *
 * ⛔ **t317 stopped the clock going forward and changed nothing that had already happened.** Before
 * it, a planner's run was closed by `onSessionExit`, so `ended_at` recorded the CLI's idle timeout
 * rather than the split — and `activetime.ts` reads every duration off `started_at`/`ended_at`, so
 * four of this fleet's planners reported roughly 47 minutes of waiting as work. This is the
 * migration that moves those four ends back onto the evidence.
 *
 * ⛔ **The evidence is the children, and nothing else.** A run that filed no children inside its own
 * span keeps the end it has: there is nothing left that says when its split happened, and a number
 * chosen because it looks plausible is precisely the reading being repaired.
 */

let dir: string
let db: typeof import('./db.js')
let activetime: typeof import('./activetime.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-plansplitmigration-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  activetime = await import('./activetime.js')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** The exact string `turnend.ts` wrote when a planner's process exited after filing its split. */
const LEGACY_NOTE =
  'The agent filed its plan as subtasks and stopped, as instructed. This task waits for ' +
  'them and comes back by itself.'

let nextSeq = 1

function seedTask(id: string, kind: 'plan' | 'work', createdAt: number, parent?: string): void {
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, kind, parent_task_id, created_by_json,
                          mandate_json, budget_json, created_at, updated_at)
       values (?, ?, 'x', 'completed', ?, ?, '{}', '{}', '{}', ?, ?)`
    )
    .run(id, nextSeq++, kind, parent ?? null, createdAt, createdAt)
}

function seedRun(id: string, taskId: string, startedAt: number, endedAt: number, note: string): void {
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, session_id, started_at, ended_at, outcome, note,
                         kind, quota_unverified)
       values (?, ?, 'worker-1', ?, ?, ?, 'blocked', ?, 'work', 0)`
    )
    .run(id, taskId, `session-${id}`, startedAt, endedAt, note)
}

const endOf = (runId: string): number =>
  (db.db().prepare('select ended_at as e from runs where id = ?').get(runId) as { e: number }).e

/**
 * Rewind to just before the repair and reopen, which replays it against the seeded rows.
 *
 * ⚠️ Pinned by a fragment of the migration's own **code**. The transpiler strips comments before
 * `Function.prototype.toString` sees them, and a number typed in here would become a test of
 * whichever migration is inserted next.
 */
function replay(file: string): void {
  db.db().exec(`pragma user_version = ${db.versionBefore('planner-split repair')}`)
  db.closeDb()
  db.openDb(file)
}

describe('ending a pre-t317 planner run at the split it filed', () => {
  it('moves the end back to the newest child filed inside the run, and leaves every other run alone', () => {
    const file = join(dir, 'repair.db')
    db.openDb(file)

    // The case: a planner that split at 5,000 and whose process was reaped at 100,000.
    // ⚠️ A child filed at 2,000 as well, by an ordinary `task_create` earlier in the same run —
    // which is why the split is the **newest** child in the span and not the oldest.
    seedTask('plan-a', 'plan', 500)
    seedTask('early-a', 'work', 2_000, 'plan-a')
    seedTask('piece-a1', 'work', 5_000, 'plan-a')
    seedTask('piece-a2', 'work', 5_000, 'plan-a')
    seedRun('run-a', 'plan-a', 1_000, 100_000, LEGACY_NOTE)

    // A planner with the same note whose children are gone. No evidence, so no repair.
    seedTask('plan-b', 'plan', 500)
    seedRun('run-b', 'plan-b', 1_000, 100_000, LEGACY_NOTE)

    // A planner whose children were filed *after* its run closed — a later run's split, not this
    // one's. Outside the span, so it says nothing about this run.
    seedTask('plan-c', 'plan', 500)
    seedTask('piece-c1', 'work', 200_000, 'plan-c')
    seedRun('run-c', 'plan-c', 1_000, 100_000, LEGACY_NOTE)

    // An ordinary work task with children and some other reason for being blocked.
    seedTask('work-d', 'work', 500)
    seedTask('piece-d1', 'work', 5_000, 'work-d')
    seedRun('run-d', 'work-d', 1_000, 100_000, 'The agent stopped to ask you something.')

    replay(file)

    expect(endOf('run-a')).toBe(5_000)
    expect(endOf('run-b')).toBe(100_000)
    expect(endOf('run-c')).toBe(100_000)
    expect(endOf('run-d')).toBe(100_000)
  })

  it('⛔ is a no-op the second time, so a rewound database is not walked further back each replay', () => {
    const file = join(dir, 'repair.db')
    expect(endOf('run-a')).toBe(5_000)
    replay(file)
    expect(endOf('run-a')).toBe(5_000)
  })

  it("reports the planner's active time as the work before the split, not the wait after it", () => {
    // The whole point of the row edit: `Took` is derived, and this is the number it derives.
    const timing = activetime.timingForTasks(['plan-a'], 200_000).get('plan-a')
    expect(timing?.activeMs).toBe(4_000)
    expect(timing?.activeSince).toBeNull()
  })
})
