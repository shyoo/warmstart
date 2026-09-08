import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CreditStatus } from '@shared/protocol.js'

/**
 * t282: "spend usage credits past the plan limit" at the moment a run **starts**.
 *
 * ⭐ **The measurement, 2026-09-07.** A task was filed against an account whose 7d window read
 * **100%**. It was held, correctly — the switch was off. The operator then turned the switch on, and
 * nothing happened: not on the next tick, not after stopping and resuming the task by hand, and not
 * after overriding the quota gate on it. The task sat at `ready` behind the same sentence for as
 * long as anyone watched it.
 *
 * The reason is that the switch was wired into exactly three places, and all three are *mid-run*:
 * the compaction reserve, the window-boundary preempt and the overrun preempt. `chooseTarget`'s
 * dispatch gate had never heard of it, and neither had `quotaReleaseFor`, which is what lets a
 * `paused_quota` task back into the queue. So an account with permission to bill past its plan limit
 * was refused *new* work by the one rule that permission was bought to lift, and a task parked
 * before the switch was thrown went on waiting for a window reset it no longer needed.
 *
 * ⛔ **What this file pins is that the permission is not one signal.** Three things have to be true
 * before a full window is dispatched into: the operator's fleet switch, the vendor's word that
 * *this* account has credits enabled, and a monthly purse with something left in it. Each of the
 * three is tested from both sides, because getting any of them wrong spends real money or strands
 * real work.
 *
 * ⚠️ Every input here is a row. There is no CLI and no probe: `probeSpend`'s parsing is pinned in
 * `adapters/claude-credits.test.ts`, and the two halves as a *rule* are pinned in `credits.test.ts`.
 * What is under test here is scheduling.
 *
 * ⛔ The workers run on a declared adapter whose command is `node`, so `isInstalled()` is true on any
 * machine that can run this suite — a worker on `claude-code` would pass or fail the installed gate
 * for a reason that has nothing to do with the gate under test.
 */

const ADAPTER = 'test-creditsgate'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let scoring: typeof import('./scoring.js')
let settings: typeof import('./settings.js')
let spend: typeof import('./spend.js')
let api: typeof import('./api.js')

/** The window t282 met: a weekly gated at 97%, read at 100% — spent outright. */
const FULL_7D = 100
const RESET_IN_MS = 3 * 24 * 3600 * 1000

/** Credits on, with room left. The shape an account past its plan limit and still billing reports. */
const ON: CreditStatus = {
  enabled: true,
  userDisabled: false,
  disabledReason: null,
  canToggle: false,
  everEnabled: true,
  monthlyLimit: 40,
  used: 12.5,
  currency: 'USD',
  resetsAt: null
}

/** Credits off — the shape both live accounts reported on 2026-09-07, money fields and all null. */
const OFF: CreditStatus = {
  enabled: false,
  userDisabled: true,
  disabledReason: 'org_level_disabled',
  canToggle: false,
  everEnabled: true,
  monthlyLimit: null,
  used: null,
  currency: 'USD',
  resetsAt: null
}

/** Credits on, and the month's allowance already spent to the last cent. */
const SPENT: CreditStatus = { ...ON, used: 40 }

function seedWorker(label: string) {
  return workers.createWorker({ adapterId: ADAPTER, label, enabled: true })
}

function seed7d(workerId: string, percent: number, resetsIn = RESET_IN_MS): number {
  const resetsAt = Date.now() + resetsIn
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, 'weekly', 'Claude 7d', percent, resetsAt, 'config-cache', Date.now())
  return resetsAt
}

function seed5h(workerId: string, percent: number, resetsIn = 90 * 60 * 1000): number {
  const resetsAt = Date.now() + resetsIn
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, 'session', 'Claude 5h', percent, resetsAt, 'config-cache', Date.now())
  return resetsAt
}

/** A task pinned to one account: t282's shape, and the one that cannot route around a full window. */
function pinnedTask(workerId: string, title = 'the t282 shape') {
  return tasks.createTask({
    title,
    createdBy: { kind: 'human' },
    constraints: { workerId, adapterId: ADAPTER }
  })
}

/** What the scheduler said on this task's thread — the prompt the task was filed with is not that. */
function notes(taskId: string): string[] {
  return tasks
    .messagesFor(taskId)
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
}

/** The account the operator actually gave permission for: switch on, vendor agreeing. */
function creditsOn(workerId: string): void {
  workers.setWorkerCredits(workerId, ON)
  settings.setSetting('spendCreditsPastLimit', true)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-creditsgate-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Credits Gate CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_CREDITSGATE_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      capabilities: { transports: ['stream', 'pty'], manualCompact: true }
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  scoring = await import('./scoring.js')
  settings = await import('./settings.js')
  spend = await import('./spend.js')
  api = await import('./api.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'creditsgate.db'))
  adapters.loadAdapters()
})

