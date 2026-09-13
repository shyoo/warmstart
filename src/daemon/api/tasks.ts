/** Tasks and everything hanging off one - approvals, questions, attachments, loose ends. */
import { resolveAutoCompact, resolveWorkspaceMode, trunkPolicyConflict, windowHighWater } from '@shared/tasks.js'
import type { Task, WorkspaceModeChoice } from '@shared/tasks.js'
import { resolveCompletionMode } from '@shared/policy.js'
import { adapter } from '../adapters/index.js'
import { manualReviewsForTask, reviewsForTask } from '../review.js'
import { attachmentBytes, createAttachment, createFolderAttachment, requireAttachment } from '../attachments.js'
import { getWorker, listWorkers, requireWorker } from '../workers.js'
import { lastQuota, windowExpired } from '../quota.js'
import { getSession } from '../sessions.js'
import { getProject, policyFor, requireProject } from '../projects.js'
import { deleteUnlandedBranch, retireStrandedBranch } from '../worktrees.js'
import { cleanUpMergedBranch, pendingDeliveries, reconcilePullRequestDeliveries } from '../deliveries.js'
import { addMessage, attachDependency, blockedDependentsOf, createTask, dependentsOf, detachDependency, getTask, listTasks, messagesFor, pageTasks, projectActivity, promoteDraft, requireTask, setHoldReason, setQuotaOverride, setQuotaPreemptWarning, runsFor, setTaskStatsExcluded, setWorkspaceMode, updateTask } from '../tasks.js'
import { taskCommits } from '../taskcommits.js'
import { commitDiffFor, commitFileFor, diffFileFor, diffSummaryFor } from '../taskdiff.js'
import { cancelTask, deleteBlockers, deleteTask, restoreTask, resumeTask } from '../cancel.js'
import { addRule, answerApproval, listRules, openApprovals, removeRule, requestApproval } from '../approvals.js'
import { answerQuestion, askQuestion, openQuestions, questionsForTask, voidQuestionsForTask } from '../questions.js'
import { childrenOf as splitChildrenOf } from '../split.js'
import { allAvailability } from '../resources.js'
import { activityFor } from '../activity.js'
import { continueTask, deliverToLiveSession, QUOTA_HIGH_WATER, QUOTA_OVERRIDE_FALLBACK_MS, resolveTask } from '../scheduler.js'
import { promptFor } from '../prompt.js'
import { commitConversation, landConversation, pendingWorkFor, relandTask, resolveChecksOnTask, resolveCommitOnTask, resolveConflictOnTask, resolveRetryOnTask } from '../resolutions.js'
import { windowResetsAt } from '../quota.js'
import { resolveObjective } from '../objective.js'
import { settings } from '../settings.js'
import { compactionsForTask } from '../compaction.js'
import { listConversations } from '../conversations.js'
import { log } from '../log.js'
import { clockTime } from '../threadline.js'
import { dismissLooseEnd, resolveFinishPolicy, scanLooseEnds } from '../finish.js'
import { withLanding } from '../landingstate.js'
import { resolveSessionSharing } from '../sharing.js'
import type { Api, ApiContext } from './support.js'
import { checkConstraints, dependenciesFor } from './support.js'

type TaskMethod =
  | 'task.list' | 'task.page' | 'task.get' | 'project.activity' | 'task.create' | 'attachment.create' | 'attachment.folder'
  | 'attachment.read' | 'task.update' | 'task.setFinishPolicy' | 'task.pendingWork'
  | 'task.diffSummary' | 'task.diffFile' | 'task.commitDiff' | 'task.commitFile'
  | 'task.commitConversation' | 'task.landConversation' | 'task.setSessionSharing'
  | 'task.setCompletionMode' | 'task.setWorkspaceMode' | 'task.setAutoCompact' | 'task.setStatsExcluded' | 'task.setObjective'
  | 'task.setModel' | 'task.setWorker' | 'task.setPriority' | 'task.land' | 'task.resolveConflict'
  | 'task.resolveRetry' | 'task.resolveChecks' | 'task.resolveCommit' | 'task.message' | 'task.cancel'
  | 'task.resume' | 'task.overrideQuota' | 'task.resolve' | 'task.deleteCheck' | 'task.delete'
  | 'task.restore' | 'task.promote' | 'task.addDependency' | 'task.removeDependency' | 'approval.list'
  | 'approval.request' | 'approval.answer' | 'approval.rules' | 'approval.addRule' | 'approval.removeRule'
  | 'question.ask' | 'question.list' | 'question.forTask' | 'question.answer' | 'resource.list'
  | 'conversation.list' | 'looseend.list' | 'looseend.retire' | 'looseend.delete' | 'looseend.dismiss'
  | 'looseend.reclaim' | 'looseend.cleanup' | 'looseend.checkMerged' | 'delivery.pending'

