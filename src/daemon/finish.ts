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
import { mandateAllows } from './tasks.js'
import { ensurePool, workspaceState } from './worktrees.js'
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
}

export interface TrunkReading {
  /** Where the target stood at dispatch. */
  before: string
  /** Where it stands now — read before landing, so the tool's own push is never the movement. */
  after: string
  /** Subjects of what appeared, newest first, for the message a person will read. */
  commits: string[]
}

export function decideFinish({ task, project, state, hasChecks, trunk }: FinishInputs): FinishDecision {
  const { policy, instruction } = resolveFinishPolicy(task, project)
  const loose = state.dirtyFiles.length + state.untrackedFiles.length

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
    // ⭐ And if the trunk is behind, say so here rather than leaving somebody to discover it. This
    //    is the shape t22 arrived in on 2026-08-29: the agent pushed its own commit to
    //    `origin/main`, so the branch was genuinely finished, and the operator — whose `main` was
    //    two commits short — read "nothing to land" as "the work is gone".
    return {
      kind: 'nothing-to-land',
      reason:
        state.targetBehind > 0
          ? `\`${state.branch}\` carries no commits \`${state.landedRef}\` does not already have. ` +
            `The work reached \`${state.landedRef}\` without passing through here — your local ` +
            `\`${localTarget}\` is ${state.targetBehind} commit(s) behind it, so run ` +
            '`git pull` in the trunk to see it.'
          : `\`${state.branch}\` carries no commits \`${state.landedRef}\` does not already have`
    }
  }

  if (policy === 'await-human') {
    return {
      kind: 'await-human',
      reason: `${state.unlandedCommits} commit(s) are ready on \`${state.branch}\` and this task waits for you`
    }
  }

  if (policy === 'pull-request') return { kind: 'land' }

  // 4. `agent-lands`, which is the only policy that pushes to a trunk unattended, so it is the only
  //    one with a bar. ⛔ Authority first: a task whose mandate excludes `land` may not, whatever a
  //    dropdown says. A UI sets preferences; it never widens an authority.
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
  return { kind: 'land' }
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
    for (const path of members) {
      const state = await workspaceState(path, policy.landingTarget)
      for (const end of looseEndsIn(project, state)) {
        if (seen.has(end.id) || dismissed.has(end.id)) continue
        seen.add(end.id)
        found.push(end)
      }
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
