import { useCallback, useEffect, useState } from 'react'
import type { GradeBatch, ReviewFilter, ReviewQueuePage } from '@shared/quality'
import { BATCH_SIZES, BATCH_THRESHOLDS, thresholdLabel } from '@shared/quality'
import type { Project } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { when } from '../lib/format'
import { agentNames } from '../lib/agentname'
import { AgentLabel } from './AgentLabel'

/**
 * Analytics › Quality Review.
 *
 * ⛔ **This page is about *coverage*, not about scores.** How well each agent grades and how well
 * each agent is graded is Statistics › Quality per Task, and duplicating that distribution here
 * would give an operator two tables of the same numbers folded two ways and no way to tell which was
 * authoritative. The question here is the one the other page cannot answer: *which finished work has
 * nobody looked at yet, and can anybody still look at it?*
 *
 * ⛔ **Every button on this page spends real turns on real accounts.** The batch says how many
 * before it is pressed, and ALL says out loud that it is unbounded.
 *
 * ⚠️ Progress is deliberately thin here. Once a batch is queued the reviews are ordinary runs on
 * ordinary tasks, so the place to watch them is the Tasks table and the task threads — the same
 * place every other kind of work on this fleet is watched. A second live view of the same runs would
 * be a second thing to keep true.
 */

const FILTERS: Array<{ id: ReviewFilter; label: string }> = [
  { id: 'none', label: 'No review' },
  { id: 'one', label: '1 review' },
  { id: 'many', label: '2 or more' },
  { id: 'all', label: 'All finished' }
]

const PAGE_SIZE = 25

function sizeLabel(size: number | null): string {
  return size === null ? 'ALL' : String(size)
}

