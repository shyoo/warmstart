import type { Task } from '@shared/tasks.js'

/**
 * Which tasks are inside `landTask` right now: rebasing, running the project's checks, merging.
 *
 * ⛔ **In memory, never a `TaskStatus`.** A landing is a stretch of one process's work, not a place
 * in the DAG: nothing admits, cancels or retries a task *because* it is landing, and a status written
 * to the row would outlive a daemon that died mid-merge and go on saying `landing` about a task
 * nothing is landing. The set dies with the process, which is the truth about what it described.
 *
 * ⚠️ Its own module so `events.ts` can read it without importing the landing machinery. Every
 * `task.changed` goes out with the flag set from here (t353): before that only the two emits inside
 * `landTask` carried it, so the first `setStatus` during a landing broadcast a task without it and
 * the Tasks table and thread dropped back to `running` while Flow still said landing.
 */
const active = new Set<string>()

export function beginLanding(taskId: string): void {
  active.add(taskId)
}

export function endLanding(taskId: string): void {
  active.delete(taskId)
}

/** Whether a task is currently executing inside `landTask`. */
export function isTaskLanding(taskId: string): boolean {
  return active.has(taskId)
}

/** The task as a reader should see it: with `landing` answered now, not when the row was read. */
export function withLanding<T extends Task>(task: T): T {
  return { ...task, landing: active.has(task.id) }
}
