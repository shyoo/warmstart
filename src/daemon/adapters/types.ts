import type { Attachment } from '@shared/tasks.js'
import type {
  AdapterDetection,
  AdapterInfo,
  QuotaSnapshot,
  QuotaWindow,
  SessionTransport,
  SpendSnapshot,
  WorkerIdentity
} from '@shared/protocol.js'
import type { StreamDecoder } from '../stream.js'
import type { TranscriptDecoder } from '../transcript.js'

/**
 * A permission rule for an adapter whose approvals are settled by **configuration rather than a
 * callback** (`approvalChannel: 'settings_rules'`).
 *
 * ⚠️ The difference from `permission_prompt_tool` is not cosmetic and costs real autonomy: there is
 * nobody to ask mid-run. Whatever is not allowed before the process starts is refused while it runs,
 * and the agent finds out by being told no. So the allowlist has to be written into the isolation
 * root *before* spawn, and an adapter that works this way will stall on anything not anticipated.
 */
export interface PermissionRules {
  allow: string[]
  deny: string[]
}

export interface WrittenPermissions {
  /** Where the rules were written, for Doctor and for the operator to read. */
  path: string | null
  /** Populated when nothing could be written; the session still runs, with fewer powers. */
  error?: string
}

export interface SpawnRequest {
  /**
   * The id agentyard minted for this session.
   *
   * ⚠️ Only meaningful when the adapter declares `mintsSessionId`. Where the CLI accepts no such
   * flag it is still agentyard's handle for the session - it is simply not a fact about the process,
   * which is why identity has to be established differently. See `AgentAdapter.transcriptPath`.
   */
  sessionId: string
  isolationRoot: string
  cwd: string
  transport: SessionTransport
  model?: string | undefined
  /**
   * ⛔ Set only when the adapter declares `selectableEffort`. The scheduler drops it otherwise rather
   * than passing a level to a CLI with no flag for one, so an adapter reading this can trust that it
   * said it could act on it.
   */
  effort?: string | undefined
  /**
   * Overrides the adapter's default mode. ⚠️ Used by the controller's chat session, which runs in the
   * operator's home directory rather than a worktree: there is no branch to throw away there, so its
   * tool use goes through the approval policy instead of a classifier.
   */
  permissionMode?: string | undefined
  /** Path to the MCP config giving this session agentyard's own tools. */
  mcpConfig?: string | null | undefined
  /** A one-shot flow (login, doctor) supplies its own argv and ignores session options. */
  argv?: string[] | undefined
  /**
   * The vendor's own handle for a conversation this session should continue.
   *
   * ⛔ **Only set when the adapter declares `resumeSession`**, and the flag it becomes is the
   * adapter's business: Claude Code takes `--resume <session-id>`, Antigravity takes
   * `--conversation <uuid>`. The scheduler knows only that a handle exists, never the spelling.
   *
   * ⚠️ Not the same field as `sessionId`. Where the CLI mints its own ids the two differ, which is
   * exactly why this is separate: agentyard's handle is not something the vendor would recognise.
   */
  resumeFrom?: string | undefined
  /**
   * Open a **new** conversation holding a copy of an existing one's context.
   *
   * ⛔ **Not `resumeFrom`, and the difference is whether the original is still running.** A resume
   * re-enters the same conversation and takes the same id back; a fork mints its own, so both can be
   * live at once and nothing the original is doing is disturbed. ⚠️ Only set when the adapter
   * declares `forkSession`.
   */
  forkFrom?: string | undefined
  /**
   * Images this run is carrying.
   *
   * ⛔ Read only by a `spawn-flag` adapter, which is the whole reason this is on the *spawn* rather
   * than on the prompt: codex has no stdin channel to send an image down, so `-i <file>` on the
   * process that runs the turn is the only channel there is. Every adapter may also use it to grant
   * its sandbox the directory the files are in, because the absolute path goes into the prompt text
   * on all of them and a path an agent may not open is worse than no path at all.
   */
  attachments?: Attachment[] | undefined
  /**
   * Stream this turn as it is written, rather than a message at a time.
   *
   * ⛔ Set only when the adapter declares `streamsPartialOutput` **and** the operator asked for it
   * (`Settings.liveNarration`), exactly the way `effort` is gated — so an adapter reading this can
   * trust that it said it could act on it, and nothing anywhere branches on an adapter's name.
   */
  partialMessages?: boolean | undefined
}

