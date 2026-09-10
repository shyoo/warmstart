import type { FinishPolicy, PendingWork } from '@shared/tasks.js'
import { FINISH_LABELS, policyLands, policyVerifies } from '@shared/tasks.js'
import { getProject, landingTargetFor, policyFor, reloadProjectIfPresent } from './projects.js'
import { decideFinish, resolveFinishPolicy } from './finish.js'
import { landingBaseFor, hasRemote, landTask } from './landing.js'
import {
  branchNameFor,
  claimWorkspace,
  parkWorkspace,
  prepareWorkspace,
  releaseWorkspace,
  workspaceHeldBy,
  workspaceOnBranch,
  workspaceState
} from './worktrees.js'
import { releaseAllFor } from './resources.js'
import {
  addMessage,
  finishRun,
  getTask,
  markResolveRetryAsked,
  messagesFor,
  runsFor,
  setHoldReason,
  setStatus,
  updateTask
} from './tasks.js'
import { db } from './db.js'
import { log } from './log.js'
import { continueTask, releaseFor, sessionOf } from './scheduler.js'

/**
 * RPC-driven actions, not scheduling: every "Resolve & retry" and "Land/Commit" button on a
 * task thread, and `pendingWorkFor`, the read that decides which of them a card can offer.
 *
 * ⚠️ These run at the operator's request, not on the tick — `resolveRetryOnTask`'s `automatic`
 * flag is the one exception, and it is still a dispatch reacting to a specific failure rather
 * than routine scheduling.
 */

// ---------------------------------------------------------------------------- landing later

/**
 * Land a branch whose task already finished.
 *
 * ⛔ **The case t5 had no answer for.** A task completed, its branch carried a real commit
 * (`ea05929`), the workspace was released, and nothing in the app could ever land it again — the
 * only path to `landTask` ran inside the completion that had already happened. It sat for a day and
 * was recovered by hand.
 *
 * ⚠️ This claims a workspace and prepares it on the branch rather than operating from the trunk.
 * The trunk holds the landing target checked out; rebasing a task branch there would move the
 * operator's own checkout under them, and AGENTS.md has said since M2 that nothing works in the
 * trunk. `prepareWorkspace` already switches to an existing branch, so the pooled path is also the
 * shorter one.
 */
/**
 * Hand a failed landing back to an agent, with the rebase named.
 *
 * ⛔ **The fourth option a stuck landing needed.** When `landTask` fails on a conflict the task
 * rests at `awaiting_human`, and the three choices offered there were *mark done*, *stop here* and
 * *reassign* — none of which is the thing anybody actually wants, which is **fix the conflict and
 * commit again**. Measured on t59, 2026-08-30: the branch was sound, the work was committed, and a
 * migration collided with one that had landed while it ran. The operator's only routes were to
 * declare unverified work finished, park it, or pay for a whole fresh run on a different worker.
 *
 * ⚠️ It does **not** start the rebase first, unlike the `resolve-conflict` verdict inside
 * `landCompletion`. That path has the workspace already held by a live session and can leave the
 * markers in the tree; this one runs after everything was released, and the next run may be handed
 * a different workspace from the pool — so a rebase started here could be started in a directory
 * the agent never sees. Naming the command is reliable where pre-running it is not.
 *
 * ⭐ The base comes from `landingBaseFor`, so the instruction names the ref the landing will really
 * use. Telling an agent to rebase onto `origin/main` when the policy merges onto `main` is the
 * mismatch that caused this conflict to be missed in the first place.
 */
