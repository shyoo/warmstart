import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * One account, more than one task at a time.
 *
 * ⭐ `maxConcurrent` has gated this since M1 — `atCapacity` reads it before dispatch and
 * `spawnSession` refuses past it — and until 2026-08-29 nothing in the app could change it. It was
 * rendered in the Workers table as text, commissioned at 1, and every suite in the repo exercised it
 * at exactly that value. So a fleet of one account ran one task at a time, and the hold that said so
 * read as a fact about the provider rather than as a setting nobody had been given a control for.
 *
 * ⚠️ These tests drive the two gates directly rather than a live dispatch. What was untested is the
 * arithmetic at values above one, and a real dispatch would need an agent CLI to prove it.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let residency: typeof import('./residency.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-concurrency-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  residency = await import('./residency.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  db.openDb(join(dir, 'concurrency.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

let seq = 0
const add = (maxConcurrent?: number) => {
  seq += 1
  return workers.createWorker({ adapterId: 'claude-code', label: `w${seq}`, maxConcurrent })
}

/** Only the two fields `atCapacity` reads. A real session carries thirty more and none of them count. */
const session = (id: string, purpose: 'work' | 'consult' = 'work'): Session =>
  ({ id, purpose }) as Session

describe('how many tasks one account may run at once', () => {
  it('commissions at one, which is a cost decision rather than a provider limit', () => {
    // ⚠️ Parallel requests against one cached prefix each pay a cache write (cost-model.md §1), so a
    // second session on an account is worth money. The default says so; it does not say "impossible".
    expect(add().maxConcurrent).toBe(1)
  })

  it('takes the number it is given, at commissioning and afterwards', () => {
    const worker = add(4)
    expect(worker.maxConcurrent).toBe(4)
    expect(workers.updateWorker(worker.id, { maxConcurrent: 2 }).maxConcurrent).toBe(2)
  })

  it('refuses to go below one, because a max of zero is a worker that never says why', () => {
    // ⛔ Zero would leave the worker enabled, its quota counted and its role honoured, and silently
    //    never take a task — `atCapacity` true on an empty account. The switch for "do not use this
    //    one" is `enabled`, which says so on the row.
    const worker = add()
    expect(workers.updateWorker(worker.id, { maxConcurrent: 0 }).maxConcurrent).toBe(1)
    expect(workers.updateWorker(worker.id, { maxConcurrent: -3 }).maxConcurrent).toBe(1)
    expect(add(0).maxConcurrent).toBe(1)
  })

  it('keeps the current value when a patch does not mention it', () => {
    // ⛔ The guard that stops the clamp becoming a reset. Every worker mutation goes through one
    //    statement that writes all five columns, so a rename must not quietly re-floor this one.
    const worker = add(3)
    expect(workers.updateWorker(worker.id, { label: 'renamed' }).maxConcurrent).toBe(3)
  })

  it('floors a fractional value rather than storing it', () => {
    // A number input hands back whatever was typed; half a session is not a thing.
    expect(add(2.7).maxConcurrent).toBe(2)
  })
})

describe('the capacity gate above one slot', () => {
  it('lets a second task onto an account already running one', () => {
    // ⭐ The whole point. At `maxConcurrent: 1` this is the hold the operator saw as `queued`.
    expect(residency.atCapacity([session('a')], 2, null)).toBe(false)
  })

  it('stops the third, so the number is a bound and not a suggestion', () => {
    expect(residency.atCapacity([session('a'), session('b')], 2, null)).toBe(true)
  })

  it('still exempts the session a task would reuse, at every width', () => {
    // ⛔ Reusing an open session starts no process, so it cannot fill a slot. This was the bug that
    //    made a one-slot worker refuse every warm continuation; widening the account must not
    //    quietly reintroduce it at the new ceiling.
    const open = session('warm')
    expect(residency.atCapacity([open, session('b')], 2, open)).toBe(false)
    expect(residency.atCapacity([open], 1, open)).toBe(false)
  })

  it('counts work only, so consults do not consume the widened slots either', () => {
    // ⚠️ A consult is one short tool-less turn holding no workspace, bounded separately in
    //    controller.ts. Counting it here would mean a busy fleet cannot ask for judgment exactly
    //    when judgment is worth the most.
    const busy = [session('a'), session('c1', 'consult'), session('c2', 'consult')]
    expect(residency.atCapacity(busy, 2, null)).toBe(false)
  })

  it('keeps a slot for a task whose question closed its session', () => {
    // t117's session had ended, so it was absent from `sessionsForWorker`; without this separate
    // reservation t118 immediately started on the same one-slot worker while t117 still owned its
    // workspace and awaited a person.
    const worker = add(1)
    const parked = tasks.createTask({ title: 'needs a decision' })
    const run = tasks.startRun({
      taskId: parked.id,
      workerId: worker.id,
      sessionId: 'closed-after-question',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(parked.id, 'awaiting_human', { assignee: 'human' })

    const retained = residency.awaitingHumanReservations(worker.id, [])
    expect(retained).toBe(1)
    expect(residency.atCapacity([], worker.maxConcurrent, null, retained)).toBe(true)
    expect(residency.awaitingHumanReservations('another-worker', [])).toBe(0)
  })

  it('does not double-count a parked task whose session is still warm', () => {
    const worker = add(1)
    const parked = tasks.createTask({ title: 'waiting with a warm conversation' })
    const run = tasks.startRun({
      taskId: parked.id,
      workerId: worker.id,
      sessionId: 'still-warm',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(parked.id, 'awaiting_human', { assignee: 'human' })

    const warm = session('still-warm')
    expect(residency.awaitingHumanReservations(worker.id, [warm])).toBe(0)
    expect(residency.atCapacity([warm], worker.maxConcurrent, warm, 0)).toBe(false)
  })

  it('keeps a slot for a task that is still running or landing after its session closed', () => {
    // ⛔ When a one-shot adapter like Codex calls task_complete, its CLI process exits immediately
    // and the session becomes 'closed' while landTask is still checking and merging work.
    // Without retained reservations for running tasks, the scheduler and spawnSession would treat
    // the worker as idle and dispatch another task, violating maxConcurrent (measured on t164/t165, t179/t180).
    const worker = add(1)
    const runningTask = tasks.createTask({ title: 'landing in progress' })
    const run = tasks.startRun({
      taskId: runningTask.id,
      workerId: worker.id,
      sessionId: 'closed-while-landing',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(runningTask.id, 'running', { assignee: worker.id })

    // Session is closed, so absent from sessionsForWorker ([]).
    const runningRetained = residency.runningTaskReservations(worker.id, [])
    expect(runningRetained).toBe(1)
    const totalRetained = residency.retainedReservations(worker.id, [])
    expect(totalRetained).toBe(1)
    expect(residency.atCapacity([], worker.maxConcurrent, null, totalRetained)).toBe(true)
    expect(residency.runningTaskReservations('another-worker', [])).toBe(0)

    // Does not double-count if the session is still live:
    const liveSession = session('closed-while-landing')
    expect(residency.runningTaskReservations(worker.id, [liveSession])).toBe(0)

    // Once landing finishes and the run is closed, the slot is freed:
    tasks.setStatus(runningTask.id, 'completed')
    tasks.finishRun(run.id, 'completed')
    expect(residency.runningTaskReservations(worker.id, [])).toBe(0)
    expect(residency.retainedReservations(worker.id, [])).toBe(0)
    expect(residency.atCapacity([], worker.maxConcurrent, null, 0)).toBe(false)
  })

  it('spawnSession refuses when an uncounted open run exists on a 1-slot worker', () => {
    const worker = add(1)
    const runningTask = tasks.createTask({ title: 'task with open run' })
    const run = tasks.startRun({
      taskId: runningTask.id,
      workerId: worker.id,
      sessionId: 'session-closed-early',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(runningTask.id, 'running', { assignee: worker.id })

    // spawnSession checks live sessions + open runs on this worker.
    // Even if sessionsForWorker is empty, the open run must block spawning a second work session.
    expect(() =>
      sessions.spawnSession({
        workerId: worker.id,
        purpose: 'work'
      })
    ).toThrow(/is at its concurrency limit \(1\/1\)/)

    // Once the run finishes, spawnSession no longer throws concurrency limit
    tasks.finishRun(run.id, 'completed')
    // (It might throw due to cwd/isolation or lack of CLI, but not concurrency limit)
    try {
      sessions.spawnSession({ workerId: worker.id, purpose: 'work' })
    } catch (err: unknown) {
      expect((err as Error).message).not.toMatch(/is at its concurrency limit/)
    }
  })

  it('spawnSession does not throw concurrency limit when open run belongs to a settled task', () => {
    // ⛔ Measured on t255: an orphaned open run on a completed task must never block
    // spawnSession from spawning a new session on an idle worker.
    const worker = add(1)
    const settledTask = tasks.createTask({ title: 'task already settled' })
    tasks.startRun({
      taskId: settledTask.id,
      workerId: worker.id,
      sessionId: 'orphaned-session',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    // Leave ended_at as null directly in db to simulate orphaned run
    tasks.setStatus(settledTask.id, 'completed')

    try {
      sessions.spawnSession({ workerId: worker.id, purpose: 'work' })
    } catch (err: unknown) {
      expect((err as Error).message).not.toMatch(/is at its concurrency limit/)
    }
  })

  it('runningTaskReservations ignores unclosed runs on non-running tasks', () => {
    const worker = add(1)
    const task = tasks.createTask({ title: 'resting task' })
    // Directly insert an unclosed run for this task on worker
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, session_id, started_at, quota_unverified)
         values (?, ?, ?, 'lingering-session', 1000, 0)`
      )
      .run('lingering-run-1', task.id, worker.id)

    // For any non-running/assigned status, runningTaskReservations must return 0
    const nonRunningStatuses: Array<import('@shared/tasks.js').TaskStatus> = [
      'completed',
      'failed',
      'cancelled',
      'awaiting_human',
      'ready',
      'draft',
      'blocked',
      'paused_user',
      'paused_quota'
    ]

    for (const st of nonRunningStatuses) {
      db.db().prepare('update tasks set status = ?, assignee = null where id = ?').run(st, task.id)
      expect(residency.runningTaskReservations(worker.id, [])).toBe(0)
    }

    // If task is in 'running' status assigned to this worker, it reports 1
    db.db().prepare('update tasks set status = ?, assignee = ? where id = ?').run('running', worker.id, task.id)
    expect(residency.runningTaskReservations(worker.id, [])).toBe(1)

    // If task is in 'running' status assigned to ANOTHER worker, it reports 0
    db.db().prepare('update tasks set status = ?, assignee = ? where id = ?').run('running', 'other-worker', task.id)
    expect(residency.runningTaskReservations(worker.id, [])).toBe(0)
  })

  it('setStatus automatically closes open runs when task settles', () => {
    const worker = add(1)
    const task = tasks.createTask({ title: 'task settling' })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: 'open-sess',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    expect(tasks.requireRun(run.id).endedAt).toBeNull()

    // Completing the task must close the open run
    tasks.setStatus(task.id, 'completed')
    const finishedRun = tasks.requireRun(run.id)
    expect(finishedRun.endedAt).not.toBeNull()
    expect(finishedRun.outcome).toBe('completed')
  })

  it('startRun automatically finishes prior open runs on the same task', () => {
    const worker1 = add(1)
    const worker2 = add(1)
    const task = tasks.createTask({ title: 'task run sequence' })
    const run1 = tasks.startRun({
      taskId: task.id,
      workerId: worker1.id,
      sessionId: 'sess-1',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    expect(tasks.requireRun(run1.id).endedAt).toBeNull()

    // Starting a new run on worker 2 terminates run 1
    const run2 = tasks.startRun({
      taskId: task.id,
      workerId: worker2.id,
      sessionId: 'sess-2',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    expect(tasks.requireRun(run1.id).endedAt).not.toBeNull()
    expect(tasks.requireRun(run1.id).outcome).toBe('terminated')
    expect(tasks.requireRun(run2.id).endedAt).toBeNull()
  })
})

/**
 * A planner waiting for its own pieces, and the question of whether one workspace can deadlock.
 *
 * ⛔ **t197 asked it directly: file a Plan & Split when only one workspace is left — can it wedge?**
 * The answer has to be *no by construction*, and the construction is this: a planner that has filed
 * its split is `blocked`, and `blocked` reserves nothing. Its run ended, its session closed, its
 * workspace went back to the pool. If a blocked planner held a slot, a one-account fleet would have
 * nothing left to run the very pieces it is waiting for, and neither the planner nor its children
 * could ever move again — the planner waiting on children that cannot be dispatched, holding the
 * only thing that could dispatch them.
 *
 * ⚠️ The other half of the answer lives in `mergebranch.test.ts`: a plan branch left checked out in a
 * pooled slot used to refuse every child's landing for ever, which is the same wedge by another road.
 */
describe('a planner blocked on its own pieces', () => {
  it('stops the planner run when its split is filed, even before the CLI exits', async () => {
    const worker = add(1)
    const plan = tasks.createTask({ title: 'plan and delegate', kind: 'plan' })
    const run = tasks.startRun({
      taskId: plan.id,
      workerId: worker.id,
      sessionId: 'planner-still-live',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(plan.id, 'running', { assignee: worker.id })

    // This is the durable half of `task_split`: its children now own the work, while the planner
    // waits for them. The CLI has not exited yet, which is the regression that used to leave the
    // active-time clock open for the whole split.
    tasks.setStatus(plan.id, 'blocked', { holdReason: 'waiting on its own pieces' })
    await scheduler.endPlannerForSplit('planner-still-live')

    const ended = tasks.requireRun(run.id)
    expect(ended.endedAt).not.toBeNull()
    expect(ended.outcome).toBe('blocked')
    expect(ended.note).toMatch(/filed its plan as subtasks/)
    expect(residency.retainedReservations(worker.id, [])).toBe(0)
  })

  it('⛔ holds no slot, so the pieces it waits for can be dispatched', () => {
    const worker = add(1)
    const plan = tasks.createTask({ title: 'plan the work', kind: 'plan' })
    const run = tasks.startRun({
      taskId: plan.id,
      workerId: worker.id,
      sessionId: 'planner-session',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(plan.id, 'running', { assignee: worker.id })
    expect(residency.retainedReservations(worker.id, [])).toBe(1)

    // The split is filed: `applySplit` parks the parent, then the run ends as `blocked`.
    tasks.setStatus(plan.id, 'blocked', { holdReason: 'waiting on 2 pieces of its own plan' })
    tasks.finishRun(run.id, 'blocked')

    expect(residency.retainedReservations(worker.id, [])).toBe(0)
    expect(residency.atCapacity([], worker.maxConcurrent, null, 0)).toBe(false)
  })

  it('⚠️ still holds one while the split approval is open, because a person is being waited on', () => {
    // ⛔ Not a bug, and not the same state. `task_split` blocks on an approval, and the session is
    // kept warm so the answer resumes into it rather than paying for a cold rebuild. That costs a
    // slot for as long as the card is unanswered — which is the price of the approval being
    // structural, and is stated here so it is a decision rather than a surprise.
    const worker = add(1)
    const plan = tasks.createTask({ title: 'plan awaiting approval', kind: 'plan' })
    tasks.startRun({
      taskId: plan.id,
      workerId: worker.id,
      sessionId: 'approval-session',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(plan.id, 'awaiting_human', { assignee: worker.id })
    expect(residency.awaitingHumanReservations(worker.id, [])).toBe(1)
  })

  it('does not count a task as retained when it has moved to another worker with a live session', () => {
    // ⭐ Measured on t251: a task reassigned from one worker to another should not be counted
    // as retained on the original worker if it now has an active run on the new worker.
    const workerA = add(1)
    const workerB = add(1)
    const task = tasks.createTask({ title: 'task reassigned' })

    // Task was running on Worker A with a closed session
    const runA = tasks.startRun({
      taskId: task.id,
      workerId: workerA.id,
      sessionId: 'closed-session-a',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: workerA.id })
    tasks.finishRun(runA.id, 'completed')

    // Task is now running on Worker B with a live session
    const runB = tasks.startRun({
      taskId: task.id,
      workerId: workerB.id,
      sessionId: 'live-session-b',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: workerB.id })
    const liveSessionB = session('live-session-b')

    // Worker A should not count the task as retained, since it's now on Worker B with a live session
    expect(residency.runningTaskReservations(workerA.id, [])).toBe(0)
    expect(residency.runningTaskReservations(workerB.id, [liveSessionB])).toBe(0)

    // Verify the task is correctly counted as retained on Worker B if its session closes
    tasks.finishRun(runB.id, 'completed')
    tasks.setStatus(task.id, 'running', { assignee: workerB.id })
    expect(residency.runningTaskReservations(workerB.id, [])).toBe(1)
  })
})
