import type {
  AdapterInfo,
  CostReport,
  DoctorReport,
  ModelOptions,
  RpcMethod,
  RpcParams,
  RpcResult,
  Settings,
  Worker
} from '@shared/protocol.js'
import { canWork } from '@shared/protocol.js'
import type { ChildDefaults, Task, TaskConstraints } from '@shared/tasks.js'
import { resolveAutoCompact, resolveCompletionMode, windowHighWater, windowsForPool } from '@shared/tasks.js'
import { existsSync } from 'node:fs'
import { adapter, adapters } from './adapters/index.js'
import { deleteReview, reviewsForTask } from './review.js'
import { cancelReview, requestReview, reviewEligibility } from './reviewer.js'
import { attachmentBytes, createAttachment, createFolderAttachment, requireAttachment } from './attachments.js'
import {
  createWorker,
  getWorker,
  listWorkers,
  creditsDiscrepancy,
  noteCreditsDiscrepancyReported,
  setWorkerCreditsIntent,
  refreshIdentity,
  reorderWorkers,
  requireWorker,
  retireWorker,
  modelRoutingActive,
  routableModelsFor,
  updateWorker
} from './workers.js'
import { accountUnavailability } from './eligibility.js'
import { dispatchCountsByPair, routingDecisions } from './routingdecisions.js'
import type { ModelReport, ModelReportRow, VelocityReport } from '@shared/routing.js'
import { paceFactors, paceFor, paceValue } from './pace.js'
import { qualityReport, reviewQueue, ungradedTasks } from './quality.js'
import { cancelBatch, currentBatch, startBatch } from './gradebatch.js'
import { statisticsReport } from './statistics.js'
import { weights, WEIGHT_FORMULAS } from './objective.js'
import { lastQuota, lastQuotaReading, probeWorker, refreshNow, windowExpired } from './quota.js'
import { benchmarkPrior } from './benchmarks.js'
import { fitnessFor } from './fitness.js'
import { emit } from './events.js'
import {
  backscroll,
  closeSession,
  getSession,
  listSessions,
  resizeSession,
  sessionsForWorker,
  sessionsAndWarmConversationsForWorker,
  spawnSession,
  writeSession
} from './sessions.js'
import { costModel, costModels } from './costmodel.js'
import { requestShutdown } from './lifecycle.js'
import { paths } from './paths.js'
import {
  addProject,
  archiveProject,
  getProject,
  listProjects,
  policyFor,
  reloadProject,
  requireProject,
  setProjectChecks,
  setProjectPolicy,
  writeStarterConfig
} from './projects.js'
import { proposeChecks } from './projectstack.js'
import {
  createProject,
  inspectProjectDirectory,
  proposeProjectDocs,
  workspaceRootReport
} from './projectsetup.js'
import { flowWorkspaces } from './flow.js'
import { ensurePool, retireStrandedBranch } from './worktrees.js'
import {
  addMessage,
  attachDependency,
  blockedDependentsOf,
  createTask,
  dependentsOf,
  detachDependency,
  getTask,
  listTasks,
  messagesFor,
  pageTasks,
  promoteDraft,
  requireTask,
  setQuotaOverride,
  setStatus,
  runForSession,
  runsFor,
  setTaskHandoff,
  setTaskStatsExcluded,
  updateTask
} from './tasks.js'
import { taskCommits } from './taskcommits.js'
import { cancelTask, deleteBlockers, deleteTask, restoreTask, resumeTask } from './cancel.js'
import {
  addRule,
  answerApproval,
  listRules,
  openApprovals,
  removeRule,
  requestApproval
} from './approvals.js'
import { answerQuestion, askQuestion, openQuestions, questionsForTask, voidQuestionsForTask } from './questions.js'
import {
  addSplitDependency,
  applySplit,
  childrenOf as splitChildrenOf,
  validateSplit
} from './split.js'
import { allAvailability } from './resources.js'
import { activityFor } from './activity.js'
import {
  completeTask,
  parkForHuman,
  continueTask,
  deliverToLiveSession,
  QUOTA_HIGH_WATER,
  QUOTA_OVERRIDE_FALLBACK_MS,
  resolveTask,
  tick
} from './scheduler.js'
import { promptFor } from './prompt.js'
import { atCapacity, retainedReservations } from './residency.js'
import {
  commitConversation,
  landConversation,
  pendingWorkFor,
  relandTask,
  resolveChecksOnTask,
  resolveCommitOnTask,
  resolveConflictOnTask,
  resolveRetryOnTask
} from './resolutions.js'
import { controllerReport, drainConsults, enqueueConsult } from './controller.js'
import { gateQuestion, riskOf } from './judgment.js'
import { chatHistory, clearChat, sendChat } from './chat.js'
import { costFactors, estimateTask } from './estimator.js'
import { recentClockEvents, remainingTokens, reserveState } from './reserve.js'
import { decide, medianHumanLatencyMs } from './cacheclock.js'
import { lastRateLimit, windowResetsAt } from './quota.js'
import { DEFAULT_OBJECTIVE, parseObjective, resolveObjective } from './objective.js'
import { setSetting, settings } from './settings.js'
import { lastSpend, refreshCreditStatus } from './spend.js'
import { compactionsForTask } from './compaction.js'
import { listConversations } from './conversations.js'
import { log, logFiles, recentLog } from './log.js'
import { dismissLooseEnd, resolveFinishPolicy, scanLooseEnds } from './finish.js'
import { resolveSessionSharing } from './sharing.js'
import { errorMessage } from '@shared/errors.js'
import { apiAgent } from './api/agent.js'
import { apiProjects } from './api/projects.js'
import { apiQuality } from './api/quality.js'
import { apiTasks } from './api/tasks.js'
import { apiWorkers } from './api/workers.js'

export type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>
export type Api = { [M in RpcMethod]: Handler<M> }

/**
 * The prerequisites of a task, as rows rather than ids, with deleted ones dropped.
 *
 * ⚠️ Shared by `task.get` and the two edge methods so the pane redraws from exactly what the detail
 * fetch would have given it. A list assembled twice is a list that disagrees with itself.
 */
function dependenciesFor(taskId: string): Task[] {
  const task = getTask(taskId)
  if (!task) return []
  return (task.dependsOn || [])
    .map((id) => getTask(id))
    .filter((t): t is Task => !!t && t.deletedAt === null)
}

/** "26825 minutes" is technically true and useless. Say it the way a person would. */
function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

/**
 * Decide what happens to a task an agent just filed.
 *
 * ⛔ The rule-based assessment is what runs on every filing, and it is free. Only what it returns as
 * `controller` costs a turn - the point of a gate is to contain task explosion, not to add a turn to
 * every instance of it. Plan §7.2.
 */
