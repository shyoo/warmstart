import { describe, expect, it } from 'vitest'
import type { Objective } from '@shared/tasks.js'
import {
  PRESETS,
  DEFAULT_OBJECTIVE,
  normalise,
  parseObjective,
  presetOf,
  resolveObjective,
  policy,
  WEIGHT_FORMULAS,
  weights
} from './objective.js'

/**
 * M3's pure logic. Each of these is a place where being wrong costs money quietly rather than
 * failing loudly.
 */

describe('objectives', () => {
  it('every preset is a unit vector', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const total = preset.cost + preset.velocity + preset.quality
      expect(total, name).toBeCloseTo(1, 5)
    }
  })

  it('normalises whatever it is handed rather than trusting the caller', () => {
    const result = normalise({ cost: 2, velocity: 1, quality: 1 })
    expect(result.cost + result.velocity + result.quality).toBeCloseTo(1, 5)
    expect(result.cost).toBeCloseTo(0.5, 5)
  })

  it('falls back rather than dividing by zero', () => {
    expect(normalise({ cost: 0, velocity: 0, quality: 0 })).toEqual(PRESETS.balanced)
  })

  it('reads a preset name or an explicit vector, and rejects nonsense', () => {
    expect(parseObjective('economy')).toEqual(PRESETS.economy)
    expect(parseObjective({ cost: 1, velocity: 0, quality: 0 })?.cost).toBe(1)
    expect(parseObjective('nope')).toBeNull()
    expect(parseObjective(42)).toBeNull()
  })

  it('presetOf recognises preset vectors and returns null for custom vectors', () => {
    expect(presetOf(PRESETS.economy)).toBe('economy')
    expect(presetOf(PRESETS.balanced)).toBe('balanced')
    expect(presetOf(PRESETS.velocity)).toBe('velocity')
    expect(presetOf(PRESETS.quality)).toBe('quality')
    expect(presetOf({ cost: 0.5, velocity: 0.25, quality: 0.25 })).toBeNull()
  })

  it('resolveObjective follows 3-tier precedence: task -> project -> fleet/default', () => {
    const fleetDefault = PRESETS.economy
    // 1. Task override takes top precedence
    expect(resolveObjective('quality', 'velocity', fleetDefault)).toEqual(PRESETS.velocity)
    // 2. Project override applies when task is not set / inherits
    expect(resolveObjective('quality', 'inherit', fleetDefault)).toEqual(PRESETS.quality)
    expect(resolveObjective({ config: { objective: 'quality' } }, null, fleetDefault)).toEqual(PRESETS.quality)
    // 3. Fleet fallback applies when neither project nor task overrides
    expect(resolveObjective(null, 'inherit', fleetDefault)).toEqual(fleetDefault)
    expect(resolveObjective(undefined, undefined)).toEqual(DEFAULT_OBJECTIVE)
  })
})

