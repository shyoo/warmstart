import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * Lowering a capacity is deliberately forward-only.
 *
 * A person narrows a workspace pool or an account's parallelism to stop starting *new* work. It
 * must never turn a settings edit into an unannounced cancellation of the work already spending
 * that account or sitting in a worktree. These are database-backed active runs — no process is
 * spawned — so the assertions cover the durable facts a cancellation would change: session state,
 * open run, and workspace claim.
 */

let dir: string
let db: typeof import('./db.js')
let api: typeof import('./api.js')
let projects: typeof import('./projects.js')
let resources: typeof import('./resources.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')
let tasks: typeof import('./tasks.js')
let workers: typeof import('./workers.js')
let worktrees: typeof import('./worktrees.js')

let projectId: string
let project: Project

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function insertLiveSession(id: string, workerId: string, cwd: string): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, started_at)
       values (?, ?, 'claude-code', 'stream', ?, ?, 'live', ?)`
    )
    .run(id, workerId, projectId, cwd, Date.now())
}

function activeRun(workerId: string, cwd: string, number: number) {
  const task = tasks.createTask({ title: `active task ${number}`, projectId })
  const sessionId = `active-session-${number}`
  insertLiveSession(sessionId, workerId, cwd)
  return {
    task,
    sessionId,
    run: tasks.startRun({
      taskId: task.id,
      workerId,
      sessionId,
      projectId,
      quotaUnverified: false,
      costModelId: null
    })
  }
}

function expectStillRunning(active: ReturnType<typeof activeRun>): void {
  expect(sessions.getSession(active.sessionId)?.state).toBe('live')
  expect(tasks.runsFor(active.task.id).find((run) => run.id === active.run.id)?.endedAt).toBeNull()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-capacity-reduction-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  api = await import('./api.js')
  projects = await import('./projects.js')
  resources = await import('./resources.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  tasks = await import('./tasks.js')
  workers = await import('./workers.js')
  worktrees = await import('./worktrees.js')
  db.openDb(join(dir, 'capacity-reduction.db'))

  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'capacity test')
  git(root, 'config', 'user.email', 'capacity@example.invalid')
  writeFileSync(join(root, 'README.md'), 'capacity test\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'initial')
  project = projects.addProject({ root, name: 'capacity test' })
  projectId = project.id
})

beforeEach(async () => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
  db.db().exec('delete from workers')
  projects.setProjectPolicy(projectId, { poolSize: 3 })
  project = projects.requireProject(projectId)
  await worktrees.ensurePool(project)
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Registered temporary worktrees can retain a Windows handle briefly.
  }
})

describe('reducing capacity leaves work already underway alone', () => {
  it('keeps live runs and their claims when the workspace pool is narrowed below current use', async () => {
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'workspace worker', maxConcurrent: 3 })
    const poolId = resources.workspacePoolId(projectId)
    const members = resources.getResource(poolId)?.members ?? []
    expect(members).toHaveLength(3)

    const first = activeRun(worker.id, members[0]!, 1)
    const second = activeRun(worker.id, members[1]!, 2)
    expect(resources.claim(poolId, first.run.id, 1, members[0])).not.toBeNull()
    expect(resources.claim(poolId, second.run.id, 1, members[1])).not.toBeNull()

    await api.buildApi({ version: 'test', startedAt: Date.now(), port: 0 })['project.setPolicy']({
      id: projectId,
      poolSize: 1
    })

    expectStillRunning(first)
    expectStillRunning(second)
    const state = resources.availability(poolId)
    expect(state?.resource.capacity).toBe(1)
    expect(state?.claims.map((claim) => claim.holder)).toEqual([first.run.id, second.run.id])
    // The new ceiling applies to the next claimant; it never achieves the limit by releasing work.
    expect(resources.claim(poolId, 'later-run')).toBeNull()
  })

  it('keeps live runs on an account when its parallelism is reduced below current use', async () => {
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'parallel worker', maxConcurrent: 3 })
    const first = activeRun(worker.id, project.root, 1)
    const second = activeRun(worker.id, project.root, 2)

    const changed = await api.buildApi({ version: 'test', startedAt: Date.now(), port: 0 })['worker.update']({
      id: worker.id,
      maxConcurrent: 1
    })

    expect(changed.maxConcurrent).toBe(1)
    expectStillRunning(first)
    expectStillRunning(second)
    expect(sessions.sessionsForWorker(worker.id)).toHaveLength(2)
    // Just as importantly, later dispatches see the lower limit and wait instead of a third session.
    expect(scheduler.atCapacity(sessions.sessionsForWorker(worker.id), changed.maxConcurrent, null)).toBe(true)
  })
})
