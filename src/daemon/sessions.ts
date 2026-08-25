import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from '@lydell/node-pty'
import type { Session, SessionState, SessionTransport } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { requireWorker } from './workers.js'
import { log } from './log.js'
import { ensureDir } from './paths.js'

/**
 * Live agent processes.
 *
 * A session is hosted in a PTY we own, which is the whole reason `/compact` is a function call here
 * rather than the OS-level UI automation the prior art was stuck with. But owning stdin does not
 * mean reading stdout for meaning:
 *
 * ⛔ Terminal bytes go to the UI and to a scrollback buffer. **Nothing in this file parses them to
 * decide anything.** Usage, context size, idle time and effort come from the agent's own transcript
 * (transcript.ts), which is exact.
 */

/** Enough backscroll that reopening the window does not look like the session lost its history. */
const SCROLLBACK_BYTES = 256 * 1024

interface Live {
  session: Session
  proc: pty.IPty
  scrollback: string[]
  scrollbackBytes: number
  purpose: 'work' | 'login'
}

const live = new Map<string, Live>()

export interface SessionEvents {
  onChange(session: Session): void
  onData(sessionId: string, data: string): void
  onExit(sessionId: string, exitCode: number | null): void
}

let events: SessionEvents = { onChange() {}, onData() {}, onExit() {} }
export function setSessionEvents(e: SessionEvents): void {
  events = e
}

interface SessionRow {
  id: string
  worker_id: string
  adapter_id: string
  transport: string
  project_id: string | null
  cwd: string
  model: string | null
  effort: string | null
  state: string
  pid: number | null
  transcript_path: string | null
  context_tokens: number | null
  last_request_started_at: number | null
  cache_expires_at: number | null
  tokens_since_compact: number
  started_at: number
  closed_at: number | null
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    workerId: r.worker_id,
    adapterId: r.adapter_id,
    transport: r.transport as SessionTransport,
    projectId: r.project_id,
    cwd: r.cwd,
    model: r.model,
    effort: r.effort,
    state: r.state as SessionState,
    pid: r.pid,
    transcriptPath: r.transcript_path,
    contextTokens: r.context_tokens,
    lastRequestStartedAt: r.last_request_started_at,
    cacheExpiresAt: r.cache_expires_at,
    tokensSinceCompact: r.tokens_since_compact,
    startedAt: r.started_at,
    closedAt: r.closed_at
  }
}

export function listSessions(includeClosed = false): Session[] {
  const sql = includeClosed
    ? 'select * from sessions order by started_at desc'
    : "select * from sessions where state not in ('closed','failed') order by started_at desc"
  return rows<SessionRow>(db().prepare(sql).all()).map(toSession)
}

export function getSession(id: string): Session | null {
  const r = row<SessionRow>(db().prepare('select * from sessions where id = ?').get(id))
  return r ? toSession(r) : null
}

export function sessionsForWorker(workerId: string): Session[] {
  return rows<SessionRow>(
    db()
      .prepare("select * from sessions where worker_id = ? and state not in ('closed','failed')")
      .all(workerId)
  ).map(toSession)
}

export interface SpawnOptions {
  workerId: string
  cwd?: string | undefined
  transport?: SessionTransport | undefined
  model?: string | undefined
  argv?: string[] | undefined
  cols?: number | undefined
  rows?: number | undefined
  purpose?: 'work' | 'login' | undefined
}

