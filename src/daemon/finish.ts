import type {
  FinishPolicy,
  LooseEnd,
  Project,
  ResolvedFinishPolicy,
  Task
} from '@shared/tasks.js'
import {
  DEFAULT_FINISH_INSTRUCTION,
  finishInstructionFor,
  projectFinishChoice,
  resolveWorkspaceMode,
  trunkPolicyConflict,
} from '@shared/tasks.js'
import { landingRungFor as sharedLandingRungFor, resolveFinishPolicy as sharedResolveFinishPolicy } from '@shared/policy.js'
import { db, rows } from './db.js'
import { log } from './log.js'
import { landingTargetFor, listProjects, policyFor } from './projects.js'
import { listTasks, mandateAllows, runsFor } from './tasks.js'
import { openClaims, trunkResourceId } from './resources.js'
import type { MergeReading } from './landing.js'
import { commitsOnlyOn, ensurePool, taskBranches, workspaceState } from './worktrees.js'
import { mergedDeliveryFor, openDeliveryFor, type PullRequestDelivery } from './deliveries.js'
import type { WorkspaceState } from './worktrees.js'
import { settings } from './settings.js'
export { projectFinishChoice, finishInstructionFor }

/**
 * Delegates to `shared/policy.ts`, binding the fleet setting for daemon callers.
 */
export function resolveFinishPolicy(task: Task | null, project: Project | null): ResolvedFinishPolicy {
  return sharedResolveFinishPolicy(task, project, settings().finishPolicy)
}

/**
 * The rung a landing will really run for this task, with the fleet setting bound.
 *
 * ⛔ **Ask this, not `resolveFinishPolicy`, wherever the answer decides a ref, a check list or a
 * landing strategy.** See `landingRungFor` in `shared/policy.ts` for the conversation case that
 * makes the two answers differ, and for t578, the landing loop it caused.
 */
