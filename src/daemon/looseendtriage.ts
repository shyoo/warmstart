import type { LooseEnd, Task } from '@shared/tasks.js'
import { TERMINAL_STATUSES } from '@shared/tasks.js'

/**
 * **Let an agent handle all of them** — the bulk answer to the Loose ends panel (t1282).
 *
 * ⚠️ One click per row stopped scaling: the operator had dozens of rows, and every **Land it** /
 * **Delete it** is a judgement that needs the branch read first. This files *one* task per project
 * that carries every open row the operator was looking at, and asks an agent to make that judgement
 * per item: merge it into its own branch (so it lands when the task lands), delete it, or leave it.
 *
 * ⛔ The daemon still decides nothing here. It files a task — exactly what **Make a task** does for
 * one row — and the confirmed click is the operator delegating the decision, including deletion, to
 * an agent whose reasoning is on the thread and whose every deletion names a SHA that restores it.
 */

/** The title prefix that marks a triage task, so a second click does not file a rival one. */
export const TRIAGE_TITLE_PREFIX = 'Handle the open loose ends in '

export function triageTitle(projectName: string, count: number): string {
  return `${TRIAGE_TITLE_PREFIX}${projectName} (${count} item${count === 1 ? '' : 's'})`
}

/** An open triage task for this project, if one exists. Two at once would merge the same branches. */
export function openTriageTask(tasks: readonly Task[], projectId: string): Task | null {
  return (
    tasks.find(
      (t) =>
        t.projectId === projectId &&
        !TERMINAL_STATUSES.has(t.status) &&
        t.title.startsWith(TRIAGE_TITLE_PREFIX)
    ) ?? null
  )
}

export interface TriageGroup {
  projectId: string
  projectName: string
  ends: LooseEnd[]
}

/**
 * Which rows go to which project's task, from a *fresh* scan.
 *
 * ⛔ Only rows the operator was shown (`ids`) and that still exist now: the panel may be minutes old,
 * and a row that resolved in between must not reach an agent as something to act on.
 */
export function triageGroups(fresh: readonly LooseEnd[], ids: readonly string[]): TriageGroup[] {
  const wanted = new Set(ids)
  const groups = new Map<string, TriageGroup>()
  for (const end of fresh) {
    if (!wanted.has(end.id)) continue
    let group = groups.get(end.projectId)
    if (!group) {
      group = { projectId: end.projectId, projectName: end.projectName, ends: [] }
      groups.set(end.projectId, group)
    }
    group.ends.push(end)
  }
  return [...groups.values()]
}

const KIND: Record<LooseEnd['kind'], string> = {
  uncommitted: 'uncommitted',
  unlanded: 'not landed',
  stash: 'stashed',
  stranded: 'branch left behind',
  merged: 'merged, branch left'
}

function describe(end: LooseEnd, index: number): string {
  const head = [`${index + 1}. [${KIND[end.kind]}]`]
  if (end.branch) head.push(`branch \`${end.branch}\``)
  if (end.taskSeq !== null) head.push(`(t${end.taskSeq})`)
  const lines = [`${head.join(' ')} — ${end.summary}`, `   workspace: ${end.workspacePath}`]
  if (end.url) lines.push(`   pull request: ${end.url}`)
  return lines.join('\n')
}

/** The instruction the triage agent works from. Pure, so it is tested as text. */
export function triagePrompt(group: TriageGroup, target: string, scannedAt: Date): string {
  return [
    `The operator asked you to go through every open loose end in ${group.projectName} and decide, ` +
      'item by item, what happens to it. They handed all of them over with one click instead of ' +
      'deciding each row, so the judgement is yours: make it carefully, and make it per item.',
    '',
    `Items, as scanned at ${scannedAt.toISOString()} (the landing target is \`${target}\`):`,
    '',
    ...group.ends.map(describe),
    '',
    '## How to decide',
    '',
    'Read before you decide. For a branch: its task’s record (`task_read` with the t-number), ' +
      `\`git log --oneline ${target}..<branch>\` and \`git diff ${target}...<branch>\`. An item may ` +
      'already be gone — re-check it exists before acting. Then do exactly one of:',
    '',
    '- **Land it** — the work is complete, correct, still wanted, and fits the current trunk. Merge ' +
      'it into your own task branch with `git merge --no-ff <branch>`, resolve any conflict, and ' +
      'confirm the project’s checks pass. Your branch carries it to the trunk when you finish. ' +
      '⛔ Keep those merge commits; do not squash them into your own, because the original commits ' +
      'reaching the trunk is what clears their rows.',
    '- **Delete it** — superseded (the trunk already does this another way), abandoned, broken ' +
      'beyond a reasonable fix, or the task’s thread says it was not wanted. Record the tip first ' +
      '(`git rev-parse <branch>`), then `git branch -D <branch>`. If git refuses because a worktree ' +
      'has it checked out, leave it and say so.',
    '- **Leave it** for the person — when you cannot tell: partial work you cannot account for, ' +
      'something that needs a product decision, anything you would be guessing about. Leaving is ' +
      'always allowed. Deleting work you cannot account for is not.',
    '',
    'By kind:',
    '',
    '- **branch left behind** and **merged, branch left** hold nothing the trunk lacks. Confirm that ' +
      `\`git log ${target}..<branch>\` shows nothing the trunk does not already carry (or that the ` +
      'pull request merged), then delete the name.',
    '- **stashed** — list with `git stash list --format="%H %gs"`, read with `git stash show -p ' +
      '<sha>`. To keep it, `git stash apply <sha>` on your branch and commit. Either way, drop it ' +
      'only by re-finding its `stash@{n}` from the SHA immediately before `git stash drop`: the ' +
      'stash stack is shared with every worktree and other sessions push and pop it.',
    '- **uncommitted** — files in another pooled workspace. Read them with `git -C <workspace> ' +
      'status` and `diff`. To keep them, carry the change into your own branch and commit it here. ' +
      '⛔ Never reset, clean, or delete another workspace’s files; that is the person’s call.',
    '',
    'Change nothing beyond what merging and conflict resolution need. Finish with a list of every ' +
      'item: what you did and why, and for each deleted branch or dropped stash its SHA, so it can ' +
      'be restored with `git branch <name> <sha>`. Put that list in your final message before ' +
      '`task_complete`. If you merged nothing, there is nothing to land, and that is a fine result.'
  ].join('\n')
}