export interface SpawnPlan {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface IdentityProbe extends WorkerIdentity {
  loggedIn: boolean | null
}

/**
 * One agent CLI.
 *
 * ⛔ The scheduler asks `info.capabilities` and `info.policy`. It never asks which adapter this is.
 * Antigravity lacking `/compact`, or lacking a classifier-backed auto mode, has to express itself
 * as a missing capability - not as a branch in scheduling code.
 */
export interface AgentAdapter {
  readonly info: AdapterInfo

  /** Is this CLI installed, and at what version? Cheap, run at commissioning and by Doctor. */
  detect(): Promise<AdapterDetection>

  /**
   * Is the binary on this machine at all? ⛔ Synchronous and free - a filesystem lookup, never a
   * process spawn - because the scheduler asks it on **every candidate on every tick**.
   *
   * `detect()` answers the same question by running the CLI, which costs ~300ms and cannot be in a
   * loop that runs every ten seconds. This is the version a gate can afford.
   */
  isInstalled(): boolean

  /** Who is logged in to this isolation root? Must not spend a turn. */
  probeIdentity(isolationRoot: string): Promise<IdentityProbe>

  /**
   * How much of this account's window is left.
   *
   * ⚠️ Best-effort by contract. Every adapter must return a snapshot rather than throw, must set
   * `source`, and must never present a stale reading as current - see quota/poller.ts for why that
   * matters more than it sounds.
   */
  probeQuota(isolationRoot: string): Promise<Omit<QuotaSnapshot, 'workerId'>>

  /**
   * What this account's **money** meters read — a credit purse, a cumulative spend counter, an
   * overage bill. The pay-as-you-go side of the same question `probeQuota` asks about the flat fee.
   *
   * ⚠️ Best-effort by contract, exactly as `probeQuota` is: return a snapshot rather than throw,
   * always set `source`, and never present a stale reading as current — date it by the **vendor's**
   * timestamp wherever the vendor supplies one, because the staleness ladder in quota.ts reads it. A
   * probe that ran and found nothing returns no meters and an `error` saying why; that is a fact,
   * and it is recorded rather than dropped.
   *
   * ⛔ **It must cost no tokens.** This is called from the quota poller's own pacing, which runs for
   * weeks at a time, and a loop that bills anything is the one thing this scheduler may never be
   * (AGENTS.md). A file read is the rung this was designed around; a command is affordable only if
   * it spends nothing.
   *
   * ⚠️ Optional, and absent on every adapter whose `spendProbe` is `'none'` or `'stream'`. `'stream'`
   * means the number arrives unasked on a turn already being paid for — there is nothing to poll,
   * and implementing this there would buy a second, costlier route to a fact already in hand.
   */
  probeSpend?(isolationRoot: string): Promise<Omit<SpendSnapshot, 'workerId'>>

  plan(req: SpawnRequest): SpawnPlan

  /**
   * Where this session's transcript will appear, so the tailer can watch before the file exists.
   *
   * ⛔ Returns null when the adapter cannot mint a session id: the CLI names the file, and guessing
   * at the name would mean metering somebody else's session. `discoverTranscript` answers instead,
   * after the fact.
   */
  transcriptPath(isolationRoot: string, cwd: string, sessionId: string): string | null

  /**
   * Find the transcript a session actually wrote, for CLIs that name their own.
   *
   * ⚠️ Optional, and only implemented where `mintsSessionId` is false. Called after the process has
   * started, and must return the newest transcript **created after `startedAt`** - never merely the
   * newest, which on a machine where the operator is also using the CLI by hand would attach the
   * tailer to their session and meter their work as agentyard's.
   */
  discoverTranscript?(isolationRoot: string, cwd: string, startedAt: number): string | null

  /**
   * Write the project's permission rules into the isolation root before a session starts.
   *
   * Only implemented for `approvalChannel: 'settings_rules'`. ⛔ agentyard writes *rules*, never
   * credentials, and only into the root this worker owns.
   */
  writePermissions?(isolationRoot: string, rules: PermissionRules): WrittenPermissions

