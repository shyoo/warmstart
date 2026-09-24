import type { Task } from '@shared/tasks'

/**
 * Has the task moved on from the status it carried when the composer recorded a send outcome —
 * "Queued — same thread…" or "Delivered into the running turn."?
 *
 * ⛔ **t673.** The hint used to stay on screen forever: a requeue resolves into `running`/`assigned`
 * on a scheduler tick minutes later, off in daemon state the composer never watches on its own, and
 * nothing cleared a message answering a question the status itself had already moved past. A task
 * still sitting on the status it was at when the hint was recorded has not yet proven the hint
 * wrong, so it stays; the moment the status moves, the hint is stale.
 */
export function outcomeHintStale(status: Task['status'], recordedStatus: Task['status'] | null): boolean {
  return recordedStatus !== null && status !== recordedStatus
}
