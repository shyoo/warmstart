import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let quota: typeof import('./quota.js')

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

function seedRateLimit(
  workerId: string,
  windowId: string,
  status: string,
  resetsAt: number | null,
  sampledAt = Date.now()
): void {
  db.db()
    .prepare(
      `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
       values (?,?,?,?,?,?)`
    )
    .run(workerId, null, windowId, status, resetsAt, sampledAt)
}

function seedQuotaPercent(workerId: string, percent: number, resetsAt = Date.now() + 3_600_000): void {
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, '5h', '5-hour', percent, resetsAt, 'probe', Date.now())
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
  quota = await import('./quota.js')
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
  function seedClosingWindow(workerId: string, resetInMs = 10 * 60_000): void {
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(workerId, null, '5h', 'allowed', Date.now() + resetInMs, Date.now())
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
    const warning = tasks.requireTask(task.id).quotaPreemptWarning
    expect(warning?.trigger).toBe('window')
    expect(warning?.preemptAt).toBe(Date.now() + scheduler.QUOTA_PREEMPT_WARNING_MS)
    expect(wrapUpsOn(task.id)).toBe(0)

    await vi.advanceTimersByTimeAsync(scheduler.QUOTA_PREEMPT_WARNING_MS - 1)
    await scheduler.tick()
    expect(wrapUpsOn(task.id)).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    // ⚠️ `paused_quota`, not `awaiting_human`: a window boundary has a reset time, so the task
    // carries it and resumes itself. Nobody has to come back and press anything.
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
    expect(tasks.getTask(task.id)?.notBefore).not.toBeNull()
  })

  it('lets a person override during the warning without losing the running session', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    seedClosingWindow(workerId)

    await scheduler.tick()
    const warning = tasks.requireTask(task.id).quotaPreemptWarning
    expect(warning).not.toBeNull()

    tasks.setQuotaOverride(task.id, warning!.resumeAt)
    expect(tasks.requireTask(task.id).quotaPreemptWarning).toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    await scheduler.tick()

    expect(wrapUpsOn(task.id)).toBe(0)
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('running')
  })

  it('does not delay a vendor refusal behind an earlier override prompt', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    seedClosingWindow(workerId)
    await scheduler.tick()
    expect(tasks.requireTask(task.id).quotaPreemptWarning).not.toBeNull()

    seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() + 3_600_000)
    await scheduler.tick()
    expect(tasks.requireTask(task.id).quotaPreemptWarning).toBeNull()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    expect(tasks.requireTask(task.id).status).toBe('paused_quota')
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

  it('preempts a run when the vendor refuses the turn', async () => {
    expect(settings.DEFAULT_SETTINGS.autoOverrunPreempt).toBe(true)
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() + 3_600_000)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
  })

  it('attaches the final quota reading to a run stopped by preemption', async () => {
    // ⛔ An urgent probe only updates quota_samples. Run #1 needs its own closing snapshot or its
    // before/after delta remains unmeasured forever — the hole observed on t170.
    const isolationRoot = join(dir, `quota-worker-${seq + 1}`)
    const workerId = workers.createWorker({
      adapterId: 'claude-code',
      label: `quota-w${seq + 1}`,
      isolationRoot,
      enabled: false
    }).id
    writeFileSync(
      join(isolationRoot, '.claude.json'),
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: Date.now(),
          utilization: {
            limits: [
              {
                kind: 'session',
                percent: 97,
                resets_at: new Date(Date.now() + 3_600_000).toISOString()
              }
            ]
          }
        }
      })
    )
    const sessionId = seedSession(workerId)
    const task = tasks.createTask({ title: 'a metered run to preempt', createdBy: { kind: 'human' } })
    const run = tasks.startRun({
      taskId: task.id,
      workerId,
      sessionId,
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    tasks.creditTurn(sessionId, { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 })
    tasks.setStatus(task.id, 'running', { assignee: workerId })
    seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() + 3_600_000)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    const stopped = tasks.requireRun(run.id)
    expect(stopped.outcome).toBe('preempted')
    expect(stopped.quotaAfter?.windows).toEqual([
      expect.objectContaining({ id: 'session', percent: 97 })
    ])
  })

  it('leaves a run alone on a bare warning, because the vendor served that turn', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(wrapUpsOn(task.id)).toBe(0)
    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
  })

  it('leaves a run with a vendor refusal alone when autoOverrunPreempt is off', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() + 3_600_000)
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
    expect(tasks.requireTask(task.id).quotaPreemptWarning?.trigger).toBe('overrun')
    await vi.advanceTimersByTimeAsync(scheduler.QUOTA_PREEMPT_WARNING_MS)
    await scheduler.tick()
    await vi.advanceTimersByTimeAsync(130_000)

    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
    expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
  })

  /**
   * ⛔ **The minute is a deadline, not a countdown that re-arms.** The watchdog re-evaluates the
   * same trigger every ten seconds, and the reading behind it moves; if a fresher percentage wrote a
   * fresh `preemptAt`, an account climbing one point at a time would postpone its own preemption
   * indefinitely and the grace period would become a way of never acting at all.
   */
  it('sharpens its reason on a newer reading without buying another minute', async () => {
    const { task, run } = seedRunawayTask(0)
    const workerId = tasks.requireRun(run.id).workerId
    const seedPercent = (percent: number): void => {
      db.db()
        .prepare(
          `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
           values (?,?,?,?,?,?,?)`
        )
        .run(workerId, '5h', '5-hour', percent, Date.now() + 3_600_000, 'probe', Date.now())
    }

    seedPercent(96)
    await scheduler.tick()
    const first = tasks.requireTask(task.id).quotaPreemptWarning
    expect(first?.reason).toContain('96%')
    const posted = tasks.messagesFor(task.id).filter((m) => m.text.includes('Quota preemption warning')).length
    expect(posted).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    seedPercent(98)
    await scheduler.tick()

    const second = tasks.requireTask(task.id).quotaPreemptWarning
    expect(second?.preemptAt).toBe(first?.preemptAt)
    expect(second?.reason).toContain('98%')
    expect(wrapUpsOn(task.id)).toBe(0)
    expect(
      tasks.messagesFor(task.id).filter((m) => m.text.includes('Quota preemption warning')).length
    ).toBe(posted)
  })

  /**
   * ⛔ **Measured, not imagined.** t71 ran on ClaudeThird on 2026-08-31 and was preempted three
   * times in six hours - 18:10Z, 22:01Z, 23:23Z - each time within seconds of being dispatched,
   * each time for `rate-limit allowed_warning`, and each time throwing away a resumed 278k-token
   * session. The daemon's own probes minutes either side read `Claude 5h 17%`, `Claude 5h 0%` and
   * `Claude 5h 19%` on the very window it was being preempted over. The last one parked the task at
   * `not_before` **2026-09-07T01:00Z**, a full week, because the sample that produced the verdict
   * was a `seven_day` one and nothing checked.
   */
  describe('the t71 preemptions, which should not have happened', () => {
    it('ignores a seven_day advisory that lands on top of a healthy five_hour reading', async () => {
      const { task, run } = seedRunawayTask(0)
      const workerId = tasks.requireRun(run.id).workerId
      // The exact sequence from the log: `five_hour` says allowed, then twelve seconds later a
      // weekly advisory arrives and becomes "the" status.
      seedRateLimit(workerId, 'five_hour', 'allowed', Date.now() + 3_600_000, Date.now() - 12_000)
      seedRateLimit(workerId, 'seven_day', 'allowed_warning', Date.parse('2026-09-07T01:00:00Z'))
      seedQuotaPercent(workerId, 0)

      await scheduler.tick()
      await vi.advanceTimersByTimeAsync(130_000)

      expect(tasks.getTask(task.id)?.status).toBe('running')
      expect(tasks.requireRun(run.id).endedAt).toBeNull()
    })

    it('never parks a task against a window that is not the one it draws from', () => {
      const workerId = seedWorker()
      seedRateLimit(workerId, 'seven_day', 'allowed_warning', Date.parse('2026-09-07T01:00:00Z'))
      seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() + 90 * 60 * 1000)

      const verdict = scheduler.overrunVerdict(workerId, 0)

      expect(verdict).not.toBeNull()
      // ⛔ 90 minutes, not six days. A five-hour concern may not write a seven-day `not_before`.
      expect(verdict!.resumeAt).toBeLessThan(Date.now() + 3 * 60 * 60 * 1000)
    })

    it('does not preempt at 17% just because the vendor is cautious about that window', () => {
      const workerId = seedWorker()
      seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

      expect(scheduler.overrunVerdict(workerId, 17)).toBeNull()
    })

    it('does preempt when a warning and our own reading agree about the same window', () => {
      const workerId = seedWorker()
      seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

      expect(scheduler.overrunVerdict(workerId, 17)).toBeNull()
      expect(scheduler.overrunVerdict(workerId, scheduler.QUOTA_WARNED_PREEMPT_WATER)).not.toBeNull()
    })

    it('still preempts on a reading alone, with no vendor signal at all', () => {
      const workerId = seedWorker()

      expect(scheduler.overrunVerdict(workerId, 90)).toBeNull()
      expect(scheduler.overrunVerdict(workerId, scheduler.QUOTA_MIDRUN_PREEMPT_WATER)).not.toBeNull()
    })

    it('treats an unknown reading as unknown, so a warning cannot borrow evidence it lacks', () => {
      const workerId = seedWorker()
      seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

      expect(scheduler.overrunVerdict(workerId, null)).toBeNull()
    })

    it('forgets a warning whose window has already turned over', () => {
      const workerId = seedWorker()
      // A refusal, but for a window that reset a minute ago: it describes something that no longer
      // exists. Left in place it was the account's status until the next turn produced a sample -
      // and on a worker nothing is running on, that is never.
      seedRateLimit(workerId, 'five_hour', 'rejected', Date.now() - 60_000)

      expect(scheduler.overrunVerdict(workerId, 0)).toBeNull()
    })

    it('forgets a status that is no longer recent, while keeping its reset time', () => {
      const workerId = seedWorker()
      const resetsAt = Date.now() + 3_600_000
      seedRateLimit(workerId, 'five_hour', 'rejected', resetsAt, Date.now() - 30 * 60 * 1000)

      expect(scheduler.overrunVerdict(workerId, 0)).toBeNull()
      expect(quota.windowResetsAt(workerId)?.at).toBe(resetsAt)
    })

    it('preempts when 5h warning arrives on an elevated baseline (t75: 76% used)', () => {
      const workerId = seedWorker()
      seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

      const verdict = scheduler.overrunVerdict(workerId, 76)
      expect(verdict).not.toBeNull()
      expect(verdict?.reason).toContain('76% of 5h window used')
    })

    it('preempts a live run via run.quotaBefore even after lastQuota aged past STALE_AFTER_MS (>15m)', async () => {
      const { task, run } = seedRunawayTask(0)
      const workerId = tasks.requireRun(run.id).workerId

      // Record quota before the run (76% as in t75)
      tasks.setRunQuota(run.id, 'before', {
        windows: [{ id: '5h', label: '5-hour', percent: 76 }],
        sampledAt: Date.now() - 20 * 60 * 1000,
        stale: false
      })

      // lastQuota in database is 20m old (>15m stale)
      db.db()
        .prepare(
          `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
           values (?,?,?,?,?,?,?)`
        )
        .run(workerId, '5h', '5-hour', 76, Date.now() + 3_600_000, 'probe', Date.now() - 20 * 60 * 1000)

      seedRateLimit(workerId, 'five_hour', 'allowed_warning', Date.now() + 3_600_000)

      await scheduler.tick()
      expect(tasks.requireTask(task.id).quotaPreemptWarning?.trigger).toBe('overrun')
      await vi.advanceTimersByTimeAsync(scheduler.QUOTA_PREEMPT_WARNING_MS)
      await scheduler.tick()
      await vi.advanceTimersByTimeAsync(130_000)

      expect(tasks.requireRun(run.id).outcome).toBe('preempted')
      expect(tasks.getTask(task.id)?.status).toBe('paused_quota')
    })
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
