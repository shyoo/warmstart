import { db, rows } from './db.js'
import { timingForTasks } from './activetime.js'
import { creditedKeys, type Credit } from './pace.js'
import { priceForTask } from './price.js'
import { qualityReport } from './quality.js'
import { fitnessFor } from './fitness.js'
import { benchmarkPrior } from './benchmarks.js'
import { adapterLabels } from './adapters/index.js'
import type {
  Distribution,
  PriceBasis,
  PriceStatRow,
  PriceStats,
  QualityStatRow,
  QualityStats,
  StatRow,
  StatisticsReport,
  StatisticsWindow,
  VelocityStats
} from '@shared/statistics.js'

/**
 * Analytics › Statistics — the descriptive half of what this fleet has measured.
 *
 * ⛔ **Nothing here is shrunk, blended, clamped or fitted, and that is the whole point of the
 * file.** `pace.ts`, `estimator.ts` and `fitness.ts` all publish numbers built to be *acted on*, so
 * all three deliberately pull a sparse key toward a neutral middle — a factor learned from two
 * tasks that says ×4 would otherwise route the whole fleet on an accident. A person asking *"what
 * does a task cost me on Opus at high effort"* is asking a different question, and the honest answer
 * to it is the distribution that was measured, tail included. The two families will disagree; the
 * page says so rather than reconciling them behind the reader's back.
 *
 * ⛔ **The credit rule is imported, never re-derived.** `creditedKeys` attributes a finished task to
 * the adapter and model of its last non-failed work run — the same rule `review.ts` grades on. A
 * copy of that query living here is one rename away from this page and the Velocity tab disagreeing
 * about which agent did which task, with nothing to say which of them was right.
 *
 * ⚠️ **Completed tasks only, and the same window `pace.ts` reads.** A cancelled or failed task
 * stopped for reasons that say nothing about what a task on that agent costs or takes, and folding
 * them in would make the agent that gets interrupted most look like the cheapest.
 */

/**
 * How many finished tasks the page describes by default. ⚠️ The same ceiling `paceFactors` uses, so
 * the two surfaces are looking at the same window and a disagreement between them is real rather
 * than a difference in how far back each happened to read.
 *
 * ⭐ An operator can ask for `all` instead (t361): a fleet past its two-hundredth task was reading
 * a window that quietly dropped its oldest work, with nothing on the page but a number saying so.
 * The read then stops at nothing — `limit -1` is SQLite's own spelling for that — and the report
 * says `sampleLimit: null`.
 */
const SAMPLE_LIMIT = 200

function limitFor(window: StatisticsWindow): number | null {
  return window === 'all' ? null : SAMPLE_LIMIT
}

/** The absent rung of a key, written the same way `pace.ts` writes it. */
const NO_MODEL = '?'

/**
 * The model identity Statistics groups on.
 *
 * Claude records both a stable name and a dated build name for the same model.  The renderer has
 * always deliberately hidden that date in `modelLabel`; grouping by the unnormalised id therefore
 * made two indistinguishable "Haiku 4.5" rows.  Keep the aggregation identity in step with that
 * display rule, before the tree is made, so every statistic and chart uses the same evidence.
 */
export function statisticsModelId(model: string | null): string | null {
  if (!model || model === NO_MODEL || model === '<synthetic>') return null
  return (model.trim().split('/').pop() ?? '').replace(/-\d{8}$/, '') || null
}

// ---------------------------------------------------------------------------- the pure arithmetic

