import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from '@lydell/node-pty'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import type { Session, SessionPurpose, SessionState, SessionTransport } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { requireWorker } from './workers.js'
import { log } from './log.js'
import { ensureDir } from './paths.js'
import { removeMcpConfig, writeMcpConfig } from './mcpconfig.js'
import { StreamParser, type StreamEvent } from './stream.js'

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

/**
 * How agentyard is attached to one agent process.
 *
 * ⚠️ The two transports are not interchangeable plumbing, and this is the measured reason (2026-08-25):
 * `--print` refuses to start under a pseudo-terminal - *"Input must be provided either through stdin
 * or as a prompt argument"* - because a PTY is not piped stdin. So `stream` gets real pipes and
 * `pty` gets a terminal, and each is used where it belongs.
 */
interface Channel {
  pid: number | undefined
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface Live {
  session: Session
  channel: Channel
  scrollback: string[]
  scrollbackBytes: number
  purpose: SessionPurpose
  /** Only for the `stream` transport, where output is a machine protocol rather than a screen. */
  parser: StreamParser | null
}

const live = new Map<string, Live>()

export interface SessionEvents {
  onChange(session: Session): void
  onData(sessionId: string, data: string): void
  onExit(sessionId: string, exitCode: number | null): void
  /** Structured records from the `stream` transport - rate limits, results. Never screen text. */
  onStream(session: Session, event: StreamEvent): void
}

let events: SessionEvents = { onChange() {}, onData() {}, onExit() {}, onStream() {} }
export function setSessionEvents(e: SessionEvents): void {
  events = e
}

/**
 * Per-session subscriptions, for callers that are waiting on **one** session rather than watching
 * the fleet - a consult waiting for its answer, a chat waiting for a reply.
 *
 * Kept beside the global sink rather than routed through it because the daemon's single sink belongs
 * to the process wiring in index.ts, and a request-scoped listener that had to be registered there
 * would leak every time a caller forgot to unregister.
 */
type StreamListener = (event: StreamEvent) => void
type EndListener = (exitCode: number | null) => void
const streamListeners = new Map<string, Set<StreamListener>>()
const endListeners = new Map<string, Set<EndListener>>()

export function onSessionStream(id: string, cb: StreamListener): () => void {
  const set = streamListeners.get(id) ?? new Set<StreamListener>()
  streamListeners.set(id, set)
  set.add(cb)
  return () => set.delete(cb)
}

export function onSessionEnd(id: string, cb: EndListener): () => void {
  const set = endListeners.get(id) ?? new Set<EndListener>()
  endListeners.set(id, set)
  set.add(cb)
  return () => set.delete(cb)
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
  purpose: string
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
    purpose: (r.purpose as SessionPurpose) ?? 'work',
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
  permissionMode?: string | undefined
  argv?: string[] | undefined
  cols?: number | undefined
  rows?: number | undefined
  purpose?: SessionPurpose | undefined
}

export function spawnSession(opts: SpawnOptions): Session {
  const worker = requireWorker(opts.workerId)
  if (worker.retiredAt) throw new Error(`worker '${worker.label}' is retired`)
  const purpose = opts.purpose ?? 'work'

  if (purpose !== 'login') {
    if (!worker.enabled) throw new Error(`worker '${worker.label}' is disabled`)
    // A human-occupied worker's quota is tracked and never spent. Logging in is still allowed;
    // running work on it is not.
    if (worker.humanOccupied) {
      throw new Error(`worker '${worker.label}' is marked human-occupied`)
    }
  }

  if (purpose === 'work') {
    const running = sessionsForWorker(worker.id).filter((s) => s.purpose === 'work').length
    if (running >= worker.maxConcurrent) {
      throw new Error(
        `worker '${worker.label}' is at its concurrency limit (${running}/${worker.maxConcurrent})`
      )
    }
  }

  // ⚠️ A consult is exempt from `maxConcurrent` and bounded separately - one at a time per worker.
  // That limit exists to bound unattended *work*: parallel agents editing repositories and spending
  // the window for hours. A consult is one short tool-less turn holding no workspace, and counting it
  // as work would mean the fleet cannot ask for judgment exactly when it is busiest, which is when
  // judgment is worth the most. The real bounds on it are in controller.ts: one per worker, a
  // fleet-wide hourly cap, and the same quota gates work goes through.
  if (purpose === 'consult') {
    const inFlight = sessionsForWorker(worker.id).filter((s) => s.purpose === 'consult').length
    if (inFlight > 0) throw new Error(`worker '${worker.label}' is already answering a consult`)
  }

  // A login flow has no project yet, so home is the sane default rather than the daemon's own cwd.
  const cwd = opts.cwd && opts.cwd !== '.' ? opts.cwd : homedir()
  if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)
  ensureDir(worker.isolationRoot)

