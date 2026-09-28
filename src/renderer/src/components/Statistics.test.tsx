import { describe, expect, it } from 'vitest'
import type { PriceStatRow, StatisticsReport } from '@shared/statistics.js'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  graphLabel,
  labelColumn,
  measuredModelPoints,
  placeScatterLabels,
  priceRowsForGraph,
  sampleNote,
  TradeoffPlots,
  withoutSoleEfforts
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
      includeConversations: true,
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
 * t812: "Show effort level" splits each model into one point per effort it ran at.
 */
describe('measuredModelPoints by effort', () => {
  const dist = (average: number, samples = 5) => ({ samples, average, p50: average, p99: average, p100: average })
  function at(
    level: 'model' | 'effort',
    model: string,
    effort: string | null,
    average: number,
    extra: { basis?: PriceStatRow['basis']; sole?: boolean; samples?: number } = {}
  ) {
    return {
      key: `claude-code/${model}${effort ? `/${effort}` : ''}${extra.basis ? `/${extra.basis}` : ''}`,
      level,
      label: effort ?? model,
      adapterId: 'claude-code',
      model,
      effort,
      ...(extra.sole ? { sole: true } : {}),
      distribution: dist(average, extra.samples)
    }
  }
  function quality(row: ReturnType<typeof at>) {
    return {
      ...row,
      prior: null,
      priorBasis: null,
      cleanComposite: row.distribution.average,
      clean: row.distribution.samples,
      samples: row.distribution.samples,
      fitness: null,
      fitnessBasis: null,
      tasks: row.distribution.samples
    }
  }
  function report(rows: {
    price: Array<ReturnType<typeof at>>
    velocity: Array<ReturnType<typeof at>>
    quality: Array<ReturnType<typeof at>>
  }): StatisticsReport {
    return {
      generatedAt: 0,
      sampleLimit: null,
      window: 'all',
      includeConversations: true,
      price: {
        rows: rows.price.map((r) => ({ basis: 'subscription' as const, unpriced: 0, ...r })),
        tasks: 1,
        unpriced: 0,
        estimated: false
      },
      velocity: { rows: rows.velocity, tasks: 1, untimed: 0 },
      quality: { rows: rows.quality.map(quality), totalReviews: 0, ungraded: 0, rubricVersion: 'v1' }
    }
  }

  const twoEfforts = report({
    price: [
      at('model', 'claude-opus-5', null, 3, { samples: 10 }),
      at('effort', 'claude-opus-5', 'high', 4),
      at('effort', 'claude-opus-5', 'low', 2)
    ],
    velocity: [
      at('model', 'claude-opus-5', null, 30, { samples: 10 }),
      at('effort', 'claude-opus-5', 'high', 40),
      at('effort', 'claude-opus-5', 'low', 20)
    ],
    quality: [
      at('model', 'claude-opus-5', null, 8, { samples: 10 }),
      at('effort', 'claude-opus-5', 'high', 9),
      at('effort', 'claude-opus-5', 'low', 7)
    ]
  })

  it('draws one point per model when off, and one per effort when on', () => {
    expect(measuredModelPoints(twoEfforts).map((p) => p.cost)).toEqual([3])
    const split = measuredModelPoints(twoEfforts, false, true)
    expect(split.map((p) => [p.shortLabel, p.cost, p.velocity, p.quality])).toEqual([
      ['Opus 5 High', 4, 40, 9],
      ['Opus 5 Low', 2, 20, 7]
    ])
  })

  it('places a single-effort model at its effort from the sole row', () => {
    const sole = report({
      price: [at('model', 'claude-opus-5', null, 3), at('effort', 'claude-opus-5', 'high', 3, { sole: true })],
      velocity: [at('model', 'claude-opus-5', null, 30), at('effort', 'claude-opus-5', 'high', 30, { sole: true })],
      quality: [at('model', 'claude-opus-5', null, 8), at('effort', 'claude-opus-5', 'high', 8, { sole: true })]
    })
    expect(measuredModelPoints(sole, false, true).map((p) => p.shortLabel)).toEqual(['Opus 5 High'])
  })

  /**
   * t814: gpt-5.6-terra's *Med* mark graded 9.4 over 10 tasks while the model graded 8.1 over 109;
   * the hover has to say the mark is a slice of its model, not the model.
   */
  it('gives an effort mark its model\'s task count, and a model mark none', () => {
    const [high] = measuredModelPoints(twoEfforts, false, true)
    expect(sampleNote(high!)).toBe("n=5 · of the model's 10 tasks")
    expect(sampleNote(measuredModelPoints(twoEfforts)[0]!)).toBe('n=10')
  })

  it('keeps a model with no recorded effort as its one model-level point', () => {
    const none = report({
      price: [at('model', 'claude-haiku-4-5', null, 1)],
      velocity: [at('model', 'claude-haiku-4-5', null, 10)],
      quality: [at('model', 'claude-haiku-4-5', null, 7)]
    })
    expect(measuredModelPoints(none, false, true).map((p) => p.shortLabel)).toEqual(['Haiku 4.5'])
  })

  it('holds each effort point to the same five-task floor', () => {
    const thin = report({
      price: [at('model', 'claude-opus-5', null, 3, { samples: 8 }), at('effort', 'claude-opus-5', 'high', 4), at('effort', 'claude-opus-5', 'low', 2, { samples: 3 })],
      velocity: [at('model', 'claude-opus-5', null, 30, { samples: 8 }), at('effort', 'claude-opus-5', 'high', 40), at('effort', 'claude-opus-5', 'low', 20, { samples: 3 })],
      quality: [at('model', 'claude-opus-5', null, 8, { samples: 8 }), at('effort', 'claude-opus-5', 'high', 9), at('effort', 'claude-opus-5', 'low', 7, { samples: 3 })]
    })
    expect(measuredModelPoints(thin, false, true).map((p) => p.shortLabel)).toEqual(['Opus 5 High'])
  })

  it('hides sole effort rows from the tabs, but no other row', () => {
    const rows = [at('model', 'claude-opus-5', null, 3), at('effort', 'claude-opus-5', 'high', 3, { sole: true })]
    const shown = withoutSoleEfforts(report({ price: rows, velocity: rows, quality: rows }))
    expect(shown.price.rows.map((r) => r.level)).toEqual(['model'])
    expect(shown.velocity.rows.map((r) => r.level)).toEqual(['model'])
    expect(shown.quality.rows.map((r) => r.level)).toEqual(['model'])
    expect(withoutSoleEfforts(twoEfforts).velocity.rows).toHaveLength(3)
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
// ⚠️ Five by default, at `MIN_TRUSTED_SAMPLES` — otherwise both models here would be dropped by
// the sample-count filter and this suite would be asserting properties of an empty plot.
function distribution(average: number, samples = 5) {
  return { samples, average, p50: average, p99: average, p100: average }
}

function scatterModel(name: string, average: number) {
  return {
    key: `claude-code/${name}`,
    level: 'model' as const,
    label: name,
    adapterId: 'claude-code',
    model: name,
    effort: null,
    distribution: distribution(average)
  }
}

function scatterQuality(name: string, average: number) {
  return {
    ...scatterModel(name, average),
    prior: null,
    priorBasis: null,
    cleanComposite: null,
    clean: 0,
    samples: 0,
    fitness: null,
    fitnessBasis: null,
    tasks: 1
  }
}

function scatterPrice(name: string, average: number): PriceStatRow {
  return {
    ...scatterModel(name, average),
    basis: 'subscription',
    unpriced: 0
  }
}

/** Two models, each measured on all three axes, which is the gate the plot renders behind. */
function measuredReport(sonnetQuality = 6): StatisticsReport {
  return {
    generatedAt: 0,
    sampleLimit: null,
    window: 'all',
    includeConversations: true,
    price: {
      rows: [scatterPrice('claude-opus-5', 3), scatterPrice('claude-sonnet-5', 1)],
      tasks: 2,
      unpriced: 0,
      estimated: false
    },
    velocity: {
      rows: [
        {
          ...scatterModel('claude-code', 4),
          key: 'claude-code',
          level: 'agent' as const,
          label: 'Claude Code',
          model: null
        },
        scatterModel('claude-opus-5', 9),
        scatterModel('claude-sonnet-5', 4)
      ],
      tasks: 2,
      untimed: 0
    },
    quality: {
      rows: [scatterQuality('claude-opus-5', 9), scatterQuality('claude-sonnet-5', sonnetQuality)],
      totalReviews: 2,
      ungraded: 0,
      rubricVersion: 'v1'
    }
  }
}

describe('the trade-off scatters draw one mark per model on every pair of axes', () => {
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

  /** t814: a mark's hover says how many tasks stand behind it, on the icon's own title too. */
  it('prints n= in every mark\'s hover', () => {
    const titles = [...markup.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]!)
    expect(titles.length).toBeGreaterThan(0)
    expect(titles.every((t) => /\(n=\d+\)/.test(t))).toBe(true)
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

/**
 * The quality axis is zoomed to 5..10 (t778): the models cluster high (most between 7.5 and 9),
 * so a 0..10 axis flattens the very differences the plot exists to show.
 */
describe('the quality axis shows 5.0 to 10.0', () => {
  const markup = renderToStaticMarkup(<TradeoffPlots report={measuredReport()} />)
  const svgs = markup.split('class="scatter-plot-svg"').slice(1)
  const yTicksOf = (svg: string): string[] =>
    [...svg.matchAll(/<text[^>]*text-anchor="end"[^>]*class="scatter-plot-tick"[^>]*>([^<]+)</g)].map(
      (m) => m[1]!
    )
  const circlesOf = (svg: string): Array<{ cx: number; cy: number }> =>
    [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2])
    }))

  it('labels the quality y axis 5.0 to 10.0 on both quality scatters', () => {
    expect(svgs).toHaveLength(3)
    expect(yTicksOf(svgs[0]!)).toEqual(['5.0', '6.0', '7.0', '8.0', '9.0', '10.0'])
    expect(yTicksOf(svgs[1]!)).toEqual(['5.0', '6.0', '7.0', '8.0', '9.0', '10.0'])
  })

  it('leaves the cost y axis starting at zero', () => {
    const costTicks = yTicksOf(svgs[2]!)
    expect(costTicks).toHaveLength(5)
    expect(costTicks[costTicks.length - 1]).toBe('$0.00')
  })

  it('spreads neighbouring grades across the zoomed span', () => {
    // Quality 9 vs 6 is 3 rubric points over a 5-point span: 60% of the 178px plot height —
    // on the old 0..10 axis the same pair sat 53px apart.
    const [a, b] = circlesOf(svgs[0]!)
    expect(Math.abs(a!.cy - b!.cy)).toBeGreaterThan(100)
  })

  it('holds a sub-5 grade at the axis edge instead of off the chart', () => {
    // Sonnet grading 2 — below the zoomed span — but still measured on all three axes.
    const low = renderToStaticMarkup(<TradeoffPlots report={measuredReport(2)} />)
    const first = low.split('class="scatter-plot-svg"').slice(1)[0]!
    for (const { cy } of circlesOf(first)) {
      // Plot area runs marginTop 12 to height - marginBottom 190; nothing may fall below it.
      expect(cy).toBeLessThanOrEqual(190)
    }
    expect(first).toMatch(/<circle cx="[-\d.]+" cy="190"/)
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
