import { useCallback, useEffect, useState } from 'react'
import type { Project, Run, Task, TaskMessage } from '@shared/tasks'
import type { ModelOptions, Session } from '@shared/protocol'
import { rpc, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { duration, tokens, when } from '../lib/format'

type TaskDetailData = {
  task: Task
  messages: TaskMessage[]
  runs: Run[]
  sessions: Session[]
  activity: Array<{ text: string; ts: number }>
}

/**
 * How long this task has been worked on, or was worked on.
 *
 * ⛔ Measured from the first **run**, not from `createdAt`. When somebody typed a task in is not how
 * long it took; a task filed on Monday and dispatched on Wednesday did not take two days. A task
 * that has never run has no duration, and says so rather than showing zero.
 */
function elapsed(task: Task, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration((task.lastRunEndedAt ?? now) - task.firstRunAt)
}

/**
 * The task table.
 *
 * Tabular and dense on purpose — this is a control surface, not a board. The columns are what an
 * operator actually needs to decide something: who filed it, who is on it, what it is waiting for,
 * and what it has spent.
 *
 * ⛔ Cancel is not delete. Cancel is a row action that winds the work down into a resting state and
 * destroys nothing; delete sits behind the row menu, refuses while anything depends on the task, and
 * never removes the runs.
 */

const STATUS_TONE: Record<string, string> = {
  running: 'state-running',
  assigned: 'state-running',
  ready: 'state-ok',
  completed: 'state-ok',
  failed: 'state-danger',
  awaiting_human: 'state-human',
  blocked: 'state-idle',
  scheduled: 'state-idle',
  draft: 'state-idle',
  paused_user: 'state-warn',
  paused_quota: 'state-warn',
  cancelling: 'state-warn',
  cancelled: 'state-idle'
}

/**
 * What a status is called where a person can see it.
 *
 * ⛔ Renamed here, not in the domain. `assigned` means something precise to the scheduler and to
 * cancel.ts, and changing it there to suit a table would be the tail wagging the dog. But it is the
 * state a task is in while a workspace is being claimed, a branch checked out and the project's
 * prepare hook run — which is *dispatching*, and is the part of the wait that most needs a name.
 */
const STATUS_LABEL: Record<string, string> = { assigned: 'dispatching' }

/**
 * Statuses where something is happening and the next change arrives on its own.
 *
 * ⚠️ `ready` is in here, and that is the whole point of the list. A freshly filed task sits at
 * `ready` for up to one scheduler tick before anything moves, and rendered as a flat word beside
 * `completed` and `failed` it reads as a resting state — as though the operator were the one being
 * waited on. They are not: it is queued, and the dots say so.
 */
const IN_FLIGHT = new Set(['ready', 'scheduled', 'assigned', 'running', 'cancelling'])

/** Three dots that say the fleet is doing something, for a row whose next event arrives by itself. */
function Working(): React.JSX.Element {
  return (
    <span className="working" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * Who is on this task, resolved to a name.
 *
 * ⛔ `assignee` holds a worker **id** — a uuid, which is the correct thing to store and useless to
 * read. The two reserved values are not worker ids at all and must not be looked up as though they
 * were, or a task waiting on a person renders as a missing account.
 */
function assigneeLabel(task: Task, fleet: FleetEntry[]): string {
  if (!task.assignee) return '—'
  if (task.assignee === 'human') return 'you'
  if (task.assignee === 'controller') return 'controller'
  return fleet.find((f) => f.worker.id === task.assignee)?.worker.label ?? task.assignee.slice(0, 8)
}

export function Tasks({
  projects,
  projectId,
  fleet
}: {
  projects: Project[]
  /** When set, this list is one project's and the creation form does not offer to change it. */
  projectId?: string
  /** Only so a worker id can be drawn as the name of an account. */
  fleet: FleetEntry[]
}): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /**
   * The live tail, per task.
   *
   * ⛔ Kept here rather than inside the detail pane, and appended from the event stream rather than
   * re-fetched. A task's own list refreshes on every `task.changed`, and a pane that rebuilt its tail
   * from each fetch would flicker back to whatever the daemon happened to hold at that instant.
   */
  const [activity, setActivity] = useState<Record<string, Array<{ text: string; ts: number }>>>({})
  const now = useNow(1000)

  const refresh = useCallback(async () => {
    setTasks(await rpc('task.list', projectId ? { projectId } : {}))
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    void rpc('task.get', { id: selected }).then((got) => {
      setDetail(got)
      // Seed the tail once from whatever the daemon is holding, so opening a task that is already
      // running does not start from a blank pane. Events take over from here.
      if (got && got.activity.length > 0) {
        setActivity((prev) => (prev[got.task.id]?.length ? prev : { ...prev, [got.task.id]: got.activity }))
      }
    })
  }, [selected, tasks])

  useDaemonEvents((event) => {
    if (event.type === 'task.changed' || event.type === 'run.changed') void refresh()
    if (event.type === 'task.activity') {
      // A new attempt starts with an empty pane. See clearActivity.
      if (event.reset) {
        setActivity((prev) => ({ ...prev, [event.taskId]: [] }))
        return
      }
      setActivity((prev) => {
        // ⚠️ Bounded here as well as in the daemon. This is agent output arriving as fast as a model
        // can produce it, and an unbounded array in a React state is a memory leak with a pretty UI.
        const tail = [...(prev[event.taskId] ?? []), { text: event.text, ts: event.ts }].slice(-40)
        return { ...prev, [event.taskId]: tail }
      })
    }
  })

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    await refresh()
  }

  const remove = async (task: Task) => {
    const blockers = await rpc('task.deleteCheck', { id: task.id })
    if (!blockers.ok) {
      setError(`Cannot delete t${task.seq}:\n${blockers.reasons.map((r) => `• ${r}`).join('\n')}`)
      return
    }
    await act(() => rpc('task.delete', { id: task.id }))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Tasks</h2>
          <p className="panel-sub">
            A task is a thread of work with an assignee — not a prompt. Anyone can file one: you, the
            controller, or an agent mid-run.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New task'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {adding && (
        <NewTask
          projects={projects}
          fixedProjectId={projectId}
          fleet={fleet}
          onDone={async () => {
            setAdding(false)
            await refresh()
          }}
          onError={setError}
        />
      )}

      {tasks.length === 0 ? (
        <div className="empty-inline">
          <p>No tasks yet.</p>
          <p className="dim">
            File one and the scheduler will route it to a worker that can afford it, in a workspace of
            its own, on a branch named after the task.
          </p>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="tbl-num">#</th>
              <th>Title</th>
              <th>Status</th>
              {/* ⛔ On the table, not only in the detail pane. Which account is spending on a task is
                  the first thing an operator checks and the last thing that should need a click —
                  and a routing mistake is invisible until it is shown here. */}
              <th>Worker</th>
              <th>From</th>
              <th>Dep</th>
              {/* ⛔ How long, beside how much. A task showing only a token count answers "what did
                  this cost" and not "is this taking too long", and the second is the question
                  somebody watching a run actually has. */}
              <th className="tbl-num">Took</th>
              {/* ⚠️ "Spent" was read as money by everybody who saw it. These are tokens. */}
              <th className="tbl-num">Tokens</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className={selected === task.id ? 'tbl-row--selected' : ''}
                onClick={() => setSelected(task.id === selected ? null : task.id)}
              >
                <td className="num tbl-num">{task.seq}</td>
                <td>
                  <span className="tbl-strong">
                    {task.lineageDepth > 0 && <span className="dim">{'└ '}</span>}
                    {task.title.length > 70 ? `${task.title.slice(0, 70)}…` : task.title}
                  </span>
                  {task.branch && <div className="tbl-path mono">{task.branch}</div>}
                </td>
                <td>
                  <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>
                    {STATUS_LABEL[task.status] ?? task.status}
                    {IN_FLIGHT.has(task.status) && <Working />}
                  </span>
                  {/* The scheduler's own reason, refreshed every tick it passes this task over. */}
                  {task.holdReason && <div className="tbl-sub dim">{task.holdReason}</div>}
                  {/* ⛔ One line only. The full tail is in the detail pane; a table that grew a
                      paragraph per running row would stop being a table. */}
                  {task.status === 'running' && activity[task.id]?.length ? (
                    <div className="tbl-sub tbl-live">
                      {activity[task.id]?.[activity[task.id]!.length - 1]?.text}
                    </div>
                  ) : null}
                </td>
                <td className={task.assignee ? '' : 'dim'}>{assigneeLabel(task, fleet)}</td>
                <td className="dim">
                  {task.createdBy.kind === 'human'
                    ? 'you'
                    : task.createdBy.kind === 'controller'
                      ? 'ctrl'
                      : 'agent'}
                </td>
                <td className="num dim">{task.dependsOn.length ? `←${task.dependsOn.length}` : '—'}</td>
                <td className="num tbl-num dim">{elapsed(task, now)}</td>
                <td className="num tbl-num">{tokens(task.budget.spentTokens || null)}</td>
                <td className="tbl-actions" onClick={(e) => e.stopPropagation()}>
                  {CANCELLABLE.has(task.status) && (
                    <button
                      className="btn btn--ghost"
                      title="Stop the work and return this task to a resting state. Destroys nothing."
                      onClick={() => void act(() => rpc('task.cancel', { id: task.id }))}
                    >
                      Cancel
                    </button>
                  )}
                  {(task.status === 'paused_user' || task.status === 'cancelled') && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => void act(() => rpc('task.resume', { id: task.id }))}
                    >
                      Resume
                    </button>
                  )}
                  {/* ⛔ On the row too. A task waiting on a person is the one thing an operator
                      scans this table for, and needing to open it first to find any way to answer
                      is what left t3 sitting in `awaiting_human` after its work was done. */}
                  {task.status === 'awaiting_human' && (
                    <button
                      className="btn btn--ghost"
                      title="Records that you are satisfied. Nothing is verified by this — it is your judgement."
                      onClick={() => void act(() => rpc('task.resolve', { id: task.id }))}
                    >
                      Mark done
                    </button>
                  )}
                  {task.status === 'draft' && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => void act(() => rpc('task.promote', { id: task.id }))}
                    >
                      Queue
                    </button>
                  )}
                  <button
                    className="btn btn--ghost btn--danger"
                    title="Delete. Runs are kept either way — they are the record of what this cost."
                    onClick={() => void remove(task)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <TaskDetail
          detail={detail}
          activity={activity[detail.task.id] ?? []}
          fleet={fleet}
          now={now}
          refresh={async () => {
            setDetail(await rpc('task.get', { id: detail.task.id }))
          }}
        />
      )}
    </div>
  )
}

