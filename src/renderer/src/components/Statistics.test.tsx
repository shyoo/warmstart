import { describe, expect, it } from 'vitest'
import type { PriceStatRow, StatisticsReport } from '@shared/statistics.js'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  graphLabel,
  labelColumn,
  measuredModelPoints,
  placeScatterLabels,
  priceRowsForGraph,
  TradeoffPlots
} from './Statistics.js'

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
  // ⚠️ Five by default — the trust floor `MIN_TRUSTED_SAMPLES` sets — so every test below is about
  // folding logic rather than accidentally tripping the sample-count filter tested on its own below.
  function distribution(average: number, samples = 5) {
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

  /**
   * ⭐ Requested 2026-09-13: below five finished tasks on any axis, a model "cannot be much
   * trusted" and drops off the plot entirely rather than draw a bar over a guess.
   */
  it('drops a model whose weakest axis has fewer than five samples', () => {
    const rows = [row('claude-sonnet-5', 'subscription')]
    rows[0]!.distribution = distribution(2, 4) // one axis under the floor
    expect(measuredModelPoints(report(rows))).toHaveLength(0)
  })

  it('keeps a model once every axis reaches the floor, and reports its weakest count', () => {
    const rows = [row('claude-sonnet-5', 'subscription')]
    rows[0]!.distribution = distribution(2, 5)
    const points = measuredModelPoints(report(rows))
    expect(points).toHaveLength(1)
    // velocityRow/qualityRow above both fold 5 samples; price folds 5 too, so the weakest is 5.
    expect(points[0]!.samples).toBe(5)
  })
})

/**
 * The trade-off scatters' drawing, not only their arithmetic.
 *
 * ⭐ Retired 2026-09-14: the earlier rotatable 3D plot was reported confusing to read and hard to
 * interact with, and is replaced by three flat y/x scatters — quality against cost, quality against
 * active time and cost against active time — each readable without dragging anything.
 *
 * ⚠️ `renderToStaticMarkup`, because the suites run with `environment: 'node'` and there is no DOM to
 * mount into. It is enough for what is being claimed: that all three scatters render, one mark per
 * measured model, positioned inside its own plot area.
 */
