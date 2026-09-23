import type { FinishPolicy, PendingWork, ResolveRetryCause } from '@shared/tasks.js'
import { FINISH_LABELS, isOpenConversation, policyLands, policyVerifies, resolveRetryCauses, resolveWorkspaceMode, trunkPolicyConflict } from '@shared/tasks.js'
import type { Project, Task } from '@shared/tasks.js'
import { getProject, landingTargetFor, policyFor, reloadProjectIfPresent } from './projects.js'
import { decideFinish, landingLevel, resolveFinishPolicy } from './finish.js'
import { landingBaseFor, hasRemote, landTask, localBaseNote, trunkNotReady, trunkOccupiedBy } from './landing.js'
import {
  branchExists,
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
  listTasks,
  markResolveRetryAsked,
  messagesFor,
  runsFor,
  setHoldReason,
  setLandAfterTurn,
  setStatus
} from './tasks.js'
import { db } from './db.js'
import { log } from './log.js'
import { messageBody, oneLine } from './threadline.js'
import { STANDING_HOLD_GRACE_MS, continueTask, releaseFor, sessionOf } from './scheduler.js'
import { landConversationWork } from './conversationland.js'
import { adapter } from './adapters/index.js'
import { getWorker } from './workers.js'

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
  //
  // ⛔ **And the level a *landing* runs, not the one `resolveFinishPolicy` answers with.** An open
  // conversation answers `await-human` from its kind — which maps to `leave-branch`, whose base is
  // `origin/<target>` — while the Land press that just failed rebased onto the local target. On
  // t578, 2026-09-20, that told the agent to rebase onto `origin/main` while local `main` stood 9
  // commits ahead: it did exactly that, reported the rebase clean, and the next press failed on the
  // identical conflict. A loop with no converging state. See `landingLevelFor`.
  const level = landingLevel(task, project)
  const base = landingBaseFor(project, level, await hasRemote(project.root), task)
  const checks = policyVerifies(level) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '
  const instruction =
    `The landing failed because \`${task.branch}\` does not rebase cleanly onto \`${base}\`. ` +
    `Run \`git rebase ${base}\`, resolve every conflict, and finish the rebase. ` +
    // ⛔ The measured gap, where there is one. Naming `main` did not stop t578's agent rebasing
    // onto `origin/main` and calling it clean; being told the two are nine commits apart would have.
    (await localBaseNote(project.root, base)) +
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
  const branch = task.branch ?? branchNameFor(task.seq, task.title, task.branchUnit)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /landing failed|checks failed/i.test(messageBody(m)))
  const failureDetail = lastSystem ? messageBody(lastSystem) : (task.holdReason ?? 'Project checks failed')
  const checks = project.config.check ?? []
  // ⚠️ Said in full, because the shortcut is real: t347's agent reported *"focused daemon tests"*
  // green and complete, and the landing's own run of `npm test` was red on a file it had not
  // opened. The exact commands, run in full, are the bar — the same bar the landing applies.
  const checkStep =
    checks.length > 0
      ? `Then run every project check in full, exactly as written (${checks.map((check) => `\`${check}\``).join(', ')}), ` +
        'in this workspace, and do not report complete until each one exits 0 — a focused subset of the ' +
        'tests is not a pass, because the landing reruns the full commands and will fail again on ' +
        'anything you did not run. '
      : 'Then rerun the failing command in full and do not report complete until it exits 0. '

  const instruction =
    `The landing failed because project verification checks failed on \`${branch}\`:\n\n` +
    `${failureDetail}\n\n` +
    'Start from the failure named above: find the failing test or check, run that one first, and fix ' +
    'the cause (the test if the behaviour changed on purpose, the code if it did not). ' +
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
  const branch = task.branch ?? branchNameFor(task.seq, task.title, task.branchUnit)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ Clear finish_asked_at so that when the new run reports complete and needs finish processing,
  // it is not immediately treated as already-asked and rejected.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(messageBody(m)))
  const failureDetail = lastSystem ? messageBody(lastSystem) : (task.holdReason ?? 'Uncommitted changes remain')

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
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /trunk moved|trunk tripwire|branch is empty/i.test(messageBody(m)))
  const failureDetail = lastSystem ? messageBody(lastSystem) : (task.holdReason ?? 'The trunk moved during this run and this branch is empty')

  // ⛔ **The task's own target, not the project's.** A piece of a Plan & Split lands onto its
  // planner's branch, and `landingBaseFor` answers about the project's trunk unless it is handed the
  // task — so this instruction told a split child to rebase onto `main` and commit there. It did.
  // The prompt is the whole of the agent's picture of where its work goes; a wrong ref here is not a
  // wrong sentence, it is work put on the wrong branch by an agent doing exactly as it was told.
  //
  // ⛔ **And the level a *landing* runs, not the one `resolveFinishPolicy` answers with.** An open
  // conversation answers `await-human` from its kind — which maps to `leave-branch`, whose base is
  // `origin/<target>` — while the Land press that just failed rebased onto the local target. On
  // t578, 2026-09-20, that told the agent to rebase onto `origin/main` while local `main` stood 9
  // commits ahead: it did exactly that, reported the rebase clean, and the next press failed on the
  // identical conflict. A loop with no converging state. See `landingLevelFor`.
  const level = landingLevel(task, project)
  const base = landingBaseFor(project, level, await hasRemote(project.root), task)
  const checks = policyVerifies(level) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '

  const instruction =
    `The landing could not proceed because \`${base}\` moved while your run was in flight and \`${branch}\` carries no commits:\n\n` +
    `${failureDetail}\n\n` +
    `If you made commits directly to \`${base}\`, or if changes need to be rebased onto \`${base}\`, ` +
    `rebase \`${branch}\` onto \`${base}\`, ensure all intended changes are committed on \`${branch}\`. ` +
    (await localBaseNote(project.root, base)) +
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

  // ⛔ **The same classifier the card uses, and nothing local.** This used to keep its own regexes,
  // and the first of them was `/conflict|rebase/` — which matched *"the project checks failed after
  // rebase"*, the reason every red check writes. The card said *Project checks failed*; this sent
  // the agent the rebase instruction; the agent rebased (a no-op), reported complete, and the same
  // test went red on the next landing. Three times each on t344 and t347 (2026-09-11), and the name
  // of the failing test never reached the agent. One list, in `@shared/tasks`, read by both.
  const resolvers: Record<ResolveRetryCause, (taskId: string) => Promise<{ ok: boolean; reason?: string }>> = {
    conflicted: resolveConflictOnTask,
    checksFailed: resolveChecksOnTask,
    uncommitted: resolveCommitOnTask,
    trunkMoved: resolveTrunkMovedOnTask
  }
  const cause = resolveRetryCauses(task)[0]
  const resolver = cause ? resolvers[cause] : null
  if (!resolver) return { ok: false, reason: 'this landing failure needs human review' }

  if (automatic) {
    // ⛔ Before asking: a send/dispatch that fails still spent the one automatic chance.
    markResolveRetryAsked(task.id)
    addMessage(task.id, 'system', 'Retrying once automatically', null, [], { detail: 'Retrying with the failure details. A second failure will wait for your review.' })
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
  // ⚠️ **A trunk conversation's tree is the project root, whether or not it holds the lease.** One
  // resting between turns has no claim and no branch, so both looks above came back empty and every
  // trunk conversation read *"not holding a workspace and has no branch"* — a failed look reported
  // about a checkout that was right there. Read only while the trunk is on the target: on any other
  // branch it is the operator's own work, not this conversation's.
  const trunk = held === null && resolveWorkspaceMode(task, project).mode === 'trunk'
  const trunkState = trunk ? await workspaceState(project.root, target).catch(() => null) : null
  const state =
    held !== null
      ? await workspaceState(held.path, target)
      : trunk
        ? trunkState?.branch === target
          ? trunkState
          : null
        : branch
          ? await workspaceOnBranch(project, branch, target)
          : null
  if (!state) {
    // ⛔ **A branch that does not exist is a reading, not a failed one** (t369, reported
    // 2026-09-11). A conversation that has just landed had its branch retired and its workspace
    // released, and the next numbered branch is not cut in any tree until the next turn needs one —
    // so every landing was immediately followed by *"⚠️ Could not read this task's workspace"*,
    // a warning about a tree that had been released precisely because there was nothing left in it.
    // Nothing is on a branch that is not there: no uncommitted files, no unlanded commits, and no
    // measurement outstanding. Answered as `supported`, which draws no warning and no Commit or
    // Land button, because there is nothing for either of them to do.
    if (trunk) {
      return {
        ...none,
        reason: `this conversation works in the trunk, and the trunk is not on \`${target}\``
      }
    }
    if (branch && !(await branchExists(project, branch))) {
      return { ...none, supported: true, branch, unclaimed: true }
    }
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
 * Ask the agent to commit this thread's work, on the level the operator picked.
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
 * ⛔ **And it no longer writes the level, which is the change of 2026-09-10.** It used to, and that
 * write ended the conversation: `finish_policy` stopped being `inherit`, `isOpenConversation` went
 * false for ever, the kind stopped answering `await-human`, and the next `task_complete` completed
 * the task. A chat could be committed exactly once and then was no longer a chat. The level is
 * carried in the *instruction* instead — the agent commits and then lands with it — so the turn
 * contract never changes and only Finish or Stop ends the thread.
 *
 * ⚠️ Two instructions, because the agent's way of landing is not the same on both. An MCP adapter
 * has `land_work` and is told to call it; an MCP-less one has no tool and is told to say the commit
 * is ready so that the person can press **Land**. Decided from `capabilities.mcp`, never from an
 * adapter name — a missing feature is a missing capability.
 *
 * ⛔ `commit-only` is the level that means *commit and stop there*, so it asks for no landing at all.
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
  // ⛔ **A trunk conversation has no branch, and must not be told one** (t649 ← t648). This fell
  // back to `branchNameFor` for every task, so t648 — working in the trunk on `main` — was asked to
  // commit on `warmstart/t648-…`, a branch that never existed, and to squash commits "ahead of this
  // branch's landing target". The first is an instruction to create a branch in the operator's
  // checkout; the second, followed literally in the trunk, is a rewrite of the target itself.
  const trunk = resolveWorkspaceMode(task, project).mode === 'trunk' ? landingTargetFor(task, project) : null
  const conflict = trunk && policyLands(policy) ? trunkPolicyConflict(policy) : null
  if (conflict) return { ok: false, reason: `this conversation works in the trunk: ${conflict}` }
  const branch = trunk ?? task.branch ?? branchNameFor(task.seq, task.title, task.branchUnit)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  // ⛔ **A press that would re-ask for a commit already made is the loop this button had** (t581).
  // t578's agent committed, replied *"the commit is ready to land"*, and the card went on offering
  // Commit as its only control — so the second press sent the identical instruction into the same
  // session twelve seconds later and spent a second turn on it. Measured from the tree, at the
  // moment of the press, exactly as the card's own read is: nothing uncommitted and commits waiting
  // is not a state a turn can improve, and the answer names the control that does move it.
  //
  // ⚠️ `supported` only. *I could not look* is not *there is nothing there*, and this must not turn
  // an unreadable workspace into a refusal — committing checks the branch out again.
  const pending = await pendingWorkFor(task.id)
  if (pending.supported && !pending.hasDiff && pending.unlandedCommits > 0) {
    return {
      ok: false,
      reason:
        `nothing is uncommitted on \`${pending.branch ?? branch}\` — the agent has already committed ` +
        `${pending.unlandedCommits === 1 ? 'it' : 'them'}. ` +
        (policyLands(policy)
          ? `Press **Land** to ${trunk ? 'verify' : 'move'} ${pending.unlandedCommits === 1 ? 'that commit' : `those ${pending.unlandedCommits} commits`}; ` +
            'a turn spent asking for a commit that exists would change nothing.'
          : 'There is nothing left for this level to ask for.')
    }
  }

  const canLand = agentCanLand(task.id)
  const instruction = commitConversationInstruction({
    policy,
    branch,
    checks: policyVerifies(policy) ? (project.config.check ?? []) : [],
    canLand,
    inTrunk: trunk !== null
  })

  // ⛔ **Recorded before the turn is asked for, so a daemon restart between the two does not drop
  // it.** This is the tool's own half of the promise the button's tooltip makes: the agent is told
  // not to merge or push, and on an MCP-less adapter it has no `land_work` to close the loop with,
  // so something has to. `landAfterCommitTurn` re-reads the tree when the turn ends rather than
  // acting on this from memory. ⚠️ Written for an MCP adapter too — it stands down quietly when the
  // agent landed it itself, and that is cheaper than being wrong about whether it did.
  setLandAfterTurn(task.id, policyLands(policy) ? policy : null)

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(
    `t${task.seq}: asked the agent to commit this conversation as ${policy} (${outcome})` +
      (policyLands(policy) ? `; the tool lands it when the turn ends unless ${canLand ? 'land_work' : 'the agent'} got there first` : '')
  )
  return { ok: true }
}

/**
 * The landing a **Commit** press promised, once the turn it asked for has ended.
 *
 * ⛔ **The half of the Commit button that did not exist** (t581, from t578 on 2026-09-20). Commit
 * writes an instruction that ends *"Do not merge or push to the landing target yourself"*, and the
 * level the operator chose is carried in that instruction rather than onto `finish_policy`. An
 * adapter with MCP closes the loop by calling `land_work`; **muse-code and codex declare
 * `mcp: false`**, so on those the level reached nobody at all. t578 came to rest with one squashed
 * commit on its branch, an agent that had correctly reported *"the commit is ready to land"*, and a
 * card whose only control was the button that had just been pressed.
 *
 * ⛔ **It re-reads rather than trusting the ask.** AGENTS.md: record the ask with the evidence that
 * would prove it landed, and re-read before acting on the far side of the wait. So a branch with
 * nothing on it — the agent called `land_work` itself, or committed nothing — stands the landing
 * down in silence rather than posting a refusal about work that is already where it was going.
 *
 * ⛔ **And the promise is cleared first, whatever happens next.** A landing that fails must not be
 * retried on the next unrelated turn: the failure is said once, in the thread, and the operator has
 * **Land** in front of them.
 *
 * ⚠️ Spends no turn. `landConversationWork` is the tool landing by itself, which is the whole reason
 * this can run unattended at all.
 */
export async function landAfterCommitTurn(taskId: string): Promise<void> {
  const task = getTask(taskId)
  const level = task?.landAfterTurn ?? null
  if (!task || !level) return
  setLandAfterTurn(task.id, null)
  if (!policyLands(level)) return

  const pending = await pendingWorkFor(task.id)
  // ⛔ Nothing to land is not a failure and is not reported as one: on an MCP adapter it is the
  // ordinary shape of a turn in which the agent called `land_work` and the tool already landed.
  if (pending.supported && pending.unlandedCommits === 0) {
    log.info(`t${task.seq}: the commit turn left nothing on \`${pending.branch ?? task.branch}\` to land`)
    return
  }

  const landed = await landConversationWork(task.id, { finishPolicy: level })
  if (landed.ok) return
  // ⚠️ Said once, on the thread, under a headline `salvageLandedCommits` does not match — the
  // operator asked for this landing and is owed the reason it did not happen, beside the reply that
  // said the commit was ready.
  addMessage(
    task.id,
    'system',
    `Not landed: ${oneLine(landed.reason ?? 'the landing did not complete')}`,
    null,
    [],
    {
      event: 'landing.failed',
      detail:
        `${landed.reason ?? 'the landing did not complete'} The commit is intact on ` +
        `\`${task.branch ?? 'this branch'}\` and nothing has been discarded — press **Land** once ` +
        'this is resolved, or say what to do next in the thread.'
    }
  )
  log.info(`t${task.seq}: the landing the Commit button promised was refused: ${landed.reason}`)
}

/**
 * Forget a landing a **Commit** press promised, because the turn it was waiting on will not arrive.
 *
 * ⛔ A run that failed, was cancelled or stopped to ask a question did not produce the commit the
 * promise was made about. Leaving it set would land — correctly, at the right level, but on the far
 * side of whatever the operator said *next*, which is a surprise. The button is still there.
 */
export function forgetLandAfterTurn(taskId: string): void {
  if (getTask(taskId)?.landAfterTurn) setLandAfterTurn(taskId, null)
}

/**
 * What the Commit button asks a conversation's agent to do. Pure, and exported for its test.
 *
 * ⛔ **Only a level that lands names a landing.** `land_work` accepts the three `policyLands` levels
 * and nothing else, so `commit-and-verify` — which the Commit ▼ offers — used to produce an
 * instruction to call the tool with a value its own schema refuses. `commit-only` and
 * `commit-and-verify` both end at the commit; the second runs the checks first.
 *
 * ⚠️ What this agent can do about landing is asked of the adapter by the caller, never assumed. A
 * session with no MCP has no `land_work`, and naming a tool an agent has not got is the failure
 * `promptFor` documents — it reads as an instruction it cannot follow rather than as an absence.
 */
export function commitConversationInstruction({
  policy,
  branch,
  checks,
  canLand,
  inTrunk = false
}: {
  policy: FinishPolicy
  /** The task's branch — or, for a trunk conversation, the landing target it commits straight onto. */
  branch: string
  checks: string[]
  canLand: boolean
  inTrunk?: boolean
}): string {
  const checkStep =
    checks.length > 0
      ? `Run this project's checks (${checks.map((check) => `\`${check}\``).join(', ')}) and fix any failure first. `
      : ''
  // ⛔ **The trunk has no branch, so it gets none of the branch sentences** (t649 ← t648). The same
  // wording `commitHygiene` in `promptFor` gives a trunk task, so the two contracts never disagree:
  // commit on the target in place, only your own changes — the operator's checkout may hold files
  // that were never this agent's — and nothing that rewrites, moves or hides the target.
  const commitStep = inTrunk
    ? `Commit your changes directly on \`${branch}\` in the trunk — this conversation has no branch of ` +
      'its own, so do not create or switch to one. Commit only your own changes, never files that were ' +
      'already uncommitted when you arrived. Do not rewrite or squash existing commits, force-push, ' +
      'stash or reset. '
    : `Commit everything you have changed on \`${branch}\`. ` +
      'If two or more commits ahead of this branch’s landing target all belong to this task, squash ' +
      'them into one coherent commit where safe. Do not rewrite commits already on the landing ' +
      'target, force-push, or use a destructive reset. '
  // ⚠️ In the trunk a landing is verify-then-push-if-the-level-pushes (`landConversationWork`'s
  // trunk branch): nothing to rebase, nothing to merge, and no next branch — the conversation stays
  // where it is. Saying otherwise sends the agent looking for a branch the reply never names.
  const landing = inTrunk
    ? 'It runs the checks in the trunk and pushes if the level pushes; there is no branch to rebase ' +
      'and none to move to, so carry on in the trunk afterwards. Do not push yourself. '
    : 'It rebases, runs the checks and merges or pushes per policy, and names the branch to ' +
      'carry on in. Do not merge or push to the landing target yourself. '
  const after = !policyLands(policy)
    ? inTrunk
      ? 'Stop there — nothing is to be pushed. '
      : 'Stop there — nothing is to be merged or pushed. '
    : canLand
      ? `Then land it by calling the MCP tool \`land_work\` with \`finishPolicy: "${policy}"\`. ` + landing
      : // ⛔ **What actually happens next, which is not what this used to say** (t581). It said the
        // person would press **Land**, and on an MCP-less adapter nothing else was going to land it
        // — so the sentence was both the agent's only instruction and the tool's whole plan. The
        // tool lands it itself now (`landAfterCommitTurn`), and the agent is told that rather than
        // sent to describe a button.
        inTrunk
        ? 'Then say in your reply that the commit is ready to land, and stop. Warmstart lands it from ' +
          'there — it runs the checks in the trunk and pushes if the level pushes, and this ' +
          'conversation carries on in the trunk. Do not push yourself. '
        : 'Then say in your reply that the commit is ready to land, and stop. Warmstart lands it from ' +
          'there — it rebases, runs the checks and merges or pushes per policy, and puts this ' +
          'conversation on the next numbered branch. Do not merge or push to the landing target ' +
          'yourself. '

  return (
    `Please commit this conversation's work now: ${FINISH_LABELS[policy]}.\n\n` +
    commitStep +
    checkStep +
    after +
    '⛔ This does not end the task: do not call `task_complete`, and carry on afterwards as before.'
  )
}

