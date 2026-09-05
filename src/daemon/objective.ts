import type { Objective, ObjectivePreset } from '@shared/tasks.js'
import {
  PRESETS,
  DEFAULT_OBJECTIVE,
  normalise,
  parseObjective,
  presetOf
} from '@shared/tasks.js'

export {
  PRESETS,
  DEFAULT_OBJECTIVE,
  normalise,
  parseObjective,
  presetOf,
  type ObjectivePreset
}

/** Global default → project override → task override. The result is recorded on every Run. */
export function resolveObjective(
  project?: unknown,
  task?: unknown,
  fallback: Objective = DEFAULT_OBJECTIVE
): Objective {
  const taskObj = parseObjective(
    task && typeof task === 'object' && 'objective' in task
      ? task.objective
      : task
  )
  const projectObj = parseObjective(
    project && typeof project === 'object' && 'config' in project
      ? (project.config as { objective?: unknown } | undefined)?.objective
      : project && typeof project === 'object' && 'objective' in project
      ? project.objective
      : project
  )
  return taskObj ?? projectObj ?? fallback
}

// ---------------------------------------------------------------------------- consumer 1

export interface Weights {
  /** A live cache is an asset with an expiry date; using it is the cheapest thing available. */
  warm: number
  affinity: number
  /** Context rot is documented, not folklore: accuracy and recall degrade as tokens grow. */
  contextRot: number
  projectSwitch: number
  quotaRisk: number
  /** A cold start pays a full cache write. This is what prices splitting. */
  cold: number
  capabilityFit: number
  /**
   * How much a *measured* difference in how long an agent takes is worth.
   *
   * ⛔ Velocity-only, because that is the axis it belongs to and nothing else. Being slow is not the
   * same as being expensive — a cheap agent that takes three hours and a dear one that takes twenty
   * minutes are both real, and folding cost into this weight would make the cost axis pay twice for
   * the same preference while the velocity axis paid nothing.
   */
  pace: number
  /**
   * How much model fitness matters.
   *
   * Sufficiency, not excellence: as long as the model meets the complexity band's sufficiency bar,
   * it earns the full bonus. Exceeding the bar earns nothing more, so a dearer model cannot
   * out-earn a sufficient cheap one on this term and price decides.
   */
  fitness: number
  /**
   * How much relative task price matters.
   *
   * Penalty scaling from 0 (cheapest in the field) to 1 (8x or more expensive).
   */
  price: number
}

/**
 * Each weight's derivation, as the arithmetic it actually is.
 *
 * ⛔ **Published so a score can be checked rather than believed.** A rendered `1.249` tells an
 * operator nothing — not where it came from, not whether it is large, not what would move it. These
 * strings are printed beside the number they produce, and `objective.test.ts` evaluates every one of
 * them against `weights()` so the published derivation cannot drift from the code that computes it.
 *
 * ⚠️ Written with `×` and `−` because they are read by people, and parsed back by that test.
 */
export const WEIGHT_FORMULAS: Record<keyof Weights, string> = {
  warm: '1.0 + 2.2×cost − 0.6×velocity',
  affinity: '0.8 + 1.0×cost + 0.4×quality',
  contextRot: '0.6 + 1.6×quality',
  projectSwitch: '0.3 + 0.6×cost',
  quotaRisk: '0.5 + 1.2×cost',
  cold: '0.8 + 2.0×cost − 0.7×velocity',
  capabilityFit: '0.7 + 1.3×quality',
  pace: '0.3 + 1.7×velocity',
  fitness: '0.4 + 1.6×quality',
  price: '0.5 + 2.0×cost'
}

