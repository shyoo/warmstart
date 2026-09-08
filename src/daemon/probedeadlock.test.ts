import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pinnedTask } from './testkit.js'

/**
 * t309: *"the probe is stale until Muse works, and the controller will not dispatch to Muse until
 * the probe succeeds"* — and the measurement that there is no such lock.
 *
 * ⛔ **The premise this file exists to keep false.** A worker with no readable quota is dispatched
 * to *blind*, marked `quotaUnverified`, and that flag is a note on the run rather than a filter.
 * Nothing in `eligibility.ts` asks about a reading at all. Verified against the live fleet the same
 * day: all thirteen MuseFirst runs carried `quota_unverified = 1` and several completed, so the
 * controller had already done thirteen times the thing it was reported as unable to do. The risk is
 * that some later gate grows a quota precondition by accident — one `continue` in the dispatch
 * gate's no-reading branch would do it — and the fleet would stop itself with its own instrument
 * without a single test going red. These are that test.
 *
 * ⭐ **And the lock that *was* real.** `health.state === 'suspect'` refused the dispatch while
 * `mayRefreshUsage` refused the probe, leaving two exits that both needed the thing being withheld.
 * The probe is now allowed and a reading with real windows in it lifts the hold, which is the half
 * of the pair a fleet can walk out of on its own. An expired subscription — the measured case the
 * quarantine was built for — is still refused both, because retrying it cannot help.
 *
 * ⚠️ Every input here is a row: a temp database, a declared adapter whose command is `node`, no CLI
 * and no tokens.
 */

const ADAPTER = 'test-probe-deadlock'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let scoring: typeof import('./scoring.js')
let scheduler: typeof import('./scheduler.js')
let quota: typeof import('./quota.js')
let eligibility: typeof import('./eligibility.js')

function seedWorker(label: string) {
  return workers.createWorker({ adapterId: ADAPTER, label, enabled: true })
}

/**
 * Exactly the row a failed screen probe writes — `store()` on an empty snapshot: one sample, no
 * window, percent 0, the vendor's sentence in `error`. This is the shape of MuseFirst's real
 * samples 18249, 18446 and 18511.
 */
function seedFailedProbe(workerId: string, error = 'Currently unavailable'): void {
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at, window_group)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(workerId, '', '', 0, null, 'cli', error, Date.now(), null)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-probedeadlock-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Probe Deadlock CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_PROBE_DEADLOCK_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      capabilities: { transports: ['stream', 'pty'] }
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  scoring = await import('./scoring.js')
  scheduler = await import('./scheduler.js')
  quota = await import('./quota.js')
  eligibility = await import('./eligibility.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'probedeadlock.db'))
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

describe('a worker whose quota probe came back empty is still dispatchable', () => {
  it('is chosen for a task pinned to it, with no refusal at all', () => {
    const worker = seedWorker('BlankProbe')
    seedFailedProbe(worker.id)

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.reason).toBe('')
  })

  it('is marked unverified rather than withheld — the flag is a note, not a gate', () => {
    const worker = seedWorker('BlankProbe')
    seedFailedProbe(worker.id)

    expect(scoring.chooseTarget(pinnedTask(worker.id, ADAPTER)).quotaUnverified).toBe(true)
  })

  it('is dispatchable having never been probed at all, which is a new account', () => {
    const worker = seedWorker('NeverProbed')

    const choice = scoring.chooseTarget(pinnedTask(worker.id, ADAPTER))
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.reason).toBe('')
  })

  it('is refused by no account gate, because none of them reads a quota row', () => {
    const worker = seedWorker('BlankProbe')
    seedFailedProbe(worker.id)

    expect(eligibility.accountRefusal(workers.requireWorker(worker.id))).toBeNull()
  })

  /**
   * ⛔ The one legitimate hold, and its bound. `needsBaseline` may park a task for a single probe so
   * the run has something to be measured against — never more than one, because `ensureFreshQuota`
   * answers `false` once the attempt is stamped and `false` must not bench the task.
   */
  it('is held for at most one probe, and this adapter cannot even ask for that one', () => {
    const worker = seedWorker('BlankProbe')
    seedFailedProbe(worker.id)

    expect(scheduler.needsBaseline(workers.requireWorker(worker.id))).toBeNull()
  })
})