/**
 * The value at a percentile of a sorted sample, by linear interpolation between order statistics.
 *
 * ⛔ **`p100` is the maximum and `p50` is the ordinary median**, which is what makes this method the
 * right one here: a nearest-rank definition would make `p50` of an even-length sample jump to one of
 * the two middle values, and the page sits beside `pace.ts`, whose `median` averages them. Two
 * medians of the same data that differ by a definition nobody printed is precisely the kind of
 * unexplained disagreement this codebase treats as a fault.
 *
 * ⚠️ Interpolation cannot invent a tail. On four samples `p99` is a hair below the maximum by
 * construction, and no amount of arithmetic changes the fact that nobody has seen the 99th
 * percentile of four things. That is why `samples` travels beside every distribution.
 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0] ?? null
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const low = sorted[lower] ?? 0
  if (lower === upper) return low
  const high = sorted[upper] ?? low
  return low + (high - low) * (rank - lower)
}

/** ⚠️ Sorts a copy. The caller's array is grouped by key and is read again for other rungs. */
export function distributionOf(values: number[]): Distribution {
  if (values.length === 0) {
    return { samples: 0, average: null, p50: null, p99: null, p100: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    average: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    p100: percentile(sorted, 100)
  }
}

/**
 * Which billing layers a group of tasks actually drew on.
 *
 * ⛔ **`unknown` is a verdict, not a synonym for `subscription`.** A group whose every task failed to
 * price has not been shown to be free; it has not been measured. `AGENTS.md` says this about every
 * other absent number and it is no less true of money.
 *
 * ⚠️ The threshold is a strict `> 0`, not a rounded cent. A task that drew fourteen thousandths of a
 * dollar of real overage was billed at an API rate, and rounding that to `$0.00` before classifying
 * would file it as a pure subscription task on the strength of a display decision.
 */
export function basisOf(layers: Array<{ subscription: number | null; overage: number | null }>): PriceBasis {
  let anySubscription = false
  let anyOverage = false
  let priced = 0
  for (const l of layers) {
    if (l.subscription === null && l.overage === null) continue
    priced++
    if ((l.subscription ?? 0) > 0) anySubscription = true
    if ((l.overage ?? 0) > 0) anyOverage = true
  }
  if (priced === 0) return 'unknown'
  if (anySubscription && anyOverage) return 'mixed'
  if (anyOverage) return 'api'
  if (anySubscription) return 'subscription'
  // ⚠️ Priced, and both layers came to zero — a free local endpoint is the ordinary case. That is a
  // measured subscription-shaped answer (nothing was billed on top), not an unknown one.
  return 'subscription'
}

// ---------------------------------------------------------------------------- the sample set

/** One finished task, with everything the three tabs fold over it. */
interface Sample {
  taskId: string
  adapterId: string
  model: string | null
  /** From the crediting run's session. Null where the session is gone or never declared one. */
  effort: string | null
  usd: number | null
  subscriptionUsd: number | null
  overageUsd: number | null
  priceEstimated: boolean
  activeMs: number
}

function effortsForSessions(credits: Map<string, Credit>): Map<string, string | null> {
  const ids = [...new Set([...credits.values()].map((c) => c.sessionId).filter((id): id is string => !!id))]
  const out = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    for (const r of rows<{ id: string; effort: string | null }>(
      db().prepare(`select id, effort from sessions where id in (${holes})`).all(...chunk)
    )) {
      out.set(r.id, r.effort)
    }
  }
  return out
}

/**
 * Every finished task this page describes, credited and measured.
 *
 * ⛔ **Exported for the tests, which is the only way the folding below can be checked at all.**
 * Building a fleet's worth of runs, sessions, quota samples and reviews in a fixture to exercise one
 * percentile is a test about SQLite; the arithmetic is what can be wrong in an interesting way.
 */
export function samples(now = Date.now(), window: StatisticsWindow = 'recent'): Sample[] {
  const finished = rows<{ id: string }>(
    db()
      .prepare(
        // ⛔ `stats_excluded = 0`. A task an operator has taken out of the numbers is out of all
        //    three tabs at once — the price, the duration and the grade are folded from one sample
        //    set precisely so that they cannot disagree about which tasks exist.
        `select id from tasks
          where status = 'completed' and deleted_at is null and coalesce(stats_excluded, 0) = 0
          order by updated_at desc
          limit ?`
      )
      .all(limitFor(window) ?? -1)
  )
  const ids = finished.map((t) => t.id)
  if (ids.length === 0) return []

  const credits = creditedKeys(ids)
  const timings = timingForTasks(ids, now)
  const efforts = effortsForSessions(credits)

  const out: Sample[] = []
  for (const id of ids) {
    const credit = credits.get(id)
    // ⛔ An uncredited task is dropped rather than pooled into an "unknown agent" row. Every column
    //    on this page is *per agent*; a bucket that is not one of them is a number with no owner.
    if (!credit) continue
    const price = priceForTask(id)
    // ⚠️ `usd` already includes `overageUsd`. The subscription layer is the remainder, and it is
    //    computed rather than read because `TaskPrice` carries the total and the billed part only.
    const overage = price?.overageUsd ?? null
    const usd = price?.usd ?? null
    const subscription = usd === null ? null : usd - (overage ?? 0)
    out.push({
      taskId: id,
      adapterId: credit.adapterId,
      model: statisticsModelId(credit.model),
      effort: credit.sessionId ? (efforts.get(credit.sessionId) ?? null) : null,
      usd,
      subscriptionUsd: subscription,
      overageUsd: overage,
      priceEstimated: price?.estimated ?? false,
      activeMs: timings.get(id)?.activeMs ?? 0
    })
  }
  return out
}

