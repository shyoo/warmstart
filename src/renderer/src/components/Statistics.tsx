import { useCallback, useEffect, useState } from 'react'
import type {
  Distribution,
  PriceBasis,
  PriceStatRow,
  QualityStatRow,
  StatRow,
  StatisticsReport
} from '@shared/statistics'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { duration, money, when } from '../lib/format'
import { effortLabel, modelLabel } from '../lib/modelname'

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
    <table className="tbl">
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

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('statistics.report'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

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
        {report && (
          // ⚠️ Worded for the empty fleet too. *last 0 finished tasks* is not a sentence, and the
          //    state it describes — a new install — is the one a stranger reads this page in first.
          <span className="tag" title={`Read at ${when(report.generatedAt)}`}>
            {report.price.tasks === 0
              ? 'nothing finished yet'
              : `last ${report.price.tasks} finished task${report.price.tasks === 1 ? '' : 's'}`}
          </span>
        )}
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
      Folded over the {report.price.tasks} most recently updated <strong>completed</strong> tasks (the
      read stops at {report.sampleLimit}), each credited to the agent and model of its last
      non-failed work run — the same rule peer review grades on, so speed, spend and score in this
      app always name the same author for the same task.
    </p>
  )
}

function PriceTab({ report }: { report: StatisticsReport }): React.JSX.Element {
  const { price } = report
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
          nothing.
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

      {quality.rows.length === 0 ? (
        <div className="notice">
          No completed task on this fleet is credited to an agent yet, so there is nothing to grade
          or to look a baseline up for.
        </div>
      ) : (
        <table className="tbl">
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
