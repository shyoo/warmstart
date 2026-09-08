import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

/**
 * Dispatching scenarios and concurrency capacity tracking.
 *
 * ⛔ Measured on t255: a task manually launched on ClaudeFirst (which had capacity) was queued with
 * "ClaudeFirst at capacity" because an earlier task (t249) that had run on ClaudeFirst and completed
 * on ClaudeSecond left an unclosed run with ended_at = null in the database.
 *
 * `runningTaskReservations` counted that run as an active reservation on ClaudeFirst even though the
 * task was completed, permanently wedging ClaudeFirst at capacity (1/1).
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let residency: typeof import('./residency.js')
let scoring: typeof import('./scoring.js')

let origClaudeInstalled: () => boolean

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-dispatching-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  residency = await import('./residency.js')
  scoring = await import('./scoring.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  origClaudeInstalled = claudeCode.isInstalled
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'dispatching.db'))
})

afterAll(async () => {
  if (origClaudeInstalled) {
    const { claudeCode } = await import('./adapters/claude-code.js')
    claudeCode.isInstalled = origClaudeInstalled
  }
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows file locks
  }
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
})

function createReadyWorker(label: string, maxConcurrent = 1): Worker {
  const w = workers.createWorker({ adapterId: 'claude-code', label, maxConcurrent, enabled: true })
  db.db()
    .prepare('update workers set identity_json = ? where id = ?')
    .run(JSON.stringify({ loggedIn: true, account: `${label}@example.com` }), w.id)
  writeFileSync(
    join(w.isolationRoot, '.claude.json'),
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [
            { kind: 'session', group: 'session', percent: 10, resets_at: null },
            { kind: 'weekly', group: 'weekly', percent: 10, resets_at: null }
          ]
        }
      }
    })
  )
  return workers.requireWorker(w.id)
}

describe('dispatching scenarios and capacity tracking', () => {
  it('t255: does not hold ClaudeFirst at capacity when an earlier task completed on ClaudeSecond with an unclosed run on ClaudeFirst', () => {
    const claudeFirst = createReadyWorker('ClaudeFirst', 1)
    const claudeSecond = createReadyWorker('ClaudeSecond', 1)

    // Task 1 (t249) was started on ClaudeFirst
    const task1 = tasks.createTask({ title: 'Task 1 (t249)' })
    const run1 = tasks.startRun({
      taskId: task1.id,
      workerId: claudeFirst.id,
      sessionId: 'session-cf-1',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })

    // Simulate the exact anomaly: run1 exited without closing (ended_at is null)
    // Task 1 was then assigned to ClaudeSecond, started a new run, and completed on ClaudeSecond
    tasks.setStatus(task1.id, 'running', { assignee: claudeSecond.id })
    const run2 = tasks.startRun({
      taskId: task1.id,
      workerId: claudeSecond.id,
      sessionId: 'session-cs-2',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run2.id, 'completed')
    tasks.setStatus(task1.id, 'completed')

    // Manually force run1.ended_at to null to test scheduler robustness against legacy/corrupted data
    db.db().prepare('update runs set ended_at = null, outcome = null where id = ?').run(run1.id)

    // Verify ClaudeFirst is not considered reserved or at capacity
    expect(residency.runningTaskReservations(claudeFirst.id, [])).toBe(0)
    expect(residency.atCapacity([], claudeFirst.maxConcurrent, null, 0)).toBe(false)

    // Task 2 (t255) is manually launched/pinned on ClaudeFirst
    const task2 = tasks.createTask({
      title: 'Task 2 (t255)',
      constraints: { workerId: claudeFirst.id }
    })

    // Dispatch target choice must pick ClaudeFirst, NOT defer with 'ClaudeFirst at capacity'
    const choice = scoring.chooseTarget(task2)
    expect(choice.worker).not.toBeNull()
    expect(choice.worker?.id).toBe(claudeFirst.id)
    expect(choice.reason).not.toMatch(/ClaudeFirst at capacity/)
  })

  it('pinned task dispatches to worker when capacity is available, and holds at capacity only while a task is actively running', () => {
    const workerA = createReadyWorker('WorkerA', 1)
    const taskRunning = tasks.createTask({ title: 'Active task' })
    const run = tasks.startRun({
      taskId: taskRunning.id,
      workerId: workerA.id,
      sessionId: 'session-active',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(taskRunning.id, 'running', { assignee: workerA.id })

    // Pinned task 2 on WorkerA
    const taskPinned = tasks.createTask({
      title: 'Pinned task',
      constraints: { workerId: workerA.id }
    })

    // WorkerA is genuinely running a task (with closed session or live session), so it is at capacity
    const choiceBusy = scoring.chooseTarget(taskPinned)
    expect(choiceBusy.worker).toBeNull()
    expect(choiceBusy.reason).toMatch(/WorkerA at capacity/)

    // Once the active task completes, WorkerA is immediately free
    tasks.setStatus(taskRunning.id, 'completed')
    tasks.finishRun(run.id, 'completed')

    const choiceFree = scoring.chooseTarget(taskPinned)
    expect(choiceFree.worker).not.toBeNull()
    expect(choiceFree.worker?.id).toBe(workerA.id)
  })

  it('immediately frees worker capacity when a task is reassigned mid-flight to another worker', () => {
    const workerA = createReadyWorker('WorkerA', 1)
    const workerB = createReadyWorker('WorkerB', 1)

    const task1 = tasks.createTask({ title: 'Task moving across workers' })
    tasks.startRun({
      taskId: task1.id,
      workerId: workerA.id,
      sessionId: 'sess-a',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(task1.id, 'running', { assignee: workerA.id })

    expect(residency.runningTaskReservations(workerA.id, [])).toBe(1)
    expect(residency.runningTaskReservations(workerB.id, [])).toBe(0)

    // Reassign task 1 to worker B
    tasks.setStatus(task1.id, 'running', { assignee: workerB.id })

    expect(residency.runningTaskReservations(workerA.id, [])).toBe(0)
    expect(residency.runningTaskReservations(workerB.id, [])).toBe(1)

    // A task pinned to worker A can now be targeted
    const task2 = tasks.createTask({
      title: 'Task 2 on WorkerA',
      constraints: { workerId: workerA.id }
    })
    const choice = scoring.chooseTarget(task2)
    expect(choice.worker).not.toBeNull()
    expect(choice.worker?.id).toBe(workerA.id)
  })

  it('setStatus automatically cleans up all open runs on completed, failed, and cancelled tasks', () => {
    const worker = createReadyWorker('Worker', 1)

    // 1. Completed
    const tCompleted = tasks.createTask({ title: 'Completing' })
    const runC = tasks.startRun({
      taskId: tCompleted.id,
      workerId: worker.id,
      sessionId: 'sess-c',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    expect(tasks.requireRun(runC.id).endedAt).toBeNull()
    tasks.setStatus(tCompleted.id, 'completed')
    expect(tasks.requireRun(runC.id).endedAt).not.toBeNull()
    expect(tasks.requireRun(runC.id).outcome).toBe('completed')

    // 2. Failed
    const tFailed = tasks.createTask({ title: 'Failing' })
    const runF = tasks.startRun({
      taskId: tFailed.id,
      workerId: worker.id,
      sessionId: 'sess-f',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(tFailed.id, 'failed')
    expect(tasks.requireRun(runF.id).endedAt).not.toBeNull()
    expect(tasks.requireRun(runF.id).outcome).toBe('failed')

    // 3. Cancelled
    const tCancelled = tasks.createTask({ title: 'Cancelling' })
    const runX = tasks.startRun({
      taskId: tCancelled.id,
      workerId: worker.id,
      sessionId: 'sess-x',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(tCancelled.id, 'cancelled')
    expect(tasks.requireRun(runX.id).endedAt).not.toBeNull()
    expect(tasks.requireRun(runX.id).outcome).toBe('cancelled')
  })

  it('continueTask terminates lingering open runs before requeueing', () => {
    const worker = createReadyWorker('Worker', 1)
    const task = tasks.createTask({ title: 'Task to continue' })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: 'interrupted-sess',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })

    expect(tasks.requireRun(run.id).endedAt).toBeNull()

    const result = scheduler.continueTask(task.id)
    expect(result).toBe('requeued')
    expect(tasks.requireTask(task.id).status).toBe('ready')
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.requireRun(run.id).outcome).toBe('terminated')
  })

  it('reconcileTasks sweeps all open runs on daemon startup across settled and resting tasks', () => {
    const worker = createReadyWorker('Worker', 1)

    const completed = tasks.createTask({ title: 'Completed before restart' })
    tasks.setStatus(completed.id, 'completed')
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, session_id, started_at, quota_unverified)
         values ('orphan-completed', ?, ?, 's-comp', 1000, 0)`
      )
      .run(completed.id, worker.id)

    const awaiting = tasks.createTask({ title: 'Awaiting human before restart' })
    tasks.setStatus(awaiting.id, 'awaiting_human', { assignee: 'human' })
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, session_id, started_at, quota_unverified)
         values ('orphan-awaiting', ?, ?, 's-await', 1000, 0)`
      )
      .run(awaiting.id, worker.id)

    const stuck = tasks.createTask({ title: 'Stuck running during restart' })
    tasks.setStatus(stuck.id, 'running', { assignee: worker.id })
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, session_id, started_at, quota_unverified)
         values ('orphan-stuck', ?, ?, 's-stuck', 1000, 0)`
      )
      .run(stuck.id, worker.id)

    // Reconcile startup
    scheduler.reconcileTasks()

    // All runs must be closed
    expect(tasks.requireRun('orphan-completed').endedAt).not.toBeNull()
    expect(tasks.requireRun('orphan-completed').outcome).toBe('completed')

    expect(tasks.requireRun('orphan-awaiting').endedAt).not.toBeNull()
    expect(tasks.requireRun('orphan-awaiting').outcome).toBe('terminated')

    expect(tasks.requireRun('orphan-stuck').endedAt).not.toBeNull()
    expect(tasks.requireRun('orphan-stuck').outcome).toBe('terminated')

    expect(residency.runningTaskReservations(worker.id, [])).toBe(0)
  })

  it('migration 52: closes orphaned runs on settled tasks with correct outcomes and notes', () => {
    const file = join(dir, 'replay_m52.db')
    db.openDb(file)

    const worker = createReadyWorker('M52Worker', 1)

    // Create 3 settled tasks
    const tComp = tasks.createTask({ title: 'Settled Completed' })
    tasks.setStatus(tComp.id, 'completed')

    const tFail = tasks.createTask({ title: 'Settled Failed' })
    tasks.setStatus(tFail.id, 'failed')

    const tCanc = tasks.createTask({ title: 'Settled Cancelled' })
    tasks.setStatus(tCanc.id, 'cancelled')

    // Create 1 running task
    const tRun = tasks.createTask({ title: 'Still Running' })
    tasks.setStatus(tRun.id, 'running', { assignee: worker.id })

    // Insert open runs on all of them
    const insertRun = db.db().prepare(`
      insert into runs (id, task_id, worker_id, session_id, started_at, quota_unverified)
      values (?, ?, ?, 'sess', 1000, 0)
    `)
    insertRun.run('r-comp', tComp.id, worker.id)
    insertRun.run('r-fail', tFail.id, worker.id)
    insertRun.run('r-canc', tCanc.id, worker.id)
    insertRun.run('r-run', tRun.id, worker.id)

    // Rewind user_version to right before migration 52
    const before = db.versionBefore('orphaned run closed by migration 52')
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()

    // Reopen db to trigger migration 52 replay
    db.openDb(file)

    const runComp = tasks.requireRun('r-comp')
    expect(runComp.endedAt).not.toBeNull()
    expect(runComp.outcome).toBe('completed')
    expect(runComp.note).toBe('orphaned run closed by migration 52')

    const runFail = tasks.requireRun('r-fail')
    expect(runFail.endedAt).not.toBeNull()
    expect(runFail.outcome).toBe('failed')
    expect(runFail.note).toBe('orphaned run closed by migration 52')

    const runCanc = tasks.requireRun('r-canc')
    expect(runCanc.endedAt).not.toBeNull()
    expect(runCanc.outcome).toBe('cancelled')
    expect(runCanc.note).toBe('orphaned run closed by migration 52')

    // The running task's open run must NOT be touched by migration 52
    const runStillRunning = tasks.requireRun('r-run')
    expect(runStillRunning.endedAt).toBeNull()
  })
})
