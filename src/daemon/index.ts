import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DaemonEvent, Session } from '@shared/protocol.js'
import { acquireLock, clearEndpoint, publishEndpoint, releaseLock } from './lock.js'
import { closeDb, openDb } from './db.js'
import { loadCostModels } from './costmodel.js'
import { startServer, type DaemonServer } from './server.js'
import { QuotaPoller } from './quota.js'
import { reconcileOrphans, setSessionEvents, shutdownAll } from './sessions.js'
import { TranscriptTailer, recordCompaction, recordTurn } from './transcript.js'
import { log, onLog } from './log.js'
import { setEventSink } from './events.js'
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

  const orphans = reconcileOrphans()
  if (orphans) log.info(`cleared ${orphans} session(s) left behind by a previous run`)

  const token = randomBytes(32).toString('hex')
  const server: DaemonServer = await startServer(token, { version: VERSION, startedAt })

  publishEndpoint({ pid: process.pid, port: server.port, token, version: VERSION, startedAt })

  const emit = (event: DaemonEvent) => server.broadcast(event)
  setEventSink(emit)
  const tailers = new Map<string, TranscriptTailer>()

  setSessionEvents({
    onChange(session: Session) {
      emit({ type: 'session.changed', session })
      if (session.state === 'live' && session.transcriptPath && !tailers.has(session.id)) {
        const tailer = new TranscriptTailer(session.id, session.transcriptPath, {
          onTurn(turn) {
            recordTurn(turn)
            emit({ type: 'turn', turn })
          },
          onCompact(sessionId, meta) {
            recordCompaction(sessionId, meta)
          }
        })
        tailer.start()
        tailers.set(session.id, tailer)
      }
    },
    onData(sessionId, data) {
      emit({ type: 'session.data', sessionId, data })
    },
    onExit(sessionId, exitCode) {
      // One last pass: the final turn is often written after the process is already gone.
      const tailer = tailers.get(sessionId)
      setTimeout(() => {
        tailer?.stop()
        tailers.delete(sessionId)
      }, 3000)
      emit({ type: 'session.exit', sessionId, exitCode })
    }
  })

  onLog((level, message, ts) => {
    if (level === 'warn' || level === 'error') emit({ type: 'log', level, message, ts })
  })

  const poller = new QuotaPoller((quota) => emit({ type: 'quota.changed', quota }))
  poller.start()

  log.info(`orchestratord ${VERSION} ready (pid ${process.pid}, data ${paths.root})`)

  let shuttingDown = false
  const shutdown = (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutting down: ${reason}`)
    poller.stop()
    for (const t of tailers.values()) t.stop()
    shutdownAll()
    void server.close().finally(() => {
      clearEndpoint()
      releaseLock()
      closeDb()
      process.exit(0)
    })
    // Never hang a shutdown on a socket that will not close.
    setTimeout(() => process.exit(0), 4000).unref()
  }

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
