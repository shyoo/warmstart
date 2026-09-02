import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'

/**
 * A fleet with work arriving, windows filling, tasks parked on a clock, and nobody watching.
 *
 * ⛔ **The failure this file exists for** (2026-08-31): a task was parked `paused_quota`, its account
 * was probed by hand, the probe came back at **0% of the window** — and the task stayed parked.
 * Nothing was broken in the probe and nothing was broken in the resume; they simply never spoke. The
 * only question anything asked about a parked task was *is it time yet*, and `not_before` is a
 * **prediction** made at the moment of parking. On the overrun path it is not even a measurement: a
 * rate-limit warning that carries no reset time parks the task `now + 5h` by arithmetic, so an
 * account that came back in twenty minutes held its work for five hours.
 *
 * ⚠️ So a park now ends on **either** of two things — the clock it was given, or a reading that says
 * there is room — and the second is held to exactly the standard a dispatch is: fresh, not from a
 * window that has since rolled, and below the same gate. Anything looser would release a task the
 * next tick would immediately hold again, which is worse than staying parked because it costs a
 * message every ten seconds.
 *
 * ⛔ Every worker here is **disabled** wherever `tick()` is called. `tick()` dispatches, and a
 * dispatch in a unit test opens a real CLI against a real account.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')

const HOUR = 3600_000
const MIN = 60_000

let seq = 0

function seedWorker(label: string, adapterId = 'claude-code'): string {
  seq += 1
  return workers.createWorker({ adapterId, label: `${label}-${seq}`, enabled: false }).id
}

/**
 * ⛔ Enables **only** the workers named, and never the fleet. Every other worker in this database
 * was created without a quota reading, and an enabled worker with no reading sends `needsBaseline`
 * off to `refreshUsage`, which opens a real CLI.
 */
/**
 * The one Antigravity account this machine may hold.
 *
 * ⛔ `maxAccounts: 1` is a real product rule, not a test artefact: that CLI keeps its credential in
 * the OS keyring with no way to point it elsewhere, so a second worker would be two rows sharing one
 * window. Commissioning one per case throws, exactly as it should.
 */
let agyWorker: string | null = null
function theAntigravityAccount(model: string): string {
  if (!agyWorker) agyWorker = seedWorker('agy', 'antigravity-cli')
  workers.updateWorker(agyWorker, { defaultModel: model, defaultModels: null })
  return agyWorker
}

function enable(...workerIds: string[]): void {
  const stmt = db.db().prepare('update workers set enabled = 1 where id = ?')
  for (const id of workerIds) stmt.run(id)
}

