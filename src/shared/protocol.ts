import type { ManualReview, QualityReview } from './review.js'
import type { ModelClass } from './modelclass.js'

export type { ModelClass } from './modelclass.js'
import type {
  GradeBatch,
  QualityReport,
  ReviewCounts,
  ReviewFilter,
  ReviewQueuePage,
  UngradedTask
} from './quality.js'
import type { StatisticsReport, StatisticsWindow } from './statistics.js'
import type { ModelReport, RoutingDecisionPage, VelocityReport } from './routing.js'
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
  DebateExchange,
  DebateSeat,
  DebateState,
  DebateVerdict,
  Objective,
  ObjectiveChoice,
  Priority,
  Project,
  ProjectCreateRequest,
  ProjectCreateResult,
  ProjectDocDraft,
  ProjectInspection,
  ProjectPolicyPatch,
  WorkspaceRootReport,
  WorkspaceMode,
  WorkspaceModeChoice,
  PendingWork,
  TaskDiffFile,
  TaskDiffSummary,
  Question,
  QuestionKind,
  QuestionOption,
  QuestionOrigin,
  QuestionResolution,
  ReserveReport,
  ResourceAvailability,
  RestingState,
  RunOutcome,
  RunKind,
  Run,
  Task,
  PullRequestDelivery,
  TaskCommit,
  TaskConstraints,
  TaskKind,
  TaskStatus,
  TaskMessage,
  TaskPage,
  ProjectActivity,
  TaskSort,
  TaskView,
  FinishPolicy,
  FlowWorkspace,
  ChildDefaults,
  FinishPolicyChoice,
  ResolvedFinishPolicy,
  SessionSharing,
  AutoCompactChoice,
  ResolvedAutoCompact,
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
   * May a run keep going past the plan limit on an account that has usage credits turned on?
   * Default **false**.
   *
   * ⛔ **Two conditions, and both must hold.** This switch is the operator's standing intent; the
   * other half is `Worker.credits.enabled`, which is what the *vendor* says about that one account.
   * Where both are true the three interventions that exist to protect a quota window —
   * `autoCompact`, `autoPreempt` and `autoOverrunPreempt` — stand down for that worker, because
   * hitting the limit is the moment credits start doing their job and wrapping the run up there is
   * what defeats the purchase. Where the worker has no credits, nothing changes: a fleet-wide
   * "spend credits" applied to an account with none behind it would trade a clean wrap-up for a hard
   * vendor refusal.
   *
   * ⚠️ Default off because it is the one switch here that lets the fleet **spend real money** —
   * every other intervention this interface gates costs at worst an early wrap-up. An operator opts
   * into a bill; they are never defaulted into one.
   */
  spendCreditsPastLimit: boolean
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
   * Default balanced (40% quality, 30% cost, 30% velocity).
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
   * ⭐ The longest an idle account's reading is left before a real refresh (t577) — not merely how
   * often a cache file is re-read.
   *
   * ⛔ A separate control on purpose. An idle account's window is, by construction, not moving, so
   * the frequent cadence buys nothing there and costs a background process per sweep. The two
   * questions — *how closely do we watch work in flight* and *how often do we look at a quiet fleet*
   * — have different answers and used to share one number.
   */
  idleProbeIntervalMinutes: number
  /**
   * Whether the scheduler may occasionally explore an alternative routable model on the chosen worker.
   *
   * ⛔ Default **off**, on the same principle as `autoRunawayStop` and `summariseTitles`. This
   * deliberately dispatches work to a model the arithmetic did not choose: a real cost paid for
   * information, and it should be opted into.
   */
  modelExploration: boolean
  /**
   * Probability (0..1) of exploring an alternative model on an eligible decision. Default 0.10.
   */
  modelExplorationRate: number
  /**
   * How much of a running turn the live views show. Default `summary`.
   *
   *  - `summary`   — whole messages, one line per tool call, one line per thinking phase. Every
   *    adapter, no extra flags, no extra stream traffic.
   *  - `streaming` — as above, plus prose arriving word by word on adapters that declare
   *    `streamsPartialOutput`. ⚠️ Roughly ten times the stream lines per turn (measured 2026-09-13:
   *    81 against 7), which is why it is opted into rather than defaulted into.
   *
   * ⛔ Never branch on the adapter here: a CLI that cannot do it simply does not declare the
   * capability, and `streaming` is then the same as `summary` for that worker.
   */
  liveNarration: 'summary' | 'streaming'
}

/** The per-agent cost scale, as the Cost screen shows it. Mirrors `estimator.ts`'s own types. */
export interface CostFactorReport {
  keys: Array<{
    adapterId: string
    /** Null is the adapter-wide level: that agent's runs whose model was never recorded. */
    model: string | null
    samples: number
    medianPriced: number
    /** What the data says before shrinkage. Published so the shrinkage is visible, not implied. */
    ratio: number
    /** What is actually applied. */
    factor: number
    assumed: boolean
    /**
     * The median run on this level in **dollars** rather than priced tokens.
     *
     * ⛔ Carried beside `medianPriced` rather than replacing it: money is now the primary
     * indicator, but the two are measured from different things (§5) and neither is derived from
     * the other. `null` where no run on this level could be priced at all.
     */
    medianUsd: number | null
    /** ⚠️ How many of `samples` yielded a price. Always ≤ `samples`, and often far fewer. */
    usdSamples: number
    /**
     * Which series `ratio` was actually measured in.
     *
     * ⛔ Carried because a ×12 learned from dollars and a ×12 learned from priced tokens are
     * different claims about the same level, and the number alone cannot tell them apart. Every
     * belief carries its basis (AGENTS.md), and for this level the basis is *which unit*.
     */
    learnedFrom: 'usd' | 'priced_tokens'
  }>
  warmFactor: number
  coldFactor: number
  warmSamples: number
  coldSamples: number
  /** The fleet's median run with every factor divided out — the unit `factor` multiplies. */
  neutralPriced: number
  neutralRaw: number
  /** The same fleet-neutral run in **dollars**, or null where no run in the window could be priced. */
  neutralUsd: number | null
  samples: number
  /** ⚠️ Fleet-wide count of runs that could be priced in money. Always ≤ `samples`. */
  usdSamples: number
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
  /**
   * What each worker's money meters last read — the pay-as-you-go side of the cost picture, beside
   * the quota windows that carry the subscription side.
   *
   * ⚠️ `sampledAt` is null where the worker has never been probed, and `error` carries the last
   * failed probe verbatim. A meter reading is never shown without its age.
   */
  spend: Array<{
    workerId: string
    label: string
    meters: SpendMeter[]
    sampledAt: number | null
    error: string | null
  }>
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

/**
 * How much authority unattended work on this account may have.
 *
 * ⛔ **A choice about this account, not about a project (t545).** It used to live on
 * `ProjectConfig.permission.unattended`, gating every adapter a project's tasks could reach alike;
 * an account's own reach into the machine is a fact about that account, so it travels with the
 * worker instead — the same account is exactly as trusted whichever project hands it work.
 * `sandboxed-only` is enforced as an **eligibility gate** (`scoring.ts`), not as a downgrade: a task
 * that only a bypassing adapter could run holds, visibly, rather than being run sandboxed into the
 * stall t250 measured. See `docs/security.md`.
 */
export type UnattendedAuthority = 'full-user' | 'sandboxed-only'

export const UNATTENDED_AUTHORITY_LABELS: Record<UnattendedAuthority, string> = {
  'full-user': 'Full user authority',
  'sandboxed-only': 'Sandboxed adapters only'
}

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
   * May this account be asked for judgment, do work, both, or neither?
   *
   * ⚠️ `none` is not `enabled: false`. Disabling takes the account out of service entirely — no
   * quota polling, no rows, nothing. `none` keeps it commissioned, signed in and measured while
   * excluding it from both dispatch and judgment, which is the only way to say "this local model is
   * here, but I do not want it grading my work". Read it through `canWork`/`canJudge`, never by
   * comparing against a single name.
   *
   * The controller is a worker in the fleet with its own quota, which is what makes **leadership
   * delegation** free: an account near the top of its window simply stops being chosen for the next
   * judgment call, and at the floor the deterministic fallback answers instead. Plan §11.
   */
  role: WorkerRole
  maxConcurrent: number
  /**
   * How much of this machine unattended work on this account may reach.
   *
   * ⛔ **The absent-key grandfather is `full-user` for every adapter that only ever ran that way**
   * (Claude Code, Antigravity, Muse, an external declarative adapter, a local model) — moving the
   * setting here must not silently restrict a running fleet. Codex is the one adapter that offers a
   * real sandbox, and it grandfathers to `sandboxed-only` — the mode it has always run in — so
   * upgrading this build does not silently hand it `--dangerously-bypass-approvals-and-sandbox` on
   * its next dispatch. See migration 77.
   */
  unattendedAuthority: UnattendedAuthority
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
  /** Model used for peer reviews performed by this account. */
  gradingModel?: string | null
  /** Model used for this account's optional, title-only consults. */
  summarisingModel?: string | null
  /** Reasoning effort used with this account's grading model, where its CLI accepts one. */
  gradingEffort?: string | null
  /** Whether this account may be selected as a peer reviewer. */
  gradingEnabled?: boolean
  /** ⚠️ Only ever sent where the adapter declares `selectableEffort`; dropped otherwise. */
  defaultEffort: string | null
  /**
   * Default models per quota pool (e.g. { gemini: 'gemini-3.7-flash-high', claude: 'claude-sonnet-4-6' }).
   * When set on a multi-pool worker, the scheduler automatically balances across pools based on available budget.
   */
  defaultModels?: Record<string, string | null> | null
  /**
   * Every model this account may be *routed to*, beyond what it reaches for by default.
   *
   * ⛔ **`null` or `[]` both mean exactly what this worker uses today** —
   * `resolveModelChoice(null, worker, false, lastQuota(worker.id)).model`, wrapped in a
   * one-element array, or `[null]` when that itself is null ("the CLI's own choice"). That is what
   * keeps model-aware routing inert until an operator opts a worker in: nothing reads this as
   * "every model the adapter can price" just because it is empty.
   *
   * ⚠️ Validated against the cost model on write — `'model.options'` names the only models an
   * adapter can be priced, gated and estimated for, and an id absent from that list is refused
   * rather than stored.
   */
  routableModels?: string[] | null
  /**
   * Custom capability tier overrides per model ID on this account ('high' | 'med' | 'low').
   * Overrides built-in defaults for model routing candidate selection.
   */
  modelClasses?: Record<string, ModelClass> | null
  /**
   * Custom preferred reasoning effort overrides per model ID on this account.
   */
  modelEfforts?: Record<string, string | null> | null
  identity: WorkerIdentity | null
  /**
   * What the vendor last said about this account spending past its plan limit.
   *
   * ⛔ **The per-worker half of the `spendCreditsPastLimit` switch.** That switch is the operator's
   * standing intent; this is the vendor's answer, and the scheduler only stops preempting where the
   * two agree. A fleet-wide "use the credits" applied to a worker with no credits behind it would
   * push runs into an exhausted window and trade a clean wrap-up for a hard vendor refusal.
   *
   * ⚠️ `null` until a spend probe has read one, which is also what every adapter that reports
   * nothing leaves here for ever. Not knowing is not permission.
   */
  credits: CreditStatus | null
  /**
   * Whether the operator has said **this** account should spend credits, and what they were told.
   *
   * ⛔ Held so a discrepancy can be *noticed*: an operator who asked for credits on an account the
   * vendor then reports as off has a real problem — the runs they expected to keep going are being
   * wrapped up — and it is invisible unless the intent is written down beside the reading.
   */
  creditsIntent: CreditsIntent | null
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
  /**
   * Is the account unusable specifically because its vendor subscription has expired?
   *
   * ⛔ Distinct from `needsReauth`: re-authenticating does not resolve an expired subscription,
   * and presenting it as `re-sign-in required` sends an operator on a loop.
   */
  subscriptionExpired?: boolean
}

