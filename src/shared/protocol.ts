import type {
  Approval,
  ApprovalRule,
  Project,
  ResourceAvailability,
  RestingState,
  Run,
  Task,
  TaskMessage
} from './tasks.js'

/**
 * The daemon's wire contract.
 *
 * Shared by all three processes, but note who talks to whom: the **renderer never speaks to
 * orchestratord directly**. It calls the main process over IPC, and main holds the endpoint token.
 * See AGENTS.md - the renderer displays untrusted agent output, so it does not get a credential to
 * a service that can spawn processes.
 */

/** Published by the daemon at `<dataDir>/orchestratord.json`, mode 0600. */
export interface DaemonEndpoint {
  pid: number
  port: number
  token: string
  version: string
  startedAt: number
}

// ---------------------------------------------------------------------------- domain

/** A quota bucket: one account or endpoint. Not a session. See docs/glossary.md. */
export interface Worker {
  id: string
  adapterId: string
  label: string
  /** Where the vendor CLI keeps this account's credentials. agentyard never reads inside it. */
  isolationRoot: string
  enabled: boolean
  /** Quota is tracked but never spent - a person is using this account by hand. */
  humanOccupied: boolean
  maxConcurrent: number
  identity: WorkerIdentity | null
  retiredAt: number | null
  createdAt: number
}

export interface WorkerIdentity {
  account?: string
  organization?: string
  cliVersion?: string
  /** Whatever the probe could read back, verbatim, for the Doctor panel. */
  raw?: string
}

export interface QuotaWindow {
  id: string
  label: string
  percent: number
  resetsAt: number | null
}

export interface QuotaSnapshot {
  workerId: string
  windows: QuotaWindow[]
  sampledAt: number
  source: 'cli' | 'config-cache' | 'unknown'
  /** Set when the probe failed. The scheduler degrades conservatively rather than stalling. */
  error?: string
}

/** One live agent process. Quota lives on the worker; context lives here. */
export interface Session {
  id: string
  workerId: string
  adapterId: string
  transport: SessionTransport
  projectId: string | null
  cwd: string
  model: string | null
  effort: string | null
  state: SessionState
  pid: number | null
  transcriptPath: string | null
  contextTokens: number | null
  /** Cache TTL is measured from the REQUEST start, not the response record. cost-model.md §1. */
  lastRequestStartedAt: number | null
  cacheExpiresAt: number | null
  tokensSinceCompact: number
  startedAt: number
  closedAt: number | null
}

export type SessionTransport = 'pty' | 'stream'
export type SessionState = 'starting' | 'live' | 'idle' | 'closed' | 'failed'

/** One assistant turn's metering, read from the agent's own transcript. */
export interface Turn {
  sessionId: string
  requestId: string | null
  ts: number
  requestStartedAt: number | null
  model: string | null
  effort: string | null
  gitBranch: string | null
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadTokens: number
  cacheWrite1hTokens: number
  cacheWrite5mTokens: number
  contextTokens: number | null
}

// ---------------------------------------------------------------------------- adapters

export interface AdapterCapabilities {
  transports: SessionTransport[]
  permissionModes: string[]
  /** Is there a reviewer that is not the human? Claude yes, Antigravity no. Plan §9.1. */
  classifierBackedAuto: boolean
  approvalChannel: 'permission_prompt_tool' | 'settings_rules' | 'none'
  manualCompact: boolean
  resumeSession: boolean
  forkSession: boolean
  nativeWorktree: boolean
  multimodalInput: boolean
  mcp: boolean
  quotaProbe: 'cli' | 'api' | 'none'
}

export interface AdapterPolicy {
  defaultPermissionMode: string
  /** What "stop what you are doing" is, as bytes. ESC for a TUI; adapters may differ. */
  interruptSequence: string
  costModelId: string
  wrapUpProtocol: 'handoff' | 'compact' | 'none'
  /** Models with no injected token budget must be told their remaining budget explicitly. */
  needsExplicitBudget: boolean
}

export interface AdapterInfo {
  id: string
  label: string
  /** The executable looked for on PATH. */
  command: string
  isolationEnvVar: string | null
  capabilities: AdapterCapabilities
  policy: AdapterPolicy
}

export interface AdapterDetection {
  adapterId: string
  found: boolean
  path: string | null
  version: string | null
  error?: string
}

// ---------------------------------------------------------------------------- cost models

export interface CostModelSummary {
  id: string
  provider: string
  effectiveFrom: string
  source: 'builtin' | 'user' | 'bundled'
  path: string | null
}

// ---------------------------------------------------------------------------- doctor

export interface DoctorReport {
  generatedAt: number
  daemon: { version: string; pid: number; port: number; uptimeMs: number; dbPath: string }
  adapters: AdapterDetection[]
  workers: Array<{
    workerId: string
    label: string
    isolationRootExists: boolean
    loggedIn: boolean | null
    lastQuota: QuotaSnapshot | null
    note?: string
  }>
  costModels: CostModelSummary[]
  warnings: string[]
}

// ---------------------------------------------------------------------------- rpc

export interface RpcMap {
  'health': { params: void; result: { ok: true; version: string; uptimeMs: number } }

  'adapter.list': { params: void; result: AdapterInfo[] }
  'adapter.detect': { params: void; result: AdapterDetection[] }

