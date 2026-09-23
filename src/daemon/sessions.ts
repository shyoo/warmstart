import { capacitySpawnError } from '@shared/capacity.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from '@lydell/node-pty'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import type {
  AdapterInfo,
  Session,
  SessionPurpose,
  SessionState,
  SessionStreamLine,
  SessionTransport,
  UnattendedAuthority,
  Worker
} from '@shared/protocol.js'
import { sessionEnded } from '@shared/protocol.js'
import type { Attachment, CacheMove } from '@shared/tasks.js'
import { grantedDirsFor } from './attachments.js'
import { db, row, rows } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { samePath } from './fspath.js'
import { getWorker, refreshIdentity, requireWorker, watchReadiness } from './workers.js'
import { log } from './log.js'
import { ensureDir, paths } from './paths.js'
import { removeMcpConfig, writeMcpConfig } from './mcpconfig.js'
import { StreamParser, describeStream, renderForHuman, stripAnsi, type SpawnAsked, type StreamEvent } from './stream.js'
import { settings } from './settings.js'
import { formatCmdInvocation, unwrapForPty } from './which.js'
import { terminalAnswerer } from './termquery.js'
import { appEnv } from '@shared/env.js'

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
 * Set `WARMSTART_AUTO_TRUST=0` to turn it off and answer the dialog by hand instead.
 */
const AUTO_TRUST_SCRATCH = appEnv('AUTO_TRUST') !== '0'

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
  /**
   * Close the input side and leave the process running.
   *
   * ⛔ Not `kill`. A CLI that reads its prompt from stdin to EOF - `codex exec` - only starts
   * working once this is called, so for a `streamPrompts: 'once'` adapter this is the go signal and
   * not a teardown. A PTY has no separate input side to close, which is why it is a no-op there.
   */
  end(): void
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
  /** Set once a `streamPrompts: 'once'` session has had its one prompt and its stdin closed. */
  promptedOnce: boolean
  /**
   * When the turn now in flight was handed to the CLI.
   *
   * ⭐ **The request start a `metering: 'stream'` session has no other way to know.** The transcript
   * path reads it off the record before the assistant's, and a stream has no such record - so the
   * cache clock was simply never set for codex or Antigravity, and their sessions drew a blank
   * countdown for as long as they existed. This is the moment the prompt went down the pipe, which
   * is what `ttl_measured_from: request_start` means. See `creditStreamTurn`.
   */
  promptedAt: number | null
  /**
   * When this session last produced evidence that a model request was in flight.
   *
   * ⭐ **The mid-turn request start that `promptedAt` cannot be.** `promptedAt` is stamped once, when
   * the prompt goes down the pipe, and `codex exec` takes exactly one prompt and then works for as
   * long as the task needs — dozens of model requests, one turn, one usage record at the very end.
   * So the only request start the fleet knew about was the *first* one, and a codex run longer than
   * OpenAI's 30-minute prefix TTL ended by declaring its own cache lapsed at the moment it was
   * warmest. See `creditStreamTurn` and `touchCacheClock`.
   *
   * ⚠️ Deliberately **not** stamped by the terminal `usage`/`result` pair. Those arrive when the turn
   * is over, and a prefix's TTL runs from the request that reused it, not from the response that
   * ended it (`ttl_measured_from: request_start`). The last *mid-turn* record is the newest evidence
   * that errs in the safe direction; taking the terminal one would credit the whole final response
   * as if it were part of the window. ⛔ `init` is excluded for the opposite reason: `thread.started`
   * is printed before any request, so it is evidence of a process, not of a cache.
   */
  lastActivityAt: number | null
  /** What this session's command line asked for, so its opening line can say so. See `initLine`. */
  asked: SpawnAsked
}

const live = new Map<string, Live>()

/**
 * The stream records that are *not* evidence a model request was under way.
 *
 * ⛔ `init` is printed before the first request — a process, not a cache. `result` and `usage` are
 * the terminal pair, and a prefix's TTL runs from the request that reused it rather than from the
 * response that ended it, so crediting them would count the whole final response as window.
 * Everything else — assistant prose, an item completing, a rate-limit record riding the turn — only
 * exists because a model answered, which means the prefix was read.
 */
const NO_REQUEST_EVIDENCE = new Set<StreamEvent['kind']>(['init', 'result', 'usage'])

/** Does seeing this record prove a model request was under way? See `NO_REQUEST_EVIDENCE`. */
export function isRequestEvidence(kind: StreamEvent['kind']): boolean {
  return !NO_REQUEST_EVIDENCE.has(kind)
}

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

/**
 * The last few things a `stream` session's CLI said in its own voice, rather than in its protocol.
 *
 * ⛔ **A process that explained why it died, into a pipe nobody kept.** Measured 2026-09-14 (t436):
 * Muse Code 1.1.1 exited 1 at +4.5s with an empty stdout, having written
 * `runtime host failed to start: failed to read skill file at C:\Dev\warmstart/.codex/skills: Not a
 * directory (os error 20)` to stderr. `openPipes` already merges stderr into the same `onData`, and
 * `StreamParser` already skipped it as the ordinary chatter it usually is — so three quality reviews
 * were filed as *the reviewer's session ended before it answered*, which is true, uninformative, and
 * blames the reviewer for a workspace the CLI refused to open. The cause was one grep away from the
 * operator and nothing carried it there.
 *
 * ⚠️ **A tail, and only read when there is nothing better.** This is not a log: a healthy run's
 * chatter (`muse: workspace root: …`, codex's `Reading additional input from stdin…`) lands here
 * too, and quoting it at a session that answered normally would be noise. `sessionDiagnostics` is
 * read on exactly one path — a session that ended with no answer — where the alternative is
 * silence. Bounded on both axes, like `retainScrollback` and for the same reason.
 */
const DIAGNOSTIC_LINES = 5
const DIAGNOSTIC_CHARS = 300
const diagnostics = new Map<string, string[]>()

function noteDiagnostic(id: string, line: string): void {
  const said = stripAnsi(line).trim()
  if (!said) return
  const lines = diagnostics.get(id) ?? []
  lines.push(said.length > DIAGNOSTIC_CHARS ? `${said.slice(0, DIAGNOSTIC_CHARS)}…` : said)
  while (lines.length > DIAGNOSTIC_LINES) lines.shift()
  diagnostics.set(id, lines)
}

/**
 * What this session's CLI said outside its protocol, newest last, or null if it said nothing.
 *
 * ⛔ Reported verbatim. The vendor's own sentence names the file, the flag or the account, which no
 * sentence written here could — the same reason `resultError` unwraps rather than classifies.
 */
export function sessionDiagnostics(id: string): string | null {
  const lines = diagnostics.get(id)
  return lines?.length ? lines.join(' / ') : null
}

/** Keep an exited session's last words, oldest session evicted first. See `retainStreamLog`. */
function retainDiagnostics(id: string): void {
  const lines = diagnostics.get(id)
  if (!lines) return
  diagnostics.delete(id)
  diagnostics.set(id, lines)
  for (const key of [...diagnostics.keys()]) {
    if (diagnostics.size <= FINISHED_SESSIONS) break
    if (!live.has(key)) diagnostics.delete(key)
  }
}

/**
 * The decoded log a `stream` session's live view reads back when it is opened mid-run.
 *
 * ⛔ **Not the transcript and not the scrollback.** The transcript is the machine's exact copy and
 * stays the machine's; the scrollback is what a terminal should draw, which for a pipe session is
 * `renderForHuman`'s ANSI and cannot be laid out. This is the third thing, and it exists for the
 * same reason `activity.ts` does: a pane opened in the middle of a run has to show what has already
 * happened, and re-deriving it from a file the daemon does not own is not available.
 *
 * ⚠️ In memory and bounded, on purpose. Its correct lifetime is the process: a `stream` session that
 * is gone has nothing live to look at, and a log that outlived it would be describing a run that no
 * longer exists. What was *decided* is on the thread, which is the durable record.
 */
