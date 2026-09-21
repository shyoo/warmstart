import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session, Worker } from '@shared/protocol.js'

/**
 * The fleet card's `n / max` (t597).
 *
 * Measured on a live fleet 2026-09-21: ClaudeSecond read `1 / 1` with nothing running on it,
 * and CodexFirst read `2 / 1` beside a single task on a one-slot worker. Both numbers come from
 * one arithmetic — `instanceUse` in `fleetcard.ts` adds open `work` sessions to the daemon's
 * `reservedSlots` — so both halves are pinned here, assembled exactly the way `fleet.list` serves
 * them: live rows from `sessionsForWorker`, gauges from `sessionsAndWarmConversationsForWorker`,
 * holds from `retainedReservations`.
 *
 * ⛔ Two defects, each enough on its own. (1) A running task whose open run does not reference its
 * live session was counted twice — once in `open` for the session, once in `held` for the task —
 * because both reservation counters excuse only tasks whose runs name a live session id. (2) A
 * task parked at `awaiting_human` and then reassigned kept reserving its old worker, which read
 * occupied though the reply would run elsewhere.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')
let residency: typeof import('./residency.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-slotcount-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  residency = await import('./residency.js')
  db.openDb(join(dir, 'slotcount.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
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

let seq = 0
function add(label: string, maxConcurrent = 1): Worker {
  seq += 1
  return workers.createWorker({ adapterId: 'claude-code', label: label ?? `w${seq}`, maxConcurrent })
}

function startRun(taskId: string, workerId: string, sessionId: string | null) {
  return tasks.startRun({ taskId, workerId, sessionId, projectId: null, quotaUnverified: false, costModelId: null })
}

function liveSession(id: string, workerId: string, state = 'live', purpose = 'work') {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at)
       values (?,?,?,?,?,?,?,?)`
    )
    .run(id, workerId, 'claude-code', 'stream', dir, state, purpose, Date.now())
}

/**
 * The card's number, assembled the way `fleet.list` (sessions, reservedSlots) and `instanceUse`
 * (open + held) compute it — `open` over the gauge list including warm conversations, `held`
 * over the live rows, exactly as the two call sites pass them.
 */
function cardUse(workerId: string): { open: number; held: number; inUse: number } {
  const live = sessions.sessionsForWorker(workerId)
  const all = sessions.sessionsAndWarmConversationsForWorker(workerId)
  const open = all.filter((s) => s.purpose === 'work' && !['closed', 'abandoned', 'failed'].includes(s.state)).length
  const held = residency.retainedReservations(workerId, live)
  return { open, held, inUse: open + held }
}