export type WorkerRole = 'worker' | 'controller' | 'both' | 'none'

/**
 * The two things an account can be asked to do, read off its role.
 *
 * ⛔ **Predicates, never a `!==` against one name.** Every gate here used to be written inline as
 * `role !== 'worker'` (can judge) or `role === 'controller'` (cannot work). Those spellings are only
 * correct while the role has exactly three values: the moment `none` exists, `!== 'worker'` reads an
 * account that does nothing as a controller, which is the opposite of what it says. Asking the
 * question by name means adding a role cannot silently re-enable it everywhere.
 */
export function canWork(role: WorkerRole): boolean {
  return role === 'worker' || role === 'both'
}

/** May this account be asked for judgment — a consult, a controller turn? See `canWork`. */
export function canJudge(role: WorkerRole): boolean {
  return role === 'controller' || role === 'both'
}

/**
 * The role a (work, judgment) pair spells — the inverse of `canWork`/`canJudge`.
 *
 * ⛔ **The whole pair, never an edit to the old name.** The Workers panel used to let each checkbox
 * derive its own next role by comparing the current one, which mapped a single-role account onto
 * itself when its only box was unticked: `controller` minus judgment came out `controller`. The
 * write succeeded, nothing moved, and the box sprang back with nothing to explain it. Deriving the
 * role from both booleans at once cannot express that.
 *
 * ⚠️ Neither is `none`, and it is a real answer rather than a slip — see `Worker.role`.
 */
export function roleOf(work: boolean, judge: boolean): WorkerRole {
  if (work && judge) return 'both'
  if (work) return 'worker'
  if (judge) return 'controller'
  return 'none'
}

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
  /** Has the CLI's config or probe identified that the subscription is expired / inactive? */
  subscriptionExpired?: boolean | null
  /**
   * The models the endpoint said it serves, as Warmstart names them (`local-llm:<served id>`), or
   * null where the adapter has no such list (every cloud CLI). ⭐ This is the model picker for a
   * local worker: the cost model has no catalogue to offer, because the model is whatever the
   * operator loaded, and only the server knows what that is.
   */
  servedModels?: string[] | null
  /**
   * The context window the endpoint reported (llama.cpp's `/props` → `n_ctx`), or null where the
   * server does not say. ⚠️ A measurement where present; the cost model's figure is the fallback.
   */
  contextWindow?: number | null
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
  /**
   * Where the numbers came from, which is what says how much to trust their age.
   *
   *  - `cli`          — a reading taken *now*, by asking the CLI.
   *  - `config-cache` — a file the vendor refreshes on its own schedule. As old as `sampledAt` says.
   *  - `stream`       — ⭐ the vendor volunteered it mid-turn, on a record riding work already being
   *    paid for. Fresher than either of the above and free: Claude Code's `rate_limit_event` carries
   *    `unifiedWindows` with a utilization per window (measured 2026-09-13 on 2.1.270). Stamped with
   *    **our** clock, because the record describes the request that is happening now.
   *  - `unknown`      — nothing usable was read. Never a synonym for `ok`.
   */
  source: 'cli' | 'config-cache' | 'stream' | 'unknown'
  /** Set when the probe failed. The scheduler degrades conservatively rather than stalling. */
  error?: string
  /**
   * Did the vendor itself say "no reading published yet", as opposed to any other reason `windows`
   * came back empty (a dialog ate the keystrokes, the session never started, a parse failure)?
   *
   * ⛔ **A real answer, not a guess.** Set only when the adapter's own `usageUnavailable` matched the
   * screen — see `muse-code.ts`: the panel is measured to blank until the window's first turn
   * completes, so "vendor silent" is itself evidence the window is fresh, never evidence that
   * something is broken. Everything downstream that reasons about a fresh window (`scoring.ts`'s
   * `prepaid`) may read it; nothing else should confuse it with a generic failure.
   */
  vendorSilent?: boolean
}

/**
 * One line of a `stream` session, decoded for a person to read.
 *
 * ⛔ **The second tier, and the reason there are two.** A dispatched agent has no terminal: `--print`
 * refuses to start under a PTY, so work runs on pipes and there is no screen to mirror. What the
 * session pane can honestly show is this — the same structured events the scheduler already consumes,
 * rendered. ⚠️ It is a *reconstruction*, it says so on screen, and nothing downstream reads it back.
 *
 * ⛔ `text` and `detail` are agent output and therefore untrusted. Rendered as text, never as markup.
 */
export interface SessionStreamLine {
  /** Monotonic per session, so a backfill and the live feed can be merged without duplicates. */
  seq: number
  ts: number
  /**
   * What this line is, so the pane can style it without reading the words.
   *
   *  - `text`       — assistant prose.
   *  - `thinking`   — a thinking phase. ⚠️ Never the words: measured 2026-09-13 on claude 2.1.270,
   *    the stream's `thinking` blocks carry an empty string and a signature, and `--include-partial-
   *    messages` gives `thinking_delta.thinking === ""` too. What exists is a token estimate.
   *  - `tool`       — a tool call, summarised by the adapter that knows its vendor's shapes.
   *  - `rate_limit` — the vendor's own quota caution, which is also what preemption runs on.
   *  - `result`     — the turn ended.
   *  - `note`       — anything else worth a line: the model and mode a session opened with.
   */
  kind: 'text' | 'thinking' | 'tool' | 'rate_limit' | 'result' | 'note'
  text: string
  /** The long form — a command, a path, a reason — shown only when the row is opened. */
  detail?: string | null
  /** ⚠️ `error` is the turn failing, not the agent reporting bad news. */
  tone?: 'normal' | 'dim' | 'warn' | 'error'
  /**
   * Tokens estimated for the thinking phase this line describes, where the vendor says.
   *
   * ⭐ Free: claude-code emits `{"type":"system","subtype":"thinking_tokens"}` with a running
   * `estimated_tokens` on every turn, with no flag. It is the only measure of a thinking phase that
   * a caller can have, and a caller that shows it must show it as an estimate.
   */
  thinkingTokens?: number
}

/**
 * One meter of **money actually billed**, as opposed to a `QuotaWindow`'s share of a flat fee.
 *
 * ⛔ **The money analogue of a quota window, and deliberately not the same type.** A window is a
 * percentage of something already paid for; a meter is a purse or a counter that a vendor charges
 * against on top of the subscription — Claude extra-usage overage, Antigravity cloud credits,
 * Codex credits. The two are summed into one headline (`RunPrice.usd`) and are never conflated on
 * the way there.
 */
export interface SpendMeter {
  id: string
  label: string
  /** ⚠️ A column, not an assumption, so a credit purse is a value rather than a schema change. */
  unit: 'usd' | 'credits'
  /**
   * What the meter read. `null` means the probe ran and found nothing — which is a fact, and not
   * the same statement as a balance of zero.
   */
  balance: number | null
  /**
   * Which way the number moves when money is spent.
   *
   * ⛔ `'balance_falls'` is a purse being drawn down, where a *rise* is a top-up;
   * `'spend_rises'` is a cumulative counter, where a *fall* is a billing-period rollover. Both of
   * those are "the baseline moved", and both poison every run across them — the exact analogue of
   * a quota window rolling over. See `attribute()` in daemon/price.ts.
   */
  direction: 'balance_falls' | 'spend_rises'
  /**
   * What one unit is worth in dollars. Always 1 for a `usd` meter.
   *
   * ⛔ `null` where the vendor publishes no conversion, which makes the meter **real but
   * unpriceable** — such a movement is `n/a`, never $0.00.
   */
  usdPerUnit: number | null
}

