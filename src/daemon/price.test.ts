import { describe, expect, it } from 'vitest'
import { attribute, type AttributionRun, type Reading } from './price.js'

/**
 * Who owes what, when two agents shared one account.
 *
 * ⛔ **The arithmetic in here is the whole feature.** Everything else — the plan catalogue, the
 * migration, the two UI surfaces — is plumbing around this one question: a weekly window moved by
 * N%, and more than one run was open while it did. Getting it wrong is silent: the number still
 * renders, still looks like money, and is simply attributed to the wrong task.
 *
 * Every case below is a literal fixture rather than a database. The database layer above this is
 * three lookups and a memo; the decisions all live in `attribute`.
 */

const MIN = 60_000
const t = (n: number): number => 1_700_000_000_000 + n * MIN

/** Shorthand: a run over minute offsets. */
function run(id: string, from: number, to: number | null): AttributionRun {
  return { id, startedAt: t(from), endedAt: to === null ? null : t(to) }
}

function reading(at: number, percent: number, stale = false): Reading {
  return { at: t(at), percent, stale }
}

describe('splitting a window between overlapping runs', () => {
  /**
   * ⭐ **The worked example from the ask, asserted to the number.**
   *
   * task1 runs t1..t3, task2 runs t2..t4, and the weekly window reads 0 / 5 / 15 / 17% at
   * t1 / t2 / t3 / t4. The operator's own arithmetic: task1 = 5 + 10/2 = 10, task2 = 10/2 + 2 = 7.
   *
   * ⚠️ Note what the t1→t2 segment does *not* do: task2 starts exactly at t2, so its overlap with
   * that segment is zero milliseconds and it takes none of the 5%. Touching endpoints are not an
   * overlap, and a `>=` there would quietly hand task2 half of a segment it was not open for.
   */
  it('reproduces the ask’s worked example exactly', () => {
    const result = attribute(
      [run('task1', 1, 3), run('task2', 2, 4)],
      [reading(1, 0), reading(2, 5), reading(3, 15), reading(4, 17)],
      t(5)
    )
    expect(result.get('task1')!.percent).toBeCloseTo(10, 9)
    expect(result.get('task2')!.percent).toBeCloseTo(7, 9)
  })

  it('marks both sides of a shared segment as estimates, and names who they shared with', () => {
    const result = attribute(
      [run('task1', 1, 3), run('task2', 2, 4)],
      [reading(1, 0), reading(2, 5), reading(3, 15), reading(4, 17)],
      t(5)
    )
    expect(result.get('task1')!.estimated).toBe(true)
    expect(result.get('task1')!.reason).toBe('shared_window')
    expect(result.get('task1')!.parallelRunIds).toEqual(['task2'])
    expect(result.get('task2')!.parallelRunIds).toEqual(['task1'])
  })

  it('leaves a run that had the account to itself as a measurement, not an estimate', () => {
    const result = attribute([run('solo', 1, 3)], [reading(1, 10), reading(3, 16)], t(4))
    const solo = result.get('solo')!
    expect(solo.percent).toBeCloseTo(6, 9)
    expect(solo.reason).toBe('measured')
    expect(solo.estimated).toBe(false)
    expect(solo.parallelRunIds).toEqual([])
  })

  it('splits a three-way overlap three ways', () => {
    const result = attribute(
      [run('a', 0, 10), run('b', 0, 10), run('c', 0, 10)],
      [reading(0, 0), reading(10, 30)],
      t(11)
    )
    for (const id of ['a', 'b', 'c']) {
      expect(result.get(id)!.percent, id).toBeCloseTo(10, 9)
      expect(result.get(id)!.parallelRunIds.sort(), id).toEqual(
        ['a', 'b', 'c'].filter((x) => x !== id)
      )
    }
  })

  /**
   * ⛔ **Where duration weighting stops agreeing with an equal split, and why it is the right one.**
   *
   * One segment, 0→20%, over ten minutes. `long` is open for all ten; `short` joins for the last
   * two. An equal split would hand each of them 10%. The truth is much closer to 8:2 — `short` was
   * only there for a fifth of it.
   */
  it('weights a shared segment by how much of it each run was actually open for', () => {
    const result = attribute(
      [run('long', 0, 10), run('short', 8, 10)],
      [reading(0, 0), reading(10, 20)],
      t(11)
    )
    // long covers 10 of the 12 run-minutes inside the segment; short covers 2.
    expect(result.get('long')!.percent).toBeCloseTo(20 * (10 / 12), 9)
    expect(result.get('short')!.percent).toBeCloseTo(20 * (2 / 12), 9)
    expect(result.get('long')!.percent).not.toBeCloseTo(10, 3)
  })

  /**
   * ⛔ **Nobody's spend becomes somebody's spend.** Between two runs the operator uses the account
   * themselves; the window moves with nothing open. That movement is dropped. Redistributing it
   * across the runs either side would make an idle fleet look expensive, and the error grows with
   * how long it idles.
   */
  it('drops a segment no run was open for rather than sharing it out', () => {
    const result = attribute(
      [run('before', 0, 2), run('after', 8, 10)],
      [reading(0, 0), reading(2, 3), reading(8, 50), reading(10, 54)],
      t(11)
    )
    expect(result.get('before')!.percent).toBeCloseTo(3, 9)
    expect(result.get('after')!.percent).toBeCloseTo(4, 9)
    // ⚠️ The 47% that moved while nothing ran belongs to neither, and to no sum of the two.
    expect(result.get('before')!.percent! + result.get('after')!.percent!).toBeCloseTo(7, 9)
  })
})