/** A quota reading of a given age, straight into the store. `resetsAt` is relative to *now*. */
function reading(
  workerId: string,
  windows: Array<{ id: string; label?: string; percent: number; resetsIn?: number; group?: string }>,
  ageMs = 30_000
): void {
  const at = Date.now() - ageMs
  for (const w of windows) {
    db.db()
      .prepare(
        `insert or replace into quota_samples
           (worker_id, window_id, label, percent, resets_at, source, sampled_at, window_group)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(
        workerId,
        w.id,
        w.label ?? w.id,
        w.percent,
        w.resetsIn === undefined ? null : Date.now() + w.resetsIn,
        'config cache',
        at,
        w.group ?? null
      )
  }
}

/** A task parked on a window, exactly as `preempt` leaves one. */
function park(title: string, workerId: string, notBefore: number | null): Task {
  const task = tasks.createTask({ title, createdBy: { kind: 'human' } })
  db.db().prepare('update tasks set not_before = ? where id = ?').run(notBefore, task.id)
  tasks.setStatus(task.id, 'paused_quota', { assignee: workerId })
  return tasks.requireTask(task.id)
}

const statusOf = (task: Task): string | undefined => tasks.getTask(task.id)?.status

const resumeNotes = (task: Task): string[] =>
  tasks
    .messagesFor(task.id)
    .filter((m) => m.role === 'system' && /Back in the queue|has reset/.test(m.text))
    .map((m) => m.text)

let origClaudeInstalled: () => boolean
let origAgyInstalled: () => boolean

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotacycle-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  const { antigravityCli } = await import('./adapters/antigravity-cli.js')
  origClaudeInstalled = claudeCode.isInstalled
  origAgyInstalled = antigravityCli.isInstalled
  claudeCode.isInstalled = () => true
  antigravityCli.isInstalled = () => true
  db.openDb(join(dir, 'quotacycle.db'))
})

beforeEach(() => {
  db.db().exec(
    'delete from runs; delete from sessions; delete from task_messages; delete from tasks;' +
      ' delete from quota_samples; delete from rate_limit_samples; delete from settings;' +
      // ⛔ Belt and braces. One enabled worker left behind by an earlier case would turn the next
      // `tick()` into a real dispatch against a real CLI.
      ' update workers set enabled = 0'
  )
})

afterAll(async () => {
  if (origClaudeInstalled) {
    const { claudeCode } = await import('./adapters/claude-code.js')
    claudeCode.isInstalled = origClaudeInstalled
  }
  if (origAgyInstalled) {
    const { antigravityCli } = await import('./adapters/antigravity-cli.js')
    antigravityCli.isInstalled = origAgyInstalled
  }
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what the fleet tells the poller to look at', () => {
  it('names the accounts with a run in flight', () => {
    const worker = seedWorker('busy')
    const task = tasks.createTask({ title: 'running', createdBy: { kind: 'human' } })
    tasks.startRun({
      taskId: task.id,
      workerId: worker,
      sessionId: null,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker })

    expect(scheduler.probeDemand().activeWorkerIds).toEqual([worker])
  })

  it('forgets an account the moment its run ends', () => {
    // ⚠️ The active cadence is expensive — it refreshes rather than re-reads. An account whose run
    // finished is an idle account, and holding it at the busy rate is the fleet watching itself.
    const worker = seedWorker('was-busy')
    const task = tasks.createTask({ title: 'finished', createdBy: { kind: 'human' } })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker,
      sessionId: null,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker })
    tasks.finishRun(run.id, 'completed')
    tasks.setStatus(task.id, 'completed')

    expect(scheduler.probeDemand().activeWorkerIds).toEqual([])
  })

  it('names one account once however many runs it is carrying', () => {
    const worker = seedWorker('two-slots')
    for (const title of ['a', 'b']) {
      const task = tasks.createTask({ title, createdBy: { kind: 'human' } })
      tasks.startRun({
        taskId: task.id,
        workerId: worker,
        sessionId: null,
        projectId: null,
        quotaUnverified: true,
        costModelId: null
      })
      tasks.setStatus(task.id, 'running', { assignee: worker })
    }

    expect(scheduler.probeDemand().activeWorkerIds).toEqual([worker])
  })

  it('reports every account a task is parked on, across agents', () => {
    // ⭐ This is what makes an unattended resume timely. Without it the fleet looks at a parked
    // account whenever the interval next comes round — up to twenty minutes past its own reset.
    const claude = seedWorker('claude', 'claude-code')
    const codex = seedWorker('codex', 'openai-compatible')
    park('waiting on claude', claude, Date.now() + 30 * MIN)
    park('waiting on codex', codex, Date.now() + 10 * MIN)

    const releases = scheduler.probeDemand().releases
    expect(new Set(releases.map((r) => r.workerId))).toEqual(new Set([claude, codex]))
  })

  it('keeps only the soonest release for an account holding several parked tasks', () => {
    const worker = seedWorker('crowded')
    park('later', worker, Date.now() + 4 * HOUR)
    park('sooner', worker, Date.now() + 20 * MIN)
    park('later still', worker, Date.now() + 5 * HOUR)

    const releases = scheduler.probeDemand().releases
    expect(releases).toHaveLength(1)
    expect(releases[0]?.at).toBeLessThan(Date.now() + 21 * MIN)
  })

  it('ignores a park with no time on it, because there is no moment to wake for', () => {
    const worker = seedWorker('timeless')
    park('parked with no clock', worker, null)

    expect(scheduler.probeDemand().releases).toEqual([])
  })
})

describe('a park that ends on its own clock', () => {
  it('goes back in the queue once the reset time has passed', async () => {
    const worker = seedWorker('reset')
    const task = park('due back', worker, Date.now() - MIN)

    await scheduler.tick()

    expect(statusOf(task)).toBe('ready')
    expect(tasks.getTask(task.id)?.notBefore).toBeNull()
    expect(resumeNotes(task)[0]).toMatch(/has reset/)
  })

  it('loses its assignee, so nothing shows it pinned to the account that ran out', async () => {
    const worker = seedWorker('reset')
    const task = park('due back', worker, Date.now() - MIN)

    await scheduler.tick()

    expect(tasks.getTask(task.id)?.assignee).toBeNull()
  })

  it('stays parked while its clock says it should, with nothing measured either way', async () => {
    const worker = seedWorker('still-waiting')
    const task = park('not yet', worker, Date.now() + 2 * HOUR)

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
    expect(resumeNotes(task)).toHaveLength(0)
  })

  it('is resumed once and not once per tick', async () => {
    const worker = seedWorker('reset')
    const task = park('due back', worker, Date.now() - MIN)

    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()

    expect(resumeNotes(task)).toHaveLength(1)
  })
})

describe('a park that ends because the window actually came back', () => {
  it('resumes on a fresh reading below the gate, hours before its own timer', async () => {
    // ⛔ **The reported bug, exactly.** Parked five hours out by the overrun path's fallback, probed
    // by hand, 0% used — and it stayed parked, because nothing asked whether there was room.
    const worker = seedWorker('empty-again')
    const task = park('parked on a guess', worker, Date.now() + 5 * HOUR)
    reading(worker, [{ id: 'session', label: '5h', percent: 0, resetsIn: 5 * HOUR }])

    await scheduler.tick()

    expect(statusOf(task)).toBe('ready')
    expect(resumeNotes(task)[0]).toMatch(/ahead of its own timer/)
    expect(resumeNotes(task)[0]).toMatch(/0% of its 5h window/)
  })

  it('resumes when the window it was counting has rolled over', async () => {
    // ⚠️ An expired window is not a low percentage — it is a percentage about a window that no
    // longer exists. `windowExpired` is an explicit test precisely because `stale` is only an age.
    const worker = seedWorker('rolled-over')
    const task = park('parked across the boundary', worker, Date.now() + 3 * HOUR)
    reading(worker, [{ id: 'session', label: '5h', percent: 97, resetsIn: -MIN }])

    await scheduler.tick()

    expect(statusOf(task)).toBe('ready')
    expect(resumeNotes(task)[0]).toMatch(/rolled over/)
  })

  it('stays parked on a reading that is merely old', async () => {
    // ⛔ The whole safety of this path. A 20-minute-old 0% is a claim about the past, and releasing
    // on it would put work straight back onto an account that has since filled up.
    const worker = seedWorker('stale-good-news')
    const task = park('parked', worker, Date.now() + 3 * HOUR)
    reading(worker, [{ id: 'session', label: '5h', percent: 0, resetsIn: 4 * HOUR }], 20 * MIN)

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
  })

  it('stays parked when the account is still over the dispatch gate', async () => {
    // ⚠️ Released at 95% it would be held again by `chooseTarget` on the same tick, and re-parked,
    // and released again — a task oscillating between two states and a message every ten seconds.
    const worker = seedWorker('still-full')
    const task = park('parked', worker, Date.now() + 3 * HOUR)
    reading(worker, [{ id: 'session', label: '5h', percent: 95, resetsIn: 2 * HOUR }])

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
    expect(resumeNotes(task)).toHaveLength(0)
  })

  it('stays parked when the probe came back with nothing at all', async () => {
    const worker = seedWorker('unreadable')
    const task = park('parked', worker, Date.now() + 3 * HOUR)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(worker, '', '', 0, null, 'unknown', 'no cachedUsageUtilization', Date.now())

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
  })

  it('stays parked when nothing has ever read that account', async () => {
    const worker = seedWorker('never-read')
    const task = park('parked', worker, Date.now() + 3 * HOUR)

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
  })

  it('reads the pool the task would actually draw on, not the busiest one', async () => {
    // ⭐ Antigravity meters Gemini apart from Claude/GPT. Holding a Gemini task parked because the
    // Claude/GPT pool is spent is a wait with no cause — the pools do not share.
    const worker = theAntigravityAccount('gemini-3.1-pro-high')
    const task = park('a gemini task', worker, Date.now() + 4 * HOUR)
    reading(worker, [
      { id: '5h', label: 'Claude/GPT 5h', percent: 99, resetsIn: 2 * HOUR, group: 'claude-gpt' },
      { id: '5h:gemini', label: 'Gemini 5h', percent: 6, resetsIn: 2 * HOUR, group: 'gemini' }
    ])

    await scheduler.tick()

    expect(statusOf(task)).toBe('ready')
    expect(resumeNotes(task)[0]).toMatch(/Gemini 5h/)
  })

  it('keeps a task parked when it is that task’s own pool that is spent', async () => {
    const worker = theAntigravityAccount('gemini-3.1-pro-high')
    const task = park('a gemini task', worker, Date.now() + 4 * HOUR)
    reading(worker, [
      { id: '5h:claude-gpt', label: 'Claude/GPT 5h', percent: 4, resetsIn: 2 * HOUR, group: 'claude-gpt' },
      { id: '5h', label: 'Gemini 5h', percent: 99, resetsIn: 2 * HOUR, group: 'gemini' }
    ])

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
  })

  it('leaves a park with no account attached alone', async () => {
    // ⚠️ There is nothing to read. A task parked with no assignee and no run has no window to be
    // released against, and inventing one would resume work onto an account nobody chose.
    const task = tasks.createTask({ title: 'orphan park', createdBy: { kind: 'human' } })
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() + HOUR, task.id)
    tasks.setStatus(task.id, 'paused_quota', { assignee: null })

    await scheduler.tick()

    expect(statusOf(task)).toBe('paused_quota')
  })
})

describe('the whole fleet, one tick', () => {
  /**
   * Six tasks across three agents, in every state a quota window can put one in. The point is not
   * any single transition — each is checked above — but that they do not interfere: a released task
   * must not release its neighbour, and a running one must not be touched at all.
   */
  it('releases exactly the tasks whose windows are back, and nothing else', async () => {
    const claude = seedWorker('claude', 'claude-code')
    const agy = theAntigravityAccount('gemini-3.1-pro-high')
    const codex = seedWorker('codex', 'openai-compatible')

    // 1. Claude: parked, its reset time has passed.
    const dueByClock = park('claude, due by the clock', claude, Date.now() - MIN)
    // 2. Claude: parked hours out, but the account has been read and is empty.
    const dueByReading = park('claude, empty again', claude, Date.now() + 5 * HOUR)
    reading(claude, [{ id: 'session', label: '5h', percent: 3, resetsIn: 4 * HOUR }])
    // 3. Antigravity: parked, and its own pool is still spent.
    const stillFull = park('agy, still spent', agy, Date.now() + 3 * HOUR)
    reading(agy, [{ id: '5h', label: 'Gemini 5h', percent: 98, resetsIn: 3 * HOUR, group: 'gemini' }])
    // 4. Codex: parked, nothing has ever read that account.
    const unknown = park('codex, never read', codex, Date.now() + 2 * HOUR)
    // 5. A task already queued, which the resume path must not touch.
    const queued = tasks.createTask({ title: 'plain ready task', createdBy: { kind: 'human' } })
    // 6. A run in flight, which is neither parked nor released.
    const runningTask = tasks.createTask({ title: 'in flight', createdBy: { kind: 'human' } })
    tasks.startRun({
      taskId: runningTask.id,
      workerId: claude,
      sessionId: null,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(runningTask.id, 'running', { assignee: claude })

    await scheduler.tick()

    expect(statusOf(dueByClock)).toBe('ready')
    expect(statusOf(dueByReading)).toBe('ready')
    expect(statusOf(stillFull)).toBe('paused_quota')
    expect(statusOf(unknown)).toBe('paused_quota')
    expect(statusOf(queued)).toBe('ready')
    expect(statusOf(runningTask)).toBe('running')

    // ⚠️ And the two released ones say *why* differently, because the operator's next question
    // differs: one waited out its window, the other was let back early on a measurement.
    expect(resumeNotes(dueByClock)[0]).toMatch(/has reset/)
    expect(resumeNotes(dueByReading)[0]).toMatch(/ahead of its own timer/)
  })

  it('reports the fleet’s probe demand for exactly the accounts still waiting', async () => {
    const claude = seedWorker('claude', 'claude-code')
    const codex = seedWorker('codex', 'openai-compatible')
    park('claude, due by the clock', claude, Date.now() - MIN)
    park('codex, hours out', codex, Date.now() + 2 * HOUR)

    await scheduler.tick()

    // ⭐ The released one is gone from the demand — there is nothing left to wake up for — and the
    // one still parked is what the poller now paces itself against.
    const releases = scheduler.probeDemand().releases
    expect(releases.map((r) => r.workerId)).toEqual([codex])
  })

  it('holds a released task rather than losing it when no worker can take it', async () => {
    // ⛔ Release is back to `ready`, never to a worker. Every account here is disabled, so the task
    // must sit in the queue with a reason on it — not fail, and not go back to `paused_quota`.
    const worker = seedWorker('reset')
    const task = park('due back', worker, Date.now() - MIN)

    await scheduler.tick()

    expect(statusOf(task)).toBe('ready')
    expect(tasks.getTask(task.id)?.holdReason).toBeTruthy()
  })
})

/**
 * The gate itself, asked directly.
 *
 * ⛔ These are the only cases here with **enabled** workers, and not one of them calls `tick()`.
 * `chooseTarget` is pure arithmetic over the store; `tick()` is what turns an answer into a process.
 */
describe('which account a task may be given while windows are filling', () => {
  it('refuses every worker over the high-water mark, and names each window', () => {
    const a = seedWorker('full-a')
    const b = seedWorker('full-b')
    enable(a, b)
    reading(a, [{ id: 'session', label: '5h', percent: 93, resetsIn: 2 * HOUR }])
    reading(b, [{ id: 'session', label: '5h', percent: 99, resetsIn: 2 * HOUR }])
    const task = tasks.createTask({ title: 'needs an account', createdBy: { kind: 'human' } })

    const choice = scheduler.chooseTarget(tasks.requireTask(task.id))

    expect(choice.worker).toBeNull()
    expect(choice.reason).toMatch(/93%/)
    expect(choice.reason).toMatch(/99%/)
  })

  it('takes the one account with room while the rest are spent', () => {
    const full = seedWorker('full')
    const free = seedWorker('free')
    enable(full, free)
    reading(full, [{ id: 'session', label: '5h', percent: 96, resetsIn: 2 * HOUR }])
    reading(free, [{ id: 'session', label: '5h', percent: 12, resetsIn: 2 * HOUR }])
    const task = tasks.createTask({ title: 'needs an account', createdBy: { kind: 'human' } })

    expect(scheduler.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(free)
  })

  it('takes the same account again once a fresh reading says it has room', () => {
    // ⭐ The loop closed: the probe that unblocks a parked task is the same reading that makes the
    // gate say yes. A fleet where those two disagree is the state the operator saw on t70.
    const worker = seedWorker('recovering')
    enable(worker)
    reading(worker, [{ id: 'session', label: '5h', percent: 97, resetsIn: 2 * HOUR }])
    const task = tasks.createTask({ title: 'needs an account', createdBy: { kind: 'human' } })
    expect(scheduler.chooseTarget(tasks.requireTask(task.id)).worker).toBeNull()

    reading(worker, [{ id: 'session', label: '5h', percent: 4, resetsIn: 5 * HOUR }], 1000)

    expect(scheduler.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker)
  })

  it('does not gate on a window that expired while nobody was looking', () => {
    // ⛔ Measured on t60: a reading taken two minutes before a reset stayed "fresh" for hours and
    // gated the account at 88% of a window that had already emptied. Expired is *unknown*, never
    // zero — so the task goes out marked rather than held on a number that is no longer about
    // anything.
    const worker = seedWorker('expired')
    enable(worker)
    reading(worker, [{ id: 'session', label: '5h', percent: 96, resetsIn: -2 * MIN }])
    const task = tasks.createTask({ title: 'needs an account', createdBy: { kind: 'human' } })

    const choice = scheduler.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(worker)
    expect(choice.quotaUnverified).toBe(true)
  })
})