export async function resolveConflictOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (!task.branch) return { ok: false, reason: 'this task has no branch to rebase' }
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running' || task.status === 'assigned') {
    // ⚠️ A live run will be asked by `decideFinish` when it reports, and that path can hand it the
    // conflict with the markers already in the tree. Cutting in here would be the worse version.
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ **The task's own target, not the project's.** A piece of a Plan & Split lands onto its
  // planner's branch, and `landingBaseFor` answers about the project's trunk unless it is handed the
  // task — so this instruction told a split child to rebase onto `main` and commit there. It did.
  // The prompt is the whole of the agent's picture of where its work goes; a wrong ref here is not a
  // wrong sentence, it is work put on the wrong branch by an agent doing exactly as it was told.
  const base = landingBaseFor(project, resolveFinishPolicy(task, project).policy, await hasRemote(project.root), task)
  const checks = policyVerifies(resolveFinishPolicy(task, project).policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '
  const instruction =
    `The landing failed because \`${task.branch}\` does not rebase cleanly onto \`${base}\`. ` +
    `Run \`git rebase ${base}\`, resolve every conflict, and finish the rebase. ` +
    'Keep both sides of the change wherever they are compatible — the other side is work that has ' +
    'already landed, so discarding it is never the answer. ' +
    `Once the rebase is clean, if two or more commits ahead of \`${base}\` all belong to this task, ` +
    `squash them into one coherent commit (for example, \`git rebase -i ${base}\`). ` +
    'Do not rewrite commits already on the landing target, force-push, or use a destructive reset. ' +
    checkStep +
    'Confirm there are no conflict markers and the tree is clean, commit or amend any fixes, then report the task complete again.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to rebase onto ${base} and resolve (${outcome})`)
  return { ok: true }
}

/**
 * Hand a failed check verification back to an agent, with the failure output named.
 */
export async function resolveChecksOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /landing failed|checks failed/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'Project checks failed')
  const checks = project.config.check ?? []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) again after the fix. `
      : 'Rerun the failing command after the fix. '

  const instruction =
    `The landing failed because project verification checks failed on \`${branch}\`:\n\n` +
    `${failureDetail}\n\n` +
    'Please inspect and fix the failing checks (e.g. typecheck, lint, or tests). ' +
    'If two or more commits ahead of this task branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe; do not rewrite commits already on the landing target, ' +
    'force-push, or use a destructive reset. ' +
    checkStep +
    `Commit or amend the fixes on \`${branch}\` only after the checks pass, then report the task complete again.`

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to fix failing checks (${outcome})`)
  return { ok: true }
}

/**
 * Hand uncommitted work or a failed commit back to an agent to commit and report complete again.
 */
export async function resolveCommitOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ Clear finish_asked_at so that when the new run reports complete and needs finish processing,
  // it is not immediately treated as already-asked and rejected.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'Uncommitted changes remain')

  const instruction =
    `The landing could not proceed because changes on \`${branch}\` are uncommitted:\n\n` +
    `${failureDetail}\n\n` +
    'Please review your work. If two or more commits ahead of this task branch’s landing target all ' +
    'belong to this task, squash them into one coherent commit where safe; do not rewrite commits ' +
    'already on the landing target, force-push, or use a destructive reset. ' +
    `Commit all intended changes on \`${branch}\`, then report the task complete again.`

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to commit uncommitted work (${outcome})`)
  return { ok: true }
}

export async function resolveTrunkMovedOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const branch = task.branch
  if (!branch) return { ok: false, reason: 'task has no branch' }
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ Clear finish_asked_at so that when the new run reports complete and needs finish processing,
  // it is not immediately treated as already-asked and rejected.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /trunk moved|trunk tripwire|branch is empty/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'The trunk moved during this run and this branch is empty')

  // ⛔ **The task's own target, not the project's.** A piece of a Plan & Split lands onto its
  // planner's branch, and `landingBaseFor` answers about the project's trunk unless it is handed the
  // task — so this instruction told a split child to rebase onto `main` and commit there. It did.
  // The prompt is the whole of the agent's picture of where its work goes; a wrong ref here is not a
  // wrong sentence, it is work put on the wrong branch by an agent doing exactly as it was told.
  const base = landingBaseFor(project, resolveFinishPolicy(task, project).policy, await hasRemote(project.root), task)
  const checks = policyVerifies(resolveFinishPolicy(task, project).policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '

  const instruction =
    `The landing could not proceed because \`${base}\` moved while your run was in flight and \`${branch}\` carries no commits:\n\n` +
    `${failureDetail}\n\n` +
    `If you made commits directly to \`${base}\`, or if changes need to be rebased onto \`${base}\`, ` +
    `rebase \`${branch}\` onto \`${base}\`, ensure all intended changes are committed on \`${branch}\`. ` +
    'If two or more commits ahead of this task branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe; do not rewrite commits already on the landing target, ' +
    'force-push, or use a destructive reset. ' +
    checkStep +
    'Confirm the tree is clean, then report the task complete again.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to resolve trunk-moved changes on ${branch} (${outcome})`)
  return { ok: true }
}