describe('weights', () => {
  it('cost-weighted work values a warm session more than velocity-weighted does', () => {
    // The whole point of the vector: this is a continuous consequence, not a switch on a mode name.
    expect(weights(PRESETS.economy).cacheWarmth).toBeGreaterThan(weights(PRESETS.velocity).cacheWarmth)
  })

  it('cost-weighted work prices a cold start higher', () => {
    expect(weights(PRESETS.economy).cold).toBeGreaterThan(weights(PRESETS.velocity).cold)
  })

  it('quality-weighted work punishes context rot hardest', () => {
    expect(weights(PRESETS.quality).contextRot).toBeGreaterThan(weights(PRESETS.economy).contextRot)
  })

  it('no weight is ever negative, whatever the vector', () => {
    for (const preset of Object.values(PRESETS)) {
      for (const [key, value] of Object.entries(weights(preset))) {
        expect(value, `${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('cost policy', () => {
  it('cost-weighted work compacts sooner than velocity-weighted', () => {
    expect(policy(PRESETS.economy).compactThresholdMs).toBeLessThan(
      policy(PRESETS.velocity).compactThresholdMs
    )
  })

  it('the compact threshold stays near the measured ~2h break-even', () => {
    // docs/cost-model.md §3: 58 + 1.2n = 30n, so n ≈ 2.0 hours. The vector moves it, but not far -
    // a threshold that wandered to 20 minutes or 10 hours would mean the arithmetic was lost.
    for (const preset of Object.values(PRESETS)) {
      const hours = policy(preset).compactThresholdMs / 3_600_000
      expect(hours).toBeGreaterThan(1)
      expect(hours).toBeLessThan(4)
    }
  })

  it('cost-weighted work leaves a bigger margin before a window closes', () => {
    expect(policy(PRESETS.economy).preemptMarginMs).toBeGreaterThan(
      policy(PRESETS.velocity).preemptMarginMs
    )
  })

  it('the preempt margin always covers a ~2.7 minute compaction', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(policy(preset).preemptMarginMs).toBeGreaterThan(3 * 60 * 1000)
    }
  })

  it('only velocity-weighted work gambles a keepalive on an unknown budget', () => {
    expect(policy(PRESETS.velocity).keepaliveWhenQuotaUnknown).toBe(true)
    expect(policy(PRESETS.economy).keepaliveWhenQuotaUnknown).toBe(false)
    expect(policy(PRESETS.quality).keepaliveWhenQuotaUnknown).toBe(false)
  })
})

describe('the published weight formulas', () => {
  /**
   * ⛔ **A derivation that can drift from its code is worse than none**, because it is believed. The
   * strings in `WEIGHT_FORMULAS` are printed to an operator and to the controller as the reason a
   * weight is what it is; this evaluates each one and checks it against `weights()`, so editing the
   * arithmetic without editing the published formula fails here rather than in somebody's reading of
   * a routing decision.
   */
  const evaluate = (formula: string, o: Objective): number => {
    // ⛔ Parsed, never evaluated. `Function(…)` on a string is implied eval, and a test that reaches
    // for it to check a published constant has traded a real guarantee for a convenient one.
    // The grammar is deliberately tiny: signed terms of `number` or `number×name`.
    const vars: Record<string, number> = {
      cost: o.cost,
      velocity: o.velocity,
      quality: o.quality
    }
    let total = 0
    for (const [, sign, body] of formula.matchAll(/([+−-]?)\s*([\d.]+(?:×[a-z]+)?)/g)) {
      const factor = sign === '−' || sign === '-' ? -1 : 1
      const [num, name] = (body as string).split('×')
      const scalar = Number(num)
      if (Number.isNaN(scalar)) throw new Error(`unparsed term: ${body} in ${formula}`)
      if (name === undefined) {
        total += factor * scalar
      } else {
        const v = vars[name]
        if (v === undefined) throw new Error(`unknown variable ${name} in ${formula}`)
        total += factor * scalar * v
      }
    }
    return total
  }

  const vectors: Objective[] = [
    { cost: 0.34, velocity: 0.33, quality: 0.33 },
    { cost: 0.7, velocity: 0.15, quality: 0.15 },
    { cost: 0.15, velocity: 0.7, quality: 0.15 },
    { cost: 0.15, velocity: 0.15, quality: 0.7 }
  ]

  it('evaluate to exactly the weights the scheduler uses, on every preset', () => {
    for (const v of vectors) {
      const w = weights(v)
      for (const [name, formula] of Object.entries(WEIGHT_FORMULAS)) {
        expect(evaluate(formula, v), `${name} on ${JSON.stringify(v)}`).toBeCloseTo(
          w[name as keyof typeof w],
          10
        )
      }
    }
  })

  it('cover every weight, so none is printed without a derivation', () => {
    const declared = Object.keys(WEIGHT_FORMULAS).sort()
    const actual = Object.keys(weights(vectors[0] as Objective)).sort()
    expect(declared).toEqual(actual)
  })
})
