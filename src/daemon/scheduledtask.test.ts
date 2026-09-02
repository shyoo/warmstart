import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let api: typeof import('./api.js')
let handlers: ReturnType<(typeof import('./api.js'))['buildApi']>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-scheduledtask-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
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
