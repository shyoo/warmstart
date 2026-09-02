import type {
  Approval,
  ApprovalRule,
  Attachment,
  CacheMove,
  ChatMessage,
  ClockDecision,
  Compaction,
  CompletionMode,
  ResolvedCompletionMode,
  CompletionModeChoice,
  Consult,
  Objective,
  ObjectiveChoice,
  Project,
  ProjectPolicyPatch,
  Question,
  QuestionKind,
  QuestionOption,
  QuestionOrigin,
  QuestionResolution,
  ReserveReport,
  ResourceAvailability,
  RestingState,
  RunOutcome,
  Run,
  Task,
  TaskConstraints,
  TaskKind,
  TaskMessage,
  TaskPage,
  TaskSort,
  TaskView,
  FinishPolicy,
  FinishPolicyChoice,
  ResolvedFinishPolicy,
  SessionSharing,
  SessionSharingChoice,
  ResolvedSessionSharing,
  LooseEnd
} from './tasks.js'

/**
 * What the scheduler currently believes about cost, and why.
 *
 * ⛔ Every number here carries its basis. A cost model that cannot say *why* it thinks something is
 * a cost model nobody will override when it is wrong - and it will be wrong.
 */
/**
 * Fleet-wide switches the operator owns.
 *
 * ⛔ Global, every one of them. Per-worker or per-project toggles would be four places to look when a
 * session is not compacting or a run was not stopped, and this exists precisely so that "why did it
 * do that?" has a short answer.
 *
 * ⚠️ Each switch gates something that *acts on a live session without being asked* — compaction,
 * preemption, a runaway stop. That is the whole membership rule: a preference the scheduler cannot
 * infer, about an intervention the operator would want to be able to stop.
 */
export interface Settings {
  /** May the cache clock compact a session on its own? Default true. */
  autoCompact: boolean
  /**
   * May the scheduler wrap a run up before its quota window closes? Default true.
   *
   * ⛔ Gates the *window boundary* trigger only. A runaway stop is `autoRunawayStop`, because the two
   * rest on completely different evidence and are trustworthy to completely different degrees.
   */
  autoPreempt: boolean
  /**
   * May the scheduler wrap up a run when 5-hour quota is near exhaustion (>=95%) or an in-stream
   * rate-limit warning arrives? Default **true**.
   */
  autoOverrunPreempt: boolean
  /**
   * May the scheduler stop a run for going far past its token estimate? Default **false**.
   *
   * ⚠️ Off by design, not by oversight — though for a smaller reason since 2026-08-30. The factor is
   * now priced rather than counted, and taken against an estimate for the run's *own* agent and
   * model, which is what stopped every Antigravity run reading as a runaway at 4x before it had done
   * anything unusual. What is still true: the estimate learns only from runs that *completed*, so
   * stopping long runs makes its picture of work like this shorter rather than truer. The operator
   * opts in. cost-model.md §10.
   */
  autoRunawayStop: boolean
  /**
   * May the controller be asked to write a one-line label for a task whose prompt is a paragraph?
   * Default **false**.
   *
   * ⛔ Off because this is the only judgment call that spends a turn without changing what runs — it
   * writes `titleSummary`, which nothing but the UI reads. The four questions the scheduler asks
   * anyway (decompose, triage, gate, route) carry the label for free and are unaffected by this
   * switch; it gates only the dedicated question, asked at most once per long task. An operator who
   * wants a readable board more than they want the turns says so here.
   */
  summariseTitles: boolean
  /**
   * What finishing a task means, fleet-wide, for every project that has not said otherwise.
   *
   * ⚠️ The odd one out in this interface, and deliberately so. The three switches above gate an
   * *intervention on a live session*; this is the bottom tier of a three-tier preference (fleet →
   * project → task). It lives here because a fleet-wide default has to live somewhere an operator
   * can find it, and this is where the operator already looks for fleet-wide anything.
   */
  finishPolicy: FinishPolicy
  /**
   * May a task be given a conversation another task has already been having? The bottom tier of the
   * same three (fleet → project → task), and ⛔ **off** unless somebody turns it on.
   */
  sessionSharing: SessionSharing
  /**
   * How far a dispatched agent is expected to get before it stops. The bottom tier of the same three
   * (fleet -> project -> task), and ⛔ **autonomous** unless somebody chooses otherwise.
   */
  completionMode: CompletionMode
  /**
   * What the scheduler optimises for, fleet-wide, when a project or task has not specified otherwise.
   * Default balanced (34% cost, 33% velocity, 33% quality).
   */
  objective: Objective
  /**
   * How often (in minutes) orchestratord sweeps workers for quota **while a run is in flight**.
   * Default 5 minutes.
   *
   * ⚠️ This is the *active* cadence, and since 2026-08-31 it means what it says: on a worker with a
   * run in flight the sweep now **refreshes** the vendor's cache on this interval rather than only
   * re-reading a file the vendor may not have written for hours. The old behaviour is why a fleet
   * card could read 63% while the run beside it was being preempted at 93%.
   */
  probeIntervalMinutes: number
  /**
   * How often (in minutes) orchestratord sweeps workers when **nothing is running**. Default 20.
   *
   * ⛔ A separate control on purpose. An idle account's window is, by construction, not moving, so
   * the frequent cadence buys nothing there and costs a background process per sweep. The two
   * questions — *how closely do we watch work in flight* and *how often do we look at a quiet fleet*
   * — have different answers and used to share one number.
   */
  idleProbeIntervalMinutes: number
}