  /**
   * Answer this CLI's "do you trust this folder?" question for one directory, in advance.
   *
   * ⛔ Only ever called with a directory **this app created and owns** - the empty scratch dir a
   * projectless session runs in. It is never called with a project, a worktree or anybody's home,
   * and an adapter must not widen it: the question is about what an agent may act on, and the only
   * honest answer to pre-record is one about a folder with nothing in it.
   *
   * Optional, because most of this is one vendor's dialog. An adapter that does not implement it
   * simply leaves the question to the person, which is the behaviour that existed before.
   */
  trustDirectory?(isolationRoot: string, dir: string): void

  /**
   * Does this failure mean *nobody can sign this account in any more*?
   *
   * ⛔ The adapter answers, because the sentence is its CLI's. An expired subscription, a revoked
   * key and a plain crash all arrive as the same `api_error` on the wire and differ only in the
   * words after it - so this is one of the few places where matching on vendor text is the right
   * answer rather than a shortcut, and it belongs here, next to the CLI it knows about, and not
   * in the scheduler.
   *
   * ⚠️ It decides how the account is *presented*, never whether it is gated: a worker held out of
   * dispatch is held out whatever produced the failure. What this changes is whether the operator
   * is told to press `Sign in` or told to go and read the reason. Answering `false` is always
   * safe; answering `true` wrongly sends somebody to re-authenticate an account that was fine.
   */
  // ⚠️ A function property, not a method, for the same reason as `parseUsage` below.
  needsReauth?: (reason: string) => boolean

  /**
   * Does this failure mean *the account's subscription has expired or is inactive*?
   *
   * ⛔ The adapter answers, because the error sentence is its CLI's. An expired subscription is not
   * a re-auth requirement (signing in again will fail identically) and not an unfinished first-run
   * setup. What this changes is presenting the worker clearly as "Subscription Expired" and
   * withholding misleading "Finish setup" buttons.
   */
  subscriptionExpired?: (reason: string) => boolean

  /**
   * Does this failure mean *the account is out of quota for now*, rather than broken?
   *
   * ⛔ **The distinction t108 turned on** (2026-09-02). A run whose CLI answered
   * `api_error: You've hit your session limit · resets 4am` was wound up like any other failure: the
   * task went to `awaiting_human` and sat there. The window reopened at 11:00 and nothing moved it —
   * `awaiting_human` ends when a person types something, and seven hours later one did. Every other
   * way this fleet meets an exhausted window (the mid-run watchdog, a vendor refusal on the stream)
   * parks the task at `paused_quota` with `not_before`, which resumes itself; this one path did not
   * recognise the same event when it arrived as prose at the end of a turn.
   *
   * ⚠️ Same rules as `needsReauth`: anchored on measured phrases, never on `api_error` alone, and
   * `false` is always the safe answer — it only means the failure is handled the way it was before.
   * A wrong `true` parks a task on a clock instead of showing it to a person, which is recoverable
   * (the thread says so, and Resume is on the row) but still worse than not guessing.
   */
  // ⚠️ A function property, not a method, for the same reason as `parseUsage` below.
  outOfQuota?: (reason: string) => boolean

  /**
   * Does this failure mean *the remote provider is temporarily overloaded* (e.g. HTTP 529)?
   *
   * ⛔ **The distinction t153 turned on** (2026-09-03). A run whose CLI answered
   * `api_error: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.`
   * was wound up like an ordinary task failure and went to `awaiting_human` (or, if it happened
   * before any metered turns, struck the worker as dead-on-arrival and quarantined it). Neither
   * is true: the worker's credentials and setup are fine, and the work prompt is fine.
   *
   * ⚠️ Same rules as `needsReauth` and `outOfQuota`: anchored on measured phrases, never on
   * `api_error` alone, and `false` is always the safe fallback. What this changes is allowing the
   * scheduler to automatically retry after a timeout rather than abandoning the run to a person.
   */
  // ⚠️ A function property, not a method, for the same reason as `parseUsage` below.
  overloaded?: (reason: string) => boolean

