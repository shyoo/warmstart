import type { Project, ResolvedSessionSharing, Task } from '@shared/tasks.js'
import type { Session } from '@shared/protocol.js'
import {
  DEFAULT_FLEET_SHARING,
  projectSharingChoice,
  resolveSessionSharing as sharedResolveSessionSharing
} from '@shared/tasks.js'
import { settings } from './settings.js'
import { adapter } from './adapters/index.js'

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

export { projectSharingChoice }

/**
 * Resolve task → project → fleet, taking the first that is not `inherit`.
 *
 * ⚠️ `inherit` is a real value, not a blank. A task left on it follows its project as the project
 * changes; a task set explicitly to the same value does not. That difference is the reason the
 * dropdown offers it rather than showing an empty box.
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
  | 'no-workspace'
  | 'busy'
  | 'cannot-resume'
  | 'context-too-full'
  | null

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
  opts: { hasWorkspace: boolean; leased: boolean }
): ShareRefusal {
  // ⛔ Cross-project sharing is not a tuning question. One client's code in another client's
  // conversation is not something a scheduler gets to decide is acceptable.
  if (!session.projectId || session.projectId !== task.projectId) return 'not-this-project'
  // A conversation with no worktree has nothing to lend: the borrower would have to claim its own,
  // and at that point it is a cold start wearing somebody else's context.
  if (!opts.hasWorkspace) return 'no-workspace'
  if (opts.leased) return 'busy'
  if (!adapter(session.adapterId).info.capabilities.resumeSession) return 'cannot-resume'
  if (isTooFull(session)) return 'context-too-full'
  return null
}

/**
 * ⚠️ Unknown is not full. A session whose model has no priced window reports no `contextWindow`, and
 * reading that as "too full" would exclude a whole provider from sharing for a number it does not
 * publish — the same trap as treating an unrecorded cache expiry as lapsed.
 */
export function isTooFull(session: Session): boolean {
  if (session.contextWindow === null || session.contextTokens === null) return false
  return session.contextTokens > session.contextWindow * SHARE_CEILING
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
