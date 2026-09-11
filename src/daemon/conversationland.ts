import type { FinishPolicy } from '@shared/tasks.js'
import { policyLands } from '@shared/tasks.js'
import { decideFinish, resolveFinishPolicy } from './finish.js'
import { hasRemote, landTask, landingBaseFor } from './landing.js'
import { landingTargetFor, policyFor, reloadProjectIfPresent } from './projects.js'
import { addMessage, getTask, setTaskBranch } from './tasks.js'
import { noteCurrentBranch } from './sessions.js'
import { sessionOf } from './scheduler.js'
import {
  branchNameFor,
  gitIn as git,
  workspaceHeldBy,
  workspaceOnBranch,
  workspaceState
} from './worktrees.js'
import { log } from './log.js'
import { errorMessage } from '@shared/errors.js'

/**
 * Landing a conversation's work **without ending the conversation**.
 *
 * ⛔ **The whole point is what this does *not* do.** Every other route to `landTask` is a task
 * finishing: it writes a rung onto `finish_policy`, the task goes `completed`, the branch is retired
 * and `isOpenConversation` is false for ever. Under the old build that meant a chat could land
 * exactly once and then stopped being a chat — measured by reading `commitConversation` and
 * `landConversation`, both of which wrote the rung as their *first* action and documented why.
 *
 * ⛔ So this lands and leaves everything else alone: no rung is persisted, the status is not
 * touched, and an open run is not closed. What moves instead is the **branch**. The landing retired
 * the one the work was on, so the conversation is put on the next numbered one —
 * `warmstart/t343-…` → `warmstart/t343.2-…` → `.3` — cut from the target the landing just updated,
 * so the next stretch of work starts on top of what landed rather than behind it.
 *
 * ⛔ **Only Finish and Stop end a conversation.** That is the operator decision this file
 * implements, and it is why a landing is an ordinary event in the middle of a thread rather than
 * its last one.
 *
 * ⚠️ **It can run while the agent's own run is open**, because the common caller is the `land_work`
 * MCP tool: the agent has committed, asked to land, and is blocked on the tool's reply. Nothing here
 * may end that run, and nothing here may write to the workspace the agent is about to keep using
 * beyond the branch switch it is told about in the reply.
 */
export interface ConversationLanding {
  ok: boolean
  /** Why not, verbatim — the agent and the operator both see exactly this. */
  reason?: string
  landedSha?: string
  target?: string
  /** The branch the conversation is now on, and the one to keep working in. */
  nextBranch?: string
}

/**
 * The rung a conversation lands on, when nobody named one.
 *
 * ⛔ **The project's own answer with the conversation-kind override skipped**, which is exactly what
 * the thread shows as `inheritedFinish` (`resolveFinishPolicy(null, project)` — a null task cannot
 * be an open conversation, so the kind never speaks). Reading the task's resolved policy instead
 * would answer `await-human` every time, because answering `await-human` from the kind is the whole
 * of what the kind does.
 *
 * ⚠️ And `commit-and-merge` when even that does not land — a project set to `commit-only` has said
 * something about *finishing*, not about a landing a person has just asked for out loud. The fleet
 * default is the honest floor for an explicit request.
 */
function rungFor(
  project: Parameters<typeof resolveFinishPolicy>[1],
  explicit: FinishPolicy | undefined
): FinishPolicy {
  if (explicit && policyLands(explicit)) return explicit
  const inherited = resolveFinishPolicy(null, project).policy
  return policyLands(inherited) ? inherited : 'commit-and-merge'
}

/**
 * Land what this conversation has committed, and give it the next branch to carry on in.
 *
 * ⛔ **The same bar as a first completion, not a shortcut past it.** `decideFinish` is asked with
 * the chosen rung, against a workspace read at this moment and a project re-read from disk — the
 * mandate, the clean tree, real commits and the project's declared checks all have to hold, and a
 * refusal returns the reason and moves nothing.
 */