/**
 * Has the account this task is talking to got `land_work`?
 *
 * ⛔ Read off the adapter's declared `capabilities.mcp`, never off its name — the invariant in
 * AGENTS.md. ⚠️ Falls back, when no session is live, to the account the task is pinned to and then
 * to the one it last ran on — **not** `assignee`, which a resting conversation has handed to
 * `'human'` — and to *no MCP* when none resolves: telling an agent to press a button it does not
 * have is wrong but inert, where telling it to call a tool it has not got is an instruction it
 * cannot follow.
 */
function agentCanLand(taskId: string): boolean {
  const task = getTask(taskId)
  const live = sessionOf(taskId)
  const workerId = task?.constraints.workerId || task?.ranOn || null
  const adapterId = live?.adapterId ?? (workerId ? (getWorker(workerId)?.adapterId ?? null) : null)
  return adapterId ? adapter(adapterId).info.capabilities.mcp === true : false
}

/**
 * Land this thread's branch on the level the operator picked, with no turn spent.
 *
 * ⛔ **The other half of settling a conversation, and the half that had no button at all.** A
 * conversation whose agent committed leaves a clean tree and commits sitting on its branch: Commit
 * has nothing to ask for, Finish only writes down that a person is satisfied, and Retry landing is
 * drawn only after a landing has already failed. So the work stayed on the branch and the thread
 * offered no way to move it.
 *
 * ⛔ **It delegates to `landConversationWork`, and writes no level.** Pressing Land used to write
 * the chosen level onto `finish_policy` and call `relandTask`, which completed the task — so one
 * landing was the last thing a conversation ever did. Now the level is passed *through* the landing
 * rather than persisted, the task stays an open conversation, and it comes back on the next numbered
 * branch ready for the next thing the person says. Only Finish and Stop end a conversation.
 *
 * ⚠️ Only the levels the *tool* acts on are accepted (`policyLands`) — landing under `commit-only`
 * would be a button that does nothing. ⛔ And no shortcut past `decideFinish`: the identical bar a
 * first completion meets, so a dirty tree is refused with the ordinary reason rather than landed
 * because somebody pressed a button.
 */
