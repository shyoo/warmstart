import type {
  AdapterInfo,
  DoctorReport,
  RpcMethod,
  RpcParams,
  RpcResult
} from '@shared/protocol.js'
import { existsSync } from 'node:fs'
import { adapter, adapters } from './adapters/index.js'
import {
  createWorker,
  listWorkers,
  refreshIdentity,
  requireWorker,
  retireWorker,
  updateWorker
} from './workers.js'
import { lastQuota, probeWorker } from './quota.js'
import {
  backscroll,
  closeSession,
  listSessions,
  resizeSession,
  sessionsForWorker,
  spawnSession,
  writeSession
} from './sessions.js'
import { costModels } from './costmodel.js'
import { paths } from './paths.js'
import {
  addProject,
  archiveProject,
  listProjects,
  reloadProject,
  writeStarterConfig
} from './projects.js'
import {
  addMessage,
  createTask,
  getTask,
  listTasks,
  messagesFor,
  promoteDraft,
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
import { allAvailability } from './resources.js'
import { completeTask, tick } from './scheduler.js'
import { log } from './log.js'

type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>

/** "26825 minutes" is technically true and useless. Say it the way a person would. */
function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
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

    'fleet.list': () =>
      listWorkers().map((worker) => ({
        worker,
        quota: lastQuota(worker.id),
        sessions: sessionsForWorker(worker.id)
      })),

    'worker.create': async (p) => {
      const worker = createWorker(p)
      // Identity is read back immediately so the UI can say whose account this is, or say plainly
      // that nobody is logged in yet - which is the normal state right after commissioning.
      return await refreshIdentity(worker.id)
    },
    'worker.update': (p) => {
      const { id, ...patch } = p
      return updateWorker(id, patch)
    },
    'worker.retire': (p) => retireWorker(p.id),
    'worker.probe': async (p) => {
      await refreshIdentity(p.id)
      return await probeWorker(p.id)
    },

    'costmodel.list': () => costModels().map((m) => m.summary()),

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
    'task.get': (p) => {
      const task = getTask(p.id)
      if (!task) return null
      return { task, messages: messagesFor(p.id), runs: runsFor(p.id) }
    },
    'task.create': (p) => createTask(p),
    'task.update': (p) => {
      const { id, ...patch } = p
      return updateTask(id, patch as never)
    },
    'task.message': (p) => {
      addMessage(p.id, 'human', p.text)
      return { ok: true as const }
    },
    'task.cancel': (p) =>
      cancelTask(p.id, {
        ...(p.restingState ? { restingState: p.restingState } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.hard ? { hard: p.hard } : {}),
        requestedBy: 'human'
      }),
    'task.resume': (p) => resumeTask(p.id),
    'task.deleteCheck': (p) => deleteBlockers(p.id),
    // ⛔ Human-only. There is deliberately no worker-tier equivalent: an agent that can delete the
    // record of its own failed work is an agent that can hide it.
    'task.delete': (p) => deleteTask(p.id, { ...(p.hard ? { hard: true } : {}), ...(p.force ? { force: true } : {}) }),
    'task.restore': (p) => restoreTask(p.id),
    'task.promote': (p) => promoteDraft(p.id),

    // ---- approvals ---------------------------------------------------------------------
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
        ? { decision: 'deny' as const, reason: 'agentyard policy or the operator declined.' }
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

    // ---- resources and the loop --------------------------------------------------------
    'resource.list': () => allAvailability(),
    'scheduler.tick': () => tick(),

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
      try {
        // ⛔ Bounded by construction: createTask narrows the mandate, shares the budget, enforces the
        // depth and fan-out caps and merges near-duplicates. Nothing here has to be trusted.
        const task = createTask({
          title: p.title,
          ...(p.prompt ? { prompt: p.prompt } : {}),
          projectId: parent.projectId,
          parentTaskId: parent.id,
          createdBy: {
            kind: 'agent',
            workerId: run.workerId,
            sessionId: p.sessionId,
            runId: run.id
          },
          ...(p.assigneeHint ? { assigneeHint: p.assigneeHint } : {})
        })
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
