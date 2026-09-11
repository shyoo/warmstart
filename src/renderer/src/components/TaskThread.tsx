import { sessionEnded } from '@shared/protocol'
import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  resolveModelChoice,
  SHARING_LABELS,
  type AutoCompactChoice,
  type Compaction,
  type CompletionModeChoice,
  type FinishPolicyChoice,
  type Attachment,
  type Objective,
  type ObjectiveChoice,
  type ResolvedAutoCompact,
  type ResolvedCompletionMode,
  type ResolvedFinishPolicy,
  type ResolvedSessionSharing,
  type Run,
  type SessionSharingChoice,
  type Task,
  type TaskCommit,
  type TaskMessage
} from '@shared/tasks'
import type { ModelOptions, Session } from '@shared/protocol'
import type { ManualReview, QualityReview } from '@shared/review'
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { ImageChips, usePastedImages } from '../lib/pasteimages'
import { SettingButtonSelect } from './SettingButtonSelect'
import { TaskQuestions } from './Questions'
import { AddDependency, candidatesFor, DependencyList, useTaskCandidates } from './Dependencies'
import { showsLiveOutput } from '../lib/live'
import { codeSpans } from '../lib/codespans'
import { bubbleSide, promptMessageId } from '../lib/threadbubble'
import { duration, tokens, when } from '../lib/format'
import { Money, taskPriceTitle } from './Price'
import { effortLabel, modelLabel } from '../lib/modelname'
import {
  activeTime,
  activeTimeTitle,
  CANCELLABLE,
  chronologicalTimeline,
  kindLabel,
  pieceSettings,
  plannedAssignment,
  statusToneFor,
  elapsed,
  hasQuotaGate,
  holdLine,
  isWorking,
  routerPicksModel,
  statusLabel,
  STOPPABLE,
  taskLabel,
  Working,
  workspacePathFor,
  STATUS_TONE
} from '../lib/taskview'
import { errorMessage } from '@shared/errors.js'
import { stripAnsi } from '@shared/ansi'
import { useAction } from '../lib/useAction'
import { TaskSettingPicker } from './TaskSettingPicker'
import { CacheCost, Fact, ModelFact, SessionFact } from './thread/Facts'
import { Decide, QuotaDecide, QuotaOverride } from './thread/Decide'
import { ActivityDisclosure, PromptChip } from './thread/Disclosure'
import { CompactionRow, ReviewRow, RunRow } from './thread/RunRow'
import {
  compactionChoice,
  completionChoice,
  finishChoice,
  objectiveChoice,
  priorityChoice,
  ranOnLabel,
  sharingChoice,
  workerChoice,
  paceNote
} from '../lib/threadview'

