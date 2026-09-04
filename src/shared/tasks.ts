/**
 * The task domain.
 *
 * Three objects that look alike in a UI and are nothing alike in the scheduler:
 *
 *  - a **Task** is a thread of work with an assignee. It can be scheduled, reassigned, made to
 *    depend on other work, and it outlives every session that touches it.
 *  - an **Approval** is an interrupt on one live session. It blocks that session right now, only
 *    that session can consume the answer, its answer set is closed, and it dies with the session.
 *  - a **Question** is an interrupt too, but its answer set is written by whoever asked and its
 *    answer is *content*. So it can never become a project rule the way an approval can, an
 *    unanswered one parks rather than denying, and it outlives its session on purpose.
 *
 * Filing any of them as another is wrong on every axis the first exists for. See the implementation
 * plan §7.3 and §7.4.
 */

import type { QuotaSnapshot, QuotaWindow, Worker } from './protocol.js'

// ---------------------------------------------------------------------------- project

export type Vcs = 'git' | 'none'

/** Committed at `<project>/.multi_agent_controller/project.json`. Nothing secret goes in it. */
export interface ProjectConfig {
  schema_version: number
  name?: string
  vcs?: Vcs
  objective?: string
  workspaces?: { poolSize?: number; root?: string }
  prepare?: string[]
  check?: string[]
  /**
   * ⚠️ `strategy` is the pre-2026-08-28 spelling and is still read, so an existing project.json keeps
   * working. It is migrated to `finish` on load; write `finish` in new files.
   */
  landing?: {
    strategy?: LandingStrategyId
    target?: string
    finish?: FinishPolicyChoice
    /** What a `custom` finish tells the agent to do. Defaults to `DEFAULT_FINISH_INSTRUCTION`. */
    finishInstruction?: string
  }
  session?: {
    share?: SessionSharingChoice
    completion?: CompletionModeChoice
  }
  permission?: { mode?: string; allow?: string[]; deny?: string[] }
  env?: Record<string, string | number>
  resources?: Array<{ ref: string }>
  mandate?: Partial<Mandate>
}

export interface ProjectPolicyPatch {
  finish?: FinishPolicyChoice
  landingTarget?: string
  finishInstruction?: string | null
  sessionShare?: SessionSharingChoice
  completion?: CompletionModeChoice
  poolSize?: number
  prepare?: string[]
}

export interface Project {
  id: string
  name: string
  /** The trunk. Agents never run here. */
  root: string
  vcs: Vcs
  config: ProjectConfig
  /** Where the config was read from, or null when the project has none yet. */
  configPath: string | null
  createdAt: number
  archivedAt: number | null
}

// ---------------------------------------------------------------------------- task

/**
 * What kind of thing this task is.
 *
 * ⛔ A `plan` task is **decomposed, not dispatched**. Its output is a set of draft children with
 * dependency edges - which keeps decomposition visible, cancellable, billable to a budget and
 * re-runnable when the plan turns out wrong, rather than being a hidden phase. Plan §18.1.
 */
export type TaskKind = 'work' | 'plan'

/**
 * What a dependency edge counts as met.
 *
 * ⛔ `completed` is the default and the meaning every edge in the fleet already had: *"do B after A"*
 * means A succeeded. `settled` releases on any resting terminal state — `completed`, `failed` or
 * `cancelled` — and is written by `task_split` alone, because a planner has to be woken by the
 * children that failed as well as the ones that worked. It is told which was which.
 */
export type DependencyRequirement = 'completed' | 'settled'

/**
 * The settings a Plan & Split parent hands to each piece it files.
 *
 * ⛔ **Separate from the parent's own settings, which is decision D5.** "Plan with one model, build
 * with another" is the case that motivated Plan & Split at all: the planning turn wants a model that
 * reads a repository well and asks good questions, and the pieces want whatever is cheapest that can
 * follow a concrete instruction. One row of settings would have forced them to be the same.
 *
 * ⚠️ Every field is optional and an absent one means *inherit*, resolved against the project exactly
 * as an ordinary task's would be. A stored `null` and an absent key mean the same thing here on
 * purpose: this is written by a form where "leave it alone" is the common answer.
 */
export interface ChildDefaults {
  workerId?: string | null
  /**
   * Every account a piece of this plan may run on.
   *
   * ⛔ **A closed list, not a preference.** The composer's Pieces row lets an operator name two or
   * three cheap accounts for work they have already decided is small, and the scheduler must pick
   * from *that* list or from none — a split whose pieces were routed to whatever the fleet felt like
   * is a split whose settings did nothing. It was exactly that until 2026-09-04: the composer sent
   * this field, `applySplit` read only the singular `workerId` beside it, and every child was filed
   * with no constraint at all and picked up by the largest model in the fleet.
   *
   * ⚠️ Empty or absent means *the scheduler chooses*, which is the honest reading of a control
   * nobody touched. One entry is a pin, and is written to `workerId` as well so every other reader
   * of a pinned account sees it.
   */
  workerIds?: string[]
  model?: string | null
  effort?: string | null
  /** The model each named account runs a piece with — a model id belongs to one CLI, never to a fleet. */
  modelsByWorker?: Record<string, string>
  /** The effort each named account is asked for, where its CLI takes an effort flag at all. */
  effortsByWorker?: Record<string, string>
  finishPolicy?: FinishPolicyChoice
  sessionSharing?: SessionSharingChoice
  priority?: Priority
  /** How many pieces the planner may file. Bounded by the task's mandate, which stays the authority. */
  maxChildren?: number
}

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'blocked'
  | 'scheduled'
  | 'assigned'
  | 'running'
  | 'awaiting_human'
  | 'paused_quota'
  | 'paused_user'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'

/**
 * The buckets the task list can be filtered by.
 *
 * ⛔ **Every status belongs to exactly one bucket.** Not "at least one" — exactly one. That is what
 * makes a multi-select a plain union with no row appearing twice and no count double-adding, and it
 * is what stops a status added later from being invisible in every view except All. The test that
 * pins this checks both directions, because only one of them is the interesting failure.
 *
 * ⚠️ **All is not in here.** It is the *empty* selection, so that "everything" has one representation
 * rather than two — an empty array and a full one would look identical to a reader and different to
 * a `Set`.
 *
 * `draft` sits under Blocked rather than in a bucket of its own: a draft dispatches nothing until
 * somebody promotes it, which is the same thing Blocked means to the person scanning this list —
 * *not going anywhere without me*.
 */
export const TASK_VIEWS = {
  active: ['ready', 'scheduled', 'assigned', 'running', 'cancelling'],
  needs_you: ['awaiting_human', 'paused_user'],
  blocked: ['blocked', 'paused_quota', 'draft'],
  done: ['completed'],
  failed: ['failed', 'cancelled']
} as const satisfies Record<string, readonly TaskStatus[]>

export type TaskView = keyof typeof TASK_VIEWS

