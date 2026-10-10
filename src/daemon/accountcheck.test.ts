import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * t961: an account the vendor will not bill has to *read* as one, and stay read as one.
 *
 * ⛔ **Measured 2026-10-07 on MuseFirst.** Meta answered every model call with `402 … Billing
 * verification failed … (billing_error)`; the worker's `health_json` was null. Three gaps: the
 * 402 from a quality review was written on the review only, every Probe press lifted the hold on a
 * still-valid `auth.json`, and nothing free could see billing at all. These pin each one shut.
 *
 * ⚠️ Every input is a row in a temp database and a built-in adapter's own classifiers; no CLI runs.
 */

const BILLING_402 =
  'API error 402 [request_id=1a503b29-529c-4fc3-a931-694087b5ce53]: Billing verification failed. ' +
  'Please check your payment method. (billing_error)'

let dir: string
let workers: typeof import('./workers.js')
let check: typeof import('./accountcheck.js')
let museCode: typeof import('./adapters/muse-code.js')['museCode']

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'warmstart-accountcheck-'))
  process.env.WARMSTART_DATA_DIR = dir
  const db = await import('./db.js')
  workers = await import('./workers.js')
  check = await import('./accountcheck.js')
  museCode = (await import('./adapters/muse-code.js')).museCode
  db.openDb(join(dir, 'accountcheck.db'))
  ;(await import('./adapters/index.js')).loadAdapters()
})

