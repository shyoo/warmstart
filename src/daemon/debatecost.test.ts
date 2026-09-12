import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DebateSeat } from '@shared/tasks.js'

/**
 * What a debate would cost, before one exists.
 *
 * ⛔ **The renderer does not compute money**, so the arithmetic the cost notice prints is proved
 * here rather than in a component test. Two rules carry the weight: money is `null` — never
 * `$0.00` — the moment any contributing estimate could not be priced, and the heterogeneity count
 * is taken on the **adapter**, so two Claude models read as one family.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let debatecost: typeof import('./debatecost.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-debatecost-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  debatecost = await import('./debatecost.js')
  db.openDb(join(dir, 'debatecost.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

let seq = 0
function account(adapterId: string, maxConcurrent = 1): string {
  seq += 1
  return workers.createWorker({ adapterId, label: `debate-${adapterId}-${seq}`, maxConcurrent }).id
}

const seat = (workerId: string, model?: string): DebateSeat => ({
  workerId,
  model: model ?? null,
  effort: null
})

describe('the cost preview', () => {
  it('prices N seats × R rounds plus the organizer’s turns, and says so in the basis', () => {
    const a = account('claude-code')
    const b = account('openai-compatible')
    const one = debatecost.debatePreview({
      title: 'which cache do we use',
      seats: [seat(a), seat(b)],
      rounds: 1,
      organizerWorkerId: a
    })
    const three = debatecost.debatePreview({
      title: 'which cache do we use',
      seats: [seat(a), seat(b)],
      rounds: 3,
      organizerWorkerId: a
    })
    expect(one.seatCount).toBe(2)
    // ⚠️ Three rounds is three times one round, seats and organizer alike — the honest arithmetic
    // for a feature whose own literature says it is often not worth it.
    expect(three.totalTokens).toBe(one.totalTokens * 3)
    expect(three.basis).toContain('2 seat(s) × 3 round(s)')
    expect(three.basis).toContain('3 organizer turn(s)')
  })

  // ⚠️ The headline the operator actually reads: how many times the same question asked *once* of
  // the organizer's own agent this debate is.
  it('reports the multiple against the same question asked once', () => {
    const a = account('claude-code')
    const preview = debatecost.debatePreview({
      title: 'q',
      seats: [seat(a), seat(a)],
      rounds: 2,
      organizerWorkerId: a
    })
    // Two seats and the organizer, twice: six turns of the same size.
    expect(preview.multiple).toBeCloseTo(6, 5)
  })

  /**
   * ⛔ **`null` money with `usdConfidence: 'none'`, never `$0.00`.** A partial sum presented as a
   * total is the `$0.00`-for-`n/a` mistake wearing a different hat, and this fleet has nothing
   * metered, so nothing here can be priced.
   */
  it('answers null money rather than zero where nothing behind it could be priced', () => {
    const a = account('claude-code')
    const preview = debatecost.debatePreview({
      title: 'q',
      seats: [seat(a), seat(a)],
      rounds: 2,
      organizerWorkerId: a
    })
    expect(preview.totalUsd).toBeNull()
    expect(preview.perSeatUsd).toBeNull()
    expect(preview.usdConfidence).toBe('none')
    // ⚠️ And the token answer still stands: an unpriceable fleet is not a fleet with no estimate.
    expect(preview.totalTokens).toBeGreaterThan(0)
    // ⚠️ And `confidence` says so: nothing on this fleet has been metered, so the token answer is
    // the deliberately pessimistic fallback rather than a measurement. `unknown` is a verdict.
    expect(preview.confidence).toBe('none')
  })

  // ⛔ The weakest contributing answer decides, because a total is only as good as its worst term.
  it('takes the weaker confidence of everything it added up', () => {
    const a = account('claude-code')
    const preview = debatecost.debatePreview({ title: 'q', seats: [seat(a)], rounds: 1, organizerWorkerId: a })
    expect(preview.confidence).toBe('none')
    expect(preview.usdConfidence).toBe('none')
    // ⚠️ Nothing here rests on an assumed cache multiplier, because nothing here was measured at
    // all — `assumed` is about a priced answer built on a guessed factor, not about a missing one.
    expect(preview.assumed).toBe(false)
  })
})

describe('the heterogeneity count', () => {
  /**
   * ⛔ **Counted on the adapter, not the model name.** Published work finds cross-*family* pairs
   * are what carry debate's gain and same-family pairs show minimal gains, so two Claude models
   * are one family however different their ids look.
   */
  it('reads two models of one adapter as one family', () => {
    const a = account('claude-code')
    const preview = debatecost.debatePreview({
      title: 'q',
      seats: [seat(a, 'claude-opus-5'), seat(a, 'claude-haiku-4-5-20251001')],
      rounds: 1,
      organizerWorkerId: a
    })
    expect(preview.adapterSpread).toBe(1)
  })

  it('reads two adapters as two families', () => {
    const preview = debatecost.debatePreview({
      title: 'q',
      seats: [seat(account('claude-code')), seat(account('openai-compatible'))],
      rounds: 1
    })
    expect(preview.adapterSpread).toBe(2)
  })

  it('counts nothing for an account this fleet has forgotten', () => {
    const preview = debatecost.debatePreview({
      title: 'q',
      seats: [seat('w-gone'), seat('w-also-gone')],
      rounds: 1
    })
    expect(preview.adapterSpread).toBe(0)
  })
})

describe('how many seats can actually be in flight at once', () => {
  /**
   * ⛔ **Said out loud, never silently corrected**, in the same voice `poolIsNarrow` uses for the
   * workspace pool. `maxConcurrent` commissions at 1, so on the commonest install — one account —
   * a three-seat debate is three serial runs. That is a fact about the fleet, not a bug to route
   * around, and the composer states it next to the seat count.
   */
  it('reports one when three seats share one single-slot account', () => {
    const a = account('claude-code', 1)
    expect(debatecost.parallelSeatsFor([seat(a), seat(a), seat(a)], null)).toBe(1)
  })

  it('reports the account’s own concurrency when it has room', () => {
    const a = account('claude-code', 3)
    expect(debatecost.parallelSeatsFor([seat(a), seat(a), seat(a)], null)).toBe(3)
    // ⚠️ Never more seats than there are: a slot nobody is sitting in is not parallelism.
    expect(debatecost.parallelSeatsFor([seat(a), seat(a)], null)).toBe(2)
  })

  it('adds up across accounts, because two accounts are two windows', () => {
    const a = account('claude-code', 1)
    const b = account('openai-compatible', 1)
    expect(debatecost.parallelSeatsFor([seat(a), seat(b)], null)).toBe(2)
  })

  // ⚠️ The honest reading of an unknown is *at least one*; zero would report a debate that can
  // never start.
  it('gives an unknown account one slot rather than none', () => {
    expect(debatecost.parallelSeatsFor([seat('w-gone'), seat('w-gone-too')], null)).toBe(2)
  })

  it('is zero for an empty roster and never negative', () => {
    expect(debatecost.parallelSeatsFor([], null)).toBe(0)
  })
})