  const ad = adapter(worker.adapterId)
  // Minted here, before the process exists, so the transcript path is known before the file is.
  const id = randomUUID()
  const transport: SessionTransport = opts.transport ?? 'pty'
  // ⛔ Tool sets, by purpose, and each is a deliberate cost and trust decision:
  //  - `login`   — no tools. The vendor's own credential flow and nothing else.
  //  - `consult` — no tools. A consult is a judgment call answered as JSON that the daemon validates
  //                and applies itself; an unattended controller that could *act* would be a much
  //                larger thing to trust, and every tool definition is also cache prefix.
  //  - `chat`    — the controller tier, because a person is watching what it does.
  //  - `work`    — the worker tier.
  const mcpConfig =
    purpose === 'work'
      ? writeMcpConfig(id, 'worker')
      : purpose === 'chat'
        ? writeMcpConfig(id, 'controller')
        : null
  const plan = ad.plan({
    sessionId: id,
    isolationRoot: worker.isolationRoot,
    cwd,
    transport,
    model: opts.model,
    permissionMode: opts.permissionMode,
    mcpConfig,
    argv: opts.argv
  })

  const emitData = (data: string) => {
    const entry = live.get(id)
    if (!entry) return
    if (entry.parser) {
      const listeners = streamListeners.get(id)
      for (const event of entry.parser.push(data)) {
        events.onStream(entry.session, event)
        for (const listener of listeners ?? []) listener(event)
      }
    }
    entry.scrollback.push(data)
    entry.scrollbackBytes += data.length
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      entry.scrollbackBytes -= entry.scrollback.shift()?.length ?? 0
    }
    events.onData(id, data)
  }

  const handleExit = (exitCode: number | null) => {
    live.delete(id)
    removeMcpConfig(id)
    for (const listener of endListeners.get(id) ?? []) listener(exitCode)
    streamListeners.delete(id)
    endListeners.delete(id)
    setState(id, exitCode === 0 ? 'closed' : 'failed')
    events.onExit(id, exitCode)
    log.info(`session ${id.slice(0, 8)} exited with ${exitCode}`)
  }

  const channel =
    transport === 'stream'
      ? openPipes(plan, cwd, emitData, handleExit)
      : openPty(plan, cwd, opts.cols ?? 120, opts.rows ?? 30, emitData, handleExit)

  // Metered like anything else: a judgment call is not free, and the ledger reports what each one
  // cost from this transcript rather than from an estimate.
  const transcriptPath = purpose === 'login' ? null : ad.transcriptPath(worker.isolationRoot, cwd, id)
  const now = Date.now()
  db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, pid,
                             purpose, transcript_path, tokens_since_compact, started_at)
       values (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, 0, ?)`
    )
    .run(
      id,
      worker.id,
      worker.adapterId,
      transport,
      cwd,
      opts.model ?? null,
      channel.pid ?? null,
      purpose,
      transcriptPath,
      now
    )

  const session = getSession(id)
  if (!session) throw new Error('session row vanished immediately after insert')
  live.set(id, {
    session,
    channel,
    scrollback: [],
    scrollbackBytes: 0,
    purpose,
    parser: transport === 'stream' ? new StreamParser() : null
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

/**
 * Send a user message, in whatever shape this session's transport expects.
 *
 * ⚠️ This is why unattended work runs on `stream`, not `pty`. Two independent reasons, both measured:
 * the CLI's **workspace trust dialog is skipped in non-interactive mode** and would otherwise block
 * every dispatch into a fresh worktree with nobody there to answer it; and `--permission-prompt-tool`
 * only exists in non-interactive mode, which is the whole structured-approval channel. A `pty`
 * session is for a human at the keyboard, where both of those are fine.
 */
export function sendPrompt(id: string, text: string): void {
  const entry = live.get(id)
  if (!entry) throw new Error(`session '${id}' is not live`)
  if (entry.session.transport === 'stream') {
    const envelope = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
    entry.channel.write(`${JSON.stringify(envelope)}\n`)
  } else {
    entry.channel.write(`${text}\r`)
  }
}

export function writeSession(id: string, data: string): void {
  const entry = live.get(id)
  if (!entry) throw new Error(`session '${id}' is not live`)
  entry.channel.write(data)
}

/**
 * Interrupt a session the way a person would - the adapter's own key, not a signal. A killed agent
 * leaves its work uncommitted and its claims held; an interrupted one can be asked to wrap up.
 */
export function interruptSession(id: string): void {
  const entry = live.get(id)
  if (!entry) return
  const sequence = adapter(entry.session.adapterId).info.policy.interruptSequence
  try {
    entry.channel.write(sequence)
  } catch (err) {
    log.warn(`could not interrupt session ${id}:`, err)
  }
}

export function resizeSession(id: string, cols: number, rows_: number): void {
  const entry = live.get(id)
  if (!entry) return
  try {
    entry.channel.resize(Math.max(2, cols), Math.max(1, rows_))
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
    entry.channel.kill()
  } catch (err) {
    log.warn(`could not kill session ${id}:`, err)
    setState(id, 'failed')
  }
}

/**
 * Called at startup. Rows left `live` by a daemon that died are lies - but the *processes* may not
 * be.
 *
 * ⛔ An agent whose supervisor died keeps running, keeps calling the API and keeps spending the
 * account's window, with nothing watching it and nowhere for its work to land. So orphaned pids are
 * killed, not just marked. Leaving them alive is the one failure mode a quota-aware tool must not
 * have.
 */
export function reconcileOrphans(): number {
  const stale = rows<SessionRow>(
    db().prepare("select * from sessions where state not in ('closed','failed')").all()
  )
  let killed = 0
  for (const r of stale) {
    if (r.pid && isAlive(r.pid) && ownsProcess(r.pid, r.id)) {
      try {
        process.kill(r.pid)
        killed++
      } catch (err) {
        log.warn(`could not stop orphaned agent pid ${r.pid}:`, err)
      }
    }
    db()
      .prepare("update sessions set state = 'failed', closed_at = ? where id = ?")
      .run(Date.now(), r.id)
    removeMcpConfig(r.id)
  }
  if (stale.length) {
    log.warn(
      `marked ${stale.length} orphaned session(s) failed at startup` +
        (killed ? `, stopped ${killed} still-running agent process(es)` : '')
    )
  }
  return stale.length
}

/**
 * Is this pid still the process we started?
 *
 * ⛔ Liveness alone is not enough to justify killing something. Pids are recycled, and "kill whatever
 * is at this number now" is how a tool takes out an editor, another agent window, or the user's own
 * shell. The session id is a uuid *we* minted and passed as `--session-id`, so finding it in the
 * process's own command line is proof of identity that a recycled pid cannot fake.
 *
 * If the command line cannot be read, the answer is **no**. Leaving one orphan running costs quota;
 * killing the wrong process costs somebody their work.
 */
function ownsProcess(pid: number, sessionId: string): boolean {
  try {
    const commandLine =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
            ],
            { encoding: 'utf8', timeout: 10_000, windowsHide: true }
          )
        : execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
            encoding: 'utf8',
            timeout: 10_000
          })
    return commandLine.includes(sessionId)
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function shutdownAll(): void {
  for (const [id, entry] of live) {
    try {
      entry.channel.kill()
    } catch {
      // Best effort; the daemon is going away regardless.
    }
    setState(id, 'closed')
  }
  live.clear()
}

// ---------------------------------------------------------------------------- channels

/** A terminal a human can watch and type into. What "take the keyboard" needs. */
function openPty(
  plan: { command: string; args: string[]; env: Record<string, string> },
  cwd: string,
  cols: number,
  rows_: number,
  onData: (data: string) => void,
  onExit: (code: number | null) => void
): Channel {
  const proc = pty.spawn(plan.command, plan.args, {
    name: 'xterm-256color',
    cols,
    rows: rows_,
    cwd,
    env: plan.env
  })
  proc.onData(onData)
  proc.onExit(({ exitCode }) => onExit(exitCode))
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill()
  }
}

/**
 * Real pipes, for the machine protocol.
 *
 * ⚠️ Not a PTY, and not by preference: `--print` exits immediately under one, because a
 * pseudo-terminal is not piped stdin. Measured 2026-08-25.
 */
function openPipes(
  plan: { command: string; args: string[]; env: Record<string, string> },
  cwd: string,
  onData: (data: string) => void,
  onExit: (code: number | null) => void
): Channel {
  const child = spawnChild(plan.command, plan.args, {
    cwd,
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => onData(d))
  // stderr is where the CLI puts its diagnostics; showing it is how a broken spawn stops being a
  // silent one.
  child.stderr?.on('data', (d: string) => onData(d))
  child.on('exit', (code) => onExit(code))
  child.on('error', (err) => {
    onData(`\n[agentyard] could not start: ${err.message}\n`)
    onExit(-1)
  })
  return {
    pid: child.pid,
    write: (data) => {
      child.stdin?.write(data)
    },
    // A pipe has no geometry. Silently doing nothing is the correct behaviour, not a failure.
    resize: () => undefined,
    kill: () => {
      child.kill()
    }
  }
}