export function weights(objective: Objective): Weights {
  const { cost, velocity, quality } = objective
  return {
    // Cost-weighted work hugs warm sessions; velocity-weighted work tolerates a cold start to begin
    // sooner. Both are continuous in the weights - neither is a switch.
    warm: 1.0 + 2.2 * cost - 0.6 * velocity,
    affinity: 0.8 + 1.0 * cost + 0.4 * quality,
    contextRot: 0.6 + 1.6 * quality,
    projectSwitch: 0.3 + 0.6 * cost,
    quotaRisk: 0.5 + 1.2 * cost,
    cold: 0.8 + 2.0 * cost - 0.7 * velocity,
    capabilityFit: 0.7 + 1.3 * quality,
    // Measured speed matters to everyone a little and to velocity-weighted work a lot. It is never
    // zero: a fleet that has learned one agent takes four times as long should still prefer the
    // other when nothing else separates them.
    pace: 0.3 + 1.7 * velocity,
    fitness: 0.4 + 1.6 * quality,
    price: 0.5 + 2.0 * cost
  }
}

// ---------------------------------------------------------------------------- consumer 2

export interface CostPolicy {
  /**
   * Below this much expected idleness, do nothing: the TTL covers it anyway.
   *
   * ⛔ **Derived from the provider's TTL, not fixed.** The sentence above is the whole definition,
   * and it is only true relative to a particular TTL — "the TTL covers it" cannot be a constant
   * when the TTL is 60 minutes on Anthropic and 30 on OpenAI. Hardcoded at 55m, this said *do
   * nothing below 55 minutes of idleness* to a provider whose prefix is gone at 30, which is a
   * floor above the whole window: every codex session would skip the keepalive branch and fall
   * through to a compaction it cannot perform. See `policy`.
   */
  keepaliveFloorMs: number
  /** Above this, compaction beats keepalive. ~2h at the measured constants; the vector moves it. */
  compactThresholdMs: number
  /** How long before a window resets to start wrapping up. Cost-weighted is generous. */
  preemptMarginMs: number
  /** Multiplier on a worker's configured concurrency. Cost-weighted serialises onto warm sessions. */
  concurrencyMultiplier: number
  verificationDefault: 'auto' | 'required' | 'not_required'
  /** Whether a keepalive may be spent at all when the quota reading is not trustworthy. */
  keepaliveWhenQuotaUnknown: boolean
}

/** What `policy` assumes when the caller has no cost model to hand. Anthropic's, and unchanged. */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000

/**
 * ⚠️ `cacheTtlMs` defaults to Anthropic's hour, so every existing caller gets exactly the numbers it
 * got before. Only a caller that passes a provider's real TTL sees different ones.
 */
export function policy(objective: Objective, cacheTtlMs = DEFAULT_CACHE_TTL_MS): CostPolicy {
  const { cost, velocity, quality } = objective
  return {
    // ⛔ Five minutes short of the TTL, which is the 55m this used to hardcode when the TTL was
    // assumed to be an hour — so Anthropic's behaviour is unchanged to the millisecond. The margin
    // is what stops a session being left to lapse inside the last few minutes on the grounds that
    // the TTL "covers" an idleness it only just covers.
    keepaliveFloorMs: Math.max(0, cacheTtlMs - 5 * 60 * 1000),
    // The measured break-even is ~2h (docs/cost-model.md §3). Cost-weighted compacts earlier because
    // it would rather pay 58k once than 30k an hour; velocity-weighted keeps context hot for longer.
    compactThresholdMs: (2 * 60 - 35 * cost + 40 * velocity) * 60 * 1000,
    // Must cover the wrap-up turns plus ~2 minutes of compaction plus the reserve.
    preemptMarginMs: (8 + 14 * cost + 6 * quality - 4 * velocity) * 60 * 1000,
    concurrencyMultiplier: velocity > 0.5 ? 2 : 1,
    verificationDefault: quality > 0.5 ? 'required' : cost > 0.5 ? 'auto' : 'auto',
    // ⚠️ Spending tokens to hold a cache open on an account whose remaining budget is unknown is a
    // gamble. Cost- and quality-weighted work declines it; velocity-weighted accepts it.
    keepaliveWhenQuotaUnknown: velocity > 0.4
  }
}