export function QualityReview({
  projects,
  onOpenTask,
  onOpenStatistics
}: {
  projects: Project[]
  onOpenTask: (taskId: string) => void
  /** The distribution of the scores themselves lives one page over; this is the way there. */
  onOpenStatistics: () => void
}): React.JSX.Element {
  const [page, setPage] = useState<ReviewQueuePage | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('none')
  const [offset, setOffset] = useState(0)
  const [batch, setBatch] = useState<GradeBatch | null>(null)
  const [size, setSize] = useState<number | null>(5)
  const [threshold, setThreshold] = useState<number>(1)
  const [gradableOnly, setGradableOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [queue, running] = await Promise.all([
        rpc('quality.queue', { filter, limit: PAGE_SIZE, offset, gradableOnly }),
        rpc('quality.batch')
      ])
      setPage(queue)
      setBatch(running)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [filter, offset, gradableOnly])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useDaemonEvents((event) => {
    // A grade being stored rewrites a row's bucket, and a review is a run — both arrive here.
    if (event.type === 'task.changed' || event.type === 'run.changed') void refresh()
  })

  /**
   * ⚠️ A poll, and only while a batch is running. A batch lives in the daemon's memory rather than
   * in the database, so nothing emits when one entry moves from queued to grading; the alternative
   * is a new event type carrying state that is gone on restart anyway.
   */
  useEffect(() => {
    if (!batch || batch.state !== 'running') return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [batch, refresh])

  const start = useCallback(async () => {
    setBusy(true)
    try {
      const result = await rpc('quality.batch.start', { count: size, threshold })
      if (!result.ok) setError(result.reason)
      else {
        setBatch(result.batch)
        setError(null)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [size, threshold, refresh])

  const stop = useCallback(async () => {
    try {
      const result = await rpc('quality.batch.cancel')
      if (!result.ok) setError(result.reason)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh])

  const counts = page?.counts
  const labels = page?.adapterLabels ?? {}
  const running = batch?.state === 'running'
  const pages = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1
  const current = Math.floor(offset / PAGE_SIZE)

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Quality Review</h2>
          <p className="panel-sub">
            Which finished work has been graded by a peer, which has not, and who is left who could
            still grade it. The scores themselves — per agent, per model — are on{' '}
            <button className="linkish" onClick={onOpenStatistics}>
              Statistics › Quality per Task
            </button>
            .
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn btn--secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="metric-grid">
        <Tile value={counts ? String(counts.none) : '—'} label="finished tasks with no review" />
        <Tile value={counts ? String(counts.one) : '—'} label="with exactly 1 review" />
        <Tile value={counts ? String(counts.many) : '—'} label="with 2 or more reviews" />
      </div>

      <section className="doc-section">
        <h3>Commission a batch</h3>
        <div className="row-actions">
          <span>Batch</span>
          <select
            aria-label="How many reviews to commission"
            value={size === null ? 'all' : String(size)}
            onChange={(e) => setSize(e.target.value === 'all' ? null : Number(e.target.value))}
            disabled={running}
          >
            {BATCH_SIZES.map((s) => (
              <option key={sizeLabel(s)} value={s === null ? 'all' : String(s)}>
                {sizeLabel(s)}
              </option>
            ))}
          </select>
          <span>quality reviews, on tasks that have</span>
          <select
            aria-label="How thin a task's review coverage has to be"
            value={String(threshold)}
            onChange={(e) => setThreshold(Number(e.target.value))}
            disabled={running}
          >
            {BATCH_THRESHOLDS.map((t) => (
              <option key={t} value={String(t)}>
                {thresholdLabel(t)}
              </option>
            ))}
          </select>
          <button className="btn btn--primary" disabled={busy || running} onClick={() => void start()}>
            {running ? 'Grading…' : 'Batch'}
          </button>
          {running && (
            <button className="btn btn--warn" onClick={() => void stop()}>
              Stop queue
            </button>
          )}
        </div>
        <p className="dim">
          ⚠️ Each one spends a real turn on a real peer account and takes minutes, not seconds.{' '}
          <strong>ALL</strong> is exactly that — every finished task matching the filter, up to 500 —
          so on a fleet with a backlog it is hours of grading, not a longer press of the same button.
          Reviews run one per account at a time; a two-account fleet grades two tasks at once.
        </p>
        <p className="dim">
          ⛔ No agent is asked to grade a task twice, and none is ever asked to grade its own work.
          Once an agent has produced a score for a task it stops being a candidate for that task — a
          second grade from the same judge costs a turn to reproduce a number that is already stored.
          A task with nobody left says so in the table below, and the batch skips it rather than
          quietly substituting the next one.
        </p>

        {batch && <BatchProgress batch={batch} labels={labels} onOpenTask={onOpenTask} />}
      </section>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`tab${filter === f.id ? ' tab--active' : ''}`}
              onClick={() => {
                setFilter(f.id)
                setOffset(0)
              }}
            >
              {f.label}
              {counts && (
                <span className="nav-count num">
                  {f.id === 'none'
                    ? counts.none
                    : f.id === 'one'
                      ? counts.one
                      : f.id === 'many'
                        ? counts.many
                        : counts.total}
                </span>
              )}
            </button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={gradableOnly}
            onChange={(e) => {
              setGradableOnly(e.target.checked)
              setOffset(0)
            }}
          />
          Filter out cannot be graded
        </label>
      </div>

      {!page ? (
        <p className="dim">Reading what peer review has covered…</p>
      ) : page.rows.length === 0 ? (
        <div className="notice">
          Nothing in this bucket. ⚠️ Only <strong>completed</strong> tasks that an agent actually ran
          on are counted at all — a cancelled task has no result to judge, and one somebody finished
          by hand has no agent work to grade.
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Task</th>
              <th>Project</th>
              <th>Work by</th>
              <th className="tbl-num">Reviews</th>
              <th className="tbl-num">Score</th>
              <th>Graded by</th>
              <th>Can still be graded</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.taskId}>
                <td className="tbl-title-cell">
                  <button className="linkish tbl-title" title={row.title} onClick={() => onOpenTask(row.taskId)}>
                    <span className="tbl-strong">t{row.seq}</span> {row.title}
                  </button>
                </td>
                <td className="dim">
                  {projects.find((p) => p.id === row.projectId)?.name ?? 'unassigned'}
                </td>
                <Agent adapterId={row.adapterId} model={row.model} labels={labels} />
                <td className="tbl-num num">{row.reviewCount}</td>
                {/* ⛔ `n/a`, never 0.0. An ungraded task has no score; 0 is a real grade. */}
                <td className="tbl-num num">{row.score === null ? 'n/a' : row.score.toFixed(1)}</td>
                {/* ⛔ The models, not the adapter ids: two `openai-compatible` grades can be two
                    completely different judges, and this is the cell that says which are used up. */}
                <td className="dim" title={agentNames(row.gradedBy, labels)?.title}>
                  {agentNames(row.gradedBy, labels)?.text ?? '—'}
                </td>
                <td className={row.eligible ? 'dim' : 'warn'}>
                  {row.grading ? 'grading now' : row.eligible ? 'yes' : `no — ${row.ineligibleReason}`}
                </td>
                <td className="tbl-when">{when(row.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {page && page.total > PAGE_SIZE && (
        <div className="pager">
          <div className="pager-nav">
            <button
              className="btn btn--ghost"
              disabled={current === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Newer
            </button>
            <span className="dim">
              page {current + 1} of {pages} · {page.total} task{page.total === 1 ? '' : 's'}
            </span>
            <button
              className="btn btn--ghost"
              disabled={current >= pages - 1}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Older →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * What the queue has done so far.
 *
 * ⚠️ Skipped rows keep their own sentence rather than a shared one. *No peer is commissioned that
 * has not already graded this* and *the branch is gone so there is nothing to diff* are different
 * facts about the fleet, and only one of them is something an operator can act on.
 */
function BatchProgress({
  batch,
  labels,
  onOpenTask
}: {
  batch: GradeBatch
  labels: Record<string, string>
  onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const shown = batch.entries.filter((e) => e.state !== 'queued').slice(0, 50)
  return (
    <>
      <p className={batch.state === 'running' ? '' : 'dim'}>
        <strong>
          {batch.state === 'running'
            ? 'Grading'
            : batch.state === 'cancelled'
              ? 'Batch stopped'
              : 'Batch finished'}
        </strong>{' '}
        — {batch.graded} graded · {batch.grading} in flight · {batch.queued} queued · {batch.skipped}{' '}
        skipped, of {batch.entries.length} attempted. Started {when(batch.startedAt)}.{' '}
        {batch.state === 'running' && 'Progress per task is on the Tasks page and in each thread.'}
      </p>
      {shown.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Task</th>
              <th>State</th>
              <th className="tbl-num">Score</th>
              <th>Reviewer</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.taskId}>
                <td className="tbl-title-cell">
                  <button className="linkish tbl-title" title={entry.title} onClick={() => onOpenTask(entry.taskId)}>
                    <span className="tbl-strong">t{entry.seq}</span> {entry.title}
                  </button>
                </td>
                <td className={entry.state === 'skipped' ? 'warn' : 'dim'}>{entry.state}</td>
                <td className="tbl-num num">
                  {entry.composite === null ? '—' : entry.composite.toFixed(1)}
                </td>
                {entry.reviewer === null ? (
                  <td className="dim">—</td>
                ) : (
                  <Agent adapterId={entry.reviewer} model={entry.reviewerModel} labels={labels} />
                )}
                <td className={entry.state === 'skipped' ? 'warn' : 'dim'}>{entry.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/**
 * One agent in a table cell. ⛔ Never the adapter id alone — see `AgentLabel`, which says why.
 */
function Agent({
  adapterId,
  model,
  labels
}: {
  adapterId: string | null
  model: string | null
  labels: Record<string, string>
}): React.JSX.Element {
  return (
    <td className="dim">
      <AgentLabel adapterId={adapterId} model={model} labels={labels} />
    </td>
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
