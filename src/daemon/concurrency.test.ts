import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * One account, more than one task at a time.
 *
 * ⭐ `maxConcurrent` has gated this since M1 — `atCapacity` reads it before dispatch and
 * `spawnSession` refuses past it — and until 2026-08-29 nothing in the app could change it. It was
 * rendered in the Workers table as text, commissioned at 1, and every suite in the repo exercised it
 * at exactly that value. So a fleet of one account ran one task at a time, and the hold that said so
 * read as a fact about the provider rather than as a setting nobody had been given a control for.
 *
 * ⚠️ These tests drive the two gates directly rather than a live dispatch. What was untested is the
 * arithmetic at values above one, and a real dispatch would need an agent CLI to prove it.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let scheduler: typeof import('./scheduler.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-concurrency-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  scheduler = await import('./scheduler.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'concurrency.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

let seq = 0
const add = (maxConcurrent?: number) => {
  seq += 1
  return workers.createWorker({ adapterId: 'claude-code', label: `w${seq}`, maxConcurrent })
}

/** Only the two fields `atCapacity` reads. A real session carries thirty more and none of them count. */
const session = (id: string, purpose: 'work' | 'consult' = 'work'): Session =>
  ({ id, purpose }) as Session

describe('how many tasks one account may run at once', () => {
  it('commissions at one, which is a cost decision rather than a provider limit', () => {
    // ⚠️ Parallel requests against one cached prefix each pay a cache write (cost-model.md §1), so a
    // second session on an account is worth money. The default says so; it does not say "impossible".
    expect(add().maxConcurrent).toBe(1)
  })

  it('takes the number it is given, at commissioning and afterwards', () => {
    const worker = add(4)
    expect(worker.maxConcurrent).toBe(4)
    expect(workers.updateWorker(worker.id, { maxConcurrent: 2 }).maxConcurrent).toBe(2)
  })

  it('refuses to go below one, because a max of zero is a worker that never says why', () => {
    // ⛔ Zero would leave the worker enabled, its quota counted and its role honoured, and silently
    //    never take a task — `atCapacity` true on an empty account. The switch for "do not use this
    //    one" is `enabled`, which says so on the row.
    const worker = add()
    expect(workers.updateWorker(worker.id, { maxConcurrent: 0 }).maxConcurrent).toBe(1)
    expect(workers.updateWorker(worker.id, { maxConcurrent: -3 }).maxConcurrent).toBe(1)
    expect(add(0).maxConcurrent).toBe(1)
  })

  it('keeps the current value when a patch does not mention it', () => {
    // ⛔ The guard that stops the clamp becoming a reset. Every worker mutation goes through one
    //    statement that writes all five columns, so a rename must not quietly re-floor this one.
    const worker = add(3)
    expect(workers.updateWorker(worker.id, { label: 'renamed' }).maxConcurrent).toBe(3)
  })

  it('floors a fractional value rather than storing it', () => {
    // A number input hands back whatever was typed; half a session is not a thing.
    expect(add(2.7).maxConcurrent).toBe(2)
  })
})

describe('the capacity gate above one slot', () => {
  it('lets a second task onto an account already running one', () => {
    // ⭐ The whole point. At `maxConcurrent: 1` this is the hold the operator saw as `queued`.
    expect(scheduler.atCapacity([session('a')], 2, null)).toBe(false)
  })

  it('stops the third, so the number is a bound and not a suggestion', () => {
    expect(scheduler.atCapacity([session('a'), session('b')], 2, null)).toBe(true)
  })

  it('still exempts the session a task would reuse, at every width', () => {
    // ⛔ Reusing an open session starts no process, so it cannot fill a slot. This was the bug that
    //    made a one-slot worker refuse every warm continuation; widening the account must not
    //    quietly reintroduce it at the new ceiling.
    const open = session('warm')
    expect(scheduler.atCapacity([open, session('b')], 2, open)).toBe(false)
    expect(scheduler.atCapacity([open], 1, open)).toBe(false)
  })

  it('counts work only, so consults do not consume the widened slots either', () => {
    // ⚠️ A consult is one short tool-less turn holding no workspace, bounded separately in
    //    controller.ts. Counting it here would mean a busy fleet cannot ask for judgment exactly
    //    when judgment is worth the most.
    const busy = [session('a'), session('c1', 'consult'), session('c2', 'consult')]
    expect(scheduler.atCapacity(busy, 2, null)).toBe(false)
  })

  it('keeps a slot for a task whose question closed its session', () => {
    // t117's session had ended, so it was absent from `sessionsForWorker`; without this separate
    // reservation t118 immediately started on the same one-slot worker while t117 still owned its
    // workspace and awaited a person.
    const worker = add(1)
    const parked = tasks.createTask({ title: 'needs a decision' })
    const run = tasks.startRun({
      taskId: parked.id,
      workerId: worker.id,
      sessionId: 'closed-after-question',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(parked.id, 'awaiting_human', { assignee: 'human' })

    const retained = scheduler.awaitingHumanReservations(worker.id, [])
    expect(retained).toBe(1)
    expect(scheduler.atCapacity([], worker.maxConcurrent, null, retained)).toBe(true)
    expect(scheduler.awaitingHumanReservations('another-worker', [])).toBe(0)
  })

  it('does not double-count a parked task whose session is still warm', () => {
    const worker = add(1)
    const parked = tasks.createTask({ title: 'waiting with a warm conversation' })
    const run = tasks.startRun({
      taskId: parked.id,
      workerId: worker.id,
      sessionId: 'still-warm',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.finishRun(run.id, 'blocked')
    tasks.setStatus(parked.id, 'awaiting_human', { assignee: 'human' })

    const warm = session('still-warm')
    expect(scheduler.awaitingHumanReservations(worker.id, [warm])).toBe(0)
    expect(scheduler.atCapacity([warm], worker.maxConcurrent, warm, 0)).toBe(false)
  })

  it('keeps a slot for a task that is still running or landing after its session closed', () => {
    // ⛔ When a one-shot adapter like Codex calls task_complete, its CLI process exits immediately
    // and the session becomes 'closed' while landTask is still checking and merging work.
    // Without retained reservations for running tasks, the scheduler and spawnSession would treat
    // the worker as idle and dispatch another task, violating maxConcurrent (measured on t164/t165, t179/t180).
    const worker = add(1)
    const runningTask = tasks.createTask({ title: 'landing in progress' })
    const run = tasks.startRun({
      taskId: runningTask.id,
      workerId: worker.id,
      sessionId: 'closed-while-landing',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(runningTask.id, 'running', { assignee: worker.id })

    // Session is closed, so absent from sessionsForWorker ([]).
    const runningRetained = scheduler.runningTaskReservations(worker.id, [])
    expect(runningRetained).toBe(1)
    const totalRetained = scheduler.retainedReservations(worker.id, [])
    expect(totalRetained).toBe(1)
    expect(scheduler.atCapacity([], worker.maxConcurrent, null, totalRetained)).toBe(true)
    expect(scheduler.runningTaskReservations('another-worker', [])).toBe(0)

    // Does not double-count if the session is still live:
    const liveSession = session('closed-while-landing')
    expect(scheduler.runningTaskReservations(worker.id, [liveSession])).toBe(0)

    // Once landing finishes and the run is closed, the slot is freed:
    tasks.setStatus(runningTask.id, 'completed')
    tasks.finishRun(run.id, 'completed')
    expect(scheduler.runningTaskReservations(worker.id, [])).toBe(0)
    expect(scheduler.retainedReservations(worker.id, [])).toBe(0)
    expect(scheduler.atCapacity([], worker.maxConcurrent, null, 0)).toBe(false)
  })

  it('spawnSession refuses when an uncounted open run exists on a 1-slot worker', () => {
    const worker = add(1)
    const runningTask = tasks.createTask({ title: 'task with open run' })
    const run = tasks.startRun({
      taskId: runningTask.id,
      workerId: worker.id,
      sessionId: 'session-closed-early',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.setStatus(runningTask.id, 'running', { assignee: worker.id })

    // spawnSession checks live sessions + open runs on this worker.
    // Even if sessionsForWorker is empty, the open run must block spawning a second work session.
    expect(() =>
      sessions.spawnSession({
        workerId: worker.id,
        purpose: 'work'
      })
    ).toThrow(/is at its concurrency limit \(1\/1\)/)

    // Once the run finishes, spawnSession no longer throws concurrency limit
    tasks.finishRun(run.id, 'completed')
    // (It might throw due to cwd/isolation or lack of CLI, but not concurrency limit)
    try {
      sessions.spawnSession({ workerId: worker.id, purpose: 'work' })
    } catch (err: unknown) {
      expect((err as Error).message).not.toMatch(/is at its concurrency limit/)
    }
  })
})
