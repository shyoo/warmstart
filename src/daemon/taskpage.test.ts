import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  statusesForViews,
  TASK_VIEWS,
  TASK_VIEW_ORDER,
  viewForStatus,
  type TaskStatus,
  type TaskView
} from '@shared/tasks.js'

/**
 * Filtering and paging the task table.
 *
 * ⛔ This moved into the daemon rather than staying in React, and the reason is the event stream: the
 * list re-fetches on every `task.changed` the fleet emits — several a second on a working fleet — so
 * shipping every task in a project across the boundary each time to throw most of them away is a
 * cost that grows with exactly the thing paging exists to survive.
 *
 * The three ways this goes silently wrong, each pinned below:
 *   1. **A bucket that misses a status.** It vanishes from every view except All, and nobody notices
 *      until a task somebody is waiting on is in it.
 *   2. **Counts that follow the filter.** `Needs you 0` while three tasks wait on you, because you
 *      happened to be looking at Done.
 *   3. **An unstable sort.** A pager over an order that is not total drops and repeats rows between
 *      pages, and both look like data loss.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')

const OTHER_PROJECT = 'other-project'

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota',
  'paused_user',
  'cancelling',
  'cancelled',
  'completed',
  'failed'
]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskpage-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'taskpage.db'))
  // A real row, because `tasks.project_id` is a foreign key. Filtering by a project that does not
  // exist is not the case under test here.
  db.db()
    .prepare(
      `insert into projects (id, name, root, vcs, config_json, created_at)
       values (?,?,?,?,'{}',?)`
    )
    .run(OTHER_PROJECT, 'other', join(dir, 'other'), 'none', Date.now())
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

const at = (title: string, status: TaskStatus, projectId?: string): string => {
  const t = tasks.createTask(projectId ? { title, projectId } : { title })
  tasks.setStatus(t.id, status)
  return t.id
}

// ---------------------------------------------------------------------------- the buckets

describe('the buckets a status can be in', () => {
  it('puts every status in a bucket', () => {
    // ⛔ The failure this exists for, and it is a *future* one: somebody adds a status to TaskStatus
    // and not to TASK_VIEWS, and every task in it becomes unreachable from any chip. Nothing else in
    // the app would complain — the table still renders, the counts still add up, and the rows are
    // simply gone.
    const missing = ALL_STATUSES.filter((s) => viewForStatus(s) === null)
    expect(missing).toEqual([])
  })

  it('puts every status in exactly one bucket', () => {
    // ⭐ Disjointness is what makes a multi-select a plain union. A status in two buckets would be
    // returned once by the query and counted twice by the chips, so the numbers above the table
    // would disagree with the table — and only when two particular chips were selected together.
    for (const status of ALL_STATUSES) {
      const holding = Object.entries(TASK_VIEWS).filter(([, list]) =>
        (list as readonly string[]).includes(status)
      )
      expect(holding.map(([view]) => view)).toHaveLength(1)
    }
  })

  it('names no status that is not a status', () => {
    // The other direction: a bucket referring to a status that was renamed away silently narrows
    // itself, and a chip that quietly matches less than it says is worse than one that errors.
    for (const list of Object.values(TASK_VIEWS)) {
      for (const status of list) expect(ALL_STATUSES).toContain(status)
    }
  })

  it('draws every bucket exactly once, so a chip cannot go missing from the row', () => {
    expect(TASK_VIEW_ORDER.map((v) => v.id).sort()).toEqual(Object.keys(TASK_VIEWS).sort())
  })

  it('reads an empty selection as no filter rather than as nothing', () => {
    // ⛔ All is the *empty* selection. Reading it as "match none" would render an empty table for the
    // default view, which is the first thing anybody sees.
    expect(statusesForViews([])).toEqual([])
  })

  it('unions the statuses of several buckets', () => {
    const picked = statusesForViews(['needs_you', 'done'])
    expect(picked).toContain('awaiting_human')
    expect(picked).toContain('paused_user')
    expect(picked).toContain('completed')
    expect(picked).not.toContain('running')
  })
})

// ---------------------------------------------------------------------------- filtering

describe('showing only the buckets that were asked for', () => {
  beforeEach(() => {
    at('running one', 'running')
    at('waiting on me', 'awaiting_human')
    at('parked', 'paused_user')
    at('finished', 'completed')
    at('broken', 'failed')
  })

  it('returns everything when nothing is selected', () => {
    expect(tasks.pageTasks({}).tasks).toHaveLength(5)
    expect(tasks.pageTasks({ views: [] }).total).toBe(5)
  })

  it('returns one bucket', () => {
    const page = tasks.pageTasks({ views: ['done'] })
    expect(page.tasks.map((t) => t.title)).toEqual(['finished'])
    expect(page.total).toBe(1)
  })

  it('returns the union of several, with each row once', () => {
    // ⭐ The property the whole multi-select rests on. Two buckets that overlapped would return the
    // same task twice here, and React would draw two rows with the same key.
    const page = tasks.pageTasks({ views: ['needs_you', 'done'] })
    const titles = page.tasks.map((t) => t.title).sort()
    expect(titles).toEqual(['finished', 'parked', 'waiting on me'])
    expect(new Set(page.tasks.map((t) => t.id)).size).toBe(3)
    expect(page.total).toBe(3)
  })

  it('hides deleted tasks, and counts them nowhere', () => {
    const gone = at('deleted', 'completed')
    db.db().prepare('update tasks set deleted_at = ? where id = ?').run(Date.now(), gone)
    const page = tasks.pageTasks({ views: ['done'] })
    expect(page.tasks.map((t) => t.title)).toEqual(['finished'])
    expect(page.total).toBe(1)
    expect(page.counts.done).toBe(1)
  })

  it('keeps to one project', () => {
    at('elsewhere', 'running', OTHER_PROJECT)
    const page = tasks.pageTasks({ projectId: OTHER_PROJECT })
    expect(page.tasks.map((t) => t.title)).toEqual(['elsewhere'])
    expect(page.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------- the counts

describe('the numbers on the chips', () => {
  beforeEach(() => {
    at('a', 'running')
    at('b', 'running')
    at('c', 'awaiting_human')
    at('d', 'completed')
  })

  it('counts each bucket', () => {
    const { counts } = tasks.pageTasks({})
    expect(counts).toEqual({ active: 2, needs_you: 1, blocked: 0, done: 1, failed: 0 })
  })

  it('does not follow the selection', () => {
    // ⭐ The bug worth pinning. A chip whose count reflected the current filter would read
    // `Needs you 0` while somebody was waiting on you, purely because you were looking at Done — so
    // the number would only ever be right for the chip you had already clicked.
    expect(tasks.pageTasks({ views: ['done'] }).counts).toEqual(
      tasks.pageTasks({}).counts
    )
  })

  it('does not follow the page either', () => {
    // ⚠️ Counts are over the whole scope, not the rows returned. A count computed from `tasks.length`
    // would be capped by the page size, so it would be correct on page one of a short list and wrong
    // everywhere else — the hardest version of this to notice.
    expect(tasks.pageTasks({ limit: 1 }).counts.active).toBe(2)
  })

  it('still follows the project', () => {
    // ⛔ Scope is not selection. The chips describe *this project's* work; a fleet-wide count above a
    // project's table would send somebody looking for tasks that are not on the screen.
    at('elsewhere', 'running', OTHER_PROJECT)
    expect(tasks.pageTasks({ projectId: OTHER_PROJECT }).counts.active).toBe(1)
  })

  it('reports zero for a bucket with nothing in it, rather than leaving it out', () => {
    // A missing key renders as `undefined` in a chip. Every bucket answers.
    const { counts } = tasks.pageTasks({})
    for (const view of Object.keys(TASK_VIEWS) as TaskView[]) {
      expect(typeof counts[view]).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------- paging

describe('handing back one page at a time', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) at(`task ${i}`, 'running')
  })

  it('returns the page asked for, and the total behind it', () => {
    const page = tasks.pageTasks({ limit: 2, offset: 0 })
    expect(page.tasks).toHaveLength(2)
    expect(page.total).toBe(5)
  })

  it('walks the whole list without dropping or repeating a row', () => {
    // ⭐ What an unstable sort breaks, and it breaks it invisibly: every page renders, and one task
    // is simply never seen while another appears twice. These tasks are filed in the same
    // millisecond, which is the case that has no answer without a tie-break.
    const seen: string[] = []
    for (let offset = 0; offset < 5; offset += 2) {
      seen.push(...tasks.pageTasks({ limit: 2, offset }).tasks.map((t) => t.id))
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('returns an empty page past the end, and still says how many there are', () => {
    const page = tasks.pageTasks({ limit: 2, offset: 99 })
    expect(page.tasks).toEqual([])
    expect(page.total).toBe(5)
    expect(page.counts.active).toBe(5)
  })

  it('caps what one call can be asked for', () => {
    // ⛔ A bound, not a preference. This is reachable from anything that can call the RPC, and an
    // unbounded page is a request to serialise the table into a websocket frame.
    expect(tasks.taskPageSize(10_000)).toBe(200)
    expect(tasks.taskPageSize(0)).toBe(1)
    expect(tasks.taskPageSize(-1)).toBe(1)
    expect(tasks.taskPageSize()).toBe(50)
  })
})

// ---------------------------------------------------------------------------- ordering

describe('what order they come back in', () => {
  it('puts the most recently touched first by default', () => {
    const older = at('older', 'running')
    const newer = at('newer', 'running')
    db.db().prepare('update tasks set updated_at = ? where id = ?').run(1_000, older)
    db.db().prepare('update tasks set updated_at = ? where id = ?').run(2_000, newer)
    expect(tasks.pageTasks({}).tasks.map((t) => t.title)).toEqual(['newer', 'older'])
  })

  it('orders by when it was filed when asked to', () => {
    const first = at('filed first', 'running')
    const second = at('filed second', 'running')
    db.db().prepare('update tasks set created_at = ? where id = ?').run(1_000, first)
    db.db().prepare('update tasks set created_at = ? where id = ?').run(2_000, second)
    expect(tasks.pageTasks({ sort: 'created', asc: true }).tasks.map((t) => t.title)).toEqual([
      'filed first',
      'filed second'
    ])
  })

  it('orders by task number when asked to', () => {
    at('one', 'running')
    at('two', 'running')
    expect(tasks.pageTasks({ sort: 'seq', asc: true }).tasks.map((t) => t.seq)).toEqual([1, 2])
    expect(tasks.pageTasks({ sort: 'seq' }).tasks.map((t) => t.seq)).toEqual([2, 1])
  })

  it('breaks a tie on the task number, in the direction it was asked for', () => {
    // ⚠️ Two tasks filed in the same millisecond — which the plan decomposer produces routinely —
    // have no order at all without a tie-break, and a pager over a partial order drops and repeats
    // rows between pages. Both look like data loss.
    //
    // ⛔ Asserted as an **order**, not as "asked twice, answered the same". That weaker version
    // passed with the tie-break deleted: SQLite happens to fall back to rowid, which is stable and
    // is also insertion order — so the test agreed with itself while pinning nothing. The direction
    // is what rowid cannot fake, because it never reverses.
    for (let i = 0; i < 4; i++) at(`same instant ${i}`, 'running')
    db.db().exec('update tasks set updated_at = 5000')
    expect(tasks.pageTasks({}).tasks.map((t) => t.seq)).toEqual([4, 3, 2, 1])
    expect(tasks.pageTasks({ asc: true }).tasks.map((t) => t.seq)).toEqual([1, 2, 3, 4])
  })
})
