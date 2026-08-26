import { describe, expect, it } from 'vitest'
import { PRESETS, normalise, parseObjective, policy, weights } from './objective.js'

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
})

describe('weights', () => {
  it('cost-weighted work values a warm session more than velocity-weighted does', () => {
    // The whole point of the vector: this is a continuous consequence, not a switch on a mode name.
    expect(weights(PRESETS.economy).warm).toBeGreaterThan(weights(PRESETS.velocity).warm)
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