/**
 * The one recovery action behind every failed-landing button.
 *
 * ⚠️ The wording is deliberately broader than a conflict: a branch can need a rebase, a check fix,
 * or a deliberate commit. They all need the same thing from the scheduler — another run on the same
 * thread — and presenting them as separate recovery verbs taught people to pick the wrong one.
 */
export async function resolveRetryOnTask(
  taskId: string,
  automatic = false
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (automatic && task.resolveRetryAskedAt !== null) {
    return { ok: false, reason: 'automatic resolve-and-retry was already attempted; review this failure' }
  }

  const reason = task.holdReason ?? ''
  const resolver =
    /conflict|rebase/i.test(reason)
      ? resolveConflictOnTask
      : /checks? failed|verification failed/i.test(reason)
        ? resolveChecksOnTask
        : /uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(reason)
          ? resolveCommitOnTask
          : /trunk moved.*branch is empty/i.test(reason)
            ? resolveTrunkMovedOnTask
            : null
  if (!resolver) return { ok: false, reason: 'this landing failure needs human review' }

  if (automatic) {
    // ⛔ Before asking: a send/dispatch that fails still spent the one automatic chance.
    markResolveRetryAsked(task.id)
    addMessage(task.id, 'system', 'Automatically retrying once with the failure details. A second failure will wait for your review.')
  }
  return resolver(task.id)
}

/**
 * Is there work in this task's workspace that pressing Finish would walk away from?
 *
 * ⛔ **Read from the tree, at the moment it is asked, and never inferred.** The alternative was to
 * decide whether to draw the Commit button from what the task *says* — a run that reported, a hold
 * reason mentioning "uncommitted" — and every one of those is a record of something that was true
 * once. An agent that edited three files and did not mention it leaves no such record at all, and a
 * Finish button drawn without a warning on top of three uncommitted files is the one failure this
 * whole card exists to prevent.
 *
 * ⛔ **The workspace is found by holder, in the two places a holder can be.** A conversation resting
 * between turns has its claim reassigned to the *task* (`releaseWorkspaceOf`, retaining); one whose
 * agent is still live has it held by the *session*. Looking in only one place answers "no diff" for
 * half the states this is asked in, which is a wrong answer that reads exactly like a right one.
 *
 * ⚠️ Every failure is reported as `supported: false` with a reason rather than as an absence of
 * work. "There is nothing to commit" and "I could not look" are different sentences, and the UI
 * shows the second one instead of hiding a button.
 */
export async function pendingWorkFor(taskId: string): Promise<PendingWork> {
  const none: PendingWork = {
    supported: false,
    reason: '',
    branch: null,
    unclaimed: false,
    dirtyFiles: 0,
    untrackedFiles: 0,
    unlandedCommits: 0,
    hasDiff: false
  }
  const task = getTask(taskId)
  if (!task) return { ...none, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') {
    return { ...none, reason: 'this task has no git project, so there is nothing to commit' }
  }
  const target = landingTargetFor(task, project)
  const held =
    workspaceHeldBy(project, task.id) ??
    (() => {
      const session = sessionOf(task.id)
      return session ? workspaceHeldBy(project, session.id) : null
    })()
  // ⛔ **The third place to look, and the one t280 needed.** A conversation between turns holds its
  // claim; a conversation whose session has ended does not — the slot went back to the pool while the
  // worktree kept the branch and every uncommitted file on it. Answering "not holding a workspace"
  // there is not a measurement, it is a look in the wrong place, and the card hid the Commit button
  // the hold reason was telling the operator to press.
  const branch = task.branch ?? null
  const state =
    held !== null
      ? await workspaceState(held.path, target)
      : branch
        ? await workspaceOnBranch(project, branch, target)
        : null
  if (!state) {
    return {
      ...none,
      branch,
      reason: branch
        ? `this task is not holding a workspace, and no workspace has \`${branch}\` checked out`
        : 'this task is not holding a workspace and has no branch'
    }
  }
  return {
    supported: true,
    reason: '',
    branch: state.branch,
    unclaimed: held === null,
    dirtyFiles: state.dirtyFiles.length,
    untrackedFiles: state.untrackedFiles.length,
    unlandedCommits: state.unlandedCommits,
    // ⛔ Uncommitted files only, and deliberately not `holdsWork`. An unlanded *commit* is work that
    // is already safe on the branch — Finish leaves it exactly where the agent put it, and warning
    // about it would be crying wolf on the ordinary end of every conversation that did commit.
    hasDiff: state.dirtyFiles.length > 0 || state.untrackedFiles.length > 0
  }
}

