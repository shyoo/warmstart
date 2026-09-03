import type {
  LooseEnd,
  Project,
  ResolvedFinishPolicy,
  Task
} from '@shared/tasks.js'
import {
  DEFAULT_FINISH_INSTRUCTION,
  finishInstructionFor,
  projectFinishChoice,
  resolveFinishPolicy as sharedResolveFinishPolicy
} from '@shared/tasks.js'
import { db, rows } from './db.js'
import { log } from './log.js'
import { listProjects, policyFor } from './projects.js'
import { listTasks, mandateAllows } from './tasks.js'
import type { MergeReading } from './landing.js'
import { ensurePool, taskBranches, workspaceState } from './worktrees.js'
import type { WorkspaceState } from './worktrees.js'
import { settings } from './settings.js'
export { projectFinishChoice, finishInstructionFor }

/**
 * Task, then project, then fleet - the first one that is not `inherit`.
 *
 * ⚠️ The `source` travels with the answer so the UI can say *inherited from the project* rather than
 * showing a value the operator will look for on the task and not find. A setting whose origin is
 * invisible is one nobody trusts and everybody overrides.
 */
export function resolveFinishPolicy(task: Task | null, project: Project | null): ResolvedFinishPolicy {
  return sharedResolveFinishPolicy(task, project, settings().finishPolicy)
}

// ---------------------------------------------------------------------------- the decision

/**
 * What to do with a task whose agent has just said it is finished.
 *
 * ⛔ **Pure, and it does no I/O beyond reading git.** Every branch below was previously an `if` buried
 * in the scheduler or in `landTask`, which is why the answer differed depending on which one ran
 * first and why none of it could be tested without a live session. The caller performs the action;
 * this decides which one, and carries the sentence explaining it.
 */
export type FinishDecision =
  /** Send `instruction` into the session and wait for the agent to report completion again. */
  | { kind: 'ask-agent'; instruction: string; reason: string }
  /** Stop. The work is intact and a person decides what happens to it. */
  | { kind: 'await-human'; reason: string }
  /** Run the project's landing strategy. */
  | { kind: 'land' }
  /** Nothing was produced, and saying "landed" about it would be false. */
  | { kind: 'nothing-to-land'; reason: string }
  /**
   * The branch is empty and the **trunk** moved while this run was in flight.
   *
   * ⛔ Evidence, not an accusation. An operator committing to their own trunk while agents work is
   * ordinary and this must not call it a fault — which is why the rule needs *both* halves. What is
   * not ordinary is a run that produced nothing on its branch while the trunk gained commits, and
   * that pairing is the exact signature of t17 on 2026-08-28: three commits authored on `main` in
   * the trunk, a branch that never moved, and `nothing-to-land` logged three times as though the
   * agent had simply had nothing to do.
   */
  | { kind: 'trunk-moved'; reason: string; commits: string[] }
  /**
   * The branch will not rebase onto its target, and the agent that wrote it is still there.
   *
   * ⛔ **The verdict this file was missing.** A conflict used to be discovered inside `landTask`,
   * which runs *after* this function has already chosen `land` — so the one path that can hand a
   * problem back to the live conversation had been passed two branches earlier, and every conflict
   * became a dead-end `awaiting_human` for a person to resolve by hand. Measured on t39 and t43.
   *
   * ⚠️ The caller starts the rebase and leaves it conflicted before sending `instruction`, so the
   * markers are in the tree when the agent goes looking. It must abort if it cannot send.
   */
  | { kind: 'resolve-conflict'; instruction: string; reason: string; base: string; paths: string[] }
  /** The project's own finish policy already ran and left the branch clean. */
  | { kind: 'done'; reason: string }

export interface FinishInputs {
  task: Task
  project: Project | null
  state: WorkspaceState
  /** Has the project defined any check commands? ⚠️ Not whether they passed - `land` runs them. */
  hasChecks: boolean
  /**
   * What the trunk's landing target did while this run was in flight.
   *
   * ⚠️ `null` means **no reading**, never "it did not move": a run dispatched before the tripwire
   * existed, a non-git project, a target branch that does not resolve. Unknown is not innocence, but
   * it is also not evidence, so a null declines to fire rather than guessing in either direction.
   */
  trunk?: TrunkReading | null
  /**
   * Whether the branch would rebase onto its target, read without touching anything.
   *
   * ⚠️ `null` is **no reading**, exactly like `trunk`: a git too old for `merge-tree`, a target that
   * does not resolve, a fetch that failed. Unknown declines to fire rather than guessing, and
   * `landTask` remains the backstop that actually attempts the rebase.
   */
  merge?: MergeReading | null
}

