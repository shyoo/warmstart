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

/**
 * An edge added by hand, after the task exists.
 *
 * ⛔ `addDependency` writes the edge and nothing else — correct inside `createTask`, where the row
 * has no derived status yet. A person adding a prerequisite to a task already sitting at `ready` is
 * asking for the consequence as well: without the `admit()` in `attachDependency` that task stays
 * dispatchable and runs before the thing it was just told to wait for.
 */
describe('adding and dropping a prerequisite by hand', () => {
  it('blocks a ready task the moment the edge is made', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    expect(tasks.requireTask(second.id).status).toBe('ready')
    const blocked = tasks.attachDependency(second.id, first.id)
    expect(blocked.status).toBe('blocked')
    expect(blocked.dependsOn).toEqual([first.id])
  })

  it('releases the task when the last prerequisite is dropped', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    expect(tasks.detachDependency(second.id, first.id).status).toBe('ready')
  })

  it('keeps the task blocked while another prerequisite is unmet', () => {
    const a = tasks.createTask({ title: 'one' })
    const b = tasks.createTask({ title: 'two' })
    const waiting = tasks.createTask({ title: 'waits on both' })
    tasks.attachDependency(waiting.id, a.id)
    tasks.attachDependency(waiting.id, b.id)
    expect(tasks.detachDependency(waiting.id, a.id).status).toBe('blocked')
  })

  it('does not claw back a run already in flight', () => {
    // ⚠️ `admit()` refuses every status in TERMINAL_OR_HELD, and that is the intended answer here:
    // the edge is recorded and applies to the next dispatch. Stopping a live agent mid-thought
    // because somebody edited the plan around it would be the more surprising of the two.
    const first = at('runs first', 'awaiting_human')
    const running = at('already going', 'running')
    expect(tasks.attachDependency(running, first).status).toBe('running')
    expect(tasks.requireTask(running).dependsOn).toEqual([first])
  })

  it('refuses an edge that would close a cycle, and leaves the task alone', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    expect(() => tasks.attachDependency(first.id, second.id)).toThrow(/cycle/)
    expect(tasks.requireTask(first.id).dependsOn).toEqual([])
  })

  it('refuses to make a task wait on itself', () => {
    const only = tasks.createTask({ title: 'alone' })
    expect(() => tasks.attachDependency(only.id, only.id)).toThrow(/itself/)
  })

  it('says what happened in the thread, both ways', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    tasks.detachDependency(second.id, first.id)
    const said = tasks.messagesFor(second.id).map((m) => m.text)
    expect(said.some((t) => t.includes(`Now waits on t${first.seq}`))).toBe(true)
    expect(said.some((t) => t.includes(`No longer waits on t${first.seq}`))).toBe(true)
  })
})

/**
 * A completion releases what was waiting on it, whichever path completed it.
 *
 * ⛔ **The failure these pin, measured 2026-09-04.** t192 finished, failed to land twice, rested at
 * `awaiting_human`, and was landed by hand — `relandTask`, which writes `completed` and had no
 * `admitDependents` beside it. t193 sat at `blocked` behind a prerequisite that was finished, and
 * nothing in the system was ever going to look again. `decomposeTask` had the same hole. Both were
 * *call sites*, which is why the fix is not a third call: `setStatus` admits on the transition, so
 * the seven places that complete a task cannot each be wrong in their own way.
 */
