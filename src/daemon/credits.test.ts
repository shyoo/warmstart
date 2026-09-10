import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CreditStatus } from '@shared/protocol.js'

/**
 * Usage credits: the two halves that have to agree, and what happens when they do not.
 *
 * ⛔ **The property under test is that money is never spent on one signal alone.** `Worker.credits`
 * is what the *vendor* says about an account; `settings.spendCreditsPastLimit` is what the
 * *operator* asked of the fleet. Standing the quota guards down on either one by itself is a
 * different bug in each direction, and both are expensive: on the switch alone the fleet stops
 * wrapping runs up on accounts that have no credits behind them, so a run meets a hard vendor
 * refusal where it would have committed and handed off; on the vendor's word alone an operator who
 * never asked for a bill starts paying one.
 *
 * ⚠️ Every input here is a row. There is no CLI and no probe — `probeSpend`'s own parsing is pinned
 * in `adapters/claude-credits.test.ts` against payloads captured off the live accounts.
 */

const ADAPTER = 'test-credits'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let clock: typeof import('./cacheclock.js')

/** Credits on, and spending. The shape `probeSpend` returns for an account past its plan limit. */
const ON: CreditStatus = {
  enabled: true,
  userDisabled: false,
  disabledReason: null,
  canToggle: false,
  everEnabled: true,
  monthlyLimit: 50,
  used: 12.5,
  currency: 'USD',
  resetsAt: null
}

/**
 * Credits off — and this is the shape both live accounts actually reported on 2026-09-07.
 *
 * ⚠️ Every money field `null`, not zero. The operator has real credits on these accounts; the vendor
 * publishes none of it while they are off.
 */
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

function seedWorker(label: string) {
  return workers.createWorker({ adapterId: ADAPTER, label, enabled: true })
}

/** A live session on this worker, which is all `mayCompact` needs to find the account. */
function seedSession(workerId: string, id = 'ef5e90dc-0000-4000-8000-0000000000c1'): string {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             context_tokens, tokens_since_compact, started_at)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(id, workerId, ADAPTER, 'stream', dir, 'live', 'work', 400_000, 300_000, Date.now())
  return id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-credits-'))
  process.env.WARMSTART_DATA_DIR = dir
  mkdirSync(join(dir, 'adapters'), { recursive: true })
  writeFileSync(
    join(dir, 'adapters', `${ADAPTER}.json`),
    JSON.stringify({
      schema_version: 1,
      id: ADAPTER,
      label: 'Test Credits CLI',
      command: 'node',
      print_args: ['-e', ''],
      version_args: ['--version'],
      isolation_env_var: 'TEST_CREDITS_HOME',
      cost_model_id: 'anthropic.subscription.2026-08',
      capabilities: { transports: ['stream', 'pty'], manualCompact: true }
    })
  )
  db = await import('./db.js')
  workers = await import('./workers.js')
  clock = await import('./cacheclock.js')
  const adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'credits.db'))
  adapters.loadAdapters()
})

beforeEach(() => {
  db.db().exec('delete from sessions; delete from workers;')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what the vendor said, stored beside what the operator asked for', () => {
  it('round-trips a reading onto the worker', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    expect(workers.getWorker(worker.id)?.credits).toEqual(ON)
  })

  /**
   * ⚠️ Written on every spend probe — every few minutes on a busy worker — so an unchanged reading
   * must not become a `worker.changed` that makes every open window refetch the fleet.
   */
  it('does not rewrite the row when the reading has not moved', () => {
    const worker = seedWorker('ClaudeFirst')
    const first = workers.setWorkerCredits(worker.id, OFF)
    const again = workers.setWorkerCredits(worker.id, OFF)
    expect(again).toEqual(first)
  })

  /** ⛔ An intent is a note about what was wanted. It enables nothing and grants nothing. */
  it('records an intent without touching the vendor reading', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, OFF)
    const after = workers.setWorkerCreditsIntent(worker.id, true)
    expect(after.creditsIntent?.asked).toBe(true)
    expect(after.credits?.enabled).toBe(false)
  })
})

describe('spendingCreditsOn — all three halves, and none alone', () => {
  it('spends only when fleet and worker both allow it and the vendor agrees', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    workers.setWorkerCreditsIntent(worker.id, true)
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), true)).toBe(true)
  })

  /**
   * ⛔ The expensive direction. A run pushed past a limit on an account with no credits behind it
   * does not get a reprieve — it gets a vendor refusal, and loses the commit and the handoff that
   * wrapping up would have produced.
   */
  it('does not spend on the fleet switch alone', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, OFF)
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), true)).toBe(false)
  })

  it('does not spend on the vendor’s word alone', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), false)).toBe(false)
  })

  it('stops an active account from spending when its worker toggle is turned off', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    workers.setWorkerCreditsIntent(worker.id, true)
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), true)).toBe(true)

    workers.setWorkerCreditsIntent(worker.id, false)
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), true)).toBe(false)
  })

  /** ⚠️ Not knowing is not permission. A worker no spend probe has read is not spending. */
  it('treats an unprobed account as not spending', () => {
    const worker = seedWorker('ClaudeFirst')
    expect(workers.spendingCreditsOn(workers.getWorker(worker.id), true)).toBe(false)
    expect(workers.spendingCreditsOn(null, true)).toBe(false)
  })
})

