import { adapters } from './adapters/index.js'
import { benchmarkPrior } from './benchmarks.js'
import { knownModelIds } from './workers.js'
import { qualityReport } from './quality.js'
import type { QualityKey } from '@shared/quality.js'

/**
 * How fit a model is believed to be, blending a benchmark prior with this fleet's own peer reviews.
 *
 * ⚠️ **Why the prior is the baseline rather than the measurement.**
 * `transient_docs/quality_review_2026-09-03.md` §12: nothing calibrates the composite across
 * providers, no task on this fleet has ever been run twice on two models, and a handful of reviews
 * would otherwise mint a reputation. Shrinking the measured composite toward a published (or
 * honestly inferred) benchmark number, rather than trusting it outright from review one, is what
 * keeps three lucky reviews from outranking a model with a hundred mediocre ones.
 *
 * ⛔ **Nothing here gates on anything, and this file does not change that.** `@shared/review.ts` and
 * `@shared/quality.ts` both open with the same sentence: no routing decision reads a composite. This
 * is a new number computed the same way, for whichever future score chooses to read it.
 */

export interface Fitness {
  adapterId: string
  model: string | null
  /** 0..1 from `benchmarkPrior`. `null` when the model is unbenchmarked. */
  prior: number | null
  /** `cleanComposite / 10`. `null` when nothing clean has been graded. */
  measured: number | null
  /** ⚠️ The **clean** review count, never `samples` — see the note on `rungFor` below. */
  samples: number
  /** The blend, or `null` when neither a prior nor a clean review exists. Never 0, never 0.5. */
  value: number | null
  basis: string
}

/**
 * How fast a key earns the right to move off its prior: `prior^(K/(n+K)) · measured^(n/(n+K))`, in
 * log space — the same shape `shrink` (`estimator.ts`) and `shrinkPace` (`pace.ts`) already use, so
 * all three read the same way side by side.
 *
 * ⭐ **Higher than the estimator's 5 and pace's 4, deliberately.** A quality composite is graded by a
 * peer LLM against a rubric nobody has calibrated across providers or reviewers — the least
 * measured quantity of the three — and it should take more evidence to move it than it takes to
 * move a token total (which is metered exactly) or a duration (which is a wall clock). K = 8 means a
 * single clean review keeps only `8/(1+8) ≈ 11%` of the distance between the prior and what that one
 * review said; it takes on the order of twenty before the measured number dominates.
 */
const K = 8

function blend(prior: number, measured: number, n: number): number {
  return Math.exp((K * Math.log(prior) + n * Math.log(measured)) / (n + K))
}

/**
 * The quality-review rung for one key: the exact `(adapterId, model)` bucket, then the adapter-wide
 * one `qualityReport()` already produces for reviews whose subject model was never recorded — the
 * same fallback shape `paceFor` climbs, except this rung is real data rather than something
 * synthesized on the way past: `qualityKeys` (`quality.ts`) buckets a review with no recorded
 * `subject_model` under `model: null` on its own, and this just asks for that bucket by name.
 */
function rungFor(keys: QualityKey[], adapterId: string, model: string | null): QualityKey | null {
  return (
    keys.find((k) => k.adapterId === adapterId && k.model === (model ?? null)) ??
    keys.find((k) => k.adapterId === adapterId && k.model === null) ??
    null
  )
}

/**
 * @param keys The quality rungs to read, from a `qualityReport()` the caller already has.
 *
 * ⛔ **Pass these in from any loop.** `qualityReport()` reads the whole reviews table and runs four
 * more counting queries, and this function is called once per routing candidate — the same reason
 * `paceFor` takes `PaceFactors` rather than calling `paceFactors()` itself. Omitting the argument
 * loads a fresh report, which is right for a one-off caller and wrong inside `chooseTarget`.
 */
export function fitnessFor(
  adapterId: string,
  model: string | null,
  keys?: QualityKey[]
): Fitness {
  const rungs = keys ?? qualityReport().keys
  const exact = rungs.find((k) => k.adapterId === adapterId && k.model === (model ?? null))
  const rung = rungFor(rungs, adapterId, model)
  const rungIsExact = !!exact
  const rungIsAdapterWide = !rungIsExact && !!rung

  const priorInfo = benchmarkPrior(model)
  const prior = priorInfo.agentic
  // ⛔ `clean`, never `samples`. `@shared/quality.ts`: "clean ... is the number to compare agents
  // on"; a review of a task two adapters both worked on, or one whose blinding leaked, is counted
  // but excluded from `cleanComposite` for the same reason, and shrinking on the wrong count would
  // let a key with ten reviews and two clean ones shrink as if it had earned all ten.
  const n = rung?.clean ?? 0
  const measured = rung && rung.cleanComposite !== null && n > 0 ? rung.cleanComposite / 10 : null

  const rungNote = rungIsExact
    ? `the exact (${adapterId}, ${model ?? '?'}) key`
    : rungIsAdapterWide
      ? `${adapterId}'s adapter-wide rung (no review of this model recorded a model id)`
      : 'no quality review of this key at all'

  let value: number | null
  let blendNote: string

  if (prior !== null && measured !== null) {
    value = blend(prior, measured, n)
    blendNote =
      `blended from a benchmark prior of ${prior.toFixed(2)} (${priorInfo.basis}) and ${n} clean ` +
      `review(s) averaging ${measured.toFixed(2)}, shrunk toward the prior with K=${K}`
  } else if (prior !== null) {
    // ⛔ Degenerate case 1: a prior, nothing graded. `value = prior` — not 0.5, not the prior halved.
    value = prior
    blendNote = `nothing has been graded on this key yet, so the benchmark prior stands alone (${priorInfo.basis})`
  } else if (measured !== null) {
    // ⛔ Degenerate case 2: reviews exist, no prior. `value = measured`, unshrunk — there is nothing
    // to shrink it toward.
    value = measured
    blendNote = `no benchmark prior exists for this model, so the answer rests entirely on ${n} clean review(s) of an unbenchmarked model`
  } else {
    // ⛔ Degenerate case 3, and the one this whole file exists to get right: neither exists.
    // `AGENTS.md`: "`unknown` is a verdict, not a synonym for `ok` or for 'half as bad'."
    value = null
    blendNote = 'neither a benchmark prior nor a clean review exists for this key'
  }

  return {
    adapterId,
    model,
    prior,
    measured,
    samples: n,
    value,
    basis: `${rungNote}: ${blendNote}`
  }
}

/**
 * Every model this fleet can currently price, with its fitness — the same universe `model.options`
 * (`api.ts`) serves to the composer, so the operator surface can show "known" and "unknown" side by
 * side rather than only the models that happen to have been graded.
 */
export function fitnessTable(): Fitness[] {
  const out: Fitness[] = []
  // ⛔ One report for the whole table, not one per model. See `fitnessFor`'s `keys` parameter.
  const keys = qualityReport().keys
  for (const a of adapters()) {
    let ids: string[]
    try {
      ids = knownModelIds(a.info.id)
    } catch {
      continue
    }
    for (const id of ids) out.push(fitnessFor(a.info.id, id, keys))
  }
  return out
}