const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota'
])

/**
 * One task, opened.
 *
 * ⛔ Two columns, and which fact goes in which is the whole design. The **left** is the conversation
 * — what was said, what is being said right now, and the box for saying the next thing; it is the
 * only part a person reads in order. The **right** is the ledger — who is on it, on which session,
 * for how long, at what cost. Everything on the right used to be either absent or spread through
 * prose in the thread, which meant "which session is this running on?" was answerable only by
 * reading a paragraph the daemon happened to have written.
 */
function TaskDetail({
  detail,
  activity,
  fleet,
  now,
  refresh
}: {
  detail: TaskDetailData
  /** The live tail, kept by the list so it survives a re-fetch of the detail. */
  activity: Array<{ text: string; ts: number }>
  fleet: FleetEntry[]
  now: number
  refresh: () => Promise<void>
}): React.JSX.Element {
  const { task, messages, runs, sessions } = detail
  const live = task.status === 'running' || task.status === 'assigned'
  const resolve = async () => {
    await rpc('task.resolve', { id: task.id })
    await refresh()
  }
  const cancel = async () => {
    await rpc('task.cancel', { id: task.id })
    await refresh()
  }
  const liveSession = sessions.find(
    (s) => s.id === runs[0]?.sessionId && s.state !== 'closed' && s.state !== 'failed'
  )

  return (
    <section className="detail">
      <h3>
        t{task.seq} · {task.title}
      </h3>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="thread">
            {messages.length === 0 && <p className="dim">Nothing has been said on this task yet.</p>}
            {messages.map((m) => (
              <div key={m.id} className={`msg msg--${m.role}`}>
                <span className="msg-role">{m.role}</span>
                <span className="msg-text">{m.text}</span>
              </div>
            ))}
          </div>

          {/* ⛔ Below the thread and outside it. This is not part of the record — it is a window onto
              a process that is still running, and mixing the two would make the thread unreadable
              afterwards. It disappears when there is nothing running and nothing was said. */}
          {(live || activity.length > 0) && (
            <div className="peek">
              <div className="peek-head">
                <span>live</span>
                {live && <Working />}
                <span className="dim">
                  what the agent is saying as it works — not kept, and not the record
                </span>
              </div>
              <div className="peek-body">
                {activity.length === 0 ? (
                  <span className="dim">waiting for the agent’s first words…</span>
                ) : (
                  // ⚠️ Newest first in the DOM, drawn bottom-up by `column-reverse`. That is what
                  // pins the view to the latest line without a scroll handler — a pane that had to
                  // be scrolled by hand to see the current line is not a live view of anything.
                  [...activity].reverse().map((line, i) => (
                    <div key={`${line.ts}-${i}`} className="peek-line">
                      {line.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <Compose task={task} refresh={refresh} />
        </div>

        <aside className="detail-side">
          <Fact label="status">
            <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>
              {STATUS_LABEL[task.status] ?? task.status}
              {IN_FLIGHT.has(task.status) && <Working />}
            </span>
          </Fact>
          {task.holdReason && (
            <Fact label={task.status === 'awaiting_human' ? 'wants' : 'waiting on'}>
              {task.holdReason}
            </Fact>
          )}
          {/*
            ⛔ The one status that is explicitly about the operator was the only one with nothing to
            press. Everything else at rest has Resume, Queue, Cancel or Delete; the state meaning "a
            decision is wanted from you" offered nowhere to record the decision, so a task whose work
            was done but had not landed sat there next to a run marked `completed` and the only exits
            were to cancel work that had succeeded or delete the record of it.
          */}
          {task.status === 'awaiting_human' && (
            <div className="decide">
              <div className="decide-head">your call</div>
              <div className="decide-actions">
                <button
                  className="btn btn--primary"
                  title="Records that you are satisfied. ⚠️ Nothing is verified by this — it is your judgement, and it is written into the thread as such."
                  onClick={() => void resolve()}
                >
                  Mark done
                </button>
                <button
                  className="btn btn--ghost"
                  title="Stops here and rests the task. Destroys nothing."
                  onClick={() => void cancel()}
                >
                  Stop here
                </button>
              </div>
              <p className="decide-hint">
                Or say what you want next in the box below — that continues this task as another run
                on the same thread, on the session that still holds its context.
              </p>
            </div>
          )}
          <Fact label="worker">{assigneeLabel(task, fleet)}</Fact>

          {/* ⭐ The question this whole cost model exists to answer, and the one the UI could not.
              A worker id says which account paid; only the session says whether the run continued
              from a warm prefix at 0.1·C or rebuilt one at 2.0·C. */}
          <Fact label="session">
            <SessionFact runs={runs} sessions={sessions} />
          </Fact>

          {/*
            ⛔ Context and tokens are different *kinds* of number and were shown side by side with
            nothing saying so — "52k ctx" beside "1.2M tokens" reads as a contradiction until you
            know one is a level and the other a total. Context is how full the window is *right now*
            and goes down when a session compacts; tokens are everything this task has ever spent and
            only ever go up.
          */}
          {/* ⚠️ Only when there is a number. `0 in the window now` is a measurement of nothing — the
              same reason the session chip draws an empty context as an absence. */}
          {liveSession?.contextTokens ? (
            <Fact label="context">
              <span
                className="num"
                title={
                  'How full this session’s context window is at the moment — a level, not a total. ' +
                  'It falls when the session compacts. It is not the number below it.'
                }
              >
                {tokens(liveSession.contextTokens)} in the window now
              </span>
            </Fact>
          ) : null}
          <Fact label="priority">{task.priority}</Fact>
          <Fact label="filed">{when(task.createdAt)}</Fact>
          {task.firstRunAt && <Fact label="started">{when(task.firstRunAt)}</Fact>}
          <Fact label="took">{elapsed(task, now)}</Fact>
          {/* ⚠️ Named, not left as "spent". A bare number in a column headed Spent is read as money
              by roughly everybody; these are tokens, metered from the agent's own transcript. */}
          <Fact label="tokens">
            <span
              className="num"
              title={
                'Everything every run of this task has spent — input, output and cache, summed from ' +
                'the agent’s own transcript. A total, so it only ever grows, and much larger than ' +
                'the context above because every turn re-reads the whole window.'
              }
            >
              {tokens(task.budget.spentTokens || null)} spent in total
            </span>
          </Fact>
          {task.branch && (
            <Fact label="branch">
              <span className="mono">{task.branch}</span>
            </Fact>
          )}
          <Fact label="mandate">
            {task.mandate.allowed.join(', ')} · depth {task.lineageDepth}/
            {task.mandate.maxLineageDepth}
          </Fact>

          {runs.length > 0 && (
            <div className="side-runs">
              {/* ⚠️ The label carries the distinction, because "completed" here beside
                  "awaiting_human" above is the thing that reads as a contradiction. A run is one
                  attempt; whether the *task* is done is a separate question. */}
              <div
                className="side-label"
                title="One attempt each. A run finishing says the agent stopped cleanly — not that the task is done, which is what the status above answers."
              >
                runs · attempts, not outcomes
              </div>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} fleet={fleet} now={now} />
              ))}
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{children}</span>
    </div>
  )
}

/**
 * Which session, and whether its context was reused.
 *
 * ⛔ Reuse is decided by the clock, not by a flag: a session that already existed when the run
 * started is one whose prompt cache the run inherited. Nothing needs to record the intent, and a
 * recorded intent could disagree with what happened.
 */
function SessionFact({ runs, sessions }: { runs: Run[]; sessions: Session[] }): React.JSX.Element {
  const run = runs[0]
  if (!run?.sessionId) return <span className="dim">none yet</span>
  const session = sessions.find((s) => s.id === run.sessionId)
  const reused = session ? session.startedAt < run.startedAt : null

  return (
    <>
      <span className="mono">{run.sessionId.slice(0, 8)}</span>{' '}
      {reused === null ? (
        <span className="dim">(closed)</span>
      ) : reused ? (
        <span className="ok" title="The run continued in a session that already held this task's context — a cache read at 0.1·C.">
          reused, context kept
        </span>
      ) : (
        <span className="dim" title="A new process, so the prompt prefix was built from nothing — 2.0·C.">
          new session
        </span>
      )}
    </>
  )
}

/**
 * One attempt, with what it cost — twice over, and deliberately not reconciled.
 *
 * ⛔ The token counts are exact assistant-turn metering from the agent's own transcript. The window
 * figures are the *account's* view, read either side of the run, and they include everything the CLI
 * spent that never reached a transcript. The two disagreeing is the measurement, not a bug — HANDOFF
 * calls that gap the instrument. Merging them would destroy it.
 */
function RunRow({
  run,
  fleet,
  now
}: {
  run: Run
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const worker = fleet.find((f) => f.worker.id === run.workerId)?.worker.label
  const spent = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="mono">{run.id.slice(0, 8)}</span>
        <span className={run.outcome === 'completed' ? 'ok' : run.outcome ? 'warn' : 'state-running'}>
          {run.outcome ?? 'running'}
        </span>
        <span className="num dim">{duration((run.endedAt ?? now) - run.startedAt)}</span>
      </div>
      <div className="side-run-body num">
        <span>{worker ?? run.workerId.slice(0, 8)}</span>
        <span
          title={
            'What this run spent: input + output + cache read + cache write, summed from the ' +
            'transcript. ⛔ Not the size of the context — a single long conversation re-reads its ' +
            'whole window every turn, so the total runs far ahead of it.'
          }
        >
          {tokens(spent || null)} spent
        </span>
      </div>
      <QuotaDelta run={run} />
    </div>
  )
}

/**
 * What this run cost the account's window.
 *
 * ⛔ Shown only when there are **two** readings. One reading is a state, not a cost, and rendering
 * "41%" beside a run invites it to be read as the run's price. When the closing reading has not
 * arrived yet — it is taken in the background once the run ends and takes about half a minute — this
 * says so rather than showing half a subtraction.
 */
function QuotaDelta({ run }: { run: Run }): React.JSX.Element | null {
  const before = run.quotaBefore
  const after = run.quotaAfter
  if (!before) return null
  if (!after) {
    return (
      <div className="side-run-quota dim">
        window at {pct(before)} before · closing reading not taken yet
      </div>
    )
  }
  const rows = before.windows
    .map((b) => {
      const a = after.windows.find((w) => w.id === b.id)
      return a ? { label: b.label, from: b.percent, to: a.percent } : null
    })
    .filter((r): r is { label: string; from: number; to: number } => !!r)

  if (rows.length === 0) return null
  return (
    <div className="side-run-quota num">
      {rows.map((r) => (
        <span key={r.label} title="the account's own window, read before the run and after it">
          {r.label} {Math.round(r.from)}% → {Math.round(r.to)}%
          <span className={r.to > r.from ? 'warn' : 'dim'}>
            {' '}
            ({r.to > r.from ? '+' : ''}
            {Math.round(r.to - r.from)})
          </span>
        </span>
      ))}
      {/* ⚠️ A stale reading either side makes the difference meaningless, and it is the difference
          being shown. Say so on the number rather than beside it. */}
      {(before.stale || after.stale) && (
        <span className="warn" title="One of the two readings was already too old to act on.">
          reading not fresh
        </span>
      )}
    </div>
  )
}

function pct(q: NonNullable<Run['quotaBefore']>): string {
  return q.windows.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(' · ')
}

/**
 * Say something to a task.
 *
 * ⛔ The cheap half of a mid-flight question. A note into a live session is a cache read — `0.1·C`,
 * and it refreshes the TTL. The same note delivered by restarting the task is `2.0·C` plus everything
 * the successor has to rediscover about the branch. Nothing is lost when there is no live session:
 * the note waits and is prepended to the next run's prompt instead.
 *
 * ⚠️ Its own layout, not `.form-row`. That is a three-column grid built for a labelled settings form,
 * and this row has no label — so the input landed in the 110px label track and the Send button was
 * drawn on top of what somebody was typing.
 */
function Compose({
  task,
  refresh
}: {
  task: Task
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const running = task.status === 'running' || task.status === 'assigned'

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setSending(true)
    try {
      const result = await rpc('task.message', { id: task.id, text: body })
      setText('')
      setOutcome(result.outcome)
      await refresh()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="compose">
      <div className="compose-row">
        <input
          value={text}
          placeholder={
            running
              ? 'Reply to the agent working on this — it goes into the running session'
              : 'Ask for the next thing — this continues the task, it does not file a new one'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) void send()
          }}
        />
        <button className="btn btn--primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? 'Sending…' : running ? 'Send' : 'Send and continue'}
        </button>
      </div>
      {/*
        ⛔ This used to say "Nothing is running, so this waits… prepended to the prompt the next run
        starts with" — which was true of the code and false of the world, because a finished task has
        no next run. The message went into a still-warm session and produced nothing anybody could
        see. It now starts one, and the hint says which of the two happened.
      */}
      <p className="compose-hint">
        {outcome === 'requeued'
          ? 'Queued as a new run on this task — same thread, and it goes back to the session that ' +
            'still holds the context where there is one.'
          : outcome === 'delivered'
            ? 'Delivered into the run that is already going.'
            : running
              ? 'Delivered straight into the session that is running — a cache read, and it ' +
                'refreshes that session’s TTL. The agent sees it mid-task.'
              : 'This continues the task rather than filing a new one: it starts another run on the ' +
                'same thread, preferring the session, worker and workspace it already used.'}
      </p>
    </div>
  )
}

/**
 * Filing a task, read top to bottom: **where** it runs, **how** it should be treated, **who and
 * what** may run it, and last of all **what to do**.
 *
 * ⛔ The prompt is at the bottom, and that is the whole point of the ordering. It used to be first,
 * with the settings underneath, which meant the field somebody was actually here to fill in was the
 * one they met before they had decided anything — and the three rows they had to read afterwards
 * looked like an afterthought attached to a message they had already written. Everything above the
 * prompt narrows what this task *is*; the prompt says what it is *for*, and it is the last thing
 * touched before filing, exactly as in the composer at the foot of every task thread.
 *
 * ⚠️ Worker sits above Model on purpose, against the sketch this was built from. A model list belongs
 * to one CLI — `costModel(adapter.policy.costModelId).modelIds()` — so until an account is pinned
 * there is no list to draw. Putting the choice that produces the list *below* the control that needs
 * it would have made the Model row point downwards at its own precondition.
 */
function NewTask({
  projects,
  fixedProjectId,
  fleet,
  onDone,
  onError
}: {
  projects: Project[]
  /** Set when filed from inside a project. The picker is replaced by the project's name. */
  fixedProjectId?: string
  /** The accounts that could take this, so one can be pinned and its CLI's models offered. */
  fleet: FleetEntry[]
  onDone: () => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? '')
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2')
  const [verification, setVerification] = useState<'auto' | 'required'>('auto')
  const [plan, setPlan] = useState(false)
  const [workerId, setWorkerId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [saving, setSaving] = useState(false)
  /**
   * ⛔ Fetched, not compiled in. The renderer holds no cost models, and a second table of model facts
   * here would drift from the first the day a model was added to a file and not to this bundle.
   */
  const [options, setOptions] = useState<ModelOptions[]>([])

  useEffect(() => {
    void rpc('model.options')
      .then(setOptions)
      // A fleet with no priceable model list is still a fleet that can run work. The form falls back
      // to whatever each CLI defaults to, which is what it did before there was a picker at all.
      .catch(() => setOptions([]))
  }, [])

  // ⛔ Only accounts that could actually take work. Offering a switched-off worker as a pin produces
  // a task that waits forever on a candidate loop that will never match it.
  const pinnable = fleet.filter((e) => e.worker.enabled).map((e) => e.worker)
  const pinned = pinnable.find((w) => w.id === workerId) ?? null
  const forAdapter = pinned ? (options.find((o) => o.adapterId === pinned.adapterId) ?? null) : null
  const chosen = forAdapter?.models.find((m) => m.id === model) ?? null
  // Effort appears only where the CLI can be told one *and* the chosen model has levels to offer.
  // Neither half is true of any built-in adapter today, so today this renders nothing — by design.
  const efforts = forAdapter?.selectableEffort ? (chosen?.effortLevels ?? []) : []

  const submit = async () => {
    setSaving(true)
    try {
      if (plan) {
        // ⛔ A plan task is decomposed, not dispatched. Its children arrive as drafts and their
        // prompts are written at promotion, not now — which is also why it carries no worker and no
        // model: nothing here runs, and each draft answers those questions for itself.
        await rpc('task.plan', { title: title.trim(), projectId: projectId || null })
      } else {
        await rpc('task.create', {
          title: title.trim(),
          projectId: projectId || null,
          priority,
          verification,
          // ⚠️ Absent, not empty. The daemon reads a *present* `constraints` as an instruction to
          // validate one, and an object of empty strings would be three constraints that name
          // nothing rather than three questions left to the scheduler.
          ...(workerId || model || effort
            ? {
                constraints: {
                  ...(workerId ? { workerId } : {}),
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {})
                }
              }
            : {})
        })
      }
      setTitle('')
      await onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form">
      <div className="form-row">
        <label>Project</label>
        {fixedProjectId ? (
          // ⛔ Not a disabled picker. A control that cannot be used is still a control, and this one
          // would sit there implying the project is a choice being made here. It is not: the page
          // you filed from decided it.
          <span className="form-fixed">
            {projects.find((p) => p.id === fixedProjectId)?.name ?? fixedProjectId}
          </span>
        ) : (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">none — runs without a workspace</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="form-hint">
          A git project gets a pooled worktree and a branch named after the task. Agents never work in
          the trunk.
        </span>
      </div>

      <div className="form-row">
        <label>Policy</label>
        <div>
          <select value={priority} onChange={(e) => setPriority(e.target.value as 'P2')}>
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={verification === 'required'}
              onChange={(e) => setVerification(e.target.checked ? 'required' : 'auto')}
            />
            I want to check this before it lands
          </label>
          <label
            className="check"
            title="A goal too big for one task. It is decomposed rather than dispatched."
          >
            <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
            this is a goal, not a task — break it up first
          </label>
        </div>
        <span className="form-hint">
          Requiring verification stops auto-landing: the branch is kept and the task waits for you.
        </span>
      </div>

      {/* ⛔ Both rows vanish for a goal rather than greying out. A goal dispatches nothing, so an
          account and a model chosen here would apply to no run that will ever exist. */}
      {!plan && (
        <>
          <div className="form-row">
            <label>Worker</label>
            <select
              value={workerId}
              onChange={(e) => {
                setWorkerId(e.target.value)
                // ⛔ Cleared together. A model belongs to one CLI's cost model file, so a model
                // chosen for the account you just moved away from is not merely stale — it is an id
                // the new account's adapter would be handed and fail to start on.
                setModel('')
                setEffort('')
              }}
            >
              <option value="">Auto — the scheduler picks</option>
              {pinnable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            {/* ⚠️ Said plainly because the sketch called this "preferred" and it is not. The
                scheduler skips every other candidate outright; there is no soft form of it. */}
            <span className="form-hint">
              Auto weighs quota, cache warmth and what each account has proved. Choosing one
              <strong> pins</strong> the task: it waits for that account rather than routing around
              it.
            </span>
          </div>

          <div className="form-row">
            <label>{efforts.length > 0 ? 'Model / Effort' : 'Model'}</label>
            {forAdapter ? (
              <div className="pickers">
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value)
                    setEffort('')
                  }}
                >
                  <option value="">Auto — the CLI’s own default</option>
                  {forAdapter.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
                {efforts.length > 0 && (
                  <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                    <option value="">Auto — the model’s own default</option>
                    {efforts.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              // ⛔ A sentence, not a greyed-out select. The list is genuinely not knowable yet, and a
              // dead control here would read as a choice being withheld rather than as one whose
              // precondition is sitting immediately above it.
              <span className="form-fixed">whatever the account that takes it runs by default</span>
            )}
            <span className="form-hint">
              {forAdapter
                ? 'Only models this account’s cost model can price are offered — one it cannot price ' +
                  'is one that cannot be gated, estimated for, or reasoned about the context window of.'
                : 'Pin a worker above to choose. A model list belongs to one CLI, so there is nothing ' +
                  'to offer until an account is chosen.'}
            </span>
          </div>
        </>
      )}

      {/*
        The ask itself, last and largest.

        ⚠️ A textarea, not the single-line input this used to be. What goes here is the prompt an
        agent receives verbatim, and a prompt worth writing usually has a second sentence in it; a
        field that swallowed Enter as "file this now" made the shape of the box a lie about what it
        would accept. Enter breaks the line, ⌘/Ctrl+Enter files — the same bargain every chat
        composer makes, and the same one the thread composer makes one screen away.
      */}
      <div className="ask">
        <textarea
          className="ask-input"
          rows={3}
          value={title}
          placeholder={
            plan
              ? 'Describe the outcome — the controller breaks it into drafts'
              : 'Describe the work as you would to a colleague'
          }
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim() && !saving) {
              void submit()
            }
          }}
        />
        <div className="ask-foot">
          <span className="ask-hint">
            {plan
              ? 'Turned into a handful of draft tasks with dependencies between them. Drafts dispatch ' +
                'nothing — you promote them one at a time, and each prompt is written then.'
              : 'Sent to the agent as written, after any handoff from an earlier run.'}
          </span>
          <button
            className="btn btn--primary"
            disabled={saving || !title.trim()}
            onClick={() => void submit()}
          >
            {saving ? 'Filing…' : plan ? 'File and decompose' : 'File task'}
          </button>
        </div>
      </div>
    </div>
  )
}