afterAll(async () => {
  ;(await import('./db.js')).closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const seed = (label: string): string => workers.createWorker({ adapterId: 'muse-code', label, enabled: true }).id

describe('classifyAccountCheck', () => {
  it('reads a billing refusal as expired, even with a status code hidden in its request id', () => {
    expect(check.classifyAccountCheck(museCode, { text: BILLING_402, isError: true }).verdict).toBe('expired')
  })

  it('reads a turn the vendor ran as ok, its overload as an outage, and silence as inconclusive', () => {
    expect(check.classifyAccountCheck(museCode, { text: 'I am Muse.', isError: false }).verdict).toBe('ok')
    expect(check.classifyAccountCheck(museCode, { text: 'API error 529: overloaded', isError: true }).verdict).toBe('outage')
    expect(check.classifyAccountCheck(museCode, null).verdict).toBe('inconclusive')
    expect(check.classifyAccountCheck(museCode, { text: 'the tool crashed', isError: true }).verdict).toBe('failed')
  })
})

describe('the Muse adapter declares a check', () => {
  it('so the warm-up and Probe have a turn that can tell', () => {
    expect(museCode.info.accountCheck?.prompt).toBeTruthy()
  })
})

/**
 * t1010: the verbatim record `claude -p` returned on ClaudeSecond, 2026-10-09, after access was
 * withdrawn: `is_error: true`, `api_error_status: 403`, `total_cost_usd: 0`, while `auth status`
 * still said `loggedIn: true` and `.claude.json` still said `billingType: stripe_subscription`.
 */
const CLAUDE_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access'

describe('the Claude adapter declares a check (t1010)', () => {
  let claudeCode: typeof import('./adapters/claude-code.js')['claudeCode']
  beforeAll(async () => {
    claudeCode = (await import('./adapters/claude-code.js')).claudeCode
  })

  it('so Probe has a turn that can tell, where nothing free can', () => {
    expect(claudeCode.info.accountCheck?.prompt).toBeTruthy()
  })

  it('reads the withdrawn-access refusal as expired, not as a failure or a re-login', () => {
    const verdict = check.classifyAccountCheck(claudeCode, { text: CLAUDE_DISABLED, isError: true })
    expect(verdict.verdict).toBe('expired')
    expect(verdict.reason).toBe(CLAUDE_DISABLED)
  })

  it('still reads a turn the vendor ran as ok', () => {
    expect(check.classifyAccountCheck(claudeCode, { text: 'I am Claude.', isError: false }).verdict).toBe('ok')
  })

  it('holds the account as expired when a check refuses it', () => {
    const id = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeWithdrawn', enabled: true }).id
    check.noteTurnFailure({ workerId: id, adapterId: 'claude-code', purpose: 'review' }, { text: CLAUDE_DISABLED, isError: true })
    expect(workers.requireWorker(id).health?.subscriptionExpired).toBe(true)
  })

  it('is not spent on an account closed to work', async () => {
    const id = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeClosed', enabled: false }).id
    const result = await check.checkAccount(id, 'test')
    expect(result.verdict).toBe('inconclusive')
    expect(result.reason).toContain('disabled')
    expect(workers.requireWorker(id).health).toBeNull()
  })
})

describe('probeAsksVendor', () => {
  const info = (answer?: 'screen', accountCheck = true) =>
    ({
      ...(accountCheck ? { accountCheck: { prompt: 'p', timeoutMs: 1 } } : {}),
      usageRefresh: { command: '/usage', readyMs: 1, settleMs: 1, ...(answer ? { answer } : {}) }
    }) as Parameters<typeof check.probeAsksVendor>[0]

  it('asks where the usage refresh reads a file, so a withdrawn account cannot hide behind its cache', () => {
    expect(check.probeAsksVendor(info(), null)).toBe(true)
  })

  it('leaves a screen-answered refresh to ask for itself, unless the account is already held as expired', () => {
    expect(check.probeAsksVendor(info('screen'), null)).toBe(false)
    expect(check.probeAsksVendor(info('screen'), { subscriptionExpired: true })).toBe(true)
  })

  it('never asks an adapter that declares no check', () => {
    expect(check.probeAsksVendor(info(undefined, false), { subscriptionExpired: true })).toBe(false)
  })
})

describe('noteTurnFailure', () => {
  it('holds an account whose quality review the vendor refused to bill', () => {
    const id = seed('ReviewRefused')
    check.noteTurnFailure({ workerId: id, adapterId: 'muse-code', purpose: 'review' }, { text: BILLING_402, isError: true })
    const health = workers.requireWorker(id).health
    expect(health?.state).toBe('suspect')
    expect(health?.subscriptionExpired).toBe(true)
    expect(health?.checkedAt).toBeTypeOf('number')
  })

  it('re-confirms a hold that already says the same thing instead of re-striking it', async () => {
    const id = seed('Reconfirmed')
    const turn = { workerId: id, adapterId: 'muse-code', purpose: 'chat' }
    check.noteTurnFailure(turn, { text: BILLING_402, isError: true })
    const first = workers.requireWorker(id).health!
    await new Promise((r) => setTimeout(r, 5))
    check.noteTurnFailure(turn, { text: BILLING_402, isError: true })
    const second = workers.requireWorker(id).health!
    expect(second.since).toBe(first.since)
    expect(second.strikes).toBe(first.strikes)
    expect(second.checkedAt!).toBeGreaterThan(first.checkedAt!)
  })

  it('leaves a work run to the scheduler, which carries the run id', () => {
    const id = seed('WorkRefused')
    check.noteTurnFailure({ workerId: id, adapterId: 'muse-code', purpose: 'work' }, { text: BILLING_402, isError: true })
    expect(workers.requireWorker(id).health).toBeNull()
  })

  it('records an outage without holding the account, and a metered turn ends it', () => {
    const id = seed('Overloaded')
    check.noteTurnFailure({ workerId: id, adapterId: 'muse-code', purpose: 'work' }, { text: 'API error 529: overloaded', isError: true })
    const w = workers.requireWorker(id)
    expect(w.health).toBeNull()
    expect(w.outage?.reason).toContain('overloaded')
    workers.clearDispatchFailure(id)
    expect(workers.requireWorker(id).outage).toBeNull()
  })

  it('ignores a turn that succeeded or failed for reasons that are not the account', () => {
    const id = seed('TaskShaped')
    const turn = { workerId: id, adapterId: 'muse-code', purpose: 'review' }
    check.noteTurnFailure(turn, { text: 'done', isError: false })
    check.noteTurnFailure(turn, { text: 'the tool crashed', isError: true })
    const w = workers.requireWorker(id)
    expect(w.health).toBeNull()
    expect(w.outage).toBeNull()
  })
})

describe('an expired hold', () => {
  it('is not lifted by a Probe press on a credential file that still reads valid', async () => {
    const id = seed('ProbePressed')
    workers.recordDispatchFailure(id, BILLING_402, null)
    await workers.refreshIdentity(id, true)
    expect(workers.requireWorker(id).health?.subscriptionExpired).toBe(true)
  })

  it('is due a re-check six hours after the vendor last refused, and not before', () => {
    const id = seed('Recheck')
    workers.recordDispatchFailure(id, BILLING_402, null)
    const at = workers.requireWorker(id).health!.checkedAt!
    expect(check.expiredRecheckDue(id, at + check.RECHECK_EXPIRED_MS - 1)).toBe(false)
    expect(check.expiredRecheckDue(id, at + check.RECHECK_EXPIRED_MS)).toBe(true)
  })

  it('is never re-checked on an account held for something other than expiry', () => {
    const id = seed('OtherHold')
    workers.recordDispatchFailure(id, 'the session ended without a turn', null)
    expect(check.expiredRecheckDue(id, Date.now() + 10 * check.RECHECK_EXPIRED_MS)).toBe(false)
  })
})
