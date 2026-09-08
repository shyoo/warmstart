import type { Project, ResolvedModelChoice, ResolvedSessionSharing, Task } from '@shared/tasks.js'
import type { Session } from '@shared/protocol.js'
import {
  DEFAULT_FLEET_SHARING,
  projectSharingChoice,
} from '@shared/tasks.js'
import { resolveSessionSharing as sharedResolveSessionSharing } from '@shared/policy.js'
import { settings } from './settings.js'
import { adapter } from './adapters/index.js'
import { cacheHasLapsed } from './sessions.js'

/**
 * Who may borrow whose conversation.
 *
 * ⛔ **The gates here are mechanical, and that was a deliberate choice** rather than a first
 * approximation waiting to be replaced. A topic score is the obvious next idea and it has no ground
 * truth: when it misfires there is nothing to check it against, and the cost of being wrong is an
 * agent that has silently read work it was not given. So the rule is one anybody can predict from the
 * outside — *same project, same account, free, clean, and room to grow* — and `rank` returns a list
 * rather than a winner so a score can become a comparator later without any of this being rewritten.
 *
 * ⚠️ Sharing is a **preference, never an authority**. `mandate` still decides what a task may do.
 * Turning this on lets a task read a conversation; it never lets one act beyond what it was granted.
 */

/**
 * How full a conversation may be before it stops taking on new work.
 *
 * ⛔ A borrowed conversation that is about to need compaction is a false economy: the borrower pays
 * to read a large prefix and then pays again to compact it, having gained context that was mostly
 * about somebody else's task. Below this it is cheaper than a cold start; above it, it is not
 * obviously cheaper than anything.
 *
 * ⚠️ A fraction of the window rather than a token count, because the windows differ by an order of
 * magnitude across the fleet — 200k on some models, 1M on others — and one constant would be far too
 * strict on the large ones and useless on the small.
 */
export const SHARE_CEILING = 0.6

/**
 * How full a conversation has to be before being *wanted* is a reason to compact it.
 *
 * ⛔ Above `SHARE_CEILING`, deliberately, and the gap between the two is the point rather than an
 * oversight. Between 60% and 70% a conversation is merely not worth borrowing: it is left alone,
 * because compacting it costs a full read of a context nobody has asked for and the session's own
 * task may want every token of what is in there. Past 70% the same conversation is the *only* warm
 * prefix a queued task in this project can have, it is going to need compacting anyway — the cache
 * clock's own move 4 is waiting on an idle estimate that may never come — and doing it now converts
 * a conversation that can serve nobody into one that can serve the queue.
 *
 * ⚠️ A fraction of the window for the same reason `SHARE_CEILING` is one: the windows across a fleet
 * differ by an order of magnitude and one token count would be nonsense at both ends.
 */
export const SHARE_COMPACT_FLOOR = 0.7

export { projectSharingChoice }

/**
 * Delegates to `shared/policy.ts`, binding the fleet setting for daemon callers.
 */
export function resolveSessionSharing(
  task: Task | null,
  project: Project | null
): ResolvedSessionSharing {
  return sharedResolveSessionSharing(task, project, settings().sessionSharing ?? DEFAULT_FLEET_SHARING)
}

/** Why a conversation was not offered to a task. Null means it was. */
export type ShareRefusal =
  | 'not-this-project'
  | 'not-this-account'
  | 'wrong-model'
  | 'wrong-effort'
  | 'no-workspace'
  | 'busy'
  | 'cannot-resume'
  | 'one-shot'
  | 'cache-lapsed'
  | 'context-too-full'
  | null

/**
 * Which of the two reuses is being asked about.
 *
 * ⛔ **They are not the same question, and codex is where they came apart.** `live` means *send a
 * prompt into the process that is running this conversation right now*; `revive` means *spawn a new
 * process that reopens a conversation nobody is talking in*. A `streamPrompts: 'once'` CLI reads
 * stdin to EOF and exits, so it can be revived and can never be spoken to — and until `codex exec
 * resume` was wired it happened to fail both, which let one `resumeSession` check stand in for both
 * gates. It cannot any more: leaving it as one would offer a live codex process as a warm session
 * and write a prompt into a pipe that closed after its first turn.
 */
export type Continuation = 'live' | 'revive'

/**
 * What the task would be run *as*, on the worker whose conversation is being considered.
 *
 * ⛔ Resolved by the caller rather than here, from the same `resolveModelChoice` the dispatch will
 * reach, because the answer depends on the worker's defaults and its quota pools — knowledge this
 * module deliberately does not have. Passing the resolved pair in is what keeps "which model would
 * this task use?" a question with one implementation.
 */
export type ShareIntent = Pick<ResolvedModelChoice, 'model' | 'effort'>

/**
 * Would joining this conversation silently give the task a different model or effort than it asked
 * for?
 *
 * ⛔ **The gate that makes borrowing honest.** A turn sent into a live conversation is served by the
 * process that conversation is already running: the model and the reasoning effort were fixed when
 * it was spawned and there is no argument to change them — `dispatchIntoWarmSession` sends a prompt,
 * it does not respawn. So a task pinned to Opus, dropped into a Sonnet conversation because that one
 * happened to be warm, runs on Sonnet and records that it ran on the model it asked for. The saving
 * is real and the answer is not the one that was ordered.
 *
 * ⚠️ **Unknown is not a mismatch**, the same rule `isTooFull` follows. A session whose CLI chose its
 * own model records `null`, and reading that as "different" would exclude every adapter that does
 * not report one — refusing a real saving over a fact nobody wrote down. Only two *known* and
 * *different* values are a refusal.
 */