export interface TrunkReading {
  /** Where the target stood at dispatch. */
  before: string
  /** Where it stands now — read before landing, so the tool's own push is never the movement. */
  after: string
  /** Subjects of what appeared, newest first, for the message a person will read. */
  commits: string[]
}

export function decideFinish({
  task,
  project,
  state,
  hasChecks,
  trunk,
  merge
}: FinishInputs): FinishDecision {
  const { policy, instruction } = resolveFinishPolicy(task, project)
  const loose = state.dirtyFiles.length + state.untrackedFiles.length

  // 0. A rebase this tool started and the agent did not finish. ⛔ Checked before anything else,
  //    because the conflicted files are *dirty* to step 1 and it would tell somebody to commit a
  //    half-merged tree. The work is intact either way — an abandoned rebase discards nothing — but
  //    the sentence has to name what is actually wrong.
  if (merge?.rebaseInProgress) {
    return {
      kind: 'await-human',
      reason:
        `a rebase onto \`${merge.base}\` is still in progress in ${state.path} and was not finished` +
        (merge.conflictedPaths.length
          ? `: ${merge.conflictedPaths.join(', ')} remain conflicted. `
          : '. ') +
        'Resolve them and `git rebase --continue`, or `git rebase --abort` to put the branch back.'
    }
  }

  // 1. Work that is not committed. ⛔ The tool does not commit it — deciding what to stage, what to
  //    leave and what to test first is judgement that differs per project and per person, and a
  //    daemon applying a blocklist at the one moment nobody is watching is a worse version of it.
  //    Every serious tool in this space converges here: the agent commits, the tool never does.
  if (loose > 0) {
    if (task.finishAskedAt === null) {
      return {
        kind: 'ask-agent',
        instruction:
          policy === 'custom' && instruction
            ? instruction
            : `You have ${loose} uncommitted file(s). Commit them on \`${state.branch ?? 'your branch'}\`, ` +
              'then report the task complete again. Do not start new work.',
        reason: `${loose} file(s) are uncommitted`
      }
    }
    // ⚠️ Asked once and still loose. The work is preserved exactly where it is — never reset, never
    // swept into a commit nobody wrote — and a person is told where to find it.
    return {
      kind: 'await-human',
      reason:
        `${loose} file(s) are still uncommitted in ${state.path} after the agent was asked to ` +
        'commit them. The work is intact; nothing has been discarded.'
    }
  }

  // 2. A custom policy that has run. Its own last step is the landing, so the tool does not add one.
  if (policy === 'custom') {
    if (task.finishAskedAt === null) {
      return {
        kind: 'ask-agent',
        instruction: instruction ?? DEFAULT_FINISH_INSTRUCTION,
        reason: 'this project defines its own finish policy'
      }
    }
    return {
      kind: 'done',
      reason:
        state.unlandedCommits > 0
          ? `this project's finish policy ran and left ${state.unlandedCommits} commit(s) on ` +
            `\`${state.branch}\`. The tool did not land them — the policy owns that step.`
          : "this project's finish policy ran and the workspace is clean."
    }
  }

  // 3. Clean, and nothing to land. ⛔ A question answered is finished; reporting it as landed would
  //    tell somebody their change reached the trunk when no commit exists.
  if (state.unlandedCommits === 0) {
    // ⭐ Before calling that ordinary, ask where the work went. A branch with nothing on it is the
    //    normal shape of a task that only had to answer a question — and it is *also* the shape of a
    //    task whose agent worked in the trunk instead. The two are indistinguishable from the
    //    branch alone, which is why t17 finished three times reporting success.
    //
    // ⚠️ Both conditions, deliberately. The trunk moving on its own means an operator was working,
    //    which happens constantly and is nobody's fault; a branch being empty on its own is the
    //    commonest honest outcome there is. Only together are they worth stopping for.
    if (trunk && trunk.after !== trunk.before) {
      return {
        kind: 'trunk-moved',
        reason:
          `\`${state.branch}\` carries no commits, but the trunk's \`${project?.config.landing?.target ?? 'target'}\` ` +
          `moved from ${trunk.before.slice(0, 8)} to ${trunk.after.slice(0, 8)} while this run was in ` +
          'flight. Work that lands in the trunk directly is never seen by the checks, the rebase or ' +
          'the landing policy — so this is being handed to you rather than reported as finished.',
        commits: trunk.commits
      }
    }
    const localTarget = project ? policyFor(project).landingTarget : 'the target'
    if (state.targetBehind > 0) {
      return {
        kind: 'nothing-to-land',
        reason:
          `\`${state.branch}\` carries no commits \`${state.landedRef}\` does not already have. ` +
          `The work reached \`${state.landedRef}\` without passing through here — your local ` +
          `\`${localTarget}\` is ${state.targetBehind} commit(s) behind it, so run ` +
          '`git pull` in the trunk to see it.'
      }
    }
    // ⭐ Empty commit guard: if no commits were produced on this branch and no work landed on the remote,
    // ask a person how to proceed rather than automatically completing.
    return {
      kind: 'await-human',
      reason:
        `\`${state.branch}\` carries no commits that \`${state.landedRef}\` does not already have. ` +
        'No work landed — check if the agent answered as a question instead of making changes.'
    }
  }

  if (policy === 'await-human') {
    return {
      kind: 'await-human',
      reason: `${state.unlandedCommits} commit(s) are ready on \`${state.branch}\` and this task waits for you`
    }
  }

  // 4. ⛔ The two rungs that stop at the branch. Neither moves the work anywhere, so neither
  //    needs `land` authority and neither can be blocked by a conflict it is not going to hit. What
  //    separates them is only whether the checks ran.
  if (policy === 'commit-only') {
    return {
      kind: 'done',
      reason: `${state.unlandedCommits} commit(s) on \`${state.branch}\`, not verified and not merged`
    }
  }
  // ⛔ `land`, not `done`, because the checks have not run yet and this is the rung that runs them.
  //    `verifyOnly` reports the verdict and moves nothing; saying `done` here would be claiming a
  //    verification that had not happened.
  if (policy === 'commit-and-verify') return { kind: 'land' }

  if (policy === 'pull-request') return landOrResolve(task, state, merge)

  // 5. The two that move the work. ⛔ Authority first: a task whose mandate excludes `land` may not,
  //    whatever a dropdown says. A UI sets preferences; it never widens an authority.
  if (!mandateAllows(task, 'land')) {
    return { kind: 'await-human', reason: 'this task has no authority to land' }
  }
  // ⛔ And nothing unverified. A project with no check commands has nothing proving the work builds,
  // so landing it while nobody is watching is a guess dressed as a policy. Naming the gap is also
  // the nudge to close it.
  if (!hasChecks) {
    return {
      kind: 'await-human',
      reason:
        'this project defines no check commands, so nothing proves the work builds. Add a `check` ' +
        'array to its project.json to let the fleet land unattended.'
    }
  }
  return landOrResolve(task, state, merge)
}

