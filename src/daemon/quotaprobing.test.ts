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
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  events = await import('./events.js')
  workers = await import('./workers.js')
  settings = await import('./settings.js')
  db.openDb(join(dir, 'probing.db'))
})

beforeEach(() => {
  db.db().exec('delete from quota_samples; delete from rate_limit_samples; delete from settings')
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

  it('refuses an account a dead run has quarantined', () => {
    const worker = seedWorker('suspect')
    enable(worker)
    db.db()
      .prepare('update workers set health_json = ? where id = ?')
      .run(JSON.stringify({ state: 'suspect', reason: 'a run produced nothing' }), worker)
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
