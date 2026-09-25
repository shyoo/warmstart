import {
  isPlanExecute,
  taskTypeLabel,
  isTrunkBlockedReason,
  resolveModelChoice,
  resolveRetryCauses,
  TERMINAL_STATUSES,
  type Compaction,
  type ResolveRetryCause,
  type ResolvedModelChoice,
  type Run,
  type Task
} from '@shared/tasks'
import type { ModelOptions, Session } from '@shared/protocol'
import type { QualityReview } from '@shared/review'
import { autoModelCount, autoRoutes, type ModelRoute } from '@shared/modelroutes'
import type { FleetEntry } from './daemon'
import { duration } from './format'
import { modelLabel } from './modelname'
import { Fragment } from 'react'

/**
 * How a task is drawn, shared by the list and the thread.
 *
 * ⛔ **One definition, two screens.** These used to be private to `Tasks.tsx`, which was fine while
 * the table and the detail pane were the same file. They are not any more — the thread is its own
 * route now — and a status colour or a worker name that differed between the row you clicked and the
 * page it opened would be the kind of discrepancy an operator spends ten minutes not trusting.
 */

/**
 * Who, if anyone, a status is waiting on — the one question the colour answers.
 *
 * - `agent` (blue): an agent or the tool is actively doing the work — running, dispatching, grading,
 *   landing, winding down.
 * - `human` (yellow): nothing moves until a person answers. Only `awaiting_human`.
 * - `waiting` (grey): neither — the task is parked and a trigger (a quota window, a prerequisite, a
 *   clock, a landing slot, a resume) moves it later. ⛔ Not yellow: `paused_user` and `paused_quota`
 *   used to share the warning colour with nothing to do about either, and a colour that means "act"
 *   on a row that needs no act trains a person to ignore the one that does (t668).
 * - `done` (green) and `error` (red).
 */
export type StatusAttention = 'agent' | 'human' | 'waiting' | 'done' | 'error'

export const STATUS_ATTENTION: Record<string, StatusAttention> = {
  landing: 'agent',
  grading: 'agent',
  running: 'agent',
  assigned: 'agent',
  ready: 'agent',
  queued: 'agent',
  cancelling: 'agent',
  completed: 'done',
  failed: 'error',
  awaiting_human: 'human',
  blocked: 'waiting',
  scheduled: 'waiting',
  draft: 'waiting',
  paused_user: 'waiting',
  paused_quota: 'waiting',
  landing_queued: 'waiting',
  cancelled: 'waiting'
}

const ATTENTION_TONE: Record<StatusAttention, string> = {
  agent: 'state-running',
  human: 'state-warn',
  waiting: 'state-idle',
  done: 'state-ok',
  error: 'state-danger'
}

/** Hover text on a status pill: says outright whether the person is the one being waited on. */
export const ATTENTION_HINT: Record<StatusAttention, string> = {
  agent: 'Agent working — no action needed',
  human: 'Waiting on you — human action needed',
  waiting: 'Parked — no action needed; resumes on its own trigger',
  done: 'Finished',
  error: 'Failed'
}

export const STATUS_TONE: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_ATTENTION).map(([status, attention]) => [status, ATTENTION_TONE[attention]])
)

/**
 * What a status is called where a person can see it.
 *
 * ⛔ Renamed here, not in the domain. `assigned` means something precise to the scheduler and to
 * cancel.ts, and changing it there to suit a table would be the tail wagging the dog. But it is the
 * state a task is in while a workspace is being claimed, a branch checked out and the project's
 * prepare hook run — which is *dispatching*, and is the part of the wait that most needs a name.
 */
export const STATUS_LABEL: Record<string, string> = { assigned: 'dispatching', landing_queued: 'queued to land' }

/**
 * The same rename, asked per task, because one status covers two situations a person tells apart.
 *
 * ⛔ Still not a status. `setHoldReason` in tasks.ts argues the case: the task really is `ready` -
 * the scheduler would dispatch it this second if a worker could take it - and inventing a domain
 * status for "ready but nothing free" would put a lie in the DAG to paper over a gap in the UI. So
 * the *word* changes here and the DAG does not.
 *
 * ⚠️ Driven by `holdReason` rather than by counting workers, because the scheduler has already done
 * that arithmetic and written down its answer. A renderer that re-derived "is anything free?" would
 * be a second opinion on a question with an authoritative one, and the two would disagree the first
 * time a gate the UI does not know about (quota, capability, a missing baseline) held a task back.
 * ⭐ Measured 2026-08-29: t22 sat at `ready` for seven minutes with `Antigravity at capacity`
 * written on it, and read as a task waiting on the operator to press something.
 *
 * ⭐ `landing` (t353) is the same kind of word: the daemon's live `landing` flag while the task is
 * rebasing, running the project's checks and merging. Flow already said so; the table and the thread
 * went on saying `running`, or `completed` before the merge had happened. Not a domain status either —
 * see `landingstate.ts` for why a landing must not be written to the row.
 */
export function statusLabel(
  task: Pick<Task, 'status' | 'holdReason' | 'gradingWorkerId' | 'landing'>
): string {
  if (task.landing) return 'landing'
  if (task.gradingWorkerId) return 'grading'
  if (task.status === 'ready' && task.holdReason) return 'queued'
  return STATUS_LABEL[task.status] ?? task.status
}

/** Who a task is waiting on, by the same precedence as `statusLabel` so the word and its tone agree. */
export function statusAttention(
  task: Pick<Task, 'status' | 'gradingWorkerId' | 'landing'>
): StatusAttention | null {
  return STATUS_ATTENTION[task.landing ? 'landing' : task.gradingWorkerId ? 'grading' : task.status] ?? null
}