/**
 * Whether an account may spend past its plan limit, and on whose say-so.
 *
 * ⛔ **A reading, never a request.** Nothing in this app turns usage credits on: measured 2026-09-07
 * on Claude Code 2.1.263, both live accounts report `can_toggle: false` with
 * `disabled_reason: "org_level_disabled"`, and driving `/usage-credits` opens a **login chooser**
 * rather than a toggle. So this type exists to say what the vendor reports, to let the scheduler act
 * on it, and to let the operator be told when what they asked for and what the vendor says have come
 * apart. Flipping the switch is done by a person, where the vendor put it.
 *
 * ⚠️ Every money field is nullable and `null` is *not reported*, never zero — the same rule
 * `SpendMeter.balance` follows. On an account with credits off, the vendor publishes no balance at
 * all, and rendering that as `$0.00` would claim a purse is empty when it has merely not been shown.
 */
export interface CreditStatus {
  /** Is the account spending past its plan limit right now, per the vendor? */
  enabled: boolean
  /**
   * Did a *person* turn it off, as opposed to the account never having been allowed it?
   *
   * ⚠️ Kept apart from `disabledReason` because they answer different questions and disagree in
   * practice: both measured accounts report `user_disabled: true` **and** `org_level_disabled`.
   */
  userDisabled: boolean | null
  /** The vendor's own word for why, e.g. `org_level_disabled`. ⛔ Recorded, never interpreted. */
  disabledReason: string | null
  /**
   * Does the vendor say this account can turn credits on from the CLI at all?
   *
   * ⛔ The field that makes the honest answer possible. `false` on both measured accounts, and it is
   * why the app reports rather than acts — see the note on this interface.
   */
  canToggle: boolean | null
  /** Has this account ever had credits on? ⚠️ Distinguishes "off" from "never offered". */
  everEnabled: boolean | null
  /**
   * Does the vendor say this month's credit allowance is already spent?
   *
   * ⛔ **The difference between *you turned credits off* and *the vendor turned them off because the
   * allowance ran out*, which no other field here can tell apart.** Measured 2026-09-13 on Claude
   * Code 2.1.270 (`ClaudeFirst`): `hasExtraUsageEnabled: true` and `user_disabled: false` — the
   * operator's switch is on — while `is_enabled: false`, `spend_limit_reached: true` and
   * `used_credits` (20.57) is past `monthly_limit` (17.30). Both readings collapse into
   * `enabled: false`, and only this one says the next move is to wait for `resetsAt` (or raise the
   * ceiling) rather than to go and find a toggle.
   *
   * ⚠️ The vendor's own statement, not an arithmetic one: `creditsPurseEmpty` still infers the same
   * thing from `used >= monthlyLimit` where this is `null`, which is every adapter but this one and
   * every row written before this field existed.
   */
  spendLimitReached: boolean | null
  /** The monthly ceiling, where the vendor publishes one. */
  monthlyLimit: number | null
  /** Spend against that ceiling so far this billing month. See `SpendMeter.direction`. */
  used: number | null
  /** ISO-4217, as the vendor spells it. ⛔ Not assumed to be USD. */
  currency: string | null
  /**
   * When the monthly purse refills, as ms epoch — or `null` where the vendor says nothing.
   *
   * ⚠️ Inferred on `claude-code` from `oauthAccount.subscriptionCreatedAt` (the vendor publishes
   * no explicit credits reset anywhere measured), so this is the subscription-month anniversary,
   * not a date anybody printed. Anything that cannot name its basis reads `null`.
   */
  resetsAt: number | null
}

/**
 * What the operator asked for on one account, and when they were last told what the vendor says.
 *
 * ⚠️ `asked` is the intent and nothing more — it grants no permission by itself and enables nothing
 * at the vendor. `reportedAt` exists so a discrepancy is raised **once** rather than on every probe:
 * a question the operator has already answered must not come back every five minutes.
 */
export interface CreditsIntent {
  asked: boolean
  at: number
  /** When a mismatch between `asked` and the vendor's reading was last put to the operator. */
  reportedAt: number | null
  /**
   * Which mismatch that was — `creditsMismatchKind`'s answer at the moment it was reported.
   *
   * ⛔ **Once per *cause*, not once per account.** The operator who acts on the sentence and then
   * meets a different obstacle is told nothing by a silence keyed on `reportedAt` alone: measured
   * 2026-09-13 on `ClaudeFirst`, they turned the vendor's switch on, the allowance then ran out, and
   * the one surviving word for both situations was *Vendor reports credits off* — with the Doctor
   * warning suppressed since the first reading. ⚠️ `undefined` on rows written before this field,
   * which read as *nothing reported yet* and so raise their current cause once.
   */
  reportedKind?: CreditsMismatchKind | null
}

/**
 * Why the vendor is not spending credits this account was asked to spend.
 *
 * ⛔ A closed set, because each one has a different next move and `enabled: false` names none of
 * them: `purse-empty` waits for the refill (or a higher ceiling), `user-off` is a switch somebody
 * threw, `never-offered` is an account that has never had credits at all, and `off` is the vendor
 * saying no without saying why.
 */
export type CreditsMismatchKind = 'purse-empty' | 'user-off' | 'never-offered' | 'off'

/** Every meter one worker reports, at one moment. The money analogue of `QuotaSnapshot`. */
export interface SpendSnapshot {
  workerId: string
  meters: SpendMeter[]
  /**
   * What the vendor says about spending past the plan limit, where it says anything.
   *
   * ⚠️ Rides the spend probe rather than the quota one because it is a statement about *money*, and
   * because on every adapter measured so far it is read from the same file in the same breath.
   * `undefined` is an adapter that does not report it; `null` is one that looked and found nothing.
   */
  credits?: CreditStatus | null
  sampledAt: number
  source: 'cli' | 'config-cache' | 'stream' | 'unknown'
  /** Set when the probe failed. ⚠️ A failed probe is recorded, not dropped — see `QuotaSnapshot`. */
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
/**
 * ⚠️ `'review'` is none of the others, which is why it is its own value: it needs a real `cwd`
 * (unlike `consult`), no MCP tools (unlike `work`), a read-only permission mode, and a concurrency
 * bound of its own.
 */
export type SessionPurpose = 'work' | 'login' | 'consult' | 'chat' | 'probe' | 'review'

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
  /**
   * ⛔ Shown, never filtered out. A quality review is a real conversation that really happened and
   * really spent tokens; hiding it here would make this page disagree with the `runs` table it is a
   * view of. It is labelled instead, so a run that is not work reads as one.
   */
  kind: RunKind
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
  /**
   * The member of `permissionModes` in which this CLI may **read** the repository and may not write
   * to it.
   *
   * ⛔ A capability, not a name, and `null` is a real answer: an adapter with no such mode is never
   * offered a quality review rather than being run in a mode that could edit the trunk. That gate
   * matters more here than anywhere else in this app — a reviewer is spawned in the operator's own
   * project root, the one directory where an unwanted edit cannot be recovered by throwing a branch
   * away.
   *
   * ⚠️ Measured per CLI, and they disagree: `plan` on claude-code and antigravity-cli, `read-only`
   * on codex and local-llm. Declarative adapters default to `null`, which is the safe
   * direction — a JSON adapter is excluded until it says otherwise.
   */
  readOnlyPermissionMode: string | null
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
  /**
   * This adapter's `plan` honours `SpawnRequest.forkFrom`: a second process can be opened on a
   * conversation **that is still live**, holding its context without touching it.
   *
   * ⭐ What it is for, since t423: a dispatched task runs on pipes and has no terminal, so there is
   * no TTY to attach to and no way to make one. A fork is the closest honest thing — the real CLI,
   * in the real workspace, holding the same context, as a separate conversation nobody's run depends
   * on. Measured 2026-09-13 on claude 2.1.270: `--resume <id> --fork-session --session-id <new>`
   * honoured the minted id and read 31,372 cached tokens, which is a cache read and not a rebuild.
   *
   * ⚠️ Same claim shape as `resumeSession`: about *this adapter*, never about the vendor's flag list.
   */
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
   * Where this adapter's **money** reading comes from, if it has one at all.
   *
   * ⛔ The money analogue of `quotaProbe`, and a capability rather than a lookup table for the same
   * reason: nothing may branch on which adapter it is holding. A vendor that starts publishing a
   * balance becomes a value here and an implementation of `probeSpend`, and no scheduling code
   * changes.
   *
   *  - `none`         — this CLI reports no money at all. Every adapter starts here, and most stay.
   *  - `cli`          — a command has to be run to read it. Nothing declares this yet.
   *  - `config-cache` — it is already on disk, left behind by the CLI's own work. A file read, no
   *    process, no token. Codex writes its credit balance into every rollout.
   *  - `stream`       — it rides a turn already being paid for and arrives unasked. Claude Code
   *    reports `total_cost_usd` and its overage flags on records this fleet is already decoding.
   *    ⛔ There is nothing to poll on such an adapter, and `probeSpend` must not exist on one: a
   *    separate probe would be a second way to learn the same fact, and a costlier one.
   */
  spendProbe: 'none' | 'cli' | 'config-cache' | 'stream'
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
   * What one `assistant_text` event off this adapter's stream **is** — a finished piece of prose, or
   * a fragment of one still arriving.
   *
   *  - `message` — the event carries a whole assistant message, already framed by the vendor. Claude
   *    Code emits one per `{"type":"assistant"}` record; Codex one per `item.completed`. Its
   *    linebreaks are the agent's own, and the next event is a *different* message.
   *  - `delta`   — the event carries however many tokens happened to arrive together. Muse's
   *    `run.output.delta`, Antigravity's `text_delta`, the local-LLM bridge's ~60-character chunks.
   *    Consecutive events spell one sentence, and the boundary between two of them is usually
   *    mid-word.
   *
   * ⛔ **Declared, because the peephole cannot tell by looking, and it guessed wrong in both
   * directions.** Framing every event as its own row made a muse turn read one word per line
   * (`landing / corners.test.ts / pass. The / tree / is clean`, t272); framing every event as a
   * continuation then glued Claude's separate messages into one paragraph with no separator at all
   * (`…what t269 recorded.Now let me make the edits.`, t284) and dropped every linebreak it had
   * written. There is no reading of the bytes that gets both right — only the adapter knows which
   * shape its vendor emits, so the adapter says.
   *
   * ⚠️ `message` is the default a declarative adapter gets, and it is the safe direction: the worst
   * a wrongly-`message` stream does is show more rows than it needed, where a wrongly-`delta` one
   * destroys the text by running unrelated sentences together.
   */
  outputFraming: 'message' | 'delta'
  /**
   * Can this CLI be asked to stream a turn as it is written, rather than a message at a time?
   *
   * ⛔ **A capability, because it is a fact about the binary and because the setting that turns it on
   * is fleet-wide.** Claude Code has `--include-partial-messages`, which turns one `assistant` record
   * into a `content_block_start` / many `content_block_delta` / `content_block_stop` run — measured
   * 2026-09-13 on 2.1.270: 81 stream lines where the same turn without the flag produced 7.
   *
   * ⚠️ What it buys is smaller than it sounds, and the measurement is the reason the fleet default is
   * off. It does **not** unlock the thinking text (that is empty either way) and it does not unlock
   * the thinking token estimate (`system/thinking_tokens` arrives without any flag). It buys prose
   * appearing word by word in the live session view, at roughly ten times the parser traffic.
   */
  streamsPartialOutput: boolean
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
  /**
   * The mode unattended work runs in, when `defaultPermissionMode` is not available to it.
   *
   * ⛔ **Not a preference — a fact about the CLI.** Claude Code accepts `--permission-mode auto`
   * under `-p` without complaint and then runs `default` anyway; measured 2026-09-06 on 2.1.263, its
   * own `init` record reports `"permissionMode":"default"` while `acceptEdits`, `plan`, `dontAsk`
   * and `bypassPermissions` all stick. An adapter whose auto mode survives headless leaves this
   * unset and unattended work keeps `defaultPermissionMode`.
   *
   * ⚠️ Read only for a **`work`** session on the **`stream`** transport - the unattended case. A chat,
   * a consult or a review passes its own mode and is never touched by this.
   */
  headlessPermissionMode?: string | null
  /**
   * The mode that removes `headlessAuthority: 'sandboxed'`'s boundary, for the one adapter that
   * has both a sandbox and an escape from it.
   *
   * ⛔ **Absent everywhere except Codex, on purpose.** An adapter whose `headlessAuthority` is
   * already `'full-user'` has no sandboxed tier to opt out of — `headlessPermissionMode` already
   * names its one unattended mode. This field only means something on an adapter that offers a real
   * boundary by default, and says what to run instead when a worker's own
   * `unattendedAuthority: 'full-user'` says to skip it. See `sessions.ts`'s `permissionModeFor`.
   */
  bypassPermissionMode?: string | null
  /**
   * How much authority unattended work on this adapter actually has.
   *
   * ⛔ **A capability, not a branch on a mode name.** The question a project needs answered is *can
   * this thing do anything my user can do*, and the answer is not derivable from the mode string —
   * `bypassPermissions`, `--dangerously-skip-permissions` and `--sandbox danger-full-access` are
   * three spellings of the same authority, and a reader that pattern-matched on them would be wrong
   * the first time a vendor renamed one. Each adapter states its own answer, conservatively.
   *
   * ⚠️ `'sandboxed'` is a claim about a boundary the *CLI* enforces, and it is not absolute:
   * Codex's `workspace-write` is real but is widened by `grants.ts` to reach the shared `.git`. It
   * means *there is a boundary and it is not your whole user account*, which is the distinction a
   * project is choosing between.
   */
  headlessAuthority: 'sandboxed' | 'full-user'
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
  /**
   * How long to wait between typing the command and sending the carriage return.
   *
   * ⛔ **Measured 2026-09-07 (t266): on Muse Code the two must not arrive in one write.** Driven
   * through this app's own PTY, `write('/usage \r')` left `/usage` sitting in the composer unsent —
   * four times over eighteen seconds — while typing the text and sending the return 400ms later
   * drew the panel first time. Its TUI negotiates the kitty keyboard protocol and bracketed paste
   * on startup, and a return arriving inside the same chunk as the text is not a keypress to it.
   * ⚠️ Absent means one write, which is what Claude Code and Antigravity were measured on and what
   * they keep.
   */
  submitDelayMs?: number
  /**
   * What this CLI needs *done* before its provider will publish a window at all.
   *
   * `null`/absent is the ordinary case: the refresh above is the whole of it, and it spends nothing.
   */
  warmup?: UsageWarmup
}

