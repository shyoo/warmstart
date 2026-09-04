import { db, rows } from './db.js'
import { costModel, CostModel, type BillingWindowRef, type PlanRef } from './costmodel.js'
import type { SpendMeter } from '@shared/protocol.js'
import { log } from './log.js'
import type { RunPrice, RunQuota } from '@shared/tasks.js'

/**
 * What a run cost in money.
 *
 * ⛔ **Derived, never stored.** A run's price changes when a *later* run is discovered to have
 * overlapped it — two agents on one account share the window they both drew from, and the second
 * one's existence is what makes the first one's number an estimate. A column written at the end of
 * a run would be correct for exactly as long as nothing else touched that account, which on this
 * fleet is measured in minutes. So the answer is computed from the timeline on demand and memoised
 * against an epoch, and `bumpPricingEpoch()` is what every writer of a run or a reading calls.
 *
 * ⛔ **No pricing arithmetic here.** The dollars come from `CostModel.priceOfWindowUsage` and
 * `CostModel.priceOfMeterUsage`; this file decides only *whose* share of a movement is whose. See
 * AGENTS.md and docs/cost-model.md §13.
 *
 * ⛔ **Money is layered, because a subscription fleet is billed in layers.** `subscriptionUsd` is
 * an amortised share of a flat monthly fee — nobody is charged it at the moment the run happens.
 * `overageUsd` is money that really was billed on top: Claude extra-usage overage, Antigravity
 * cloud credits, Codex credits, attributed off `spend_samples` exactly the way a quota window is
 * attributed off `quota_samples`. `usd` is the sum of those two and nothing else; `listUsd` — what
 * the same work would have cost on a market-rated API — is carried beside them and never added in.
 *
 * ⚠️ **`null` is not `0` anywhere in here.** A layer nobody measured is absent, and a total missing
 * one of its layers is a *lower bound* that says so in its `basis`.
 */

// ---------------------------------------------------------------------------- the pure algorithm

/** One reading of one window, at one moment. */
export interface Reading {
  at: number
  percent: number
  /** True when this was the best available reading and was already too old to act on. */
  stale?: boolean
}

/** The only thing attribution needs to know about a run. */
export interface AttributionRun {
  id: string
  startedAt: number
  endedAt: number | null
}

export type AttributionReason = 'measured' | 'shared_window' | 'no_reading' | 'window_reset'

/**
 * Which way the series moves when money is spent.
 *
 * ⛔ **The two are mirror images, and the algorithm below is one algorithm.** A quota window
 * `rises` toward 100% as an account is drawn down, and a fall is a rollover. A credit purse
 * `falls` toward zero as money is spent, and a rise is a top-up. Both of the exceptional cases are
 * *the baseline moved*, and both poison every run across them for the same reason: what the run
 * spent either side of the move is unknowable, in an unknown ratio.
 *
 * ⚠️ Maps from `SpendMeter.direction`: `'spend_rises'` → `'rises'`, `'balance_falls'` → `'falls'`.
 */
export type SeriesDirection = 'rises' | 'falls'

export interface AttributeOptions {
  /**
   * Defaults to `'rises'`, which is the quota-window behaviour this function was written for.
   *
   * ⛔ The default is load-bearing: every existing caller and every existing test in
   * `price.test.ts` passes no options and must come out **unchanged to the number**.
   */
  direction?: SeriesDirection
}

export interface Attribution {
  /** The share of the window this run is answerable for, or null when it cannot be said. */
  percent: number | null
  reason: AttributionReason
  /**
   * The `*`. True whenever the number is a split, a stale reading, a run still in flight, a
   * corrected reading, or a run the series only partly covered.
   */
  estimated: boolean
  /**
   * How much of the run ran outside the series entirely, in milliseconds. `0` for a run the
   * readings covered end to end.
   *
   * ⛔ **Non-zero makes `percent` a lower bound**, and that is a different statement from every
   * other reason `estimated` is set. A shared or stale number is imprecise about a movement that
   * *was* read; this one is missing a stretch nobody read at all, so the true share is this or
   * more — never less. `price.ts` says so in the basis rather than leaving a reader to assume the
   * number is complete.
   */
  unmeasuredMs: number
  /** Who it shared the window with, for the hover message. */
  parallelRunIds: string[]
}