/**
 * Say in the thread that a landing has started, before it starts.
 *
 * ⛔ **The feedback a person pressing Land was given was that the buttons went grey** (t369,
 * reported 2026-09-11). A landing fetches, rebases, runs every check the project declares and then
 * pushes — minutes, on this repository — and for all of it the thread was silent while the only
 * indication anything was happening sat in the ledger on the other side of the pane, above the
 * fold. The operator has to scroll away from the conversation to find out that the button they just
 * pressed did something.
 *
 * ⛔ **It is written to the thread, not flashed at the person, because it is a real event.** A
 * landing that takes four minutes and then fails leaves two rows that read in order — *landing
 * under this level* then *this is why it did not* — and the first of them is the timestamp that says
 * how long the failure took to arrive. A transient toast would have said the same thing and then
 * destroyed it.
 *
 * ⚠️ It deliberately does **not** start with *Landed as* — `salvageLandedCommits` matches thread
 * rows on those opening words and a started-landing row carries no sha to salvage.
 */
function announceLandingStarted(
  task: { id: string; seq: number; branch: string | null },
  policy: FinishPolicy,
  what = 'Landing'
): void {
  addMessage(
    task.id,
    'system',
    `${what} ${task.branch ? `\`${task.branch}\`` : 'this branch'} — ${FINISH_LABELS[policy]}…`,
    null,
    [],
    {
      event: 'landing.started',
      detail:
        'The tool fetches the landing target, rebases this branch onto it, runs the project’s ' +
        'check commands where this level asks for them, and only then merges or pushes. Nothing ' +
        'moves until every step passes; a refusal leaves the branch exactly where it is and says ' +
        'why in the next line.'
    }
  )
}

export async function landConversation(
  taskId: string,
  policy: FinishPolicy
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (!policyLands(policy)) {
    return { ok: false, reason: `${FINISH_LABELS[policy]} does not land a branch` }
  }
  // ⚠️ The *button*, not the tool. `landConversationWork` runs perfectly well beside an open run
  // — that is how `land_work` reaches it, with the agent blocked on the reply — but an operator
  // pressing Land mid-turn is landing a tree an agent is still editing, which the clean-tree bar
  // would refuse a moment later anyway and less legibly.
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; wait for the turn to end' }
  }
  log.info(`t${task.seq}: landing this conversation as ${policy} at the operator's request`)
  announceLandingStarted(task, policy)
  const result = await landConversationWork(task.id, { finishPolicy: policy })
  if (!result.ok) {
    // ⚠️ Kept on the task as well as returned, for the reason `relandTask` gives: the renderer
    // refreshes the task the moment the call returns and has nowhere to put a reason that only
    // came back through the RPC.
    const detail = `Landing failed: ${result.reason ?? 'the landing did not complete'}`
    setHoldReason(task.id, detail)
    addMessage(task.id, 'system', `Not landed: ${oneLine(result.reason ?? 'the landing did not complete')}`, null, [], {
      event: 'landing.failed',
      detail
    })
    return { ok: false, ...(result.reason ? { reason: result.reason } : {}) }
  }
  return { ok: true }
}