describe('the gap between what was asked for and what the vendor is doing', () => {
  /**
   * ⛔ The direction that costs the operator something they did not expect: they asked for credits,
   * the account is not spending them, and their runs are still being wrapped up at the limit with
   * nothing on screen to say why.
   */
  it('reports credits asked for but off, and names the vendor’s reason', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, OFF)
    workers.setWorkerCreditsIntent(worker.id, true)
    const said = workers.creditsDiscrepancy(workers.getWorker(worker.id)!)
    expect(said).toContain('org_level_disabled')
    expect(said).toContain('cannot be changed from the CLI')
  })

  /** ⚠️ Once. A question the operator has already been shown must not return on every probe. */
  it('says it once and then stops', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, OFF)
    workers.setWorkerCreditsIntent(worker.id, true)
    expect(workers.creditsDiscrepancy(workers.getWorker(worker.id)!)).not.toBeNull()
    workers.noteCreditsDiscrepancyReported(worker.id)
    expect(workers.creditsDiscrepancy(workers.getWorker(worker.id)!)).toBeNull()
  })

  it('says nothing when the vendor is doing what was asked', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    workers.setWorkerCreditsIntent(worker.id, true)
    expect(workers.creditsDiscrepancy(workers.getWorker(worker.id)!)).toBeNull()
  })

  /**
   * ⛔ The other direction is not this app's business. Credits on where none were asked for is the
   * operator's own setting on the operator's own account, and challenging it would be noise.
   */
  it('says nothing about credits being on where none were asked for', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    expect(workers.creditsDiscrepancy(workers.getWorker(worker.id)!)).toBeNull()
  })
})

describe('compaction stands down where credits are being spent — but only the quota kind', () => {
  const sessionOn = (): Parameters<typeof clock.mayCompact>[0] => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, ON)
    workers.setWorkerCreditsIntent(worker.id, true)
    return { id: seedSession(worker.id), workerId: worker.id } as Parameters<
      typeof clock.mayCompact
    >[0]
  }

  /**
   * ⛔ Quota-motivated compaction buys survival of a *window*. On an account deliberately spending
   * past that window there is nothing left to buy: the compaction still costs a real cache write and
   * still drops the context the run is working from.
   */
  it('refuses a quota-motivated compaction, and names the credits rather than the fleet switch', () => {
    expect(clock.mayCompact(sessionOn(), true, true, 'quota')).toEqual({
      allowed: false,
      source: 'credits'
    })
  })

  /**
   * ⛔ **The failure the narrower rule exists to avoid.** Nothing about buying credits makes a
   * context window bigger. A conversation compacting because it is too large to carry, or too large
   * for a queued task to borrow, is not protecting a budget — and standing that down would take the
   * one intervention that keeps a long session under its own ceiling, so the next turn fails
   * outright instead of being wrapped up. The operator's call, 2026-09-07.
   */
  it('leaves a context-motivated compaction alone on the very same account', () => {
    expect(clock.mayCompact(sessionOn(), true, true, 'context')).toEqual({
      allowed: true,
      source: 'fleet'
    })
  })

  /** ⚠️ `'quota'` is the default, so a caller that does not say gets the stand-down, not a miss. */
  it('defaults to the quota motive rather than silently opting out', () => {
    expect(clock.mayCompact(sessionOn(), true, true).source).toBe('credits')
  })

  it('leaves an ordinary account exactly as it was', () => {
    const worker = seedWorker('ClaudeFirst')
    workers.setWorkerCredits(worker.id, OFF)
    const id = seedSession(worker.id)
    const session = { id, workerId: worker.id } as Parameters<typeof clock.mayCompact>[0]
    expect(clock.mayCompact(session, true, true, 'quota')).toEqual({
      allowed: true,
      source: 'fleet'
    })
  })

  /** ⚠️ The switch off means the guards stay up, whatever the vendor says about the account. */
  it('keeps compacting a credit-enabled account while the switch is off', () => {
    expect(clock.mayCompact(sessionOn(), true, false, 'quota')).toEqual({
      allowed: true,
      source: 'fleet'
    })
  })
})
