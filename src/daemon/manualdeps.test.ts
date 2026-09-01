import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'

/**
 * The two edge methods as the pane actually calls them.
 *
 * ⛔ Through `buildApi`, not through `tasks.ts`. `dependents.test.ts` holds `attachDependency` and
 * `detachDependency` to their behaviour — the edge, the admission, the refusals — and this file
 * exists for the layer above it: the RPC pair is what the New Task form and the task ledger reach,
 * it returns the redrawn `dependencies` list beside the task, and *that* is the contract a renderer
 * breaks silently. A handler that returned the task alone would typecheck against a `Task` and leave
 * the pane drawing a list it had just changed from a fetch it never made.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let api: typeof import('./api.js')
let handlers: ReturnType<(typeof import('./api.js'))['buildApi']>

type EdgeResult = { task: Task; dependencies: Task[] }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-manualdeps-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'manualdeps.db'))
  handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
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

const add = (id: string, dependsOn: string): EdgeResult =>
  handlers['task.addDependency']({ id, dependsOn }) as EdgeResult
const drop = (id: string, dependsOn: string): EdgeResult =>
  handlers['task.removeDependency']({ id, dependsOn }) as EdgeResult

describe('the edge methods the panes call', () => {
  it('hands back the redrawn list beside the task, so the pane needs no second fetch', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })

    const added = add(second.id, first.id)
    expect(added.task.status).toBe('blocked')
    expect(added.dependencies.map((d) => d.id)).toEqual([first.id])
    // ⚠️ Rows, not ids. The ledger draws `t12 · title (status)` and has nothing to look them up in.
    expect(added.dependencies[0]?.title).toBe('runs first')

    const dropped = drop(second.id, first.id)
    expect(dropped.task.status).toBe('ready')
    expect(dropped.dependencies).toEqual([])
  })

  it('leaves a deleted prerequisite out of that list rather than drawing a blank row', () => {
    // ⛔ The same filter `task.get` applies. A pane that drew one list from `task.get` and another
    // from the edge call would show a row appearing and vanishing as things were clicked.
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    add(second.id, first.id)
    db.db().prepare('update tasks set deleted_at = ? where id = ?').run(Date.now(), first.id)

    const after = add(second.id, tasks.createTask({ title: 'and this one' }).id)
    expect(after.dependencies.map((d) => d.title)).toEqual(['and this one'])
    // ⚠️ The edge itself survives the delete: `dependsOn` still names it, and admission still
    // counts it. Only the drawing drops it.
    expect(after.task.dependsOn).toHaveLength(2)
  })

  it('is idempotent, so a double click files one edge and not two', () => {
    const first = tasks.createTask({ title: 'runs first' })
    const second = tasks.createTask({ title: 'runs after' })
    add(second.id, first.id)
    const again = add(second.id, first.id)
    expect(again.task.dependsOn).toEqual([first.id])
    expect(again.dependencies).toHaveLength(1)
  })

  it('refuses a cycle four edges long, not only the two-task one', () => {
    // ⛔ `reaches` walks the whole graph and this is the check that says so. A cycle found at the
    // door is an error message; one found by the scheduler is a deadlock nothing ever notices.
    const a = tasks.createTask({ title: 'a' })
    const b = tasks.createTask({ title: 'b' })
    const c = tasks.createTask({ title: 'c' })
    const d = tasks.createTask({ title: 'd' })
    add(b.id, a.id)
    add(c.id, b.id)
    add(d.id, c.id)
    expect(() => add(a.id, d.id)).toThrow(/cycle/)
    expect(tasks.requireTask(a.id).dependsOn).toEqual([])
  })

  it('refuses either end naming a task that does not exist', () => {
    // ⚠️ `removeDependency` on its own is a `delete` that matches nothing and reports success, so a
    // typo'd id would answer "done" and redraw an unchanged list as though something had happened.
    const a = tasks.createTask({ title: 'a' })
    expect(() => add(a.id, 'no-such-task')).toThrow()
    expect(() => add('no-such-task', a.id)).toThrow()
    expect(() => drop('no-such-task', a.id)).toThrow()
    expect(tasks.requireTask(a.id).status).toBe('ready')
  })
})

describe('filing a task that already names a prerequisite', () => {
  it('is born blocked, with no instant in which it could have been dispatched', () => {
    // ⛔ Why the New Task form sends `dependsOn` with the filing instead of adding the edge a moment
    // later: `createTask` writes the edges *before* it admits, so there is no window for a tick.
    const first = tasks.createTask({ title: 'runs first' })
    const second = handlers['task.create']({
      title: 'waits for it',
      dependsOn: [first.id]
    }) as Task
    expect(second.status).toBe('blocked')
    expect(second.dependsOn).toEqual([first.id])
  })

  it('leaves a draft a draft, prerequisite or not', () => {
    // ⚠️ `draft` is in `TERMINAL_OR_HELD`: somebody chose it, and an edge does not get to move a
    // task into the queue's derived states behind their back.
    const first = tasks.createTask({ title: 'runs first' })
    const draft = handlers['task.create']({
      title: 'a draft that waits',
      status: 'draft',
      dependsOn: [first.id]
    }) as Task
    expect(draft.status).toBe('draft')
    expect(draft.dependsOn).toEqual([first.id])
  })

  it('unblocks through the one path when the prerequisite completes', () => {
    // The point of the whole edge: nothing here presses anything. `admitDependents` is the only
    // route out of `blocked`, and it is called by whatever finishes the prerequisite.
    const first = tasks.createTask({ title: 'runs first' })
    const second = handlers['task.create']({
      title: 'waits for it',
      dependsOn: [first.id]
    }) as Task
    tasks.setStatus(first.id, 'completed')
    tasks.admitDependents(first.id)
    expect(tasks.requireTask(second.id).status).toBe('ready')
  })
})
