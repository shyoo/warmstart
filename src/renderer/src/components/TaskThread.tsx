import { sessionEnded } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  type FinishPolicy,
  resolveModelChoice,
  AUTO_COMPACT_LABELS,
  COMPLETION_LABELS,
  OBJECTIVE_PRESET_ORDER,
  SHARING_LABELS,
  presetOf,
  type AutoCompactChoice,
  type Compaction,
  type CompletionModeChoice,
  type FinishPolicyChoice,
  type Attachment,
  type Objective,
  type PendingWork,
  type ObjectiveChoice,
  type ResolvedAutoCompact,
  type ResolvedCompletionMode,
  type ResolvedFinishPolicy,
  type ResolvedSessionSharing,
  type Run,
  type SessionSharingChoice,
  type Task,
  type TaskMessage
} from '@shared/tasks'
import type { ModelOptions, Session } from '@shared/protocol'
import {
  RUBRIC_DIMENSIONS,
  rubricFor,
  type QualityReview
} from '@shared/review'
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { ImageChips, usePastedImages } from '../lib/pasteimages'
import { conversationIdFor } from '../lib/conversation'
import { SettingButtonSelect, type SettingOption } from './SettingButtonSelect'
import { TaskQuestions } from './Questions'
import { AddDependency, candidatesFor, DependencyList, useTaskCandidates } from './Dependencies'
import { showsLiveOutput } from '../lib/live'
import { duration, quotaWindowDeltas, timeRange, tokens, when } from '../lib/format'
import { Money, runPriceTitle, taskPriceTitle } from './Price'
import { effortLabel, modelLabel } from '../lib/modelname'
import {
  activeTime,
  activeTimeTitle,
  CANCELLABLE,
  canRelandTask,
  chronologicalTimeline,
  kindLabel,
  pieceSettings,
  elapsed,
  holdLine,
  isChecksFailedTask,
  isConflictedTask,
  isTrunkMovedTask,
  isUncommittedTask,
  isWorking,
  modelFacts,
  reassignmentModel,
  statusLabel,
  STATUS_TONE,
  STOPPABLE,
  taskLabel,
  Working,
  workspacePathFor
} from '../lib/taskview'

