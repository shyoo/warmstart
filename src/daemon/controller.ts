import { randomUUID } from 'node:crypto'
import type { Consult, ConsultKind, ConsultStatus } from '@shared/tasks.js'
import type { ControllerReport, Worker } from '@shared/protocol.js'
import { canJudge } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { adapter } from './adapters/index.js'
import { listWorkers, recordDispatchFailure } from './workers.js'
import { accountUnavailability } from './eligibility.js'
import { freshRateLimit, isRefusal, lastQuota } from './quota.js'
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
import { errorMessage } from '@shared/errors.js'

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
  route: 90 * 1000,
  // ⚠️ Long, because nothing waits on it: the task dispatches, runs and finishes whether or not it is
  // ever labelled. This is the one question that can afford to sit behind every question that is
  // actually holding work up.
  title: 30 * 60 * 1000
}

/** Do not re-ask the same question about the same subject inside this. */
const COOLDOWN_MS: Record<ConsultKind, number> = {
  decompose: 30 * 60 * 1000,
  triage: 30 * 60 * 1000,
  gate: 30 * 60 * 1000,
  route: 5 * 60 * 1000,
  // ⛔ A day, and the longest here by two orders of magnitude. The text being summarised does not
  // change on its own, so re-asking buys a differently-worded label for the same turn — and this is
  // the one kind where the sweep that files it would otherwise come back to the same task every tick
  // forever, because a task the controller declined to label still looks unlabelled.
  title: 24 * 60 * 60 * 1000
}

/** Fleet-wide. A controller that has answered twenty questions in an hour is in a loop, not working. */
export const HOURLY_CAP = 20

/** One turn of judgment. Past this the consult is abandoned and the fallback fires. */
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000

/** Less than this left in a consult's window is not worth spawning a CLI for; the fallback is used. */
export const MIN_ANSWER_MS = 20 * 1000

/** When the deterministic answer is due. */
export function consultDeadline(consult: Pick<Consult, 'kind' | 'createdAt'>): number {
  return consult.createdAt + CONSULT_TTL_MS[consult.kind]
}

/**
 * How long one started consult may wait for its answer.
 *
 * ⛔ Bounded by the consult's own window, not only by `ANSWER_TIMEOUT_MS`. The window used to be
 * checked only *before* a consult started, so a route consult (90s) that started 49s in waited the
 * full four minutes for an answer that never came — t501 sat undispatched for 4m49s behind "the top
 * score is used if none arrives" (2026-09-17).
 */
