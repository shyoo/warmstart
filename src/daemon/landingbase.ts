import type { FinishPolicy, LandingStrategyId, Project, Task } from '@shared/tasks.js'
import { resolveWorkspaceMode } from '@shared/tasks.js'
import { landingTargetFor, policyFor } from './projects.js'

/**
 * One answer to "which ref is this project's trunk, really".
 *
 * ⛔ **This module exists to keep that answer from being copied.** `landing.ts` owns the strategies
 * and `worktrees.ts` owns the workspaces, and neither may import the other — `landing.ts` already
 * reads `landedRef` from `worktrees.ts`, so the arrow only goes one way. Left to themselves the two
 * files each grew their own reading of the trunk, and the disagreement is not academic:
 *
 * ⭐ Measured on this repository, 2026-09-04: `local main` was **41 commits ahead of
 * `origin/main`**, because the project's finish policy is `commit-and-merge` — which merges into
 * the *local* trunk and never pushes. `baseRef` cut every new task branch from `origin/main`, 41
 * commits back, while `landTask` rebased onto local `main`. So a task started with nothing else
 * running, touching a file nobody had touched, still had to rebase 41 commits of unrelated history
 * to land, and routinely conflicted. Two definitions of the trunk, and the stale one won.
 *
 * Branch off exactly what the landing will rebase onto and that whole class of conflict disappears:
 * the rebase at the end is a no-op for work nobody else touched.
 */

/**
 * Which strategy a resolved policy runs.
 *
 * ⛔ The policy is the authority. `custom` is the one that falls through to the project's own
 * `landing.strategy`, because a custom policy is an instruction to the agent and the tool is only
 * tidying up behind it.
 */
const FOR_POLICY: Partial<Record<FinishPolicy, LandingStrategyId>> = {
  'commit-and-verify': 'verify-only',
  'commit-and-merge': 'merge-local',
  'commit-and-push': 'auto-land',
  'pull-request': 'pull-request',
  'commit-only': 'leave-branch',
  'await-human': 'leave-branch',
  // Report-only work lands nowhere, but it must read the operator's current local trunk. On t385
  // falling through to an auto-land project strategy cut the seat from origin/main, six commits
  // behind local main and before debate.ts existed.
  'report-only': 'merge-local'
}

/** The strategy id a resolved policy runs, without constructing the strategy. */
export function landingStrategyIdFor(
  project: Project,
  policy?: FinishPolicy,
  task?: (Pick<Task, 'landingTarget'> & Partial<Pick<Task, 'workspaceMode'>>) | null
): LandingStrategyId {
  // ⛔ From the task's workspace, which is data: a trunk task's work is on the target already, so
  // every level that would move it verifies (and pushes) in place instead. The levels that move nothing
  // keep their own strategy, and `custom` and `report-only` never reach a landing in the trunk.
  if (
    task?.workspaceMode !== undefined &&
    resolveWorkspaceMode({ workspaceMode: task.workspaceMode }, project).mode === 'trunk' &&
    (policy === 'commit-and-verify' || policy === 'commit-and-merge' || policy === 'commit-and-push')
  ) {
    return 'trunk'
  }
  const id = FOR_POLICY[policy as FinishPolicy] ?? policyFor(project).landingStrategy
  if (id === 'merge-local' && landingTargetFor(task, project) !== policyFor(project).landingTarget) {
    return 'merge-branch'
  }
  return id
}

/**
 * The ref a landing will actually rebase onto.
 *
 * ⛔ **One answer, because two of them was the bug.** `merge-local` rebases onto the *local* target
 * and says so in its own comment — *"never `origin/<target>`; rebasing onto the remote would
 * quietly make this policy depend on a fetch, which is the thing it exists to avoid"*. `auto-land`
 * rebases onto `origin/<target>`. `readMergeability` had its own third copy of the rule and always
 * preferred the remote, so on the default policy the pre-flight check answered about a **different
 * base** than the one used.
 *
 * ⭐ Measured on t59, 2026-08-30, with a trunk two commits ahead of its remote:
 * `merge-tree origin/main HEAD` said **clean**, `merge-tree main HEAD` said **conflict**.
 * `decideFinish` was told clean, chose `land`, and `git rebase main` then failed inside `landTask` —
 * so `resolve-conflict`, the one verdict that hands a conflict back to the agent that is still
 * there, was passed two branches earlier. The task dead-ended at `awaiting_human`, which is exactly
 * the failure that verdict was written to prevent.
 *
 * ⚠️ Callers still do their own fetch. This decides the name only, so that asking what the base is
 * cannot have the side effect of changing what it points at.
 */
export function landingBaseFor(
  project: Project,
  policy: FinishPolicy | undefined,
  remote: boolean,
  task?: (Pick<Task, 'landingTarget'> & Partial<Pick<Task, 'workspaceMode'>>) | null
): string {
  const target = landingTargetFor(task, project)
  const id = landingStrategyIdFor(project, policy, task)
  if (id === 'merge-local' || id === 'merge-branch' || id === 'trunk') return target
  return remote ? `origin/${target}` : target
}
