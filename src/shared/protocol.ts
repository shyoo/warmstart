import type {
  Approval,
  ApprovalRule,
  CacheMove,
  ChatMessage,
  ClockDecision,
  Consult,
  Objective,
  Project,
  ReserveReport,
  ResourceAvailability,
  RestingState,
  Run,
  Task,
  TaskKind,
  TaskMessage
} from './tasks.js'

/**
 * What the scheduler currently believes about cost, and why.
 *
 * ⛔ Every number here carries its basis. A cost model that cannot say *why* it thinks something is
 * a cost model nobody will override when it is wrong - and it will be wrong.
 */
export interface CostReport {
  generatedAt: number
  objective: Objective
  reserves: ReserveReport[]
  /** What the clock would do right now, without doing it. */
  decisions: ClockDecision[]
  recent: Array<{
    sessionId: string
    move: CacheMove
    reason: string
    contextTokens: number | null
    estimatedCost: number | null
    ts: number
  }>
  /** Measured from real answers, not assumed. Drives the keepalive-versus-compact choice. */
  medianHumanLatencyMs: number
  workers: Array<{
    workerId: string
    label: string
    remainingTokens: number | null
    remainingBasis: string
    windowResetsAt: number | null
    windowResetSource: string | null
    liveRateLimitStatus: string | null
  }>
}

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
  /**
   * May this account be asked for judgment, do work, or both?
   *
   * The controller is a worker in the fleet with its own quota, which is what makes **leadership
   * delegation** free: an account near the top of its window simply stops being chosen for the next
   * judgment call, and at the floor the deterministic fallback answers instead. Plan §11.
   */
  role: WorkerRole
  maxConcurrent: number
  identity: WorkerIdentity | null
  /** What the last run on this account proved about it. `null` means nothing is known against it. */
  health: WorkerHealth | null
  retiredAt: number | null
  createdAt: number
}

/**
 * What dispatching to this worker actually did, last time it was tried.
 *
 * ⛔ Identity answers *who is signed in*; this answers *whether work survives here*, and they are
 * different questions with different evidence. An account can pass `auth status` and still be unable
 * to run anything - an expired subscription is the case that found this - and identity has no way to
 * know, because it never spends a turn. So the evidence is a **run that died without producing a
 * single metered turn**: no assistant output, no tokens, nothing the transcript could meter. That is
 * not a task failing, it is the worker failing, and charging it to the task sends the operator to
 * debug their prompt.
 *
 * ⚠️ `suspect` is a hard dispatch gate, and it is deliberately easy to clear: re-probing the worker
 * clears it, and so does one run that produces a turn. A quarantine that needs a support ticket to
 * lift is worse than the fault it prevents.
 */
export interface WorkerHealth {
  state: 'ok' | 'suspect'
  /** One line, from the CLI's own output where there was any. Never inferred. */
  reason: string
  /** How many consecutive dispatches died without a turn. */
  strikes: number
  since: number
  /** The run that produced this verdict, so the evidence is reachable. */
  runId: string | null
}

export type WorkerRole = 'worker' | 'controller' | 'both'

