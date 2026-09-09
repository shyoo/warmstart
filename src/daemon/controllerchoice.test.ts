import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

/**
 * Who gets asked for judgment, and — the part this file exists for — who does not.
 *
 * ⛔ **The defect these were written from.** The scheduler had grown a gate for an account that work
 * does not survive on: a run that produces no metered turn marks the worker `suspect`, and dispatch
 * skips it until something proves otherwise. `chooseController` never got that gate. So ClaudeFirst,
 * whose subscription had expired, was quarantined for *work* and simultaneously reported **ready**
 * on the Controller panel — and was picked for judgment call after judgment call, each one spending
 * the only loop in the daemon that spends tokens to rediscover the same fact and throw it away.
 *
 * Two separate faults made that possible and both are covered below:
 *
 *   1. Two gate lists that had to be kept in step by hand, and were not. There is now one shared
 *      list (`eligibility.ts`) plus each caller's own specific gates.
 *   2. A judgment call that died recorded its failure on the **consult** and nothing on the
 *      **worker**, so the loop could not learn. The work path had had that since M4.
 *
 * ⚠️ Every worker here runs on a declared adapter whose command is `node`, so `isInstalled()` is
 * true on any machine that can run this suite. Using a real agent CLI would make the gates pass or
 * fail for reasons that have nothing to do with the gate under test — and would answer differently
 * on CI than on the laptop, which is the failure mode these tests exist to catch elsewhere.
 */

const ADAPTER = 'test-controller'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let controller: typeof import('./controller.js')
let quota: typeof import('./quota.js')

/** A worker that passes every gate, so each test can break exactly one thing. */
function fit(label: string, role: 'controller' | 'both' = 'controller'): Worker {
  const worker = workers.createWorker({ adapterId: ADAPTER, label })
  return workers.updateWorker(worker.id, { role })
}

/**
 * A quota reading, written where `lastQuota` reads it.
 *
 * ⚠️ Inserted at the storage layer on purpose: every exported way to record one goes through an
 * adapter's probe, and a declared adapter has none. The alternative — a worker on `claude-code` —
 * would fail the installed gate on any machine without that CLI, which includes all of CI.
 */
