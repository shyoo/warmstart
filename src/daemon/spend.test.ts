import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SpendSnapshot } from '@shared/protocol.js'
import { claudeCode } from './adapters/claude-code.js'

/**
 * The money store, and the two rules it exists to keep.
 *
 * ⛔ **A probe that ran and found nothing is a fact.** Every honesty rule in `quota.ts` applies here
 * for the same reason it applies there: a gap in the series is indistinguishable from a healthy
 * quiet period, and a balance read as `0` when the vendor published nothing is a sentence — *this
 * account is out of money* — that nobody measured.
 *
 * ⛔ **A failing money probe must never cost the account its quota reading.** They ride one pacing
 * loop by design (`probeWorker`), which is exactly what makes an adapter that breaks its own
 * best-effort contract able to take the window down with it if nothing stands in the way.
 */

let dir: string
let db: typeof import('./db.js')
let spend: typeof import('./spend.js')
let quota: typeof import('./quota.js')
let workers: typeof import('./workers.js')
let price: typeof import('./price.js')
let tasks: typeof import('./tasks.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-spend-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  spend = await import('./spend.js')
  quota = await import('./quota.js')
  workers = await import('./workers.js')
  price = await import('./price.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'spend.db'))
})

beforeEach(() => {
  db.db().exec(
    'delete from spend_samples; delete from quota_samples; delete from runs; delete from tasks; delete from workers'
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

/** ⚠️ Disabled, so nothing in this file can reach a real CLI on the machine running it. */
function worker(adapterId = 'openai-compatible'): string {
  return workers.createWorker({ adapterId, label: `w-${adapterId}`, enabled: false }).id
}

const purse = (
  balance: number | null,
  at: number,
  extra: Partial<Omit<SpendSnapshot, 'workerId'>> = {}
): Omit<SpendSnapshot, 'workerId'> => ({
  meters: [
    {
      id: 'codex_credits',
      label: 'Codex credits',
      unit: 'credits',
      balance,
      direction: 'balance_falls',
      usdPerUnit: null
    }
  ],
  sampledAt: at,
  source: 'config-cache',
  ...extra
})

describe('recording what a meter read', () => {
  it('round-trips a meter, its direction and its missing conversion', () => {
    const w = worker()
    expect(spend.recordSpendSample(w, purse(412, 1_000))).toBe(1)

    const last = spend.lastSpend(w)
    expect(last?.sampledAt).toBe(1_000)
    expect(last?.source).toBe('config-cache')
    expect(last?.meters).toEqual([
      {
        id: 'codex_credits',
        label: 'Codex credits',
        unit: 'credits',
        balance: 412,
        direction: 'balance_falls',
        // ⛔ `null`, not 1. A credit with no published conversion is real and unpriceable, and the
        // moment this becomes a number somebody's bill contains one this fleet invented.
        usdPerUnit: null
      }
    ])
  })

  it('keeps a probe that ran and found nothing, with its reason and no balance', () => {
    const w = worker()
    spend.recordSpendSample(w, {
      meters: [],
      sampledAt: 2_000,
      source: 'config-cache',
      error: 'codex reports unlimited credits, so there is no purse to meter'
    })

    const last = spend.lastSpend(w)
    // ⛔ No meters — inventing one for an unlimited account would draw a purse that never moves,
    // which reads exactly like a purse nobody is spending from.
    expect(last?.meters).toEqual([])
    expect(last?.error).toMatch(/unlimited credits/)
    expect(last?.sampledAt).toBe(2_000)
    // ⚠️ And the row is really there: the *only* evidence this account was ever asked.
    const n = db.db().prepare('select count(*) as n from spend_samples where worker_id = ?').get(w) as {
      n: number
    }
    expect(n.n).toBe(1)
  })

  it('does not write a second row for a reading it already has', () => {
    // ⚠️ A `config-cache` meter on an idle account answers the identical (meter, vendor timestamp)
    // pair on every poll. Storing it again would grow the series without adding information — the
    // failure that made the fleet strip sprout a duplicate quota window every five minutes.
    const w = worker()
    expect(spend.recordSpendSample(w, purse(412, 1_000))).toBe(1)
    expect(spend.recordSpendSample(w, purse(412, 1_000))).toBe(0)
    expect(spend.spendSeries(w, 'codex_credits')).toEqual([{ balance: 412, at: 1_000 }])
  })

  it('bumps the pricing epoch on a new reading, and only on a new one', () => {
    // ⛔ A reading moves a segment boundary, which changes what **every** run open across it is
    // answerable for. ⚠️ And a re-read changes nothing, so invalidating the memo for one would be a
    // recompute of the whole fleet's prices every five minutes for no new fact.
    const w = worker()
    const before = price.pricingEpoch()
    spend.recordSpendSample(w, purse(412, 1_000))
    const afterWrite = price.pricingEpoch()
    expect(afterWrite).not.toBe(before)

    spend.recordSpendSample(w, purse(412, 1_000))
    expect(price.pricingEpoch()).toBe(afterWrite)
  })

  it('reports the newest probe even when the newest probe failed', () => {
    // ⚠️ The inversion worth pinning. Answering with the last *good* reading would put a balance
    // from an hour ago on screen as though it were current — the reading is stale and the honest
    // answer says so, which is what `ageMs` and `error` are for.
    const w = worker()
    spend.recordSpendSample(w, purse(412, 1_000))
    spend.recordSpendSample(w, {
      meters: [],
      sampledAt: 5_000,
      source: 'unknown',
      error: 'the spend probe threw: nope'
    })
    const last = spend.lastSpend(w)
    expect(last?.sampledAt).toBe(5_000)
    expect(last?.meters).toEqual([])
    expect(last?.error).toMatch(/threw/)
  })

  it('leaves a balance-less row out of the series rather than reading it as zero', () => {
    const w = worker()
    spend.recordSpendSample(w, purse(412, 1_000))
    spend.recordSpendSample(w, purse(null, 2_000))
    spend.recordSpendSample(w, purse(398, 3_000))
    // ⛔ Two readings, not three. A meter the vendor declined to number is not a purse at zero, and
    // a series that read it as one would publish a $412 fall and a $398 top-up that never happened.
    expect(spend.spendSeries(w, 'codex_credits')).toEqual([
      { balance: 412, at: 1_000 },
      { balance: 398, at: 3_000 }
    ])
  })

  it('says nothing at all about a worker nobody has probed', () => {
    expect(spend.lastSpend(worker())).toBeNull()
  })
})

describe('probing beside the quota probe', () => {
  it('asks nothing of an adapter whose money arrives on the stream', async () => {
    // ⛔ `stream` is not a probe. Claude Code's dollars ride a turn already being paid for, and a
    // poller asking again would be a second and costlier route to a fact already in hand.
    const w = worker('claude-code')
    let asked = 0
    const written = await spend.probeSpendFor(w, {
      info: { capabilities: { spendProbe: 'stream' } },
      probeSpend: async () => {
        asked += 1
        return { meters: [], sampledAt: 1, source: 'stream' }
      }
    })
    expect(asked).toBe(0)
    expect(written).toBe(0)
    expect(spend.lastSpend(w)).toBeNull()
  })

  it('records a throwing probe as a failed reading rather than propagating it', async () => {
    const w = worker()
    const written = await spend.probeSpendFor(w, {
      info: { capabilities: { spendProbe: 'config-cache' } },
      probeSpend: async () => {
        throw new Error('the adapter broke its own contract')
      }
    })
    expect(written).toBe(1)
    const last = spend.lastSpend(w)
    expect(last?.meters).toEqual([])
    expect(last?.error).toMatch(/broke its own contract/)
  })

  it('leaves the quota reading beside it untouched when the spend probe throws', async () => {
    // ⭐ **The whole reason the two share a pacing loop needs this to be true.** A money probe that
    // takes the window reading down with it would trade a number nothing depends on for the number
    // every routing decision, gate and reserve is computed from.
    const w = worker()
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at, window_group)
         values (?, '5h', '5h', 41, null, 'cli', null, ?, null)`
      )
      .run(w, 4_000)

    await spend.probeSpendFor(w, {
      info: { capabilities: { spendProbe: 'config-cache' } },
      probeSpend: async () => {
        throw new Error('nope')
      }
    })

    const reading = quota.lastQuota(w)
    expect(reading?.windows).toEqual([{ id: '5h', label: '5h', percent: 41, resetsAt: null }])
    expect(reading?.sampledAt).toBe(4_000)
  })
})

/**
 * The two Claude Code stream signals, both of which used to be decoded and dropped.
 *
 * ⛔ They are money, and they are the only statements of it this fleet ever gets: `total_cost_usd`
 * on the `result` record, and `isUsingOverage` / `overageStatus` on the `rate_limit_event`. Both
 * ride a turn already being paid for, which is why claude-code declares `spendProbe: 'stream'` and
 * has no probe at all.
 */
describe("the stream's money signals", () => {
  const openRun = (): { sessionId: string; runId: string } => {
    const w = worker('claude-code')
    const task = tasks.createTask({ title: 'something to bill' })
    const sessionId = `sess-${task.id}`
    const run = tasks.startRun({
      taskId: task.id,
      workerId: w,
      sessionId,
      projectId: null,
      quotaUnverified: false,
      costModelId: 'anthropic.subscription.2026-08'
    })
    return { sessionId, runId: run.id }
  }

  const listUsd = (runId: string): number | null =>
    (db.db().prepare('select list_usd from runs where id = ?').get(runId) as { list_usd: number | null })
      .list_usd

  const overage = (runId: string): { on_overage: number | null; overage_status: string | null } =>
    db.db().prepare('select on_overage, overage_status from runs where id = ?').get(runId) as {
      on_overage: number | null
      overage_status: string | null
    }

  it('leaves the list price at the second result, never at the sum of two', () => {
    // ⛔ **The double-count this replaces exists to prevent.** `total_cost_usd` is cumulative for
    // the invocation, exactly as the `usage` record's counters are cumulative for a turn. A session
    // that emits two results has spent the second number, not their total — and adding would be
    // wrong in the expensive direction on every multi-result session there has ever been.
    const { sessionId, runId } = openRun()
    tasks.creditRunListUsd(sessionId, 0.41)
    tasks.creditRunListUsd(sessionId, 0.77)
    expect(listUsd(runId)).toBe(0.77)
  })

  it('writes nothing when the vendor reported no cost, rather than writing zero', () => {
    // ⚠️ `null` is *the vendor said nothing*. Storing 0 would claim the turn was free, which is a
    // measurement nobody took — and `RunPrice` keeps "unmeasured" and "free" apart everywhere else.
    const { sessionId, runId } = openRun()
    tasks.creditRunListUsd(sessionId, null)
    expect(listUsd(runId)).toBeNull()
  })

  it('marks the run that was open when the vendor said it was on overage', () => {
    const { sessionId, runId } = openRun()
    tasks.markRunOverage(sessionId, { isUsingOverage: true, overageStatus: 'active' })
    expect(overage(runId)).toEqual({ on_overage: 1, overage_status: 'active' })
  })

  it('leaves a run the vendor said nothing about at null, which is not false', () => {
    // ⛔ The distinction the whole column rests on. `0` means *it told us this run was not on
    // overage*; `null` means *it never said*. Collapsing them would turn every un-instrumented run
    // into positive evidence that no extra-usage money was spent on it.
    const { runId } = openRun()
    expect(overage(runId)).toEqual({ on_overage: null, overage_status: null })
  })

  it('does not blank a boolean with an event that carried only a status', () => {
    const { sessionId, runId } = openRun()
    tasks.markRunOverage(sessionId, { isUsingOverage: true, overageStatus: 'active' })
    tasks.markRunOverage(sessionId, { overageStatus: 'allowed_warning' })
    expect(overage(runId)).toEqual({ on_overage: 1, overage_status: 'allowed_warning' })
  })

  it('swallows both quietly when the session has no open run', () => {
    // ⚠️ Both records can arrive after the run has been closed — a finish, a cancel, a wrap-up.
    // Inventing a run to hold the number would be worse than losing it.
    const { sessionId, runId } = openRun()
    tasks.finishRun(runId, 'completed')
    expect(() => tasks.creditRunListUsd(sessionId, 1.23)).not.toThrow()
    expect(() => tasks.markRunOverage(sessionId, { isUsingOverage: true })).not.toThrow()
    expect(listUsd(runId)).toBeNull()
    expect(overage(runId).on_overage).toBeNull()
  })

  it('bumps the pricing epoch on both, because both change what a run cost', () => {
    const { sessionId } = openRun()
    const before = price.pricingEpoch()
    tasks.creditRunListUsd(sessionId, 0.5)
    const middle = price.pricingEpoch()
    expect(middle).not.toBe(before)
    tasks.markRunOverage(sessionId, { isUsingOverage: false })
    expect(price.pricingEpoch()).not.toBe(middle)
  })

  it('declares a stream meter rather than a probe, so nothing polls for it', () => {
    expect(claudeCode.info.capabilities.spendProbe).toBe('stream')
    // ⛔ And carries no `probeSpend`: a second route to a number already in hand is a costlier one.
    expect(claudeCode.probeSpend).toBeUndefined()
  })
})