/** The colour beside `statusLabel`. */
export function statusToneFor(task: Pick<Task, 'status' | 'gradingWorkerId' | 'landing'>): string {
  const attention = statusAttention(task)
  return attention ? ATTENTION_TONE[attention] : ''
}

/** The hover text beside `statusLabel`. */
export function statusHintFor(task: Pick<Task, 'status' | 'gradingWorkerId' | 'landing'>): string | undefined {
  const attention = statusAttention(task)
  return attention ? ATTENTION_HINT[attention] : undefined
}

/**
 * The hold, and how long it has left to run.
 *
 * ⛔ **Because "at 92% of its 5h window" does not say whether that means five minutes or five
 * hours**, and those are different situations with different answers — one is worth waiting out and
 * the other is worth overriding, reassigning or going to bed over. The scheduler has known the reset
 * time all along; since 2026-09-01 it writes it down as `holdUntil` instead of discarding it, and
 * this is where a person finally reads it. Measured on t71: held against a window resetting 2h29m
 * later, shown as a sentence with no clock in it.
 *
 * ⚠️ Nothing is appended where there is no clock — "at capacity" ends when a run ends, which is not
 * a time anybody can name, and inventing a countdown for it would be worse than the silence.
 */
export function holdLine(
  task: Pick<Task, 'status' | 'holdReason' | 'holdUntil'>,
  now = Date.now()
): string | null {
  // A completed task is no longer waiting on anything. `holdReason` is retained as history, so a
  // landing failure resolved separately can still be present after completion; drawing it here
  // turns that old event into the task's apparent current state. Failed and cancelled tasks keep
  // their reasons because those can explain how they ended.
  if (task.status === 'completed') return null
  if (!task.holdReason) return null
  const left = task.holdUntil ? task.holdUntil - now : 0
  if (left <= 0) return task.holdReason
  return `${task.holdReason} — earliest retry in ${duration(left)}`
}

/** Statuses where an agent is actively executing work. */
export const WORKING_STATUSES = new Set(['running'])

export function isWorking(task: Pick<Task, 'status' | 'gradingWorkerId' | 'landing'>): boolean {
  return task.status === 'running' || Boolean(task.gradingWorkerId) || Boolean(task.landing)
}

export const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota',
  'landing_queued'
])

/**
 * Statuses where a Stop button belongs beside the composer, next to Send.
 *
 * ⛔ **A strict subset of `CANCELLABLE`, and it has to stay one.** A Stop offered on a status the
 * daemon will not cancel is not a button, it is a lie: `cancelTask` returns the task untouched for
 * anything outside its own set, so the press would refresh the pane and change nothing, and the
 * operator would press it again. The subset test in `taskview.test.ts` is what keeps the two
 * honest if either list moves.
 *
 * ⭐ `awaiting_human` is in since t669. Stop and Complete used to live on the *your call* card above
 * the composer, which a conversation drew after every reply; Stop now sits here beside Send, parks
 * the task as `paused_user`, and Complete takes its place there. `paused_quota` is left out: it is
 * already stopped, and the quota card above the composer carries its own choices.
 *
 * ⭐ `blocked` is in, and it is the least obvious one. A blocked task is not idle — it is admitted
 * the moment its prerequisites land, with no further say from anybody — so the only moment to take
 * it off that track is before the prerequisites finish, which is exactly while it reads `blocked`.
 */
export const STOPPABLE = new Set(['ready', 'blocked', 'scheduled', 'assigned', 'running', 'awaiting_human'])

/**
 * Whether a task is held by quota or warning of quota preemption, needing operator attention / override.
 * Active overrides are excluded because the quota gate is already lifted.
 */
export function isQuotaGated(
  task: Pick<Task, 'status' | 'holdReason' | 'quotaPreemptWarning' | 'quotaOverrideUntil'> & {
    deletedAt?: number | null
  },
  now = Date.now()
): boolean {
  if (task.deletedAt) return false
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
  if (task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now) return false

  if (task.status === 'paused_quota') return true
  if (task.status === 'ready' && /% of its .* window/i.test(task.holdReason ?? '')) return true
  if (task.status === 'running' && task.quotaPreemptWarning !== null) return true
  return false
}

/**
 * Whether a task has any quota gate state to show (either currently gated or live overridden).
 */
export function hasQuotaGate(
  task: Pick<Task, 'status' | 'holdReason' | 'quotaPreemptWarning' | 'quotaOverrideUntil'> & {
    deletedAt?: number | null
  },
  now = Date.now()
): boolean {
  if (task.deletedAt) return false
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false

  const held =
    (task.status === 'ready' && /% of its .* window/i.test(task.holdReason ?? '')) ||
    task.status === 'paused_quota'
  const warning = task.status === 'running' && task.quotaPreemptWarning !== null
  const live = task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now
  return held || Boolean(warning) || live
}

export type ProjectWorkState = 'working' | 'needs_attention' | 'paused' | 'pending_pr' | 'idle'

/**
 * Computes the work state for a project from the same buckets as `projectTaskCounts`, so the dot
 * and the numbers beside it never disagree:
 * - 'working': at least one task is in the agent bucket (blue).
 * - 'needs_attention': at least one task is awaiting a human (yellow).
 * - 'pending_pr': at least one pending pull request has been opened and not landed yet.
 * - 'paused': nothing is moving and nobody is waited on, but unfinished work is parked (grey).
 * - 'idle': no unfinished work.
 *
 * Precedence rule: working > needs_attention > pending_pr > paused.
 */
export function projectWorkState(
  tasks: ReadonlyArray<Pick<Task, 'status'> & Partial<Pick<Task, 'gradingWorkerId' | 'landing' | 'deletedAt'>>>,
  hasPendingPr = false
): ProjectWorkState {
  const counts = projectTaskCounts(tasks)
  if (counts.running > 0) return 'working'
  if (counts.awaiting > 0) return 'needs_attention'
  if (hasPendingPr) return 'pending_pr'
  if (counts.waiting > 0) return 'paused'
  return 'idle'
}