/**
 * Land, unless the branch will not rebase — in which case ask the agent once.
 *
 * ⛔ Called from **both** landing policies rather than written once at the end, because
 * `pull-request` returns `land` earlier and a conflict is no less real on that path.
 *
 * ⚠️ Deliberately placed *after* the mandate and checks gates. A task with no authority to land has
 * no business being asked to resolve a merge either — that is authoring a commit on somebody's trunk
 * by a longer route, and `mandateAllows` is the one gate no UI and no convenience may widen.
 */
function landOrResolve(
  task: Task,
  state: WorkspaceState,
  merge: MergeReading | null | undefined
): FinishDecision {
  if (!merge || merge.clean) return { kind: 'land' }
  const paths = merge.conflictedPaths
  const list = paths.length ? paths.map((p) => `  ${p}`).join('\n') : '  (git did not name them)'
  // ⚠️ Asked once. A second ask on a conflict the agent already failed to resolve is the runaway
  // `finish_asked_at` exists to prevent, wearing a different hat.
  if (task.conflictAskedAt !== null) {
    return {
      kind: 'await-human',
      reason:
        `\`${state.branch}\` still does not rebase onto \`${merge.base}\` after the agent was asked ` +
        `to resolve it. Conflicting: ${paths.join(', ') || 'unknown'}. The branch is intact.`
    }
  }
  return {
    kind: 'resolve-conflict',
    base: merge.base,
    paths,
    // ⛔ Says "conflict" on purpose, not just "does not rebase" — this reason becomes `holdReason`
    // on more than one path below (a one-shot CLI's immediate hand-off, and a live session's send
    // failing), and the "Resolve & retry" button on the task pane is offered by testing `holdReason`
    // against /conflict/i. A reason that only said "does not rebase onto main" left a rebase conflict
    // resting at `awaiting_human` with no way back into the button that fixes exactly this. t102,
    // 2026-09-01.
    reason: `\`${state.branch}\` has a conflict and does not rebase onto \`${merge.base}\``,
    instruction:
      `Your branch no longer rebases onto \`${merge.base}\` — it moved while you were working.\n\n` +
      'I have started the rebase for you and left it stopped at the conflict. These files are ' +
      `conflicted:\n${list}\n\n` +
      'Resolve each one, `git add` it, then `git rebase --continue` until the rebase finishes, and ' +
      "report the task complete again. ⛔ Keep both sides' intent — the other change landed on " +
      'purpose. Do not `git rebase --abort`, do not force-push, and do not start new work.'
  }
}

