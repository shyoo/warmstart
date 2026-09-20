import {
  isMultiSelectQuestion,
  type FinishPolicy,
  type PendingWork,
  type Question,
  type Task,
  type WorkspaceMode
} from '@shared/tasks'
import { canRelandTask, isQuotaGated, resolveRetryCauses } from '@renderer/lib/taskview'
import {
  COMMIT_FALLBACK,
  commitLevelsForMode,
  defaultLevel,
  effectiveWorkspaceMode,
  settleControls
} from '@renderer/lib/finishlevel'

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

/** Every way a person can settle or redirect a task from the phone detail page. */
export type TaskDecision = 'override' | 'retry' | 'reland' | 'resume' | 'reassign' | 'resolve' | 'commit'

/**
 * What one task offers, in the order it is drawn.
 *
 * ⛔ Read off the task, never off what was clicked, and every entry names an RPC the remote
 * allowlist permits — a 403 here would be a bug in this list, and `parity.test.ts` holds it to
 * the map. `landing_queued` is a hold the tick ends by itself (`retryQueuedLandings`), so it is
 * not somebody's job and gets no Reassign; a `running` task cannot be marked done without
 * stopping it first.
 *
 * ⛔ No Stop here, on purpose: the detail page keeps one-tap buttons for answers, and stopping a
 * live run from a phone is the easiest tap to make by accident. The desktop keeps it; the phone
 * asks for the run to be wound down from there instead.
 *
 * ⚠️ `pending` is the `task.pendingWork` read, passed through rather than re-read: the Commit
 * rule below is desktop `settleControls` bit for bit (conversation kind, something uncommitted or
 * an unreadable tree), so a `null` — not yet read — offers nothing, exactly as over there.
 */
export function decisionsFor(task: Task, now = Date.now(), pending?: PendingWork | null): TaskDecision[] {
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
    if (settleControls(task.kind === 'conversation', pending ?? null).commit) out.push('commit')
  }
  return out
}

/**
 * The level the phone's Commit press sends: the same default the desktop menu opens on — the
 * task's own level, else the project's, else the quiet `commit-only` fallback — restricted to the
 * levels Commit can offer in this task's workspace mode. Same functions, so the two menus cannot
 * disagree about what "commit" means.
 */
export function commitLevelFor(
  task: Pick<Task, 'finishPolicy' | 'workspaceMode'>,
  inheritedFinish: { policy: FinishPolicy } | null | undefined,
  inheritedMode: WorkspaceMode | undefined
): FinishPolicy {
  const mode = effectiveWorkspaceMode(task.workspaceMode, inheritedMode ?? 'worktree')
  return defaultLevel(task.finishPolicy, inheritedFinish?.policy, commitLevelsForMode(mode), COMMIT_FALLBACK)
}
