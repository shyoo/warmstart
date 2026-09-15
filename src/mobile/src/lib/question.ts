import { isMultiSelectQuestion, type Question, type Task } from '@shared/tasks'
import { canRelandTask, isQuotaGated, resolveRetryCauses } from '@renderer/lib/taskview'

/**
 * The rules behind the phone's answer card and its decision row, kept out of the components so
 * they can be pinned by a test rather than by hand on a phone.
 *
 * ⛔ **A question is not an approval and the phone must not flatten it into one.** The Attention
 * list can answer a short closed choice where it stands; everything else — a `text` question, a
 * `multi`, an option whose `detail` is the part that makes it answerable — belongs on the task,
 * with the thread around it. That is what `TaskDetailScreen` draws.
 */

/** The open ones, newest last, in the order the thread reads them. */
export function openQuestions(questions: Question[]): Question[] {
  return questions.filter((question) => question.answeredAt === null)
}

/**
 * Whether the card opens with checkboxes.
 *
 * ⚠️ `kind` is the declaration and is trusted first, but Claude Code's own `AskUserQuestion`
 * routinely asks for several answers in prose while sending `choice` — `isMultiSelectQuestion`
 * is the same recovery the desktop applies, and the operator can still toggle it either way.
 */
export function startsMulti(question: Question): boolean {
  if (question.kind === 'multi') return true
  return isMultiSelectQuestion(question.question, question.options, question.header ?? undefined)
}

/**
 * ⛔ Nothing chosen and nothing typed is not an answer. The agent is waiting on content, and an
 * empty submission would reach it as "the operator gave no answer" — which is what parking already
 * says, more honestly, without anybody having pressed a button.
 */
export function answerIsEmpty(optionIds: string[], text: string): boolean {
  return optionIds.length === 0 && text.trim().length === 0
}

/** Every way a person can settle or redirect a task from the phone. */
export type TaskDecision = 'override' | 'retry' | 'reland' | 'resume' | 'reassign' | 'resolve' | 'stop'

/**
 * What one task offers, in the order it is drawn.
 *
 * ⛔ Read off the task, never off what was clicked, and every entry names an RPC the remote
 * allowlist permits — a 403 here would be a bug in this list. `landing_queued` is a hold the tick
 * ends by itself (`retryQueuedLandings`), so it is not somebody's job and gets no Reassign; a
 * `running` task cannot be marked done without stopping it first.
 */
export function decisionsFor(task: Task, now = Date.now()): TaskDecision[] {
  if (task.deletedAt) return []
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'cancelling') return []
  const out: TaskDecision[] = []
  if (isQuotaGated(task, now)) out.push('override')
  if (resolveRetryCauses(task).length > 0) out.push('retry')
  if (canRelandTask(task)) out.push('reland')
  if (task.status === 'paused_quota' || task.status === 'paused_user') out.push('resume')
  if (task.status !== 'landing_queued') {
    out.push('reassign')
    if (task.status !== 'running') out.push('resolve')
  }
  if (task.status !== 'paused_user') out.push('stop')
  return out
}