export interface TaskDetailData {
  task: Task
  messages: TaskMessage[]
  runs: Run[]
  sessions: Session[]
  /** Optional so a cached detail from a previous build renders rather than crashing. */
  compactions?: Compaction[]
  /** Every quality review of this task, newest first. Optional for the same reason as above. */
  reviews?: QualityReview[]
  activity: Array<{ text: string; ts: number }>
  /** How many tasks are held at `blocked` waiting on this one. Counted by the daemon. */
  blocking: number
  dependencies?: Task[]
  dependents?: Task[]
  /** The task that filed this one — a Plan & Split planner, for a piece of a split. */
  parent?: Task | null
  /** The pieces this task filed, for a planner. Ordered as filed, failures included. */
  children?: Task[]
  resolvedFinish?: ResolvedFinishPolicy
  resolvedSharing?: ResolvedSessionSharing
  inheritedFinish?: ResolvedFinishPolicy
  inheritedSharing?: ResolvedSessionSharing
  inheritedCompletion?: ResolvedCompletionMode
  inheritedAutoCompact?: ResolvedAutoCompact
  /** Whether the adapter this task would run on can be asked to compact. A capability, not a choice. */
  compactionCapable?: boolean
  inheritedObjective?: Objective
  resolvedObjective?: Objective
  previewPrompt?: string
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
  backLabel = 'Tasks',
  onOpenTask
}: {
  taskId: string
  /** Only so a worker id can be drawn as the name of an account. */
  fleet: FleetEntry[]
  onBack: () => void
  backLabel?: string
  onOpenTask?: (taskId: string) => void
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
      onOpenTask={onOpenTask}
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
/**
 * What this task is actually running on.
 *
 * ⛔ **Two facts, and which one leads is the whole point.** What the transcript says answered each
 * turn is a measurement; what a dispatch starting now would ask for is a prediction. `modelFacts`
 * decides between them — see the note there for why leading with the prediction made this row
 * contradict the run list beneath it — and this draws the answer.
 */
function ModelFact({
  session,
  ran,
  requested
}: {
  session: Session | null
  ran: string | null
  requested: { model: string | null; effort: string | null; source: string }
}): React.JSX.Element {
  const { headline, note } = modelFacts({
    observed: session ? { model: session.model ?? null, effort: session.effort ?? null } : null,
    ran,
    requested
  })
  return (
    <>
      <span title={headline.title}>{headline.text}</span>
      {note && (
        <div className={`tbl-sub ${note.tone}`} title={note.title}>
          {note.text}
        </div>
      )}
    </>
  )
}

/**
 * What changing the model or the effort costs, said before it is changed.
 *
 * ⛔ Prompt caches are **model-scoped**, so switching model does not degrade the cache — it leaves it
 * behind entirely, and the next turn rebuilds the whole prefix. Effort is cheaper and not free: it
 * invalidates the message history on every model, and on some it takes the tools and system caches
 * with it. Anthropic publishes both as a hierarchy; this is the two rows that apply here.
 *
 * ⚠️ Priced in this repo's own units — a warm read is 0.1·C and a cold rebuild 2.0·C (§1) — rather
 * than in dollars, because the fleet runs on subscriptions where the marginal dollar is not the
 * currency that runs out. The window is.
 *
 * ⭐ Only ever shown when there is a live conversation with context in it. A task that has not run,
 * or whose session is closed, loses nothing by being re-pointed, and warning there would train the
 * operator to dismiss the warning that matters.
 */
function CacheCost({
  session,
  changing
}: {
  session: Session | null
  changing: 'model' | 'effort'
}): React.JSX.Element | null {
  const held = session?.contextTokens ?? 0
  if (!session || held <= 0) return null

  return (
    <div className="warn tbl-sub">
      {changing === 'model' ? (
        <>
          This conversation holds {tokens(held)} of cached context. Prompt caches belong to one model,
          so switching discards all of it — the next turn rebuilds the prefix at 2.0·C instead of
          reading it at 0.1·C.
        </>
      ) : (
        <>
          Changing effort invalidates this conversation’s {tokens(held)} of message cache. Cheaper
          than a model switch, which also discards the tools and system prefix — but not free.
        </>
      )}{' '}
      Applies to the next run; this session keeps what it started with.
    </div>
  )
}

function TaskDetail({
  detail,
  activity,
  fleet,
  blocking,
  now,
  refresh,
  back,
  onOpenTask
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
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  const {
    task,
    messages,
    runs,
    sessions,
    compactions = [],
    dependencies = [],
    dependents = [],
    parent = null,
    children = [],
    reviews = []
  } = detail
  const timeline = chronologicalTimeline(runs, compactions, reviews)
  // ⛔ Served, never compiled in — the renderer holds no cost models, and the capability flags that
  // decide whether an effort control exists at all live with the adapter, not here.
  const [modelOptions, setModelOptions] = useState<ModelOptions[]>([])
  useEffect(() => {
    void rpc('model.options')
      .then(setModelOptions)
      .catch(() => setModelOptions([]))
  }, [])
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
    (s) => s.id === runs[0]?.sessionId && !sessionEnded(s.state)
  )
  const workspace = workspacePathFor(runs, sessions)
  // ⚠️ Empty for everything that is not a Plan & Split task, which is what keeps the ledger the same
  // shape it has always been for an ordinary one.
  const pieces = pieceSettings(task, fleet)

  /**
   * What the *next* dispatch would ask for: the task's own pin, else the account's default, else the
   * CLI's choice — resolved by the same function the scheduler calls, so this cannot promise an
   * inheritance the dispatch does not perform.
   *
   * ⚠️ `selectableEffort` decides whether an effort is even part of the answer. On Antigravity it is
   * false and the effort is dropped at dispatch, so showing one here would describe a flag that is
   * never sent — and that the CLI would refuse if it were.
   */
  const assigned =
    fleet.find((e) => e.worker.id === (task.constraints.workerId || task.assignee))?.worker ?? null
  const canSetEffort =
    modelOptions.find((o) => o.adapterId === assigned?.adapterId)?.selectableEffort ?? false
  // ⛔ With the account's own quota reading, because that is what the dispatch resolves against. A
  // worker with more than one model pool picks the emptier one at spawn time (`resolveModelChoice`),
  // so predicting without the reading here does not predict the same model the scheduler will run —
  // it silently returns the first pool's default and the ledger disagrees with its own run list.
  const resolved = resolveModelChoice(
    task.constraints,
    assigned,
    canSetEffort,
    fleet.find((e) => e.worker.id === assigned?.id)?.quota
  )
  const offered = modelOptions.find((o) => o.adapterId === assigned?.adapterId)?.models ?? []
  // Effort needs both halves: a CLI that takes the flag, and a chosen model that has levels.
  const taskEfforts = canSetEffort
    ? (offered.find((m) => m.id === (resolved.model ?? ''))?.effortLevels ?? [])
    : []
  const requestedModel = {
    model: resolved.model,
    effort: resolved.effort,
    source:
      resolved.modelSource === 'task'
        ? 'pinned on this task'
        : resolved.modelSource === 'worker'
          ? `this account’s default${assigned ? ` (${assigned.label})` : ''}`
          : 'no model chosen — the CLI picks'
  }

  return (
    <section className="detail">
      {/* ⛔ The way out comes first, above the title. A screen you navigate *to* needs its exit
          where the eye starts, not below a thread that can be a hundred messages long. */}
      <header className="detail-head">
        {back}
        {/* ⚠️ The label, not the prompt. The prompt is a paragraph and this is a page heading —
            and it is not lost by being summarised here: the first entry in the thread below is
            the full text, verbatim, which is what the agent was actually given. */}
        <h3 title={task.title}>
          t{task.seq} · {taskLabel(task)}
        </h3>
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {task.status === 'draft' && (
            <DraftControls
              task={task}
              initialPrompt={messages[0]?.text ?? task.title}
              previewPrompt={detail.previewPrompt}
              onPromote={async () => {
                await rpc('task.promote', { id: task.id })
                await refresh()
              }}
              onUpdate={async (title, prompt) => {
                await rpc('task.update', { id: task.id, title, prompt })
                await refresh()
              }}
            />
          )}

          {task.status === 'blocked' && (
            <div className="blocked-banner">
              <div className="blocked-banner-header">
                <span className="blocked-banner-title">
                  Blocked by {dependencies.length > 0 ? `${dependencies.length} prerequisite ${dependencies.length === 1 ? 'task' : 'tasks'}` : 'unmet dependencies'}
                </span>
                <span className="dim">Admitted automatically when prerequisites complete</span>
              </div>
              {dependencies.length > 0 && (
                <div className="blocked-banner-deps">
                  {dependencies.map((dep) => (
                    <button
                      key={dep.id}
                      type="button"
                      className="dep-link"
                      onClick={() => onOpenTask?.(dep.id)}
                      title={`Open t${dep.seq}: ${dep.title} (${statusLabel(dep)})`}
                    >
                      <span className="dep-seq">t{dep.seq}</span>
                      <span className="dep-title">{taskLabel(dep)}</span>
                      <span className={`status ${STATUS_TONE[dep.status] ?? ''}`}>
                        {statusLabel(dep)}
                        {isWorking(dep) && <Working />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Thread messages={messages} runs={runs} activity={activity} live={live} />

          {/* ⛔ Between the conversation and the box for replying, because that is what it is: the
              agent's turn to speak ended with a question, and this is where the answer goes. In the
              ledger on the right it would read as a fact about the task rather than a prompt. */}
          <TaskQuestions taskId={task.id} taskStatus={task.status} />

          {detail.previewPrompt && task.status !== 'draft' && task.status !== 'running' && (
            <div className="thread-preview-prompt">
              <PromptDisclosure
                prompt={detail.previewPrompt}
                label="Prompt to be sent on next dispatch"
              />
            </div>
          )}

          {task.status === 'paused_quota' && (
            <PausedQuotaBanner
              task={task}
              fleet={fleet}
              modelOptions={modelOptions}
              now={now}
              onRefresh={refresh}
            />
          )}

          {task.status === 'paused_user' && (
            <div className="paused-banner">
              <div className="paused-banner-header">
                <span className="paused-banner-title">Paused by operator</span>
                <span className="dim">
                  Work and context are preserved. Click Resume to put this task back in the queue.
                </span>
              </div>
              <div className="paused-banner-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    void (async () => {
                      await rpc('task.resume', { id: task.id })
                      await refresh()
                    })()
                  }}
                >
                  Resume
                </button>
              </div>
            </div>
          )}

          {/* ⛔ Here, with the composer, and not in the ledger on the right. All three answers to
              "a decision is wanted from you" are the same kind of thing — finish it, park it, or say
              what you want next — and two of them living in a column of read-only facts made the
              third look like the only one. */}
          {task.status === 'awaiting_human' && (
            <Decide
              task={task}
              blocking={blocking}
              fleet={fleet}
              modelOptions={modelOptions}
              onResolve={resolve}
              onStop={cancel}
              onRefresh={refresh}
            />
          )}
          {task.status !== 'draft' && <Compose task={task} refresh={refresh} onStop={cancel} />}
        </div>

        <aside className="detail-side">
          <div className="detail-side-box">
            <Fact label="status">
              <span className={`status ${STATUS_TONE[task.gradingWorkerId ? 'grading' : task.status] ?? ''}`}>
                {statusLabel(task)}
                {isWorking(task) && <Working />}
              </span>
              {/* ⛔ `awaiting_human` excluded — that status already offers Stop via `Decide`,
                  alongside the other resolutions a human can make, so this would be a second
                  button doing the same thing. */}
              {CANCELLABLE.has(task.status) && task.status !== 'awaiting_human' && (
                <button
                  type="button"
                  className="btn btn--danger btn--ghost"
                  title="Stop the work and return this task to a resting state. Destroys nothing."
                  onClick={() => void cancel()}
                >
                  Stop
                </button>
              )}
            </Fact>
            {holdLine(task, now) && (
              <Fact label={task.status === 'awaiting_human' ? 'wants' : 'waiting on'}>
                {holdLine(task, now)}
              </Fact>
            )}
            {/* ⛔ Offered only where the hold is one this fleet invented. See `QuotaOverride`. */}
            <QuotaOverride task={task} onChanged={refresh} />
            {/* ⛔ **The first thing the ledger says, because it changes what everything below it
                means.** A Plan & Split task is run twice, files subtasks, waits on them and lands
                onto its own branch; an ordinary task does none of that. The two pages were
                indistinguishable, so an operator checking a plan's settings was reading a pane that
                never said which kind of task they were looking at. */}
            <Fact label="type">
              <span
                title={
                  task.kind === 'plan'
                    ? 'An agent plans this with you, files the pieces for your approval, waits for ' +
                      'every one of them to settle, and comes back to review the result as a whole.'
                    : 'One thread of work, dispatched to an agent.'
                }
              >
                {kindLabel(task)}
              </span>
            </Fact>

            {/* ⛔ Lineage, and it is not a dependency. A piece of a plan does *not* depend on its
                planner — the edge points the other way — so neither list below can name it, and a
                subtask's page could say which branch it merged into without ever saying whose plan
                it belonged to. */}
            {parent && (
              <Fact label="parent">
                <button
                  type="button"
                  className="dep-link"
                  onClick={() => onOpenTask?.(parent.id)}
                  title={`Open t${parent.seq}: ${parent.title} (${statusLabel(parent)})`}
                >
                  <span className="dep-seq">t{parent.seq}</span>
                  <span className="dep-title">{taskLabel(parent)}</span>
                  <span className={`status ${STATUS_TONE[parent.status] ?? ''}`}>
                    {statusLabel(parent)}
                    {isWorking(parent) && <Working />}
                  </span>
                </button>
              </Fact>
            )}

            {/* The pieces of this plan, with how each one turned out. ⚠️ The whole set, failures
                included: the resolution turn exists to deal with those, so hiding them would
                describe a different task. */}
            {children.length > 0 && (
              <Fact label="pieces">
                <DependencyList tasks={children} fallbackCount={0} onOpenTask={onOpenTask} />
              </Fact>
            )}

            {/* ⛔ What each piece is filed with, read from the same two fields the daemon resolves.
                The operator sets these on the composer's Pieces row and had nowhere to check them
                afterwards — which is how a split ran on accounts nobody chose without anybody being
                able to see that it had. */}
            {pieces.length > 0 && (
              <Fact label="each piece">
                <span className="piece-settings">
                  {pieces.map((row) => (
                    <span key={row.label} className="piece-setting">
                      <span className="piece-setting-label">{row.label}</span>
                      <span className="piece-setting-value">{row.value}</span>
                    </span>
                  ))}
                </span>
              </Fact>
            )}

            <Fact label="depends on">
              <DependencyEditor
                task={task}
                dependencies={dependencies}
                onOpenTask={onOpenTask}
                onChanged={refresh}
              />
            </Fact>
            {(dependents.length > 0 || blocking > 0) && (
              <Fact label="blocks">
                <DependencyList
                  tasks={dependents}
                  fallbackCount={blocking}
                  onOpenTask={onOpenTask}
                />
              </Fact>
            )}
            <Fact label="worker">
              <WorkerPicker task={task} fleet={fleet} onChanged={refresh} />
            </Fact>

            {/* ⭐ The question this whole cost model exists to answer, and the one the UI could not.
                A worker id says which account paid; only the session says whether the run continued
                from a warm prefix at 0.1·C or rebuilt one at 2.0·C. */}
            <Fact label="session">
              <SessionFact runs={runs} sessions={sessions} />
            </Fact>

            {/* ⭐ Which model answered, and how hard it was told to think. Both were chosen, stored and
                metered since M3 and shown nowhere at all — the transcript knew and the operator did
                not. */}
            <Fact label="model">
              <ModelFact
                session={liveSession ?? null}
                ran={task.ranModel ?? runs[0]?.model ?? null}
                requested={requestedModel}
              />
              {/* ⚠️ Only where the account's CLI has models to offer. A fleet whose cost models failed
                  to load still runs work; it just cannot be re-pointed from here. */}
              {offered.length > 0 && (
                <SettingButtonSelect
                  style={{ marginTop: 'var(--sp-1)' }}
                  value={task.constraints.model ?? ''}
                  options={[
                    {
                      value: '',
                      label:
                        assigned?.defaultModels && Object.values(assigned.defaultModels).filter(Boolean).length > 1
                          ? 'account default (Auto-balance across pools)'
                          : assigned?.defaultModel
                            ? `account default (${modelLabel(assigned.defaultModel)})`
                            : 'CLI default'
                    },
                    ...offered.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
                  ]}
                  ariaLabel="Model"
                  title={
                    'Which model the next run uses. A conversation already open keeps the model it ' +
                    'started with — caches belong to one model, so switching mid-conversation throws ' +
                    'the cached context away.'
                  }
                  displayLabel={
                    !(task.constraints.model)
                      ? assigned?.defaultModels && Object.values(assigned.defaultModels).filter(Boolean).length > 1
                        ? 'Auto-balance across pools'
                        : assigned?.defaultModel
                          ? (modelLabel(assigned.defaultModel) ?? assigned.defaultModel)
                          : 'CLI default'
                      : undefined
                  }
                  onChange={(val) => {
                    void rpc('task.setModel', {
                      id: task.id,
                      model: val || null,
                      // ⛔ Cleared with the model. A level legal for the old model need not be legal
                      // for the new one, and the daemon refuses the pair rather than storing it.
                      effort: null
                    }).then(refresh)
                  }}
                />
              )}
              {taskEfforts.length > 0 && (
                <SettingButtonSelect
                  style={{ marginTop: 'var(--sp-1)' }}
                  value={task.constraints.effort ?? ''}
                  options={[
                    {
                      value: '',
                      label: assigned?.defaultEffort
                        ? `account default (${effortLabel(assigned.defaultEffort)})`
                        : 'CLI default'
                    },
                    ...taskEfforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))
                  ]}
                  ariaLabel="Effort"
                  title="How hard the model thinks on the next run."
                  displayLabel={
                    !(task.constraints.effort)
                      ? assigned?.defaultEffort
                        ? (effortLabel(assigned.defaultEffort) ?? assigned.defaultEffort)
                        : 'CLI default'
                      : undefined
                  }
                  onChange={(val) => {
                    void rpc('task.setModel', {
                      id: task.id,
                      model: task.constraints.model ?? null,
                      effort: val || null
                    }).then(refresh)
                  }}
                />
              )}
              <CacheCost session={liveSession ?? null} changing="model" />
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
            {/* ⛔ On a conversation these two are read-only facts, not pickers, because the kind is
                what answers them — `resolveFinishPolicy` and `resolveSessionSharing` read
                `await-human` and `on` off a conversation task above the project and the fleet. A
                dropdown here would offer a choice that is not on the table, and the one write that
                *is* allowed to change the finish policy is the Commit button, which is a decision
                about this commit rather than a setting. ⚠️ The finish fact still shows a real rung
                once Commit has written one — at that point it is the answer, and hiding it would
                hide what the landing is about to do. */}
            {task.kind === 'conversation' && task.finishPolicy === 'inherit' ? (
              <>
                <Fact label="finish">
                  <span title="A conversation rests after every turn and commits only when you press Commit. The project's own finish policy does not apply to it.">
                    await human — you decide, per turn
                  </span>
                </Fact>
                <Fact label="conversation">
                  <span title="A conversation reuses its own session between turns, which is what makes each reply warm. This is part of the kind, not a setting.">
                    {SHARING_LABELS.on} — kept between turns
                  </span>
                </Fact>
              </>
            ) : (
              <>
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
              </>
            )}
            {/* ⛔ Third of the same shape, and it belongs beside the other two: three tiers,
                `inherit` a real value, effective on the next run. ⚠️ It is not a care setting -
                an autonomous agent still stops to ask when a decision changes what it builds. */}
            <Fact label="completion">
              <CompletionPicker
                task={task}
                inheritedCompletion={detail.inheritedCompletion}
                onChanged={refresh}
              />
            </Fact>
            {/* ⛔ Beside the other three because it is the same shape of decision and the same
                promise: `inherit` is a real value, and the control records a preference rather than
                doing anything. ⚠️ Unlike the three above it does **not** wait for the next run —
                the cache clock re-reads it on its next tick, so switching a long-running task on
                can schedule a compaction into the conversation it is already having, within 10s,
                if the clock works out that one is worth its tokens. */}
            <Fact label="compaction">
              <CompactionPicker
                task={task}
                inheritedAutoCompact={detail.inheritedAutoCompact}
                capable={detail.compactionCapable}
                onChanged={refresh}
              />
            </Fact>
            <Fact label="objective">
              <ObjectivePicker
                task={task}
                inheritedObjective={detail.inheritedObjective}
                onChanged={refresh}
              />
            </Fact>
            <Fact label="priority">
              <PriorityPicker task={task} onChanged={refresh} />
            </Fact>
            <Fact label="filed">{when(task.createdAt)}</Fact>
            {task.status === 'scheduled' && task.notBefore && (
              <Fact label="scheduled">
                <span title={new Date(task.notBefore).toLocaleString()}>
                  {task.notBefore > now
                    ? `in ${duration(task.notBefore - now)} (${when(task.notBefore)})`
                    : when(task.notBefore)}
                </span>
              </Fact>
            )}
            {task.firstRunAt && <Fact label="started">{when(task.firstRunAt)}</Fact>}
            {/* ⛔ Two numbers, because they answer two questions and only one of them is about the
                agent. `took` is the time an agent was actually working — dispatch, routing and the
                CLI's start-up included, queueing and every minute spent waiting on you excluded.
                `elapsed` is the span the task existed inside, and the gap between them is exactly the
                time nobody was working. Showing only the second is what this pane used to do, and it
                is the reading that made per-agent durations useless. */}
            <Fact label="took">
              <span className="num" title={activeTimeTitle(task, now)}>
                {activeTime(task, now)} of agent time
              </span>
            </Fact>
            {task.firstRunAt && (
              <Fact label="elapsed">
                <span
                  className="num dim"
                  title={
                    'First dispatch to last stop, wall-clock. Larger than the agent time above by ' +
                    'however long this task spent queued, held, parked on a quota window, or waiting ' +
                    'for a person.'
                  }
                >
                  {elapsed(task, now)}
                </span>
              </Fact>
            )}
            {/* ⛔ Money over tokens, and the money first. The two are different measurements of
                the same work — the price is this task's share of the account's own window, the
                token count is metered from the agent's transcript — and docs/cost-model.md §5 is
                explicit that they are never reconciled. Both are shown; neither is derived from the
                other; the tooltip on each says which it is.

                ⚠️ **A row each, not a number with a footnote.** The token total used to hang under the
                price as a `price-sub` caption, which read as an annotation *of* the price — the one
                reading §5 forbids. Two labelled rows in the same ledger as every other fact say what
                they are on their own, and the label carries the unit so the value stays a number. */}
            <Fact label="price">
              <Money
                usd={task.budget.spentUsd}
                estimated={task.budget.spentUsdEstimated}
                partial={task.budget.spentUsdPartial}
                title={taskPriceTitle(task.budget)}
              />
            </Fact>
            <Fact label="tokens">
              <span
                className="num"
                title={
                  'Everything every run of this task has spent — input, output and cache, summed from ' +
                  'the agent’s own transcript. A total, so it only ever grows, and much larger than ' +
                  'the context above because every turn re-reads the whole window.'
                }
              >
                {tokens(task.budget.spentTokens || null)}
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
          </div>

          <QualityReviewBox task={task} reviews={reviews} refresh={refresh} />

          {timeline.length > 0 && (
            <div className="detail-side-box">
              {/* ⚠️ The label carries the distinction: attempts and context compactions in chronological order. */}
              <div
                className="side-label"
                title="Chronological timeline of task attempts and context compactions."
              >
                timeline · runs, compactions & reviews
              </div>
              {timeline.map((item, idx) =>
                item.kind === 'run' ? (
                  <RunRow
                    key={item.run.id}
                    index={idx + 1}
                    run={item.run}
                    sessions={sessions}
                    fleet={fleet}
                    now={now}
                  />
                ) : item.kind === 'compaction' ? (
                  <CompactionRow
                    key={`compact-${item.compaction.id}`}
                    index={idx + 1}
                    compaction={item.compaction}
                    sessions={sessions}
                    fleet={fleet}
                    now={now}
                  />
                ) : (
                  <ReviewRow
                    key={`review-${item.review.id}`}
                    index={idx + 1}
                    review={item.review}
                    runs={runs}
                    fleet={fleet}
                    now={now}
                  />
                )
              )}
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
/**
 * Collapsible prompt disclosure with character count and copy-to-clipboard.
 */
function PromptDisclosure({
  prompt,
  label = 'Prompt sent to agent',
  defaultOpen = false
}: {
  prompt: string
  label?: string
  defaultOpen?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <details className="prompt-disclosure" open={defaultOpen}>
      <summary className="prompt-disclosure-summary">
        <span className="prompt-disclosure-title">
          <span className="prompt-disclosure-icon">📋</span> {label}
        </span>
        <span className="prompt-disclosure-meta">
          <span>{prompt.length.toLocaleString()} chars</span>
          <button
            type="button"
            className="btn btn--xs btn--ghost prompt-copy-btn"
            onClick={copy}
            title="Copy full prompt text"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </summary>
      <div className="prompt-disclosure-body">
        <pre className="prompt-pre">{prompt}</pre>
      </div>
    </details>
  )
}

/**
 * One image that is already on a message.
 *
 * ⛔ Fetched through `attachment.read` rather than pointed at by a `file://` URL. The renderer runs
 * with no filesystem access to the daemon's data directory — deliberately, and it is a different
 * machine's directory the moment anything is remote — so a path here would render as a broken image
 * with nothing to say about why.
 *
 * ⚠️ The bytes are stored on disk and the row is not. A thumbnail that will not load is a fact
 * worth showing: the prompt the agent received still names that path, and if the file has gone the
 * agent could not open it either.
 */
function MessageImage({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void rpc('attachment.read', { id: attachment.id })
      .then((r) => {
        if (live) setSrc(`data:${r.attachment.mediaType};base64,${r.dataBase64}`)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [attachment.id])
  if (failed) {
    return <span className="dim">an image that is no longer on disk ({attachment.file})</span>
  }
  return src ? (
    <img className="msg-image" src={src} alt="" title={attachment.file} />
  ) : (
    <span className="dim">loading an image…</span>
  )
}

function Thread({
  messages,
  runs,
  activity,
  live
}: {
  messages: TaskMessage[]
  runs: Run[]
  activity: Array<{ text: string; ts: number }>
  live: boolean
}): React.JSX.Element {
  /**
   * ⛔ **`live` alone.** This was `live || activity.length > 0`, and the tail is not cleared when a
   * run ends — only when the *next* attempt starts, via `reset`. So a completed task went on drawing
   * a bubble captioned "replaced when the run ends" beside a status reading `completed`, forever.
   * The tail is a window onto a running process; when nothing is running there is nothing to look
   * through, and what the agent actually recorded is already in the messages above.
   */
  const showLive = live

  return (
    <div className="thread thread--task">
      {messages.length === 0 && !showLive && (
        <p className="dim">Nothing has been said on this task yet.</p>
      )}
      {messages.map((m) => {
        const runForMsg = m.runId
          ? runs.find((r) => r.id === m.runId)
          : m.role === 'system'
            ? runs.find((r) => r.prompt && Math.abs(r.startedAt - m.ts) < 5000)
            : null
        return (
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
            <span className="msg-text">
              {m.text}
              {m.attachments.length > 0 && (
                <span className="msg-images">
                  {m.attachments.map((a) =>
                    a.kind === 'image' ? (
                      <MessageImage key={a.id} attachment={a} />
                    ) : (
                      <span className="chip" key={a.id} title={a.file}>
                        {a.kind === 'folder' ? 'Folder: ' : 'File: '}{a.file}
                      </span>
                    )
                  )}
                </span>
              )}
              {runForMsg?.prompt && (
                <div className="msg-prompt-box">
                  <PromptDisclosure
                    prompt={runForMsg.prompt}
                    label={`Prompt sent for run ${runForMsg.id.slice(0, 8)}`}
                  />
                </div>
              )}
            </span>
          </div>
        )
      })}

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
 * Preempted due to quota banner with Override, Resume, and Reassign controls.
 *
 * ⛔ The wait for window reset is automatic, but the operator can:
 * - Override: bypasses the 92% watermark and resumes immediately.
 * - Resume: resumes into the queue right now without waiting for the reset timer.
 * - Reassign: switches the worker/model and resumes immediately on the new target.
 */
function PausedQuotaBanner({
  task,
  fleet,
  modelOptions,
  now,
  onRefresh
}: {
  task: Task
  fleet: FleetEntry[]
  modelOptions: ModelOptions[]
  now: number
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(task.constraints.workerId ?? '')
  const [selectedModel, setSelectedModel] = useState<string>(task.constraints.model ?? '')
  const [selectedEffort, setSelectedEffort] = useState<string>(task.constraints.effort ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelectedWorkerId(task.constraints.workerId ?? '')
    setSelectedModel(task.constraints.model ?? '')
    setSelectedEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.effort])

  const selectedWorker = fleet.find((e) => e.worker.id === selectedWorkerId)?.worker ?? null
  const selectedEntry = fleet.find((e) => e.worker.id === selectedWorkerId) ?? null
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, selectedWorker, canSetEffort, selectedEntry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === selectedModel)?.effortLevels ?? [])
    : []

  const handleOverride = async () => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleResume = async () => {
    setBusy(true)
    try {
      await rpc('task.resume', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleReassign = async () => {
    setBusy(true)
    try {
      await rpc('task.setWorker', { id: task.id, workerId: selectedWorkerId || null })
      if (selectedWorkerId) {
        await rpc('task.setModel', {
          id: task.id,
          model: selectedModel || null,
          effort: selectedEffort || null
        })
      }
      await rpc('task.resume', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="paused-banner">
      <div className="paused-banner-header">
        <span className="paused-banner-title">
          Preempted due to quota {task.holdReason ? `(${holdLine(task, now)})` : ''}
        </span>
        <span className="dim">
          Resumes automatically when quota is available (after window reset), or you can override to continue now, resume immediately, or reassign to another agent.
        </span>
      </div>
      <div className="paused-banner-actions">
        <button
          type="button"
          className="btn btn--warn"
          disabled={busy}
          title="Override preemption and resume this task immediately even though the account is at or past 92% of its window."
          onClick={() => void handleOverride()}
        >
          Override &amp; continue
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="Puts the task back in the queue right now without waiting for the reset timer (dispatches if quota is available)."
          onClick={() => void handleResume()}
        >
          Resume
        </button>
      </div>

      <div className="paused-banner-reassign">
        <button
          type="button"
          className="btn btn--primary"
          title="Reassigns this task to another worker or Auto and resumes it immediately."
          disabled={busy}
          onClick={() => void handleReassign()}
        >
          Reassign
        </button>
        <div className="reassign-row" style={{ flex: 1, margin: 0 }}>
          <SettingButtonSelect
            className="reassign-select"
            value={selectedWorkerId}
            disabled={busy}
            ariaLabel="Reassign worker"
            options={[
              { value: '', label: 'Auto (scheduler decides)' },
              ...fleet
                .filter((e) => (e.worker.enabled && e.worker.role !== 'controller') || e.worker.id === selectedWorkerId)
                .map((e) => ({
                  value: e.worker.id,
                  label: `${e.worker.label} (${e.worker.adapterId})`
                }))
            ]}
            onChange={(nextWorkerId) => {
              setSelectedWorkerId(nextWorkerId)
              if (!nextWorkerId) {
                setSelectedModel('')
                setSelectedEffort('')
              } else {
                const w = fleet.find((entry) => entry.worker.id === nextWorkerId)?.worker
                const offered = modelOptions.find((o) => o.adapterId === w?.adapterId)?.models ?? []
                if (selectedModel && !offered.some((m) => m.id === selectedModel)) {
                  setSelectedModel(reassignmentModel(selectedModel, offered))
                  setSelectedEffort('')
                }
              }
            }}
          />

          {offeredModels.length > 0 && (
            <SettingButtonSelect
              className="reassign-select"
              value={selectedModel}
              disabled={busy}
              ariaLabel="Reassign model"
              options={[
                {
                  value: '',
                  label: inheritedModel
                    ? `account default (${modelLabel(inheritedModel) ?? inheritedModel})`
                    : 'CLI default model'
                },
                ...offeredModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
              ]}
              onChange={(val) => {
                setSelectedModel(val)
                setSelectedEffort('')
              }}
            />
          )}

          {offeredEfforts.length > 0 && (
            <SettingButtonSelect
              className="reassign-select"
              value={selectedEffort}
              disabled={busy}
              ariaLabel="Reassign effort"
              options={[
                {
                  value: '',
                  label: selectedWorker?.defaultEffort
                    ? `account default (${effortLabel(selectedWorker.defaultEffort)})`
                    : 'CLI default effort'
                },
                ...offeredEfforts.map((level) => ({
                  value: level,
                  label: effortLabel(level) ?? level
                }))
              ]}
              onChange={(val) => setSelectedEffort(val)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The rungs the Commit button offers, and the two it does not.
 *
 * ⛔ **Derived from `FINISH_ORDER`, never hand-written**, for the reason the composer's own list
 * carries: three dropdowns each kept their own copy of these and all three still offered
 * `agent-lands` a week after the rename. ⚠️ `await-human` is dropped because it is what the
 * conversation is already doing — offering it under a button called Commit would be a button that
 * does nothing — and `custom` because it is an instruction the project wrote for its *own* finish,
 * which is a different question from what this one commit should do.
 */
const COMMIT_RUNGS: FinishPolicy[] = FINISH_ORDER.filter(
  (policy) => policy !== 'await-human' && policy !== 'custom'
)

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
  fleet,
  modelOptions,
  onResolve,
  onStop,
  onRefresh
}: {
  task: Task
  blocking: number
  fleet: FleetEntry[]
  modelOptions: ModelOptions[]
  onResolve: () => Promise<void>
  onStop: () => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(task.constraints.workerId ?? '')
  const [selectedModel, setSelectedModel] = useState<string>(task.constraints.model ?? '')
  const [selectedEffort, setSelectedEffort] = useState<string>(task.constraints.effort ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelectedWorkerId(task.constraints.workerId ?? '')
    setSelectedModel(task.constraints.model ?? '')
    setSelectedEffort(task.constraints.effort ?? '')
  }, [task.constraints.workerId, task.constraints.model, task.constraints.effort])

  const selectedWorker = fleet.find((e) => e.worker.id === selectedWorkerId)?.worker ?? null
  const selectedEntry = fleet.find((e) => e.worker.id === selectedWorkerId) ?? null
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, selectedWorker, canSetEffort, selectedEntry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === selectedModel)?.effortLevels ?? [])
    : []

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

  /**
   * What is sitting uncommitted in this task's workspace, for a conversation.
   *
   * ⛔ Fetched rather than derived, and only for the kind that needs it. Finish releases the
   * workspace, so on a conversation it can walk away from files nothing else on this page mentions —
   * see `PendingWork`. ⚠️ `null` while it is being read, which is *not* the same as "nothing there":
   * the Commit button appears when the answer arrives and the Finish warning with it, rather than
   * either being drawn on a guess.
   */
  const [pending, setPending] = useState<PendingWork | null>(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const conversation = task.kind === 'conversation'

  const readPending = useCallback(async (): Promise<void> => {
    if (!conversation) return
    try {
      const answer = await rpc('task.pendingWork', { id: task.id })
      setPending(answer)
      // ⚠️ An arming that outlives the thing it warned about is a trap. Once the tree is clean the
      // next press of Finish must be an ordinary press again.
      if (!answer.supported || !answer.hasDiff) setConfirmFinish(false)
    } catch {
      // ⚠️ A tree that cannot be read is not a tree with nothing in it. Leaving `pending` alone keeps
      // whatever the last successful read said rather than replacing it with a reassuring absence.
    }
  }, [conversation, task.id])

  // ⚠️ Re-read when the task moves, because every action on this card changes the tree: a commit
  // empties it, a reply can fill it again. `updatedAt` is the cheapest honest trigger.
  useEffect(() => {
    void readPending()
  }, [readPending, task.updatedAt])

  // ⚠️ `hasDiff` only, and only once the read has come back. `pending === null` means *not yet
  // known*, and drawing a warning or a Commit button off an unknown is how a card ends up telling
  // somebody there is nothing to lose a moment before there is.
  const uncommittedNow = conversation && pending?.supported === true && pending.hasDiff
  const uncommittedLine = pending
    ? `${pending.dirtyFiles + pending.untrackedFiles} uncommitted file(s) in this workspace.`
    : ''

  // ⛔ Offered only when the thing that stopped it is a conflict, and read from `holdReason`
  // because that is where `landTask`'s failure is actually recorded. A *fix the conflict* button on
  // a task that failed its checks would send an agent to rebase something that rebases fine.
  const conflicted = isConflictedTask(task)
  const checksFailed = isChecksFailedTask(task)
  const uncommitted = isUncommittedTask(task)
  const trunkMoved = isTrunkMovedTask(task)
  const canReland = canRelandTask(task)

  const handleResolveRetry = async () => {
    setBusy(true)
    try {
      await rpc('task.resolveRetry', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleReland = async () => {
    setBusy(true)
    try {
      await rpc('task.land', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleCommit = async (finishPolicy: FinishPolicy): Promise<void> => {
    setBusy(true)
    try {
      const result = await rpc('task.commitConversation', { id: task.id, finishPolicy })
      setCommitError(result.ok ? null : (result.reason ?? 'the commit could not be started'))
      await onRefresh()
      await readPending()
    } finally {
      setBusy(false)
    }
  }

  const handleReassign = async () => {
    setBusy(true)
    try {
      await rpc('task.setWorker', { id: task.id, workerId: selectedWorkerId || null })
      if (selectedWorkerId) {
        await rpc('task.setModel', {
          id: task.id,
          model: selectedModel || null,
          effort: selectedEffort || null
        })
      }
      const targetName = selectedWorkerId
        ? (fleet.find((e) => e.worker.id === selectedWorkerId)?.worker.label ?? selectedWorkerId)
        : 'auto / scheduler choice'
      await rpc('task.message', {
        id: task.id,
        text: `Reassigned worker to ${targetName} and continued.`
      })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

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
          title={
            uncommittedNow
              ? 'There is uncommitted work in this workspace. Finishing releases it — commit first, or press again to finish anyway.'
              : 'Records your judgement that this is finished. ⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished.'
          }
          disabled={busy}
          onClick={() => {
            // ⛔ **The warning is a first press, not a dialog**, and it is armed only when something
            // would actually be lost. Finish releases the workspace back to the pool, so on a
            // conversation carrying uncommitted files it is the one irreversible button on this
            // card — and nothing else on the page says those files exist. A confirmation that fired
            // on every finish would be trained away within a day; this one only ever appears when it
            // is telling the truth.
            if (uncommittedNow && !confirmFinish) {
              setConfirmFinish(true)
              return
            }
            void onResolve()
          }}
        >
          {conversation ? (confirmFinish && uncommittedNow ? 'Finish anyway' : 'Finish') : 'Mark done'}
        </button>
        <span className="decide-what">
          <strong>Finished.</strong> {releases} ⚠️ Your judgement, written into the thread as such —
          nothing here checked the work.
          {uncommittedNow && (
            <>
              {' '}
              <span className="decide-warn">
                ⚠️ {uncommittedLine} Finishing releases this workspace, and uncommitted files go back
                to the pool with it. Commit below first, or press Finish again to finish anyway.
              </span>
            </>
          )}
        </span>
      </div>

      <div className="decide-option">
        <button
          className="btn btn--danger"
          title="Parks the task. Destroys nothing, and Resume picks it up where it stopped."
          disabled={busy}
          onClick={() => void onStop()}
        >
          {conversation ? 'Stop' : 'Stop here'}
        </button>
        <span className="decide-what">
          <strong>Not finished.</strong> Parks it as <span className="mono">paused_user</span>, which
          Resume picks back up. {holds} The branch and the workspace are kept.
        </span>
      </div>

      {/* ⛔ Drawn only when there is something to commit, which is why `pendingWork` runs git rather
          than reading the task. A Commit button on a clean tree would dispatch a turn to commit
          nothing, and one that was always there would say nothing about whether it was needed. */}
      {conversation && uncommittedNow && (
        <div className="decide-option">
          <SettingButtonSelect
            className="commit-select"
            value=""
            disabled={busy}
            ariaLabel="Commit this conversation"
            displayLabel="Commit…"
            options={COMMIT_RUNGS.map((rung) => ({
              value: rung,
              label: `${FINISH_SHORT[rung]} — ${FINISH_LABELS[rung]}`
            }))}
            onChange={(rung) => void handleCommit(rung as FinishPolicy)}
          />
          <span className="decide-what">
            <strong>Commit it.</strong> {uncommittedLine} Asks this conversation’s agent — in the
            same session, so it still has the context — to commit on{' '}
            <span className="mono">{pending?.branch ?? task.branch}</span> and report complete, then
            the rung you pick above is what the tool does with the branch afterwards.
            {commitError && <span className="decide-warn"> ⚠️ {commitError}</span>}
          </span>
        </div>
      )}

      {conflicted && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Dispatches a run on this thread that rebases the branch onto the landing target, resolves the conflicts and reports complete again."
            disabled={busy}
            onClick={() => void handleResolveRetry()}
          >
            Resolve &amp; retry
          </button>
          <span className="decide-what">
            <strong>The work is fine, the branch is stale.</strong> Sends the branch back to an agent
            to rebase onto the landing target and resolve the conflicts, then report complete again —
            same thread, so it keeps the context it already has. Nothing is discarded and the branch
            is never reset.
          </span>
        </div>
      )}

      {checksFailed && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Dispatches a run on this thread asking the agent to fix the failing checks, commit the fix, and report complete again."
            disabled={busy}
            onClick={() => void handleResolveRetry()}
          >
            Resolve &amp; retry
          </button>
          <span className="decide-what">
            <strong>Project checks failed.</strong> Sends the check output back to the agent to fix
            the lint, type, or test errors, commit the fix on <span className="mono">{task.branch}</span>, and report
            complete again — same thread, preserving existing context.
          </span>
        </div>
      )}

      {uncommitted && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Dispatches a run on this thread asking the agent to review, commit uncommitted work, and report complete again."
            disabled={busy}
            onClick={() => void handleResolveRetry()}
          >
            Resolve &amp; retry
          </button>
          <span className="decide-what">
            <strong>Uncommitted work.</strong> Sends the branch back to an agent to commit the
            changes on <span className="mono">{task.branch}</span> and report complete again — same
            thread, preserving existing context.
          </span>
        </div>
      )}

      {trunkMoved && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Dispatches a run on this thread asking the agent to rebase onto the moved trunk, verify project checks, and commit on this branch."
            disabled={busy}
            onClick={() => void handleResolveRetry()}
          >
            Resolve &amp; retry
          </button>
          <span className="decide-what">
            <strong>The trunk moved and the branch is empty.</strong> Sends the branch back to an
            agent to rebase onto the landing target, ensure all intended changes are committed on{' '}
            <span className="mono">{task.branch}</span>, run project checks, and report complete
            again — same thread, preserving existing context.
          </span>
        </div>
      )}

      {canReland && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Attempts to land the branch again without dispatching an agent."
            disabled={busy}
            onClick={() => void handleReland()}
          >
            Retry landing
          </button>
          <span className="decide-what">
            <strong>Land again.</strong> Attempts to rebase and land <span className="mono">{task.branch}</span> now.
            Use this if the trunk is now clean or another task has finished landing.
          </span>
        </div>
      )}

      <div className="decide-option">
        <button
          className="btn btn--primary"
          title="Reassigns the worker and model and dispatches a new run on this thread."
          disabled={busy}
          onClick={() => void handleReassign()}
        >
          Reassign
        </button>
        <div className="decide-what">
          {/* ⚠️ One row, and it stays one row. Each selector used to size itself to its own longest
              label — "Auto (scheduler decides)", "account default (claude-opus-5)" — so the three of
              them asked for more width than the column has and wrapped onto a line each, turning one
              decision into a stack. They share the row equally now and ellipsize instead; the full
              label is still on the button that opens the menu, and in the menu itself. */}
          <div className="reassign-row">
            <SettingButtonSelect
              className="reassign-select"
              value={selectedWorkerId}
              disabled={busy}
              ariaLabel="Reassign worker"
              options={[
                { value: '', label: 'Auto (scheduler decides)' },
                /* ⛔ Deactivated accounts are not offered. Reassigning to a disabled worker
                   parks the task on an account the scheduler will never hand a turn, so the menu
                   lists only what can actually pick the work up. The one exception is the account
                   this task is already pinned to — if it was deactivated after assignment it stays
                   in the list, so the button reads its label instead of a bare id. */
                ...fleet
                  .filter((e) => (e.worker.enabled && e.worker.role !== 'controller') || e.worker.id === selectedWorkerId)
                  .map((e) => ({
                    value: e.worker.id,
                    label: `${e.worker.label} (${e.worker.adapterId})`
                  }))
              ]}
              onChange={(nextWorkerId) => {
                setSelectedWorkerId(nextWorkerId)
                if (!nextWorkerId) {
                  setSelectedModel('')
                  setSelectedEffort('')
                } else {
                  const w = fleet.find((entry) => entry.worker.id === nextWorkerId)?.worker
                  const offered = modelOptions.find((o) => o.adapterId === w?.adapterId)?.models ?? []
                  if (selectedModel && !offered.some((m) => m.id === selectedModel)) {
                    setSelectedModel(reassignmentModel(selectedModel, offered))
                    setSelectedEffort('')
                  }
                }
              }}
            />

            {offeredModels.length > 0 && (
              <SettingButtonSelect
                className="reassign-select"
                value={selectedModel}
                disabled={busy}
                ariaLabel="Reassign model"
                options={[
                  {
                    value: '',
                    label: inheritedModel
                      ? `account default (${modelLabel(inheritedModel) ?? inheritedModel})`
                      : 'CLI default model'
                  },
                  // ⚠️ The label is written for a person; the value stays the id, which is what is
                  // sent to the CLI and what the cost model is keyed by.
                  ...offeredModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
                ]}
                displayLabel={
                  !selectedModel
                    ? inheritedModel
                      ? (modelLabel(inheritedModel) ?? inheritedModel)
                      : 'CLI default model'
                    : undefined
                }
                onChange={(val) => {
                  setSelectedModel(val)
                  setSelectedEffort('')
                }}
              />
            )}

            {offeredEfforts.length > 0 && (
              <SettingButtonSelect
                className="reassign-select"
                value={selectedEffort}
                disabled={busy}
                ariaLabel="Reassign effort"
                options={[
                  {
                    value: '',
                    label: selectedWorker?.defaultEffort
                      ? `account default (${effortLabel(selectedWorker.defaultEffort)})`
                      : 'CLI default effort'
                  },
                  ...offeredEfforts.map((level) => ({
                    value: level,
                    label: effortLabel(level) ?? level
                  }))
                ]}
                displayLabel={
                  !selectedEffort
                    ? selectedWorker?.defaultEffort
                      ? (effortLabel(selectedWorker.defaultEffort) ?? selectedWorker.defaultEffort)
                      : 'CLI default effort'
                    : undefined
                }
                onChange={(val) => setSelectedEffort(val)}
              />
            )}
          </div>
          <span>
            <strong>Reroute & continue.</strong> Sets the worker/model preference and dispatches a new run.
            If set to Auto, the scheduler automatically picks the best worker (e.g. Antigravity) based on quota and capacity.
          </span>
        </div>
      </div>

      <p className="decide-hint">
        Or say what you want next in the box below — another run on this same thread, preferring the
        session that still holds its context.
      </p>
    </div>
  )
}

/**
 * Run this now anyway, at 92% of a window — or keep a run alive through the minute before an
 * automatic quota preemption.
 *
 * ⛔ **The countdown is the daemon's, not this component's.** `quotaPreemptWarning` is written to
 * the database before it is ever shown, so the deadline survives a reload and a restart of the app
 * that is displaying it; the renderer only subtracts a ticking clock from a number it was given. A
 * vendor **refusal** never appears here, because that turn has already been declined and there is
 * nothing left to choose.
 *
 * ⛔ **Otherwise shown only when the hold is one the fleet invented for itself.** The water mark is
 * a caution computed from a reading — the vendor served every turn up to it — and on a task pinned to one
 * account there was no way to say *"8% is more than this needs"*. Every other hold on this row ends
 * when something else happens (a run finishes, a dependency completes, somebody signs in) and has
 * nothing here to overrule, so no button appears on one. ⚠️ Matched on the sentence the gate writes,
 * for the same reason the conflict button is: that sentence is where the scheduler records *which*
 * gate refused, and re-deriving it in the renderer would be a second opinion on a settled question.
 *
 * ⚠️ It says what it does **not** buy, because the honest failure mode is an operator who overrides
 * at 92%, sees the run stop anyway on a vendor refusal, and concludes the button is broken.
 */
function QuotaOverride({
  task,
  onChanged
}: {
  task: Task
  onChanged?: () => Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  // ⚠️ One ticking clock, not `Date.now()` in the render: the countdown below has to move, and a
  // component that reads the wall clock while rendering only updates when something else makes it.
  const now = useNow(1000)
  const held =
    (task.status === 'ready' && /% of its .* window/.test(task.holdReason ?? '')) ||
    task.status === 'paused_quota'
  const warning = task.status === 'running' ? task.quotaPreemptWarning : null
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now
  if (!held && !live && !warning) return null

  // ⚠️ `withdraw` sends an explicit `null`; granting sends no `until` at all, so the daemon dates
  // the permission from the window it measured rather than from a clock in the renderer.
  const set = async (withdraw: boolean): Promise<void> => {
    setBusy(true)
    try {
      await rpc('task.overrideQuota', { id: task.id, ...(withdraw ? { until: null } : {}) })
      if (onChanged) await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Fact label="quota gate">
      {live ? (
        <>
          <span>overridden for {duration((task.quotaOverrideUntil ?? 0) - now)}</span>{' '}
          <button className="btn" disabled={busy} onClick={() => void set(true)}>
            Withdraw
          </button>
        </>
      ) : (
        <>
          {warning && (
            <span className="quota-countdown">
              Preempts in {duration(Math.max(0, warning.preemptAt - now))}: {warning.reason}.{' '}
            </span>
          )}
          <button
            className="btn btn--warn"
            disabled={busy}
            title={
              warning
                ? 'Keep this run going until the quota window resets rather than wrapping it up now. A turn the vendor actually refuses will still stop it.'
                : task.status === 'paused_quota'
                  ? 'Override preemption and resume this task immediately even though the account is at or past 92% of its window.'
                  : 'Dispatch this task even though the account is at or past 92% of its window. Expires when that window resets. ⚠️ A turn the vendor actually refuses still stops the run, and so does the window boundary itself.'
            }
            onClick={() => void set(false)}
          >
            {warning
              ? 'Override preemption'
              : task.status === 'paused_quota'
                ? 'Override & continue'
                : 'Run now anyway'}
          </button>{' '}
          <span className="dim">
            {warning
              ? `keeps this run going until ${new Date(warning.resumeAt).toLocaleTimeString()}`
              : task.status === 'paused_quota'
                ? 'resumes immediately and overrides the quota gate'
                : 'spends into the window this task is waiting on'}
          </span>
        </>
      )}
    </Fact>
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

/** Statuses where a prerequisite would change nothing, so the control that adds one is not drawn. */
const FINISHED_FOR_GOOD = new Set<Task['status']>(['completed', 'cancelled', 'failed'])

/**
 * The prerequisites of *this* task, and the two ways to change them.
 *
 * ⛔ In the ledger beside `blocks`, not in the composer. An edge is a fact about the task in the same
 * sense its worker and its model are, and all three are now editable in the place they are read —
 * the pattern `WorkerPicker` established. What the composer is for is saying something to the agent.
 *
 * ⚠️ Every change is a round trip that can be refused: a cycle, a task somebody deleted between this
 * pane loading and the click. The refusal is shown here rather than swallowed, because the list not
 * changing is not, by itself, an explanation.
 */
function DependencyEditor({
  task,
  dependencies,
  onOpenTask,
  onChanged
}: {
  task: Task
  dependencies: Task[]
  onOpenTask?: (taskId: string) => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const { tasks: all, reload } = useTaskCandidates()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = async (method: 'task.addDependency' | 'task.removeDependency', dependsOn: string) => {
    setBusy(true)
    setError(null)
    try {
      await rpc(method, { id: task.id, dependsOn })
      await onChanged()
      // ⚠️ The candidate list too. Adding an edge makes every task that now reaches this one through
      // it an illegal next choice, and a stale list would keep offering them.
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const candidates = candidatesFor(all, task.id, task.dependsOn)

  return (
    <>
      <DependencyList
        tasks={dependencies}
        fallbackIds={task.dependsOn}
        onOpenTask={onOpenTask}
        onRemove={(id) => void change('task.removeDependency', id)}
        busy={busy}
      />
      {!FINISHED_FOR_GOOD.has(task.status) && (
        <AddDependency
          candidates={candidates}
          onAdd={(id) => void change('task.addDependency', id)}
          busy={busy}
          placeholder={dependencies.length > 0 ? 'wait on another task…' : 'wait on a task…'}
        />
      )}
      {error && <span className="dep-error">{error}</span>}
    </>
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
 * How an outcome reads at a glance.
 *
 * ⛔ `blocked` is not a warning. The agent asked a person something and stopped; the run did its
 * work and is one answer away from continuing. It gets the same colour as `awaiting_human` — which is
 * what the task itself is now — rather than the amber that means something went wrong.
 */
function outcomeClass(outcome: Run['outcome']): string {
  if (outcome === 'completed') return 'ok'
  if (outcome === 'blocked') return 'state-human'
  return outcome ? 'warn' : 'state-running'
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
  index,
  run,
  sessions,
  fleet,
  now
}: {
  index: number
  run: Run
  /** Every session any run of this task used, so this run's can be named rather than guessed at. */
  sessions: Session[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const worker = fleet.find((f) => f.worker.id === run.workerId)?.worker.label
  const spent = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
  const session = sessions.find((s) => s.id === run.sessionId)
  const modelName = run.model ?? session?.model ?? 'CLI default'
  const effort = session?.effort ?? null
  const agentWorkingMs = (run.endedAt ?? now) - run.startedAt - run.blockedMs
  const totalDurationMs = (run.endedAt ?? now) - run.startedAt

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Run</span>
        <span className="num dim">{timeRange(run.startedAt, run.endedAt, now)}</span>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">run_id:</span>
          <span className="side-run-val mono" title={`Run ${run.id}`}>
            {run.id.slice(0, 8)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">session:</span>
          <span className="side-run-val">
            <ConversationId run={run} sessions={sessions} workerLabel={worker} />
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">model:</span>
          <span className="side-run-val" title={modelName}>
            {modelName}
            {effort ? ` · ${effort}` : ''}
          </span>
        </div>
        {run.prompt && (
          <div className="side-run-fact">
            <span className="side-run-key">prompt:</span>
            <span className="side-run-val">
              <PromptDisclosure prompt={run.prompt} label="link" />
            </span>
          </div>
        )}
        {run.startedWarm !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">fresh:</span>
            <span className="side-run-val">
              <span
                className={run.startedWarm ? 'ok' : 'dim'}
                title={
                  run.startedWarm
                    ? 'This run inherited a conversation that already existed — continued in a live session, or resumed one that had closed.'
                    : 'This run opened a new conversation and built its context from nothing.'
                }
              >
                {run.startedWarm ? 'reused' : 'new'}
              </span>
            </span>
          </div>
        )}
        <div className="side-run-fact">
          <span className="side-run-key">status:</span>
          <span className="side-run-val">
            <span
              className={outcomeClass(run.outcome)}
              title={
                run.outcome === 'blocked'
                  ? 'The agent stopped to ask something rather than because anything went wrong. Answer it and the task carries on.'
                  : undefined
              }
            >
              {run.outcome ?? 'running'}
            </span>
          </span>
        </div>
        {/* ⛔ Price and tokens are two rows here for the same reason they are two rows in the
            ledger above: they measure the same work by two instruments that are never reconciled,
            and stacking one under the other made the second read as a gloss on the first. */}
        <div className="side-run-fact">
          <span className="side-run-key">price:</span>
          <span className="side-run-val">
            <Money
              usd={run.price?.usd ?? null}
              estimated={run.price?.estimated ?? false}
              title={runPriceTitle(run.price)}
            />
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">tokens:</span>
          <span
            className="side-run-val num"
            title={
              'What this run spent: input + output + cache read + cache write, summed from the ' +
              'transcript. ⛔ Not the size of the context — a single long conversation re-reads its ' +
              'whole window every turn, so the total runs far ahead of it.'
            }
          >
            {tokens(spent || null)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">agent time:</span>
          <span
            className="side-run-val num dim"
            title={
              run.blockedMs > 0
                ? `${duration(agentWorkingMs)} working, ${duration(run.blockedMs)} of it waiting on a person.`
                : 'Nothing waited on a person during this attempt, so all of it was work.'
            }
          >
            {duration(agentWorkingMs)}
            {run.blockedMs > 0 && <span className="dim"> (+{duration(run.blockedMs)} waiting)</span>}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">total duration:</span>
          <span className="side-run-val num dim" title="Total wall-clock duration from dispatch to end.">
            {duration(totalDurationMs)}
          </span>
        </div>
        {(run.quotaBefore || run.quotaAfter) && (
          <div className="side-run-fact side-run-fact--usage">
            <span className="side-run-key">usage:</span>
            <span className="side-run-val">
              <QuotaDelta run={run} />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One compaction, as the operator needs to read it: what it cost, and what it bought.
 *
 * ⛔ **A request that never landed is shown, not hidden.** `landedAt === null` past the settle
 * window means the session was asked to compact and did not - which is the open question in HANDOFF
 * R6 about whether `/compact` is honoured on the `stream` transport at all. A pane that rendered
 * only successes would answer that question with an empty list, which reads exactly like "nothing
 * needed compacting".
 *
 * ⚠️ **"after" is genuinely unknown until a turn measures it**, and says so rather than showing a
 * zero. The boundary record carries the pre-size and no counterpart; the first turn afterwards is
 * what fills it in, so a session that never runs again keeps its dash forever. That dash is the
 * honest answer.
 */
/**
 * The button, and what it says when it cannot be pressed.
 *
 * ⛔ **Every disabled state names its reason**, never a bare "unavailable". There are two kinds and
 * an operator acts on them differently: *no eligible peer* passes on its own (an account comes back
 * into window), while *no recoverable diff* is permanent — the task landed before its commit range
 * was recorded and its branch is gone. Both arrive as one sentence from the daemon, which is the
 * only thing that can tell them apart.
 *
 * ⚠️ Offered only on a task that has finished. Grading work that is still moving would score a
 * snapshot and store it as if it were the result.
 */
/**
 * How long this reviewer takes, as far as anybody here knows.
 *
 * ⛔ Says "not yet known" rather than an average of other accounts. A local endpoint's pace is a
 * property of the operator's own machine — a 27B model on a consumer GPU answers minutes after a
 * hosted one would have — and borrowing another agent's number would set an expectation this app
 * has no evidence for.
 */
function paceNote(typicalMs: number | null): string {
  return typicalMs === null
    ? 'How long it takes here is not yet known: it has not finished a review on this fleet.'
    : `Its last reviews here took about ${duration(typicalMs)}.`
}

function QualityReviewBox({
  task,
  reviews,
  refresh
}: {
  task: Task
  reviews: QualityReview[]
  refresh: () => Promise<void>
}): React.JSX.Element | null {
  const [eligibility, setEligibility] = useState<
    {
      ok: boolean
      reviewers: Array<{
        workerId: string
        label: string
        model: string | null
        /** The median review this account has actually completed here, or null for never. */
        typicalMs: number | null
      }>
      reason: string
    } | null
  >(null)
  const [reviewerId, setReviewerId] = useState('auto')
  const [running, setRunning] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const finished = task.status === 'completed' || task.status === 'cancelled'
  const latest = reviews.find((r) => r.status === 'complete') ?? null
  const completed = reviews.filter((r) => r.status === 'complete' && r.composite !== null)

  useEffect(() => {
    if (!finished) return
    setReviewerId('auto')
    void rpc('review.eligibility', { taskId: task.id })
      .then(setEligibility)
      .catch(() => setEligibility(null))
  }, [task.id, finished, reviews.length])

  if (!finished) return null

  const request = async () => {
    setRunning(true)
    setFailed(null)
    try {
      const result = await rpc('review.request', {
        taskId: task.id,
        workerId: reviewerId === 'auto' ? null : reviewerId
      })
      if (!result.ok) setFailed(result.reason)
      await refresh()
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="detail-side-box">
      <div
        className="side-label"
        title={
          'A second agent grades this task’s diff against a published rubric. It is never the agent ' +
          'that did the work, and nothing in the fleet gates on the score — it is an instrument.'
        }
      >
        quality review
      </div>
      {latest && (
        <div className="side-run-fact">
          <span className="side-run-key">{completed.length > 1 ? 'average:' : 'score:'}</span>
          <span className="side-run-val">
            <strong className="num">{task.qualityScore?.toFixed(1) ?? '—'} / 10</strong>
            <span className="dim">
              {' '}· {completed.length} {completed.length === 1 ? 'review' : 'reviews'}
            </span>
          </span>
        </div>
      )}
      <select
        className="reassign-select quality-review-select"
        aria-label="Quality review worker"
        value={reviewerId}
        disabled={running || !eligibility?.ok}
        onChange={(event) => setReviewerId(event.target.value)}
      >
        <option value="auto">Auto · random available small model</option>
        {eligibility?.reviewers.map((reviewer) => (
          <option key={reviewer.workerId} value={reviewer.workerId}>
            {reviewer.label}
            {reviewer.model ? ` · ${modelLabel(reviewer.model)}` : ' · CLI default'}
            {reviewer.typicalMs === null ? '' : ` · ~${duration(reviewer.typicalMs)}`}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        disabled={running || !eligibility?.ok}
        onClick={() => void request()}
      >
        {running ? 'grading…' : latest ? 'Review again' : 'Request review'}
      </button>
      <div className="side-note dim">
        {eligibility === null
          ? 'checking whether a peer can review this…'
          : eligibility.ok
            ? reviewerId === 'auto'
              ? 'Auto chooses randomly from the currently available routable peers; each uses its small review model'
              : `The selected peer will be checked for current availability, then grade this using its small review model. ${paceNote(eligibility.reviewers.find((r) => r.workerId === reviewerId)?.typicalMs ?? null)}`
            : eligibility.reason}
      </div>
      {failed && <div className="side-note warn">{failed}</div>}
    </div>
  )
}

/**
 * One quality review in the timeline — ⭐ `#N Quality Review`, which is the label this feature was
 * asked for by name.
 *
 * ⚠️ The dimensions are behind a disclosure. The composite is what a glance wants; the seven
 * rationales are what somebody arguing with the number wants, and they are long.
 */
function ReviewRow({
  index,
  review,
  runs,
  fleet,
  now
}: {
  index: number
  review: QualityReview
  runs: Run[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const reviewer = fleet.find((f) => f.worker.id === review.reviewerWorkerId)?.worker.label
  const run = runs.find((r) => r.id === review.runId)
  const spent = run
    ? run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
    : null
  const rubric = rubricFor(review.rubricVersion)

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Quality Review</span>
        <span className="num dim">{timeRange(review.createdAt, review.completedAt, now)}</span>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">score:</span>
          <span className="side-run-val">
            {review.status === 'complete' && review.composite !== null ? (
              <strong className="num">{review.composite.toFixed(1)} / 10</strong>
            ) : (
              <span className={review.status === 'pending' ? 'dim' : 'warn'}>
                {review.status === 'pending' ? 'grading…' : review.status}
              </span>
            )}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">reviewer:</span>
          <span
            className="side-run-val dim"
            title="A different agent than the one that did the work. A review never grades its own author."
          >
            {reviewer ?? review.reviewerAdapter}
            {review.reviewerModel ? ` · ${modelLabel(review.reviewerModel)}` : ''}
          </span>
        </div>
        {review.diffFiles !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">diff:</span>
            <span className="side-run-val num dim">
              {review.diffFiles} file(s) +{review.diffInsertions}/-{review.diffDeletions}
              {review.diffTruncated ? ' · truncated' : ''}
            </span>
          </div>
        )}
        {spent !== null && (
          <div className="side-run-fact">
            <span className="side-run-key">tokens:</span>
            <span className="side-run-val num dim">{tokens(spent)}</span>
          </div>
        )}
        {(review.mixedAuthorship || review.blindingLeak) && (
          <div className="side-run-fact">
            <span className="side-run-key">caveat:</span>
            <span
              className="side-run-val warn"
              title={
                'A score carrying either of these is not clean evidence about one agent. Mixed ' +
                'authorship means more than one agent contributed work; a blinding leak means a ' +
                'name survived in the prose that could not be redacted without destroying the text.'
              }
            >
              {[review.mixedAuthorship ? 'mixed authorship' : '', review.blindingLeak ? 'blinding leak' : '']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        )}
        {review.failureReason && (
          <div className="side-run-fact">
            <span className="side-run-key">reason:</span>
            <span className="side-run-val dim">{review.failureReason}</span>
          </div>
        )}
        {review.summary && (
          <div className="side-run-fact">
            <span className="side-run-key">summary:</span>
            <span className="side-run-val dim">{review.summary}</span>
          </div>
        )}
        {review.scores && (
          <>
            <button type="button" className="linkish" onClick={() => setOpen(!open)}>
              {open ? 'hide' : 'show'} the seven dimensions
            </button>
            {open && (
              <div className="review-dimensions">
                {RUBRIC_DIMENSIONS.map((dimension) => {
                  const entry = review.scores?.[dimension]
                  if (!entry) return null
                  const definition = rubric?.labels[dimension]
                  return (
                    <div className="side-run-fact" key={dimension}>
                      <span
                        className="side-run-key"
                        title={
                          definition && rubric
                            ? `${definition.asks} Weight ${rubric.weights[dimension].toFixed(2)}.`
                            : `Rubric ${review.rubricVersion} is not available in this build.`
                        }
                      >
                        {definition?.label ?? dimension}:
                      </span>
                      <span className="side-run-val">
                        <strong className="num">
                          {entry.score === null ? 'n/a' : `${entry.score}/10`}
                        </strong>
                        <span className="dim"> {entry.rationale}</span>
                      </span>
                    </div>
                  )
                })}
                <div className="side-run-fact">
                  <span className="side-run-key">rubric:</span>
                  <span
                    className="side-run-val dim"
                    title="The composite is a weighted mean computed with this stored, immutable rubric version."
                  >
                    v{review.rubricVersion} · weighted mean over the dimensions scored
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function CompactionRow({
  index,
  compaction: c,
  sessions,
  fleet,
  now
}: {
  index: number
  compaction: Compaction
  sessions: Session[]
  fleet: FleetEntry[]
  now: number
}): React.JSX.Element {
  const landed = c.landedAt !== null
  const pending = !landed && now - (c.askedAt ?? c.ts) < 4 * 60 * 1000
  const saved =
    c.preTokens !== null && c.postTokens !== null && c.preTokens > c.postTokens
      ? c.preTokens - c.postTokens
      : null
  const startTs = c.askedAt ?? c.ts
  const endTs = c.landedAt ?? (c.durationMs ? startTs + c.durationMs : null)

  const session = sessions.find((s) => s.id === c.sessionId)
  const worker = session ? fleet.find((f) => f.worker.id === session.workerId)?.worker.label : null

  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="side-run-seq">#{index} Compact</span>
        <span className="num dim">
          {timeRange(startTs, landed ? endTs : pending ? null : endTs, now)}
        </span>
      </div>
      <div className="side-run-facts">
        <div className="side-run-fact">
          <span className="side-run-key">run_id:</span>
          <span className="side-run-val mono" title={`Session ${c.sessionId}`}>
            {worker ? `${worker}/` : ''}{c.sessionId.slice(0, 8)}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">trigger:</span>
          <span
            className="side-run-val dim"
            title={
              c.trigger === 'clock'
                ? 'The cache clock bought this: it decided a shrink was worth more than holding the prefix as it was.'
                : c.trigger === 'agent'
                  ? 'The agent compacted its own context.'
                  : 'The CLI compacted on its own when the context filled. This fleet only watched it happen.'
            }
          >
            {c.trigger}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">result:</span>
          <span className="side-run-val">
            <span
              className={landed ? 'ok' : pending ? 'dim' : 'warn'}
              title={
                landed
                  ? undefined
                  : pending
                    ? 'Asked for, and not yet confirmed by a compaction boundary in the transcript.'
                    : 'Asked for and never confirmed. The session did not honour it, and the clock falls back to a handoff rather than asking a third time.'
              }
            >
              {landed ? 'compacted' : pending ? 'asked' : 'failed'}
            </span>
            {c.durationMs !== null && <span className="num dim"> · {duration(c.durationMs)}</span>}
          </span>
        </div>
        <div className="side-run-fact">
          <span className="side-run-key">context:</span>
          <span
            className="side-run-val num"
            title={
              'Context before the compaction, and after it. The second number is measured by the ' +
              'first turn that follows - until one does, it is unknown rather than zero.'
            }
          >
            <span>{tokens(c.preTokens)} → {tokens(c.postTokens)}</span>
            {saved !== null && (
              <span className="ok" title="Tokens every subsequent turn no longer has to read.">
                {' '}({tokens(saved)} smaller)
              </span>
            )}
          </span>
        </div>
        {c.reason && (
          <div className="side-run-fact">
            <span className="side-run-key">reason:</span>
            <span className="side-run-val dim">{c.reason}</span>
          </div>
        )}
      </div>
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
function ConversationId({
  run,
  sessions,
  workerLabel
}: {
  run: Run
  sessions: Session[]
  workerLabel?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const id = conversationIdFor(run, sessions)
  const displayId = id ? id.slice(0, 12) : run.sessionId ? run.sessionId.slice(0, 8) : null
  const textToCopy = id ?? run.sessionId ?? ''

  const copy = (): void => {
    if (!textToCopy) return
    void navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      // ⚠️ Silent. A clipboard permission this window does not have is not something to interrupt
      // somebody reading a ledger about, and the id is on screen either way.
      .catch(() => undefined)
  }

  if (!displayId) {
    return (
      <span className="mono">
        {workerLabel ? `${workerLabel} / ` : ''}
        <span className="dim">none</span>
      </span>
    )
  }

  return (
    <span className="mono">
      {workerLabel ? `${workerLabel} / ` : ''}
      <button
        className="conv-id mono"
        onClick={copy}
        title={`Conversation ${textToCopy} — click to copy. This is the id to pass after --resume or --conversation.`}
      >
        {copied ? 'copied' : displayId}
      </button>
    </span>
  )
}

/**
 * What this run cost the account's window.
 *
 * ⛔ Each opening window always keeps its own row. One reading is a state, not a cost, and rendering
 * "41%" beside a run invites it to be read as the run's price. Until the background closing reading
 * arrives, `41% → n/a` makes the missing half explicit and leaves a stable row for the result.
 */
function QuotaDelta({ run }: { run: Run }): React.JSX.Element | null {
  const before = run.quotaBefore
  const after = run.quotaAfter
  if (!before) return null
  const rows = quotaWindowDeltas(before, after)

  if (rows.length === 0) return null
  return (
    <div className="side-run-quota side-run-quota--windows num">
      {rows.map((r) => (
        <span key={r.label} title="the account's own window, read before the run and after it">
          {r.label} {Math.round(r.from)}% → {r.to === null ? 'n/a' : `${Math.round(r.to)}%`}
          {r.to !== null && (
            <span className={r.to > r.from ? 'warn' : 'dim'}>
              {' '}
              ({r.to > r.from ? '+' : ''}
              {Math.round(r.to - r.from)})
            </span>
          )}
        </span>
      ))}
      {/* ⚠️ A stale reading either side makes the difference meaningless, and it is the difference
          being shown. Say so on the number rather than beside it. */}
      {(before.stale || after?.stale) && (
        <span className="warn" title="One of the two readings was already too old to act on.">
          reading not fresh
        </span>
      )}
    </div>
  )
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
  refresh,
  onStop
}: {
  task: Task
  refresh: () => Promise<void>
  onStop: () => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const { settings } = useUiSettings()
  const paste = usePastedImages()
  const running = task.status === 'running' || task.status === 'assigned'
  const stoppable = STOPPABLE.has(task.status)

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setSending(true)
    try {
      const result = await rpc('task.message', {
        id: task.id,
        text: body,
        ...(paste.ids.length > 0 ? { attachmentIds: paste.ids } : {})
      })
      setText('')
      paste.clear()
      setOutcome(result.outcome)
      await refresh()
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    try {
      await onStop()
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="compose">
      <div className="compose-row">
        <textarea
          className="compose-input"
          rows={1}
          value={text}
          placeholder={
            running
              ? 'Reply to the agent working on this — it goes into the running session'
              : 'Ask for the next thing — this continues the task, it does not file a new one'
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={paste.onPaste}
          onDrop={paste.onDrop}
          onDragOver={paste.onDragOver}
          onKeyDown={(e) => {
            if (isSubmitKey(e, settings.enterBehavior) && text.trim() && !sending) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {/* ⛔ Beside the box you would otherwise type into, because the two are the same decision.
            An operator watching a run go the wrong way has exactly two moves — say something to it,
            or stop it — and until now only one of them was here: stopping meant leaving the thread,
            finding the row again in the table and opening its action menu, which is three
            navigations away from the words that made you want to stop.
            ⚠️ Not disabled while sending, and not the primary. Stopping a run that is mid-reply is
            a legitimate thing to want, and this is the destructive-looking half of a pair where the
            other half is the ordinary action. */}
        {stoppable && (
          <button
            className="btn btn--danger"
            disabled={stopping}
            title="Stop the work and park this task. Destroys nothing — the branch and the workspace are kept, and Resume picks it back up."
            onClick={() => void stop()}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <button className="btn btn--primary" disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? 'Sending…' : running ? 'Send' : 'Send and continue'}
        </button>
      </div>
      <ImageChips paste={paste} />
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

  const options: SettingOption[] = [
    { value: 'inherit', label: `inherit (${inheritedLabel})` },
    ...FINISH_ORDER.map((p) => ({
      value: p,
      label: FINISH_LABELS[p]
    }))
  ]

  return (
    <>
      <SettingButtonSelect
        value={task.finishPolicy}
        options={options}
        disabled={busy}
        ariaLabel="Finish policy"
        title="What happens to this task's work when it is done."
        displayLabel={task.finishPolicy === 'inherit' ? inheritedLabel : undefined}
        onChange={(val) => void choose(val as FinishPolicyChoice)}
      />
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

  const options: SettingOption[] = [
    { value: 'inherit', label: `inherit (${inheritedLabel})` },
    { value: 'on', label: 'reuse one if possible' },
    { value: 'off', label: 'always start a new one' }
  ]

  return (
    <>
      <SettingButtonSelect
        value={task.sessionSharing}
        options={options}
        disabled={busy}
        ariaLabel="Session sharing"
        title={
          'Whether this task may continue in a conversation another task in this project has ' +
          'already been having. Cheaper — a cold start rebuilt 41,542 tokens of prefix that a ' +
          'reused one read back for 65 — but the agent sees everything said in that conversation.'
        }
        displayLabel={task.sessionSharing === 'inherit' ? inheritedLabel : undefined}
        onChange={(val) => void choose(val as SessionSharingChoice)}
      />
      {note && <div className="note">{note}</div>}
    </>
  )
}

/**
 * How far the agent is expected to get before it stops.
 *
 * ⚠️ Records a preference and nothing else. A run already in flight was given its prompt when
 * it was dispatched, and a prompt is sent once - so this takes effect on the task's next run, which
 * the control says rather than leaving somebody to discover.
 */
function CompletionPicker({
  task,
  inheritedCompletion,
  onChanged
}: {
  task: Task
  inheritedCompletion?: ResolvedCompletionMode
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const choose = async (completionMode: CompletionModeChoice): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('task.setCompletionMode', { id: task.id, completionMode })
      if (onChanged) await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inheritedLabel = inheritedCompletion?.mode
    ? COMPLETION_LABELS[inheritedCompletion.mode] ?? inheritedCompletion.mode
    : 'run to the end'

  const options: SettingOption[] = [
    { value: 'inherit', label: `inherit (${inheritedLabel})` },
    { value: 'autonomous', label: 'run to the end' },
    { value: 'checkpointed', label: 'check in at each phase' }
  ]

  return (
    <>
      <SettingButtonSelect
        value={task.completionMode}
        options={options}
        disabled={busy}
        ariaLabel="Completion mode"
        title={
          'How far the agent goes before it stops. Running to the end is the default and does not ' +
          'stop it asking you a question when one changes what it builds; checking in makes it ' +
          'report at each phase boundary and wait. Takes effect on the next run.'
        }
        displayLabel={task.completionMode === 'inherit' ? inheritedLabel : undefined}
        onChange={(val) => void choose(val as CompletionModeChoice)}
      />
      {note && <div className="note">{note}</div>}
    </>
  )
}

/**
 * Whether the cache clock may spend a `/compact` on this task's conversation.
 *
 * ⛔ **A permission, and the control says so rather than reading as a button.** `on` does not compact
 * anything; it lets the clock reach the moves that can, and the clock still has to agree that this
 * particular compaction buys something — context past the break-even, enough growth since the last
 * one, a prefix worth reading while it is still warm. An operator who reads this as *compact now*
 * and watches nothing happen for an hour has been misled by the label, not by the feature.
 *
 * ⚠️ **The one picker on this pane that is not "takes effect on the next run".** Sharing, completion
 * and finish all change a *prompt*, and a prompt is sent once, so a run in flight was already given
 * its instructions. This changes what a loop decides on its next tick, and that loop runs every ten
 * seconds against the session this task is talking in right now.
 *
 * ⛔ **`capable === false` is shown, not hidden.** Codex takes one prompt per session and has no
 * `/compact`; Antigravity implements none. A control quietly missing on those workers is
 * indistinguishable from a bug, and a control present but silently inert is worse — so the options
 * are disabled and the tooltip says which agent cannot do it. ⚠️ Nothing here branches on an adapter
 * name; the daemon read `capabilities.manualCompact` and sent the answer.
 */
function CompactionPicker({
  task,
  inheritedAutoCompact,
  capable,
  onChanged
}: {
  task: Task
  inheritedAutoCompact?: ResolvedAutoCompact
  capable?: boolean
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const choose = async (autoCompact: AutoCompactChoice): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('task.setAutoCompact', { id: task.id, autoCompact })
      if (onChanged) await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inheritedLabel = inheritedAutoCompact?.autoCompact
    ? AUTO_COMPACT_LABELS[inheritedAutoCompact.autoCompact] ?? inheritedAutoCompact.autoCompact
    : AUTO_COMPACT_LABELS.on

  const options: SettingOption[] = [
    { value: 'inherit', label: `inherit (${inheritedLabel})` },
    { value: 'on', label: AUTO_COMPACT_LABELS.on },
    { value: 'off', label: AUTO_COMPACT_LABELS.off }
  ]

  // ⚠️ `capable === false`, not `!capable`. Undefined means a detail payload from an older daemon
  // that does not send the field, and disabling a working control because the answer is missing
  // would be the worse of the two mistakes.
  const cannot = capable === false

  return (
    <>
      <SettingButtonSelect
        value={task.autoCompact}
        options={options}
        disabled={busy || cannot}
        ariaLabel="Automatic compaction"
        title={
          cannot
            ? 'This task\u2019s agent cannot be asked to compact — the capability is declared by the ' +
              'adapter, and only Claude Code declares it today. The setting is recorded either way ' +
              'and takes effect if this task moves to a worker that can.'
            : 'Whether the cache clock may compact this conversation, overriding Settings > Global. ' +
              'It is permission, not an instruction: the clock still decides on its own terms — ' +
              'context past the ~2h break-even, enough growth since the last compaction, and a ' +
              'prefix worth reading while it is still warm. Unlike the settings above it applies to ' +
              'the conversation this task is in now, from the next tick.'
        }
        displayLabel={task.autoCompact === 'inherit' ? inheritedLabel : undefined}
        onChange={(val) => void choose(val as AutoCompactChoice)}
      />
      {note && <div className="note">{note}</div>}
    </>
  )
}

/**
 * What this task is optimising for.
 *
 * ⚠️ Records a preference and nothing else — effective on the next run.
 */
function ObjectivePicker({
  task,
  inheritedObjective,
  onChanged
}: {
  task: Task
  inheritedObjective?: Objective
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const choose = async (objective: ObjectiveChoice): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await rpc('task.setObjective', { id: task.id, objective })
      if (onChanged) await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const inheritedPreset = inheritedObjective ? presetOf(inheritedObjective) : null
  const inheritedLabel =
    inheritedPreset ??
    (inheritedObjective
      ? `${Math.round(inheritedObjective.cost * 100)}%/${Math.round(inheritedObjective.velocity * 100)}%/${Math.round(inheritedObjective.quality * 100)}%`
      : 'balanced')

  const currentChoice =
    typeof task.objective === 'string'
      ? task.objective
      : task.objective
        ? presetOf(task.objective) ?? 'custom'
        : 'inherit'

  const options: SettingOption[] = [
    { value: 'inherit', label: `inherit (${inheritedLabel})` },
    ...OBJECTIVE_PRESET_ORDER.map((preset) => ({ value: preset, label: preset })),
    ...(currentChoice === 'custom' ? [{ value: 'custom', label: 'custom' }] : [])
  ]

  return (
    <>
      <SettingButtonSelect
        value={currentChoice}
        options={options}
        disabled={busy}
        aria-label="Optimization objective"
        title="Optimization objective (cost, velocity, quality) for this task's next run."
        displayLabel={currentChoice === 'inherit' ? inheritedLabel : undefined}
        onChange={(value) => void choose(value as ObjectiveChoice)}
      />
      {note && <div className="note">{note}</div>}
    </>
  )
}

function WorkerPicker({
  task,
  fleet,
  onChanged
}: {
  task: Task
  fleet: FleetEntry[]
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const pinnable = fleet.filter((e) => e.worker.enabled && e.worker.role !== 'controller').map((e) => e.worker)
  const currentWorkerId = task.constraints.workerId ?? ''

  const choose = async (workerId: string): Promise<void> => {
    setBusy(true)
    try {
      await rpc('task.setWorker', { id: task.id, workerId: workerId || null })
      if (onChanged) await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const options: SettingOption[] = [
    { value: '', label: 'Auto — scheduler choice' },
    ...pinnable.map((w) => ({
      value: w.id,
      label: w.label
    }))
  ]

  return (
    <>
      <SettingButtonSelect
        value={currentWorkerId}
        options={options}
        disabled={busy}
        ariaLabel="Worker"
        title="Pin a worker to restrict this task to that worker, or let the scheduler decide."
        onChange={(val) => void choose(val)}
      />
      {task.ranOn && !currentWorkerId && (
        <div className="tbl-sub dim">
          last run on {fleet.find((f) => f.worker.id === task.ranOn)?.worker.label ?? task.ranOn.slice(0, 8)}
        </div>
      )}
    </>
  )
}

function PriorityPicker({
  task,
  onChanged
}: {
  task: Task
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const choose = async (priority: 'P0' | 'P1' | 'P2' | 'P3'): Promise<void> => {
    setBusy(true)
    try {
      await rpc('task.setPriority', { id: task.id, priority })
      if (onChanged) await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const options: SettingOption[] = (['P0', 'P1', 'P2', 'P3'] as const).map((p) => ({
    value: p,
    label: p
  }))

  return (
    <SettingButtonSelect
      value={task.priority}
      options={options}
      disabled={busy}
      ariaLabel="Priority"
      title="Priority orders the queue: P0 runs before P1, P2, P3."
      onChange={(val) => void choose(val as 'P0' | 'P1' | 'P2' | 'P3')}
    />
  )
}

function DraftControls({
  task,
  initialPrompt,
  previewPrompt,
  onPromote,
  onUpdate
}: {
  task: Task
  initialPrompt: string
  previewPrompt?: string
  onPromote: () => Promise<void>
  onUpdate: (title: string, prompt: string) => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTitle(task.title)
    setPrompt(initialPrompt)
  }, [task.title, initialPrompt])

  const save = async () => {
    setBusy(true)
    try {
      await onUpdate(title, prompt)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const fileTask = async () => {
    setBusy(true)
    try {
      if (editing && (title !== task.title || prompt !== initialPrompt)) {
        await onUpdate(title, prompt)
      }
      await onPromote()
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="draft-card">
        <div className="draft-card-head">Edit Draft</div>
        <div className="draft-card-fields">
          <label className="form-label">Title</label>
          <input
            className="draft-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
          />
          <label className="form-label" style={{ marginTop: 'var(--sp-2)' }}>
            Prompt / Instructions
          </label>
          <textarea
            className="ask-input draft-textarea"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the work as you would to a colleague. You can paste an image in here as well."
          />
        </div>
        <div className="draft-card-foot">
          <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <div className="ask-actions">
            <button className="btn" disabled={busy || !title.trim()} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save draft'}
            </button>
            <button
              className="btn btn--primary"
              disabled={busy || !title.trim()}
              onClick={() => void fileTask()}
            >
              {busy ? 'Filing…' : 'File task'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="draft-banner">
      <div className="draft-banner-body">
        <div className="draft-banner-title">
          <strong>Draft</strong> · This task has not been dispatched to the queue.
        </div>
        <div className="draft-banner-sub">
          You can edit the prompt or change policies in the sidebar, and file the task when ready.
        </div>
        {previewPrompt && (
          <div className="draft-preview-prompt">
            <PromptDisclosure
              prompt={previewPrompt}
              label="Prompt to be sent to agent"
            />
          </div>
        )}
      </div>
      <div className="draft-banner-actions">
        <button className="btn" onClick={() => setEditing(true)}>
          Edit draft
        </button>
        <button className="btn btn--primary" disabled={busy} onClick={() => void fileTask()}>
          {busy ? 'Filing…' : 'File task'}
        </button>
      </div>
    </div>
  )
}
