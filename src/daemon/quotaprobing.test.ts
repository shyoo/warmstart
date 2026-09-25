import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'
import type { ProbeDemand } from './quota.js'

/**
 * **When** the fleet looks at an account, as opposed to what it sees.
 *
 * ⛔ The complaint this file is the answer to (2026-08-31, t70): a run was wrapped up at the top of
 * its five-hour window while the fleet card over it read 63%, and the probe interval said five
 * minutes while the number on that card had not moved in hours. Three separate faults, none of them
 * a wrong percentage:
 *
 *   1. **The cadence was a re-read, not a refresh.** `probeWorker` reads a file the vendor rewrites
 *      on its own schedule; only `refreshUsage` makes it current, and that was gated at two hours
 *      for every account including the one actually spending its window right now.
 *   2. **The live signal went nowhere.** A `rate_limit_event` is free, arrives mid-turn, and is the
 *      only thing that knows the window moved — and it was written to a table and left there.
 *   3. **A parked task waited on the poller's interval, not on its own reset time.** A task due back
 *      at 06:39 was looked at whenever the sweep next came round.
 *
 * ⚠️ Nothing here spawns a process. Every worker that could host one is disabled, and the two
 * decisions worth checking - `forcedRefresh` and `nextDelayMs` - are public exactly so they can be
 * asked without driving a sweep against a real account.
 */

let dir: string
let db: typeof import('./db.js')
let quota: typeof import('./quota.js')
let events: typeof import('./events.js')
let workers: typeof import('./workers.js')
let settings: typeof import('./settings.js')

const MIN = 60_000

describe('screen-answered probes', () => {
  it('retries a swallowed command until a complete quota panel appears', async () => {
    let now = 0
    let attempts = 0
    const result = await quota.driveScreenProbe(
      '/usage',
      12_000,
      () => {
        attempts += 1
      },
      () => (attempts >= 3 ? 'complete panel' : 'startup screen'),
      (value) =>
        value === 'complete panel'
          ? [{ id: '5h', label: '5h', percent: 12, resetsAt: null }]
          : null,
      {
        pause: async (ms) => {
          now += ms
        },
        now: () => now
      }
    )

    expect(result.attempts).toBe(3)
    expect(result.windows?.[0]?.percent).toBe(12)
  })

  it('stops at the deadline when the panel never appears', async () => {
    let now = 0
    const writes: string[] = []
    const result = await quota.driveScreenProbe(
      '/usage',
      6_000,
      (value) => writes.push(value),
      () => 'still starting',
      () => null,
      {
        pause: async (ms) => {
          now += ms
        },
        now: () => now
      }
    )

    expect(writes).toEqual(['/usage\r', '/usage\r'])
    expect(result.windows).toBeNull()
    expect(result.unavailable).toBeNull()
  })

  /**
   * ⛔ The state t266 found on a Muse Code worker commissioned the same morning: the panel drew and
   * said `Currently unavailable`, because the provider publishes no windows until the account has
   * spent a turn. Retrying that is twenty seconds of typing at a CLI that has already answered, and
   * the answer the operator was shown ("the panel did not appear") was about a different fault.
   */
  it('stops as soon as the CLI says it has no reading, and keeps its reason', async () => {
    let now = 0
    const writes: string[] = []
    const result = await quota.driveScreenProbe(
      '/usage ',
      30_000,
      (value) => writes.push(value),
      () => 'Subscription · Muse Code Everyday Usage\n  Currently unavailable',
      () => null,
      {
        unavailable: (screen) =>
          screen.includes('Currently unavailable') ? 'this account has not spent a turn yet' : null,
        pause: async (ms) => {
          now += ms
        },
        now: () => now
      }
    )

    expect(writes).toEqual(['/usage \r'])
    expect(result.windows).toBeNull()
    expect(result.unavailable).toBe('this account has not spent a turn yet')
  })

  /**
   * ⛔ The other half of t266: on Muse Code the command and the return must not arrive in one
   * write. Measured through this app's own PTY — `'/usage \r'` left the text sitting in the
   * composer unsent, four times over eighteen seconds, and the same text with the return behind it
   * drew the panel first time. ⚠️ An adapter that declares no delay still gets exactly one write,
   * which is what the other two were measured on.
   */
  it('sends the return separately when the adapter asks for a gap', async () => {
    let now = 0
    const writes: Array<{ at: number; data: string }> = []
    const result = await quota.driveScreenProbe(
      '/usage ',
      12_000,
      (data) => writes.push({ at: now, data }),
      () => (writes.length >= 2 ? 'complete panel' : 'startup screen'),
      (screen) =>
        screen === 'complete panel'
          ? [{ id: '5h', label: '5h', percent: 4, resetsAt: null }]
          : null,
      {
        submitDelayMs: 400,
        pause: async (ms) => {
          now += ms
        },
        now: () => now
      }
    )

    expect(writes.map((w) => w.data)).toEqual(['/usage ', '\r'])
    expect(writes[1]!.at - writes[0]!.at).toBe(400)
    expect(result.windows?.[0]?.percent).toBe(4)
  })

  /**
   * ⚠️ A reading always wins. The backscroll is a tail of everything the session printed, so an
   * account that filled its windows in while the probe was open leaves *both* panels on it - and
   * the parser is asked first, every pass, precisely so the empty one cannot win that race.
   */
  it('prefers the reading when one screen holds both panels', async () => {
    let now = 0
    const result = await quota.driveScreenProbe(
      '/usage ',
      30_000,
      () => {},
      () => 'Currently unavailable\n… later …\nCurrent 3% used',
      (screen) =>
        /Current (\d+)% used/.test(screen)
          ? [{ id: '5h', label: '5h', percent: 3, resetsAt: null }]
          : null,
      {
        unavailable: (screen) =>
          screen.includes('Currently unavailable') ? 'this account has not spent a turn yet' : null,
        pause: async (ms) => {
          now += ms
        },
        now: () => now
      }
    )

    expect(result.windows?.[0]?.percent).toBe(3)
    expect(result.unavailable).toBeNull()
  })
})