const STREAM_LOG_LINES = 500
const streamLogs = new Map<string, SessionStreamLine[]>()
let streamSeq = 0

function noteStreamLine(id: string, line: Omit<SessionStreamLine, 'seq' | 'ts'>): SessionStreamLine {
  const full: SessionStreamLine = { ...line, seq: ++streamSeq, ts: Date.now() }
  const log = streamLogs.get(id) ?? []
  log.push(full)
  while (log.length > STREAM_LOG_LINES) log.shift()
  streamLogs.set(id, log)
  return full
}

/** What a pane opened mid-run is shown before the live feed reaches it. */
export function streamLog(id: string): SessionStreamLine[] {
  return streamLogs.get(id) ?? []
}

/**
 * Keep an exited session's log, oldest evicted first.
 *
 * ⚠️ The same bound and the same reason as `retainScrollback`: this is a convenience for reading and
 * not a record, so it is bounded on both axes and the transcript stays the thing that is kept.
 */
function retainStreamLog(id: string): void {
  const log = streamLogs.get(id)
  if (!log) return
  streamLogs.delete(id)
  streamLogs.set(id, log)
  // ⛔ A running session's log is never the one evicted, however old its first line is. The cap is
  // there to stop finished sessions accumulating; dropping the log of a session somebody is
  // watching would blank the pane of the one run that still has something to say.
  for (const key of [...streamLogs.keys()]) {
    if (streamLogs.size <= FINISHED_SESSIONS) break
    if (!live.has(key)) streamLogs.delete(key)
  }
}

export interface SessionEvents {
  onChange(session: Session): void
  onData(sessionId: string, data: string): void
  onExit(sessionId: string, exitCode: number | null): void
  /** Structured records from the `stream` transport - rate limits, results. Never screen text. */
  onStream(session: Session, event: StreamEvent): void
  /** The same records, shaped for the live view. See `streamLog`. */
  onStreamLine(sessionId: string, line: SessionStreamLine): void
}

let events: SessionEvents = {
  onChange() {},
  onData() {},
  onExit() {},
  onStream() {},
  onStreamLine() {}
}
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

/**
 * Sessions we have asked to stop.
 *
 * ⛔ **This is what tells a deliberate close from a crash, and nothing else can.** Killing a process
 * makes it exit non-zero on every platform, so `handleExit` reading only the exit code recorded every
 * shutdown we ourselves ordered — winding a task down, reclaiming a worktree, the cache clock closing
 * a cold conversation — as `failed`. Measured 2026-08-31: 81 runs with `outcome: 'completed'` inside
 * sessions the whole UI drew as failures, which is most of the reason the Conversations page read as
 * a wall of red.
 *
 * ⚠️ In memory, deliberately. It is a fact about *this* daemon's intent, and a daemon that dies
 * mid-close genuinely does not know what it meant — `reconcileOrphans` calls that `abandoned`.
 */
const closing = new Set<string>()

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

/**
 * Close a session and wait for its process to actually be gone.
 *
 * ⛔ `closeSession` asks; it does not wait. The kill is delivered and the row is not marked until
 * `handleExit` runs, so anything that needs the *worktree* rather than the row — parking it, handing
 * it to another task — must wait for the process, not for the call to return. Reclaiming a tree while
 * the last agent still holds file handles in it is how a git operation fails for reasons nobody can
 * reproduce.
 *
 * ⚠️ Resolves rather than throwing when the wait times out. The caller is already committed to losing
 * this session; a process that will not die is a reason to stop *reusing* its workspace, not a reason
 * to fail the dispatch that asked. `false` says the wait ran out, so the caller can decline to hand
 * the tree on.
 */
export function closeAndWait(id: string, timeoutMs = 15_000): Promise<boolean> {
  if (!live.has(id)) {
    setState(id, 'closed')
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      resolve(ok)
    }
    const off = onSessionEnd(id, () => finish(true))
    const timer = setTimeout(() => {
      log.warn(`session ${id.slice(0, 8)} did not exit within ${timeoutMs}ms of being closed`)
      finish(false)
    }, timeoutMs)
    timer.unref?.()
    closeSession(id)
  })
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
  vendor_session_id: string | null
  current_branch: string | null
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
    vendorSessionId: r.vendor_session_id,
    currentBranch: r.current_branch,
    contextTokens: r.context_tokens,
    contextWindow: contextWindowFor(r.adapter_id, r.model, r.worker_id),
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
function contextWindowFor(adapterId: string, model: string | null, workerId?: string | null): number | null {
  try {
    // ⭐ A window the endpoint itself reported (a local server's `/props`) beats the cost model's
    // figure for the same model: one is read off the running server, the other is a file's default.
    const reported = workerId ? getWorker(workerId)?.identity?.contextWindow : null
    if (reported) return reported
    const cm = costModel(adapter(adapterId).info.policy.costModelId)
    if (model) {
      const spec = cm.modelSpec(model)
      if (spec?.context_window) return spec.context_window
    }
    // No model named yet, on an adapter whose models are whatever the server serves: the template's
    // window is the honest default until the bridge's `init` names the model (`noteModelChosen`).
    const dynamic = cm.dynamicModelPrefix()
    if (dynamic) return cm.modelSpec(`${dynamic}?`)?.context_window ?? null
    return null
  } catch {
    // An unknown adapter or an unpriced model is a missing denominator, not a broken session.
    return null
  }
}

export function listSessions(includeClosed = false): Session[] {
  const sql = includeClosed
    ? 'select * from sessions order by started_at desc'
    : "select * from sessions where state not in ('closed','abandoned','failed') order by started_at desc"
  return rows<SessionRow>(db().prepare(sql).all()).map(toSession)
}

/**
 * When the prompt now in flight went into this session, or null if it is not live or has had none.
 *
 * ⛔ Read by `creditStreamTurn`, which is the only thing able to set a cache clock for an adapter
 * metered from its stream. Deliberately not persisted: it describes a turn in flight, and a turn
 * that finished has already written the durable `last_request_started_at` this stood in for.
 */
export function promptSentAt(id: string): number | null {
  return live.get(id)?.promptedAt ?? null
}

/**
 * The newest moment this live session showed a model request was under way, or null.
 *
 * ⛔ Read by the two things that wind a stream-metered session's cache clock — `touchCacheClock`
 * while the turn runs, and `creditStreamTurn` when it ends. Not persisted, for the same reason
 * `promptSentAt` is not: it describes a turn in flight, and a turn that ended has already written
 * the durable `last_request_started_at` it stood in for.
 */
export function lastRequestEvidenceAt(id: string): number | null {
  return live.get(id)?.lastActivityAt ?? null
}

export function getSession(id: string): Session | null {
  const r = row<SessionRow>(db().prepare('select * from sessions where id = ?').get(id))
  return r ? toSession(r) : null
}

/**
 * Record the vendor's own name for this conversation, learned from the session's first record.
 *
 * ⛔ Written once and never overwritten with null. An adapter that reports an id on every record
 * and a blank on one of them would otherwise erase the only handle that can resume it.
 */
/**
 * The model that actually answered, where the worker left the choice to its server.
 *
 * ⛔ Only a session whose `model` is null adopts it. A model the daemon *asked for* stays the
 * record of what was asked, and a CLI's `init` naming something else is a discrepancy to read in
 * the thread (`initLine`, `stream.ts`), not a fact to overwrite the request with. A local worker
 * with no default sends no model at all; the bridge asks `/v1/models` and reports what it found,
 * and this is the only way that run, its cost row and its quality grade come to name it.
 */
