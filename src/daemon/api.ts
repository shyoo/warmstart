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
    'session.backscroll': (p) => ({ data: backscroll(p.id) })
  }
}
