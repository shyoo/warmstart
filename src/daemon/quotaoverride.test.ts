import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinnedTask } from './testkit.js'
import { messageBody } from './threadline.js'

/**
 * t71, and the two things that were wrong with the way it waited.
 *
 * ⭐ **The measurement.** 2026-09-01T00:31:06Z, t71 was pinned to ClaudeThird — `constraints.workerId`,
 * a pin somebody set by hand, not a routing decision — and the dispatch gate read that account's
 * five-hour window at exactly **92%**, the water mark. The task was held with *"ClaudeThird at 92%
 * of its Claude 5h window"* against a `resets_at` **2h29m** away. Two separate faults followed from
 * one discarded number:
 *
 *  1. **Nothing could be done about it.** The water mark is arithmetic of ours over a reading; the
 *     vendor had served every turn up to it. A person who can see that 8% of a window is more than
 *     one commit needs had no way to say so, and a *pinned* task cannot route around it by
 *     definition. So it waited two and a half hours for a gate nobody agreed with.
 *  2. **The whole fleet was priced as busy.** The reset time was formatted into a sentence and
 *     thrown away, so `expectedIdleMs` still saw `status = 'ready'` and answered *"work queued
 *     now"* — the one answer that suppresses moves 2, 3 and 4 of the cache clock for **every live
 *     session**, for the entire window. A queue that provably cannot move for 2h29m was the input
 *     arguing that no session had time to compact.
 *
 * ⚠️ These run against a temp database and no CLI: every input here is a row.
 *
 * ⛔ **The workers here run on a declared adapter whose command is `node`**, so `isInstalled()` is
 * true on any machine that can run this suite. A worker on `claude-code` would pass or fail the
 * installed gate for a reason that has nothing to do with the gate under test — and would answer
 * differently on CI, which carries none of the agent CLIs, than on the laptop.
 */

const ADAPTER = 'test-quota'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let scoring: typeof import('./scoring.js')
let clock: typeof import('./cacheclock.js')
let api: typeof import('./api.js')
let quota: typeof import('./quota.js')
let settings: typeof import('./settings.js')

/** The window t71 actually met: 92% used, resetting 2h29m later. */
const HELD_PERCENT = 92
const RESET_IN_MS = 149 * 60 * 1000

function seedWorker(label: string) {
  return workers.createWorker({ adapterId: ADAPTER, label, enabled: true })
}

function seedQuota(workerId: string, percent: number, resetsIn = RESET_IN_MS): number {
  const resetsAt = Date.now() + resetsIn
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, 'session', 'Claude 5h', percent, resetsAt, 'config-cache', Date.now())
  return resetsAt
}

function seed7dQuota(workerId: string, percent: number, resetsIn = 7 * 24 * 3600 * 1000): number {
  const resetsAt = Date.now() + resetsIn
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, 'weekly', 'Claude 7d', percent, resetsAt, 'config-cache', Date.now())
  return resetsAt
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotaoverride-'))
  process.env.WARMSTART_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Quota CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_QUOTA_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      // ⚠️ `manualCompact` declared, because move 4 is the decision under test: an adapter that
      // cannot be told to compact falls through it for a reason unrelated to the idle estimate.
      capabilities: { transports: ['stream', 'pty'], manualCompact: true }
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  scoring = await import('./scoring.js')
  clock = await import('./cacheclock.js')
  api = await import('./api.js')
  quota = await import('./quota.js')
  settings = await import('./settings.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'quotaoverride.db'))
  adapters.loadAdapters()
})