export function noteModelChosen(sessionId: string, model: string | null): void {
  if (!model) return
  const changed = db()
    .prepare('update sessions set model = ? where id = ? and model is null')
    .run(model, sessionId).changes
  if (!changed) return
  const session = getSession(sessionId)
  if (session) {
    const entry = live.get(sessionId)
    if (entry) entry.session = session
    events.onChange(session)
  }
}

export function noteVendorSession(sessionId: string, vendorId: string | null): void {
  if (!vendorId) return
  const changed = db()
    .prepare(
      'update sessions set vendor_session_id = ? where id = ? and coalesce(vendor_session_id, ?) = ?'
    )
    .run(vendorId, sessionId, vendorId, vendorId).changes
  if (!changed) return
  const session = getSession(sessionId)
  if (session) {
    const entry = live.get(sessionId)
    if (entry) entry.session = session
    events.onChange(session)
  }
}

/**
 * Record which branch this conversation's worktree is now on.
 *
 * ⚠️ Written after the switch has actually happened, never before. A row claiming a branch the
 * tree is not on would send the next borrower's restore to the wrong place, and the failure would
 * land on a task that did nothing wrong.
 */
export function noteCurrentBranch(sessionId: string, branch: string | null): void {
  db().prepare('update sessions set current_branch = ? where id = ?').run(branch, sessionId)
  const session = getSession(sessionId)
  if (session) {
    const entry = live.get(sessionId)
    if (entry) entry.session = session
    events.onChange(session)
  }
}

/**
 * The session that already holds this conversation and could be started again, or null.
 *
 * ⛔ **Same worker and same directory, both required.** The worker because a conversation lives
 * inside one account's isolation root and one quota bucket; the directory because Claude Code files
 * its transcripts under an encoding of the cwd, so `--resume` run from another worktree finds
 * nothing and starts cold while reporting success.
 *
 * ⚠️ Returns closed and failed sessions on purpose - those are precisely the ones worth reviving.
 * A session that is still live needs no resuming and is `warmSessionFor`'s business.
 */
function hasRecordedTurn(sessionId: string): boolean {
  return db().prepare('select 1 from turns where session_id = ? limit 1').get(sessionId) !== undefined
}

/**
 * Is a run still open against this session?
 *
 * ⛔ Asked of the **runs**, never of the session's state, because the two disagree in exactly the
 * case that matters. A daemon killed mid-run leaves the session row saying `live` and the process
 * gone; `reconcileOrphans` settles that at startup. What it cannot settle is the opposite - a row
 * that has already been marked closed while the run that was using it is still open - and handing
 * that conversation to a second task is how one agent's turn lands in another task's ledger.
 */
export function hasOpenRun(sessionId: string): boolean {
  return (
    db()
      .prepare('select 1 from runs where session_id = ? and ended_at is null limit 1')
      .get(sessionId) !== undefined
  )
}

/**
 * Every gate on reopening a conversation **except** the one about which directory it was had in.
 *
 * ⛔ Split out of `resumableSession` so the routing score and the dispatch cannot disagree about what
 * "resumable" means. They ask at different moments and can only ask different questions: the
 * dispatch has claimed a worktree and can require it back, while the score runs *before* any
 * workspace is claimed and has only a preference (`priorCwd`) to offer the pool. Two hand-written
 * copies of this list would drift, and the direction they would drift is a score that promises a
 * warm continuation the dispatch then declines to make.
 *
 * ⚠️ Everything here is a property of the conversation and the account. The cwd is not, which is
 * exactly why it is the caller's half.
 */
export function reopenable(session: Session, workerId: string): boolean {
  if (session.workerId !== workerId) return false
  if (session.purpose !== 'work') return false
  if (session.contextTokens === 0) return false
  const caps = adapter(session.adapterId).info.capabilities
  if (!caps.resumeSession) return false
  // ⛔ **The vendor's own handle, where the vendor is the one that names conversations.** `spawn`
  // resolves `resumeFrom` as `vendorSessionId ?? id`, and that fallback is right only for an
  // adapter with `mintsSessionId: true`, where the id we generated *is* the one the CLI was
  // started with. On an adapter that names its own — codex writes a `thread_id` into
  // `thread.started`, and this fleet records whatever it is given — the fallback hands the CLI a
  // UUID it has never seen. Measured against codex-cli 0.151.0: that is not a quiet no-op but a
  // hard exit, `no rollout found for thread id <uuid>`, which fails the run rather than starting
  // it cold. A session that ended before it announced itself has no handle to go back to, so it
  // is not a resume candidate at all.
  if (!caps.mintsSessionId && !session.vendorSessionId) return false
  // ⛔ A recorded turn, and nothing weaker. A session that exited before it said anything has no
  // conversation to go back to, and asking a CLI to resume one is not a quiet no-op: measured and
  // written up in cost-model.md §7, `claude --resume` on an unknown id fails the process outright
  // with *No conversation found with session ID*. Every empty session in this install's history -
  // the 0-second Antigravity exits, the two Claude sessions that failed on start - has zero turns,
  // and every real one has at least one.
  if (!hasRecordedTurn(session.id)) return false
  // ⛔ **Never take a conversation somebody is still talking in.** Two independent checks,
  // because they fail independently: a session that has not ended belongs to `warmSessionFor`,
  // which routes work into it as a live continuation rather than restarting the process; and a
  // run still open against it means a task is mid-turn there whatever the row says. Resuming
  // either would start a second process against one conversation - two agents writing the same
  // worktree, two turns billed to whichever run happened to be open, and a `task_complete` that
  // could settle the wrong task.
  if (!sessionEnded(session.state)) return false
  if (hasOpenRun(session.id)) return false
  return true
}

export function resumableSession(candidates: Session[], workerId: string, cwd: string): Session | null {
  for (const session of candidates) {
    // ⛔ `samePath`, not `!==`. On Windows the same worktree reaches this under more than one
    // spelling — this install held it as both `c:\Dev\…` and `C:\Dev\…` — and a string compare
    // decides the directory is not itself, resumes nothing, and pays a full cold start reporting
    // `warm=false` as though that were the answer. See fspath.ts.
    if (!samePath(session.cwd, cwd)) continue
    if (!reopenable(session, workerId)) continue
    return session
  }
  return null
}

/**
 * The conversations this account has finished in this project, newest first.
 *
 * ⛔ Closed and failed only, and `purpose = 'work'` only. A live one is `warmSessionFor`'s business
 * and reviving it would put two processes on one conversation; a probe or a consult holds nothing
 * worth going back to. ⚠️ `context_tokens > 0` is the cheap half of "did anything happen here" —
 * `resumableSession` still asks the expensive half, which is whether a turn was ever recorded,
 * because a `--resume` onto an id the CLI never wrote fails the process outright.
 *
 * ⚠️ Bounded. This is asked on the dispatch path, and a project a fleet has worked in for months has
 * thousands of finished conversations; the newest few dozen are the only ones with a prefix worth
 * anything anyway.
 */
export function finishedConversationsIn(
  projectId: string,
  workerId: string,
  limit = 50
): Session[] {
  return rows<SessionRow>(
    db()
      .prepare(
        `select * from sessions
          where project_id = ? and worker_id = ? and purpose = 'work'
            and state in ('closed','failed') and coalesce(context_tokens, 0) > 0
          order by coalesce(closed_at, started_at) desc
          limit ?`
      )
      .all(projectId, workerId, limit)
  ).map(toSession)
}

