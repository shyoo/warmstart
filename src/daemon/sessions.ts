import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from '@lydell/node-pty'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import type {
  Session,
  SessionPurpose,
  SessionState,
  SessionTransport,
  Worker
} from '@shared/protocol.js'
import type { CacheMove } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { refreshIdentity, requireWorker, watchReadiness } from './workers.js'
import { log } from './log.js'
import { ensureDir, paths } from './paths.js'
import { removeMcpConfig, writeMcpConfig } from './mcpconfig.js'
import { StreamParser, renderForHuman, type StreamEvent } from './stream.js'

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
 * Answer the vendor's folder-trust question for the app's own scratch directory, in advance.
 *
 * ⚠️ **Deliberately narrow, and the narrowness is the whole justification.** The question a CLI asks
 * is whether an agent may act on the files in a folder. The only folder answered here is
 * `<dataDir>/scratch`: created by this app, kept empty, and used solely by sessions that have no
 * project - a login, and the usage probe. ⛔ It is never called for a project, a worktree, or
 * anybody's home directory, and an operator's own trust decisions are untouched.
 *
 * Without it the probe cannot work unattended at all: measured 2026-08-27, an unanswered trust
 * dialog swallows every keystroke sent to the session, so `/usage` was typed into the dialog and
 * the Enter after it accepted the folder - reporting "no fresher reading" forever.
 *
 * Set `MULTI_AGENT_CONTROLLER_AUTO_TRUST=0` to turn it off and answer the dialog by hand instead.
 */
const AUTO_TRUST_SCRATCH = process.env.MULTI_AGENT_CONTROLLER_AUTO_TRUST !== '0'

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

/**
 * The last screen of a session that has already exited.
 *
 * ⛔ Without this a short-lived session loses its output completely. `handleExit` drops the entry
 * from `live`, `emitData` returns early when there is no entry, and `backscroll` reads `live` - so
 * bytes arriving in the same tick as the exit were discarded, and anything a UI asked for afterwards
 * came back empty. Windows only ever passed because conpty happens to deliver data before the exit.
 *
 * ⚠️ This is exactly the output a person most needs to read: a `login` session that fails prints its
 * reason and exits, and the pane went blank at precisely that moment. Found by CI on Linux, where a
 * command that echoes one line and exits produced zero bytes.
 *
 * Bounded on both axes - the same byte cap as a live session, and a fixed number of sessions, oldest
 * dropped first - because this is a convenience for reading, not a record. The transcript is the
 * record.
 */
const finished = new Map<string, string>()
const FINISHED_SESSIONS = 32

function retainScrollback(id: string, text: string): void {
  // Re-inserting moves it to the end, which is what makes the eviction below oldest-first.
  finished.delete(id)
  finished.set(id, text.length > SCROLLBACK_BYTES ? text.slice(-SCROLLBACK_BYTES) : text)
  while (finished.size > FINISHED_SESSIONS) {
    const oldest = finished.keys().next().value
    if (oldest === undefined) break
    finished.delete(oldest)
  }
}

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
  clock_move: string | null
  clock_move_at: number | null
  clock_move_attempts: number
  clock_move_context: number | null
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
    contextWindow: contextWindowFor(r.adapter_id, r.model),
    lastRequestStartedAt: r.last_request_started_at,
    cacheExpiresAt: r.cache_expires_at,
    tokensSinceCompact: r.tokens_since_compact,
    clockMove: (r.clock_move as CacheMove | null) ?? null,
    clockMoveAt: r.clock_move_at,
    clockMoveAttempts: r.clock_move_attempts ?? 0,
    clockMoveContext: r.clock_move_context,
    startedAt: r.started_at,
    closedAt: r.closed_at
  }
}

/**
 * ⚠️ Never a default. `scheduler.ts` falls back to 200k when scoring context rot, because a
 * score has to be a number and being roughly right there costs nothing. A *displayed* window is
 * different: `52k/200k` shown for a session whose real window is 1M is a wrong number wearing a
 * measurement's clothes, and the reader has no way to tell. Unknown stays unknown.
 */