export function landingRung(
  task: Task | null,
  project: Project | null,
  explicit?: FinishPolicy
): FinishPolicy {
  return sharedLandingRungFor(task, project, settings().finishPolicy, explicit)
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
   * The commits on this task's target that a **sibling** put there, if any are known.
   *
   * ⛔ **The third condition on the tripwire, and it exists because Plan & Split makes the first two
   * ordinary.** The rule is *empty branch* + *target moved* = an agent worked in the trunk. Under a
   * split, children land onto the shared plan branch **while their siblings run**, so a child that
   * legitimately produced no commits — it answered a question, or its work was already there — would
   * be refused its verdict and named in the log as a tripwire hit, constantly and by design.
   *
   * ⛔ Not solved by exempting children. That hands back exactly the hole t17 came through, on the
   * tasks that write the most code: a child that commits onto the plan branch instead of its own
   * branch is the *same* failure, one level down. So the movement is attributed instead — commits a
   * sibling is known to have landed are subtracted, and anything left over still fires.
   *
   * ⚠️ An empty array means *nothing is attributable*, which is the state of every ordinary task and
   * keeps the rule exactly as it was.
   */
  siblingLanded?: string[]
  /**
   * The commits **this task** is recorded as having landed on its own target.
   *
   * ⛔ **The fourth condition on the tripwire, and a conversation that lands twice is why.** The
   * rule is *empty branch* + *target moved* = an agent worked in the trunk. A conversation lands,
   * carries on talking on a fresh branch, and then answers a question without writing a file — at
   * which point its branch is legitimately empty and the target moved during the same run, because
   * *it* moved it. Subtracted exactly as a sibling's landings are, for exactly the same reason:
   * movement with a known author is not evidence against anybody.
   *
   * ⚠️ Empty for a task that has never landed, which leaves the rule as it was.
   */
  ownLanded?: string[]
  /**
   * Whether the branch would rebase onto its target, read without touching anything.
   *
   * ⚠️ `null` is **no reading**, exactly like `trunk`: a git too old for `merge-tree`, a target that
   * does not resolve, a fetch that failed. Unknown declines to fire rather than guessing, and
   * `landTask` remains the backstop that actually attempts the rebase.
   */
  merge?: MergeReading | null
  /**
   * The rung to judge against, when the caller has one the three tiers do not answer with.
   *
   * ⛔ **The one caller is a conversation landing**, and without it this function is unusable
   * there: a `conversation` on `inherit` resolves to `await-human` *from its kind*, which is the
   * whole point of the kind, so `decideFinish` would refuse to land a conversation on principle
   * every time. The override says which rung is being asked about; it does not widen anything
   * — `mandateAllows('land')`, the checks, the clean tree and the rescue-tip rule are all
   * still ahead of it.
   *
   * ⚠️ Absent on every other path, which resolves task → project → fleet exactly as before.
   */
  policy?: FinishPolicy
  /**
   * The caller keeps this workspace, so an untracked file in it is not work anybody walks away from.
   *
   * ⛔ **Step 1 is a guard on *losing* work, not a tidiness rule.** A task that finishes gives its
   * worktree back to the pool, where the next claimant parks it — so the uncommitted half of
   * `git status` is work about to be left behind, and the agent is rightly asked for a commit. A
   * **conversation landing** gives nothing back: the tree, the session standing in it and every
   * untracked file stay exactly where they are, and the next numbered branch is cut around them.
   *
   * ⭐ Measured 2026-09-20 in a scratch repository, both directions: `git rebase` with untracked
   * files present succeeds and leaves them untouched; `git rebase` with one tracked modification
   * refuses — *"cannot rebase: You have unstaged changes"*. So tracked dirt still stops a landing
   * here and untracked dirt no longer does, and neither answer is a guess.
   *
   * ⚠️ t581: t578's operator had *asked* for two backup directories and the agent had rightly left
   * those binaries out of its commit. The tree was therefore never pristine again, the landing was
   * refused every time, and pressing Commit was the only control the card would draw.
   */
  keepsWorkspace?: boolean
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
  merge,
  siblingLanded = [],
  ownLanded = [],
  policy: policyOverride,
  keepsWorkspace = false
}: FinishInputs): FinishDecision {
  const resolved = resolveFinishPolicy(task, project)
  // ⚠️ The override replaces the *rung*, never the instruction: `custom` is the only policy that
  // carries one, it is not a rung anything lands on, and `policyLands` refuses it at the caller.
  const policy = policyOverride ?? resolved.policy
  const instruction = resolved.instruction
  const loose = state.dirtyFiles.length + state.untrackedFiles.length
  // ⛔ What would stop *this* caller, which is not the same list. See `FinishInputs.keepsWorkspace`:
  // a landing that gives the workspace back is guarding every uncommitted file; one that keeps it is
  // guarding only the tracked changes a rebase refuses to run over.
  const blocking = keepsWorkspace ? state.dirtyFiles.length : loose

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

  // 0b. The task whose deliverable is the thread. ⛔ **Before step 1 and before step 3, and the
  //     placement is the whole of it.** Step 3's empty-branch guard is correct and earned (t17) —
  //     an empty branch is indistinguishable from an agent that committed in the trunk — so the
  //     only safe way to exempt a task that was never going to write a commit is for the operator
  //     to have said so *in advance*, which is what choosing this rung is. Ahead of step 1 as well,
  //     because asking a report-only task to *commit* a stray file is asking for the opposite of
  //     what it is for.
  //
  // ⛔ **Done means the branch is as it started**, because this rung lands nothing and so anything
  //     left behind can only ever become a loose end. Before 2026-09-12 a seat that committed or left
  //     files was `done` anyway, and `rescueDirt` then turned its files into a `wip:` commit on a
  //     branch nobody would land. So the agent that made the mess is asked, once, to put it back —
  //     keeping anything worth keeping in its summary, which *is* the deliverable — and a second
  //     report that still leaves something goes to a person with the work intact. The tool itself
  //     discards nothing.
  //
  // ⚠️ `state.unlandedCommits` must be `commitsOnlyOn`'s count here, not `landedRef`'s: a report-only
  //     branch is cut from the *local* target, so on a trunk ahead of its remote the `landedRef` count
  //     is the trunk's own history. The caller owes that measurement (`landCompletion`).
  //
  // ⚠️ After the rebase guard, which outranks everything: a half-finished rebase is a broken tree
  //     however little the task was expected to leave behind.
  if (policy === 'report-only') {
    if (state.unlandedCommits === 0 && loose === 0) {
      return { kind: 'done', reason: 'this task reports on its thread; nothing was expected on the branch' }
    }
    const left = [
      ...(state.unlandedCommits > 0 ? [`${state.unlandedCommits} commit(s)`] : []),
      ...(loose > 0 ? [`${loose} uncommitted file(s)`] : [])
    ].join(' and ')
    const branch = state.branch ?? 'your branch'
    if (task.finishAskedAt === null) {
      const target = project ? landingTargetFor(task, project) : null
      return {
        kind: 'ask-agent',
        reason: `this task reports on its thread but left ${left} on \`${branch}\``,
        instruction:
          `This task reports on its thread and lands nothing, so it must leave \`${branch}\` exactly as ` +
          `it found it — but it holds ${left}. Anything left there only becomes a loose end.\n\n` +
          '1. If any of it matters to your answer, put it in your summary now (a short excerpt or patch ' +
          'is fine): the thread is the only thing anybody will read.\n' +
          (loose > 0
            ? '2. Undo your uncommitted changes and delete the files you created in this workspace.\n'
            : '') +
          (state.unlandedCommits > 0
            ? `${loose > 0 ? '3' : '2'}. Take your own commits off the branch: ` +
              `\`git reset --keep $(git merge-base HEAD ${target ?? '<landing target>'})\`. ` +
              'Touch no commit that was already there.\n'
            : '') +
          '\nDo not commit, push, force-push or start new work. Then report the task complete again, ' +
          'with your whole answer as the summary.'
      }
    }
    return {
      kind: 'await-human',
      reason:
        `this task reports on its thread but still leaves ${left} on \`${branch}\` in ${state.path} ` +
        'after the agent was asked to put them back. Nothing was landed and nothing has been discarded.'
    }
  }

  // 1. Work that is not committed. ⛔ The tool does not commit it — deciding what to stage, what to
  //    leave and what to test first is judgement that differs per project and per person, and a
  //    daemon applying a blocklist at the one moment nobody is watching is a worse version of it.
  //    Every serious tool in this space converges here: the agent commits, the tool never does.
  if (blocking > 0) {
    if (task.finishAskedAt === null) {
      return {
        kind: 'ask-agent',
        instruction:
          policy === 'custom' && instruction
            ? instruction
            : `You have ${blocking} uncommitted file(s). Commit them on \`${state.branch ?? 'your branch'}\`, ` +
              'and, if two or more commits ahead of the landing target all belong to this task, squash them ' +
              'into one coherent commit where safe. Do not rewrite commits already on the landing target, ' +
              'force-push, or use a destructive reset. Then report the task complete again. Do not start new work.',
        reason: `${blocking} file(s) are uncommitted`
      }
    }
    // ⚠️ Asked once and still loose. The work is preserved exactly where it is — never reset, never
    // swept into a commit nobody wrote — and a person is told where to find it.
    return {
      kind: 'await-human',
      reason:
        `${blocking} file(s) are still uncommitted in ${state.path} after the agent was asked to ` +
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
    // ⛔ Attribute the movement before accusing anybody of it. Every commit a sibling landed is
    //    subtracted; if that accounts for all of them the target moved for a reason this design
    //    creates on purpose, and the run is ordinary. Anything unaccounted for still fires.
    const explained = [...siblingLanded, ...ownLanded]
    const unexplained = trunk
      ? trunk.commits.filter((c) => !explained.some((sha) => sha && c.startsWith(sha.slice(0, 8))))
      : []
    if (trunk && trunk.after !== trunk.before && (trunk.commits.length === 0 || unexplained.length > 0)) {
      return {
        kind: 'trunk-moved',
        reason:
          `\`${state.branch}\` carries no commits, but the trunk's \`${project ? landingTargetFor(task, project) : 'target'}\` ` +
          `moved from ${trunk.before.slice(0, 8)} to ${trunk.after.slice(0, 8)} while this run was in ` +
          'flight. Work that lands in the trunk directly is never seen by the checks, the rebase or ' +
          'the landing policy — so this is being handed to you rather than reported as finished.',
        commits: unexplained.length > 0 ? unexplained : trunk.commits
      }
    }
    const localTarget = project ? landingTargetFor(task, project) : 'the target'
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

export interface TrunkFinishInputs {
  task: Task
  project: Project
  /** The resolved rung. */
  policy: FinishPolicy
  /** `custom`'s instruction, when that is the rung. */
  instruction: string | null
  target: string
  /** What the checkout holds now. */
  survey: {
    branch: string | null
    dirtyFiles: string[]
    untrackedFiles: string[]
    operation: string | null
    conflicted: string[]
  }
  /** Files already uncommitted when the run started — the operator's, not the agent's. */
  dirtyBefore: string[]
  /**
   * How many commits reached the target during this run that no other task is recorded as
   * landing. ⚠️ `null` is *could not measure* (no baseline), which is read as "something may have
   * been committed" rather than as nothing.
   */
  commitsThisRun: number | null
  hasChecks: boolean
}

/**
 * What to do with a **trunk** task whose agent has said it is finished.
 *
 * ⛔ **A different ladder, because half of the usual one has already happened.** The commits are on
 * the local target the moment they are made; there is no branch to be empty, no rebase to conflict
 * and no merge left to do. What is left to decide is whether the checkout was left in a state
 * somebody else can use, whether the checks agree, and whether to push.
 *
 * ⛔ **No trunk tripwire.** The tripwire exists to catch an agent that worked in the trunk instead of
 * its branch; a trunk task working in the trunk is the mode doing what it says.
 *
 * ⚠️ Pure, like `decideFinish`, and every ask is once — `finishAskedAt` is the same guard.
 */
export function decideTrunkFinish(input: TrunkFinishInputs): FinishDecision {
  const { task, policy, target, survey } = input
  const before = new Set(input.dirtyBefore)
  const mine = [...survey.dirtyFiles, ...survey.untrackedFiles].filter((f) => !before.has(f))
  const asked = task.finishAskedAt !== null

  // 0. An operation left half done blocks everybody who uses this checkout next.
  if (survey.operation) {
    const conflicted = survey.conflicted.length ? ` (${survey.conflicted.slice(0, 10).join(', ')} still conflicted)` : ''
    const reason = `a ${survey.operation} is still in progress in the trunk${conflicted}`
    if (!asked) {
      return {
        kind: 'ask-agent',
        reason,
        instruction:
          `A ${survey.operation} is still in progress in the trunk${conflicted}. Finish it — resolve, ` +
          '`git add`, and continue — or, if it was not yours to finish, say so in your summary. Do not ' +
          'abort it and do not reset. Then report the task complete again.'
      }
    }
    return { kind: 'await-human', reason: `${reason} after the agent was asked to finish it. Nothing was undone.` }
  }

  // 1. Off the target. Commits made on another branch in the operator's checkout are not this mode.
  if (survey.branch !== target) {
    return {
      kind: 'await-human',
      reason:
        `the trunk is on ${survey.branch ? `\`${survey.branch}\`` : 'a detached HEAD'} rather than ` +
        `\`${target}\` — a trunk task commits on \`${target}\` itself. Nothing was moved.`
    }
  }

  // 2. The thread is the deliverable. ⚠️ Commits already on `main` are not taken back by this tool
  //    or asked to be: removing commits from a shared trunk is a person's decision.
  if (policy === 'report-only') {
    if ((input.commitsThisRun ?? 0) > 0) {
      return {
        kind: 'await-human',
        reason: `this task reports on its thread, but ${input.commitsThisRun} commit(s) reached \`${target}\` during its run`
      }
    }
    if (mine.length > 0) {
      if (!asked) {
        return {
          kind: 'ask-agent',
          reason: `this task reports on its thread but left ${mine.length} file(s) changed in the trunk`,
          instruction:
            `This task reports on its thread and changes nothing, but ${mine.length} file(s) you changed are ` +
            `uncommitted in the trunk: ${mine.slice(0, 10).join(', ')}. Put anything that matters in your ` +
            'summary, then undo exactly those changes — no others. Do not commit. Then report complete again.'
        }
      }
      return { kind: 'await-human', reason: `${mine.length} file(s) are still changed in the trunk. Nothing was discarded.` }
    }
    return { kind: 'done', reason: 'this task reports on its thread and left the trunk as it found it' }
  }

  // 3. The agent's own uncommitted work.
  if (mine.length > 0) {
    if (!asked) {
      return {
        kind: 'ask-agent',
        reason: `${mine.length} file(s) you changed are uncommitted in the trunk`,
        instruction:
          policy === 'custom' && input.instruction
            ? input.instruction
            : `You have ${mine.length} uncommitted file(s) in the trunk: ${mine.slice(0, 10).join(', ')}. ` +
              `Commit them on \`${target}\`` +
              (before.size > 0 ? ' — and only them: the files that were already uncommitted when you arrived are not yours' : '') +
              '. Do not rewrite commits, force-push or reset. Then report the task complete again. Do not start new work.'
      }
    }
    return {
      kind: 'await-human',
      reason: `${mine.length} file(s) are still uncommitted in the trunk after the agent was asked to commit them. Nothing was discarded.`
    }
  }

  if (policy === 'custom') {
    if (!asked) {
      return { kind: 'ask-agent', instruction: input.instruction ?? DEFAULT_FINISH_INSTRUCTION, reason: 'this project defines its own finish policy' }
    }
    return { kind: 'done', reason: "this project's finish policy ran in the trunk" }
  }

  // 4. Nothing committed. ⭐ Ordinary here — a trunk task that answered a question, or found the
  //    work already done, has nothing to verify. No tripwire: see the header.
  if (input.commitsThisRun === 0) {
    return { kind: 'done', reason: `no commits reached \`${target}\` during this run, and the trunk is as it was` }
  }

  if (policy === 'await-human') {
    return { kind: 'await-human', reason: `the commits are on your local \`${target}\`, unverified, and this task waits for you` }
  }
  if (policy === 'commit-only') {
    return { kind: 'done', reason: `committed on \`${target}\` in the trunk, not verified` }
  }
  const conflict = trunkPolicyConflict(policy)
  if (conflict) return { kind: 'await-human', reason: conflict }
  if (policy === 'commit-and-push') {
    if (!mandateAllows(task, 'land')) return { kind: 'await-human', reason: 'this task has no authority to push' }
    if (!input.hasChecks) {
      return {
        kind: 'await-human',
        reason:
          'this project defines no check commands, so nothing proves the work builds and it was not pushed. ' +
          'Add a `check` array to its project.json to let a trunk task push unattended.'
      }
    }
  }
  // `commit-and-verify`, `commit-and-merge` and `commit-and-push`: verify in place, push if asked.
  return { kind: 'land' }
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
 * ⚠️ `warmstart/t<seq>-<slug>` is written by `branchNameFor`, so the sequence number is
 * recoverable from the branch alone — which matters because the workspace has usually been released
 * and reused by the time anybody looks, and the branch is the only thread back to the task.
 *
 * ⚠️ A conversation that has landed is on `warmstart/t<seq>.<unit>-<slug>`, and the unit is skipped:
 * the task is the same task however many times it has landed. A pattern that did not allow for it
 * matched nothing and left every such branch attributed to no task at all.
 */
export function taskSeqFromBranch(branch: string | null): number | null {
  const match = branch?.match(/\/t(\d+)(?:\.\d+)?-/)
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

async function trunkLooseEnd(project: Project, target: string): Promise<LooseEnd | null> {
  if (openClaims(trunkResourceId(project.id)).length > 0) return null
  const last = listTasks({ projectId: project.id })
    .filter((t) => t.workspaceMode !== 'worktree' && resolveWorkspaceMode(t, project).mode === 'trunk')
    .map((t) => ({ task: t, run: runsFor(t.id).filter((r) => r.kind === 'work').at(-1) }))
    .filter((x): x is { task: Task; run: NonNullable<typeof x.run> } => !!x.run)
    .sort((a, b) => b.run.startedAt - a.run.startedAt)[0]
  if (!last || (last.task.status !== 'cancelled' && last.task.status !== 'failed')) return null
  const state = await workspaceState(project.root, target)
  const before = new Set(last.run.trunkDirtyBefore ?? [])
  const left = [...state.dirtyFiles, ...state.untrackedFiles].filter((f) => !before.has(f))
  if (left.length === 0) return null
  return {
    id: `trunk:${project.id}:t${last.task.seq}`,
    kind: 'uncommitted',
    projectId: project.id,
    projectName: project.name,
    workspacePath: project.root,
    branch: state.branch,
    taskSeq: last.task.seq,
    count: left.length,
    summary:
      `${left.length} file(s) t${last.task.seq} left uncommitted in the trunk when it ${last.task.status === 'cancelled' ? 'was cancelled' : 'failed'}: ` +
      `${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}`
  }
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
    const branches = await taskBranches(project, policy.landingTarget)
    // ⭐ **A branch GitHub merged, whose local name has not moved since.** A squash or rebase merge
    // leaves every commit on it "ahead" of the trunk forever, so without this t389 (2026-09-12) read
    // as *not landed* and was offered **Land it** after its PR had merged. Only an unchanged head
    // qualifies: a commit added after the merge is real work the pull request never carried.
    const merged = new Map<string, PullRequestDelivery>()
    for (const branch of branches) {
      const delivery = mergedDeliveryFor(project.id, branch.branch)
      if (delivery && delivery.headSha.toLowerCase() === branch.head) merged.set(branch.branch, delivery)
    }
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
      if (taskSeq === null || !closedTaskSeqs.has(taskSeq)) continue
      // ⛔ A leftover is what deleting the branch would lose, so the count is `commitsOnlyOn`, the
      // same measure as the branch loop below — not `landedRef`, which counts a trunk that is ahead
      // of its remote as this task's work. A branch git cannot measure keeps the reading it had.
      const scopedState = {
        ...state,
        stashes: 0,
        // ⚠️ A merged branch's commits are reported once, as merged, by the branch loop below.
        unlandedCommits: !state.branch || merged.has(state.branch)
          ? 0
          : await commitsOnlyOn(path, state.branch, policy.landingTarget).catch(() => state.unlandedCommits)
      }
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
    for (const branch of branches) {
      // ⚠️ `-1` is "git could not measure it", not "nothing on it". Neither reported nor retired.
      if (branch.ahead < 0 || branch.taskSeq === null || !closedTaskSeqs.has(branch.taskSeq)) continue
      const pr = merged.get(branch.branch)
      const openPr = openDeliveryFor(project.id, branch.branch)
      const end: LooseEnd = {
        projectId: project.id,
        projectName: project.name,
        workspacePath: branch.heldBy ?? project.root,
        branch: branch.branch,
        taskSeq: branch.taskSeq,
        ...(pr
          ? {
              id: `merged:${branch.branch}`,
              kind: 'merged' as const,
              count: branch.ahead,
              url: pr.url,
              summary:
                `${pr.url} merged as \`${(pr.mergeSha ?? '').slice(0, 8)}\` — only the local branch ` +
                `\`${branch.branch}\` is left` +
                (pr.retireBlocked ? `. Kept because ${pr.retireBlocked}` : '')
            }
          : branch.ahead > 0
          ? {
              id: `unlanded:${branch.branch}`,
              kind: 'unlanded' as const,
              count: branch.ahead,
              ...(openPr ? { url: openPr.url } : {}),
              summary: openPr
                ? `Pull request ${openPr.url} is open — ${branch.ahead} commit(s) on \`${branch.branch}\` that the trunk does not have`
                : `${branch.ahead} commit(s) on \`${branch.branch}\` that the trunk does not have`
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

    // ⭐ **The trunk, after a trunk task stopped without finishing.** Its files are never stashed or
    // committed for it (decided 2026-09-12), so a cancelled or failed one can leave edits in the
    // operator's checkout that no worktree scan would ever see. ⚠️ Only files that were not already
    // there when its run started, and only while nobody holds the trunk — otherwise this would report
    // the operator's own editing, or a live task's, as litter.
    const trunkEnd = await trunkLooseEnd(project, policy.landingTarget)
    if (trunkEnd && !seen.has(trunkEnd.id) && !dismissed.has(trunkEnd.id)) {
      seen.add(trunkEnd.id)
      found.push(trunkEnd)
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
