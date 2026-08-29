import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FinishPolicy,
  FinishPolicyChoice,
  ResolvedFinishPolicy,
  Run,
  SessionSharing,
  SessionSharingChoice,
  ResolvedSessionSharing,
  Task,
  TaskMessage
} from '@shared/tasks'
import type { Session } from '@shared/protocol'
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { conversationIdFor } from '../lib/conversation'
import { showsLiveOutput } from '../lib/live'
import { duration, tokens, when } from '../lib/format'
import {
  assigneeLabel,
  elapsed,
  IN_FLIGHT,
  statusLabel,
  STATUS_TONE,
  Working,
  workspacePathFor
} from '../lib/taskview'

export interface TaskDetailData {
  task: Task
  messages: TaskMessage[]
  runs: Run[]
  sessions: Session[]
  activity: Array<{ text: string; ts: number }>
  /** How many tasks are held at `blocked` waiting on this one. Counted by the daemon. */
  blocking: number
  resolvedFinish?: ResolvedFinishPolicy
  resolvedSharing?: ResolvedSessionSharing
  inheritedFinish?: ResolvedFinishPolicy
  inheritedSharing?: ResolvedSessionSharing
}

/**
 * One task, as a place you can be.
 *
 * ⛔ **Its own route, not a pane under the table.** It used to render below the list, which meant a
 * project with forty tasks put the thing you had just clicked on below forty rows of the thing you
 * had clicked it from — and the more work a project had, the further the reading was pushed off
 * screen. Being a route also makes the selection survivable: Back returns here, and a task being
 * re-sorted or filtered out of the list cannot move you off the task you are reading.
 *
 * ⚠️ This fetches its own data. Nothing is passed in but an id, so the same component serves a task
 * inside a project and one belonging to no project at all.
 */
export function TaskThread({
  taskId,
  fleet,
  onBack,
  backLabel = 'Tasks'
}: {
  taskId: string
  /** Only so a worker id can be drawn as the name of an account. */
  fleet: FleetEntry[]
  onBack: () => void
  backLabel?: string
}): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [missing, setMissing] = useState(false)
  const { activity, seed } = useActivity()
  const now = useNow(1000)

  const refresh = useCallback(async () => {
    const got = await rpc('task.get', { id: taskId })
    if (!got) {
      setMissing(true)
      return
    }
    setDetail(got)
    // Seed the tail once from whatever the daemon is holding, so opening a task that is already
    // running does not start from a blank pane. Events take over from here.
    seed(got.task.id, got.activity)
  }, [taskId, seed])

  useEffect(() => {
    setDetail(null)
    setMissing(false)
    void refresh()
  }, [refresh])

  useDaemonEvents((event) => {
    // ⚠️ Narrowed to this task. The pane used to re-fetch on every `task.changed` the fleet emitted,
    // which on a busy fleet is a fetch a second for a task nothing is happening to.
    if (event.type === 'task.changed' && event.task.id === taskId) void refresh()
    if (event.type === 'run.changed' && event.run.taskId === taskId) void refresh()
  })

  const back = (
    <button className="btn btn--ghost back-to-list" onClick={onBack} title={`Back to ${backLabel}`}>
      ← {backLabel}
    </button>
  )

  if (missing) {
    return (
      <div className="empty-inline">
        {back}
        <p>That task is no longer here.</p>
        <p className="dim">It may have been deleted since this pane was opened.</p>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="empty-inline">
        {back}
        <p className="dim">Loading…</p>
      </div>
    )
  }

  return (
    <TaskDetail
      detail={detail}
      activity={activity[detail.task.id] ?? []}
      fleet={fleet}
      blocking={detail.blocking}
      now={now}
      refresh={refresh}
      back={back}
    />
  )
}

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
  blocking,
  now,
  refresh,
  back
}: {
  detail: TaskDetailData
  /** The live tail, kept outside the detail so it survives a re-fetch of it. */
  activity: Array<{ text: string; ts: number }>
  fleet: FleetEntry[]
  /** How many tasks are waiting on this one — the concrete consequence of finishing it or not. */
  blocking: number
  now: number
  refresh: () => Promise<void>
  /** The way back to the list. Passed in, because what "back" means depends on where you came from. */
  back: React.ReactNode
}): React.JSX.Element {
  const { task, messages, runs, sessions } = detail
  const live = showsLiveOutput(task.status)
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
  const workspace = workspacePathFor(runs, sessions)

  return (
    <section className="detail">
      {/* ⛔ The way out comes first, above the title. A screen you navigate *to* needs its exit
          where the eye starts, not below a thread that can be a hundred messages long. */}
      <header className="detail-head">
        {back}
        <h3>
          t{task.seq} · {task.title}
        </h3>
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          <Thread messages={messages} activity={activity} live={live} />

          {/* ⛔ Here, with the composer, and not in the ledger on the right. All three answers to
              "a decision is wanted from you" are the same kind of thing — finish it, park it, or say
              what you want next — and two of them living in a column of read-only facts made the
              third look like the only one. */}
          {task.status === 'awaiting_human' && (
            <Decide task={task} blocking={blocking} onResolve={resolve} onStop={cancel} />
          )}
          <Compose task={task} refresh={refresh} />
        </div>

        <aside className="detail-side">
          <Fact label="status">
            <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>
              {statusLabel(task)}
              {IN_FLIGHT.has(task.status) && <Working />}
            </span>
          </Fact>
          {task.holdReason && (
            <Fact label={task.status === 'awaiting_human' ? 'wants' : 'waiting on'}>
              {task.holdReason}
            </Fact>
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
          {/* ⛔ Settable while the task is running, and settable after it has finished — which is
              the point. Switching a task resting in `awaiting_human` to a landing policy *is* the
              decision to land it, and the same bar a first completion faced is applied again. */}
          <Fact label="finish">
            <FinishPicker
              task={task}
              inheritedFinish={detail.inheritedFinish}
              onChanged={refresh}
            />
          </Fact>
          {/* ⚠️ Next to `finish` because they are the same shape of decision — three tiers, `inherit`
              a real value, changeable at any time — and an operator who has learnt one has learnt
              the other. ⛔ Unlike `finish`, this one only records: a task already talking in a
              conversation is never moved out of it. */}
          <Fact label="conversation">
            <SharingPicker
              task={task}
              inheritedSharing={detail.inheritedSharing}
              onChanged={refresh}
            />
          </Fact>
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
          {workspace && (
            <Fact label="workspace">
              <span className="mono" title={workspace}>
                {workspace}
              </span>
            </Fact>
          )}
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
                <RunRow key={run.id} run={run} sessions={sessions} fleet={fleet} now={now} />
              ))}
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}