describe('the answers that are not numbers', () => {
  /**
   * ⛔ **98% → 2% is not a refund of 96%, and it is not 2% either.** The baseline moved mid-run, so
   * what the run actually spent is unknowable — some of it before the rollover and some after, in
   * an unknown ratio. `n/a` is the only honest verdict, and it poisons *every* run across the
   * rollover, not only the one that noticed it.
   */
  it('calls a window that rolled over mid-run n/a, for every run across it', () => {
    const result = attribute(
      [run('a', 1, 4), run('b', 2, 5)],
      [reading(1, 96), reading(2, 98), reading(3, 2), reading(5, 6)],
      t(6)
    )
    expect(result.get('a')!.reason).toBe('window_reset')
    expect(result.get('a')!.percent).toBeNull()
    expect(result.get('b')!.reason).toBe('window_reset')
    expect(result.get('b')!.percent).toBeNull()
  })

  it('does not call a run n/a for a rollover that happened outside it', () => {
    const result = attribute(
      [run('later', 6, 8)],
      [reading(1, 98), reading(3, 2), reading(6, 4), reading(8, 9)],
      t(9)
    )
    expect(result.get('later')!.reason).toBe('measured')
    expect(result.get('later')!.percent).toBeCloseTo(5, 9)
  })

  it('is n/a with no reading before the run', () => {
    const result = attribute([run('r', 1, 3)], [reading(2, 5), reading(4, 9)], t(5))
    expect(result.get('r')!.reason).toBe('no_reading')
    expect(result.get('r')!.percent).toBeNull()
  })

  it('is n/a with no reading after the run', () => {
    const result = attribute([run('r', 3, 9)], [reading(1, 5), reading(2, 6)], t(10))
    expect(result.get('r')!.reason).toBe('no_reading')
  })

  it('is n/a with a single reading, which has nothing to be subtracted from', () => {
    const result = attribute([run('r', 1, 3)], [reading(2, 5)], t(4))
    expect(result.get('r')!.reason).toBe('no_reading')
  })

  it('is n/a with no readings at all', () => {
    const result = attribute([run('r', 1, 3)], [], t(4))
    expect(result.get('r')!.reason).toBe('no_reading')
  })

  /**
   * ⚠️ A gap of hours either side is not a stale anchor, it is a missing one. Anything could have
   * happened in it, including a rollover nobody saw, so the run is priced at nothing rather than
   * against a reading from yesterday.
   */
  it('is n/a when the nearest reading is half a day away', () => {
    const result = attribute([run('r', 1000, 1002)], [reading(0, 5), reading(2000, 40)], t(2001))
    expect(result.get('r')!.reason).toBe('no_reading')
  })
})

