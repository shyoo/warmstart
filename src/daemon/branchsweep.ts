import type { Project, Task } from '@shared/tasks.js'
import { errorMessage } from '@shared/errors.js'
import { emit } from './events.js'
import { log } from './log.js'
import { listProjects, policyFor } from './projects.js'
import { addMessage, getTask, listTasks } from './tasks.js'
import { mergedDeliveryFor, openDeliveryFor } from './deliveries.js'
import { stashesFrom } from './landing.js'
import { retireStrandedBranch, taskBranches } from './worktrees.js'

/**
 * Retire the empty branches finished tasks leave, without waiting for a click (t977).
 *
 * ⭐ **A *branch left behind* row asks the operator a question that has only one answer.** The
 * branch carries nothing the trunk lacks, its task is over, and **Retire it** re-derives that proof
 * and deletes the name. Measured 2026-10-07: t976 was a reclaim that concluded nothing needed landing,
 * Complete's own retirement lost a race with the workspace park (`releaseWorkspaceOf`), and the empty
 * `warmstart/t976-…` sat under Loose ends until somebody pressed the button the proof already licensed.
 *
 * ⛔ **Names, never work.** Each branch must pass, at the moment of deletion:
 * - its task is `completed` or `cancelled`, re-read just before acting. `paused_user` and `draft` resume
 *   into their branch (`cancel.ts`); `failed` is left for a person, who may retry it.
 * - nothing on it is missing from the trunk — zero commits only on it, or content the trunk already
 *   holds under other SHAs (`contentLanded`, the licence **Retire it** accepts since t948);
 * - no stash was taken off it, so the stashed row still has a branch to name;
 * - no pull request is recorded for it — those are the delivery sweep's (`deliveries.ts`);
 * - and `retireStrandedBranch` agrees: it measures again and steps off only an idle, unclaimed, clean
 *   pool member. Anything else holding the branch is somebody working, and the branch is kept.
 *
 * ⚠️ A branch kept is logged once per distinct reason, not on every pass. A *not landed* branch never
 * reaches this function: real commits are deleted only by the operator's **Delete it**.
 */
export async function retireSettledBranches(): Promise<{ retired: string[] }> {
  if (sweeping) return { retired: [] }
  sweeping = true
  const retired: string[] = []
  try {
    for (const project of listProjects()) {
      if (project.vcs !== 'git') continue
      try {
        const done = await retireIn(project)
        if (done.length > 0) {
          retired.push(...done)
          emit({ type: 'project.changed', project })
        }
      } catch (err) {
        log.warn(`could not sweep the finished branches of ${project.name}: ${errorMessage(err)}`)
      }
    }
    return { retired }
  } finally {
    sweeping = false
  }
}

let sweeping = false

/** The last reason each branch was kept for, so a refusal is logged when it changes and not every pass. */
const keptBecause = new Map<string, string>()

const SETTLED: ReadonlySet<Task['status']> = new Set<Task['status']>(['completed', 'cancelled'])

async function retireIn(project: Project): Promise<string[]> {
  const target = policyFor(project).landingTarget
  const settled = new Map(
    listTasks({ projectId: project.id })
      .filter((task) => SETTLED.has(task.status))
      .map((task) => [task.seq, task])
  )
  const retired: string[] = []
  for (const branch of await taskBranches(project, target)) {
    const task = branch.taskSeq === null ? undefined : settled.get(branch.taskSeq)
    if (!task) continue
    // ⚠️ `-1` is "git could not measure", never zero; and a branch with real commits is not ours.
    if (branch.ahead < 0 || (branch.ahead > 0 && !branch.contentLanded)) continue
    if (mergedDeliveryFor(project.id, branch.branch) || openDeliveryFor(project.id, branch.branch)) continue
    const key = `${project.id}:${branch.branch}`
    const keep = (why: string): void => {
      if (keptBecause.get(key) === why) return
      keptBecause.set(key, why)
      log.info(`kept ${branch.branch} of finished t${task.seq}: ${why}`)
    }
    const stashes = await stashesFrom(project.root, branch.branch)
    if (stashes > 0) {
      keep(`${stashes} stash(es) were taken off it`)
      continue
    }
    // ⛔ Re-read: a reply may have woken the task since the list above was taken.
    const now = getTask(task.id)
    if (!now || !SETTLED.has(now.status) || now.deletedAt) continue
    const verdict = await retireStrandedBranch(project, branch.branch, target)
    if (!verdict.deleted) {
      keep(verdict.reason ?? 'it could not be retired')
      continue
    }
    keptBecause.delete(key)
    retired.push(branch.branch)
    addMessage(task.id, 'system', `Deleted the empty branch \`${branch.branch}\``, null, [], {
      detail:
        (branch.ahead > 0
          ? `Every commit on \`${branch.branch}\` is already on \`${target}\` under a different SHA`
          : `\`${branch.branch}\` held no commit \`${target}\` does not already have`) +
        ', no stash was taken off it and no workspace was using it, so nothing was lost. ' +
        `Replying to this task starts a fresh branch from \`${target}\` as it stands then.`
    })
  }
  return retired
}
