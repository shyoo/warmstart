import type { Task } from '@shared/tasks.js'
import { db, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { costModel, type CostModel } from './costmodel.js'
import { priceForRun, pricesForRuns } from './price.js'
import { log } from './log.js'

/**
 * What a task is likely to cost, learned from what tasks actually cost — and on *which agent*.
 *
 * ⛔ This is why runs are never deleted with their task. They are the only record of real spend, and
 * an estimator with no history is the thing that makes a scheduler confidently wrong.
 *
 * ⛔ **One median across the whole fleet was a central tendency of nothing.** Measured on this
 * install 2026-08-30 over 73 completed runs, median total tokens per run:
 * `antigravity-cli/gemini-3.7-flash-medium` 12,477,352 (n=35) against
 * `claude-code/claude-sonnet-5` 153,091 (n=14) — **81x**, and 93x after pricing, so pricing does not
 * explain it. A single median sat between the two and described neither: it called every Antigravity
 * run a runaway before it had done anything unusual, and under-estimated every one of them at the
 * parent-budget gate. So the estimate is two factors now, `size(task) × factor(agent, model)`.
 *
 * Deliberately median rather than mean throughout: one runaway run should not move the estimate for
 * everything after it, and agent work has a long right tail.
 *
 * ⚠️ Confidence is reported, always. An estimate from two samples and an estimate from fifty are
 * different objects, and a gate that treats them the same is a gate that will open when it should
 * not - so `low` confidence widens every margin that consumes it.
 */

export type Confidence = 'none' | 'low' | 'medium' | 'high'

export interface Estimate {
  /** Raw metered tokens, the unit budgets are granted and spent in. */
  tokens: number
  /**
   * The same estimate in input-token-equivalents (cost-model.md §3).
   *
   * ⛔ The unit any *comparison* must be made in. Raw totals are 92-98% cache reads, billed at a
   * fraction, so they measure how long a run was rather than what it cost. `overrunFactor` divides
   * in this unit for exactly that reason.
   */
  pricedTokens: number
  /**
   * The same estimate in **money**, and the primary cost indicator now.
   *
   * ⛔ `null` is `n/a`, never `$0.00`. A run prices `n/a` for six distinct reasons (price.ts), so a
   * fleet can be busy and still have nothing to divide; every consumer here falls back to
   * `pricedTokens` rather than treating an unpriceable fleet as a free one.
   */
  usd: number | null
  /**
   * How much the *money* answer is worth, which is not how much the token answer is worth.
   *
   * ⚠️ A key's priced runs are a subset of its runs, so this is routinely lower than `confidence`
   * and is `none` exactly when `usd` is null.
   */
  usdConfidence: Confidence
  confidence: Confidence
  samples: number
  /** Which unit the answer came from, and where the factor was learned. Every cost belief says so. */
  basis: string
  /** The agent/model multiplier applied; 1 when no key was given or none is known yet. */
  factor: number
  /**
   * True when any cost here rests on assumed cache multipliers — the Google and OpenAI files publish
   * none. ⛔ Carried to the UI rather than swallowed: an 80x ratio between an exactly priced provider
   * and an assumed one moves with the assumption.
   */
  assumed: boolean
}

/** Who would run the task. Everything about the estimate that is not the task itself. */
export interface EstimateOn {
  adapterId: string | null
  model?: string | null
  /** Would it inherit a conversation? Undefined where the caller cannot say, and then it is ignored. */
  warm?: boolean | undefined
}

/**
 * The fallback when nothing has been measured. Chosen from the one thing we do know: the M2
 * end-to-end run - a trivially small task - metered ~490k input-token-equivalents, almost all of it
 * cache reads on a 35k prefix. So this is not "a small number"; it is a deliberately *pessimistic*
 * one, because an under-estimate is what breaks a quota gate.
 */
const COLD_FALLBACK_TOKENS = 250_000

/** How many completed runs the factors are learned from. */
const SAMPLE_LIMIT = 200

/**
 * How fast a key earns the right to its own apparent ratio: `1 + (ratio-1)·n/(n+K)`.
 *
 * ⛔ Shrinkage is not decoration here. Measured 2026-08-30: **zero** of the 54 tasks with runs has
 * ever run on two different (adapter, model) keys, so nothing in this data separates "that agent is
 * expensive" from "that agent gets the big tasks". A 3-sample key therefore keeps ~37% of its
 * apparent ratio and a 35-sample key ~88%, and one run can never mint a 90x multiplier.
 */
const SHRINK_K = 5

/**
 * ⚠️ Wide on purpose. The measured spread between the two best-sampled keys is 81x, so a
 * conventional [0.25, 4] clamp would throw away the entire signal this exists to carry. These bounds
 * stop an arithmetic accident; they do not express a belief about how different two agents can be.
 */
const FACTOR_FLOOR = 0.05
const FACTOR_CEILING = 20

/**
 * How many priced runs a key needs before its factor is learned from dollars rather than tokens.
 *
 * ⛔ Money is primary but it is not always *there*: a run with no complete pair of window readings
 * prices `n/a`, and a key with one priced run out of thirty would otherwise have its whole
 * reputation set by whichever run happened to be sampled. Below this line the key keeps the priced
 * token answer, which is the number this file has always produced, and `basis` says which it used.
 */
const USD_MIN_SAMPLES = 3

interface SampleRow {
  id: string
  project_id: string | null
  adapter_id: string | null
  model: string | null
  cost_model_id: string | null
  started_warm: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total: number
}

interface Sample {
  projectId: string | null
  adapterId: string
  model: string | null
  raw: number
  priced: number
  /** What this run cost in money, or null where it could not be priced at all. */
  usd: number | null
  warm: boolean | null
  assumed: boolean
}

export interface CostFactor {
  adapterId: string
  /** Null is the adapter-wide rung: that agent's runs whose model was never recorded. */
  model: string | null
  samples: number
  /** Median priced cost of a run on this key, in input-token-equivalents. */
  medianPriced: number
  /**
   * The median run on this key in **dollars**, or null where none of its runs could be priced.
   *
   * ⛔ Never rounded to whole dollars. A run on this fleet costs cents, and the integer median the
   * token series uses would report every key as $0.
   */
  medianUsd: number | null
  /**
   * ⚠️ **Its own count, and never `samples`.** A key's priced runs are a strict subset of its runs,
   * because some of them price `n/a`. Conflating the two would claim a 35-run key had 35 dollar
   * measurements when it had four, and shrink its factor as though it did.
   */
  usdSamples: number
  /** Which series `ratio` was actually measured in. The basis string is built from this. */
  learnedFrom: 'usd' | 'priced_tokens'
  /** What the data says before shrinkage — published so the shrinkage is visible, not implied. */
  ratio: number
  /** What is actually applied. */
  factor: number
  assumed: boolean
}

export interface CostFactors {
  keys: CostFactor[]
  /** Warmth, learned after the agent factor is divided out so the two do not absorb each other. */
  warmFactor: number
  coldFactor: number
  warmSamples: number
  coldSamples: number
  /** The fleet's median run, priced and raw, with every factor divided out. The neutral unit. */
  neutralPriced: number
  neutralRaw: number
  /** The same neutral run in dollars, or null where no run in the window could be priced. */
  neutralUsd: number | null
  samples: number
  /** ⚠️ How many of `samples` yielded a price. Always ≤ `samples`, and often far fewer. */
  usdSamples: number
  assumed: boolean
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0)
}

