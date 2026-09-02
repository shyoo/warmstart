import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * A project with nowhere left to work.
 *
 * ⛔ **Measured 2026-08-29, and it cost a task.** The enabled fleet could run five sessions at once
 * (ClaudeSecond at 2, Antigravity at 3) against a workspace pool of three, so a fourth task was
 * structurally guaranteed rather than unlucky. t40 was routed — spending a controller consult — then
 * dispatched, then killed by the one line in `dispatch` that asks the pool for a worktree:
 *
 * ```
 * 22:10:18  consult route answered on ClaudeSecond: t40 routed to ClaudeSecond
 * 22:10:23  dispatch of t40 failed: no free workspace in multi_agent_controller
 * 22:10:23  t40 assigned -> failed
 * 22:10:31  landed t38 (0148aa9d) onto main            ← a worktree freed, eight seconds later
 * ```
 *
 * `failed` is terminal, so nothing brought it back. Two rules come out of that, and both are tested
 * here: **a contended resource is a hold, never a failure**, and **a hold is re-decided every tick
 * rather than written down as a dependency** — because an edge onto whoever happens to hold the pool
 * would outlive the contention that created it and send a P0 to the back of the queue.
 *
 * ⚠️ The pool here is declared straight into the broker rather than built out of real worktrees.
 * What is under test is the gate's reading of the broker; `worktrees.test.ts` owns the git.
 */