/** The per-agent cost scale, as the Cost screen shows it. Mirrors `estimator.ts`'s own types. */
export interface CostFactorReport {
  keys: Array<{
    adapterId: string
    /** Null is the adapter-wide rung: that agent's runs whose model was never recorded. */
    model: string | null
    samples: number
    medianPriced: number
    /** What the data says before shrinkage. Published so the shrinkage is visible, not implied. */
    ratio: number
    /** What is actually applied. */
    factor: number
    assumed: boolean
  }>
  warmFactor: number
  coldFactor: number
  warmSamples: number
  coldSamples: number
  /** The fleet's median run with every factor divided out — the unit `factor` multiplies. */
  neutralPriced: number
  neutralRaw: number
  samples: number
  assumed: boolean
}

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
  /**
   * ⚠️ Shipped with the decisions rather than fetched separately, so the switch and the behaviour it
   * governs can never be a frame out of step on screen - a toggle that reads "on" beside a table of
   * declined compactions is the kind of disagreement nobody trusts afterwards.
   */
  settings: Settings
  /**
   * What each agent and model costs relative to the fleet, learned from completed runs.
   *
   * ⛔ Shown with its sample count and its unshrunk ratio, never as a bare multiplier. A 12x from 35
   * runs and a 12x from one are different claims, and the second is mostly the prior.
   */
  costFactors: CostFactorReport
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
  /**
   * What this account reaches for when the task does not say.
   *
   * ⛔ Resolved **task → worker → the CLI's own default**, and no tier between. A model id belongs to
   * one CLI, so a default held anywhere that can route to several adapters is invalid most of the
   * time.
   *
   * ⚠️ `null` is not a missing setting — it is "whatever the CLI picks", which is what every install
   * did before this field existed and what a worker keeps doing until somebody sets one.
   */
  defaultModel: string | null
  /** ⚠️ Only ever sent where the adapter declares `selectableEffort`; dropped otherwise. */
  defaultEffort: string | null
  /**
   * Default models per quota pool (e.g. { gemini: 'gemini-3.7-flash-high', claude: 'claude-sonnet-4-6' }).
   * When set on a multi-pool worker, the scheduler automatically balances across pools based on available budget.
   */
  defaultModels?: Record<string, string | null> | null
  identity: WorkerIdentity | null
  /** What the last run on this account proved about it. `null` means nothing is known against it. */
  health: WorkerHealth | null
  /**
   * Where this worker sits in the fleet strip, lowest first.
   *
   * ⛔ A position somebody chose, never a ranking. Nothing scores, gates or routes on it — the
   * scheduler's order is its scoring, and a worker being first here says nothing about being picked
   * first. It exists because the strip is a row of cards people learn the shape of, and any order
   * derived from live state rearranges itself under the reader.
   */
  sortOrder: number
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
  /**
   * Is the fix *sign in again*, rather than *go and read what happened*?
   *
   * ⛔ Presentation, never a gate. A suspect worker is held out of dispatch either way; this only
   * decides whether the UI offers the one button that can help. The adapter classifies its own
   * CLI's words — see `needsReauth` in adapters/types.ts.
   */
  needsReauth?: boolean
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
  /**
   * Which **separately metered pool** this window belongs to, where the vendor has more than one.
   *
   * ⭐ Antigravity meters Gemini apart from Claude/GPT — two five-hour windows and two weeklies on
   * one account, measured 2026-08-27 — so "how full is this account?" has two answers and the right
   * one depends on which model the next run uses.
   *
   * ⚠️ `undefined` on a provider with a single pool, which is every other one here. Undefined means
   * "this window covers everything", not "unknown".
   *
   * ⛔ Carried **beside** the id rather than encoded in it. The busiest five-hour window is also
   * aliased to the bare id `5h` for the consumers that cannot know a model — the reset countdown and
   * the reserve's sample query — and that aliasing overwrites the id. The group has to survive it.
   */
  group?: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One line of the daemon's log, as the log panel and the tail RPC both carry it. */
export interface LogEntry {
  ts: number
  level: LogLevel
  message: string
}

/** A log file on disk. ⚠️ Reported, never streamed — the ring buffer covers the live case. */
export interface LogFile {
  name: string
  path: string
  bytes: number
  modifiedAt: number
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
  /**
   * The vendor's own name for this conversation, if it has told us one.
   *
   * ⛔ Not `id`. Where the CLI mints its own conversation ids - Antigravity does - this is the only
   * handle that CLI would recognise, and `id` is agentyard's private label. Where the CLI takes an
   * id we chose, the two are the same string.
   *
   * Null until the session's first record arrives, and permanently null for adapters that say
   * nothing about it.
   */
  vendorSessionId: string | null
  /**
   * The branch the workspace this conversation lives in is checked out to.
   *
   * ⚠️ What the *conversation* is on, which is not the same question as what git reports. A task
   * borrowing this session moves the tree and this moves with it; the agent's own memory of the files
   * does not, which is why a switch is announced rather than performed quietly.
   */
  currentBranch: string | null
  contextTokens: number | null
  /**
   * How big this session's context window is, from the cost model that prices its model.
   *
   * ⛔ Sent with the session rather than looked up in the renderer, which has no cost models and
   * must not grow a second table of model facts to keep in step with the first.
   *
   * `null` means the model is unknown or unpriced — draw the level without a denominator rather
   * than inventing one. A bar against a guessed window is a bar that lies quietly.
   */
  contextWindow: number | null
  /** Cache TTL is measured from the REQUEST start, not the response record. cost-model.md §1. */
  lastRequestStartedAt: number | null
  cacheExpiresAt: number | null
  tokensSinceCompact: number
  /**
   * The last cache-clock move *asked for* on this session, and when.
   *
   * ⛔ A move is a request, not an outcome. Compaction takes ~2 minutes; the clock ticks every 10
   * seconds and `decide()` is a pure function of this row - so without this the same move is
   * re-issued twelve more times before the first can land, each one a billable user message. That
   * happened: thirteen `/compact` sends to one session in two minutes, 2026-08-26.
   *
   * `clockMoveContext` is `tokensSinceCompact` at the moment of the ask, which is what makes
   * "did it land?" answerable - compaction resets that to zero.
   */
  clockMove: CacheMove | null
  clockMoveAt: number | null
  clockMoveAttempts: number
  clockMoveContext: number | null
  startedAt: number
  closedAt: number | null
}