// ---------------------------------------------------------------------------- the tree

const EFFORT_POWER: Record<string, number> = {
  max: 60,
  xhigh: 50,
  high: 40,
  medium: 30,
  med: 30,
  low: 20,
  minimal: 10,
  min: 10
}

export function effortPowerScore(effort: string): number {
  const key = effort.trim().toLowerCase()
  return EFFORT_POWER[key] ?? 0
}

export function compareEffortPower(a: string, b: string): number {
  const diff = effortPowerScore(b) - effortPowerScore(a)
  if (diff !== 0) return diff
  return a.localeCompare(b)
}

export function modelPowerScore(modelId: string): number {
  if (!modelId || modelId === NO_MODEL) return -1
  const lower = modelId.toLowerCase()

  let score = 0
  let effortScore = 0

  // 1. Check & strip embedded effort in model ID (e.g. gemini-3.8-flash-high, gemini-3.8-flash-medium)
  let baseModel = lower
  for (const [eff, val] of Object.entries(EFFORT_POWER)) {
    if (lower.endsWith(`-${eff}`) || lower.endsWith(`_${eff}`)) {
      effortScore = val
      baseModel = lower.slice(0, -(eff.length + 1))
      break
    }
  }
  score += effortScore

  // 2. Version extraction (e.g. 3.8, 3.7, 3-7, 3.5, 5.6, 5.4, 4.5, etc.)
  const vMatch = baseModel.match(/(?:gemini|claude|gpt|llama|qwen|sonnet|haiku|opus)?[-_]?(\d+)(?:[._-](\d+))?/)
  if (vMatch) {
    const major = Number.parseInt(vMatch[1] ?? '0', 10) || 0
    const minor = Number.parseInt(vMatch[2] ?? '0', 10) || 0
    score += major * 10000 + minor * 1000
  }

  // 3. Parameter size (e.g. 120b, 70b, 32b, 8b)
  const pMatch = baseModel.match(/(\d+)b\b/)
  if (pMatch) {
    score += (Number.parseInt(pMatch[1] ?? '0', 10) || 0) * 50
  }

  // 4. Tier keyword adjustments on baseModel
  if (baseModel.includes('opus')) score += 900
  else if (baseModel.includes('pro') || baseModel.includes('ultra') || baseModel.includes('sol')) score += 800
  else if (baseModel.includes('plus') || baseModel.includes('terra')) score += 700
  else if (baseModel.includes('sonnet')) score += 600
  else if (baseModel.includes('flash')) score += 500
  else if (baseModel.includes('medium')) score += 350
  else if (baseModel.includes('haiku')) score += 200
  else if (baseModel.includes('mini')) score += 150
  else if (baseModel.includes('lite') || baseModel.includes('nano')) score += 100

  // 5. Reasoning / Thinking models
  if (baseModel.includes('thinking') || baseModel.includes('reasoning') || baseModel.startsWith('o1') || baseModel.startsWith('o3')) {
    score += 500
  }

  return score
}

export function compareModelPower(a: string, b: string): number {
  const diff = modelPowerScore(b) - modelPowerScore(a)
  if (diff !== 0) return diff
  return a.localeCompare(b)
}

/**
 * The three rungs every table on this page has, in order.
 *
 * ⛔ **An agent row is not the sum of its model rows, it is the fold of the same tasks one rung
 * up.** A median of medians is not a median, and a p99 of p99s is not anything at all — so each
 * depth re-folds the raw samples it covers rather than combining the rung below it.
 */
