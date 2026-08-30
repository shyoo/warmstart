import { randomUUID } from 'node:crypto'
import type { Consult, ConsultKind, ConsultStatus } from '@shared/tasks.js'
import type { ControllerReport, Worker } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { adapter } from './adapters/index.js'
import { listWorkers, recordDispatchFailure } from './workers.js'
import { accountUnavailability } from './eligibility.js'
import { lastQuota, lastRateLimit } from './quota.js'
import {
  closeSession,
  onSessionEnd,
  onSessionStream,
  sendPrompt,
  sessionsForWorker,
  spawnSession
} from './sessions.js'
import { applyConsult, fallbackFor, questionStillStands } from './judgment.js'
import { getTask } from './tasks.js'

/**
 * The controller.
 *
 * ⛔ **The controller is never in the critical path.** The scheduler enqueues a question and carries
 * on; a separate, slower loop drains the queue; and every question has a deterministic fallback that
 * fires on a timer whether or not the controller ever answers. If the controller's own account is out
 * of quota, mis-commissioned, slow, or returns nonsense, the fleet keeps working - it simply works
 * with less judgment. That property, and not a prompt, is what makes it safe to put an LLM here at
 * all. Plan §11.
 *
 * Three structural bounds, in order of how much they matter:
 *
 *  1. **A consult has no tools.** It is asked a question and answers with JSON, which the daemon
 *     parses, validates against a *closed* answer set, and applies itself. A hallucinated worker id
 *     is a validation failure, not a dispatch. The one place the controller gets tools is the chat
 *     pane, where a person is watching.
 *  2. **Its most open-ended output lands in `draft`.** Decomposition can invent whatever it likes;
 *     drafts do not dispatch, are not assigned, and hold no worker.
 *  3. **It is capped.** One consult per worker at a time, one in flight fleet-wide, an hourly cap,
 *     and a per-subject cooldown so the same failing task is not re-diagnosed every thirty seconds.
 */

/** How long a queued question waits for judgment before the deterministic answer is used. */
const CONSULT_TTL_MS: Record<ConsultKind, number> = {
  // Nothing can happen until a goal is decomposed, so it can afford to wait.
  decompose: 10 * 60 * 1000,
  triage: 10 * 60 * 1000,
  gate: 10 * 60 * 1000,
  // ⚠️ Short on purpose: a task is sitting undispatched while this is open, and the deterministic
  // answer to a near-tie is already good.
  route: 90 * 1000
}

/** Do not re-ask the same question about the same subject inside this. */
const COOLDOWN_MS: Record<ConsultKind, number> = {
  decompose: 30 * 60 * 1000,
  triage: 30 * 60 * 1000,
  gate: 30 * 60 * 1000,
  route: 5 * 60 * 1000
}

/** Fleet-wide. A controller that has answered twenty questions in an hour is in a loop, not working. */
export const HOURLY_CAP = 20

/** One turn of judgment. Past this the consult is abandoned and the fallback fires. */
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000

/** The CLI needs a moment before it reads stdin; a prompt sent too early is dropped. */
const PROMPT_DELAY_MS = 2500

/** Above this on a trusted 5h reading, an account stops being asked. This is leadership delegation. */
const CONTROLLER_HIGH_WATER = 80

export const CONTROLLER_LOOP_MS = 30_000

interface ConsultRow {
  id: string
  kind: string
  subject_id: string | null
  status: string
  question: string
  worker_id: string | null
  session_id: string | null
  answer_json: string | null
  outcome: string | null
  fallback_reason: string | null
  created_at: number
  started_at: number | null
  ended_at: number | null
}