describe('the suspect quarantine has an exit the fleet can reach on its own', () => {
  const strike = (id: string, reason = 'the session ended without producing a turn'): void => {
    workers.recordDispatchFailure(id, reason, null)
  }

  /**
   * ⚠️ A **real** adapter, uniquely in this file, and only for the three `mayRefreshUsage` cases.
   * That gate's last line asks whether the adapter declares a `usageRefresh` at all, and a declared
   * test adapter cannot: `external.ts` hard-codes it to `null`. Asking it of an adapter with no
   * probe to run would answer `false` for a reason that has nothing to do with the quarantine, and
   * pass whether or not the lock is closed. ⛔ Nothing here spawns it — `mayRefreshUsage` reads two
   * rows and a capability.
   */
  const seedProbeCapable = (label: string) =>
    workers.createWorker({ adapterId: 'muse-code', label, enabled: true })

  it('still withholds the dispatch, which is the part that was right', () => {
    const worker = seedWorker('Struck')
    strike(worker.id)

    expect(eligibility.accountRefusal(workers.requireWorker(worker.id))?.why).toContain('held out')
  })

  it('says in the refusal how the hold ends, so it does not read as a dead end', () => {
    const worker = seedWorker('Struck')
    strike(worker.id)

    const why = eligibility.accountRefusal(workers.requireWorker(worker.id))!.why
    expect(why).toContain('quota probe')
    expect(why).toContain('metered turn')
  })

  /**
   * ⭐ The lock, closed. Before t309 this answered `false`, so the account was refused the dispatch
   * *and* the probe and could only be freed by hand.
   */
  it('allows the probe that a suspect worker needs in order to be freed', () => {
    const worker = seedProbeCapable('StruckMuse')
    expect(quota.mayRefreshUsage(worker.id)).toBe(true)
    strike(worker.id)

    expect(workers.requireWorker(worker.id).health?.state).toBe('suspect')
    expect(quota.mayRefreshUsage(worker.id)).toBe(true)
  })

  it('still refuses to probe an account a run measured as expired, which retrying cannot fix', () => {
    const worker = seedProbeCapable('ExpiredMuse')
    // The verdict the failed run recorded, which is how `subscriptionExpired` reaches the health row.
    db.db()
      .prepare('update workers set health_json = ? where id = ?')
      .run(
        JSON.stringify({
          state: 'suspect',
          reason: 'subscription expired',
          strikes: 1,
          since: Date.now(),
          runId: null,
          needsReauth: false,
          subscriptionExpired: true
        }),
        worker.id
      )

    // ⚠️ `mayRefreshUsage` only. The dispatch refusal for this account is asserted on the declared
    // adapter above; asked of `muse-code` here it answers *"not installed"* first, which is a
    // standing gate about this machine rather than anything about the quarantine.
    expect(quota.mayRefreshUsage(worker.id)).toBe(false)
  })

  it('lifts the hold on a reading with real windows in it, and offers the account work again', () => {
    const worker = seedWorker('Struck')
    strike(worker.id)
    expect(workers.requireWorker(worker.id).health?.state).toBe('suspect')

    workers.clearQuarantineByProbe(worker.id)

    expect(workers.requireWorker(worker.id).health).toBeNull()
    expect(eligibility.accountRefusal(workers.requireWorker(worker.id))).toBeNull()
  })

  /**
   * ⛔ Windows only. A probe that fails proves nothing about the account, and lifting on it would
   * clear the quarantine using the very evidence that failed to disprove it.
   */
  it('is not lifted by a probe that came back empty', () => {
    const worker = seedWorker('Struck')
    strike(worker.id)
    seedFailedProbe(worker.id)

    expect(workers.requireWorker(worker.id).health?.state).toBe('suspect')
  })
})
