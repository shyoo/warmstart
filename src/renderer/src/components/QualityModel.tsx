import { useCallback, useEffect, useState } from 'react'
import type { QualityReport, UngradedTask } from '@shared/quality'
import { RUBRIC_DIMENSIONS, type RubricDimension } from '@shared/review'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { when } from '../lib/format'
import { modelLabel } from '../lib/modelname'
import { AgentLabel } from './AgentLabel'
import { errorMessage } from '@shared/errors.js'

/**
 * Analytics > Routing Model > Quality.
 *
 * ⛔ **Nothing on this page gates anything.** No task changes status because of a score, no routing
 * decision reads one, and the estimator never sees a review run — the sentence `@shared/review.ts`
 * opens with, repeated here because a page that ranks agents by a number is exactly where a reader
 * assumes the number must be doing something. It is an instrument. Wiring it into routing before it
 * has been shown to measure anything is a mistake this project has already made once.
 *
 * ⛔ **Nothing on this page commissions a review any more.** The button that used to live here
 * graded up to five ungraded tasks inside its own RPC call; grading is now asked for on Analytics
 * &rsaquo; Quality Review, which can filter by how many grades a task already has, run more than
 * five, and report what happened to each one. Two buttons that both spend turns on the same accounts
 * with different caps is a way to spend a quota window by pressing the wrong one.
 */