  /**
   * Read a quota reading out of what the `/usage` panel rendered.
   *
   * ⛔ Required by, and only by, an adapter declaring `usageRefresh.answer === 'screen'`. This is
   * the one place in this codebase where rendered terminal text is allowed to become state, it is
   * allowed to produce **a quota reading and nothing else**, and the reason is that on Antigravity
   * there is no alternative at all: the numbers live in the CLI's memory and reach no file.
   *
   * ⚠️ Screen text is a rendering, so this must fail the way a rendering fails — return `null` when
   * the panel is not there or does not parse, never a zero, a guess, or a half-read set of windows.
   * A missing reading is already a state everything downstream distrusts correctly; a wrong one is
   * not.
   *
   * The text handed in has already had its ANSI escapes stripped.
   */
  // ⚠️ A function property, not a method: callers pull it off the adapter object
  // (`const parse = adapter(id).parseUsage`) and a method shorthand makes that an
  // unbound-method error. It never uses `this`.
  parseUsage?: (screen: string, now?: number) => QuotaWindow[] | null

  /** Parse account identity from the same usage screen when available. */
  parseIdentityFromScreen?: (screen: string) => { account?: string; subscriptionType?: string } | null

  /**
   * The same screen, asked a different question: does this CLI say *it* has no reading to give?
   *
   * ⛔ **The third answer.** `parseUsage` has two — a reading, or `null` for *I could not read this
   * screen* — and a panel that drew correctly and printed `Currently unavailable` is neither.
   * Measured on Muse Code: the `/usage` panel can render its Subscription block with no
   * percentages, even though the command was accepted. This is a provider response, not evidence
   * of a particular account state; an earlier first-turn explanation was disproved by recurrence
   * after completed work on 2026-09-08.
   *
   * Return the sentence to show a person — what the CLI said and what is known — or `null`, which
   * is every screen this adapter has no special reading of. ⚠️ It is asked **only after `parseUsage`
   * has declined**, so it can never mask a reading, and a non-null answer *ends the retry loop*: a
   * provider that has published no numbers will not publish them because the command was typed a
   * fifth time.
   */
  usageUnavailable?: (screen: string) => string | null

  /**
   * Turn one of this CLI's own stream records into an agentyard event.
   *
   * ⛔ Required for any adapter that offers the `stream` transport, because **there is no shared
   * stream-json format** - measured 2026-08-25, the three CLIs disagree on the envelope key, the
   * terminal record, where the text lives and whether usage appears at all. A parser keyed on one
   * vendor's shape reads *nothing* from another, silently. See stream.ts.
   *
   * Return null for records this adapter does not care about.
   */
  decodeStream?: StreamDecoder

  /**
   * Turn one line of this CLI's own transcript into a metered turn.
   *
   * ⛔ Required for any adapter declaring `metering: 'transcript'` whose transcript is **not** Claude
   * Code's shape, and there is no shared shape any more than there is a shared stream format —
   * measured 2026-09-06, muse's session log keys on `payload_type`, nests usage under
   * `payload.event.usage`, dates records in **microseconds**, and counts the cached prefix *inside*
   * `input_tokens` rather than beside it. A reader keyed on the other vendor meters nothing at all,
   * silently, and an unmetered run reports as free rather than as unknown.
   *
   * ⚠️ Absent means Claude Code's shape, which is what this tailer has always assumed.
   */
  decodeTranscript?: TranscriptDecoder

  /**
   * Format a user prompt into the wire shape this CLI's stream transport expects.
   *
   * ⛔ There is no shared stream-json format for input any more than for output: Claude Code expects
   * `{"type":"user",...}` while Antigravity expects `{"event":"user",...}`.
   *
   * ⛔ `attachments` is offered only where `capabilities.imageInput === 'inline'`; `sendPrompt`
   * gates on that before calling. An adapter that receives them anyway must still be safe to hand
   * an empty list, and one that declares `none` must ignore them — antigravity **fails the entire
   * turn** on an image block rather than dropping it, measured 2026-08-31.
   */
  encodeStreamPrompt?: (text: string, attachments?: Attachment[]) => string
}