/**
 * A turn spent to make a silent provider start publishing its numbers.
 *
 * ⛔ **This is the one probe in this app that costs money, and it is why it may only ever run from
 * a person's own press.** The scheduler spends zero tokens (see the invariant in AGENTS.md); a
 * refresh that quietly sent a prompt every time a window reset would bill a fleet for sitting idle,
 * which is the exact failure that invariant exists to forbid. Nothing on a timer may reach it.
 *
 * ⚠️ Declared by the adapter, never inferred from its id — an adapter that does not declare this
 * has no warm-up, and the button that offers one is not drawn. A missing feature is a missing
 * capability, never an `if` on a name.
 *
 * ⛔ **Completion is not read off the screen.** The TUI is for humans: the warm-up writes the
 * prompt, waits `completeMs` by the clock, and then re-drives the ordinary `/usage` probe, whose
 * parser is the only thing in this codebase allowed to turn rendered text into state — and into a
 * quota reading and nothing else. There is no "is it finished yet?" scraped from the pane.
 */
export interface UsageWarmup {
  /**
   * The prompt typed into the CLI, kept as small as a turn can be.
   *
   * ⚠️ It is a *question about the model itself* on purpose: it needs no workspace, no file and no
   * tool, so it cannot fail on a folder this account has not been told it trusts, and it cannot do
   * anything to a repository.
   */
  prompt: string
  /** How long the turn is given to finish before the usage panel is asked again. */
  completeMs: number
  /**
   * What a person is told — at commissioning, and again beside the button before they press it.
   *
   * ⚠️ It says what it costs. An operator who did not know a probe could spend a turn is the one
   * person this whole declaration is written for.
   */
  note: string
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
  /**
   * Set on an entry that lists what one worker's own server serves (local-llm), beside the
   * adapter-wide entry. A picker for that worker prefers its entry; a task constraint, which may
   * land on any worker, reads the adapter-wide one.
   */
  workerId?: string
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
  tools: Array<{
    id: 'git' | 'gh' | 'tailscale'
    label: string
    found: boolean
    path: string | null
    need: 'required' | 'pull-request' | 'remote'
  }>
  workers: Array<{
    workerId: string
    label: string
    isolationRootExists: boolean
    loggedIn: boolean | null
    lastQuota: QuotaSnapshot | null
    note?: string
  }>
  projects: Array<{ projectId: string; name: string; root: string; rootExists: boolean }>
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
  /** Total ledger rows, before the requested page is applied. */
  total: number
  spentTokens: number
  fallbacks: number
}

// ---------------------------------------------------------------------------- rpc

export interface RpcMap {
  'health': { params: void; result: { ok: true; version: string; uptimeMs: number } }