export function QualityModel({
  onOpenQualityReview
}: {
  onOpenQualityReview: () => void
}): React.JSX.Element {
  const [report, setReport] = useState<QualityReport | null>(null)
  const [ungraded, setUngraded] = useState<UngradedTask[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [quality, pending] = await Promise.all([
        rpc('quality.report'),
        rpc('quality.ungraded', { limit: 25 })
      ])
      setReport(quality)
      setUngraded(pending)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useDaemonEvents((event) => {
    if (event.type === 'task.changed') void refresh()
  })

  if (error) return <div className="alert">{error}</div>
  if (!report) return <p className="dim">Reading what peer review has measured…</p>

  const graders = report.graders.filter((g) => g.enabled)

  return (
    <div className="stack">
      <section className="doc-section">
        <h3>1. Where a quality number comes from</h3>
        <p className="panel-sub">
          Every task on this fleet is run <strong>once</strong>, for cost reasons. One run produces no
          comparison: it tells you the task finished, not whether it finished well. The run&rsquo;s
          outcome is a statement about a process exiting, and its active time a statement about speed.
          Both are measured. Quality was not — so it is measured separately, by a second agent reading
          the diff.
        </p>
        <p className="panel-sub">
          A quality number for a model is therefore not a property of the model. It is the mean of the
          grades that model&rsquo;s work has actually received, from peers, against a fixed rubric,
          with the rubric version stored on every one so a later weight change cannot quietly
          reinterpret history.
        </p>
        <div className="metric-grid">
          <Tile value={String(report.totalReviews)} label="complete ratings & peer reviews" />
          <Tile value={String(report.gradedTasks)} label="finished tasks with a grade" />
          <Tile value={String(report.ungradedTasks)} label="finished tasks with none" />
          <Tile value={report.rubricVersion} label="rubric version in force" />
        </div>
      </section>

      <section className="doc-section">
        <h3>2. How the peer review works, in plain language</h3>
        <ol className="doc-list">
          <li>
            <strong>A task finishes.</strong> The daemon works out whose work it is: the adapter of
            the <em>last non-failed work run</em>. If more than one agent contributed, the review is
            still taken but marked <span className="tag">mixed authorship</span> — a score attributed
            to one agent for a task another did most of is not evidence about either.
          </li>
          <li>
            <strong>The commit range is resolved, or the review is refused.</strong> First the range
            the task actually landed, then its branch; if neither resolves, no review happens. There
            is no third rung. Reviewing the wrong commits is worse than not reviewing, because it
            produces a number indistinguishable from a real one.
          </li>
          <li>
            <strong>A peer is chosen — never the author.</strong> Excluded by <em>adapter</em>, not by
            account: one Claude account grading another Claude account is Claude grading Claude. The
            peer must also have a read-only mode, be under the same quota water mark work goes
            through, and not already be reviewing. If no peer qualifies, the reason names every
            candidate considered and nothing is written.
          </li>
          <li>
            <strong>The diff is blinded.</strong> Commit trailers, tool footers, model ids, worker
            labels and vendor dotfile directories come out mechanically. Prose does not — a commit
            body explaining an agent-specific sandbox bug cannot be redacted without destroying its
            meaning — so a review whose prose still names a vendor is flagged{' '}
            <span className="tag">leak</span> and excluded from the clean comparison rather than
            being claimed as blind.
          </li>
          <li>
            <strong>One pass, no tools that write.</strong> The reviewer reads the diff, opens at most
            a handful of files, and answers with JSON. It is told explicitly not to explore the
            repository or run the tests: a thorough review is not what is wanted, a calibrated one is.
            That is what keeps a review well under 1% of the task it grades.
          </li>
          <li>
            <strong>The overall score is computed here, not read from the reply.</strong> The model
            returns seven dimension scores and rationales; the composite is the weighted mean over the
            dimensions it actually scored. Holistic scoring is where LLM judges are least reliable, so
            the model is never asked for one.
          </li>
          <li>
            <strong>A malformed reply is a finding, not a retry.</strong> No repair pass and no
            re-ask. It is stored as <code>failed</code> with its reason — never as a score of 0, which
            is a real grade and would be a lie about the work.
          </li>
        </ol>
        <div className="notice">
          <strong>Grading runs on each provider&rsquo;s small model</strong>
          {graders.length > 0 && (
            <>
              {' '}—{' '}
              {graders.map((g, i) => (
                <span key={g.workerId}>
                  {i > 0 ? ', ' : ''}
                  {g.label} <code>{g.model ?? 'the CLI default'}</code>
                </span>
              ))}
            </>
          )}
          . ⚠️ Whether a small model can hold a seven-dimension rubric and produce calibrated,
          non-clustered scores is <em>unmeasured</em>. The reviewing model is stored on every review,
          so the experiment is available: grade the same tasks on a small and a large model of one
          provider and compare the spread. If the small model clusters everything at 7–8 it is not a
          judge, and the choice moves up a rung. Each account&rsquo;s grading model is set in Settings
          &rsaquo; Workers.
        </div>
      </section>

      <section className="doc-section">
        <h3>3. The rubric</h3>
        <p className="panel-sub">
          Seven dimensions, each scored 0–10 against five described anchor states the judge
          interpolates between — never a bare line to pick a number off. A dimension that does not
          apply is scored <code>null</code>, not 0, and the composite renormalises over what was
          actually scored: a pure-CSS change has no test coverage to grade and must not be punished
          for it.
        </p>
        <table className="tbl">
          <thead>
            <tr>
              <th>Dimension</th>
              <th>The one question it asks</th>
              <th className="tbl-num">Weight</th>
            </tr>
          </thead>
          <tbody>
            {RUBRIC_DIMENSIONS.map((dimension) => (
              <tr key={dimension}>
                <td className="tbl-strong">{report.labels[dimension]?.label ?? dimension}</td>
                <td className="dim">{report.labels[dimension]?.asks ?? ''}</td>
                <td className="tbl-num num">{(report.weights[dimension] ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim">
          Requirement fidelity and correctness are <strong>40% between them</strong>: a beautifully
          crafted patch that does the wrong thing is a failure, and the weights have to say so
          numerically or they do not mean it. Codebase fit is 15% and never more — it is the dimension
          a judge is most confident and least right about.
        </p>
      </section>

      <section className="doc-section">
        <h3>4. What each agent and model has scored</h3>
        {report.keys.length === 0 ? (
          <p className="dim">
            Nothing has been graded yet, so there is no per-model quality to show. Grade some finished
            work below and this table fills in.
          </p>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Model / agent</th>
                  <th className="tbl-num">Clean mean</th>
                  <th className="tbl-num">All</th>
                  <th className="tbl-num">n (clean/all)</th>
                  <th className="tbl-num">Range</th>
                  {RUBRIC_DIMENSIONS.map((d) => (
                    <th key={d} className="tbl-num" title={report.labels[d]?.label ?? d}>
                      {shortDimension(d)}
                    </th>
                  ))}
                  <th>Last graded</th>
                </tr>
              </thead>
              <tbody>
                {report.keys.map((key) => (
                  <tr key={`${key.adapterId}/${key.model ?? '?'}`}>
                    {/* ⛔ The model leads. `openai-compatible` is a transport, and the two things
                        it reaches here — Codex CLI and a local endpoint — are not one agent whose
                        quality can be averaged into a single row's worth of number. */}
                    <td className="tbl-strong">
                      <AgentLabel
                        adapterId={key.adapterId}
                        model={key.model}
                        labels={report.adapterLabels}
                      />
                    </td>
                    <td className="tbl-num num">{fmt(key.cleanComposite)}</td>
                    <td className="tbl-num num dim">{fmt(key.composite)}</td>
                    <td className="tbl-num num">
                      {key.clean}/{key.samples}
                    </td>
                    <td className="tbl-num num dim">
                      {key.worst === null ? 'n/a' : `${key.worst.toFixed(1)}–${(key.best ?? 0).toFixed(1)}`}
                    </td>
                    {RUBRIC_DIMENSIONS.map((d) => (
                      <td key={d} className="tbl-num num dim">
                        {fmt(key.dimensions[d] ?? null)}
                      </td>
                    ))}
                    <td className="tbl-when">{key.lastGradedAt ? when(key.lastGradedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim">
              <strong>Clean mean</strong> is the number to compare agents on: it excludes reviews of
              tasks more than one adapter worked on, and reviews whose blinding leaked a vendor name
              into the prose. Where <em>clean</em> is far below <em>all</em>, the difference is the
              measurement telling you it is not yet a comparison.
            </p>
          </>
        )}
      </section>

      {report.reviewers.length > 0 && (
        <section className="doc-section">
          <h3>5. Who has been grading, and how generously</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>Reviewer</th>
                <th>Graded on</th>
                <th className="tbl-num">Reviews given</th>
                <th className="tbl-num">Average</th>
                <th className="tbl-num">Median</th>
                <th className="tbl-num">Range</th>
              </tr>
            </thead>
            <tbody>
              {report.reviewers.flatMap((r) => {
                const mainRow = (
                  <tr key={r.adapterId}>
                    <td className="tbl-strong">{r.label}</td>
                    {/* ⚠️ What actually produced these reviews, not what Settings would pick for the
                        next one. A judge's generosity is a fact about the model that graded. */}
                    <td
                      className="dim"
                      title={
                        r.modelsUsed.length > 0
                          ? r.modelsUsed.join(', ')
                          : 'no review recorded which model it ran on'
                      }
                    >
                      {r.modelsUsed.length > 0
                        ? r.modelsUsed.map((m) => modelLabel(m) ?? m).join(', ')
                        : 'not recorded'}
                      {r.gradingModel && !r.modelsUsed.includes(r.gradingModel) ? (
                        <span className="dim"> · now set to {modelLabel(r.gradingModel) ?? r.gradingModel}</span>
                      ) : null}
                    </td>
                    <td className="tbl-num num">{r.reviews}</td>
                    <td className="tbl-num num">{fmt(r.meanGiven)}</td>
                    <td className="tbl-num num">{fmt(r.medianGiven)}</td>
                    <td className="tbl-num num">{fmtRange(r.minGiven, r.maxGiven)}</td>
                  </tr>
                )
                const modelRows =
                  r.byModel && r.byModel.length > 1
                    ? r.byModel.map((m) => (
                        <tr key={`${r.adapterId}-${m.model ?? 'unknown'}`} className="sub-row">
                          <td style={{ paddingLeft: '1.5rem' }} className="dim">
                            ↳ {m.model ? (modelLabel(m.model) ?? m.model) : 'unrecorded'}
                          </td>
                          <td className="dim"><code>{m.model ?? 'unrecorded'}</code></td>
                          <td className="tbl-num num dim">{m.reviews}</td>
                          <td className="tbl-num num dim">{fmt(m.meanGiven)}</td>
                          <td className="tbl-num num dim">{fmt(m.medianGiven)}</td>
                          <td className="tbl-num num dim">{fmtRange(m.minGiven, m.maxGiven)}</td>
                        </tr>
                      ))
                    : []
                return [mainRow, ...modelRows]
              })}
            </tbody>
          </table>
          <p className="dim">
            Published as a calibration check and never applied as a correction: a judge averaging 8.9
            over forty reviews and one averaging 5.2 over three are not producing comparable numbers,
            and nothing on this fleet would justify picking a scale factor between them.
          </p>
        </section>
      )}

      <section className="doc-section">
        <h3>{report.reviewers.length > 0 ? '6' : '5'}. Ungraded work</h3>
        <div className="metric-grid">
          <Tile value={String(report.ungradedTasks)} label="finished tasks with no grade" />
          {report.failures.map((f) => (
            <Tile
              key={f.status}
              value={String(f.count)}
              label={`review${f.count === 1 ? '' : 's'} ${f.status}${f.lastReason ? ` — ${f.lastReason}` : ''}`}
            />
          ))}
        </div>

        <div className="row-actions">
          <button className="btn" onClick={onOpenQualityReview}>
            Grade finished work on Quality Review →
          </button>
          <span className="dim">
            ⚠️ Grading is commissioned in one place, so there is one cap and one queue to watch. That
            page filters by how many grades a task already has and reports what each review produced.
          </span>
        </div>

        {ungraded.length > 0 && (
          <>
            <h4 className="doc-h4">Next in line</h4>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Would grade</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {ungraded.slice(0, 10).map((t) => (
                  <tr key={t.taskId}>
                    <td className="tbl-title-cell">
                      <div className="tbl-title" title={t.title}>
                        <span className="tbl-strong">t{t.seq}</span> {t.title}
                      </div>
                    </td>
                    <td className="dim">
                      <AgentLabel adapterId={t.adapterId} model={t.model} labels={report.adapterLabels} />
                    </td>
                    <td className="tbl-when">{when(t.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ungraded.length > 10 && (
              <p className="dim">…and {report.ungradedTasks - 10} more.</p>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function Tile({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="metric-tile">
      <div className="metric-tile-value">{value}</div>
      <div className="metric-tile-label">{label}</div>
    </div>
  )
}

/** ⛔ `n/a`, never `0.0`. A dimension nothing scored is an absence, and 0 is a real grade. */
function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1)
}

function fmtRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return '—'
  if (min === max) return min.toFixed(1)
  return `${min.toFixed(1)}–${max.toFixed(1)}`
}

const SHORT: Record<RubricDimension, string> = {
  requirement_fidelity: 'req',
  correctness: 'corr',
  tests: 'test',
  codebase_fit: 'fit',
  scope_discipline: 'scope',
  maintainability: 'maint',
  self_sufficiency: 'self'
}

function shortDimension(dimension: RubricDimension): string {
  return SHORT[dimension]
}