function tree<T extends Sample, R>(
  all: T[],
  agentLabel: (adapterId: string) => string,
  fold: (level: 'agent' | 'model' | 'effort', label: string, key: string, group: T[]) => R,
  /**
   * Splits the model rung: one row per distinct value the classifier names.
   *
   * ⛔ Price only. A model whose tasks were billed two ways must not average an amortised
   * subscription share with money really billed on top — the mean of the two is a number in
   * neither currency (t285). The agent rung above stays the fold of everything, so the totals
   * still reconcile; the model rung below names which dollars each row is in.
   */
  modelSplit?: (s: T) => string | null
): R[] {
  const out: R[] = []
  const byAgent = new Map<string, T[]>()
  for (const s of all) {
    const list = byAgent.get(s.adapterId) ?? []
    list.push(s)
    byAgent.set(s.adapterId, list)
  }
  for (const [adapterId, agentGroup] of [...byAgent.entries()].sort((a, b) =>
    agentLabel(a[0]).localeCompare(agentLabel(b[0]))
  )) {
    out.push(fold('agent', agentLabel(adapterId), adapterId, agentGroup))

    const byModel = new Map<string, T[]>()
    for (const s of agentGroup) {
      // A missing model is still part of its agent's total, but it is not a model a reader can
      // compare or choose.  Do not manufacture a `?` / "model not recorded" child row for it.
      if (!s.model) continue
      const k = s.model
      const list = byModel.get(k) ?? []
      list.push(s)
      byModel.set(k, list)
    }
    for (const [model, modelGroup] of [...byModel.entries()].sort((a, b) => compareModelPower(a[0], b[0]))) {
      // ⚠️ One row per billing basis where the caller asked for the split, so `subs` and `API
      //    rate` dollars are never averaged together. The key carries the basis because two rows
      //    share the model label; the effort key below carries it too, for the same reason.
      const splits = new Map<string, T[]>()
      if (modelSplit) {
        for (const s of modelGroup) {
          const k = modelSplit(s) ?? ''
          const list = splits.get(k) ?? []
          list.push(s)
          splits.set(k, list)
        }
      } else {
        splits.set('', modelGroup)
      }
      for (const [split, splitGroup] of [...splits.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const modelKey = split ? `${adapterId}/${model}/${split}` : `${adapterId}/${model}`
        out.push(fold('model', model, modelKey, splitGroup))

        const byEffort = new Map<string, T[]>()
        for (const s of splitGroup) {
          // ⛔ A task whose effort was never recorded gets no effort row at all. A `?` rung under a
          //    model is a bucket nobody can act on, and it would sit in the table looking like a
          //    setting somebody chose.
          if (!s.effort) continue
          const list = byEffort.get(s.effort) ?? []
          list.push(s)
          byEffort.set(s.effort, list)
        }
        // ⚠️ Suppressed when the model ran at exactly one effort: a lone child that restates its
        //    parent's numbers is a row that costs a line and says nothing.
        if (byEffort.size < 2) continue
        for (const [effort, effortGroup] of [...byEffort.entries()].sort((a, b) =>
          compareEffortPower(a[0], b[0])
        )) {
          out.push(
            fold('effort', effort, split ? `${modelKey}/${effort}` : `${adapterId}/${model}/${effort}`, effortGroup)
          )
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------- the three tabs

function priceStats(all: Sample[], label: (id: string) => string): PriceStats {
  const rowsOut = tree<Sample, PriceStatRow>(all, label, (level, text, key, group) => {
    const priced = group.filter((s) => s.usd !== null)
    return {
      key,
      level,
      label: text,
      adapterId: group[0]?.adapterId ?? '',
      model: level === 'agent' ? null : (group[0]?.model ?? null),
      effort: level === 'effort' ? (group[0]?.effort ?? null) : null,
      distribution: distributionOf(priced.map((s) => s.usd as number)),
      basis: basisOf(group.map((s) => ({ subscription: s.subscriptionUsd, overage: s.overageUsd }))),
      unpriced: group.length - priced.length
    }
  },
  // ⛔ A task is billed exactly one way: subscription-only, billed on top, or both. Splitting the
  //    model rung on it is what keeps an account crossing into overage mid-month from averaging
  //    the two layers into one row. A task nobody could price lands in `unknown`, whose row the
  //    samples filter below drops — the fleet-wide `unpriced` count is where that fact belongs.
  (s) =>
    s.usd === null
      ? 'unknown'
      : basisOf([{ subscription: s.subscriptionUsd, overage: s.overageUsd }])
  )
  return {
    // ⛔ A rung nobody could price at all is dropped rather than rendered as a row of `n/a`. The
    //    fleet-wide `unpriced` count below is where that fact belongs; a table of blanks is not.
    rows: rowsOut.filter((r) => r.distribution.samples > 0),
    tasks: all.length,
    unpriced: all.filter((s) => s.usd === null).length,
    estimated: all.some((s) => s.priceEstimated)
  }
}

function velocityStats(all: Sample[], label: (id: string) => string): VelocityStats {
  const rowsOut = tree<Sample, StatRow>(all, label, (level, text, key, group) => {
    // ⛔ Zero is not a duration. A completed task with no measurable active time is a resumed
    //    conversation that answered and closed, and averaging a zero into a per-agent pace makes
    //    whichever agent caught those look like the fast one.
    const timed = group.filter((s) => s.activeMs > 0)
    return {
      key,
      level,
      label: text,
      adapterId: group[0]?.adapterId ?? '',
      model: level === 'agent' ? null : (group[0]?.model ?? null),
      effort: level === 'effort' ? (group[0]?.effort ?? null) : null,
      distribution: distributionOf(timed.map((s) => s.activeMs))
    }
  })
  return {
    rows: rowsOut.filter((r) => r.distribution.samples > 0),
    tasks: all.length,
    untimed: all.filter((s) => s.activeMs <= 0).length
  }
}

/**
 * Quality, as far as it can honestly be taken today.
 *
 * ⭐ **The baseline is the published benchmark prior, and on a fleet with no reviews it is the whole
 * answer.** `fitness.ts` is emphatic that an ungraded key must not read as average — not 0, not 0.5
 * — so a `null` here means *nobody has benchmarked this model and nobody has graded it*, and the
 * page prints that rather than a number.
 *
 * ⚠️ **An effort row carries the measured composite only.** A benchmark is published per model;
 * there is no such thing as a prior for `high` in particular, and copying the model's down a level
 * would print one number three times as though it had been measured three ways.
 */
function qualityStats(all: Sample[], label: (id: string) => string): QualityStats {
  const report = qualityReport()
  const clean = cleanReviews()

  const rowsOut = tree<Sample, QualityStatRow>(all, label, (level, text, key, group) => {
    const adapterId = group[0]?.adapterId ?? ''
    const model = level === 'agent' ? null : (group[0]?.model ?? null)
    const effort = level === 'effort' ? (group[0]?.effort ?? null) : null

    // ⛔ Scored from the reviews of *these* tasks, not from `qualityReport().keys`. The report
    //    buckets every review the fleet has ever taken; this table's rungs are the tasks in its
    //    sample window, and the two are only the same thing on a fleet that has never pruned.
    const ids = new Set(group.map((s) => s.taskId))
    const mine = clean.filter((r) => ids.has(r.taskId))
    const scored = mine.filter((r) => r.composite !== null)
    const cleanScored = scored.filter((r) => r.clean)
    // ⚠️ The chart folds the same clean composites the mean is taken over, so `distribution.average`
    //    and `cleanComposite` are one number — printed twice on purpose, never computed twice.
    const distribution = distributionOf(cleanScored.map((r) => r.composite as number))
    const composite = distribution.average

    // ⛔ **A prior and a fitness are properties of a model, and only of a model.** A benchmark is
    //    published per model, so there is no such thing as one for `claude-code` in general or for
    //    `high` in particular. Both rungs above and below get `null`, which the table draws as a
    //    dash rather than as `unknown` — *nobody has measured this* and *this quantity does not
    //    exist at this depth* are different sentences and must not share a cell.
    const modelLevel = level === 'model'
    const prior = modelLevel ? benchmarkPrior(model) : null
    const fit = modelLevel ? fitnessFor(adapterId, model, report.keys) : null

    return {
      key,
      level,
      label: text,
      adapterId,
      model,
      effort,
      prior: prior?.agentic ?? null,
      priorBasis: prior?.basis ?? null,
      cleanComposite: composite,
      clean: cleanScored.length,
      samples: scored.length,
      fitness: fit?.value ?? null,
      fitnessBasis: fit?.basis ?? null,
      tasks: group.length,
      distribution
    }
  })

  return {
    rows: rowsOut,
    totalReviews: report.totalReviews,
    ungraded: report.ungradedTasks,
    rubricVersion: report.rubricVersion
  }
}

interface ReviewRow {
  taskId: string
  composite: number | null
  clean: boolean
}

/**
 * Every complete scored review, with the cleanliness test `@shared/quality.ts` defines.
 *
 * ⛔ Single-author and blinded without a leak. A review of a task two adapters both worked on is not
 * evidence about either, and one whose blinding left a vendor name in the prose was not blind.
 */
function cleanReviews(): ReviewRow[] {
  return rows<{ task_id: string; composite: number | null; mixed_authorship: number; blinding_leak: number; blinded: number }>(
    db()
      .prepare(
        `select task_id, composite, mixed_authorship, blinding_leak, blinded
           from quality_reviews
          where status = 'complete'`
      )
      .all()
  ).map((r) => ({
    taskId: r.task_id,
    composite: r.composite,
    clean: r.mixed_authorship === 0 && r.blinding_leak === 0 && r.blinded === 1
  }))
}

export function statisticsReport(now = Date.now(), window: StatisticsWindow = 'recent'): StatisticsReport {
  const all = samples(now, window)
  const labels = adapterLabels()
  const label = (id: string): string => labels[id] ?? id
  return {
    generatedAt: now,
    sampleLimit: limitFor(window),
    window,
    price: priceStats(all, label),
    velocity: velocityStats(all, label),
    quality: qualityStats(all, label)
  }
}
