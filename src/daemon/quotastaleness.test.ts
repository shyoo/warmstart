import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinnedTask } from './testkit.js'
import type { QuotaWindow } from '@shared/protocol.js'

/**
 * t276, and the fifteen minutes in which a spent account became routable again.
 *
 * ⭐ **The measurement.** 2026-09-07T20:28:21Z the dispatch gate held t276 with, among twelve other
 * refusals, *"CodexFirst (gpt-5.6-terra) at 100% of its GPT 7d window"* — correct, and read off a
 * sample taken at 20:18:42Z. At **20:33:59Z** the same task was dispatched to that same account,
 * *"on an unverified quota reading"*, scoring `quotaRisk 0.00 — no quota reading this fleet trusts`.
 * Nothing about the account had changed. The reading had crossed `STALE_AFTER_MS` — by seventeen
 * seconds — and the gate was written as `if (quota && !quota.stale)`, so an aged reading did not
 * make the gate cautious, it removed the gate. The run died `paused_quota` five seconds later,
 * having bought a spawned `codex exec`, a cold start and a preempted run.
 *
 * ⛔ **Spend inside a window only goes up.** A sample carries the `resetsAt` of the window instance
 * it measured, so while that reset is in the future the sample and the live window are the same
 * window — and no amount of age can lower the number. Staleness is a reason to distrust *headroom*
 * (`trustedWindows`, which feeds the `quotaRisk` preference) and never a reason to disbelieve
 * *exhaustion*. Those two now come apart, which is the whole of the fix.
 *
 * ⛔ **And 100% is not a water mark.** 92/97 are this fleet's own caution over turns the vendor was
 * still serving, which is why a person may overrule them. At `WINDOW_EXHAUSTED` there is no turn on
 * the other side to be bought, so the override stops there too.
 *
 * ⚠️ Every input here is a row: a temp database, a declared adapter whose command is `node`, no CLI
 * and no tokens.
 */

const ADAPTER = 'test-stale-quota'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let scoring: typeof import('./scoring.js')
let quota: typeof import('./quota.js')
let shared: typeof import('@shared/tasks.js')

/** Older than `STALE_AFTER_MS`, by about as little as t276 was. */
const STALE_MS = 15 * 60 * 1000 + 17_000
const FIVE_HOURS = 5 * 60 * 60 * 1000
const WEEK = 7 * 24 * 60 * 60 * 1000

interface SeedWindow {
  id: string
  label: string
  percent: number
  /** Relative to now; negative puts the reset in the past, which is a window that has turned over. */
  resetsIn: number | null
  group?: string
}

function seedWorker(label: string) {
  return workers.createWorker({ adapterId: ADAPTER, label, enabled: true })
}

/** One reading, however many windows, taken `ageMs` ago. Returns the reset times it wrote. */
function seedReading(workerId: string, windows: SeedWindow[], ageMs = 0): number[] {
  const sampledAt = Date.now() - ageMs
  const resets: number[] = []
  for (const w of windows) {
    const resetsAt = w.resetsIn === null ? null : Date.now() + w.resetsIn
    resets.push(resetsAt ?? 0)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at, window_group)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(workerId, w.id, w.label, w.percent, resetsAt, 'config-cache', sampledAt, w.group ?? null)
  }
  return resets
}

/** CodexFirst as it actually read at 20:18:42Z on 2026-09-07: nothing spent today, the week gone. */
function seedCodexFirst(workerId: string, ageMs: number): number {
  const [, weekly] = seedReading(
    workerId,
    [
      { id: '5h', label: 'GPT 5h', percent: 0, resetsIn: FIVE_HOURS },
      { id: '7d', label: 'GPT 7d', percent: 100, resetsIn: 31 * 60 * 60 * 1000 }
    ],
    ageMs
  )
  return weekly!
}