function admitAgentTask(taskId: string): void {
  const task = requireTask(taskId)
  const risk = riskOf(task)

  if (risk.gate === 'auto') {
    addMessage(task.id, 'system', `Admitted automatically: ${risk.why}.`)
    promoteDraft(task.id)
    return
  }
  if (risk.gate === 'human') {
    addMessage(task.id, 'system', `Held for you: ${risk.why}.`)
    updateTask(task.id, { assigneeHint: 'human' })
    setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `an agent filed this and it needs your decision: ${risk.why}`
    })
    return
  }

  addMessage(task.id, 'system', `Held for the controller to review: ${risk.why}.`)
  // ⚠️ It stays a draft while the question is open. A draft dispatches nothing and holds nothing, so
  // the cost of waiting - including waiting forever, if there is no controller - is only time.
  enqueueConsult({ kind: 'gate', subjectId: task.id, question: gateQuestion(task, risk.why) })
}

export interface ApiContext {
  version: string
  startedAt: number
  port: number
}

function apiHandlers(ctx: ApiContext): Api {
  const uptime = () => Date.now() - ctx.startedAt

  return {
    health: () => ({ ok: true as const, version: ctx.version, uptimeMs: uptime() }),

    'adapter.list': (): AdapterInfo[] => adapters().map((a) => a.info),
    'adapter.detect': () => Promise.all(adapters().map((a) => a.detect())),

    // ⚠️ `lastQuotaReading`, not `lastQuota`: this is the display path, and it shows the newest
    // reading that has windows rather than the newest *attempt*. Nothing here gates anything.
    'fleet.list': () =>
      listWorkers().map((worker) => {
        const liveSessions = sessionsForWorker(worker.id)
        const sessions = sessionsAndWarmConversationsForWorker(worker.id)
        return {
          worker,
          quota: lastQuotaReading(worker.id),
          sessions,
          // ⛔ Both gates called here rather than reimplemented in the renderer. See the fields'
          // notes in protocol.ts: together these are what "ready" means everywhere in the daemon.
          unavailable: accountUnavailability(worker),
          atCapacity: atCapacity(
            liveSessions,
            worker.maxConcurrent,
            null,
            retainedReservations(worker.id, liveSessions)
          )
        }
      }),

    'worker.create': async (p) => {
      const worker = createWorker(p)
      // Identity is read back immediately so the UI can say whose account this is, or say plainly
      // that nobody is logged in yet - which is the normal state right after commissioning.
      return await refreshIdentity(worker.id)
    },
    'worker.update': (p) => {
      const { id, ...patch } = p
      // ⛔ Checked at the door, exactly as a task's own pin is. A default is worse than a pin when it
      // is wrong: nobody chose it at the moment of dispatch, so an invalid one fails *every* task
      // routed to this account with an error about a model the operator set days ago and forgot.
      checkWorkerDefaults(requireWorker(id).adapterId, patch)
      return updateWorker(id, patch)
    },
    'worker.setCreditsIntent': (p) => setWorkerCreditsIntent(p.id, p.asked),
    'worker.reorder': (p) => reorderWorkers(p.ids),
    'worker.retire': (p) => retireWorker(p.id),
    // ⭐ A person pressing Probe wants a number, not a re-read of a cache that may be weeks old.
    // `refreshNow` drives the adapter's own usage command into a TUI and then reads the result;
    // for an adapter that declares none it falls straight through to the file read, so this is
    // never worse than what it replaced.
    'worker.probe': async (p) => {
      // ⛔ `lift` — a person pressing this is the one signal that clears a dispatch quarantine.
      // The background sweep re-reads identity too and deliberately does not, because an expired
      // subscription answers `auth status` exactly as a live one does.
      await refreshIdentity(p.id, true)
      // ⛔ Claim the same refresh ledger as the dispatch gate and poller. Calling `refreshUsage`
      // directly left this manual TUI invisible: the next scheduler tick started a second probe,
      // and `spawnSession` correctly rejected it as already refreshing. The resulting failed
      // attempt overwrote the fresh baseline the operator had just requested.
      const w = requireWorker(p.id)
      const info = adapter(w.adapterId).info
      if (info.usageRefresh) {
        await refreshNow(p.id, 0)
      } else {
        await probeWorker(p.id).catch((err: unknown) => {
          log.warn(`quota probe failed for ${p.id}:`, err)
        })
      }
      const reading =
        lastQuotaReading(p.id) ??
        lastQuota(p.id) ?? {
          workerId: p.id,
          windows: [],
          sampledAt: Date.now(),
          source: 'unknown',
          ageMs: 0,
          stale: true
        }
      emit({ type: 'quota.changed', quota: reading })
      return reading
    },

    'costmodel.list': () => costModels().map((m) => m.summary()),

    'model.options': (): ModelOptions[] =>
      adapters().flatMap((a) => {
        try {
          const cm = costModel(a.info.policy.costModelId)
          const pools = cm.pools()
          return [
            {
              adapterId: a.info.id,
              costModelId: cm.id,
              selectableEffort: a.info.capabilities.selectableEffort,
              models: cm.modelIds().map((id) => {
                const spec = cm.modelSpec(id)
                return {
                  id,
                  contextWindow: spec?.context_window ?? null,
                  effortLevels: spec?.effort_levels ?? [],
                  ...(spec?.pool ? { pool: spec.pool } : {})
                }
              }),
              ...(pools.length > 0 ? { pools } : {})
            }
          ]
        } catch (err) {
          // ⚠️ One adapter naming a cost model that will not load must not blank the picker for the
          // other three. The form falls back to "whatever the worker defaults to", which is exactly
          // what happened before there was a picker at all.
          log.warn(`no model list for adapter '${a.info.id}':`, err)
          return []
        }
      }),

    // ⛔ Counted before the request is made: once the wind-down starts, the answer to "what
    // did this end?" is zero, and that is the one number the caller needs to report.
    'daemon.shutdown': () => {
      const liveSessions = listSessions().filter((s) => s.purpose === 'work').length
      const stopping = requestShutdown('the app asked')
      return { stopping, liveSessions }
    },

    'doctor.run': async (): Promise<DoctorReport> => {
      const detections = await Promise.all(adapters().map((a) => a.detect()))
      const warnings: string[] = []

      const workers = await Promise.all(
        listWorkers().map(async (w) => {
          const rootExists = existsSync(w.isolationRoot)
          const identity = await adapter(w.adapterId).probeIdentity(w.isolationRoot)
          const quota = lastQuota(w.id)
          if (!rootExists) warnings.push(`${w.label}: isolation root is missing`)
          if (identity.loggedIn === false) warnings.push(`${w.label}: not logged in`)
          if (!quota || quota.windows.length === 0) {
            warnings.push(
              `${w.label}: no quota reading yet` + (quota?.error ? ` (${quota.error})` : '')
            )
          } else if (quota.stale) {
            warnings.push(
              `${w.label}: quota reading is ${describeAge(quota.ageMs)} old - ` +
                'treat it as unknown, not as current'
            )
          }
          // ⛔ **The gap between what was asked for and what the vendor is doing.** An operator who
          // turned on "spend credits past the plan limit" for this account, and whose account is not
          // in fact spending them, has runs still being wrapped up at the limit and no way to see
          // why from the board. ⚠️ Raised here rather than as a `Question`, because a question needs
          // a session to hang on and this is a property of the *account* — and because Doctor is
          // already where "we probed, and here is what does not add up" lives.
          const mismatch = creditsDiscrepancy(w)
          if (mismatch) {
            warnings.push(`${w.label}: ${mismatch.replace(/\*\*/g, '')}`)
            noteCreditsDiscrepancyReported(w.id)
          }
          return {
            workerId: w.id,
            label: w.label,
            isolationRootExists: rootExists,
            loggedIn: identity.loggedIn,
            lastQuota: quota,
            ...(identity.raw ? { note: identity.raw.slice(0, 400) } : {})
          }
        })
      )

      for (const d of detections) {
        if (!d.found) warnings.push(`${d.adapterId}: CLI not found on PATH`)
        else if (d.error) warnings.push(`${d.adapterId}: ${d.error}`)
      }

      // ⛔ Said out loud, because a capability table is easy to write from documentation and
      // expensive to be wrong about. An operator deciding whether to trust unattended work on an
      // adapter should be told which claims were exercised and which were read.
      for (const a of adapters()) {
        const v = a.info.verification
        if (v.level !== 'measured') {
          warnings.push(
            `${a.info.label}: its capabilities are documented, not measured (${v.asOf}). ` +
              'Treat unattended work on it as unproven.'
          )
        }
        const inUse = listWorkers().some((w) => w.adapterId === a.info.id)
        if (a.info.capabilities.metering === 'none' && inUse) {
          warnings.push(
            `${a.info.label}: its work cannot be metered at all, so runs on it cost an unknown ` +
              'amount rather than nothing.'
          )
        } else if (a.info.capabilities.metering === 'stream' && inUse) {
          // ⚠️ Worth saying, because it is a real difference in what survives a crash: a transcript
          // can be re-read afterwards, a stream cannot.
          warnings.push(
            `${a.info.label}: metered from its live stream rather than a transcript, so a run whose ` +
              'daemon restarted mid-flight loses the turns nobody was attached for.'
          )
        }
        if (!a.info.capabilities.mintsSessionId && listWorkers().some((w) => w.adapterId === a.info.id)) {
          warnings.push(
            `${a.info.label}: its orphaned processes will not be stopped, because it accepts no ` +
              'session id and so cannot be proved to own one. Stop them by hand after a crash.'
          )
        }
      }
      if (listWorkers().length === 0) warnings.push('No workers commissioned yet.')

      return {
        generatedAt: Date.now(),
        daemon: {
          version: ctx.version,
          pid: process.pid,
          port: ctx.port,
          uptimeMs: uptime(),
          dbPath: paths.db
        },
        adapters: detections,
        workers,
        costModels: costModels().map((m) => m.summary()),
        warnings
      }
    },

    'session.list': () => listSessions(),
    'session.spawn': (p) => {
      requireWorker(p.workerId)
      return spawnSession(p)
    },
    'session.write': (p) => {
      writeSession(p.id, p.data)
      return { ok: true as const }
    },
    'session.resize': (p) => {
      resizeSession(p.id, p.cols, p.rows)
      return { ok: true as const }
    },
    'session.close': (p) => {
      closeSession(p.id)
      return { ok: true as const }
    },
    'session.backscroll': (p) => ({ data: backscroll(p.id) }),

    // ---- projects ----------------------------------------------------------------------
    'project.list': () => listProjects(),
    'project.add': (p) => addProject(p),
    'project.inspect': (p) => inspectProjectDirectory(p),
    'project.workspaceRoot': (p) => workspaceRootReport(p.root, p.workspaceRoot),
    'project.docTemplates': (p) => ({ docs: proposeProjectDocs(p) }),
    'project.create': (p) => createProject(p),
    'project.reload': (p) => reloadProject(p.id),
    'project.archive': (p) => archiveProject(p.id),
    'project.writeConfig': (p) => ({ path: writeStarterConfig(p.id) }),
    // ⛔ Resolved here, never in the renderer — see the method's note in protocol.ts.
    'project.flow': (p) => flowWorkspaces(p.projectId),

    // ---- tasks -------------------------------------------------------------------------
    'task.list': (p) => listTasks(p ?? {}),
    'task.page': (p) => pageTasks(p ?? {}),
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
        task,
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
    // ---- quality review -----------------------------------------------------------------
    // ⛔ Two calls, and the split is the point. `review.eligibility` is free and answers *before*
    // anybody presses anything — no peer, or no recoverable diff, are both states the button has to
    // state rather than discover. `review.request` spends a turn.
    'review.eligibility': (p) => reviewEligibility(p.taskId),
    'review.request': (p) => requestReview(p.taskId, p.workerId),
    'review.cancel': (p) => {
      const target = p.reviewId ?? p.taskId
      if (!target) return { ok: false, reason: 'missing reviewId or taskId' }
      return cancelReview(target)
    },
    'review.delete': (p) => {
      if (!p.reviewId) return { ok: false, reason: 'missing reviewId' }
      return deleteReview(p.reviewId)
    },

    'task.create': (p) =>
      createTask({
        ...p,
        ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {})
      }),

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
      const { id, ...patch } = p
      if (patch.constraints) {
        patch.constraints = checkConstraints(patch.constraints)
      }
      return updateTask(id, patch)
    },
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
      const task = updateTask(p.id, { finishPolicy: p.finishPolicy })
      // ⚠️ Every rung that moves the work somewhere, not just the one that pushes. Choosing
      // `commit-and-merge` on a parked task is as much a decision to land it as `commit-and-push` is.
      const wantsLanding =
        p.finishPolicy === 'commit-and-merge' ||
        p.finishPolicy === 'commit-and-push' ||
        p.finishPolicy === 'pull-request'
      if (!wantsLanding || before.status !== 'awaiting_human' || !task.branch) {
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
        // Reassigned to auto / scheduler choice: clear workerId, adapterId, model, effort, modelPolicy
        const { workerId, adapterId, model, effort, modelPolicy, ...rest } = task.constraints
        const isResting = !['running', 'assigned'].includes(task.status)
        voidQuestionsForTask(task.id, 'task reassigned')
        return updateTask(p.id, {
          constraints: rest,
          ...(isResting ? { assigneeHint: null } : {})
        })
      }
      const worker = requireWorker(p.workerId)
      if (task.constraints.workerId !== worker.id) {
        voidQuestionsForTask(task.id, 'task reassigned')
      }
      // If the adapter changed, clear model and effort because they belong to the previous adapter
      const adapterChanged = task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId
      const modelPolicy = adapterChanged
        ? 'inherit'
        : (task.constraints.modelPolicy ?? (task.constraints.model ? undefined : 'inherit'))
      const constraints = checkConstraints({
        ...task.constraints,
        workerId: worker.id,
        adapterId: worker.adapterId,
        model: adapterChanged ? undefined : task.constraints.model,
        effort: adapterChanged ? undefined : task.constraints.effort,
        modelPolicy
      })
      if (adapterChanged) {
        delete constraints.model
        delete constraints.effort
      }
      if (!constraints.modelPolicy) delete constraints.modelPolicy
      const isResting = !['running', 'assigned'].includes(task.status)
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
      addMessage(
        p.id,
        'system',
        `A person overrode the ${gatePercent}% quota gate for this task until ` +
          `${new Date(until).toISOString()}.${resumed ? ' Resumed to continue to completion.' : ''} ${reason}`
      )
      return { task: requireTask(p.id), until, applies, reason }
    },
    'task.resolve': (p) => resolveTask(p.id, p.note),
    'task.deleteCheck': (p) => deleteBlockers(p.id),
    // ⛔ Human-only. There is deliberately no worker-tier equivalent: an agent that can delete the
    // record of its own failed work is an agent that can hide it.
    'task.delete': (p) => deleteTask(p.id, { ...(p.hard ? { hard: true } : {}), ...(p.force ? { force: true } : {}) }),
    'task.restore': (p) => restoreTask(p.id),
    'task.promote': (p) => promoteDraft(p.id),

    // ---- dependency edges, added and dropped by hand ---------------------------------------
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

    // ---- approvals ---------------------------------------------------------------------
    'project.proposeChecks': (p) => ({ checks: proposeChecks(requireProject(p.id).root) }),
    'project.setChecks': (p) => setProjectChecks(p.id, p.checks),
    /**
     * ⛔ **The pool follows the policy here, not on some later dispatch.** `poolSize` is only a
     * number in `project.json` until `ensurePool` turns it into worktrees and a Resource capacity,
     * and until 2026-09-01 nothing did that when the operator changed it — `ensurePool` was reachable
     * only from `claimWorkspace` and from the loose-ends scan an Overview load runs. So the width the
     * operator had just chosen was true in the file and false in the Resources panel, for as long as
     * it took something unrelated to happen.
     *
     * ⚠️ **Not the fix for the hold that came with it** — `poolPressure` is. A task filed against a
     * pool that was full at its old size used to be held by a gate reading the stale capacity, and
     * the hold blocked the very dispatch that would have corrected it; that loop was cut by reading
     * the *configured* size in the gate (t91, `9278841`). This is the other half: making the setting
     * true when it is made, rather than when it is next needed.
     *
     * ⚠️ Best-effort, and deliberately unable to fail the setting. The operator's choice is written
     * either way; if git cannot create the worktree the capacity simply stays where it was, the next
     * `claimWorkspace` tries again, and the error is in the log rather than in a dialog over a
     * settings form.
     *
     * ⚠️ Narrowing takes effect here too, because `ensurePool` rebuilds the member list from
     * `1..poolSize`. ⛔ Nothing on disk is removed — deleting a worktree can destroy work — and a
     * claim already held on a member that is no longer one stays valid until its run ends.
     */
    'project.setPolicy': async ({ id, ...patch }) => {
      const project = setProjectPolicy(id, patch)
      if (patch.poolSize !== undefined) {
        try {
          const members = await ensurePool(project)
          log.info(`${project.name}: workspace pool is now ${members.length} member(s)`)
        } catch (err) {
          log.error(`could not resize the workspace pool for ${project.name}:`, err)
        }
      }
      return project
    },

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
        ? { decision: 'deny' as const, reason: 'Multi Agent Controller policy or the operator declined.' }
        : { decision: 'allow' as const }
    },
    'approval.answer': (p) => answerApproval(p.id, p.decision, 'human'),

    // ---- questions ---------------------------------------------------------------------
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
    'approval.rules': (p) => listRules(p.projectId ?? null),
    'approval.addRule': (p) =>
      addRule({ projectId: p.projectId ?? null, text: p.text, effect: p.effect }),
    'approval.removeRule': (p) => {
      removeRule(p.id)
      return { ok: true as const }
    },

    // ---- resources and the loop --------------------------------------------------------
    'resource.list': () => allAvailability(),

    // ---- the log ------------------------------------------------------------------------
    // ⛔ Read-only, both of them. Nothing here may delete a log file: the one thing an operator
    // needs from a record of an unattended fleet is that it is still there afterwards.
    // ---- loose ends ---------------------------------------------------------------------
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
    },

    'log.tail': (p) => recentLog(Math.min(p.limit ?? 500, 2000), p.level ?? 'debug'),
    'log.files': () => ({ directory: paths.logs, files: logFiles() }),

    'settings.get': () => settings(),

    // ⚠️ A partial patch, not a whole object. The renderer sends the one switch the operator threw,
    // so two clients cannot silently overwrite each other's unrelated settings by round-tripping a
    // stale copy of the whole thing.
    'settings.set': (p) => {
      const before = settings()
      let current = before
      for (const [key, value] of Object.entries(p) as Array<[keyof Settings, Settings[keyof Settings]]>) {
        const sanitized = key === 'objective' ? (parseObjective(value) ?? DEFAULT_OBJECTIVE) : value
        current = setSetting(key, sanitized as never)
      }
      // ⭐ **Throwing the switch asks the vendor again.** `spendCreditsPastLimit` is inert without
      // `Worker.credits.enabled`, which is written only by a spend probe — so an operator who turned
      // it on to unstick a task could sit behind a credit status nobody had read since the account
      // was commissioned, watching a switch that changed nothing and being told nothing. The probe
      // reads a config cache on the accounts that have one; it opens no terminal and spends no turn.
      //
      // ⚠️ Fire-and-forget, and only on the false → true edge: nothing here waits on it, a failed
      // probe records itself, and re-saving an unrelated setting must not re-probe the fleet.
      if (current.spendCreditsPastLimit && !before.spendCreditsPastLimit) void refreshCreditStatus()
      return current
    },

    'cost.report': () => {
      const objective = settings().objective ?? DEFAULT_OBJECTIVE
      const live = listSessions()
      return {
        generatedAt: Date.now(),
        objective,
        reserves: listWorkers().map((w) => reserveState(w.id)),
        // Evaluated, not executed: this is the panel that answers "why is that session still open?"
        decisions: live.map((session) => decide(session, { objective })),
        recent: recentClockEvents(30) as CostReport['recent'],
        medianHumanLatencyMs: medianHumanLatencyMs(),
        // ⚠️ Published whole, `learnedFrom` and all. The money fields are measured now, and
        // `null` still means "nothing on this rung could be priced" rather than $0.00. `usdSamples`
        // is its own count on every rung: a key's priced runs are a subset of its runs, so it is
        // routinely far below `samples`. ⛔ Never re-mapped field by field on the way out — a rung
        // that gains a basis the estimator publishes would silently lose it here.
        costFactors: costFactors(),
        // ⚠️ One entry per worker that has ever been probed, and none for the rest — an account
        // nobody has asked is absent here rather than present with a meter at zero. `sampledAt` is
        // the **vendor's** timestamp where the vendor supplied one, which is what makes the age on
        // screen an honest age; `error` carries the last failed probe verbatim.
        spend: listWorkers().flatMap((w) => {
          const reading = lastSpend(w.id)
          return reading
            ? [
                {
                  workerId: w.id,
                  label: w.label,
                  meters: reading.meters,
                  sampledAt: reading.sampledAt,
                  error: reading.error ?? null
                }
              ]
            : []
        }),
        settings: settings(),
        workers: listWorkers().map((w) => {
          const remaining = remainingTokens(w.id)
          const reset = windowResetsAt(w.id)
          const rate = lastRateLimit(w.id)
          return {
            workerId: w.id,
            label: w.label,
            remainingTokens: remaining.tokens,
            remainingBasis: remaining.basis,
            windowResetsAt: reset?.at ?? null,
            windowResetSource: reset?.source ?? null,
            liveRateLimitStatus: rate?.status ?? null
          }
        })
      }
    },
    // ---- analytics -----------------------------------------------------------------------
    // ⛔ Reads, all of them, with one exception: `quality.batch.start` spends turns and is only ever
    // reached by somebody pressing a button. Nothing in a scheduler tick calls it.
    'routing.decisions': (p) => routingDecisions(p?.limit ?? 5, p?.offset ?? 0),
    'routing.velocity': () => velocityReport(),
    'routing.models': () => modelReport(),
    'quality.report': () => qualityReport(),
    'statistics.report': () => statisticsReport(),
    'quality.ungraded': (p) => ungradedTasks(p?.limit ?? 25),
    'quality.queue': (p) =>
      reviewQueue(p?.filter ?? 'none', p?.limit ?? 25, p?.offset ?? 0, p?.gradableOnly ?? false),
    // ⛔ Starts a queue and answers; it does not wait for the grades. See `quality.batch.start`.
    'quality.batch.start': (p) => startBatch(p.count, p.threshold),
    'quality.batch': () => currentBatch(),
    'quality.batch.cancel': () => cancelBatch(),

    'scheduler.tick': () => tick(),

    // ---- the controller ----------------------------------------------------------------
    'controller.report': (p) => controllerReport(p?.limit ?? 40, p?.offset ?? 0),
    // ⚠️ The one RPC that can spend tokens by being called. Nothing in a scheduler tick calls it.
    'controller.drain': () => drainConsults(),

    'task.plan': (p) =>
      createTask({
        title: p.title,
        kind: 'plan',
        projectId: p.projectId ?? null,
        ...(p.prompt ? { prompt: p.prompt } : {}),
        // ⛔ The planner's own settings. Until t182 a plan task took none of these, because it was
        // never dispatched and nothing would have read them; it is a real run now.
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.finishPolicy ? { finishPolicy: p.finishPolicy } : {}),
        ...(p.sessionSharing ? { sessionSharing: p.sessionSharing } : {}),
        ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {}),
        ...(p.dependsOn?.length ? { dependsOn: p.dependsOn } : {}),
        ...(p.attachmentIds?.length ? { attachmentIds: p.attachmentIds } : {}),
        // ⛔ **The fan-out the operator picked is written into the mandate**, which is what
        // `createTask` actually enforces. There is never a second, invisible cap: the old shape had
        // `ROOT_MANDATE.maxChildren = 5` against a decomposition cap of 8, so a split of six was
        // refused with a message about a limit nobody had set.
        ...(p.maxChildren ? { mandate: { maxChildren: p.maxChildren } } : {}),
        // ⛔ Checked at the door, like every other constraint. The accounts and models named for the
        // pieces are stored here and read by `applySplit` months later, with no operator in the
        // room; an id that names nothing would produce children no candidate loop can ever match and
        // a model the cost model cannot price. `checkConstraints` refuses both, here, once.
        ...(p.childDefaults
          ? { childDefaults: { ...p.childDefaults, ...checkedChildAccounts(p.childDefaults) } }
          : {})
      }),
    'task.estimate': (p) => {
      // ⚠️ The worker is optional and the answer changes enormously with it. A caller that wants
      // "what will this cost" without saying where has asked a fleet-neutral question and gets a
      // fleet-neutral answer; the basis string says which it got.
      const worker = p.workerId ? getWorker(p.workerId) : null
      const estimate = estimateTask(
        requireTask(p.id),
        worker ? { adapterId: worker.adapterId } : undefined
      )
      return {
        tokens: estimate.tokens,
        pricedTokens: estimate.pricedTokens,
        // ⚠️ `null` where the runs behind the answer could not be priced, which is a different
        // statement from "it is free"; `usdConfidence` is `none` in exactly that case.
        usd: estimate.usd,
        usdConfidence: estimate.usdConfidence,
        confidence: estimate.confidence,
        basis: estimate.basis,
        factor: estimate.factor,
        assumed: estimate.assumed
      }
    },

    'chat.history': (p) => chatHistory(p?.threadId),
    'chat.send': (p) => sendChat(p.text, p.threadId),
    'chat.clear': (p) => {
      clearChat(p?.threadId)
      return { ok: true as const }
    },

    // ---- worker tier -------------------------------------------------------------------
    'agent.complete': async (p) => {
      await completeTask(p.sessionId, p.summary)
      return { ok: true as const }
    },
    /**
     * ⛔ The other terminal contract. It is deliberately *not* routed through `completeTask`: no
     * finish decision is taken, nothing is landed and nothing is claimed about the work. See
     * `parkForHuman`.
     */
    'agent.awaitHuman': (p) => parkForHuman(p.sessionId, p.reason, p.state),
    'agent.createTask': (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent || !run) {
        return { ok: false, reason: 'this session is not working on a task' }
      }
      const filedAt = Date.now()
      try {
        // ⛔ Bounded by construction: createTask narrows the mandate, shares the budget, enforces the
        // depth and fan-out caps and merges near-duplicates. Nothing here has to be trusted.
        //
        // ⚠️ Filed as a **draft** first, then admitted or not. The risk assessment needs the task's
        // inherited mandate and budget to judge it, and those exist only once it is created - so the
        // safe order is create-held, assess, release. A task that reaches `ready` before it has been
        // assessed can be dispatched by the very next tick.
        const task = createTask({
          title: p.title,
          ...(p.prompt ? { prompt: p.prompt } : {}),
          projectId: parent.projectId,
          parentTaskId: parent.id,
          status: 'draft',
          createdBy: {
            kind: 'agent',
            workerId: run.workerId,
            sessionId: p.sessionId,
            runId: run.id
          },
          ...(p.assigneeHint ? { assigneeHint: p.assigneeHint } : {})
        })
        // A merge into a near-duplicate returns the *existing* task, which has already been through
        // this. Re-gating it would re-open a decision somebody may have already made.
        if (task.createdAt >= filedAt) admitAgentTask(task.id)
        return { ok: true, seq: task.seq }
      } catch (err) {
        return { ok: false, reason: errorMessage(err) }
      }
    },
    /**
     * File a whole Plan & Split, once the operator has approved it.
     *
     * ⛔ **Validated, then approved, then written — in that order.** The operator is never shown a
     * plan that cannot be filed, so every rule `applySplit` enforces is checked *before* the card is
     * raised. And nothing is written until they answer, so a refusal costs a message rather than a
     * cleanup.
     *
     * ⚠️ This blocks for as long as the operator takes, and it holds the planner's worker slot while
     * it does — `awaitingHumanReservations` counts an `awaiting_human` task against `maxConcurrent`
     * so that the answer can resume a warm session. That is the price of a structural approval, and
     * it is the same price `ask_human` already pays.
     */
    'agent.split': async (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent || !run) {
        return { ok: false, reply: 'This session is not working on a task, so it cannot split one.' }
      }

      const pieces = p.pieces ?? []
      const precheck = validateSplit(parent, pieces)
      if (!precheck.ok) {
        return { ok: false, reply: `That split was not filed: ${precheck.reason}` }
      }

      const listed = pieces
        .map((piece, i) => {
          const label = piece.summary?.trim() || piece.title.trim().split(/\r?\n/)[0] || `piece ${i + 1}`
          const waits = piece.dependsOn?.length
            ? ` (after ${piece.dependsOn.map((d) => `#${d + 1}`).join(', ')})`
            : ''
          return `${i + 1}. ${label}${waits}`
        })
        .join('\n')

      const resolution = await askQuestion({
        sessionId: p.sessionId,
        origin: 'task_split',
        kind: 'choice',
        header: `Split t${parent.seq} into ${pieces.length}?`,
        question:
          `t${parent.seq} wants to split into ${pieces.length} pieces and delegate them:\n\n${listed}\n\n` +
          'Approving files all of them at once and starts them; they branch off this plan’s branch ' +
          'and merge back into it, and nothing reaches the trunk until the whole plan is reviewed. ' +
          'Refusing sends your note back to the planner so it can revise.',
        options: [
          { id: 'approve', label: `File all ${pieces.length}`, detail: 'They start as soon as an account is free' },
          { id: 'refuse', label: 'Not like this', detail: 'Add a note and the planner revises the plan' }
        ]
      })

      const approved = resolution.status === 'answered' && resolution.answer?.optionIds?.includes('approve')
      if (!approved) {
        // ⚠️ The operator's own words go back verbatim. A planner told only "refused" has nothing to
        // revise towards and will re-file something very close to what was just turned down.
        const note = resolution.answer?.text?.trim()
        return {
          ok: false,
          reply:
            resolution.status === 'answered'
              ? `The operator did not approve that split.${note ? ` They said: ${note}` : ''} ` +
                'Revise the plan and call task_split again, or ask them what they would prefer.'
              : `Nobody answered, so nothing was filed (${resolution.status}). Stop here rather than guessing.`
        }
      }

      const result = applySplit(
        parent.id,
        pieces,
        { kind: 'agent', workerId: run.workerId, sessionId: p.sessionId, runId: run.id },
        parent.childDefaults
      )
      if (!result.ok) return { ok: false, reply: `That split was not filed: ${result.reason}` }

      const seqs = result.children.map((c) => c.seq)
      return {
        ok: true,
        seqs,
        // ⛔ **This text is load-bearing.** It tells the planner to stop, because an agent that keeps
        // working after splitting is spending a billed turn on work it has just delegated — and it
        // says what will wake it, so stopping does not read as abandoning the task.
        reply:
          `Filed ${seqs.length} pieces: ${seqs.map((s) => `t${s}`).join(', ')}. This task now waits ` +
          'for all of them to settle. STOP NOW — do not start any of this work yourself. You will be ' +
          'started again automatically, with a summary of how every piece turned out, and your job ' +
          'then is to review the result as a whole and finish the task.'
      }
    },
    'agent.depend': (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent) return { ok: false, reason: 'this session is not working on a task' }
      return addSplitDependency(parent.id, p.taskSeq, p.dependsOnSeq)
    },
    'agent.handoff': (p) => {
      const run = runForSession(p.sessionId)
      if (run?.taskId) {
        setTaskHandoff(run.taskId, p.note)
        addMessage(run.taskId, 'agent', `Handoff recorded:
${p.note}`, run.id)
      }
      return { ok: true as const }
    }
  }
}

