/**
 * The task domain.
 *
 * Two objects that look alike in a UI and are nothing alike in the scheduler:
 *
 *  - a **Task** is a thread of work with an assignee. It can be scheduled, reassigned, made to
 *    depend on other work, and it outlives every session that touches it.
 *  - an **Approval** is an interrupt on one live session. It blocks that session right now, only
 *    that session can consume the answer, its answer set is closed, and it dies with the session.
 *
 * Filing the second as the first is wrong on every axis a Task exists for. See the implementation
 * plan §7.3 and §7.4.
 */

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
  permission?: { mode?: string; allow?: string[]; deny?: string[] }
  env?: Record<string, string | number>
  resources?: Array<{ ref: string }>
  mandate?: Partial<Mandate>
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
}

export interface TaskMessage {
  id: number
  taskId: string
  role: 'human' | 'agent' | 'system'
  text: string
  runId: string | null
  /**
   * When this message reached an agent. A note typed into a live session is answered in that
   * session - `0.1·C` - and must not also be replayed into the next prompt, which would charge for
   * it twice and leave the agent unsure what is still outstanding.
   */
  deliveredAt: number | null
  ts: number
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
  title: string
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
   * When the finish instruction was sent to the agent, if it has been.
   *
   * ⛔ The guard against re-asking. The instruction is sent, the agent works, and it calls
   * `task_complete` again — and between those two moments nothing about the task has changed, so the
   * same decision would be reached again. That is the preemption loop of 2026-08-28 in a different
   * costume, and each repeat here is a billed turn spent telling an agent to do what it just did.
   */
  finishAskedAt: number | null
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
  branch: string | null
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
  /** Capabilities the task cannot run without, e.g. `manualCompact`. */
  needs?: string[]
  workspacePolicy?: 'pooled' | 'trunk' | 'direct' | 'any'
}

/** One attempt of a task on one session. Runs are what the estimator learns from. */
export interface Run {
  id: string
  taskId: string
  sessionId: string | null
  workerId: string
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
   * Did this run inherit a conversation, or build one from nothing?
   *
   * ⛔ **`null` is not `false`.** Runs that predate the column recorded nothing, and rendering those
   * as *new* would be an assertion nobody measured. The UI says nothing at all for null.
   */
  startedWarm: boolean | null
}

/** A quota reading kept beside a run, with enough of its basis to be distrusted properly. */
export interface RunQuota {
  windows: Array<{ id: string; label: string; percent: number }>
  sampledAt: number
  /** True when this was the best available reading and was already too old to act on. */
  stale: boolean
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'terminated' | 'preempted'

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

/** What the cache clock decided to do with a session, and why. */
export type CacheMove = 'dispatch' | 'keepalive' | 'compact' | 'let_expire' | 'handoff_close' | 'none'

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
 */
export type ConsultKind = 'decompose' | 'triage' | 'gate' | 'route'

export type ConsultStatus = 'pending' | 'answered' | 'fallback' | 'failed'

export interface Consult {
  id: string
  kind: ConsultKind
  /** The task this is about, where there is one. */
  subjectId: string | null
  status: ConsultStatus
  question: string
  workerId: string | null
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
  ts: number
}

// ---------------------------------------------------------------------------- landing

export type LandingStrategyId = 'auto-land' | 'leave-branch' | 'pull-request'

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
  /** Land it unattended, but only if it is provably safe to. See `safeToLand`. */
  | 'agent-lands'
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
 * ⚠️ The fleet default, and it lives here rather than in `finish.ts` because `settings.ts` needs it
 * and `finish.ts` needs `settings.ts` — a cycle that resolves to `undefined` at import time and
 * would have made the fleet tier silently empty.
 *
 * `agent-lands` is what the project default has always effectively been (`auto-land`). It is not a
 * loosening: `safeToLand` now requires a project to define checks and for them to pass, which the
 * old path did not, so the same value lands strictly less than it used to.
 */
export const DEFAULT_FLEET_FINISH: FinishPolicy = 'agent-lands'

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
  kind: 'uncommitted' | 'unlanded' | 'stash'
  projectId: string
  projectName: string
  workspacePath: string
  branch: string | null
  /** Files for `uncommitted`, commits for `unlanded`, entries for `stash`. */
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
}