/**
 * **The one probe that spends money** (t570).
 *
 * ⛔ Muse Code publishes a subscription window only once something has been spent in it, so on a
 * freshly reset account every free probe in the world returns `Currently unavailable`. The warm-up
 * is the operator's way out: one very small turn, then the ordinary panel drive again.
 *
 * ⚠️ What is asserted here is the *shape of the wait*, because that is the part that could quietly
 * become a screen-scrape. It waits by the clock and reads nothing back — the pane is never asked
 * whether the turn looks finished.
 */
describe('dismissing the usage view', () => {
  /**
   * ⛔ t689: a warm-up typed after muse's `/usage` panel drew never ended an unavailable streak —
   * the panel that drew is the prime suspect for eating the prompt. The dismiss key goes first so
   * the prompt reaches the composer, and the wait is by the clock like the rest of this path:
   * nothing is read back.
   */
  it('sends the key, then waits the settle before anything else is typed', async () => {
    let now = 0
    const writes: Array<{ at: number; data: string }> = []
    await quota.dismissScreenView('\x1b', 2000, (data) => writes.push({ at: now, data }), async (ms) => {
      now += ms
    })

    expect(writes.map((w) => w.data)).toEqual(['\x1b'])
    expect(now).toBe(2000)
  })
})

describe('the warm-up turn', () => {
  it('sends the prompt, then waits the declared time before anything else happens', async () => {
    let now = 0
    const writes: Array<{ at: number; data: string }> = []
    await quota.driveWarmupTurn(
      'What model are you?',
      90_000,
      (data) => writes.push({ at: now, data }),
      {
        pause: async (ms) => {
          now += ms
        }
      }
    )

    expect(writes.map((w) => w.data)).toEqual(['What model are you?\r'])
    // ⛔ The whole wait, spent before the caller re-drives `/usage`. A warm-up that returned early
    // would ask the panel about a turn that is still running and read `Currently unavailable` back
    // — a paid probe reporting the state it was bought to clear.
    expect(now).toBe(90_000)
  })

  /**
   * ⛔ Same two-write rule as the probe, for the same measured reason: on this CLI a carriage
   * return arriving in the same chunk as the text is not a keypress, so a one-write warm-up spends
   * nothing and leaves the prompt sitting in the composer — the worst of both outcomes, since the
   * operator is told a turn was sent.
   */
  it('sends the return separately when the adapter asks for a gap', async () => {
    let now = 0
    const writes: Array<{ at: number; data: string }> = []
    await quota.driveWarmupTurn(
      'What model are you?',
      60_000,
      (data) => writes.push({ at: now, data }),
      {
        submitDelayMs: 400,
        pause: async (ms) => {
          now += ms
        }
      }
    )

    expect(writes.map((w) => w.data)).toEqual(['What model are you?', '\r'])
    expect(writes[1]!.at - writes[0]!.at).toBe(400)
    expect(now).toBe(60_400)
  })
})