/** Assemble the domain RPC builders. `satisfies Api` deliberately names any omitted RPC method. */
export function buildApi(ctx: ApiContext): Api {
  const handlers = apiHandlers(ctx)
  return {
    ...apiWorkers(handlers),
    ...apiProjects(handlers),
    ...apiTasks(handlers),
    ...apiQuality(handlers),
    ...apiAgent(handlers)
  } satisfies Api
}

/**
 * Reject a constraint that names something that does not exist, here, at the door.
 *
 * ⛔ Admission is the only cheap place to say no. A bad worker id makes a task that no candidate loop
 * can ever match and that sits in `ready` looking like a scheduling problem; a model the cost model
 * cannot price is one agentyard cannot gate, estimate for or reason about the context window of, and
 * it would surface minutes later as a CLI argument error charged to a real window. `knownModels` in
 * judgment.ts refuses an unpriceable model from the *controller* for exactly these reasons - a person
 * filing a task deserves the same door.
 *
 * ⚠️ The adapter is derived from the pinned worker rather than taken on trust. Two fields that can
 * disagree about which CLI will run this are two fields that will eventually disagree.
 */

/**
 * Is this account's default model — and effort, where it has one — something its CLI could run?
 *
 * ⚠️ `null` is always allowed and never checked: it means "let the CLI pick", which is the state
 * every worker ships in and the one the operator returns to by clearing the box.
 */
