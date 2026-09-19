import { useCallback, useEffect, useState } from 'react'
import type {
  Distribution,
  PriceBasis,
  PriceStatRow,
  QualityStatRow,
  StatRow,
  StatisticsReport,
  StatisticsWindow
} from '@shared/statistics'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { duration, money, when } from '../lib/format'
import { compactModelLabel, effortLabel, modelLabel } from '../lib/modelname'
import {
  readStatisticsExcludeApiMixed,
  readStatisticsWindow,
  writeStatisticsExcludeApiMixed,
  writeStatisticsWindow
} from '../lib/prefs'
import { errorMessage } from '@shared/errors.js'
import { AgentIcon } from './AgentIcon'

/**
 * Analytics › Statistics.
 *
 * ⛔ **The descriptive page, and it is not a second Routing Model.** Every tab under Routing Model
 * answers *why the scheduler chose that account*, so every number on it is built to be acted on —
 * and each is therefore shrunk toward a neutral middle by how little evidence stands behind it. This
 * page answers *what actually happened*, where shrinking is the wrong operation: a person budgeting
 * for a task wants the tail, not a factor that has been pulled toward the fleet average precisely so
 * that a lucky sample cannot move the router.
 *
 * ⚠️ **The two pages will disagree about the same fleet, and that is not a bug to reconcile.**
 * Velocity here prints a measured p50 in minutes; Velocity under Routing Model prints a shrunk ratio
 * against the fleet's geometric centre. Both are right about their own question, and the notes on
 * each tab say which question that is rather than leaving a reader to discover the difference by
 * finding two numbers that will not line up.
 *
 * ⛔ **One fetch for three tabs.** The price, the duration and the grade have to be folded over the
 * same window of finished tasks or the columns are not comparable; three calls would let a task land
 * between them.
 */
export type StatisticsTab = 'price' | 'velocity' | 'quality'

export const STATISTICS_TABS: Array<{ id: StatisticsTab; label: string }> = [
  { id: 'price', label: 'Model Price per Task' },
  { id: 'velocity', label: 'Velocity per Task' },
  { id: 'quality', label: 'Quality per Task' }
]

/**
 * How the three depths are drawn.
 *
 * ⚠️ Indent alone, no expanders. The tree is at most three rungs and the whole point of the page is
 * comparing an agent against its own models; a collapsed table hides exactly the comparison the
 * reader came for, and a table that remembers which rungs were open is state nobody asked for.
 */
const LEVEL_CLASS: Record<StatRow['level'], string> = {
  agent: 'stat-row stat-row--agent',
  model: 'stat-row stat-row--model',
  effort: 'stat-row stat-row--effort'
}

const BASIS_LABEL: Record<PriceBasis, string> = {
  subscription: 'subs',
  api: 'API rate',
  mixed: 'mixed',
  unknown: 'unpriced'
}

const BASIS_TITLE: Record<PriceBasis, string> = {
  subscription:
    'Every task here was paid for out of a flat monthly fee. The dollars are an amortised share of ' +
    'that fee — nobody was billed them at the moment the work ran.',
  api:
    'Every task here was billed on top of the subscription, at a market rate, when it ran: Claude ' +
    'extra-usage overage, Antigravity cloud credits or Codex credits.',
  mixed:
    'Some of these tasks drew on the flat fee and some were billed on top. One account crossing ' +
    'into overage mid-month puts every total above it here.',
  unknown: 'Nothing in this group could be priced. That is not the same statement as "it was free".'
}

/** The label a row prints in its first column, at the depth it sits. */
function rowLabel(row: { level: StatRow['level']; label: string; model: string | null }): string {
  if (row.level === 'agent') return row.label
  if (row.level === 'effort') return effortLabel(row.label) ?? row.label
  // ⚠️ `?` is `pace.ts`'s spelling for work whose model was never recorded, and it has to be said
  // in words here — a lone question mark in a table reads as a rendering fault.
  // ⛔ `<synthetic>` is the same statement wearing a different mask: Claude Code's JSONL
  //    bookkeeping placeholder, which migration 34 cleaned out of `turns` and `sessions` and left on
  //    24 `runs` rows. It is not a model anybody chose and must not sit in a table looking like one.
  //    `modelLabel` already returns null for it, so this only supplies the words.
  return modelLabel(row.label) ?? 'model not recorded'
}

/**
 * The same label, with the harness that ran it in front of it.
 *
 * ⛔ **A model id does not name a runner, and on this fleet two of them run the same model.**
 * `claude-sonnet-4-6` is served both by Claude Code and by Antigravity, at different prices out of
 * different subscriptions — so a bar labelled *Sonnet 4.6* in a chart with no parent row to indent
 * under is a comparison between two things the reader cannot tell apart. The table carries the
 * harness in the agent row above each model; a chart has no such row, so it carries it inline.
 */
export function graphLabel(
  row: { level: StatRow['level']; label: string; model: string | null; adapterId: string; basis?: PriceBasis },
  agents: Map<string, string>,
  /**
   * The price chart splits the model rung by billing basis, so a bar has to say which dollars it is
   * in — but only when the chart it sits in holds more than one basis. ⛔ *Opus 5 (subs)* under a
   * title that already reads *Subscription* said the same thing twice and took the width a model
   * name needed (t361); the API & mixed chart still needs it, because those two bars are different
   * dollars.
   */
  nameBasis = false
): string {
  const own = rowLabel(row)
  const suffixed =
    nameBasis && row.level !== 'effort' && row.basis && row.basis !== 'unknown'
      ? `${own} (${BASIS_LABEL[row.basis]})`
      : own
  if (row.level === 'agent') return suffixed
  const agent = agents.get(row.adapterId)
  return agent ? `${agent} · ${suffixed}` : suffixed
}

/**
 * The label column of a chart, sized to the longest label it has to hold.
 *
 * ⛔ The column was a fixed 250 units and any label past 34 characters was cut with an ellipsis,
 * so *Antigravity · Gemini 3.8 Flash Med (subs)* lost its model (t361). The width now follows the
 * text and the type steps down one size at a time before anything is cut — a chart whose labels
 * cannot be read is not a comparison, whatever its bars say.
 *
 * ⚠️ The character width is an estimate (Inter at 12px averages ~0.56em); it only has to be
 * generous, since the column is a cap on the text, not a fit.
 */