/** A worker that exists, is signed in as far as anything knows, and can never be dispatched to. */
function seedWorker(label: string, adapterId = 'claude-code'): string {
  return workers.createWorker({ adapterId, label, enabled: false }).id
}

/**
 * ⚠️ Enabled only where the *account gate* is what is under test, and never in a file that sweeps.
 * An enabled worker with a real adapter is one `refreshUsage` away from opening a real CLI.
 */
function enable(workerId: string): void {
  db.db().prepare('update workers set enabled = 1 where id = ?').run(workerId)
}

/** Start a worker's reading history over, so a test can say what the *newest* attempt is. */
function forgetSamples(workerId: string): void {
  db.db().prepare('delete from quota_samples where worker_id = ?').run(workerId)
}

/** A reading of a given age, written straight to the store. */
function sample(workerId: string, opts: { ageMs: number; percent?: number; windows?: boolean }): void {
  const at = Date.now() - opts.ageMs
  if (opts.windows === false) {
    db.db()
      .prepare(
        `insert or replace into quota_samples
           (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(workerId, '', '', 0, null, 'unknown', 'probe failed', at)
    return
  }
  db.db()
    .prepare(
      `insert or replace into quota_samples
         (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(workerId, 'session', '5h', opts.percent ?? 10, at + 3600_000, 'config cache', at)
}

const demandOf = (demand: Partial<ProbeDemand>): (() => ProbeDemand) => () => ({
  activeWorkerIds: demand.activeWorkerIds ?? [],
  releases: demand.releases ?? []
})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-probing-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  events = await import('./events.js')
  workers = await import('./workers.js')
  settings = await import('./settings.js')
  db.openDb(join(dir, 'probing.db'))
})

beforeEach(() => {
  // Every case describes its own fleet. Leaving an enabled worker from an earlier gate test here
  // lets the final sweep invoke that worker's real identity CLI, turning a test about a disabled
  // account into an environment-dependent 5-second timeout.
  db.db().exec('delete from quota_samples; delete from rate_limit_samples; delete from settings; delete from workers')
  quota.clearUrgentProbes()
})

afterEach(() => quota.clearUrgentProbes())

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('how long the poller waits before looking again', () => {
  it('wakes on a short tick when nothing is running, not once per idle interval', () => {
    // ⛔ t577. This used to assert `20 * MIN`, and that was half the bug: a sweep that fires exactly
    // once per interval and lands seconds early skips an account whose reading crosses the line a
    // moment later, so a 20-minute setting produced 40-minute-old readings. The interval is now the
    // *age* an idle account is refreshed at; the poller wakes often enough to honour it.
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.nextDelayMs()).toBe(5 * MIN)
    // One tick short of the interval, so the reading is refreshed before it reaches the age, not after.
    expect(poller.idleRefreshAfterMs()).toBe(15 * MIN)
  })

  it('never wakes less often than the idle interval, however long that is', () => {
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 2)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    // Clamped up to the active cadence (5m); the tick can never exceed what the interval allows.
    expect(poller.nextDelayMs()).toBeLessThanOrEqual(5 * MIN)
  })

  it('uses the active cadence the moment a run is in flight', () => {
    // ⭐ The control the operator was already given, now meaning what it says. A fleet with work on
    // it is watched at the frequency they chose for work; a quiet one is not.
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('busy')
    const poller = new quota.QuotaPoller({
      demand: demandOf({ activeWorkerIds: [worker] })
    })

    expect(poller.nextDelayMs()).toBe(5 * MIN)
  })

  it('never lets the idle cadence be faster than the active one', () => {
    // ⚠️ Two independent numbers that can be set into an incoherent pair. An idle fleet polled more
    // often than a busy one is not a preference anybody holds; it is a mistake, and it is clamped
    // rather than obeyed.
    settings.setSetting('probeIntervalMinutes', 30)
    settings.setSetting('idleProbeIntervalMinutes', 5)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    // The 5-minute idle setting is clamped up to the 30-minute active one, so an idle account is
    // refreshed at ~25-30m, never at 5.
    expect(poller.idleRefreshAfterMs()).toBe(25 * MIN)
    expect(poller.nextDelayMs()).toBe(5 * MIN)
  })

  it('wakes just after a parked task is due back, not at the end of the interval', () => {
    // ⛔ The whole point of an unattended fleet. A task parked until 06:39 on a 20-minute idle
    // cadence used to be looked at whenever the sweep next came round.
    const worker = seedWorker('parked-on')
    const at = Date.now() + 4 * MIN
    const poller = new quota.QuotaPoller({ demand: demandOf({ releases: [{ workerId: worker, at }] }) })

    const delay = poller.nextDelayMs()
    expect(delay).toBeGreaterThan(4 * MIN)
    expect(delay).toBeLessThanOrEqual(4 * MIN + quota.RELEASE_PROBE_GRACE_MS + 1000)
  })

  it('takes the soonest of several parked tasks across different accounts', () => {
    const near = seedWorker('near')
    const far = seedWorker('far')
    const poller = new quota.QuotaPoller({
      demand: demandOf({
        releases: [
          { workerId: far, at: Date.now() + 40 * MIN },
          { workerId: near, at: Date.now() + 3 * MIN }
        ]
      })
    })

    expect(poller.nextDelayMs()).toBeLessThanOrEqual(3 * MIN + quota.RELEASE_PROBE_GRACE_MS + 1000)
  })

  it('does not let a release push the delay past the cadence it would have used anyway', () => {
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('far-off')
    const poller = new quota.QuotaPoller({
      demand: demandOf({ releases: [{ workerId: worker, at: Date.now() + 5 * 3600_000 }] })
    })

    expect(poller.nextDelayMs()).toBe(5 * MIN)
  })

  it('drops to its floor when something urgent is queued', () => {
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('warned')
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    quota.requestUrgentProbe(worker, 'the CLI said allowed_warning')

    expect(poller.nextDelayMs()).toBeLessThanOrEqual(1000)
  })

  it('survives a demand supplier that throws, at the idle cadence', () => {
    // ⚠️ Degrading to the old behaviour is acceptable; a poller that stops is not.
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const poller = new quota.QuotaPoller({
      demand: () => {
        throw new Error('the scheduler is mid-migration')
      }
    })

    expect(poller.nextDelayMs()).toBe(5 * MIN)
  })
})