  'fleet.list': {
    params: void
    result: Array<{ worker: Worker; quota: QuotaSnapshot | null; sessions: Session[] }>
  }
  'worker.create': {
    params: {
      adapterId: string
      label: string
      /** Omit to have the daemon create `<appdata>/workers/<slug>`; pass to adopt an existing root. */
      isolationRoot?: string
      humanOccupied?: boolean
      maxConcurrent?: number
    }
    result: Worker
  }
  'worker.update': {
    params: { id: string } & Partial<
      Pick<Worker, 'label' | 'enabled' | 'humanOccupied' | 'maxConcurrent'>
    >
    result: Worker
  }
  'worker.retire': { params: { id: string }; result: Worker }
  'worker.probe': { params: { id: string }; result: QuotaSnapshot }

  'costmodel.list': { params: void; result: CostModelSummary[] }
  'doctor.run': { params: void; result: DoctorReport }

  'session.list': { params: void; result: Session[] }
  'session.spawn': {
    params: {
      workerId: string
      /** Defaults to the user's home directory - a login flow needs somewhere to run, not a project. */
      cwd?: string
      transport?: SessionTransport
      model?: string
      /** Login and other one-shot flows pass their own argv instead of a prompt. */
      argv?: string[]
      cols?: number
      rows?: number
      purpose?: 'work' | 'login'
    }
    result: Session
  }
  'session.write': { params: { id: string; data: string }; result: { ok: true } }
  'session.resize': { params: { id: string; cols: number; rows: number }; result: { ok: true } }
  'session.close': { params: { id: string }; result: { ok: true } }
  'session.backscroll': { params: { id: string }; result: { data: string } }

  // ---- M2: projects, tasks, approvals, resources ----------------------------------------
  'project.list': { params: void; result: Project[] }
  'project.add': { params: { root: string; name?: string }; result: Project }
  'project.reload': { params: { id: string }; result: Project }
  'project.archive': { params: { id: string }; result: Project }
  'project.writeConfig': { params: { id: string }; result: { path: string } }

  'task.list': { params: { projectId?: string; includeDeleted?: boolean } | void; result: Task[] }
  'task.get': {
    params: { id: string }
    result: { task: Task; messages: TaskMessage[]; runs: Run[] } | null
  }
  'task.create': { params: TaskCreateParams; result: Task }
  'task.update': { params: { id: string } & Record<string, unknown>; result: Task }
  'task.message': { params: { id: string; text: string }; result: { ok: true } }
  'task.cancel': {
    params: { id: string; restingState?: RestingState; reason?: string; hard?: boolean }
    result: Task
  }
  'task.resume': { params: { id: string }; result: Task }
  'task.deleteCheck': { params: { id: string }; result: { ok: boolean; reasons: string[] } }
  'task.delete': { params: { id: string; hard?: boolean; force?: boolean }; result: Task }
  'task.restore': { params: { id: string }; result: Task }
  'task.promote': { params: { id: string }; result: Task }

  'approval.list': { params: void; result: Approval[] }
  /** Called by the MCP server on the agent's behalf. Blocks until policy or a person answers. */
  'approval.request': {
    params: {
      sessionId: string
      origin: 'permission_prompt' | 'tool_gate' | 'resource_gate'
      tool: string
      target: string
      summary: string
      raw?: string
    }
    result: { decision: 'allow' | 'deny'; reason?: string }
  }
  'approval.answer': {
    params: { id: string; decision: 'allow' | 'allow_always' | 'deny' }
    result: Approval
  }
  'approval.rules': { params: { projectId?: string }; result: ApprovalRule[] }
  'approval.addRule': {
    params: { text: string; effect: 'allow' | 'deny'; projectId?: string | null }
    result: ApprovalRule
  }
  'approval.removeRule': { params: { id: string }; result: { ok: true } }

  'resource.list': { params: void; result: ResourceAvailability[] }
  'scheduler.tick': { params: void; result: { dispatched: number; note: string } }

  // ---- worker tier: called by the MCP server on an agent's behalf -----------------------
  /** ⛔ The only signal that a task succeeded. A process exiting says nothing about the work. */
  'agent.complete': { params: { sessionId: string; summary: string }; result: { ok: true } }
  /** Agent-authored work. Bounded by the calling task's inherited mandate and budget. */
  'agent.createTask': {
    params: { sessionId: string; title: string; prompt?: string; assigneeHint?: string }
    result: { ok: boolean; seq?: number; reason?: string }
  }
  'agent.handoff': { params: { sessionId: string; note: string }; result: { ok: true } }
}

export interface TaskCreateParams {
  title: string
  projectId?: string | null
  prompt?: string
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  parentTaskId?: string | null
  dependsOn?: string[]
  notBefore?: number | null
  deadline?: number | null
  assigneeHint?: string | null
  verification?: 'required' | 'not_required' | 'auto'
  status?: 'draft' | 'ready'
  estTokens?: number | null
}

export type RpcMethod = keyof RpcMap
export type RpcParams<M extends RpcMethod> = RpcMap[M]['params']
export type RpcResult<M extends RpcMethod> = RpcMap[M]['result']

export interface RpcRequest {
  id: number
  method: RpcMethod
  params?: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } }

// ---------------------------------------------------------------------------- events

export type DaemonEvent =
  | { type: 'worker.changed'; worker: Worker }
  | { type: 'project.changed'; project: Project }
  | { type: 'resource.changed'; availability: ResourceAvailability }
  | { type: 'task.changed'; task: Task }
  | { type: 'run.changed'; run: Run }
  | { type: 'approval.opened'; approval: Approval }
  | { type: 'approval.answered'; approval: Approval }
  | { type: 'quota.changed'; quota: QuotaSnapshot }
  | { type: 'session.changed'; session: Session }
  | { type: 'session.data'; sessionId: string; data: string }
  | { type: 'session.exit'; sessionId: string; exitCode: number | null }
  | { type: 'turn'; turn: Turn }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; ts: number }
