import { sessionEnded } from '@shared/protocol.js'
import type { Session } from '@shared/protocol.js'
import type { FlowWorkspace, ResourceClaim, Task } from '@shared/tasks.js'
import { samePath } from './fspath.js'
import { getResource, openClaims, workspacePoolId } from './resources.js'
import { getSession, listSessions } from './sessions.js'
import { getTask, lastRunForSession, runForSession } from './tasks.js'
import { getWorker } from './workers.js'

/**
 * Who is working where, for the Flow board.
 *
 * ⛔ **Read-only, and it never calls `ensurePool`.** A view that built worktrees would create four
 * directories on a repository somebody merely clicked on, and it would do it again every time the
 * tab was opened. A project whose pool has never been built answers with an empty list, which is
 * the truth: there is nowhere for work to run yet.
 *
 * ⚠️ The pool's `members` array is the order the board draws — `ws1` first — so the row a task
 * appears in does not move as claims come and go.
 */

/** `C:\Dev\ws\ws2` → `ws2`. The pool names its members, so this is a display trim, not a parse. */
function shortName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

/** The live `work` session sitting in this tree, if a process is still open there. */
function residentSession(sessions: Session[], path: string): Session | null {
  return sessions.find((s) => samePath(s.cwd, path)) ?? null
}

/** The last session that worked in this tree, for when the workspace is currently free. */
function lastSessionInPath(sessions: Session[], path: string): Session | null {
  const matching = sessions.filter((s) => samePath(s.cwd, path))
  return matching.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}

/**
 * The task a claim is held for, and how.
 *
 * Three holder shapes, because three different things take a workspace claim and each is a state an
 * operator reads differently:
 *
 *  - a **session id** — a live conversation is working in that tree right now;
 *  - a **task id** — the task holds its own tree between runs (dispatch has claimed it and not yet
 *    started, or the run ended with the task waiting on a person and the tree kept for its return);
 *  - **`reland:<taskId>`** — a landing attempt is using the tree, with no agent in it at all.
 */
function resolveHolder(claim: ResourceClaim): {
  holding: FlowWorkspace['holding']
  task: Task | null
  sessionId: string | null
  workerId: string | null
} {
  if (claim.holder.startsWith('reland:')) {
    return {
      holding: 'landing',
      task: getTask(claim.holder.slice('reland:'.length)),
      sessionId: null,
      workerId: null
    }
  }

  const asTask = getTask(claim.holder)
  if (asTask) return { holding: 'task', task: asTask, sessionId: null, workerId: null }

  const session = getSession(claim.holder)
  if (!session) return { holding: null, task: null, sessionId: null, workerId: null }
  // ⚠️ `runForSession` first — the open run is what this conversation is about *now*. The last run
  // is the fallback for the seconds between a run ending and its claim being released, where the
  // honest answer is still the task that was just being worked on.
  const run = runForSession(session.id) ?? lastRunForSession(session.id)
  return {
    holding: 'session',
    task: run ? getTask(run.taskId) : null,
    sessionId: session.id,
    workerId: session.workerId
  }
}

/** Every workspace of one project's pool, with the ticket ↔ workspace ↔ worker binding on each. */
export function flowWorkspaces(projectId: string): FlowWorkspace[] {
  const resource = getResource(workspacePoolId(projectId))
  if (!resource) return []

  const claims = openClaims(resource.id).filter((c) => c.member)
  const sessions = listSessions().filter((s) => s.purpose === 'work' && !sessionEnded(s.state))
  const allWorkSessions = listSessions(true).filter((s) => s.purpose === 'work')

  // ⛔ Members first, then any claim on a path the pool no longer lists. Dropping the second group
  // would hide a task that is visibly running from the one board that claims to show all of them.
  const extras = claims
    .map((c) => c.member!)
    .filter((member) => !resource.members.some((m) => samePath(m, member)))
  const paths = [...resource.members, ...extras]

  return paths.map((path) => {
    const claim = claims.find((c) => samePath(c.member!, path)) ?? null
    const held = claim
      ? resolveHolder(claim)
      : { holding: null, task: null, sessionId: null, workerId: null }
    const resident = residentSession(sessions, path)
    const lastResident = lastSessionInPath(allWorkSessions, path)
    // ⚠️ The claim's own session wins over whatever else is sitting in the tree; a resident session
    // answers for a claim the *task* holds, which is how an awaiting-human task still names the
    // account it is with. See `ranOn` in tasks.ts for why `assignee` is the last resort.
    const sessionId = held.sessionId ?? resident?.id ?? null
    const workerId =
      held.workerId ??
      resident?.workerId ??
      held.task?.ranOn ??
      (held.task?.assignee && held.task.assignee !== 'human' ? held.task.assignee : null) ??
      lastResident?.workerId ??
      null
    const worker = workerId ? getWorker(workerId) : null

    return {
      path,
      label: shortName(path),
      inPool: resource.members.some((m) => samePath(m, path)),
      holding: held.holding,
      taskId: held.task?.id ?? null,
      taskSeq: held.task?.seq ?? null,
      taskTitle: held.task ? (held.task.titleSummary ?? held.task.title) : null,
      taskStatus: held.task?.status ?? null,
      workerId,
      workerLabel: worker?.label ?? null,
      adapterId: worker?.adapterId ?? null,
      sessionId,
      branch: resident?.currentBranch ?? held.task?.branch ?? lastResident?.currentBranch ?? null,
      claimedAt: claim?.acquiredAt ?? null
    }
  })
}