function seedQuota(workerId: string, percent: number, sampledAt = Date.now()): void {
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?, '5h', '5h', ?, null, 'cache', ?)`
    )
    .run(workerId, percent, sampledAt)
}

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-controller-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir

  // Declared before the registry is built: `loadAdapters()` is called once, deliberately, so that a
  // worker's capabilities cannot change between the gate that admitted its question and the session
  // that answers it.
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Controller CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_CONTROLLER_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      capabilities: { transports: ['stream', 'pty'] }
    })
  )

  db = await import('./db.js')
  workers = await import('./workers.js')
  quota = await import('./quota.js')
  controller = await import('./controller.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'controller.db'))
  adapters.loadAdapters()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the account gates, which judgment and work now share', () => {
  it('refuses an account a dead run has held out of dispatch', () => {
    // ⛔ The reported bug, in one test. This is the state ClaudeFirst was in: signed in, enabled,
    // installed, quarantined by the scheduler — and offered every judgment call anyway.
    const worker = fit('expired-subscription')
    expect(controller.controllerUnavailability(worker)).toBeNull()

    workers.recordDispatchFailure(worker.id, 'subscription expired', 'r1')
    const struck = workers.requireWorker(worker.id)
    expect(struck.health?.state).toBe('suspect')

    const why = controller.controllerUnavailability(struck)
    expect(why).toContain('held out')
    // ⚠️ The vendor's own words survive to the panel. "not now" tells an operator nothing they can
    // act on; "subscription expired" tells them exactly where to go.
    expect(why).toContain('subscription expired')

    workers.retireWorker(worker.id)
  })

  it('offers it again the moment something proves it works', () => {
    const worker = fit('recovers')
    workers.recordDispatchFailure(worker.id, 'subscription expired', 'r1')
    expect(controller.controllerUnavailability(workers.requireWorker(worker.id))).toContain(
      'held out'
    )

    // A quarantine that needs a support ticket to lift is worse than the fault it prevents: one
    // metered turn, or a re-probe, clears it.
    workers.clearDispatchFailure(worker.id)
    expect(controller.controllerUnavailability(workers.requireWorker(worker.id))).toBeNull()

    workers.retireWorker(worker.id)
  })

  it('refuses one the operator has switched off', () => {
    const worker = workers.updateWorker(fit('switched-off').id, { enabled: false })
    expect(controller.controllerUnavailability(worker)).toContain('disabled')
    workers.retireWorker(worker.id)
  })

  it('refuses one a person is using by hand', () => {
    const worker = workers.updateWorker(fit('in-use').id, { humanOccupied: true })
    expect(controller.controllerUnavailability(worker)).toContain('human-occupied')
    workers.retireWorker(worker.id)
  })

  it('refuses one that is checkably signed out', () => {
    const worker = fit('signed-out')
    const signedOut = { ...worker, identity: { loggedIn: false, checkedAt: Date.now() } }
    expect(controller.controllerUnavailability(signedOut)).toContain('not signed in')
    workers.retireWorker(worker.id)
  })

  it('still offers one whose sign-in state is unknowable', () => {
    // ⛔ `null` is not `false`, and conflating them would make Antigravity — whose credential lives
    // in the OS keyring by design — permanently ineligible for judgment it can perfectly well give.
    const worker = fit('keyring')
    const unknown = { ...worker, identity: { loggedIn: null, checkedAt: Date.now() } }
    expect(controller.controllerUnavailability(unknown)).toBeNull()
    workers.retireWorker(worker.id)
  })

  it('refuses a retired account even when handed one directly', () => {
    // `listWorkers()` already excludes these, so this gate only fires for a caller holding an older
    // row — which is exactly when a missing gate does its damage silently.
    const worker = fit('retired')
    expect(controller.controllerUnavailability(workers.retireWorker(worker.id))).toContain('retired')
  })

  it('refuses an adapter that is not installed on this machine', async () => {
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'maybe-installed' })
    const promoted = workers.updateWorker(worker.id, { role: 'controller' })
    const why = controller.controllerUnavailability(promoted)
    // ⚠️ Asserted conditionally, and deliberately: whether Claude Code is on PATH is a property of
    // the machine, not of the code. On a laptop that has it this says nothing; on CI, which has
    // none of the agent CLIs, it proves the gate fires. A test that demanded one answer would be
    // testing the runner.
    const installed = (await import('./adapters/index.js')).adapter('claude-code').isInstalled()
    if (installed) expect(why).toBeNull()
    else expect(why).toContain('not installed')
    workers.retireWorker(worker.id)
  })
})

describe("the controller's own gates, on top of the account's", () => {
  it('refuses an adapter that cannot run a non-interactive session', async () => {
    // A consult is answered over stream-json. ⛔ A capability question, never an adapter name.
    writeFileSync(
      join(dir, 'adapters', 'pty-only.json'),
      JSON.stringify({
        schema_version: 1,
        id: 'pty-only',
        label: 'Interactive Only CLI',
        command: 'node',
        print_args: ['-e', ''],
        version_args: ['--version'],
        isolation_env_var: 'TEST_CONTROLLER_HOME',
        cost_model_id: 'anthropic.subscription.2026-08',
        capabilities: { transports: ['pty'] }
      })
    )
    ;(await import('./adapters/index.js')).loadAdapters()

    const worker = workers.updateWorker(
      workers.createWorker({ adapterId: 'pty-only', label: 'pty-only-worker' }).id,
      { role: 'controller' }
    )
    expect(controller.controllerUnavailability(worker)).toContain(
      'cannot run a non-interactive session'
    )
    workers.retireWorker(worker.id)
  })

  it('refuses one the vendor is currently rate-limiting', () => {
    const worker = fit('rate-limited')
    quota.recordRateLimit(worker.id, null, {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: null
    })
    expect(controller.controllerUnavailability(workers.requireWorker(worker.id))).toContain(
      'rate-limited'
    )
    workers.retireWorker(worker.id)
  })

  it('refuses one near the top of its five-hour window', () => {
    // Leadership delegation is just this gate. Nothing special happens at the floor — that *is* the
    // floor: the account stops being chosen and the next question routes elsewhere.
    const worker = fit('nearly-full')
    seedQuota(worker.id, 96)
    const why = controller.controllerUnavailability(workers.requireWorker(worker.id))
    expect(why).toContain('96%')
    workers.retireWorker(worker.id)
  })

  it('offers one with room in the same window', () => {
    const worker = fit('plenty-of-room')
    seedQuota(worker.id, 12)
    expect(controller.controllerUnavailability(workers.requireWorker(worker.id))).toBeNull()
    workers.retireWorker(worker.id)
  })

  it('never offers an account designated for work only', () => {
    const worker = workers.updateWorker(fit('labourer').id, { role: 'worker' })
    expect(controller.controllerUnavailability(worker)).toContain('does work only')
    workers.retireWorker(worker.id)
  })

  /**
   * ⛔ t223: `none` is what unticking both boxes now writes, and the judgment gate reads it through
   * `canJudge`. Spelled `role !== 'worker'` — which is how every gate here was written — an account
   * held out of everything would have read as a controller and been offered judgment calls.
   */
  it('never offers an account held out of both roles, and leaves it off the panel', () => {
    const worker = workers.updateWorker(fit('neither').id, { role: 'none' })
    expect(controller.controllerUnavailability(worker)).toContain(
      'held out of both work and judgment'
    )
    expect(controller.chooseController().worker?.id).not.toBe(worker.id)
    // The Controller panel lists accounts that judgment can reach. This one cannot be reached, so
    // a row saying so would be a row about a decision already taken elsewhere.
    expect(controller.controllerReport().controllers.map((c) => c.workerId)).not.toContain(worker.id)
    workers.retireWorker(worker.id)
  })
})

describe('choosing between the accounts that are left', () => {
  it('uses a worker\'s configured cheap model for a title-only consult', () => {
    const worker = workers.updateWorker(fit('title-worker').id, { summarisingModel: 'claude-haiku-4-5' })
    const choice = controller.chooseController({ kind: 'title' })
    expect(choice.worker?.id).toBe(worker.id)
    expect(choice.model).toBe('claude-haiku-4-5')
    workers.retireWorker(worker.id)
  })

  it('leaves a worker with no summary model out of title-only consults', () => {
    const worker = workers.updateWorker(fit('no-title-worker').id, { summarisingModel: null })
    const choice = controller.chooseController({ kind: 'title' })
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('no title-summary model')
    workers.retireWorker(worker.id)
  })

  it('says nothing is available, with a reason, when every account is unfit', () => {
    const worker = fit('the-only-one')
    workers.recordDispatchFailure(worker.id, 'subscription expired', null)

    const choice = controller.chooseController()
    expect(choice.worker).toBeNull()
    // ⛔ The deterministic fallback answers from here. A null controller is a designed state, not an
    // error — but it has to say why, or the operator sees judgment silently stop happening.
    expect(choice.reason).toContain('held out')

    workers.retireWorker(worker.id)
  })

  it('prefers a dedicated controller over an account that also does work', () => {
    const both = fit('does-everything', 'both')
    const dedicated = fit('judgment-only', 'controller')
    seedQuota(both.id, 10)
    seedQuota(dedicated.id, 10)

    expect(controller.chooseController().worker?.id).toBe(dedicated.id)

    workers.retireWorker(both.id)
    workers.retireWorker(dedicated.id)
  })

  it('prefers the emptier window between two accounts of the same role', () => {
    const busy = fit('busy')
    const idle = fit('idle')
    seedQuota(busy.id, 70)
    seedQuota(idle.id, 5)

    expect(controller.chooseController().worker?.id).toBe(idle.id)

    workers.retireWorker(busy.id)
    workers.retireWorker(idle.id)
  })

  it('does not let an unread window outrank a measured empty one', () => {
    // ⚠️ Unknown scores 0.5 — below a measured empty account and above a measured busy one. This is
    // the same rule the scheduler has: a guess must never outrank a measurement in either direction.
    const unknown = fit('never-probed')
    const measured = fit('measured-empty')
    seedQuota(measured.id, 0)

    expect(controller.chooseController().worker?.id).toBe(measured.id)

    workers.retireWorker(unknown.id)
    workers.retireWorker(measured.id)
  })

  it('treats a reading too old to trust as no reading at all', () => {
    const stale = fit('stale-reading')
    const busy = fit('busy-but-fresh')
    // Old enough that `lastQuota` marks it stale; a stale 0% must not beat a fresh 40%.
    seedQuota(stale.id, 0, Date.now() - 30 * 24 * 60 * 60 * 1000)
    seedQuota(busy.id, 40)

    expect(controller.chooseController().worker?.id).toBe(busy.id)

    workers.retireWorker(stale.id)
    workers.retireWorker(busy.id)
  })
})

describe('what the Controller panel is allowed to say', () => {
  it('never calls an account ready when it cannot be asked', () => {
    // ⛔ The visible half of the reported bug. `available` was `chosen.worker?.id === w.id`, so a
    // quarantined account showed `ready` whenever the chooser wrongly returned it — and every other
    // row said "another is preferred" no matter why it was really out.
    const struck = fit('cannot-be-asked')
    const healthy = fit('can-be-asked')
    workers.recordDispatchFailure(struck.id, 'subscription expired', null)

    const report = controller.controllerReport()
    const row = report.controllers.find((c) => c.workerId === struck.id)
    expect(row?.available).toBe(false)
    expect(row?.reason).toContain('subscription expired')

    workers.retireWorker(struck.id)
    workers.retireWorker(healthy.id)
  })

  it('gives each account its own reason, not the chooser’s summary', () => {
    const offline = workers.updateWorker(fit('turned-off').id, { enabled: false })
    const busy = fit('at-the-water-mark')
    seedQuota(busy.id, 99)

    const rows = controller.controllerReport().controllers
    expect(rows.find((c) => c.workerId === offline.id)?.reason).toContain('disabled')
    expect(rows.find((c) => c.workerId === busy.id)?.reason).toContain('99%')

    workers.retireWorker(offline.id)
    workers.retireWorker(busy.id)
  })

  it('calls an account ready when it is, chosen or not', () => {
    const first = fit('first-choice')
    const second = fit('also-fine')
    seedQuota(first.id, 1)
    seedQuota(second.id, 2)

    const rows = controller.controllerReport().controllers
    expect(rows.find((c) => c.workerId === first.id)?.available).toBe(true)
    // ⚠️ Both are askable. Reporting only the winner as `ready` made a healthy fleet look like a
    // fleet with one working account.
    expect(rows.find((c) => c.workerId === second.id)?.available).toBe(true)
    expect(rows.find((c) => c.workerId === second.id)?.reason).toContain('another is preferred')

    workers.retireWorker(first.id)
    workers.retireWorker(second.id)
  })
})

describe('a judgment call that produced nothing', () => {
  it('is charged to the account, not to the question', () => {
    expect(controller.deadConsultVerdict(0, 'it did not answer in time')).toContain(
      'produced no turn'
    )
  })

  it('spares an account that metered anything at all', () => {
    // ⛔ Zero metered turns, not merely an unusable answer. A reply that arrives and fails
    // validation proves the account works and the prompt does not — quarantining a healthy
    // controller for a bad prompt would empty the fleet one question at a time.
    expect(controller.deadConsultVerdict(4210, 'the reply contained no JSON object')).toBeNull()
  })

  it('holds the account out of the next judgment call', () => {
    // The whole point of recording it: before this, the failure was written on the consult and the
    // same account was asked again on the next drain, indefinitely.
    const worker = fit('answers-nothing')
    const verdict = controller.deadConsultVerdict(0, 'it did not answer in time')
    workers.recordDispatchFailure(worker.id, verdict as string, null)

    expect(controller.chooseController().worker?.id).not.toBe(worker.id)
    expect(controller.controllerUnavailability(workers.requireWorker(worker.id))).toContain(
      'produced no turn'
    )

    workers.retireWorker(worker.id)
  })

  it('is what the timeout path actually records', () => {
    // ⚠️ A source-level check, because the alternative is spawning a real CLI and waiting out a
    // timeout. It catches the edit that matters: deleting the call and leaving the fallback, which
    // is precisely the state this file was written to fix.
    const src = readFileSync(new URL('controller.ts', import.meta.url), 'utf8')
    const timeout = src.slice(src.indexOf('if (text === null) {'))
    expect(timeout.slice(0, 200)).toContain('noteDeadConsult')
  })
})

describe('the two gate lists that drifted apart', () => {
  it('are one list, imported by both', () => {
    // ⛔ The structural half of the fix. Behaviour tests prove today's gates agree; this proves
    // nobody re-introduced a private copy tomorrow, which is how they diverged the first time.
    // ⛔ `accountRefusal` is called from `chooseTarget`, which lives in scoring.ts since t295 split
    // the scorer out of scheduler.ts — that is the file that must import the shared list now.
    const scoring = readFileSync(new URL('scoring.ts', import.meta.url), 'utf8')
    const ctrl = readFileSync(new URL('controller.ts', import.meta.url), 'utf8')
    expect(scoring).toContain("from './eligibility.js'")
    expect(ctrl).toContain("from './eligibility.js'")
  })

  it('agree on every unfit account, gate by gate', async () => {
    const { accountUnavailability } = await import('./eligibility.js')
    const worker = fit('agreement')

    const states: Array<[string, Worker]> = [
      ['disabled', { ...worker, enabled: false }],
      ['human-occupied', { ...worker, humanOccupied: true }],
      ['retired', { ...worker, retiredAt: Date.now() }],
      [
        'signed out',
        { ...worker, identity: { loggedIn: false, checkedAt: Date.now() } }
      ],
      [
        'held out',
        {
          ...worker,
          health: { state: 'suspect', reason: 'subscription expired', strikes: 1, since: 0, runId: null }
        }
      ]
    ]

    for (const [name, unfit] of states) {
      expect(accountUnavailability(unfit), name).not.toBeNull()
      // ⛔ Whatever the shared list refuses, the controller refuses. It may refuse *more* - transport,
      // rate limit, its own water mark - but never less.
      expect(controller.controllerUnavailability(unfit), name).not.toBeNull()
    }

    workers.retireWorker(worker.id)
  })
})

describe('consult sessions', () => {
  it('are projectless and run in scratch, never homedir', () => {
    const src = readFileSync(new URL('sessions.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/const projectless =.*purpose === 'consult'/)
  })
})
