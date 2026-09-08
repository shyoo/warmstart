import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Conversation, ConversationRun, ConversationTask } from '@shared/protocol'
import { SESSION_ENDED } from '@shared/protocol'
import { rpc, useDaemonEvents, useNow } from '../lib/daemon'
import { duration, tokens, when } from '../lib/format'
import { Working } from '../lib/taskview'
import { errorMessage } from '@shared/errors.js'

/**
 * Which conversation served which runs.
 *
 * ⛔ **This page exists because one sequence is invisible everywhere else: what actually happened
 * inside one conversation, in order.** A task's own pane says which conversation each of its runs was
 * in; nothing said what *else* had happened in that conversation. Once a session outlives the task
 * that opened it, that is the difference between the cost saving working and two agents having read
 * work nobody meant to show them, and the two look identical from the task list.
 *
 * ⛔ **One component, two mount points.** Rendered with a `projectId` it is the project's
 * Conversations tab; rendered without one it is History → Conversations. They answer the same
 * question at two scopes, and two tables would have drifted about what a conversation is.
 *
 * ⚠️ Read-only, deliberately. The only honest actions here would be "run a task in this
 * conversation", which the task pane already offers, and "close it", which the cache clock owns — and
 * a close button beside a live agent is an invitation to kill a run by tidying up.
 */

/**
 * What a conversation's *work* outcome is called, and what colour it reads as.
 *
 * ⛔ Not `sessions.state`. That is a fact about the process, and this column answers "did the work in
 * here succeed?" — see `conversationOutcome` in the daemon for why the two had to be split.
 */
const OUTCOME_TONE: Record<string, string> = {
  completed: 'state-ok',
  failed: 'state-danger',
  blocked: 'state-human',
  cancelled: 'state-idle',
  terminated: 'state-idle',
  preempted: 'state-warn',
  mixed: 'state-warn'
}

const OUTCOME_LABEL: Record<string, string> = {
  completed: 'completed',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'cancelled',
  terminated: 'stopped',
  preempted: 'preempted',
  mixed: 'mixed'
}

/**
 * What became of the *process*, phrased for somebody who did not write it.
 *
 * ⚠️ `abandoned` is not `failed`, and the difference is the daemon's rather than the agent's: the row
 * was still open when the daemon came back, which happens on every rebuild and every reboot. Calling
 * that a failure is what made three quarters of this table red.
 */
const STATE_LABEL: Record<string, string> = {
  starting: 'starting',
  live: 'live',
  idle: 'idle',
  closed: 'closed',
  abandoned: 'abandoned',
  failed: 'crashed'
}

const STATE_HINT: Record<string, string> = {
  starting: 'The process is being spawned.',
  live: 'The agent process is running right now.',
  idle: 'The process is up and between turns.',
  closed: 'We asked this session to stop, and it stopped.',
  abandoned:
    'The daemon restarted while this session was still open, so nobody saw how it ended. That is ' +
    'ordinary — a rebuild or a reboot does it — and it is not a statement about the work.',
  failed: 'The process died without being asked to. This is the only state that blames the session.'
}

type Filter = 'all' | 'live' | 'shared' | 'trouble'

const FILTERS: Array<{ id: Filter; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: 'Every work conversation, newest first' },
  { id: 'live', label: 'Live', hint: 'Conversations whose agent process is still up' },
  {
    id: 'shared',
    label: 'Shared',
    hint: 'Conversations that served more than one task — the agent in them saw all of that work'
  },
  {
    id: 'trouble',
    label: 'Trouble',
    hint: 'A run in here failed, or the process died without being asked to'
  }
]

function isLive(c: Conversation): boolean {
  return !SESSION_ENDED.includes(c.state)
}

function isTrouble(c: Conversation): boolean {
  return c.outcome === 'failed' || c.outcome === 'mixed' || c.state === 'failed'
}