/**
 * Conversations with no process, whose prompt cache has **not** lapsed yet.
 *
 * ⛔ The set the cache clock could not see. `listSessions()` returns live and idle rows because every
 * move it owns is a prompt and a prompt needs a process — but a vendor-side prefix outlives the
 * process that built it by up to an hour, and a conversation between two runs of the same task is
 * *exactly* the one that sits still while that hour runs out. See `decideRevive`.
 *
 * ⚠️ `cache_expires_at` in the future is the whole filter. A conversation whose prefix has already
 * lapsed holds nothing worth spending on: reviving it would pay a cold rebuild for the privilege,
 * which is the resume-time compaction's job to weigh, not this one's.
 */
/**
 * Is this session's prompt cache already gone, making its context no cheaper than a cold start?
 *
 * ⚠️ **Null is not lapsed**, and the asymmetry is deliberate. A session that never recorded a
 * request, or one on a provider whose cache this fleet cannot price, has `cacheExpiresAt === null`
 * — an absence of knowledge, not a reading of zero. Treating it as lapsed would let a provider be
 * written off for a number nobody published, which is the same trap `isTooFull` avoids for context.
 *
 * ⛔ Lives here rather than in `scheduler.ts`, where it was written, because `sharing.ts` needs it
 * and the scheduler already imports sharing — asking it there would close an import cycle. The
 * scheduler re-exports it so its own callers and tests are unaffected.
 */
export function cacheHasLapsed(session: Session, now = Date.now()): boolean {
  return session.cacheExpiresAt !== null && session.cacheExpiresAt <= now
}

export function warmClosedConversations(now = Date.now()): Session[] {
  return rows<SessionRow>(
    db()
      .prepare(
        `select * from sessions
          where purpose = 'work' and state in ('closed','failed','abandoned')
            and coalesce(context_tokens, 0) > 0
            and cache_expires_at is not null and cache_expires_at > ?
          order by cache_expires_at asc`
      )
      .all(now)
  ).map(toSession)
}

export function sessionsForWorker(workerId: string): Session[] {
  return rows<SessionRow>(
    db()
      .prepare("select * from sessions where worker_id = ? and state not in ('closed','abandoned','failed')")
      .all(workerId)
  ).map(toSession)
}

/**
 * Active sessions and most recent warmed-up conversations for a worker.
 *
 * Active (live/starting) sessions come first (newest startedAt first).
 * Warmed-up closed/idle sessions (with context_tokens > 0, purpose = 'work') follow,
 * deduplicated by conversation (vendor_session_id ?? id) and ordered newest first.
 */
export function sessionsAndWarmConversationsForWorker(workerId: string): Session[] {
  const liveRows = rows<SessionRow>(
    db()
      .prepare(
        "select * from sessions where worker_id = ? and state not in ('closed','abandoned','failed') order by started_at desc"
      )
      .all(workerId)
  ).map(toSession)

  const worker = getWorker(workerId)
  if (!worker || !adapter(worker.adapterId).info.capabilities.resumeSession) {
    return liveRows
  }

  const seenKeys = new Set<string>()
  for (const s of liveRows) {
    seenKeys.add(s.vendorSessionId ?? s.id)
  }

  const closedRows = rows<SessionRow>(
    db()
      .prepare(
        "select * from sessions where worker_id = ? and state in ('closed','abandoned','failed') and coalesce(context_tokens, 0) > 0 and purpose = 'work' order by coalesce(closed_at, started_at) desc"
      )
      .all(workerId)
  ).map(toSession)

  const warmRows: Session[] = []
  for (const s of closedRows) {
    const key = s.vendorSessionId ?? s.id
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    warmRows.push(s)
  }

  return [...liveRows, ...warmRows]
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
  /**
   * The project this conversation belongs to.
   *
   * ⛔ The column has existed since M2 and **nothing ever wrote it** - all twenty work sessions in
   * this install carry null, so the only route from a conversation back to a project was through its
   * runs, and a session that had not run yet had none at all. Written here because the caller that
   * chose the workspace is the only one that knows, and because everything downstream that groups
   * conversations by project has to read something.
   */
  projectId?: string | null | undefined
  /**
   * Start this session again holding the conversation it already had, rather than opening a new one.
   *
   * ⛔ The **same row**, not a copy. Claude Code's `--resume` reuses the original session id, so a
   * second row would be a second name for one conversation and its transcript would be metered
   * twice; and the context tokens, the cache clock and the transcript path all describe the thing
   * being resumed. The row's `started_at` is left alone for the same reason - it is the age of the
   * conversation, not of this process.
   *
   * ⚠️ Only honoured when the adapter declares `resumeSession`. Callers ask
   * `resumableSession` rather than testing that themselves.
   */
  resume?: Session | undefined
  /**
   * Open a second conversation holding a copy of this one's context, leaving it running.
   *
   * ⛔ A **new row** and a new id, where `resume` is deliberately the same row. That is the whole
   * distinction: a resume re-enters a conversation nobody else is in, a fork is how you look at one
   * somebody is still using. ⚠️ Only honoured when the adapter declares `forkSession`.
   */
  fork?: Session | undefined
  /**
   * Images the first prompt on this session will carry.
   *
   * ⛔ Needed **at spawn**, not at prompt time, for a `spawn-flag` adapter: codex takes `-i <file>`
   * on the process that runs the turn and has no stdin channel to send one down afterwards. This is
   * why `promptFor` is called before `spawnSession` rather than after it.
   */
  attachments?: Attachment[] | undefined
  /**
   * Directories outside `cwd` this session may write to, because an operator said so.
   *
   * ⛔ **State it when you know the task; otherwise it is inherited from the conversation.** A
   * dispatch names the task, so `dispatch` resolves `grantedDirsFor(task.id)` and passes it here. A
   * revive, a compaction and a forked terminal name only a session — and a grant that evaporated the
   * first time a conversation was resumed would be a grant that works until the cache clock touches
   * it, which is the worst of both. `grantedDirsForSession` below closes that by reading the task
   * back off the session's own latest run.
   *
   * ⚠️ An empty array is a different statement from absent: it says *this caller looked and there
   * are none*, and suppresses the inheritance below.
   */
  grantDirs?: string[] | undefined
}

/**
 * The directories granted to whatever task last ran in this conversation.
 *
 * ⚠️ Raw SQL rather than `lastRunForSession`: `tasks.ts` imports this module, so reading the run
 * back through it would close an import cycle for one column.
 */
function grantedDirsForSession(sessionId: string | null): string[] {
  if (!sessionId) return []
  const found = row<{ task_id: string }>(
    db()
      .prepare('select task_id from runs where session_id = ? order by started_at desc limit 1')
      .get(sessionId)
  )
  return found?.task_id ? grantedDirsFor(found.task_id) : []
}

/**
 * Should this session be asked to stream its prose as it is written?
 *
 * ⛔ **Two conditions, and both are read here rather than at any call site.** The operator's standing
 * preference (`Settings.liveNarration`) says what they want to watch; the adapter's
 * `streamsPartialOutput` says whether its CLI can do it. A worker whose CLI cannot simply runs as it
 * always did — ⛔ never an `if` on which adapter it is, which is the invariant this would be the
 * easiest place in the codebase to break.
 *
 * ⚠️ `work` on `stream` only. A PTY session is a person watching a real TUI, which streams by itself
 * and takes no such flag; a probe and a login have no prose to stream.
 */
