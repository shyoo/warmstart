import { db, rows } from './db.js'
import { costModel, type BillingWindowRef, type PlanRef } from './costmodel.js'
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
 * ⛔ **No pricing arithmetic here.** The dollars come from `CostModel.priceOfWindowUsage`; this file
 * decides only *whose* percent is whose. See AGENTS.md and docs/cost-model.md §13.
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

export interface Attribution {
  /** The share of the window this run is answerable for, or null when it cannot be said. */
  percent: number | null
  reason: AttributionReason
  /** The `*`. True whenever the number is a split, a stale reading, or a run still in flight. */
  estimated: boolean
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
 * ⛔ **A segment where the percentage falls is a rollover, and it poisons every run across it.**
 * A run that starts at 98% and ends at 2% did not earn a refund; its real cost is unknowable once
 * the baseline has moved, so it is `n/a` rather than clamped. `resets_at` is not used for this:
 * measured 2026-09-02 over 1,263 consecutive weekly samples, it moved forward 384 times while the
 * percentage fell 6 times — a rolling window re-reports its horizon constantly.
 */
export function attribute(
  runs: AttributionRun[],
  readings: Reading[],
  now: number
): Map<string, Attribution> {
  const out = new Map<string, Attribution>()
  const series = dedupe(readings)

  const noReading = (id: string): void => {
    out.set(id, { percent: null, reason: 'no_reading', estimated: false, parallelRunIds: [] })
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
  }
  const spans: Span[] = []
  for (const run of runs) {
    const inFlight = run.endedAt === null
    // ⚠️ An open run is priced up to the newest reading, not up to `now`: `now` has no measurement
    // beside it, and pretending it does would credit the run with a window movement nobody read.
    const end = inFlight ? Math.min(now, last.at) : run.endedAt!

    const before = lastAtOrBefore(series, run.startedAt)
    const after = firstAtOrAfter(series, end)
    if (!before || !after) {
      noReading(run.id)
      continue
    }
    const gapBefore = run.startedAt - before.at
    const gapAfter = after.at - end
    if (gapBefore > ANCHOR_MAX_MS || gapAfter > ANCHOR_MAX_MS) {
      noReading(run.id)
      continue
    }
    if (inFlight && last.at <= run.startedAt) {
      noReading(run.id)
      continue
    }
    const stale =
      gapBefore > ANCHOR_STALE_MS || gapAfter > ANCHOR_STALE_MS || !!before.stale || !!after.stale
    spans.push({ run, from: run.startedAt, to: end, stale, inFlight })
  }

  const acc = new Map<string, { percent: number; shared: boolean; parallel: Set<string>; reset: boolean }>()
  for (const s of spans) {
    acc.set(s.run.id, { percent: 0, shared: false, parallel: new Set(), reset: false })
  }

  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i]!
    const b = series[i + 1]!
    const active = spans
      .map((s) => ({ s, overlap: Math.max(0, Math.min(s.to, b.at) - Math.max(s.from, a.at)) }))
      .filter((x) => x.overlap > 0)
    if (active.length === 0) continue

    const delta = b.percent - a.percent
    if (delta < -EPS) {
      for (const { s } of active) acc.get(s.run.id)!.reset = true
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
        parallelRunIds: [...rec.parallel]
      })
      continue
    }
    out.set(s.run.id, {
      // ⚠️ Clamped at zero rather than allowed negative. Rounding in the vendor's own percentages
      // can make a quiet segment read -0.0001, and a negative cost is not a thing.
      percent: Math.max(0, rec.percent),
      reason: rec.shared ? 'shared_window' : 'measured',
      estimated: rec.shared || s.stale || s.inFlight,
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
 * ⛔ Called from `startRun`, `finishRun`, `setRunQuota` and the quota store — the four places a
 * fact this depends on changes. Cheap: the recompute is one pass over `runs` and `quota_samples`
 * (238 and ~2,000 rows on this install), and it only happens the next time somebody asks.
 */
export function bumpPricingEpoch(): void {
  epoch++
  memo = null
}

/** What a whole task has spent, folded over its runs. */
export interface TaskPrice {
  usd: number | null
  /** Any contributing run's number was a split, a stale reading, or still in flight. */
  estimated: boolean
  /** ⚠️ At least one run could not be priced, so this total is a **lower bound**. */
  partial: boolean
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
                plan_id, plan_source, quota_before_json, quota_after_json
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
    out.set(r.id, priceOne(r, { identities, windowsOfRun, workerWindows, attributionFor }))
  }

  for (const r of runRows) {
    if (!r.task_id) continue
    const price = out.get(r.id)!
    const seen = taskOut.get(r.task_id) ?? { usd: null, estimated: false, partial: false }
    if (price.usd === null) {
      seen.partial = true
    } else {
      seen.usd = (seen.usd ?? 0) + price.usd
      seen.estimated = seen.estimated || price.estimated
    }
    taskOut.set(r.task_id, seen)
  }
}

function priceOne(
  r: PricedRunRow,
  ctx: {
    identities: Map<string, string | null>
    windowsOfRun: Map<string, string[]>
    workerWindows: Map<string, string[]>
    attributionFor: (workerId: string, windowId: string) => Map<string, Attribution>
  }
): RunPrice {
  const na = (reason: RunPrice['reason'], basis: string, plan?: PlanRef | null): RunPrice => ({
    usd: null,
    percent: null,
    estimated: false,
    reason,
    basis,
    planId: plan?.id ?? null,
    planLabel: plan?.label ?? null,
    planSource: (r.plan_source as RunPrice['planSource']) ?? plan?.source ?? null,
    windowId: null,
    parallelRunIds: []
  })

  if (!r.cost_model_id) return na('no_plan', 'This run predates the cost-model column, so nothing knows what it was billed against.')

  let cm
  try {
    cm = costModel(r.cost_model_id)
  } catch {
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
    for (const id of a.parallelRunIds) parallel.add(id)
  }

  if (usage.length === 0) {
    return sawReset
      ? na('window_reset', 'The account’s weekly window rolled over while this run was in flight, so the difference either side of it is not a cost.', plan)
      : na('no_reading', 'This run has no complete pair of window readings — one before it and one after it — so there is no difference to price.', plan)
  }

  const priced = cm.priceOfWindowUsage(plan.id, usage)
  if (!priced) {
    return na('unpriced_plan', `${plan.label} has no subscription price to divide.`, plan)
  }

  const percent = usage.reduce((sum, u) => sum + u.percent, 0)
  return {
    usd: priced.usd,
    percent,
    estimated,
    reason: estimated && parallel.size > 0 ? 'shared_window' : 'measured',
    basis: priced.basis,
    planId: plan.id,
    planLabel: plan.label,
    planSource: (r.plan_source as RunPrice['planSource']) ?? plan.source,
    windowId: usage.map((u) => u.window.id).join(' + '),
    parallelRunIds: [...parallel]
  }
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
