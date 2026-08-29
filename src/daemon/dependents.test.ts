import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * How many tasks finishing this one would actually release.
 *
 * ⭐ This number decides which button somebody presses. A task resting at `awaiting_human` offers
 * **Mark done** and **Stop here**, and the two feel identical — both stop the work — while being the
 * difference between the rest of a plan running and not: `admit()` releases a dependent only when
 * its dependency reaches `completed`. The pane draws the count into the sentence beside each button,
 * so a wrong count is a wrong decision rather than a cosmetic slip.
 *
 * ⛔ It moved into the daemon when the thread became its own route. It used to be computed in the
 * renderer by filtering the task list the pane was rendered *inside*; a pane opened directly has no
 * such list, and the two ways of being wrong here are both silent — counting dependents that are
 * already finished, or counting rows somebody deleted.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-dependents-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'dependents.db'))
})

beforeEach(() => {
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** A task, held at a status of our choosing rather than wherever admission would put it. */
const at = (title: string, status: Parameters<typeof tasks.setStatus>[1]): string => {
  const t = tasks.createTask({ title })
  tasks.setStatus(t.id, status)
  return t.id
}

describe('counting what a task is holding up', () => {
  it('counts a dependent that is actually blocked', () => {
    const dependency = at('the one everything waits on', 'awaiting_human')
    const waiting = at('waits on it', 'blocked')
    tasks.addDependency(waiting, dependency)
    expect(tasks.blockedDependentsOf(dependency)).toBe(1)
  })

  it('counts each of several, so the sentence beside the button can name a number', () => {
    const dependency = at('the one everything waits on', 'awaiting_human')
    for (const title of ['a', 'b', 'c']) {
      const waiting = at(title, 'blocked')
      tasks.addDependency(waiting, dependency)
    }
    expect(tasks.blockedDependentsOf(dependency)).toBe(3)
  })

  it('ignores a dependent that has already run', () => {
    // ⛔ The inversion worth pinning. A dependent at `completed` is released by nothing, and counting
    // it tells an operator that Mark done frees work which finished long ago — on the one screen
    // where that number is the argument for pressing it.
    const dependency = at('the one everything waits on', 'awaiting_human')
    const done = at('already ran', 'completed')
    const running = at('already going', 'running')
    tasks.addDependency(done, dependency)
    tasks.addDependency(running, dependency)
    expect(tasks.blockedDependentsOf(dependency)).toBe(0)
  })

  it('ignores a dependent somebody deleted', () => {
    // ⚠️ `task_deps` has no cascade, so the edge outlives the row. Deleting a task is soft — the row
    // stays with `deleted_at` set — and a count that read the edge alone would keep reporting work
    // that is no longer anywhere a person can see it.
    const dependency = at('the one everything waits on', 'awaiting_human')
    const waiting = at('waits on it', 'blocked')
    tasks.addDependency(waiting, dependency)
    db.db().prepare('update tasks set deleted_at = ? where id = ?').run(Date.now(), waiting)
    expect(tasks.blockedDependentsOf(dependency)).toBe(0)
  })

  it('counts the reverse edge, not the forward one', () => {
    // ⛔ `dependsOn` is what a task waits *on*; this asks who waits on *it*. Reading the edge the
    // wrong way round gives a plausible number for every task in a chain and the right one for none.
    const first = at('runs first', 'awaiting_human')
    const second = at('runs after', 'blocked')
    tasks.addDependency(second, first)
    expect(tasks.blockedDependentsOf(first)).toBe(1)
    expect(tasks.blockedDependentsOf(second)).toBe(0)
  })

  it('says zero for a task nothing is waiting on', () => {
    expect(tasks.blockedDependentsOf(at('alone', 'awaiting_human'))).toBe(0)
  })
})