/**
 * ⛔ **t577: "Quota probe when idle: every 20 minutes", and readings 41 minutes and hours old.**
 *
 * The idle interval only ever re-read a cache file the vendor writes when the account is *used*, so
 * an account nothing was running on was never refreshed at all and its card aged without bound. What
 * is asserted here is the promise the setting makes — *no idle account's reading is left older than
 * this* — as arithmetic over a long quiet stretch, because a single-decision test cannot see the
 * failure: every individual sweep looked reasonable, and the bug was in what they added up to.
 */
describe('refreshing an account nothing is running on', () => {
  const now = () => Date.now()
  const quiet = { activeWorkerIds: [], releases: [] }

  it('refreshes an idle account once its reading is about to pass the idle interval', () => {
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('quiet')
    enable(worker)
    sample(worker, { ageMs: 16 * MIN, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    const forced = poller.forcedRefresh(worker, quiet, now())
    expect(forced?.idle).toBe(true)
    expect(forced?.why).toMatch(/16m old and nothing is running/)
  })

  it('leaves a recently read idle account alone', () => {
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('quiet-and-fresh')
    enable(worker)
    sample(worker, { ageMs: 8 * MIN, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())).toBeNull()
  })

  it('refreshes an idle account that has never been read', () => {
    const worker = seedWorker('never-read')
    enable(worker)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())?.why).toMatch(/ever been taken/)
  })

  /**
   * ⛔ The measured shape of "hours old": the old sweep refreshed nothing here, so a reading from
   * three hours ago stayed three hours old for as long as the account sat unused.
   */
  it('refreshes an idle account whose reading is hours old', () => {
    const worker = seedWorker('hours-old')
    enable(worker)
    sample(worker, { ageMs: 3 * 3600_000, percent: 80 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())?.idle).toBe(true)
  })

  /**
   * ⚠️ Keyed on the newest *attempt*. An account whose panel says it has nothing to show (Muse Code's
   * `Currently unavailable`) writes a failed row each time; if only readings *with windows* counted
   * it would look overdue on every sweep and be retried every five minutes.
   */
  it('counts a recent failed attempt as an attempt', () => {
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const worker = seedWorker('just-tried')
    enable(worker)
    sample(worker, { ageMs: 2 * MIN, windows: false })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())).toBeNull()

    // ⚠️ `sample` adds a row and the store answers with the *newest*, so the earlier attempt has to
    // go or it would still be the one asked about.
    forgetSamples(worker)
    sample(worker, { ageMs: 30 * MIN, windows: false })
    expect(poller.forcedRefresh(worker, quiet, now())?.idle).toBe(true)
  })

  it('never opens a terminal on an account the operator switched off', () => {
    const worker = seedWorker('switched-off') // seeded disabled
    sample(worker, { ageMs: 5 * 3600_000, percent: 50 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())).toBeNull()
  })

  it('never opens a terminal on an account whose subscription the failed run measured as expired', () => {
    const worker = seedWorker('expired')
    enable(worker)
    db.db()
      .prepare('update workers set health_json = ? where id = ?')
      .run(JSON.stringify({ state: 'suspect', reason: 'subscription expired', subscriptionExpired: true }), worker)
    sample(worker, { ageMs: 5 * 3600_000, percent: 50 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())).toBeNull()
  })

  it('leaves an adapter with no usage command to the free read it already gets', () => {
    // ⚠️ Nothing to drive: `probeWorker` reads it. A "refresh" here would be the same file read.
    const worker = seedWorker('endpoint', 'local-llm')
    enable(worker)
    sample(worker, { ageMs: 5 * 3600_000, percent: 50 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())).toBeNull()
  })

  it('reaches a screen-answered adapter, which the file re-read skipped entirely', () => {
    // ⛔ Muse Code and Antigravity write no cache, so the sweep's `continue` past them meant their
    // idle readings were not refreshed by *any* path. This is why they were the worst cases.
    const worker = seedWorker('muse', 'muse-code')
    enable(worker)
    sample(worker, { ageMs: 3 * 3600_000, percent: 30 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, quiet, now())?.idle).toBe(true)
  })

  it('yields to every reason that has a deadline', () => {
    const worker = seedWorker('warned')
    enable(worker)
    sample(worker, { ageMs: 3 * 3600_000, percent: 50 })
    quota.requestUrgentProbe(worker, 'rate-limit rejected')
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    const forced = poller.forcedRefresh(worker, quiet, now())
    expect(forced?.why).toMatch(/rejected/)
    expect(forced?.idle).toBeUndefined()
  })

  /**
   * ⭐ **The property the setting promises**, run over a long quiet stretch rather than asserted at
   * one instant. Sweeps happen every `nextDelayMs()`; whenever the poller would refresh, the
   * reading's age resets to zero; at no sweep may an idle account be found older than the interval.
   * This is the test that fails on the old logic, where nothing ever reset the age.
   */
  it.each([
    { idle: 20, active: 5 },
    { idle: 10, active: 5 },
    { idle: 60, active: 5 },
    { idle: 30, active: 30 },
    { idle: 5, active: 5 }
  ])('never leaves an idle account older than $idle minutes (active cadence $active)', ({ idle, active }) => {
    settings.setSetting('probeIntervalMinutes', active)
    settings.setSetting('idleProbeIntervalMinutes', idle)
    const worker = seedWorker(`quiet-${idle}-${active}`)
    enable(worker)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })
    const tick = poller.nextDelayMs()
    const limit = Math.max(idle, active) * MIN

    let refreshedAt = 0
    let oldest = 0
    let refreshes = 0
    for (let t = 0; t <= 12 * 3600_000; t += tick) {
      // ⚠️ Replace, never add: the store answers with the newest row, and a row written at an
      // earlier step is always newer than one this step back-dates, which would read as fresh forever.
      forgetSamples(worker)
      sample(worker, { ageMs: t - refreshedAt, percent: 30 })
      oldest = Math.max(oldest, t - refreshedAt)
      if (poller.forcedRefresh(worker, quiet, now())) {
        refreshedAt = t
        refreshes += 1
      }
    }

    // Found no older than the operator's setting at any wake-up...
    expect(oldest).toBeLessThanOrEqual(limit)
    // ...and refreshed at most about once per interval, so the bound on terminals is the setting
    // itself: the retired two-hour clock was a constant, and this one is theirs.
    expect(refreshes).toBeLessThanOrEqual(Math.ceil((12 * 3600_000) / Math.max(MIN, limit - tick)))
    expect(refreshes).toBeGreaterThan(0)
  })
})