export async function relandTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  // ⛔ A retry is a decision a person just made. Returning a reason only to the RPC caller made the
  // button appear to bounce back: the renderer refreshes the task immediately, then has nowhere to
  // render a false `landed` result. Keep the outcome on the task as well as returning it, so it is
  // visible after that refresh and remains in the thread for somebody who opens it later.
  const didNotLand = (reason: string, checkOutput?: string): { ok: false; reason: string } => {
    // ⛔ The ordinary landing path puts a red check's output in the thread detail, and
    // `resolveChecksOnTask` uses that detail as the next agent's evidence. Retry landing used to
    // replace it with the short reason alone, so its next Resolve & retry prompt said only
    // "checks failed" and sent an agent back without the failing test (t347, 2026-09-11).
    // Keep the same tail the ordinary path keeps: runners put the actionable summary last.
    const detail = `Retry landing failed: ${reason}` + (checkOutput ? `\n\n${checkOutput.slice(-4000)}` : '')
    setHoldReason(task.id, detail)
    addMessage(task.id, 'system', `Retry did not land: ${oneLine(reason)}`, null, [], { event: 'landing.failed', detail })
    return { ok: false, reason }
  }

  {
    const home = task.projectId ? reloadProjectIfPresent(task.projectId) : null
    if (home && resolveWorkspaceMode(task, home).mode === 'trunk') return relandTrunkTask(task, home, didNotLand)
  }

  // ⛔ **A conversation retries the landing its own Land button performs, not this one.**
  // Everything below resolves the task's *finish* policy, which an open conversation answers
  // `await-human` from its kind — a level that lands nothing — and then writes `completed`, which
  // is the one thing a conversation landing must never do (`landConversationWork`: only Finish and
  // Stop end a conversation). ⚠️ Inferred from reading both paths, not observed: `canRelandTask`
  // hides this button on a conflict, which is how every conversation landing has failed so far.
  if (isOpenConversation(task)) {
    const result = await landConversationWork(task.id)
    if (!result.ok) return didNotLand(result.reason ?? 'the landing did not complete')
    setHoldReason(task.id, null)
    return { ok: true }
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

  // ⚠️ Here rather than at the top of the function: the checks above refuse in milliseconds and
  // write their own line, and two rows for one press that never reached git would read as a landing
  // that started and vanished. From this point on the work is genuinely slow.
  announceLandingStarted(task, resolveFinishPolicy(task, project).policy, 'Retrying the landing of')

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
    // ⚠️ A trunk that is only busy has already said so and queued the task; a second line would
    // repeat it on every tick the trunk stays busy.
    if (!result.ok && result.trunkBusy) return { ok: false, reason: result.reason ?? 'the trunk is busy' }
    if (!result.ok) return didNotLand(result.reason ?? 'landing did not complete', result.checkOutput)
    return { ok: true, ...(result.reason ? { reason: result.reason } : {}) }
  } finally {
    // ⚠️ Parked and released in every path, including the refusals above. A workspace held by a
    // failed button press is one slot fewer for the fleet, permanently.
    await parkWorkspace(project, workspace.path)
    releaseWorkspace(workspace.claimId)
  }
}