export function checkWorkerDefaults(
  adapterId: string,
  patch: {
    defaultModel?: string | null
    gradingModel?: string | null
    defaultEffort?: string | null
    defaultModels?: Record<string, string | null> | null
    routableModels?: string[] | null
  }
): void {
  const info = adapter(adapterId).info
  const cm = costModel(info.policy.costModelId)

  if (patch.defaultModel) {
    if (!cm.modelSpec(patch.defaultModel)) {
      throw new Error(`'${patch.defaultModel}' is not a model ${info.label} can be priced for`)
    }
  }

  if (patch.gradingModel && !cm.modelSpec(patch.gradingModel)) {
    throw new Error(`'${patch.gradingModel}' is not a model ${info.label} can be priced for`)
  }

  if (patch.defaultModels) {
    for (const [pool, m] of Object.entries(patch.defaultModels)) {
      if (m) {
        const spec = cm.modelSpec(m)
        if (!spec) {
          throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
        }
        const matchesPool =
          spec.pool === pool ||
          (pool === 'claude' && (spec.pool === 'claude' || spec.pool === 'gpt'))
        if (spec.pool && !matchesPool) {
          throw new Error(`'${m}' does not belong to pool '${pool}'`)
        }
      }
    }
  }

  if (patch.routableModels) {
    for (const m of patch.routableModels) {
      // ⛔ The same rule `'model.options'` documents: a model that can be chosen is one that can be
      // priced, gated and estimated for. An allowlist entry the cost model does not declare is
      // refused on write, never stored — the ladder in `routableModelsFor` and part 2's scorer both
      // trust that everything in this column is legal.
      if (!cm.modelSpec(m)) {
        throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
      }
    }
  }

  if (patch.defaultEffort) {
    if (!info.capabilities.selectableEffort) {
      // ⛔ Not "ignored" — measured 2026-08-29, agy *refuses* the flag and the dispatch fails
      // outright, so accepting an effort here would store a value that breaks every run.
      throw new Error(`${info.label} takes no effort flag, so it has no default effort to set`)
    }
    // The effort has to be legal for the model it will be sent with, and that is the default model
    // unless a task overrides both. ⚠️ Checked against the *stored* model only when one is set here;
    // a task that pins a different model is checked again by `checkConstraints` on its own way in.
    const spec = patch.defaultModel ? cm.modelSpec(patch.defaultModel) : null
    if (spec && !spec.effort_levels.includes(patch.defaultEffort)) {
      throw new Error(`'${patch.defaultModel}' has no effort level '${patch.defaultEffort}'`)
    }
  }
}