  'adapter.list': { params: void; result: AdapterInfo[] }
  'adapter.detect': { params: void; result: AdapterDetection[] }
  'tool.detect': { params: void; result: DoctorReport['tools'] }

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
      /**
       * Slots held by a task with no live process — one parked at `awaiting_human`, or one still
       * finishing or landing after a one-shot CLI exited. `retainedReservations()`, called.
       *
       * ⚠️ Only this half of the in-use count is served. The other half — open `work` sessions — is
       * already in `sessions`, and the renderer patches those per event without a round-trip, so
       * counting them there keeps the card's `1 / 2` in step with the rows drawn under it.
       */
      reservedSlots: number
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
      /** Omit to take the mode this adapter has always run unattended work in. See `Worker`. */
      unattendedAuthority?: UnattendedAuthority
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
        | 'gradingModel'
        | 'summarisingModel'
        | 'gradingEffort'
        | 'gradingEnabled'
        | 'defaultEffort'
        | 'defaultModels'
        | 'routableModels'
        | 'modelClasses'
        | 'modelEfforts'
        | 'unattendedAuthority'
      >
    >
    result: Worker
  }
  /**
   * Say whether this account is *meant* to spend usage credits past its plan limit.
   *
   * ⛔ **Records an intention; changes nothing at the vendor.** Measured 2026-09-07 on Claude Code
   * 2.1.263, both live accounts report `can_toggle: false` and `/usage-credits` opens a login
   * chooser rather than a toggle — so the switch itself is thrown by a person, where the vendor put
   * it. What this buys is that the app knows what was wanted, which is the only way `Doctor` can
   * notice the account is not doing it.
   */
  'worker.setCreditsIntent': { params: { id: string; asked: boolean }; result: Worker }
  /**
   * Put the fleet in this order, top to bottom.
   *
   * ⛔ The whole ordering, never a move — see `reorderWorkers`. The result is the fleet as it now
   * stands, so a caller never has to guess whether its own list won.
   */
  'worker.reorder': { params: { ids: string[] }; result: Worker[] }
  'worker.retire': { params: { id: string }; result: Worker }
  'worker.probe': { params: { id: string }; result: QuotaSnapshot }
  /**
   * Spend one small turn on this account, then read its usage panel again.
   *
   * ⛔ **Separate from `worker.probe` on purpose.** Probe is free and is allowed to run from a
   * timer; this is neither. A single method with a `warmUp` flag would have put a paid path one
   * defaulted argument away from every caller that already refreshes quota on a schedule.
   *
   * ⚠️ Refuses, rather than falling back to a free probe, where the worker's adapter declares no
   * `usageRefresh.warmup`: the operator asked for the paid thing and is owed the news that this
   * provider does not have one.
   */
  'worker.warmUsage': { params: { id: string }; result: QuotaSnapshot }

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
  /**
   * The decoded log of a `stream` session, for a pane opened after the run began.
   *
   * ⚠️ Additive, and a caller must tolerate it being absent: a desktop driving an older remote
   * reaches a daemon that has never heard of it, and the live view is still fed by `session.stream`
   * events from the moment it opens. A missing backfill is a shorter history, not a broken pane.
   */
  'session.streamlog': { params: { id: string }; result: { lines: SessionStreamLine[] } }
  /**
   * Open a real interactive terminal on a conversation — resumed where it is resting, forked where a
   * run is still in it. See `attachTerminal`; it refuses rather than guessing.
   */
  'session.attach': { params: { id: string }; result: Session }

  // ---- M2: projects, tasks, approvals, resources ----------------------------------------
  'project.list': { params: void; result: Project[] }
  'project.reorder': { params: { ids: string[] }; result: Project[] }
  'project.add': { params: { root: string; name?: string }; result: Project }
  /**
   * Point an already-registered project at a directory it was moved or renamed to. Refuses a
   * directory that does not exist, or that another project already claims. See `relocateProject`.
   */
  'project.relocate': { params: { id: string; root: string }; result: Project }
  /**
   * What is in a directory somebody is about to add: is it already a project, does it have a repo,
   * is it empty, which orientation docs are missing, what would verify it, and what is at the
   * workspace root the pool would derive.
   *
   * ⛔ **Read-only, and it is the reason the add form is a setup step rather than a text box.** Every
   * refusal the wizard makes — already added, workspace directory taken — is decided here, on the
   * daemon side, because the renderer cannot see a disk and `project.add`'s only validation was
   * `existsSync`.
   *
   * ⚠️ Called on every change to either path field, so it does no work a keystroke cannot afford:
   * a handful of `existsSync` calls, one directory listing, and one `git rev-parse`.
   */
  'project.inspect': {
    params: { root: string; workspaceRoot?: string }
    result: ProjectInspection
  }
  /** Just the workspace half of `project.inspect`, for the field that changes on its own. */
  'project.workspaceRoot': {
    params: { root: string; workspaceRoot?: string }
    result: WorkspaceRootReport
  }
  /**
   * Starter text for whichever of `README.md`, `AGENTS.md` and `HANDOFF.md` this directory lacks.
   *
   * ⛔ Generated here and edited in the form, and the edited text travels back on `project.create` —
   * so what lands on disk is what a person read. Regenerating at write time would make the file
   * something nobody had seen.
   */
  'project.docTemplates': {
    params: { root: string; name?: string; checks?: string[]; landingTarget?: string }
    result: { docs: ProjectDocDraft[] }
  }
  /**
   * Everything the add wizard decided, in one call: the directory, the repo, the registration, the
   * policy, the checks and the orientation docs.
   *
   * ⛔ **One method, not six.** Driving that sequence from the renderer has five places to stop
   * halfway and leave a project that is registered and unconfigured. ⚠️ It fails for anything that
   * would make the project *wrong* and warns for anything that merely leaves it *incomplete* — see
   * `createProject`.
   */
  'project.create': { params: ProjectCreateRequest; result: ProjectCreateResult }
  'project.reload': { params: { id: string }; result: Project }
  'project.archive': { params: { id: string }; result: Project }
  'project.writeConfig': { params: { id: string }; result: { path: string } }
  /**
   * Which ticket is in which workspace, on which account — the Flow board's middle column.
   *
   * ⛔ **Daemon-computed, exactly as `fleet.list`'s gates are, and for the same reason.** The
   * binding lives in the workspace claim, whose `holder` is a task id, a session id or
   * `reland:<taskId>`; resolving those needs the runs table, and no method a renderer already calls
   * ships one. Re-deriving it there from session `cwd`s would answer a weaker question and go silent
   * on the two states worth naming — a task holding its tree between runs, and a landing attempt.
   *
   * ⚠️ Read-only: it never builds the pool. A project that has never dispatched answers `[]`.
   */
  'project.flow': { params: { projectId: string }; result: FlowWorkspace[] }

  'task.list': { params: { projectId?: string; includeDeleted?: boolean } | void; result: Task[] }
  /** The phone overview's bounded, reverse-chronological project timeline. */
  'project.activity': { params: { projectId: string; limit?: number }; result: ProjectActivity[] }
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
      /** Optional search query filtering title, branch, or task number. */
      query?: string
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
      /**
       * Every commit this task landed, oldest first.
       *
       * ⛔ **The pane's only way to say what the task actually shipped.** The branch is retired the
       * moment the work lands, and `landedBaseSha`/`landedHeadSha` are a range — exact for the
       * ordinary task and unable to describe one that landed twice with other work in between. A
       * task that landed before these rows existed has them salvaged from its own *"Landed as …"*
       * thread message; a task that never landed has an empty list, which is a fact and not a gap.
       */
      commits: TaskCommit[]
      /** The live tail for this task, if anything is running. Same content as `task.activity`. */
      activity: Array<{ text: string; ts: number }>
      /** Every quality review of this task, newest first. ⛔ Kept, never replaced. */
      reviews?: QualityReview[]
      /** Operator-entered overall ratings, newest first. */
      manualReviews?: ManualReview[]
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
      /**
       * The task this one was filed by, when it was filed by another task at all.
       *
       * ⛔ **Not derivable from `dependencies`.** A piece of a Plan & Split does not depend on its
       * planner — the edge points the other way, so the planner waits on the piece — and the pieces
       * of one plan have no edges between them unless the planner asked for them. Without this the
       * thread of a subtask could say *which branch it lands on* and never say *whose plan it is*,
       * which is the first thing anybody opening it wants to know.
       */
      parent?: Task | null
      /**
       * The pieces this task filed, for a Plan & Split planner.
       *
       * ⚠️ Ordered by `seq`, which is the order they were filed, and always the *whole* set —
       * including the ones that failed. A planner's resolution turn exists precisely to deal with
       * those, so a list that quietly omitted them would be describing a different task.
       */
      children?: Task[]
      resolvedFinish?: ResolvedFinishPolicy
      resolvedSharing?: ResolvedSessionSharing
      inheritedFinish?: ResolvedFinishPolicy
      inheritedSharing?: ResolvedSessionSharing
      inheritedCompletion?: ResolvedCompletionMode
      /** Where the project puts a task left on `inherit`. */
      inheritedWorkspaceMode?: WorkspaceMode
      inheritedAutoCompact?: ResolvedAutoCompact
      /** Whether the adapter this task would run on declares `manualCompact`. See the daemon note. */
      compactionCapable?: boolean
      inheritedObjective?: Objective
      resolvedObjective?: Objective
      previewPrompt?: string
    } | null
  }
  /**
   * Can this task be quality-reviewed, and by whom?
   *
   * ⛔ Free, and asked before the button is drawn. It lists configured, routable peers even when
   * transient account state prevents an immediate run; `review.request` revalidates availability.
   * No routable peer can change through configuration, while **no recoverable diff** is permanent —
   * the task landed before its commit range was recorded and its branch has been retired.
   */
  'review.eligibility': {
    params: { taskId: string }
    result: {
      ok: boolean
      reviewers: Array<{
        workerId: string
        label: string
        model: string | null
        effort: string | null
        /**
         * How long a review has actually taken on this account, or null when it has never finished
         * one. ⚠️ Measured, never modelled — the pace of a local endpoint belongs to the operator's
         * own machine, and this app can only report what it has seen there.
         */
        typicalMs: number | null
      }>
      reason: string
    }
  }
  /**
   * Grade this task's diff against the published rubric, with an agent that did not write it.
   *
   * ⚠️ Spends one turn on the reviewer's account and resolves when the grade is stored. `ok: false`
   * means nothing was asked and nothing was spent.
   */
  'review.request': {
    /** Null/omitted means Auto; a worker id is revalidated against the same eligibility gates. */
    params: { taskId: string; workerId?: string | null }
    result: { ok: true; review: QualityReview } | { ok: false; reason: string }
  }
  /** Stop one pending, read-only quality review. It never changes the task's lifecycle state. */
  'review.cancel': {
    params: { reviewId?: string; taskId?: string }
    result: { ok: true; review: QualityReview } | { ok: false; reason: string }
  }
  /** Remove one quality review result (cancelled, failed, or unwanted). */
  'review.delete': {
    params: { reviewId: string }
    result: { ok: true } | { ok: false; reason: string }
  }
  /** Record a direct 0–10 user rating; it is not a rubric review. */
  'review.manual.create': {
    params: { taskId: string; score: number; explanation: string }
    result: { ok: true; review: ManualReview } | { ok: false; reason: string }
  }
  /** Change the operator's rating in place; the task keeps at most one. */
  'review.manual.update': {
    params: { reviewId: string; score: number; explanation: string }
    result: { ok: true; review: ManualReview } | { ok: false; reason: string }
  }
  'review.manual.delete': {
    params: { reviewId: string }
    result: { ok: true } | { ok: false; reason: string }
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
    params: { dataBase64: string; mediaType: string; name?: string; width?: number; height?: number }
    result: Attachment
  }
  'attachment.folder': { params: { path: string }; result: Attachment }
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
   * What is uncommitted in this task's workspace at this instant.
   *
   * ⛔ **Asked, not pushed, and asked late.** The thread's Finish button is what makes this
   * necessary — it releases the workspace, so pressing it over four edited files loses them into a
   * pooled worktree — and the only honest answer comes from reading the tree right then. Putting it
   * on `task.get` would have made every open of every thread run git, to answer a question only a
   * task resting in front of a person can act on.
   *
   * ⚠️ It runs git, so it is not free and is not a subscription. The pane asks when a conversation
   * comes to rest and after each of its own actions, and never on a timer.
   */
  'task.pendingWork': { params: { id: string }; result: PendingWork }
  /**
   * The changed files this task's branch would put on the trunk.
   *
   * ⛔ **The landing decision is about bytes, and until this existed no screen showed them.** The
   * thread knew one diff fact — `PendingWork.hasDiff`, a boolean about the *uncommitted* tree — so
   * a person at an `awaiting_human` gate had to leave the app and run git to decide whether to
   * press Land. This is the same change `resolveRange` hands the grader, read for a person.
   *
   * ⚠️ Runs git, like `task.pendingWork`, and is asked when the panel opens rather than on a timer.
   */
  'task.diffSummary': { params: { id: string }; result: TaskDiffSummary }
  /**
   * One file's patch text.
   *
   * ⛔ **One file at a time, never the whole change at once**, and the path must be one
   * `task.diffSummary` listed — the renderer does not get to name a file on disk. The patch is
   * untrusted text: `docs/ui.md` governs how it is drawn, and it is never markup.
   */
  'task.diffFile': { params: { id: string; path: string }; result: TaskDiffFile }
  /**
   * One recorded commit's own diff — the change a task that already landed put on the trunk.
   *
   * ⛔ **The sha must be one of this task's recorded commits.** The renderer does not get to name
   * an arbitrary commit: after the branch is retired these rows are the only durable answer to
   * "where did this work go", and each row opens onto exactly the commit it names. `from` reads
   * `'commit'` so the panel can tell this answer apart from the branch it would land.
   *
   * ⚠️ Runs git, like `task.diffSummary`, and is asked when a commit row is expanded or when the
   * commits box first needs its per-commit totals — never on a timer.
   */
  'task.commitDiff': { params: { id: string; sha: string }; result: TaskDiffSummary }
  /**
   * One file's patch text out of one recorded commit.
   *
   * ⛔ **Two memberships, not one.** The sha must be this task's recorded commit *and* the path
   * must be one that commit changed — the same double gate `task.diffFile` keeps, moved onto a
   * commit the branch no longer carries.
   */
  'task.commitFile': { params: { id: string; sha: string; path: string }; result: TaskDiffFile }
  /**
   * Ask this conversation's agent to commit, on the level the operator picked.
   *
   * ⛔ **The level is a parameter rather than a separate `setFinishPolicy` call**, because the two
   * writes have to be one decision: the policy is what the landing will read *and* what switches the
   * next turn out of the conversation contract. Split across two round trips there is a window in
   * which the task has a landing policy and still the conversation prompt, and a turn dispatched in
   * that window would be told to commit and told not to, in the same breath.
   */
  'task.commitConversation': {
    params: { id: string; finishPolicy: FinishPolicy }
    result: { ok: boolean; reason?: string }
  }
  /**
   * Land this conversation's branch on the level the operator picked, with no turn spent.
   *
   * ⛔ **Separate from `task.commitConversation` because it is a different action**, not the same one
   * in a different state: nothing is asked of an agent and nothing is dispatched — the branch is
   * already committed, and the tool does the rebase, the checks and the merge itself. The card draws
   * whichever of the two the workspace actually calls for, so a person is never offered one button
   * that means two things. ⚠️ Only levels the tool acts on are valid (`policyLands`).
   */
  'task.landConversation': {
    params: { id: string; finishPolicy: FinishPolicy }
    result: { ok: boolean; reason?: string }
  }
  /**
   * Dispatch this task now even though the account it needs is at or past the 92% water mark.
   *
   * ⛔ **An override of one number, granted by a person, expiring with the window it overrules.**
   * The water mark is this fleet's own caution — the vendor served every turn up to it — and on a
   * task pinned to a single account there was no way to say *"the remaining 8% is more than this
   * needs"*. It lifts the dispatch gate and either avoidable mid-run quota preempt: the percentage
   * cliff and the early wrap-up before a known window boundary. It lifts nothing else: a disabled
   * or signed-out account, a worker at capacity, and a turn the vendor **refused** are untouched.
   *
   * ⚠️ `until` defaults to the reset of the window being overruled, so the permission dies with its
   * own reason. Pass `until: null` to withdraw one. `applies` is false when the task is not
   * currently held by quota at all — the grant is still recorded, and saying so stops the button
   * reading as though it had unstuck something.
   */
  'task.overrideQuota': {
    params: {
      id: string
      until?: number | null
      preemptionAction?: 'compact' | 'handoff'
      /**
       * Only meaningful beside `preemptionAction: 'handoff'`. Present (a worker id, or `null` for
       * auto) means "hand off, then redirect there instead of waiting"; omitted clears any earlier
       * redirect and goes back to "hand off and pause here".
       */
      reassignWorkerId?: string | null
    }
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
  /** What this project's own manifests suggest. A proposal for a person, not a change. */
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
  /**
   * Remove idle pooled worktree directories from disk — the operator-confirmed second half of
   * switching a project to trunk-only (`poolSize: 0`), which by itself only parks them.
   *
   * ⛔ Trees something is standing in are kept, whatever was confirmed: an open claim or a live
   * session, and dirt that cannot be rescued onto its branch or a stash. Branches and stashes are
   * never deleted, so Loose ends still surfaces the work.
   */
  'project.pruneWorktrees': {
    params: { id: string }
    result: { removed: string[]; kept: Array<{ path: string; reason: string }> }
  }

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
    params: { id: string; optionIds?: string[]; text?: string; attachmentIds?: string[] }
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
   * The kept routing decisions, newest first.
   *
   * ⛔ Read back from the ledger, never recomputed. The windows, caches and context sizes that
   * produced a score existed for one tick; re-deriving it now would answer a different question in
   * an identical-looking number. See `@shared/routing.ts`.
   */
  'routing.decisions': {
    params: { limit?: number; offset?: number }
    result: RoutingDecisionPage
  }
  /** Who can take work right now, and how long each account has been measured to take. */
  'routing.velocity': { params: void; result: VelocityReport }
  /** Every (worker, model) pair the fleet could route to, and what fed its `fitness` and `price`. */
  'routing.models': { params: void; result: ModelReport }
  /** What peer review has measured about each agent, and how much work is still ungraded. */
  'quality.report': { params: void; result: QualityReport }
  /**
   * What this fleet's finished work actually cost, took and scored, per agent, model and effort.
   *
   * ⛔ **Descriptive, and deliberately not any of the numbers routing reads.** `routing.velocity`
   * publishes a shrunk pace factor and `routing.models` a fitness blended toward a benchmark prior,
   * because both exist to be acted on and a sparse key must not mint a reputation. This one
   * publishes the measured distribution, tail included — the answer to *"what does a task cost me
   * on that model"*, which shrinkage is by construction the wrong answer to. The two will disagree,
   * and both are right about their own question.
   *
   * ⚠️ One call for all three tabs, so the price, the duration and the grade on screen are folded
   * over the **same** window of finished tasks. Three calls would let a task land between them and
   * leave a reader comparing columns drawn from two different sample sets.
   */
  'statistics.report': { params: { window?: StatisticsWindow } | void; result: StatisticsReport }
  /** The tasks nothing has graded, newest first — what the grade button would work through. */
  'quality.ungraded': { params: { limit?: number }; result: UngradedTask[] }
  /**
   * One page of Analytics › Quality Review: finished tasks in one grade-count bucket, with, per
   * row, whether any peer could still grade it. Coverage totals are a separate read so opening a
   * page does not wait to validate every historical diff.
   */
  'quality.queue': {
    params: { filter?: ReviewFilter; limit?: number; offset?: number; gradableOnly?: boolean } | void
    result: ReviewQueuePage
  }
  /** The exact coverage totals for Analytics › Quality Review, calculated after its visible page. */
  'quality.coverage': { params: void; result: ReviewCounts }
  /**
   * Commission many reviews at once.
   *
   * ⛔ **Returns as soon as the queue exists, not when the reviews are done.** Each entry spends a
   * real turn on a real account; ALL over a fleet's backlog is hours of work, and an RPC that stayed
   * open for it would be lost by the first window reload. Progress comes back from `quality.batch`,
   * and the reviews themselves show up as runs on their own tasks.
   *
   * `count` is how many tasks are **attempted** (null = every match); `threshold` is a strict
   * `quality_review_count < threshold`.
   */
  'quality.batch.start': {
    params: { count: number | null; threshold: number }
    result: { ok: true; batch: GradeBatch } | { ok: false; reason: string }
  }
  /** The batch on screen, or null when none has been started since the daemon came up. */
  'quality.batch': { params: void; result: GradeBatch | null }
  /** Stop the queue. ⛔ Never stops a review already in flight — that is `review.cancel`. */
  'quality.batch.cancel': {
    params: void
    result: { ok: true; batch: GradeBatch } | { ok: false; reason: string }
  }
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
    params: {
      id: string
      model: string | null
      effort: string | null
      modelPolicy?: 'auto' | 'inherit' | null
      modelClass?: ModelClass | null
    }
    result: Task
  }
  /**
   * Choose the worker this task's **next** run uses, or null to reassign to Auto / scheduler choice.
   *
   * A reassigning control may include its model and effort in this same write. The scheduler ticks
   * independently of RPCs, so writing a worker and then its explicit model in two calls would give
   * the account default one opportunity to start work in between.
   */
  'task.setWorker': {
    params: {
      id: string
      workerId: string | null
      model?: string | null
      effort?: string | null
      modelPolicy?: 'auto' | 'inherit' | null
      modelClass?: ModelClass | null
    }
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
  /**
   * Whether the cache clock may compact this task's conversation, overriding the fleet switch.
   *
   * ⚠️ **Records a permission; it does not compact anything.** Switching a task to `on` does not send
   * a `/compact` — it lets the clock reach the moves that can, and the clock still decides on its own
   * terms (context past the break-even, enough growth since the last compaction, a prefix worth
   * reading while it is warm). The next tick is where an eligible session acts on it, within 10s.
   *
   * ⛔ It cannot conjure a capability. Against an adapter declaring `manualCompact: false` this is as
   * inert as the fleet switch is there, and the thread says so rather than showing a control that
   * silently does nothing.
   */
  'task.setAutoCompact': { params: { id: string; autoCompact: AutoCompactChoice }; result: Task }
  /**
   * Leave this task out of Statistics, the pace factor and every quality aggregate — or put it back.
   *
   * ⛔ For a *measurement* that is wrong, not for a result somebody dislikes. See
   * `Task.excludedFromStats` for the boundary, and for why the estimator is deliberately not in it.
   */
  'task.setStatsExcluded': { params: { id: string; excluded: boolean }; result: Task }
  /**
   * Where the task's agent works. ⛔ Refused once the task has run, and refused into the trunk while
   * its finish policy opens a pull request.
   */
  'task.setWorkspaceMode': {
    params: { id: string; workspaceMode: WorkspaceModeChoice }
    result: Task
  }
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
   * Resume a resolvable landing failure (conflict, verification, or uncommitted work) on its thread.
   * An optional worker/model choice is applied before the corrective prompt is dispatched, so a
   * failed landing can be handed to a different agent without losing its evidence.
   */
  'task.resolveRetry': {
    params: {
      id: string
      workerId?: string | null
      model?: string | null
      modelPolicy?: 'auto' | 'inherit' | null
      modelClass?: ModelClass | null
      effort?: string | null
    }
    result: { task: Task; started: boolean; reason?: string }
  }
  /**
   * Hand a failed check verification back to an agent to fix and re-commit.
   */
  'task.resolveChecks': {
    params: { id: string }
    result: { task: Task; started: boolean; reason?: string }
  }
  /**
   * Hand uncommitted changes or a failed commit back to an agent to commit and re-report complete.
   */
  'task.resolveCommit': {
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
  /**
   * Delete the local name of a branch whose pull request GitHub reports merged.
   *
   * ⛔ Re-reads the PR, re-compares the local head with the merged head and re-asks about the
   * worktree holding it; the operator's own checkout is never switched. `deleted: false` says why.
   */
  'looseend.cleanup': {
    params: { projectId: string; branch: string }
    result: { deleted: boolean; reason?: string }
  }
  /**
   * Delete a task branch that carries real commits, because the operator decided it is not needed.
   *
   * ⛔ Unlike `looseend.retire`, this does not require the branch to be disposable first — it is the
   * explicit, destructive counterpart to **Land it** on the same row. The daemon still refuses a
   * branch a worktree holds; `deleted: false` says why.
   */
  'looseend.delete': {
    params: { projectId: string; branch: string }
    result: { deleted: boolean; reason?: string }
  }
  /** Run the pull-request sweep now instead of waiting up to five minutes for it. */
  'looseend.checkMerged': {
    params: void
    result: { ran: boolean; checked: number; cleanedUp: number; kept: number; failed: number }
  }
  /** Pending pull request deliveries across all projects that have not landed yet. */
  'delivery.pending': { params: void; result: PullRequestDelivery[] }
  'log.tail': { params: { limit?: number; level?: LogLevel }; result: LogEntry[] }
  /** What is on disk, for the offline half. ⛔ Lists files; never returns their contents. */
  'log.files': { params: void; result: { directory: string; files: LogFile[] } }
  'settings.get': { params: void; result: Settings }
  'settings.set': { params: Partial<Settings>; result: Settings }
  'scheduler.tick': { params: void; result: { dispatched: number; note: string } }

  // ---- M4: the controller ---------------------------------------------------------------
  /** The ledger: every judgment call, what it decided, what it cost, and when it fell back. */
  'controller.report': { params: { limit?: number; offset?: number } | void; result: ControllerReport }
  /**
   * Drain the consult queue once, now, instead of waiting for the controller loop.
   * ⚠️ This is the one RPC in the daemon that can spend tokens on its own. Nothing in a scheduler
   * tick calls it.
   */
  'controller.drain': { params: void; result: { answered: number; note: string } }
  /** Decompose a coarse goal into draft children. Files a `plan` task, which is the unit of work. */
  /**
   * File a Plan & Split task.
   *
   * ⛔ **Two sets of settings, and that is decision D5.** The top level is what the *planning turn*
   * runs as — a real dispatch to a real account, which is the whole of t182 — and `childDefaults` is
   * what each piece it files inherits. They were one set of settings that the composer hid entirely,
   * because until a plan task was dispatched none of them would have been read.
   */
  'task.plan': {
    params: {
      title: string
      projectId?: string | null
      prompt?: string
      priority?: Priority
      finishPolicy?: FinishPolicyChoice
      sessionSharing?: SessionSharingChoice
      constraints?: TaskConstraints
      dependsOn?: string[]
      attachmentIds?: string[]
      childDefaults?: ChildDefaults
      maxChildren?: number
      /** A draft stays put; a ready plan may instead wait for this moment before it is dispatched. */
      status?: 'draft' | 'ready'
      notBefore?: number | null
    }
    result: Task
  }
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
      /** The same number in input-token-equivalents, the fallback unit and historical series. */
      pricedTokens: number
      /**
       * The same estimate in **money**, the primary cost indicator.
       *
       * ⛔ `null` is `n/a` — no run behind this estimate could be priced — and never `$0.00`.
       */
      usd: number | null
      /** ⚠️ How much the *money* answer is worth. `none` exactly when `usd` is null. */
      usdConfidence: 'none' | 'low' | 'medium' | 'high'
      confidence: 'none' | 'low' | 'medium' | 'high'
      basis: string
      /** The agent/model multiplier applied; 1 when no worker was named or none is known yet. */
      factor: number
      /** True when a provider that publishes no cache multipliers was priced with assumed ones. */
      assumed: boolean
    }
  }

  /**
   * File a Debate task, and open its seats in the same call.
   *
   * ⛔ **The seats are filed here, not by a first agent turn.** A debate's round 1 *is* the seats
   * answering blind, so the organizer's first dispatch is already the arbitration turn — it is
   * woken by the `settled` edges when every seat has answered, and costs nothing while it waits.
   */
  'task.debate': {
    params: {
      title: string
      projectId?: string | null
      prompt?: string
      priority?: Priority
      finishPolicy?: FinishPolicyChoice
      constraints?: TaskConstraints
      dependsOn?: string[]
      attachmentIds?: string[]
      status?: 'draft' | 'ready'
      notBefore?: number | null
      seats: DebateSeat[]
      rounds: number
      exchange: DebateExchange
    }
    result: { ok: boolean; task?: Task; seatSeqs?: number[]; reason?: string }
  }
  /** The board: every seat with its rounds, positions and unresolved citations. */
  'task.debateState': {
    params: { id: string }
    result: {
      debate: DebateState
      seats: Array<{
        taskId: string
        seq: number
        status: TaskStatus
        workerId: string | null
        adapterId: string | null
        model: string | null
        rounds: Array<{
          round: number
          text: string
          /** The seat's own words, or null when it did not state confidence. */
          confidence: string | null
          citations: Array<{ path: string; exists: boolean }>
        }>
      }>
      /** The organizer's briefs and agreement, newest last, as they were written to the thread. */
      organizer: Array<{ round: number; text: string }>
    } | null
  }
  /**
   * What a task that does not exist yet would cost.
   *
   * ⛔ **A preview, and the whole point is that it appears *before* anything is filed.**
   * `task.estimate` takes a task id, which a composer showing a cost notice does not have. This
   * reuses `complexityOf` and `estimateTask` unchanged; what is new is that it accepts a
   * description instead of a row. ⛔ `null` money with `usdConfidence: 'none'` rather than `$0.00`
   * where nothing behind it could be priced — the rule `task.estimate` already keeps.
   */
  'task.estimatePreview': {
    params: {
      title: string
      projectId?: string | null
      kind?: TaskKind
      /** One entry per seat, so a heterogeneous roster is priced on the agents it actually names. */
      seats?: DebateSeat[]
      rounds?: number
      /** The organizer's account, priced separately from the seats. */
      organizerWorkerId?: string | null
      organizerModel?: string | null
    }
    result: DebatePreview
  }
  'chat.history': { params: { threadId?: string } | void; result: ChatMessage[] }
  /** Talk to the controller. Answers arrive as `chat.message` events, not in this result. */
  'chat.send': {
    params: { text: string; threadId?: string }
    result: { ok: boolean; sessionId?: string; reason?: string }
  }
  /** Remove the displayed conversation history without ending its warm session. */
  'chat.clear': { params: { threadId?: string } | void; result: { ok: true } }

  // ---- worker tier: called by the MCP server on an agent's behalf -----------------------
  /**
   * Read a task's recorded thread and prior runs.
   *
   * Without `task`, the task this session is currently running — the recovery route for recorded
   * context. With `task` (a `t<seq>`, a bare seq, or an id), another task in the **same project**,
   * so a worker can read a sibling it was told about without gaining a way to inspect the fleet:
   * a task outside the caller's project, and a reference that names nothing, are both refused.
   */
  'agent.taskRead': {
    params: { sessionId: string; task?: string }
    result: { task: Task; messages: TaskMessage[]; runs: Run[] } | null
  }
  /** ⛔ The only signal that a task succeeded. A process exiting says nothing about the work. */
  'agent.complete': { params: { sessionId: string; summary: string }; result: { ok: true } }
  /**
   * Agent-authored work. Bounded by the calling task's inherited mandate and budget.
   *
   * ⛔ `aggregate` is a landing fact, and landing is the daemon's job: prose in the child's prompt
   * cannot hold a branch off the trunk (t519, 2026-09-17). With it the child lands into the
   * caller's own branch, the way a split piece lands into its plan branch.
   */
  'agent.createTask': {
    params: { sessionId: string; title: string; prompt?: string; assigneeHint?: string; aggregate?: boolean }
    result: { ok: boolean; seq?: number; reason?: string; landingTarget?: string }
  }
  'agent.handoff': { params: { sessionId: string; note: string }; result: { ok: true } }
  /**
   * The agent has gone as far as it can and the rest is a person's.
   *
   * ⛔ **Not a quieter `agent.complete`.** It claims nothing about the work and lands nothing: the
   * task comes to rest at `awaiting_human` carrying the agent's own reason, and the run ends
   * `blocked`. What it buys is that an agent stopping is *recorded* rather than inferred from a
   * session going quiet — without it, a run stays open and the task reads `running` for ever.
   */
  'agent.awaitHuman': {
    params: { sessionId: string; reason: string; state?: string }
    result: { ok: boolean; reply: string }
  }
  /**
   * The agent needs a directory outside its workspace, and asks the operator for it.
   *
   * ⛔ **Granting one cannot help the process that asked, and that is the whole shape of this
   * call.** A sandbox's writable set is fixed when the process starts: codex reads its roots off
   * the `exec` argv and re-applies the ACLs from that frozen payload before every command, and the
   * stream transport has no mid-flight channel to widen anything. So an approval has to reach a
   * *new* run. It does: the folder is recorded on the task exactly as one attached in the composer
   * is, this run ends `blocked`, and the task is requeued at once so the next dispatch resumes the
   * same conversation warm with `--add-dir` on the argv.
   *
   * ⭐ t469, 2026-09-15, is the run that had nowhere to go. The agent asked *"grant write access to
   * `C:\Dev\warmstart-site\.git` so the completed changes can be committed"*, the operator answered
   * *"Continue."*, and no answer they could type was capable of changing a sandbox. `ok: false`
   * means nothing was granted and the run carries on; `ok: true` means the run is over.
   */
  'agent.requestDirectory': {
    params: { sessionId: string; path: string; reason: string; state?: string }
    result: { ok: boolean; reply: string }
  }
  /**
   * File a whole Plan & Split at once, blocking until the operator approves or refuses it.
   *
   * ⚠️ `reply` is what the agent is shown, and it is load-bearing either way: on approval it names
   * each piece as `t<seq>` and tells the planner to stop, because an agent that carries on after
   * splitting is spending a turn on work it has just delegated. On refusal it carries the operator's
   * own note, so the planner revises rather than re-filing the same plan.
   */
  'agent.split': {
    params: {
      sessionId: string
      pieces: Array<{ title: string; summary?: string; dependsOn: number[] }>
    }
    result: { ok: boolean; reply: string; seqs?: number[] }
  }
  'agent.depend': {
    params: { sessionId: string; taskSeq: number; dependsOnSeq: number }
    result: { ok: boolean; reason?: string }
  }
  /**
   * The debate organizer's only move, called once per round.
   *
   * ⛔ **One call, two shapes.** `continue` sends one brief per seat and puts the organizer back to
   * sleep; `converged` raises the five-verdict card and **blocks until a person answers**, exactly
   * as `agent.split` blocks on its approval. Anything that will not validate comes back as
   * `reply` with `ok: false` and the reason — a missing dissent section, a request to go past the
   * operator's round cap, a brief count that does not match the seats.
   *
   * ⚠️ `verdict` is present only on the converged path and only once a person has answered; the
   * agent reads it out of `reply` as well, because that is the sentence it acts on.
   */
  'agent.debateRound': {
    params: {
      sessionId: string
      continue?: boolean
      briefs?: Array<{ seat: number; text: string }>
      converged?: boolean
      agreement?: string
      dissent?: string
      confidence?: string
      unresolved?: string
    }
    result: { ok: boolean; reply: string; verdict?: DebateVerdict }
  }
  /**
   * Land a **conversation's** committed work, and carry on talking.
   *
   * ⛔ **Not a terminal contract, and the one worker RPC that ends nothing.** `agent.complete` and
   * `agent.awaitHuman` both close the run; this one leaves the run open, the status alone and the
   * finish policy on `inherit`, because the person asking for a landing mid-conversation has not
   * said the conversation is over. Only Finish and Stop say that.
   *
   * ⛔ **Refused on a `work` task**, where landing *is* finishing: a work task that landed through
   * here would have its branch merged while the finish path was still waiting for `task_complete`,
   * and would then be judged against a branch that no longer exists.
   *
   * ⚠️ `level` is limited by the tool to the three that land (`policyLands`); absent, the landing
   * takes the project's own level with the conversation-kind override skipped. It is never persisted
   * onto the task — it says what this landing does, not what this task's finish policy is.
   */
  'agent.land': {
    params: { sessionId: string; summary?: string; finishPolicy?: FinishPolicy }
    result: {
      ok: boolean
      /** The refusal, verbatim. The agent is shown exactly this and nothing is moved. */
      reason?: string
      landedSha?: string
      target?: string
      /** The branch the conversation is now on, which is where the next commit goes. */
      nextBranch?: string
    }
  }

  'remote.status': { params: void; result: RemoteStatus }
  'remote.recheck': { params: void; result: RemoteStatus }
  'remote.setEnabled': { params: { enabled: boolean }; result: RemoteStatus }
  /**
   * Whether paired *desktops* may connect. ⛔ Separate from `remote.setEnabled` (phones): a desktop
   * token reaches the whole fleet with full desktop authority, which is a different decision.
   */
  'remote.setDesktopsEnabled': { params: { enabled: boolean }; result: RemoteStatus }
  'remote.setBind': { params: { bind: RemoteBind; port?: number }; result: RemoteStatus }
  'remote.setProject': { params: { projectId: string; enabled: boolean }; result: RemoteStatus }
  /** ⚠️ The code carries its kind: a phone code can never mint a desktop token. Defaults to `phone`. */
  'remote.pairingCode': { params: { kind?: RemoteDeviceKind } | void; result: { code: string; expiresAt: number; url: string; kind: RemoteDeviceKind } }
  'remote.revokeDevice': { params: { id: string }; result: { ok: true } }

  /**
   * The VAPID application-server key a phone needs before it may subscribe.
   *
   * ⛔ Public half only. It is minted on this machine, and the private half signs the pushes and
   * never leaves the daemon.
   */
  'remote.pushKey': { params: void; result: { publicKey: string } }
  'remote.subscribe': { params: RemotePushSubscription; result: { ok: true } }
  'remote.unsubscribe': { params: { endpoint: string }; result: { ok: true } }
}