beforeEach(() => {
  db.db().exec(
    'delete from runs; delete from sessions; delete from task_messages; delete from tasks;' +
      ' delete from quota_samples; delete from rate_limit_samples; delete from spend_samples;' +
      ' delete from workers; delete from settings;'
  )
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the dispatch gate on a window the vendor has already emptied', () => {
  it('holds the task while the switch is off, which is what t282 was filed into', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, ON)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('ClaudeSecond at 100% of its Claude 7d window')
    // ⛔ Nothing about credits on the row: the operator has not asked for them, so there is no
    // unmet condition to explain and a paragraph about money would be noise.
    expect(choice.reason).not.toContain('spend credits past the plan limit')
  })

  it('dispatches once the operator asks and the vendor agrees — the fix', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    creditsOn(worker.id)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker?.id).toBe(worker.id)
    // ⛔ And the hold clock goes with it. A task that is dispatching is not waiting for a reset, and
    // leaving one on the choice would tell the cache clock the queue cannot move.
    expect(choice.holdUntil ?? null).toBeNull()
  })

  it('takes a 5h window that is merely over its mark as well, not only a spent one', () => {
    const worker = seedWorker('ClaudeSecond')
    seed5h(worker.id, 96)
    creditsOn(worker.id)

    expect(scoring.chooseTarget(pinnedTask(worker.id)).worker?.id).toBe(worker.id)
  })

  it('does not lift a gate that rests on anything other than a percentage', () => {
    // ⚠️ The exact shape of the override's own limit: credits buy turns the vendor will sell, and a
    // disabled account is not selling anything. Money never talks an account gate down.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    creditsOn(worker.id)
    workers.updateWorker(worker.id, { enabled: false })

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('disabled')
  })

  it('is per account, never per fleet', () => {
    // ⛔ One switch, two accounts, one answer each. A fleet-wide reading of the operator's intent
    // would push work onto the account with nothing behind it — which is a hard vendor refusal, not
    // a reprieve.
    const billing = seedWorker('ClaudeSecond')
    const plain = seedWorker('ClaudeThird')
    seed7d(billing.id, FULL_7D)
    seed7d(plain.id, FULL_7D)
    workers.setWorkerCredits(billing.id, ON)
    workers.setWorkerCredits(plain.id, OFF)
    settings.setSetting('spendCreditsPastLimit', true)

    expect(scoring.chooseTarget(pinnedTask(billing.id)).worker?.id).toBe(billing.id)
    expect(scoring.chooseTarget(pinnedTask(plain.id)).worker).toBeNull()
  })

  it('does not make the billing account look cheap', () => {
    // ⚠️ The stand-down lifts the cliff and leaves `windowRisk` alone. An account with room left is
    // still the better answer — credits are a permission to spend, not a preference for spending.
    const billing = seedWorker('ClaudeSecond')
    const free = seedWorker('ClaudeThird')
    seed7d(billing.id, FULL_7D)
    seed7d(free.id, 5)
    creditsOn(billing.id)

    const task = tasks.createTask({
      title: 'unpinned',
      createdBy: { kind: 'human' },
      constraints: { adapterId: ADAPTER }
    })
    expect(scoring.chooseTarget(task).worker?.id).toBe(free.id)
  })
})

describe('the switch on its own, and what the row says when it changes nothing', () => {
  it('refuses on the fleet switch alone when the vendor says credits are off, and says why', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, OFF)
    settings.setSetting('spendCreditsPastLimit', true)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('100% of its Claude 7d window')
    expect(choice.reason).toContain('"spend credits past the plan limit" is on, but')
    expect(choice.reason).toContain('reports usage credits off (org_level_disabled)')
  })

  it('names the unread account rather than implying the switch is broken', () => {
    // ⭐ The state an operator most often throws the switch in: nothing has probed this account, so
    // `credits` is null and the switch cannot apply. "Not knowing is not permission" — but not
    // knowing is also not something the operator can see without being told.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    settings.setSetting('spendCreditsPastLimit', true)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain("nothing has read this account's credit status yet")
  })

  it('refuses on an emptied purse, and says how much was spent', () => {
    // ⛔ `enabled` says the vendor is willing to bill; it does not say there is anything left to
    // bill against. A run pushed into a full window on an empty purse loses the wrap-up *and* gets
    // refused, which is both failures at once.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, SPENT)
    settings.setSetting('spendCreditsPastLimit', true)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('has spent all 40 USD of its monthly credits')
  })

  it('still dispatches with one cent left, because a purse is empty or it is not', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, { ...ON, used: 39.99 })
    settings.setSetting('spendCreditsPastLimit', true)

    expect(scoring.chooseTarget(pinnedTask(worker.id)).worker?.id).toBe(worker.id)
  })

  it('says nothing about credits on a refusal the operator never asked them to lift', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, OFF)

    const choice = scoring.chooseTarget(pinnedTask(worker.id))
    expect(choice.reason).not.toContain('spend credits past the plan limit')
  })

  it('still carries the reset of the window that refused it, explanation and all', () => {
    // ⚠️ The sentence grew a clause; the clock beside it must not have moved. `holdUntil` is what
    // the cache clock prices the whole fleet's idleness from.
    const worker = seedWorker('ClaudeSecond')
    const resetsAt = seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, OFF)
    settings.setSetting('spendCreditsPastLimit', true)

    expect(scoring.chooseTarget(pinnedTask(worker.id)).holdUntil).toBe(resetsAt)
  })
})

