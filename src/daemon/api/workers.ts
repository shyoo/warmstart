/** Accounts, adapters, sessions and the daemon's own housekeeping. */
import type { AdapterInfo, DoctorReport, ModelOptions, Settings } from '@shared/protocol.js'
import { existsSync } from 'node:fs'
import { adapter, adapters } from '../adapters/index.js'
import { createWorker, knownModelIds, listWorkers, creditsDiscrepancy, noteCreditsDiscrepancyReported, setWorkerCreditsIntent, refreshIdentity, reorderWorkers, requireWorker, retireWorker, updateWorker } from '../workers.js'
import { accountUnavailability } from '../eligibility.js'
import { lastQuota, lastQuotaReading, probeWorker, refreshNow } from '../quota.js'
import { emit } from '../events.js'
import { attachTerminal, backscroll, closeSession, listSessions, resizeSession, sessionsForWorker, sessionsAndWarmConversationsForWorker, spawnSession, streamLog, writeSession } from '../sessions.js'
import { costModel, costModels } from '../costmodel.js'
import { requestShutdown } from '../lifecycle.js'
import { paths } from '../paths.js'
import { atCapacity, retainedReservations } from '../residency.js'
import { DEFAULT_OBJECTIVE, parseObjective } from '../objective.js'
import { setSetting, settings } from '../settings.js'
import { refreshCreditStatus } from '../spend.js'
import { log, logFiles, recentLog } from '../log.js'
import type { Api, ApiContext } from './support.js'
import { checkWorkerDefaults, describeAge } from './support.js'
import { which } from '../which.js'

export function supportTools(): DoctorReport['tools'] {
  const tools: Array<Pick<DoctorReport['tools'][number], 'id' | 'label' | 'need'>> = [
    { id: 'git', label: 'Git', need: 'required' },
    { id: 'gh', label: 'GitHub CLI', need: 'pull-request' },
    { id: 'tailscale', label: 'Tailscale', need: 'remote' }
  ]
  return tools.map((tool) => {
    const path = which(tool.id)
    return { ...tool, found: path !== null, path }
  })
}

type WorkerMethod =
  | 'health' | 'adapter.list' | 'adapter.detect' | 'tool.detect' | 'fleet.list' | 'worker.create' | 'worker.update'
  | 'worker.setCreditsIntent' | 'worker.reorder' | 'worker.retire' | 'worker.probe' | 'costmodel.list'
  | 'model.options' | 'daemon.shutdown' | 'doctor.run' | 'session.list' | 'session.spawn' | 'session.write'
  | 'session.resize' | 'session.close' | 'session.backscroll' | 'session.streamlog' | 'session.attach'
  | 'settings.get' | 'settings.set' | 'log.tail'
  | 'log.files'

export function apiWorkers(ctx: ApiContext): Pick<Api, WorkerMethod> {
  const uptime = (): number => Date.now() - ctx.startedAt

  return {
    health: () => ({ ok: true as const, version: ctx.version, uptimeMs: uptime() }),
    'adapter.list': (): AdapterInfo[] => adapters().map((a) => a.info),
    'adapter.detect': () => Promise.all(adapters().map((a) => a.detect())),
    'tool.detect': supportTools,
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
      const current = requireWorker(id)
      // Validation needs the effective grading model when an effort-only edit arrives. Preserve an
      // explicit null so clearing the model cannot leave its old effort behind.
      checkWorkerDefaults(current.adapterId, {
        ...patch,
        ...(patch.gradingEffort !== undefined && patch.gradingModel === undefined
          ? { gradingModel: current.gradingModel }
          : {})
      })
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
          const options = (ids: string[], workerId?: string): ModelOptions => ({
            adapterId: a.info.id,
            ...(workerId ? { workerId } : {}),
            costModelId: cm.id,
            selectableEffort: a.info.capabilities.selectableEffort,
            models: ids.map((id) => {
              const spec = cm.modelSpec(id)
              return {
                id,
                contextWindow: spec?.context_window ?? null,
                effortLevels: spec?.effort_levels ?? [],
                ...(spec?.pool ? { pool: spec.pool } : {})
              }
            }),
            ...(pools.length > 0 ? { pools } : {})
          })
          // The adapter-wide list (a task's model constraint reaches any worker), then - where the
          // models are a server's - one entry per worker naming what *its* endpoint reported.
          const perWorker = cm.dynamicModelPrefix()
            ? listWorkers()
                .filter((w) => w.adapterId === a.info.id && !w.retiredAt)
                .map((w) => options(knownModelIds(a.info.id, w.id), w.id))
            : []
          return [options(knownModelIds(a.info.id)), ...perWorker]
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
      const tools = supportTools()

      for (const tool of tools) {
        if (!tool.found && tool.need === 'required') warnings.push(`${tool.label}: required tool not found on PATH`)
        if (!tool.found && tool.need === 'pull-request') warnings.push(`${tool.label}: not found on PATH; pull-request delivery is unavailable`)
      }

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
        tools,
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
    'session.streamlog': (p) => ({ lines: streamLog(p.id) }),
    'session.attach': (p) => attachTerminal(p.id),
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
    'log.tail': (p) => recentLog(Math.min(p.limit ?? 500, 2000), p.level ?? 'debug'),
    'log.files': () => ({ directory: paths.logs, files: logFiles() })
  }
}