/**
 * Land a **trunk** task again: verify in the trunk, push if the level pushes.
 *
 * ⛔ The same bar a first completion gets, minus what does not exist in the trunk — no branch, no
 * rebase. Its commits are already on the target, so a retry can only ever verify them or push them.
 */
async function relandTrunkTask(
  task: Task,
  project: Project,
  didNotLand: (reason: string, checkOutput?: string) => { ok: false; reason: string }
): Promise<{ ok: boolean; reason?: string }> {
  const policy = resolveFinishPolicy(task, project).policy
  if (policy !== 'commit-and-verify' && policy !== 'commit-and-merge' && policy !== 'commit-and-push') {
    return didNotLand(`${FINISH_LABELS[policy]} neither verifies nor pushes a trunk task`)
  }
  const occupied = trunkOccupiedBy(project, task.id)
  if (occupied) return didNotLand(`${occupied}; try again when it has finished`)
  announceLandingStarted(task, policy, 'Retrying the landing of')
  const base = runsFor(task.id).filter((r) => r.kind === 'work').at(-1)?.trunkShaBefore ?? null
  const result = await landTask({
    project,
    task,
    workspacePath: project.root,
    branch: landingTargetFor(task, project),
    policy,
    trunkBase: base
  })
  if (!result.ok) return didNotLand(result.reason ?? 'landing did not complete', result.checkOutput)
  setStatus(task.id, 'completed')
  const open = runsFor(task.id).find((r) => !r.endedAt)
  if (open) {
    finishRun(open.id, 'completed', 'landed by hand while the run was still open')
    await releaseFor(open.id, task.id, project.id)
    if (open.sessionId) releaseAllFor(open.sessionId)
  }
  return { ok: true }
}