function looseTask(title = 'unpinned') {
  return tasks.createTask({ title, createdBy: { kind: 'human' }, constraints: { adapterId: ADAPTER } })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotastaleness-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Stale Quota CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_STALE_QUOTA_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      capabilities: { transports: ['stream', 'pty'] }
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  scoring = await import('./scoring.js')
  quota = await import('./quota.js')
  shared = await import('@shared/tasks.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'quotastaleness.db'))
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

describe('poolVerdict: what one pool’s windows say about starting work', () => {
  const win = (over: Partial<QuotaWindow> & { percent: number }): QuotaWindow => ({
    id: '5h',
    label: 'GPT 5h',
    resetsAt: Date.now() + FIVE_HOURS,
    ...over
  })

  it('refuses nothing when a pool has no windows at all', () => {
    const verdict = shared.poolVerdict([])
    expect(verdict.blocking).toBeNull()
    expect(verdict.active).toEqual([])
    expect(verdict.turnedOver).toBe(false)
  })

  it('gates a weekly at 97 and a five-hour at 92, not one number for both', () => {
    expect(shared.poolVerdict([win({ percent: 95 })]).blocking?.threshold).toBe(92)
    expect(
      shared.poolVerdict([win({ id: '7d', label: 'GPT 7d', percent: 95 })]).blocking
    ).toBeNull()
    expect(
      shared.poolVerdict([win({ id: '7d', label: 'GPT 7d', percent: 98 })]).blocking?.threshold
    ).toBe(97)
  })

  it('calls a window spent at 100 and only at 100', () => {
    expect(shared.poolVerdict([win({ percent: 99.9 })]).blocking?.exhausted).toBe(false)
    expect(shared.poolVerdict([win({ percent: 100 })]).blocking?.exhausted).toBe(true)
    expect(shared.WINDOW_EXHAUSTED).toBe(100)
  })

  it('drops a window that has already turned over, and says that it did', () => {
    // ⛔ Expired is *unknown*, never zero and never full: what the new window holds cannot be
    //    derived from the old one. A caller reading this as full would hold an empty account out.
    const verdict = shared.poolVerdict([win({ percent: 100, resetsAt: Date.now() - 1000 })])
    expect(verdict.blocking).toBeNull()
    expect(verdict.active).toEqual([])
    expect(verdict.turnedOver).toBe(true)
  })

  it('keeps a window with no reset time at all, which cannot be shown to have rolled', () => {
    const verdict = shared.poolVerdict([win({ percent: 100, resetsAt: null })])
    expect(verdict.turnedOver).toBe(false)
    expect(verdict.blocking?.exhausted).toBe(true)
  })

  it('names the window furthest past its own gate', () => {
    const verdict = shared.poolVerdict([
      win({ percent: 93 }),
      win({ id: '7d', label: 'GPT 7d', percent: 99 })
    ])
    // 93 is 1 past 92; 99 is 2 past 97.
    expect(verdict.blocking?.window.label).toBe('GPT 7d')
  })

  it('names a spent window over a merely-over one, however small its deficit', () => {
    // ⛔ The t276 pair, near enough: the weekly is 3 past its 97 and the five-hour would be 4 past
    //    its 92. Naming the five-hour would report a refusal a person can lift over one they cannot.
    const verdict = shared.poolVerdict([
      win({ percent: 96 }),
      win({ id: '7d', label: 'GPT 7d', percent: 100 })
    ])
    expect(verdict.blocking?.window.label).toBe('GPT 7d')
    expect(verdict.blocking?.exhausted).toBe(true)
  })
})

describe('t276: a reading too old to score is not too old to refuse', () => {
  it('holds the account whose weekly window read 100% fifteen minutes ago', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, STALE_MS)
    // The reading is past `STALE_AFTER_MS` — the precondition of the bug, asserted rather than
    // assumed, so a change to that constant retunes this test instead of quietly disarming it.
    expect(quota.lastQuota(worker.id)?.stale).toBe(true)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('CodexFirst at 100% of its GPT 7d window')
  })

  it('says the number is old and why it is still believed', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, STALE_MS)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.reason).toContain('read 15m ago')
    expect(choice.reason).toContain('cannot have refilled')
  })

  it('carries the reset of the stale window that refused it, so the task has a clock', () => {
    const worker = seedWorker('CodexFirst')
    const weeklyReset = seedCodexFirst(worker.id, STALE_MS)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.holdUntil).toBe(weeklyReset)
  })

  it('does not make the refusal standing — a window comes back without anybody being asked', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, STALE_MS)

    expect(scoring.chooseTarget(pinnedTask(worker.id, ADAPTER)).standing).toBe(false)
  })

  it('routes to an account with room instead, rather than holding the whole task', () => {
    const spent = seedWorker('CodexFirst')
    const free = seedWorker('CodexSecond')
    seedCodexFirst(spent.id, STALE_MS)
    seedReading(free.id, [{ id: '5h', label: 'GPT 5h', percent: 12, resetsIn: FIVE_HOURS }])

    expect(scoring.chooseTarget(looseTask()).worker?.id).toBe(free.id)
  })

  it('refuses it on the tick a person is watching, with the percentage on the row', async () => {
    const worker = seedWorker('CodexFirst')
    const weeklyReset = seedCodexFirst(worker.id, STALE_MS)
    const task = pinnedTask(worker.id, ADAPTER)

    await scheduler.tick()

    const held = tasks.requireTask(task.id)
    // ⛔ What actually happened instead: `ready -> assigned on f090340f`, then a run.
    expect(held.status).toBe('ready')
    expect(held.holdReason).toContain('100% of its GPT 7d window')
    expect(held.holdUntil).toBe(weeklyReset)
  })

  it('keeps refusing however old the reading gets', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, 6 * 60 * 60 * 1000)

    expect(scoring.chooseTarget(pinnedTask(worker.id, ADAPTER)).worker).toBeNull()
  })
})