export function answerTimeoutFor(consult: Pick<Consult, 'kind' | 'createdAt'>, now = Date.now()): number {
  return Math.max(0, Math.min(ANSWER_TIMEOUT_MS, consultDeadline(consult) - now))
}

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
  detail: string | null
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
    // ⚠️ The label where there is one. A list of judgment calls is exactly the place a paragraph of
    // prompt is unreadable, and the full text is one click away on the task itself.
    subjectTitle: task?.titleSummary ?? task?.title ?? null,
    status: r.status as ConsultStatus,
    question: r.question,
    detail: r.detail ?? null,
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
  /**
   * Working shown to a person and never sent to the controller.
   *
   * ⛔ Anything here is *evidence about how the answer was reached*, not part of the question. It is
   * stored on the row and rendered in the judgment-call UI; nothing in `run()` reads it, which is
   * what keeps it off the bill.
   */
  detail?: string
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
      `insert into consults (id, kind, subject_id, status, question, detail, created_at)
       values (?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(id, req.kind, req.subjectId, req.question, req.detail ?? null, Date.now())
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

export function recentConsults(limit = 40, offset = 0): Consult[] {
  return rows<ConsultRow>(
    db().prepare('select * from consults order by created_at desc limit ? offset ?').all(limit, offset)
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
  /**
   * A title consult runs on the worker's summary model; every other consult on its judgment model
   * (t638). Null is the CLI's own default, which is what every consult ran on before either existed.
   */
  model?: string | null
  effort?: string | null
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
  if (!canJudge(worker.role)) {
    return worker.role === 'none'
      ? `${worker.label} is held out of both work and judgment`
      : `${worker.label} does work only`
  }

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

  // ⛔ A refusal, not a caution. This gate decides whether a worker may be *asked a question* - one
  // short turn - and `allowed_warning` is a turn the vendor served. Blocking on it took the whole
  // fleet's judgment offline over an advisory, which is the failure `eligibility.ts` exists to keep
  // out of the chooser: held out for a reason nobody could act on.
  const rate = freshRateLimit(worker.id)
  if (rate && isRefusal(rate.status)) {
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

export function chooseController(consult?: Pick<Consult, 'kind'>): ControllerChoice {
  const reasons: string[] = []
  const candidates: Array<{ worker: Worker; score: number; model: string | null; effort: string | null }> = []

  for (const worker of listWorkers()) {
    if (!canJudge(worker.role)) continue
    const title = consult?.kind === 'title'
    const model = title ? worker.summarisingModel ?? null : worker.judgmentModel ?? null
    // ⚠️ No effort without a model to carry it, and none where the CLI takes no flag — the same two
    // halves `checkWorkerDefaults` refused on the way in, re-read here because a worker's adapter
    // is not the only thing that can change between the write and the consult.
    const effort =
      model && adapter(worker.adapterId).info.capabilities.selectableEffort
        ? title
          ? worker.summarisingEffort ?? null
          : worker.judgmentEffort ?? null
        : null
    if (consult?.kind === 'title' && !model) {
      reasons.push(`${worker.label} has no title-summary model`)
      continue
    }
    const blocked = controllerUnavailability(worker)
    if (blocked) {
      reasons.push(blocked)
      continue
    }

    const headroom = controllerHeadroom(worker.id)

    // A dedicated controller is preferred over an account that also does work, because asking a busy
    // account for judgment competes with the work it is doing.
    candidates.push({ worker, score: (worker.role === 'controller' ? 1 : 0) + headroom, model, effort })
  }

  if (candidates.length === 0) {
    return {
      worker: null,
      reason: reasons.length ? reasons.slice(0, 2).join('; ') : 'no worker is designated a controller'
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const chosen = candidates[0]!
  return { worker: chosen.worker, reason: '', model: chosen.model, effort: chosen.effort }
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

    // ⚠️ Soonest deadline first, not oldest first. A title (30 min) queued a second before a route
    // (90s) used to take the one slot while a task sat undispatched waiting on the route.
    const queue = pendingConsults().sort((a, b) => consultDeadline(a) - consultDeadline(b))
    for (const consult of queue) {
      // 1. Expired, or too close to it to be worth a turn. The deterministic answer was always
      // available; now it is used.
      if (answerTimeoutFor(consult) < MIN_ANSWER_MS) {
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

      const choice = chooseController(consult)
      if (!choice.worker) {
        notes.push(`no controller available: ${choice.reason}`)
        break
      }

      await run(consult, choice.worker, choice.model, choice.effort ?? null)
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

async function run(
  consult: Consult,
  worker: Worker,
  model: string | null = null,
  effort: string | null = null
): Promise<void> {
  let sessionId: string | null = null
  try {
    const session = spawnSession({
      workerId: worker.id,
      transport: 'stream',
      purpose: 'consult',
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {})
    })
    sessionId = session.id
    db()
      .prepare("update consults set status = 'pending', worker_id = ?, session_id = ?, started_at = ? where id = ?")
      .run(worker.id, session.id, Date.now(), consult.id)
    emit({ type: 'consult.changed', consult: requireConsult(consult.id) })

    const timeoutMs = answerTimeoutFor(consult)
    const text = await ask(session.id, consult.question, timeoutMs)
    closeSession(session.id)

    // ⚠️ Only a consult that had the whole answer timeout says anything about the account. One cut
    // short by its own window (a route has 90s) meters nothing mid-turn, and calling that dead would
    // hold a healthy account out of dispatch for being asked a question with a short fuse.
    if (text === null) {
      if (timeoutMs >= ANSWER_TIMEOUT_MS) noteDeadConsult(worker, session.id, 'it did not answer in time')
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
      `could not ask ${worker.label}: ${errorMessage(err)}`
    )
  }
}

/** Send the question and wait for the turn to end. Resolves to null on timeout or a dead session. */
function ask(sessionId: string, question: string, timeoutMs: number): Promise<string | null> {
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
    const timer = setTimeout(() => finish(null), timeoutMs)

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

export function controllerReport(limit = 40, offset = 0): ControllerReport {
  const recent = recentConsults(limit, offset)
  const total = (db().prepare('select count(*) as n from consults').get() as { n: number }).n
  const chosen = chooseController()
  return {
    generatedAt: Date.now(),
    controllers: listWorkers()
      .filter((w) => canJudge(w.role))
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
    total,
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