/**
 * Every model this task could actually be dispatched on when it pins none of its own.
 *
 * ⚠️ Plural on purpose. A multi-pool account holds one default per pool and the scheduler picks
 * between them at dispatch on live quota, so an effort level has to be legal for *all* of them —
 * validating only the one that happens to win today would let the other pool fail at dispatch.
 */
function inheritedModels(worker: Worker | null): string[] {
  if (!worker) return []
  const models = Object.values(worker.defaultModels ?? {}).filter(
    (m): m is string => typeof m === 'string' && m.trim() !== ''
  )
  if (worker.defaultModel) models.push(worker.defaultModel)
  return [...new Set(models)]
}

/**
 * Validate the accounts and models a plan's pieces are to be filed with.
 *
 * ⛔ Through `checkConstraints`, never a second copy of the same rules. The Pieces row carries the
 * same three questions the task's own row does — which account, which model, which effort — and two
 * validators for one question is how they drift.
 */
function checkedChildAccounts(defaults: ChildDefaults): Partial<ChildDefaults> {
  const checked = checkConstraints({
    ...(defaults.workerIds?.length ? { workerIds: defaults.workerIds } : {}),
    ...(defaults.modelsByWorker ? { modelsByWorker: defaults.modelsByWorker } : {}),
    ...(defaults.effortsByWorker ? { effortsByWorker: defaults.effortsByWorker } : {})
  })
  return {
    ...(checked.workerIds ? { workerIds: checked.workerIds } : {}),
    ...(checked.modelsByWorker ? { modelsByWorker: checked.modelsByWorker } : {}),
    ...(checked.effortsByWorker ? { effortsByWorker: checked.effortsByWorker } : {})
  }
}