export function mismatch(intent: ShareIntent | undefined, session: Session): ShareRefusal {
  if (!intent) return null
  if (intent.model && session.model && intent.model !== session.model) return 'wrong-model'
  if (intent.effort && session.effort && intent.effort !== session.effort) return 'wrong-effort'
  return null
}

/**
 * May `task` be given `session`? One function, so the answer is the same everywhere it is asked and
 * the log can say which gate refused rather than "no suitable session".
 *
 * ⛔ **Never a session with an open run**, and that gate lives in the lease rather than here — a
 * caller that forgot to take the lease would still be refused by `claim`. This is the cheap filter
 * that keeps the scheduler from ranking candidates it cannot have; the lease is the guarantee.
 */
export function whyNotShared(
  task: Task,
  session: Session,
  opts: { hasWorkspace: boolean; leased: boolean; intent?: ShareIntent; continuation?: Continuation }
): ShareRefusal {
  // ⛔ Cross-project sharing is not a tuning question. One client's code in another client's
  // conversation is not something a scheduler gets to decide is acceptable.
  if (!session.projectId || session.projectId !== task.projectId) return 'not-this-project'
  // ⛔ A conversation lives inside one worker's isolation root, so sharing never crosses an
  // account — that much is structural. What is *not* structural is a task that was pinned to a
  // particular account or adapter: honouring the pin everywhere except when a warm conversation is
  // available would make the constraint mean "unless it is inconvenient".
  if (task.constraints?.workerId && task.constraints.workerId !== session.workerId) {
    return 'not-this-account'
  }
  if (task.constraints?.adapterId && task.constraints.adapterId !== session.adapterId) {
    return 'not-this-account'
  }
  const wrong = mismatch(opts.intent, session)
  if (wrong) return wrong
  // A conversation with no worktree has nothing to lend: the borrower would have to claim its own,
  // and at that point it is a cold start wearing somebody else's context.
  if (!opts.hasWorkspace) return 'no-workspace'
  if (opts.leased) return 'busy'
  const caps = adapter(session.adapterId).info.capabilities
  if (!caps.resumeSession) return 'cannot-resume'
  // ⛔ Defaults to `live`, which is the stricter of the two: a caller that forgets to say which
  // reuse it means is refused a one-shot conversation rather than handed one it cannot speak in.
  if ((opts.continuation ?? 'live') === 'live' && caps.streamPrompts === 'once') return 'one-shot'
  // ⛔ **A borrow buys a warm cache and nothing else, so a lapsed one buys nothing.**
  //
  // ⚠️ This gate belongs *here* and deliberately not in `resumableSession`, and the difference is
  // the whole reason it is narrow. A task resuming its **own** conversation gets back the branch,
  // the files and the question it was answering, and `dispatch` resumes that one cold on purpose —
  // losing it has been measured as the more expensive mistake (t91/t92, 2026-09-01, 13.3M tokens on
  // one of them re-deriving work it had already done). A **borrower** has none of that continuity:
  // it did not have this conversation, it is being handed somebody else's context to read, and the
  // only thing it gains is a prefix somebody already paid for. Once that prefix has lapsed the
  // trade inverts — the borrower pays a full rebuild (1.25x here, 2.0x on Anthropic) to load
  // context it never needed, and takes the disclosure for free.
  //
  // ⭐ Codex is where this bites: a 30-minute TTL measured from the request start lapses between
  // ordinary dispatches, so most codex conversations are cold by the time a second task wants one.
  if (cacheHasLapsed(session)) return 'cache-lapsed'
  if (isTooFull(session)) return 'context-too-full'
  return null
}

/**
 * ⚠️ Unknown is not full. A session whose model has no priced window reports no `contextWindow`, and
 * reading that as "too full" would exclude a whole provider from sharing for a number it does not
 * publish — the same trap as treating an unrecorded cache expiry as lapsed.
 */
export function isTooFull(session: Session): boolean {
  return fullerThan(session, SHARE_CEILING)
}

/**
 * Is this conversation full enough that a task waiting to borrow it is worth a compaction?
 *
 * ⚠️ Asked only of a session that was refused *for being full and for nothing else* — the caller
 * establishes that. On its own this says nothing about whether the conversation is shareable.
 */
export function wantsCompactionToShare(session: Session): boolean {
  return fullerThan(session, SHARE_COMPACT_FLOOR)
}

function fullerThan(session: Session, fraction: number): boolean {
  if (session.contextWindow === null || session.contextTokens === null) return false
  return session.contextTokens > session.contextWindow * fraction
}

/**
 * The conversations worth offering, best first.
 *
 * ⚠️ **A list, not a winner.** The caller still has to take the lease, and the lease can fail between
 * ranking and claiming. Returning a ranked list is also the seam a topic score slots into later: it
 * becomes another term in this comparator rather than a new decision somewhere else.
 *
 * Ordered by how much is left to fill — the emptiest conversation first, since it is the one with the
 * most room for the borrower's own work before it needs compacting.
 */
export function rank(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => (a.contextTokens ?? 0) - (b.contextTokens ?? 0))
}