/**
 * Counts a project's unfinished tasks for the navigation pane, one number per `StatusAttention`:
 * - 'running': the agent bucket (blue) — running, dispatching, queued, grading, landing, cancelling.
 * - 'awaiting': the human bucket (yellow) — the only number that asks something of the person.
 * - 'waiting': the parked bucket (grey) — paused, blocked, quota-held, scheduled, draft.
 * Completed, failed, cancelled and deleted tasks are not counted.
 */
export function projectTaskCounts(
  tasks: ReadonlyArray<Pick<Task, 'status'> & Partial<Pick<Task, 'gradingWorkerId' | 'landing' | 'deletedAt'>>>
): {
  running: number
  awaiting: number
  waiting: number
} {
  let running = 0
  let awaiting = 0
  let waiting = 0
  for (const t of tasks) {
    if (t.deletedAt || TERMINAL_STATUSES.has(t.status)) continue
    const attention = statusAttention(t)
    if (attention === 'agent') running++
    else if (attention === 'human') awaiting++
    else if (attention === 'waiting') waiting++
  }
  return { running, awaiting, waiting }
}

/** Only unfinished buckets with work appear in the project's sidebar count. */
export function ProjectTaskCount({ counts }: { counts: ReturnType<typeof projectTaskCounts> }): React.JSX.Element | null {
  const visible = ([
    ['running', counts.running],
    ['awaiting', counts.awaiting],
    ['waiting', counts.waiting]
  ] as const).filter(([, count]) => count > 0)
  if (visible.length === 0) return null

  return (
    <span
      className="nav-count num"
      title={`${counts.running} running · ${counts.awaiting} awaiting you (human action needed) · ${counts.waiting} paused, blocked, quota-held or scheduled (no action needed)`}
    >
      {visible.map(([bucket, count], index) => (
        <Fragment key={bucket}>
          {index > 0 && '/'}
          <span className={`nav-count-${bucket}`}>{count}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** Small indicator dot displayed before the project name in the navigation pane. */
export function ProjectDot({
  state,
  onClick,
  title: customTitle
}: {
  state: ProjectWorkState
  onClick?: (e: React.MouseEvent) => void
  title?: string
}): React.JSX.Element {
  const defaultTitle =
    state === 'working'
      ? 'Tasks in progress'
      : state === 'needs_attention'
        ? 'Human action needed'
        : state === 'paused'
          ? 'Parked — paused, blocked or quota-held; no action needed'
          : state === 'pending_pr'
            ? 'Pending pull request — click to view'
            : 'Idle'
  const title = customTitle ?? defaultTitle
  return (
    <span
      className={`project-dot project-dot--${state}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    />
  )
}

/** Three dots that indicate an agent is actively working on a task. */
export function Working(): React.JSX.Element {
  return (
    <span className="working" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * Which **account** this task is on, or was on.
 *
 * ⛔ Never "you". The column exists so that which account is spending on a task is visible without a
 * click — that is what made a misroute findable at all — and it used to be blanked by the very thing
 * it was there to survive: nine hand-off sites set `assignee` to `human` the moment a task started
 * waiting on a person, so a task ClaudeSecond had run rendered as worked on by *you*, and stayed
 * that way after it was marked done. A person answering a question did not do the work and did not
 * pay for it.
 *
 * ⚠️ `ranOn` first, `assignee` only as the before-anything-ran case: a task assigned a moment ago has
 * an account and no runs yet, which is a real state and reads as one. Who is being waited on is the
 * *status*, and it is said there.
 */
export function assigneeLabel(task: Task, fleet: FleetEntry[]): string {
  const account =
    task.ranOn ?? (task.assignee === 'human' || task.assignee === 'controller' ? null : task.assignee)
  if (!account) return task.assignee === 'controller' ? 'controller' : '—'
  return fleet.find((f) => f.worker.id === account)?.worker.label ?? account.slice(0, 8)
}

/**
 * Which **model** that account used, or would use, under the account's own name.
 *
 * ⛔ **One column, two facts, in that order.** The account and the model are not independent — a
 * model id belongs to one CLI, so `Sonnet 5 Med` under *Antigravity* would be a routing bug and
 * under *ClaudeSecond* is a Tuesday. Read as two separate columns an operator has to join by eye,
 * that pairing is exactly what goes unnoticed; stacked, the wrong one is obvious.
 *
 * ⚠️ **What ran beats what would run.** A task that has run reports its last run's model, so the
 * cell keeps saying what actually spent the tokens after somebody changes the account default. A
 * task that has not run yet has no such fact, and reports what the next dispatch would ask for -
 * resolved by `resolveModelChoice`, the same function the scheduler calls, so this cannot promise
 * an inheritance the dispatch would not perform.
 *
 * ⚠️ Effort comes from the resolution either way: a run records the model it was given and not the
 * level, and on the adapters where the level matters it is part of the model id anyway.
 *
 * ⛔ **A prediction the router has not made yet is not shown as a model name.** On a worker with a
 * routable-model allowlist `chooseTarget` scores each allowed model as its own candidate, so the
 * account's default is not what dispatch will pick — a task sitting in `assigned` read *GPT 5.6 Sol*
 * for the seconds before its first run recorded *GPT 5.6 Terra*, which looks exactly like a model
 * being switched under the operator. `routerPicksModel` is the same test the thread pane applies;
 * the cell says the choice is pending instead of naming the loser.
 *
 * Returns null where there is nothing true to say - no account, or an account that has never been
 * told a model and never run one. ⛔ The cell then shows the worker alone rather than a placeholder:
 * "the CLI picks" is the honest reading, and it is already what the detail pane says at length.
 */
export type Routed = Pick<Task, 'ranOn' | 'ranModel' | 'assignee' | 'constraints'>

export interface ModelLine {
  /** What the cell draws. */
  label: string
  /** The exact model id, for the tooltip — null while the router has yet to choose one. */
  id: string | null
  /** True where a run actually used this model, false where it is a prediction. */
  ran: boolean
  /** The router scores this account's routable models at dispatch, so no id can be named yet. */
  undecided: boolean
  /** How many models it will be scoring, for the tooltip. Zero unless `undecided`. */
  routable: number
}

/**
 * Whether the *router*, not this resolution, decides the model of the next dispatch.
 *
 * ⛔ **One predicate, both screens.** The list cell and the thread's model row ask the same
 * question, and the whole point of asking it is that `resolveModelChoice` answers a different one —
 * what the *account* defaults to. Two copies of this test would drift, and the symptom of the drift
 * is a row and the page it opens naming different models for the same unstarted task.
 *
 * ⚠️ A task-level pin still wins: a pin is a mandate the router does not touch. And
 * `modelPolicy: 'inherit'` is a task-level answer too, even though it names no model — the scheduler
 * is told to take the account's default and score nothing, so the default *is* what runs next.
 */
export function routerPicksModel(
  constraints: Task['constraints'],
  worker: { modelRoutes?: ModelRoute[] | null } | null | undefined,
  modelSource: ResolvedModelChoice['modelSource']
): boolean {
  return modelSource !== 'task' && constraints.modelPolicy !== 'inherit' && autoRoutes(worker).length > 0
}

export function modelLine(
  task: Routed,
  fleet: FleetEntry[],
  modelOptions: ModelOptions[]
): ModelLine | null {
  const account = task.ranOn ?? task.constraints.workerId ?? task.assignee
  const entry = fleet.find((f) => f.worker.id === account) ?? null
  const options = modelOptions.find((o) => o.adapterId === entry?.worker.adapterId) ?? null
  const resolved = resolveModelChoice(
    task.constraints,
    entry?.worker,
    options?.selectableEffort ?? false,
    entry?.quota
  )
  // ⚠️ Only where nothing has run. `ranModel` is a measurement, and a measurement outranks the
  // question of who would choose next — that is the "what ran beats what would run" rule above.
  if (task.ranModel === null && routerPicksModel(task.constraints, entry?.worker, resolved.modelSource)) {
    const label = task.constraints.modelClass ? `router picks (${task.constraints.modelClass})` : 'router picks'
    return {
      label,
      id: null,
      ran: false,
      undecided: true,
      routable: autoModelCount(entry?.worker)
    }
  }
  const id = task.ranModel ?? resolved.model
  if (!id) return null
  // ⛔ No effort beside a model that has no levels. `resolveModelChoice` inherits the account's
  // default effort independently of the model — which is right, and which on `claude-haiku-4-5`
  // (no levels at all) rendered *Haiku 4.5 Med* for a level the dispatch does not send.
  // ⚠️ Only where the options actually describe this model. A list that has not arrived, or one
  // whose adapter failed to price, knows nothing about its levels — and silence there is not zero.
  const spec = options?.models.find((m) => m.id === id) ?? null
  const label = modelLabel(id, spec && spec.effortLevels.length === 0 ? null : resolved.effort)
  if (!label) return null
  return { label, id, ran: task.ranModel !== null, undecided: false, routable: 0 }
}

/**
 * The same "what ran beats what would run" rule, for the thread's `model` row.
 *
 * ⛔ **The headline is a measurement wherever one exists.** This pane used to lead with the
 * *resolution* — what a dispatch starting now would ask for — under a tooltip that said "asked for
 * at launch". Those are not the same sentence, and on an account with more than one model pool they
 * are routinely not the same model: the dispatch resolves the pool against a live quota reading and
 * takes the emptier one, so the ledger announced `Gemini 3.7 Flash Med` over a run whose every turn
 * was answered by 3.8. Nothing was wrong with the run; the row was reporting a prediction as a fact.
 *
 * ⚠️ **The prediction is still shown, as the second line, and only when it differs.** It is the
 * answer to a real question — *what would the next turn use?* — which is exactly what an operator
 * who has just re-pinned the model wants confirmed. Wording it as `next run asks for …` is the whole
 * fix: two lines that say what they are cannot contradict each other.
 *
 * ⚠️ Nothing observed at all until a turn has been metered, and then the resolution is the only
 * thing there is to show. An empty session has no observation, and inventing "probably the default"
 * is the guess the rest of this file refuses to make.
 */
export function modelFacts(input: {
  /** The live session's own reading, which is the only source that also knows the effort. */
  observed: { model: string | null; effort: string | null } | null
  /** What the last run recorded, for a task whose session has since closed. */
  ran: string | null
  requested: {
    model: string | null
    effort: string | null
    source: string
    /**
     * The router will choose the model, so there is nothing to name yet.
     *
     * ⛔ **Distinct from `model: null`, which means "the CLI picks".** Both are unknown here, but
     * they are unknown for opposite reasons and resolve at different moments — the CLI's default is
     * whatever that vendor ships, while an allowlisted worker's model is decided by `chooseTarget`
     * on the tick that dispatches. Collapsing the two would print "CLI default" for a fleet that has
     * explicitly listed the models it wants scored.
     */
    undecided?: boolean
  }
}): {
  headline: { text: string; title: string }
  note: { text: string; title: string; tone: 'warn' | 'dim' } | null
} {
  const { observed, ran, requested } = input
  const model = observed?.model ?? ran ?? null
  const effort = observed?.effort ?? null
  // ⚠️ The CLI's own default is a real answer and reads as one. "—" would look like a broken field.
  const asked = requested.undecided
    ? 'chosen at dispatch'
    : (modelLabel(requested.model, requested.effort) ?? 'CLI default')
  const askedTitle = `${requested.undecided ? 'not yet decided' : (requested.model ?? 'no model chosen')} — what the next run asks for, ${requested.source}`

  const seen = modelLabel(model, effort)
  if (!seen) return { headline: { text: asked, title: askedTitle }, note: null }

  const differs =
    !requested.undecided &&
    ((requested.model !== null && model !== null && requested.model !== model) ||
      (requested.effort !== null && effort !== null && requested.effort !== effort))
  return {
    headline: {
      text: seen,
      // ⛔ The id stays in reach on every line. This field is the one an operator reads when a run
      // went somewhere unexpected, and a name written for reading may not be the string that was
      // sent.
      title: `${model ?? ''} — what the transcript says actually answered each turn`
    },
    note: differs ? { text: `next run asks for ${asked}`, title: askedTitle, tone: 'warn' } : null
  }
}

/**
 * What kind of thing this task is, in the words the composer used to file it.
 *
 * ⛔ **A fact the thread was missing entirely.** A Plan & Split task's page looked exactly like an
 * ordinary task's — same header, same ledger — while behaving completely differently: it files
 * subtasks, waits for them, lands onto its own branch and is run twice. Somebody opening it had no
 * way to tell which of the two they were looking at, and the settings that only apply to one of them
 * were drawn for both.
 */
export function kindLabel(task: Pick<Task, 'kind' | 'mandate' | 'childDefaults'>): string {
  return taskTypeLabel(task)
}

/**
 * The settings every piece of this plan is filed with, as short lines for the ledger.
 *
 * ⛔ **Read from where the daemon reads them.** These are the same two fields `pieceConstraints`
 * resolves — `childDefaults` first, the planner's own `constraints.pieceConstraints` behind it — so
 * the pane cannot claim an account the split will not use. Two readers of one setting, each with its
 * own idea of precedence, is the failure this project has already paid for once.
 *
 * ⚠️ Accounts are named by their **labels**, resolved through the fleet, with the model each one was
 * given beside it. A worker id in a ledger is a string nobody recognises, and the pairing of account
 * and model is the thing being checked when somebody opens this at all.
 */
export function pieceSettings(
  task: Pick<Task, 'kind' | 'mandate' | 'childDefaults' | 'constraints' | 'priority'>,
  fleet: FleetEntry[]
): Array<{ label: string; value: string }> {
  if (task.kind !== 'plan') return []
  const defaults = task.childDefaults ?? {}
  const fallback = task.constraints?.pieceConstraints ?? {}
  const ids = (
    defaults.workerIds?.length
      ? defaults.workerIds
      : fallback.workerIds?.length
        ? fallback.workerIds
        : defaults.workerId
          ? [defaults.workerId]
          : fallback.workerId
            ? [fallback.workerId]
            : []
  ).filter((id): id is string => !!id)
  const models = defaults.modelsByWorker ?? fallback.modelsByWorker ?? {}
  const efforts = defaults.effortsByWorker ?? fallback.effortsByWorker ?? {}

  const rows: Array<{ label: string; value: string }> = []
  rows.push({
    label: 'workers',
    value:
      ids.length === 0
        ? // ⚠️ Said plainly rather than left blank. "Nobody chose" and "the pane does not know" look
          // identical when the row is empty, and only one of them is true here.
          'any account the scheduler picks'
        : ids
            .map((id) => {
              const label = fleet.find((f) => f.worker.id === id)?.worker.label ?? id.slice(0, 8)
              const model = models[id]
              const effort = efforts[id]
              const named = modelLabel(model ?? null, effort ?? null)
              return named ? `${label} · ${named}` : label
            })
            .join(', ')
  })
  const single = ids.length <= 1 ? (defaults.model ?? fallback.model ?? null) : null
  if (single) {
    rows.push({ label: 'model', value: modelLabel(single, defaults.effort ?? fallback.effort ?? null) ?? single })
  }
  rows.push({ label: 'priority', value: defaults.priority ?? task.priority })
  if (defaults.finishPolicy) rows.push({ label: 'finish', value: defaults.finishPolicy })
  if (defaults.sessionSharing) rows.push({ label: 'conversation', value: defaults.sessionSharing })
  // ⚠️ Absent in execute mode rather than reading "up to 1 piece". The cap there is not a fan-out
  //    setting somebody chose — it is the shape of the task, and the type row above already says it.
  if (defaults.maxChildren && !isPlanExecute(task)) {
    rows.push({ label: 'fan-out', value: `up to ${defaults.maxChildren} pieces` })
  }
  return rows
}

/**
 * The worker and model a piece of a plan was filed with, read off its planner.
 *
 * ⛔ **Beside the current worker, never instead of it (t353).** `task.setWorker` rewrites a piece's
 * own constraints, so once somebody moves a piece the thread could no longer say what the plan had
 * chosen — and whether a split's routing was right is the question this answers.
 *
 * ⚠️ Derived rather than stored, and faithfully: `applySplit` files every piece from the planner's
 * `childDefaults` (with `constraints.pieceConstraints` behind it), which only `task.create` writes,
 * and `pieceSettings` resolves those two fields the same way. Empty for anything not a piece.
 */
export function plannedAssignment(
  parent: Pick<Task, 'kind' | 'mandate' | 'childDefaults' | 'constraints' | 'priority'> | null,
  fleet: FleetEntry[]
): Array<{ label: string; value: string }> {
  if (!parent) return []
  return pieceSettings(parent, fleet).filter((row) => row.label === 'workers' || row.label === 'model')
}

/**
 * Keep a task's valid model pin when changing its worker; otherwise return to inheritance.
 *
 * ⛔ Do not copy `worker.defaultModel` here. Multi-pool workers such as Antigravity resolve their
 * default from `defaultModels` and current quota, so copying the single-model legacy field pins a
 * task to a different model than the worker's configured default.
 */
export function reassignmentModel(model: string, offeredModels: ReadonlyArray<{ id: string }>): string {
  return model && offeredModels.some((offered) => offered.id === model) ? model : ''
}

/**
 * Which model a reassign row's effort levels should be read off, given the model picker's raw value.
 *
 * ⛔ **`'__auto__'` and `''` are not model ids** — they mean "no pin chosen", and the effort levels
 * on offer belong to whichever model will actually run once that choice resolves: the account's own
 * inherited default. Looking `effortLevels` up by the literal sentinel value found nothing, so effort
 * could only ever be picked once an operator had also picked one exact, named model — not the
 * ordinary case of leaving the model on Auto or on the account default.
 */
export function effortLookupModel(selectedModel: string, inheritedModel: string | null): string {
  return selectedModel && selectedModel !== '__auto__' && selectedModel !== '__inherit__'
    ? selectedModel
    : (inheritedModel ?? '')
}

/**
 * How long an agent was actually working on this task.
 *
 * ⛔ **Active time, not wall-clock, and the column that shows it is the one headed "Took".** The
 * old answer was `lastRunEnded - firstRun`, which measures how long the task *existed inside*: it
 * counts every minute queued behind a busy pool, parked on a quota window, and — the large one —
 * waiting for a person to answer a question, which `ask_human` will happily do overnight. The two
 * numbers do not differ by a correction factor, they differ without limit, and every per-agent and
 * per-model duration read off the wall-clock was describing the operator rather than the agent.
 *
 * ⚠️ Summed in the daemon (`activetime.ts`) and *finished* here: `activeSince` is the moment the
 * live stretch began, so a running task ticks without the daemon pushing a row every second, and
 * one that is open but blocked on a person has `activeSince: null` and correctly stops moving.
 *
 * A task that has never run has no duration and says so rather than showing zero.
 */
type Timed = Pick<Task, 'firstRunAt' | 'lastRunEndedAt' | 'activeMs' | 'activeSince'>

export function activeTime(task: Timed, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration(task.activeMs + (task.activeSince ? Math.max(0, now - task.activeSince) : 0))
}

/**
 * The span the task existed inside, first dispatch to last stop.
 *
 * ⛔ Kept, but never shown as *how long this took*. It answers a different and much weaker question
 * — "how long has this been going on" — and it is worth showing beside `activeTime` precisely
 * because the gap between them is the time nobody was working: queued, held, or waiting on you.
 */
export function elapsed(task: Timed, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration((task.lastRunEndedAt ?? now) - task.firstRunAt)
}

/**
 * The sentence that explains the difference, for the tooltip on both places the number appears.
 *
 * ⛔ Says *why* the two disagree rather than only that they do. An operator reading "4m" against a
 * task filed eight hours ago will assume the number is broken unless the waiting is named.
 */
export function activeTimeTitle(task: Timed, now: number): string {
  if (!task.firstRunAt) return 'Nothing has run yet, so there is no duration to report.'
  const wall = (task.lastRunEndedAt ?? now) - task.firstRunAt
  const active = task.activeMs + (task.activeSince ? Math.max(0, now - task.activeSince) : 0)
  const idle = Math.max(0, wall - active)
  return (
    `Time an agent was actually working: ${duration(active)}. ` +
    `From first dispatch to last stop is ${duration(wall)}, of which ${duration(idle)} was spent ` +
    'queued, held on a workspace or a quota window, or waiting for you to answer something — ' +
    'none of which anybody worked. Dispatch, routing and the CLI starting up all count as work.'
  )
}

/**
 * The workspace directory this task is running in, or ran in.
 *
 * ⛔ Read from the session rather than from the project. A git project's runs execute in a pooled
 * worktree (`<project>_workspaces/ws<N>`), never in `project.root` — drawing the project root would
 * tell somebody the agent is working in the trunk, which is the one thing it never does.
 *
 * ⚠️ Returns null before anything has run: a task at rest in a pool has not claimed a workspace yet,
 * and presenting a guess would claim a slot the scheduler has not assigned.
 */
export function workspacePathFor(
  runs: Pick<Run, 'sessionId'>[],
  sessions: Pick<Session, 'id' | 'cwd'>[]
): string | null {
  const run = runs[0]
  if (run?.sessionId) {
    const session = sessions.find((s) => s.id === run.sessionId)
    if (session?.cwd) return session.cwd
  }
  return sessions[0]?.cwd ?? null
}

/**
 * What to call this task, wherever a task needs a name in a row, a header or a chip.
 *
 * ⛔ **`titleSummary ?? title`, in one place, because the fallback is the whole feature.** `title` is
 * the prompt — `promptFor()` sends it to the agent verbatim, and the task form files an entire
 * textarea into it — so a board of operator-written tasks is a board of paragraphs. The controller
 * writes a one-line label into `titleSummary` when it has been asked something about the task
 * anyway; most tasks never get one, and those are not broken rows, they are unlabelled ones. Showing
 * the prompt is the right answer for them and always has been.
 *
 * ⚠️ **Never used where the prompt itself is the subject.** The task thread's first entry, the draft
 * editor, and the prompt preview all show `title` in full and must go on doing so: this is a label
 * for a table, and a label that quietly replaced the instruction being edited would lose a word of
 * what the agent was actually asked.
 */
export function taskLabel(task: Pick<Task, 'title' | 'titleSummary'>): string {
  return task.titleSummary ?? task.title
}

/**
 * The same label, cut to fit a table cell.
 *
 * ⚠️ Truncation is the *second* line of defence and is expected to do nothing on a labelled task —
 * `MAX_TITLE_SUMMARY` is 80, so a summary always fits. It still exists because an unlabelled task
 * falls back to a prompt of any length at all, and a table has to hold its shape either way.
 *
 * ⛔ **`max` bounds the payload; CSS decides where the line ends.** Every cell that renders this is
 * `text-overflow: ellipsis` against a real column width, so a `max` at or below what the column can
 * draw puts an `…` on screen while there is still room beside it — a truncation mark that is not
 * telling the truth. The task table passes `TITLE_CHARS`, deliberately well past its widest column;
 * the default is for callers with no column at all, such as the delete confirmation.
 */
export function taskLabelShort(task: Pick<Task, 'title' | 'titleSummary'>, max = 70): string {
  const label = taskLabel(task)
  return label.length > max ? `${label.slice(0, max)}…` : label
}

/**
 * Where "open this task" goes from anywhere outside its project.
 *
 * ⛔ **The project thread, never the Unassigned list for a task that has a home.**
 * Every task belongs to one project, so a question's Answer… button or a quota
 * alert's View… that lands on `← Unassigned` strands the operator: Back returns
 * to a list of project-less tasks this task is not on, with no way back to the
 * project view it came from (t699). The Unassigned route is only for the
 * genuinely project-less remainder.
 */
export type OpenTaskRoute =
  | { kind: 'project'; id: string; tab: 'thread'; taskId: string }
  | { kind: 'unassigned'; taskId: string }

export function routeForTask(task: Pick<Task, 'id' | 'projectId'>): OpenTaskRoute {
  return task.projectId
    ? { kind: 'project', id: task.projectId, tab: 'thread', taskId: task.id }
    : { kind: 'unassigned', taskId: task.id }
}

/**
 * **The one ordering rule for everything in the thread: when it finished, then when it started.**
 *
 * ⛔ **Sorting by start time reads the timeline wrong whenever two things overlap**, and in this
 * thread they overlap constantly — a compaction happens *inside* the run that asked for it, so the
 * two always share a start and never share an end. Measured on t231, 2026-09-05: run 2 ran
 * 16:44:24–16:55:19 and its compaction ran 16:44:26–16:47:06. Ordered on `startedAt` the run came
 * first by two seconds, so the operator read a compaction that had visibly finished at 16:47 printed
 * *below* a run still going at 16:55. Ordered on the end, the compaction lands above the run that
 * outlived it, which is the order the events actually concluded in and the order a person reading
 * top-to-bottom expects.
 *
 * ⚠️ **Unfinished sorts last, and that is not a fallback — it is the answer.** Something still
 * running has not ended yet, so it will end after everything that already has. `Infinity` says
 * exactly that; `0` or `Date.now()` would each be a guess at a fact nobody has.
 *
 * ⚠️ The start time breaks ties rather than being ignored: two entries that ended in the same
 * millisecond — or two that are both still open — still have an order, and it is a stable one.
 */
export function byEndThenStart(
  a: { end: number | null; start: number },
  b: { end: number | null; start: number }
): number {
  const ended = (a.end ?? Number.POSITIVE_INFINITY) - (b.end ?? Number.POSITIVE_INFINITY)
  // ⛔ `Infinity - Infinity` is `NaN`, and a comparator that returns `NaN` orders nothing. Two open
  //    entries are tied on the end and fall through to the start, which is what the guard is for.
  if (ended !== 0 && !Number.isNaN(ended)) return ended
  return a.start - b.start
}

/**
 * Sorts runs into chronological order (oldest first, newest last) for display in the thread.
 *
 * ⛔ **Old top, new bottom.** The backend stores and returns runs newest-first (`order by started_at desc`)
 * so that `runs[0]` is the latest attempt for session resolution. The UI thread reads top-to-bottom
 * in time order — attempt 1 first, attempt 2 next — matching how a person reads a timeline.
 *
 * ⚠️ Ordered on the end, like everything else in the thread — see `byEndThenStart`. Attempts rarely
 * overlap, so this usually agrees with `startedAt`; it is held to the one rule anyway, because an
 * ordering that is right for a different reason is one refactor away from being wrong.
 */
export function chronologicalRuns<T extends Pick<Run, 'startedAt' | 'endedAt'>>(runs: T[]): T[] {
  return [...runs].sort((a, b) =>
    byEndThenStart(
      { end: a.endedAt ?? null, start: a.startedAt },
      { end: b.endedAt ?? null, start: b.startedAt }
    )
  )
}

/**
 * What the "←N" dependency badge means, spelled out for a hover.
 *
 * ⚠️ Resolved against `page`, the same page of tasks already loaded for the table — not a fresh
 * fetch. A dependency filed on an earlier page falls back to its bare id rather than blocking the
 * tooltip on a round trip.
 */
export function dependencyTooltip(
  task: Pick<Task, 'dependsOn'>,
  page: Array<Pick<Task, 'id' | 'seq' | 'title' | 'titleSummary' | 'status' | 'holdReason'>>
): string {
  if (task.dependsOn.length === 0) return ''
  const byId = new Map(page.map((t) => [t.id, t]))
  const lines = task.dependsOn.map((id) => {
    const dep = byId.get(id)
    return dep ? `t${dep.seq} · ${taskLabelShort(dep, 40)} (${statusLabel(dep)})` : id
  })
  return `Depends on:\n${lines.join('\n')}`
}

export type TimelineItem = { ts: number; endTs: number | null } & (
  | { kind: 'run'; run: Run }
  | { kind: 'compaction'; compaction: Compaction }
  | { kind: 'review'; review: QualityReview }
)

/**
 * Merges runs, compactions and quality reviews into one chronological timeline (oldest first).
 *
 * ⛔ **A review is one entry, not two.** It *is* a `runs` row — that is how its tokens are metered
 * and how it earns a number in this list — so the run half is filtered out here and the review half
 * rendered instead. Without the filter every review would appear twice, once as `#N Run` with a
 * reviewer's model on somebody else's task.
 *
 * ⛔ **Ordered on when each entry finished** — `byEndThenStart`, which carries the argument. A
 * compaction runs *inside* the run that asked for it, so start times separate the two by seconds
 * while end times separate them by minutes, and only the end puts them in the order they concluded.
 *
 * ⚠️ Every kind reports both ends, and each one's `null` means the same thing: still open. A run
 * has no `endedAt` until it stops; a compaction has no `landedAt` until its boundary arrives, which
 * is the asked-and-never-landed case `compaction.ts` exists to keep on the record; a review has no
 * `completedAt` until it is graded.
 */
export function chronologicalTimeline(
  runs: Run[] = [],
  compactions: Compaction[] = [],
  reviews: QualityReview[] = []
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...runs
      .filter((r) => r.kind === 'work')
      .map((r) => ({ kind: 'run' as const, run: r, ts: r.startedAt, endTs: r.endedAt ?? null })),
    ...compactions.map((c) => ({
      kind: 'compaction' as const,
      compaction: c,
      ts: c.askedAt ?? c.ts,
      endTs: c.landedAt ?? null
    })),
    ...reviews.map((r) => ({
      kind: 'review' as const,
      review: r,
      ts: r.createdAt,
      endTs: r.completedAt ?? null
    }))
  ]
  return items.sort((a, b) =>
    byEndThenStart({ end: a.endTs, start: a.ts }, { end: b.endTs, start: b.ts })
  )
}

/**
 * The run the peek names when the timeline has scrolled away: the last one in the timeline, with
 * the `#N` the timeline itself gave it.
 *
 * ⛔ The last *timeline* entry of kind `run`, not `runs[0]`. `runs[0]` is the newest by start, and the
 * timeline is ordered on the end (`byEndThenStart`), so the two can disagree while an attempt is
 * open; the peek stands in for the row that scrolled away and has to name the same row. The index
 * is the position in the whole timeline, compactions and reviews counted, because that is the
 * number printed on the row.
 */
export function latestRunEntry(timeline: TimelineItem[]): { index: number; run: Run } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]
    if (item?.kind === 'run') return { index: i + 1, run: item.run }
  }
  return null
}

/**
 * The four landing-failure predicates, each one cause of `resolveRetryCauses`.
 *
 * ⛔ Thin wrappers over the shared classifier, not regexes of their own: the daemon's *Resolve &
 * retry* reads the same list, and a private copy here is how the card and the button came to
 * disagree about the same hold reason (t344/t347). See `resolveRetryCauses` in `@shared/tasks`.
 */
export function isConflictedTask(task: Pick<Task, 'holdReason'>): boolean {
  return resolveRetryCauses(task).includes('conflicted')
}

export function isChecksFailedTask(task: Pick<Task, 'holdReason'>): boolean {
  return resolveRetryCauses(task).includes('checksFailed')
}

export function isUncommittedTask(task: Pick<Task, 'holdReason'>): boolean {
  return resolveRetryCauses(task).includes('uncommitted')
}

export function isTrunkMovedTask(task: Pick<Task, 'holdReason'>): boolean {
  return resolveRetryCauses(task).includes('trunkMoved')
}

/**
 * Whether a human in awaiting_human should be offered "Retry landing".
 *
 * ⛔ A branch carrying no commits must never offer "Retry landing": `relandTask` requires real commits
 * (`decision.kind === 'land'`) and fails immediately if `unlandedCommits === 0`.
 *
 * ⚠️ Bare `/trunk/i` was a trap (measured on t157, 2026-09-03): it matched "the trunk moved during this
 * run and this branch is empty", offering a button that was guaranteed to fail with "Retry landing
 * failed: carries no commits".
 *
 * ⛔ **A retry that already failed once must still be retriable** (t509, 2026-09-17). A blanket
 * `/Retry landing failed/` exclusion used to hide this button for good the moment one retry did not
 * land — including a `pull-request` push rejected because a later run's squash rewrote history
 * already on the open PR, which is fixable and exactly what pressing the button again is for. Once
 * hidden, nothing on the card ever offered it again: a failed retry looked identical to a task with
 * nothing left to try. Only the specific unfixable causes above (no commits, a conflict, failing
 * checks, uncommitted files, the trunk tripwire) may hide it; a reason that is merely *prefixed* with
 * "Retry landing failed" is not on its own one of them.
 */
export function canRelandTask(task: Pick<Task, 'branch' | 'holdReason'>): boolean {
  if (!task.branch) return false
  const reason = task.holdReason ?? ''
  if (isConflictedTask(task)) return false
  if (isChecksFailedTask(task)) return false
  if (isUncommittedTask(task)) return false
  if (isTrunkMovedTask(task)) return false
  if (/no commits|nothing to land|branch is empty/i.test(reason)) return false
  // ⛔ **The trunk checkout being in the way is the case this button exists for.** Once the operator
  // has committed, stashed or cleared their own files, one press merges the branch — and nothing
  // else on the card does. t614 (2026-09-22) had none of it: `trunkNotReady`'s sentence names a file
  // count rather than the literal phrase below, so only the `uncommitted` misclassification matched,
  // and that *hid* this button. Ask the shared classifier, not a phrase.
  if (isTrunkBlockedReason(reason)) return true
  return /landing failed|not merged|wait(ed|ing) for a turn|would not fast-forward|trunk was busy|clean trunk|the trunk is busy|the trunk has uncommitted/i.test(
    reason
  )
}

/**
 * Which explanations the single "Resolve & retry" button carries.
 *
 * ⛔ **One button, however many match.** All four causes dispatch the same `task.resolveRetry`
 * with only the task id — the daemon reads `holdReason` itself, through this same function — so
 * returning every match and drawing one button per match asked the same question twice (t289).
 * The card draws one button and stacks every cause returned here beneath it.
 */
export { isTrunkBlockedReason, resolveRetryCauses, type ResolveRetryCause }