describe('the free live signal, connected to something', () => {
  it('asks for a probe when the CLI reports a rate-limit warning', () => {
    // ⭐ t70's actual sequence: the vendor says the window is nearly spent, mid-turn, for free —
    // and until this existed that fact reached the gate and never reached the operator.
    const worker = seedWorker('warned')
    quota.recordRateLimit(worker, null, {
      status: 'allowed_warning',
      rateLimitType: '5h',
      resetsAt: Date.now() + 20 * MIN
    })

    expect(quota.pendingUrgentProbes().get(worker)).toMatch(/allowed_warning/)
  })

  it('asks for one when the CLI outright refuses', () => {
    const worker = seedWorker('rejected')
    quota.recordRateLimit(worker, null, { status: 'rejected', rateLimitType: '5h', resetsAt: null })

    expect(quota.pendingUrgentProbes().has(worker)).toBe(true)
  })

  it('asks for nothing on a healthy turn', () => {
    // ⛔ Every turn of every run carries one of these. Probing on `allowed` would be a process per
    // turn, which is the exact mistake `REFRESH_AFTER_MS` was raised to two hours to stop.
    const worker = seedWorker('fine')
    quota.recordRateLimit(worker, null, { status: 'allowed', rateLimitType: '5h', resetsAt: null })

    expect(quota.pendingUrgentProbes().size).toBe(0)
  })

  it('keeps both reasons when two signals arrive before the sweep', () => {
    const worker = seedWorker('twice')
    quota.requestUrgentProbe(worker, 'first')
    quota.requestUrgentProbe(worker, 'second')

    expect(quota.pendingUrgentProbes().get(worker)).toBe('first; second')
  })

  it('is consumed by a sweep even for an account nobody may probe', async () => {
    // ⛔ Otherwise the request sits in the queue forever and `nextDelayMs` pins the loop at its
    // floor: a poller sweeping every second, permanently, because one disabled worker was warned.
    const worker = seedWorker('disabled-but-warned')
    quota.requestUrgentProbe(worker, 'a warning about an account we cannot open')

    await new quota.QuotaPoller({ demand: demandOf({}) }).sweep()

    expect(quota.pendingUrgentProbes().size).toBe(0)
  })
})

