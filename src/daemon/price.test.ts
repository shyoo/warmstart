import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attribute, type AttributionRun, type Reading } from './price.js'
import { costModel } from './costmodel.js'

/**
 * Who owes what, when two agents shared one account.
 *
 * ⛔ **The arithmetic in here is the whole feature.** Everything else — the plan catalogue, the
 * migration, the two UI surfaces — is plumbing around this one question: a weekly window moved by
 * N%, and more than one run was open while it did. Getting it wrong is silent: the number still
 * renders, still looks like money, and is simply attributed to the wrong task.
 *
 * Every case about *whose share is whose* is a literal fixture rather than a database: the
 * decisions all live in `attribute`, and it is a pure function of readings and run edges. The one
 * block at the bottom that opens a database is there because the thing it asserts — that `usd` is
 * the sum of the two money layers and that the API list price stayed out of it — is a property of
 * the pass that reads rows, and asserting it against a hand-built object would only be asserting
 * the test's own arithmetic.
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

  it('keeps a run priceable when a panel corrects a percentage downward by less than a reset', () => {
    // Observed on t207: the Antigravity Gemini weekly panel said 41.69%, then 41.61% six seconds
    // after the run ended. Treating that 0.08-point correction as a reset discarded the valid
    // 39.72% -> 41.69% movement and rendered its price n/a.
    const result = attribute(
      [run('t207', 0, 60)],
      [reading(0, 39.72), reading(45, 41.69), reading(60, 41.61)],
      t(61)
    )
    const priced = result.get('t207')!
    expect(priced.percent).toBeCloseTo(1.97, 9)
    expect(priced.reason).toBe('measured')
    expect(priced.estimated).toBe(true)
  })

  it('still rejects a two-point fall as a reset rather than smoothing it away', () => {
    const result = attribute([run('reset', 0, 60)], [reading(0, 40), reading(60, 38)], t(61))
    expect(result.get('reset')!.reason).toBe('window_reset')
    expect(result.get('reset')!.percent).toBeNull()
  })

  /**
   * ⛔ **A run the readings only partly cover is priced from the part they cover, not discarded.**
   * The series starts a minute into this run, so the first minute is unmeasured — but the movement
   * after it was read, really happened, and really belongs to this run. See the block below.
   */
  it('prices from the first reading when the run began before the series did', () => {
    const result = attribute([run('r', 1, 3)], [reading(2, 5), reading(4, 9)], t(5))
    expect(result.get('r')!.reason).toBe('measured')
    expect(result.get('r')!.percent).toBeCloseTo(4, 9)
    expect(result.get('r')!.estimated).toBe(true)
    expect(result.get('r')!.unmeasuredMs).toBe(MIN)
  })

  it('is n/a when every reading predates the run, so nothing was read while it ran', () => {
    const result = attribute([run('r', 3, 9)], [reading(1, 5), reading(2, 6)], t(10))
    expect(result.get('r')!.reason).toBe('no_reading')
    expect(result.get('r')!.percent).toBeNull()
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

/**
 * The bug t210 found: a finished run whose account was never read again after it ended.
 *
 * ⛔ **The closing reading carries the *vendor's* timestamp, not ours.** `captureQuotaAfter` asks
 * the CLI for a fresh reading when a run finishes, and what comes back is whatever that vendor's
 * own panel last computed — which is routinely a minute or two old. So a run that ended at 20:50:28
 * stores an `after` reading stamped 20:48:44, and demanding a reading at-or-after the run's end
 * threw the whole run away. Measured on this install 2026-09-04: t210 moved `weekly_all` from 18%
 * to 22% entirely inside its own span and priced `n/a`.
 *
 * ⛔ **This is a lower bound, and it is the only reason `estimated` is set that has a direction.**
 * A shared or stale share is imprecise about a movement that *was* read; this one is short of a
 * stretch nobody read, so the truth is this or more, never less. `unmeasuredMs` carries how much,
 * and `price.ts` puts it in the basis rather than letting a reader take the number for the whole run.
 */
describe('a run the readings only partly cover', () => {
  it('prices the measured part when nothing was read after the run ended', () => {
    // The run ends at t10; the last reading is at t8. Two minutes of tail nobody read.
    const result = attribute([run('r', 0, 10)], [reading(0, 18), reading(8, 22)], t(11))
    const r = result.get('r')!
    expect(r.reason).toBe('measured')
    expect(r.percent).toBeCloseTo(4, 9)
    expect(r.estimated).toBe(true)
    expect(r.unmeasuredMs).toBe(2 * MIN)
  })

  it('is exactly the t210 shape, to the number', () => {
    // ⭐ The real readings: weekly_all 18 -> 21 -> 22 -> 22 while one run held the account, and the
    // run outlived the last of them. 18 -> 22 is four points, and every one of them is this run's.
    const result = attribute(
      [{ id: 't210', startedAt: t(0.42), endedAt: t(32.5) }],
      [reading(0, 18), reading(19.7, 21), reading(25.2, 22), reading(30.7, 22)],
      t(40)
    )
    const r = result.get('t210')!
    expect(r.percent).toBeCloseTo(4, 9)
    expect(r.reason).toBe('measured')
    expect(r.estimated).toBe(true)
    expect(r.unmeasuredMs).toBeGreaterThan(0)
  })

  it('counts the head and the tail together, so a run short at both ends says so once', () => {
    const result = attribute([run('r', 0, 10)], [reading(2, 5), reading(7, 9)], t(11))
    const r = result.get('r')!
    expect(r.percent).toBeCloseTo(4, 9)
    // 2 minutes before the series began, 3 after it ended.
    expect(r.unmeasuredMs).toBe(5 * MIN)
    expect(r.estimated).toBe(true)
  })

  it('leaves a run the readings cover end to end an unqualified measurement', () => {
    const r = attribute([run('r', 1, 3)], [reading(1, 10), reading(3, 16)], t(4)).get('r')!
    expect(r.unmeasuredMs).toBe(0)
    expect(r.estimated).toBe(false)
    expect(r.reason).toBe('measured')
  })

  /**
   * ⛔ The bound is `ANCHOR_MAX_MS` — the same twelve hours that already refuse a run anchored to
   * yesterday's reading, and for the same reason. Past it the measured slice stops being a useful
   * lower bound on the whole run, and a number is worse than a dash.
   */
  it('refuses when more of the run went unread than a reading may be old', () => {
    const thirteenHours = 13 * 60
    const result = attribute(
      [run('r', 0, thirteenHours)],
      [reading(0, 10), reading(30, 14)],
      t(thirteenHours + 1)
    )
    expect(result.get('r')!.reason).toBe('no_reading')
    expect(result.get('r')!.percent).toBeNull()
  })

  it('prices an eleven-hour tail, because eleven is inside the bound and the movement is real', () => {
    const elevenHours = 11 * 60
    const result = attribute(
      [run('r', 0, elevenHours)],
      [reading(0, 10), reading(30, 14)],
      t(elevenHours + 1)
    )
    expect(result.get('r')!.percent).toBeCloseTo(4, 9)
    expect(result.get('r')!.estimated).toBe(true)
  })

  /**
   * ⛔ **The property that makes this fix safe to apply to eight days of history.** Clamping a
   * span to the series changes no arithmetic for a run the series already covered: segments only
   * exist between readings, so an overlap was already bounded by those same two instants. The fix
   * can only turn an `n/a` into a number — it can never move one that was already there.
   *
   * ⚠️ Verified against the live database on 2026-09-04 as well as here: of 378 runs, exactly two
   * changed, both from `no_reading` to a price, and not one already-priced run moved by a cent.
   */
  it('does not move a run the readings already covered, whatever else is in the series', () => {
    const runs = [run('a', 10, 20), run('b', 15, 25)]
    const covered = [reading(5, 0), reading(12, 4), reading(18, 9), reading(30, 17)]
    const withTail = attribute(runs, covered, t(40))
    // The same runs, with a later reading appended and an earlier one prepended: the series now
    // extends past both edges in both directions, and the shares must be identical.
    const wider = attribute(runs, [reading(-100, 0), ...covered, reading(200, 17)], t(400))
    for (const id of ['a', 'b']) {
      expect(wider.get(id)!.percent).toBeCloseTo(withTail.get(id)!.percent!, 9)
      expect(withTail.get(id)!.unmeasuredMs).toBe(0)
    }
  })

  it('still splits a truncated run share with whoever held the window beside it', () => {
    const result = attribute(
      [run('a', 0, 10), run('b', 0, 10)],
      [reading(0, 10), reading(6, 16)],
      t(11)
    )
    expect(result.get('a')!.percent).toBeCloseTo(3, 9)
    expect(result.get('b')!.percent).toBeCloseTo(3, 9)
    expect(result.get('a')!.reason).toBe('shared_window')
    expect(result.get('a')!.unmeasuredMs).toBe(4 * MIN)
  })

  it('reports a window that rolled over as a reset, not as a cheap truncated run', () => {
    // ⛔ The reset check runs on the segments, so truncating the span must not smuggle a rollover
    // past it: a run across a reset is `n/a` whether or not its tail was read.
    const result = attribute([run('r', 0, 20)], [reading(0, 90), reading(10, 3)], t(21))
    expect(result.get('r')!.reason).toBe('window_reset')
    expect(result.get('r')!.percent).toBeNull()
  })

  it('is n/a when a truncated run remaining anchor is still half a day stale', () => {
    // The series covers the run's start but the next reading is 20 hours later: the movement
    // between them could hide anything, and that judgment is unchanged by this fix.
    const result = attribute([run('r', 0, 2)], [reading(-1, 5), reading(20 * 60, 40)], t(21 * 60))
    expect(result.get('r')!.reason).toBe('no_reading')
  })

  it('keeps an open run own rule: nothing read since it started is n/a, not a zero', () => {
    const result = attribute([run('live', 9, null)], [reading(1, 10), reading(3, 14)], t(10))
    expect(result.get('live')!.reason).toBe('no_reading')
    expect(result.get('live')!.percent).toBeNull()
  })

  it('treats a credit purse the same way, because it is the same algorithm', () => {
    // A meter that falls as money is spent: 100 -> 94 while the run held it, and the run outlived
    // the last reading. Six credits spent, and the tail is unmeasured.
    const result = attribute(
      [run('r', 0, 10)],
      [reading(0, 100), reading(6, 94)],
      t(11),
      { direction: 'falls' }
    )
    expect(result.get('r')!.percent).toBeCloseTo(6, 9)
    expect(result.get('r')!.unmeasuredMs).toBe(4 * MIN)
    expect(result.get('r')!.estimated).toBe(true)
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

describe('the same split, on a purse that falls instead of a window that rises', () => {
  /**
   * ⭐ **The worked example again, upside down, asserted to the number.**
   *
   * A credit purse is the mirror of a quota window: it *falls* as money is spent. The same two
   * overlapping runs, and a balance reading 100 / 95 / 85 / 83 credits at t1 / t2 / t3 / t4 — the
   * same 0 / 5 / 15 / 17 of spend, counted downwards. task1 = 5 + 10/2 = 10, task2 = 10/2 + 2 = 7,
   * exactly as before.
   *
   * ⛔ This is one algorithm and not two. If these numbers ever stop matching the rising case's,
   * the direction has leaked past the one place that normalises it.
   */
  it('reproduces the worked example on a falling series, to the same numbers', () => {
    const result = attribute(
      [run('task1', 1, 3), run('task2', 2, 4)],
      [reading(1, 100), reading(2, 95), reading(3, 85), reading(4, 83)],
      t(5),
      { direction: 'falls' }
    )
    expect(result.get('task1')!.percent).toBeCloseTo(10, 9)
    expect(result.get('task2')!.percent).toBeCloseTo(7, 9)
    expect(result.get('task1')!.reason).toBe('shared_window')
    expect(result.get('task2')!.parallelRunIds).toEqual(['task1'])
  })

  /**
   * ⛔ **A top-up is a rollover.** $40 of credit arriving mid-run hides however much was spent
   * either side of it, in an unknown ratio — the same fact a weekly window resetting from 98% to 2%
   * states about a rising series. It poisons every run across it, and the verdict keeps the
   * `window_reset` name a UI already renders even though no window was involved.
   */
  it('calls a purse that was topped up mid-run n/a, for every run across it', () => {
    const result = attribute(
      [run('a', 1, 4), run('b', 2, 5)],
      [reading(1, 20), reading(2, 12), reading(3, 90), reading(5, 86)],
      t(6),
      { direction: 'falls' }
    )
    expect(result.get('a')!.reason).toBe('window_reset')
    expect(result.get('a')!.percent).toBeNull()
    expect(result.get('b')!.reason).toBe('window_reset')
    expect(result.get('b')!.percent).toBeNull()
  })

  it('does not call a run n/a for a top-up that happened outside it', () => {
    const result = attribute(
      [run('later', 6, 8)],
      [reading(1, 4), reading(3, 90), reading(6, 88), reading(8, 83)],
      t(9),
      { direction: 'falls' }
    )
    expect(result.get('later')!.reason).toBe('measured')
    expect(result.get('later')!.percent).toBeCloseTo(5, 9)
  })

  /**
   * ⛔ **The default is the guarantee.** Every existing caller passes no options, and a rising
   * series has to come out of this function exactly as it did before it learned about purses.
   */
  it('leaves a rising series untouched when no direction is asked for', () => {
    const readings = [reading(1, 0), reading(2, 5), reading(3, 15), reading(4, 17)]
    const runs = [run('task1', 1, 3), run('task2', 2, 4)]
    const implicit = attribute(runs, readings, t(5))
    const explicit = attribute(runs, readings, t(5), { direction: 'rises' })
    expect(implicit.get('task1')!.percent).toBeCloseTo(10, 9)
    expect(explicit.get('task1')!.percent).toBeCloseTo(10, 9)
    // ⚠️ And a falling reading of the *same* series is a rollover, not a negative cost.
    expect(attribute(runs, readings, t(5), { direction: 'falls' }).get('task1')!.reason).toBe(
      'window_reset'
    )
  })
})

describe('turning a meter movement into money', () => {
  const cm = costModel('anthropic.subscription.2026-08')

  it('takes a dollar meter at face value', () => {
    expect(cm.priceOfMeterUsage({ id: 'm', label: 'Extra usage', unit: 'usd', usdPerUnit: 1 }, 0.75)!.usd)
      .toBeCloseTo(0.75, 9)
  })

  it('converts credits at the vendor’s published rate', () => {
    const priced = cm.priceOfMeterUsage(
      { id: 'm', label: 'Cloud credits', unit: 'credits', usdPerUnit: 0.01 },
      120
    )!
    expect(priced.usd).toBeCloseTo(1.2, 9)
    expect(priced.basis).toContain('120.00 credits')
  })

  /**
   * ⛔ **Unpriceable is not free.** A vendor that publishes a credit balance and no conversion has
   * given a meter that is real and cannot be turned into dollars. `$0.00` would say the 120 credits
   * this run burned cost nothing, which is the one thing that is certainly false.
   */
  it('refuses to price credits the vendor publishes no dollar value for', () => {
    expect(
      cm.priceOfMeterUsage({ id: 'm', label: 'Cloud credits', unit: 'credits', usdPerUnit: null }, 120)
    ).toBeNull()
  })
})

/**
 * The layers, over real rows.
 *
 * ⛔ **The one part of the money answer that cannot be a fixture.** Whether `usd` is the sum of the
 * two layers, and whether `listUsd` stayed out of it, is a property of the pass that reads the
 * database — and asserting it against a hand-built object would be asserting the test's arithmetic.
 */
describe('layering a run’s money', () => {
  let dir: string
  let db: typeof import('./db.js')
  let price: typeof import('./price.js')

  const WORKER = 'aaaaaaaa-0000-4000-8000-00000001a7e5'
  const T0 = 1_756_000_000_000
  const HOUR = 3_600_000

  const quota = (at: number, percent: number): string =>
    JSON.stringify({
      windows: [{ id: 'weekly_all', label: 'weekly_all', percent }],
      sampledAt: at,
      stale: false
    })

  function seedRun(id: string, listUsd: number | null): void {
    db.db()
      .prepare(
        `insert or ignore into tasks (id, seq, title, status, created_by_json, mandate_json,
                                      budget_json, created_at, updated_at)
         values (?,1,?, 'completed','{}','{}','{"grantedTokens":0,"spentTokens":0}',?,?)`
      )
      .run(`task-${id}`, id, T0, T0)
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, quota_unverified,
                           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                           cost_model_id, quota_before_json, quota_after_json, list_usd, on_overage)
         values (?,?,?,?,?, 'completed',0, 0,0,0,0, 'anthropic.subscription.2026-08', ?,?,?,?)`
      )
      .run(
        id,
        `task-${id}`,
        WORKER,
        T0,
        T0 + HOUR,
        quota(T0, 0),
        quota(T0 + HOUR, 5),
        listUsd,
        listUsd === null ? null : 1
      )
  }

  function seedMeter(opts: {
    unit: 'usd' | 'credits'
    usdPerUnit: number | null
    balances: Array<[number, number]>
  }): void {
    const insert = db.db().prepare(
      `insert into spend_samples (worker_id, meter_id, label, unit, balance, direction,
                                  usd_per_unit, source, sampled_at)
       values (?,?,?,?,?, 'balance_falls', ?, 'cli', ?)`
    )
    for (const [at, balance] of opts.balances) {
      insert.run(WORKER, 'purse', 'Extra usage', opts.unit, balance, opts.usdPerUnit, at)
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentyard-layers-'))
    db = await import('./db.js')
    price = await import('./price.js')
    db.openDb(join(dir, 'layers.db'))
    db.db()
      .prepare(
        `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                              max_concurrent, role, identity_json, created_at)
         values (?, 'ClaudeLayered', 'claude-code', ?, 1, 0, 1, 'worker', ?, ?)`
      )
      .run(WORKER, join(dir, 'w'), '{"subscriptionType":"pro"}', T0)
  })

  beforeEach(() => {
    db.db().exec('delete from runs')
    db.db().exec('delete from tasks')
    db.db().exec('delete from spend_samples')
    price.bumpPricingEpoch()
  })

  afterAll(() => {
    db.closeDb()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A held file handle on Windows is not a test failure.
    }
  })

  /**
   * ⭐ **The headline is the sum of two layers, and of exactly two.** 5% of a weekly window on
   * Claude Pro is $0.2300 of amortised subscription; the purse fell $0.75 across the same hour and
   * that is money somebody was actually charged. $9.99 of API list price sits beside both and is
   * ⛔ **provably not in the total** — it is nearly ten times either layer, so a sum that included
   * it could not be mistaken for one that did not.
   */
  it('adds the subscription share to what was billed directly, and leaves list price out', () => {
    seedRun('layered', 9.99)
    seedMeter({ unit: 'usd', usdPerUnit: 1, balances: [[T0, 40], [T0 + HOUR, 39.25]] })
    price.bumpPricingEpoch()
    const p = price.priceForRun('layered')!
    expect(p.subscriptionUsd!).toBeCloseTo(0.23, 3)
    expect(p.overageUsd!).toBeCloseTo(0.75, 9)
    expect(p.usd!).toBeCloseTo(0.98, 3)
    expect(p.listUsd).toBe(9.99)
    expect(p.onOverage).toBe(true)
    expect(p.usd!).toBeLessThan(1)
    expect(p.basis).toContain('not part of this total')
  })

  /**
   * ⛔ **Credits with no conversion are `null`, not `0`.** The purse demonstrably fell by 120
   * credits; what that cost is unpublished. The overage layer is unknown, the subscription layer
   * still stands on its own, and the total says out loud that it is a lower bound.
   */
  it('reports unpriceable credits as unknown, and the total as a lower bound', () => {
    seedRun('creditsonly', null)
    seedMeter({ unit: 'credits', usdPerUnit: null, balances: [[T0, 500], [T0 + HOUR, 380]] })
    price.bumpPricingEpoch()
    const p = price.priceForRun('creditsonly')!
    expect(p.overageUsd).toBeNull()
    expect(p.overageUsd).not.toBe(0)
    expect(p.subscriptionUsd!).toBeCloseTo(0.23, 3)
    expect(p.usd!).toBeCloseTo(0.23, 3)
    expect(p.basis).toContain('lower bound')
    expect(p.listUsd).toBeNull()
    expect(p.onOverage).toBeNull()
  })

  it('folds the layers over a task, keeping each total’s shortfall separate', () => {
    seedRun('layered', 9.99)
    seedMeter({ unit: 'usd', usdPerUnit: 1, balances: [[T0, 40], [T0 + HOUR, 39.25]] })
    price.bumpPricingEpoch()
    const total = price.priceForTask('task-layered')!
    expect(total.usd!).toBeCloseTo(0.98, 3)
    expect(total.overageUsd!).toBeCloseTo(0.75, 9)
    // ⛔ The list price is a total of its own and never joins the one above it.
    expect(total.listUsd).toBe(9.99)
    expect(total.partial).toBe(false)
    expect(total.listPartial).toBe(false)
  })
})