export function checkConstraints(c: TaskConstraints): TaskConstraints {
  const checked: TaskConstraints = { ...c }

  if (c.workerIds) {
    for (const id of c.workerIds) {
      const w = requireWorker(id)
      if (!canWork(w.role)) {
        throw new Error(`${w.label} has role '${w.role}' and cannot be assigned to work tasks`)
      }
    }
  }

  if (c.modelsByWorker) {
    for (const [wId, model] of Object.entries(c.modelsByWorker)) {
      if (!model) continue
      const w = requireWorker(wId)
      const info = adapter(w.adapterId).info
      const cm = costModel(info.policy.costModelId)
      const spec = cm.modelSpec(model)
      if (!spec) {
        throw new Error(`'${model}' is not a model ${info.label} can be priced for`)
      }
    }
  }

  if (c.effortsByWorker) {
    for (const [wId, effort] of Object.entries(c.effortsByWorker)) {
      if (!effort) continue
      const w = requireWorker(wId)
      const info = adapter(w.adapterId).info
      if (!info.capabilities.selectableEffort) {
        throw new Error(`${info.label} takes no effort flag — effort is set inside the session`)
      }
      const cm = costModel(info.policy.costModelId)
      const model = c.modelsByWorker?.[wId]
      if (model) {
        const spec = cm.modelSpec(model)
        if (spec && !spec.effort_levels.includes(effort)) {
          throw new Error(`'${model}' has no effort level '${effort}'`)
        }
      }
    }
  }

  if (c.pieceConstraints) {
    checked.pieceConstraints = checkConstraints(c.pieceConstraints)
  }

  let worker: Worker | null = null
  if (c.workerId) {
    worker = requireWorker(c.workerId)
    if (!canWork(worker.role)) {
      throw new Error(`${worker.label} has role '${worker.role}' and cannot be assigned to work tasks`)
    }
    checked.adapterId = worker.adapterId
  }

  const adapterId = checked.adapterId
  if (c.model || c.effort) {
    if (!adapterId) {
      // Nothing pins the adapter, so nothing can price the model. ⛔ Dropped rather than guessed:
      // picking a default adapter here would let a model chosen for one CLI be passed to another.
      throw new Error('choose a worker before choosing a model — the model list belongs to its CLI')
    }
    const info = adapter(adapterId).info
    const cm = costModel(info.policy.costModelId)

    if (c.effort && !info.capabilities.selectableEffort) {
      throw new Error(`${info.label} takes no effort flag — effort is set inside the session`)
    }

    if (c.model) {
      const spec = cm.modelSpec(c.model)
      if (!spec) {
        throw new Error(`'${c.model}' is not a model ${info.label} can be priced for`)
      }
      if (c.effort && !spec.effort_levels.includes(c.effort)) {
        throw new Error(`'${c.model}' has no effort level '${c.effort}'`)
      }
    } else if (c.effort) {
      // ⭐ Leaving the model on *inherit* is not leaving it unanswered. `resolveModelChoice` falls to
      // the account's own default, which is the model the New Task form names in the inherit option
      // and offers these very effort levels for — so the level is checked against that model rather
      // than refused for naming none. Refusing here made "the usual model, but think harder"
      // unfileable, which is the one combination the resolver exists to support.
      const inherited = inheritedModels(worker)
      if (inherited.length === 0) {
        // Nothing here or on the account names a model, so the CLI picks one at dispatch and no
        // level can be checked against it. ⛔ Still refused: an unverifiable effort flag fails the
        // whole run later rather than this call now.
        throw new Error('an effort level means nothing without a model to apply it to')
      }
      for (const m of inherited) {
        const spec = cm.modelSpec(m)
        if (!spec) {
          throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
        }
        if (!spec.effort_levels.includes(c.effort)) {
          throw new Error(`'${m}' has no effort level '${c.effort}'`)
        }
      }
    }
  }

  return checked
}