/** Apply a next-run worker/model choice without sending a generic “Continue” turn first. */
function reassignForResolveRetry(
  id: string,
  choice: { workerId: string | null; model: string | null; modelPolicy: 'auto' | 'inherit' | null; effort: string | null }
): void {
  const task = requireTask(id)
  if (!choice.workerId) {
    const { workerId, adapterId, model, effort, modelPolicy, workerIds, ...constraints } = task.constraints
    voidQuestionsForTask(task.id, 'task reassigned')
    updateTask(id, { constraints, assigneeHint: null })
    return
  }

  const worker = requireWorker(choice.workerId)
  if (task.constraints.workerId !== worker.id) voidQuestionsForTask(task.id, 'task reassigned')
  const adapterChanged = task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId
  const { workerIds: _workerIds, ...baseConstraints } = task.constraints
  const constraints = checkConstraints({
    ...baseConstraints,
    workerId: worker.id,
    adapterId: worker.adapterId,
    model: adapterChanged ? undefined : (choice.model ?? undefined),
    effort: adapterChanged ? undefined : (choice.effort ?? undefined),
    modelPolicy: adapterChanged ? 'inherit' : (choice.modelPolicy ?? 'inherit')
  })
  if (!constraints.model) delete constraints.model
  if (!constraints.effort) delete constraints.effort
  if (!constraints.modelPolicy) delete constraints.modelPolicy
  delete constraints.workerIds
  updateTask(id, { constraints, assigneeHint: worker.id })
}

function setWorkspaceModeChecked(id: string, mode: WorkspaceModeChoice): Task {
  const task = requireTask(id)
  const project = task.projectId ? getProject(task.projectId) : null
  if (project && resolveWorkspaceMode({ workspaceMode: mode }, project).mode === 'trunk' && task.kind !== 'conversation') {
    const conflict = trunkPolicyConflict(resolveFinishPolicy(task, project).policy)
    if (conflict) throw new Error(`t${task.seq} cannot work in the trunk: ${conflict}`)
  }
  return setWorkspaceMode(id, mode)
}

