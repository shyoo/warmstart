import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

/**
 * t498: closing a conversation a worker is holding must actually free the slot it holds.
 *
 * ⛔ **The bug, reported against t497.** ClaudeThird was already holding a conversation at
 * `awaiting_human` — resting on a reply, its session kept live and warm on purpose
 * (`endConversationTurn`). A second task pinned to ClaudeThird queued behind it at capacity, exactly
 * as designed. Closing the held conversation (Finish, or Stop) was supposed to free the slot and let
 * the second task run — and did not.
 *
 * ⛔ **Root cause: `sessionOf` answers "is a run open right now", and a resting conversation has
 * none.** `endConversationTurn` finishes the run the moment the agent's turn ends — deliberately, so
 * the reply is metered as its own turn — while the session itself stays live for exactly the reply
 * the task is resting on. `resolveTask` (Finish) and `cancelTask`'s `windDown` (Stop) both located
 * "the session to close" by finding an *open* run's session, so for a task resting at
 * `awaiting_human` neither ever found anything: the still-live session was never closed, and it went
 * on counting against `worker.maxConcurrent` forever — which is exactly the resource the second task
 * was queued behind. `restingSessionOf` (scheduler.ts) finds the most recent run's session whether or
 * not that run is still open, and both call sites now use it.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let sessions: typeof import('./sessions.js')
let residency: typeof import('./residency.js')
let scoring: typeof import('./scoring.js')
let cancelMod: typeof import('./cancel.js')

let origClaudeInstalled: () => boolean

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-convcapacity-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  sessions = await import('./sessions.js')
  residency = await import('./residency.js')
  scoring = await import('./scoring.js')
  cancelMod = await import('./cancel.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  origClaudeInstalled = claudeCode.isInstalled
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'convcapacity.db'))
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

/** A one-slot worker whose CLI reads as installed, logged in, and holding fresh quota. */
function createWorker(label: string, maxConcurrent = 1): Worker {
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

/**
 * A conversation resting at `awaiting_human`, exactly the way `endConversationTurn` leaves one: its
 * run has already finished — the turn is over and metered — and its session is still `live`, kept
 * warm on purpose for the reply. `lastRequestStartedAt` controls how warm: `warmAgoMs` in the past.
 */
function seedHeldConversation(worker: Worker, warmAgoMs = 5_000) {
  const task = tasks.createTask({ title: 'held conversation', createdBy: { kind: 'human' }, kind: 'conversation' })
  const sessionId = `session-${task.id}`
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             last_request_started_at, tokens_since_compact)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(sessionId, worker.id, 'claude-code', 'stream', dir, 'live', 'work', Date.now(), Date.now() - warmAgoMs, 0)
  const run = tasks.startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId,
    projectId: null,
    quotaUnverified: false,
    costModelId: null
  })
  // The turn is over: `endConversationTurn` finishes this run the moment the agent stops talking,
  // while the session (seeded above) stays `live`.
  tasks.finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')
  tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'your turn' })
  return { task: tasks.requireTask(task.id), sessionId }
}