export function labelColumn(labels: string[]): { width: number; fontSize: number; maxChars: number } {
  const longest = labels.reduce((n, l) => Math.max(n, l.length), 0)
  const fontSize = longest > 44 ? 10 : longest > 34 ? 11 : 12
  const perChar = fontSize * 0.58
  const width = Math.min(360, Math.max(180, Math.ceil(longest * perChar) + 24))
  return { width, fontSize, maxChars: Math.floor((width - 24) / perChar) }
}

/**
 * ⛔ `n/a`, never a dash and never `$0.00`. `money()` and `duration()` already draw that line for
 * their own units; this is the one place a whole distribution can be absent.
 */
function cells(
  d: Distribution,
  render: (value: number) => string
): React.JSX.Element {
  return (
    <>
      <td className="tbl-num num">{d.average === null ? 'n/a' : render(d.average)}</td>
      <td className="tbl-num num">{d.p50 === null ? 'n/a' : render(d.p50)}</td>
      <td className="tbl-num num">{d.p99 === null ? 'n/a' : render(d.p99)}</td>
      <td className="tbl-num num">{d.p100 === null ? 'n/a' : render(d.p100)}</td>
    </>
  )
}

/**
 * ⚠️ The sample count is not decoration. A `p99` over four tasks is the maximum wearing a
 * percentile's name, and the only defence against reading it as a tail is printing what it rests on
 * next to it.
 */
function thin(samples: number): boolean {
  return samples < 5
}

/**
 * The two price charts are comparisons within one billing basis, never two views of the same rows.
 * Agent totals can be `mixed`, but model rows already carry the per-task basis that makes a chart
 * comparison meaningful, so keep only rows the requested chart explicitly names.
 */
export function priceRowsForGraph(rows: PriceStatRow[], bases: PriceBasis[]): PriceStatRow[] {
  // Agent rows are label context, never graph data when model rows exist. Keep them even when their
  // aggregate basis is mixed so `graphLabel` can still say “Claude Code · Opus 5” for a model row
  // in the subscription-only chart.
  return rows.filter((row) => row.level === 'agent' || bases.includes(row.basis))
}

const GRAPH_TITLE: Record<'price' | 'velocity' | 'quality', string> = {
  price: 'Price Distribution Comparison',
  velocity: 'Active Time Distribution Comparison',
  quality: 'Clean Composite Distribution Comparison'
}