// ---------------------------------------------------------------------------- loose ends

/**
 * ⚠️ `multi-agent-controller/t<seq>-<slug>` is written by `branchNameFor`, so the sequence number is
 * recoverable from the branch alone — which matters because the workspace has usually been released
 * and reused by the time anybody looks, and the branch is the only thread back to the task.
 */
export function taskSeqFromBranch(branch: string | null): number | null {
  const match = branch?.match(/\/t(\d+)-/)
  return match?.[1] ? Number.parseInt(match[1], 10) : null
}

export function looseEndsIn(
  project: { id: string; name: string },
  state: WorkspaceState
): LooseEnd[] {
  const seq = taskSeqFromBranch(state.branch)
  const base = {
    projectId: project.id,
    projectName: project.name,
    workspacePath: state.path,
    branch: state.branch,
    taskSeq: seq
  }
  const ends: LooseEnd[] = []
  const loose = state.dirtyFiles.length + state.untrackedFiles.length

  if (loose > 0) {
    ends.push({
      ...base,
      id: `uncommitted:${state.path}`,
      kind: 'uncommitted',
      count: loose,
      summary:
        `${loose} uncommitted file(s) in ${state.path}` +
        (state.branch ? ` on \`${state.branch}\`` : ' (no branch checked out)')
    })
  }
  if (state.unlandedCommits > 0 && state.branch) {
    ends.push({
      ...base,
      id: `unlanded:${state.branch}`,
      kind: 'unlanded',
      count: state.unlandedCommits,
      summary: `${state.unlandedCommits} commit(s) on \`${state.branch}\` that the trunk does not have`
    })
  }
  if (state.stashes > 0) {
    // ⛔ One entry per repository, not per workspace: stashes live in the shared object store, so
    // every pool member reports the same list and three slots would show the same work three times.
    ends.push({
      ...base,
      id: `stash:${project.id}`,
      kind: 'stash',
      branch: null,
      taskSeq: null,
      count: state.stashes,
      summary: `${state.stashes} stash(es) rescued from a workspace — see \`git stash list\``
    })
  }
  return ends
}

