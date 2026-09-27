import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasPendingSchedule, type Task } from '@shared/tasks.js'

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let api: typeof import('./api.js')
let handlers: ReturnType<(typeof import('./api.js'))['buildApi']>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-scheduledtask-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'scheduledtask.db'))
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
    // Windows file handle release
  }
})

describe('scheduled task admission and lifecycle', () => {
  it('creates task in scheduled status when notBefore is in the future', () => {
    const future = Date.now() + 30 * 60 * 1000
    const task = tasks.createTask({
      title: 'run in 30 minutes',
      notBefore: future
    })

    expect(task.status).toBe('scheduled')
    expect(task.notBefore).toBe(future)
    expect(task.assignee).toBeNull()
  })

  it('creates task in ready status when notBefore is not provided or in the past', () => {
    const taskImmediate = tasks.createTask({
      title: 'run now'
    })
    expect(taskImmediate.status).toBe('ready')
    expect(taskImmediate.notBefore).toBeNull()

    const taskPast = tasks.createTask({
      title: 'run past',
      notBefore: Date.now() - 5000
    })
    expect(taskPast.status).toBe('ready')
  })

  it('admitScheduled leaves future tasks alone and admits due ones to ready', () => {
    const now = Date.now()
    const taskFuture = tasks.createTask({
      title: 'future task',
      notBefore: now + 3600 * 1000
    })
    const taskDue = tasks.createTask({
      title: 'due task',
      notBefore: now + 1000
    })

    // Before due time
    expect(tasks.admitScheduled()).toBe(0)
    expect(tasks.getTask(taskFuture.id)?.status).toBe('scheduled')
    expect(tasks.getTask(taskDue.id)?.status).toBe('scheduled')

    // Fast-forward not_before in DB for the due task to simulate time passing
    db.db().prepare('update tasks set not_before = ? where id = ?').run(now - 1000, taskDue.id)

    const admitted = tasks.admitScheduled()
    expect(admitted).toBe(1)
    expect(tasks.getTask(taskDue.id)?.status).toBe('ready')
    expect(tasks.getTask(taskFuture.id)?.status).toBe('scheduled')
  })

  it('holds task at blocked when dependencies are unmet, moving to scheduled when unblocked', () => {
    const now = Date.now()
    const prereq = tasks.createTask({ title: 'prerequisite task' })
    const dependent = tasks.createTask({
      title: 'scheduled dependent',
      dependsOn: [prereq.id],
      notBefore: now + 7200 * 1000
    })

    // Has unmet dependency, so status is blocked even though notBefore is set
    expect(dependent.status).toBe('blocked')
    expect(dependent.notBefore).toBe(now + 7200 * 1000)

    // Complete the prerequisite
    tasks.setStatus(prereq.id, 'completed')
    tasks.admitDependents(prereq.id)

    // Now unblocked, but notBefore is in the future, so it transitions to scheduled (not ready)
    const refreshed = tasks.getTask(dependent.id)
    expect(refreshed?.status).toBe('scheduled')
  })

  it('updating notBefore changes status between ready and scheduled', () => {
    const task = tasks.createTask({ title: 'switchable task' })
    expect(task.status).toBe('ready')

    // Update with future notBefore -> becomes scheduled
    const future = Date.now() + 1800 * 1000
    const scheduled = tasks.updateTask(task.id, { notBefore: future })
    expect(scheduled.status).toBe('scheduled')
    expect(scheduled.notBefore).toBe(future)

    // Clear notBefore -> becomes ready
    const ready = tasks.updateTask(task.id, { notBefore: null })
    expect(ready.status).toBe('ready')
    expect(ready.notBefore).toBeNull()
  })

  it('RPC task.create supports notBefore presets and custom timestamps', () => {
    const now = Date.now()
    const t30m = handlers['task.create']({
      title: '30m task',
      notBefore: now + 30 * 60 * 1000
    }) as Task
    expect(t30m.status).toBe('scheduled')
    expect(t30m.notBefore).toBe(now + 30 * 60 * 1000)

    const t1h = handlers['task.create']({
      title: '1h task',
      notBefore: now + 60 * 60 * 1000
    }) as Task
    expect(t1h.status).toBe('scheduled')

    const tCustom = handlers['task.create']({
      title: 'custom time task',
      notBefore: now + 86400 * 1000
    }) as Task
    expect(tCustom.status).toBe('scheduled')
    expect(tCustom.notBefore).toBe(now + 86400 * 1000)
  })
})

describe('task.startNow (t759)', () => {
  it('cancels the schedule, queues the task and says so on its thread', () => {
    const scheduled = tasks.createTask({ title: 'later', notBefore: Date.now() + 3600 * 1000 })
    const started = handlers['task.startNow']({ id: scheduled.id }) as Task
    expect(started.status).toBe('ready')
    expect(started.notBefore).toBeNull()
    expect(tasks.messagesFor(scheduled.id).some((m) => m.text === 'Schedule cancelled: started now')).toBe(true)
    // The cleared start time is what keeps a later admission from parking it again.
    expect(tasks.admit(scheduled.id).status).toBe('ready')
  })

  it('still honours prerequisites: a task waiting on another lands at blocked', () => {
    const prereq = tasks.createTask({ title: 'first' })
    const scheduled = tasks.createTask({
      title: 'later, after first',
      dependsOn: [prereq.id],
      notBefore: Date.now() + 3600 * 1000
    })
    const started = handlers['task.startNow']({ id: scheduled.id }) as Task
    expect(started.status).toBe('blocked')
    expect(started.notBefore).toBeNull()
  })

  it('leaves a task that is not scheduled unchanged', () => {
    const ready = tasks.createTask({ title: 'now' })
    const before = tasks.messagesFor(ready.id).length
    expect((handlers['task.startNow']({ id: ready.id }) as Task).status).toBe('ready')
    expect(tasks.messagesFor(ready.id)).toHaveLength(before)
  })
})

describe('hasPendingSchedule (t759)', () => {
  it('is a start time a person set that has not arrived, and never a quota reset', () => {
    const now = 1_000_000
    expect(hasPendingSchedule({ status: 'scheduled', notBefore: now + 1 }, now)).toBe(true)
    expect(hasPendingSchedule({ status: 'blocked', notBefore: now + 1 }, now)).toBe(true)
    expect(hasPendingSchedule({ status: 'blocked', notBefore: now - 1 }, now)).toBe(false)
    expect(hasPendingSchedule({ status: 'blocked', notBefore: null }, now)).toBe(false)
    expect(hasPendingSchedule({ status: 'paused_quota', notBefore: now + 1 }, now)).toBe(false)
    expect(hasPendingSchedule({ status: 'ready', notBefore: null }, now)).toBe(false)
  })
})
