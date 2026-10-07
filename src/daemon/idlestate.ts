import type { Task } from '@shared/tasks.js'
import { withLanding } from './landingstate.js'

/**
 * Which `running` tasks have had their turn end with nothing terminal said — the grace window before
 * `runWatchdogs` hands them to a person.
 *
 * ⛔ **In memory, never a `TaskStatus`, for `landingstate.ts`'s reason.** The run is still open and
 * the status is still `running` — that is the contract, and `task_complete` is still the only thing
 * that ends it. What was wrong (t950 ← t946) is that the pane said *working*, with the animation, for
 * as long as that window lasted, while the session's own stream said *Turn finished*. This is the
 * fact the pane was missing, and it dies with the process like the thing it describes.
 *
 * ⚠️ Cleared by the first thing that proves the session is working again — a prompt written into it
 * or a mid-turn stream record (`onSessionBusy`, `sessions.ts`) — never by a timer, so the flag cannot
 * say *idle* about a session that has resumed. Its own leaf module so `events.ts` can read it without
 * importing the turn-end machinery.
 */
const idle = new Map<string, { sessionId: string; at: number }>()

let cleared: (taskId: string) => void = () => {}

/** Told, once, when a task stops being idle for a reason other than the caller's own — so it can be re-broadcast. */
export function onIdleCleared(listener: (taskId: string) => void): void {
  cleared = listener
}

export function markTaskIdle(taskId: string, sessionId: string, at: number): void {
  idle.set(taskId, { sessionId, at })
}

/**
 * The session did something: whichever task it had marked idle is not.
 *
 * ⚠️ `announce: false` for a caller about to change the task's status itself — the hand-over and the
 * session's exit — whose own `task.changed` follows. Announcing first would draw one frame of
 * *working* between *turn ended* and *over to you*.
 */
export function clearIdleForSession(sessionId: string, announce = true): void {
  for (const [taskId, entry] of idle) {
    if (entry.sessionId !== sessionId) continue
    idle.delete(taskId)
    if (announce) cleared(taskId)
  }
}

export function idleSinceOf(taskId: string): number | null {
  return idle.get(taskId)?.at ?? null
}

/**
 * The task as a reader should see it: `idleSince` answered now, and only for a task that is running.
 *
 * ⚠️ Any other status wins over a stale mark: a task that was parked, cancelled or finished a moment
 * ago must not read *turn ended* because this map had not been told yet.
 */
export function withIdle<T extends Task>(task: T): T {
  const at = task.status === 'running' ? idleSinceOf(task.id) : null
  if (at === null) {
    if (task.idleSince === undefined) return task
    const { idleSince: _dropped, ...rest } = task
    return rest as T
  }
  return { ...task, idleSince: at }
}

/** Every transient flag a reader sees, from one place: `landing` and `idleSince`. */
export function withTransient<T extends Task>(task: T): T {
  return withIdle(withLanding(task))
}