describe('what staleness does still cost a reading', () => {
  it('admits an old reading that is under the mark, and marks the run unverified', () => {
    const worker = seedWorker('CodexFirst')
    seedReading(worker.id, [{ id: '5h', label: 'GPT 5h', percent: 40, resetsIn: FIVE_HOURS }], STALE_MS)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    // ⚠️ Unchanged on purpose. Refusing every old reading would strand a fleet whose accounts
    //    cannot answer `/usage`; the fix narrows to the one thing an old reading still proves.
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.quotaUnverified).toBe(true)
  })

  it('does not let an old percentage score headroom it cannot vouch for', () => {
    const worker = seedWorker('CodexFirst')
    seedReading(worker.id, [{ id: '5h', label: 'GPT 5h', percent: 85, resetsIn: FIVE_HOURS }], STALE_MS)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    const risk = choice.breakdown?.terms.find((t) => t.name === 'quotaRisk')
    // 85% of a five-hour window is a real penalty on a fresh reading and a guess on an old one.
    expect(risk?.value).toBe(0)
    expect(risk?.basis).toContain('no quota reading this fleet trusts')
  })

  it('still scores headroom off a fresh reading, which is the term this must not have broken', () => {
    const worker = seedWorker('CodexFirst')
    seedReading(worker.id, [{ id: '5h', label: 'GPT 5h', percent: 85, resetsIn: FIVE_HOURS }])

    const risk = scoring
      .chooseTarget(pinnedTask(worker.id, ADAPTER))
      .breakdown?.terms.find((t) => t.name === 'quotaRisk')
    expect(risk?.value).toBeGreaterThan(0)
  })

  it('treats an old reading of a window that has since reset as unknown, not as full', () => {
    // ⛔ The other half of the rule. The claim is only ever *this window instance is full*, and it
    //    expires exactly when the instance does — otherwise a 100% reading would bench an account
    //    for a week after the week it described had ended.
    const worker = seedWorker('CodexFirst')
    seedReading(
      worker.id,
      [{ id: '7d', label: 'GPT 7d', percent: 100, resetsIn: -60_000 }],
      STALE_MS
    )

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.quotaUnverified).toBe(true)
  })

  it('refuses on a fresh reading exactly as it always did', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, 0)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('100% of its GPT 7d window')
    // Nothing about age is said about a reading that has none worth mentioning.
    expect(choice.reason).not.toContain('read ')
  })
})

describe('an override buys a turn the vendor would have served, and nothing else', () => {
  it('still lifts the fleet’s own water mark', () => {
    const worker = seedWorker('CodexFirst')
    seedReading(worker.id, [{ id: '5h', label: 'GPT 5h', percent: 93, resetsIn: FIVE_HOURS }])
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + FIVE_HOURS)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker.id)
  })

  it('lifts it on a stale reading too, since the override answered that same reading', () => {
    const worker = seedWorker('CodexFirst')
    seedReading(worker.id, [{ id: '5h', label: 'GPT 5h', percent: 93, resetsIn: FIVE_HOURS }], STALE_MS)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + FIVE_HOURS)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker?.id).toBe(worker.id)
  })

  it('does not buy a turn on a window the vendor has already emptied', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, 0)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + WEEK)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('no override can buy a turn on')
  })

  it('does not buy one on a stale exhausted reading either, which is t276 with a person in it', () => {
    const worker = seedWorker('CodexFirst')
    seedCodexFirst(worker.id, STALE_MS)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + WEEK)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).worker).toBeNull()
  })

  it('parks the overridden task on the spent window’s reset rather than nowhere', () => {
    const worker = seedWorker('CodexFirst')
    const weeklyReset = seedCodexFirst(worker.id, 0)
    const task = pinnedTask(worker.id, ADAPTER)
    tasks.setQuotaOverride(task.id, Date.now() + WEEK)

    expect(scoring.chooseTarget(tasks.requireTask(task.id)).holdUntil).toBe(weeklyReset)
  })
})
