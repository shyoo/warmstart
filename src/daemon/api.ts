import type {
  AdapterInfo,
  CostReport,
  DoctorReport,
  ModelOptions,
  RpcMethod,
  RpcParams,
  RpcResult,
  Settings
} from '@shared/protocol.js'
import type { TaskConstraints } from '@shared/tasks.js'
import { resolveCompletionMode } from '@shared/tasks.js'
import { existsSync } from 'node:fs'
import { adapter, adapters } from './adapters/index.js'
import {
  createWorker,
  getWorker,
  listWorkers,
  refreshIdentity,
  reorderWorkers,
  requireWorker,
  retireWorker,
  updateWorker
} from './workers.js'
import { accountUnavailability } from './eligibility.js'
import { lastQuota, lastQuotaReading, refreshUsage } from './quota.js'
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
  proposeChecks,
  reloadProject,
  requireProject,
  setProjectChecks,
  writeStarterConfig
} from './projects.js'
import {
  addMessage,
  blockedDependentsOf,
  createTask,
  dependentsOf,
  getTask,
  lastMessageId,
  listTasks,
  messagesFor,
  pageTasks,
  promoteDraft,
  requireTask,
  setStatus,
  runForSession,
  runsFor,
  setTaskHandoff,
  updateTask
} from './tasks.js'
import { cancelTask, deleteBlockers, deleteTask, restoreTask, resumeTask } from './cancel.js'
import {
  addRule,
  answerApproval,
  listRules,
  openApprovals,
  removeRule,
  requestApproval
} from './approvals.js'
import { answerQuestion, askQuestion, openQuestions, questionsForTask } from './questions.js'
import { allAvailability } from './resources.js'
import { activityFor } from './activity.js'
import {
  atCapacity,
  completeTask,
  continueTask,
  deliverToLiveSession,
  promptFor,
  relandTask,
  resolveConflictOnTask,
  resolveTask,
  tick
} from './scheduler.js'
import { controllerReport, drainConsults, enqueueConsult } from './controller.js'
import { gateQuestion, riskOf } from './judgment.js'
import { chatHistory, resetChat, sendChat } from './chat.js'
import { costFactors, estimateTask } from './estimator.js'
import { recentClockEvents, remainingTokens, reserveState } from './reserve.js'
import { decide, medianHumanLatencyMs } from './cacheclock.js'
import { DEFAULT_OBJECTIVE, parseObjective, resolveObjective } from './objective.js'
import { setSetting, settings } from './settings.js'
import { lastRateLimit, windowResetsAt } from './quota.js'
import { listConversations } from './conversations.js'
import { log, logFiles, recentLog } from './log.js'
import { dismissLooseEnd, resolveFinishPolicy, scanLooseEnds } from './finish.js'
import { resolveSessionSharing } from './sharing.js'

type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>

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