export type SessionTransport = 'pty' | 'stream'
/**
 * What became of the session's *process*.
 *
 * ⛔ Not a verdict on the work. A session that did its job and was then killed to free its worktree
 * exits non-zero, and for a long time that was recorded as `failed` — 81 runs with
 * `outcome: 'completed'` sat inside sessions the UI drew in red. `closed` now means *we asked it to
 * stop*, whatever exit code the kill produced; `abandoned` means the daemon went away and found the
 * row still open when it came back, which is a statement about the daemon and not about the agent;
 * and `failed` is reserved for a process that died on its own without being asked. Migration 27
 * repaired the rows written under the old rule.
 */
export type SessionState = 'starting' | 'live' | 'idle' | 'closed' | 'abandoned' | 'failed'

/**
 * The states that mean *this session is over*, in one list.
 *
 * ⛔ A dozen places asked `state !== 'closed' && state !== 'failed'` by hand, so adding `abandoned`
 * would otherwise have made every one of them quietly count a dead session as live — and the
 * scheduler would have routed work into a process that is not there. This is the same argument
 * `eligibility.ts` settled for the account gates: a membership test copied into a dozen call sites
 * is a set of copies that will drift, not a test.
 */
export const SESSION_ENDED: readonly SessionState[] = ['closed', 'abandoned', 'failed']

export function sessionEnded(state: SessionState): boolean {
  return SESSION_ENDED.includes(state)
}

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

/**
 * One turn of a conversation, as it happened.
 *
 * ⛔ **The run, not the task.** Collapsing runs into their task hid the thing this page is for:
 * measured 2026-08-31, no conversation on this install has ever served two *tasks* — sharing is off
 * at every tier — but one served **nine runs**, and t56 spanned four conversations. So a row reading
 * `1 task` was true and useless, and the history worth reviewing is this sequence.
 */
export interface ConversationRun {
  runId: string
  taskId: string
  /** The task's number, so a run can be named `t56` the way every other screen names it. */
  seq: number
  title: string
  startedAt: number
  /** ⚠️ Null while the run is still going. Renders as a clock, never as a dash. */
  endedAt: number | null
  outcome: RunOutcome | null
  /** ⚠️ Null for runs recorded before this was tracked. Renders as nothing, never as `new`. */
  startedWarm: boolean | null
  tokens: number
  model: string | null
}

/** One task's use of a conversation, with the runs it took underneath it in the order they ran. */
export interface ConversationTask {
  taskId: string
  seq: number
  title: string
  runs: number
  firstAt: number
  lastAt: number
  /** ⚠️ Null for runs recorded before this was tracked. Renders as nothing, never as `new`. */
  startedWarm: boolean | null
  tokens: number
  /** ⭐ Chronological. This is the timeline the expanded row draws. */
  timeline: ConversationRun[]
}

/**
 * A conversation and what it has been used for.
 *
 * ⛔ Derived from `runs` on demand, never stored. Which tasks a conversation served is a fact about
 * that table, and a cached copy would be one more thing to keep in step with it.
 */
export interface Conversation {
  /** agentyard's handle. */
  sessionId: string
  /** ⚠️ What the **CLI** calls it — the string to type after `--resume` or `--conversation`. */
  conversationId: string
  adapterId: string
  workerId: string
  workerLabel: string
  projectId: string | null
  projectName: string | null
  cwd: string
  /** ⚠️ What became of the *process*. `outcome` below is what became of the work. */
  state: SessionState
  currentBranch: string | null
  contextTokens: number | null
  startedAt: number
  closedAt: number | null
  tasks: ConversationTask[]
  /** ⭐ More than one means this conversation was shared. Invisible from every other screen. */
  taskCount: number
  /**
   * ⭐ How many turns were taken in here. The number that actually varies: `taskCount` has been 1
   * for every conversation this fleet has ever opened, and `runCount` has been as high as nine.
   */
  runCount: number
  /**
   * What became of the work, as opposed to what became of the process.
   *
   * ⛔ `state` answers "is this conversation still open?" and nothing more — it is a process fact,
   * and for most of this app's life it was a wrong one (see migration 27). This answers "did the
   * work in here succeed?", from the outcomes of the runs it served: `failed` if any run failed,
   * else `mixed` if they disagree, else whatever they all were. ⚠️ `null` when it served no run,
   * which is a real state — a conversation opened and never used.
   */
  outcome: RunOutcome | 'mixed' | null
  /** Total tokens across every run this conversation served. */
  tokens: number
}