/**
 * The same median, unrounded.
 *
 * ⛔ Money needs its own, because `median` rounds to an integer — correct for a token count and
 * catastrophic for dollars, where every run on this fleet would round to $0. Kept as a second
 * function rather than a flag on the first so that the token series is provably unchanged.
 */
function medianFloat(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function confidenceFor(samples: number): Confidence {
  if (samples === 0) return 'none'
  if (samples < 3) return 'low'
  if (samples < 10) return 'medium'
  return 'high'
}

const RANK: Confidence[] = ['none', 'low', 'medium', 'high']
function lower(a: Confidence, b: Confidence): Confidence {
  return RANK.indexOf(a) <= RANK.indexOf(b) ? a : b
}

/**
 * `ratio^(n/(n+K))`, clamped. One place, so every factor in this file shrinks the same way.
 *
 * ⛔ **In log space, not linear.** These are multipliers: ×8 and ×⅛ are the same distance from 1, and
 * a linear `1 + (ratio-1)·w` does not know that — it pulls ×0.02 almost all the way to 1 while
 * leaving ×2 nearly untouched, which on a two-agent fleet flattened a measured 80x spread to 5x and
 * inverted which agent looked dearer. `Math.exp(Math.log(r)·w)` shrinks both sides by the same
 * proportion, so the fleet's cheapest and dearest keep their distance from each other.
 */
function shrink(ratio: number, samples: number): number {
  if (!(ratio > 0)) return 1
  const pulled = Math.exp(Math.log(ratio) * (samples / (samples + SHRINK_K)))
  return Math.min(FACTOR_CEILING, Math.max(FACTOR_FLOOR, pulled))
}

/**
 * The fleet's centre, in the multiplicative sense: the geometric mean of what its runs cost.
 *
 * ⛔ Not the median. Run counts are wildly uneven — 35 Antigravity runs against 14 Sonnet on this
 * install — and a *pooled* median of a two-humped distribution lands inside whichever hump has more
 * runs, so every factor would be measured against the busiest agent rather than against the fleet.
 * The geometric mean sits between the humps in the space multipliers live in.
 *
 * ⚠️ Which number is chosen here does not move any estimate: `neutralPriced` is measured with the
 * factors divided out, so a rescaling of all factors cancels. It moves what the factors *say*, and
 * how far shrinkage pulls each one — which is why it has to be the honest middle.
 */
function centre(values: number[]): number {
  const usable = values.filter((v) => v > 0)
  if (usable.length === 0) return 0
  return Math.exp(usable.reduce((sum, v) => sum + Math.log(v), 0) / usable.length)
}

/**
 * The cost model that priced a run.
 *
 * ⚠️ `cost_model_id` is stamped at dispatch and is the right answer whenever it is there — a run
 * priced under an older file should stay priced under it. Runs predating the column fall back to
 * their adapter's current file, and a run whose adapter is gone is left unpriced rather than guessed.
 */
function modelFor(row: SampleRow): CostModel | null {
  try {
    if (row.cost_model_id) return costModel(row.cost_model_id)
    if (!row.adapter_id) return null
    return costModel(adapter(row.adapter_id).info.policy.costModelId)
  } catch {
    return null
  }
}

function keyId(adapterId: string, model: string | null): string {
  return `${adapterId}/${model ?? '?'}`
}

function loadSamples(): Sample[] {
  const raw = rows<SampleRow>(
    db()
      .prepare(
        `select id, project_id, adapter_id, model, cost_model_id, started_warm,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total
           from runs
          where outcome = 'completed'
            -- ⛔ Work only. A quality review is a cheap one-turn run on somebody else's task, and
            -- folding it into the median for "what does a task cost on this agent" would corrupt
            -- the number every routing, overrun and admission gate reads — downward, and by more
            -- the more the feature is used.
            and kind = 'work'
            and (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0
          order by started_at desc
          limit ?`
      )
      .all(SAMPLE_LIMIT)
  )

  // ⛔ One batched call for the whole sample set. `pricesForRuns` prices *every* run in the database
  // behind a memo keyed on an epoch, so asking it per row would re-enter that pass 200 times a tick
  // for one answer each — pathological, and invisible until the runs table is large.
  const prices = pricesForRuns(raw.map((row) => row.id))

  return raw.map((row) => {
    const priced = modelFor(row)?.priceRun({
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens
    })
    return {
      projectId: row.project_id,
      // ⚠️ A run from before migration 23 has no adapter. It still counts toward the fleet's neutral
      // size — it is a real measurement of real work — it just cannot belong to any key.
      adapterId: row.adapter_id ?? '',
      model: row.model,
      raw: row.total,
      priced: priced ? priced.tokens : row.total,
      // ⚠️ `usd ?? null`, not `usd ?? 0`. A run nobody could price is absent from the money series,
      // not a free run in it, and a zero here would drag every median it touched toward nothing.
      usd: prices.get(row.id)?.usd ?? null,
      warm: row.started_warm === null ? null : row.started_warm === 1,
      assumed: priced ? priced.assumed : true
    }
  })
}

/**
 * A memo keyed on the runs table's own fingerprint.
 *
 * ⛔ Not a timed cache. The scheduler asks for an estimate once per ready task per tick, every ten
 * seconds, and each answer prices 200 runs; a clock-based cache would go stale in tests in a way that
 * only ever shows up as a flake. The fingerprint changes the moment a run completes or is metered,
 * which is exactly when the answer changes.
 */
let cached: { fingerprint: string; value: CostFactors } | null = null

function fingerprint(): string {
  const row = db()
    .prepare(
      `select count(*) as n,
              coalesce(max(ended_at), 0) as last,
              coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as spend
         from runs where outcome = 'completed' and kind = 'work'`
    )
    .get() as { n: number; last: number; spend: number }
  return `${row.n}:${row.last}:${row.spend}`
}

/**
 * What each agent and model costs relative to the fleet, learned from completed runs.
 *
 * Two rungs of key, and both are published: `(adapter, model)` and `adapter` alone. The second rung
 * is not a formality — 17 of this install's 52 Antigravity runs never recorded a model, because the
 * session that knew it was closed and rewritten before anything asked.
 */
export function costFactors(): CostFactors {
  const print = fingerprint()
  if (cached?.fingerprint === print) return cached.value

  const samples = loadSamples()
  const globalPriced = centre(samples.map((s) => s.priced))
  // ⛔ The fleet's centre in money, measured over the priced subset only. A run that priced `n/a`
  // is not in this series at any level, which is why `usdSamples` is counted separately everywhere.
  const globalUsd = centre(samples.filter((s) => s.usd !== null).map((s) => s.usd!))

  const groups = new Map<string, Sample[]>()
  for (const s of samples) {
    if (!s.adapterId) continue
    // A run with no model belongs to the adapter-wide rung only; adding it to both would count it
    // twice in the same number.
    const ids = s.model === null ? [keyId(s.adapterId, null)] : [keyId(s.adapterId, s.model), keyId(s.adapterId, null)]
    for (const id of ids) {
      const list = groups.get(id) ?? []
      list.push(s)
      groups.set(id, list)
    }
  }

  const keys: CostFactor[] = []
  for (const [id, list] of groups) {
    const cut = id.lastIndexOf('/')
    const modelPart = id.slice(cut + 1)
    const medianPriced = median(list.map((s) => s.priced))
    const usdList = list.filter((s) => s.usd !== null).map((s) => s.usd!)
    const medianUsd = usdList.length > 0 ? medianFloat(usdList) : null
    // Money where the key has earned it, priced tokens where it has not. ⛔ The token branch is
    // reached whenever the dollar one is short, so a fleet with no prices at all computes exactly
    // what this function computed before money existed — the change is a strict extension.
    const fromUsd = usdList.length >= USD_MIN_SAMPLES && globalUsd > 0 && (medianUsd ?? 0) > 0
    const ratio = fromUsd
      ? medianUsd! / globalUsd
      : globalPriced > 0
        ? medianPriced / globalPriced
        : 1
    keys.push({
      adapterId: id.slice(0, cut),
      model: modelPart === '?' ? null : modelPart,
      samples: list.length,
      medianPriced,
      medianUsd,
      // ⚠️ Shrunk on the count of the series it was *measured* in. A ratio from four dollar
      // readings is a four-sample claim however many token samples sit behind the same key.
      usdSamples: usdList.length,
      learnedFrom: fromUsd ? 'usd' : 'priced_tokens',
      ratio,
      factor: shrink(ratio, fromUsd ? usdList.length : list.length),
      assumed: list.some((s) => s.assumed)
    })
  }
  keys.sort((a, b) => b.samples - a.samples)

  const factorOf = (adapterId: string, model: string | null): number =>
    keys.find((k) => k.adapterId === adapterId && k.model === model)?.factor ??
    keys.find((k) => k.adapterId === adapterId && k.model === null)?.factor ??
    1

  // ⛔ Warmth is measured on values the agent factor has already been divided out of. Measured
  // 2026-08-30: 8 of Sonnet's 14 completed runs were warm against 1 of Opus's 3, so a warmth term
  // read off the raw numbers would be reading the fleet's dispatch history rather than the cost of a
  // cold start.
  const neutralised = samples
    .filter((s) => s.adapterId)
    .map((s) => ({ warm: s.warm, value: s.priced / factorOf(s.adapterId, s.model) }))
  const midNeutral = centre(neutralised.map((s) => s.value))
  const warmSet = neutralised.filter((s) => s.warm === true)
  const coldSet = neutralised.filter((s) => s.warm === false)
  const warmFactor =
    midNeutral > 0 && warmSet.length > 0
      ? shrink(median(warmSet.map((s) => s.value)) / midNeutral, warmSet.length)
      : 1
  const coldFactor =
    midNeutral > 0 && coldSet.length > 0
      ? shrink(median(coldSet.map((s) => s.value)) / midNeutral, coldSet.length)
      : 1

  const divisor = (s: Sample): number =>
    s.adapterId
      ? factorOf(s.adapterId, s.model) *
        (s.warm === true ? warmFactor : s.warm === false ? coldFactor : 1)
      : 1

  const usdNeutral = samples.filter((s) => s.usd !== null).map((s) => s.usd! / divisor(s))

  const value: CostFactors = {
    keys,
    warmFactor,
    coldFactor,
    warmSamples: warmSet.length,
    coldSamples: coldSet.length,
    neutralPriced: median(samples.map((s) => s.priced / divisor(s))),
    neutralRaw: median(samples.map((s) => s.raw / divisor(s))),
    neutralUsd: usdNeutral.length > 0 ? medianFloat(usdNeutral) : null,
    samples: samples.length,
    usdSamples: usdNeutral.length,
    assumed: samples.some((s) => s.assumed)
  }
  cached = { fingerprint: print, value }
  return value
}

/** Test seam. ⚠️ The fingerprint covers ordinary use; this is for a database swapped underneath. */
export function resetCostFactors(): void {
  cached = null
}

/** The factor that applies to a candidate, and the sentence explaining where it came from. */
function factorFor(
  factors: CostFactors,
  on: EstimateOn | undefined
): { factor: number; samples: number; usdSamples: number; basis: string; assumed: boolean } {
  if (!on?.adapterId) return { factor: 1, samples: 0, usdSamples: 0, basis: '', assumed: false }

  const exact = factors.keys.find(
    (k) => k.adapterId === on.adapterId && k.model === (on.model ?? null)
  )
  const rung = exact ?? factors.keys.find((k) => k.adapterId === on.adapterId && k.model === null)
  if (!rung) {
    return {
      factor: 1,
      samples: 0,
      usdSamples: 0,
      basis: `, and nothing has completed on ${on.adapterId} yet, so no agent factor is applied`,
      assumed: false
    }
  }

  const warmth = on.warm === undefined ? 1 : on.warm ? factors.warmFactor : factors.coldFactor
  const warmthNote =
    on.warm === undefined ? '' : `, ×${warmth.toFixed(2)} for ${on.warm ? 'a warm' : 'a cold'} start`
  // ⚠️ Says which series the multiplier was measured in. A ×12 learned from dollars and a ×12
  // learned from priced tokens are different claims about the same key, and a reader chasing a
  // routing decision cannot tell them apart from the number alone.
  const unitNote =
    rung.learnedFrom === 'usd'
      ? `, learned from ${rung.usdSamples} priced run(s) in dollars`
      : `, learned in priced tokens${
          rung.usdSamples > 0
            ? ` — only ${rung.usdSamples} of its run(s) could be priced in money`
            : ' — none of its runs could be priced in money'
        }`
  return {
    factor: rung.factor * warmth,
    samples: rung.samples,
    usdSamples: rung.usdSamples,
    basis:
      `, ×${rung.factor.toFixed(2)} for ${keyId(rung.adapterId, rung.model)} ` +
      `(${rung.samples} run(s), raw ratio ${rung.ratio.toFixed(2)} shrunk toward 1)${unitNote}${warmthNote}` +
      (exact ? '' : ' — that model has no runs of its own, so the adapter-wide rung is used'),
    assumed: rung.assumed
  }
}

function estimateOf(input: {
  raw: number
  priced: number
  /** The size in money, or null where nothing behind this estimate could be priced. */
  usd: number | null
  /** How many priced runs the money size rests on. ⚠️ ≤ `samples`, and often far fewer. */
  usdSamples: number
  samples: number
  confidence: Confidence
  basis: string
  on: EstimateOn | undefined
  factors: CostFactors
}): Estimate {
  const applied = factorFor(input.factors, input.on)
  const usd = input.usd === null ? null : input.usd * applied.factor
  return {
    tokens: Math.round(input.raw * applied.factor),
    pricedTokens: Math.round(input.priced * applied.factor),
    usd,
    // ⛔ `none` exactly when there is no money answer, so nothing can read a dollar figure that
    // nothing measured. Otherwise the lower of the size's and the factor's own dollar samples.
    usdConfidence:
      usd === null
        ? 'none'
        : applied.usdSamples > 0
          ? lower(confidenceFor(input.usdSamples), confidenceFor(applied.usdSamples))
          : confidenceFor(input.usdSamples),
    // ⚠️ The lower of the two. A confident size estimate scaled by a one-sample factor is a
    // one-sample answer, and a gate told otherwise is a gate that opens when it should not.
    confidence: applied.samples
      ? lower(input.confidence, confidenceFor(applied.samples))
      : input.confidence,
    samples: input.samples,
    basis:
      input.basis +
      (input.usd === null
        ? ', in priced tokens — no run behind this estimate could be priced in money'
        : `, in dollars from ${input.usdSamples} priced run(s), with priced tokens beside it`) +
      applied.basis,
    factor: applied.factor,
    assumed: applied.assumed || input.factors.assumed
  }
}

/**
 * The fleet-neutral size of the work a project's runs have been doing.
 *
 * ⛔ De-scaled the same way the fleet-wide number is. A project that has only ever run on Antigravity
 * would otherwise carry that agent's multiplier into `size` and then be multiplied by it a second
 * time.
 */
function withinProject(
  projectId: string,
  factors: CostFactors
): { raw: number; priced: number; usd: number | null; usdSamples: number; samples: number } | null {
  const samples = loadSamples().filter((s) => s.projectId === projectId)
  if (samples.length === 0) return null
  const divisor = (s: Sample): number => {
    const key =
      factors.keys.find((k) => k.adapterId === s.adapterId && k.model === s.model) ??
      factors.keys.find((k) => k.adapterId === s.adapterId && k.model === null)
    const warmth = s.warm === true ? factors.warmFactor : s.warm === false ? factors.coldFactor : 1
    return (key?.factor ?? 1) * warmth
  }
  const usd = samples.filter((s) => s.usd !== null).map((s) => s.usd! / divisor(s))
  return {
    raw: median(samples.map((s) => s.raw / divisor(s))),
    priced: median(samples.map((s) => s.priced / divisor(s))),
    usd: usd.length > 0 ? medianFloat(usd) : null,
    usdSamples: usd.length,
    samples: samples.length
  }
}

/**
 * What this task will cost, optionally on a named agent and model.
 *
 * ⚠️ Called with no `on` it answers in fleet-neutral units, which is what a screen showing "this
 * task" rather than "this task *there*" wants. Every gate should pass a key: on this install's data
 * the difference between the two answers is 81x.
 */
export function estimateTask(task: Task, on?: EstimateOn): Estimate {
  const factors = costFactors()

  // An explicit estimate from a person or the controller outranks history: they know something about
  // this particular task that the average does not. ⛔ Still scaled by the agent factor — somebody
  // estimating "400k tokens" is describing the work, not predicting which CLI will be handed it.
  if (task.estTokens && task.estTokens > 0) {
    const pricedShare = factors.neutralRaw > 0 ? factors.neutralPriced / factors.neutralRaw : 1
    // What a fleet-neutral token of work has cost in money. ⚠️ Null where the fleet has no priced
    // run at all — a stated token count cannot invent a dollar figure nothing has measured.
    const usdShare =
      factors.neutralUsd !== null && factors.neutralRaw > 0
        ? factors.neutralUsd / factors.neutralRaw
        : null
    return estimateOf({
      raw: task.estTokens,
      priced: task.estTokens * pricedShare,
      usd: usdShare === null ? null : task.estTokens * usdShare,
      usdSamples: factors.usdSamples,
      samples: 0,
      confidence: 'medium',
      basis: 'stated on the task',
      on,
      factors
    })
  }

  if (factors.samples === 0) {
    return {
      tokens: COLD_FALLBACK_TOKENS,
      pricedTokens: COLD_FALLBACK_TOKENS,
      // ⛔ No money answer, rather than a pessimistic one. The token fallback is anchored to a real
      // measured run; there is no equivalent dollar figure to be deliberately pessimistic *with*.
      usd: null,
      usdConfidence: 'none',
      confidence: 'none',
      samples: 0,
      basis: 'nothing measured yet - deliberately pessimistic, and in priced tokens',
      factor: 1,
      assumed: false
    }
  }

  // Within the project first: the same fleet does very different work in different repositories.
  if (task.projectId) {
    const local = withinProject(task.projectId, factors)
    if (local) {
      return estimateOf({
        ...local,
        confidence: confidenceFor(local.samples),
        basis: `median of ${local.samples} completed run(s) in this project, de-scaled by agent`,
        on,
        factors
      })
    }
  }

  return estimateOf({
    raw: factors.neutralRaw,
    priced: factors.neutralPriced,
    usd: factors.neutralUsd,
    usdSamples: factors.usdSamples,
    samples: factors.samples,
    confidence: factors.samples < 5 ? 'low' : 'medium',
    basis: `median of ${factors.samples} completed run(s) across all projects, de-scaled by agent`,
    on,
    factors
  })
}

/**
 * How far past its estimate a run has gone. The runaway watchdog's input.
 *
 * ⛔ **In money where money exists, and against its own agent's estimate.** The dollar ratio is
 * preferred because that is the axis the operator evaluates cost on; it falls back to priced tokens
 * the moment either side is `n/a`, which on a fleet whose windows are not being read is most runs.
 *
 * ⛔ **Priced, and against its own agent's estimate.** Both halves were wrong before 2026-08-30: the
 * ratio was taken in raw tokens, which are 92-98% cache reads and so grow with a run's *length*
 * (cost-model.md §10), and it was taken against a fleet median no agent matched — an ordinary
 * Antigravity run started life at 81x before doing anything unusual, while an ordinary Sonnet run
 * could not reach 3x by being genuinely wasteful.
 *
 * Returns null when there is nothing to compare against: an unmeasured task cannot be a runaway, and
 * pretending otherwise would kill work for the crime of being first.
 */
export function overrunFactor(runId: string): number | null {
  const run = db()
    .prepare(
      `select r.id as id, r.task_id as task_id, r.project_id, r.adapter_id, r.model, r.cost_model_id,
              r.started_warm, r.input_tokens, r.output_tokens, r.cache_read_tokens,
              r.cache_write_tokens,
              (r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) as total
         from runs r where r.id = ? and r.kind = 'work'`
    )
    .get(runId) as (SampleRow & { task_id: string | null }) | undefined
  if (!run?.task_id || run.total <= 0) return null

  const task = db().prepare('select * from tasks where id = ?').get(run.task_id) as
    | { est_tokens: number | null; project_id: string | null }
    | undefined
  if (!task) return null

  const priced = modelFor(run)?.priceRun({
    inputTokens: run.input_tokens,
    outputTokens: run.output_tokens,
    cacheReadTokens: run.cache_read_tokens,
    cacheWriteTokens: run.cache_write_tokens
  })

  const estimate = estimateTask({ estTokens: task.est_tokens, projectId: task.project_id } as Task, {
    adapterId: run.adapter_id,
    model: run.model,
    ...(run.started_warm === null ? {} : { warm: run.started_warm === 1 })
  })
  if (estimate.confidence === 'none') return null

  // Money first. ⚠️ Both sides must be real: a run priced `n/a` against a dollar estimate, or the
  // reverse, is not a ratio at all, and silently treating either `null` as zero would either
  // exonerate a runaway or condemn an ordinary run.
  const spentUsd = priceForRun(runId)?.usd ?? null
  if (spentUsd !== null && estimate.usd !== null && estimate.usd > 0) return spentUsd / estimate.usd

  return (priced?.tokens ?? run.total) / Math.max(1, estimate.pricedTokens)
}

/**
 * The most expensive agent the fleet has measured, as a key to estimate against.
 *
 * ⛔ For gates that must decide *before* a worker is chosen. An under-estimate is what breaks a
 * gate — it admits work that then blows a parent's budget — so where the agent is genuinely unknown
 * the honest substitute is the worst one the fleet actually has, not the middle one it does not.
 *
 * ⚠️ Undefined until something has completed. A gate then gets the fleet-neutral answer, which is
 * the same answer it got before any of this existed.
 */
export function pessimisticOn(): EstimateOn | undefined {
  const factors = costFactors()
  const worst = [...factors.keys].sort((a, b) => b.factor - a.factor)[0]
  if (!worst) return undefined
  return {
    adapterId: worst.adapterId,
    model: worst.model,
    warm: factors.warmFactor > factors.coldFactor
  }
}

/** Logged once at startup, so a routing decision that looks wrong has a record to be checked against. */
export function logCostFactors(): void {
  const factors = costFactors()
  if (factors.samples === 0) return
  log.info(
    `cost factors from ${factors.samples} completed run(s): ` +
      factors.keys
        .slice(0, 6)
        .map((k) => `${keyId(k.adapterId, k.model)} ×${k.factor.toFixed(2)} (n=${k.samples})`)
        .join(', ')
  )
}