/** Landings already under way, so a slow check run is not started a second time by the next tick. */
const queuedInFlight = new Set<string>()

/**
 * The two kinds of trunk blocker, told apart — and this distinction is the whole of t621.
 *
 * ⛔ `trunkOccupiedBy` is a **lease**: another task is working in the trunk, it will settle, and the
 * queued landing genuinely ends by itself. `trunkNotReady` is the **operator's own checkout**: files
 * they have not committed, a branch they have switched to, a detached HEAD. Nothing the scheduler
 * does will ever change one of those, so a landing waiting on it is a held status with no ender —
 * the invariant `admit()` and `handOverStandingHold` both exist to keep.
 *
 * ⭐ Measured on t614 (autotrade, 2026-09-22): it reported complete at 19:42:19Z, `mergeLocal`'s
 * preflight found 16 uncommitted files in `C:\Dev\autotrade` — dated 2026-08-12, five weeks older
 * than the project's registration, so plainly the operator's own — and the task went to
 * `landing_queued` with `assignee: null`. Two hours later the daemon log carried **no further line
 * about it**: `retryQueuedLandings` had rewritten the identical hold reason on every tick,
 * `handOverStandingHold` never sees a task that is not trying to dispatch, mobile `question.ts`
 * returns no decisions for `landing_queued` by name, and Flow files it under *queued*. Nobody was
 * ever asked to clear the trunk, which was the one act that could have landed it.
 */