export interface AdapterCapabilities {
  transports: SessionTransport[]
  permissionModes: string[]
  /** Is there a reviewer that is not the human? Claude yes, Antigravity no. Plan §9.1. */
  classifierBackedAuto: boolean
  approvalChannel: 'permission_prompt_tool' | 'settings_rules' | 'none'
  manualCompact: boolean
  /**
   * This adapter's `plan` honours `SpawnRequest.resumeFrom`, so a session that has exited can be
   * started again holding the conversation it already had.
   *
   * ⛔ A claim about **this adapter**, not about the CLI. A vendor flag nobody has wired up here
   * reads as `false`: the scheduler acts on this by dropping a cold start it would otherwise pay
   * for, and a capability that lies in that direction silently loses somebody's context.
   */
  resumeSession: boolean
  forkSession: boolean
  nativeWorktree: boolean
  /**
   * How this CLI can be handed an image, if at all.
   *
   *  - `inline`     — a content block in the stream envelope. Claude Code, measured 2026-08-31: a
   *                   64×64 four-quadrant PNG sent as a base64 `image` block inside the
   *                   `{"type":"user",…}` envelope sessions.ts already sends came back named
   *                   correctly and in order.
   *  - `spawn-flag` — an argv flag on the process that runs the turn, so **initial prompt only**.
   *                   Codex's `-i/--image`; it has no stdin channel to send a second one down.
   *  - `none`       — no channel at all.
   *
   * ⛔ `none` is a hard gate, not a tidiness. Antigravity does not ignore an image block, it
   * **fails the whole turn on one** — measured 2026-08-31: `num_turns: 0`, `status: ERROR`,
   * `stream input content block type "image" is not supported`. A run that died that way would
   * read as the agent having failed the task.
   *
   * ⚠️ The absolute path is written into the prompt text regardless of this value. It costs ~20
   * tokens, all three CLIs read a PNG off disk with their own view tool (agy included, measured),
   * and it is what rescues a run whose inline block a CLI update quietly stopped accepting.
   *
   * ⛔ Replaced `multimodalInput: boolean`, which was `true` on all three built-ins, read by
   * nothing, and — on antigravity — measurably wrong. This says how the bytes are *delivered*,
   * which is the question the code actually has.
   */
  imageInput: 'inline' | 'spawn-flag' | 'none'
  mcp: boolean
  /**
   * Can this CLI be told an effort level when the process starts?
   *
   * ⛔ False on all three built-ins as of 2026-08-27, and that is a measurement rather than an
   * oversight. Effort appears throughout agentyard as something *read back* from a transcript - the
   * glossary calls it a property a session has, `transcript.ts` records it per turn - and no built-in
   * CLI has a start-up flag for it that anybody here has run. Claude Code sets it inside the session;
   * Antigravity encodes it in the model id (`gemini-3.1-pro-high` is a different model from
   * `gemini-3.1-pro-low`, which is why its effort levels come one to a model).
   *
   * ⚠️ The New Task form reads this and renders no effort control where it is false, rather than a
   * disabled one. A control that cannot be used is still a control, and it would sit there implying
   * the choice was being made. The moment an adapter can honestly take a level, the control appears.
   */
  selectableEffort: boolean
  quotaProbe: 'cli' | 'api' | 'none'
  /**
   * Does this CLI's `stream` transport hold a conversation on stdin, or read one prompt and stop?
   *
   * ⛔ Added 2026-08-29 because the answer was assumed and the assumption cost a worker. `codex exec`
   * takes its prompt from **stdin read to EOF** — it prints `Reading prompt from stdin...` and then
   * blocks until the pipe closes. agentyard writes the prompt and keeps the pipe open, the way Claude
   * Code and Antigravity both need, so every codex dispatch sat at 0% CPU forever: no output, no
   * rollout file, nothing to meter, and a task that looked assigned and was simply never asked.
   *
   *  - `conversation` — stdin stays open and takes prompt after prompt. Claude Code, Antigravity.
   *  - `once`         — one prompt, then EOF, then the process runs that turn and exits. Codex.
   *
   * ⚠️ `once` is a real limit on the scheduler, not a detail of encoding: a wrap-up nudge, a finish
   * instruction and a conflict-resolution prompt all arrive *after* the first prompt, and on a `once`
   * adapter there is no stdin left to put them on. `sendPrompt` refuses them loudly rather than
   * writing into a closed pipe, which is how that becomes a reported gap instead of a second silence.
   */
  streamPrompts: 'conversation' | 'once'
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
  defaultModel?: string | null
  defaultModels?: Record<string, string | null> | null
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
  /** How long to let the answer land before reading it. */
  settleMs: number
  /**
   * Where the answer turns up.
   *
   * `file` (the default) is the Claude Code shape: the slash command rewrites a cache on disk and
   * `probeQuota()` reads it. The screen is never consulted.
   *
   * ⛔ `screen` means the number exists **only** as rendered text, and the adapter's `parseUsage`
   * reads it out of the session's backscroll. It is a deliberate, narrow exception to *the TUI is
   * for humans* — see that invariant in AGENTS.md — and it is permitted for **quota readings and
   * nothing else**. Antigravity keeps its quota in `quota_manager.go` in memory and writes it
   * nowhere: measured 2026-08-27 by driving `/usage` in a PTY and diffing every file under
   * `~/.gemini`, where only `cli.log` and `history.jsonl` moved and neither carries a number. The
   * choice on that provider is not screen-versus-file, it is screen-versus-nothing.
   */
  answer?: 'file' | 'screen'
  /**
   * Terminal geometry the probe session needs.
   *
   * ⛔ Only meaningful for `answer: 'screen'`, and not cosmetic there. Measured 2026-08-27 against
   * the live account: at the default 30 rows Antigravity's `/usage` panel scrolled and the last
   * group's five-hour window fell below the fold, so the parser saw three windows where there were
   * four. Width matters too — the panel draws a progress bar and puts the figure after it, so a
   * narrow terminal wraps the number onto its own line and it stops being found.
   */
  cols?: number
  rows?: number
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

export interface ModelPoolInfo {
  id: string
  label: string
  models: string[]
}

/** The choices one adapter can offer, read from the cost model file its policy names. */
export interface ModelOptions {
  adapterId: string
  costModelId: string
  /** ⚠️ False means this adapter takes no effort flag; the form offers no effort control for it. */
  selectableEffort: boolean
  /** ⚠️ `contextWindow` is null where nobody has read the figure — unknown, never 0. */
  models: Array<{ id: string; contextWindow: number | null; effortLevels: string[]; pool?: string }>
  /** Multi-pool definitions if this cost model partitions models into separately metered pools. */
  pools?: ModelPoolInfo[]
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
    result: Array<{
      worker: Worker
      quota: QuotaSnapshot | null
      sessions: Session[]
      /**
       * Why this account could not be handed a turn right now, or `null` if it could.
       *
       * ⛔ Served, not re-derived. This is `accountUnavailability()` — the one list every gate reads
       * — and the renderer cannot run it: half of it is a filesystem question (is the CLI even
       * installed) that no browser context can answer. A UI that counted *ready* workers for itself
       * would be the third copy of a list that has already drifted once, and it would drift in the
       * direction of telling an operator a worker is ready while the scheduler refuses it.
       */
      unavailable: string | null
      /**
       * Is every slot `maxConcurrent` allows already running work?
       *
       * ⛔ `atCapacity()` from the scheduler, called — the same function the dispatch gate uses, so
       * *ready* on a screen and *ready* at dispatch cannot come apart. ⚠️ Passed no reuse session,
       * because there is no task here to reuse one *for*: this answers "could this account start
       * something new", which is strictly the more pessimistic of the two questions the gate asks.
       */
      atCapacity: boolean
    }>
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
      Pick<
        Worker,
        | 'label'
        | 'enabled'
        | 'humanOccupied'
        | 'maxConcurrent'
        | 'role'
        | 'defaultModel'
        | 'defaultEffort'
        | 'defaultModels'
      >
    >
    result: Worker
  }
  /**
   * Put the fleet in this order, top to bottom.
   *
   * ⛔ The whole ordering, never a move — see `reorderWorkers`. The result is the fleet as it now
   * stands, so a caller never has to guess whether its own list won.
   */
  'worker.reorder': { params: { ids: string[] }; result: Worker[] }
  'worker.retire': { params: { id: string }; result: Worker }
  'worker.probe': { params: { id: string }; result: QuotaSnapshot }