describe('restingSessionOf finds a resting conversation, unlike sessionOf', () => {
  it('sessionOf sees nothing once the turn has ended, even though the session is still live', () => {
    const worker = createWorker('ClaudeThird')
    const { task, sessionId } = seedHeldConversation(worker)
    expect(scheduler.sessionOf(task.id)).toBeNull()
    expect(sessions.getSession(sessionId)?.state).toBe('live')
  })

  it('restingSessionOf finds the same live session', () => {
    const worker = createWorker('ClaudeThird')
    const { task, sessionId } = seedHeldConversation(worker)
    expect(scheduler.restingSessionOf(task.id)?.id).toBe(sessionId)
  })

  it('agrees with sessionOf while a run is genuinely open', () => {
    const worker = createWorker('ClaudeThird')
    const task = tasks.createTask({ title: 'mid turn', createdBy: { kind: 'human' } })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: 'session-open',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at, tokens_since_compact)
         values (?,?,?,?,?,?,?,?,?)`
      )
      .run(run.sessionId, worker.id, 'claude-code', 'stream', dir, 'live', 'work', Date.now(), 0)
    expect(scheduler.restingSessionOf(task.id)?.id).toBe(scheduler.sessionOf(task.id)?.id)
  })

  it('returns null for a task that never ran', () => {
    const task = tasks.createTask({ title: 'never dispatched', createdBy: { kind: 'human' } })
    expect(scheduler.restingSessionOf(task.id)).toBeNull()
  })
})

describe('a held conversation blocks a pinned task at capacity, exactly as designed', () => {
  it('refuses the second task while the first rests on a reply', () => {
    const worker = createWorker('ClaudeThird', 1)
    seedHeldConversation(worker)
    const blocked = tasks.createTask({
      title: 'filed against ClaudeThird',
      createdBy: { kind: 'human' },
      constraints: { workerId: worker.id }
    })
    const choice = scoring.chooseTarget(blocked)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toMatch(/at capacity/i)
  })
})

describe('Finish closes a resting conversation and frees the slot it held', () => {
  it('closes the session even though no run was open', async () => {
    const worker = createWorker('ClaudeThird')
    const { task, sessionId } = seedHeldConversation(worker)
    await scheduler.resolveTask(task.id, 'good enough')
    expect(tasks.requireTask(task.id).status).toBe('completed')
    expect(sessions.getSession(sessionId)?.state).toBe('closed')
  })

  it('unblocks a task that was queued behind the worker at capacity', async () => {
    const worker = createWorker('ClaudeThird', 1)
    const { task: held } = seedHeldConversation(worker)
    const blocked = tasks.createTask({
      title: 'filed against ClaudeThird',
      createdBy: { kind: 'human' },
      constraints: { workerId: worker.id }
    })
    expect(scoring.chooseTarget(blocked).worker).toBeNull()

    await scheduler.resolveTask(held.id)

    const choice = scoring.chooseTarget(blocked)
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.reason).not.toMatch(/at capacity/i)
  })
})

describe('Stop decides the resting session the same way it decides a live one', () => {
  it('closes it outright when the resting state is cancelled', async () => {
    const worker = createWorker('ClaudeThird')
    const { task, sessionId } = seedHeldConversation(worker)
    await cancelMod.cancelTask(task.id, { restingState: 'cancelled', requestedBy: 'human' })
    expect(tasks.requireTask(task.id).status).toBe('cancelled')
    expect(sessions.getSession(sessionId)?.state).toBe('closed')
  })

  it('keeps a still-warm session open on an ordinary human Stop (paused_user)', async () => {
    const worker = createWorker('ClaudeThird')
    const { task, sessionId } = seedHeldConversation(worker, 5_000)
    await cancelMod.cancelTask(task.id, { requestedBy: 'human' })
    expect(tasks.requireTask(task.id).status).toBe('paused_user')
    // ⛔ Not a regression: `decideSessionFate` deliberately keeps a warm session for a task that may
    // resume into it. The bug was that this decision was never reached at all for a resting
    // conversation; this pins that it now is, and that it can still choose to keep one warm.
    expect(sessions.getSession(sessionId)?.state).toBe('live')
  })

  it('closes a lapsed session on an ordinary human Stop, so it stops holding the slot', async () => {
    const worker = createWorker('ClaudeThird')
    // Well past Claude's default cache TTL (3600s): resuming it would cost a cold rebuild anyway.
    const { task, sessionId } = seedHeldConversation(worker, 2 * 60 * 60 * 1000)
    await cancelMod.cancelTask(task.id, { requestedBy: 'human' })
    expect(tasks.requireTask(task.id).status).toBe('paused_user')
    expect(sessions.getSession(sessionId)?.state).toBe('closed')
  })

  it('frees the worker for a task queued behind it once the cancelled session is closed', async () => {
    const worker = createWorker('ClaudeThird', 1)
    const { task: held } = seedHeldConversation(worker)
    const blocked = tasks.createTask({
      title: 'filed against ClaudeThird',
      createdBy: { kind: 'human' },
      constraints: { workerId: worker.id }
    })
    expect(scoring.chooseTarget(blocked).worker).toBeNull()

    await cancelMod.cancelTask(held.id, { restingState: 'cancelled', requestedBy: 'human' })

    const choice = scoring.chooseTarget(blocked)
    expect(choice.worker?.id).toBe(worker.id)
  })
})

describe('capacity accounting agrees once the resting session is actually gone', () => {
  it('atCapacity reads free the moment the live session closes', async () => {
    const worker = createWorker('ClaudeThird', 1)
    const { task } = seedHeldConversation(worker)
    const before = sessions.sessionsForWorker(worker.id)
    expect(residency.atCapacity(before, worker.maxConcurrent, null)).toBe(true)

    await scheduler.resolveTask(task.id)

    const after = sessions.sessionsForWorker(worker.id)
    expect(residency.atCapacity(after, worker.maxConcurrent, null)).toBe(false)
  })
})
