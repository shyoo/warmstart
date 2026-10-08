import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session, Worker } from '@shared/protocol.js'
import type { Run, Task } from '@shared/tasks.js'

/**
 * A conversation whose turn ended with jobs still running in the background (t987 ← t962).
 *
 * ⭐ t962's agent said *"the evaluation runs are going in the background, I'll pick up the results when
 * they finish"* and ended its turn. The task rested at `awaiting_human`, then flipped to *the agent
 * picked this up again by itself* a minute later with three more jobs running. The CLI's own list of
 * background jobs (`StreamEvent.background_tasks`, measured on claude 2.1.294) is written before the
 * turn's `result`, so the turn end can know.
 *
 * ⛔ What is pinned: the hold itself, the four claims on a turn's end that must still win over it, and
 * both exits — the CLI's wake (a second turn) and the wake that never comes (the watchdog).
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')
let background: typeof import('./backgroundtasks.js')

let claude: Worker
let seq = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-backgroundhold-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  background = await import('./backgroundtasks.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'backgroundhold.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'bg-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** A conversation mid-turn: run open, task running, session live. */
function working(): { task: Task; run: Run; session: Session } {
  seq += 1
  const sessionId = `99999999-2222-3333-4444-${String(seq).padStart(12, '0')}`
  const task = tasks.createTask({ title: `bg ${seq}`, kind: 'conversation', status: 'ready' })
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
       values (?, ?, 'claude-code', 'stream', null, ?, 'live', 'work', ?)`
    )
    .run(sessionId, claude.id, dir, Date.now())
  const run = tasks.startRun({
    taskId: task.id,
    workerId: claude.id,
    sessionId,
    projectId: null,
    quotaUnverified: false,
    costModelId: null
  })
  tasks.setStatus(task.id, 'running', { assignee: claude.id })
  return { task: tasks.requireTask(task.id), run, session: sessions.getSession(sessionId) as Session }
}

const evalJob = { id: 'bj57m2xio', description: 'Evaluation run, Raindrop' }

describe('a turn that ends with background jobs running', () => {
  it('keeps the task running, the run open and the session held, and posts the reply', async () => {
    const { task, run, session } = working()
    background.noteBackgroundTasks(session.id, [evalJob])

    await scheduler.endConversationTurn(session, run, task, 'The evaluation runs are going in the background.')

    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('running')
    expect(tasks.runsFor(task.id).find((r) => r.id === run.id)?.endedAt).toBeNull()
    expect(background.heldRunOf(session.id)).toBe(run.id)
    const thread = tasks.messagesFor(task.id)
    expect(thread.some((m) => m.role === 'agent' && m.text.includes('going in the background'))).toBe(true)
    const said = thread.filter((m) => m.event === 'conversation.background_hold')
    expect(said).toHaveLength(1)
    expect(said[0]?.detail).toContain('Evaluation run, Raindrop')
  })

  it('says so once, however many turns end with the jobs still running', async () => {
    const { task, run, session } = working()
    background.noteBackgroundTasks(session.id, [evalJob])
    await scheduler.endConversationTurn(session, run, task, 'first')
    await scheduler.endConversationTurn(session, run, tasks.requireTask(task.id), 'second')

    expect(tasks.messagesFor(task.id).filter((m) => m.event === 'conversation.background_hold')).toHaveLength(1)
    expect(tasks.requireTask(task.id).status).toBe('running')
  })

  it('rests at your turn when the next turn ends with nothing left running — the CLI’s wake', async () => {
    const { task, run, session } = working()
    background.noteBackgroundTasks(session.id, [evalJob])
    await scheduler.endConversationTurn(session, run, task, 'first')

    background.noteBackgroundTasks(session.id, [])
    await scheduler.endConversationTurn(session, run, tasks.requireTask(task.id), 'All four finished.')

    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('awaiting_human')
    expect(tasks.runsFor(task.id).find((r) => r.id === run.id)?.endedAt).not.toBeNull()
    expect(background.heldRunOf(session.id)).toBeNull()
  })

  it('rests at your turn at once when nothing is running, as before', async () => {
    const { task, run, session } = working()
    await scheduler.endConversationTurn(session, run, task, 'Done.')
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.messagesFor(task.id).some((m) => m.event === 'conversation.background_hold')).toBe(false)
  })

  it('does not hold a turn a landing is owed on: the Commit press wins', async () => {
    const { task, run, session } = working()
    tasks.setLandAfterTurn(task.id, 'commit-only')
    background.noteBackgroundTasks(session.id, [evalJob])
    await scheduler.endConversationTurn(session, run, tasks.requireTask(task.id), 'Committed.')
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(background.heldRunOf(session.id)).toBeNull()
  })
})

describe('the wake that never comes', () => {
  it('releases a held conversation to your turn without posting the reply twice', async () => {
    const { task, run, session } = working()
    background.noteBackgroundTasks(session.id, [evalJob])
    await scheduler.endConversationTurn(session, run, task, 'The jobs are running.')
    background.noteBackgroundTasks(session.id, [])

    await scheduler.endConversationTurn(session, run, tasks.requireTask(task.id), null, { release: true })

    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(background.heldRunOf(session.id)).toBeNull()
    expect(tasks.messagesFor(task.id).filter((m) => m.role === 'agent')).toHaveLength(1)
  })
})