beforeEach(() => {
  db.db().exec(
    'delete from runs; delete from sessions; delete from task_messages; delete from tasks;' +
      ' delete from quota_samples; delete from rate_limit_samples; delete from workers;'
  )
  quota.forgetRefreshAttempts()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('a task held at the water mark says when it could next move', () => {
  it('holds a pinned task at exactly 92%, which is the boundary t71 met', () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)

    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    // The sentence names the window, because on a two-pool account "its 5h window" is unverifiable.
    expect(choice.reason).toContain('ClaudeThird at 92% of its Claude 5h window')
  })

  it('carries the reset of the window that refused it, rather than discarding it', () => {
    const worker = seedWorker('ClaudeThird')
    const resetsAt = seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)

    const choice = scoring.chooseTarget(task)
    // ⛔ The very sample that refused the dispatch, not a second lookup that could name another one.
    expect(choice.holdUntil).toBe(resetsAt)
  })

  it('writes that clock onto the task, where a person and the cache clock can both read it', async () => {
    const worker = seedWorker('ClaudeThird')
    const resetsAt = seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)

    await scheduler.tick()

    const held = tasks.requireTask(task.id)
    expect(held.status).toBe('ready')
    expect(held.holdReason).toContain('92% of its Claude 5h window')
    expect(held.holdUntil).toBe(resetsAt)
  })

  it('leaves holdUntil null for a hold that ends when something happens rather than at a time', async () => {
    // ⚠️ Nothing installed and nothing enabled: the account gates refuse, and none of them can name
    // a moment they stop being true. Inventing a countdown for one would be worse than silence.
    const worker = seedWorker('ClaudeThird')
    workers.updateWorker(worker.id, { enabled: false })
    const task = pinnedTask(worker.id, ADAPTER)

    await scheduler.tick()

    const held = tasks.requireTask(task.id)
    expect(held.holdReason).toContain('disabled')
    expect(held.holdUntil).toBeNull()
  })

  it('takes the earliest reset when more than one account is over the mark', () => {
    const first = seedWorker('ClaudeSecond')
    const second = seedWorker('ClaudeThird')
    const soon = seedQuota(first.id, 95, 20 * 60 * 1000)
    seedQuota(second.id, HELD_PERCENT, RESET_IN_MS)
    const task = tasks.createTask({ title: 'unpinned', createdBy: { kind: 'human' } })

    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    // The task needs any one of them, so the first window back is the first moment it could move.
    expect(choice.holdUntil).toBe(soon)
  })
})

describe('a person may overrule the water mark, and only the water mark', () => {
  it('dispatches to the pinned account at 92% once the override is live', () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(worker.id)
  })

  it('stops applying the moment it expires, without anybody withdrawing it', () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    // ⛔ A deadline in the past is not an override. The permission expires with its own reason.
    tasks.setQuotaOverride(task.id, Date.now() - 1000)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('92% of its Claude 5h window')
  })

  it('does not make the overridden account look cheap', () => {
    // ⚠️ The override lifts the cliff and leaves `windowRisk` alone, which saturates at exactly this
    // percentage. A fleet with a free account elsewhere must still prefer the free one.
    const full = seedWorker('ClaudeThird')
    const free = seedWorker('ClaudeSecond')
    seedQuota(full.id, HELD_PERCENT)
    seedQuota(free.id, 5)
    const task = tasks.createTask({ title: 'unpinned', createdBy: { kind: 'human' } })
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(free.id)
  })

  it('does not lift a gate that rests on anything other than a percentage', () => {
    const worker = seedWorker('ClaudeThird')
    workers.updateWorker(worker.id, { enabled: false })
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('disabled')
  })

  it('exempts the run it enabled from being preempted over that same percentage', () => {
    const worker = seedWorker('ClaudeThird')
    // ⛔ Past the mid-run water mark, which would ordinarily wrap the run up immediately. Dispatching
    // under an override and preempting three points later buys a cold start and nothing else.
    expect(scheduler.overrunVerdict(worker.id, 96)).not.toBeNull()
    expect(scheduler.overrunVerdict(worker.id, 96, { quotaOverride: true })).toBeNull()
  })

  it('never talks a vendor refusal down, whatever a person said', () => {
    const worker = seedWorker('ClaudeThird')
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(worker.id, null, 'session', 'rejected', Date.now() + RESET_IN_MS, Date.now())

    // The turn did not happen. There is no setting that makes a refused turn into a served one.
    const verdict = scheduler.overrunVerdict(worker.id, 40, { quotaOverride: true })
    expect(verdict?.reason).toContain('vendor refused the turn')
  })
})

