import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Which ticket is in which tree, on which account.
 *
 * ⛔ **The claim is the binding, and this is the test that says so.** The first Flow board drew
 * tasks in lanes and workspaces in a strip below them, and joined neither — so the running column,
 * the one an operator opens the view for, could not say who was handling what. Matching a live
 * session's `cwd` to a worktree path would have looked like a fix and gone silent for the two states
 * that matter most: a task holding its tree *between* runs, and a landing attempt with no agent in
 * the tree at all. Both are asserted below.
 *
 * ⚠️ The pool is declared straight into the broker, as `poolgate.test.ts` does. What is under test
 * is the resolution of a claim's holder; `worktrees.test.ts` owns the git.
 */

let dir: string
let db: typeof import('./db.js')
let resources: typeof import('./resources.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let workers: typeof import('./workers.js')
let flow: typeof import('./flow.js')

let projectId: string
let poolId: string
let workerId: string

const WS1 = 'C:\\ws\\ws1'
const WS2 = 'C:\\ws\\ws2'
const WS3 = 'C:\\ws\\ws3'

function declarePool(members = [WS1, WS2, WS3]): void {
  resources.upsertResource({
    id: poolId,
    projectId,
    kind: 'counted',
    label: 'demo workspaces',
    members,
    meta: {}
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-flow-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  resources = await import('./resources.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  workers = await import('./workers.js')
  flow = await import('./flow.js')
  db.openDb(join(dir, 'flow.db'))

  const root = mkdtempSync(join(tmpdir(), 'agentyard-flow-project-'))
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  projectId = projects.addProject({ root, name: 'demo' }).id
  poolId = resources.workspacePoolId(projectId)
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from tasks')
  declarePool()
  workerId = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeSecond', enabled: true }).id
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

/** A live `work` session in `cwd`, the way a dispatch leaves one. */
function session(id: string, cwd: string): string {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at, project_id, current_branch)
       values (?,?,'claude-code','stream',?,'live','work',0,?,?,?)`
    )
    .run(id, workerId, cwd, Date.now(), projectId, 'multi-agent-controller/t1-demo')
  return id
}

function file(title: string): string {
  return tasks.createTask({ title, projectId }).id
}

function rowFor(label: string): import('@shared/tasks.js').FlowWorkspace {
  const found = flow.flowWorkspaces(projectId).find((w) => w.label === label)
  expect(found, `no row for ${label}`).toBeDefined()
  return found!
}

describe('the ticket ↔ workspace ↔ worker binding the Flow board draws', () => {
  it('names the ticket, the tree and the account for a session holding a claim', () => {
    const taskId = file('the running one')
    const sessionId = session('s1', WS2)
    tasks.startRun({
      taskId,
      workerId,
      sessionId,
      projectId,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(taskId, 'running')
    // The claim starts on the task and is passed to its session, exactly as `dispatch` does it.
    const claim = resources.claim(poolId, taskId, 1, WS2)
    expect(claim).not.toBeNull()
    resources.reassignClaim(claim!.id, sessionId)

    const row = rowFor('ws2')
    expect(row.taskSeq).toBe(tasks.requireTask(taskId).seq)
    expect(row.holding).toBe('session')
    expect(row.workerLabel).toBe('ClaudeSecond')
    expect(row.adapterId).toBe('claude-code')
    expect(row.sessionId).toBe(sessionId)
    expect(row.branch).toBe('multi-agent-controller/t1-demo')
  })

  it('still names the account for a task holding its tree between runs', () => {
    // ⛔ The case a `cwd` match cannot answer on its own: the run has ended, the claim is back on the
    // task, and the operator has to know which account it will go back to.
    const taskId = file('waiting on a person')
    const sessionId = session('s2', WS1)
    const run = tasks.startRun({
      taskId,
      workerId,
      sessionId,
      projectId,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(taskId, 'awaiting_human')
    expect(resources.claim(poolId, taskId, 1, WS1)).not.toBeNull()

    const row = rowFor('ws1')
    expect(row.holding).toBe('task')
    expect(row.taskStatus).toBe('awaiting_human')
    expect(row.workerLabel).toBe('ClaudeSecond')
  })

  it('reads the account off the last run when nothing is open in the tree', () => {
    const taskId = file('parked with its tree')
    const run = tasks.startRun({
      taskId,
      workerId,
      sessionId: null,
      projectId,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'completed')
    expect(resources.claim(poolId, taskId, 1, WS3)).not.toBeNull()

    const row = rowFor('ws3')
    expect(row.sessionId).toBeNull()
    // ⚠️ `ranOn`, not a guess: the account that spent the tokens is still who this tree belongs to.
    expect(row.workerLabel).toBe('ClaudeSecond')
  })

  it('calls a landing attempt what it is, with no agent in the tree', () => {
    const taskId = file('landing now')
    expect(resources.claim(poolId, `reland:${taskId}`, 1, WS1)).not.toBeNull()

    const row = rowFor('ws1')
    expect(row.holding).toBe('landing')
    expect(row.taskSeq).toBe(tasks.requireTask(taskId).seq)
    expect(row.sessionId).toBeNull()
  })

  it('lists every free member, so the width of the pool is readable', () => {
    const rows = flow.flowWorkspaces(projectId)
    expect(rows.map((r) => r.label)).toEqual(['ws1', 'ws2', 'ws3'])
    expect(rows.every((r) => r.holding === null && r.taskId === null)).toBe(true)
    expect(rows.every((r) => r.inPool)).toBe(true)
  })

  it('remembers the worker and branch that last used a tree when the session has closed', () => {
    session('s-closed', WS2)
    db.db().prepare("update sessions set state = 'closed' where id = 's-closed'").run()

    const row = rowFor('ws2')
    expect(row.holding).toBeNull()
    expect(row.taskId).toBeNull()
    expect(row.workerLabel).toBe('ClaudeSecond')
    expect(row.branch).toBe('multi-agent-controller/t1-demo')
  })

  it('keeps drawing a claim on a member the pool no longer lists', () => {
    // ⛔ A narrowed `poolSize` does not end a run. Dropping the row would hide a task that is
    //    plainly working — see the note on `project.setPolicy` in api.ts.
    const taskId = file('outside the new pool')
    expect(resources.claim(poolId, taskId, 1, WS3)).not.toBeNull()
    declarePool([WS1, WS2])

    const rows = flow.flowWorkspaces(projectId)
    expect(rows.map((r) => r.label)).toEqual(['ws1', 'ws2', 'ws3'])
    const stale = rows.find((r) => r.label === 'ws3')!
    expect(stale.inPool).toBe(false)
    expect(stale.taskSeq).toBe(tasks.requireTask(taskId).seq)
  })

  it('answers empty for a project whose pool has never been built', () => {
    // ⛔ And it builds nothing on the way: opening a tab may not create worktrees.
    const other = projects.addProject({
      root: mkdtempSync(join(tmpdir(), 'agentyard-flow-empty-')),
      name: 'never dispatched'
    })
    expect(flow.flowWorkspaces(other.id)).toEqual([])
  })
})