export function spawnSession(opts: SpawnOptions): Session {
  const worker = requireWorker(opts.workerId)
  if (worker.retiredAt) throw new Error(`worker '${worker.label}' is retired`)
  const purpose = opts.purpose ?? 'work'

  if (purpose === 'work') {
    if (!worker.enabled) throw new Error(`worker '${worker.label}' is disabled`)
    // A human-occupied worker's quota is tracked and never spent. Logging in is still allowed;
    // running work on it is not.
    if (worker.humanOccupied) {
      throw new Error(`worker '${worker.label}' is marked human-occupied`)
    }
    const running = sessionsForWorker(worker.id).length
    if (running >= worker.maxConcurrent) {
      throw new Error(
        `worker '${worker.label}' is at its concurrency limit (${running}/${worker.maxConcurrent})`
      )
    }
  }

  // A login flow has no project yet, so home is the sane default rather than the daemon's own cwd.
  const cwd = opts.cwd && opts.cwd !== '.' ? opts.cwd : homedir()
  if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)
  ensureDir(worker.isolationRoot)

  const ad = adapter(worker.adapterId)
  // Minted here, before the process exists, so the transcript path is known before the file is.
  const id = randomUUID()
  const transport: SessionTransport = opts.transport ?? 'pty'
  const plan = ad.plan({
    sessionId: id,
    isolationRoot: worker.isolationRoot,
    cwd,
    transport,
    model: opts.model,
    argv: opts.argv
  })

  const proc = pty.spawn(plan.command, plan.args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd,
    env: plan.env
  })

  const transcriptPath = purpose === 'work' ? ad.transcriptPath(worker.isolationRoot, cwd, id) : null
  const now = Date.now()
  db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, pid,
                             transcript_path, tokens_since_compact, started_at)
       values (?, ?, ?, ?, ?, ?, 'starting', ?, ?, 0, ?)`
    )
    .run(
      id,
      worker.id,
      worker.adapterId,
      transport,
      cwd,
      opts.model ?? null,
      proc.pid,
      transcriptPath,
      now
    )

  const session = getSession(id)
  if (!session) throw new Error('session row vanished immediately after insert')
  const entry: Live = { session, proc, scrollback: [], scrollbackBytes: 0, purpose }
  live.set(id, entry)

  proc.onData((data) => {
    entry.scrollback.push(data)
    entry.scrollbackBytes += data.length
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      entry.scrollbackBytes -= entry.scrollback.shift()?.length ?? 0
    }
    events.onData(id, data)
  })

  proc.onExit(({ exitCode }) => {
    live.delete(id)
    setState(id, exitCode === 0 ? 'closed' : 'failed')
    events.onExit(id, exitCode)
    log.info(`session ${id.slice(0, 8)} exited with ${exitCode}`)
  })

  log.info(
    `spawned ${purpose} session ${id.slice(0, 8)} on ${worker.label}: ${plan.command} ${plan.args.join(' ')}`
  )
  setState(id, 'live')
  return getSession(id) ?? session
}

function setState(id: string, state: SessionState): void {
  const closed = state === 'closed' || state === 'failed'
  db()
    .prepare('update sessions set state = ?, closed_at = ? where id = ?')
    .run(state, closed ? Date.now() : null, id)
  const s = getSession(id)
  if (s) {
    const entry = live.get(id)
    if (entry) entry.session = s
    events.onChange(s)
  }
}

export function writeSession(id: string, data: string): void {
  const entry = live.get(id)
  if (!entry) throw new Error(`session '${id}' is not live`)
  entry.proc.write(data)
}

export function resizeSession(id: string, cols: number, rows_: number): void {
  const entry = live.get(id)
  if (!entry) return
  try {
    entry.proc.resize(Math.max(2, cols), Math.max(1, rows_))
  } catch (err) {
    // A resize racing an exit is normal and not worth failing a call over.
    log.debug('resize ignored:', err)
  }
}

export function backscroll(id: string): string {
  return live.get(id)?.scrollback.join('') ?? ''
}

export function closeSession(id: string): void {
  const entry = live.get(id)
  if (!entry) {
    setState(id, 'closed')
    return
  }
  try {
    entry.proc.kill()
  } catch (err) {
    log.warn(`could not kill session ${id}:`, err)
    setState(id, 'failed')
  }
}

/**
 * Called at startup. Rows left `live` by a daemon that died are lies - the processes went with it.
 * Marking them failed keeps the concurrency accounting honest for the next spawn.
 */
export function reconcileOrphans(): number {
  const stale = rows<SessionRow>(
    db().prepare("select * from sessions where state not in ('closed','failed')").all()
  )
  for (const r of stale) {
    db()
      .prepare("update sessions set state = 'failed', closed_at = ? where id = ?")
      .run(Date.now(), r.id)
  }
  if (stale.length) log.warn(`marked ${stale.length} orphaned session(s) failed at startup`)
  return stale.length
}

export function shutdownAll(): void {
  for (const [id, entry] of live) {
    try {
      entry.proc.kill()
    } catch {
      // Best effort; the daemon is going away regardless.
    }
    setState(id, 'closed')
  }
  live.clear()
}