describe('task.overrideQuota', () => {
  const handlers = () => api.buildApi({ version: '0.0.0', startedAt: Date.now(), port: 0 })

  it('dates the permission from the window the scheduler measured, not from a clock in the caller', async () => {
    const worker = seedWorker('ClaudeThird')
    const resetsAt = seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    await scheduler.tick()

    const result = await handlers()['task.overrideQuota']({ id: task.id })
    expect(result.until).toBe(resetsAt)
    expect(result.applies).toBe(true)
    expect(result.task.quotaOverrideUntil).toBe(resetsAt)
  })

  it('answers a live preemption warning and keeps its measured window boundary', async () => {
    const worker = seedWorker('ClaudeThird')
    const task = pinnedTask(worker.id, ADAPTER)
    const resumeAt = Date.now() + RESET_IN_MS
    tasks.setQuotaPreemptWarning(task.id, {
      trigger: 'window',
      reason: 'Claude 5h resets soon',
      preemptAt: Date.now() + 60_000,
      resumeAt
    })

    const result = await handlers()['task.overrideQuota']({ id: task.id })
    expect(result.applies).toBe(true)
    expect(result.until).toBe(resumeAt)
    expect(result.task.quotaOverrideUntil).toBe(resumeAt)
    expect(result.task.quotaPreemptWarning).toBeNull()
  })

  it('changes a live compact-capable warning to handoff without overriding quota', async () => {
    const worker = seedWorker('ClaudeThird')
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    tasks.setQuotaPreemptWarning(task.id, {
      trigger: 'window',
      reason: 'Claude 5h resets soon',
      preemptAt: Date.now() + 60_000,
      resumeAt: Date.now() + RESET_IN_MS,
      action: 'compact',
      canCompact: true
    })

    const result = await handlers()['task.overrideQuota']({ id: task.id, preemptionAction: 'handoff' })
    expect(result.task.quotaPreemptWarning?.action).toBe('handoff')
    expect(result.task.quotaOverrideUntil).toBeNull()
  })

  it('says so plainly when the grant changes nothing right now', async () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, 5)
    const task = pinnedTask(worker.id, ADAPTER)

    const result = await handlers()['task.overrideQuota']({ id: task.id })
    expect(result.applies).toBe(false)
    expect(result.reason).toContain('nothing is holding this task on quota')
    // ⚠️ Recorded anyway: it is a standing instruction for the window, not a button that only works
    // while the task happens to be stuck.
    expect(result.task.quotaOverrideUntil).not.toBeNull()
  })

  it('overrides preemption and resumes a paused_quota task immediately to continue to completion', async () => {
    const worker = seedWorker('ClaudeThird')
    const resetsAt = seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setStatus(task.id, 'paused_quota', { assignee: worker.id })
    db.db().prepare('update tasks set not_before = ? where id = ?').run(resetsAt, task.id)

    const result = await handlers()['task.overrideQuota']({ id: task.id })
    expect(result.applies).toBe(true)
    expect(result.until).toBe(resetsAt)
    expect(result.task.status).toBe('ready')
    expect(result.task.notBefore).toBeNull()
    expect(result.task.quotaOverrideUntil).toBe(resetsAt)

    // The resumed task can now be chosen by the scheduler despite the 92% watermark
    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(worker.id)

    // And is exempt from mid-run preemption at 96%
    expect(
      scheduler.overrunVerdict(worker.id, 96, {
        quotaOverride: tasks.quotaOverridden(tasks.requireTask(task.id))
      })
    ).toBeNull()
  })

  it('withdraws on an explicit null, and the gate applies again', async () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    await handlers()['task.overrideQuota']({ id: task.id })
    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker.id)

    const withdrawn = await handlers()['task.overrideQuota']({ id: task.id, until: null })
    expect(withdrawn.task.quotaOverrideUntil).toBeNull()
    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker).toBeNull()
  })

  it('writes the decision into the thread, where the run it enables will be read', async () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, HELD_PERCENT)
    const task = pinnedTask(worker.id, ADAPTER)
    await scheduler.tick()
    await handlers()['task.overrideQuota']({ id: task.id })

    const notes = tasks.messagesFor(task.id).filter((m) => m.role === 'system')
    expect(notes.some((m) => messageBody(m).includes('overrode the 92% quota gate'))).toBe(true)
  })
})