describe('a hand-thrown override and a full window, which is where t282 went next', () => {
  it('still refuses an exhausted window on the override alone', () => {
    // ⛔ t276's rule, unchanged: at 100% there is no turn the vendor would have served, so an
    // override buys a process, a cold start and a `paused_quota` five seconds later.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = pinnedTask(worker.id)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('which no override can buy a turn on')
  })

  it('dispatches the same task once credits are on, because now there is a turn to buy', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = pinnedTask(worker.id)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)
    creditsOn(worker.id)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker.id)
  })

  it('writes the credits sentence into the thread, not the override one', () => {
    // ⛔ Exactly one of the two ever speaks, and it is the true one: the gate consults credits
    // first, so on a credit-enabled account the override is not what let this run start.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = pinnedTask(worker.id)
    tasks.setQuotaOverride(task.id, Date.now() + RESET_IN_MS)
    creditsOn(worker.id)

    const w = workers.requireWorker(worker.id)
    scheduler.noteCreditsDispatch(tasks.requireTask(task.id), w)
    scheduler.noteQuotaOverrideDispatch(tasks.requireTask(task.id), w)

    const said = notes(task.id)
    expect(said.some((t) => t.includes('billed against those credits'))).toBe(true)
    expect(said.some((t) => t.includes('overridden by'))).toBe(false)
  })

  it('says nothing at all when the account was never over its mark', () => {
    // ⚠️ A credit-enabled account dispatched at 5% was not held by anything, and announcing a
    // stand-down that changed no decision trains the reader to ignore the line that matters.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, 5)
    const task = pinnedTask(worker.id)
    creditsOn(worker.id)

    scheduler.noteCreditsDispatch(task, workers.requireWorker(worker.id))
    expect(notes(task.id)).toHaveLength(0)
  })

  it('names the window and the gate it stood down, so the board can be read back', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = pinnedTask(worker.id)
    creditsOn(worker.id)

    scheduler.noteCreditsDispatch(task, workers.requireWorker(worker.id))
    const said = notes(task.id)[0] ?? ''
    expect(said).toContain('at 100% of its Claude 7d window')
    expect(said).toContain('The 97% gate would normally hold this task')
    expect(said).toContain('Settings › Fleet')
  })
})

describe('a task already parked at paused_quota when the switch is thrown', () => {
  /** The t282 park: preempted or refused on a full window, waiting on a reset three days out. */
  function parked(workerId: string) {
    const task = pinnedTask(workerId)
    tasks.setStatus(task.id, 'paused_quota', { assignee: workerId })
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(Date.now() + RESET_IN_MS, task.id)
    return tasks.requireTask(task.id)
  }

  it('stays parked while the switch is off, because the window really has not come back', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, ON)

    expect(scheduler.quotaReleaseFor(parked(worker.id))).toBeNull()
  })

  it('comes back the moment credits apply, without waiting for a fresh reading', () => {
    // ⭐ The half of t282 that made the bug look like a scheduler that had forgotten the task. Every
    // other release test here asks "has the window come back", and for a parked task on a full
    // weekly the answer is no for three days. It is the wrong question for an account that has been
    // given permission to spend straight past the limit.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = parked(worker.id)
    creditsOn(worker.id)

    const why = scheduler.quotaReleaseFor(task)
    expect(why).toContain('reports usage credits enabled')
    expect(why).toContain('billed against those credits')
  })

  it('releases even where there is no quota reading at all', () => {
    // ⛔ Before any reading is consulted, deliberately: the permission does not rest on one. A park
    // on an account nobody has probed since is exactly the case that used to wait for ever.
    const worker = seedWorker('ClaudeSecond')
    const task = parked(worker.id)
    creditsOn(worker.id)

    expect(scheduler.quotaReleaseFor(task)).not.toBeNull()
  })

  it('does not release on the switch alone', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, OFF)
    const task = parked(worker.id)
    settings.setSetting('spendCreditsPastLimit', true)

    expect(scheduler.quotaReleaseFor(task)).toBeNull()
  })

  it('does not release onto an emptied purse', () => {
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    workers.setWorkerCredits(worker.id, SPENT)
    const task = parked(worker.id)
    settings.setSetting('spendCreditsPastLimit', true)

    expect(scheduler.quotaReleaseFor(task)).toBeNull()
  })

  it('puts the task back in the queue on the next tick, clock and all', () => {
    // ⛔ End to end through the transition `resumeQuotaPaused` owns: status back to `ready`,
    // `not_before` cleared so nothing re-parks it, and the reason in the thread.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = parked(worker.id)
    creditsOn(worker.id)

    expect(tasks.resumeQuotaPaused(scheduler.quotaReleaseFor)).toBe(1)
    const back = tasks.requireTask(task.id)
    expect(back.status).toBe('ready')
    expect(back.notBefore).toBeNull()
    expect(tasks.messagesFor(task.id).some((m) => m.text.includes('Back in the queue'))).toBe(true)
  })

  it('and that task is one the dispatch gate will actually take', () => {
    // ⚠️ The pair that has to hold together: releasing a task the gate then refuses costs a message
    // every tick and moves nothing. Both sides read the same two conditions.
    const worker = seedWorker('ClaudeSecond')
    seed7d(worker.id, FULL_7D)
    const task = parked(worker.id)
    creditsOn(worker.id)
    tasks.resumeQuotaPaused(scheduler.quotaReleaseFor)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker.id)
  })
})