/**
 * Ask the agent to commit this thread's work, on the rung the operator picked.
 *
 * ⛔ **It asks rather than commits, because the daemon does not author commits** — the rule
 * `decideFinish` is built on, and the reason `commit-after-verified` cannot exist. This is the
 * dirty-tree half of settling a conversation: there is something here that only an agent can turn
 * into a commit, so it costs a turn.
 *
 * ⛔ **The clean-tree half is `landConversation`, and it is a *different button*.** One control that
 * asked an agent or landed by itself depending on state nobody can see would be two actions wearing
 * one label; the card draws Commit when there are uncommitted files and Land when there are not.
 *
 * ⛔ **The rung is written to `finishPolicy` first, and that write does two jobs.** It is what the
 * landing will read when the agent reports complete — so `commit·verify·merge` really merges — and
 * it is what takes this task out of `isOpenConversation`, which switches the next turn back to the
 * ordinary closing instruction. Without the second, the agent would be handed the conversation
 * instruction that tells it *not* to commit, in the same turn it is being asked to commit, and would
 * quite reasonably do nothing.
 */
export async function commitConversation(
  taskId: string,
  policy: FinishPolicy
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; wait for the turn to end' }
  }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }

  updateTask(task.id, { finishPolicy: policy })
  // ⛔ Cleared for the same reason `resolveCommitOnTask` clears it: the next `task_complete` has to
  // reach a real finish decision rather than being turned away as already-asked.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const checks = policyVerifies(policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run this project's checks (${checks.map((check) => `\`${check}\``).join(', ')}) and fix any failure before you report complete. `
      : ''
  const after =
    policy === 'commit-only'
      ? 'Nothing will be merged or pushed afterwards. '
      : policy === 'commit-and-verify'
        ? 'Nothing will be merged or pushed afterwards; the tool runs the checks again on its side. '
        : policy === 'pull-request'
          ? 'The tool pushes the branch and opens the pull request afterwards — do not open one yourself. '
          : 'The tool takes it from there and lands the branch afterwards. '

  const instruction =
    `Please commit this conversation's work now: ${FINISH_LABELS[policy]}.\n\n` +
    `Commit everything you have changed on \`${branch}\`. ` +
    'If two or more commits ahead of this branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe. Do not rewrite commits already on the landing ' +
    'target, force-push, or use a destructive reset. ' +
    checkStep +
    after +
    'When the commit is in place, call `task_complete` with a one-line summary of what it contains.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked the agent to commit this conversation as ${policy} (${outcome})`)
  return { ok: true }
}

/**
 * Land this thread's branch on the rung the operator picked, with no turn spent.
 *
 * ⛔ **The other half of settling a conversation, and the half that had no button at all.** A
 * conversation whose agent committed leaves a clean tree and commits sitting on its branch: Commit
 * has nothing to ask for, Finish only writes down that a person is satisfied, and Retry landing is
 * drawn only after a landing has already failed. So the work stayed on the branch and the thread
 * offered no way to move it — which is what "one of them should be commit/verify/land into main,
 * where the tool does the last landing part" is asking for.
 *
 * ⛔ **The rung is written to `finishPolicy` first**, for the same two reasons as
 * `commitConversation`: `relandTask` reads the resolved policy, and a conversation's own kind
 * otherwise resolves to `await-human`, which lands nothing. ⚠️ Only the rungs the *tool* acts on are
 * offered (`policyLands`) — landing under `commit-only` would be a button that does nothing.
 *
 * ⛔ **No shortcut past `decideFinish`.** `relandTask` runs the identical bar a first completion
 * meets — authority, checks, a clean tree, real commits — so a dirty tree is refused here with the
 * ordinary reason rather than landed because somebody pressed a button.
 */