/** Scan every pool member of every project. ⚠️ Reads git only; it never writes and never cleans. */
export async function scanLooseEnds(): Promise<LooseEnd[]> {
  const dismissed = new Set(
    rows<{ id: string }>(db().prepare('select id from loose_end_dismissals').all()).map((r) => r.id)
  )
  const found: LooseEnd[] = []

  for (const project of listProjects()) {
    if (project.vcs !== 'git') continue
    const policy = policyFor(project)
    let members: string[]
    try {
      members = await ensurePool(project)
    } catch {
      continue
    }
    // ⚠️ Deduplicated by id: the stash entry is per repository and every member reports it.
    const seen = new Set<string>()
    // A loose end is the clean-up left *after* a task stopped.  A live task owns its workspace and
    // branch while it works; showing that work here races the task pane and offers clean-up actions
    // before the task is done.  Branch names carry the task sequence, so resolve that evidence from
    // the durable task row rather than inferring state from the worktree's current contents.
    const closedTaskSeqs = new Set(
      listTasks({ projectId: project.id })
        .filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
        .map((task) => task.seq)
    )
    for (const path of members) {
      const state = await workspaceState(path, policy.landingTarget)
      const taskSeq = taskSeqFromBranch(state.branch)
      const closedStashes = (state.stashBranches ?? []).filter((branch) => {
        const stashTaskSeq = taskSeqFromBranch(branch)
        return stashTaskSeq !== null && closedTaskSeqs.has(stashTaskSeq)
      })
      // A parked pool member is normally detached, so its `branch` cannot be used to attribute a
      // stash.  Git's stash subject can; emit that repository-wide row independently and let `seen`
      // collapse the identical reading from the other pool members.
      if (closedStashes.length > 0) {
        for (const end of looseEndsIn(project, {
          ...state,
          branch: null,
          dirtyFiles: [],
          untrackedFiles: [],
          unlandedCommits: 0,
          stashes: closedStashes.length
        })) {
          if (seen.has(end.id) || dismissed.has(end.id)) continue
          seen.add(end.id)
          found.push(end)
        }
      }
      // `looseEndsIn` is intentionally also used as a pure unit-tested description of a workspace.
      // Narrow the scan here, where task lifecycle evidence is available.
      const scopedState = {
        ...state,
        stashes: 0
      }
      if (taskSeq === null || !closedTaskSeqs.has(taskSeq)) continue
      for (const end of looseEndsIn(project, scopedState)) {
        if (seen.has(end.id) || dismissed.has(end.id)) continue
        seen.add(end.id)
        found.push(end)
      }
    }

    // ⛔ **The branches, which no pool member can see.** Everything above reads a workspace and
    // reports the branch that workspace has checked out — so a branch at rest, which is what a
    // finished task leaves, is invisible to all of it. Measured 2026-09-01: t23 and t79 had been
    // sitting in this repository for days, both fully contained in the trunk, neither reported
    // anywhere. `retireBranch` swallows every failure and returns `false`, and nothing retried; the
    // only trace either of them left was an *absent* sentence in a finish message.
    for (const branch of await taskBranches(project, policy.landingTarget)) {
      // ⚠️ `-1` is "git could not measure it", not "nothing on it". Neither reported nor retired.
      if (branch.ahead < 0 || branch.taskSeq === null || !closedTaskSeqs.has(branch.taskSeq)) continue
      const end: LooseEnd = {
        projectId: project.id,
        projectName: project.name,
        workspacePath: branch.heldBy ?? project.root,
        branch: branch.branch,
        taskSeq: branch.taskSeq,
        ...(branch.ahead > 0
          ? {
              id: `unlanded:${branch.branch}`,
              kind: 'unlanded' as const,
              count: branch.ahead,
              summary: `${branch.ahead} commit(s) on \`${branch.branch}\` that the trunk does not have`
            }
          : {
              id: `stranded:${branch.branch}`,
              kind: 'stranded' as const,
              count: 0,
              summary:
                `\`${branch.branch}\` carries nothing the trunk does not already have` +
                (branch.heldBy ? ` and is checked out in ${branch.heldBy}` : ' — only the name is left')
            })
      }
      if (seen.has(end.id) || dismissed.has(end.id)) continue
      seen.add(end.id)
      found.push(end)
    }
  }
  return found
}

export function dismissLooseEnd(id: string): void {
  db()
    .prepare(
      'insert into loose_end_dismissals (id, dismissed_at) values (?,?) on conflict(id) do nothing'
    )
    .run(id, Date.now())
  log.info(`loose end dismissed: ${id}`)
}
