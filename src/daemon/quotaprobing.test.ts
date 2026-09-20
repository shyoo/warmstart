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
  it('uses the idle cadence when nothing is running', () => {
    settings.setSetting('probeIntervalMinutes', 5)
    settings.setSetting('idleProbeIntervalMinutes', 20)
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.nextDelayMs()).toBe(20 * MIN)
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

    expect(poller.nextDelayMs()).toBe(30 * MIN)
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

    expect(poller.nextDelayMs()).toBe(20 * MIN)
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

    expect(poller.nextDelayMs()).toBe(20 * MIN)
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

  it('forces nothing for an account nothing is happening on, however old its reading', () => {
    // ⛔ Age is not a reason on its own, and after the two branches met that is the rule the whole
    // sweep rests on: a three-hour-old reading of an account nobody is routing work to describes a
    // window that has not moved. The account is still refreshable — the dispatch gate asks the
    // moment there is a task for it — but no clock asks on its behalf.
    const worker = seedWorker('quiet')
    enable(worker)
    sample(worker, { ageMs: 3 * 3600_000, percent: 40 })
    const poller = new quota.QuotaPoller({ demand: demandOf({}) })

    expect(poller.forcedRefresh(worker, { activeWorkerIds: [], releases: [] }, now())).toBeNull()
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