function trunkHoldKind(reason: string): string {
  if (/uncommitted file\(s\) in it/i.test(reason)) return 'dirty'
  if (/detached HEAD/i.test(reason)) return 'detached'
  if (/checked out rather than/i.test(reason)) return 'wrong-branch'
  return reason
}

/**
 * Operator-only trunk holds this process has seen, and since when.
 *
 * ⚠️ Process-local and keyed by `trunkHoldKind`, not by the sentence. The sentence carries a file
 * count and five file names, so an operator editing in their own checkout would reset the clock on
 * every keystroke and never be asked anything — the ledger has to key on *what kind* of thing is in
 * the way, which does not change while they work. A restart re-starts the clock, which is the safe
 * direction: it delays a hand-over, it never invents one.
 */
const trunkHolds = new Map<string, { kind: string; since: number }>()

/** Test seam: the ledger is process state, and a test that seeds a fleet needs it empty. */
export function forgetTrunkHolds(): void {
  trunkHolds.clear()
}

/**
 * A queued landing waiting on something only the operator can do, handed to the operator.
 *
 * ⚠️ `awaiting_human`, not `failed`, and for `handOverStandingHold`'s reasons: nothing failed. The
 * branch is intact, every commit is on it, and the task is one act away from landing. ⛔ The hold
 * reason is *rewritten* rather than kept, because the queued one ends with "it will land by itself
 * once the trunk is free" and that sentence has just stopped being true.
 *
 * Returns whether the task was handed over on this pass.
 */
