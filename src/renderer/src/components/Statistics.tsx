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
import { effortLabel, modelLabel } from '../lib/modelname'
import { readStatisticsWindow, writeStatisticsWindow } from '../lib/prefs'
import { errorMessage } from '@shared/errors.js'

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
  return rows.filter((row) => bases.includes(row.basis))
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
    <div className="panel">
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
        <h3>What a finished task has cost</h3>
        <p className="panel-sub">
          The measured distribution, unshrunk. ⛔ This is deliberately <em>not</em> the number the
          router reads: <code>estimate</code> publishes a median with a confidence and pulls a sparse
          key toward the fleet&rsquo;s centre, because a factor learned from two tasks that says ×4
          would otherwise route the whole fleet on an accident. Budgeting is the opposite question —
          the tail is the point — so nothing on this page is shrunk.
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
        <h3>How long a finished task has taken</h3>
        <p className="panel-sub">
          <strong>Active time, never wall-clock.</strong> A task dispatched at 09:00, blocked on a
          question at 09:04 and answered at 17:00 took four minutes of agent work and eight hours of
          your day. Only the four minutes are here — every stretch spent waiting on a person is
          subtracted, including the stretches <em>inside</em> a run, which a naive{' '}
          <code>ended − started</code> misses entirely.
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