describe('the trade-off scatters draw one mark per model on every pair of axes', () => {
  // ⚠️ Five by default, at `MIN_TRUSTED_SAMPLES` — otherwise both models here would be dropped by
  // the sample-count filter and this suite would be asserting properties of an empty plot.
  function distribution(average: number, samples = 5) {
    return { samples, average, p50: average, p99: average, p100: average }
  }

  /** Two models, each measured on all three axes, which is the gate the plot renders behind. */
  function measuredReport(): StatisticsReport {
    const model = (name: string, average: number) => ({
      key: `claude-code/${name}`,
      level: 'model' as const,
      label: name,
      adapterId: 'claude-code',
      model: name,
      effort: null,
      distribution: distribution(average)
    })
    const quality = (name: string, average: number) => ({
      ...model(name, average),
      prior: null,
      priorBasis: null,
      cleanComposite: null,
      clean: 0,
      samples: 0,
      fitness: null,
      fitnessBasis: null,
      tasks: 1
    })
    const price = (name: string, average: number): PriceStatRow => ({
      ...model(name, average),
      basis: 'subscription',
      unpriced: 0
    })
    return {
      generatedAt: 0,
      sampleLimit: null,
      window: 'all',
      price: { rows: [price('claude-opus-5', 3), price('claude-sonnet-5', 1)], tasks: 2, unpriced: 0, estimated: false },
      velocity: {
        rows: [
          { ...model('claude-code', 4), key: 'claude-code', level: 'agent' as const, label: 'Claude Code', model: null },
          model('claude-opus-5', 9),
          model('claude-sonnet-5', 4)
        ],
        tasks: 2,
        untimed: 0
      },
      quality: {
        rows: [quality('claude-opus-5', 9), quality('claude-sonnet-5', 6)],
        totalReviews: 2,
        ungraded: 0,
        rubricVersion: 'v1'
      }
    }
  }

  const markup = renderToStaticMarkup(<TradeoffPlots report={measuredReport()} />)

  it('draws three scatters, one per pair of measured axes', () => {
    expect([...markup.matchAll(/class="scatter-plot-svg"/g)]).toHaveLength(3)
    expect(
      [...markup.matchAll(/class="scatter-plot-title">([^<]+)<span[^>]*>vs<\/span> ([^<]+)/g)].map((match) =>
        `${match[1]!.trim()} vs ${match[2]!.trim()}`
      )
    ).toEqual(['Quality vs Cost', 'Quality vs Active time', 'Cost vs Active time'])
  })

  /** ⭐ Quality is always the vertical axis and active time always the horizontal one (2026-09-23). */
  it('puts quality on the y axis and active time on the x axis', () => {
    const titles = [...markup.matchAll(/class="scatter-plot-axis-label"[^>]*>([^<(]+)\(/g)].map((m) => m[1]!.trim())
    expect(titles).toEqual(['Cost', 'Quality', 'Active time', 'Quality', 'Active time', 'Cost'])
  })

  /** ⛔ Two models measured on all three axes is two marks per scatter, six in total. */
  it('draws one mark per model in every scatter', () => {
    const halos = [...markup.matchAll(/class="scatter-plot-point-halo"/g)]
    expect(halos).toHaveLength(6)
  })

  it('positions every mark inside its own plot area', () => {
    const circles = [...markup.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="[\d.]+" class="scatter-plot-point-halo"/g)]
    expect(circles.length).toBeGreaterThan(0)
    for (const [, x, y] of circles) {
      expect(Number(x)).toBeGreaterThanOrEqual(0)
      expect(Number(x)).toBeLessThanOrEqual(300)
      expect(Number(y)).toBeGreaterThanOrEqual(0)
      expect(Number(y)).toBeLessThanOrEqual(220)
    }
  })

  it('names the model beside every mark, since the icon only names the agent', () => {
    expect([...markup.matchAll(/class="scatter-plot-mark-label"/g)]).toHaveLength(6)
    expect(markup).toMatch(/>Opus 5<\/text>/)
    expect(markup).toMatch(/>Sonnet 5<\/text>/)
  })

  it('says which side of each axis is better by position, not "higher", since cost is plotted inverted', () => {
    expect([...markup.matchAll(/\(right is better\)/g)]).toHaveLength(3)
    expect([...markup.matchAll(/\(top is better\)/g)]).toHaveLength(3)
    expect(markup).not.toMatch(/higher is better/)
  })

  it('leaves no trace of the retired 3D plot classes', () => {
    expect(markup).not.toMatch(/three-axis/)
  })
})

describe('placeScatterLabels', () => {
  const bounds = { left: 46, right: 286, top: 12, bottom: 190 }

  it('keeps a lone label on its mark, to the right', () => {
    const label = placeScatterLabels([{ key: 'a', text: 'Opus 5', cx: 100, cy: 100 }], bounds, 7)[0]!
    expect(label.anchor).toBe('start')
    expect(label.x).toBeGreaterThan(100)
    expect(label.y).toBe(100)
    expect(label.displaced).toBe(false)
  })

  it('puts a label left of a mark near the right edge rather than off the plot', () => {
    const label = placeScatterLabels([{ key: 'a', text: 'Gemini 3.1 Pro High', cx: 270, cy: 100 }], bounds, 7)[0]!
    expect(label.anchor).toBe('end')
    expect(label.x).toBeLessThan(270)
  })

  /** ⛔ The reported case: three models graded within a hair of each other drew one unreadable blot. */
  it('never overprints two labels, or a label and another mark, when marks overlap', () => {
    const labels = placeScatterLabels(
      [
        { key: 'a', text: 'Opus 5', cx: 200, cy: 30 },
        { key: 'b', text: 'GPT 5.6 Sol', cx: 202, cy: 31 },
        { key: 'c', text: 'Muse Spark 1.3', cx: 201, cy: 33 }
      ],
      bounds,
      7
    )
    // The same 4.4px-per-character estimate the placement uses; this checks the geometry, not the type.
    const box = (l: (typeof labels)[number]) => {
      const width = l.text.length * 4.4
      return l.anchor === 'start' ? { x0: l.x, x1: l.x + width, y: l.y } : { x0: l.x - width, x1: l.x, y: l.y }
    }
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue
        const [p, q] = [box(a), box(b)]
        const apart = p.x1 < q.x0 || p.x0 > q.x1 || Math.abs(p.y - q.y) >= 9
        expect(apart).toBe(true)
      }
      for (const other of labels) {
        if (other === a) continue
        const p = box(a)
        const clear = other.cx + 7 < p.x0 || other.cx - 7 > p.x1 || Math.abs(other.cy - p.y) >= 7 + 4.5
        expect(clear).toBe(true)
      }
    }
    for (const l of labels) {
      expect(l.y).toBeGreaterThanOrEqual(bounds.top)
      expect(l.y).toBeLessThanOrEqual(bounds.bottom)
    }
  })
})
