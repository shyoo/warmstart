import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let api: typeof import('./api.js')

let claude: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-draft-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'draft.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'claude-1', enabled: false })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks
  }
})

describe('draft task lifecycle', () => {
  it('creates a task in draft status when requested', () => {
    const task = tasks.createTask({
      title: 'Initial draft title',
      prompt: 'Initial draft prompt',
      status: 'draft',
      priority: 'P2'
    })
    expect(task.status).toBe('draft')
    expect(task.title).toBe('Initial draft title')
    const msgs = tasks.messagesFor(task.id)
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.text).toBe('Initial draft prompt')
  })

  it('updates title and prompt of a draft task', () => {
    const task = tasks.createTask({
      title: 'Draft to edit',
      prompt: 'Original prompt text',
      status: 'draft'
    })
    const updated = tasks.updateTask(task.id, {
      title: 'Updated draft title',
      prompt: 'Updated prompt text'
    })
    expect(updated.title).toBe('Updated draft title')
    const msgs = tasks.messagesFor(task.id)
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.text).toBe('Updated prompt text')
  })

  it('pins worker and then reassigns to auto / scheduler choice', () => {
    const apiHandlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({
      title: 'Worker pin test',
      status: 'draft'
    })

    // Pin worker via task.setWorker
    const pinned = apiHandlers['task.setWorker']({ id: task.id, workerId: claude.id }) as typeof task
    expect(pinned.constraints.workerId).toBe(claude.id)
    expect(pinned.constraints.adapterId).toBe('claude-code')

    // Reassign worker to auto / scheduler choice
    const unpinned = apiHandlers['task.setWorker']({ id: task.id, workerId: null }) as typeof task
    expect(unpinned.constraints.workerId).toBeUndefined()
    expect(unpinned.constraints.adapterId).toBeUndefined()
  })

  it('updates priority via task.setPriority', () => {
    const apiHandlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({
      title: 'Priority test',
      status: 'draft',
      priority: 'P3'
    })
    expect(task.priority).toBe('P3')

    const updated = apiHandlers['task.setPriority']({ id: task.id, priority: 'P0' }) as typeof task
    expect(updated.priority).toBe('P0')
  })

  it('promotes draft to ready', () => {
    const task = tasks.createTask({
      title: 'Promote test',
      status: 'draft'
    })
    expect(task.status).toBe('draft')

    const promoted = tasks.promoteDraft(task.id)
    expect(promoted.status).toBe('ready')
  })
})