describe('spendingCreditsOn, and the purse behind it', () => {
  it('reads an emptied purse as not spending, however willing the vendor is', () => {
    const worker = { credits: SPENT } as Parameters<typeof workers.spendingCreditsOn>[0]
    expect(workers.spendingCreditsOn(worker, true)).toBe(false)
  })

  it('leaves an unpublished ceiling alone, because an unknown is not an exhaustion', () => {
    expect(workers.creditsPurseEmpty({ ...ON, monthlyLimit: null, used: 99 })).toBe(false)
    expect(workers.creditsPurseEmpty({ ...ON, used: null })).toBe(false)
    expect(workers.creditsPurseEmpty({ ...ON, monthlyLimit: 0, used: 0 })).toBe(false)
    expect(workers.creditsPurseEmpty(null)).toBe(false)
  })

  it('counts spend at or past the ceiling, and nothing below it', () => {
    expect(workers.creditsPurseEmpty({ ...ON, used: 39.99 })).toBe(false)
    expect(workers.creditsPurseEmpty({ ...ON, used: 40 })).toBe(true)
    expect(workers.creditsPurseEmpty({ ...ON, used: 41 })).toBe(true)
  })
})

describe('throwing the switch asks the vendor again', () => {
  const handlers = () => api.buildApi({ version: '0.0.0', startedAt: Date.now(), port: 0 })

  /** An adapter that reports credits on, standing in for the config cache a real one reads. */
  const probe = (seen: string[]) => ({
    info: { capabilities: { spendProbe: 'config-cache' as const } },
    probeSpend: async () => {
      seen.push('asked')
      return { meters: [], sampledAt: Date.now(), source: 'config-cache' as const, credits: ON }
    }
  })

  it('writes the vendor’s word onto every live account', async () => {
    // ⭐ Without this an operator throws a switch that is inert *because nothing has looked*, and the
    // only thing on screen is the same refusal as before. The probe reads a config cache: no
    // terminal, no turn, no window spent.
    const first = seedWorker('ClaudeSecond')
    const second = seedWorker('ClaudeThird')
    const seen: string[] = []

    expect(await spend.refreshCreditStatus(probe(seen))).toBe(2)
    expect(seen).toHaveLength(2)
    expect(workers.getWorker(first.id)?.credits?.enabled).toBe(true)
    expect(workers.getWorker(second.id)?.credits?.enabled).toBe(true)
  })

  it('leaves a retired account out of it', async () => {
    const worker = seedWorker('ClaudeSecond')
    workers.retireWorker(worker.id)
    await expect(spend.refreshCreditStatus()).resolves.toBe(0)
  })

  it('is fired by the switch going on, and not by saving something else', async () => {
    const worker = seedWorker('ClaudeSecond')
    const handler = handlers()['settings.set']

    await handler({ spendCreditsPastLimit: true })
    expect(settings.settings().spendCreditsPastLimit).toBe(true)
    // ⚠️ The probe itself is fire-and-forget and this adapter has no meter to read, so what is
    // pinned here is the edge: the setting is what changed, and re-saving it must not re-probe.
    await handler({ spendCreditsPastLimit: true })
    await handler({ autoCompact: false })
    expect(settings.settings().spendCreditsPastLimit).toBe(true)
    expect(settings.settings().autoCompact).toBe(false)
    expect(workers.getWorker(worker.id)?.credits ?? null).toBeNull()
  })
})
