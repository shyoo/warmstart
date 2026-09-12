import { describe, expect, it } from 'vitest'
import type { PriceStatRow, StatisticsReport } from '@shared/statistics.js'
import { graphLabel, labelColumn, measuredModelPoints, priceRowsForGraph } from './Statistics.js'

function row(key: string, basis: PriceStatRow['basis']): PriceStatRow {
  return {
    key,
    level: 'model',
    label: key,
    adapterId: 'claude-code',
    model: key,
    effort: null,
    distribution: { samples: 1, average: 1, p50: 1, p99: 1, p100: 1 },
    basis,
    unpriced: 0
  }
}

describe('priceRowsForGraph', () => {
  it('gives subscription and API/mixed graphs mutually exclusive model rows', () => {
    const rows = [row('subscription-model', 'subscription'), row('api-model', 'api'), row('mixed-model', 'mixed')]

    expect(priceRowsForGraph(rows, ['subscription']).map((value) => value.key)).toEqual(['subscription-model'])
    expect(priceRowsForGraph(rows, ['api', 'mixed']).map((value) => value.key)).toEqual([
      'api-model',
      'mixed-model'
    ])
  })
})

describe('graphLabel', () => {
  const agents = new Map([['claude-code', 'Claude Code']])

  it('names the harness in front of the model, because two harnesses can serve one model', () => {
    expect(graphLabel(row('claude-sonnet-5', 'subscription'), agents)).toBe('Claude Code · Sonnet 5')
  })

  it('names the billing basis only when asked, so a subscription-only chart does not say subs twice', () => {
    // t361: *Opus 5 (subs)* under a title that already read *Subscription* said the same thing twice
    // and took the width the model name needed.
    expect(graphLabel(row('claude-opus-5', 'subscription'), agents)).toBe('Claude Code · Opus 5')
    expect(graphLabel(row('claude-opus-5', 'mixed'), agents, true)).toBe('Claude Code · Opus 5 (mixed)')
  })
})

describe('labelColumn', () => {
  it('keeps the type at 12 for short labels and never truncates them', () => {
    const column = labelColumn(['Claude Code · Opus 5', 'Codex CLI · GPT 5.6'])
    expect(column.fontSize).toBe(12)
    expect(column.maxChars).toBeGreaterThanOrEqual(20)
  })

  it('steps the type down and widens the column before cutting a long label', () => {
    // t361: the column was a fixed 250 and cut anything past 34 characters with an ellipsis.
    const long = 'Antigravity · Gemini 3.8 Flash Med (mixed)'
    const column = labelColumn([long, 'Claude Code · Opus 5'])
    expect(column.fontSize).toBeLessThan(12)
    expect(column.maxChars).toBeGreaterThanOrEqual(long.length)
    expect(column.width).toBeGreaterThan(250)
    expect(column.width).toBeLessThanOrEqual(360)
  })
})

describe('measuredModelPoints', () => {
  function distribution(average: number, samples = 1) {
    return { samples, average, p50: average, p99: average, p100: average }
  }

  function report(priceRows: PriceStatRow[]): StatisticsReport {
    const velocityRow = {
      key: 'claude-code/claude-sonnet-5',
      level: 'model' as const,
      label: 'claude-sonnet-5',
      adapterId: 'claude-code',
      model: 'claude-sonnet-5',
      effort: null,
      distribution: distribution(5)
    }
    const agentRow = { ...velocityRow, key: 'claude-code', level: 'agent' as const, label: 'Claude Code', model: null }
    const qualityRow = {
      key: 'claude-code/claude-sonnet-5',
      level: 'model' as const,
      label: 'claude-sonnet-5',
      adapterId: 'claude-code',
      model: 'claude-sonnet-5',
      effort: null,
      prior: null,
      priorBasis: null,
      cleanComposite: null,
      clean: 0,
      samples: 0,
      fitness: null,
      fitnessBasis: null,
      tasks: 1,
      distribution: distribution(8)
    }
    return {
      generatedAt: 0,
      sampleLimit: null,
      window: 'all',
      price: { rows: priceRows, tasks: 1, unpriced: 0, estimated: false },
      velocity: { rows: [agentRow, velocityRow], tasks: 1, untimed: 0 },
      quality: { rows: [qualityRow], totalReviews: 0, ungraded: 1, rubricVersion: 'v1' }
    }
  }

  it('folds a model billed both ways into one point when nothing is excluded', () => {
    const rows = [row('claude-sonnet-5', 'subscription'), row('claude-sonnet-5', 'api')]
    rows[0]!.distribution = distribution(2)
    rows[1]!.distribution = distribution(10)
    const points = measuredModelPoints(report(rows))
    expect(points).toHaveLength(1)
    expect(points[0]!.cost).toBe(6) // average of the two basis rows folded together
    expect(points[0]!.adapterId).toBe('claude-code')
  })

  it('drops API-rate and mixed price rows when excludeApiMixed is set', () => {
    const rows = [row('claude-sonnet-5', 'subscription'), row('claude-sonnet-5', 'api')]
    rows[0]!.distribution = distribution(2)
    rows[1]!.distribution = distribution(10)
    const points = measuredModelPoints(report(rows), true)
    expect(points).toHaveLength(1)
    expect(points[0]!.cost).toBe(2) // only the subscription row counted
  })

  it('drops a model out of the comparison entirely when its only price row is excluded', () => {
    const points = measuredModelPoints(report([row('claude-sonnet-5', 'mixed')]), true)
    expect(points).toHaveLength(0)
  })
})