export interface WorkerIdentity {
  /**
   * Is anybody signed in to this account?
   *
   * ⛔ Three states, and the third is not a formality. `false` means the vendor answered and nobody
   * is signed in. `null` means agentyard **could not tell** — the CLI is absent, the probe errored,
   * or the vendor keeps its credential somewhere agentyard will not look (Antigravity's keyring).
   * Collapsing `null` into `false` would refuse to dispatch to a perfectly good Antigravity worker;
   * collapsing it into `true` would dispatch into a run that cannot authenticate and will hold a
   * worker's only slot until something reaps it.
   *
   * ⚠️ This field exists because it was once reconstructed by string-matching `raw`, which quietly
   * failed the moment a probe failed for any reason other than "not signed in".
   */
  loggedIn?: boolean | null
  account?: string
  organization?: string
  cliVersion?: string
  /**
   * Has a person walked this isolation root through the CLI's first-run screens?
   *
   * ⛔ Signing in is not the same as being set up, and conflating them cost a day. Measured
   * 2026-08-27: `claude auth login` writes `oauthAccount` and `userID` into the isolation root but
   * not `hasCompletedOnboarding`, so an **interactive** session there opens the theme picker and
   * then the login-method chooser — while `-p` skips all of it and runs perfectly. A worker can
   * therefore do scheduled work for days and still be unable to answer `/usage`, which is exactly
   * what happened.
   *
   * `null` means the adapter cannot tell, and is not a problem to report.
   */
  setupComplete?: boolean | null
  /**
   * The plan the vendor says this account is on, verbatim and unparsed.
   *
   * ⚠️ Recorded, not interpreted. `claude auth status --json` has carried a `subscriptionType` since
   * at least 2.1.223 and this app was reading past it. It is shown next to the account so an
   * operator can see *which* subscription a worker is spending - and so an account whose plan has
   * lapsed says so somewhere, rather than only revealing itself as runs that die on contact.
   *
   * ⛔ Nothing gates on this string. What an expired plan reports here has never been measured on
   * this project, and a gate built on a guessed value would refuse healthy accounts. The gate is
   * `health`, which rests on a run that actually failed.
   */
  subscriptionType?: string | null
  /** Whatever the probe could read back, verbatim, for the Doctor panel. */
  raw?: string
  /**
   * When this answer was read, not when the worker was created.
   *
   * ⚠️ Identity is a *cached* belief about the outside world, and until a login session started
   * refreshing it, it was written once at commissioning and never again - so a worker signed in
   * successfully kept the `loggedIn: false` from before the sign-in, permanently. A belief with no
   * timestamp cannot be told apart from a current one, by a person or by a test.
   */
  checkedAt?: number
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
  purpose: SessionPurpose
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

/**
 * What this session is for.
 *
 * ⚠️ Load-bearing, not a label. A `consult` is one short tool-less turn and takes no workspace, so it
 * is exempt from the worker's work-concurrency limit - a fleet that cannot ask for judgment precisely
 * when it is busiest would have the feature only when it is not needed. It is bounded separately: one
 * consult per worker at a time, a fleet-wide hourly cap, and the same quota gates as work.
 *
 * A `probe` is shorter still and spends nothing at all: a TUI opened only so a slash command can be
 * typed into it, read from disk, and closed. ⛔ It gets no tools, is exempt from the work-concurrency
 * limit for the same reason a consult is, and the cache clock ignores it - a session that lives for
 * fifteen seconds has no prefix worth keeping warm.
 */
export type SessionPurpose = 'work' | 'login' | 'consult' | 'chat' | 'probe'

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
  /**
   * Will this CLI accept a session id agentyard chose?
   *
   * ⛔ Load-bearing twice over, and it took M5 to notice. When false, the transcript path cannot be
   * known before the file exists (so it is discovered afterwards), and — the one that matters —
   * **a process cannot be proved to be ours**, because the identity check works by finding our own
   * minted uuid in the process's command line. agentyard therefore will not reap orphans for such an
   * adapter. Leaving an orphan running costs quota; killing the wrong process costs somebody's work.
   */
  mintsSessionId: boolean
  /**
   * Where agentyard gets this adapter's token counts from.
   *
   * ⛔ Three values because M5 measured three answers, and getting this wrong is expensive in the
   * quiet direction — an unmetered run reports as costing *nothing* rather than as *unknown*.
   *
   *  - `transcript` — the CLI writes a line-per-event JSONL file agentyard tails. Exact, and it
   *    includes the compaction sampling iteration a stream would miss (cost-model.md §6). Claude Code.
   *  - `stream` — no readable transcript, but the stream carries usage records. Antigravity writes its
   *    conversations as SQLite, so this is the only route; Codex reports cache reads and writes here
   *    too. ⚠️ Only available while agentyard is attached — a run whose daemon restarted mid-flight
   *    loses the turns it did not see.
   *  - `none` — agentyard cannot tell what it cost. Nothing declares this today, and anything that
   *    did would need to say `unknown` everywhere downstream rather than sum to zero.
   */
  metering: 'transcript' | 'stream' | 'none'
  /**
   * How many accounts of this adapter one machine can hold, or null for no limit.
   *
   * ⚠️ This is a fact about **where the vendor keeps credentials**, not a licence term. A CLI with a
   * config-directory environment variable can be pointed at one isolation root per account, which is
   * the whole basis of a fleet. One that stores credentials in the OS keyring — Antigravity — has
   * exactly one identity per OS user, and no amount of engineering changes that without agentyard
   * touching a credential, which it does not do. Commissioning enforces this rather than discovering
   * it later as two workers quietly sharing one account's quota.
   */
  maxAccounts: number | null
}

