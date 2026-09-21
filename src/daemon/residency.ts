import type { Session } from '@shared/protocol.js'
import { cacheHasLapsed, getSession, hasOpenRun } from './sessions.js'
import { lastRunForSession, listTasks, runForSession, runsFor } from './tasks.js'
import { workspaces } from './scheduler.js'

/**
 * Session residency and capacity.
 *
 * ⚠️ **A worker is not a session.** Quota lives on the worker (an account); context lives on the
 * session (a live process). Residency here is a *session* concept — which conversation is sitting on
 * which workspace, and which one costs least to lose — while a reservation is counted per *worker*.
 * Conflating the two makes the scheduler incoherent (AGENTS.md).
 */

/** The exclusive resource one task holds while it is the one talking in a conversation. */
export function sessionLeaseId(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * Has this account got a slot for this task?
 *
 * ⛔ **The session the task would reuse does not count**, because reusing it starts no process.
 * `maxConcurrent` bounds how many agents run at once; a turn sent into a session that is already open
 * adds none. Counting it made a one-slot worker — the default — refuse the single most valuable move
 * the cost model has: a task resting at `awaiting_human` keeps its session warm for the reply, that
 * idle session filled the only slot, and the reply was then held at *"at capacity"* indefinitely.
 *
 * ⚠️ Measured on a real fleet 2026-08-28 while trying to share a conversation, but the bug was never
 * about sharing: the same gate had been silently blocking every warm continuation on a one-slot
 * worker since long before sharing existed, and a one-slot worker is what the app creates by default.
 *
 * ⚠️ Safe because the only session ever passed as `reuse` came from `warmSessionFor`, which returns
 * idle sessions only, and the lease stops two tasks being handed the same one.
 */
export function atCapacity(
  sessions: Session[],
  maxConcurrent: number,
  reuse: Session | null,
  retainedAwaitingHuman = 0
): boolean {
  return slotsInUse(sessions, reuse, retainedAwaitingHuman) >= maxConcurrent
}

/** The same arithmetic `atCapacity` gates on, as a number, so a refusal can say how full it is. */
export function slotsInUse(
  sessions: Session[],
  reuse: Session | null,
  retainedAwaitingHuman = 0
): number {
  const busy = sessions.filter((s) => s.purpose === 'work' && s.id !== reuse?.id).length
  return busy + retainedAwaitingHuman
}

/**
 * Live `work` sessions no run references, by id.
 *
 * A session row and the run serving it normally name each other — dispatch starts every run with
 * its session's id — and both reservation counters below excuse a task whose runs name a live
 * session. When the linkage is missing, the task would be counted once for its live session and
 * once more for its reservation, and a one-slot worker would read `2 / 1` beside a single task
 * (t597). An unclaimed live session on the same worker is that task's process far more often than
 * a second one, so each covers one sessionless running task. Computed once per
 * `retainedReservations` call and shared, so one session never covers two tasks. Parked tasks
 * never consume cover: their hold protects a workspace, not a process, and a stray live session
 * does not invalidate it.
 */
export function unclaimedLiveWorkSessions(sessions: Session[]): Set<string> {
  const unclaimed = new Set<string>()
  for (const session of sessions) {
    if (session.purpose !== 'work' && session.purpose != null) continue
    if (runForSession(session.id) ?? lastRunForSession(session.id)) continue
    unclaimed.add(session.id)
  }
  return unclaimed
}

/**
 * Closed sessions are absent from `sessionsForWorker`, but a task they parked at `awaiting_human`
 * still owns one worker slot. Do not count one whose session is live: that session is already in the
 * ordinary concurrency total.
 */
export function awaitingHumanReservations(workerId: string, sessions: Session[]): number {
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  return listTasks().filter((task) => {
    if (task.status !== 'awaiting_human' || task.ranOn !== workerId) return false
    // ⛔ Reassigned while parked (t597): the reply will run on the new worker, so the old one
    // holds nothing for it any more. Counting it there wedged the old worker at `1 / 1` with no
    // process on it. A task waiting on a person (`human`) or pinned here still holds this slot.
    if (task.assignee && task.assignee !== 'human' && task.assignee !== workerId) return false
    return !runsFor(task.id).some((run) => run.sessionId && liveSessionIds.has(run.sessionId))
  }).length
}

/**
 * Closed sessions are absent from `sessionsForWorker`, but a task that is still running (e.g.
 * completing or landing after its CLI process has exited, such as with one-shot adapters like Codex)
 * still owns one worker slot. Do not count one whose session is live: that session is already in the
 * ordinary concurrency total.
 */
export function runningTaskReservations(
  workerId: string,
  sessions: Session[],
  cover: Set<string> = unclaimedLiveWorkSessions(sessions)
): number {
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  return listTasks().filter((task) => {
    // ⛔ Only tasks actively in flight ('running' or 'assigned') can reserve a running slot.
    // Settled tasks (completed, failed, cancelled) and resting/queued tasks (ready, draft,
    // awaiting_human, paused_user, paused_quota, blocked) are not running and must never reserve a running slot.
    if (task.status !== 'running' && task.status !== 'assigned') return false
    // If the task is actively assigned to another worker, it belongs to that worker, not this one.
    if (task.assignee && task.assignee !== workerId) return false
    const isRunningOnWorker =
      task.assignee === workerId || (!task.assignee && task.ranOn === workerId)
    const hasOpenRunOnWorker = runsFor(task.id).some(
      (run) => run.workerId === workerId && run.endedAt === null && (run.kind === 'work' || !run.kind)
    )
    if (!isRunningOnWorker && !hasOpenRunOnWorker) return false
    if (runsFor(task.id).some((run) => run.workerId === workerId && run.sessionId && liveSessionIds.has(run.sessionId))) return false
    // ⛔ An unclaimed live session covers one sessionless task (t597): the task is demonstrably
    // mid-flight on this worker and the session is demonstrably serving nobody on the books, so
    // counting both would read `2 / 1` for one process. Each session covers one task — it is
    // deleted from the shared set — and an `assigned` task with no run yet is never covered,
    // because nothing has started that the session could belong to.
    if (cover && cover.size > 0 && hasOpenRunOnWorker) {
      const sessionId = cover.values().next().value
      if (sessionId !== undefined) {
        cover.delete(sessionId)
        return false
      }
    }
    return true
  }).length
}

/**
 * Total slots held on this worker by tasks whose sessions are not currently in `sessions`
 * (both tasks parked at `awaiting_human` and tasks still `running` while completing/landing).
 */
export function retainedReservations(workerId: string, sessions: Session[]): number {
  const cover = unclaimedLiveWorkSessions(sessions)
  return awaitingHumanReservations(workerId, sessions) + runningTaskReservations(workerId, sessions, cover)
}


/**
 * Of the conversations sitting on a workspace, which one costs least to lose?
 *
 * ⛔ **A lapsed cache first, always.** Such a session's context is no cheaper to reach than a cold
 * start already, so closing it destroys nothing that had value — and a still-warm session ranked
 * ahead of a lapsed one would be the scheduler throwing away the exact thing it exists to preserve.
 *
 * ⚠️ Among equals, the one idle longest, measured from its **last request** rather than from when it
 * started. A conversation that opened an hour ago and spoke a second ago is the busiest thing here,
 * not the oldest; ranking by `startedAt` would evict it first and reliably pick the wrong session.
 * `startedAt` is the fallback only for a session that has never made a request.
 *
 * Exported for its own tests: the ranking is where the judgement is, and it is worth being able to
 * check it without a pool, a worktree and a process.
 */
export function leastValuableResident(candidates: Session[], now = Date.now()): Session | null {
  const ranked = [...candidates].sort((a, b) => {
    const [al, bl] = [cacheHasLapsed(a, now), cacheHasLapsed(b, now)]
    if (al !== bl) return al ? -1 : 1
    return (a.lastRequestStartedAt ?? a.startedAt) - (b.lastRequestStartedAt ?? b.startedAt)
  })
  return ranked[0] ?? null
}

/**
 * Close the least valuable conversation holding a workspace in this project, so somebody else can
 * have the tree. Returns whether anything was actually freed.
 *
 * ⛔ **Never one with an open run.** A conversation mid-turn is an agent working; evicting it would
 * kill a run to start another, which is not a trade this scheduler is allowed to make on its own.
 *
 * ⚠️ The victim is the one whose prompt cache has already lapsed — its context is no cheaper to
 * reach than a cold start, so it is the one session whose loss costs nothing measurable. Only if
 * none has lapsed does this fall back to the longest idle, and that case is a genuine cost: it is
 * the pool being too small for the work, and the log says so in those words.
 */
export function evictableResidents(projectId: string, kind?: 'worktree' | 'trunk'): Session[] {
  return [...workspaces.entries()]
    .filter(([sessionId, held]) => held.projectId === projectId && !hasOpenRun(sessionId))
    // ⚠️ Closing a conversation in the trunk frees no pool member and the reverse, so an eviction is
    // asked for the kind of tree it is meant to free. Absent asks about both, for the gate's
    // "is anything reclaimable at all".
    .filter(([, held]) => !kind || (held.workspace.kind ?? 'worktree') === kind)

    .map(([sessionId]) => getSession(sessionId))
    .filter((s): s is Session => s !== null)
}
