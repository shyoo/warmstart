import type { Objective, ObjectivePreset } from '@shared/tasks.js'

/**
 * Objectives: cost, velocity, quality.
 *
 * Different people want different things, and the same person wants different things on different
 * days. So it is a **weight vector**, not a mode.
 *
 * ⛔ **Nothing may branch on a preset's name**, and the vector is consumed in exactly two places:
 * `weights()`, which feeds scheduler scoring, and `policy()`, which the cache clock, the model
 * selector and preemption consult. Anything else reading an objective is a design smell — if a third
 * consumer appears, one of these two is missing a field.
 */

export const PRESETS: Record<ObjectivePreset, Objective> = {
  economy: { cost: 0.7, velocity: 0.15, quality: 0.15 },
  balanced: { cost: 0.34, velocity: 0.33, quality: 0.33 },
  velocity: { cost: 0.15, velocity: 0.7, quality: 0.15 },
  quality: { cost: 0.15, velocity: 0.15, quality: 0.7 }
}

export const DEFAULT_OBJECTIVE: Objective = PRESETS.balanced

export function normalise(objective: Partial<Objective>): Objective {
  const cost = Math.max(0, objective.cost ?? 0)
  const velocity = Math.max(0, objective.velocity ?? 0)
  const quality = Math.max(0, objective.quality ?? 0)
  const total = cost + velocity + quality
  if (total === 0) return DEFAULT_OBJECTIVE
  return { cost: cost / total, velocity: velocity / total, quality: quality / total }
}

/** A preset name, an explicit vector, or nothing. Presets are just named vectors. */
export function parseObjective(value: unknown): Objective | null {
  if (typeof value === 'string') {
    const preset = PRESETS[value.toLowerCase() as ObjectivePreset]
    return preset ? { ...preset } : null
  }
  if (value && typeof value === 'object') {
    const record = value as Partial<Objective>
    if ('cost' in record || 'velocity' in record || 'quality' in record) return normalise(record)
  }
  return null
}

/** Global default → project override → task override. The result is recorded on every Run. */
export function resolveObjective(project?: unknown, task?: unknown): Objective {
  return parseObjective(task) ?? parseObjective(project) ?? DEFAULT_OBJECTIVE
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
  capabilityFit: '0.7 + 1.3×quality'
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
    capabilityFit: 0.7 + 1.3 * quality
  }
}

// ---------------------------------------------------------------------------- consumer 2

export interface CostPolicy {
  /** Below this much expected idleness, do nothing: the TTL covers it anyway. */
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

export function policy(objective: Objective): CostPolicy {
  const { cost, velocity, quality } = objective
  return {
    keepaliveFloorMs: 55 * 60 * 1000,
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
