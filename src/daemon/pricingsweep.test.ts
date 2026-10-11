import { describe, expect, it } from 'vitest'
import { attribute, type AttributionRun, type Reading } from './price.js'
import { referenceAttribute } from './fixtures/pricing-reference.js'

describe('pricing sweep preserves recorded arithmetic and evidence', () => {
  it('matches the original for shuffled, overlapping, open and partially measured runs', () => {
    let seed = 1046
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let trial = 0; trial < 500; trial++) {
      const runs: AttributionRun[] = Array.from({ length: 30 }, (_, i) => {
        const start = Math.floor(random() * 100_000_000)
        return { id: `r${i}`, startedAt: start, endedAt: random() < 0.1 ? null : start + Math.floor(random() * 100_000_000) }
      })
      const readings: Reading[] = Array.from({ length: 80 }, () => ({
        at: Math.floor(random() * 200_000_000 / 1000) * 1000, percent: random() * 100, stale: random() < 0.2
      }))
      readings.push(...readings.slice(0, 5).map((r) => ({ ...r, stale: !r.stale })))
      for (const direction of ['rises', 'falls'] as const) {
        expect(attribute(runs, readings, 170_000_000, { direction }))
          .toEqual(referenceAttribute(runs, readings, 170_000_000, { direction }))
      }
    }
  })

  it('scales through a long sparse history without allocating every span on every segment', () => {
    const runs = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, startedAt: i * 100_000, endedAt: i * 100_000 + 40_000 }))
    const readings = Array.from({ length: 20_000 }, (_, i) => ({ at: i * 5000, percent: (i % 200) / 2 }))
    expect(attribute(runs, readings, 100_000_000)).toEqual(referenceAttribute(runs, readings, 100_000_000))
  })
})