describe('deciding to refresh rather than merely re-read', () => {
  const now = () => Date.now()

  it('refreshes an account with a run in flight once its reading is older than the cadence', () => {
    // ⛔ The measured fault: five minutes was the interval at which a *file* was re-read, and the
    // file is written by the vendor whenever it feels like it. So a busy account's card could be
    // hours behind the window it was actively spending.
    settings.setSetting('probeIntervalMinutes', 5)
    const worker = seedWorker('busy')
    sample(worker, { ageMs: 6 * MIN, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    const forced = poller.forcedRefresh(worker, { activeWorkerIds: [worker], releases: [] }, now())
    expect(forced?.why).toMatch(/run is in flight/)
  })

  it('leaves a busy account alone while its reading is still inside the cadence', () => {
    settings.setSetting('probeIntervalMinutes', 5)
    const worker = seedWorker('busy-and-fresh')
    sample(worker, { ageMs: 30_000, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, { activeWorkerIds: [worker], releases: [] }, now())).toBeNull()
  })

  it('refreshes a busy account that has never been read at all', () => {
    const worker = seedWorker('busy-and-unknown')
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(
      poller.forcedRefresh(worker, { activeWorkerIds: [worker], releases: [] }, now())?.why
    ).toMatch(/run is in flight/)
  })

  it('refreshes an idle account the moment a parked task is due back on it', () => {
    const worker = seedWorker('parked-on')
    sample(worker, { ageMs: 60_000, percent: 99 })
    const at = Date.now() - quota.RELEASE_PROBE_GRACE_MS - 1000
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    const forced = poller.forcedRefresh(worker, { activeWorkerIds: [], releases: [{ workerId: worker, at }] }, now())
    expect(forced?.why).toMatch(/parked on this window/)
    expect(forced?.release).toBe(at)
  })

  it('waits out the grace period rather than reading the window it is about to leave', () => {
    // ⚠️ `resetsAt` is the boundary itself. Probing on the dot reads the old window one last time
    // and parks the task for another whole interval on a number that expired a second later.
    const worker = seedWorker('due-any-second')
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    const forced = poller.forcedRefresh(
      worker,
      { activeWorkerIds: [], releases: [{ workerId: worker, at: Date.now() - 1000 }] },
      now()
    )
    expect(forced).toBeNull()
  })

  it('takes an urgent request ahead of everything else', () => {
    const worker = seedWorker('warned')
    sample(worker, { ageMs: 10_000, percent: 40 })
    quota.requestUrgentProbe(worker, 'rate-limit rejected')
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, { activeWorkerIds: [], releases: [] }, now())?.why).toMatch(
      /rejected/
    )
  })

  it('refreshes an account nothing is happening on once its reading passes the idle interval', () => {
    // ⛔ **This asserted the opposite until t577** — *"age is not a reason on its own"* — and that
    // rule is what left idle cards 41 minutes and hours old under a setting that said twenty. Its
    // premise, that an idle account's window has not moved, is also false at a reset: a reading of a
    // window that has since reset is not merely old, it is *wrong* (90% where the truth is 0%).
    // The operator's idle interval is the age they will tolerate; see `refreshing an account nothing
    // is running on` for the bound and for everything that still exempts an account.
    const worker = seedWorker('quiet')
    enable(worker)
    sample(worker, { ageMs: 3 * 3600_000, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, { activeWorkerIds: [], releases: [] }, now())?.idle).toBe(true)
    expect(quota.mayRefreshUsage(worker)).toBe(true)
  })
})