/**
 * Who can take work right now, and how fast each account has been measured to work.
 *
 * ⛔ **The two halves are read from the two places that own them**, never re-derived here:
 * availability from `accountUnavailability` — the one shared list of account gates, which work and
 * judgment both read — and pace from `pace.ts`, which is what the `pace` scoring term reads. A third
 * copy of either would be a third answer to a question the scheduler has already answered.
 *
 * ⚠️ Capacity is reported rather than folded into `unavailable`: a worker at its concurrency limit is
 * busy, not unfit, and the two look identical in a single boolean.
 */
function velocityReport(): VelocityReport {
  const objective = settings().objective ?? DEFAULT_OBJECTIVE
  const factors = paceFactors()
  const w = weights(objective)
  return {
    generatedAt: Date.now(),
    objective,
    paceWeight: w.pace,
    paceFormula: WEIGHT_FORMULAS.pace,
    neutralActiveMs: factors.neutralActiveMs,
    samples: factors.samples,
    workers: listWorkers()
      .filter((worker) => !worker.retiredAt)
      .map((worker) => {
        const measured = paceFor(factors, worker.adapterId, worker.defaultModel)
        const quota = lastQuota(worker.id)
        // ⚠️ The *tightest* applicable window, not the 5h one by name: an account can be fine on its
        // five hours and nearly out of its week, and routing is held by whichever bites first.
        const window =
          quota && !quota.stale
            ? [...quota.windows].sort((a, b) => b.percent - a.percent)[0] ?? null
            : null
        return {
          workerId: worker.id,
          label: worker.label,
          adapterId: worker.adapterId,
          medianActiveMs: measured.medianActiveMs,
          samples: measured.samples,
          factor: measured.factor,
          value: paceValue(measured.factor),
          basis: measured.basis,
          running: sessionsForWorker(worker.id).filter((session) => session.purpose === 'work').length,
          maxConcurrent: worker.maxConcurrent,
          unavailable: accountUnavailability(worker),
          windowPercent: window ? window.percent : null,
          windowLabel: window ? (window.label ?? window.id) : null
        }
      })
  }
}