describe('a completion admits what waits on it', () => {
  it('releases a blocked dependent the moment the status is written', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    expect(tasks.requireTask(second.id).status).toBe('blocked')

    // ⛔ `setStatus` alone — no `admitDependents`, no scheduler. That is the whole claim: the paths
    // that stranded t193 did exactly this and nothing more.
    tasks.setStatus(first.id, 'completed')
    expect(tasks.requireTask(second.id).status).toBe('ready')
  })

  it('leaves a dependent blocked while another prerequisite is unfinished', () => {
    const a = tasks.createTask({ title: 'one' })
    const b = tasks.createTask({ title: 'two' })
    const waiting = tasks.createTask({ title: 'waits on both' })
    tasks.attachDependency(waiting.id, a.id)
    tasks.attachDependency(waiting.id, b.id)
    tasks.setStatus(a.id, 'completed')
    expect(tasks.requireTask(waiting.id).status).toBe('blocked')
    tasks.setStatus(b.id, 'completed')
    expect(tasks.requireTask(waiting.id).status).toBe('ready')
  })

  it('does not release a dependent when the prerequisite stops any other way', () => {
    // ⚠️ The inverse, and the reason admission recomputes rather than fires. `failed`, `cancelled`
    // and `awaiting_human` are all *stopped*, and none of them is *done*.
    for (const status of ['failed', 'cancelled', 'awaiting_human'] as const) {
      const first = tasks.createTask({ title: `runs first (${status})` })
      const second = tasks.createTask({ title: `runs after (${status})` })
      tasks.attachDependency(second.id, first.id)
      tasks.setStatus(first.id, status)
      expect(tasks.requireTask(second.id).status).toBe('blocked')
    }
  })

  it("releases a `settled` edge on a prerequisite that failed, from the same write", () => {
    // ⛔ The half `completed` alone would have missed. `task_split` writes `require: 'settled'`
    // precisely so a planner is woken by the pieces that *failed* — and outside `cancelTask`, no
    // production path admitted on a failure at all, so the planner's own resolution turn depended
    // on a call nobody made.
    const child = tasks.createTask({ title: 'a piece' })
    const planner = tasks.createTask({ title: 'the planner' })
    tasks.addDependency(planner.id, child.id, 'settled')
    tasks.admit(planner.id)
    expect(tasks.requireTask(planner.id).status).toBe('blocked')

    tasks.setStatus(child.id, 'failed')
    expect(tasks.requireTask(planner.id).status).toBe('ready')
  })

  it('does not walk the graph again when a completed task is re-written', () => {
    // ⚠️ Only the transition admits. A completed task whose row is re-written — an assignee, a hold
    // reason — is not a second completion, and a dependent a person has since put back to `draft`
    // must not be dragged into the queue by it.
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    tasks.setStatus(first.id, 'completed')
    tasks.setStatus(second.id, 'draft')
    tasks.setStatus(first.id, 'completed', { assignee: null })
    expect(tasks.requireTask(second.id).status).toBe('draft')
  })
})

/**
 * The backstop, for the rows the missing calls already stranded.
 *
 * ⚠️ Nothing about a `blocked` task expires, so a single missed admission is permanent. `t193` was
 * seven hours old when a person noticed. This sweep is what makes the failure cost one tick.
 */
describe('the blocked-task sweep', () => {
  it('releases a task stranded behind a prerequisite that already completed', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.addDependency(second.id, first.id)
    // ⛔ The stranded state, built the way the bug built it: the edge written, the prerequisite
    // completed, and the dependent left at `blocked` because nobody admitted it.
    db.db().prepare("update tasks set status = 'completed' where id = ?").run(first.id)
    db.db().prepare("update tasks set status = 'blocked' where id = ?").run(second.id)

    expect(tasks.admitBlocked()).toBe(1)
    expect(tasks.requireTask(second.id).status).toBe('ready')
  })

  it('leaves a genuine block alone, and says so by releasing nothing', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.attachDependency(second.id, first.id)
    expect(tasks.admitBlocked()).toBe(0)
    expect(tasks.requireTask(second.id).status).toBe('blocked')
  })

  it('ignores a task somebody deleted', () => {
    // ⚠️ A soft-deleted row keeps its status and its edges. Putting one back in the queue would
    // dispatch work that is not on anybody's board.
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    tasks.addDependency(second.id, first.id)
    db.db().prepare("update tasks set status = 'completed' where id = ?").run(first.id)
    db.db().prepare("update tasks set status = 'blocked', deleted_at = ? where id = ?").run(Date.now(), second.id)
    expect(tasks.admitBlocked()).toBe(0)
    expect(tasks.requireTask(second.id).status).toBe('blocked')
  })
})
