import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DaemonEvent, Session } from '@shared/protocol.js'

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
let workers: typeof import('./workers.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')
let turnend: typeof import('./turnend.js')
let attachments: typeof import('./attachments.js')
let questions: typeof import('./questions.js')
let promptMod: typeof import('./prompt.js')
let seq = 0

function seedSession(workerId: string, adapterId: string): Session {
  seq += 1
  const id = `7a541000-0000-4000-8000-${String(seq).padStart(12, '0')}`
  const startedAt = Date.now()
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             last_request_started_at, tokens_since_compact)
       values (?,?,?,?,?,?,?,?,?,0)`
    )
    .run(id, workerId, adapterId, 'stream', dir, 'live', 'work', startedAt, startedAt)
  return sessions.getSession(id)!
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskmessage-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  api = await import('./api.js')
  tasks = await import('./tasks.js')
  events = await import('./events.js')
  workers = await import('./workers.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  turnend = await import('./turnend.js')
  attachments = await import('./attachments.js')
  questions = await import('./questions.js')
  promptMod = await import('./prompt.js')
  db.openDb(join(dir, 'taskmessage.db'))
})

afterEach(() => {
  vi.restoreAllMocks()
  events.setEventSink(() => {})
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

  it('requeues a failed task back to ready with assignee null', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'a failed task someone writes to' })
    tasks.setStatus(task.id, 'failed', { assignee: 'w-failed' })

    const result = await handlers['task.message']({ id: task.id, text: 'retry this please' })

    expect(result.outcome).toBe('requeued')
    const updated = tasks.requireTask(task.id)
    expect(updated.status).toBe('ready')
    expect(updated.assignee).toBeNull()
  })

  it('queues messages without interrupting an active turn when delivery is queue', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const worker = workers.createWorker({ adapterId: 'antigravity-cli', label: `w-agy-${++seq}`, enabled: false })
    const task = tasks.createTask({ title: 'Initial work' })
    const session = seedSession(worker.id, 'antigravity-cli')
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    tasks.markDelivered([tasks.messagesFor(task.id)[0]!.id])

    const sendSpy = vi.spyOn(sessions, 'sendPrompt').mockImplementation(() => {})
    const closeSpy = vi.spyOn(sessions, 'closeAndWait').mockResolvedValue(true)
    const heard: DaemonEvent[] = []
    events.setEventSink((e) => heard.push(e))

    const res = await handlers['task.message']({
      id: task.id,
      text: 'Do this next',
      delivery: 'queue'
    })

    expect(res.outcome).toBe('queued')
    expect(sendSpy).not.toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(tasks.requireTask(task.id).status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.queuedHumanFollowups(task.id).map((m) => m.text)).toEqual(['Do this next'])
    expect(heard.some((e) => e.type === 'task.changed' && e.task.id === task.id)).toBe(true)

    db.db().prepare('delete from sessions where id = ?').run(session.id)
    db.db().prepare('delete from workers where id = ?').run(worker.id)
  })

  it('requeues a resting task when delivery is queue', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const task = tasks.createTask({ title: 'Resting task' })
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'your turn' })

    const res = await handlers['task.message']({
      id: task.id,
      text: 'Follow up',
      delivery: 'queue'
    })

    expect(res.outcome).toBe('requeued')
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('holds task completion and requeues cleanly when follow-up messages are queued', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const worker = workers.createWorker({ adapterId: 'claude-code', label: `w-cc-${++seq}`, enabled: false })
    const task = tasks.createTask({ title: 'Step 1' })
    const session = seedSession(worker.id, 'claude-code')
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    tasks.markDelivered([tasks.messagesFor(task.id)[0]!.id])

    await handlers['task.message']({ id: task.id, text: 'Step 2', delivery: 'queue' })
    await handlers['task.message']({ id: task.id, text: 'Step 3', delivery: 'queue' })

    const closeSpy = vi.spyOn(sessions, 'closeAndWait').mockResolvedValue(true)
    await scheduler.completeTask(session.id, 'Finished step 1')

    expect(closeSpy).not.toHaveBeenCalled()
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('ready')
    const msgs = tasks.messagesFor(task.id)
    expect(msgs.some((m) => m.role === 'agent' && m.text.includes('Finished step 1'))).toBe(true)
    expect(tasks.queuedHumanFollowups(task.id).map((m) => m.text)).toEqual(['Step 2', 'Step 3'])

    const nextPrompt = promptMod.promptFor(tasks.requireTask(task.id), 'claude-code', true, { markDelivered: true })
    expect(nextPrompt.text).toContain('Step 2')
    expect(nextPrompt.text).toContain('Step 3')
    expect(tasks.queuedHumanFollowups(task.id)).toEqual([])
  })

  it('wakes a conversation turn automatically when a follow-up message was queued mid-turn', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const worker = workers.createWorker({ adapterId: 'claude-code', label: `w-conv-${++seq}`, enabled: false })
    const task = tasks.createTask({ title: 'Chat turn 1', kind: 'conversation' })
    const session = seedSession(worker.id, 'claude-code')
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    tasks.markDelivered([tasks.messagesFor(task.id)[0]!.id])

    await handlers['task.message']({ id: task.id, text: 'Queued question 2', delivery: 'queue' })
    await scheduler.endConversationTurn(session, run, tasks.requireTask(task.id), 'Answer 1')

    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('ready')
    expect(tasks.queuedHumanFollowups(task.id).map((m) => m.text)).toEqual(['Queued question 2'])

    // Open ask_human questions are not bypassed by a pre-queued message
    const tAsked = tasks.createTask({ title: 'Chat with question', kind: 'conversation' })
    const sAsked = seedSession(worker.id, 'claude-code')
    const rAsked = tasks.startRun({
      taskId: tAsked.id,
      workerId: worker.id,
      sessionId: sAsked.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(tAsked.id, 'running', { assignee: worker.id })
    tasks.markDelivered([tasks.messagesFor(tAsked.id)[0]!.id])
    await handlers['task.message']({ id: tAsked.id, text: 'Pre-queued note', delivery: 'queue' })
    questions.fileParkedQuestion({ sessionId: sAsked.id, origin: 'ask_human', kind: 'text', question: 'Confirm path?' })
    await scheduler.endConversationTurn(sAsked, rAsked, tasks.requireTask(tAsked.id), 'Asked first')
    expect(tasks.requireTask(tAsked.id).status).toBe('awaiting_human')
  })

  it('delivers queued follow-ups inline on an open MCP turn end without waiting for the idle watchdog, or restarts cleanly for folder grants', async () => {
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const worker = workers.createWorker({ adapterId: 'claude-code', label: `w-idle-${++seq}`, enabled: false })
    const task = tasks.createTask({ title: 'Work run' })
    const session = seedSession(worker.id, 'claude-code')
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    tasks.markDelivered([tasks.messagesFor(task.id)[0]!.id])

    const sendSpy = vi.spyOn(sessions, 'sendPrompt').mockImplementation(() => {})
    await handlers['task.message']({ id: task.id, text: 'Queued turn 2', delivery: 'queue' })
    await turnend.onStreamResult(session, { isError: false, text: 'Finished step 1', terminalReason: null })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0]?.[1]).toBe('Queued turn 2')
    expect(tasks.queuedHumanFollowups(task.id)).toEqual([])
    expect(turnend.idleTurnFor(session.id)).toBeNull()
    expect(tasks.requireRun(run.id).endedAt).toBeNull()

    // Folder attachment requires a fresh spawn (--add-dir), so it closes and requeues instead
    const folder = attachments.createFolderAttachment(dir)
    const closeSpy = vi.spyOn(sessions, 'closeAndWait').mockResolvedValue(true)
    await handlers['task.message']({
      id: task.id,
      text: 'Check attached folder',
      attachmentIds: [folder.id],
      delivery: 'queue'
    })
    await turnend.onStreamResult(session, { isError: false, text: 'Finished turn 2', terminalReason: null })

    expect(closeSpy).toHaveBeenCalledWith(session.id)
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('ready')
    expect(tasks.queuedHumanFollowups(task.id).map((m) => m.text)).toEqual(['Check attached folder'])
  })

  it('replays migration 98 (task_messages.queued) safely and persists queued flag across reads', () => {
    const conn = db.db()
    const before = db.versionBefore("alter table task_messages add column queued integer not null default 0")
    conn.exec(`pragma user_version = ${before}`)
    db.openDb(join(dir, 'taskmessage.db'))

    const cols = db.db().prepare("pragma table_info('task_messages')").all() as { name: string }[]
    expect(cols.some((c) => c.name === 'queued')).toBe(true)
  })
})