describe('when the number is right but the confidence is not', () => {
  /**
   * ⭐ The number does not move; only the `*` appears. A stale anchor is still the best evidence
   * there is — silently downgrading the *value* would be a second, invisible error on top of it.
   */
  it('marks a run anchored to a stale reading as an estimate without changing the number', () => {
    const fresh = attribute([run('r', 10, 12)], [reading(10, 4), reading(12, 9)], t(13))
    const stale = attribute(
      [run('r', 10, 12)],
      [{ ...reading(10, 4), stale: true }, reading(12, 9)],
      t(13)
    )
    expect(fresh.get('r')!.percent).toBeCloseTo(5, 9)
    expect(stale.get('r')!.percent).toBeCloseTo(5, 9)
    expect(fresh.get('r')!.estimated).toBe(false)
    expect(stale.get('r')!.estimated).toBe(true)
  })

  it('marks a run whose anchor sits far from its edge as an estimate', () => {
    // 40 minutes before the run started: past the staleness bound, well inside the hard limit.
    const result = attribute([run('r', 40, 42)], [reading(0, 4), reading(42, 9)], t(43))
    expect(result.get('r')!.percent).toBeCloseTo(5, 9)
    expect(result.get('r')!.estimated).toBe(true)
  })

  /**
   * ⛔ A run still in flight is **always** an estimate, however clean its readings look: the
   * remaining spend has not happened yet, and a number presented as final would be revised
   * downward-looking the moment the run continues.
   */
  it('prices a run that is still open, and always marks it an estimate', () => {
    const result = attribute([run('live', 1, null)], [reading(1, 10), reading(3, 14)], t(3))
    expect(result.get('live')!.percent).toBeCloseTo(4, 9)
    expect(result.get('live')!.estimated).toBe(true)
  })

  it('is n/a for a run that opened after the last reading', () => {
    const result = attribute([run('live', 9, null)], [reading(1, 10), reading(3, 14)], t(10))
    expect(result.get('live')!.reason).toBe('no_reading')
  })
})

describe('the edges', () => {
  /**
   * ⛔ **A window that did not move is $0.00, not n/a.** The run was measured; the measurement was
   * zero. Collapsing this into the same dash as "nobody read the window" would throw away the one
   * case where the tool can say something cheerful and exact.
   */
  it('gives a run that moved the window by nothing a real zero', () => {
    const result = attribute([run('r', 1, 3)], [reading(1, 12), reading(3, 12)], t(4))
    expect(result.get('r')!.percent).toBe(0)
    expect(result.get('r')!.reason).toBe('measured')
  })

  it('never reports a negative share, whatever rounding the vendor did', () => {
    const result = attribute(
      [run('r', 1, 3)],
      [reading(1, 12), { at: t(2), percent: 11.9995 }, reading(3, 12)],
      t(4)
    )
    // 11.9995 is inside the epsilon, so it is rounding rather than a rollover — and it is clamped.
    expect(result.get('r')!.reason).toBe('measured')
    expect(result.get('r')!.percent).toBe(0)
  })

  it('tolerates readings arriving out of order and duplicated', () => {
    const result = attribute(
      [run('r', 1, 3)],
      [reading(3, 15), reading(1, 10), reading(3, 15), reading(1, 10)],
      t(4)
    )
    expect(result.get('r')!.percent).toBeCloseTo(5, 9)
  })

  it('prefers a fresh reading to a stale one taken at the same instant', () => {
    const result = attribute(
      [run('r', 1, 3)],
      [{ ...reading(1, 10), stale: true }, reading(1, 10), reading(3, 15)],
      t(4)
    )
    expect(result.get('r')!.estimated).toBe(false)
  })

  it('answers for every run it was handed, and only those', () => {
    const result = attribute([run('a', 1, 3), run('b', 90, 92)], [reading(1, 1), reading(3, 2)], t(4))
    expect([...result.keys()].sort()).toEqual(['a', 'b'])
    expect(result.get('b')!.reason).toBe('no_reading')
  })
})