describe('a queue that cannot move is not a queue about to move', () => {
  const NOW = 1_700_000_000_000

  const liveSession = () =>
    ({
      id: 's1',
      workerId: 'w1',
      adapterId: ADAPTER,
      transport: 'stream',
      projectId: null,
      cwd: '/tmp',
      model: null,
      effort: null,
      state: 'live',
      pid: null,
      purpose: 'work',
      transcriptPath: null,
      vendorSessionId: null,
      currentBranch: null,
      contextTokens: 180_000,
      contextWindow: null,
      lastRequestStartedAt: null,
      cacheExpiresAt: NOW + 10 * 60 * 1000,
      tokensSinceCompact: 90_000,
      clockMove: null,
      clockMoveAt: null,
      clockMoveAttempts: 0,
      clockMoveContext: null,
      startedAt: NOW - 60 * 60 * 1000,
      closedAt: null
    }) as Parameters<typeof clock.expectedIdleMs>[0]

  it('still reads a genuinely dispatchable task as work queued now', () => {
    tasks.createTask({ title: 'nothing is holding this', createdBy: { kind: 'human' } })
    const idle = clock.expectedIdleMs(liveSession(), NOW)
    expect(idle.ms).toBe(0)
    expect(idle.confident).toBe(true)
  })

  it('reads a task held behind a window as wanted when that window resets', () => {
    // ⛔ The t71 shape, at the level the cache clock sees it: status `ready`, and a clock saying it
    // cannot move for 2h29m. This used to answer 0ms and suppress every move on every session.
    const task = tasks.createTask({ title: 'held on quota', createdBy: { kind: 'human' } })
    tasks.setHoldReason(task.id, 'ClaudeThird at 92% of its Claude 5h window', NOW + RESET_IN_MS)

    const idle = clock.expectedIdleMs(liveSession(), NOW)
    expect(idle.ms).toBe(RESET_IN_MS)
    expect(idle.confident).toBe(true)
    expect(idle.because).toContain('149m')
  })

  it('counts a preempted task, which was invisible here entirely', () => {
    // A whole queue parked by a closing window used to read as "nothing queued" — the branch that
    // returns infinity and lets every warm prefix lapse.
    const task = tasks.createTask({ title: 'parked by preemption', createdBy: { kind: 'human' } })
    tasks.updateTask(task.id, { notBefore: NOW + RESET_IN_MS })
    tasks.setStatus(task.id, 'paused_quota', { assignee: null })

    const idle = clock.expectedIdleMs(liveSession(), NOW)
    expect(idle.ms).toBe(RESET_IN_MS)
    expect(idle.because).toContain('149m')
  })

  it('takes the earliest of several waits, not the first one it finds', () => {
    const far = tasks.createTask({ title: 'far', createdBy: { kind: 'human' } })
    tasks.setHoldReason(far.id, 'ClaudeThird at 92% of its Claude 5h window', NOW + RESET_IN_MS)
    const near = tasks.createTask({ title: 'near', createdBy: { kind: 'human' } })
    tasks.setHoldReason(near.id, 'ClaudeSecond at 94% of its Claude 5h window', NOW + 20 * 60 * 1000)

    expect(clock.expectedIdleMs(liveSession(), NOW).ms).toBe(20 * 60 * 1000)
  })

  it('ignores a hold with no clock behind it, which can end on the next tick', () => {
    const task = tasks.createTask({ title: 'at capacity', createdBy: { kind: 'human' } })
    tasks.setHoldReason(task.id, 'ClaudeThird at capacity')

    const idle = clock.expectedIdleMs(liveSession(), NOW)
    expect(idle.ms).toBe(0)
    expect(idle.because).toContain('ready now')
  })

  it('now reaches the compaction it was talked out of for two and a half hours', () => {
    // ⭐ The payoff, and the answer to "does /compact still happen while the task is queued?". With
    // the queue held for 2h29m — past the ~2h break-even — a 180k context is compacted rather than
    // kept warm for work that provably cannot arrive.
    const task = tasks.createTask({ title: 'held on quota', createdBy: { kind: 'human' } })
    tasks.setHoldReason(task.id, 'ClaudeThird at 92% of its Claude 5h window', NOW + RESET_IN_MS)

    const decision = clock.decide(liveSession(), {
      objective: { cost: 1, velocity: 0, quality: 0 },
      now: NOW,
      settings: settings.settings()
    })
    expect(decision.move).toBe('compact')
  })

  it('and still declines it while work really could arrive on the next tick', () => {
    // ⛔ The contrast that makes the test above mean something. Same session, same context, same
    // switches — one dispatchable task instead of a held one, and compacting is the wrong move
    // because the session is about to be wanted. The idle estimate is the only input that differs.
    tasks.createTask({ title: 'nothing is holding this', createdBy: { kind: 'human' } })

    const decision = clock.decide(liveSession(), {
      objective: { cost: 1, velocity: 0, quality: 0 },
      now: NOW,
      settings: settings.settings()
    })
    expect(decision.move).not.toBe('compact')
  })
})