  'costmodel.list': { params: void; result: CostModelSummary[] }
  /**
   * What a person filing a task may choose from, per adapter.
   *
   * ⛔ Served rather than compiled into the renderer, for the same reason a session carries its own
   * context window: the renderer has no cost models and must not grow a second table of model facts
   * to keep in step with the first. Every id here came out of the cost model file that will also
   * price it, so a model that can be chosen is a model that can be gated, estimated for and reasoned
   * about - and one that cannot be priced is never offered.
   */
  'model.options': { params: void; result: ModelOptions[] }
  /**
   * Ask orchestratord to wind down and exit.
   *
   * ⛔ **This ends every live session**, which means every running agent. The daemon exists so
   * that closing a window stops nothing; asking it to stop is therefore an explicit act with a
   * cost, and the caller is the one that has to be sure - see the app's quit path, which asks a
   * person first whenever any work is in flight.
   *
   * ⚠️ `liveSessions` is counted **before** anything is stopped, so a caller that wants to say
   * what it ended can. `stopping: false` means something was already winding it down.
   */
  'daemon.shutdown': { params: void; result: { stopping: boolean; liveSessions: number } }
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
  /**
   * One page of the task table, filtered by bucket.
   *
   * ⛔ A second method rather than a new shape for `task.list`. `task.list` has fourteen callers and
   * one of them is the MCP tool an *agent* calls — changing an external contract to add a filter to
   * a table would be the tail wagging the dog. Nothing that reads the whole list has to care that
   * this exists.
   */
  'task.page': {
    params: {
      projectId?: string
      includeDeleted?: boolean
      /** Buckets to show. ⚠️ Empty means everything; All is the empty selection, not a sixth view. */
      views?: TaskView[]
      sort?: TaskSort
      asc?: boolean
      limit?: number
      offset?: number
    } | void
    result: TaskPage
  }
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
      /**
       * Every compaction on this task, whether this fleet bought it or merely watched it happen.
       *
       * ⛔ Beside `runs` because it belongs to the same question - what did this task cost, and
       * why - and because a compaction is the one event that makes every turn after it cheaper.
       * A pane that showed runs and hid compactions was showing the spending and not the saving.
       */
      compactions: Compaction[]
      /** The live tail for this task, if anything is running. Same content as `task.activity`. */
      activity: Array<{ text: string; ts: number }>
      /**
       * How many tasks are held at `blocked` waiting on this one.
       *
       * ⛔ The concrete consequence of Mark done versus Stop here, and it has to be a number rather
       * than a sentence: `admit()` releases a dependent only when its dependency reaches
       * `completed`, so those two buttons are the difference between the rest of a plan running and
       * not — and with nothing on screen saying so the choice looks like a matter of taste.
       *
       * ⚠️ Computed here because the thread is its own route now. It used to be counted in the
       * renderer by filtering the task list the pane was rendered inside; a pane opened directly
       * has no such list, and fetching every task in the fleet to count two of them would be a
       * worse answer than a `count(*)`.
       */
      blocking: number
      /** Tasks this task depends on (prerequisites). */
      dependencies?: Task[]
      /** Tasks that depend on this task (downstream dependents). */
      dependents?: Task[]
      resolvedFinish?: ResolvedFinishPolicy
      resolvedSharing?: ResolvedSessionSharing
      inheritedFinish?: ResolvedFinishPolicy
      inheritedSharing?: ResolvedSessionSharing
      inheritedCompletion?: ResolvedCompletionMode
      inheritedObjective?: Objective
      resolvedObjective?: Objective
      previewPrompt?: string
    } | null
  }
  'task.create': { params: TaskCreateParams; result: Task }
  /**
   * Take one image off the operator's clipboard and put it on disk.
   *
   * ⛔ **One image per call, and `MAX_BODY_BYTES` stays 4 MB.** Eight pasted screenshots are eight
   * requests of ~2 MB rather than one of 16 MB. Raising a limit to fit a payload that can be split
   * is how a limit stops meaning anything.
   *
   * ⛔ `mediaType` is checked against the file's own magic number, never trusted. The renderer's
   * `File.type` comes from the clipboard and is whatever the source said it was.
   *
   * The row comes back unbound; it becomes part of the thread when the message carrying its id is
   * filed. One never filed is deleted by `prunePending`.
   */
  'attachment.create': {
    params: { dataBase64: string; mediaType: string; width?: number; height?: number }
    result: Attachment
  }
  /** The bytes back, for the renderer's own thumbnails. */
  'attachment.read': { params: { id: string }; result: { attachment: Attachment; dataBase64: string } }
  'task.update': { params: TaskUpdateParams; result: Task }
  'task.message': {
    params: { id: string; text: string; attachmentIds?: string[] }
    /**
     * `outcome` says what the message *did*, so the UI can stop guessing.
     *
     * `delivered` — a run was already open and the note went into it. `requeued` — the task had
     * stopped and this restarted it as a new run on the same thread. `queued` — it is already
     * waiting to be dispatched and the note will go with it. `ignored` — no such task.
     */
    result: { ok: true; outcome: 'delivered' | 'requeued' | 'queued' | 'ignored' }
  }
  'task.cancel': {
    params: { id: string; restingState?: RestingState; reason?: string; hard?: boolean }
    result: Task
  }
  'task.resume': { params: { id: string }; result: Task }
  /**
   * Dispatch this task now even though the account it needs is at or past the 92% water mark.
   *
   * ⛔ **An override of one number, granted by a person, expiring with the window it overrules.**
   * The water mark is this fleet's own caution — the vendor served every turn up to it — and on a
   * task pinned to a single account there was no way to say *"the remaining 8% is more than this
   * needs"*. It lifts the dispatch gate and the matching mid-run percentage preempt, and it lifts
   * nothing else: a disabled or signed-out account, a worker at capacity, the window boundary
   * itself, and a turn the vendor **refused** are all untouched.
   *
   * ⚠️ `until` defaults to the reset of the window being overruled, so the permission dies with its
   * own reason. Pass `until: null` to withdraw one. `applies` is false when the task is not
   * currently held by quota at all — the grant is still recorded, and saying so stops the button
   * reading as though it had unstuck something.
   */
  'task.overrideQuota': {
    params: { id: string; until?: number | null }
    result: { task: Task; until: number | null; applies: boolean; reason: string }
  }
  /**
   * A person judging a task finished — the answer `awaiting_human` was asking for and had no way to
   * take. ⚠️ Records a judgement, not a verification: `task_complete` remains the only signal that an
   * *agent* finished.
   */
  'task.resolve': { params: { id: string; note?: string }; result: Task }
  'task.deleteCheck': { params: { id: string }; result: { ok: boolean; reasons: string[] } }
  'task.delete': { params: { id: string; hard?: boolean; force?: boolean }; result: Task }
  'task.restore': { params: { id: string }; result: Task }
  'task.promote': { params: { id: string }; result: Task }

  /**
   * Say by hand that this task waits on another one - and unsay it.
   *
   * ⛔ Two methods rather than a `dependsOn` field on `task.update`. An edge is rejected for reasons
   * a whole-array write cannot report usefully (a cycle, a task that does not exist, itself), and a
   * patch that replaced the set would silently drop an edge the controller had added between the
   * pane loading and the person clicking.
   *
   * ⚠️ Adding one re-runs admission at once, so a `ready` task becomes `blocked`; a task already
   * running is **not** clawed back - the prerequisite applies to its next dispatch, and the thread
   * gets a system message saying which of the two happened. `dependencies` comes back with the task
   * so the pane that asked does not need a second round trip to redraw the list it just changed.
   */
  'task.addDependency': {
    params: { id: string; dependsOn: string }
    result: { task: Task; dependencies: Task[] }
  }
  'task.removeDependency': {
    params: { id: string; dependsOn: string }
    result: { task: Task; dependencies: Task[] }
  }

  // ---- project checks -------------------------------------------------------------------
  //
  // ⛔ The check list is what the verifying finish policies trust when they say work is
  // verified, so it is proposed and edited, never inferred silently. See daemon/projects.ts.
  /** What this project's `package.json` suggests. A proposal for a person, not a change. */
  'project.proposeChecks': { params: { id: string }; result: { checks: string[] } }
  /** Write the check list into the project's committed `project.json`. */
  'project.setChecks': { params: { id: string; checks: string[] }; result: Project }
  /**
   * Set per-project policy — the tier between the fleet default and the task.
   *
   * ⛔ A patch, not a whole config: an absent field is *left alone*, and `inherit` is a real value
   * meaning "follow the fleet". Every key it writes is one `project.json` already supported.
   */
  'project.setPolicy': { params: { id: string } & ProjectPolicyPatch; result: Project }

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

  // ---- questions -----------------------------------------------------------------------
  //
  // ⛔ Separate from `approval.*` because the two answer different shapes of thing. An approval is
  // answered with a verdict from a closed set; a question is answered with content the asker defined
  // the shape of. See daemon/questions.ts.
  /**
   * Called by the MCP server on the agent's behalf. **Blocks until a person answers or it parks.**
   *
   * ⚠️ That can be minutes. `questions.ts` holds the session until its prompt cache expires, floored
   * at 5 minutes and capped at an hour, because that is what waiting actually costs. Whether every
   * MCP client tolerates a tool call that long is **not measured** — if one gives up first, the tool
   * call fails and the question is left open, which parks on schedule and loses nothing but the turn.
   */
  'question.ask': {
    params: {
      sessionId: string
      origin: QuestionOrigin
      kind: QuestionKind
      question: string
      header?: string
      options?: QuestionOption[]
    }
    result: QuestionResolution
  }
  /** Everything waiting on a person, parked included — both are answered the same way. */
  'question.list': { params: Record<string, never>; result: Question[] }
  'question.forTask': { params: { taskId: string }; result: Question[] }
  'question.answer': {
    params: { id: string; optionIds?: string[]; text?: string }
    result: Question
  }
  'approval.addRule': {
    params: { text: string; effect: 'allow' | 'deny'; projectId?: string | null }
    result: ApprovalRule
  }
  'approval.removeRule': { params: { id: string }; result: { ok: true } }

  'resource.list': { params: void; result: ResourceAvailability[] }
  /** Everything the cost model currently believes, and on what basis. */
  'cost.report': { params: void; result: CostReport }
  /**
   * The recent past of the daemon's log, for a panel that has just opened.
   *
   * ⚠️ Served from a ring buffer in memory, not by reading a file. The live stream arrives as `log`
   * events; this is only what happened *before* the UI attached, which is otherwise invisible.
   */
  /**
   * Set a task's finish policy. ⚠️ Also *acts*: switching a finished task to a landing policy lands
   * it, subject to the same bar a first completion faces.
   */
  'task.setFinishPolicy': {
    params: { id: string; finishPolicy: FinishPolicyChoice }
    result: { task: Task; landed: boolean; reason?: string }
  }
  /**
   * Whether this task may borrow a conversation. ⚠️ Recorded only - it takes effect on the next run
   * and never moves a task out of the session it is already talking in.
   */
  /**
   * Choose the model and effort this task's **next** run uses.
   *
   * ⛔ Records a preference and nothing else — deliberately unlike `task.setFinishPolicy`, which also
   * acts. A conversation already open keeps the model it started with, because switching model
   * mid-conversation throws the prompt cache away: caches are model-scoped, so the next turn pays a
   * full cache write instead of a read. Effort is cheaper and still not free — it invalidates the
   * messages cache on every model. The UI prices both before the operator commits.
   *
   * ⚠️ Validated at the door by `checkConstraints`, so a model this task's account cannot run is
   * refused here rather than at 3am when the task is finally dispatched.
   */
  'task.setModel': {
    params: { id: string; model: string | null; effort: string | null }
    result: Task
  }
  /**
   * Choose the worker this task's **next** run uses, or null to reassign to Auto / scheduler choice.
   */
  'task.setWorker': {
    params: { id: string; workerId: string | null }
    result: Task
  }
  /**
   * Set a task's priority level.
   */
  'task.setPriority': {
    params: { id: string; priority: 'P0' | 'P1' | 'P2' | 'P3' }
    result: Task
  }
  'task.setSessionSharing': { params: { id: string; sessionSharing: SessionSharingChoice }; result: Task }
  /** ⚠️ Takes effect on the task's **next** run: it changes the prompt, and a prompt is sent once. */
  'task.setCompletionMode': {
    params: { id: string; completionMode: CompletionModeChoice }
    result: Task
  }
  /** Choose what this task is optimising for, or 'inherit' to follow project/fleet. */
  'task.setObjective': {
    params: { id: string; objective: ObjectiveChoice }
    result: Task
  }
  /** Land a branch whose task already finished. The loose-ends list and the task pane both use it. */
  'task.land': { params: { id: string }; result: { task: Task; landed: boolean; reason?: string } }
  /**
   * Hand a failed landing back to an agent to rebase and resolve.
   *
   * ⛔ The fourth option a stuck landing needed. When `landTask` fails on a conflict the task rests
   * at `awaiting_human`, where the choices were *mark done*, *stop here* and *reassign* — none of
   * which is *fix the conflict and commit again*, which is the only one anybody wants.
   */
  'task.resolveConflict': {
    params: { id: string }
    result: { task: Task; started: boolean; reason?: string }
  }
  /**
   * Hand a failed check verification back to an agent to fix and re-commit.
   */
  'task.resolveChecks': {
    params: { id: string }
    result: { task: Task; started: boolean; reason?: string }
  }
  /** Work that exists and is going nowhere: uncommitted files, unlanded branches, rescued stashes. */
  /**
   * Every work conversation and what it served. ⚠️ Read-only and derived; there is deliberately no
   * way to *edit* a conversation from here, because the only honest edits are "run a task in it",
   * which the task pane already offers, and "close it", which the cache clock owns.
   */
  'conversation.list': {
    params: { projectId?: string; limit?: number }
    result: Conversation[]
  }
  'looseend.list': { params: void; result: LooseEnd[] }
  'looseend.dismiss': { params: { id: string }; result: { ok: true } }
  /** File a task to go and deal with one. ⚠️ Creates work; it does not do the work. */
  'looseend.reclaim': { params: LooseEnd; result: Task }
  /**
   * Delete a task branch that carries nothing the trunk does not already have.
   *
   * ⛔ The daemon re-derives that proof itself; this is a request, not an instruction. A branch that
   * has gained a commit since the panel was scanned comes back `deleted: false` with the reason.
   */
  'looseend.retire': {
    params: { projectId: string; branch: string }
    result: { deleted: boolean; reason?: string }
  }
  'log.tail': { params: { limit?: number; level?: LogLevel }; result: LogEntry[] }
  /** What is on disk, for the offline half. ⛔ Lists files; never returns their contents. */
  'log.files': { params: void; result: { directory: string; files: LogFile[] } }
  'settings.get': { params: void; result: Settings }
  'settings.set': { params: Partial<Settings>; result: Settings }
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
  /**
   * What work like this has cost before, from completed runs. Median, never mean.
   *
   * ⚠️ Pass a worker to get the answer *for that agent*. Without one the estimate is fleet-neutral,
   * and on this install the two differ by 81x — see `estimator.ts`.
   */
  'task.estimate': {
    params: { id: string; workerId?: string }
    result: {
      tokens: number
      /** The same number in input-token-equivalents, the unit comparisons are made in. */
      pricedTokens: number
      confidence: 'none' | 'low' | 'medium' | 'high'
      basis: string
      /** The agent/model multiplier applied; 1 when no worker was named or none is known yet. */
      factor: number
      /** True when a provider that publishes no cache multipliers was priced with assumed ones. */
      assumed: boolean
    }
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
  /**
   * ⚠️ Validated at the door, not at spawn time. `workerId`, `model` and `effort` are all rejected
   * here when they name something that does not exist, is not priceable, or is not offerable for the
   * adapter in question - a bad value that survived admission would surface as a CLI argument error
   * on somebody's account, minutes later, charged to their window.
   */
  constraints?: TaskConstraints
  verification?: 'required' | 'not_required' | 'auto'
  finishPolicy?: FinishPolicyChoice
  sessionSharing?: SessionSharingChoice
  completionMode?: CompletionModeChoice
  objective?: ObjectiveChoice
  status?: 'draft' | 'ready'
  kind?: TaskKind
  estTokens?: number | null
  /** Attachments already uploaded through `attachment.create`, bound to the task's first message. */
  attachmentIds?: string[]
}