let dir: string
let db: typeof import('./db.js')
let resources: typeof import('./resources.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let workers: typeof import('./workers.js')

let projectId: string
let poolId: string

const members = ['ws1', 'ws2', 'ws3']

function declarePool(): void {
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
  dir = mkdtempSync(join(tmpdir(), 'agentyard-poolgate-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  resources = await import('./resources.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'poolgate.db'))

  const root = mkdtempSync(join(tmpdir(), 'agentyard-poolgate-project-'))
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  projectId = projects.addProject({ root, name: 'demo' }).id
  poolId = resources.workspacePoolId(projectId)
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
  projects.setProjectPolicy(projectId, { poolSize: 3 })
  declarePool()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

/** Fill the pool the way running tasks would. */
function fill(n = 3): void {
  for (let i = 0; i < n; i++) expect(resources.claim(poolId, `holder-${i}`)).not.toBeNull()
}

function freeOne(): void {
  const held = resources.availability(poolId)?.claims[0]
  expect(held).toBeDefined()
  resources.release(held!.id)
}

function file(title: string, priority?: 'P0' | 'P2'): string {
  return tasks.createTask({ title, projectId, priority }).id
}

function pressureOn(id: string): string | null {
  return scheduler.poolPressure(tasks.requireTask(id))
}

function reasonFor(id: string): string {
  return tasks.requireTask(id).holdReason ?? ''
}

describe('the gate in front of a full workspace pool', () => {
  it('holds the fourth task instead of dispatching it', () => {
    fill()
    expect(pressureOn(file('the fourth'))).toMatch(/workspace/)
  })

  it('lets a task through while a member is still free', () => {
    // ⚠️ Two of three. The gate must read what is *free*, not what is *held* — a pool holding
    //    anything at all is the normal state of a working fleet.
    fill(2)
    expect(pressureOn(file('the third'))).toBeNull()
  })

  it('names the project and the pool size, because the row is where the operator looks', () => {
    fill()
    const said = pressureOn(file('held'))
    expect(said).toContain('demo')
    expect(said).toContain('3')
  })

  it('lets the first task through after the configured pool grows, so its claim can create ws4', () => {
    fill()
    projects.setProjectPolicy(projectId, { poolSize: 4 })

    // `ensurePool` runs inside the following dispatch. Holding it here would make a three-to-four
    // change self-sealing: the dispatch which could create ws4 would never be attempted.
    expect(pressureOn(file('the new fourth workspace'))).toBeNull()
  })

  it('honours a smaller configured pool before its member list is reconciled', () => {
    // The broker still has four members from before the setting changed, but the new cap means a
    // third active task fills the pool now. The next claim will replace that stale member list.
    resources.upsertResource({
      id: poolId,
      projectId,
      kind: 'counted',
      label: 'demo workspaces',
      members: [...members, 'ws4'],
      meta: {}
    })
    fill()
    projects.setProjectPolicy(projectId, { poolSize: 3 })

    expect(pressureOn(file('must wait for the smaller pool'))).toContain('3 workspace')
  })

  it('says nothing about a task that belongs to no project', () => {
    // ⛔ A projectless task holds no workspace and never asks the pool for one. Holding it on a full
    //    pool would stop the one kind of work that could still run.
    fill()
    const orphan = tasks.createTask({ title: 'no project' }).id
    expect(pressureOn(orphan)).toBeNull()
  })

  it('lets the first task through a pool nobody has built yet', () => {
    // ⛔ `ensurePool` creates the worktrees on the first dispatch. A project that has never run has
    //    no resource row, and reading that as "full" would hold every task in it forever — the pool
    //    exists in order to be created.
    db.db().prepare('delete from resources where id = ?').run(poolId)
    expect(pressureOn(file('the very first'))).toBeNull()
    declarePool()
  })

  it('lifts the hold the moment a workspace comes back', () => {
    fill()
    const waiting = file('waiting')
    expect(pressureOn(waiting)).not.toBeNull()
    freeOne()
    expect(pressureOn(waiting)).toBeNull()
  })
})

describe('the ways past a full pool that are not a free member', () => {
  it('lets a task return to the workspace it kept while awaiting a person', () => {
    // Its retained member makes the pool look full, but this task is not competing for one: dispatch
    // transfers that claim to its next session. Holding it here would make a closed-question task
    // impossible to resume without first giving its workspace away.
    fill(2)
    const parked = file('kept its workspace for a reply')
    expect(resources.claim(poolId, parked, 1, 'ws3')).not.toBeNull()
    expect(pressureOn(parked)).toBeNull()
  })

  it('lets a task with a warm session through, because reusing one claims nothing', () => {
    // ⛔ **The gate would otherwise refuse the cheapest move the cost model has.** A task continued
    //    in a conversation that never closed does not ask the pool for anything — the session is
    //    already sitting in the workspace it holds, and `dispatch` skips the claim entirely for it.
    //    Holding such a task on a full pool would mean a reply to an `awaiting_human` task could
    //    never be delivered while three others were running.
    fill()
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'warm' })
    const continued = file('has somewhere to go')
    expect(pressureOn(continued)).not.toBeNull()

    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, started_at)
         values (?, ?, 'claude-code', 'stream', ?, 'ws1', 'idle', ?)`
      )
      .run('warm-session', worker.id, projectId, Date.now())
    const run = tasks.startRun({
      taskId: continued,
      workerId: worker.id,
      sessionId: 'warm-session',
      projectId,
      quotaUnverified: false,
      costModelId: null
    })
    // ⚠️ Finished, because a session mid-turn is busy and `warmSessionFor` returns only idle ones.
    tasks.finishRun(run.id, 'completed')

    expect(pressureOn(continued)).toBeNull()
  })
})

describe('a hold rather than a dependency', () => {
  it('records no edge onto whoever is holding the pool', () => {
    // ⭐ **The whole reason this is a gate and not `addDependency`.** An edge would pin this task
    //    behind one specific task, survive the contention that created it, and — walked by
    //    `admitDependents` — hand a finished task back to an agent.
    fill()
    const held = file('held')
    pressureOn(held)
    expect(tasks.requireTask(held).dependsOn).toEqual([])
  })

  it('re-decides every tick, so a P0 filed later is not stuck behind the older task', () => {
    // ⛔ This is what a dependency edge would have broken. Both are held while the pool is full; when
    //    a slot opens, `schedulingOrder` picks the winner from scratch — and it is the urgent one,
    //    not the one that has been waiting longest.
    fill()
    const older = file('filed first', 'P2')
    const urgent = file('filed later', 'P0')
    expect(pressureOn(older)).not.toBeNull()
    expect(pressureOn(urgent)).not.toBeNull()

    freeOne()
    const queue = [tasks.requireTask(older), tasks.requireTask(urgent)].sort(tasks.schedulingOrder)
    expect(queue[0]?.id).toBe(urgent)
  })
})

describe('the tick, end to end', () => {
  it('holds the task at ready and never marks it failed', async () => {
    // ⭐ t40, reproduced. Before this gate the same conditions produced `assigned -> failed`, which
    //    is terminal — the eight seconds until a worktree freed made no difference at all.
    fill()
    const stuck = file('t40')
    await scheduler.tick()
    expect(tasks.requireTask(stuck).status).toBe('ready')
    expect(reasonFor(stuck)).toMatch(/workspace/)
  })

  it('stops holding on the pool once one is free', async () => {
    fill()
    const stuck = file('t40')
    await scheduler.tick()
    expect(reasonFor(stuck)).toMatch(/workspace/)

    freeOne()
    await scheduler.tick()
    // ⚠️ There is no worker in this fixture, so the task is still held — by the *worker* gate, which
    //    is exactly the point: the pool has stopped being the thing in its way.
    expect(reasonFor(stuck)).not.toMatch(/workspace/)
    expect(tasks.requireTask(stuck).status).toBe('ready')
  })
})

describe('deciding what a thrown dispatch means', () => {
  it('sends a contended task back to ready', () => {
    const verdict = scheduler.afterFailedDispatch(
      new resources.Contended('no free workspace in demo', poolId)
    )
    expect(verdict.status).toBe('ready')
    expect(verdict.reason).toBe('no free workspace in demo')
  })

  it('still fails everything that is actually broken', () => {
    // ⛔ The narrowness is the safety. A `prepare` hook that exits non-zero fails identically in ten
    //    seconds, and retrying it would turn one legible error into an unbounded loop of the same
    //    one. Only contention meets a different world on the next attempt.
    expect(scheduler.afterFailedDispatch(new Error('prepare hook exited 1')).status).toBe('failed')
    expect(scheduler.afterFailedDispatch('worktree is locked').status).toBe('failed')
  })

  it('never returns assigned, which is where the task would strand', () => {
    // ⚠️ `dispatch` sets `assigned` before it claims anything, and `assigned` is in
    //    `TERMINAL_OR_HELD` — a task left there is one `admit` will not touch again.
    const verdict = scheduler.afterFailedDispatch(new resources.Contended('busy', poolId))
    expect(verdict.status).not.toBe('assigned')
  })
})