describe('7-day windows have more runway and compact / hold around 97-98%', () => {
  it('does not hold a task at 93% on a 7d window, where 5h would be held', () => {
    const worker = seedWorker('ClaudeThird')
    seed7dQuota(worker.id, 93)
    const task = pinnedTask(worker.id, ADAPTER)

    const choice = scoring.chooseTarget(task)
    // ⚠️ At 93% on a 7d window, the account is NOT held.
    expect(choice.worker?.id).toBe(worker.id)
  })

  it('holds a pinned task when the 7d window reaches 97%', () => {
    const worker = seedWorker('ClaudeThird')
    const resetsAt = seed7dQuota(worker.id, 97)
    const task = pinnedTask(worker.id, ADAPTER)

    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('ClaudeThird at 97% of its Claude 7d window')
    expect(choice.holdUntil).toBe(resetsAt)
  })

  it('task.overrideQuota reports the 97% gate when overriding a weekly window', async () => {
    const worker = seedWorker('ClaudeThird')
    seed7dQuota(worker.id, 97)
    const task = pinnedTask(worker.id, ADAPTER)
    await scheduler.tick()

    const handlers = api.buildApi({ version: '0.0.0', startedAt: Date.now(), port: 0 })
    const result = await handlers['task.overrideQuota']({ id: task.id })
    expect(result.applies).toBe(true)

    const notes = tasks.messagesFor(task.id).filter((m) => m.role === 'system')
    expect(notes.some((m) => messageBody(m).includes('overrode the 97% quota gate'))).toBe(true)
  })
})

describe('cache clock respects quota overrides and active runs', () => {
  const OBJECTIVE = { cost: 1, velocity: 0, quality: 0 }

  it('Move 5 declines to compact or close when the task has an active quota override', () => {
    const worker = seedWorker('ClaudeThird')
    seedQuota(worker.id, 95) // reserve is at risk (> 92%)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)

    const s = {
      id: 'session-override-1',
      workerId: worker.id,
      adapterId: ADAPTER,
      transport: 'stream' as const,
      projectId: null,
      cwd: '/tmp',
      model: null,
      effort: null,
      state: 'live' as const,
      pid: null,
      purpose: 'work' as const,
      transcriptPath: null,
      vendorSessionId: null,
      currentBranch: null,
      contextTokens: 150_000,
      contextWindow: null,
      lastRequestStartedAt: null,
      cacheExpiresAt: Date.now() + 10 * 60 * 1000,
      tokensSinceCompact: 80_000,
      clockMove: null,
      clockMoveAt: null,
      clockMoveAttempts: 0,
      clockMoveContext: null,
      startedAt: Date.now() - 60 * 60 * 1000,
      closedAt: null
    }

    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose,
                               context_tokens, tokens_since_compact, cache_expires_at, started_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        s.id,
        s.workerId,
        s.adapterId,
        s.transport,
        s.projectId,
        s.cwd,
        s.state,
        s.purpose,
        s.contextTokens,
        s.tokensSinceCompact,
        s.cacheExpiresAt,
        s.startedAt
      )

    // Associate a run with this session for the task
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: s.id,
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })

    const decision = clock.decide(s, {
      objective: OBJECTIVE,
      now: Date.now(),
      settings: settings.settings()
    })

    // Move 5 must NOT compact or handoff_close; it must return none noting the override or active run
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('overridden by hand')

    tasks.finishRun(run.id, 'completed')
  })

  it('outcome === ignored does not issue handoff_close while a run is open', () => {
    const worker = seedWorker('ClaudeThird')
    const task = pinnedTask(worker.id, ADAPTER)

    const s = {
      id: 'session-open-run',
      workerId: worker.id,
      adapterId: ADAPTER,
      transport: 'stream' as const,
      projectId: null,
      cwd: '/tmp',
      model: null,
      effort: null,
      state: 'live' as const,
      pid: null,
      purpose: 'work' as const,
      transcriptPath: null,
      vendorSessionId: null,
      currentBranch: null,
      contextTokens: 150_000,
      contextWindow: null,
      lastRequestStartedAt: null,
      cacheExpiresAt: Date.now() + 10 * 60 * 1000,
      tokensSinceCompact: 80_000,
      clockMove: 'compact' as const,
      clockMoveAt: Date.now() - 300_000,
      clockMoveAttempts: 2,
      clockMoveContext: 80_000,
      startedAt: Date.now() - 60 * 60 * 1000,
      closedAt: null
    }

    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose,
                               context_tokens, tokens_since_compact, cache_expires_at, clock_move,
                               clock_move_at, clock_move_attempts, started_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        s.id,
        s.workerId,
        s.adapterId,
        s.transport,
        s.projectId,
        s.cwd,
        s.state,
        s.purpose,
        s.contextTokens,
        s.tokensSinceCompact,
        s.cacheExpiresAt,
        s.clockMove,
        s.clockMoveAt,
        s.clockMoveAttempts,
        s.startedAt
      )

    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: s.id,
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })

    const decision = clock.decide(s, {
      objective: OBJECTIVE,
      now: Date.now(),
      settings: settings.settings()
    })

    // Must NOT be handoff_close
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('a run is currently open')

    tasks.finishRun(run.id, 'completed')
  })
})
