import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Preempting a run once, rather than once every ten seconds.
 *
 * ⛔ Measured on t5, 2026-08-28. The runaway watchdog decided a run was past its estimate, sent the
 * agent *"Wrap up now. Commit anything that compiles on this branch, then call the `handoff` tool"*,
 * and then waited two minutes for that to land — leaving the run open and the task `running`, which
 * is exactly the state the watchdog scans for. It fired again on the next tick, and the next: **13**
 * identical notices between 02:42:52 and 02:44:42, and 13 wrap-up prompts into a session that had
 * already committed and already handed off. What the operator saw was an agent apparently stuck in a
 * commit loop, answering "already done" over and over.
 *
 * ⚠️ And the loop paid for itself in the currency it was policing: each of those forced turns was
 * more spend, so the overrun factor quoted in the notice climbed 3.1× → 3.9× while no work happened.
 * A watchdog whose own firing satisfies its trigger will not stop on its own.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let settings: typeof import('./settings.js')

/** The estimate the runaway factor is measured against; one completed run is enough to have one. */
const ESTIMATE = 100_000

let seq = 0

/** A session row written straight to the store: no CLI is installed in a unit test and none is needed. */
function seedSession(workerId: string): string {
  seq += 1
  const id = `5e551011-0000-4000-8000-${String(seq).padStart(12, '0')}`
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             tokens_since_compact)
       values (?,?,?,?,?,?,?,?,0)`
    )
    .run(id, workerId, 'openai-compatible', 'stream', dir, 'live', 'work', Date.now())
  return id
}

/**
 * ⚠️ `enabled: false` on every worker here. Nothing in this file should dispatch, and `tick()` — which
 * these tests call directly — is the thing that dispatches.
 */
function seedWorker(): string {
  seq += 1
  return workers.createWorker({ adapterId: 'openai-compatible', label: `w${seq}`, enabled: false }).id
}

/** History, so `overrunFactor` has something to divide by. Without it a run cannot be a runaway. */
function seedHistory(): void {
  const workerId = seedWorker()
  const sessionId = seedSession(workerId)
  const task = tasks.createTask({ title: 'a run that finished', createdBy: { kind: 'human' } })
  const run = tasks.startRun({
    taskId: task.id,
    workerId,
    sessionId,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  tasks.creditTurn(sessionId, { input: ESTIMATE, output: 0, cacheRead: 0, cacheWrite: 0 })
  tasks.finishRun(run.id, 'completed')
}

/** A live run that has already spent well past `RUNAWAY_FACTOR` times the estimate above. */
function seedRunawayTask(spend = ESTIMATE * 4) {
  const workerId = seedWorker()
  const sessionId = seedSession(workerId)
  const task = tasks.createTask({ title: 'a run that will not stop', createdBy: { kind: 'human' } })
  const run = tasks.startRun({
    taskId: task.id,
    workerId,
    sessionId,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  tasks.creditTurn(sessionId, { input: spend, output: 0, cacheRead: 0, cacheWrite: 0 })
  tasks.setStatus(task.id, 'running', { assignee: workerId })
  return { task, run, sessionId }
}

const noticesOn = (taskId: string): number =>
  tasks
    .messagesFor(taskId)
    .filter((m) => m.role === 'system' && m.text.includes('past its estimate')).length

/** Every preemption of any kind, which is the only thing `preempt` does synchronously. */
const wrapUpsOn = (taskId: string): number =>
  tasks.messagesFor(taskId).filter((m) => m.role === 'system' && m.text.startsWith('Preempted')).length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-preempt-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  settings = await import('./settings.js')
  db.openDb(join(dir, 'preempt.db'))
})

beforeEach(() => {
  db.db().exec(
    'delete from runs; delete from sessions; delete from task_messages; delete from tasks;' +
      ' delete from rate_limit_samples; delete from settings'
  )
  vi.useFakeTimers({ shouldAdvanceTime: false })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('a run past its estimate', () => {
  // ⚠️ Opted into. The trigger these three exercise ships **off**, so every one of them has to turn
  // it on first - which is itself the assertion that the switch is load-bearing.
  beforeEach(() => settings.setSetting('autoRunawayStop', true))

  it('is told to wrap up once, however many ticks pass while it does', async () => {
    seedHistory()
    const { task } = seedRunawayTask()

    // ⛔ Three ticks inside the grace period — the exact shape of the t5 log, where twelve of them
    // fitted before the park landed.
    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()

    expect(noticesOn(task.id)).toBe(1)
  })

  it('still parks the task when the grace period expires', async () => {
    // ⚠️ The guard suppresses the *repeat*, not the preemption. A run that goes quiet after being
    // told to wrap up must still be parked, or the fix trades a loop for a task nobody ever ends.
    seedHistory()
    const { task, run } = seedRunawayTask()

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    // ⛔ `awaiting_human`, not `paused_quota`: no window is closing, so there is nothing to resume
    // after and a person has to decide whether this work is worth more money.
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(noticesOn(task.id)).toBe(1)
  })

  it('leaves a run that finished during the grace period alone', async () => {
    // ⛔ Two minutes is a long time in a fleet. The usual outcome of a wrap-up prompt is that the
    // agent takes it, commits, and ends — and parking a task that already moved on would close a
    // session and overwrite a status that is no longer the preemption's to set.
    seedHistory()
    const { task, run } = seedRunawayTask()

    await scheduler.tick()
    tasks.finishRun(run.id, 'completed')
    tasks.setStatus(task.id, 'completed')
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('completed')
    expect(tasks.getTask(task.id)?.status).toBe('completed')
  })
})

/**
 * ⛔ The switches exist so a fleet can be brought up gradually, which means the thing worth testing
 * is not that they flip - it is that a run actually survives them being off. A toggle that persists
 * beautifully and gates nothing is the failure mode here.
 */
describe('the switches that gate all of this', () => {
  /** A worker whose window closes inside the preempt margin, from a live rate-limit record. */
  function seedClosingWindow(workerId: string): void {
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(workerId, null, '5h', 'allowed', Date.now() + 60_000, Date.now())
  }

  it('leaves a closing window alone when preemption is off', async () => {
    const { task, run } = seedRunawayTask(0)
    seedClosingWindow(tasks.requireRun(run.id).workerId)
    settings.setSetting('autoPreempt', false)

    await scheduler.tick()
    // ⛔ Past the grace period, not just past the tick. Preemption changes nothing about the run
    // synchronously - it sends a prompt and waits - so a check that stops at `tick()` would pass
    // against a switch that gates nothing at all. Measured: it did.
    await vi.advanceTimersByTimeAsync(130_000)

    expect(wrapUpsOn(task.id)).toBe(0)
    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
  })

  it('wraps up at a closing window when preemption is on, which is the default', async () => {
    // ⛔ The paired half. Without it the test above passes just as well against a watchdog that is
    // broken outright, and "the switch works" would mean nothing.
    expect(settings.DEFAULT_SETTINGS.autoPreempt).toBe(true)
    const { task, run } = seedRunawayTask(0)
    seedClosingWindow(tasks.requireRun(run.id).workerId)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    // ⚠️ `paused_quota`, not `awaiting_human`: a window boundary has a reset time, so the task
    // carries it and resumes itself. Nobody has to come back and press anything.
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
    expect(tasks.getTask(task.id)?.notBefore).not.toBeNull()
  })

  it('never stops a runaway until somebody asks for it', async () => {
    expect(settings.DEFAULT_SETTINGS.autoRunawayStop).toBe(false)
    seedHistory()
    const { task, run } = seedRunawayTask()

    await scheduler.tick()
    await scheduler.tick()

    expect(noticesOn(task.id)).toBe(0)
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('preempts a run on rate_limit_warning when autoOverrunPreempt is on', async () => {
    expect(settings.DEFAULT_SETTINGS.autoOverrunPreempt).toBe(true)
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(workerId, null, '5h', 'allowed_warning', Date.now() + 3_600_000, Date.now())

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
  })

  it('leaves a run with rate_limit_warning alone when autoOverrunPreempt is off', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(workerId, null, '5h', 'allowed_warning', Date.now() + 3_600_000, Date.now())
    settings.setSetting('autoOverrunPreempt', false)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(wrapUpsOn(task.id)).toBe(0)
    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
  })

  it('preempts a run when 5h quota is >= 95% and autoOverrunPreempt is on', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(workerId, '5h', '5-hour', 96, Date.now() + 3_600_000, 'probe', Date.now())

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
  })

  it('persists, and a corrupt value falls back rather than taking the fleet down', () => {
    // A switch written by something that is not this build is a preference, not a credential: it
    // must not be able to stop the daemon starting.
    expect(settings.setSetting('autoPreempt', false).autoPreempt).toBe(false)
    expect(settings.settings().autoPreempt).toBe(false)
    db.db()
      .prepare('insert or replace into settings (key, value, updated_at) values (?,?,?)')
      .run('autoPreempt', 'not json', Date.now())
    expect(settings.settings().autoPreempt).toBe(true)
  })
})

/**
 * The other end of a preemption: giving the task back.
 *
 * ⛔ `preempt` parks a task as `paused_quota` carrying `not_before = resetsAt`, and its own comment
 * says it *"resumes itself"*. Nothing did. `admitScheduled` reads `status = 'scheduled'`; `admit`
 * refuses everything in `TERMINAL_OR_HELD`, which lists this status; `resumeTask` took only
 * `paused_user` and `cancelled`. Measured on t60, 2026-08-31: parked 05:09:25Z with `not_before`
 * 06:40:00Z, still `paused_quota` at 06:44:50Z on a worker whose window had already reset.
 */
describe('a task parked for a quota window', () => {
  const park = (notBefore: number | null) => {
    const workerId = seedWorker()
    const task = tasks.createTask({ title: 'parked for quota', createdBy: { kind: 'human' } })
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(notBefore, task.id)
    tasks.setStatus(task.id, 'paused_quota', { assignee: workerId })
    return task
  }

  it('⭐ comes back on its own once the reset has passed', () => {
    const task = park(Date.now() - 60_000)
    expect(tasks.resumeQuotaPaused()).toBe(1)

    const back = tasks.requireTask(task.id)
    expect(back.status).toBe('ready')
    // ⛔ `not_before` is cleared with it. Left behind, it would put the task straight back to
    //    `scheduled` on the next `admit()` for a deadline that has already gone by.
    expect(back.notBefore).toBeNull()
    expect(back.assignee).toBeNull()
    expect(tasks.messagesFor(task.id).some((m) => m.text.includes('has reset'))).toBe(true)
  })

  it('waits while the window is still shut', () => {
    const task = park(Date.now() + 60 * 60 * 1000)
    expect(tasks.resumeQuotaPaused()).toBe(0)
    expect(tasks.requireTask(task.id).status).toBe('paused_quota')
  })

  it('does not strand a quota pause that carries no reset time', () => {
    // ⚠️ It should not happen — `preempt` always sets one — and if it ever does, parked for ever is
    //    the worse of the two wrong answers. Matches `admitScheduled`'s own predicate.
    const task = park(null)
    expect(tasks.resumeQuotaPaused()).toBe(1)
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('leaves a pause a person chose alone', () => {
    // ⛔ `paused_user` has no clock on it and is not this function's business.
    const workerId = seedWorker()
    const task = tasks.createTask({ title: 'stopped by hand', createdBy: { kind: 'human' } })
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 60_000, task.id)
    tasks.setStatus(task.id, 'paused_user', { assignee: workerId })
    expect(tasks.resumeQuotaPaused()).toBe(0)
    expect(tasks.requireTask(task.id).status).toBe('paused_user')
  })

  it('can also be resumed by hand, which it could not be before', async () => {
    // ⛔ `paused_quota` is reached by the machine, so it had no Resume button and `resumeTask` turned
    //    it away — an operator who could see the window had reset had no way to say so.
    const cancel = await import('./cancel.js')
    const task = park(Date.now() + 60 * 60 * 1000)
    const resumed = cancel.resumeTask(task.id)
    expect(resumed.status).toBe('ready')
    expect(resumed.notBefore).toBeNull()
  })
})
