import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ROOT_MANDATE, type Task } from '@shared/tasks.js'

/**
 * Task scheduling order and queue dispatch.
 *
 * ⛔ Invariants:
 *  - Highest priority first (P0 > P1 > P2 > P3).
 *  - Nearest deadline first among tasks with the same priority.
 *  - Strict FIFO (oldest created_at first, then seq tie-break) among tasks with equal priority and deadline.
 *  - Deterministic and zero token cost.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let projects: typeof import('./projects.js')
let scheduler: typeof import('./scheduler.js')
let workers: typeof import('./workers.js')

let projectId: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-scheduling-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  projects = await import('./projects.js')
  scheduler = await import('./scheduler.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'scheduling.db'))

  const root = mkdtempSync(join(tmpdir(), 'agentyard-scheduling-proj-'))
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  projectId = projects.addProject({ root, name: 'sched-demo' }).id
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows file locks during cleanup
  }
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-test',
    seq: overrides.seq ?? 1,
    projectId: overrides.projectId ?? null,
    title: overrides.title ?? 'Test task',
    titleSummary: overrides.titleSummary ?? null,
    kind: overrides.kind ?? 'work',
    landedBaseSha: overrides.landedBaseSha ?? null,
    landedHeadSha: overrides.landedHeadSha ?? null,
    qualityReviewId: overrides.qualityReviewId ?? null,
    qualityScore: overrides.qualityScore ?? null,
    qualityReviewedAt: overrides.qualityReviewedAt ?? null,
    qualityReviewer: overrides.qualityReviewer ?? null,
    status: overrides.status ?? 'ready',
    priority: overrides.priority ?? 'P2',
    createdBy: overrides.createdBy ?? { kind: 'human' },
    parentTaskId: overrides.parentTaskId ?? null,
    lineageDepth: overrides.lineageDepth ?? 0,
    assignee: overrides.assignee ?? null,
    assigneeHint: overrides.assigneeHint ?? null,
    mandate: overrides.mandate ?? ROOT_MANDATE,
    budget: overrides.budget ?? { grantedTokens: 0, spentTokens: 0 },
    dependsOn: overrides.dependsOn ?? [],
    notBefore: overrides.notBefore ?? null,
    deadline: overrides.deadline ?? null,
    requires: overrides.requires ?? [],
    constraints: overrides.constraints ?? {},
    verification: overrides.verification ?? 'auto',
    finishPolicy: overrides.finishPolicy ?? 'inherit',
    sessionSharing: overrides.sessionSharing ?? 'inherit',
    completionMode: overrides.completionMode ?? 'inherit',
    objective: overrides.objective ?? 'inherit',
    autoCompact: overrides.autoCompact ?? 'inherit',
    finishAskedAt: overrides.finishAskedAt ?? null,
    conflictAskedAt: overrides.conflictAskedAt ?? null,
    resolveRetryAskedAt: overrides.resolveRetryAskedAt ?? null,
    preemptible: overrides.preemptible ?? true,
    estTokens: overrides.estTokens ?? null,
    cancel: overrides.cancel ?? null,
    handoffNote: overrides.handoffNote ?? null,
    holdReason: overrides.holdReason ?? null,
    holdUntil: overrides.holdUntil ?? null,
    quotaOverrideUntil: overrides.quotaOverrideUntil ?? null,
    branch: overrides.branch ?? null,
    firstRunAt: overrides.firstRunAt ?? null,
    lastRunEndedAt: overrides.lastRunEndedAt ?? null,
    activeMs: overrides.activeMs ?? 0,
    activeSince: overrides.activeSince ?? null,
    ranOn: overrides.ranOn ?? null,
    ranModel: overrides.ranModel ?? null,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now()
  }
}

describe('schedulingOrder: unit ordering logic', () => {
  it('sorts multiple tasks with the same priority in FIFO order by createdAt', () => {
    const t1 = makeTask({ id: 't1', seq: 1, priority: 'P2', createdAt: 1000 })
    const t2 = makeTask({ id: 't2', seq: 2, priority: 'P2', createdAt: 2000 })
    const t3 = makeTask({ id: 't3', seq: 3, priority: 'P2', createdAt: 3000 })

    const queue = [t3, t1, t2].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('breaks ties deterministically with seq when createdAt is identical', () => {
    const t1 = makeTask({ id: 't1', seq: 1, priority: 'P2', createdAt: 5000 })
    const t2 = makeTask({ id: 't2', seq: 2, priority: 'P2', createdAt: 5000 })
    const t3 = makeTask({ id: 't3', seq: 3, priority: 'P2', createdAt: 5000 })

    const queue = [t3, t2, t1].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('places higher priority tasks before older lower priority tasks', () => {
    const olderP2 = makeTask({ id: 'older-p2', seq: 1, priority: 'P2', createdAt: 1000 })
    const laterP0 = makeTask({ id: 'later-p0', seq: 2, priority: 'P0', createdAt: 9000 })

    expect(tasks.schedulingOrder(olderP2, laterP0)).toBeGreaterThan(0)
    expect(tasks.schedulingOrder(laterP0, olderP2)).toBeLessThan(0)

    const queue = [olderP2, laterP0].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['later-p0', 'older-p2'])
  })

  it('orders all priority tiers correctly: P0 > P1 > P2 > P3', () => {
    const p3 = makeTask({ id: 'p3', seq: 1, priority: 'P3', createdAt: 100 })
    const p2 = makeTask({ id: 'p2', seq: 2, priority: 'P2', createdAt: 200 })
    const p1 = makeTask({ id: 'p1', seq: 3, priority: 'P1', createdAt: 300 })
    const p0 = makeTask({ id: 'p0', seq: 4, priority: 'P0', createdAt: 400 })

    const queue = [p2, p3, p0, p1].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('preserves FIFO order within each priority bucket across a mixed priority queue', () => {
    const p2Old = makeTask({ id: 'p2-old', seq: 1, priority: 'P2', createdAt: 100 })
    const p1Old = makeTask({ id: 'p1-old', seq: 2, priority: 'P1', createdAt: 200 })
    const p0Old = makeTask({ id: 'p0-old', seq: 3, priority: 'P0', createdAt: 300 })
    const p2New = makeTask({ id: 'p2-new', seq: 4, priority: 'P2', createdAt: 400 })
    const p1New = makeTask({ id: 'p1-new', seq: 5, priority: 'P1', createdAt: 500 })
    const p0New = makeTask({ id: 'p0-new', seq: 6, priority: 'P0', createdAt: 600 })

    const queue = [p2New, p1New, p0New, p2Old, p1Old, p0Old].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['p0-old', 'p0-new', 'p1-old', 'p1-new', 'p2-old', 'p2-new'])
  })

  it('favors earlier deadlines over later deadlines and no deadlines within same priority', () => {
    const noDeadline = makeTask({ id: 'no-deadline', seq: 1, priority: 'P2', deadline: null, createdAt: 100 })
    const laterDeadline = makeTask({ id: 'late-deadline', seq: 2, priority: 'P2', deadline: 20000, createdAt: 200 })
    const urgentDeadline = makeTask({ id: 'urgent-deadline', seq: 3, priority: 'P2', deadline: 10000, createdAt: 300 })

    const queue = [noDeadline, laterDeadline, urgentDeadline].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['urgent-deadline', 'late-deadline', 'no-deadline'])
  })

  it('breaks ties using FIFO when deadlines are equal', () => {
    const d1 = makeTask({ id: 'd1', seq: 1, priority: 'P2', deadline: 10000, createdAt: 1000 })
    const d2 = makeTask({ id: 'd2', seq: 2, priority: 'P2', deadline: 10000, createdAt: 2000 })

    const queue = [d2, d1].sort(tasks.schedulingOrder)
    expect(queue.map((t) => t.id)).toEqual(['d1', 'd2'])
  })
})

describe('listTasks: FIFO ordering in database queries', () => {
  it('returns tasks in chronological creation order', () => {
    const first = tasks.createTask({ title: 'first task', projectId, priority: 'P2' })
    const second = tasks.createTask({ title: 'second task', projectId, priority: 'P2' })
    const third = tasks.createTask({ title: 'third task', projectId, priority: 'P2' })

    const list = tasks.listTasks({ projectId })
    expect(list.map((t) => t.id)).toEqual([first.id, second.id, third.id])
  })
})

describe('scheduler tick: end-to-end FIFO dispatch', () => {
  it('dispatches the oldest ready task first when multiple tasks are queued', async () => {
    workers.createWorker({ adapterId: 'claude-code', label: 'w1', maxConcurrent: 1 })
    const w = workers.listWorkers()[0]!
    workers.updateWorker(w.id, { enabled: false })

    const task1 = tasks.createTask({ title: 'Task 1 (Oldest)', projectId, priority: 'P2' })
    const task2 = tasks.createTask({ title: 'Task 2 (Middle)', projectId, priority: 'P2' })
    const task3 = tasks.createTask({ title: 'Task 3 (Newest)', projectId, priority: 'P2' })

    const res = await scheduler.tick()
    expect(res.dispatched).toBe(0)
    expect(tasks.requireTask(task1.id).status).toBe('ready')
    expect(tasks.requireTask(task2.id).status).toBe('ready')
    expect(tasks.requireTask(task3.id).status).toBe('ready')

    const ready = tasks.listTasks({ projectId }).filter((t) => t.status === 'ready').sort(tasks.schedulingOrder)
    expect(ready.map((t) => t.id)).toEqual([task1.id, task2.id, task3.id])
  })

  it('prioritizes newly filed P0 tasks over older queued P2 tasks on the next tick', async () => {
    workers.createWorker({ adapterId: 'claude-code', label: 'w1', maxConcurrent: 1 })
    const w = workers.listWorkers()[0]!
    workers.updateWorker(w.id, { enabled: false })

    const p2Old = tasks.createTask({ title: 'Old P2 task', projectId, priority: 'P2' })
    const p0New = tasks.createTask({ title: 'Urgent P0 task', projectId, priority: 'P0' })

    const ready = tasks.listTasks({ projectId }).filter((t) => t.status === 'ready').sort(tasks.schedulingOrder)
    expect(ready[0]?.id).toBe(p0New.id)
    expect(ready[1]?.id).toBe(p2Old.id)
  })
})

describe('automatic resolve and retry', () => {
  it('requeues one actionable landing failure, then leaves the repeat for human review', async () => {
    const task = tasks.createTask({ title: 'repair a red check', projectId })
    db.db()
      .prepare('update tasks set status = ?, assignee = ?, hold_reason = ?, branch = ? where id = ?')
      .run(
        'awaiting_human',
        'human',
        'landing failed: the project checks failed after rebase',
        'multi-agent-controller/t1-repair-a-red-check',
        task.id
      )

    expect(await scheduler.resolveRetryOnTask(task.id, true)).toEqual({ ok: true })
    const retried = tasks.requireTask(task.id)
    expect(retried.status).toBe('ready')
    expect(retried.resolveRetryAskedAt).not.toBeNull()
    expect(tasks.messagesFor(task.id).filter((m) => /Automatically retrying once/.test(m.text))).toHaveLength(1)

    // Recreate the same resting failure after that retry. The marker is durable, so a daemon tick
    // or restart cannot turn this into an unbounded sequence of billed recovery runs.
    tasks.setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: 'landing failed: the project checks failed after rebase'
    })
    expect(await scheduler.resolveRetryOnTask(task.id, true)).toMatchObject({ ok: false })
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.messagesFor(task.id).filter((m) => /Automatically retrying once/.test(m.text))).toHaveLength(1)
  })
})