function StatGraph({
  rows,
  unit,
  render,
  title
}: {
  rows: Array<StatRow & { basis?: PriceBasis; unpriced?: number }>
  unit: 'price' | 'velocity' | 'quality'
  render: (value: number) => string
  /** Price uses separate scales for subscription and API/overage work. */
  title?: string
}): React.JSX.Element | null {
  const [mode, setMode] = useState<'whisker' | 'grouped'>('whisker')
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Prefer model-level rows; fallback to agent-level if no model rows exist
  const modelRows = rows.filter((r) => r.level === 'model' && r.distribution.samples > 0)
  const targetRows = modelRows.length > 0 ? modelRows : rows.filter((r) => r.distribution.samples > 0)

  // ⚠️ Read off the agent rows rather than off the adapter registry: the registry knows every
  // adapter ever compiled in, and this chart must name only the ones the table above it is folding.
  const agentLabels = new Map(rows.filter((r) => r.level === 'agent').map((r) => [r.adapterId, r.label]))

  if (targetRows.length === 0) return null

  // A bar names its billing basis only when this chart holds more than one — see `graphLabel`.
  const nameBasis =
    unit === 'price' && new Set(targetRows.map((r) => r.basis ?? 'unknown')).size > 1
  const labels = targetRows.map((row) => graphLabel(row, agentLabels, nameBasis))
  const column = labelColumn(labels)

  const maxVal = Math.max(
    1,
    ...targetRows.flatMap((r) => [
      r.distribution.p100 ?? 0,
      r.distribution.p99 ?? 0,
      r.distribution.average ?? 0,
      r.distribution.p50 ?? 0
    ])
  )

  // ⚠️ Sized to the longest label, because the harness sits in front of the model name and the
  //    price chart may put the basis after it.
  const labelWidth = column.width
  const chartWidth = 470
  const totalWidth = labelWidth + chartWidth + 30
  const rowHeight = mode === 'whisker' ? 34 : 48
  const headerHeight = 32
  const totalHeight = headerHeight + targetRows.length * rowHeight + 20

  const scale = (val: number | null) => {
    if (val === null || val <= 0) return 0
    return Math.min(chartWidth, (val / maxVal) * chartWidth)
  }

  // Ticks for axis
  const tickCount = 5
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (maxVal / tickCount) * i)

  return (
    <div
      className="stat-graph-box"
      style={{
        marginBottom: 'var(--sp-4)',
        padding: 'var(--sp-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface)'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sp-2)',
          flexWrap: 'wrap',
          gap: 'var(--sp-2)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-body)' }}>
            {title ?? GRAPH_TITLE[unit]}
          </span>
          <div
            className="btn-group"
            style={{
              display: 'inline-flex',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              border: '1px solid var(--color-border)'
            }}
          >
            <button
              type="button"
              className={`btn btn--xs ${mode === 'whisker' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ borderRadius: 0, padding: '2px 8px', fontSize: '11px' }}
              onClick={() => setMode('whisker')}
            >
              Range &amp; Whisker
            </button>
            <button
              type="button"
              className={`btn btn--xs ${mode === 'grouped' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ borderRadius: 0, padding: '2px 8px', fontSize: '11px' }}
              onClick={() => setMode('grouped')}
            >
              Grouped Bars
            </button>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-3)',
            fontSize: 'var(--text-meta)'
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 10,
                height: 10,
                background: '#38bdf8',
                transform: 'rotate(45deg)',
                display: 'inline-block'
              }}
            />
            Average
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 12,
                height: 8,
                background: '#34d399',
                borderRadius: 2,
                display: 'inline-block'
              }}
            />
            p50 (Median)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 12,
                height: 8,
                background: '#fbbf24',
                borderRadius: 2,
                display: 'inline-block'
              }}
            />
            p99
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 12,
                height: 8,
                background: '#f472b6',
                borderRadius: 2,
                display: 'inline-block'
              }}
            />
            p100 (Max)
          </span>
        </div>
      </div>

      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${totalWidth} ${totalHeight}`}
          style={{ width: '100%', minWidth: 620, height: 'auto', display: 'block' }}
        >
          {/* Axis Gridlines & Labels */}
          {ticks.map((t, idx) => {
            const x = labelWidth + scale(t)
            return (
              <g key={idx}>
                <line
                  x1={x}
                  y1={headerHeight - 8}
                  x2={x}
                  y2={totalHeight - 12}
                  stroke="var(--color-border)"
                  strokeDasharray={idx === 0 ? undefined : '2,2'}
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y={headerHeight - 12}
                  textAnchor={idx === 0 ? 'start' : idx === tickCount ? 'end' : 'middle'}
                  fill="var(--color-text-dim)"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  {render(t)}
                </text>
              </g>
            )
          })}

          {/* Rows */}
          {targetRows.map((row, idx) => {
            const y = headerHeight + idx * rowHeight
            const d = row.distribution
            const xAvg = scale(d.average)
            const xP50 = scale(d.p50)
            const xP99 = scale(d.p99)
            const xP100 = scale(d.p100)
            const isHovered = hoveredIdx === idx

            const label = labels[idx] ?? ''

            return (
              <g
                key={row.key}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Row highlight */}
                {isHovered && (
                  <rect
                    x="0"
                    y={y}
                    width={totalWidth}
                    height={rowHeight}
                    fill="var(--color-surface-hover, rgba(255,255,255,0.04))"
                    rx="3"
                  />
                )}

                {/* Model Label */}
                <text
                  x={labelWidth - 12}
                  y={y + (mode === 'whisker' ? rowHeight / 2 + 4 : 16)}
                  textAnchor="end"
                  fill={isHovered ? 'var(--color-text)' : 'var(--color-text-dim)'}
                  fontSize={column.fontSize}
                  fontWeight={row.level === 'agent' ? '600' : '400'}
                >
                  {label.length > column.maxChars ? label.slice(0, column.maxChars - 1) + '…' : label}
                </text>

                {mode === 'whisker' ? (
                  // Range & Whisker Mode
                  <g transform={`translate(${labelWidth}, ${y + rowHeight / 2})`}>
                    {/* Background span line / bar 0 -> p100 */}
                    <rect
                      x={0}
                      y={-4}
                      width={xP100}
                      height={8}
                      fill="rgba(244, 114, 182, 0.15)"
                      rx={3}
                    />

                    {/* Whisker bar p50 -> p100 */}
                    <line x1={xP50} y1={0} x2={xP100} y2={0} stroke="#f472b6" strokeWidth="2" />

                    {/* p50 -> p99 highlight */}
                    <line x1={xP50} y1={0} x2={xP99} y2={0} stroke="#fbbf24" strokeWidth="3" />

                    {/* p50 tick */}
                    <line
                      x1={xP50}
                      y1={-8}
                      x2={xP50}
                      y2={8}
                      stroke="#34d399"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />

                    {/* p99 tick */}
                    <line x1={xP99} y1={-7} x2={xP99} y2={7} stroke="#fbbf24" strokeWidth="2" />

                    {/* p100 tick */}
                    <line x1={xP100} y1={-7} x2={xP100} y2={7} stroke="#f472b6" strokeWidth="2" />

                    {/* Average Diamond */}
                    <g transform={`translate(${xAvg}, 0) rotate(45)`}>
                      <rect
                        x={-4}
                        y={-4}
                        width={8}
                        height={8}
                        fill="#38bdf8"
                        stroke="var(--color-bg)"
                        strokeWidth="1"
                      />
                    </g>
                  </g>
                ) : (
                  // Grouped Bars Mode
                  <g transform={`translate(${labelWidth}, ${y + 6})`}>
                    {/* Average bar */}
                    <rect x={0} y={0} width={xAvg} height={7} fill="#38bdf8" rx={1.5} />
                    {/* p50 bar */}
                    <rect x={0} y={9} width={xP50} height={7} fill="#34d399" rx={1.5} />
                    {/* p99 bar */}
                    <rect x={0} y={18} width={xP99} height={7} fill="#fbbf24" rx={1.5} />
                    {/* p100 bar */}
                    <rect x={0} y={27} width={xP100} height={7} fill="#f472b6" rx={1.5} />
                  </g>
                )}

                {/* Hover values preview */}
                {isHovered && (
                  <title>{`${label} (n=${d.samples}): Avg=${d.average !== null ? render(d.average) : 'n/a'}, p50=${d.p50 !== null ? render(d.p50) : 'n/a'}, p99=${d.p99 !== null ? render(d.p99) : 'n/a'}, p100=${d.p100 !== null ? render(d.p100) : 'n/a'}`}</title>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {hoveredIdx !== null && targetRows[hoveredIdx] && (
        <div
          style={{
            marginTop: 'var(--sp-2)',
            padding: 'var(--sp-2)',
            background: 'var(--color-surface-2)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--text-meta)',
            display: 'flex',
            gap: 'var(--sp-3)',
            flexWrap: 'wrap'
          }}
        >
          <strong>{labels[hoveredIdx]}</strong>
          <span className="dim">n={targetRows[hoveredIdx].distribution.samples}</span>
          <span>
            Avg:{' '}
            <strong className="num">
              {targetRows[hoveredIdx].distribution.average !== null
                ? render(targetRows[hoveredIdx].distribution.average)
                : 'n/a'}
            </strong>
          </span>
          <span>
            p50:{' '}
            <strong className="num">
              {targetRows[hoveredIdx].distribution.p50 !== null
                ? render(targetRows[hoveredIdx].distribution.p50)
                : 'n/a'}
            </strong>
          </span>
          <span>
            p99:{' '}
            <strong className="num">
              {targetRows[hoveredIdx].distribution.p99 !== null
                ? render(targetRows[hoveredIdx].distribution.p99)
                : 'n/a'}
            </strong>
          </span>
          <span>
            p100:{' '}
            <strong className="num">
              {targetRows[hoveredIdx].distribution.p100 !== null
                ? render(targetRows[hoveredIdx].distribution.p100)
                : 'n/a'}
            </strong>
          </span>
        </div>
      )}
    </div>
  )
}

type ModelPoint = {
  key: string
  label: string
  /** The model alone, drawn beside the mark — the icon already names the agent. */
  shortLabel: string
  adapterId: string
  cost: number
  velocity: number
  quality: number
  /** The fewest finished tasks backing any of the three axes. See `MIN_TRUSTED_SAMPLES`. */
  samples: number
}

/**
 * ⛔ **A point weaker than this is not a measurement, it's a guess wearing one.** Below five
 * finished tasks on an axis, `measuredModelPoints` drops the model from the comparison entirely
 * rather than plot a bar nobody should read a trend into — the same floor `thin()` dims a table
 * row at, applied here as an exclusion because a bubble has no column to dim.
 */
export const MIN_TRUSTED_SAMPLES = 5

/**
 * Only models with measured values on every axis, each resting on at least
 * `MIN_TRUSTED_SAMPLES` finished tasks, enter this comparison.
 *
 * `excludeApiMixed` drops price rows billed at an API rate or mixed basis, so the cost axis folds
 * only amortised subscription dollars — the two kinds of dollar are not interchangeable (see the
 * price tab's own note), and a bubble is one point that cannot say which basis it is in.
 */
export function measuredModelPoints(report: StatisticsReport, excludeApiMixed = false): ModelPoint[] {
  type PartialPoint = {
    adapterId: string
    model: string
    cost?: number
    velocity?: number
    quality?: number
    costSamples?: number
    velocitySamples?: number
    qualitySamples?: number
  }
  const points = new Map<string, PartialPoint>()
  const add = (
    rows: Array<StatRow & { basis?: PriceBasis }>,
    axis: 'cost' | 'velocity' | 'quality',
    skip?: (row: StatRow & { basis?: PriceBasis }) => boolean
  ): void => {
    const grouped = new Map<string, { total: number; samples: number }>()
    for (const row of rows) {
      if (row.level !== 'model' || !row.model || row.distribution.average === null) continue
      if (skip?.(row)) continue
      const key = `${row.adapterId}/${row.model}`
      const current = grouped.get(key) ?? { total: 0, samples: 0 }
      current.total += row.distribution.average * row.distribution.samples
      current.samples += row.distribution.samples
      grouped.set(key, current)
      if (!points.has(key)) points.set(key, { adapterId: row.adapterId, model: row.model })
    }
    for (const [key, value] of grouped) {
      const point = points.get(key)
      if (point && value.samples > 0) {
        point[axis] = value.total / value.samples
        point[`${axis}Samples`] = value.samples
      }
    }
  }
  // Price can have one row per billing basis. Fold those measured rows back together for one point.
  add(report.price.rows, 'cost', excludeApiMixed ? (row) => row.basis !== 'subscription' : undefined)
  add(report.velocity.rows, 'velocity')
  add(report.quality.rows, 'quality')
  const agents = new Map(report.velocity.rows.filter((r) => r.level === 'agent').map((r) => [r.adapterId, r.label]))
  return [...points.entries()]
    .filter(([, p]) => p.cost !== undefined && p.velocity !== undefined && p.quality !== undefined)
    .map(([key, p]) => ({
      key,
      label: `${agents.get(p.adapterId) ?? p.adapterId} · ${modelLabel(p.model) ?? p.model}`,
      shortLabel: compactModelLabel(p.model) ?? p.model,
      adapterId: p.adapterId,
      cost: p.cost!,
      velocity: p.velocity!,
      quality: p.quality!,
      samples: Math.min(p.costSamples!, p.velocitySamples!, p.qualitySamples!)
    }))
    .filter((point) => point.samples >= MIN_TRUSTED_SAMPLES)
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The three measured axes a model point carries. Field names match `ModelPoint`'s own keys. */
type Axis = 'quality' | 'cost' | 'velocity'

const AXIS_TITLE: Record<Axis, string> = {
  quality: 'Quality',
  cost: 'Cost',
  velocity: 'Active time'
}

const AXIS_RENDER: Record<Axis, (value: number) => string> = {
  quality: (v) => v.toFixed(1),
  cost: money,
  velocity: duration
}

/** ⚠️ Named by position, not by value: cost and active time are plotted inverted (see
 *  `INVERTED_AXES`), so a cheaper task sits *higher* on the cost axis while its number is *lower*, and
 *  "higher is better" read as a claim about the number. Every axis runs better away from the origin. */
const X_AXIS_HINT = 'right is better'
const Y_AXIS_HINT = 'top is better'

/** Cost and active time are measured such that a *smaller* number is the better outcome; flipping
 *  their plotted position (but not their displayed value) keeps "further from the origin" reading
 *  as "better" on every axis, quality included. */
const INVERTED_AXES: ReadonlySet<Axis> = new Set(['cost', 'velocity'])

/** Maps a raw measured value to where it plots, and back again — the transform is its own inverse. */
function axisPosition(axis: Axis, value: number, max: number): number {
  return INVERTED_AXES.has(axis) ? max - value : value
}

/** ⛔ Quality is always read on its published 0..10 rubric scale; cost and active time have no
 *  fixed ceiling, so their axis stretches to the worst measured point instead. */
function axisMax(points: ModelPoint[], axis: Axis): number {
  if (axis === 'quality') return 10
  return Math.max(...points.map((p) => p[axis]), axis === 'cost' ? 0.01 : 1)
}

/** A mark's name label, where it was placed, and whether it had to move off its mark to fit. */
export type PlacedLabel = {
  key: string
  text: string
  x: number
  y: number
  anchor: 'start' | 'end'
  /** The mark's centre, so a displaced label can draw a leader back to it. */
  cx: number
  cy: number
  displaced: boolean
}

/** Rough width of `text` at the label's 8px type: close enough to keep labels apart, not to typeset. */
const LABEL_CHAR_WIDTH = 4.4
const LABEL_LINE_HEIGHT = 9

/**
 * Places a name beside every mark without two names overprinting.
 *
 * ⚠️ The measured models cluster — most grade between 7.5 and 9 — so a label drawn at its mark would
 * be unreadable exactly where the plot is most interesting. Each label goes right of its mark (left
 * when it would run off the plot), at the mark's height if that is free, else at the nearest free
 * line above or below. Greedy and in mark order, so the same data always lays out the same way.
 */
export function placeScatterLabels(
  marks: Array<{ key: string; text: string; cx: number; cy: number }>,
  bounds: { left: number; right: number; top: number; bottom: number },
  markRadius: number
): PlacedLabel[] {
  const placed: Array<PlacedLabel & { x0: number; x1: number }> = []
  const gap = markRadius + 4
  const ordered = [...marks].sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.key.localeCompare(b.key))
  for (const mark of ordered) {
    const width = mark.text.length * LABEL_CHAR_WIDTH
    const fitsRight = mark.cx + gap + width <= bounds.right
    const fitsLeft = mark.cx - gap - width >= bounds.left
    const sides = (fitsRight || !fitsLeft ? [true, false] : [false, true]).filter((right) =>
      right ? fitsRight || !fitsLeft : fitsLeft
    )
    const extent = (right: boolean): [number, number] =>
      right ? [mark.cx + gap, mark.cx + gap + width] : [mark.cx - gap - width, mark.cx - gap]
    // ⚠️ Another model's icon is as much in the way as its label: a name drawn under a mark is gone.
    const free = (right: boolean, y: number): boolean => {
      const [x0, x1] = extent(right)
      const half = LABEL_LINE_HEIGHT / 2
      return (
        y >= bounds.top + half &&
        y <= bounds.bottom - half &&
        placed.every((p) => p.x1 < x0 || p.x0 > x1 || Math.abs(p.y - y) >= LABEL_LINE_HEIGHT) &&
        marks.every(
          (m) =>
            m.key === mark.key ||
            m.cx + markRadius < x0 ||
            m.cx - markRadius > x1 ||
            Math.abs(m.cy - y) >= markRadius + half
        )
      )
    }
    // At the mark's height on either side first; only then the nearest free line above or below.
    const candidates = [
      ...sides.map((right) => ({ right, y: mark.cy })),
      ...Array.from({ length: 12 }, (_, i) => i + 1).flatMap((step) =>
        sides.flatMap((right) => [
          { right, y: mark.cy + step * LABEL_LINE_HEIGHT },
          { right, y: mark.cy - step * LABEL_LINE_HEIGHT }
        ])
      )
    ]
    const chosen = candidates.find((c) => free(c.right, c.y)) ?? { right: sides[0]!, y: mark.cy }
    const [x0, x1] = extent(chosen.right)
    placed.push({
      key: mark.key,
      text: mark.text,
      x: chosen.right ? x0 : x1,
      y: chosen.y,
      anchor: chosen.right ? 'start' : 'end',
      cx: mark.cx,
      cy: mark.cy,
      displaced: Math.abs(chosen.y - mark.cy) > markRadius,
      x0,
      x1
    })
  }
  return placed.map(({ x0: _x0, x1: _x1, ...label }) => label)
}

/**
 * One 2D scatter of every measured model over a pair of axes.
 *
 * ⚠️ Exported for its own test, which renders it with `renderToStaticMarkup` — the suites run in a
 * `node` environment with no DOM, and this is the one way the drawing can be checked at all.
 */
export function ScatterPlot({
  points,
  xAxis,
  yAxis
}: {
  points: ModelPoint[]
  xAxis: Axis
  yAxis: Axis
}): React.JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null)
  const width = 300
  const height = 220
  // ⚠️ Wide enough for a duration tick (`27m 31s`, ~38px of 9px mono) to clear the rotated axis title.
  const marginLeft = 62
  const marginRight = 14
  const marginTop = 12
  const marginBottom = 30
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom
  const maxX = axisMax(points, xAxis)
  const maxY = axisMax(points, yAxis)
  const scaleX = (v: number): number => marginLeft + (v / maxX) * plotW
  const scaleY = (v: number): number => height - marginBottom - (v / maxY) * plotH
  const tickCount = 4
  const xTicks = Array.from({ length: tickCount + 1 }, (_, i) => (maxX / tickCount) * i)
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => (maxY / tickCount) * i)
  const active = points.find((p) => p.key === hovered)
  const iconSize = 14
  const midY = (marginTop + height - marginBottom) / 2

  return (
    <div className="scatter-plot-box">
      <div className="scatter-plot-head">
        <span className="scatter-plot-title">
          {AXIS_TITLE[xAxis]} <span className="dim">vs</span> {AXIS_TITLE[yAxis]}
        </span>
      </div>
      <svg
        className="scatter-plot-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${AXIS_TITLE[xAxis]} against ${AXIS_TITLE[yAxis]}, one mark per model`}
      >
        <g aria-hidden>
          {xTicks.map((t, i) => (
            <line
              key={`gx-${i}`}
              x1={scaleX(t)}
              y1={marginTop}
              x2={scaleX(t)}
              y2={height - marginBottom}
              className="scatter-plot-grid"
            />
          ))}
          {yTicks.map((t, i) => (
            <line
              key={`gy-${i}`}
              x1={marginLeft}
              y1={scaleY(t)}
              x2={width - marginRight}
              y2={scaleY(t)}
              className="scatter-plot-grid"
            />
          ))}
        </g>
        <line
          x1={marginLeft}
          y1={height - marginBottom}
          x2={width - marginRight}
          y2={height - marginBottom}
          className="scatter-plot-axis"
        />
        <line
          x1={marginLeft}
          y1={marginTop}
          x2={marginLeft}
          y2={height - marginBottom}
          className="scatter-plot-axis"
        />
        {xTicks.map((t, i) => (
          <text
            key={`xl-${i}`}
            x={scaleX(t)}
            y={height - marginBottom + 12}
            textAnchor="middle"
            className="scatter-plot-tick"
          >
            {AXIS_RENDER[xAxis](axisPosition(xAxis, t, maxX))}
          </text>
        ))}
        {yTicks.map((t, i) => (
          <text key={`yl-${i}`} x={marginLeft - 6} y={scaleY(t) + 3} textAnchor="end" className="scatter-plot-tick">
            {AXIS_RENDER[yAxis](axisPosition(yAxis, t, maxY))}
          </text>
        ))}
        <text
          x={(marginLeft + width - marginRight) / 2}
          y={height - 4}
          textAnchor="middle"
          className="scatter-plot-axis-label"
        >
          {AXIS_TITLE[xAxis]} ({X_AXIS_HINT})
        </text>
        <text
          x={8}
          y={midY}
          textAnchor="middle"
          className="scatter-plot-axis-label"
          transform={`rotate(-90, 8, ${midY})`}
        >
          {AXIS_TITLE[yAxis]} ({Y_AXIS_HINT})
        </text>
        {placeScatterLabels(
          points.map((point) => ({
            key: point.key,
            text: point.shortLabel,
            cx: scaleX(axisPosition(xAxis, point[xAxis], maxX)),
            cy: scaleY(axisPosition(yAxis, point[yAxis], maxY))
          })),
          { left: marginLeft, right: width - marginRight, top: marginTop, bottom: height - marginBottom },
          iconSize / 2
        ).map((label) => (
          <g key={`label-${label.key}`} aria-hidden>
            {label.displaced && (
              <line
                x1={label.cx}
                y1={label.cy}
                x2={label.anchor === 'start' ? label.x - 1 : label.x + 1}
                y2={label.y}
                className="scatter-plot-label-leader"
              />
            )}
            <text
              x={label.x}
              y={label.y + 3}
              textAnchor={label.anchor}
              className={`scatter-plot-mark-label${hovered === label.key ? ' active' : ''}`}
            >
              {label.text}
            </text>
          </g>
        ))}
        {points.map((point) => {
          const cx = scaleX(axisPosition(xAxis, point[xAxis], maxX))
          const cy = scaleY(axisPosition(yAxis, point[yAxis], maxY))
          const r = (hovered === point.key ? iconSize + 4 : iconSize) / 2
          return (
            <g
              key={point.key}
              onPointerEnter={() => setHovered(point.key)}
              onPointerLeave={() => setHovered(null)}
            >
              <circle cx={cx} cy={cy} r={r + 3} className="scatter-plot-point-halo" />
              <g transform={`translate(${cx - r}, ${cy - r})`}>
                <AgentIcon adapterId={point.adapterId} size={r * 2} title={point.label} />
              </g>
              <title>
                {`${point.label}\n${AXIS_TITLE[xAxis]} ${AXIS_RENDER[xAxis](point[xAxis])} · ${AXIS_TITLE[yAxis]} ${AXIS_RENDER[yAxis](point[yAxis])}`}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="scatter-plot-legend">
        {active ? (
          <>
            <strong>{active.label}</strong> · {AXIS_TITLE[xAxis]} {AXIS_RENDER[xAxis](active[xAxis])} ·{' '}
            {AXIS_TITLE[yAxis]} {AXIS_RENDER[yAxis](active[yAxis])}
          </>
        ) : (
          ' '
        )}
      </div>
    </div>
  )
}

const SCATTER_PAIRS: Array<{ x: Axis; y: Axis }> = [
  { x: 'quality', y: 'cost' },
  { x: 'quality', y: 'velocity' },
  { x: 'velocity', y: 'cost' }
]

/**
 * Three 2D scatters, one per pair of measured axes, replacing the earlier rotatable 3D plot —
 * reported 2026-09-14 as confusing to read and hard to interact with. A flat x/y plot has a
 * position a reader can recover without dragging anything.
 */
export function TradeoffPlots({ report }: { report: StatisticsReport }): React.JSX.Element | null {
  // ⭐ Per-display preference, on the precedent `readStatisticsWindow` sets: whether this filter was
  // on last time is remembered so leaving the page or restarting the app does not silently turn it
  // back off (reported 2026-09-13).
  const [excludeApiMixed, setExcludeApiMixed] = useState(() => readStatisticsExcludeApiMixed())
  const toggleExcludeApiMixed = (value: boolean): void => {
    writeStatisticsExcludeApiMixed(value)
    setExcludeApiMixed(value)
  }
  // ⛔ The gate on whether this section exists at all reads the unfiltered set: hiding the whole
  // section (and its own toggle) the moment the filter empties it would leave no way back to "off".
  const everPoints = measuredModelPoints(report)
  const points = measuredModelPoints(report, excludeApiMixed)
  if (everPoints.length === 0) return null
  return (
    <section className="scatter-plots" aria-label="Quality, cost and velocity model comparison">
      <div className="scatter-plots-head">
        <div>
          <h3>Measured model trade-offs</h3>
          <p>
            Each mark is the icon of the agent that ran it, one model per mark, measured on at least{' '}
            {MIN_TRUSTED_SAMPLES} finished tasks on every axis. Hover a mark for its exact numbers.
          </p>
        </div>
        <label
          className="scatter-plots-filter"
          title="When on, the cost axis folds only amortised subscription dollars — API-rate and mixed-basis tasks are left out rather than averaged in as though they were the same kind of dollar."
        >
          <input
            type="checkbox"
            checked={excludeApiMixed}
            onChange={(e) => toggleExcludeApiMixed(e.target.checked)}
          />
          Exclude API rate &amp; mixed
        </label>
      </div>
      {points.length === 0 ? (
        <p className="notice">No model has a subscription-only price under this filter. Uncheck it to see every measured model again.</p>
      ) : (
        <>
          <div className="scatter-plots-grid">
            {SCATTER_PAIRS.map((pair) => (
              <ScatterPlot key={`${pair.x}-${pair.y}`} points={points} xAxis={pair.x} yAxis={pair.y} />
            ))}
          </div>
          <p className="dim">
            {points.length} model{points.length === 1 ? '' : 's'} with all three measurements.
          </p>
        </>
      )}
    </section>
  )
}

function DistributionTable({
  rows,
  unit,
  render,
  extraHead,
  extraCell
}: {
  rows: Array<StatRow & { basis?: PriceBasis; unpriced?: number }>
  unit: string
  render: (value: number) => string
  extraHead?: React.JSX.Element
  extraCell?: (row: StatRow & { basis?: PriceBasis; unpriced?: number }) => React.JSX.Element
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="notice">
        No finished task on this fleet carries a {unit} yet. Every number here is folded from
        completed tasks only — a cancelled or failed one stopped for reasons that say nothing about
        what work on that agent costs or takes.
      </div>
    )
  }
  return (
    <table className="tbl stat-tbl">
      <thead>
        <tr>
          <th>Agent / Model / Effort</th>
          {extraHead}
          <th className="tbl-num">n</th>
          <th className="tbl-num">Average</th>
          <th className="tbl-num">p50</th>
          <th className="tbl-num">p99</th>
          <th className="tbl-num">p100</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={LEVEL_CLASS[row.level]}>
            <td className={row.level === 'agent' ? 'tbl-strong' : ''} title={row.model ?? row.adapterId}>
              {rowLabel(row)}
            </td>
            {extraCell?.(row)}
            <td className={`tbl-num num${thin(row.distribution.samples) ? ' dim' : ''}`}>
              {row.distribution.samples}
            </td>
            {cells(row.distribution, render)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Statistics({
  tab,
  setTab,
  onOpenQualityReview
}: {
  tab: StatisticsTab
  setTab: (tab: StatisticsTab) => void
  /** ⚠️ *Which* work has been graded is a different question from *how* it scored, and it has its
   *  own page. This tab is the distribution; the coverage and the batch button are over there. */
  onOpenQualityReview: () => void
}): React.JSX.Element {
  const [report, setReport] = useState<StatisticsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  // ⭐ Which window to read: the last 200 finished tasks, or all of them. Remembered per display.
  const [scope, setScope] = useState<StatisticsWindow>(() => readStatisticsWindow())

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('statistics.report', { window: scope }))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [scope])

  const chooseWindow = (next: StatisticsWindow): void => {
    writeStatisticsWindow(next)
    setScope(next)
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  useDaemonEvents((event) => {
    // ⚠️ `run.changed` and not `task.changed`: a run ending is what moves a price, a duration and a
    // task into the completed window, and a task row changing for any other reason moves none of it.
    if (event.type === 'run.changed') void refresh()
  })

  return (
    <div className="panel statistics-paper">
      <header className="panel-head">
        <div>
          <h2>Statistics</h2>
          <p className="panel-sub">
            What this fleet&rsquo;s finished work actually cost, took and scored — per agent, per
            model and per effort level.
          </p>
        </div>
        <div className="panel-actions">
          {report && (
            // ⚠️ Worded for the empty fleet too. *last 0 finished tasks* is not a sentence, and the
            //    state it describes — a new install — is the one a stranger reads this page in first.
            <span className="tag" title={`Read at ${when(report.generatedAt)}`}>
              {report.price.tasks === 0
                ? 'nothing finished yet'
                : `${report.window === 'all' ? 'all' : 'last'} ${report.price.tasks} finished task${report.price.tasks === 1 ? '' : 's'}`}
            </span>
          )}
          {/* ⭐ The window is a choice, not a constant (t361). A fleet past its two-hundredth task
              was reading a window that quietly dropped its oldest work. */}
          <label className="pager-size" title="How far back every tab on this page reads">
            <span className="dim">Window</span>
            <select value={scope} onChange={(e) => chooseWindow(e.target.value === 'all' ? 'all' : 'recent')}>
              <option value="recent">last 200 finished tasks</option>
              <option value="all">all finished tasks</option>
            </select>
          </label>
        </div>
      </header>

      <div className="tabs">
        {STATISTICS_TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {report && <TradeoffPlots report={report} />}

      {error ? (
        <div className="alert">{error}</div>
      ) : !report ? (
        <p className="dim">Folding what the fleet has finished…</p>
      ) : tab === 'price' ? (
        <PriceTab report={report} />
      ) : tab === 'velocity' ? (
        <VelocityTab report={report} />
      ) : (
        <QualityTab report={report} onOpenQualityReview={onOpenQualityReview} />
      )}
    </div>
  )
}

function Window({ report }: { report: StatisticsReport }): React.JSX.Element {
  return (
    <p className="dim">
      Folded over{' '}
      {report.sampleLimit === null ? (
        <>
          every <strong>completed</strong> task this fleet still has — {report.price.tasks} of them
        </>
      ) : (
        <>
          the {report.price.tasks} most recently updated <strong>completed</strong> tasks (the read
          stops at {report.sampleLimit}; the Window control above reads all of them)
        </>
      )}
      , each credited to the agent and model of its last non-failed work run — the same rule peer
      review grades on, so speed, spend and score in this app always name the same author for the
      same task.
    </p>
  )
}

function PriceTab({ report }: { report: StatisticsReport }): React.JSX.Element {
  const { price } = report
  // ⛔ API and mixed rows can be orders of magnitude above an amortised subscription share. A
  // shared scale makes the subscription distribution unreadable, so give each billing basis its
  // own chart and axis. ⛔ Filter the chart input itself: retaining all non-agent rows makes both
  // charts render the same models (t325).
  return (
    <div className="stack">
      <section className="doc-section">
        <h3>Historical task costs</h3>
        <p className="panel-sub">
          The measured distribution, not shrunk. This is deliberately not the number the router reads:
          routing estimates apply statistical shrinkage to sparse samples, whereas budgeting requires
          raw observed distributions.
        </p>
        <Window report={report} />
        <div className="notice">
          <strong>Two kinds of dollar, and they are not interchangeable.</strong>{' '}
          <em>subs</em> is an amortised share of a flat monthly fee that was paid whether the run
          happened or not. <em>API rate</em> is money really billed on top, at a market rate, at the
          moment the work ran. <em>mixed</em> means the group contains both, which is what an account
          crossing into overage mid-month does to every total above it. Averaging the two without
          saying which is which turns &ldquo;this agent is cheap&rdquo; into a sentence that means
          nothing — so a model whose tasks were billed both ways gets one row (and one chart bar)
          per basis: the table says which in its <em>Billed as</em> column, the API &amp; mixed chart
          names it on the bar (<em>Opus (mixed)</em>), and the subscription chart, being all one
          basis, does not repeat it. The agent row above keeps folding everything.
        </div>
        {price.estimated && (
          <p className="dim">
            ⚠️ At least one contributing run&rsquo;s share of its billing window was a split, a stale
            reading or a stretch nobody read, so every total here is an estimate. Hover a run in a
            task thread for the derivation of its own number.
          </p>
        )}
        {price.unpriced > 0 && (
          <p className="dim">
            {price.unpriced} of {price.tasks} finished tasks could not be priced at all and are
            excluded rather than counted as zero — <em>unpriced</em> is not <em>free</em>.
          </p>
        )}
      </section>

      <StatGraph
        rows={priceRowsForGraph(price.rows, ['subscription'])}
        unit="price"
        render={money}
        title="Subscription Model Price Comparison"
      />
      <StatGraph
        rows={priceRowsForGraph(price.rows, ['api', 'mixed'])}
        unit="price"
        render={money}
        title="API & Mixed Model Price Comparison"
      />

      <DistributionTable
        rows={price.rows}
        unit="price"
        render={money}
        extraHead={<th>Billed as</th>}
        extraCell={(row) => {
          const basis = (row as PriceStatRow).basis
          return (
            <td className={basis === 'unknown' ? 'dim' : ''} title={BASIS_TITLE[basis]}>
              {BASIS_LABEL[basis]}
            </td>
          )
        }}
      />
      <p className="dim">
        ⚠️ <strong>n</strong> is how many tasks each row folds, and it is printed because a{' '}
        <code>p99</code> over four samples is the maximum wearing a percentile&rsquo;s name. Rows
        below five samples are dimmed on that column; nothing is hidden, because suppressing the
        column would let a reader assume the tail had been checked.
      </p>
    </div>
  )
}

function VelocityTab({ report }: { report: StatisticsReport }): React.JSX.Element {
  const { velocity } = report
  return (
    <div className="stack">
      <section className="doc-section">
        <h3>Historical task duration</h3>
        <p className="panel-sub">
          <strong>Active time, never wall-clock.</strong> Measures active agent compute duration. Any
          time spent waiting for user feedback, external approvals, or paused runs is excluded.
        </p>
        <Window report={report} />
        <div className="notice">
          <strong>This will not match Routing Model &rsaquo; Velocity, and neither is wrong.</strong>{' '}
          That tab publishes a <em>pace factor</em>: a ratio against the fleet&rsquo;s geometric
          centre, shrunk toward 1 by how few samples stand behind it, and excluding tasks under a
          minute of active time because a resumed conversation that answered and closed is not
          evidence about how fast an agent works. It is built to break a tie between two accounts
          without a lucky sample being able to move the router. This page counts every completed task
          that took a measurable moment and shrinks nothing, because &ldquo;how long will this
          take&rdquo; is a question about the distribution and not about a tie-break.
        </div>
        {velocity.untimed > 0 && (
          <p className="dim">
            {velocity.untimed} of {velocity.tasks} finished tasks measured no active time at all and
            are excluded: a zero is not a duration anybody can compare, and averaging them in would
            make whichever agent caught them look like the fast one.
          </p>
        )}
      </section>

      <StatGraph rows={velocity.rows} unit="velocity" render={duration} />

      <DistributionTable rows={velocity.rows} unit="duration" render={duration} />
    </div>
  )
}

function QualityTab({
  report,
  onOpenQualityReview
}: {
  report: StatisticsReport
  onOpenQualityReview: () => void
}): React.JSX.Element {
  const { quality } = report
  return (
    <div className="stack">
      <section className="doc-section">
        <h3>What the work has been graded at</h3>
        {quality.totalReviews === 0 ? (
          <div className="notice">
            <strong>Nothing on this fleet has been peer reviewed yet, so every number below is the
            baseline.</strong>{' '}
            The <em>prior</em> column is a published agentic-coding benchmark for the model, on a 0..1
            scale — it is what the fleet believes before it has seen this model do anything, and it
            is deliberately the whole answer rather than a placeholder. ⛔ A key with no prior and no
            review reads <em>unknown</em>, never 0 and never 0.5: an ungraded model must not be able
            to look average. Commission a grader and grade some finished tasks from{' '}
            <button className="linkish" onClick={onOpenQualityReview}>
              Analytics &rsaquo; Quality Review
            </button>
            , and the measured column fills in beside it.
          </div>
        ) : (
          <p className="panel-sub">
            <strong>The prior is the baseline; review moves it slowly.</strong> <em>Prior</em> is a
            published benchmark for the model. <em>Composite</em> is this fleet&rsquo;s own peer
            review, on the rubric&rsquo;s 0..10 scale, over <em>clean</em> reviews only — a review of
            a task two agents both worked on is not evidence about either, and one whose blinding
            leaked was not blind. <em>Fitness</em> is the two blended, shrunk toward the prior hard
            enough that a single clean review keeps about 11% of the distance between them; it takes
            on the order of twenty before the measured number dominates.
          </p>
        )}
        <Window report={report} />
        <p className="dim">
          Rubric {quality.rubricVersion} · {quality.totalReviews} complete review
          {quality.totalReviews === 1 ? '' : 's'} · {quality.ungraded} finished task
          {quality.ungraded === 1 ? '' : 's'} still ungraded. ⛔ Nothing here gates a routing
          decision; no score is read by the scheduler.
        </p>
        <p className="dim">
          This tab is the <strong>distribution</strong> of the grades.{' '}
          <button className="linkish" onClick={onOpenQualityReview}>
            Quality Review
          </button>{' '}
          is the other half of the same question: which tasks those grades cover, which have none,
          and who is left who could still grade them.
        </p>
      </section>

      {/* ⭐ The same chart the other two tabs draw, over the clean composites (t361). Rows with no
          clean review have `distribution.samples === 0` and draw no bar, which is the honest
          picture: an ungraded model has no distribution, not a short one. */}
      <StatGraph rows={quality.rows} unit="quality" render={(v) => v.toFixed(1)} />

      {quality.rows.length === 0 ? (
        <div className="notice">
          No completed task on this fleet is credited to an agent yet, so there is nothing to grade
          or to look a baseline up for.
        </div>
      ) : (
        <table className="tbl stat-tbl">
          <thead>
            <tr>
              <th>Agent / Model / Effort</th>
              <th className="tbl-num">Tasks</th>
              <th className="tbl-num">Prior</th>
              <th className="tbl-num">Composite</th>
              <th className="tbl-num">Clean</th>
              <th className="tbl-num">Reviews</th>
              <th className="tbl-num">Fitness</th>
            </tr>
          </thead>
          <tbody>
            {quality.rows.map((row: QualityStatRow) => (
              <tr key={row.key} className={LEVEL_CLASS[row.level]}>
                <td
                  className={row.level === 'agent' ? 'tbl-strong' : ''}
                  title={row.model ?? row.adapterId}
                >
                  {rowLabel(row)}
                </td>
                <td className="tbl-num num">{row.tasks}</td>
                <td className="tbl-num num" title={row.priorBasis ?? undefined}>
                  {row.level !== 'model' ? (
                    // ⛔ A dash, not `unknown`. A benchmark is published per model, so there is no
                    //    prior for `claude-code` in general or for `high` in particular — and
                    //    *nobody has measured this* is a different sentence from *this quantity does
                    //    not exist at this depth*. Copying the model's number up or down would print
                    //    it three times as though it had been measured three ways.
                    <span className="dim">—</span>
                  ) : row.prior === null ? (
                    <span className="dim">unknown</span>
                  ) : (
                    row.prior.toFixed(2)
                  )}
                </td>
                <td className="tbl-num num">
                  {row.cleanComposite === null ? (
                    <span className="dim">ungraded</span>
                  ) : (
                    row.cleanComposite.toFixed(1)
                  )}
                </td>
                <td className="tbl-num num">{row.clean}</td>
                <td className="tbl-num num dim">{row.samples}</td>
                <td className="tbl-num num" title={row.fitnessBasis ?? undefined}>
                  {row.level !== 'model' ? (
                    <span className="dim">—</span>
                  ) : row.fitness === null ? (
                    <span className="dim">unknown</span>
                  ) : (
                    row.fitness.toFixed(2)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="dim">
        ⚠️ <strong>Clean</strong> is the count the composite is averaged over; <strong>Reviews</strong>{' '}
        is every complete scored review including the ones excluded as mixed-authorship or leaked.
        The gap between the two is how much grading effort this fleet has spent on evidence it cannot
        use.
      </p>
    </div>
  )
}