export interface TaskUpdateParams {
  id: string
  title?: string
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  projectId?: string | null
  notBefore?: number | null
  deadline?: number | null
  assigneeHint?: string | null
  verification?: 'required' | 'not_required' | 'auto'
  finishPolicy?: FinishPolicyChoice
  sessionSharing?: SessionSharingChoice
  completionMode?: CompletionModeChoice
  objective?: ObjectiveChoice
  preemptible?: boolean
  estTokens?: number | null
  constraints?: TaskConstraints
  prompt?: string
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
  | { type: 'question.opened'; question: Question }
  | { type: 'question.answered'; question: Question }
  /** ⚠️ Not closed. The asker has gone; the question is still open and still answerable. */
  | { type: 'question.parked'; question: Question }
  | { type: 'quota.changed'; quota: QuotaSnapshot }
  | { type: 'session.changed'; session: Session }
  | { type: 'session.data'; sessionId: string; data: string }
  | { type: 'session.exit'; sessionId: string; exitCode: number | null }
  | { type: 'turn'; turn: Turn }
  | { type: 'consult.changed'; consult: Consult }
  | { type: 'chat.message'; message: ChatMessage }
  /**
   * One line the daemon logged.
   *
   * ⚠️ `debug` is in the union because the level is the *daemon's* choice, gated by
   * `MULTI_AGENT_CONTROLLER_LOG_LEVEL` at the source. A renderer that could not represent a level
   * the daemon can send would drop lines an operator had explicitly asked to see.
   */
  | { type: 'log'; level: LogLevel; message: string; ts: number }
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
  | { type: 'task.activity'; taskId: string; text: string; ts: number; reset?: true }