/**
 * Everything said on this task, and what is being said right now, in one place.
 *
 * ⛔ **The live output is inside the thread, not below it.** It used to be its own bordered pane
 * under the messages, on the argument that a window onto a running process is not part of the
 * record and mixing the two would make the record unreadable. The argument was right about the data
 * and wrong about the reading: what an agent is saying *now* is the continuation of what it said a
 * minute ago, and putting them in two boxes meant following one conversation by moving your eyes
 * between two of them — while the composer for replying sat below both, further from the words it
 * was answering.
 *
 * ⚠️ It is still **not stored**. The live bubble is replaced by the agent's real message when the
 * run ends; nothing here is written to `task_messages`. Marked as live for exactly that reason —
 * text that will be replaced must not look like text that has been kept.
 */
function Thread({
  messages,
  activity,
  live
}: {
  messages: TaskMessage[]
  activity: Array<{ text: string; ts: number }>
  live: boolean
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  /**
   * Whether the view is following the conversation.
   *
   * ⛔ Not a scroll-to-bottom on every change. This is agent output arriving as fast as a model can
   * produce it, and yanking the viewport down while somebody is reading something further up is the
   * one behaviour that makes a live pane useless — they scroll up, it throws them back, and they
   * stop trying. Following is the default and stops the moment they take control.
   */
  const pinned = useRef(true)

  const onScroll = (): void => {
    const el = box.current
    if (!el) return
    // ⚠️ A tolerance, not equality. Sub-pixel scroll heights and a zoomed display both make an
    // exactly-at-the-bottom test fail while the view plainly is at the bottom.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const last = activity.length > 0 ? activity[activity.length - 1]?.ts : null
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages.length, last, live])

  /**
   * ⛔ **`live` alone.** This was `live || activity.length > 0`, and the tail is not cleared when a
   * run ends — only when the *next* attempt starts, via `reset`. So a completed task went on drawing
   * a bubble captioned "replaced when the run ends" beside a status reading `completed`, forever.
   * The tail is a window onto a running process; when nothing is running there is nothing to look
   * through, and what the agent actually recorded is already in the messages above.
   */
  const showLive = live

  return (
    <div className="thread thread--task" ref={box} onScroll={onScroll}>
      {messages.length === 0 && !showLive && (
        <p className="dim">Nothing has been said on this task yet.</p>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`msg msg--${m.role}`}>
          <span className="msg-role">
            {m.role}
            {/* ⛔ On every message. A thread with no clock cannot answer "did the agent reply to
                that, or was it already saying this?" — and on a task that ran over two days, which
                is ordinary here, it cannot even say which day. The exact moment is in the title,
                because the column has room for a short form and not for both. */}
            <span className="msg-when" title={new Date(m.ts).toLocaleString()}>
              {when(m.ts)}
            </span>
          </span>
          <span className="msg-text">{m.text}</span>
        </div>
      ))}

      {showLive && (
        <div className="msg msg--agent msg--live">
          {/* ⚠️ No dots here. They belong at the end of the text, where the sentence stops — that
              is where a reader is looking when they want to know whether more is coming. */}
          <span className="msg-role">agent</span>
          <span className="msg-text">
            {activity.length === 0 ? (
              <span className="dim">waiting for the agent’s first words…</span>
            ) : (
              activity.map((line, i) => (
                <span key={`${line.ts}-${i}`} className="msg-live-line">
                  {line.text}
                </span>
              ))
            )}
            {/* ⛔ An animation, not a sentence. "live — replaced by what the agent records when
                the run ends" was a caption explaining a mechanism nobody had asked about, and it
                sat there looking like part of the transcript. Three pulsing dots at the point the
                text stops say the one thing a reader wants — *more is coming* — and stop saying it
                the instant it is no longer true. */}
            <Working />
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The two ways to settle a task that is waiting on a person, each next to what it actually does.
 *
 * ⛔ They were indistinguishable, and the tooltips were the reason: *"records that you are
 * satisfied"* and *"stops here and rests the task"* are two ways of saying **it stops**. The
 * difference is not in how it feels, it is in the DAG. `admit()` unblocks a dependent only when its
 * dependency reaches `completed`, so **Mark done releases everything waiting on this task and Stop
 * here does not** — and with nothing on screen saying so, the choice looked like a matter of taste
 * while it was quietly the difference between the rest of a plan running and not.
 *
 * ⚠️ The count is drawn, not implied. "2 tasks start" is a fact somebody can check; "unblocks
 * dependents" is a sentence they have to take on trust and cannot see the scope of.
 */
function Decide({
  task,
  blocking,
  onResolve,
  onStop
}: {
  task: Task
  blocking: number
  onResolve: () => Promise<void>
  onStop: () => Promise<void>
}): React.JSX.Element {
  // ⚠️ Both numbers agree with their verb. "The 2 tasks waiting on it stays blocked" is the kind of
  // sentence somebody stops reading, and this one is load-bearing.
  const releases =
    blocking === 0
      ? 'Nothing is waiting on this one, so it just comes to rest as done.'
      : blocking === 1
        ? 'Releases the one task waiting on it — it becomes ready and can be dispatched.'
        : `Releases the ${blocking} tasks waiting on it — they become ready and can be dispatched.`
  const holds =
    blocking === 0
      ? 'Nothing is waiting on it either way.'
      : blocking === 1
        ? 'The one task waiting on it stays blocked — only a completed task releases it.'
        : `The ${blocking} tasks waiting on it stay blocked — only a completed task releases them.`

  return (
    <div className="decide">
      <div className="decide-head">
        <span>your call</span>
        {/* The reason it stopped, where the answer is given rather than only in the ledger. */}
        {task.holdReason && <span className="decide-why">{task.holdReason}</span>}
      </div>

      <div className="decide-option">
        <button
          className="btn btn--ok"
          title="Records your judgement that this is finished. ⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished."
          onClick={() => void onResolve()}
        >
          Mark done
        </button>
        <span className="decide-what">
          <strong>Finished.</strong> {releases} ⚠️ Your judgement, written into the thread as such —
          nothing here checked the work.
        </span>
      </div>

      <div className="decide-option">
        <button
          className="btn btn--danger"
          title="Parks the task. Destroys nothing, and Resume picks it up where it stopped."
          onClick={() => void onStop()}
        >
          Stop here
        </button>
        <span className="decide-what">
          <strong>Not finished.</strong> Parks it as <span className="mono">paused_user</span>, which
          Resume picks back up. {holds} The branch and the workspace are kept.
        </span>
      </div>

      <p className="decide-hint">
        Or say what you want next in the box below — neither of these, but another run on this same
        thread, preferring the session that still holds its context.
      </p>
    </div>
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
 * Which conversation this task is in, and whether the latest run had to build it.
 *
 * ⛔ **This used to infer reuse from the clock** - `session.startedAt < run.startedAt` - on the
 * argument that nothing needed to record the intent because a recorded intent could disagree with
 * what happened. It disagreed with what happened. `spawnSession` inserts its row before `startRun`
 * inserts the run's, so a brand-new session is *always* older than its own first run by a
 * millisecond or two: measured against this install 2026-08-28, the heuristic rendered **"reused,
 * context kept" on 19 of 20 runs**, every one of which was a cold start. It reported the exact
 * inverse of the truth, on the one number an operator would use to judge what a task cost.
 *
 * ⚠️ `startedWarm` is now written at dispatch by the code that made the choice. Null means the run
 * predates the column, and null renders as **nothing** rather than as a guess.
 */
function SessionFact({ runs, sessions }: { runs: Run[]; sessions: Session[] }): React.JSX.Element {
  const run = runs[0]
  if (!run) return <span className="dim">none yet</span>
  // ⚠️ Resolved by the same function the run rows use, so the id in the ledger and the id beside the
  // latest run cannot be two different strings.
  const conversation = conversationIdFor(run, sessions)
  if (!conversation) return <span className="dim">none yet</span>

  return (
    <>
      <span className="mono" title={`Conversation ${conversation}`}>
        {conversation.slice(0, 12)}
      </span>{' '}
      {run.startedWarm === null ? null : run.startedWarm ? (
        <span
          className="ok"
          title="This run inherited a conversation that already existed — continued in a live session, or resumed one that had closed. The prompt prefix was read, not rebuilt."
        >
          reused, context kept
        </span>
      ) : (
        <span
          className="dim"
          title="A new conversation, so the prompt prefix was built from nothing. Measured on this machine: 41,542 cache-creation tokens for a trivial prompt in an empty directory."
        >
          new conversation
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
  sessions,
  fleet,
  now
}: {
  run: Run
  /** Every session any run of this task used, so this run's can be named rather than guessed at. */
  sessions: Session[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const worker = fleet.find((f) => f.worker.id === run.workerId)?.worker.label
  const spent = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="mono" title={`Run ${run.id}`}>
          {run.id.slice(0, 8)}
        </span>
        {/* ⛔ Nothing at all when `startedWarm` is null. Runs that predate the column recorded no
            answer, and drawing `new` for those would put a measurement nobody took next to one
            that was taken. */}
        {run.startedWarm !== null && (
          <span
            className={run.startedWarm ? 'ok' : 'dim'}
            title={
              run.startedWarm
                ? 'This run inherited a conversation that already existed — continued in a live ' +
                  'session, or resumed one that had closed. It did not rebuild the context first.'
                : 'This run opened a new conversation and built its context from nothing.'
            }
          >
            {run.startedWarm ? 'warm' : 'new'}
          </span>
        )}
        <span className={run.outcome === 'completed' ? 'ok' : run.outcome ? 'warn' : 'state-running'}>
          {run.outcome ?? 'running'}
        </span>
        <span className="num dim">{duration((run.endedAt ?? now) - run.startedAt)}</span>
      </div>
      {/* ⛔ Per run, not only on the task. A task that ran three times can have run in three
          different conversations — that is the whole point of resuming and sharing — and the ledger
          above shows only the latest. Which conversation *this* attempt was served by is the fact
          that explains why it cost what it cost. */}
      <ConversationId run={run} sessions={sessions} />
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
 * Which conversation served this run, as the string you would actually type.
 *
 * ⛔ **The vendor's id where the CLI named its own conversation, ours where it took ours.** This is
 * what goes after `--resume` or `--conversation`, so it has to be the real one rather than whichever
 * we happen to file the row under — an id that looks right and resumes nothing is worse than no id.
 *
 * ⚠️ A run with no session shows nothing rather than a dash with a tooltip: dispatch can fail before
 * anything is spawned, and that run genuinely was not served by a conversation. A session row that
 * has since gone falls back to the session id, which is what `--session-id` was given.
 */
function ConversationId({ run, sessions }: { run: Run; sessions: Session[] }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const id = conversationIdFor(run, sessions)
  if (!id) return null

  const copy = (): void => {
    void navigator.clipboard
      .writeText(id)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      // ⚠️ Silent. A clipboard permission this window does not have is not something to interrupt
      // somebody reading a ledger about, and the id is on screen either way.
      .catch(() => undefined)
  }

  return (
    <div className="side-run-conv">
      <button
        className="conv-id mono"
        onClick={copy}
        title={`Conversation ${id} — click to copy. This is the id to pass after --resume or --conversation.`}
      >
        {copied ? 'copied' : id.slice(0, 12)}
      </button>
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
 * What happens to this task's work when it is done.
 *
 * ⚠️ Three tiers resolve into one answer — task, then project, then fleet — and `inherit` is a real
 * value rather than a blank. A task set to inherit follows its project as the project changes; one
 * set explicitly to the same value does not, and a control that could not express the difference
 * would quietly convert every glance at this dropdown into a decision.
 *
 * ⛔ The answer from the daemon is what lands in state, never the value that was clicked — and here
 * that matters twice over, because choosing a landing policy on a finished task also *lands* it, and
 * the attempt can be refused. A dropdown that painted itself green while the push was rejected would
 * be the worst kind of lie this app could tell.
 */
const FINISH_LABELS: Record<FinishPolicy, string> = {
  'await-human': 'await human',
  'agent-lands': 'agent lands it',
  'pull-request': 'open a pull request',
  'custom': 'this project’s own policy'
}

const SHARING_LABELS: Record<SessionSharing, string> = {
  on: 'reuse one if possible',
  off: 'always start a new one'
}

function FinishPicker({
  task,
  inheritedFinish,
  onChanged
}: {
  task: Task
  inheritedFinish?: ResolvedFinishPolicy
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const choose = async (finishPolicy: FinishPolicyChoice): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await rpc('task.setFinishPolicy', { id: task.id, finishPolicy })
      setNote(
        result.landed
          ? 'landed'
          : result.reason
            ? `not landed — ${result.reason}`
            : null
      )
      if (onChanged) await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inheritedLabel = inheritedFinish?.policy
    ? FINISH_LABELS[inheritedFinish.policy] ?? inheritedFinish.policy
    : 'agent lands it'

  return (
    <>
      <select
        className="finish-picker"
        value={task.finishPolicy}
        disabled={busy}
        aria-label="Finish policy"
        onChange={(e) => void choose(e.target.value as FinishPolicyChoice)}
      >
        <option value="inherit">inherit ({inheritedLabel})</option>
        <option value="await-human">await human</option>
        <option value="agent-lands">agent lands it</option>
        <option value="pull-request">open a pull request</option>
        <option value="custom">this project&rsquo;s own policy</option>
      </select>
      {note && <div className="note">{note}</div>}
    </>
  )
}

/**
 * Whether this task may borrow a conversation somebody else has been having.
 *
 * ⛔ Records a preference and nothing more. `FinishPicker` beside it also *acts* — switching a
 * finished task to a landing policy lands it — and the asymmetry is deliberate rather than an
 * omission: acting on this one would mean moving a running agent out of the conversation it is
 * mid-thought in, which is the single thing sharing must never do. It applies from the next run.
 *
 * ⚠️ The saving is real and measured, and so is the disclosure. An agent joining a conversation sees
 * everything said in it, which is why this is off until somebody says otherwise and why the tooltip
 * says so rather than describing only the upside.
 */
function SharingPicker({
  task,
  inheritedSharing,
  onChanged
}: {
  task: Task
  inheritedSharing?: ResolvedSessionSharing
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const choose = async (sessionSharing: SessionSharingChoice): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('task.setSessionSharing', { id: task.id, sessionSharing })
      if (onChanged) await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inheritedLabel = inheritedSharing?.sharing
    ? SHARING_LABELS[inheritedSharing.sharing] ?? inheritedSharing.sharing
    : 'always start a new one'

  return (
    <>
      <select
        className="finish-picker"
        value={task.sessionSharing}
        disabled={busy}
        aria-label="Session sharing"
        title={
          'Whether this task may continue in a conversation another task in this project has ' +
          'already been having. Cheaper — a cold start rebuilt 41,542 tokens of prefix that a ' +
          'reused one read back for 65 — but the agent sees everything said in that conversation.'
        }
        onChange={(e) => void choose(e.target.value as SessionSharingChoice)}
      >
        <option value="inherit">inherit ({inheritedLabel})</option>
        <option value="on">reuse one if possible</option>
        <option value="off">always start a new one</option>
      </select>
      {note && <div className="note">{note}</div>}
    </>
  )
}
