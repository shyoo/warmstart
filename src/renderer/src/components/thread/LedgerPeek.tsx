/**
 * The ledger's headline, kept in view after the ledger itself has scrolled away.
 *
 * ⛔ **A stand-in, never a second source.** A long conversation pushes the status box off the top of
 * the page within a screen or two, and the only way to learn whether the task was still running was
 * to scroll back up and then find your place again (t477, 2026-09-16). This draws the few facts a
 * person scrolls up *for* — which task, what state, and once the timeline has gone too, how the
 * latest attempt is doing — in a small box pinned at the top of the ledger column. Every value is
 * read from the same `task` and `run` the rows below read, so it can never say something the ledger
 * does not; pressing it scrolls the row it stands in for back into view.
 *
 * ⚠️ Drawn only once the box it stands in for has scrolled *above* the page (`useScrolledPast`). A
 * box still below the fold has not been read yet and gets no peek; a box on screen needs none.
 */
import type { Run, Task } from '@shared/tasks'
import type { Session } from '@shared/protocol'
import type { FleetEntry } from '../../lib/daemon'
import { timeRange } from '../../lib/format'
import { holdLine, isWorking, statusLabel, statusToneFor, Working } from '../../lib/taskview'
import { outcomeClass } from '../../lib/threadview'
import { QuotaDelta } from './RunRow'

export function LedgerPeek({
  task,
  now,
  latest,
  sessions,
  fleet,
  onJumpToLedger,
  onJumpToRun
}: {
  task: Task
  now: number
  /** The last run in the timeline, with its `#N`; `null` while the timeline is still on screen. */
  latest: { index: number; run: Run } | null
  sessions: Session[]
  fleet: FleetEntry[]
  onJumpToLedger: () => void
  onJumpToRun: () => void
}): React.JSX.Element {
  const hold = holdLine(task, now)
  const run = latest?.run ?? null
  const session = run ? sessions.find((s) => s.id === run.sessionId) : undefined
  const worker = run ? fleet.find((f) => f.worker.id === run.workerId)?.worker.label : undefined
  const modelName = run ? (run.model ?? session?.model ?? 'CLI default') : ''
  return (
    <div className="ledger-peek" data-testid="ledger-peek">
      <button
        type="button"
        className="ledger-peek-section"
        title="The ledger has scrolled away. Press to go back to it."
        onClick={onJumpToLedger}
      >
        <span className="ledger-peek-row">
          <span className="ledger-peek-key">task</span>
          <span className="ledger-peek-val mono">t{task.seq}</span>
        </span>
        <span className="ledger-peek-row">
          <span className="ledger-peek-key">status</span>
          <span className="ledger-peek-val">
            <span className={`status ${statusToneFor(task)}`}>
              {statusLabel(task)}
              {isWorking(task) && <Working />}
            </span>
          </span>
        </span>
        {hold && (
          <span className="ledger-peek-row">
            <span className="ledger-peek-key">{task.status === 'awaiting_human' ? 'wants' : 'waiting on'}</span>
            <span className="ledger-peek-val">{hold}</span>
          </span>
        )}
      </button>
      {latest && run && (
        <button
          type="button"
          className="ledger-peek-section ledger-peek-section--run"
          title="The timeline has scrolled away. Press to go back to this run."
          onClick={onJumpToRun}
        >
          <span className="ledger-peek-head">
            <span className="side-run-seq">#{latest.index} Run</span>
            <span className="num dim">{timeRange(run.startedAt, run.endedAt, now)}</span>
          </span>
          <span className="ledger-peek-row">
            <span className="ledger-peek-key">on</span>
            <span className="ledger-peek-val" title={modelName}>
              {worker ? `${worker} / ` : ''}
              {modelName}
            </span>
          </span>
          {run.startedWarm !== null && (
            <span className="ledger-peek-row">
              <span className="ledger-peek-key">fresh</span>
              <span className={`ledger-peek-val ${run.startedWarm ? 'ok' : 'dim'}`}>
                {run.startedWarm ? 'reused' : 'new'}
              </span>
            </span>
          )}
          <span className="ledger-peek-row">
            <span className="ledger-peek-key">status</span>
            <span className={`ledger-peek-val ${outcomeClass(run.outcome)}`}>
              {run.outcome ?? 'running'}
            </span>
          </span>
          {run.quotaBefore && (
            <span className="ledger-peek-row">
              <span className="ledger-peek-key">usage</span>
              <span className="ledger-peek-val">
                <QuotaDelta run={run} />
              </span>
            </span>
          )}
        </button>
      )}
    </div>
  )
}
