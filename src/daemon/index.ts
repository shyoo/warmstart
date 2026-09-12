import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DaemonEvent, Session } from '@shared/protocol.js'
import { acquireLock, clearEndpoint, publishEndpoint, releaseLock } from './lock.js'
import { prunePending } from './attachments.js'
import { closeDb, openDb } from './db.js'
import { loadCostModels } from './costmodel.js'
import { logCostFactors } from './estimator.js'
import { adapter, hasAdapter, loadAdapters } from './adapters/index.js'
import { startServer, type DaemonServer } from './server.js'
import { startRemoteServer } from './remote/server.js'
import { QuotaPoller } from './quota.js'
import {
  getSession,
  lastRequestEvidenceAt,
  noteVendorSession,
  reconcileOrphans,
  setSessionEvents,
  shutdownAll
} from './sessions.js'
import { reconcileClaims } from './resources.js'
import {
  probeDemand,
  reconcileTasks,
  startScheduler,
  stopScheduler
} from './scheduler.js'
import { noteTurnStatus, onSessionExit, onStreamResult } from './turnend.js'
import { reconcileConsults, startController, stopController } from './controller.js'
import { reconcileReviews } from './reviewer.js'
import { salvageLandedCommits } from './taskcommits.js'
import { creditTurn, runForSession } from './tasks.js'
import { recordRateLimit } from './quota.js'
import {
  TranscriptTailer,
  creditStreamTurn,
  recordCompaction,
  recordTurn,
  touchCacheClock
} from './transcript.js'
import { log, onLog } from './log.js'
import { setEventSink } from './events.js'
import { forgetStreamUsage, noteStepUsage, takeTurnUsage, takeUnfinishedTurn } from './streamusage.js'
import { onShutdownRequest } from './lifecycle.js'
import { noteActivity } from './activity.js'
import { onSettingChange } from './settings.js'
import { paths } from './paths.js'

/**
 * orchestratord.
 *
 * Lives outside Electron on purpose. The premise of the product is unattended progress across quota
 * windows that are hours long; if closing the window killed the fleet, there would be nothing here
 * that a handful of terminal tabs does not already do.
 */

const require = createRequire(import.meta.url)
const VERSION = (require('../../package.json') as { version: string }).version