export function buildApi(ctx: ApiContext): { [M in RpcMethod]: Handler<M> } {
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
          atCapacity: atCapacity(liveSessions, worker.maxConcurrent, null)
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
    'worker.reorder': (p) => reorderWorkers(p.ids),
    'worker.retire': (p) => retireWorker(p.id),
    // ⭐ A person pressing Probe wants a number, not a re-read of a cache that may be weeks old.
    // `refreshUsage` drives the adapter's own usage command into a TUI and then reads the result;
    // for an adapter that declares none it falls straight through to the file read, so this is
    // never worse than what it replaced.
    'worker.probe': async (p) => {
      // ⛔ `lift` — a person pressing this is the one signal that clears a dispatch quarantine.
      // The background sweep re-reads identity too and deliberately does not, because an expired
      // subscription answers `auth status` exactly as a live one does.
      await refreshIdentity(p.id, true)
      await refreshUsage(p.id)
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
    'project.reload': (p) => reloadProject(p.id),
    'project.archive': (p) => archiveProject(p.id),
    'project.writeConfig': (p) => ({ path: writeStarterConfig(p.id) }),

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
      const previewPrompt = promptFor(task, adapterId, false, { markDelivered: false })
      const dependencies = (task.dependsOn || [])
        .map((id) => getTask(id))
        .filter((t): t is typeof task => !!t && t.deletedAt === null)
      const dependents = dependentsOf(p.id)
        .map((id) => getTask(id))
        .filter((t): t is typeof task => !!t && t.deletedAt === null)
      return {
        task,
        messages: messagesFor(p.id),
        runs,
        sessions,
        activity: activityFor(p.id),
        blocking: blockedDependentsOf(p.id),
        dependencies,
        dependents,
        resolvedFinish: resolveFinishPolicy(task, project),
        resolvedSharing: resolveSessionSharing(task, project),
        inheritedFinish: resolveFinishPolicy(null, project),
        inheritedSharing: resolveSessionSharing(null, project),
        inheritedCompletion: resolveCompletionMode(null, project, settings().completionMode),
        inheritedObjective: resolveObjective(project?.config?.objective, null, settings().objective),
        resolvedObjective: resolveObjective(project?.config?.objective, task.objective, settings().objective),
        previewPrompt
      }
    },
    'task.create': (p) => createTask({ ...p, ...(p.constraints ? { constraints: checkConstraints(p.constraints) } : {}) }),
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
    'task.setSessionSharing': (p) => updateTask(p.id, { sessionSharing: p.sessionSharing }),
    'task.setCompletionMode': (p) => updateTask(p.id, { completionMode: p.completionMode }),
    'task.setObjective': (p) => updateTask(p.id, { objective: p.objective }),
    /**
     * ⚠️ Next run only. Nothing is sent into a session that is already talking — see the note on the
     * protocol type for what a mid-conversation switch costs.
     */
    'task.setModel': (p) => {
      const task = requireTask(p.id)
      // ⛔ Through the same door a filing goes through. The adapter has to be known before a model
      // can be checked, and `checkConstraints` is where that argument already lives.
      const constraints = checkConstraints({
        ...task.constraints,
        ...(p.model ? { model: p.model } : { model: undefined }),
        ...(p.effort ? { effort: p.effort } : { effort: undefined })
      })
      return updateTask(p.id, { constraints })
    },
    'task.setWorker': (p) => {
      const task = requireTask(p.id)
      if (!p.workerId) {
        // Reassigned to auto / scheduler choice: clear workerId, adapterId, model, effort
        const { workerId, adapterId, model, effort, ...rest } = task.constraints
        const isResting = !['running', 'assigned'].includes(task.status)
        return updateTask(p.id, {
          constraints: rest,
          ...(isResting ? { assigneeHint: null } : {})
        })
      }
      const worker = requireWorker(p.workerId)
      // If the adapter changed, clear model and effort because they belong to the previous adapter
      const adapterChanged = task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId
      const constraints = checkConstraints({
        ...task.constraints,
        workerId: worker.id,
        adapterId: worker.adapterId,
        model: adapterChanged ? undefined : task.constraints.model,
        effort: adapterChanged ? undefined : task.constraints.effort
      })
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

    'task.message': (p) => {
      addMessage(p.id, 'human', p.text)
      // ⛔ Delivered into the live session if there is one. That is `0.1·C` and it refreshes the TTL;
      // the same note delivered by restarting the task is `2.0·C` plus everything the successor has
      // to rediscover about the branch. Plan §18.4.
      const id = lastMessageId(p.id)
      if (id !== null) deliverToLiveSession(p.id, id, p.text)
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
    'task.resume': (p) => resumeTask(p.id),
    'task.resolve': (p) => resolveTask(p.id, p.note),
    'task.deleteCheck': (p) => deleteBlockers(p.id),
    // ⛔ Human-only. There is deliberately no worker-tier equivalent: an agent that can delete the
    // record of its own failed work is an agent that can hide it.
    'task.delete': (p) => deleteTask(p.id, { ...(p.hard ? { hard: true } : {}), ...(p.force ? { force: true } : {}) }),
    'task.restore': (p) => restoreTask(p.id),
    'task.promote': (p) => promoteDraft(p.id),

    // ---- approvals ---------------------------------------------------------------------
    'project.proposeChecks': (p) => ({ checks: proposeChecks(requireProject(p.id).root) }),
    'project.setChecks': (p) => setProjectChecks(p.id, p.checks),

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
      let current = settings()
      for (const [key, value] of Object.entries(p) as Array<[keyof Settings, Settings[keyof Settings]]>) {
        const sanitized = key === 'objective' ? (parseObjective(value) ?? DEFAULT_OBJECTIVE) : value
        current = setSetting(key, sanitized as never)
      }
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
        costFactors: costFactors(),
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
    'scheduler.tick': () => tick(),

    // ---- the controller ----------------------------------------------------------------
    'controller.report': (p) => controllerReport(p?.limit ?? 40),
    // ⚠️ The one RPC that can spend tokens by being called. Nothing in a scheduler tick calls it.
    'controller.drain': () => drainConsults(),

    'task.plan': (p) =>
      createTask({
        title: p.title,
        kind: 'plan',
        projectId: p.projectId ?? null,
        ...(p.prompt ? { prompt: p.prompt } : {})
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
        confidence: estimate.confidence,
        basis: estimate.basis,
        factor: estimate.factor,
        assumed: estimate.assumed
      }
    },

    'chat.history': (p) => chatHistory(p?.threadId),
    'chat.send': (p) => sendChat(p.text, p.threadId),
    'chat.reset': (p) => {
      resetChat(p?.threadId)
      return { ok: true as const }
    },

    // ---- worker tier -------------------------------------------------------------------
    'agent.complete': async (p) => {
      await completeTask(p.sessionId, p.summary)
      return { ok: true as const }
    },
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
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
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
    defaultEffort?: string | null
    defaultModels?: Record<string, string | null> | null
  }
): void {
  const info = adapter(adapterId).info
  const cm = costModel(info.policy.costModelId)

  if (patch.defaultModel) {
    if (!cm.modelSpec(patch.defaultModel)) {
      throw new Error(`'${patch.defaultModel}' is not a model ${info.label} can be priced for`)
    }
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

export function checkConstraints(c: TaskConstraints): TaskConstraints {
  const checked: TaskConstraints = { ...c }

  if (c.workerId) {
    const worker = requireWorker(c.workerId)
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

    if (c.model) {
      const spec = cm.modelSpec(c.model)
      if (!spec) {
        throw new Error(`'${c.model}' is not a model ${info.label} can be priced for`)
      }
      if (c.effort) {
        if (!info.capabilities.selectableEffort) {
          throw new Error(`${info.label} takes no effort flag — effort is set inside the session`)
        }
        if (!spec.effort_levels.includes(c.effort)) {
          throw new Error(`'${c.model}' has no effort level '${c.effort}'`)
        }
      }
    } else if (c.effort) {
      throw new Error('an effort level means nothing without a model to apply it to')
    }
  }

  return checked
}