export async function landConversation(
  taskId: string,
  policy: FinishPolicy
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (!policyLands(policy)) {
    return { ok: false, reason: `${FINISH_LABELS[policy]} does not land a branch` }
  }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; wait for the turn to end' }
  }
  updateTask(task.id, { finishPolicy: policy })
  log.info(`t${task.seq}: landing this conversation as ${policy} at the operator's request`)
  return relandTask(task.id)
}

export async function relandTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  // ⛔ A retry is a decision a person just made. Returning a reason only to the RPC caller made the
  // button appear to bounce back: the renderer refreshes the task immediately, then has nowhere to
  // render a false `landed` result. Keep the outcome on the task as well as returning it, so it is
  // visible after that refresh and remains in the thread for somebody who opens it later.
  const didNotLand = (reason: string): { ok: false; reason: string } => {
    const detail = `Retry landing failed: ${reason}`
    setHoldReason(task.id, detail)
    addMessage(task.id, 'system', detail)
    return { ok: false, reason }
  }

  if (!task.branch) return didNotLand('this task has no branch')
  if (/trunk moved.*branch is empty/i.test(task.holdReason ?? '')) {
    return didNotLand('the branch carries no commits; use Mark done if the work in trunk is finished, or Resolve & retry to rebase')
  }
  // ⛔ From disk, for the same reason the first completion does it — this button reaches the
  // identical `decideFinish`, and a stale `check` array would refuse the retry just as silently.
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return didNotLand('not a git project')

  // A task that stopped for a person may already be holding its own worktree. Reuse it for landing:
  // asking the pool for another member would either fail at capacity or try to check out the branch
  // in two worktrees at once.
  const retained = workspaceHeldBy(project, task.id)
  const workspace = retained ?? (await claimWorkspace(project, `reland:${task.id}`))
  if (!workspace) return didNotLand('every workspace is busy; try again in a moment')

  try {
    const prepared = await prepareWorkspace(project, workspace, task.branch, task)
    if (!prepared.ok) return didNotLand(prepared.error ?? 'could not prepare a workspace')

    const policy = policyFor(project)
    const state = await workspaceState(workspace.path, landingTargetFor(task, project))
    // ⛔ The same decision as a first completion, not a shortcut past it. A branch reaching this by
    // a button press gets the identical bar: authority, checks, a clean tree, real commits.
    const decision = decideFinish({ task, project, state, hasChecks: policy.check.length > 0 })
    if (decision.kind !== 'land') {
      const reason = 'reason' in decision ? decision.reason : 'nothing to land'
      return didNotLand(reason)
    }

    const result = await landTask({
      project,
      task,
      workspacePath: workspace.path,
      branch: task.branch,
      policy: resolveFinishPolicy(task, project).policy
    })
    if (result.ok) {
      setStatus(task.id, 'completed')
      // ⛔ And close the run this task was still in the middle of, if it had one.
      //
      // ⚠️ It usually has none — this is the *land again* button on a task that finished long ago.
      // But a `running` task can reach here now, and setting the status without ending its run
      // leaves a completed task owning an open run, a live session and a claimed workspace that
      // nothing will ever release. Measured by doing it: t58, landed by hand on 2026-08-30, came
      // back `completed` with `run 44ad4938 … ended=OPEN` and ws3 still claimed. ⭐ Only
      // `reconcileClaims` at the next startup would have freed it, because `reconcileTasks` sweeps
      // `running` tasks and this one is no longer running — the status change is what hides it.
      const open = runsFor(task.id).find((r) => !r.endedAt)
      if (open) {
        finishRun(open.id, 'completed', 'landed by hand while the run was still open')
        await releaseFor(open.id, task.id, project.id)
        if (open.sessionId) releaseAllFor(open.sessionId)
      }
    }
    if (!result.ok) return didNotLand(result.reason ?? 'landing did not complete')
    return { ok: true, ...(result.reason ? { reason: result.reason } : {}) }
  } finally {
    // ⚠️ Parked and released in every path, including the refusals above. A workspace held by a
    // failed button press is one slot fewer for the fleet, permanently.
    await parkWorkspace(project, workspace.path)
    releaseWorkspace(workspace.claimId)
  }
}