describe('the fleet card number', () => {
  it('reads 1 / 1 beside one running task with one live session', () => {
    const w = add('CodexFirst')
    const task = tasks.createTask({ title: 'the one task' })
    startRun(task.id, w.id, 's1')
    tasks.setStatus(task.id, 'running', { assignee: w.id })
    liveSession('s1', w.id)
    expect(cardUse(w.id)).toEqual({ open: 1, held: 0, inUse: 1 })
  })

  it('t597: reads 1 / 1 when the open run never recorded its session', () => {
    // The CodexFirst `2 / 1`: the task is demonstrably mid-flight and the session demonstrably
    // serves nobody on the books, so the session covers the task instead of doubling it.
    const w = add('CodexFirst')
    const task = tasks.createTask({ title: 'unlinked run' })
    startRun(task.id, w.id, null)
    tasks.setStatus(task.id, 'running', { assignee: w.id })
    liveSession('s1', w.id)
    expect(residency.runningTaskReservations(w.id, sessions.sessionsForWorker(w.id))).toBe(0)
    expect(cardUse(w.id)).toEqual({ open: 1, held: 0, inUse: 1 })
  })

  it('t597: one unclaimed session covers one task, and the second still holds', () => {
    // Pairing is 1:1 — a second sessionless task is a second holder, not a second cover.
    const w = add('CodexFirst')
    const first = tasks.createTask({ title: 'first' })
    startRun(first.id, w.id, null)
    tasks.setStatus(first.id, 'running', { assignee: w.id })
    const second = tasks.createTask({ title: 'second' })
    startRun(second.id, w.id, null)
    tasks.setStatus(second.id, 'running', { assignee: w.id })
    liveSession('s1', w.id)
    expect(residency.runningTaskReservations(w.id, sessions.sessionsForWorker(w.id))).toBe(1)
    expect(cardUse(w.id)).toEqual({ open: 1, held: 1, inUse: 2 })
  })

  it('a probe session never covers a sessionless work task', () => {
    // Cover is work only: probes, consults and reviews hold no work slot and excuse nothing.
    const w = add('CodexFirst')
    const task = tasks.createTask({ title: 'unlinked run' })
    startRun(task.id, w.id, null)
    tasks.setStatus(task.id, 'running', { assignee: w.id })
    liveSession('probe-1', w.id, 'live', 'probe')
    expect(cardUse(w.id)).toEqual({ open: 0, held: 1, inUse: 1 })
  })

  it('t597: a parked task reassigned elsewhere frees the old worker', () => {
    // The ClaudeSecond `1 / 1` with nothing on it: the reply will run on the new worker, so the
    // old one holds nothing — and the new one holds nothing yet either.
    const oldWorker = add('ClaudeSecond')
    const newWorker = add('ClaudeFirst')
    const task = tasks.createTask({ title: 'parked then reassigned' })
    const run = startRun(task.id, oldWorker.id, 's-old')
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    expect(cardUse(oldWorker.id)).toEqual({ open: 0, held: 1, inUse: 1 })

    tasks.setStatus(task.id, 'awaiting_human', { assignee: newWorker.id })
    expect(cardUse(oldWorker.id)).toEqual({ open: 0, held: 0, inUse: 0 })
    expect(cardUse(newWorker.id)).toEqual({ open: 0, held: 0, inUse: 0 })
  })

  it('a parked task waiting on a person still holds its worker', () => {
    // The reassignment fix must not free the t117 hold: a task nobody moved still owns its slot.
    const w = add('ClaudeSecond')
    const task = tasks.createTask({ title: 'waiting on you' })
    const run = startRun(task.id, w.id, 's-old')
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    expect(cardUse(w.id)).toEqual({ open: 0, held: 1, inUse: 1 })
  })

  it('a parked task with its warm session live counts once', () => {
    // The ended run still names the live session, so the ordinary exclusion — not cover — applies.
    const w = add('ClaudeSecond')
    const task = tasks.createTask({ title: 'warm parked' })
    const run = startRun(task.id, w.id, 's-warm')
    tasks.finishRun(run.id, 'completed')
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    liveSession('s-warm', w.id, 'idle')
    expect(cardUse(w.id)).toEqual({ open: 1, held: 0, inUse: 1 })
  })

  it('a landing task with a closed session holds its slot until it settles', () => {
    const w = add('CodexFirst')
    const task = tasks.createTask({ title: 'landing' })
    const run = startRun(task.id, w.id, 's-closed')
    tasks.setStatus(task.id, 'running', { assignee: w.id })
    expect(cardUse(w.id)).toEqual({ open: 0, held: 1, inUse: 1 })
    tasks.setStatus(task.id, 'completed')
    tasks.finishRun(run.id, 'completed')
    expect(cardUse(w.id)).toEqual({ open: 0, held: 0, inUse: 0 })
  })

  it('two genuinely busy tasks still read over max', () => {
    // Pairing excuses nothing that is linked: two tasks, two sessions, each named by its run.
    const w = add('CodexFirst')
    for (const [title, sessionId] of [['first', 's1'], ['second', 's2']] as const) {
      const task = tasks.createTask({ title })
      startRun(task.id, w.id, sessionId)
      tasks.setStatus(task.id, 'running', { assignee: w.id })
      liveSession(sessionId, w.id)
    }
    expect(cardUse(w.id)).toEqual({ open: 2, held: 0, inUse: 2 })
  })

  it('a parked task and a running task are two holders, not one', () => {
    const w = add('CodexFirst')
    const parked = tasks.createTask({ title: 'parked' })
    const parkedRun = startRun(parked.id, w.id, 's-old')
    tasks.finishRun(parkedRun.id, 'blocked')
    tasks.setStatus(parked.id, 'awaiting_human', { assignee: 'human' })
    const running = tasks.createTask({ title: 'running' })
    startRun(running.id, w.id, 's1')
    tasks.setStatus(running.id, 'running', { assignee: w.id })
    liveSession('s1', w.id)
    expect(cardUse(w.id)).toEqual({ open: 1, held: 1, inUse: 2 })
  })
})

describe('unclaimedLiveWorkSessions', () => {
  it('is empty where every live session is named by a run', () => {
    const w = add('W')
    const open = tasks.createTask({ title: 'open' })
    startRun(open.id, w.id, 's-open')
    const parked = tasks.createTask({ title: 'parked' })
    const ended = startRun(parked.id, w.id, 's-ended')
    tasks.finishRun(ended.id, 'blocked')
    const live = [
      { id: 's-open', purpose: 'work' },
      { id: 's-ended', purpose: 'work' }
    ] as Session[]
    expect(residency.unclaimedLiveWorkSessions(live)).toEqual(new Set())
  })

  it('names a live session no run references, and nothing else', () => {
    const w = add('W')
    const task = tasks.createTask({ title: 'linked' })
    startRun(task.id, w.id, 's-linked')
    const live = [
      { id: 's-linked', purpose: 'work' },
      { id: 's-lost', purpose: 'work' },
      { id: 'probe-1', purpose: 'probe' },
      { id: 'legacy', purpose: null }
    ] as unknown as Session[]
    // `legacy` has no purpose on very old rows; only a non-work purpose disqualifies.
    expect(residency.unclaimedLiveWorkSessions(live)).toEqual(new Set(['s-lost', 'legacy']))
  })
})

describe('awaitingHumanReservations assignment', () => {
  function park(workerId: string): ReturnType<typeof tasks.createTask> {
    const task = tasks.createTask({ title: 'parked' })
    const run = startRun(task.id, workerId, 's-old')
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    return task
  }

  it('holds the worker it ran on while a person is the assignee', () => {
    const w = add('W')
    park(w.id)
    expect(residency.awaitingHumanReservations(w.id, [])).toBe(1)
  })

  it('holds the worker it is pinned to', () => {
    const w = add('W')
    const task = park(w.id)
    tasks.setStatus(task.id, 'awaiting_human', { assignee: w.id })
    expect(residency.awaitingHumanReservations(w.id, [])).toBe(1)
  })

  it('t597: holds nothing where it ran once reassigned to another worker', () => {
    const oldWorker = add('Old')
    const newWorker = add('New')
    const task = park(oldWorker.id)
    tasks.setStatus(task.id, 'awaiting_human', { assignee: newWorker.id })
    expect(residency.awaitingHumanReservations(oldWorker.id, [])).toBe(0)
    expect(residency.awaitingHumanReservations(newWorker.id, [])).toBe(0)
  })
})