function wantsPartialMessages(
  info: AdapterInfo,
  purpose: SessionPurpose,
  transport: SessionTransport
): boolean {
  if (transport !== 'stream') return false
  if (!info.capabilities.streamsPartialOutput) return false
  return settings().liveNarration === 'streaming'
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

/**
 * The permission mode this session actually starts in.
 *
 * ⛔ **Unattended work is the only case that gets moved**, and it is moved because its CLI's default
 * mode does not reach it. Claude Code's `auto` is accepted under `-p` and silently ignored (see
 * `AdapterPolicy.headlessPermissionMode`), so a dispatched task ran with no classifier and no
 * allowlist — every command it tried became an approval on somebody's screen, and the two nobody
 * saw in ten minutes timed out into a deny. `headlessPermissionMode` is the adapter saying what its
 * CLI will honour instead.
 *
 * ⚠️ A caller's own mode always wins, and three callers have one: chat and the reviewer name theirs
 * deliberately, and a consult runs toolless in a scratch directory. This is why the substitution is
 * pinned to `work` on `stream` rather than to the transport alone — a `pty` session is a person at a
 * keyboard, where the real `auto` works and where they can answer for themselves.
 *
 * ⭐ `unattendedAuthority` is the worker's own setting (t545), read only for this same `work`/`stream`
 * case. Codex is the one adapter that declares a `bypassPermissionMode`: when the account is set to
 * `full-user`, that mode is preferred over `headlessPermissionMode`, which is how a codex worker
 * opts into `--dangerously-bypass-approvals-and-sandbox` instead of its default sandbox. Every other
 * adapter leaves `bypassPermissionMode` unset, so this is inert for them regardless of the setting.
 */
export function permissionModeFor(
  info: AdapterInfo,
  purpose: SessionPurpose,
  transport: SessionTransport,
  requested: string | undefined,
  unattendedAuthority?: UnattendedAuthority
): string | undefined {
  if (requested) return requested
  // ⛔ A consult is unattended judgment and gets no tools, so it runs in the mode that reads and does
  // not act — never the adapter's default. `antigravity-cli`'s default is
  // `dangerously-skip-permissions`, and a route consult on it (t501, 2026-09-17) spent its whole
  // four minutes opening `warmstart.db` with python and reading daemon source instead of answering,
  // while the task it was routing sat undispatched. `null` means the adapter declares no such mode.
  if (purpose === 'consult') return info.capabilities.readOnlyPermissionMode ?? undefined
  if (purpose !== 'work' || transport !== 'stream') return undefined
  if (unattendedAuthority === 'full-user' && info.policy.bypassPermissionMode) {
    return info.policy.bypassPermissionMode
  }
  return info.policy.headlessPermissionMode ?? undefined
}

export function spawnSession(opts: SpawnOptions): Session {
  const worker = requireWorker(opts.workerId)
  const purpose = opts.purpose ?? 'work'

  const blocked = whyNoSession(worker, purpose)
  if (blocked) throw new Error(blocked)

  if (purpose === 'work') {
    const liveWork = sessionsForWorker(worker.id).filter((s) => s.purpose === 'work')
    const liveIds = new Set(liveWork.map((s) => s.id))
    const uncountedOpenRuns = rows<{ id: string; session_id: string | null }>(
      db()
        .prepare(
          `select r.id, r.session_id from runs r
           join tasks t on r.task_id = t.id
           where r.worker_id = ? and r.ended_at is null
             and coalesce(r.kind, 'work') = 'work'
             and t.status in ('running', 'assigned')`
        )
        .all(worker.id)
    ).filter((r) => !r.session_id || !liveIds.has(r.session_id)).length

    const running = liveWork.length + uncountedOpenRuns
    if (running >= worker.maxConcurrent) {
      throw new Error(capacitySpawnError(worker.label, running, worker.maxConcurrent))
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

  // ⚠️ One review at a time per worker, and exempt from `maxConcurrent` for the same reason a
  // consult is: the limit exists to bound unattended *work* — parallel agents editing repositories
  // for hours — and a review is one short read-only turn holding no workspace. ⛔ It does hold the
  // operator's trunk open for reading, which is why it is bounded at all.
  if (purpose === 'review') {
    const inFlight = sessionsForWorker(worker.id).filter((s) => s.purpose === 'review').length
    if (inFlight > 0) throw new Error(`worker '${worker.label}' is already reviewing`)
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
  const projectless = purpose === 'login' || purpose === 'probe' || purpose === 'consult'
  const cwd =
    opts.cwd && opts.cwd !== '.' ? opts.cwd : projectless ? ensureDir(paths.scratch) : homedir()

  // ⛔ The isolation root must exist before any adapter tries to create files under it (e.g.,
  // trustDirectory for Muse's workspace-trust pre-answer).
  ensureDir(worker.isolationRoot)

  // ⛔ Only ever the scratch directory, and only for a session with no project. See the constant.
  if (projectless && AUTO_TRUST_SCRATCH && cwd === paths.scratch) {
    adapter(worker.adapterId).trustDirectory?.(worker.isolationRoot, cwd)
  }
  if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)

  const ad = adapter(worker.adapterId)
  // Minted here, before the process exists, so the transcript path is known before the file is.
  // ⚠️ Except when resuming, where the id already exists and is the whole point - see `opts.resume`.
  const resuming = opts.resume && ad.info.capabilities.resumeSession ? opts.resume : null
  // ⚠️ A fork keeps its own id even where the CLI mints ids, because the whole point is that the
  // original keeps its own: two rows, two transcripts, one shared prefix.
  const forking = opts.fork && ad.info.capabilities.forkSession ? opts.fork : null
  const id = resuming?.id ?? randomUUID()
  const transport: SessionTransport = opts.transport ?? 'pty'
  // ⛔ Tool sets, by purpose, and each is a deliberate cost and trust decision:
  //  - `login`   — no tools. The vendor's own credential flow and nothing else.
  //  - `consult` — no tools. A consult is a judgment call answered as JSON that the daemon validates
  //                and applies itself; an unattended controller that could *act* would be a much
  //                larger thing to trust, and every tool definition is also cache prefix.
  //  - `chat`    — the controller tier, because a person is watching what it does.
  //  - `review`  — no tools, for the same reason as `consult`, plus one of its own: the reviewer is
  //                never told to call `task_complete`, so it never hunts for a tool it does not have.
  //  - `work`    — the worker tier.
  const mcpConfig =
    purpose === 'work'
      ? writeMcpConfig(id, 'worker')
      : purpose === 'chat'
        ? writeMcpConfig(id, 'controller')
        : null
  const partialMessages = wantsPartialMessages(ad.info, purpose, transport)
  const permissionMode = permissionModeFor(
    ad.info,
    purpose,
    transport,
    opts.permissionMode,
    worker.unattendedAuthority
  )
  const plan = ad.plan({
    sessionId: id,
    isolationRoot: worker.isolationRoot,
    cwd,
    transport,
    model: opts.model,
    effort: opts.effort,
    partialMessages,
    permissionMode,
    mcpConfig,
    argv: opts.argv,
    attachments: opts.attachments,
    // ⛔ The caller's list where it had one, the conversation's where it did not. See
    // `SpawnOptions.grantDirs` for why a resume may not be allowed to quietly drop a grant.
    grantDirs: opts.grantDirs ?? grantedDirsForSession(resuming?.id ?? forking?.id ?? null),
    // ⛔ The vendor's handle where it gave us one, ours where it took ours. `mintsSessionId` is
    // exactly the question of which, and getting it backwards means handing a CLI an id it has never
    // heard of - which resumes nothing and says nothing about it.
    ...(resuming ? { resumeFrom: resuming.vendorSessionId ?? resuming.id } : {}),
    ...(forking ? { forkFrom: forking.vendorSessionId ?? forking.id } : {})
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
      // ⛔ Stamped **before** the event is handed on, so `creditStreamTurn` — which runs inside the
      // `usage` callback below — reads the last *mid-turn* record rather than the terminal one it is
      // itself processing. See `lastActivityAt` for why the terminal pair is excluded.
      if (isRequestEvidence(event.kind)) entry.lastActivityAt = Date.now()
      events.onStream(entry.session, event)
      for (const listener of listeners ?? []) listener(event)
      text += renderForHuman(event, entry.asked)
      // ⛔ The second tier, beside the first rather than instead of it. The rendered bytes above
      // still feed `scrollback`, which `turnend.ts` reads to find a completion an MCP-less adapter
      // could not report; this is the same events shaped for a view that can lay one out.
      const described = describeStream(event, entry.asked)
      if (described) events.onStreamLine(id, noteStreamLine(id, described))
    }
    return text
  }

  const handleExit = (exitCode: number | null) => {
    const exiting = live.get(id)
    if (exiting) retainScrollback(id, exiting.scrollback.join(''))
    live.delete(id)
    // ⚠️ Kept past the exit, unlike the entry above. The seconds after a run fails are exactly when
    // somebody opens the pane to find out why, and a view that blanked itself on exit would clear
    // the screen at the moment it became worth reading. `retainStreamLog` bounds how many survive.
    retainStreamLog(id)
    // ⛔ Before the end listeners, not after: the reviewer's wait and `onSessionExit` both ask what
    // the CLI said *while* settling a session that has just died, which is the one moment it matters.
    retainDiagnostics(id)
    removeMcpConfig(id)
    for (const listener of endListeners.get(id) ?? []) listener(exitCode)
    streamListeners.delete(id)
    endListeners.delete(id)
    // ⛔ Asked to stop beats the exit code. See `closing`: a kill we ordered is a `closed`
    // conversation whatever signal ended it, and only a process that died on its own is `failed`.
    const asked = closing.delete(id)
    setState(id, exitCode === 0 || asked ? 'closed' : 'failed')
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

  // ⛔ A probe PTY has no terminal on the other end. A person's session is drawn by xterm.js, which
  // answers the TUI's *where is the cursor?* itself; the usage probe is watched by nobody, and a
  // CLI that waits for that answer exits before `/usage` is ever typed — measured 2026-09-13 on
  // Muse Code 1.2.1, gone at +6.4s with `readyMs` at 14s. See termquery.ts for what is answered.
  const answerer = purpose === 'probe' && transport !== 'stream' ? terminalAnswerer() : null
  const onPtyData = answerer
    ? (data: string) => {
        emitData(data)
        const reply = answerer.push(data)
        // ⚠️ The channel itself, not `live` — the first query can arrive before the row is
        // registered. Called only from the PTY's own data path, so `channel` is assigned by then.
        if (reply) {
          try {
            channel.write(reply)
          } catch (err) {
            log.debug('terminal reply ignored:', err)
          }
        }
      }
    : emitData

  const channel =
    transport === 'stream'
      ? openPipes(plan, cwd, emitData, handleExit)
      : openPty(plan, cwd, opts.cols ?? 120, opts.rows ?? 30, onPtyData, handleExit)

  // Metered like anything else: a judgment call is not free, and the ledger reports what each one
  // cost from this transcript rather than from an estimate.
  //
  // ⚠️ Null is normal for an adapter that cannot mint a session id: the CLI names its own transcript,
  // so there is nothing to predict and `findTranscriptLater` goes looking once the file exists.
  // Guessing at the name would risk metering somebody else's session as ours.
  const transcriptPath = purpose === 'login' ? null : ad.transcriptPath(worker.isolationRoot, cwd, id)
  const now = Date.now()
  // ⚠️ `on conflict` is the resume path and reaches nothing else: every other spawn mints a fresh
  // uuid, so the row cannot already exist. What it deliberately does **not** touch is what makes the
  // resumed session the same session - `started_at`, `context_tokens` and `transcript_path` all
  // describe the conversation rather than this process.
  //
  // ⛔ The cache clock is cleared, though. A session told to `/compact` and then closed before it
  // could comes back believing a move is still in flight, and the clock would wait out its timeout
  // against a process that has no memory of being asked.
  db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, pid,
                             purpose, transcript_path, tokens_since_compact, started_at, effort,
                             project_id)
       values (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, 0, ?, ?, ?)
       on conflict(id) do update set
         state = 'starting', pid = excluded.pid, closed_at = null,
         transport = excluded.transport, cwd = excluded.cwd,
         model = coalesce(excluded.model, sessions.model),
         clock_move = null, clock_move_at = null, clock_move_attempts = 0, clock_move_context = null`
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
      opts.effort ?? null,
      opts.projectId ?? null
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
      transport === 'stream' && ad.decodeStream
        ? new StreamParser(ad.decodeStream, { partialMessages }, (line) => noteDiagnostic(id, line))
        : null,
    promptedOnce: false,
    promptedAt: null,
    lastActivityAt: null,
    asked: { model: opts.model ?? null, effort: opts.effort ?? null, permissionMode: permissionMode ?? null }
  })

  log.info(
    `${resuming ? 'resumed' : 'spawned'} ${purpose} session ${id.slice(0, 8)} on ${worker.label}: ` +
      `${plan.command} ${plan.args.join(' ')}`
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
  const closed = sessionEnded(state)
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
 * Which of a prompt's images may be put in **this** adapter's envelope.
 *
 * ⛔ **The gate that keeps a turn alive.** On `none` the answer is none: antigravity does not ignore
 * an image block, it fails the whole turn on one — `num_turns: 0`, `status: ERROR`, measured
 * 2026-08-31 — and the operator would read that as the agent having failed the task. On
 * `spawn-flag` the answer is also none, for the opposite reason: the bytes went into the argv when
 * the process started, and a second copy would be paid for twice.
 *
 * ⚠️ Nothing is lost in either case. The absolute path of every attachment is already in the prompt
 * text, put there by `promptFor`, and all three CLIs read a PNG off disk with their own view tool.
 *
 * Exported because this is the one decision in the image path that must never regress, and driving
 * it through a live session would mean spawning three CLIs to assert one branch.
 */
export function inlineImagesFor(adapterId: string, attachments: Attachment[]): Attachment[] {
  return adapter(adapterId).info.capabilities.imageInput === 'inline'
    ? attachments.filter((attachment) => attachment.kind === 'image')
    : []
}

/**
 * Sessions the daemon has spoken into with nobody's run open — a `/compact`, a keepalive, a wrap-up
 * nudge.
 *
 * ⛔ **Kept so that an answer to one of those is not mistaken for the agent resuming on its own.**
 * `resumeIdleConversation` opens a run whenever a resting conversation starts talking again, which
 * is exactly right when the agent woke itself up and exactly wrong when *we* woke it: a cache-clock
 * keepalive would otherwise bill a run, flip the task to `running` and put a *the agent picked this
 * up again* line in the thread, every time the clock ticked.
 *
 * ⚠️ Set and cleared by `sendPrompt` itself, from its `housekeeping` option, so the mark cannot
 * outlive the prompt that set it: the next ordinary prompt into the session takes it off again. The
 * turn end clears it too, for a session that is never prompted again.
 */
const housekeeping = new Set<string>()

/**
 * ⚠️ Exported for the suite that pins the refusal, and used by `sendPrompt` itself. Production code
 * sets this through `sendPrompt`'s `housekeeping` option — a mark set anywhere else is a mark
 * nothing clears.
 */
export function markHousekeepingPrompt(sessionId: string): void {
  housekeeping.add(sessionId)
}

export function isHousekeepingTurn(sessionId: string): boolean {
  return housekeeping.has(sessionId)
}

export function clearHousekeepingPrompt(sessionId: string): void {
  housekeeping.delete(sessionId)
}

/**
 * Send a user message, in whatever shape this session's transport expects.
 *
 * ⚠️ This is why unattended work runs on `stream`, not `pty`. Two independent reasons, both measured:
 * the CLI's **workspace trust dialog is skipped in non-interactive mode** and would otherwise block
 * every dispatch into a fresh worktree with nobody there to answer it; and `--permission-prompt-tool`
 * only exists in non-interactive mode, which is the whole structured-approval channel. A `pty`
 * session is for a human at the keyboard, where both of those are fine.
 *
 * ⛔ There is no default wire shape and this used to pretend there was. An adapter with no
 * `encodeStreamPrompt` fell through to Claude Code's `{"type":"user",...}` envelope, which for codex
 * meant its prompt began with the literal characters `{"type":"user"` — and the envelope was the
 * lesser half of the bug. See `AdapterCapabilities.streamPrompts`.
 */
export function sendPrompt(
  id: string,
  text: string,
  attachments: Attachment[] = [],
  opts: { housekeeping?: boolean } = {}
): void {
  const entry = live.get(id)
  if (!entry) throw new Error(`session '${id}' is not live`)
  // ⛔ **Set *and* cleared here, so the mark cannot outlive the prompt that set it.** An earlier
  // version had the cache clock set it and the turn end clear it, which meant one dropped `result`
  // left a session permanently unable to report an unprompted resume. Every prompt says which kind
  // it is, the default is the honest one, and the last one to be sent wins.
  if (opts.housekeeping) markHousekeepingPrompt(id)
  else housekeeping.delete(id)
  if (entry.session.transport === 'stream') {
    const ad = adapter(entry.session.adapterId)
    const once = ad.info.capabilities.streamPrompts === 'once'
    // ⛔ Loud, not silent. A one-shot session's stdin is gone after the first prompt, so a wrap-up
    // nudge or a finish instruction has nowhere to go — and writing into a closed pipe would throw
    // somewhere unhelpful or, worse, succeed into a void. The caller logs this and the operator
    // learns the account cannot be steered mid-turn, which is true and is the point.
    if (once && entry.promptedOnce) {
      throw new Error(
        `session '${id}' takes one prompt only (${ad.info.label} reads stdin to EOF); ` +
          'a second prompt needs a new session'
      )
    }
    const inline = inlineImagesFor(entry.session.adapterId, attachments)
    if (attachments.length > 0 && inline.length === 0) {
      log.info(
        `${ad.info.label} takes no inline image (imageInput: ` +
          `${ad.info.capabilities.imageInput}); ${attachments.length} attachment(s) travel as a ` +
          'file path in the prompt instead'
      )
    }
    const payload = ad.encodeStreamPrompt
      ? ad.encodeStreamPrompt(text, inline)
      : JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        })
    entry.channel.write(`${payload}\n`)
    if (once) {
      // ⛔ The EOF *is* the go signal. `codex exec` prints `Reading prompt from stdin...` and blocks
      // until the pipe closes; without this the process sits at 0% CPU indefinitely, which is what
      // t52 did for 50 minutes while reporting as `running`.
      entry.promptedOnce = true
      entry.channel.end()
    }
  } else {
    entry.channel.write(`${text}\r`)
  }
  // ⛔ Last, and only once the prompt is actually out. Every path above can refuse - a one-shot
  // session asked for a second prompt throws - and a refused prompt started no turn, so stamping it
  // would roll a cache clock forward over a request that never happened.
  entry.promptedAt = Date.now()
}
/**
 * Type into a session, as a person at a keyboard.
 *
 * ⛔ **A `stream` session has no keyboard, and pretending otherwise killed runs.** Measured
 * 2026-09-13 on claude 2.1.270: its `--input-format stream-json` stdin is newline-delimited JSON,
 * and three raw keystrokes written ahead of the next message produced
 * `Error parsing streaming input line (type=user, 112 chars): SyntaxError` and **exit 1** — the
 * identical run without them exited 0. The session pane offered *take the keyboard* on dispatched
 * work, so one stray character ended the task. Refused here rather than in the pane, because the
 * RPC is reachable from the remote desktop too.
 *
 * ⚠️ Talking to a running agent is `sendPrompt` — it encodes what the transport expects — and on a
 * task that is what the thread composer already does.
 */
export function writeSession(id: string, data: string): void {
  // ⚠️ The transport is asked about **before** liveness, so the answer is the same whether or not
  // the process happens to be up: typing into a pipe session is never the right thing, and a caller
  // told only `not live` would try again when it was.
  const row = getSession(id)
  if (row && row.transport === 'stream') {
    throw new Error(
      `session '${id.slice(0, 8)}' runs on a pipe, not a terminal: its stdin takes whole ` +
        'stream-json messages and a keystroke on it ends the run. Reply on the task instead.'
    )
  }
  const entry = live.get(id)
  if (!entry) throw new Error(`session '${id}' is not live`)
  entry.channel.write(data)
}

/**
 * Interrupt a session the way a person would - the adapter's own key, not a signal. A killed agent
 * leaves its work uncommitted and its claims held; an interrupted one can be asked to wrap up.
 *
 * ⛔ **A keystroke only reaches a keyboard.** On a `stream` session the interrupt key is not an
 * interrupt at all: the CLI's stdin is a newline-delimited JSON reader, so an ESC sits in its buffer
 * and then corrupts the next real message. Measured 2026-09-13 on claude 2.1.270 — a stray prefix
 * ahead of a valid line produced `Error parsing streaming input line … SyntaxError` and **exit 1**.
 * A stream adapter that declares its own control frame may interrupt cleanly; otherwise its pipe is
 * wound down by asking it through `sendPrompt`, and closed if it will not.
 */
export function interruptSession(id: string): void {
  const entry = live.get(id)
  if (!entry) return
  if (entry.session.transport === 'stream') {
    const encode = adapter(entry.session.adapterId).encodeStreamInterrupt
    if (!encode) {
      log.debug(`session ${id.slice(0, 8)} runs on a pipe with no interrupt control frame`)
      return
    }
    try {
      entry.channel.write(`${encode(randomUUID())}\n`)
    } catch (err) {
      log.warn(`could not interrupt stream session ${id}:`, err)
    }
    return
  }
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
  // ⚠️ Marked *before* the kill, not after. `handleExit` can run inside `kill()` on a process that
  // is already gone, and it reads this set — recording the intent afterwards would lose the race on
  // exactly the sessions that shut down fastest.
  closing.add(id)
  try {
    entry.channel.kill()
  } catch (err) {
    log.warn(`could not kill session ${id}:`, err)
    closing.delete(id)
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
 *
 * ⛔ **`abandoned`, not `failed`.** This marks every open row on every restart, and the daemon
 * restarts for reasons that have nothing to do with the agent — a rebuild, a machine reboot, a
 * `/commit`. Calling that a failure blamed the conversation for the supervisor's absence, and since
 * a restart is the ordinary case it is how most of the history came to read `failed`. `abandoned`
 * says the true thing: nobody was watching when this ended, so what became of the work is unknown.
 */
export function reconcileOrphans(): number {
  const stale = rows<SessionRow>(
    db().prepare("select * from sessions where state not in ('closed','abandoned','failed')").all()
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
        killProcessTree(r.pid)
        killed++
      } catch (err) {
        log.warn(`could not stop orphaned agent pid ${r.pid}:`, err)
      }
    }
    db()
      .prepare("update sessions set state = 'abandoned', closed_at = ? where id = ?")
      .run(Date.now(), r.id)
    removeMcpConfig(r.id)
  }

  // ⛔ Also reap detached agent processes on Windows whose parent process has died and whose
  // command line contains a session ID uuid minted by agentyard.
  if (process.platform === 'win32' && !process.env.VITEST) {
    try {
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--session-id*" } | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress'
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }
      ).trim()
      if (raw) {
        // ⛔ `JSON.parse` is `any`, and this is a process list being turned into kill targets — the
        // one place a shape assumed rather than checked would have this reaping a PID it misread,
        // which is why `isCimProcess` is a guard rather than a cast.
        // ⚠️ `ConvertTo-Json` collapses a single match to a bare object rather than a one-element
        // array, so both shapes are real and neither may be assumed.
        const parsed: unknown = JSON.parse(raw)
        const procs = (Array.isArray(parsed) ? parsed : [parsed]).filter(isCimProcess)
        for (const p of procs) {
          if (p.ProcessId && p.ParentProcessId && !isAlive(p.ParentProcessId)) {
            const match = p.CommandLine?.match(/--session-id\s+([0-9a-fA-F-]+)/)
            const sId = match ? match[1] : null
            if (sId && !live.has(sId)) {
              try {
                killProcessTree(p.ProcessId)
                killed++
              } catch (err) {
                // ⚠️ One orphan that would not die is not a reason to abandon the rest of the sweep.
                // The commonest cause is benign: the process exited between the ownership check and
                // the kill, so it is already no longer an orphan.
                log.debug(`could not stop detached orphaned agent pid ${p.ProcessId}:`, err)
              }
            }
          }
        }
      }
    } catch (err) {
      // ⚠️ Best-effort. This whole block is a sweep for processes nothing is tracking, so a
      // PowerShell that is missing, slow or refused must not take the reaper down with it.
      log.debug('the detached-process sweep did not run:', err)
    }
  }
  if (stale.length) {
    log.warn(
      `marked ${stale.length} orphaned session(s) abandoned at startup` +
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

/** The only fields the detached-process reaper reads from PowerShell's CIM JSON. */
function isCimProcess(value: unknown): value is {
  ProcessId?: number
  ParentProcessId?: number
  CommandLine?: string
} {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.ProcessId === undefined || typeof record.ProcessId === 'number') &&
    (record.ParentProcessId === undefined || typeof record.ParentProcessId === 'number') &&
    (record.CommandLine === undefined || typeof record.CommandLine === 'string')
  )
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

/**
 * Terminate a process and all of its descendants.
 *
 * On Windows, child processes spawned by CLI wrappers (e.g. node-pty conpty or cmd.exe wrappers around
 * claude.exe) do not receive SIGTERM/SIGKILL when the parent is killed with plain process.kill().
 * `taskkill /PID <pid> /T /F` forces termination of the entire process tree.
 */
export function killProcessTree(pid: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    // Process or process tree already exited.
  }
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
  const unwrapped = unwrapForPty(plan.command, plan.args)
  const proc = pty.spawn(unwrapped.command, unwrapped.args, {
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
    // A pseudo-terminal has one channel, not two: there is no input half to close without closing
    // the terminal. Nothing that needs EOF uses a PTY.
    end: () => undefined,
    resize: (c, r) => proc.resize(c, r),
    kill: () => {
      try {
        proc.kill()
      } catch {
        // Ignored
      }
      if (proc.pid) killProcessTree(proc.pid)
    }
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
  const invocation = formatCmdInvocation(plan.command, plan.args)
  const child = spawnChild(invocation.command, invocation.args, {
    cwd,
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => onData(d))
  // stderr is where the CLI puts its diagnostics; showing it is how a broken spawn stops being a
  // silent one.
  child.stderr?.on('data', (d: string) => onData(d))
  child.on('exit', (code) => onExit(code))
  child.on('error', (err) => {
    onData(`\n[warmstart] could not start: ${err.message}\n`)
    onExit(-1)
  })
  return {
    pid: child.pid,
    write: (data) => {
      child.stdin?.write(data)
    },
    end: () => {
      child.stdin?.end()
    },
    // A pipe has no geometry. Silently doing nothing is the correct behaviour, not a failure.
    resize: () => undefined,
    kill: () => {
      try {
        child.kill()
      } catch {
        // Ignored
      }
      if (child.pid) killProcessTree(child.pid)
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
export function markClockMove(
  sessionId: string,
  move: CacheMove,
  context: number,
  attempts?: number
): void {
  if (attempts !== undefined) {
    db()
      .prepare(
        `update sessions
            set clock_move = ?, clock_move_at = ?, clock_move_context = ?,
                clock_move_attempts = ?
          where id = ?`
      )
      .run(move, Date.now(), context, attempts, sessionId)
  } else {
    db()
      .prepare(
        `update sessions
            set clock_move = ?, clock_move_at = ?, clock_move_context = ?,
                clock_move_attempts = case when clock_move = ? then clock_move_attempts + 1 else 1 end
          where id = ?`
      )
      .run(move, Date.now(), context, move, sessionId)
  }
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

/**
 * A session failed to resume (e.g. remote thread 404, corrupted rollout, or startup failure on warm run).
 * Clear its context tokens and mark it failed so neither `finishedConversationsIn` nor `resumableSession`
 * ever attempts to resume it again.
 */
export function invalidateSessionContext(sessionId: string): void {
  db()
    .prepare("update sessions set context_tokens = 0, state = 'failed' where id = ?")
    .run(sessionId)
  const session = getSession(sessionId)
  if (session) {
    session.contextTokens = 0
    session.state = 'failed'
    events.onChange(session)
  }
}

/**
 * Open a real terminal on a conversation, and say plainly when there cannot be one.
 *
 * ⛔ **A dispatched agent has no terminal and none can be made for it.** Work runs on pipes because
 * `--print` refuses to start under a pseudo-terminal (measured 2026-08-25, see `Channel`), so the
 * session pane cannot mirror a screen that does not exist — it draws the decoded stream instead, and
 * says so. This is the other half of that answer: the real CLI, in the same workspace, holding the
 * same context, as its *own* conversation.
 *
 * ⛔ **Always a fork, never a resume, and that is not the obvious choice.** A resume would be cheaper
 * to describe — the conversation is often resting, and `--resume` is what resting conversations are
 * for — but `spawnSession`'s resume path reuses **the same row**, and it would come back marked `pty`
 * while still reading `purpose: 'work'`. `warmSessionFor` walks a task's own runs and offers any live,
 * idle session it finds, so the next dispatch would write scheduled unattended work into the terminal
 * a person is sitting at, in the CLI's interactive permission mode. A fork mints its own row, leaves
 * the original exactly as resumable as it was, and costs a cache read: measured 2026-09-13 on claude
 * 2.1.270, `--resume <old> --fork-session --session-id <new>` read 31,372 tokens from cache.
 *
 * ⚠️ **Two processes, one worktree, and this does not pretend otherwise.** A person typing into the
 * fork can edit the same files the run is editing. It opens in the CLI's own default permission mode
 * — a person is watching, so `permissionModeFor` leaves it alone and the agent asks — and the caller
 * that offers the button is the one that has to say what the workspace is.
 */
export function attachTerminal(sessionId: string): Session {
  const target = getSession(sessionId)
  if (!target) throw new Error(`session '${sessionId}' is not known`)
  const info = adapter(target.adapterId).info
  if (!info.capabilities.transports.includes('pty')) {
    throw new Error(`${info.label} has no interactive terminal to open`)
  }
  if (!info.capabilities.forkSession) {
    throw new Error(
      `${info.label} cannot fork a conversation, so there is no way to open one beside a run ` +
        'without becoming a second agent in it.'
    )
  }
  // ⚠️ The conversation's own directory, never a fresh one. A terminal opened somewhere else is a
  // terminal onto a different piece of work, and the whole value here is standing where the agent is.
  return spawnSession({
    workerId: target.workerId,
    cwd: target.cwd,
    transport: 'pty',
    // ⛔ `chat`, which is the tier where a person is watching: it gets agentyard's controller MCP
    // tools and the CLI's own permission mode, so it asks before it acts. `work` would substitute
    // the headless bypass, which is exactly the authority nobody is asking for at a keyboard.
    purpose: 'chat',
    projectId: target.projectId,
    ...(target.model ? { model: target.model } : {}),
    fork: target
  })
}