describe('the account gates every refresh goes through', () => {
  it('refuses a worker whose adapter has no usage command to drive', () => {
    const worker = seedWorker('codex', 'openai-compatible')
    expect(quota.mayRefreshUsage(worker)).toBe(false)
  })

  it('allows one that has', () => {
    const worker = seedWorker('claude')
    enable(worker)
    expect(quota.mayRefreshUsage(worker)).toBe(true)
  })

  it('refuses a disabled account', () => {
    expect(quota.mayRefreshUsage(seedWorker('off'))).toBe(false)
  })

  it('refuses an account checkably signed out, however urgent the request', () => {
    // ⛔ A TUI on an account nobody is signed in to sits on its login screen for the whole timeout
    // and answers nothing. Urgency does not make that a better use of thirty seconds.
    const worker = seedWorker('signed-out')
    enable(worker)
    db.db()
      .prepare('update workers set identity_json = ? where id = ?')
      .run(JSON.stringify({ loggedIn: false, checkedAt: Date.now() }), worker)
    expect(quota.mayRefreshUsage(worker)).toBe(false)
  })

  /**
   * ⭐ **Reversed by t309, deliberately.** This asserted `false`, and that was the lock: a
   * quarantined account was refused the dispatch *and* the probe, so both its exits — a metered turn
   * and a person pressing Probe — needed the very thing being withheld. The asymmetry that settles
   * it is cost. A probe is a PTY and thirty seconds; a dispatch is a workspace claim, a process, and
   * a task handed to a person as though their own work had failed. Asking is the cheap half.
   */
  it('probes an account a dead run has quarantined, which is how the hold lifts itself', () => {
    const worker = seedWorker('suspect')
    enable(worker)
    db.db()
      .prepare('update workers set health_json = ? where id = ?')
      .run(JSON.stringify({ state: 'suspect', reason: 'a run produced nothing' }), worker)
    expect(quota.mayRefreshUsage(worker)).toBe(true)
  })

  /**
   * ⛔ The measured case the quarantine was built for, and the one this must still refuse. An
   * expired subscription answers `auth status` exactly as a live one does, so only the failed run's
   * own verdict tells them apart — and a probe on it spawns a CLI to watch it fail to authenticate.
   */
  it('still refuses an account whose subscription the failed run measured as expired', () => {
    const worker = seedWorker('expired')
    enable(worker)
    db.db()
      .prepare('update workers set health_json = ? where id = ?')
      .run(
        JSON.stringify({
          state: 'suspect',
          reason: 'subscription expired',
          subscriptionExpired: true
        }),
        worker
      )
    expect(quota.mayRefreshUsage(worker)).toBe(false)
  })
})

