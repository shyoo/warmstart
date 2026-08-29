import type { TaskStatus } from '@shared/tasks'

/**
 * Is there a running process to look through the window at?
 *
 * ⛔ **The status decides this, never the tail.** The obvious version — *show the live bubble if
 * there are any lines* — is wrong, and was shipped: the tail is only cleared when the **next**
 * attempt starts (`reset` on `task.activity`), never when a run ends. So a completed task went on
 * drawing a live bubble beside a status reading `completed`, indefinitely, captioned with a promise
 * about a run that had already finished.
 *
 * ⚠️ Nothing is lost by hiding it. What the agent actually recorded is a message in the thread; the
 * tail is a peephole onto a process, and when no process is running there is nothing to see through
 * it.
 *
 * `assigned` counts as live: the workspace is being claimed and the prepare hook is running, so the
 * agent is about to speak and an empty bubble is the honest state to be in.
 */
export function showsLiveOutput(status: TaskStatus): boolean {
  return status === 'running' || status === 'assigned'
}