/** A browser's `pushManager.subscribe()` result, as the phone app forwards it. */
/**
 * What a debate would cost, before one exists.
 *
 * ⛔ Every figure carries its basis, and money is `null` rather than `$0.00` where nothing behind
 * it could be priced — `usdConfidence` is `none` in exactly that case. `multiple` is the honest
 * headline: how many times the same question asked *once* this debate is.
 */
export interface DebatePreview {
  /** What one seat's single turn is expected to cost. */
  perSeatTokens: number
  perSeatUsd: number | null
  /** Seats × rounds + the organizer's turns. */
  totalTokens: number
  totalUsd: number | null
  /** ⚠️ `null` when the single-run baseline itself could not be estimated. */
  multiple: number | null
  usdConfidence: 'none' | 'low' | 'medium' | 'high'
  confidence: 'none' | 'low' | 'medium' | 'high'
  basis: string
  /** True when any figure rests on assumed cache multipliers. See `Estimate.assumed`. */
  assumed: boolean
  /** How many distinct **adapters** the roster spans. One is a same-family debate. */
  adapterSpread: number
  /**
   * The seats that cannot run at the same time, because their accounts' `maxConcurrent` or the
   * project's workspace pool will not have them. ⚠️ Said out loud, never silently corrected.
   */
  parallelSeats: number
  seatCount: number
}