export function apiTasks(_ctx: ApiContext): Pick<Api, TaskMethod> {
  return {
    'task.list': (p) => listTasks(p ?? {}).map(withLanding),
    'project.activity': (p) => projectActivity(p.projectId, p.limit),
    'task.page': (p) => {
      const page = pageTasks(p ?? {})
      return { ...page, tasks: page.tasks.map(withLanding) }
    },
    'task.get': (p) => {
      const task = getTask(p.id)
      if (!task) return null
      const runs = runsFor(p.id)
      // ⛔ The sessions too, so the detail pane can answer the question the whole cost model exists
      // for: did this run continue from a warm prefix, or rebuild one? A worker id says which account
      // paid; only the session says whether the context survived.
      const seen = new Set<string>()
      const sessions = runs
        .map((r) => r.sessionId)
        .filter((id): id is string => !!id && !seen.has(id) && !!seen.add(id))
        .map((id) => getSession(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
      const project = task.projectId ? getProject(task.projectId) : null
      const assignedWorker = task.constraints.workerId
        ? getWorker(task.constraints.workerId)
        : task.assignee
          ? getWorker(task.assignee)
          : (listWorkers().find((w) => w.retiredAt === null) ?? null)
      const adapterId = assignedWorker?.adapterId ?? 'claude-code'
      // ⚠️ `.text` — and the preview therefore still contains the attachment path lines, which
      // is the point: what this pane shows has to be what the agent is sent, or it is a
      // different prompt with a reassuring resemblance to the real one.
      const previewPrompt = promptFor(task, adapterId, false, { markDelivered: false }).text
      const dependencies = dependenciesFor(p.id)
      // ⛔ The lineage, which no edge in this graph carries. A piece of a plan does not *depend on*
      // its planner — the planner depends on the piece — so neither list below can answer "whose
      // plan is this?" or "what did this plan file?".
      const parent = task.parentTaskId ? (getTask(task.parentTaskId) ?? null) : null
      const children = splitChildrenOf(p.id)
      const dependents = dependentsOf(p.id)
        .map((id) => getTask(id))
        .filter((t): t is typeof task => !!t && t.deletedAt === null)
      return {
        task: withLanding(task),
        messages: messagesFor(p.id),
        runs,
        sessions,
        compactions: compactionsForTask(p.id),
        // ⛔ **What this task actually put on the trunk**, one row per commit. The task's branch is
        // gone the moment it lands and `landedBaseSha`/`landedHeadSha` are a range, which cannot
        // describe a task that landed twice; these are the commits themselves. See `taskcommits.ts`.
        commits: taskCommits(p.id),
        activity: activityFor(p.id),
        // ⛔ Every review, not just the latest. A second review never sees the first (anchoring), so
        // two independent scores that disagree are the most interesting rows in this dataset — they
        // measure how much the *judge* is worth — and the thread has to be able to show both.
        reviews: reviewsForTask(p.id),
        manualReviews: manualReviewsForTask(p.id),
        blocking: blockedDependentsOf(p.id),
        dependencies,
        dependents,
        parent,
        children,
        resolvedFinish: resolveFinishPolicy(task, project),
        resolvedSharing: resolveSessionSharing(task, project),
        inheritedFinish: resolveFinishPolicy(null, project),
        inheritedSharing: resolveSessionSharing(null, project),
        inheritedCompletion: resolveCompletionMode(null, project, settings().completionMode),
        inheritedWorkspaceMode: resolveWorkspaceMode(null, project).mode,
        inheritedAutoCompact: resolveAutoCompact(null, settings().autoCompact),
        /**
         * ⛔ **Whether compaction is a thing this task's agent can be asked for at all**, which is a
         * capability and not a preference. Answered here rather than in the renderer because the
         * renderer would have to branch on an adapter id to work it out, and that is the one thing
         * AGENTS.md forbids outright. A `false` turns the picker into a statement of fact instead of
         * a control that silently does nothing.
         *
         * ⚠️ Read off the same `adapterId` the prompt preview above is built from — the worker this
         * task is pinned to, its assignee, or the first live one. A task with no pin can therefore be
         * shown a capability it will not have if the scheduler routes it elsewhere; the picker says
         * `on` regardless in that case, and the clock's own `manualCompact` gate is what actually
         * decides at dispatch. Guessing wrong here costs a sentence, never a compaction.
         */
        compactionCapable: adapter(adapterId).info.capabilities.manualCompact,
        inheritedObjective: resolveObjective(project?.config?.objective, null, settings().objective),
        resolvedObjective: resolveObjective(project?.config?.objective, task.objective, settings().objective),
        previewPrompt
      }
    },
    'task.create': (p) => {
      // ⛔ Refused at the door, where the person choosing can still choose differently. A trunk task
      // that could only open a pull request would otherwise be held at every dispatch for ever.
      const project = p.projectId ? getProject(p.projectId) : null
      if (project && p.workspaceMode && resolveWorkspaceMode({ workspaceMode: p.workspaceMode }, project).mode === 'trunk') {
        const policy =
          p.finishPolicy && p.finishPolicy !== 'inherit' ? p.finishPolicy : resolveFinishPolicy(null, project).policy
        const conflict = p.kind === 'conversation' ? null : trunkPolicyConflict(policy)
        if (conflict) throw new Error(`cannot file this in the trunk: ${conflict}`)
      }
      return createTask({
        ...p,
        ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {})
      })
    },
    /**
     * One pasted image, onto disk.
     *
     * ⛔ One per call, so that `MAX_BODY_BYTES` can stay at 4 MB. Eight screenshots are eight
     * requests of ~2 MB rather than one of 16; raising a limit to fit a payload that can be
     * split is how a limit stops meaning anything.
     *
     * ⛔ The bytes decide what this is, not `mediaType` — see `createAttachment`. The row
     * comes back unbound, and becomes part of a thread only when a message carrying its id is
     * filed.
     */
    'attachment.create': (p) =>
      createAttachment(Buffer.from(p.dataBase64, 'base64'), p.mediaType, {
        width: p.width ?? null,
        height: p.height ?? null,
        name: p.name
      }),
    'attachment.folder': (p) => createFolderAttachment(p.path),
    'attachment.read': (p) => {
      const attachment = requireAttachment(p.id)
      const bytes = attachmentBytes(attachment)
      if (!bytes) throw new Error(`the bytes of attachment '${p.id}' are no longer on disk`)
      return { attachment, dataBase64: bytes.toString('base64') }
    },
    'task.update': (p) => {
      const { id, workspaceMode, ...patch } = p
      if (patch.constraints) {
        patch.constraints = checkConstraints(patch.constraints)
      }
      if (workspaceMode !== undefined) setWorkspaceModeChecked(id, workspaceMode)
      return updateTask(id, patch)
    },
    /** ⛔ Refused once the task has run, and refused into the trunk beside a pull-request rung. */
    'task.setWorkspaceMode': (p) => setWorkspaceModeChecked(p.id, p.workspaceMode),
    /**
     * Set a task's finish policy, and act on it if the task is already sitting on finished work.
     *
     * ⛔ Changing this to a landing policy on a task resting in `awaiting_human` *is* the decision to
     * land it — that is the whole value of a control you can change after the fact. The bar is
     * unchanged: `relandTask` runs the same `decideFinish` a first completion would, so a task that
     * is not safe to land comes straight back with the reason.
     */
    'task.setFinishPolicy': async (p) => {
      const before = requireTask(p.id)
      const home = before.projectId ? getProject(before.projectId) : null
      const inTrunk = home !== null && resolveWorkspaceMode(before, home).mode === 'trunk'
      if (inTrunk && home) {
        const conflict = trunkPolicyConflict(resolveFinishPolicy({ ...before, finishPolicy: p.finishPolicy }, home).policy)
        if (conflict) throw new Error(`t${before.seq} works in the trunk: ${conflict}`)
      }
      const task = updateTask(p.id, { finishPolicy: p.finishPolicy })
      // ⚠️ Every rung that moves the work somewhere, not just the one that pushes. Choosing
      // `commit-and-merge` on a parked task is as much a decision to land it as `commit-and-push` is.
      const wantsLanding =
        p.finishPolicy === 'commit-and-merge' ||
        p.finishPolicy === 'commit-and-push' ||
        p.finishPolicy === 'pull-request'
      if (!wantsLanding || before.status !== 'awaiting_human' || (!task.branch && !inTrunk)) {
        return { task, landed: false }
      }
      const result = await relandTask(p.id)
      return { task: requireTask(p.id), landed: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    /**
     * ⚠️ Takes effect on the task's **next** run, and nothing else. Unlike `setFinishPolicy`, which
     * also acts, this only records a preference - a task already talking in a conversation is not
     * moved out of it, because moving an agent mid-thought is the one thing sharing must never do.
     */
    /**
     * ⚠️ Runs git, and only when asked. See the note in protocol.ts for why it is not on `task.get`.
     */
    'task.pendingWork': (p) => pendingWorkFor(p.id),
    'task.diffSummary': (p) => diffSummaryFor(p.id),
    'task.diffFile': (p) => diffFileFor(p.id, p.path),
    'task.commitDiff': (p) => commitDiffFor(p.id, p.sha),
    'task.commitFile': (p) => commitFileFor(p.id, p.sha, p.path),
    /** ⛔ One call, because the rung it writes decides both the landing and the next turn's prompt. */
    'task.commitConversation': (p) => commitConversation(p.id, p.finishPolicy),
    /** ⛔ The clean-tree half of the same decision: no turn, the tool lands it. See `landConversation`. */
    'task.landConversation': (p) => landConversation(p.id, p.finishPolicy),
    'task.setSessionSharing': (p) => updateTask(p.id, { sessionSharing: p.sessionSharing }),
    'task.setCompletionMode': (p) => updateTask(p.id, { completionMode: p.completionMode }),
    /**
     * ⚠️ Records a permission and sends nothing. The cache clock reads it on its next tick and
     * decides on its own terms; see the note on the protocol type.
     */
    'task.setAutoCompact': (p) => updateTask(p.id, { autoCompact: p.autoCompact }),
    'task.setStatsExcluded': (p) => setTaskStatsExcluded(p.id, p.excluded),
    'task.setObjective': (p) => updateTask(p.id, { objective: p.objective }),
    /**
     * ⚠️ Next run only. Nothing is sent into a session that is already talking — see the note on the
     * protocol type for what a mid-conversation switch costs.
     */
    'task.setModel': (p) => {
      const task = requireTask(p.id)
      let model: string | undefined
      let modelPolicy: 'auto' | 'inherit' | undefined

      if (p.modelPolicy !== undefined) {
        modelPolicy = p.modelPolicy ?? undefined
      }

      if (p.model !== undefined) {
        if (p.model === '__inherit__' || p.model === 'policy:inherit') {
          model = undefined
          modelPolicy = 'inherit'
        } else if (p.model === '__auto__' || p.model === 'policy:auto') {
          model = undefined
          modelPolicy = 'auto'
        } else if (p.model) {
          model = p.model
          if (p.modelPolicy === undefined) {
            modelPolicy = undefined
          }
        } else {
          model = undefined
          if (p.modelPolicy === undefined) {
            modelPolicy = 'inherit'
          }
        }
      } else {
        model = task.constraints.model
        if (p.modelPolicy === undefined) {
          modelPolicy = task.constraints.modelPolicy
        }
      }

      // ⛔ Through the same door a filing goes through. The adapter has to be known before a model
      // can be checked, and `checkConstraints` is where that argument already lives.
      const constraints = checkConstraints({
        ...task.constraints,
        model,
        modelPolicy,
        ...(p.effort !== undefined ? (p.effort ? { effort: p.effort } : { effort: undefined }) : {})
      })
      if (!model) delete constraints.model
      if (!modelPolicy) delete constraints.modelPolicy
      if (p.effort !== undefined && !p.effort) delete constraints.effort
      return updateTask(p.id, { constraints })
    },
    'task.setWorker': (p) => {
      const task = requireTask(p.id)
      if (!p.workerId) {
        // Reassigned to auto / scheduler choice: clear workerId, adapterId, model, effort, modelPolicy, workerIds
        const { workerId, adapterId, model, effort, modelPolicy, workerIds, ...rest } = task.constraints
        const isResting = !['running', 'assigned'].includes(task.status)
        voidQuestionsForTask(task.id, 'task reassigned')
        if (isResting) setHoldReason(task.id, null)
        return updateTask(p.id, {
          constraints: rest,
          ...(isResting ? { assigneeHint: null } : {})
        })
      }
      const worker = requireWorker(p.workerId)
      if (task.constraints.workerId !== worker.id) {
        voidQuestionsForTask(task.id, 'task reassigned')
      }
      // If the adapter changed, clear an *old* model and effort because they belong to the previous
      // adapter. A reassign control supplies its new choice in this very RPC: a scheduler tick can
      // land after either RPC, so setting the worker and then the model used to let the new account's
      // default model start a run before the explicit choice arrived.
      const adapterChanged = task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId
      const hasModelChoice = p.model !== undefined || p.modelPolicy !== undefined || p.effort !== undefined
      const model = hasModelChoice ? (p.model ?? undefined) : (adapterChanged ? undefined : task.constraints.model)
      const effort = hasModelChoice ? (p.effort ?? undefined) : (adapterChanged ? undefined : task.constraints.effort)
      const modelPolicy = hasModelChoice
        ? (p.modelPolicy ?? (p.model ? undefined : 'inherit'))
        : (adapterChanged ? 'inherit' : (task.constraints.modelPolicy ?? (task.constraints.model ? undefined : 'inherit')))
      const { workerIds: _workerIds, ...baseConstraints } = task.constraints
      const constraints = checkConstraints({
        ...baseConstraints,
        workerId: worker.id,
        adapterId: worker.adapterId,
        model,
        effort,
        modelPolicy
      })
      if (!model) {
        delete constraints.model
      }
      if (!effort) {
        delete constraints.effort
      }
      if (!constraints.modelPolicy) delete constraints.modelPolicy
      delete constraints.workerIds
      const isResting = !['running', 'assigned'].includes(task.status)
      if (isResting) setHoldReason(task.id, null)
      return updateTask(p.id, {
        constraints,
        ...(isResting ? { assigneeHint: worker.id } : {})
      })
    },
    'task.setPriority': (p) => updateTask(p.id, { priority: p.priority }),
    'task.land': async (p) => {
      const result = await relandTask(p.id)
      return { task: requireTask(p.id), landed: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    'task.resolveConflict': async (p) => {
      const result = await resolveConflictOnTask(p.id)
      return { task: requireTask(p.id), started: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    'task.resolveRetry': async (p) => {
      // The hold reason is the classifier's evidence. `task.setWorker` normally clears it for a
      // resting task, which made a reassigned retry look like an unexplained generic retry.
      const holdReason = requireTask(p.id).holdReason
      if (p.workerId !== undefined) {
        reassignForResolveRetry(p.id, {
          workerId: p.workerId,
          model: p.model ?? null,
          modelPolicy: p.modelPolicy ?? null,
          effort: p.effort ?? null
        })
        setHoldReason(p.id, holdReason)
      }
      const result = await resolveRetryOnTask(p.id)
      return { task: requireTask(p.id), started: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    'task.resolveChecks': async (p) => {
      const result = await resolveChecksOnTask(p.id)
      return { task: requireTask(p.id), started: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    'task.resolveCommit': async (p) => {
      const result = await resolveCommitOnTask(p.id)
      return { task: requireTask(p.id), started: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
    },
    'task.message': (p) => {
      const id = addMessage(p.id, 'human', p.text, null, p.attachmentIds ?? [])
      // ⛔ Delivered into the live session if there is one. That is `0.1·C` and it refreshes the TTL;
      // the same note delivered by restarting the task is `2.0·C` plus everything the successor has
      // to rediscover about the branch. Plan §18.4.
      //
      // ⚠️ The id comes back from `addMessage` rather than from `lastMessageId`. This row now
      // binds attachments, and a second insert landing between the two calls would hand this
      // note's delivery — and its images — to somebody else's message.
      deliverToLiveSession(p.id, id, p.text)
      // ⛔ And a task that had stopped is started again — same task, same thread, a new run. Without
      // this the note reached a live process and produced nothing anybody could see: no run, no
      // metering, no status, no landing. See `continueTask`.
      return { ok: true as const, outcome: continueTask(p.id) }
    },
    'task.cancel': (p) =>
      cancelTask(p.id, {
        ...(p.restingState ? { restingState: p.restingState } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.hard ? { hard: p.hard } : {}),
        requestedBy: 'human'
      }),
    'task.resume': (p) => {
      voidQuestionsForTask(p.id, 'task resumed')
      return resumeTask(p.id)
    },
    /**
     * A person overruling the 92% water mark on one task.
     *
     * ⛔ **The deadline is taken from what the scheduler already measured, not re-derived here.**
     * `holdUntil` is the reset of the very window that refused this task's dispatch, written by the
     * gate that refused it; computing a second answer in this handler would be a second chance to
     * name a different window, and the two would drift the first time the pool logic changed.
     *
     * ⚠️ It answers honestly when the grant changes nothing. A task nobody is holding on quota, or
     * one parked at `paused_quota` — which is a *preempted* run and comes back with **Resume**, not
     * with this — is told so rather than being left to look unstuck.
     */
    'task.overrideQuota': (p) => {
      const before = requireTask(p.id)
      if (p.preemptionAction) {
        const warning = before.quotaPreemptWarning
        if (!warning || before.status !== 'running') {
          throw new Error('this task has no live preemption decision')
        }
        if (p.preemptionAction === 'compact' && !warning.canCompact) {
          throw new Error('this worker cannot compact its conversation')
        }
        const task = setQuotaPreemptWarning(p.id, { ...warning, action: p.preemptionAction })
        log.info(`t${task.seq}: preemption action changed by hand to ${p.preemptionAction}`)
        return {
          task,
          until: warning.resumeAt,
          applies: true,
          reason: `will ${p.preemptionAction} when the preemption countdown expires`
        }
      }
      if ('until' in p && p.until === null) {
        return {
          task: setQuotaOverride(p.id, null),
          until: null,
          applies: false,
          reason: 'the override is withdrawn; the usual quota gate applies again'
        }
      }
      // ⛔ The window the hold was written from, then the worker's own reset, then an hour. Each
      // fallback is one step further from a measurement, and the last is honest about being a
      // duration rather than a boundary: with nothing readable, "an hour" at least expires.
      const pinned = before.constraints.workerId ? getWorker(before.constraints.workerId) : null
      const until =
        p.until ??
        before.quotaPreemptWarning?.resumeAt ??
        before.holdUntil ??
        before.notBefore ??
        (pinned ? (windowResetsAt(pinned.id)?.at ?? null) : null) ??
        (before.assignee ? (windowResetsAt(before.assignee)?.at ?? null) : null) ??
        Date.now() + QUOTA_OVERRIDE_FALLBACK_MS
      const task = setQuotaOverride(p.id, until)
      let resumed = false
      if (before.status === 'paused_quota') {
        resumeTask(p.id)
        resumed = true
      }
      const applies =
        (before.status === 'ready' && before.holdUntil !== null && before.holdUntil > Date.now()) ||
        resumed ||
        before.quotaPreemptWarning !== null
      const reason = applies
        ? `${before.holdReason ?? (resumed ? 'preemption paused_quota' : 'the quota gate')} — overridden until ${new Date(until).toISOString()}`
        : 'nothing is holding this task on quota right now; the override is recorded and will ' +
          'apply if something does before it expires'
      log.info(
        `t${task.seq}: quota water mark overridden by hand until ${new Date(until).toISOString()}` +
          (applies ? ` (was ${before.status}: ${before.holdReason ?? 'paused on quota'})` : ' (not currently held on quota)')
      )
      let gatePercent = QUOTA_HIGH_WATER
      const targetWorker = pinned ?? (before.assignee ? getWorker(before.assignee) : null)
      if (targetWorker) {
        const q = lastQuota(targetWorker.id)
        if (q) {
          for (const win of q.windows) {
            if (win && !windowExpired(win) && win.percent >= windowHighWater(win)) {
              gatePercent = windowHighWater(win)
              break
            }
          }
        }
      }
      addMessage(p.id, 'system', `Quota gate (${gatePercent}%) overridden until ${clockTime(until)}`, null, [], {
        detail:
          `A person overrode the ${gatePercent}% quota gate for this task until ` +
          `${new Date(until).toISOString()}.${resumed ? ' Resumed to continue to completion.' : ''} ${reason}`
      })
      return { task: requireTask(p.id), until, applies, reason }
    },
    'task.resolve': (p) => resolveTask(p.id, p.note),
    'task.deleteCheck': (p) => deleteBlockers(p.id),
    // ⛔ Human-only. There is deliberately no worker-tier equivalent: an agent that can delete the
    // record of its own failed work is an agent that can hide it.
    'task.delete': (p) => deleteTask(p.id, { ...(p.hard ? { hard: true } : {}), ...(p.force ? { force: true } : {}) }),
    'task.restore': (p) => restoreTask(p.id),
    'task.promote': (p) => promoteDraft(p.id),
    //
    // ⛔ `requireTask` on both ends and the cycle check live in `tasks.ts`, so the error a person
    // sees here is the same one an agent filing a task with `depends_on` sees. There is one rule
    // about what a legal edge is, and it is not written twice.
    'task.addDependency': (p) => ({
      task: attachDependency(p.id, p.dependsOn),
      dependencies: dependenciesFor(p.id)
    }),
    'task.removeDependency': (p) => ({
      task: detachDependency(p.id, p.dependsOn),
      dependencies: dependenciesFor(p.id)
    }),
    'approval.list': () => openApprovals(),
    'approval.request': async (p) => {
      // ⚠️ The permission-prompt-tool payload shape is not documented. Log what actually arrives so
      // the real contract can be read off a live run rather than guessed at twice. See HANDOFF R6.
      if (p.raw) log.info(`permission-prompt payload: ${p.raw.slice(0, 2000)}`)
      const decision = await requestApproval({
        sessionId: p.sessionId,
        origin: p.origin,
        tool: p.tool,
        target: p.target,
        summary: p.summary
      })
      return decision === 'deny'
        ? { decision: 'deny' as const, reason: 'Warmstart policy or the operator declined.' }
        : { decision: 'allow' as const }
    },
    'approval.answer': (p) => answerApproval(p.id, p.decision, 'human'),
    'approval.rules': (p) => listRules(p.projectId ?? null),
    'approval.addRule': (p) =>
      addRule({ projectId: p.projectId ?? null, text: p.text, effect: p.effect }),
    'approval.removeRule': (p) => {
      removeRule(p.id)
      return { ok: true as const }
    },
    'question.ask': async (p) =>
      await askQuestion({
        sessionId: p.sessionId,
        origin: p.origin,
        kind: p.kind,
        question: p.question,
        ...(p.header ? { header: p.header } : {}),
        ...(p.options ? { options: p.options } : {})
      }),
    'question.list': () => openQuestions(),
    'question.forTask': (p) => questionsForTask(p.taskId),
    'question.answer': (p) => {
      const answered = answerQuestion(p.id, { optionIds: p.optionIds ?? [], text: p.text ?? null })
      // ⛔ **A parked question's answer needs a run to arrive in.** A live question resolves into the
      // tool call the agent is holding and the work carries straight on; a parked one only lands on
      // the thread, and nothing was scheduled to read it — so the operator answered, watched nothing
      // happen, and had to send a second message to start the work again. For an adapter with no
      // MCP *every* question is parked (t63, 2026-08-30), which made that the only path there is.
      //
      // ⚠️ Only from `awaiting_human`. An operator who paused or stopped the task while the question
      // was open has put it somewhere deliberate, and an answer is not a request to overrule that.
      if (answered.parkedAt && answered.taskId) {
        const task = getTask(answered.taskId)
        if (task?.status === 'awaiting_human') continueTask(task.id)
      }
      return answered
    },
    'resource.list': () => allAvailability(),
    // ⛔ Read-only, both of them. Nothing here may delete a log file: the one thing an operator
    // needs from a record of an unattended fleet is that it is still there afterwards.
    // ⛔ Read, dismiss, and create a task. Nothing here removes a workspace, discards a stash or
    // deletes a branch: the whole point of the list is that the work outlives the run that made it.
    'conversation.list': (p) =>
      listConversations({
        ...(p?.projectId ? { projectId: p.projectId } : {}),
        ...(p?.limit ? { limit: p.limit } : {})
      }),
    'looseend.list': () => scanLooseEnds(),
    'looseend.retire': async (p) => {
      const project = requireProject(p.projectId)
      return retireStrandedBranch(project, p.branch, policyFor(project).landingTarget)
    },
    'looseend.delete': async (p) => {
      const project = requireProject(p.projectId)
      return deleteUnlandedBranch(project, p.branch, policyFor(project).landingTarget)
    },
    'looseend.cleanup': async (p) => {
      requireProject(p.projectId)
      return cleanUpMergedBranch(p.projectId, p.branch)
    },
    'looseend.checkMerged': () => reconcilePullRequestDeliveries(),
    'delivery.pending': () => pendingDeliveries(),
    'looseend.dismiss': (p) => {
      dismissLooseEnd(p.id)
      return { ok: true as const }
    },
    'looseend.reclaim': (p) => {
      const end = p
      const task = createTask({
        title:
          `Reclaim ${end.workspacePath}: ${end.summary}. Inspect what is there, finish it or ` +
          'discard it deliberately, and land what should be landed. Do not delete work you cannot ' +
          'account for.',
        projectId: end.projectId,
        priority: 'P2',
        createdBy: { kind: 'human' }
      })
      log.info(`t${task.seq} filed to reclaim ${end.workspacePath}`)
      return task
    }
  }
}
