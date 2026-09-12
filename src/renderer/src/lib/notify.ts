/**
 * When a task's movement is worth interrupting somebody for.
 *
 * ⛔ **Only a *transition*, never a state.** The first time this process sees a task it says
 * nothing, whatever state that task is in. Otherwise opening the app — or reconnecting to a daemon
 * that has been working for an hour — fires one notification per resting task, and a notifier that
 * cries at startup is one the person turns off within a day, which costs the feature rather than
 * the noise.
 *
 * ⛔ **Three events, not every change.** A task moves through `scheduled`, `assigned`, `running`
 * and back many times per piece of work, and none of those wants a person. What wants a person is:
 * it is asking you something, it is done, or it broke.
 *
 * ⚠️ Pure and in `lib/`, so the rule can be pinned without a window — see `notify.test.ts`.
 */
import type { Task, TaskStatus } from '@shared/tasks'

export type NotifyKind = 'wants-you' | 'finished' | 'failed'

export interface Notifiable {
  kind: NotifyKind
  title: string
  body: string
  taskId: string
}

/** The three statuses that end a person's ability to ignore the app. */
const NOTIFY_ON: Record<string, NotifyKind> = {
  awaiting_human: 'wants-you',
  completed: 'finished',
  failed: 'failed'
}

const HEADLINE: Record<NotifyKind, string> = {
  'wants-you': 'Wants your decision',
  finished: 'Task finished',
  failed: 'Task failed'
}

/**
 * ⚠️ A title is text somebody or some agent wrote, and it goes into an OS notification. It is not
 * escaped here because nothing on this path parses it — `Notification` takes strings — but it is
 * cut, because a notification with a 4,000-character body is a wall on somebody's desktop.
 */
const MAX_BODY = 120

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_BODY ? flat : `${flat.slice(0, MAX_BODY - 1)}…`
}

/**
 * Should this status change raise a notification?
 *
 * `before` is `undefined` when this process has not seen the task before, which is never a
 * notification — see the note at the top of this file.
 */
export function notifiableTransition(before: TaskStatus | undefined, task: Task): Notifiable | null {
  if (before === undefined) return null
  if (before === task.status) return null
  const kind = NOTIFY_ON[task.status]
  if (!kind) return null
  return {
    kind,
    title: HEADLINE[kind],
    body: shorten(task.titleSummary || task.title),
    taskId: task.id
  }
}

/**
 * The statuses worth remembering between events.
 *
 * ⚠️ Exported so the caller's map can be pruned rather than growing for the life of the window: a
 * fleet that has run for a week has thousands of settled tasks and only the live ones can still
 * transition into something worth saying.
 */
export function worthTracking(status: TaskStatus): boolean {
  return status !== 'draft' && status !== 'cancelled'
}