function toConsult(r: ConsultRow): Consult {
  const task = r.subject_id ? getTask(r.subject_id) : null
  const worker = r.worker_id ? listWorkers().find((w) => w.id === r.worker_id) : null
  return {
    id: r.id,
    kind: r.kind as ConsultKind,
    subjectId: r.subject_id,
    subjectSeq: task?.seq ?? null,
    subjectTitle: task?.title ?? null,
    status: r.status as ConsultStatus,
    question: r.question,
    workerId: r.worker_id,
    workerLabel: worker?.label ?? null,
    sessionId: r.session_id,
    answer: r.answer_json ? safeParse(r.answer_json) : null,
    outcome: r.outcome,
    fallbackReason: r.fallback_reason,
    spentTokens: r.session_id ? spentOn(r.session_id) : 0,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Metered from the consult session's own transcript. ⛔ Never an estimate: judgment is not free. */
function spentOn(sessionId: string): number {
  const r = db()
    .prepare(
      `select coalesce(sum(input_tokens + output_tokens + cache_read_tokens +
                           cache_write_1h_tokens + cache_write_5m_tokens), 0) as n
         from turns where session_id = ?`
    )
    .get(sessionId) as { n: number }
  return r.n
}

// ---------------------------------------------------------------------------- the queue

export interface ConsultRequest {
  kind: ConsultKind
  subjectId: string | null
  question: string
}

/**
 * Ask for judgment, and return immediately.
 *
 * ⛔ Called from the scheduler's free loop, so it must not spend, block or throw. It writes a row and
 * returns. Idempotent per `(kind, subject)`: a pending question is not asked twice, and a recently
 * answered one is inside its cooldown - which is what stops a task that fails every tick from
 * commissioning a fresh diagnosis every tick.
 */
export function enqueueConsult(req: ConsultRequest): Consult | null {
  const existing = row<ConsultRow>(
    db()
      .prepare(
        `select * from consults where kind = ? and subject_id is ?
          order by created_at desc limit 1`
      )
      .get(req.kind, req.subjectId)
  )
  if (existing) {
    if (existing.status === 'pending') return toConsult(existing)
    const age = Date.now() - (existing.ended_at ?? existing.created_at)
    if (age < COOLDOWN_MS[req.kind]) return null
  }

  const id = randomUUID()
  db()
    .prepare(
      `insert into consults (id, kind, subject_id, status, question, created_at)
       values (?, ?, ?, 'pending', ?, ?)`
    )
    .run(id, req.kind, req.subjectId, req.question, Date.now())
  const consult = requireConsult(id)
  log.info(`consult queued: ${req.kind}${req.subjectId ? ` on ${req.subjectId.slice(0, 8)}` : ''}`)
  emit({ type: 'consult.changed', consult })
  return consult
}

export function requireConsult(id: string): Consult {
  const r = row<ConsultRow>(db().prepare('select * from consults where id = ?').get(id))
  if (!r) throw new Error(`no consult '${id}'`)
  return toConsult(r)
}

export function pendingConsults(): Consult[] {
  return rows<ConsultRow>(
    db().prepare("select * from consults where status = 'pending' order by created_at").all()
  ).map(toConsult)
}

/** Is a question about this subject currently open? The scheduler uses this to hold work back. */
export function hasPendingConsult(kind: ConsultKind, subjectId: string): boolean {
  const r = db()
    .prepare("select count(*) as n from consults where kind = ? and subject_id = ? and status = 'pending'")
    .get(kind, subjectId) as { n: number }
  return r.n > 0
}

/** The most recent settled answer about a subject, if it is still fresh enough to act on. */
export function latestAnswer(kind: ConsultKind, subjectId: string, maxAgeMs: number): unknown {
  const r = row<ConsultRow>(
    db()
      .prepare(
        `select * from consults where kind = ? and subject_id = ? and status = 'answered'
          order by created_at desc limit 1`
      )
      .get(kind, subjectId)
  )
  if (!r || !r.ended_at || Date.now() - r.ended_at > maxAgeMs) return null
  return r.answer_json ? safeParse(r.answer_json) : null
}

export function recentConsults(limit = 40): Consult[] {
  return rows<ConsultRow>(
    db().prepare('select * from consults order by created_at desc limit ?').all(limit)
  ).map(toConsult)
}

function settle(
  id: string,
  status: Exclude<ConsultStatus, 'pending'>,
  fields: { answer?: unknown; outcome?: string; fallbackReason?: string } = {}
): Consult {
  db()
    .prepare(
      `update consults set status = ?, answer_json = coalesce(?, answer_json),
                           outcome = coalesce(?, outcome),
                           fallback_reason = coalesce(?, fallback_reason), ended_at = ?
        where id = ?`
    )
    .run(
      status,
      fields.answer === undefined ? null : JSON.stringify(fields.answer),
      fields.outcome ?? null,
      fields.fallbackReason ?? null,
      Date.now(),
      id
    )
  const consult = requireConsult(id)
  emit({ type: 'consult.changed', consult })
  return consult
}

// ---------------------------------------------------------------------------- choosing one

export interface ControllerChoice {
  worker: Worker | null
  reason: string
}

/**
 * Which account answers the next question.
 *
 * **Leadership delegation, and it is just the gates.** The controller is a worker with its own quota,
 * so an account near the top of its window stops being chosen and the next judgment call routes
 * elsewhere; when none is left, `worker` is null and the deterministic fallback answers. Nothing
 * special happens at the floor - that *is* the floor.
 */
/**
 * Why this account cannot answer the next question, or `null` if it can.
 *
 * ⛔ **Exported, and the report uses it too.** `controllerReport` used to say `ready` for whichever
 * worker the chooser returned and `another is preferred` for every other row, which meant the panel
 * could not distinguish *"fine, just not first"* from *"cannot be asked at all"* — and when the
 * chooser itself was wrong, the panel repeated it with a confident green label. One function, asked
 * per worker, is what stops the two from ever disagreeing again.
 */
export function controllerUnavailability(worker: Worker): string | null {
  if (worker.role === 'worker') return `${worker.label} does work only`

  // Everything true of the account regardless of what is being asked - including the quarantine
  // that this function did not have and the scheduler did. See eligibility.ts.
  const unfit = accountUnavailability(worker)
  if (unfit) return unfit

  // A consult is answered over stream-json. An adapter without that transport cannot be a
  // controller, and that is a capability question, never an adapter name.
  if (!adapter(worker.adapterId).info.capabilities.transports.includes('stream')) {
    return `${worker.label} cannot run a non-interactive session`
  }
  if (sessionsForWorker(worker.id).some((s) => s.purpose === 'consult')) {
    return `${worker.label} is already answering one`
  }

  const rate = lastRateLimit(worker.id)
  if (rate && rate.status !== 'allowed') {
    return `${worker.label} is rate-limited (${rate.status})`
  }

  const window = controllerWindow(worker.id)
  if (window && window.percent >= CONTROLLER_HIGH_WATER) {
    return `${worker.label} is at ${Math.round(window.percent)}% of its 5h window`
  }
  return null
}

/** The window the water mark reads, or `null` when nothing fresh enough to trust says. */
function controllerWindow(workerId: string): { percent: number } | null {
  const quota = lastQuota(workerId)
  if (!quota || quota.stale) return null
  return quota.windows.find((w) => w.id === 'session' || w.id === '5h') ?? null
}

/**
 * How much room this account has, as a preference and never as a gate.
 *
 * ⚠️ Three states, not two, and the middle one is the point. A **measured** window gives its own
 * headroom; a **fresh reading with no matching window** is a real answer of `plenty`; **no reading
 * at all, or one too old to trust**, scores 0.5 - below a measured empty account and above a
 * measured busy one. Collapsing unknown into either end is how a guess starts outranking a
 * measurement.
 */
function controllerHeadroom(workerId: string): number {
  const quota = lastQuota(workerId)
  if (!quota || quota.stale) return 0.5
  const window = controllerWindow(workerId)
  return window ? 1 - window.percent / 100 : 1
}

export function chooseController(): ControllerChoice {
  const reasons: string[] = []
  const candidates: Array<{ worker: Worker; score: number }> = []

  for (const worker of listWorkers()) {
    if (worker.role === 'worker') continue
    const blocked = controllerUnavailability(worker)
    if (blocked) {
      reasons.push(blocked)
      continue
    }

    const headroom = controllerHeadroom(worker.id)

    // A dedicated controller is preferred over an account that also does work, because asking a busy
    // account for judgment competes with the work it is doing.
    candidates.push({ worker, score: (worker.role === 'controller' ? 1 : 0) + headroom })
  }

  if (candidates.length === 0) {
    return {
      worker: null,
      reason: reasons.length ? reasons.slice(0, 2).join('; ') : 'no worker is designated a controller'
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return { worker: (candidates[0] as { worker: Worker }).worker, reason: '' }
}

export function consultsStartedSince(since: number): number {
  const r = db()
    .prepare('select count(*) as n from consults where started_at is not null and started_at >= ?')
    .get(since) as { n: number }
  return r.n
}

// ---------------------------------------------------------------------------- the loop

let draining = false

/**
 * Drain the queue.
 *
 * ⚠️ **This is the only loop in the daemon that spends tokens**, and it is deliberately not the one
 * that dispatches work. One consult at a time, oldest first, so a burst of questions costs a queue
 * rather than a fleet-wide spike.
 */
export async function drainConsults(): Promise<{ answered: number; note: string }> {
  if (draining) return { answered: 0, note: 'already draining' }
  draining = true
  try {
    let answered = 0
    const notes: string[] = []

    for (const consult of pendingConsults()) {
      // 1. Expired. The deterministic answer was always available; now it is used.
      if (Date.now() - consult.createdAt > CONSULT_TTL_MS[consult.kind]) {
        applyFallback(consult, 'no controller answered within the window')
        notes.push(`${consult.kind} fell back on time`)
        continue
      }

      // 2. Overtaken. A task cancelled, deleted or already dealt with by a person needs no judgment,
      // and paying for an answer to a question nobody is asking any more is the easiest waste there
      // is to avoid.
      const stands = questionStillStands(consult)
      if (!stands.ok) {
        settle(consult.id, 'failed', { outcome: `Dropped: ${stands.reason}` })
        notes.push(`${consult.kind} dropped`)
        continue
      }

      if (consultsStartedSince(Date.now() - 60 * 60 * 1000) >= HOURLY_CAP) {
        notes.push(`hourly cap of ${HOURLY_CAP} reached`)
        break
      }

      const choice = chooseController()
      if (!choice.worker) {
        notes.push(`no controller available: ${choice.reason}`)
        break
      }

      await run(consult, choice.worker)
      answered++
      // One per pass. The next question can wait thirty seconds; a fleet-wide burst cannot be undone.
      break
    }

    return {
      answered,
      note: notes.length ? notes.join('; ') : answered ? 'answered' : 'nothing to decide'
    }
  } finally {
    draining = false
  }
}

async function run(consult: Consult, worker: Worker): Promise<void> {
  let sessionId: string | null = null
  try {
    const session = spawnSession({ workerId: worker.id, transport: 'stream', purpose: 'consult' })
    sessionId = session.id
    db()
      .prepare("update consults set status = 'pending', worker_id = ?, session_id = ?, started_at = ? where id = ?")
      .run(worker.id, session.id, Date.now(), consult.id)
    emit({ type: 'consult.changed', consult: requireConsult(consult.id) })

    const text = await ask(session.id, consult.question)
    closeSession(session.id)

    if (text === null) {
      noteDeadConsult(worker, session.id, 'it did not answer in time')
      applyFallback(requireConsult(consult.id), 'the controller did not answer in time')
      return
    }

    const parsed = extractJson(text)
    if (parsed === null) {
      applyFallback(requireConsult(consult.id), 'the reply contained no JSON object')
      return
    }

    const applied = applyConsult(requireConsult(consult.id), parsed)
    if (!applied.ok) {
      // ⛔ An answer outside the closed set is not "close enough". It is discarded and the
      // deterministic answer used, with the reason kept so a bad prompt is visible rather than felt.
      applyFallback(requireConsult(consult.id), applied.reason)
      return
    }
    settle(consult.id, 'answered', { answer: parsed, outcome: applied.outcome })
    log.info(`consult ${consult.kind} answered on ${worker.label}: ${applied.outcome}`)
  } catch (err) {
    if (sessionId) closeSession(sessionId)
    applyFallback(
      requireConsult(consult.id),
      `could not ask ${worker.label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Send the question and wait for the turn to end. Resolves to null on timeout or a dead session. */
function ask(sessionId: string, question: string): Promise<string | null> {
  return new Promise((resolve) => {
    let text = ''
    let done = false

    const finish = (value: string | null) => {
      if (done) return
      done = true
      offStream()
      offEnd()
      clearTimeout(timer)
      resolve(value)
    }

    const offStream = onSessionStream(sessionId, (event) => {
      if (event.kind === 'assistant_text') text += event.text
      if (event.kind === 'result') finish(event.text ?? text ?? null)
    })
    const offEnd = onSessionEnd(sessionId, () => finish(text || null))
    const timer = setTimeout(() => finish(null), ANSWER_TIMEOUT_MS)

    setTimeout(() => {
      try {
        sendPrompt(sessionId, question)
      } catch (err) {
        log.warn('could not send a consult question:', err)
        finish(null)
      }
    }, PROMPT_DELAY_MS)
  })
}

/**
 * A judgment call that produced not one metered turn is evidence about the **account**, not about
 * the question - exactly as a dead run is on the work side, and recorded the same way.
 *
 * ⛔ This loop is the only one in the daemon that spends tokens, and it had no way to learn. An
 * account whose subscription had expired was asked, produced nothing, fell back to the
 * deterministic answer, and was asked again on the next drain, indefinitely: the failure was
 * written on the *consult* and nothing was ever written on the *worker*. The work path had had
 * this since M4 and the judgment path never got it.
 *
 * ⚠️ Zero metered turns, not merely an unusable answer. A reply that arrives and fails validation
 * proves the account works and the prompt does not, and quarantining a healthy controller for a
 * bad prompt would empty the fleet one question at a time.
 *
 * ⚠️ `spentOn`, not `session.lastRequestStartedAt`. A consult always runs over `stream`, and the
 * stream metering path deliberately never sets that column - it has no request id and writes
 * `request_started_at` as null - so reading it would have called every healthy consult dead.
 */
export function deadConsultVerdict(spentTokens: number, why: string): string | null {
  if (spentTokens > 0) return null
  return `a judgment call on this account produced no turn: ${why}`
}

function noteDeadConsult(worker: Worker, sessionId: string, why: string): void {
  const verdict = deadConsultVerdict(spentOn(sessionId), why)
  if (verdict) recordDispatchFailure(worker.id, verdict, null)
}

function applyFallback(consult: Consult, reason: string): void {
  const outcome = fallbackFor(consult)
  settle(consult.id, 'fallback', { outcome, fallbackReason: reason })
  log.info(`consult ${consult.kind} fell back (${reason}): ${outcome}`)
}

/**
 * Pull the answer out of the reply.
 *
 * A model asked for JSON reliably returns JSON *and* a sentence about it. Taking the last balanced
 * object rather than the first non-`{` character means a preamble is free and an epilogue is free,
 * and anything that is not an object at all fails cleanly into the fallback.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => !!s)
  for (const candidate of fenced.reverse()) {
    const parsed = asObject(candidate)
    if (parsed) return parsed
  }

  // No fence. Walk the string tracking brace depth, ignoring braces inside strings, and keep the
  // last balanced span - a naive lastIndexOf('}') would truncate at a brace inside a quoted prompt.
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let best: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) best = text.slice(start, i + 1)
      if (depth < 0) depth = 0
    }
  }
  return best ? asObject(best) : null
}

function asObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- reporting

export function controllerReport(limit = 40): ControllerReport {
  const recent = recentConsults(limit)
  const chosen = chooseController()
  return {
    generatedAt: Date.now(),
    controllers: listWorkers()
      .filter((w) => w.role !== 'worker')
      .map((w) => {
        // ⛔ Asked of this worker, never inferred from which one won. A row that reads `ready` has
        // passed every gate the chooser applies; a row that does not says which gate stopped it.
        const blocked = controllerUnavailability(w)
        return {
          workerId: w.id,
          label: w.label,
          role: w.role,
          available: blocked === null,
          reason:
            blocked ?? (chosen.worker?.id === w.id ? 'ready' : 'ready — another is preferred')
        }
      }),
    pending: pendingConsults().length,
    usedThisHour: consultsStartedSince(Date.now() - 60 * 60 * 1000),
    hourlyCap: HOURLY_CAP,
    recent,
    spentTokens: recent.reduce((sum, c) => sum + c.spentTokens, 0),
    fallbacks: recent.filter((c) => c.status === 'fallback').length
  }
}

// ---------------------------------------------------------------------------- wiring

let timer: NodeJS.Timeout | null = null

export function startController(): void {
  if (timer) return
  timer = setInterval(() => {
    void drainConsults().catch((err) => log.error('controller loop failed:', err))
  }, CONTROLLER_LOOP_MS)
  timer.unref?.()
  log.info(`controller started (drain every ${CONTROLLER_LOOP_MS / 1000}s, cap ${HOURLY_CAP}/hour)`)
}

export function stopController(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** At startup, a consult left `pending` with a session belongs to a daemon that is gone. */
export function reconcileConsults(): number {
  const stranded = rows<ConsultRow>(
    db().prepare("select * from consults where status = 'pending' and session_id is not null").all()
  )
  for (const r of stranded) {
    db()
      .prepare("update consults set session_id = null, worker_id = null, started_at = null where id = ?")
      .run(r.id)
  }
  if (stranded.length) log.warn(`requeued ${stranded.length} consult(s) interrupted by a restart`)
  return stranded.length
}