async function main(): Promise<void> {
  if (!acquireLock()) {
    log.error('another orchestratord holds the lock; exiting')
    process.exit(3)
  }

  const startedAt = Date.now()
  openDb()
  loadCostModels()
  // ⛔ Before anything can commission a worker or schedule a tick. An adapter appearing under a
  // running scheduler would mean capabilities changing between the gate that admitted a task and the
  // dispatch that acted on it.
  const external = loadAdapters()
  if (external.loaded) log.info(`${external.loaded} adapter(s) declared in the data directory`)

  // ⚠️ After the adapters, because a factor is priced by the cost model its adapter names. Logged
  // rather than merely computed: a routing or runaway decision that looks wrong later is checked
  // against what the fleet believed each agent cost at the time.
  logCostFactors()

  const orphans = reconcileOrphans()
  if (orphans) log.info(`cleared ${orphans} session(s) left behind by a previous run`)
  // Claims and task states recorded by a daemon that has since died are lies. Clearing them is what
  // stops a crash from permanently costing a workspace or stranding a task in `running`.
  reconcileClaims()
  reconcileTasks()
  reconcileConsults()
  // ⛔ And the grades, which `reconcileTasks` cannot reach: a review runs on a **finished** task, so
  // its open run and its `pending` row are invisible to a sweep that walks running work. Left alone
  // they read as *grading…* forever, with no process behind the word (t217, 2026-09-04).
  reconcileReviews()
  // ⛔ An image pasted into a form that was never submitted is a file nobody will ever delete, and
  // these are megabytes each. Once at startup and once a day thereafter; only ever unbound rows.
  prunePending()
  const attachmentSweep = setInterval(() => prunePending(), 24 * 60 * 60 * 1000)
  attachmentSweep.unref()

  const token = randomBytes(32).toString('hex')
  const server: DaemonServer = await startServer(token, { version: VERSION, startedAt })
  // Separate credentials and listener: the loopback bearer token never leaves this process.
  const remote = startRemoteServer({ version: VERSION, startedAt, port: server.port })

  // ⛔ **Not awaited, and it must not be.** Reading every project's history is one `git log` per
  // project, and the endpoint below is what the UI connects to — a repository on a slow or
  // disconnected volume would otherwise delay the whole app for something no caller is waiting on.
  // ⚠️ Idempotent and additive by construction, so running it on every boot costs one git call and
  // writes nothing once a fleet is salvaged. See `taskcommits.ts`.
  void salvageLandedCommits().catch((err) =>
    log.warn(`could not salvage landed commits: ${String(err)}`)
  )

  publishEndpoint({ pid: process.pid, port: server.port, token, version: VERSION, startedAt })

  const emit = (event: DaemonEvent) => { server.broadcast(event); remote.broadcast(event) }
  setEventSink(emit)
  const tailers = new Map<string, TranscriptTailer>()

  setSessionEvents({
    onChange(session: Session) {
      emit({ type: 'session.changed', session })
      if (session.state === 'live' && session.transcriptPath && !tailers.has(session.id)) {
        const tailer = new TranscriptTailer(session.id, session.transcriptPath, {
          onTurn(turn) {
            // ⛔ Bill it only if the store had never seen it. A transcript repeats usage records -
            // 72 for 41 real turns, measured on claude 2.1.223 - and `turns` deduped them while
            // every accumulator beside it did not.
            if (!recordTurn(turn)) return
            creditTurn(turn.sessionId, {
              input: turn.inputTokens,
              output: turn.outputTokens,
              cacheRead: turn.cacheReadTokens,
              cacheWrite: turn.cacheWrite1hTokens + turn.cacheWrite5mTokens
            })
            // ⚠️ The *session* change that came with this turn is announced by `recordTurn`
            // itself, where the row is written. See transcript.ts `announce`.
            emit({ type: 'turn', turn })
          },
          onCompact(sessionId, meta) {
            recordCompaction(sessionId, meta)
          }
        },
        // ⛔ The adapter's own reader, where it has one. Absent means Claude Code's shape, which is
        // what this tailer assumed for every adapter until muse arrived with a different one.
        adapter(session.adapterId).decodeTranscript)
        tailer.start()
        tailers.set(session.id, tailer)
      }
    },
    onData(sessionId, data) {
      emit({ type: 'session.data', sessionId, data })
    },
    onStream(session, event) {
      // ⛔ The vendor's name for this conversation, and the only moment it is ever offered. It was
      // decoded and thrown away: `agy` names its own conversations, reports the id once on `init`,
      // and takes `--conversation <id>` to resume one - so discarding it is what made every reply on
      // an Antigravity task a cold start. Measured on this install 2026-08-28: nine (task, adapter)
      // pairs, distinct sessions equal to runs in all nine.
      if (event.kind === 'init') noteVendorSession(session.id, event.sessionId)
      // The one quota signal that is both live and free: it rides a turn already being paid for.
      if (event.kind === 'rate_limit') {
        recordRateLimit(session.workerId, session.id, event.info)
      }
      // ⛔ Only the terminal usage record, and only for adapters metered from the stream. Antigravity
      // reports usage per step *and* again in its result; billing both would double-count the turn.
      // Claude Code is billed from its transcript instead, which is exact and sees the compaction
      // sampling iteration a stream never shows (cost-model.md §6).
      // ⚠️ No `session.changed` here either: it used to be emitted with the `session` this
      // callback was handed, which is the row as it was *before* `creditStreamTurn` wrote to it -
      // announcing a change while carrying the values from before it. `creditStreamTurn` now
      // announces its own write, from the store.
      //
      // ⭐ **The terminal record is not always the turn** (measured 2026-09-03, `streamusage.ts`).
      // `agy` reports `result.usage` cumulatively over the *conversation*, so crediting it as-is
      // bills every earlier turn again, and its `input_tokens` is a sum of prompt sizes rather than
      // a window level — which is what drew `1.1M/1.0M` on the gauge. Where a run emitted per-call
      // usage, `takeTurnUsage` returns their sum as the turn and the last call's prompt size as the
      // context level; where it did not, it hands back the terminal record unchanged.
      // ⛔ **A running turn keeps its own cache alive, and the row has to say so** (t224). Every
      // record above is downstream of a model request, and on a provider whose reads refresh the TTL
      // that request renewed the prefix for free. Without this the clock only ever moved when a turn
      // *ended*, so a `codex exec` run longer than OpenAI's 30-minute window spent its whole second
      // half reported as holding a lapsed cache while it was busy reusing it. No-op for anything not
      // metered from its stream, and it can only push an existing clock forward - see the function.
      const requestedAt = lastRequestEvidenceAt(session.id)
      if (requestedAt !== null) touchCacheClock(session, requestedAt)
      if (event.kind === 'usage' && !event.final) noteStepUsage(session.id, event.usage)
      if (event.kind === 'usage' && event.final) {
        const turn = takeTurnUsage(session.id, event.usage)
        creditStreamTurn(session, turn.usage, turn.contextTokens ?? undefined)
      }
      // ⛔ The peephole. A running task used to show a status and a token count and nothing else, so
      // "is this working or is it stuck?" could only be answered by opening the session pane and
      // reading a terminal. This is the same prose, already decoded, forwarded to whoever is looking
      // at the task. It is never written to the thread - see activity.ts.
      // ⛔ Framed by the adapter, not by this module reading the bytes. One `assistant_text` off
      // claude-code is a whole message; one off muse is a handful of tokens. Treating either as the
      // other wrecks the pane — see `AdapterCapabilities.outputFraming`.
      if (event.kind === 'assistant_text') {
        const run = runForSession(session.id)
        if (run?.taskId) {
          const framing = hasAdapter(session.adapterId)
            ? adapter(session.adapterId).info.capabilities.outputFraming
            : 'message'
          noteActivity(run.taskId, event.text, run.id, framing)
        }
      }
      // ⛔ And the record that says the turn failed, which nothing was listening to. A `stream`
      // session that hits an `api_error` does not exit, so waiting for `onExit` waits forever.
      if (event.kind === 'result') void onStreamResult(session, event)
      // ⛔ Held rather than acted on, because it arrives *before* the terminal record and describes
      // something the terminal record cannot say: that the turn stopped for a person. See
      // `noteTurnStatus`.
      if (event.kind === 'turn_status') noteTurnStatus(session.id, event)
    },
    onExit(sessionId, exitCode) {
      const finished = getSession(sessionId)
      // ⛔ **Before the run is closed, because a closed run takes no credit.** A session stopped
      // mid-turn has per-call usage sitting in the accumulator that no terminal record will ever come
      // to collect, and `forgetStreamUsage` below used to throw it away: t366 (2026-09-11) spent 47
      // minutes and nine model responses on `antigravity-cli` and its run reads `0 in / 0 out`, priced
      // *"no reading"*. ⚠️ `onSessionExit` calls `finishRun`, and `creditTurn` only finds an **open**
      // run, so this has to go first. It cannot double-count: the accumulator is empty unless the
      // turn was cut off. See `takeUnfinishedTurn`.
      const cutOff = finished ? takeUnfinishedTurn(sessionId) : null
      if (finished && cutOff) {
        creditStreamTurn(finished, cutOff.usage, cutOff.contextTokens ?? undefined)
      }
      if (finished) void onSessionExit(finished, exitCode)
      // One last pass: the final turn is often written after the process is already gone.
      const tailer = tailers.get(sessionId)
      setTimeout(() => {
        tailer?.stop()
        tailers.delete(sessionId)
      }, 3000)
      forgetStreamUsage(sessionId)
      emit({ type: 'session.exit', sessionId, exitCode })
    }
  })

  // ⛔ Every level, not only failures. Forwarding `warn` and `error` alone meant a fleet working
  // correctly and a fleet doing nothing at all produced the same empty stream, and "when did it
  // probe that account?" had no answer anywhere in the app.
  onLog((entry) => emit({ type: 'log', ...entry }))

  // ⛔ The poller no longer runs on a fixed interval. It asks the scheduler what the fleet is doing
  // and paces itself: the active cadence while a run is in flight, the idle one when nothing is, and
  // a look thirty seconds after any parked task's window is due back. `probeDemand` is passed in
  // rather than imported by `quota.ts` so the module that decides *when to look* stays out of the
  // module that decides *what to run*.
  // ⛔ No listener. `quota.changed` is emitted where a reading is *stored*, so every rung — the
  // sweep, the dispatch gate, the end of a run, the Probe button — reaches the strip by the same
  // route. Wiring the sweep's own callback to `emit` here is what made the other three silent.
  const poller = new QuotaPoller({ demand: probeDemand })
  poller.start()
  onSettingChange((key, value) => {
    if (key === 'probeIntervalMinutes' && typeof value === 'number') {
      poller.setIntervalMinutes(value)
    }
    if (key === 'idleProbeIntervalMinutes' && typeof value === 'number') {
      poller.setIdleIntervalMinutes(value)
    }
  })
  startScheduler()
  // ⚠️ A second loop, on purpose. The scheduler is free and runs every ten seconds; this one can
  // spend and runs every thirty, one question at a time. Keeping them separate is what lets the
  // controller be an LLM without putting an LLM in the path of every dispatch.
  startController()

  log.info(`orchestratord ${VERSION} ready (pid ${process.pid}, data ${paths.root})`)

  let shuttingDown = false
  const shutdown = (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutting down: ${reason}`)
    poller.stop()
    stopScheduler()
    stopController()
    for (const t of tailers.values()) t.stop()
    shutdownAll()
    void Promise.all([server.close(), remote.close()]).finally(() => {
      clearEndpoint()
      releaseLock()
      closeDb()
      process.exit(0)
    })
    // Never hang a shutdown on a socket that will not close.
    setTimeout(() => process.exit(0), 4000).unref()
  }

  // ⛔ The one way anything asks this process to stop other than a signal. The app uses it when
  // the operator has turned the tray off, so that closing the window really does leave nothing
  // running - see AGENTS.md. No pid is read and nothing is killed from outside.
  onShutdownRequest(shutdown)

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err)
  })
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection:', err)
  })
}

main().catch((err) => {
  log.error('orchestratord failed to start:', err)
  clearEndpoint()
  releaseLock()
  process.exit(1)
})