/**
 * How the capability block above was established.
 *
 * ⛔ agentyard's own rule is *measure, don't assert*, and an adapter is where that gets tested: a
 * capability table is easy to write from documentation and expensive to be wrong about. So an adapter
 * says which it is, the Doctor says so out loud, and nothing silently presents a documented
 * capability with the same confidence as a measured one.
 *
 *  - `measured`   — exercised against the real CLI on a real machine, with a date.
 *  - `documented` — taken from the vendor's own documentation, unrun. Believed, not verified.
 */
export interface AdapterVerification {
  level: 'measured' | 'documented'
  /** ISO date the claim was last established. */
  asOf: string
  /** Where it came from, and — for `documented` — what has to be run to promote it. */
  note: string
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
  /**
   * The environment variable that points this CLI at one account's credential directory.
   *
   * ⛔ `null` means the vendor offers no such variable, which is not a detail: it is the difference
   * between an adapter that can hold a fleet and one that can hold a single account. See
   * `capabilities.maxAccounts`.
   */
  isolationEnvVar: string | null
  capabilities: AdapterCapabilities
  policy: AdapterPolicy
  verification: AdapterVerification
  login: AdapterLogin
  /** `null` means this CLI offers no free way to refresh its own usage figures. */
  usageRefresh: UsageRefresh | null
  /** `null` means signing in is all this CLI needs before a terminal is usable. */
  firstRun: AdapterFirstRun | null
}

/**
 * How an account is signed in — **declared by the adapter, never inferred from its name.**
 *
 * ⚠️ The renderer used to work this out itself with `id === 'claude-code' ? ['auth','login'] :
 * ['login']`, which is the branch-on-adapter-name this design forbids, and it was wrong the first
 * time somebody used it: `agy` has no `login` subcommand at all, so commissioning an Antigravity
 * account failed with *unexpected argument "login"* (measured on agy 1.1.20, 2026-08-26).
 *
 * ⛔ `external` is a real answer, not a missing one. A vendor whose credential lives in the OS
 * keyring has no CLI login for this app to run, and pretending otherwise produces a terminal pane
 * that can only fail.
 */
export type AdapterLogin =
  | { kind: 'cli'; argv: string[] }
  | { kind: 'external'; reason: string }

/**
 * How to make a CLI refresh its own usage cache, for free.
 *
 * ⭐ Measured 2026-08-27 on claude 2.1.223. `claude -p /usage` spends a real turn — that finding is
 * three months old and correct — but it is a fact about **print mode**, and it got generalised into
 * "there is no free quota probe" for far too long. Typed into an interactive session, `/usage` is a
 * *client-side* command: it costs no tokens and it rewrites `cachedUsageUtilization` on disk. A
 * cache that had been 20 days stale came back seconds old.
 *
 * This is the same trick the design already turns on for compaction: the daemon owns stdin, so a
 * slash command is a function call. ⛔ The alternative — reading `.credentials.json` and calling the
 * vendor's usage API, which is what every community monitor does — is closed to this project, and
 * not on grounds of difficulty. See `docs/cost-model.md` §5.
 */
/**
 * A plain interactive session, for the screens only a person can answer.
 *
 * ⚠️ Not a second login. The account is already signed in by the time this matters; what is missing
 * is the first-run setup a TUI insists on before it will show a prompt. The app cannot answer these
 * for the operator — they are choices, and one of them is a login method.
 */
export interface AdapterFirstRun {
  /** Argv for a bare interactive session. Empty means the command with no arguments. */
  argv: string[]
  /** The key in the CLI's own config that proves the screens were completed. */
  completedKey: string
  reason: string
}