/**
 * Every (worker, model) pair the fleet could route to, and what fed its `fitness` and `price` terms.
 *
 * ⛔ **Every priced model on every commissioned worker, not only its allowlist.** `routable` is what
 * tells the two apart: an operator deciding whether to *add* a model needs to see its prior and its
 * fitness before it has ever run a task, which is exactly the row an allowlist-only report would omit.
 *
 * ⚠️ `costUsd` is `estimateTask` on a fleet-neutral pseudo-task — `{ estTokens: null, projectId:
 * null }` — the same object shape `overrunFactor` (`estimator.ts`) builds when it has a real task's
 * numbers and nothing else. It answers "what would an average task cost on this pair", never "what
 * would *this* task cost", because there is no task in a table of pairs.
 */
export function modelReport(): ModelReport {
  const objective = settings().objective ?? DEFAULT_OBJECTIVE
  const w = weights(objective)
  const pace = paceFactors()
  const dispatchCounts = dispatchCountsByPair()
  // ⛔ One quality report for the whole table. This loop runs every priced model on every
  // commissioned worker — a hundred-odd rows on a mixed fleet — and `fitnessFor` would otherwise
  // reload the reviews table for each. See its `keys` parameter.
  const qualityKeys = qualityReport().keys
  const rows: ModelReportRow[] = []

  for (const worker of listWorkers()) {
    if (worker.retiredAt) continue
    let ids: string[]
    let cm: ReturnType<typeof costModel>
    try {
      cm = costModel(adapter(worker.adapterId).info.policy.costModelId)
      ids = cm.modelIds()
    } catch {
      continue
    }
    const routable = new Set(routableModelsFor(worker).filter((m): m is string => m !== null))
    const quota = lastQuota(worker.id)

    for (const model of ids) {
      const prior = benchmarkPrior(model)
      const fit = fitnessFor(worker.adapterId, model, qualityKeys)
      const estimate = estimateTask({ estTokens: null, projectId: null } as Task, {
        adapterId: worker.adapterId,
        model
      })
      const paced = paceFor(pace, worker.adapterId, model)
      const pool = cm.modelSpec(model)?.pool ?? null
      const windows = quota && !quota.stale ? windowsForPool(quota.windows, pool) : []
      const worst = windows.reduce<(typeof windows)[number] | null>(
        (max, win) => (!max || win.percent > max.percent ? win : max),
        null
      )
      const counts = dispatchCounts.get(`${worker.id}:${model}`)

      rows.push({
        workerId: worker.id,
        label: worker.label,
        adapterId: worker.adapterId,
        model,
        routable: routable.has(model),
        prior: prior.agentic,
        priorBasis: prior.basis,
        priorSource: prior.source,
        cleanComposite: fit.measured === null ? null : fit.measured * 10,
        cleanSamples: fit.samples,
        fitness: fit.value,
        fitnessBasis: fit.basis,
        costUsd: estimate.usd,
        costConfidence: estimate.usdConfidence,
        paceFactor: paced.samples > 0 ? paced.factor : null,
        paceSamples: paced.samples,
        pool,
        poolPercent: worst ? worst.percent : null,
        dispatches: counts?.dispatches ?? 0,
        explorations: counts?.explorations ?? 0
      })
    }
  }

  return {
    generatedAt: Date.now(),
    objective,
    active: modelRoutingActive(),
    fitnessWeight: w.fitness,
    fitnessFormula: WEIGHT_FORMULAS.fitness,
    priceWeight: w.price,
    priceFormula: WEIGHT_FORMULAS.price,
    rows
  }
}