export function matchesFilter(c: Conversation, filter: Filter): boolean {
  if (filter === 'live') return isLive(c)
  if (filter === 'shared') return c.taskCount > 1
  if (filter === 'trouble') return isTrouble(c)
  return true
}

export function Conversations({
  projectId,
  projectName,
  onOpenTask
}: {
  /** When set, this is one project's conversations and the project column is dropped. */
  projectId?: string
  projectName?: string
  /**
   * Open the task a run belonged to.
   *
   * ⚠️ Optional. Where the host has nowhere to put a thread, the run is not drawn as a link rather
   * than drawn as one that does nothing.
   */
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  const [rowsData, setRows] = useState<Conversation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const now = useNow(1000)

  const refresh = useCallback(async () => {
    try {
      setRows(await rpc('conversation.list', projectId ? { projectId } : {}))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A run starting or ending is what changes this page, so it follows the same events the task list
  // does rather than polling.
  useDaemonEvents((event) => {
    if (event.type === 'run.changed' || event.type === 'session.changed') void refresh()
  })

  // ⛔ Counted over everything, not over what is showing. A chip whose number changed when you
  // selected it would be describing the filter rather than the fleet, and the number is the reason
  // the chip is worth clicking.
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.id, rowsData.filter((c) => matchesFilter(c, f.id)).length])
      ) as Record<Filter, number>,
    [rowsData]
  )

  const shown = rowsData.filter((c) => matchesFilter(c, filter))
  const totalRuns = rowsData.reduce((sum, c) => sum + c.runCount, 0)

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Conversations</h2>
          <p className="panel-sub">
            A conversation is one agent session — the thing <code>--resume</code> reopens. It can
            outlive the task that opened it, so each row expands into everything that happened in it,
            in the order it happened. {projectName ? `Scoped to ${projectName}.` : 'Every project.'}
          </p>
        </div>
        {/* ⛔ Runs beside conversations. The count of sessions alone is the number that has never
            told anybody anything: it goes up by one per dispatch. */}
        <div className="conv-total num">
          <strong>{rowsData.length}</strong>
          <span className="dim">
            {rowsData.length === 1 ? 'conversation' : 'conversations'} · {totalRuns} run
            {totalRuns === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`chip${filter === f.id ? ' chip--on' : ''}`}
            onClick={() => setFilter(f.id)}
            title={f.hint}
          >
            {f.label}
            <span className="chip-n">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty-inline">
          {/* ⚠️ Three different nothings. Still loading, a filter that matches none, and genuinely
              none — offering "one is opened the first time a task is dispatched" to somebody with
              forty conversations and a chip selected reads as the app having lost them. */}
          {!loaded ? (
            <p className="dim">Reading conversations…</p>
          ) : rowsData.length > 0 ? (
            <>
              <p>No conversations in that view.</p>
              <p className="dim">The filter is hiding the rest — the counts above say where.</p>
              <button className="btn" onClick={() => setFilter('all')}>
                Show all
              </button>
            </>
          ) : (
            <>
              <p>No conversations yet.</p>
              <p className="dim">
                One is opened the first time a task is dispatched{projectName ? ' here' : ''}, and it
                is reused for as long as it stays warm and on the same tree.
              </p>
            </>
          )}
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="tbl-col-caret" />
              <th>Conversation</th>
              {/* ⛔ "Worker", not "account". A worker is what the fleet strip, the task table and the
                  routing log all call it; this table was the only screen using another word for the
                  same object. */}
              <th>Worker</th>
              {!projectId && <th>Project</th>}
              <th>Branch</th>
              {/* ⛔ Runs first. It is the number that varies: no conversation here has ever served
                  two tasks, and one has served nine runs. */}
              <th className="tbl-num">Runs</th>
              <th className="tbl-num">Tasks</th>
              <th className="tbl-num">Context</th>
              <th className="tbl-num">Tokens</th>
              <th>Started</th>
              {/* ⛔ Both ends. "Started 3h ago" alone cannot tell a conversation that has been
                  working for three hours from one that stopped after ninety seconds. */}
              <th>Ended</th>
              <th className="tbl-num">Took</th>
              <th>Outcome</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <ConversationRow
                key={c.sessionId}
                conversation={c}
                showProject={!projectId}
                now={now}
                expanded={open === c.sessionId}
                onToggle={() => setOpen(open === c.sessionId ? null : c.sessionId)}
                {...(onOpenTask ? { onOpenTask } : {})}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ConversationRow({
  conversation: c,
  showProject,
  now,
  expanded,
  onToggle,
  onOpenTask
}: {
  conversation: Conversation
  showProject: boolean
  now: number
  expanded: boolean
  onToggle: () => void
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  const live = isLive(c)
  const ended = c.closedAt
  // ⚠️ A live conversation is timed against the clock, not against a `closedAt` it does not have.
  // A dash there would say "no duration", and the duration is the whole point while it is running.
  const took = duration((ended ?? now) - c.startedAt)
  const columns = showProject ? 14 : 13

  return (
    <>
      <tr
        className={`conv-row${live ? '' : ' tbl-row--off'}${expanded ? ' tbl-row--selected' : ''}`}
        onClick={onToggle}
      >
        <td className="tbl-col-caret">
          <span className={`caret${expanded ? ' caret--open' : ''}`} aria-hidden>
            ▸
          </span>
        </td>
        <td>
          {/* ⚠️ The vendor's id, not ours — this is the string that goes after `--resume` or
              `--conversation`, so it is the one worth being able to read out of here. */}
          <span className="tbl-strong mono" title={`${c.conversationId} — the id --resume takes`}>
            {c.conversationId.slice(0, 8)}
          </span>
          <div className="tbl-path mono">{c.adapterId}</div>
        </td>
        <td>{c.workerLabel}</td>
        {showProject && <td className={c.projectName ? '' : 'dim'}>{c.projectName ?? '—'}</td>}
        <td className="mono">
          {c.currentBranch ? (
            c.currentBranch.replace(/^multi-agent-controller\//, '')
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td className="num tbl-num">{c.runCount}</td>
        <td className="num tbl-num">
          {/* ⭐ Anything above 1 is a shared conversation — the agent in it saw every one of them. */}
          {c.taskCount > 1 ? (
            <strong title="Shared — the agent in this conversation saw every one of these tasks.">
              {c.taskCount}
            </strong>
          ) : (
            c.taskCount
          )}
        </td>
        <td className="num tbl-num">{tokens(c.contextTokens)}</td>
        <td className="num tbl-num">{tokens(c.tokens || null)}</td>
        <td className="tbl-when dim" title={new Date(c.startedAt).toLocaleString()}>
          {when(c.startedAt)}
        </td>
        <td className="tbl-when dim" title={ended ? new Date(ended).toLocaleString() : undefined}>
          {ended ? when(ended) : <span className="state-running">still open</span>}
        </td>
        <td className="num tbl-num dim">{took}</td>
        <td>
          {c.outcome ? (
            <span className={`status ${OUTCOME_TONE[c.outcome] ?? ''}`}>
              {OUTCOME_LABEL[c.outcome] ?? c.outcome}
              {live && <Working />}
            </span>
          ) : (
            // ⛔ Not "unknown". A conversation with no run is a specific, diagnosable thing: it was
            // opened and never used, which means a dispatch died before its first turn.
            <span className="dim" title="Opened, but no run was ever recorded against it.">
              no runs
            </span>
          )}
        </td>
        <td>
          <span
            className={`tag${c.state === 'failed' ? ' tag--suspect' : ''}`}
            title={STATE_HINT[c.state]}
          >
            {STATE_LABEL[c.state] ?? c.state}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="conv-detail">
          <td colSpan={columns}>
            <Timeline conversation={c} {...(onOpenTask ? { onOpenTask } : {})} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * What happened in this conversation, in order.
 *
 * ⛔ **Runs, grouped under their task.** The two questions this page is asked are "who else was in
 * here?" (the tasks) and "what did it do?" (the runs), and a view that answered only the first was
 * true and useless: sharing is off at every tier, so every conversation reads `1 task`, while the
 * same conversation may have taken nine turns across several attempts at that one task. Grouping
 * keeps the sharing answer legible for when sharing is switched on, and the runs underneath are the
 * history somebody actually came to review.
 */
function Timeline({
  conversation: c,
  onOpenTask
}: {
  conversation: Conversation
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  return (
    <div className="conv-timeline">
      <div className="tbl-path mono">{c.cwd}</div>
      {c.tasks.length === 0 ? (
        <p className="note">
          No run has been recorded against this conversation. It was opened and never used — a
          dispatch that failed before its first turn.
        </p>
      ) : (
        c.tasks.map((task) => (
          <TaskGroup
            key={task.taskId}
            task={task}
            shared={c.taskCount > 1}
            {...(onOpenTask ? { onOpenTask } : {})}
          />
        ))
      )}
    </div>
  )
}

function TaskGroup({
  task,
  shared,
  onOpenTask
}: {
  task: ConversationTask
  shared: boolean
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  return (
    <section className="conv-task">
      <header className="conv-task-head">
        <button
          type="button"
          className="conv-task-title"
          disabled={!onOpenTask}
          onClick={() => onOpenTask?.(task.taskId)}
          title={onOpenTask ? 'Open this task’s thread' : task.title}
        >
          <span className="mono">t{task.seq}</span>
          <span>{task.title}</span>
        </button>
        <span className="conv-task-meta num dim">
          {task.runs} run{task.runs === 1 ? '' : 's'} · {tokens(task.tokens || null)} tokens
          {/* ⛔ Nothing at all when it was never recorded, rather than `new`. */}
          {task.startedWarm !== null && (
            <>
              {' · '}
              <span className={task.startedWarm ? 'ok' : 'dim'}>
                {task.startedWarm ? 'continued' : 'started cold'}
              </span>
            </>
          )}
          {shared && <span className="tag conv-shared-tag">shared</span>}
        </span>
      </header>
      <ol className="conv-runs">
        {task.timeline.map((run, i) => (
          <RunLine key={run.runId} run={run} index={i + 1} />
        ))}
      </ol>
    </section>
  )
}

function RunLine({ run, index }: { run: ConversationRun; index: number }): React.JSX.Element {
  const outcome = run.outcome
  return (
    <li className="conv-run">
      <span className="conv-run-n num dim">#{index}</span>
      <span className="conv-run-when dim" title={new Date(run.startedAt).toLocaleString()}>
        {when(run.startedAt)}
      </span>
      <span className="conv-run-took num dim">
        {run.endedAt ? (
          duration(run.endedAt - run.startedAt)
        ) : (
          <span className="state-running">running</span>
        )}
      </span>
      <span className="conv-run-tokens num dim">{tokens(run.tokens || null)}</span>
      <span className="conv-run-model mono dim">{run.model ?? '—'}</span>
      {/* ⛔ Labelled, never hidden. A quality review really happened on this conversation and really
          spent these tokens; filtering it out here would make this page disagree with the runs it is
          a view of. */}
      {run.kind !== 'work' && (
        <span className="dim" title="A peer quality review of another agent's work on this task.">
          review
        </span>
      )}
      {run.startedWarm !== null && (
        <span className={`conv-run-warm ${run.startedWarm ? 'ok' : 'dim'}`}>
          {run.startedWarm ? 'warm' : 'cold'}
        </span>
      )}
      <span className={`status ${outcome ? (OUTCOME_TONE[outcome] ?? '') : 'state-running'}`}>
        {outcome ? (OUTCOME_LABEL[outcome] ?? outcome) : 'in flight'}
        {!outcome && <Working />}
      </span>
    </li>
  )
}
