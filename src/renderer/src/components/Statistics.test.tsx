import { describe, expect, it } from 'vitest'
import type { PriceStatRow, StatisticsReport } from '@shared/statistics.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { graphLabel, labelColumn, measuredModelPoints, priceRowsForGraph, ThreeAxisPlot } from './Statistics.js'

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

/**
 * The three-axis plot's drawing, not only its arithmetic.
 *
 * ⭐ Reported 2026-09-13: *is it possible to draw some bars from the bottom to the point, such that
 * where they are anchored? It is currently challenging to see where the pareto planes exist.* An
 * isometric scatter gives a mark no readable position — two icons a centimetre apart on screen can be
 * anywhere along each other's line of sight — so each one now stands on a bar down to a ruled floor.
 *
 * ⚠️ `renderToStaticMarkup`, because the suites run with `environment: 'node'` and there is no DOM to
 * mount into. It is enough for what is being claimed: that the elements exist, one bar per mark, and
 * that each bar is vertical and ends where its own mark is. The geometry itself is pinned separately
 * in `lib/plot3d.test.ts`; this is the wiring between the two.
 */
describe('the three-axis plot draws an anchor under every mark', () => {
  function distribution(average: number, samples = 1) {
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

  const markup = renderToStaticMarkup(<ThreeAxisPlot report={measuredReport()} />)
  /** ⚠️ `<line …></line>`, which is how React serialises it — not the self-closing form. */
  const attrs = (cls: string): Array<Record<string, number>> =>
    [...markup.matchAll(/<line ([^>]*)>/g)]
      .map((m) => m[1] ?? '')
      .filter((a) => a.includes(`class="${cls}"`))
      .map((a) => {
        const out: Record<string, number> = {}
        for (const [, k, v] of a.matchAll(/(x1|y1|x2|y2)="([^"]+)"/g)) out[k as string] = Number(v)
        return out
      })

  it('draws the floor as a ruled plane rather than leaving the marks in mid-air', () => {
    // ⚠️ `floorGrid`'s default is four divisions, which is five lines each way.
    expect(attrs('three-axis-grid')).toHaveLength(10)
  })

  /** ⛔ One bar per mark, and a foot under each: two models measured on three axes is two of each. */
  it('draws one bar and one foot per mark', () => {
    expect(attrs('three-axis-stem')).toHaveLength(2)
    expect([...markup.matchAll(/class="three-axis-foot"/g)]).toHaveLength(2)
  })

  /**
   * ⛔ The claim the whole feature makes: the bar is vertical and its top *is* the mark. A bar that
   * merely pointed at the floor somewhere nearby would be a confident wrong anchor.
   */
  it('stands each bar upright, ending where its own mark is drawn', () => {
    const stems = attrs('three-axis-stem')
    const icons = [...markup.matchAll(/<g transform="translate\(([-\d.]+), ([-\d.]+)\)"/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2])
    }))
    expect(stems).toHaveLength(2)
    expect(icons.length).toBeGreaterThanOrEqual(2)
    for (const stem of stems) {
      expect(stem.x1).toBeCloseTo(stem.x2 as number, 6)
      // The foot is at or below the top on screen, so a taller measurement reads as a taller bar.
      expect(stem.y1).toBeGreaterThanOrEqual(stem.y2 as number)
      // ⚠️ The icon is translated by its own radius, so its centre is the bar's top.
      expect(icons.some((i) => Math.abs(i.x + 8 - (stem.x2 as number)) < 1.5)).toBe(true)
    }
    // ⚠️ And at least one bar has real length, or this would pass on a plot drawn flat.
    expect(stems.some((s) => (s.y1 as number) - (s.y2 as number) > 1)).toBe(true)
  })

  /**
   * ⚠️ One mark is always on the floor — the axis is scaled to the worst measurement, so whatever
   * is worst sits at zero. It keeps its foot: *anchored at zero* is a reading, and a mark with no
   * anchor at all would read as one whose bar had been forgotten.
   */
  it('still marks the foot of a point that sits on the floor', () => {
    const flat = attrs('three-axis-stem').filter((s) => s.y1 === s.y2)
    expect(flat).toHaveLength(1)
    expect([...markup.matchAll(/class="three-axis-foot"/g)]).toHaveLength(2)
  })

  it('says in words that the marks stand on the floor, so the drawing is explained once', () => {
    expect(markup).toMatch(/standing on a bar/)
  })
})