function contextWindowFor(adapterId: string, model: string | null): number | null {
  if (!model) return null
  try {
    const spec = costModel(adapter(adapterId).info.policy.costModelId).modelSpec(model)
    return spec?.context_window ?? null
  } catch {
    // An unknown adapter or an unpriced model is a missing denominator, not a broken session.
    return null
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
  /** ⛔ Only ever set by a caller that checked the adapter declares `selectableEffort`. */
  effort?: string | undefined
  permissionMode?: string | undefined
  argv?: string[] | undefined
  cols?: number | undefined
  rows?: number | undefined
  purpose?: SessionPurpose | undefined
}

/**
 * Why no session may be started on this worker at all, or `null`.
 *
 * ⛔ Signing in is exempt from everything except retirement: `off` is not retirement, and a
 * switch that locked the operator out of repairing the account it switched off would be a trap.
 *
 * ⚠️ Exported so a caller can ask *before* trying, rather than catching the throw. `refreshUsage`
 * used to spawn unconditionally and log `usage refresh failed on adopted: worker is disabled`
 * with a stack trace - which reads as a fault, when the correct behaviour is simply to read the
 * cache instead. ⛔ Deliberately *not* `accountUnavailability`: a `suspect` worker must still be
 * probeable by hand, because that is one of the two things that lift the hold.
 */
export function whyNoSession(worker: Worker, purpose: SessionPurpose): string | null {
  if (worker.retiredAt) return `worker '${worker.label}' is retired`
  if (purpose === 'login') return null
  if (!worker.enabled) return `worker '${worker.label}' is disabled`
  // A human-occupied worker's quota is tracked and never spent. Logging in is still allowed;
  // running work on it is not.
  if (worker.humanOccupied) return `worker '${worker.label}' is marked human-occupied`
  return null
}

export function spawnSession(opts: SpawnOptions): Session {
  const worker = requireWorker(opts.workerId)
  const purpose = opts.purpose ?? 'work'

  const blocked = whyNoSession(worker, purpose)
  if (blocked) throw new Error(blocked)

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

  // One probe at a time per worker. Two TUIs racing to rewrite the same usage cache would answer a
  // question nobody asked twice, and the second reading is not fresher than the first.
  if (purpose === 'probe') {
    const inFlight = sessionsForWorker(worker.id).filter((s) => s.purpose === 'probe').length
    if (inFlight > 0) throw new Error(`worker '${worker.label}' is already refreshing its usage`)
  }

  // ⛔ A session with no project runs in a directory this app owns, never in the user's home.
  // Measured 2026-08-27: the CLI asks whether it trusts the folder it opened in - per account, once
  // per folder - and until that is answered it swallows everything typed at it. The usage probe was
  // typing `/usage` into that dialog and pressing Enter on "Yes, I trust this folder", every time,
  // reporting no fresher reading and blaming onboarding. An empty directory makes the question
  // trivial to answer and keeps the answer reusable.
  const projectless = purpose === 'login' || purpose === 'probe'
  const cwd =
    opts.cwd && opts.cwd !== '.' ? opts.cwd : projectless ? ensureDir(paths.scratch) : homedir()

  // ⛔ Only ever the scratch directory, and only for a session with no project. See the constant.
  if (projectless && AUTO_TRUST_SCRATCH && cwd === paths.scratch) {
    adapter(worker.adapterId).trustDirectory?.(worker.isolationRoot, cwd)
  }
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
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    mcpConfig,
    argv: opts.argv
  })

  // Stopped from handleExit, whichever way the session ends. Declared here so both closures see it.
  let stopReadinessWatch: (() => void) | null = null

  const emitData = (data: string) => {
    const entry = live.get(id)
    if (!entry) {
      // ⚠️ After the exit, not before it. node-pty can deliver the final write after `onExit` on
      // Linux, and this used to `return` - throwing away the last thing the process said.
      retainScrollback(id, (finished.get(id) ?? '') + data)
      events.onData(id, data)
      return
    }
    // ⛔ A `stream` session's stdout is a machine protocol, and it never reaches the pane as itself.
    // It used to: the first dispatched task filled the terminal with raw stream-json, because the
    // same bytes were forwarded to xterm that the parser was reading. What a person gets instead is
    // the decoded events, and only the ones that mean something to them.
    const shown = entry.parser ? renderStream(entry, id, data) : data
    if (!shown) return

    entry.scrollback.push(shown)
    entry.scrollbackBytes += shown.length
    while (entry.scrollbackBytes > SCROLLBACK_BYTES && entry.scrollback.length > 1) {
      entry.scrollbackBytes -= entry.scrollback.shift()?.length ?? 0
    }
    events.onData(id, shown)
  }

  /** Feed the parser, fan the events out to everyone waiting, and return what a human should see. */
  const renderStream = (entry: Live, id: string, data: string): string => {
    const listeners = streamListeners.get(id)
    let text = ''
    for (const event of entry.parser?.push(data) ?? []) {
      events.onStream(entry.session, event)
      for (const listener of listeners ?? []) listener(event)
      text += renderForHuman(event)
    }
    return text
  }

  const handleExit = (exitCode: number | null) => {
    const exiting = live.get(id)
    if (exiting) retainScrollback(id, exiting.scrollback.join(''))
    live.delete(id)
    removeMcpConfig(id)
    for (const listener of endListeners.get(id) ?? []) listener(exitCode)
    streamListeners.delete(id)
    endListeners.delete(id)
    setState(id, exitCode === 0 ? 'closed' : 'failed')
    events.onExit(id, exitCode)
    log.info(`session ${id.slice(0, 8)} exited with ${exitCode}`)

    // A login session ending is the one moment we *know* the answer to "who is signed in?" may have
    // changed. Identity used to be read once at commissioning and never again, which meant a worker
    // that had just finished signing in stayed permanently undispatchable.
    if (purpose === 'login') {
      stopReadinessWatch?.()
      void refreshIdentity(opts.workerId).catch((err: unknown) => {
        log.warn(`could not re-read identity after login session ${id.slice(0, 8)}:`, err)
      })
    }
  }

  if (transport === 'stream' && !ad.decodeStream) {
    log.warn(
      `${ad.info.label} offers the stream transport but decodes no records; this session will ` +
        'produce no usage, no result text and no rate-limit signal'
    )
  }

  const channel =
    transport === 'stream'
      ? openPipes(plan, cwd, emitData, handleExit)
      : openPty(plan, cwd, opts.cols ?? 120, opts.rows ?? 30, emitData, handleExit)

  // Metered like anything else: a judgment call is not free, and the ledger reports what each one
  // cost from this transcript rather than from an estimate.
  //
  // ⚠️ Null is normal for an adapter that cannot mint a session id: the CLI names its own transcript,
  // so there is nothing to predict and `findTranscriptLater` goes looking once the file exists.
  // Guessing at the name would risk metering somebody else's session as ours.
  const transcriptPath = purpose === 'login' ? null : ad.transcriptPath(worker.isolationRoot, cwd, id)
  const now = Date.now()
  db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, pid,
                             purpose, transcript_path, tokens_since_compact, started_at, effort)
       values (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, 0, ?, ?)`
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
      now,
      // ⚠️ What was *asked for*, recorded so the detail pane can say so before a turn has run. The
      // transcript overwrites it with what actually happened — `coalesce` in transcript.ts keeps
      // this value only until the first turn reports one, which is the right precedence.
      opts.effort ?? null
    )

  const session = getSession(id)
  if (!session) throw new Error('session row vanished immediately after insert')
  live.set(id, {
    session,
    channel,
    scrollback: [],
    scrollbackBytes: 0,
    purpose,
    // ⛔ The adapter's own decoder, not a shared one. The three CLIs' stream formats agree on
    // almost nothing, and a parser keyed on the wrong dialect returns an empty list for every line
    // rather than an error. An adapter that offers `stream` and no decoder gets nothing, loudly.
    parser:
      transport === 'stream' && ad.decodeStream ? new StreamParser(ad.decodeStream) : null
  })

  log.info(
    `spawned ${purpose} session ${id.slice(0, 8)} on ${worker.label}: ${plan.command} ${plan.args.join(' ')}`
  )
  setState(id, 'live')
  if (!transcriptPath && purpose !== 'login' && ad.discoverTranscript) {
    findTranscriptLater(id, worker.isolationRoot, cwd, now)
  }

  // ⛔ A sign-in that has succeeded should not need to be reported to this app by the person who
  // just did it. The vendor writes its own config the moment the credential lands or the first-run
  // screens are answered; that write is watched, identity is re-read, and the terminal closes itself
  // once the worker is actually usable. `auth login` exits on its own, but the first-run session is
  // a plain agent prompt that sits there forever - which is exactly where somebody was left
  // wondering whether it had worked.
  if (purpose === 'login') {
    stopReadinessWatch = watchReadiness(worker.id, () => {
      log.info(`${worker.label} is signed in and set up; closing its ${purpose} terminal`)
      closeSession(id)
    })
  }

  return getSession(id) ?? session
}

/** How long to keep looking for a transcript a CLI names itself, and how often. */
const DISCOVER_ATTEMPTS = 20
const DISCOVER_INTERVAL_MS = 1500

/**
 * Watch for the transcript an adapter could not predict.
 *
 * ⛔ Without this a session on a non-minting adapter is **never metered** - no turns, no context
 * size, no cache expiry - and the cost model would report it as costing nothing rather than as
 * unknown, which is much the worse of the two failures.
 *
 * Gives up quietly after half a minute. A session with no transcript still runs and still completes;
 * it is simply invisible to the meter, and that is what Doctor reports.
 */
function findTranscriptLater(
  sessionId: string,
  isolationRoot: string,
  cwd: string,
  startedAt: number
): void {
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    const entry = live.get(sessionId)
    if (!entry || attempts > DISCOVER_ATTEMPTS) {
      clearInterval(timer)
      if (entry) {
        log.warn(`no transcript appeared for session ${sessionId.slice(0, 8)}; it will run unmetered`)
      }
      return
    }
    let found: string | null = null
    try {
      found =
        adapter(entry.session.adapterId).discoverTranscript?.(isolationRoot, cwd, startedAt) ?? null
    } catch (err) {
      log.warn('transcript discovery failed:', err)
    }
    if (!found) return

    clearInterval(timer)
    db().prepare('update sessions set transcript_path = ? where id = ?').run(found, sessionId)
    log.info(`session ${sessionId.slice(0, 8)} writes its transcript at ${found}`)
    // Re-announcing is what starts the tailer: index.ts attaches one when a live session first has a
    // path, and at spawn time this one did not.
    const updated = getSession(sessionId)
    if (updated) {
      entry.session = updated
      events.onChange(updated)
    }
  }, DISCOVER_INTERVAL_MS)
  timer.unref?.()
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
    const ad = adapter(entry.session.adapterId)
    const payload = ad.encodeStreamPrompt
      ? ad.encodeStreamPrompt(text)
      : JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        })
    entry.channel.write(`${payload}\n`)
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
  const entry = live.get(id)
  if (entry) return entry.scrollback.join('')
  // ⛔ Falls back to what the session said before it exited, rather than to ''. See `finished`.
  return finished.get(id) ?? ''
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
  let unidentifiable = 0
  for (const r of stale) {
    // ⛔ An adapter that will not accept a session id we chose leaves nothing of ours in the process's
    // command line, so identity **cannot be established** - and the standing rule is that agentyard
    // kills only what it can prove is its own. Leaving an orphan running costs quota; killing the
    // wrong process costs somebody their work, and that has happened here for real once already.
    const identifiable = adapterMintsIds(r.adapter_id)
    if (r.pid && isAlive(r.pid) && !identifiable) {
      unidentifiable++
    } else if (r.pid && isAlive(r.pid) && ownsProcess(r.pid, r.id)) {
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
  if (unidentifiable) {
    log.warn(
      `${unidentifiable} orphaned process(es) were left running: their adapter does not accept a ` +
        'session id, so they cannot be proved to be its own. Stop them by hand if they are. ' +
        'Doctor reports this.'
    )
  }
  return stale.length
}

/** Does this adapter let agentyard name the session? Unknown adapters are treated as "no". */
function adapterMintsIds(adapterId: string): boolean {
  try {
    return adapter(adapterId).info.capabilities.mintsSessionId
  } catch {
    return false
  }
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
    onData(`\n[multi-agent-controller] could not start: ${err.message}\n`)
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

// ---------------------------------------------------------------- cache-clock moves in flight

/**
 * Write down that the clock has *asked* a session to do something.
 *
 * ⛔ The distinction this exists to keep: a move is a request, and the outcome arrives minutes
 * later or never. `decide()` is a pure function of the session row, so without a record of the
 * request the same inputs produce the same move on the next 10s tick - which is how one session
 * was sent `/compact` thirteen times in two minutes, each one a billable user message, by the one
 * component whose whole job is to not waste tokens.
 *
 * `context` is `tokens_since_compact` at the moment of the ask. Compaction resets it to zero, so a
 * drop is proof the move landed; "a turn happened" is not, because an agent answering "I don't
 * understand /compact" is also a turn.
 */
export function markClockMove(sessionId: string, move: CacheMove, context: number): void {
  db()
    .prepare(
      `update sessions
          set clock_move = ?, clock_move_at = ?, clock_move_context = ?,
              clock_move_attempts = case when clock_move = ? then clock_move_attempts + 1 else 1 end
        where id = ?`
    )
    .run(move, Date.now(), context, move, sessionId)
}

/** The move landed, or is no longer worth waiting for. Attempts reset with it. */
export function clearClockMove(sessionId: string): void {
  db()
    .prepare(
      `update sessions
          set clock_move = null, clock_move_at = null, clock_move_context = null,
              clock_move_attempts = 0
        where id = ?`
    )
    .run(sessionId)
}
