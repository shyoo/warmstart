import type { DaemonEvent } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'

/**
 * What is worth waking someone for.
 *
 * ⛔ Deliberately tiny, and it should stay that way. A notification is the one thing this app does
 * that interrupts a person who is not looking at it, so the bar is *only* things that are stuck
 * until a human acts: a question, an approval, a task resting at `awaiting_human`, and the quota
 * gate. Progress is not an alert — that is what opening the app is for.
 *
 * ⚠️ The quota rule here is **not** the renderer's `isQuotaGated` and must not drift into being a
 * copy of it. That predicate answers "should this row be drawn as gated", which includes states a
 * person has already seen and dealt with. This one answers "has this task just stopped in a way
 * only a person can restart", which is the narrower question a phone buzzing at midnight is asking.
 */
export interface Alert {
  /**
   * What makes two alerts the same alert. ⚠️ Includes the state, not just the task — a task that
   * goes gated, is released, and goes gated again is worth saying twice.
   */
  key: string
  title: string
  body: string
  /** The task the phone should open. `null` where the alert belongs to no task. */
  taskId: string | null
}

/** ⚠️ Truncated hard: a notification is a line on a lock screen, not a place to read a prompt. */
function line(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

const name = (task: Pick<Task, 'seq' | 'title' | 'titleSummary'>): string =>
  `t${task.seq}: ${line(task.titleSummary ?? task.title, 60)}`

export function alertFor(event: DaemonEvent): Alert | null {
  switch (event.type) {
    case 'question.opened':
      return {
        key: `question:${event.question.id}`,
        title: 'A question needs you',
        body: line((event.question.header ? `${event.question.header} — ` : '') + event.question.question),
        taskId: event.question.taskId
      }
    case 'approval.opened':
      return {
        key: `approval:${event.approval.id}`,
        title: 'Approval needed',
        body: line(event.approval.summary),
        taskId: event.approval.taskId
      }
    case 'task.changed': {
      const task = event.task
      if (task.deletedAt) return null
      if (task.status === 'awaiting_human') {
        return { key: `human:${task.id}`, title: 'Waiting on you', body: name(task), taskId: task.id }
      }
      // An override already in force means a person has answered this gate; do not ask again.
      if (task.quotaOverrideUntil !== null && task.quotaOverrideUntil > Date.now()) return null
      if (task.status === 'paused_quota') {
        return { key: `quota:${task.id}`, title: 'Held by the quota gate', body: name(task), taskId: task.id }
      }
      if (task.status === 'running' && task.quotaPreemptWarning !== null) {
        return { key: `preempt:${task.id}`, title: 'About to be preempted', body: name(task), taskId: task.id }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Which alerts actually go out.
 *
 * ⛔ `task.changed` fires on every field of every task, so the same "held by the quota gate" arrives
 * many times a minute while nothing about it has changed. Without this the phone is unusable within
 * an hour, and the operator turns notifications off — which costs more than never having sent any.
 */
export class AlertGate {
  private readonly sent = new Map<string, number>()

  constructor(private readonly windowMs = 10 * 60_000) {}

  /** True the first time a key is seen, and again only once its window has passed. */
  admit(key: string, now = Date.now()): boolean {
    const last = this.sent.get(key)
    if (last !== undefined && now - last < this.windowMs) return false
    this.sent.set(key, now)
    // Bounded by the same window it enforces: nothing older can suppress anything.
    for (const [seen, at] of this.sent) if (now - at >= this.windowMs) this.sent.delete(seen)
    return true
  }
}
