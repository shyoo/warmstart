import { sessionEnded } from '@shared/protocol.js'
import type { Session } from '@shared/protocol.js'
import type { FlowWorkspace, ResourceClaim, Task, TaskStatus, WorkspaceMode } from '@shared/tasks.js'
import { projectWorkspaceModeChoice } from '@shared/tasks.js'
import { samePath } from './fspath.js'
import { getResource, landResourceId, openClaims, trunkResourceId, workspacePoolId } from './resources.js'
import { getProject, policyFor } from './projects.js'
import { getSession, listSessions } from './sessions.js'
import { getTask, lastRunForSession, runForSession } from './tasks.js'
import { getWorker } from './workers.js'
import { isTaskLanding } from './landing.js'

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

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'cancelled', 'failed'])

function isTaskFinished(task: Task | null | undefined): boolean {
  return !task || TERMINAL_TASK_STATUSES.has(task.status)
}

function isLanding(taskId: string, projectId: string | null): boolean {
  if (isTaskLanding(taskId)) return true
  if (!projectId) return false
  return openClaims(landResourceId(projectId)).some((c) => c.holder === taskId)
}

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
 *  - a **session id** — a live conversation is working in that tree right now, or winding down/releasing;
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
    const task = getTask(claim.holder.slice('reland:'.length))
    if (isTaskFinished(task)) {
      return { holding: null, task: null, sessionId: null, workerId: null }
    }
    return {
      holding: 'landing',
      task,
      sessionId: null,
      workerId: null
    }
  }

  const asTask = getTask(claim.holder)
  if (asTask) {
    if (isTaskFinished(asTask)) {
      return { holding: null, task: null, sessionId: null, workerId: null }
    }
    const holding = isLanding(asTask.id, asTask.projectId) ? 'landing' : 'task'
    return { holding, task: asTask, sessionId: null, workerId: null }
  }

  const session = getSession(claim.holder)
  if (!session) {
    return { holding: null, task: null, sessionId: null, workerId: null }
  }
  // ⚠️ `runForSession` first — the open run is what this conversation is about *now*. The last run
  // is the fallback for the seconds between a run ending and its claim being released, where the
  // honest answer is still the task that was just being worked on.
  const run = runForSession(session.id) ?? lastRunForSession(session.id)
  const task = run ? getTask(run.taskId) : null
  if (isTaskFinished(task)) {
    return { holding: null, task: null, sessionId: session.id, workerId: session.workerId }
  }
  const holding = isLanding(task!.id, task!.projectId)
    ? 'landing'
    : sessionEnded(session.state)
      ? 'releasing'
      : 'session'
  return {
    holding,
    task,
    sessionId: session.id,
    workerId: session.workerId
  }
}

/**
 * Every workspace of one project, with the ticket ↔ workspace ↔ worker binding on each: the trunk
 * first, then the pool.
 *
 * ⭐ **The trunk is a row, for every git project.** A trunk-mode task works there and nowhere else,
 * so a board that drew only `ws1…` hid it; and whether the trunk is free is also what decides when a
 * worktree landing can merge, so the row earns its place on a project with no trunk tasks at all.
 * ⚠️ Labelled with the landing target (`main`), which is what the checkout is for.
 */
export function flowWorkspaces(projectId: string): FlowWorkspace[] {
  const sessions = listSessions().filter((s) => s.purpose === 'work' && !sessionEnded(s.state))
  const allWorkSessions = listSessions(true).filter((s) => s.purpose === 'work')
  const project = getProject(projectId)
  const trunk = project && project.vcs === 'git' ? [trunkRow(project.root, policyFor(project).landingTarget, projectWorkspaceModeChoice(project), projectId, sessions, allWorkSessions)] : []

  const resource = getResource(workspacePoolId(projectId))
  if (!resource) return trunk

  const claims = openClaims(resource.id).filter((c) => c.member)

  // ⛔ Members first, then any claim on a path the pool no longer lists. Dropping the second group
  // would hide a task that is visibly running from the one board that claims to show all of them.
  const extras = claims
    .map((c) => c.member!)
    .filter((member) => !resource.members.some((m) => samePath(m, member)))
  const paths = [...resource.members, ...extras]

  const bound = paths.map((path) => {
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
      kind: 'worktree' as const,
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

  // ⛔ A single task cannot occupy two independent workspaces.
  // If multiple workspaces resolve to the same task, keep only the most authoritative binding
  // (live session over landing over retained task claim, newer claimedAt over older) and
  // demote any duplicate workspace to free so it can take other work.
  const seen = new Map<string, number>()
  for (let i = 0; i < bound.length; i++) {
    const ws = bound[i]!
    if (!ws.taskId) continue
    const prevIdx = seen.get(ws.taskId)
    if (prevIdx === undefined) {
      seen.set(ws.taskId, i)
      continue
    }
    const prev = bound[prevIdx]!
    const rank = (h: FlowWorkspace['holding']): number =>
      h === 'session' ? 4 : h === 'landing' ? 3 : h === 'releasing' ? 2 : h === 'task' ? 1 : 0
    const prevScore = rank(prev.holding) * 1e14 + (prev.claimedAt ?? 0)
    const currScore = rank(ws.holding) * 1e14 + (ws.claimedAt ?? 0)
    const [winnerIdx, loser] = currScore >= prevScore ? [i, prev] : [prevIdx, ws]
    seen.set(ws.taskId, winnerIdx)
    loser.holding = null
    loser.taskId = null
    loser.taskSeq = null
    loser.taskTitle = null
    loser.taskStatus = null
  }

  return [...trunk, ...bound]
}

/**
 * The trunk's row. ⚠️ Reads the claim only — no git, for the reason the header gives — so a trunk
 * dirty with the operator's own edits reads *free* here: nothing of this tool's is in it.
 */
function trunkRow(
  root: string,
  target: string,
  defaultMode: WorkspaceMode,
  projectId: string,
  sessions: Session[],
  allWorkSessions: Session[]
): FlowWorkspace {
  const claim = openClaims(trunkResourceId(projectId))[0] ?? null
  const held = claim ? resolveHolder(claim) : { holding: null, task: null, sessionId: null, workerId: null }
  const resident = held.holding ? residentSession(sessions, root) : null
  const lastResident = lastSessionInPath(allWorkSessions, root)
  const workerId =
    held.workerId ??
    resident?.workerId ??
    held.task?.ranOn ??
    (held.task?.assignee && held.task.assignee !== 'human' ? held.task.assignee : null) ??
    null
  const worker = workerId ? getWorker(workerId) : null
  return {
    path: root,
    label: target,
    kind: 'trunk',
    defaultMode,
    inPool: true,
    holding: held.holding,
    taskId: held.task?.id ?? null,
    taskSeq: held.task?.seq ?? null,
    taskTitle: held.task ? (held.task.titleSummary ?? held.task.title) : null,
    taskStatus: held.task?.status ?? null,
    workerId,
    workerLabel: worker?.label ?? null,
    adapterId: worker?.adapterId ?? null,
    sessionId: held.sessionId ?? resident?.id ?? null,
    branch: resident?.currentBranch ?? lastResident?.currentBranch ?? target,
    claimedAt: claim?.acquiredAt ?? null
  }
}
