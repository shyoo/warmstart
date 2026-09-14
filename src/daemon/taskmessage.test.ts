import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'

/**
 * A note to a task has to reach every view of that task, not only the one that sent it.
 *
 * ⛔ `addMessage` emits nothing, and `continueTask` emits only when it moves the status. A task that
 * was `ready` therefore took the note into the store and told nobody: the UI suite's thread waited
 * 30s for it on the Windows CI runner (run 34872370257), while on a machine with a CLI the same task
 * was `running` and its run's own events refreshed the pane and hid the gap.
 */

let dir: string
let db: typeof import('./db.js')
let api: typeof import('./api.js')
let tasks: typeof import('./tasks.js')
let events: typeof import('./events.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskmessage-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  api = await import('./api.js')
  tasks = await import('./tasks.js')
  events = await import('./events.js')
  db.openDb(join(dir, 'taskmessage.db'))
})

afterAll(() => {
  events.setEventSink(() => {})
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('task.message', () => {
  it('announces the task when the note leaves its status where it was', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'a queued task someone writes to' })
    expect(task.status).toBe('ready')

    const heard: DaemonEvent[] = []
    events.setEventSink((e) => heard.push(e))
    const result = await handlers['task.message']({ id: task.id, text: 'Landed as `98f200ab`' })

    expect(result.outcome).toBe('queued')
    expect(heard.some((e) => e.type === 'task.changed' && e.task.id === task.id)).toBe(true)
  })

  it('and does not announce twice when the requeue already did', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'a stopped task someone writes to' })
    tasks.setStatus(task.id, 'completed')

    const heard: DaemonEvent[] = []
    events.setEventSink((e) => heard.push(e))
    const result = await handlers['task.message']({ id: task.id, text: 'one more thing' })

    expect(result.outcome).toBe('requeued')
    expect(heard.filter((e) => e.type === 'task.changed' && e.task.id === task.id)).toHaveLength(1)
  })
})
