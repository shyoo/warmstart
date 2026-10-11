// Frozen t1046 reference from 77551ce8: test-only, preserving the pre-optimization arithmetic.
import type { AttributionRun, Reading, Attribution, AttributeOptions } from '../price.js'

const ANCHOR_STALE_MS = 10 * 60 * 1000
const ANCHOR_MAX_MS = 12 * 60 * 60 * 1000

/** Percent readings are integers from every vendor seen so far; this is slack, not tolerance. */
const EPS = 0.001

/**
 * A small backwards movement is a corrected reading, not a billing-window reset.
 *
 * Antigravity's live panel has reported a 1.60-point maximum downward correction without a reset
 * (158 observed falls through 2026-09-04); its next actual reset-sized fall was 2.00 points. The
 * boundary is deliberately in this common attribution layer rather than special-casing a vendor:
 * every source can correct a rounded percentage, but a reset remains too important to silently
 * smooth over. A correction is omitted from the spend and marks the affected answer estimated.
 */
const RESET_DROP_PERCENT = 2

/**
 * Split a window's movement across the runs that were holding it.
 *
 * The timeline is cut at every reading. Each consecutive pair is a *segment* carrying a delta, and
 * each segment's delta is divided among the runs open across it **in proportion to how much of the
 * segment each one covered**.
 *
 * ⭐ Duration weighting is a strict generalisation of an equal split: where two runs both span a
 * whole segment the weights come out equal, and it only differs where a run's edge falls *inside* a
 * segment — which is exactly the case an equal split gets wrong.
 *
 * ⛔ **A segment with no run open is dropped, not redistributed.** That movement is the operator's
 * own interactive use of the account, and charging it to whichever task ran next would be a lie
 * that grows with how long the fleet sits idle.
 *
 * ⛔ **A segment where the series moves *backwards* means the baseline moved, and it poisons every
 * run across it.** For a rising quota window that is a rollover: a run that starts at 98% and ends
 * at 2% did not earn a refund, and its real cost is unknowable once the window has reset, so it is
 * `n/a` rather than clamped. For a falling credit purse it is a **top-up**, which is the exact
 * analogue — the money that arrived mid-run hides however much was spent around it. Both come out
 * as `window_reset`, whose name is now narrower than its meaning; the string is kept because it is
 * a `PriceReason` a UI already renders.
 *
 * `resets_at` is not used for this: measured 2026-09-02 over 1,263 consecutive weekly samples, it
 * moved forward 384 times while the percentage fell 6 times — a rolling window re-reports its
 * horizon constantly. The movement itself is the honest signal, in either direction.
 *
 * ⛔ **A run the series only partly covers is priced from the part it covers, not discarded.** Its
 * span is clamped to the readings that exist, and how much fell outside them comes back as
 * `unmeasuredMs` so the caller can say the number is a lower bound. The case is common rather than
 * exotic: a vendor's closing reading carries the *vendor's* timestamp, so a run that ended at
 * 20:50:28 routinely stores an `after` stamped 20:48:44 (t210, measured 2026-09-04) — and demanding
 * a reading at or after the run's end threw away a 4-point window movement that was measured in full
 * and unambiguously that run's. ⚠️ Bounded by `ANCHOR_MAX_MS` like every other gap, and a run with
 * *nothing* read while it was open is still `no_reading`.
 */
