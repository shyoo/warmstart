import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let api: typeof import('./api.js')

let claude: Worker
let agy: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-prompt-test-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'prompt.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'claude-1', enabled: true })
  agy = workers.createWorker({ adapterId: 'antigravity-cli', label: 'agy-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks
  }
})

describe('promptFor prompt construction', () => {
  it('builds prompt for an MCP adapter with task_complete instruction', () => {
    const task = tasks.createTask({
      title: 'Fix issue with login',
      prompt: 'Please inspect auth.ts and fix the login redirect.',
      status: 'ready'
    })

    const prompt = scheduler.promptFor(task, 'claude-code', false, { markDelivered: false })
    expect(prompt).toContain('Fix issue with login')
    expect(prompt).toContain('Please inspect auth.ts and fix the login redirect.')
    expect(prompt).toContain('call the MCP tool `task_complete` with a one-line summary')
    expect(prompt).toContain('call `request_human` rather than guessing')
  })

  it('builds prompt for a non-MCP adapter with commit instruction', () => {
    const task = tasks.createTask({
      title: 'Update readme',
      prompt: 'Add install instructions to README.md',
      status: 'ready'
    })

    const prompt = scheduler.promptFor(task, 'antigravity-cli', false, { markDelivered: false })
    expect(prompt).toContain('Update readme')
    expect(prompt).toContain('Add install instructions to README.md')
    expect(prompt).toContain('commit what you have and end with a one-line summary of what changed')
    expect(prompt).toContain('say so plainly and stop rather than guessing')
    expect(prompt).not.toContain('task_complete')
  })

  it('prepends handoff notes from previous sessions', () => {
    const task = tasks.createTask({
      title: 'Refactor database',
      prompt: 'Migrate to v18',
      status: 'ready'
    })
    tasks.setTaskHandoff(task.id, 'Stashed partial work in stash@{0}. Completed table schema.')

    const refreshed = tasks.requireTask(task.id)
    const prompt = scheduler.promptFor(refreshed, 'claude-code', false, { markDelivered: false })
    expect(prompt).toContain('Continuing earlier work. Handoff from the previous session:')
    expect(prompt).toContain('Stashed partial work in stash@{0}. Completed table schema.')
    expect(prompt).toContain('Migrate to v18')
    expect(prompt.indexOf('Continuing earlier work')).toBeLessThan(prompt.indexOf('Migrate to v18'))
  })

  it('prepends branchNotice when workspace moved across branches', () => {
    const task = tasks.createTask({
      title: 'Inspect styles',
      prompt: 'Check app.css for missing colors',
      status: 'ready'
    })

    const notice = '⚠️ This workspace has moved since your last turn: it was on `feat-old` and is now on `feat-new`.'
    const prompt = scheduler.promptFor(task, 'claude-code', false, {
      branchNotice: notice,
      markDelivered: false
    })
    expect(prompt).toContain(notice)
    expect(prompt.indexOf('⚠️ This workspace has moved')).toBeLessThan(prompt.indexOf('Inspect styles'))
  })

  it('does not re-include original brief on resumed conversations', () => {
    const task = tasks.createTask({
      title: 'Original brief',
      prompt: 'Do something long and involved',
      status: 'ready'
    })

    // First dispatch marks initial message delivered
    const msgs = tasks.messagesFor(task.id)
    tasks.markDelivered(msgs.map((m) => m.id))

    // Resumed conversation with no new undelivered notes
    const resumedPrompt = scheduler.promptFor(task, 'claude-code', true, { markDelivered: false })
    expect(resumedPrompt).not.toContain('Do something long and involved')
    expect(resumedPrompt).toContain('call the MCP tool `task_complete`')
  })
})

describe('run prompt persistence and task.get preview', () => {
  it('records prompt on startRun and returns it on runsFor', () => {
    const task = tasks.createTask({
      title: 'Run with recorded prompt',
      prompt: 'Ensure tests pass',
      status: 'ready'
    })

    const expectedPrompt = scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: claude.id,
      sessionId: 'session-123',
      projectId: null,
      quotaUnverified: false,
      costModelId: 'anthropic.claude-3-7-sonnet',
      prompt: expectedPrompt
    })

    expect(run.prompt).toBe(expectedPrompt)

    const storedRuns = tasks.runsFor(task.id)
    expect(storedRuns.length).toBe(1)
    expect(storedRuns[0]?.prompt).toBe(expectedPrompt)

    const required = tasks.requireRun(run.id)
    expect(required.prompt).toBe(expectedPrompt)
  })

  it('task.get returns previewPrompt matching target worker adapter', async () => {
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })
    const task = tasks.createTask({
      title: 'Preview test',
      prompt: 'Check task.get preview field',
      status: 'draft',
      constraints: { workerId: agy.id }
    })

    const detail = (await handlers['task.get']({ id: task.id })) as NonNullable<
      Awaited<ReturnType<(typeof handlers)['task.get']>>
    >
    expect(detail).not.toBeNull()
    expect(detail.previewPrompt).toBeDefined()
    expect(detail.previewPrompt).toContain('Check task.get preview field')
    // Because worker is agy (antigravity-cli with mcp: false), it has commit instruction
    expect(detail.previewPrompt).toContain('commit what you have and end with a one-line summary')
  })
})