export interface TaskDetailData {
  task: Task
  messages: TaskMessage[]
  runs: Run[]
  sessions: Session[]
  /** Optional so a cached detail from a previous build renders rather than crashing. */
  compactions?: Compaction[]
  /** Every quality review of this task, newest first. Optional for the same reason as above. */
  reviews?: QualityReview[]
  /** Direct operator ratings, kept separately because they have no peer-review rubric. */
  manualReviews?: ManualReview[]
  /**
   * Every commit this task landed, oldest first.
   *
   * ⛔ **The branch is gone and this is what is left.** A landed task's workspace is released and
   * its branch retired within seconds of finishing, so *"where did this work go"* has no answer
   * anywhere else in the pane. Optional for the same reason the two above are: a detail cached by
   * an older build has no such field and must still render.
   */
  commits?: TaskCommit[]
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
      onDeleted={onBack}
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
function TaskDetail({
  detail,
  activity,
  fleet,
  blocking,
  now,
  refresh,
  back,
  onDeleted,
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
  /**
   * Leave, because the task being read no longer exists.
   *
   * ⚠️ Not `refresh`. A deleted task's thread cannot re-fetch itself into anything but *That task is
   * no longer here*, so the pane that deleted it goes back to the list that still has rows in it.
   */
  onDeleted: () => void
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
    reviews = [],
    manualReviews = [],
    commits = []
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
  const planned = plannedAssignment(parent, fleet)

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
  const resolvedSpec = offered.find((m) => m.id === (resolved.model ?? '')) ?? null
  // Effort needs both halves: a CLI that takes the flag, and a chosen model that has levels.
  const taskEfforts = canSetEffort ? (resolvedSpec?.effortLevels ?? []) : []
  /**
   * ⛔ **A worker with a routable-model allowlist has no single predictable model**, so this says so
   * rather than naming one. `resolveModelChoice` answers what the *account* defaults to; once an
   * operator widens a worker, `chooseTarget` scores each allowed model as its own candidate and the
   * winner is not knowable until the tick that dispatches. Naming the default here would be the
   * exact thing the comment above forbids — promising an inheritance the dispatch does not perform.
   * ⚠️ A task-level pin still wins and is still named: a pin is a mandate the router does not touch.
   */
  // ⚠️ `modelPolicy: 'inherit'` is a task-level answer too, even though it names no model: the
  // scheduler is told to take the account's default and score nothing, so the default *is* what the
  // next run asks for and saying "chosen at dispatch" would be reporting a decision nobody makes.
  // ⛔ The predicate itself lives in `taskview.tsx`, beside the list cell that asks the same
  // question. The row and the page it opens must not name different models for the same task.
  const routerPicks = routerPicksModel(task.constraints, assigned, resolved.modelSource)
  const requestedModel = {
    model: routerPicks ? null : resolved.model,
    undecided: routerPicks,
    // ⛔ Dropped where the model in effect declares no levels, matching what the dispatch sends: an
    // account defaulting to `medium` inherits that level onto `claude-haiku-4-5`, which takes no
    // effort at all, and this row read *Haiku 4.5 Med* for a flag nothing applied.
    // ⚠️ Only where the model list actually describes it — an unlisted model says nothing about
    // its levels, and dropping there would hide one the CLI is really being sent.
    effort: resolvedSpec && resolvedSpec.effortLevels.length === 0 ? null : resolved.effort,
    source: routerPicks
      ? `chosen at dispatch from ${assigned?.routableModels?.length} routable models${assigned ? ` on ${assigned.label}` : ''}`
      : resolved.modelSource === 'task'
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
              onDelete={onDeleted}
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
              <span className="dim">next dispatch</span>
              <PromptChip prompt={detail.previewPrompt} title="Prompt to be sent on next dispatch" />
            </div>
          )}

          {/* ⛔ **Two ways out, because stopping a task is not a verdict on it.** The banner
              offered only Resume, so an operator who stopped a task and then decided the work was
              already good enough could either restart an agent they did not want or delete the
              record — and everything blocked behind it stayed blocked either way, since `admit()`
              releases a dependent only on `completed`. `resolveTask` completes from any status;
              what was missing was somewhere to press. */}
          {task.status === 'paused_user' && (
            <div className="paused-banner">
              <div className="paused-banner-header">
                <span className="paused-banner-title">Paused by operator</span>
                <span className="dim">
                  Work and context are preserved. Resume puts this task back in the queue; Mark done
                  rests it as finished and releases anything waiting on it.
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
                {/* ⚠️ The same judgement the Decide card records, said the same way: this is your
                    call, not a check. `task_complete` remains the only signal that an agent
                    finished. */}
                <button
                  type="button"
                  className="btn btn--ok"
                  title={
                    blocking > 0
                      ? `Records your judgement that this is finished. Releases the ${blocking} task(s) waiting on it. ⚠️ Nothing here verified the work.`
                      : 'Records your judgement that this is finished. ⚠️ Nothing here verified the work.'
                  }
                  onClick={() => void resolve()}
                >
                  Mark done
                </button>
              </div>
            </div>
          )}

          {/* ⛔ Shown around the composer, matching `Decide`: quota override decisions are an
              action on the work and belong where the operator gives instructions, not only in the
              read-only ledger on the right. */}
          {hasQuotaGate(task, now) && task.status !== 'awaiting_human' && (
            <QuotaDecide
              task={task}
              fleet={fleet}
              modelOptions={modelOptions}
              now={now}
              onStop={cancel}
              onRefresh={refresh}
            />
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
              inheritedFinish={detail.inheritedFinish}
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
              <span className={`status ${statusToneFor(task)}`}>
                {statusLabel(task)}
                {isWorking(task) && <Working />}
              </span>
              {task.gradingWorkerId ? (
                <button
                  type="button"
                  className="btn btn--danger btn--ghost"
                  title="Stop this quality review. The task remains at rest."
                  onClick={() => void cancel()}
                >
                  Stop
                </button>
              ) : (
                CANCELLABLE.has(task.status) && task.status !== 'awaiting_human' && (
                  <button
                    type="button"
                    className="btn btn--danger btn--ghost"
                    title="Stop the work and return this task to a resting state. Destroys nothing."
                    onClick={() => void cancel()}
                  >
                    Stop
                  </button>
                )
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
                  <span className={`status ${statusToneFor(parent)}`}>
                    {statusLabel(parent)}
                    {isWorking(parent) && <Working />}
                  </span>
                </button>
              </Fact>
            )}

            {/* The children this plan filed, with how each one turned out. ⚠️ The whole set, failures
                included: the resolution turn exists to deal with those, so hiding them would
                describe a different task. */}
            {children.length > 0 && (
              <Fact label="children">
                <DependencyList tasks={children} fallbackCount={0} onOpenTask={onOpenTask} />
              </Fact>
            )}

            {/* ⛔ What each child is filed with, read from the same two fields the daemon resolves.
                The operator sets these on the composer's Executor row and had nowhere to check them
                afterwards — which is how a split ran on accounts nobody chose without anybody being
                able to see that it had. */}
            {pieces.length > 0 && (
              <Fact label="executors">
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
            {/* ⛔ What the plan filed this child with, kept apart from the pickers below: those
                show what it will run on *now*, and moving a piece rewrites them. */}
            {planned.length > 0 && (
              <Fact label="planned">
                <span
                  className="piece-settings"
                  title={`The worker and model t${parent?.seq} filed this child with`}
                >
                  {planned.map((row) => (
                    <span key={row.label} className="piece-setting">
                      <span className="piece-setting-label">{row.label}</span>
                      <span className="piece-setting-value">{row.value}</span>
                    </span>
                  ))}
                </span>
              </Fact>
            )}
            <Fact label="worker">
              <TaskSettingPicker
                choice={workerChoice(task, fleet)}
                ariaLabel="Worker"
                title="Pin a worker to restrict this task to that worker, or let the scheduler decide."
                save={(workerId) => rpc('task.setWorker', { id: task.id, workerId: workerId || null })}
                onChanged={refresh}
                footer={
                  task.ranOn && !task.constraints.workerId ? (
                    <div className="tbl-sub dim">last run on {ranOnLabel(task, fleet)}</div>
                  ) : null
                }
              />
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
                  value={
                    task.constraints.model ??
                    (task.constraints.modelPolicy === 'auto' ? '__auto__' : '')
                  }
                  options={[
                    ...(offered.length > 1
                      ? [{ value: '__auto__', label: 'Auto Model (scheduler decides)' }]
                      : []),
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
                    task.constraints.modelPolicy === 'auto'
                      ? 'Auto Model'
                      : !task.constraints.model
                        ? assigned?.defaultModels && Object.values(assigned.defaultModels).filter(Boolean).length > 1
                          ? 'Auto-balance across pools'
                          : assigned?.defaultModel
                            ? (modelLabel(assigned.defaultModel) ?? assigned.defaultModel)
                            : 'CLI default'
                        : undefined
                  }
                  onChange={(val) => {
                    const modelPolicy = val === '__auto__' ? 'auto' : !val ? 'inherit' : null
                    const model = val === '__auto__' || !val ? null : val
                    void rpc('task.setModel', {
                      id: task.id,
                      model,
                      modelPolicy,
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
                      modelPolicy: task.constraints.modelPolicy ?? null,
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
                {/* ⚠️ Three tiers resolve into one answer — task, then project, then fleet — and
                    `inherit` is a real value rather than a blank. A task set to inherit follows its
                    project as the project changes; one set explicitly to the same value does not.
                    ⛔ The answer from the daemon is what lands in state, never the value that was
                    clicked, and here that matters twice over: choosing a landing policy on a
                    finished task also *lands* it, and the attempt can be refused. Hence
                    `successNote` — a control that painted itself green while the push was rejected
                    would be the worst kind of lie this app could tell. */}
                <Fact label="finish">
                  <TaskSettingPicker
                    choice={finishChoice(task, detail.inheritedFinish)}
                    ariaLabel="Finish policy"
                    title="What happens to this task's work when it is done."
                    save={(value) =>
                      rpc('task.setFinishPolicy', {
                        id: task.id,
                        finishPolicy: value as FinishPolicyChoice
                      })
                    }
                    successNote={(result) =>
                      result.landed ? 'landed' : result.reason ? `not landed — ${result.reason}` : null
                    }
                    onChanged={refresh}
                  />
                </Fact>
                {/* ⚠️ Next to `finish` because they are the same shape of decision — three tiers, `inherit`
                    a real value, changeable at any time — and an operator who has learnt one has learnt
                    the other. ⛔ Unlike `finish`, this one only records: a task already talking in a
                    conversation is never moved out of it — acting on this one would mean moving a
                    running agent out of the conversation it is mid-thought in, which is the single
                    thing sharing must never do. It applies from the next run. ⚠️ The saving is real
                    and measured, and so is the disclosure the tooltip makes: an agent joining a
                    conversation sees everything said in it. */}
                <Fact label="conversation">
                  <TaskSettingPicker
                    choice={sharingChoice(task, detail.inheritedSharing)}
                    ariaLabel="Session sharing"
                    title={
                      'Whether this task may continue in a conversation another task in this ' +
                      'project has already been having. Cheaper — a cold start rebuilt 41,542 ' +
                      'tokens of prefix that a reused one read back for 65 — but the agent sees ' +
                      'everything said in that conversation.'
                    }
                    save={(value) =>
                      rpc('task.setSessionSharing', {
                        id: task.id,
                        sessionSharing: value as SessionSharingChoice
                      })
                    }
                    onChanged={refresh}
                  />
                </Fact>
              </>
            )}
            {/* ⛔ Third of the same shape, and it belongs beside the other two: three tiers,
                `inherit` a real value, effective on the next run. ⚠️ It is not a care setting -
                an autonomous agent still stops to ask when a decision changes what it builds. */}
            <Fact label="completion">
              <TaskSettingPicker
                choice={completionChoice(task, detail.inheritedCompletion)}
                ariaLabel="Completion mode"
                title={
                  'How far the agent goes before it stops. Running to the end is the default and ' +
                  'does not stop it asking you a question when one changes what it builds; ' +
                  'checking in makes it report at each phase boundary and wait. Takes effect on ' +
                  'the next run.'
                }
                save={(value) =>
                  rpc('task.setCompletionMode', {
                    id: task.id,
                    completionMode: value as CompletionModeChoice
                  })
                }
                onChanged={refresh}
              />
            </Fact>
            {/* ⛔ Beside the other three because it is the same shape of decision and the same
                promise: `inherit` is a real value, and the control records a preference rather than
                doing anything. ⚠️ Unlike the three above it does **not** wait for the next run —
                the cache clock re-reads it on its next tick, so switching a long-running task on
                can schedule a compaction into the conversation it is already having, within 10s,
                if the clock works out that one is worth its tokens.
                ⛔ It is a permission, not an instruction: `on` lets the clock reach the moves that
                can compact, and the clock still has to agree this one buys something.
                ⛔ `capable === false` is *shown*, disabled, not hidden — a control quietly missing
                on Codex or Antigravity is indistinguishable from a bug, and one present but
                silently inert is worse. ⚠️ `=== false`, not `!capable`: undefined means an older
                daemon that does not send the field, and disabling a working control because the
                answer is missing is the worse of the two mistakes. Nothing here branches on an
                adapter name; the daemon read `capabilities.manualCompact` and sent the answer. */}
            <Fact label="compaction">
              <TaskSettingPicker
                choice={compactionChoice(task, detail.inheritedAutoCompact)}
                ariaLabel="Automatic compaction"
                disabled={detail.compactionCapable === false}
                title={
                  detail.compactionCapable === false
                    ? 'This task’s agent cannot be asked to compact — the capability is ' +
                      'declared by the adapter, and only Claude Code declares it today. The ' +
                      'setting is recorded either way and takes effect if this task moves to a ' +
                      'worker that can.'
                    : 'Whether the cache clock may compact this conversation, overriding Settings ' +
                      '> Global. It is permission, not an instruction: the clock still decides on ' +
                      'its own terms — context past the ~2h break-even, enough growth since the ' +
                      'last compaction, and a prefix worth reading while it is still warm. Unlike ' +
                      'the settings above it applies to the conversation this task is in now, from ' +
                      'the next tick.'
                }
                save={(value) =>
                  rpc('task.setAutoCompact', { id: task.id, autoCompact: value as AutoCompactChoice })
                }
                onChanged={refresh}
              />
            </Fact>
            <Fact label="objective">
              <TaskSettingPicker
                choice={objectiveChoice(task.objective, detail.inheritedObjective)}
                ariaLabel="Optimization objective"
                title="Optimization objective (cost, velocity, quality) for this task's next run."
                save={(value) =>
                  rpc('task.setObjective', { id: task.id, objective: value as ObjectiveChoice })
                }
                onChanged={refresh}
              />
            </Fact>
            <Fact label="priority">
              <TaskSettingPicker
                choice={priorityChoice(task)}
                ariaLabel="Priority"
                title="Priority orders the queue: P0 runs before P1, P2, P3."
                save={(value) =>
                  rpc('task.setPriority', {
                    id: task.id,
                    priority: value as 'P0' | 'P1' | 'P2' | 'P3'
                  })
                }
                onChanged={refresh}
              />
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
            {/* ⛔ Sits under the two durations because that is where it will be read: an operator
                who has just noticed a "took" that cannot be true is looking at exactly these rows.
                ⚠️ Deliberately not a delete and not a hide — the task keeps its thread, its runs and
                its price, and only the fleet-wide aggregates stop counting it. */}
            <Fact label="statistics">
              <StatsExclusionToggle task={task} onChanged={refresh} />
            </Fact>
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

          {commits.length > 0 && <CommitsBox commits={commits} />}

          <QualityReviewBox task={task} reviews={reviews} refresh={refresh} />
          <ManualReviewBox task={task} reviews={manualReviews} refresh={refresh} />

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
                    refresh={refresh}
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

/**
 * One message's text, with the identifiers in it set as code.
 *
 * ⚠️ `.msg-text` is `white-space: pre-wrap`, so every run has to be emitted as a plain string — a
 * wrapper element around the plain runs would be harmless, but the fenced ones must not swallow the
 * whitespace either side of them, which is what carries the line breaks the daemon wrote.
 */
function MessageText({ text }: { text: string }): React.JSX.Element {
  // ⚠️ Stripped here as well as where the daemon writes: a thread written before 2026-09-11 holds
  // check output with vitest's colour codes in it, and a person reading it now should not.
  return (
    <>
      {codeSpans(stripAnsi(text)).map((span, i) =>
        span.code ? (
          <code className="msg-code" key={i}>
            {span.text}
          </code>
        ) : (
          <Fragment key={i}>{span.text}</Fragment>
        )
      )}
    </>
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
  const liveRun = showLive ? runs.find((r) => !r.endedAt) : undefined

  return (
    <div className="thread thread--task">
      {messages.length === 0 && !showLive && (
        <p className="dim">Nothing has been said on this task yet.</p>
      )}
      {messages.map((m) => {
        const runForMsg = m.runId ? runs.find((r) => r.id === m.runId) : null
        const isTargetMsgForRunActivity =
          runForMsg?.activity &&
          runForMsg.activity.length > 0 &&
          (m.role === 'agent' ||
            (!messages.some((other) => other.runId === runForMsg.id && other.role === 'agent') &&
              m.role === 'system'))
        return (
          <div key={m.id} className={`msg msg--${m.role} msg--${bubbleSide(m.role)}`}>
            <div className="msg-bubble">
              <div className="msg-text">
              {isTargetMsgForRunActivity && (
                <details className="msg-chip-disclosure">
                  <summary>⚙ {runForMsg.activity!.length} step{runForMsg.activity!.length === 1 ? '' : 's'}</summary>
                  <ActivityDisclosure
                    activity={runForMsg.activity!}
                    label={`Intermediate activity (${runForMsg.activity!.length} step${runForMsg.activity!.length === 1 ? '' : 's'})`}
                  />
                </details>
              )}
              {/* ⛔ The backticks were being printed. Every message this codebase writes names refs,
                  branches, shas and files in them — *"Landed as `98f200ab` onto `main`"* — and until
                  now the reader got the punctuation and none of the distinction it was there to
                  make. ⚠️ Inline code only; see `lib/codespans.ts` for why this is not a markdown
                  renderer and must not become one. */}
              <MessageText text={m.text} />
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
              </div>
              {/* ⛔ The meta line under the bubble: when, the prompt that produced it as a `📋 1,475`
                  chip (on the run's last answer — see `promptMessageId`), and ⓘ for the detail a
                  short system line keeps behind it. */}
              <div className="msg-meta">
                <span className="msg-when" title={new Date(m.ts).toLocaleString()}>{when(m.ts)}</span>
                {runForMsg?.prompt && promptMessageId(messages, runForMsg.id) === m.id && (
                  <PromptChip prompt={runForMsg.prompt} />
                )}
                {m.detail && <details className="msg-detail"><summary title="Show details">ⓘ</summary><div><MessageText text={m.detail} /></div></details>}
              </div>
            </div>
          </div>
        )
      })}

      {showLive && (
        <div className="msg msg--agent msg--left msg--live">
          <div className="msg-bubble">
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
              {/* ⛔ An animation, not a sentence, and once: at the point the text stops, which is
                  where a reader looks to see whether more is coming. */}
              <Working />
            </span>
            {/* ⚠️ The running turn's prompt has nowhere else to go until the agent answers: a warm
                continuation on the same worker writes no system line to hang it on. */}
            {liveRun?.prompt && promptMessageId(messages, liveRun.id) === null && (
              <div className="msg-meta">
                <PromptChip prompt={liveRun.prompt} />
              </div>
            )}
          </div>
        </div>
      )}
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
 * the pattern the worker picker established. What the composer is for is saying something to the agent.
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
      setError(errorMessage(err))
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
 * How an outcome reads at a glance.
 *
 * ⛔ `blocked` is not a warning. The agent asked a person something and stopped; the run did its
 * work and is one answer away from continuing. It gets the same colour as `awaiting_human` — which is
 * what the task itself is now — rather than the amber that means something went wrong.
 */
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
 * What this task put on the trunk, one row per commit.
 *
 * ⛔ **The only durable answer to "where did this work go".** The workspace is released and the
 * branch retired within seconds of a landing, so by the time anybody opens a finished task there is
 * no branch to look at — `branch` above names one that no longer exists. These are the commits
 * themselves, and they stay reachable from the target for as long as the history does.
 *
 * ⛔ **A list, never a range.** A task that landed twice — work, then a fix asked for on the same
 * thread — put two commits on the trunk with other tasks' work in between, and printing
 * `base..head` for that pair would claim the lot. Each row is one commit that was actually recorded.
 *
 * ⚠️ A row's SHA and subject are what was true when it was recorded, and a rewritten history would
 * leave them naming a commit that no longer resolves. That is not corrected here: this pane reports
 * the record, and `review.ts` is where reachability is checked before anything is graded on it.
 */
function CommitsBox({ commits }: { commits: TaskCommit[] }): React.JSX.Element {
  return (
    <div className="detail-side-box">
      <div
        className="side-label"
        title={
          'Every commit this task landed on its target, oldest first. The branch is deleted when a ' +
          'task lands, so these SHAs are what identifies the work afterwards.'
        }
      >
        commits in this task · {commits.length}
      </div>
      {commits.map((commit) => (
        <div className="side-run" key={commit.sha}>
          <div className="side-run-head">
            <span
              className="side-run-seq mono"
              title={
                `${commit.sha}\n` +
                (commit.target ? `landed onto ${commit.target}\n` : '') +
                (commit.source === 'salvage'
                  ? 'Recovered from this task’s own “Landed as …” message — it landed before ' +
                    'commits were recorded.'
                  : 'Recorded by the landing that made it.')
              }
            >
              {commit.sha.slice(0, 8)}
            </span>
            {commit.authoredAt !== null && (
              <span className="num dim">{when(commit.authoredAt)}</span>
            )}
          </div>
          {commit.subject && <div className="side-commit-subject">{commit.subject}</div>}
        </div>
      ))}
    </div>
  )
}

/**
 * How long this reviewer takes, as far as anybody here knows.
 *
 * ⛔ Says "not yet known" rather than an average of other accounts. A local endpoint's pace is a
 * property of the operator's own machine — a 27B model on a consumer GPU answers minutes after a
 * hosted one would have — and borrowing another agent's number would set an expectation this app
 * has no evidence for.
 */
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
        effort: string | null
        /** The median review this account has actually completed here, or null for never. */
        typicalMs: number | null
      }>
      reason: string
    } | null
  >(null)
  const [reviewerId, setReviewerId] = useState('auto')
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const finished = task.status === 'completed' || task.status === 'cancelled'
  const latest = reviews.find((r) => r.status === 'complete') ?? null
  const completed = reviews.filter((r) => r.status === 'complete' && r.composite !== null)
  const pending = reviews.find((r) => r.status === 'pending') ?? null

  useEffect(() => {
    if (!finished) return
    setReviewerId('auto')
    void rpc('review.eligibility', { taskId: task.id })
      .then(setEligibility)
      .catch(() => setEligibility(null))
  }, [task.id, finished, reviews.length])

  // ⛔ A grade in flight always has a way to stop it, whatever the task went on to do. The box used
  // to be drawn only on a finished task, so a review still pending when its task was reopened
  // showed *grading…* in the ledger with no control anywhere that could end it (t217/t220).
  if (!finished && !pending) return null

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
      setFailed(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    setFailed(null)
    try {
      const result = await rpc('review.cancel', { reviewId: pending?.id, taskId: task.id })
      if (!result.ok) setFailed(result.reason)
      await refresh()
    } catch (err) {
      setFailed(errorMessage(err))
    } finally {
      setStopping(false)
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
        // ⚠️ `qualityScore` folds in the operator's own rating when there is one, so the denominator
        // shown here is the task's, not the peer list's — or the number would not match its count.
        <div className="side-run-fact">
          <span className="side-run-key">{task.qualityReviewCount > 1 ? 'average:' : 'score:'}</span>
          <span className="side-run-val">
            <strong className="num">{task.qualityScore?.toFixed(1) ?? '—'} / 10</strong>
            <span className="dim">
              {' '}· {completed.length} peer {completed.length === 1 ? 'review' : 'reviews'}
              {task.qualityManualCount > 0 ? ' and your rating' : ''}
            </span>
          </span>
        </div>
      )}
      <select
        className="reassign-select quality-review-select"
        aria-label="Quality review worker"
        value={reviewerId}
        disabled={running || stopping || Boolean(pending) || !eligibility?.ok}
        onChange={(event) => setReviewerId(event.target.value)}
      >
        <option value="auto">Auto · random available small model</option>
        {eligibility?.reviewers.map((reviewer) => (
          <option key={reviewer.workerId} value={reviewer.workerId}>
            {reviewer.label}
            {reviewer.model ? ` · ${modelLabel(reviewer.model)}` : ' · CLI default'}
            {reviewer.effort ? ` · ${reviewer.effort}` : ''}
            {reviewer.typicalMs === null ? '' : ` · ~${duration(reviewer.typicalMs)}`}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        disabled={running || stopping || Boolean(pending) || !eligibility?.ok}
        onClick={() => void request()}
      >
        {running ? 'grading…' : latest ? 'Review again' : 'Request review'}
      </button>
      {(pending || task.gradingWorkerId || running) && (
        // ⚠️ `btn--warn`, not another plain `btn`: stacked under an identical-looking Request button
        // it read as part of the same control, which is how t220 could see a grade it could not stop.
        <button
          type="button"
          className="btn btn--warn"
          disabled={stopping}
          onClick={() => void stop()}
          title="Stops this read-only grade. The task and any completed reviews are unchanged."
        >
          {stopping ? 'stopping…' : 'Stop grading'}
        </button>
      )}
      <div className="side-note dim">
        {pending
          ? `Grading since ${when(pending.createdAt)}. Stop grading ends it; the task and every completed review are unchanged.`
          : eligibility === null
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
 * A human's overall verdict sits beside, never inside, the peer-review rubric.
 *
 * ⛔ One rating per task, and it is editable: the daemon caps `manual_reviews` at one row per task
 * (`createManualReview`), so this box is either the form for a first rating or the stored one with
 * Edit and Delete. Editing reuses the same select and textarea, pre-filled, and Save goes to
 * `review.manual.update` rather than creating a second row.
 */
function ManualReviewBox({
  task,
  reviews,
  refresh
}: {
  task: Task
  reviews: ManualReview[]
  refresh: () => Promise<void>
}): React.JSX.Element | null {
  const existing = reviews[0] ?? null
  const [score, setScore] = useState('')
  const [explanation, setExplanation] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const finished = task.status === 'completed' || task.status === 'cancelled'
  if (!finished) return null

  const beginEdit = () => {
    if (!existing) return
    setScore(String(existing.score))
    setExplanation(existing.explanation)
    setFailure(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setScore('')
    setExplanation('')
    setFailure(null)
  }

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const result = existing
        ? await rpc('review.manual.update', { reviewId: existing.id, score: Number(score), explanation })
        : await rpc('review.manual.create', { taskId: task.id, score: Number(score), explanation })
      if (result.ok) {
        setScore('')
        setExplanation('')
        setEditing(false)
      } else {
        setFailure(result.reason)
      }
      await refresh()
    } catch (err) {
      setFailure(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!existing) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await rpc('review.manual.delete', { reviewId: existing.id })
      if (!result.ok) setFailure(result.reason)
      else setEditing(false)
      await refresh()
    } catch (err) {
      setFailure(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const form = (
    <>
      <select
        className="reassign-select quality-review-select"
        aria-label="Your quality rating"
        value={score}
        disabled={busy}
        onChange={(event) => setScore(event.target.value)}
      >
        <option value="">Rate the agent’s work…</option>
        {Array.from({ length: 11 }, (_, value) => (
          <option key={value} value={String(value)}>{value} / 10</option>
        ))}
      </select>
      <textarea
        className="compose-input"
        rows={2}
        value={explanation}
        disabled={busy}
        placeholder="Briefly explain this rating…"
        onChange={(event) => setExplanation(event.target.value)}
      />
      <div className="manual-review-actions">
        {existing && (
          <button type="button" className="btn" disabled={busy} onClick={cancelEdit}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy || score === '' || !explanation.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'saving…' : existing ? 'Save changes' : 'Save your review'}
        </button>
      </div>
    </>
  )

  return (
    <div className="detail-side-box">
      <div
        className="side-label"
        title="Your overall 0–10 rating and explanation. It counts in this task’s quality score and in quality reporting, but does not use the peer-review rubric."
      >
        your review
      </div>
      {existing && !editing && (
        <div className="side-run">
          <div className="side-run-head">
            <strong className="num">{existing.score} / 10</strong>
            <span className="dim">{when(existing.createdAt)}</span>
          </div>
          <div className="side-note">{existing.explanation}</div>
          <div className="manual-review-actions">
            <button type="button" className="btn" disabled={busy} onClick={beginEdit}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn--danger btn--ghost"
              disabled={busy}
              title="Remove your rating. The task’s quality score is recomputed from any peer reviews that remain."
              onClick={() => void remove()}
            >
              {busy ? 'deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {(!existing || editing) && form}
      <div className="side-note dim">
        {existing
          ? 'One rating per task: edit it if you change your mind.'
          : 'This is an overall rating, not a seven-dimension rubric score.'}
      </div>
      {failure && <div className="side-note warn">{failure}</div>}
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
      {/* ⚠️ Only after a send, and one short line: the placeholder already says what the box does. */}
      {outcome === 'requeued' && <p className="compose-hint">Queued — same thread, same session where it can.</p>}
      {outcome === 'delivered' && <p className="compose-hint">Delivered into the running turn.</p>}
    </div>
  )
}

/**
 * Take this task out of the fleet's own statistics, or put it back.
 *
 * ⛔ **For a measurement that is wrong, not for a result somebody dislikes**, and the tooltip says
 * so because nothing else can stop it being used the other way. The case it was built for: t52
 * reported 639 minutes of agent time against a 9.8-minute median for the same model, because a run
 * reaped with *"orchestratord restarted"* carried ten and a half hours of daemon downtime inside its
 * span. That reading is now clamped at source; this is for the next one nobody has thought of yet.
 *
 * ⚠️ **Not a delete and not a hide.** The task keeps its thread, its runs, its price and its place
 * in every list. What stops is its contribution to Statistics, to the pace factor the router reads,
 * and to every quality aggregate.
 */
function StatsExclusionToggle({
  task,
  onChanged
}: {
  task: Task
  onChanged?: () => Promise<void>
}): React.JSX.Element {
  const excluded = task.excludedFromStats
  const { busy, note, run: toggle } = useAction(
    () => rpc('task.setStatsExcluded', { id: task.id, excluded: !excluded }),
    { onSuccess: onChanged }
  )

  return (
    <>
      <button
        type="button"
        className={`btn btn--xs ${excluded ? 'btn--primary' : 'btn--secondary'}`}
        disabled={busy}
        aria-pressed={excluded}
        onClick={() => void toggle()}
        title={
          excluded
            ? 'This task is being left out of Statistics, out of the pace factor the router reads, ' +
              'and out of every quality aggregate. Nothing else about it changed — the thread, the ' +
              'runs and the price are all still here. Press to count it again.'
            : 'Leave this task out of Statistics, out of the pace factor the router reads, and out ' +
              'of every quality aggregate. ⛔ For a measurement that is wrong — an active time no ' +
              'agent could have spent, a price attributed to the wrong window — and not for a ' +
              'result you would rather not see. The estimator still reads its tokens either way: a ' +
              'task excluded for an impossible duration still spent exactly what it spent.'
        }
      >
        {excluded ? 'excluded from stats' : 'counted'}
      </button>
      {note && <div className="note">{note}</div>}
    </>
  )
}

function DraftControls({
  task,
  initialPrompt,
  previewPrompt,
  onPromote,
  onUpdate,
  onDelete
}: {
  task: Task
  initialPrompt: string
  previewPrompt?: string
  onPromote: () => Promise<void>
  onUpdate: (title: string, prompt: string) => Promise<void>
  /** Called once the task is gone, so the pane leaves rather than re-reading a deleted row. */
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [busy, setBusy] = useState(false)
  /**
   * ⛔ **The one way out of a draft, and it was missing.** A draft filed by mistake could be edited
   * and filed, and nothing else — every other route to delete is on the Tasks table, which is not
   * where somebody who has just opened the draft is. Confirmed like the table's own delete, and
   * checked with `task.deleteCheck` first so a refusal is a sentence rather than a thrown RPC.
   */
  const [confirming, setConfirming] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const askDelete = async () => {
    setDeleteError(null)
    setBusy(true)
    try {
      const blockers = await rpc('task.deleteCheck', { id: task.id })
      if (!blockers.ok) {
        setDeleteError(blockers.reasons.map((r) => `• ${r}`).join('\n'))
        return
      }
      setConfirming(true)
    } catch (err) {
      setDeleteError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await rpc('task.delete', { id: task.id })
      setConfirming(false)
      onDelete()
    } catch (err) {
      setConfirming(false)
      setDeleteError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmDialog = confirming ? (
    <div className="confirm-shade" role="presentation">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-draft-title"
        aria-describedby="delete-draft-copy"
      >
        <h3 id="delete-draft-title">Delete t{task.seq}?</h3>
        <p id="delete-draft-copy">
          This draft has not been dispatched, so nothing has run on it and there is nothing to keep.
          It is removed from your task list.
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
            No
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Yes, delete'}
          </button>
        </div>
      </div>
    </div>
  ) : null

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
        {deleteError && <div className="alert">{deleteError}</div>}
        {confirmDialog}
        <div className="draft-card-foot">
          <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <div className="ask-actions">
            <button
              className="btn btn--danger"
              disabled={busy}
              title="Delete this draft. Nothing has run on it."
              onClick={() => void askDelete()}
            >
              Delete draft
            </button>
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
        {deleteError && <div className="alert">{deleteError}</div>}
        {previewPrompt && (
          <div className="draft-preview-prompt">
            <PromptChip prompt={previewPrompt} title="Prompt to be sent to agent" />
          </div>
        )}
      </div>
      <div className="draft-banner-actions">
        <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
          Edit draft
        </button>
        <button
          className="btn btn--danger"
          disabled={busy}
          title="Delete this draft. Nothing has run on it, so there is nothing to keep."
          onClick={() => void askDelete()}
        >
          Delete draft
        </button>
        <button className="btn btn--primary" disabled={busy} onClick={() => void fileTask()}>
          {busy ? 'Filing…' : 'File task'}
        </button>
      </div>
      {confirmDialog}
    </div>
  )
}
