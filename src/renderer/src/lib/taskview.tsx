import type { Task } from '@shared/tasks'
import type { FleetEntry } from './daemon'
import { duration } from './format'

/**
 * How a task is drawn, shared by the list and the thread.
 *
 * ⛔ **One definition, two screens.** These used to be private to `Tasks.tsx`, which was fine while
 * the table and the detail pane were the same file. They are not any more — the thread is its own
 * route now — and a status colour or a worker name that differed between the row you clicked and the
 * page it opened would be the kind of discrepancy an operator spends ten minutes not trusting.
 */

export const STATUS_TONE: Record<string, string> = {
  running: 'state-running',
  assigned: 'state-running',
  ready: 'state-ok',
  completed: 'state-ok',
  failed: 'state-danger',
  awaiting_human: 'state-human',
  blocked: 'state-idle',
  scheduled: 'state-idle',
  draft: 'state-idle',
  paused_user: 'state-warn',
  paused_quota: 'state-warn',
  cancelling: 'state-warn',
  cancelled: 'state-idle'
}

/**
 * What a status is called where a person can see it.
 *
 * ⛔ Renamed here, not in the domain. `assigned` means something precise to the scheduler and to
 * cancel.ts, and changing it there to suit a table would be the tail wagging the dog. But it is the
 * state a task is in while a workspace is being claimed, a branch checked out and the project's
 * prepare hook run — which is *dispatching*, and is the part of the wait that most needs a name.
 */
export const STATUS_LABEL: Record<string, string> = { assigned: 'dispatching' }

/**
 * The same rename, asked per task, because one status covers two situations a person tells apart.
 *
 * ⛔ Still not a status. `setHoldReason` in tasks.ts argues the case: the task really is `ready` -
 * the scheduler would dispatch it this second if a worker could take it - and inventing a domain
 * status for "ready but nothing free" would put a lie in the DAG to paper over a gap in the UI. So
 * the *word* changes here and the DAG does not.
 *
 * ⚠️ Driven by `holdReason` rather than by counting workers, because the scheduler has already done
 * that arithmetic and written down its answer. A renderer that re-derived "is anything free?" would
 * be a second opinion on a question with an authoritative one, and the two would disagree the first
 * time a gate the UI does not know about (quota, capability, a missing baseline) held a task back.
 * ⭐ Measured 2026-08-29: t22 sat at `ready` for seven minutes with `Antigravity at capacity`
 * written on it, and read as a task waiting on the operator to press something.
 */
export function statusLabel(task: Pick<Task, 'status' | 'holdReason'>): string {
  if (task.status === 'ready' && task.holdReason) return 'queued'
  return STATUS_LABEL[task.status] ?? task.status
}

/**
 * Statuses where something is happening and the next change arrives on its own.
 *
 * ⚠️ `ready` is in here, and that is the whole point of the list. A freshly filed task sits at
 * `ready` for up to one scheduler tick before anything moves, and rendered as a flat word beside
 * `completed` and `failed` it reads as a resting state — as though the operator were the one being
 * waited on. They are not: it is queued, and the dots say so.
 */
export const IN_FLIGHT = new Set(['ready', 'scheduled', 'assigned', 'running', 'cancelling'])

export const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota'
])

/** Three dots that say the fleet is doing something, for a row whose next event arrives by itself. */
export function Working(): React.JSX.Element {
  return (
    <span className="working" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * Which **account** this task is on, or was on.
 *
 * ⛔ Never "you". The column exists so that which account is spending on a task is visible without a
 * click — that is what made a misroute findable at all — and it used to be blanked by the very thing
 * it was there to survive: nine hand-off sites set `assignee` to `human` the moment a task started
 * waiting on a person, so a task ClaudeSecond had run rendered as worked on by *you*, and stayed
 * that way after it was marked done. A person answering a question did not do the work and did not
 * pay for it.
 *
 * ⚠️ `ranOn` first, `assignee` only as the before-anything-ran case: a task assigned a moment ago has
 * an account and no runs yet, which is a real state and reads as one. Who is being waited on is the
 * *status*, and it is said there.
 */
export function assigneeLabel(task: Task, fleet: FleetEntry[]): string {
  const account =
    task.ranOn ?? (task.assignee === 'human' || task.assignee === 'controller' ? null : task.assignee)
  if (!account) return task.assignee === 'controller' ? 'controller' : '—'
  return fleet.find((f) => f.worker.id === account)?.worker.label ?? account.slice(0, 8)
}

/**
 * How long this task has been worked on, or was worked on.
 *
 * ⛔ Measured from the first **run**, not from `createdAt`. When somebody typed a task in is not how
 * long it took; a task filed on Monday and dispatched on Wednesday did not take two days. A task
 * that has never run has no duration, and says so rather than showing zero.
 */
export function elapsed(task: Task, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration((task.lastRunEndedAt ?? now) - task.firstRunAt)
}