describe('what a sweep reports back', () => {
  /**
   * ⚠️ Observed on the **event sink**, which is where the poller's own listener used to be. That
   * callback was the only thing telling the UI a reading had changed, and three of the four paths
   * that store one never went through it (t86) — so the announcement moved to the store, and this
   * assertion moved with it, onto what the renderer actually receives.
   */
  it('says nothing about disabled or quarantined accounts', async () => {
    const heard: DaemonEvent[] = []
    const disabled = seedWorker('never-touch-me')
    events.setEventSink((e) => heard.push(e))
    try {
      await new quota.QuotaPoller({ demand: demandOf({}) }).sweep()
    } finally {
      events.setEventSink(() => {})
    }

    const about = heard
      .filter((e): e is Extract<DaemonEvent, { type: 'quota.changed' }> => e.type === 'quota.changed')
      .map((e) => e.quota.workerId)
    expect(about).not.toContain(disabled)
  })
})

describe('vendorSilent: the vendor\'s own "nothing published yet" survives to a reader', () => {
  /**
   * ⛔ **The distinction `scoring.ts`'s `inferredFreshWindows` (t516) depends on.** A row the adapter
   * explained (`usageUnavailable` matched) has to read back differently from an ordinary probe
   * failure, or scoring cannot tell "this window is fresh" from "we don't know what happened".
   */
  it('is true on a row the adapter explained, and absent on an ordinary failure', () => {
    const explained = seedWorker('vendor-explained')
    const ordinary = seedWorker('probe-just-failed')
    const now = Date.now()
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at, vendor_silent)
         values (?,'','',0,null,'unknown',?,?,1)`
      )
      .run(explained, 'the panel reads "Currently unavailable"', now)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
         values (?,'','',0,null,'unknown',?,?)`
      )
      .run(ordinary, 'the panel did not appear', now)

    expect(quota.lastQuota(explained)?.vendorSilent).toBe(true)
    expect(quota.lastQuota(ordinary)?.vendorSilent).toBeUndefined()
  })

  it('does not leak onto a row that actually carries windows', () => {
    // ⛔ `store()` writes `vendor_silent` only on the no-windows row; a reader must not find it stuck
    // on a later, real reading purely because the column exists.
    const worker = seedWorker('recovered')
    const now = Date.now()
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at, vendor_silent)
         values (?,'','',0,null,'unknown',?,?,1)`
      )
      .run(worker, 'the panel reads "Currently unavailable"', now - 60_000)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,'7d','Muse 7d',5,?,'cli',?)`
      )
      .run(worker, now + 3600_000, now)

    expect(quota.lastQuota(worker)?.vendorSilent).toBeUndefined()
  })
})