export function referenceAttribute(
  runs: AttributionRun[],
  readings: Reading[],
  now: number,
  options: AttributeOptions = {}
): Map<string, Attribution> {
  const out = new Map<string, Attribution>()
  const series = dedupe(readings)
  // ⚠️ Normalised exactly once, here, into "how much was spent across this segment". Everything
  // below — the duration weighting, the dropped idle segments, the bounds — is direction-blind,
  // and a second `if` further down is how the two cases would drift apart.
  const spentAcross = (a: Reading, b: Reading): number =>
    options.direction === 'falls' ? a.percent - b.percent : b.percent - a.percent

  const noReading = (id: string): void => {
    out.set(id, {
      percent: null,
      reason: 'no_reading',
      estimated: false,
      unmeasuredMs: 0,
      parallelRunIds: []
    })
  }

  if (series.length < 2) {
    for (const r of runs) noReading(r.id)
    return out
  }

  const last = series[series.length - 1]!

  // Every run's effective span, and whether it can be anchored at all.
  interface Span {
    run: AttributionRun
    from: number
    to: number
    stale: boolean
    inFlight: boolean
    /** How much of the run fell outside the series, so its share is a lower bound by that much. */
    unmeasuredMs: number
  }
  const first = series[0]!
  const spans: Span[] = []
  for (const run of runs) {
    const inFlight = run.endedAt === null
    // ⚠️ An open run is priced up to the newest reading, not up to `now`: `now` has no measurement
    // beside it, and pretending it does would credit the run with a window movement nobody read.
    const end = inFlight ? Math.min(now, last.at) : run.endedAt!

    // ⛔ **The part of this run the series can actually speak for**, which is not always the whole
    // run. See `truncated`. Clamping changes no arithmetic for a run the series already covered:
    // segments only exist between readings, so an overlap was already bounded by these same two
    // instants. What it changes is *which runs get a span at all*.
    const from = Math.max(run.startedAt, first.at)
    const to = Math.min(end, last.at)
    if (to <= from) {
      // Nothing was read while this run was open — including the in-flight run whose account has
      // not been probed since it started, which is the same statement.
      noReading(run.id)
      continue
    }

    // How much of the run ran outside the series entirely. ⚠️ Not the same quantity as the anchor
    // gaps below: those are *measured* stretches whose readings are old, this is a stretch with no
    // reading at either end, so whatever was spent in it is missing from the answer rather than
    // imprecisely shared into it.
    const unmeasured = from - run.startedAt + (end - to)
    if (unmeasured > ANCHOR_MAX_MS) {
      // ⛔ Past this the measured slice is not a useful lower bound on the whole run — the same
      // judgment `ANCHOR_MAX_MS` already makes about a gap wide enough to hide anything.
      noReading(run.id)
      continue
    }

    // ⚠️ Both exist by construction now: `from` is at or after the first reading and `to` at or
    // before the last, so each side has one to anchor against. The gaps still matter, and mean what
    // they always meant — how old the reading anchoring this edge is.
    const before = lastAtOrBefore(series, from)!
    const after = firstAtOrAfter(series, to)!
    const gapBefore = from - before.at
    const gapAfter = after.at - to
    if (gapBefore > ANCHOR_MAX_MS || gapAfter > ANCHOR_MAX_MS) {
      noReading(run.id)
      continue
    }
    const stale =
      gapBefore > ANCHOR_STALE_MS || gapAfter > ANCHOR_STALE_MS || !!before.stale || !!after.stale
    spans.push({ run, from, to, stale, inFlight, unmeasuredMs: unmeasured })
  }

  const acc = new Map<
    string,
    { percent: number; shared: boolean; parallel: Set<string>; reset: boolean; corrected: boolean }
  >()
  for (const s of spans) {
    acc.set(s.run.id, { percent: 0, shared: false, parallel: new Set(), reset: false, corrected: false })
  }

  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i]!
    const b = series[i + 1]!
    const active = spans
      .map((s) => ({ s, overlap: Math.max(0, Math.min(s.to, b.at) - Math.max(s.from, a.at)) }))
      .filter((x) => x.overlap > 0)
    if (active.length === 0) continue

    const delta = spentAcross(a, b)
    if (delta <= -RESET_DROP_PERCENT) {
      for (const { s } of active) acc.get(s.run.id)!.reset = true
      continue
    }
    if (delta < -EPS) {
      // A panel corrected a rounded percentage downward. It cannot make a run cheaper, so it
      // contributes no spend; it does make the positive part an estimate rather than a clean
      // measurement. t207's 41.69% -> 41.61% Antigravity weekly reading is this exact case.
      for (const { s } of active) acc.get(s.run.id)!.corrected = true
      continue
    }

    const total = active.reduce((sum, x) => sum + x.overlap, 0)
    for (const { s, overlap } of active) {
      const rec = acc.get(s.run.id)!
      rec.percent += (delta * overlap) / total
      if (active.length > 1) {
        rec.shared = true
        for (const other of active) if (other.s.run.id !== s.run.id) rec.parallel.add(other.s.run.id)
      }
    }
  }

  for (const s of spans) {
    const rec = acc.get(s.run.id)!
    if (rec.reset) {
      out.set(s.run.id, {
        percent: null,
        reason: 'window_reset',
        estimated: false,
        unmeasuredMs: 0,
        parallelRunIds: [...rec.parallel]
      })
      continue
    }
    out.set(s.run.id, {
      // ⚠️ Clamped at zero rather than allowed negative. Rounding in the vendor's own percentages
      // can make a quiet segment read -0.0001, and a negative cost is not a thing.
      percent: Math.max(0, rec.percent),
      reason: rec.shared ? 'shared_window' : 'measured',
      estimated: rec.shared || s.stale || s.inFlight || rec.corrected || s.unmeasuredMs > 0,
      unmeasuredMs: s.unmeasuredMs,
      parallelRunIds: [...rec.parallel]
    })
  }

  // Anything that never made it into `spans` and never got an answer: no timeline reached it.
  for (const r of runs) if (!out.has(r.id)) noReading(r.id)
  return out
}

/** Sorted by time, one reading per timestamp. ⚠️ Stale readings lose to fresh ones at the same ms. */
function dedupe(readings: Reading[]): Reading[] {
  const byTime = new Map<number, Reading>()
  for (const r of readings) {
    if (!Number.isFinite(r.at) || !Number.isFinite(r.percent)) continue
    const seen = byTime.get(r.at)
    if (!seen || (seen.stale && !r.stale)) byTime.set(r.at, r)
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}

function lastAtOrBefore(series: Reading[], at: number): Reading | null {
  let found: Reading | null = null
  for (const r of series) {
    if (r.at <= at) found = r
    else break
  }
  return found
}

function firstAtOrAfter(series: Reading[], at: number): Reading | null {
  for (const r of series) if (r.at >= at) return r
  return null
}