export async function landConversationWork(
  taskId: string,
  opts: { sessionId?: string; rung?: FinishPolicy } = {}
): Promise<ConversationLanding> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  // ⛔ The kind, first. This tool does not end a run, so on a `work` task it would land the branch
  // and leave the task running with no way to report the landing through the finish path that is
  // still waiting for `task_complete`. A work task lands by finishing; that is not a smaller
  // version of this, it is a different contract.
  if (task.kind !== 'conversation') {
    return {
      ok: false,
      reason:
        `t${task.seq} is a ${task.kind} task, not a conversation. Landing a ${task.kind} task is ` +
        'what reporting it complete does — finish the work and call `task_complete` instead.'
    }
  }
  // ⛔ From disk, at the moment of the decision. `projects.config_json` is a cache refreshed on a
  // cold dispatch, and a conversation is the longest-lived warm session there is — see
  // `reloadProjectIfPresent` and condition 4 in docs/landing.md.
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }

  const branch = task.branch ?? branchNameFor(task.seq, task.title, task.branchUnit)
  if (!branch) return { ok: false, reason: 'this task has no branch' }

  const rung = rungFor(project, opts.rung)

  // ⛔ **The workspace the conversation is already holding, found the way `pendingWorkFor` finds
  // it**, in all three places a holder can be: the session (a live turn), the task (a conversation
  // resting between turns) and the pool member that still has the branch checked out (a conversation
  // whose session ended and gave its claim back). Claiming a fresh workspace instead would either
  // fail at capacity or try to check the branch out in two worktrees at once.
  const session = opts.sessionId ? { id: opts.sessionId } : sessionOf(task.id)
  const held =
    (session ? workspaceHeldBy(project, session.id) : null) ?? workspaceHeldBy(project, task.id)
  const target = landingTargetFor(task, project)
  const state = held
    ? await workspaceState(held.path, target)
    : await workspaceOnBranch(project, branch, target)
  if (!state) {
    return {
      ok: false,
      reason: `this conversation is not holding a workspace, and no workspace has \`${branch}\` checked out`
    }
  }

  const decision = decideFinish({
    task,
    project,
    state,
    hasChecks: policyFor(project).check.length > 0,
    policy: rung
  })
  if (decision.kind !== 'land') {
    // ⚠️ Every non-`land` verdict carries a sentence naming the condition that failed, including
    // `ask-agent` — which here is not an ask but a refusal, because the agent is the caller and is
    // already being told. See docs/landing.md §"What safe means".
    const reason = 'reason' in decision ? decision.reason : 'there is nothing to land'
    return { ok: false, reason }
  }

  const result = await landTask({
    project,
    task,
    workspacePath: state.path,
    branch,
    policy: rung,
    // ⛔ The conversation is not finishing, so nothing may rest it at `awaiting_human` or post a
    // headline of its own. See `LandingContext.quiet`.
    quiet: true
  })
  if (!result.ok || !result.commit) {
    return { ok: false, reason: result.reason ?? 'the landing did not complete' }
  }

  // ⭐ The landing retired `branch`, and the target has moved. Cut the next numbered branch from
  // where the target now stands, in the workspace the conversation is still sitting in, so the next
  // thing the agent commits is on top of what just landed.
  const nextUnit = task.branchUnit + 1
  const nextBranch = branchNameFor(task.seq, task.title, nextUnit)
  const base = landingBaseFor(project, rung, await hasRemote(project.root), task)
  try {
    await git(state.path, ['switch', '-c', nextBranch, base])
  } catch (err) {
    // ⚠️ The landing itself succeeded and is not undone by this: the commits are on the target and
    // recorded. What failed is the fresh branch, so say which half happened rather than reporting
    // the whole thing as a refusal that moved nothing.
    const reason =
      `landed as ${result.commit.slice(0, 8)} onto \`${target}\`, but \`${nextBranch}\` could not ` +
      `be created from \`${base}\`: ${errorMessage(err)}`
    addMessage(task.id, 'system', 'Landed, but the next branch could not be created', null, [], { detail: reason })
    return { ok: false, reason, landedSha: result.commit, target }
  }

  setTaskBranch(task.id, nextBranch, nextUnit)
  // ⚠️ Records what is already true of the tree, for the next borrower to restore. Only where there
  // is a session — a conversation landing between turns has none.
  if (session) noteCurrentBranch(session.id, nextBranch)

  // ⛔ **The headline keeps its exact shape** — `Landed as `<sha>` onto `<target>`` — because
  // `salvageLandedCommits` matches system messages on those opening words, and everything the
  // landing knows goes in `detail` rather than on the line. See `landedMessage`.
  addMessage(
    task.id,
    'system',
    result.message?.headline ?? `Landed as \`${result.commit.slice(0, 8)}\` onto \`${target}\``,
    null,
    [],
    {
      event: 'landing.landed',
      detail: `${result.message?.detail ?? ''} This conversation continues on \`${nextBranch}\`.`.trim()
    }
  )
  log.info(
    `t${task.seq}: landed ${result.commit.slice(0, 8)} onto ${target} as ${rung}; ` +
      `the conversation continues on ${nextBranch}`
  )
  return { ok: true, landedSha: result.commit, target, nextBranch }
}