/**
 * How far a reading may sit from a run's edge before the number stops being a measurement.
 *
 * ⚠️ Two bounds, not one, because they mean different things. Past `STALE` the anchor is still the
 * best evidence there is and the run is priced from it with a `*`; past `MAX` there is a gap in the
 * series wide enough that anything could have happened inside it, and the honest answer is `n/a`.
 */
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
export function attribute(
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

// ---------------------------------------------------------------------------- the database layer
//
// Everything below reads rows. Everything above is pure, and the tests that matter live there.

/** Bumped by every writer of a run or a reading; the memo is keyed on it. */
let epoch = 0
let memo: { epoch: number; runs: Map<string, RunPrice>; tasks: Map<string, TaskPrice> } | null = null

/**
 * Throw the memoised prices away.
 *
 * ⛔ Called from `startRun`, `finishRun`, `setRunQuota` and the quota store — and, now that money
 * is layered, from every writer of the pay-as-you-go side too: a `spend_samples` row landing, and
 * a run's `list_usd` / `on_overage` being stamped. Each of those changes an answer this file has
 * already memoised, and the memo has no other way to find out.
 *
 * Cheap: the recompute is one pass over `runs`, `quota_samples` and `spend_samples` (238 and
 * ~2,000 rows on this install), and it only happens the next time somebody asks.
 */
export function bumpPricingEpoch(): void {
  epoch++
  memo = null
}

/**
 * The current epoch, for the tests that check a writer remembered to bump it.
 *
 * ⚠️ Exported for that and nothing else — no caller may branch on it. It is a cache generation
 * number, not a fact about money, and a decision keyed on it would be a decision keyed on how often
 * something happened to be recomputed.
 */
export function pricingEpoch(): number {
  return epoch
}

/**
 * What a whole task has spent, folded over its runs.
 *
 * ⛔ **Three totals, each with its own `partial`.** They are folded over different subsets of the
 * same runs — a run can carry a list price and no measurable overage, or the reverse — so one
 * shared "this is short" flag would be wrong for two of the three every time it was right for one.
 */
export interface TaskPrice {
  /** Subscription share + directly-billed overage, summed over every run that could be priced. */
  usd: number | null
  /** Any contributing run's number was a split, a stale reading, or still in flight. */
  estimated: boolean
  /** ⚠️ At least one run could not be priced, so this total is a **lower bound**. */
  partial: boolean
  /** The directly-billed part of `usd`. ⚠️ A component of it, never a second charge beside it. */
  overageUsd: number | null
  /** ⚠️ At least one run's overage is unknown, so `overageUsd` is a **lower bound**. */
  overagePartial: boolean
  /** ⛔ The API-equivalent list price, which is **not** part of `usd`. See `RunPrice.listUsd`. */
  listUsd: number | null
  /** ⚠️ At least one run has no list price, so `listUsd` is a **lower bound**. */
  listPartial: boolean
}

export function priceForRun(runId: string): RunPrice | null {
  return compute().runs.get(runId) ?? null
}

export function pricesForRuns(runIds: string[]): Map<string, RunPrice> {
  const all = compute().runs
  const out = new Map<string, RunPrice>()
  for (const id of runIds) {
    const p = all.get(id)
    if (p) out.set(id, p)
  }
  return out
}

export function priceForTask(taskId: string): TaskPrice | null {
  return compute().tasks.get(taskId) ?? null
}

interface PricedRunRow {
  id: string
  task_id: string | null
  worker_id: string
  started_at: number
  ended_at: number | null
  cost_model_id: string | null
  model: string | null
  plan_id: string | null
  plan_source: string | null
  quota_before_json: string | null
  quota_after_json: string | null
  /** ⛔ Carried, never summed into `usd`. What this run would have cost on a market-rated API. */
  list_usd: number | null
  /** ⚠️ `null` is "nobody knows", which is not the same statement as `0` / not on overage. */
  on_overage: number | null
}

interface WorkerRow {
  id: string
  identity_json: string | null
}

interface SampleRow {
  worker_id: string
  window_id: string
  percent: number
  sampled_at: number
}

interface SpendSampleRow {
  worker_id: string
  meter_id: string
  label: string
  unit: string
  balance: number | null
  direction: string
  usd_per_unit: number | null
  sampled_at: number
}

/** One money meter of one worker, and everything ever read off it. */
interface MeterSeries {
  meter: Pick<SpendMeter, 'id' | 'label' | 'unit' | 'usdPerUnit'>
  direction: SeriesDirection
  readings: Reading[]
}

function compute(): { runs: Map<string, RunPrice>; tasks: Map<string, TaskPrice> } {
  if (memo && memo.epoch === epoch) return memo
  const result = { epoch, runs: new Map<string, RunPrice>(), tasks: new Map<string, TaskPrice>() }
  try {
    build(result.runs, result.tasks)
  } catch (err) {
    // ⛔ A pricing failure may not take the task list down with it. Every run reads `n/a` instead.
    log.warn('pricing pass failed - runs will read n/a:', err)
  }
  memo = result
  return result
}

function build(out: Map<string, RunPrice>, taskOut: Map<string, TaskPrice>): void {
  const runRows = rows<PricedRunRow>(
    db()
      .prepare(
        `select id, task_id, worker_id, started_at, ended_at, cost_model_id, model,
                plan_id, plan_source, quota_before_json, quota_after_json,
                list_usd, on_overage
           from runs order by started_at asc`
      )
      .all()
  )
  if (runRows.length === 0) return

  const identities = new Map<string, string | null>()
  for (const w of rows<WorkerRow>(db().prepare('select id, identity_json from workers').all())) {
    identities.set(w.id, subscriptionOf(w.identity_json))
  }

  // Readings, per worker and window. ⚠️ `window_id != ''` skips the rows a failed probe writes.
  const series = new Map<string, Reading[]>()
  const addReading = (workerId: string, windowId: string, r: Reading): void => {
    const key = `${workerId} ${windowId}`
    const list = series.get(key)
    if (list) list.push(r)
    else series.set(key, [r])
  }
  for (const s of rows<SampleRow>(
    db()
      .prepare("select worker_id, window_id, percent, sampled_at from quota_samples where window_id != ''")
      .all()
  )) {
    addReading(s.worker_id, s.window_id, { at: s.sampled_at, percent: s.percent })
  }

  // The snapshots a run carried. ⭐ These are what price a worker whose sample history predates the
  // `window_id` column — ClaudeFirst's 404 samples all carry an empty id and are unusable.
  const windowsOfRun = new Map<string, string[]>()
  for (const r of runRows) {
    const ids = new Set<string>()
    for (const json of [r.quota_before_json, r.quota_after_json]) {
      const q = parseQuota(json)
      if (!q) continue
      for (const w of q.windows) {
        ids.add(w.id)
        addReading(r.worker_id, w.id, { at: q.sampledAt, percent: w.percent, stale: q.stale })
      }
    }
    windowsOfRun.set(r.id, [...ids])
  }

  // The money meters, per worker. ⚠️ The direction is the meter's own: a credit purse *falls* as
  // money is spent and a cumulative counter *rises*, and `attribute` is told which so that a
  // top-up and a billing rollover both come out as "the baseline moved" rather than as spend.
  // ⚠️ `balance is not null` skips the rows a failed probe writes — the analogue of `window_id != ''`.
  const meters = new Map<string, Map<string, MeterSeries>>()
  for (const s of rows<SpendSampleRow>(
    db()
      .prepare(
        `select worker_id, meter_id, label, unit, balance, direction, usd_per_unit, sampled_at
           from spend_samples
          where meter_id != '' and balance is not null
          order by sampled_at asc`
      )
      .all()
  )) {
    let byMeter = meters.get(s.worker_id)
    if (!byMeter) {
      byMeter = new Map<string, MeterSeries>()
      meters.set(s.worker_id, byMeter)
    }
    const existing = byMeter.get(s.meter_id)
    // ⚠️ The newest sample wins the *description* — a vendor may relabel a meter or start
    // publishing a conversion it did not have before — while every sample contributes a reading.
    const meter = {
      id: s.meter_id,
      label: s.label,
      unit: s.unit === 'credits' ? ('credits' as const) : ('usd' as const),
      usdPerUnit: s.unit === 'credits' ? s.usd_per_unit : 1
    }
    const direction: SeriesDirection = s.direction === 'balance_falls' ? 'falls' : 'rises'
    if (existing) {
      existing.meter = meter
      existing.direction = direction
      existing.readings.push({ at: s.sampled_at, percent: s.balance! })
    } else {
      byMeter.set(s.meter_id, {
        meter,
        direction,
        readings: [{ at: s.sampled_at, percent: s.balance! }]
      })
    }
  }

  const runsByWorker = new Map<string, PricedRunRow[]>()
  for (const r of runRows) {
    const list = runsByWorker.get(r.worker_id)
    if (list) list.push(r)
    else runsByWorker.set(r.worker_id, [r])
  }

  const now = Date.now()
  const attributions = new Map<string, Map<string, Attribution>>()
  const attributionFor = (workerId: string, windowId: string): Map<string, Attribution> => {
    const key = `${workerId} ${windowId}`
    let found = attributions.get(key)
    if (!found) {
      found = attribute(
        (runsByWorker.get(workerId) ?? []).map((r) => ({
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at
        })),
        series.get(key) ?? [],
        now
      )
      attributions.set(key, found)
    }
    return found
  }

  // ⚠️ A cache of its own rather than a second use of the one above: the keys are meter ids, which
  // share no namespace with window ids, and the series is attributed with a different direction.
  const meterAttributions = new Map<string, Map<string, Attribution>>()
  const metersOf = (workerId: string): MeterSeries[] => [...(meters.get(workerId)?.values() ?? [])]
  const meterAttributionFor = (workerId: string, m: MeterSeries): Map<string, Attribution> => {
    const key = `${workerId} ${m.meter.id}`
    let found = meterAttributions.get(key)
    if (!found) {
      found = attribute(
        (runsByWorker.get(workerId) ?? []).map((r) => ({
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at
        })),
        m.readings,
        now,
        { direction: m.direction }
      )
      meterAttributions.set(key, found)
    }
    return found
  }

  // Every window this worker has ever reported, for runs that carried no snapshot of their own.
  const workerWindows = new Map<string, string[]>()
  for (const key of series.keys()) {
    const sep = key.indexOf(' ')
    const workerId = key.slice(0, sep)
    const windowId = key.slice(sep + 1)
    const list = workerWindows.get(workerId)
    if (list) list.push(windowId)
    else workerWindows.set(workerId, [windowId])
  }

  for (const r of runRows) {
    out.set(
      r.id,
      priceOne(r, {
        identities,
        windowsOfRun,
        workerWindows,
        attributionFor,
        metersOf,
        meterAttributionFor
      })
    )
  }

  // ⚠️ Each total folds over the runs that *have* that number, and records separately when it was
  // short. A run priced in subscription dollars with no meter reading contributes to `usd` and
  // makes `overageUsd` a lower bound, and saying that with one flag would misreport one of them.
  for (const r of runRows) {
    if (!r.task_id) continue
    const price = out.get(r.id)!
    const seen: TaskPrice = taskOut.get(r.task_id) ?? {
      usd: null,
      estimated: false,
      partial: false,
      overageUsd: null,
      overagePartial: false,
      listUsd: null,
      listPartial: false
    }
    if (price.usd === null) {
      seen.partial = true
    } else {
      seen.usd = (seen.usd ?? 0) + price.usd
      seen.estimated = seen.estimated || price.estimated
    }
    if (price.overageUsd === null) seen.overagePartial = true
    else seen.overageUsd = (seen.overageUsd ?? 0) + price.overageUsd
    if (price.listUsd === null) seen.listPartial = true
    else seen.listUsd = (seen.listUsd ?? 0) + price.listUsd
    taskOut.set(r.task_id, seen)
  }
}

/** Everything `priceOne` needs from the pass around it. */
interface PriceCtx {
  identities: Map<string, string | null>
  windowsOfRun: Map<string, string[]>
  workerWindows: Map<string, string[]>
  attributionFor: (workerId: string, windowId: string) => Map<string, Attribution>
  metersOf: (workerId: string) => MeterSeries[]
  meterAttributionFor: (workerId: string, meter: MeterSeries) => Map<string, Attribution>
}

/** The subscription layer: an amortised share of a flat monthly fee, or why there isn't one. */
interface SubscriptionPart {
  usd: number | null
  percent: number | null
  basis: string
  /** How much of the run no reading covered. See `RunPrice.unmeasuredMs`. */
  unmeasuredMs: number
  /** The `n/a` verdict when `usd` is null; one of the five, and each renders its own tooltip. */
  reason: RunPrice['reason']
  estimated: boolean
  parallel: Set<string>
  windowId: string | null
  plan: PlanRef | null
}

/** The pay-as-you-go layer: money a vendor really billed, on top of the subscription. */
interface OveragePart {
  usd: number | null
  basis: string
  estimated: boolean
  parallel: Set<string>
  /** How many meters this worker has ever reported. ⚠️ Zero is why `no_meter` exists. */
  meters: number
}

function priceOne(r: PricedRunRow, ctx: PriceCtx): RunPrice {
  // ⚠️ Read straight off the row rather than derived. Both are facts a probe wrote about this run
  // and neither moves when a later run is discovered — unlike everything else in this file.
  const listUsd = typeof r.list_usd === 'number' ? r.list_usd : null
  const onOverage = r.on_overage === null || r.on_overage === undefined ? null : r.on_overage !== 0

  let cm: CostModel | null = null
  if (r.cost_model_id) {
    try {
      cm = costModel(r.cost_model_id)
    } catch {
      cm = null
    }
  }

  const overage = overagePart(r, cm, ctx)
  const sub = subscriptionPart(r, cm, ctx)
  return combine(r, sub, overage, { listUsd, onOverage })
}

/**
 * ⛔ **Unchanged arithmetic.** This is exactly what `usd` was before money became layered, moved
 * behind a name; every number it produces, and every one of the five ways it declines to produce
 * one, is what it always was. What changed is only that a caller now adds something to it.
 */
function subscriptionPart(r: PricedRunRow, cm: CostModel | null, ctx: PriceCtx): SubscriptionPart {
  const na = (
    reason: RunPrice['reason'],
    basis: string,
    plan?: PlanRef | null
  ): SubscriptionPart => ({
    usd: null,
    percent: null,
    basis,
    unmeasuredMs: 0,
    reason,
    estimated: false,
    parallel: new Set(),
    windowId: null,
    plan: plan ?? null
  })

  if (!r.cost_model_id) {
    return na('no_plan', 'This run predates the cost-model column, so nothing knows what it was billed against.')
  }
  if (!cm) {
    return na('no_plan', `No cost model '${r.cost_model_id}' is loaded, so this run has no subscription to divide.`)
  }

  const ownWindows = ctx.windowsOfRun.get(r.id) ?? []
  const plan =
    cm.planById(r.plan_id) ??
    cm.resolvePlan({
      subscriptionType: ctx.identities.get(r.worker_id) ?? null,
      windowIds: ownWindows
    })
  if (!plan) return na('no_plan', `${cm.provider} declares no subscription plans, so there is no price to divide.`)
  if (!plan.priced) {
    return na('unpriced_plan', `${plan.label} has no subscription price to divide, so a run on it costs no measurable money.`, plan)
  }

  const pool = r.model ? (cm.modelSpec(r.model)?.pool ?? null) : null
  const candidates = ownWindows.length > 0 ? ownWindows : (ctx.workerWindows.get(r.worker_id) ?? [])
  const windows = cm.billingWindowsFor(candidates, pool)
  if (windows.length === 0) {
    return na('no_window', `${cm.provider} reported no billing window for this run, so there is nothing to take a fraction of.`, plan)
  }

  const usage: Array<{ window: BillingWindowRef; percent: number }> = []
  const parallel = new Set<string>()
  let estimated = false
  let sawReset = false
  /** The widest stretch of this run no reading covered, across the windows it was priced on. */
  let unmeasuredMs = 0
  for (const w of windows) {
    const a = ctx.attributionFor(r.worker_id, w.id).get(r.id)
    if (!a) continue
    if (a.reason === 'window_reset') {
      sawReset = true
      continue
    }
    if (a.percent === null) continue
    usage.push({ window: w, percent: a.percent })
    estimated = estimated || a.estimated
    unmeasuredMs = Math.max(unmeasuredMs, a.unmeasuredMs)
    for (const id of a.parallelRunIds) parallel.add(id)
  }

  if (usage.length === 0) {
    return sawReset
      ? na('window_reset', 'The account’s weekly window rolled over while this run was in flight, so the difference either side of it is not a cost.', plan)
      : na('no_reading', 'This run has no complete pair of window readings — one before it and one after it — so there is no difference to price.', plan)
  }

  const priced = cm.priceOfWindowUsage(plan.id, usage)
  if (!priced) return na('unpriced_plan', `${plan.label} has no subscription price to divide.`, plan)

  return {
    usd: priced.usd,
    percent: usage.reduce((sum, u) => sum + u.percent, 0),
    // ⛔ Said out loud, because it is the one kind of `estimated` that has a *direction*. A shared
    // or stale share is imprecise about a movement that was read; this one is short of a stretch
    // nobody read, so the true cost is this or more. A reader who is not told that will take the
    // number for the whole run.
    basis:
      unmeasuredMs > 0
        ? `${priced.basis} ⚠️ At least this much: ${describeGap(unmeasuredMs)} of this run fell ` +
          'outside the window readings, and whatever it spent there is not in this number.'
        : priced.basis,
    unmeasuredMs,
    reason: estimated && parallel.size > 0 ? 'shared_window' : 'measured',
    estimated,
    parallel,
    windowId: usage.map((u) => u.window.id).join(' + '),
    plan
  }
}

/**
 * The directly-billed dollars this run is answerable for.
 *
 * ⛔ **One unknown meter makes the whole layer unknown.** A worker's meters are not independent
 * bills to be summed as far as they go: a total that silently omits the one meter that could not
 * be read is a smaller number wearing a complete number's clothes. `null`, and the basis says why.
 *
 * ⛔ **A worker with no meters is `null`, not `$0.00`.** Nobody has asked that account what it has
 * been billed; "not measured" and "measured, and it was nothing" are different facts, and only the
 * second one is a number.
 */
function overagePart(r: PricedRunRow, cm: CostModel | null, ctx: PriceCtx): OveragePart {
  const series = ctx.metersOf(r.worker_id)
  const parallel = new Set<string>()
  if (series.length === 0) {
    return {
      usd: null,
      basis:
        'No spend meter has been read for this account, so nothing is known about money billed on top of the subscription.',
      estimated: false,
      parallel,
      meters: 0
    }
  }
  if (!cm) {
    return {
      usd: null,
      basis: 'No cost model is loaded for this run, so its meters cannot be converted to dollars.',
      estimated: false,
      parallel,
      meters: series.length
    }
  }

  let usd = 0
  let estimated = false
  const parts: string[] = []
  const unknown: string[] = []
  for (const m of series) {
    const a = ctx.meterAttributionFor(r.worker_id, m).get(r.id)
    if (!a || a.percent === null) {
      unknown.push(
        a?.reason === 'window_reset'
          ? `${m.meter.label} was topped up or rolled over while this run was in flight`
          : `${m.meter.label} has no complete pair of readings around this run`
      )
      continue
    }
    const priced = cm.priceOfMeterUsage(m.meter, a.percent)
    if (!priced) {
      // ⛔ Real and unpriceable: the vendor publishes the credits and no conversion for them.
      unknown.push(`${m.meter.label} is metered in credits with no published dollar value`)
      continue
    }
    usd += priced.usd
    estimated = estimated || a.estimated
    for (const id of a.parallelRunIds) parallel.add(id)
    parts.push(priced.basis)
  }

  if (unknown.length > 0) {
    return {
      usd: null,
      basis: `Directly-billed money is unknown for this run: ${unknown.join('; ')}.`,
      estimated,
      parallel,
      meters: series.length
    }
  }
  return { usd, basis: parts.join(' + '), estimated, parallel, meters: series.length }
}

/**
 * The headline, and everything a reader needs to distrust it properly.
 *
 * ⛔ **`null` is absent, not zero.** Both layers missing is `n/a` with the reason that says which
 * kind of missing; one layer missing is the other layer alone, and the `basis` says out loud that
 * the total is a lower bound — because a partial sum presented as a complete one is the single
 * rendering of this feature that would actively mislead.
 *
 * ⛔ **`listUsd` is not in the sum.** It travels on the result, and only ever beside it.
 */
function combine(
  r: PricedRunRow,
  sub: SubscriptionPart,
  overage: OveragePart,
  columns: { listUsd: number | null; onOverage: boolean | null }
): RunPrice {
  const parallel = new Set([...sub.parallel, ...overage.parallel])
  const estimated = sub.estimated || overage.estimated
  const usd = sub.usd === null && overage.usd === null ? null : (sub.usd ?? 0) + (overage.usd ?? 0)

  // Every component that went into the number, named — and the one that could not be.
  const parts: string[] = []
  if (sub.usd !== null) parts.push(`Subscription share: ${sub.basis}`)
  if (overage.usd !== null && overage.basis) parts.push(`Billed directly: ${overage.basis}`)
  if (usd !== null && (sub.usd === null || overage.usd === null)) {
    parts.push(`⚠️ A lower bound: ${sub.usd === null ? sub.basis : overage.basis}`)
  }
  if (columns.listUsd !== null) {
    parts.push(
      `Carried separately, and not part of this total: $${columns.listUsd.toFixed(4)} at API list price.`
    )
  }

  const reason: RunPrice['reason'] =
    usd !== null
      ? estimated && parallel.size > 0
        ? 'shared_window'
        : 'measured'
      : // ⚠️ Nothing meters this run at all — no billing window and no spend meter. Distinct from
        // `no_window`, which means the provider has a window and reported none for this run.
        sub.reason === 'no_window' && overage.meters === 0
        ? 'no_meter'
        : sub.reason

  return {
    usd,
    subscriptionUsd: sub.usd,
    overageUsd: overage.usd,
    listUsd: columns.listUsd,
    onOverage: columns.onOverage,
    percent: sub.percent,
    estimated,
    // ⛔ `null` where there is no price at all, so "covered end to end" (`0`) stays distinguishable
    // from "there was nothing to cover" — the same null-is-not-zero rule the rest of this file keeps.
    unmeasuredMs: usd === null ? null : sub.unmeasuredMs,
    reason,
    basis: parts.length > 0 ? parts.join(' ') : sub.basis,
    planId: sub.plan?.id ?? null,
    planLabel: sub.plan?.label ?? null,
    planSource: (r.plan_source as RunPrice['planSource']) ?? sub.plan?.source ?? null,
    windowId: sub.windowId,
    parallelRunIds: [...parallel]
  }
}

/** A duration in the words a tooltip wants. ⚠️ Rounded up: "0 minutes" would read as none at all. */
function describeGap(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`
}

function parseQuota(json: string | null): RunQuota | null {
  if (!json) return null
  try {
    const q = JSON.parse(json) as RunQuota
    return q && Array.isArray(q.windows) && typeof q.sampledAt === 'number' ? q : null
  } catch {
    return null
  }
}

/** ⚠️ Recorded verbatim by the probe and read verbatim here — never parsed on the way in. */
export function subscriptionOf(identityJson: string | null): string | null {
  if (!identityJson) return null
  try {
    const id = JSON.parse(identityJson) as { subscriptionType?: string | null }
    return id?.subscriptionType ?? null
  } catch {
    return null
  }
}