/** In the order they are drawn, with the label each chip carries. */
export const TASK_VIEW_ORDER: Array<{ id: TaskView; label: string }> = [
  { id: 'active', label: 'Active' },
  // ⭐ The one an operator actually scans for. A task waiting on a person is stopped and nothing in
  // the fleet will restart it, so it is the only bucket whose contents are *your* backlog.
  { id: 'needs_you', label: 'Needs you' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' }
]

/** The statuses a set of views selects, as one flat list. Empty selection means no filter at all. */
export function statusesForViews(views: readonly TaskView[]): TaskStatus[] {
  return views.flatMap((v) => [...TASK_VIEWS[v]])
}

/** Which bucket a status falls in. Used to fold a `group by status` count into chip counts. */
export function viewForStatus(status: TaskStatus): TaskView | null {
  for (const [view, statuses] of Object.entries(TASK_VIEWS)) {
    if ((statuses as readonly string[]).includes(status)) return view as TaskView
  }
  return null
}

/** One page of the task table, with the counts the chips above it draw. */
export interface TaskPage {
  tasks: Task[]
  /** How many rows the filter matches, which is what the pager counts pages out of. */
  total: number
  /**
   * How many tasks are in each bucket, **ignoring the current selection**.
   *
   * ⛔ Unfiltered on purpose. A chip whose count reflected the filter would read `Needs you 0` while
   * three tasks were waiting on you, purely because you were looking at Done — the number would then
   * only ever be right for the chip you had already clicked, which is the one you least need it on.
   */
  counts: Record<TaskView, number>
}

/** What the table can be ordered by. ⚠️ Every one of these is a real column, never a computed one. */
export type TaskSort = 'seq' | 'created' | 'updated'

/** Where a cancelled task comes to rest. Cancel is not delete: none of these destroy anything. */
export type RestingState = 'paused_user' | 'draft' | 'cancelled'

export const RESTING_STATES: RestingState[] = ['paused_user', 'draft', 'cancelled']

/** A task in one of these can be deleted; anything else must be cancelled first. */
export const DELETABLE_FROM: TaskStatus[] = [
  'draft',
  'paused_user',
  'cancelled',
  'completed',
  'failed'
]

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

export type Principal =
  | { kind: 'human' }
  | { kind: 'controller' }
  | { kind: 'agent'; workerId: string; sessionId: string; runId: string }

/**
 * The authority a task runs under. Inherited from its creator and **narrowed, never widened** - a
 * task that has lost `spawn_tasks` cannot create children because it has no such authority, not
 * because a heuristic caught it.
 */
export interface Mandate {
  allowed: MandateOperation[]
  projectIds: string[] | 'creator'
  maxLineageDepth: number
  maxChildren: number
}

export type MandateOperation = 'read' | 'write' | 'commit' | 'push' | 'spawn_tasks' | 'land'

export const ROOT_MANDATE: Mandate = {
  allowed: ['read', 'write', 'commit', 'push', 'spawn_tasks', 'land'],
  projectIds: 'creator',
  maxLineageDepth: 3,
  maxChildren: 5
}

/** A token grant, inherited as a *share* so a subtree cannot outspend its root. */
export interface Budget {
  grantedTokens: number
  spentTokens: number
  /**
   * What every run of this task has cost in money, summed.
   *
   * ⛔ **Derived on read, never written to `budget_json`.** A task's total moves when a *later* run
   * is found to have overlapped one of its own — see daemon/price.ts. Persisting it would freeze an
   * estimate the moment a parallel run ended. `creditTurn` writes the two token fields explicitly
   * for exactly this reason.
   *
   * `null` means nothing could be priced at all, and is `n/a` in the UI rather than $0.00.
   */
  spentUsd?: number | null
  /** At least one contributing run's number was a split, a stale reading, or still in flight. */
  spentUsdEstimated?: boolean
  /** ⚠️ At least one run could not be priced, so the total above is a **lower bound**. */
  spentUsdPartial?: boolean
  /**
   * The vendor's API-equivalent list price for every run of this task, summed.
   *
   * ⛔ **Not a component of `spentUsd`**, for the reason `RunPrice.listUsd` gives: it is what
   * this task *would* have cost on a market-rated API, not what anybody was billed.
   *
   * ⚠️ Derived on read like `spentUsd`, and never written to `budget_json`.
   */
  spentListUsd?: number | null
  /**
   * The directly-billed pay-as-you-go share of `spentUsd` — overage and credits, not the amortised
   * subscription. ⚠️ Derived on read like `spentUsd`, and never written to `budget_json`.
   */
  spentOverageUsd?: number | null
}

export type MessageRole = 'human' | 'agent' | 'controller' | 'system'

/**
 * An image a person put on a message, stored as bytes on disk with its metadata in sqlite.
 *
 * ⛔ **Bytes on disk, never in the row.** A pasted screenshot is 1-3 MB and this database is
 * opened by the daemon on every tick; a blob column would bloat the WAL for data that is only ever
 * read whole, by path, and mostly by a CLI rather than by us.
 *
 * ⚠️ `kind` is a column rather than an assumption so that audio, when it arrives, is a value and
 * not a migration.
 */
export interface Attachment {
  id: string
  /** Null until the attachment is bound to the message it was pasted into. */
  messageId: number | null
  taskId: string | null
  kind: 'image' | 'file' | 'folder'
  mediaType: string
  /** Absolute path. This is what travels in the prompt text on every adapter. */
  file: string
  bytes: number
  width: number | null
  height: number | null
  createdAt: number
}

export interface TaskMessage {
  id: number
  taskId: string
  role: MessageRole
  text: string
  runId: string | null
  /**
   * When this message reached an agent. A note typed into a live session is answered in that
   * session - `0.1·C` - and must not also be replayed into the next prompt, which would charge for
   * it twice and leave the agent unsure what is still outstanding.
   */
  deliveredAt: number | null
  ts: number
  /**
   * Images pasted onto this message. Empty on almost every row, which is why they live in their own
   * table rather than as nullable columns here.
   */
  attachments: Attachment[]
}

export interface CancelRecord {
  requestedBy: 'human' | 'controller' | 'system'
  requestedAt: number
  reason: string | null
  restingState: RestingState
}

export interface Task {
  id: string
  /** Short human-facing number, stable and far easier to say out loud than a uuid. */
  seq: number
  projectId: string | null
  /**
   * ⛔ **This is the prompt.** `promptFor()` pushes it verbatim as the first part of what the agent
   * is told, and the task-creation form files the whole textarea into it. So it is routinely a
   * paragraph rather than a label, and nothing may overwrite it with something shorter for the sake
   * of a table — a truncated title is a truncated instruction.
   */
  title: string
  /**
   * A one-line label for `title`, written by the controller. Null until one exists.
   *
   * ⚠️ **Display only, and additive by construction.** Nothing in the prompt path reads it: the UI
   * renders `titleSummary ?? title` wherever a task needs a name in a row, a header or a chip, and
   * the thread still shows the full prompt as its first entry. That split is the whole feature — a
   * readable board without losing a word of what the agent was actually asked.
   */
  titleSummary: string | null
  kind: TaskKind
  status: TaskStatus
  priority: Priority
  createdBy: Principal
  parentTaskId: string | null
  lineageDepth: number
  assignee: string | null
  /** `human`, `any`, or a worker id. Open, because a hint is advisory - the scheduler may ignore it. */
  assigneeHint: string | null
  mandate: Mandate
  budget: Budget
  dependsOn: string[]
  notBefore: number | null
  deadline: number | null
  requires: Array<{ resourceId: string; amount: number }>
  constraints: TaskConstraints
  /**
   * ⛔ Superseded by `finishPolicy` and kept only so old rows and old callers still parse. `required`
   * was migrated to `finishPolicy: 'await-human'`; nothing writes it any more and nothing gates on
   * it. It goes when the last database written before 2026-08-28 is gone.
   */
  verification: 'required' | 'not_required' | 'auto'
  /** This task's own answer, or `inherit` to take the project's — which may itself inherit. */
  finishPolicy: FinishPolicyChoice
  /**
   * May this task borrow a conversation? Resolved task → project → fleet, `inherit` by default.
   *
   * ⚠️ `inherit` is a real value rather than a blank: a task left on it follows its project as the
   * project changes, and one set explicitly to the same value does not.
   */
  sessionSharing: SessionSharingChoice
  /** How far the agent is expected to get before it stops. `inherit` follows the project. */
  completionMode: CompletionModeChoice
  /** What this task is optimising for, or `inherit` to follow project/fleet. */
  objective: ObjectiveChoice
  /**
   * May the cache clock compact this task's conversation? `inherit` follows the fleet switch.
   *
   * ⛔ Resolved by `resolveAutoCompact`, task → fleet, and read by every place the fleet switch was
   * read before — the four clock moves that can issue a `/compact` and the resume path. A control
   * that reached only some of them would be a switch that appears to be on and mostly is not, which
   * is the mirror of the rule `settings.autoCompact` already carries.
   */
  autoCompact: AutoCompactChoice
  /**
   * When the finish instruction was sent to the agent, if it has been.
   *
   * ⛔ The guard against re-asking. The instruction is sent, the agent works, and it calls
   * `task_complete` again — and between those two moments nothing about the task has changed, so the
   * same decision would be reached again. That is the preemption loop of 2026-08-28 in a different
   * costume, and each repeat here is a billed turn spent telling an agent to do what it just did.
   */
  finishAskedAt: number | null
  /** When the agent was asked to resolve a rebase conflict. ⛔ One ask, then a person. */
  conflictAskedAt: number | null
  /** When the scheduler used this task's one automatic resolve-and-retry attempt. */
  resolveRetryAskedAt: number | null
  preemptible: boolean
  estTokens: number | null
  cancel: CancelRecord | null
  handoffNote: string | null
  /**
   * Why this task is not moving, and whether anybody is expected to do something about it.
   *
   * Two callers, one question. The **scheduler** writes it every tick it passes a `ready` task over;
   * anything that hands a task to a **person** writes the reason it did. ⛔ An `awaiting_human` task
   * with no stated reason is the least actionable thing this app can show — it says a decision is
   * wanted without saying what about, and it sits next to a run marked `completed`, which reads as a
   * contradiction until somebody opens the thread and finds the sentence.
   *
   * ⛔ `ready` is not a state an operator can act on. It is the scheduler's word for "eligible", and
   * a task can sit in it for hours because every worker is at capacity, because a routing question is
   * open, or because the only account that could take it is out of window - three situations with
   * three different answers, rendered identically as a task that appears to be doing nothing while
   * the person who filed it wonders which button they forgot to press.
   *
   * The scheduler already computes its half on every tick and used to fold it into a log line. It
   * costs nothing to keep - the tick is arithmetic - and it is written only when it *changes*, so a
   * held task is not a write every ten seconds.
   *
   * ⚠️ Moves atomically with the status and is cleared by any transition that does not supply one. A
   * stale reason is worse than none, because it is read as current.
   */
  holdReason: string | null
  /**
   * The earliest moment the thing named in `holdReason` could stop being true, or null when nothing
   * can say.
   *
   * ⛔ **The machine-readable half of `holdReason`, and it exists because prose was the only half.**
   * A task held on a quota window is held until that window resets, and the scheduler read that
   * reset time in order to write the sentence — then discarded it. Two consumers needed the number:
   * the operator, who was shown *"at 92% of its 5h window"* with no way to know whether that meant
   * five minutes or five hours, and `expectedIdleMs`, which counted a task that could not move for
   * 2h29m as *"ready now"* and so told every live session in the fleet to expect work imminently.
   *
   * ⚠️ **Descriptive, never a gate.** Nothing refuses to dispatch because of it; the hold is
   * re-decided from the world on every tick exactly as it was before. It is deliberately not
   * `notBefore`, which `admit()` reads and would turn into a status change.
   */
  holdUntil: number | null
  /**
   * Until when a person has said to dispatch this task despite the quota high-water mark.
   *
   * ⛔ **It overrules a percentage of ours and nothing else.** The 92% gate is this fleet's own
   * caution, computed from a reading; it is not the vendor declining anything. So an override lets
   * the dispatch gate, the mid-run percentage preempt, and the early window-boundary preempt pass.
   * It leaves untouched every gate that rests on something else — a disabled or signed-out account,
   * a worker at capacity, and above all a turn the vendor actually **refused**, which no operator
   * setting can talk out of having happened.
   *
   * ⚠️ A deadline, not a boolean, and it is written from the reset of the window being overruled —
   * so the permission expires with the reason for it, whether or not anything ran meanwhile.
   */
  quotaOverrideUntil: number | null
  /**
   * A deterministic grace period before an automatic quota preemption.
   *
   * ⛔ Persisted before it is shown: every watchdog tick re-evaluates the trigger, so an in-memory
   * countdown would restart on daemon restart and could postpone the action forever. `trigger`
   * identifies the evidence class; changing percentages update the reason without buying another
   * minute. A vendor refusal is never represented here because the turn has already been denied.
   */
  quotaPreemptWarning: {
    trigger: 'window' | 'overrun'
    reason: string
    preemptAt: number
    resumeAt: number
  } | null
  branch: string | null
  /**
   * The ref this task's work lands onto, or null to take the project's.
   *
   * ⛔ **Null on every task that is not a split**, which is what makes the resolver inert. `landing
   * TargetFor(task, project)` returns the project's answer whenever this is null, so the 24 readers
   * that went through it changed nothing for any task that existed when it was added.
   *
   * ⚠️ Set on a split's **children**, to their planner's branch — the integration branch — so that
   * child 2 is cut from a base that already contains child 1's work. Read `docs/landing.md`: a base
   * and a measurement that disagree is t22, and it reports success.
   */
  landingTarget: string | null
  /**
   * What each piece of a Plan & Split inherits, set on the planner when the task is filed.
   *
   * ⚠️ Null for every `work` task. Only a `plan` task carries one, and `task_split` reads it when it
   * files the children rather than asking the agent to choose — a model picked by the operator in
   * the composer is not something an agent should be able to talk its way out of.
   */
  childDefaults: ChildDefaults | null
  /**
   * When work first started on this task, and when the last attempt stopped.
   *
   * ⛔ Derived from the runs, not stored on the task, because they are facts about attempts and a
   * copy on the task would drift the first time a run was re-attributed. They live here because a
   * table of tasks must be able to say **how long this took** without loading every run of every
   * row - `createdAt` is when somebody typed it, which is a different and much less interesting
   * number.
   *
   * `lastRunEndedAt` is null while an attempt is still open, which is what makes "running for 4m"
   * distinguishable from "took 4m".
   */
  firstRunAt: number | null
  lastRunEndedAt: number | null
  /**
   * How long an agent was actually working on this, and whether that number is still moving.
   *
   * ⛔ **Not `lastRunEndedAt - firstRunAt`.** That span is how long the task *existed inside*, and
   * it counts every minute the task spent queued, held on a busy workspace pool, paused on quota,
   * or waiting for a person to answer a question — none of which anybody worked. The two diverge
   * without limit, so every per-task, per-agent and per-model duration derived from the wall-clock
   * is describing the operator's evening rather than the agent's work.
   *
   * Read them together: the total is `activeMs + (activeSince ? now - activeSince : 0)`. ⚠️ Split
   * in two so a running task ticks in the renderer without the daemon pushing a new row every
   * second; `activeSince` is null whenever the number has stopped moving, which includes *a run
   * that is open but blocked on a person right now*.
   *
   * See daemon/activetime.ts for what this can and cannot see.
   */
  activeMs: number
  activeSince: number | null
  /**
   * The account the most recent run was on, whoever the task is *with* right now.
   *
   * ⛔ Derived from the runs, and it exists because `assignee` cannot answer this. Nine hand-off
   * sites set `assignee` to `human` when a task starts waiting on a person, which is honest about
   * who is being waited on and destroys the one fact the Worker column exists to show: a task that
   * ran on ClaudeSecond and then asked a question rendered as worked on by **you**, and stayed that
   * way after it was marked done. The account that spent the tokens is not the person who answered.
   *
   * ⚠️ Null until something has actually run. A task assigned a moment ago and not yet started has
   * an `assignee` and no runs, which is a different state and reads as one.
   */
  ranOn: string | null
  /**
   * The model the most recent run was dispatched with, from the same run `ranOn` names.
   *
   * ⛔ Read off the run, never re-resolved. What a task *would* be given next is a different
   * question with a different answer - `resolveModelChoice` answers that one - and the two diverge
   * the moment an account's default changes under a task that has already finished. A column that
   * silently re-labels last week's work with this week's default is the failure `ranOn` exists to
   * avoid, one field over.
   *
   * ⚠️ Null until something has run, and null on a run whose session never learned a model.
   */
  ranModel: string | null
  /**
   * The commit range this task landed, recorded at the moment the landing knew it.
   *
   * ⛔ **The only record that survives the branch.** `mergeLocal` fast-forwards the trunk and then
   * deletes the branch; after that the task's commits are in the trunk's history and nothing
   * identifies which ones they are. These two SHAs are what `git diff base..head` needs, and after a
   * fast-forward both stay reachable from the trunk forever.
   *
   * ⚠️ Null on every task that landed before this was recorded, and that is not repairable —
   * `runs.trunkShaBefore` is read at *dispatch*, before the rebase, so it is not a parent of the
   * landed commits. A reader that cannot resolve a range refuses rather than guessing: a review of
   * the wrong commits is worse than no review, because it produces a number that looks real.
   */
  landedBaseSha: string | null
  landedHeadSha: string | null
  /**
   * The latest quality review of this task, denormalised for the table.
   *
   * ⛔ **The only denormalisation in this feature**, and it is paid for: the task table sorts and
   * filters over hundreds of rows, and a join per row on every keystroke of the filter box is a real
   * cost. All four fields are written by `recordReview` and by nothing else.
   *
   * ⚠️ `null` means *not reviewed*, which is a different thing from *reviewed and scored zero*.
   * The score is the arithmetic mean across `qualityReviewCount` completed, scored reviews.
   */
  qualityReviewId: string | null
  qualityScore: number | null
  /** Number of completed, scored reviews included in `qualityScore`'s arithmetic mean. */
  qualityReviewCount: number
  qualityReviewedAt: number | null
  /** The reviewer's adapter id. ⛔ Never the subject's — a review never grades its own author. */
  qualityReviewer: string | null
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TaskConstraints {
  /**
   * Pin this task to one account.
   *
   * ⛔ A pin, not a preference. The scheduler skips every other worker outright, so a pinned task
   * waits for that one account rather than routing around it when it is busy, out of window or
   * quarantined. That is the point - somebody choosing an account has a reason - but it is also why
   * the control that sets it has to say so rather than call itself a hint.
   */
  workerId?: string
  /** Multiple workers allowed for this task. Pinned to any of these accounts. */
  workerIds?: string[]
  adapterId?: string
  model?: string
  /**
   * How hard the model should think, where the CLI can be told.
   *
   * ⛔ Only ever sent to an adapter that declares `selectableEffort`. Effort is otherwise an
   * *observed* property in this codebase - it arrives from the agent's own transcript and is a record
   * of what happened. Passing a level to a CLI that has no flag for one would produce a task that
   * claims a setting nothing applied, which is worse than not offering the choice.
   */
  effort?: string
  /** Model per worker ID, when multiple workers or a specific worker model is specified. */
  modelsByWorker?: Record<string, string>
  /** Effort per worker ID, where selectable. */
  effortsByWorker?: Record<string, string>
  /** Capabilities the task cannot run without, e.g. `manualCompact`. */
  needs?: string[]
  workspacePolicy?: 'pooled' | 'trunk' | 'direct' | 'any'
  /** For plan tasks: priority for each decomposed piece. */
  piecePriority?: Priority
  /** For plan tasks: max piece limit (e.g. <=5). */
  pieceLimit?: number
  /** For plan tasks: finish policy for each piece (e.g. commit-and-merge into planner branch). */
  pieceFinishPolicy?: FinishPolicyChoice
  /** For plan tasks: session sharing for each piece. */
  pieceSessionSharing?: SessionSharingChoice
  /** For plan tasks: constraints for each piece (e.g. allowed workers & models). */
  pieceConstraints?: TaskConstraints
}

/** One attempt of a task on one session. Runs are what the estimator learns from. */
/**
 * What a run *was*, which until 2026-09-03 was always the same answer.
 *
 * ⛔ A quality review is a `runs` row so that it is metered by the one path that meters runs and
 * numbered by the one timeline that numbers them. That makes this discriminator load-bearing rather
 * than descriptive: every query that means *work* — the estimator's training data, a task's "what
 * ran on it", `activeMs` — has to say so, or a one-turn grade contaminates a number every gate reads.
 */
export type RunKind = 'work' | 'quality_review'

export interface Run {
  id: string
  taskId: string
  sessionId: string | null
  workerId: string
  /** ⚠️ `'work'` on every row written before the column existed, which is what they all were. */
  kind: RunKind
  startedAt: number
  endedAt: number | null
  outcome: RunOutcome | null
  /** ⚠️ True when the run was dispatched without a trustworthy quota reading. See quota.ts. */
  quotaUnverified: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costModelId: string | null
  /**
   * Which agent and model spent this run's tokens, stamped on the run rather than joined from the
   * session that has since been closed.
   *
   * ⚠️ Both are nullable. `adapterId` is null only on runs that predate the column; `model` is null
   * there too, and on any run whose session never learned one. The estimator treats a null model as
   * "this adapter, model unknown" and falls back a rung rather than inventing one.
   */
  adapterId: string | null
  model: string | null
  note: string | null
  /**
   * The account's own window, read either side of this run.
   *
   * ⛔ **Two readings or none.** A cost is a difference, and a difference needs a baseline - a run
   * that reports "the account is at 41%" afterwards says nothing about what the run itself spent.
   * The `before` is taken at dispatch (the scheduler refreshes a stale reading and waits a tick
   * rather than dispatching blind); the `after` is taken once the run has ended and nothing is
   * waiting on it.
   *
   * ⚠️ This is *not* the same number as the token counts above, and the gap between them is the
   * point: this app meters assistant turns exactly, while quota measures everything the account
   * spent - the auto-mode classifier, title generation, whatever else. HANDOFF calls that gap the
   * instrument. Both are shown, never merged.
   */
  quotaBefore: RunQuota | null
  quotaAfter: RunQuota | null
  /**
   * Where the trunk's landing target stood when this run was dispatched.
   *
   * ⛔ The tripwire's baseline. A run whose branch ends up empty while *this* has moved is the
   * signature of work done in the trunk directly — which every check, rebase and landing policy
   * sits downstream of and therefore never sees.
   *
   * ⚠️ `null` means no reading was taken (a projectless task, a non-git project, or a run predating
   * the column), never "the trunk did not move". The check declines rather than guessing.
   */
  trunkShaBefore: string | null
  /**
   * Did this run inherit a conversation, or build one from nothing?
   *
   * ⛔ **`null` is not `false`.** Runs that predate the column recorded nothing, and rendering those
   * as *new* would be an assertion nobody measured. The UI says nothing at all for null.
   */
  startedWarm: boolean | null
  /**
   * The exact prompt sent to the agent CLI for this run.
   *
   * Includes prepended handoff notes, branch notices, the task prompt and completion instructions.
   * Null for runs that predated this column.
   */
  prompt: string | null
  /** The effective optimization objective vector active when this run was dispatched. */
  objective?: Objective | null
  /**
   * What this run cost in money, or why it cannot be said.
   *
   * ⛔ Derived from the account's own window readings, never stored — see `RunPrice`.
   */
  price?: RunPrice | null
  /**
   * How long this attempt spent waiting on a person — an open question or an escalated approval.
   *
   * ⛔ Derived from the `questions` and `approvals` rows that name this run, never stamped on it, so
   * a question answered an hour after the fact corrects the number rather than leaving a stale copy.
   * An approval the project's rules settled contributes nothing: it was answered in the same
   * millisecond it was asked.
   *
   * ⚠️ Subtract it from the run's wall-clock to get the time the agent was working:
   * `(endedAt ?? now) - startedAt - blockedMs`. That is what `Task.activeMs` sums.
   */
  blockedMs: number
}

/**
 * Why a run costs what it costs — or why it costs nothing that can be said.
 *
 * ⛔ **Six of these eight are `n/a`, and they are deliberately not one value.** "the account is
 * free", "nobody read the window either side of this run" and "the window rolled over mid-run" are
 * three different facts about the same missing number, and a reader who is shown one dash for all
 * three has no way to tell a run that cost nothing from a run nobody measured.
 */
export type PriceReason =
  /** One run held the window for its whole life. The number is a measurement. */
  | 'measured'
  /** Parallel runs shared the window; the split is duration-weighted, and shown with a `*`. */
  | 'shared_window'
  /** No complete pair of readings around the run. */
  | 'no_reading'
  /** The window rolled over mid-run, so the difference either side of it is not a cost. */
  | 'window_reset'
  /** The provider reports no window the subscription can be divided over. */
  | 'no_window'
  /** A free or self-hosted plan: known, and with no price to divide. */
  | 'unpriced_plan'
  /** No plan could be resolved at all. */
  | 'no_plan'
  /**
   * No meter reached this run: neither a subscription window nor a spend meter had anything to say.
   *
   * ⚠️ Distinct from `no_reading`, which means a meter exists and this run fell between two of its
   * readings. This one means there was nothing to read from in the first place.
   */
  | 'no_meter'

/**
 * A run's cost in money, with the basis every cost belief in this repo has to carry.
 *
 * ⛔ **Money here is layered, and `usd` is the headline sum of exactly two of the layers.**
 * Every agent on this fleet runs on a subscription, so what an operator pays is an amortised share
 * of a flat monthly fee (`subscriptionUsd`) **plus** whatever was billed directly on top of it
 * (`overageUsd`). `listUsd` is carried beside them and is **never** part of `usd` — see its own
 * note. See daemon/price.ts and docs/cost-model.md §13.
 */
export interface RunPrice {
  /**
   * The headline: `subscriptionUsd + overageUsd`, treating `null` as *absent* rather than zero.
   *
   * ⛔ `null` is `n/a`, and `reason` says which `n/a`. Never rendered as $0.00. Where only one
   * of the two layers could be priced this is that layer alone, and `basis` says the total is a
   * lower bound.
   *
   * ⚠️ Kept as the field name, and as the number every existing call site already reads, so that
   * adding the layers below broke no surface that only ever wanted "what did this cost".
   */
  usd: number | null
  /**
   * This run's share of the billing window × the plan's monthly fee.
   *
   * ⚠️ **Amortised, not cash.** Nobody is charged this at the moment the run happens; the
   * subscription was already paid. It is what the run consumed *of* that payment.
   */
  subscriptionUsd: number | null
  /**
   * Directly-measured pay-as-you-go dollars: Claude extra-usage overage, Antigravity cloud credits,
   * Codex credits. Attributed from `spend_samples` the same way the window percent is.
   */
  overageUsd: number | null
  /**
   * What the same work would have cost on the vendor's market-rated API.
   *
   * ⛔ **Never part of `usd`, and never summed with either layer above.** It answers "is the
   * subscription worth it", which is a different question from "what did this cost me"; adding it
   * would double-count a bill that was never issued.
   */
  listUsd: number | null
  /** Whether this run was drawing on paid overage rather than the subscription. `null` = unknown. */
  onOverage: boolean | null
  /** The share of the billing window attributed to this run. */
  percent: number | null
  /** The `*`: a split, a stale reading, or a run still in flight. */
  estimated: boolean
  reason: PriceReason
  /** One sentence, straight into the tooltip. */
  basis: string
  planId: string | null
  planLabel: string | null
  /** How the plan was decided: from the run's own window shape, the vendor string, or a default. */
  planSource: 'window_shape' | 'identity' | 'neighbour' | 'default' | 'stored' | null
  windowId: string | null
  /** Runs that held the same window at the same time. */
  parallelRunIds: string[]
}

/** A quota reading kept beside a run, with enough of its basis to be distrusted properly. */
export interface RunQuota {
  windows: Array<{ id: string; label: string; percent: number }>
  sampledAt: number
  /** True when this was the best available reading and was already too old to act on. */
  stale: boolean
}

/**
 * How a run ended.
 *
 * ⛔ **`blocked` is not a kind of failure.** A run that stopped because the agent asked a person
 * something did work, metered turns, and is one answer away from continuing — filing that as `failed`
 * says the opposite of what happened, and it was doing so on the strength of nothing more than the
 * absence of a completion signal. Measured 2026-08-30 (R14.c): the CLI says which of the two it is,
 * in `post_turn_summary`, and the terminal record cannot.
 *
 * ⚠️ `blocked` is still not `completed`, and nothing that reasons about finished work may treat it as
 * one: the estimator medians `completed` runs only, because a run that stopped half way through is
 * not a measurement of what the whole job costs.
 */
export type RunOutcome =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'terminated'
  | 'preempted'

// ---------------------------------------------------------------------------- approval

export type ApprovalOrigin = 'permission_prompt' | 'tool_gate' | 'resource_gate'
export type ApprovalDecision = 'allow' | 'allow_always' | 'deny'
export type ApprovalPolicyResult = 'auto_allow' | 'auto_deny' | 'escalate'

export interface Approval {
  id: string
  sessionId: string
  runId: string | null
  taskId: string | null
  projectId: string | null
  origin: ApprovalOrigin
  tool: string
  target: string | null
  /** A one-line rendering of what is about to happen, supplied by the caller, never inferred. */
  summary: string
  policyResult: ApprovalPolicyResult
  matchedRule: string | null
  askedAt: number
  /** The blocked session's cache expiry. Waiting is priced, which is why this is not a notification. */
  deadlineAt: number | null
  escalateAfterMs: number
  answeredAt: number | null
  answer: ApprovalDecision | null
  answeredBy: 'policy' | 'human' | 'timeout' | null
  escalatedAt: number | null
}

// ---------------------------------------------------------------------------- question

/**
 * A question put to a person by an agent that is still running.
 *
 * ⛔ **The third object, and it is neither of the other two.** A Task is schedulable, durable and
 * outlives every session. An Approval is an interrupt on one live session whose answer set is closed
 * at allow/deny and whose answer can become a rule. A Question is an interrupt like the second with
 * an answer set supplied by **whoever asked** — and an answer that is *content*, returned into the
 * tool result, not a verdict. You cannot remember the answer to "which auth approach" as a project
 * rule, and a default of "no" answers nothing.
 *
 * ⚠️ It can outlive its session. See `parkedAt`.
 */
export type QuestionKind = 'text' | 'choice' | 'multi'

/**
 * Where the question came from.
 *
 * ⚠️ `native_tool` is a question the vendor's own CLI raised — measured on Claude Code's
 * `AskUserQuestion`, 2026-08-30 — and it arrives whether or not the agent was ever told this tool
 * exists. `ask_human` is one the agent asked for deliberately. Worth keeping apart: the first says
 * something about the CLI, the second about the prompt.
 */
export type QuestionOrigin = 'ask_human' | 'native_tool' | 'checkpoint' | 'task_split'

export interface QuestionOption {
  id: string
  label: string
  /** The asker's own prose about what choosing this means. Never summarised or rewritten. */
  detail?: string
}

export interface QuestionAnswer {
  /** Empty for a `text` question; one entry for `choice`; any number for `multi`. */
  optionIds: string[]
  /** Free text, which every kind may carry — an option plus a caveat is a common and useful answer. */
  text: string | null
}

export interface Question {
  id: string
  sessionId: string
  runId: string | null
  taskId: string | null
  projectId: string | null
  origin: QuestionOrigin
  kind: QuestionKind
  question: string
  /** A short label for the question, where the asker gave one. Claude Code's `AskUserQuestion` does. */
  header: string | null
  options: QuestionOption[]
  askedAt: number
  /** The blocked session's cache expiry. Waiting is priced, which is why this is not a notification. */
  deadlineAt: number | null
  answeredAt: number | null
  answer: QuestionAnswer | null
  answeredBy: 'human' | null
  /**
   * When the session that asked went away with this still open.
   *
   * ⛔ A parked question is **not** an answered one and not a closed one. D1: nobody answered before
   * the cache expired, so holding the process stopped paying for itself and the task went to
   * `awaiting_human` — but the question is exactly as valid as it was, and answering it is what
   * starts the work again. Timing out has never been an answer here.
   */
  parkedAt: number | null
}

/** What the asker is told. `reply` is the sentence handed back to the agent, wherever it asked from. */
export interface QuestionResolution {
  status: 'answered' | 'parked' | 'void'
  reply: string
  answer: QuestionAnswer | null
}

/**
 * Detect whether a question was intended to be multi-select / checkboxes.
 *
 * Checks for:
 * 1. Bracketed tags like `[multi]`, `[multi-select]`, `[checkbox]`, `(multi-select)`, `(select all that apply)`
 * 2. Explicit multi-select phrases like "pick everything", "select all", "choose all", "check all", "any number of", "all that apply", "multiple options", etc.
 * 3. Header tags like "multi", "checkbox"
 */
export function isMultiSelectQuestion(
  question: string,
  options?: Array<{ label?: string; detail?: string } | string>,
  header?: string
): boolean {
  if (header && /\b(multi|multi-?select|checkbox(?:es)?)\b/i.test(header)) return true
  if (/\[(multi|multi-?select|checkbox(?:es)?)\]/i.test(question)) return true
  if (/\((multi|multi-?select|multiple|checkbox(?:es)?|select all that apply)\)/i.test(question)) return true
  if (
    /\b(pick everything|select all|choose all|check all|check any|select any|choose any|any number of|all that apply|all of the above|everything that applies|multiple options|more than one option|multiple choices)\b/i.test(
      question
    )
  ) {
    return true
  }
  if (options) {
    for (const opt of options) {
      const text = typeof opt === 'string' ? opt : `${opt.label ?? ''} ${opt.detail ?? ''}`
      if (/\b(select all that apply|all that apply|check all|multiple choices)\b/i.test(text)) {
        return true
      }
    }
  }
  return false
}

/** Clean bracketed multi-select tags from question text so they don't clutter the UI. */
export function cleanQuestionText(text: string): string {
  return text
    .replace(/\s*\[(multi|multi-?select|checkbox(?:es)?)\]\s*/gi, ' ')
    .replace(/\s*\((multi|multi-?select|checkbox(?:es)?)\)\s*/gi, ' ')
    .trim()
}

/**
 * Extract embedded XML parameters (e.g. from models that output `<parameter name="header">...`
 * or `</question>` in their tool arguments, as measured on claude-code in t191).
 */
export function extractEmbeddedParameters(rawQuestion: string): {
  question: string
  header?: string
  multiSelect?: boolean
} {
  let question = rawQuestion
  let header: string | undefined
  let multiSelect: boolean | undefined

  const headerMatch = /<parameter\s+name=["']header["']>([^<]+)(?:<\/parameter>|$)/i.exec(question)
  if (headerMatch?.[1]) {
    header = headerMatch[1].trim()
    question = question.replace(headerMatch[0], '').trim()
  }

  const multiMatch =
    /<parameter\s+name=["'](?:multi_select|multiSelect|is_multi_select|multiple)["']>([^<]+)(?:<\/parameter>|$)/i.exec(
      question
    )
  if (multiMatch?.[1]) {
    multiSelect = /^(true|1|yes)$/i.test(multiMatch[1].trim())
    question = question.replace(multiMatch[0], '').trim()
  }

  question = question.replace(/<\/?question>/gi, '').trim()

  return { question, header, multiSelect }
}

/** A remembered answer. `Bash(npm test)`-shaped, matched by tool plus a glob over the target. */
export interface ApprovalRule {
  id: string
  projectId: string | null
  tool: string
  pattern: string
  effect: 'allow' | 'deny'
  createdBy: 'human' | 'project-config'
  createdAt: number
}

// ---------------------------------------------------------------------------- resources

export type ResourceKind = 'exclusive' | 'counted' | 'rate_limited'

/**
 * Anything contended for. Workspaces are just a counted Resource, which collapses two mechanisms
 * into one: if the scheduler owns the claim, the lock is unnecessary.
 */
export interface Resource {
  id: string
  projectId: string | null
  kind: ResourceKind
  label: string
  capacity: number
  /** For a pool, the identity of each member - a workspace path, a profile name, a port block. */
  members: string[]
  meta: Record<string, unknown>
}

export interface ResourceClaim {
  id: string
  resourceId: string
  member: string | null
  holder: string
  amount: number
  acquiredAt: number
  releasedAt: number | null
}

export interface ResourceAvailability {
  resource: Resource
  inUse: number
  free: number
  claims: ResourceClaim[]
}

// ---------------------------------------------------------------------------- objectives

/**
 * What the operator is optimising for, as a weight vector summing to 1.
 *
 * ⛔ Presets are just named vectors, and nothing may branch on a preset's *name*. The vector is
 * consumed in exactly two places - scheduler scoring and a cost policy object - and the effective
 * objective is recorded on every Run, so "why did it pick that" is answerable months later.
 */
export interface Objective {
  cost: number
  velocity: number
  quality: number
}

export type ObjectivePreset = 'economy' | 'balanced' | 'velocity' | 'quality'
export type ObjectiveChoice = ObjectivePreset | Objective | 'inherit'

export const PRESETS: Record<ObjectivePreset, Objective> = {
  economy: { cost: 0.7, velocity: 0.15, quality: 0.15 },
  balanced: { cost: 0.34, velocity: 0.33, quality: 0.33 },
  velocity: { cost: 0.15, velocity: 0.7, quality: 0.15 },
  quality: { cost: 0.15, velocity: 0.15, quality: 0.7 }
}

export const OBJECTIVE_PRESET_ORDER: ObjectivePreset[] = ['balanced', 'economy', 'velocity', 'quality']

export const OBJECTIVE_PRESET_LABELS: Record<ObjectivePreset, string> = {
  balanced: 'balanced (34% cost, 33% velocity, 33% quality)',
  economy: 'economy (70% cost, 15% velocity, 15% quality)',
  velocity: 'velocity (15% cost, 70% velocity, 15% quality)',
  quality: 'quality (15% cost, 15% velocity, 70% quality)'
}

export const DEFAULT_OBJECTIVE: Objective = PRESETS.balanced

export function normalise(objective: Partial<Objective>): Objective {
  const cost = Math.max(0, objective.cost ?? 0)
  const velocity = Math.max(0, objective.velocity ?? 0)
  const quality = Math.max(0, objective.quality ?? 0)
  const total = cost + velocity + quality
  if (total === 0) return DEFAULT_OBJECTIVE
  return { cost: cost / total, velocity: velocity / total, quality: quality / total }
}

/** A preset name, an explicit vector, or nothing. Presets are just named vectors. */
export function parseObjective(value: unknown): Objective | null {
  if (typeof value === 'string') {
    const preset = PRESETS[value.toLowerCase() as ObjectivePreset]
    return preset ? { ...preset } : null
  }
  if (value && typeof value === 'object') {
    const record = value as Partial<Objective>
    if ('cost' in record || 'velocity' in record || 'quality' in record) return normalise(record)
  }
  return null
}

/** Return the matching preset name if the objective matches a preset vector, or null if custom. */
export function presetOf(objective: Objective): ObjectivePreset | null {
  const eps = 0.005
  for (const [key, preset] of Object.entries(PRESETS) as Array<[ObjectivePreset, Objective]>) {
    if (
      Math.abs(objective.cost - preset.cost) < eps &&
      Math.abs(objective.velocity - preset.velocity) < eps &&
      Math.abs(objective.quality - preset.quality) < eps
    ) {
      return key
    }
  }
  return null
}

/**
 * What the cache clock decided to do with a session, and why.
 *
 * ⚠️ `revive_compact` is the one move that acts on a session with **no process**: it starts one, for
 * the sole purpose of compacting a conversation before its prompt cache lapses, and closes it again.
 * Every other move is a prompt sent to something already running.
 */
export type CacheMove =
  | 'dispatch'
  | 'keepalive'
  | 'compact'
  | 'revive_compact'
  | 'let_expire'
  | 'handoff_close'
  | 'none'

export interface ClockDecision {
  sessionId: string
  move: CacheMove
  reason: string
  contextTokens: number | null
  expectedIdleMs: number | null
  /** Input-token-equivalents this move is expected to cost. */
  estimatedCost: number | null
  expiresAt: number | null
}

/**
 * One compaction: asked for, or observed, and what it left behind.
 *
 * ⚠️ **Three nullable numbers, and each null means something different from zero.** `preTokens` is
 * null when the CLI did not say how big the context was; `postTokens` is null until a turn measures
 * the compacted context, and stays null forever if the session never runs another; `landedAt` is
 * null on a compaction that was **asked for and never happened** - the case worth seeing, and the
 * one a success-only ledger would hide.
 */
export interface Compaction {
  id: number
  sessionId: string
  taskId: string | null
  /** `clock` - this fleet bought it. `agent` - the agent asked. `auto` - the CLI did it unprompted. */
  trigger: 'clock' | 'agent' | 'auto'
  reason: string | null
  preTokens: number | null
  postTokens: number | null
  durationMs: number | null
  askedAt: number | null
  landedAt: number | null
  ts: number
}

export interface ReserveReport {
  workerId: string
  verdict: 'ok' | 'at_risk' | 'unknown'
  requiredTokens: number
  remainingTokens: number | null
  liveSessions: number
  reason: string
}

// ---------------------------------------------------------------------------- controller

/**
 * A judgment event.
 *
 * ⛔ **Every one of these has a deterministic fallback, and the fallback is what happens by default.**
 * The scheduler enqueues a consult and carries on; if the controller is out of quota, mis-configured,
 * slow or wrong, the fallback fires on a timer and the fleet keeps working. That is the whole reason
 * the controller can be an LLM at all: it is never in the critical path, only ever an improvement on
 * an answer that already exists.
 *
 *  - `decompose` — a coarse goal becomes draft children with dependency edges. Plan §18.1.
 *  - `triage`    — a task that has failed twice: retry, rewrite, escalate, or hand to a person.
 *  - `gate`      — an agent filed a task at a controller gate: accept, rescope, reject, escalate. §7.2.
 *  - `route`     — two workers score within ε on an expensive task. The weakest of the four, and
 *                  gated hardest, because a tie means the alternatives are by definition close.
 *  - `title`     — a task whose prompt is a paragraph gets a one-line label for the board. The only
 *                  kind that changes nothing about what runs: it writes `titleSummary`, which
 *                  nothing but the UI reads, so its fallback is to go on showing the prompt.
 */
export type ConsultKind = 'decompose' | 'triage' | 'gate' | 'route' | 'title'

export type ConsultStatus = 'pending' | 'answered' | 'fallback' | 'failed'

export interface Consult {
  id: string
  kind: ConsultKind
  /** The task this is about, where there is one. */
  subjectId: string | null
  subjectSeq?: number | null
  subjectTitle?: string | null
  status: ConsultStatus
  question: string
  /**
   * The working shown *only to a person*: the score legend and every candidate's term-by-term
   * derivation, in full.
   *
   * ⛔ **Generated exactly as before, and deliberately not in `question`.** The derivation is
   * debugging evidence - it answers "why did the arithmetic land there" for a human reading the
   * judgment call afterwards - and putting it in the prompt charged every routing consult for
   * fifteen lines of legend plus nine lines per candidate that the controller does not need to
   * pick an id. The prompt now carries the totals and one line of what was weighed; this carries
   * the rest, and nothing reads it but the UI.
   *
   * ⚠️ Null for kinds that have no arithmetic behind them (decompose, triage, gate).
   */
  detail: string | null
  workerId: string | null
  workerLabel?: string | null
  sessionId: string | null
  answer: unknown
  /** What was applied, in one line. Populated for answers and fallbacks alike. */
  outcome: string | null
  /** Why the deterministic answer was used: no controller, out of time, or a malformed reply. */
  fallbackReason: string | null
  /** Metered from the consult session's own transcript. A judgment call is not free. */
  spentTokens: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

/** Whether an agent-filed task is admitted, reviewed by the controller, or handed to a person. §7.2. */
export type RiskGate = 'auto' | 'controller' | 'human'

export interface ChatMessage {
  id: number
  threadId: string
  role: 'human' | 'controller' | 'system'
  text: string
  sessionId: string | null
  /** The controller worker that served this message, retained for an auditable conversation. */
  workerLabel?: string | null
  ts: number
}

// ---------------------------------------------------------------------------- landing

export type LandingStrategyId =
  | 'auto-land'
  | 'leave-branch'
  | 'pull-request'
  /** Run the project's checks against the branch as committed, and report. Moves nothing. */
  | 'verify-only'
  /** Rebase, check, fast-forward the **local** trunk, retire the branch. No remote. */
  | 'merge-local'
  /**
   * Rebase, check, and fast-forward a target **ref** that is checked out nowhere.
   *
   * ⛔ The strategy a split child lands with, and it exists because `merge-local` cannot do this.
   * `merge-local` runs `git merge --ff-only` inside the operator's own trunk checkout and is gated
   * on that checkout having the target *checked out* — correct, because git refuses to update a
   * branch a worktree holds. A child landing onto its plan branch would therefore require the
   * operator's checkout to be sitting on the plan branch, which is never acceptable: the trunk is
   * the operator's, and agents work in a pooled worktree.
   *
   * ⚠️ Chosen from **data** — whether the task's resolved landing target is the project's own — and
   * never from `task.kind`. A landing path that branches on a mode name is the thing this codebase
   * refuses everywhere else.
   */
  | 'merge-branch'

/**
 * What happens to a task's work when the agent says it is finished.
 *
 * ⛔ **One field, replacing three half-answers.** Until 2026-08-28 this question was split across
 * `landing.strategy` (project only), `task.verification` (task only, and named after a different
 * idea), and nothing at all at the fleet level — so "why did this not land?" needed two fields
 * checked in two files, and neither of them could be changed while a task was running.
 *
 * ⚠️ Not the same question as `mandate.allowed` ⊇ `'land'`, which stays exactly where it is. That is
 * **authority** — may this task ever land — and it is inherited down a lineage precisely so an
 * agent-spawned subtask cannot grant itself more than its parent had. This is **preference**: given
 * that it may, should it, unattended. A dropdown may set a preference; nothing settable in the UI
 * may widen an authority.
 */
export type FinishPolicy =
  /** Stop. The branch is intact, the work is preserved, a person decides. */
  | 'await-human'
  /**
   * The agent commits on its branch. Nothing is verified and nothing is merged.
   *
   * WARNSIGN For early work and single-trunk projects, where there is often no suite to run yet.
   */
  | 'commit-only'
  /**
   * Commit, then run the project's declared `check` commands and report the verdict.
   *
   * ⛔ The **commit is unconditional; the verdict is not**. The daemon never authors a commit,
   * so verification can only happen after there is something to verify - `commit-after-verified`
   * was considered and cannot exist. A red check rests the task carrying the output and the commit
   * stays, because destroying committed work is the one thing this tool refuses to do.
   */
  | 'commit-and-verify'
  /**
   * The above, and then fast-forward the **local** trunk and retire the branch. No remote.
   *
   * ⛔ Merging always verifies, which is why `verify` is not in the name: merging unverified
   * work into the trunk is worse than leaving it on a branch.
   *
   * WARNSIGN Only into a **clean** trunk. Git refuses to update a branch a worktree holds, and the
   * operator's own checkout is usually that worktree - so a dirty or busy trunk means the branch is
   * kept and the task says so. The tool never stashes or resets a checkout somebody is typing in.
   */
  | 'commit-and-merge'
  /**
   * The above, and push the trunk to its remote.
   *
   * WARNSIGN The pre-2026-08-30 default, under its old name `agent-lands`. It stopped being the
   * default because a push is not free: on this install every push to `main` started a ten-job CI
   * matrix, 103 runs in five days, and the account's CI allowance ran out on 2026-08-29.
   */
  | 'commit-and-push'
  /** Push the branch and open a pull request; a human merges. */
  | 'pull-request'
  /**
   * Do whatever this project says finishing means.
   *
   * ⚠️ An **instruction to the agent**, never a command the daemon runs. Deciding what to stage,
   * what to leave, and what to test first is judgement that differs per project and per person —
   * it is what a `/commit` skill encodes — and a daemon running it headless would be a worse copy
   * of that judgement applied with less context at the one moment nobody is watching.
   */
  | 'custom'

/**
 * The same question at the project and task tiers, where "say nothing" is a real answer.
 *
 * ⛔ `inherit` is a distinct value, not a missing one. A task that has never been touched and a task
 * somebody deliberately set to the fleet default look identical without it, and the second is a
 * decision worth keeping when the default later changes.
 */
export type FinishPolicyChoice = FinishPolicy | 'inherit'

/** Where a resolved policy came from, so the UI can say "inherited from the project". */
export interface ResolvedFinishPolicy {
  policy: FinishPolicy
  source: 'task' | 'project' | 'fleet'
  /** Only for `custom`: what the agent is told to do. */
  instruction: string | null
}

/**
 * ⚠️ The instruction a `custom` policy sends when a project has not written its own. Deliberately
 * names a slash command: on Claude Code that resolves to the project's skill, and on an adapter
 * with no skills it still reads as a sentence an agent can act on.
 */
/**
 * ⚠️ The fleet default, and it lives here rather than in `finish.ts` because `settings.ts`
 * needs it and `finish.ts` needs `settings.ts` - a cycle that resolves to `undefined` at import time
 * and would have made the fleet tier silently empty.
 *
 * ⛔ **`commit-and-merge`, not `commit-and-push`, since 2026-08-30.** The old default pushed
 * the trunk on every completed task, and every push to `main` starts a ten-job CI matrix - three of
 * them macOS, which bills at 10x. Measured on this install: 103 runs in five days, 39 in one day, and
 * the account's CI allowance exhausted on 2026-08-29. Nothing about finishing a task needed a remote.
 * A push is now something a person does on purpose.
 */
export const DEFAULT_FLEET_FINISH: FinishPolicy = 'commit-and-merge'

/** The pre-2026-08-30 spelling of `commit-and-push`, still read off any config that has it. */
const LEGACY_FINISH: Record<string, FinishPolicy> = { 'agent-lands': 'commit-and-push' }

/**
 * Read a finish policy written by any version of this tool.
 *
 * ⛔ A rename that silently changed what an existing `project.json` *does* would be worse than
 * the bug it fixes. `agent-lands` meant "push the trunk" when it was written, and it still does.
 */
export function readFinishPolicy(raw: unknown): FinishPolicyChoice | null {
  if (typeof raw !== 'string') return null
  const migrated = LEGACY_FINISH[raw] ?? raw
  return (FINISH_ORDER as readonly string[]).includes(migrated) || migrated === 'inherit'
    ? (migrated as FinishPolicyChoice)
    : null
}

/**
 * The ladder, in order. Each rung does everything the one below does plus one thing.
 *
 * ⚠️ `pull-request` and `custom` are deliberately last and are **not rungs**: a PR pushes the
 * branch and never touches the trunk, and `custom` is an instruction to the agent rather than an
 * action the daemon takes.
 */
export const FINISH_ORDER: FinishPolicy[] = [
  'await-human',
  'commit-only',
  'commit-and-verify',
  'commit-and-merge',
  'commit-and-push',
  'pull-request',
  'custom'
]

export const FINISH_LABELS: Record<FinishPolicy, string> = {
  'await-human': 'await human',
  'commit-only': 'commit only',
  'commit-and-verify': 'commit, then verify',
  'commit-and-merge': 'commit, verify and merge locally',
  'commit-and-push': 'commit, verify, merge and push',
  'pull-request': 'open a pull request',
  'custom': 'this project’s own policy'
}

/**
 * The same ladder, short enough to sit on a pill beside five other controls.
 *
 * ⛔ A second map of the same keys, so it is a second chance to drift — `tasks.test.ts` asserts it
 * covers `FINISH_ORDER` exactly and adds nothing to it, which is the only reason a short form is
 * allowed to exist at all. The **long** label is what the menu shows; this is what is left on the
 * button once the menu closes, and the two must name the same policy.
 */
export const FINISH_SHORT: Record<FinishPolicy, string> = {
  'await-human': 'Await human',
  'commit-only': 'Commit',
  'commit-and-verify': 'Commit·Verify',
  'commit-and-merge': 'Commit·Verify·Merge',
  'commit-and-push': 'Commit·Verify·Merge·Push',
  'pull-request': 'Pull request',
  'custom': 'Project policy'
}

/**
 * Does this policy ask the daemon to run the project's checks?
 *
 * ⛔ `commit-only` deliberately does not. Each rung does strictly more than the one below, and
 * the early-phase case it exists for usually has no suite to run.
 */
export function policyVerifies(policy: FinishPolicy): boolean {
  return policy === 'commit-and-verify' || policy === 'commit-and-merge' || policy === 'commit-and-push'
}

/**
 * A policy that promises verification, on a project that has declared none.
 *
 * ⛔ An empty `check` list must never read as a clean verification. Every project starts this
 * way, so without this warning `commit-and-merge` would merge unverified work and call it verified on
 * the first day of every project - and the policy's name would be a lie.
 */
export function verificationWarning(
  policy: FinishPolicy,
  checkCount: number
): string | null {
  if (!policyVerifies(policy) || checkCount > 0) return null
  return (
    `${FINISH_LABELS[policy]} verifies nothing here: this project declares no check commands. ` +
    'Add them in Project settings, or file a task to work them out.'
  )
}

/**
 * May a task be given a conversation another task has already been having?
 *
 * ⛔ The saving is real and measured - a cold Claude turn cost **41,542 cache-creation tokens** on
 * 2026-08-28 for a trivial prompt in an empty directory, and a resumed one read all of it back for 65
 * - but it is not free of consequence. An agent joining a conversation *sees everything said in it*,
 * so this is an information boundary, and the answer belongs to whoever owns the project rather than
 * to the scheduler.
 *
 * ⚠️ Authority is elsewhere and this cannot widen it. `mandate` still decides what a task may do;
 * turning sharing on lets a task read a conversation, never act beyond what it was granted.
 */
export type SessionSharing =
  /** Every task opens its own conversation. What the tool did before any of this existed. */
  | 'off'
  /** A task may join a conversation already open in its project, when the gates allow. */
  | 'on'

export type SessionSharingChoice = SessionSharing | 'inherit'

/** Where a resolved answer came from, so the UI can say "inherited from the project". */
export interface ResolvedSessionSharing {
  sharing: SessionSharing
  source: 'task' | 'project' | 'fleet'
}

/**
 * ⛔ **Off**, and deliberately the opposite default from `DEFAULT_FLEET_FINISH`. Finishing has to do
 * *something* when a task ends, so its default is the useful one; sharing changes who can see whose
 * work, and a default that quietly widened that on upgrade would be a change nobody asked for made to
 * every project at once.
 */
export const DEFAULT_FLEET_SHARING: SessionSharing = 'off'

export const SHARING_LABELS: Record<SessionSharing, string> = {
  on: 'reuse one if possible',
  off: 'always start a new one'
}

/** The pill form of the above. Same rule as `FINISH_SHORT`: pinned by a test, never hand-synced. */
export const SHARING_SHORT: Record<SessionSharing, string> = {
  on: 'Reuse',
  off: 'Fresh'
}

/**
 * May the cache clock spend a `/compact` on the conversation this task is holding?
 *
 * ⛔ **A preference, and never a capability.** Whether an agent *can* be asked to compact is
 * `capabilities.manualCompact`, declared by the adapter — Codex takes one prompt per session and
 * has no `/compact` at all, Antigravity does not implement one. This answers the second question
 * only, *should we*, and it is asked after the capability question has already said yes. A task set
 * to `on` against an adapter that cannot compact stays exactly as inert as the fleet switch is
 * there, which is the whole reason the two are separate values rather than one tri-state.
 *
 * ⚠️ **It changes the answer to "may I compact?" and nothing downstream of it.** Context size, growth
 * since the last compaction, the cache TTL, the reserve and the cost model all still decide *whether
 * this particular compaction buys anything* — so turning it on schedules a compaction on exactly the
 * terms the fleet switch would have, at exactly the moment the clock would have chosen. It is a
 * permission, not an instruction, and it is emphatically not a "compact now" button.
 */
export type AutoCompact =
  /** Compact when the clock works out that a compaction is worth its tokens. */
  | 'on'
  /** Never spend a compaction on this task's conversation, whatever the fleet is set to. */
  | 'off'

export type AutoCompactChoice = AutoCompact | 'inherit'

export interface ResolvedAutoCompact {
  autoCompact: AutoCompact
  /**
   * ⚠️ Travels with the answer for the same reason it does on sharing and completion: a value whose
   * origin is invisible is one nobody trusts. The picker says *inherit (compact when it is worth
   * it)* rather than showing a bare `inherit` the operator has to go and look up.
   */
  source: 'task' | 'fleet'
}

export const AUTO_COMPACT_LABELS: Record<AutoCompact, string> = {
  on: 'compact when it is worth it',
  off: 'never compact'
}

/**
 * Task, then fleet — the first that is not `inherit`.
 *
 * ⛔ **Two tiers, not the three that sharing, completion and objective use, and the omission is a
 * decision rather than an oversight.** Those three answer questions a *project* plausibly owns —
 * who may read whose conversation, how a repository is landed. This one is spending policy on one
 * account's window, which is a fleet-wide concern with per-task exceptions and has no natural
 * middle. Adding the tier later is an additive `session.autoCompact` key in project.json and one
 * more branch here; adding it now would be surface nobody asked for.
 *
 * ⚠️ `inherit` is a real value. A task left on it follows the Settings > Global switch as that
 * switch changes; a task set explicitly to the same value does not — which is precisely what an
 * operator wants when they pin one long-running task's behaviour and then go and change the fleet.
 */
export function resolveAutoCompact(
  task: Pick<Task, 'autoCompact'> | null | undefined,
  fleetAutoCompact: boolean
): ResolvedAutoCompact {
  if (task && task.autoCompact !== 'inherit') {
    return { autoCompact: task.autoCompact, source: 'task' }
  }
  return { autoCompact: fleetAutoCompact ? 'on' : 'off', source: 'fleet' }
}

/**
 * How far a dispatched agent is expected to get before it stops.
 *
 * ⛔ Two different things, and neither is "how careful should you be". `autonomous` says
 * *finish the whole task*, and an agent on it still stops for a decision that changes what it builds
 * - that is what `ask_human` is for, and it is never discouraged. `checkpointed` says *report at each
 * phase boundary and wait*, which is a different contract: the agent is being steered.
 */
export type CompletionMode = 'autonomous' | 'checkpointed'
export type CompletionModeChoice = CompletionMode | 'inherit'

export interface ResolvedCompletionMode {
  mode: CompletionMode
  source: 'task' | 'project' | 'fleet'
}

/**
 * ⛔ `autonomous`, because the premise of the tool is unattended progress across quota windows
 * that are hours long. A fleet defaulting to `checkpointed` would need a person present for every
 * task, which is the thing this exists not to require. Interactivity is chosen, per task, for the
 * work that is worth steering.
 */
export const DEFAULT_FLEET_COMPLETION: CompletionMode = 'autonomous'

export const COMPLETION_LABELS: Record<CompletionMode, string> = {
  autonomous: 'run to the end',
  checkpointed: 'check in at each phase'
}

export function projectCompletionChoice(
  project: Project | null | undefined
): CompletionModeChoice {
  const raw = project?.config?.session?.completion
  return raw === 'autonomous' || raw === 'checkpointed' || raw === 'inherit' ? raw : 'inherit'
}

/** Task, then project, then fleet - the same three tiers as finish and sharing, and `inherit` is real. */
export function resolveCompletionMode(
  task: Task | null | undefined,
  project: Project | null | undefined,
  fleetMode: CompletionMode = DEFAULT_FLEET_COMPLETION
): ResolvedCompletionMode {
  if (task && task.completionMode !== 'inherit') {
    return { mode: task.completionMode, source: 'task' }
  }
  if (project) {
    const choice = projectCompletionChoice(project)
    if (choice !== 'inherit') return { mode: choice, source: 'project' }
  }
  return { mode: fleetMode, source: 'fleet' }
}

/** The pre-2026-08-28 spelling, still read off any project.json that has not been rewritten. */
const FROM_STRATEGY: Record<string, FinishPolicy> = {
  'auto-land': 'commit-and-push',
  'leave-branch': 'await-human',
  'pull-request': 'pull-request'
}

/**
 * The project's finish choice, from either spelling.
 *
 * ⛔ `finish` wins over `strategy` when both are present. A file carrying both was written by
 * somebody who edited it after this landed, and the new field is the one they meant.
 */
export function projectFinishChoice(project: Project | null | undefined): FinishPolicyChoice {
  const landing = project?.config?.landing
  // ⛔ Through `readFinishPolicy`, so a file still saying `agent-lands` keeps doing what it
  // said when it was written - pushing the trunk - rather than silently acquiring the new default.
  if (landing?.finish) return readFinishPolicy(landing.finish) ?? 'inherit'
  if (landing?.strategy) return FROM_STRATEGY[landing.strategy] ?? 'inherit'
  return 'inherit'
}

export function projectSharingChoice(project: Project | null | undefined): SessionSharingChoice {
  const raw = project?.config?.session?.share
  return raw === 'on' || raw === 'off' || raw === 'inherit' ? raw : 'inherit'
}

export function finishInstructionFor(project: Project | null | undefined): string {
  return project?.config?.landing?.finishInstruction?.trim() || DEFAULT_FINISH_INSTRUCTION
}

function pickCustomInstruction(policy: FinishPolicy, instruction: string): string | null {
  return policy === 'custom' ? instruction : null
}

/**
 * Task, then project, then fleet - the first one that is not `inherit`.
 *
 * ⚠️ The `source` travels with the answer so the UI can say *inherited from the project* rather than
 * showing a value the operator will look for on the task and not find. A setting whose origin is
 * invisible is one nobody trusts and everybody overrides.
 */
export function resolveFinishPolicy(
  task: Task | null | undefined,
  project: Project | null | undefined,
  fleetFinish: FinishPolicy = DEFAULT_FLEET_FINISH
): ResolvedFinishPolicy {
  const instruction = finishInstructionFor(project)

  if (task && task.finishPolicy !== 'inherit') {
    return {
      policy: task.finishPolicy,
      source: 'task',
      instruction: pickCustomInstruction(task.finishPolicy, instruction)
    }
  }
  if (project) {
    const choice = projectFinishChoice(project)
    if (choice !== 'inherit') {
      return {
        policy: choice,
        source: 'project',
        instruction: pickCustomInstruction(choice, instruction)
      }
    }
  }
  return {
    policy: fleetFinish,
    source: 'fleet',
    instruction: pickCustomInstruction(fleetFinish, instruction)
  }
}

/**
 * Resolve task → project → fleet, taking the first that is not `inherit`.
 *
 * ⚠️ `inherit` is a real value, not a blank. A task left on it follows its project as the project
 * changes; a task set explicitly to the same value does not. That difference is the reason the
 * dropdown offers it rather than showing an empty box.
 */
export function resolveSessionSharing(
  task: Task | null | undefined,
  project: Project | null | undefined,
  fleetSharing: SessionSharing = DEFAULT_FLEET_SHARING
): ResolvedSessionSharing {
  if (task && task.sessionSharing !== 'inherit') {
    return { sharing: task.sessionSharing, source: 'task' }
  }
  if (project) {
    const choice = projectSharingChoice(project)
    if (choice !== 'inherit') return { sharing: choice, source: 'project' }
  }
  return { sharing: fleetSharing, source: 'fleet' }
}

/**
 * Work that exists and is going nowhere.
 *
 * ⛔ **Preserving work silently is only half a fix.** `rescueDirt` stashes what a run left behind so
 * the next task can claim the slot, and `leave-branch` keeps a branch intact when landing is
 * refused — both correct, and both invisible, which makes them indistinguishable from loss to the
 * person who wanted the work. t5's commit sat on its branch for a day; the stash that preserved
 * ws1's edits was found only because somebody went looking with `git stash list`.
 *
 * ⚠️ Derived on demand, never a table. A loose end is a *fact about a repository right now* — the
 * branch got landed by hand, the stash got popped, somebody cleaned the slot — and a cached copy of
 * that fact would be wrong within minutes and would need its own reconciliation. Only the
 * dismissals are stored, because "I know, leave me alone" is the one part git cannot tell us.
 */
export interface LooseEnd {
  /** Stable across scans, so a dismissal sticks to the thing dismissed. */
  id: string
  kind: 'uncommitted' | 'unlanded' | 'stash' | 'stranded'
  projectId: string
  projectName: string
  workspacePath: string
  branch: string | null
  /** Files for `uncommitted`, commits for `unlanded`, entries for `stash`, 0 for `stranded`. */
  count: number
  /** The task this branch belongs to, when the name still parses to one. */
  taskSeq: number | null
  summary: string
}

export const DEFAULT_FINISH_INSTRUCTION =
  'Run /commit and follow every step of it. Do not stop until the work is committed.'

export interface LandingResult {
  strategy: LandingStrategyId
  ok: boolean
  commit?: string
  /**
   * The commit the landed work sits on top of — the other half of a reviewable range.
   *
   * ⛔ Captured *after* the rebase and beside `commit`, because that is the only moment both are
   * known. Without it a landed task's diff is unrecoverable the instant `retireBranch` runs, which
   * it does on every successful merge-local and auto-land. See `Task.landedBaseSha`.
   */
  base?: string
  branch?: string
  prUrl?: string
  /** Why it fell back or refused. Always populated when `ok` is false. */
  reason?: string
  checkOutput?: string
  /**
   * The branch carried no commits the target did not already have, so nothing was landed and nothing
   * needed to be.
   *
   * ⛔ `ok: true` with nothing done, and the distinction is load-bearing: a task that answers a
   * question is a success that touched no trunk, while a task that *meant* to change something and
   * committed nothing is a failure. Only the person who filed it can tell those apart, so the
   * message says plainly that the trunk was not touched rather than claiming a commit landed.
   */
  nothingToLand?: boolean
  /**
   * The id of the task this one had to queue behind, because landing is serialised per project.
   *
   * ⚠️ Set whether or not the wait paid off: with `ok: true` it means *landed, after waiting*, and
   * with `ok: false` it means the wait ran out. Present at all means two tasks finished close enough
   * together to contend, which is the thing worth saying out loud either way.
   */
  contendedWith?: string
  /**
   * The task branch was retired — its every commit is in the landing target, so the ref held a name
   * and nothing else.
   *
   * ⚠️ `false` is not a failure. Another worktree may still hold the branch, in which case it is left
   * alone and the finish is still a success; see `retireBranch`.
   */
  branchDeleted?: boolean
}

/** Where a resolved model or effort came from, so the UI can say rather than just show. */
export type ModelSource = 'task' | 'worker' | 'cli'

export interface ResolvedModelChoice {
  /** `null` means "let the CLI pick", which is a real answer and not a missing one. */
  model: string | null
  modelSource: ModelSource
  effort: string | null
  effortSource: ModelSource
}

/**
 * The share of a five-hour window past which this fleet stops starting new work on an account.
 *
 * ⛔ **One number, three readers, and until 2026-08-31 three copies of it.** The routing gate
 * (`chooseTarget`), the pool balance below, and — since t73 — the compaction reserve all turn on
 * exactly this percentage, and a fleet where the gate that stops dispatching and the gate that
 * saves the context disagree by a point is a fleet that strands a session for a rounding error.
 *
 * ⚠️ Lower than the mid-run preemption water (95%), deliberately: refusing *new* work is cheap and
 * reversible, stopping work already in flight is neither.
 */
export const WINDOW_HIGH_WATER = 92

/**
 * Beyond this, a reading is reported but must not be treated as the current state of the window.
 *
 * ⛔ **Shared, because the renderer has to answer the same question the daemon does.** The daemon
 * stamps `ageMs` and `stale` onto a reading when it *sends* it, and a card that reads those fields
 * off the payload is frozen at the moment it arrived — a reading that was two minutes old when the
 * event fired still says "read 2m ago" an hour later, and a reading that was fresh never goes stale
 * on screen at all. `quotaFreshness` recomputes both against a ticking clock; keeping the threshold
 * here is what stops the two answers drifting apart. `STALE_AFTER_MS` in the daemon is this.
 */
export const QUOTA_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * How old this reading is *now*, and whether anything may still be believed about it.
 *
 * ⚠️ **`stale` can only ever be added to, never cleared.** The flag that arrives on the reading
 * carries more than age: `lastQuotaReading` sets it when the newest attempt *failed* and these are
 * the last numbers that worked, which is a different reason to distrust them and one no clock can
 * rediscover. So this ORs with what came in rather than replacing it.
 */
export function quotaFreshness(
  quota: { sampledAt: number; windows: unknown[]; stale?: boolean } | null,
  now: number
): { ageMs: number; stale: boolean } {
  if (!quota) return { ageMs: 0, stale: true }
  const ageMs = Math.max(0, now - quota.sampledAt)
  return {
    ageMs,
    stale: (quota.stale ?? false) || quota.windows.length === 0 || ageMs > QUOTA_STALE_AFTER_MS
  }
}

/**
 * Does this account have an expired or disabled subscription?
 *
 * ⛔ Distinct from a general re-auth requirement or setup failure: re-authenticating or running
 * first-run setup cannot fix a subscription that has expired.
 */
export function isWorkerSubscriptionExpired(worker: Worker): boolean {
  if (worker.identity?.subscriptionExpired === true) return true
  if (worker.health?.subscriptionExpired === true) return true
  if (worker.identity?.subscriptionType === 'expired') return true
  const reason = (worker.health?.reason ?? '').toLowerCase()
  if (
    reason.includes('disabled claude subscription access') ||
    reason.includes('subscription has expired') ||
    reason.includes('subscription expired') ||
    reason.includes('subscription access for claude code')
  ) {
    return true
  }
  return false
}

/**
 * The five-hour window that governs *this* model pool, on a provider that meters more than one pool.
 *
 * ⛔ **The pessimistic fallback is still the default, and has to be.** With no model in hand — the
 * reset countdown, the reserve's sample query — the only safe reading is the busiest pool, which the
 * Antigravity adapter aliases to the bare id `5h` for exactly that reason.
 */
export function sessionWindowFor(
  windows: QuotaWindow[],
  pool: string | null
): QuotaWindow | undefined {
  const fallback = windows.find((w) => w.id === 'session' || w.id === '5h')
  if (!pool) return fallback

  const mine = windows.find(
    (w) => (w.id.startsWith('5h') || w.id === 'session') && (w.group?.includes(pool) ?? false)
  )
  return mine ?? fallback
}

/**
 * All quota windows that apply to a given pool (e.g. 5h and 7d for 'gemini' or 'claude').
 *
 * For a multi-pool provider (e.g. Antigravity), windows have `group` (e.g. 'gemini', 'claude-and-gpt').
 * For single-pool providers (e.g. Claude Code), windows have no `group` and apply to all pools.
 */
export function windowsForPool(
  windows: QuotaWindow[],
  pool: string | null
): QuotaWindow[] {
  if (!pool) {
    const ungrouped = windows.filter((w) => !w.group)
    return ungrouped.length > 0 ? ungrouped : windows
  }
  const matched = windows.filter((w) => w.group?.includes(pool))
  if (matched.length > 0) return matched
  const ungrouped = windows.filter((w) => !w.group)
  return ungrouped.length > 0 ? ungrouped : windows
}

/**
 * Task, then worker (with budget-aware balance across pools when configured), then whatever the CLI does on its own.
 *
 * ⛔ **Two tiers, not the three that finish policy uses.** A model id belongs to one CLI - `opus`
 * means nothing to Antigravity and `gemini-3.1-pro-high` means nothing to Claude Code - so a default
 * held at the project or the fleet would be invalid for every task that routed to a different
 * adapter, which is most of them on a mixed fleet. The worker is the narrowest tier that always
 * knows which CLI it is, and so the only one where the value is always meaningful.
 *
 * ⚠️ **`null` is an answer.** It means the CLI chooses, which is what every install did before there
 * was a control and what a worker keeps doing until somebody sets one. It is not "unset, fall
 * through" - there is nothing further to fall through to.
 *
 * ⛔ **Effort is dropped whole where the adapter cannot be told one.** Not defaulted, not passed and
 * ignored: `selectableEffort` is false on Antigravity because agy *refuses* the flag for every model
 * this fleet dispatches (measured 2026-08-29), so sending it would fail the dispatch outright rather
 * than being politely ignored.
 *
 * ⚠️ Effort resolves independently of model. A task that pins only the model still inherits the
 * worker's effort, because the two are separate choices the CLI takes as separate flags.
 */
export function resolveModelChoice(
  constraints:
    | (Pick<TaskConstraints, 'model' | 'effort'> & {
        modelsByWorker?: Record<string, string>
        effortsByWorker?: Record<string, string>
      })
    | null
    | undefined,
  // ⚠️ Structural, not `Pick<Worker, …>`: `Worker` is not imported here and TypeScript resolved the
  // name to the DOM's own `Worker` global without complaining, which typechecked into nonsense.
  worker:
    | {
        id?: string
        defaultModel: string | null
        defaultEffort: string | null
        defaultModels?: Record<string, string | null> | null
      }
    | null
    | undefined,
  selectableEffort: boolean,
  quota?: QuotaSnapshot | null
): ResolvedModelChoice {
  const workerSpecificModel =
    worker && 'id' in worker && worker.id && constraints?.modelsByWorker
      ? constraints.modelsByWorker[worker.id]
      : undefined
  const model = workerSpecificModel || constraints?.model || null
  let workerModel: string | null = null

  if (worker?.defaultModels && Object.keys(worker.defaultModels).length > 0) {
    const poolEntries = Object.entries(worker.defaultModels).filter(
      (entry): entry is [string, string] => entry[1] != null && entry[1].trim() !== ''
    )
    if (poolEntries.length === 1) {
      workerModel = poolEntries[0]![1]
    } else if (poolEntries.length > 1) {
      if (quota && quota.windows && quota.windows.length > 0) {
        // Budget-aware pool balance: evaluate windows for each pool.
        // Pools below WINDOW_HIGH_WATER are candidates; choose the one with lowest utilization (most headroom).
        let bestCandidate: { pool: string; model: string; percent: number; blocked: boolean } | null = null
        for (const [pool, m] of poolEntries) {
          const wins = windowsForPool(quota.windows, pool)
          const worstWin = wins.reduce<QuotaWindow | null>((worst, w) => {
            return !worst || w.percent > worst.percent ? w : worst
          }, null)
          const percent = worstWin ? worstWin.percent : 0
          const blocked = percent >= WINDOW_HIGH_WATER
          if (!bestCandidate) {
            bestCandidate = { pool, model: m, percent, blocked }
          } else if (bestCandidate.blocked && !blocked) {
            bestCandidate = { pool, model: m, percent, blocked }
          } else if (bestCandidate.blocked === blocked && percent < bestCandidate.percent) {
            bestCandidate = { pool, model: m, percent, blocked }
          }
        }
        workerModel = bestCandidate?.model ?? poolEntries[0]![1]
      } else {
        // No quota reading available: fallback to worker.defaultModel if set, otherwise first pool default
        workerModel = worker.defaultModel ?? poolEntries[0]![1]
      }
    }
  }

  if (!workerModel) {
    workerModel = worker?.defaultModel ?? null
  }

  const resolvedModel = model ?? workerModel
  const modelSource: ModelSource = model ? 'task' : workerModel ? 'worker' : 'cli'

  if (!selectableEffort) {
    return { model: resolvedModel, modelSource, effort: null, effortSource: 'cli' }
  }

  const workerSpecificEffort =
    worker && 'id' in worker && worker.id && constraints?.effortsByWorker
      ? constraints.effortsByWorker[worker.id]
      : undefined
  const effort = workerSpecificEffort || constraints?.effort || null
  const workerEffort = worker?.defaultEffort ?? null
  return {
    model: resolvedModel,
    modelSource,
    effort: effort ?? workerEffort,
    effortSource: effort ? 'task' : workerEffort ? 'worker' : 'cli'
  }
}

// ---------------------------------------------------------------------------- flow

/**
 * One workspace of a project's pool, with the ticket and the account currently bound to it.
 *
 * ⛔ **The binding is read off the claim, never guessed from a session's `cwd`.** A workspace claim
 * is the only record of *which ticket owns which tree*: it is taken before the run starts, it is
 * passed from the task to its session and back again between runs, and it survives a session that
 * has closed with the operator still deciding. Matching live sessions to worktree paths answers a
 * different and weaker question — *who has a process open there* — which is silent for exactly the
 * cases an operator most needs named: a task holding ws2 between runs, and a landing attempt.
 *
 * ⚠️ Resolved in the daemon because no single renderer input can answer it. The claim's `holder` is
 * a task id, a session id or `reland:<taskId>` — three shapes whose resolution needs the runs table
 * that `task.list` does not ship.
 */
export interface FlowWorkspace {
  /** The worktree path. `ws1`-style short name is `label`. */
  path: string
  label: string
  /**
   * Whether this member is still in the configured pool.
   *
   * ⚠️ False for a claim that outlived a narrowing of `poolSize` — those stay valid until the run
   * ends, so the board keeps drawing them rather than dropping a task that is plainly running.
   */
  inPool: boolean
  /** What is holding the claim, or null when the workspace is free. */
  holding: 'session' | 'task' | 'landing' | null
  taskId: string | null
  taskSeq: number | null
  /** `titleSummary ?? title`, so the board never renders a paragraph. */
  taskTitle: string | null
  taskStatus: TaskStatus | null
  workerId: string | null
  workerLabel: string | null
  /** The adapter behind `workerLabel`, for the brand icon beside it. */
  adapterId: string | null
  sessionId: string | null
  /** What the tree is checked out to, from the live session when one has reported it. */
  branch: string | null
  claimedAt: number | null
}