export interface RemotePushSubscription {
  endpoint: string
  /** The subscriber's public key, base64url. */
  p256dh: string
  /** The subscriber's 16-byte authentication secret, base64url. */
  auth: string
}

export type RemoteBind = 'tailscale' | 'lan' | 'both'
/** Which policy a paired credential gets: the phone allowlist, or desktop parity. */
export type RemoteDeviceKind = 'phone' | 'desktop'
export interface RemoteDevice { id: string; label: string; kind: RemoteDeviceKind; createdAt: number; lastSeenAt: number | null; lastAddress: string | null; revokedAt: number | null }
export interface RemoteStatus {
  /** Paired phones may connect. */
  enabled: boolean
  /** Paired desktops may connect. */
  desktopsEnabled: boolean
  bind: RemoteBind; port: number; listening: boolean; secure: boolean; urls: string[]
  tailscale: { installed: boolean; hostname: string | null; certAvailable: boolean; error: string | null; certError: string | null; certTimedOut: boolean } | null
  projects: Array<{ id: string; name: string; enabled: boolean }>; devices: RemoteDevice[]
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
  workspaceMode?: WorkspaceModeChoice
  objective?: ObjectiveChoice
  autoCompact?: AutoCompactChoice
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
  workspaceMode?: WorkspaceModeChoice
  objective?: ObjectiveChoice
  autoCompact?: AutoCompactChoice
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
  /**
   * One decoded line of a `stream` session's output, for the live session view.
   *
   * ⛔ **Structure, not bytes.** `session.data` carries what a terminal should draw, and for a
   * `stream` session that is `renderForHuman`'s ANSI — a person-shaped rendering of a machine
   * protocol, which xterm can show and nothing can lay out. This carries the same events as
   * *records*, so the pane can collapse a tool call, dim a thinking phase and keep a rate-limit
   * line apart from prose. Neither is read to decide anything: the transcript is still the
   * machine's copy (AGENTS.md).
   */
  | { type: 'session.stream'; sessionId: string; line: SessionStreamLine }
  | { type: 'session.exit'; sessionId: string; exitCode: number | null }
  | { type: 'turn'; turn: Turn }
  | { type: 'consult.changed'; consult: Consult }
  | { type: 'chat.message'; message: ChatMessage }
  /**
   * One line the daemon logged.
   *
   * ⚠️ `debug` is in the union because the level is the *daemon's* choice, gated by
   * `WARMSTART_LOG_LEVEL` at the source. A renderer that could not represent a level
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
  | {
      type: 'task.activity'
      taskId: string
      text: string
      ts: number
      reset?: true
      /**
       * A fragment of the line still being spoken: replace the watcher's last row with this text
       * rather than pushing a new one. Emitted with the whole open line, so a watcher that missed
       * a fragment still lands on the right text. Absent, the row is a settled line of its own.
       */
      append?: true
    }