export interface UsageRefresh {
  /** Typed into the session verbatim, followed by a carriage return. */
  command: string
  /** How long the TUI needs before it will accept input at all. */
  readyMs: number
  /** How long to let the answer land and be written to disk before reading it. */
  settleMs: number
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

// ---------------------------------------------------------------------------- controller

/**
 * What the controller has decided, and what each decision cost.
 *
 * ⛔ `fallbacks` is not an error count. A fallback is the design working: the deterministic answer
 * fired because no controller was available, in budget, or coherent. A fleet with every consult
 * falling back still makes progress - it just makes it with less judgment.
 */
export interface ControllerReport {
  generatedAt: number
  /** Which accounts may be asked, and whether each can be right now. */
  controllers: Array<{
    workerId: string
    label: string
    role: WorkerRole
    available: boolean
    reason: string
  }>
  pending: number
  /** Consults started in the last hour, against the fleet-wide cap. */
  usedThisHour: number
  hourlyCap: number
  recent: Consult[]
  spentTokens: number
  fallbacks: number
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
      /**
       * ⛔ Defaults to true, but pass false to commission a worker that is **not yet open for work**.
       * Adopting an already-signed-in credential root makes a worker dispatchable the instant the row
       * exists - and the scheduler ticks every ten seconds - so anything that commissions a worker it
       * does not intend to spend on has to close that window at creation, not just after it.
       */
      enabled?: boolean
    }
    result: Worker
  }
  'worker.update': {
    params: { id: string } & Partial<
      Pick<Worker, 'label' | 'enabled' | 'humanOccupied' | 'maxConcurrent' | 'role'>
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
    result: {
      task: Task
      messages: TaskMessage[]
      runs: Run[]
      /**
       * Every session any run of this task has used.
       *
       * ⛔ Shipped so the detail pane can answer "was the context reused, or rebuilt?" - the single
       * question this whole cost model exists to make answerable, and the one thing the UI could not
       * say. A worker id told you which account paid; it did not tell you whether the run started
       * from a warm prefix at `0.1·C` or a cold one at `2.0·C`.
       */
      sessions: Session[]
      /** The live tail for this task, if anything is running. Same content as `task.activity`. */
      activity: Array<{ text: string; ts: number }>
    } | null
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
  /** Everything the cost model currently believes, and on what basis. */
  'cost.report': { params: void; result: CostReport }
  'scheduler.tick': { params: void; result: { dispatched: number; note: string } }

  // ---- M4: the controller ---------------------------------------------------------------
  /** The ledger: every judgment call, what it decided, what it cost, and when it fell back. */
  'controller.report': { params: { limit?: number } | void; result: ControllerReport }
  /**
   * Drain the consult queue once, now, instead of waiting for the controller loop.
   * ⚠️ This is the one RPC in the daemon that can spend tokens on its own. Nothing in a scheduler
   * tick calls it.
   */
  'controller.drain': { params: void; result: { answered: number; note: string } }
  /** Decompose a coarse goal into draft children. Files a `plan` task, which is the unit of work. */
  'task.plan': { params: { title: string; projectId?: string | null; prompt?: string }; result: Task }
  /** What work like this has cost before, from completed runs. Median, never mean. */
  'task.estimate': {
    params: { id: string }
    result: { tokens: number; confidence: 'none' | 'low' | 'medium' | 'high'; basis: string }
  }

  'chat.history': { params: { threadId?: string } | void; result: ChatMessage[] }
  /** Talk to the controller. Answers arrive as `chat.message` events, not in this result. */
  'chat.send': {
    params: { text: string; threadId?: string }
    result: { ok: boolean; sessionId?: string; reason?: string }
  }
  'chat.reset': { params: { threadId?: string } | void; result: { ok: true } }

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
  kind?: TaskKind
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
  | { type: 'consult.changed'; consult: Consult }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; ts: number }
  /**
   * What the agent working on a task is saying, as it says it.
   *
   * ⛔ Not persisted, and deliberately not a `TaskMessage`. A running agent produces prose
   * continuously; writing each fragment into the task's thread would turn the record of a
   * conversation into a transcript of one, and the thread is the thing a person reads afterwards to
   * find out what was decided. This is the *peephole* - a bounded tail held in memory, gone when the
   * daemon restarts, which is the correct lifetime for "what is happening right now".
   *
   * ⚠️ Agent output, so it is untrusted text. It is rendered as text and never as markup.
   */
  | { type: 'task.activity'; taskId: string; text: string; ts: number }
