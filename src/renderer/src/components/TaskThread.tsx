import { sessionEnded } from '@shared/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  FINISH_LABELS,
  FINISH_ORDER,
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
import { rpc, useActivity, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { ImageChips, usePastedImages } from '../lib/pasteimages'
import { conversationIdFor } from '../lib/conversation'
import { SettingButtonSelect, type SettingOption } from './SettingButtonSelect'
import { TaskQuestions } from './Questions'
import { AddDependency, candidatesFor, DependencyList, useTaskCandidates } from './Dependencies'
import { showsLiveOutput } from '../lib/live'
import { duration, tokens, when } from '../lib/format'
import { effortLabel, modelLabel } from '../lib/modelname'
import {
  activeTime,
  activeTimeTitle,
  CANCELLABLE,
  chronologicalRuns,
  elapsed,
  holdLine,
  IN_FLIGHT,
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
  activity: Array<{ text: string; ts: number }>
  /** How many tasks are held at `blocked` waiting on this one. Counted by the daemon. */
  blocking: number
  dependencies?: Task[]
  dependents?: Task[]
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
 * ⛔ **Two numbers, not one.** `requested` is what the dispatch asked for — the task's pin, or the
 * account's default, or nothing at all; `observed` is what the agent's own transcript says answered
 * each turn. They are different questions and they disagree in the cases that matter: a CLI that
 * fell back when a model was busy, an operator who typed `/model` inside the session, an alias like
 * `opus` resolving to a dated id. Showing one number would pick a side and be wrong half the time.
 *
 * ⚠️ Nothing at all until a turn has been metered. An empty session has no observation yet, and
 * inventing "probably the default" here is exactly the guess the rest of this file refuses to make.
 */
function ModelFact({
  session,
  requested
}: {
  session: Session | null
  requested: { model: string | null; effort: string | null; source: string }
}): React.JSX.Element {
  const observed = session?.model ?? null
  const observedEffort = session?.effort ?? null

  // ⚠️ The CLI's own default is a real answer and reads as one. "—" would look like a broken field.
  const asked = modelLabel(requested.model, requested.effort) ?? 'CLI default'
  const differs = observed !== null && requested.model !== null && observed !== requested.model
  const effortDiffers =
    observedEffort !== null && requested.effort !== null && observedEffort !== requested.effort

  return (
    <>
      {/* ⛔ The id is in the tooltip on both lines. This field is the one an operator reads when a
          run went somewhere unexpected, so the exact string has to stay recoverable — a name written
          for reading may not be the thing that was sent. */}
      <span
        title={`${requested.model ?? 'no model chosen'} — asked for at launch, ${requested.source}`}
      >
        {asked}
      </span>
      {(observed || observedEffort) && (differs || effortDiffers) && (
        <div
          className="tbl-sub warn"
          title={`${observed ?? requested.model ?? ''} — what the transcript says actually answered each turn`}
        >
          running {modelLabel(observed, observedEffort) ?? asked}
        </div>
      )}
      {(observed || observedEffort) && !differs && !effortDiffers && (
        <div className="tbl-sub dim" title="confirmed by the transcript, turn by turn">
          confirmed by the transcript
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
    dependents = []
  } = detail
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
  const resolved = resolveModelChoice(task.constraints, assigned, canSetEffort)
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
                        {IN_FLIGHT.has(dep.status) && <Working />}
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
          <TaskQuestions taskId={task.id} />

          {detail.previewPrompt && task.status !== 'draft' && task.status !== 'running' && (
            <div className="thread-preview-prompt">
              <PromptDisclosure
                prompt={detail.previewPrompt}
                label="Prompt to be sent on next dispatch"
              />
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
              <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>
                {statusLabel(task)}
                {IN_FLIGHT.has(task.status) && <Working />}
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
            {task.holdReason && (
              <Fact label={task.status === 'awaiting_human' ? 'wants' : 'waiting on'}>
                {holdLine(task, now)}
              </Fact>
            )}
            {/* ⛔ Offered only where the hold is one this fleet invented. See `QuotaOverride`. */}
            <QuotaOverride task={task} onChanged={refresh} />
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
              <ModelFact session={liveSession ?? null} requested={requestedModel} />
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
          </div>

          {/* ⛔ The history box, and compactions belong in it rather than under the facts above.
              A compaction and a run are the same kind of thing to the operator - something that
              *happened to this task*, at a time, with a cost - and the box above is what the task
              *is*: its status, its settings, its totals. Filed there, the compaction ledger grew the
              settings box downward until the runs it should be read against were off the screen. */}
          {(runs.length > 0 || compactions.length > 0) && (
            <div className="detail-side-box">
              {runs.length > 0 && (
                <>
                  {/* ⚠️ The label carries the distinction, because "completed" here beside
                      "awaiting_human" above is the thing that reads as a contradiction. A run is one
                      attempt; whether the *task* is done is a separate question. */}
                  <div
                    className="side-label"
                    title="One attempt each. A run finishing says the agent stopped cleanly — not that the task is done, which is what the status above answers."
                  >
                    runs · attempts, not outcomes
                  </div>
                  {chronologicalRuns(runs).map((run) => (
                    <RunRow key={run.id} run={run} sessions={sessions} fleet={fleet} now={now} />
                  ))}
                </>
              )}
              {compactions.length > 0 && (
                /* ⛔ Its own block rather than a line inside a run, because a compaction is not
                   scoped to one attempt: the session outlives the run, and the shrink it bought is
                   still paying out on the next one. The label says what it bought, because a
                   compaction with no before-and-after is a claim rather than a measurement.
                   ⚠️ The rule above it is only drawn when there are runs to be separated from. */
                <div className={runs.length > 0 ? 'side-runs' : undefined}>
                  <div
                    className="side-label"
                    title="Each time this task's context was compacted, and what it left behind. A compaction costs one expensive turn and makes every turn after it read a smaller prefix."
                  >
                    compactions · context before → after
                  </div>
                  {compactions.map((c) => (
                    <CompactionRow key={c.id} compaction={c} now={now} />
                  ))}
                </div>
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
                  {m.attachments.map((a) => (
                    <MessageImage key={a.id} attachment={a} />
                  ))}
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
  const adapterOptions = modelOptions.find((o) => o.adapterId === selectedWorker?.adapterId)
  const offeredModels = adapterOptions?.models ?? []
  const canSetEffort = adapterOptions?.selectableEffort ?? false
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

  // ⛔ Offered only when the thing that stopped it is a conflict, and read from `holdReason`
  // because that is where `landTask`'s failure is actually recorded. A *fix the conflict* button on
  // a task that failed its checks would send an agent to rebase something that rebases fine.
  const conflicted = /conflict/i.test(task.holdReason ?? '')
  const checksFailed = /checks? failed|verification failed/i.test(task.holdReason ?? '')
  const canReland =
    Boolean(task.branch) &&
    !conflicted &&
    !checksFailed &&
    /landing failed|not merged|waited for a turn|uncommitted in trunk|would not fast-forward|trunk/i.test(task.holdReason ?? '')

  const handleResolveConflict = async () => {
    setBusy(true)
    try {
      await rpc('task.resolveConflict', { id: task.id })
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const handleResolveChecks = async () => {
    setBusy(true)
    try {
      await rpc('task.resolveChecks', { id: task.id })
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
          title="Records your judgement that this is finished. ⚠️ Nothing verified the work — task_complete remains the only signal that an agent finished."
          disabled={busy}
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
          disabled={busy}
          onClick={() => void onStop()}
        >
          Stop here
        </button>
        <span className="decide-what">
          <strong>Not finished.</strong> Parks it as <span className="mono">paused_user</span>, which
          Resume picks back up. {holds} The branch and the workspace are kept.
        </span>
      </div>

      {conflicted && (
        <div className="decide-option">
          <button
            className="btn btn--primary"
            title="Dispatches a run on this thread that rebases the branch onto the landing target, resolves the conflicts and reports complete again."
            disabled={busy}
            onClick={() => void handleResolveConflict()}
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
            onClick={() => void handleResolveChecks()}
          >
            Fix &amp; retry
          </button>
          <span className="decide-what">
            <strong>Project checks failed.</strong> Sends the check output back to the agent to fix
            the lint, type, or test errors, commit the fix on <span className="mono">{task.branch}</span>, and report
            complete again — same thread, preserving existing context.
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
                ...fleet.map((e) => ({
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
                    setSelectedModel(w?.defaultModel ?? '')
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
                    label: selectedWorker?.defaultModel
                      ? `account default (${modelLabel(selectedWorker.defaultModel)})`
                      : 'CLI default model'
                  },
                  // ⚠️ The label is written for a person; the value stays the id, which is what is
                  // sent to the CLI and what the cost model is keyed by.
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
 * Run this now anyway, at 92% of a window.
 *
 * ⛔ **Shown only when the hold is one the fleet invented for itself.** The water mark is a caution
 * computed from a reading — the vendor served every turn up to it — and on a task pinned to one
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
  const held = task.status === 'ready' && /% of its .* window/.test(task.holdReason ?? '')
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now
  if (!held && !live) return null

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
          <button
            className="btn btn--warn"
            disabled={busy}
            title="Dispatch this task even though the account is at or past 92% of its window. Expires when that window resets. ⚠️ A turn the vendor actually refuses still stops the run, and so does the window boundary itself."
            onClick={() => void set(false)}
          >
            Run now anyway
          </button>{' '}
          <span className="dim">spends into the window this task is waiting on</span>
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
        <span
          className={outcomeClass(run.outcome)}
          title={
            run.outcome === 'blocked'
              ? 'The agent stopped to ask something rather than because anything went wrong. ' +
                'Answer it and the task carries on.'
              : undefined
          }
        >
          {run.outcome ?? 'running'}
        </span>
        <span
          className="num dim"
          title={
            run.blockedMs > 0
              ? `${duration((run.endedAt ?? now) - run.startedAt - run.blockedMs)} working, ` +
                `${duration(run.blockedMs)} of it waiting on a person.`
              : 'Nothing waited on a person during this attempt, so all of it was work.'
          }
        >
          {duration((run.endedAt ?? now) - run.startedAt - run.blockedMs)}
        </span>
        {/* ⛔ Named only when there is something to name. A run that never stopped for anybody
            should not carry a "blocked 0s" that implies the measurement is interesting. */}
        {run.blockedMs > 0 && (
          <span className="dim" title="Time this attempt spent waiting on a question or an approval.">
            +{duration(run.blockedMs)} waiting
          </span>
        )}
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
      {run.prompt && (
        <div className="side-run-prompt">
          <PromptDisclosure prompt={run.prompt} label={`Run ${run.id.slice(0, 8)} prompt`} />
        </div>
      )}
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
function CompactionRow({
  compaction: c,
  now
}: {
  compaction: Compaction
  now: number
}): React.JSX.Element {
  const landed = c.landedAt !== null
  const pending = !landed && now - (c.askedAt ?? c.ts) < 4 * 60 * 1000
  const saved =
    c.preTokens !== null && c.postTokens !== null && c.preTokens > c.postTokens
      ? c.preTokens - c.postTokens
      : null
  return (
    <div className="side-run">
      <div className="side-run-head">
        <span className="mono" title={`Session ${c.sessionId}`}>
          {c.sessionId.slice(0, 8)}
        </span>
        <span
          className="dim"
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
          {landed ? 'compacted' : pending ? 'asked' : 'never landed'}
        </span>
        {c.durationMs !== null && <span className="num dim">{duration(c.durationMs)}</span>}
      </div>
      <div className="side-run-body num">
        <span
          title={
            'Context before the compaction, and after it. The second number is measured by the ' +
            'first turn that follows - until one does, it is unknown rather than zero.'
          }
        >
          {tokens(c.preTokens)} → {tokens(c.postTokens)}
        </span>
        {saved !== null && (
          <span className="ok" title="Tokens every subsequent turn no longer has to read.">
            {tokens(saved)} smaller
          </span>
        )}
      </div>
      {c.reason && <div className="side-run-why">{c.reason}</div>}
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
            ? 'This task’s agent cannot be asked to compact — the capability is declared by the ' +
              'adapter, and only Claude Code declares it today. The setting is recorded either way ' +
              'and takes effect if this task moves to a worker that can.'
            : 'Whether the cache clock may compact this conversation, overriding Settings > Global. ' +
              'It is permission, not an instruction: the clock still decides on its own terms — ' +
              'context past the ~2h break-even, enough growth since the last compaction, and a ' +
              'prefix worth reading while it is still warm. Unlike the settings above it applies to ' +
              'the conversation this task is in now, from the next tick.'
        }
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
  const pinnable = fleet.filter((e) => e.worker.enabled).map((e) => e.worker)
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
