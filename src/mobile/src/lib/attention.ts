import type { Approval, Question, Task } from '@shared/tasks'
import { isQuotaGated } from '@renderer/lib/taskview'

/**
 * The Attention list: everything waiting on a person, merged newest-first.
 *
 * Four sources, mirroring the desktop bar (`components/Attention.tsx`): open approvals, open
 * questions, tasks the quota gate holds, and tasks resting at `awaiting_human`. The desktop bar
 * reads oldest-first because a blocked session's cache is going cold; this list reads
 * newest-first — on a phone the latest arrival is what the operator triages from.
 */
export type AttentionItem =
  | { kind: 'approval'; at: number; approval: Approval }
  | { kind: 'question'; at: number; question: Question }
  | { kind: 'quota'; at: number; task: Task }
  | { kind: 'human'; at: number; task: Task }

export function buildAttentionItems(
  approvals: Approval[],
  questions: Question[],
  tasks: Task[],
  now = Date.now()
): AttentionItem[] {
  const items: AttentionItem[] = [
    ...approvals.map((approval) => ({ kind: 'approval' as const, at: approval.askedAt, approval })),
    ...questions.map((question) => ({ kind: 'question' as const, at: question.askedAt, question }))
  ]
  for (const task of tasks) {
    if (task.deletedAt) continue
    if (isQuotaGated(task, now)) {
      items.push({
        kind: 'quota',
        at: task.quotaPreemptWarning ? task.quotaPreemptWarning.preemptAt - 60_000 : task.updatedAt,
        task
      })
    } else if (task.status === 'awaiting_human') {
      items.push({ kind: 'human', at: task.updatedAt, task })
    }
  }
  return items.sort((a, b) => b.at - a.at)
}

/**
 * Which questions get inline buttons. The desktop's rule, unchanged: a `choice` with few short
 * options is answerable where it stands; anything else — `text`, `multi`, a wall of options —
 * needs the thread and the context around it.
 */
export function answerableInline(question: Question): boolean {
  return (
    question.kind === 'choice' &&
    question.options.length > 0 &&
    question.options.length <= 3 &&
    question.options.every((o) => o.label.length <= 30)
  )
}

export type AttentionAction =
  | { type: 'approve'; decision: 'allow' | 'allow_always' | 'deny'; label: string }
  | { type: 'answer'; optionIds: string[]; label: string }
  | { type: 'override'; taskId: string; label: string }
  | { type: 'stop'; taskId: string; label: string }
  | { type: 'resume'; taskId: string; label: string }
  | { type: 'resolve'; taskId: string; label: string }
  | { type: 'open-task'; taskId: string | null; label: string }

/**
 * What one item offers. Every action names an RPC the remote policy allows — a 403 here would be
 * a bug in this list, not something to work around — and `open-task` is `null` where the item
 * belongs to no task, which the card draws disabled rather than hiding.
 */
export function actionsFor(item: AttentionItem): AttentionAction[] {
  switch (item.kind) {
    case 'approval':
      return [
        { type: 'approve', decision: 'allow', label: 'Allow' },
        { type: 'approve', decision: 'allow_always', label: 'Always' },
        { type: 'approve', decision: 'deny', label: 'Deny' }
      ]
    case 'question':
      if (answerableInline(item.question)) {
        return item.question.options.map((o) => ({ type: 'answer' as const, optionIds: [o.id], label: o.label }))
      }
      return [{ type: 'open-task', taskId: item.question.taskId, label: 'Answer…' }]
    case 'quota':
      return [
        { type: 'override', taskId: item.task.id, label: 'Override & Continue' },
        { type: 'stop', taskId: item.task.id, label: 'Stop' },
        { type: 'resume', taskId: item.task.id, label: 'Resume Now' },
        { type: 'open-task', taskId: item.task.id, label: 'Reassign…' }
      ]
    case 'human':
      return [
        { type: 'resolve', taskId: item.task.id, label: 'Resolve' },
        { type: 'open-task', taskId: item.task.id, label: 'Reply…' }
      ]
  }
}

/** One line per item, naming what waits and on which task. */
export function itemSummary(item: AttentionItem): string {
  switch (item.kind) {
    case 'approval':
      return item.approval.summary
    case 'question':
      return (item.question.header ? `${item.question.header} — ` : '') + item.question.question
    case 'quota':
      return `t${item.task.seq}: ${item.task.titleSummary ?? item.task.title}`
    case 'human':
      return `t${item.task.seq}: ${item.task.titleSummary ?? item.task.title}`
  }
}