function handOverTrunkHold(task: Task, project: Project, reason: string, now: number): boolean {
  const kind = trunkHoldKind(reason)
  const prior = trunkHolds.get(task.id)
  if (!prior || prior.kind !== kind) {
    trunkHolds.set(task.id, { kind, since: now })
    return false
  }
  if (now - prior.since < STANDING_HOLD_GRACE_MS) return false
  trunkHolds.delete(task.id)
  const waited = Math.round((now - prior.since) / 60000)
  addMessage(task.id, 'system', `Waiting on the trunk checkout: ${oneLine(reason)}`, null, [], {
    event: 'landing.failed',
    detail:
      `This task's work is committed on \`${task.branch}\` and it is ready to merge, but the trunk ` +
      `checkout (${project.root}) cannot receive it: ${reason}. That is your checkout, not this ` +
      'task\'s workspace — nothing here will ever change it, and it has been this way for ' +
      `${waited}m, so waiting longer will not help. Sort the trunk out and press **Retry landing**; ` +
      'nothing has been discarded and the branch is exactly as the agent left it.'
  })
  setStatus(task.id, 'awaiting_human', {
    assignee: 'human',
    holdReason:
      `the trunk is not ready to receive this: ${reason}. Nothing in the fleet can clear this — ` +
      'the branch is intact, so press Retry landing once the trunk checkout is sorted.'
  })
  log.warn(
    `t${task.seq} handed to a person after ${waited}m of a queued landing nothing clears by itself: ${reason}`
  )
  return true
}

/**
 * Re-attempt every landing that queued for the trunk, once the trunk is free.
 *
 * ⛔ **The thing that ends the `landing_queued` hold.** Asked on the tick, zero tokens: two cheap
 * readings — the trunk lease and `git status` in the checkout — decide whether trying is worth it,
 * and only then does the (slow) landing run, in the background, so the tick is never held up by a
 * project's checks. A landing that fails for any reason other than the trunk being busy rests at
 * `awaiting_human` exactly as a first landing would, with Resolve & retry for a conflict.
 *
 * ⛔ **Only a trunk *lease* is a wait; the operator's own checkout is a question.** See
 * `handOverTrunkHold` for the measurement (t614) and why the two must not share a code path.
 */
export async function retryQueuedLandings(now = Date.now()): Promise<number> {
  let started = 0
  for (const task of listTasks().filter((t) => t.status === 'landing_queued')) {
    if (queuedInFlight.has(task.id)) continue
    const project = task.projectId ? getProject(task.projectId) : null
    if (!project) {
      setStatus(task.id, 'awaiting_human', {
        assignee: 'human',
        holdReason: 'this task was queued to land, but its project is no longer registered'
      })
      continue
    }
    const leased = trunkOccupiedBy(project, task.id)
    const busy = leased ?? (await trunkNotReady(project.root, landingTargetFor(task, project)))
    if (busy) {
      if (busy.startsWith('the trunk could not be read:')) {
        trunkHolds.delete(task.id)
        setStatus(task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: busy
        })
        continue
      }
      // A lease ends when the task holding it settles, so this one really does wait it out.
      if (leased) {
        trunkHolds.delete(task.id)
        setHoldReason(task.id, `the trunk is not ready to receive this: ${busy}. It will land by itself once the trunk is free.`)
        continue
      }
      if (handOverTrunkHold(task, project, busy, now)) continue
      setHoldReason(task.id, `the trunk is not ready to receive this: ${busy}. It will land by itself once the trunk is free.`)
      continue
    }
    trunkHolds.delete(task.id)
    queuedInFlight.add(task.id)
    started += 1
    log.info(`t${task.seq}: the trunk is free — landing the queued branch`)
    void relandTask(task.id)
      .catch((err) => log.warn(`queued landing of t${task.seq} failed:`, err))
      .finally(() => queuedInFlight.delete(task.id))
  }
  return started
}
