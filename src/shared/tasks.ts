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
  landing?: { strategy?: LandingStrategyId; target?: string }
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
  verification: 'required' | 'not_required' | 'auto'
  preemptible: boolean
  estTokens: number | null
  cancel: CancelRecord | null
  handoffNote: string | null
  branch: string | null
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TaskConstraints {
  workerId?: string
  adapterId?: string
  model?: string
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

export interface LandingResult {
  strategy: LandingStrategyId
  ok: boolean
  commit?: string
  branch?: string
  prUrl?: string
  /** Why it fell back or refused. Always populated when `ok` is false. */
  reason?: string
  checkOutput?: string
}
