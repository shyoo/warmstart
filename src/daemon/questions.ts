import { randomUUID } from 'node:crypto'
import type {
  Question,
  QuestionAnswer,
  QuestionKind,
  QuestionOption,
  QuestionOrigin,
  QuestionResolution
} from '@shared/tasks.js'
import {
  DEBATE_VERDICTS,
  DEBATE_VERDICT_DETAILS,
  DEBATE_VERDICT_LABELS,
  type DebateVerdict
} from '@shared/tasks.js'
import { normaliseAsk } from '@shared/policy.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { getSession } from './sessions.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import {
  addMessage,
  admit,
  getTask,
  markDelivered,
  messagesFor,
  onRunStart,
  onTaskSettled,
  runForSession,
  setStatus,
  taskOfSession,
  updateTask
} from './tasks.js'
import { getAttachment } from './attachments.js'
import { becomeConversation, recordVerdict } from './debate.js'
import { cancelTask } from './cancel.js'

/**
 * Questions.
 *
 * ⛔ **A question is not an approval.** They look alike for about one sentence — both interrupt one
 * live session, both are answered by a person — and then everything an approval is good at becomes
 * wrong. An approval's answer set is closed at allow/deny; a question's is written by whoever asked.
 * An approval's answer can be remembered as a project rule, which is how that queue empties itself;
 * "OAuth" is not a rule and never will be. An approval denies by default, because an unanswered
 * question about `rm -rf` is not consent — while a design question that defaults to *no* has not been
 * answered at all, and the agent is then told the operator *refused* and builds on that.
 *
 * That last one was live behaviour until this existed. `request_human` routed through the approval
 * path, so every question an agent asked came back as `The operator agreed.` or `The operator
 * declined.` The question travelled; the answer had nowhere to sit.
 *
 * ⛔ **And it is not a Task.** A task is schedulable, durable, and outlives every session; a question
 * is an interrupt with a clock on it. Filing questions as tasks would bury the board in rows nobody
 * re-reads and hand the scheduler work it cannot schedule.
 *
 * Three ways one ends, and only the first is an answer:
 *
 *  1. **A person answers it** — the session is still live, and the reply goes back into the tool
 *     result it was called from.
 *  2. **It is parked** (D1) — nobody answered before the session's cache expired, so holding the
 *     process stopped paying for itself. The task rests at `awaiting_human` and **the question stays
 *     open**, because it is exactly as good a question as it was a minute ago.
 *  3. **Its session dies** — nothing can consume the answer any more, so it is parked too.
 */

/**
 * How long to hold a session open for an answer.
 *
 * ⛔ The deadline is the blocked session's own cache expiry, because that is what waiting costs:
 * past it, resuming costs a full cold rebuild rather than a `0.1·C` read. But a clock read off a
 * session is a number that can be missing, or already in the past on a session that has been idle —
 * and a zero-length wait is a question nobody could possibly answer, dressed up as a question.
 *
 * ⚠️ The ceiling is an hour because that is the longest a prompt cache lives: measured in the R14
 * capture, 2026-08-30, `cache_creation.ephemeral_1h_input_tokens` against a 1h TTL. Holding a
 * process past that waits on a session that has already gone cold.
 */
export const MIN_WAIT_MS = 5 * 60 * 1000
export const MAX_WAIT_MS = 60 * 60 * 1000

interface QuestionRow {
  id: string
  session_id: string
  run_id: string | null
  task_id: string | null
  project_id: string | null
  origin: string
  kind: string
  question: string
  header: string | null
  options_json: string | null
  asked_at: number
  deadline_at: number | null
  answered_at: number | null
  answer_json: string | null
  answered_by: string | null
  parked_at: number | null
}

function toQuestion(r: QuestionRow): Question {
  return {
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    taskId: r.task_id,
    projectId: r.project_id,
    origin: r.origin as QuestionOrigin,
    kind: r.kind as QuestionKind,
    question: r.question,
    header: r.header,
    options: parseOptions(r.options_json),
    askedAt: r.asked_at,
    deadlineAt: r.deadline_at,
    answeredAt: r.answered_at,
    answer: parseAnswer(r.answer_json),
    answeredBy: r.answered_by as Question['answeredBy'],
    parkedAt: r.parked_at
  }
}

/**
 * ⚠️ A malformed blob is read as "no options" rather than thrown.
 *
 * A question whose options cannot be read is still a question a person can answer in prose, and
 * failing the whole row would lose the text as well as the choices.
 */
function parseOptions(json: string | null): QuestionOption[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as QuestionOption[]) : []
  } catch {
    return []
  }
}

function parseAnswer(json: string | null): QuestionAnswer | null {
  if (!json) return null
  try {
    return JSON.parse(json) as QuestionAnswer
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- asking

const waiters = new Map<string, (resolution: QuestionResolution) => void>()
const timers = new Map<string, NodeJS.Timeout>()

export interface QuestionRequest {
  sessionId: string
  origin: QuestionOrigin
  kind: QuestionKind
  question: string
  header?: string
  options?: QuestionOption[]
}

/**
 * Ask, and wait.
 *
 * ⛔ Never answers on the asker's behalf. There is no policy layer here and there should not be one:
 * the whole reason this object exists is that the answer is not derivable from anything the machine
 * holds. It waits, and if nobody comes it says so plainly rather than inventing a preference.
 */
export async function askQuestion(request: QuestionRequest): Promise<QuestionResolution> {
  const session = getSession(request.sessionId)
  const run = runForSession(request.sessionId)
  const task = run?.taskId ? getTask(run.taskId) : null

  // ⛔ **No open run, no turn to answer into.** Claude's native `AskUserQuestion` can carry several
  // questions, and `answerNativeQuestions` asks them one at a time — so the second is asked only
  // once the first resolves, which on t667 (2026-09-24) was a park 27 minutes after the run had
  // ended. Waiting another cache window for an answer nothing can receive is the wrong half; the
  // question itself is still the right one, so it is filed parked onto the session's task, where
  // the answer travels the way every parked answer does.
  if (!run) {
    fileParkedQuestion(request)
    return parkedResolution()
  }

  const deadlineAt = session
    ? costModel(adapter(session.adapterId).info.policy.costModelId).cacheExpiryFor(session)
    : null

  const now = Date.now()
  const question = insertQuestion(request, { deadlineAt, parkedAt: null })
  // ⚠️ The stored question, not the raw argument: `insertQuestion` is where a mangled tool call is
  // repaired, and the operator's hold reason has to read the way the card does.

  // ⛔ **And the task says so.** A question is the one moment the work cannot proceed without a
  // person, and the status is where anybody looks to find that out. It read `running` throughout —
  // true of the process and useless to the operator, who had no way to tell a task that was working
  // from one that had been waiting on them for seven minutes (t59, 2026-08-30: five questions, the
  // first open 03:08:16 to 03:15:06).
  //
  // ⚠️ Set only from `running`, and put back by `answerQuestion`. The run is deliberately **not**
  // ended and the session keeps its workspace — the agent is still there holding the tool call, and
  // this is a label on a live run rather than the end of one.
  //
  // ⭐ It also stops `runWatchdogs` counting the wait against the agent: every check in there is
  // scoped to `running`, so a question left open past `STALL_AFTER_MS` used to earn a stall report
  // for a session that was doing exactly what it was told.
  if (task && task.status === 'running') {
    setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `the agent asked and is waiting on you: ${question.question.slice(0, 300)}`
    })
  }
  log.info(
    `question ${question.id.slice(0, 8)}: ${question.question.slice(0, 120)} — waiting for a person`
  )

  return await waitFor(question.id, waitMsFor(deadlineAt, now))
}

/**
 * Write the row, tell everyone, and put the question on the thread.
 *
 * ⛔ Shared with `fileParkedQuestion` so that a question asked through a tool call and a question
 * asked in prose are **the same object**. The operator's side of this — the card, the options, the
 * text box, the answer that lands on the thread — is written once against `Question`, and an
 * MCP-less agent's question that skipped this insert got none of it.
 */
function insertQuestion(
  request: QuestionRequest,
  timing: { deadlineAt: number | null; parkedAt: number | null }
): Question {
  // ⛔ The open run's task, else the session's last. A question with no task has no thread to carry
  // its answer and is out of reach of every sweep keyed on a task — t680 found one such row sitting
  // on the banner, parked and unanswerable, hours after the work moved on.
  const run = runForSession(request.sessionId)
  const task = run?.taskId ? getTask(run.taskId) : taskOfSession(request.sessionId)
  const id = randomUUID()
  // ⛔ **Here, and not in each asker.** `kind` and `options` decide whether the operator gets buttons
  // or a text box, and an asker whose tool call was mangled on the way out cannot be trusted to
  // report either — on t235 three multiple-choice questions arrived as `text` with their options
  // still sitting in the question string, and were answered by hand with the letters `A`, `B`, `A`.
  // Every path in — the MCP tools, a bridge, a future one — passes through this function, so this is
  // the only place the repair covers all of them. See `normaliseAsk`.
  const asked = normaliseAsk(request)
  const options = normaliseOptions(asked.kind, asked.options)

  db()
    .prepare(
      `insert into questions (id, session_id, run_id, task_id, project_id, origin, kind, question,
                              header, options_json, asked_at, deadline_at, answered_at, answer_json,
                              answered_by, parked_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,null,null,null,?)`
    )
    .run(
      id,
      request.sessionId,
      run?.id ?? null,
      task?.id ?? null,
      task?.projectId ?? null,
      request.origin,
      asked.kind,
      asked.question,
      asked.header,
      options.length > 0 ? JSON.stringify(options) : null,
      Date.now(),
      timing.deadlineAt,
      timing.parkedAt
    )

  const question = requireQuestion(id)
  emit({ type: 'question.opened', question })

  // ⛔ Written to the thread as it is asked, not when it is answered. The thread is the
  // permanent record of why the work is the way it is, and a question asked and answered inside one
  // live session would otherwise exist only in that session's scrollback - so a successor after a
  // preemption pays to rediscover a decision somebody already made.
  //
  // ⚠️ Role `agent`, which is both true and load-bearing: `buildPrompt` re-delivers
  // outstanding *human* messages, and takes an `agent` message only when it is first in the thread.
  // So this is visible to a person and is never re-sent to an agent.
  if (task) addMessage(task.id, 'agent', renderAsk(asked), run?.id ?? null)
  return question
}

/**
 * A question that was asked with nobody left to answer it into.
 *
 * ⛔ **An adapter with no MCP has no `ask_human`.** Antigravity and codex are told a prompt contract
 * instead — end with `NEEDS DECISION:` and stop — and that line was read, quoted into `hold_reason`
 * and thrown away. Measured on t63, 2026-08-30: antigravity asked which of three quota-refresh
 * designs to build, the task rested at `awaiting_human` with the sentence on its row, and the
 * operator had **no question card, no options and nowhere to type the answer** — the entire
 * `Question` interface, which exists and works, was reachable only through a tool call that adapter
 * cannot make.
 *
 * ⚠️ Born parked, and that is the truth rather than a shortcut. The turn is over by the time this
 * text can be read: there is no waiter, no tool result to return into, and nothing to hold a process
 * open for. Parked is precisely the state for a question whose asker has gone, and the answer
 * travels the way every parked answer travels — onto the thread, into the next run's prompt.
 */
export function fileParkedQuestion(request: QuestionRequest): Question {
  const question = insertQuestion(request, { deadlineAt: null, parkedAt: Date.now() })
  emit({ type: 'question.parked', question })
  log.info(
    `question ${question.id.slice(0, 8)} filed already parked (the asker has no way to be answered): ` +
      question.question.slice(0, 120)
  )
  if (question.taskId) return question
  voidTasklessQuestion(question.id)
  return requireQuestion(question.id)
}

/**
 * ⛔ Option ids are minted here when the asker did not supply them, and they must be stable within
 * one question: the answer travels back as an id, and an id derived from an index would silently
 * point at a different option if anything ever reordered the list.
 */
function normaliseOptions(kind: QuestionKind, options: QuestionOption[]): QuestionOption[] {
  if (kind === 'text') return []
  return options.map((option, index) => ({
    id: option.id?.trim() || `opt${index + 1}`,
    label: option.label,
    ...(option.detail ? { detail: option.detail } : {})
  }))
}

/** See MIN_WAIT_MS. A missing or already-expired clock still buys the operator a usable window. */
export function waitMsFor(deadlineAt: number | null, now: number): number {
  if (deadlineAt === null) return MIN_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, deadlineAt - now))
}

function waitFor(id: string, ms: number): Promise<QuestionResolution> {
  return new Promise((resolve) => {
    timers.set(
      id,
      setTimeout(() => {
        waiters.delete(id)
        timers.delete(id)
        resolve(park(id, 'nobody answered before this session stopped paying for itself'))
      }, ms)
    )
    waiters.set(id, (resolution) => {
      const timer = timers.get(id)
      if (timer) clearTimeout(timer)
      timers.delete(id)
      waiters.delete(id)
      resolve(resolution)
    })
  })
}

// ---------------------------------------------------------------------------- answering

/**
 * A person answers.
 *
 * ⛔ Answering a **parked** question is the normal case, not an edge case. The session it was asked
 * from is long gone by then, so there is no waiter to resolve and nothing to return the reply to —
 * the answer goes into the task's thread instead, where the next run's prompt will carry it. That is
 * what makes a park recoverable rather than a dead end.
 */
export function answerQuestion(id: string, answer: QuestionAnswer, by: 'human' = 'human'): Question {
  const existing = requireQuestion(id)
  if (existing.answeredAt) return existing

  db()
    .prepare('update questions set answered_at = ?, answer_json = ?, answered_by = ? where id = ?')
    .run(Date.now(), JSON.stringify(answer), by, id)

  const answered = requireQuestion(id)
  emit({ type: 'question.answered', question: answered })

  const reply = renderAnswer(answered)
  const waiter = waiters.get(id)
  const consumedLive = Boolean(waiter)
  if (waiter) waiter({ status: 'answered', reply, answer })

  // ⛔ Recorded either way, and as a **human** message, because it is one. What differs is
  // only whether it still has to be *delivered*: an answer the waiting agent already took as its
  // tool result must not arrive a second time in the next run's prompt, which is the duplicate
  // delivery `deliveredAt` exists to prevent. An answer to a parked question has reached nobody
  // yet, so it is left outstanding and `buildPrompt` carries it - which is the whole mechanism by
  // which answering a parked question restarts the work.
  if (answered.taskId) {
    // ⛔ The attachments ride the answer's own message, which is what binds them to the task. A
    // folder answered with is therefore granted exactly as one attached in the composer is — the
    // next run's argv carries it via `grantedDirsFor`, which is the whole route by which an
    // operator hands an MCP-less agent a directory it asked for with NEEDS DECISION.
    addMessage(answered.taskId, 'human', reply, answered.runId, answer.attachmentIds ?? [])
    if (consumedLive) {
      const written = messagesFor(answered.taskId)
      const last = written[written.length - 1]
      if (last) markDelivered([last.id])
      // ⛔ Only when the answer was taken by a live waiter. That agent has its reply and is working
      // again, so the label `askQuestion` put on goes back. A **parked** question has no waiter:
      // answering it leaves the task at `awaiting_human` on purpose, because nothing is running
      // there and the reply travels in the next run's prompt instead.
      //
      // ⚠️ Guarded on the status this actually set. An operator who pressed *Stop here* while the
      // question was open has moved the task somewhere deliberate, and putting it back to `running`
      // would overrule them.
      const task = getTask(answered.taskId)
      if (task?.status === 'awaiting_human') {
        setStatus(answered.taskId, 'running', { assignee: 'agent', holdReason: null })
      }
    } else if (answered.origin === 'debate') {
      const chosen = answered.answer?.optionIds?.find((optId): optId is DebateVerdict =>
        (DEBATE_VERDICTS as readonly string[]).includes(optId)
      )
      if (chosen) {
        recordVerdict(answered.taskId, chosen)
        const note = answered.answer?.text?.trim()
        addMessage(answered.taskId, 'system', `Verdict: ${DEBATE_VERDICT_LABELS[chosen]}`, answered.runId, [], {
          detail: note ? `The operator added: ${note}` : DEBATE_VERDICT_DETAILS[chosen]
        })
        if (chosen === 'discuss') {
          becomeConversation(answered.taskId)
        } else if (chosen === 'complete') {
          updateTask(answered.taskId, { finishPolicy: 'report-only' })
          setStatus(answered.taskId, 'completed', { holdReason: 'debate converged and completed as report-only' })
        } else if (chosen === 'stop') {
          void cancelTask(answered.taskId, {
            restingState: 'paused_user',
            reason: 'the operator stopped the work after reading the debate’s agreement',
            requestedBy: 'human'
          })
        } else if (chosen === 'execute' || chosen === 'split') {
          const task = getTask(answered.taskId)
          if (task?.status === 'awaiting_human' || task?.status === 'blocked') {
            setStatus(answered.taskId, 'ready', { assignee: null, holdReason: null })
            admit(answered.taskId)
          }
        }
      }
    }
  }
  log.info(`question ${id.slice(0, 8)} answered: ${reply.slice(0, 120)}`)
  return answered
}

/**
 * How a question reads in the thread it was asked on.
 *
 * ⚠️ The options are listed, because a decision recorded without the alternatives it was
 * chosen over is half a record. Somebody reading it in a month needs to see what was *not* picked.
 */
function renderAsk(asked: {
  question: string
  header?: string | null
  options?: QuestionOption[]
}): string {
  const lines = [asked.header ? `${asked.header}: ${asked.question}` : asked.question]
  for (const option of asked.options ?? []) {
    lines.push(`  - ${option.label}${option.detail ? ` - ${option.detail}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Render an answer as the sentence the agent reads.
 *
 * ⛔ One place, because both callers must word it identically: an `ask_human` tool result and an
 * `AskUserQuestion` interception are the same answer arriving through two different doors, and an
 * agent that got a different sentence depending on the door would behave differently for no reason.
 */
export function renderAnswer(question: Question): string {
  const answer = question.answer
  if (!answer) return 'No answer was given.'
  const chosen = answer.optionIds
    .map((id) => question.options.find((o) => o.id === id)?.label ?? id)
    .filter(Boolean)
  const parts: string[] = []
  if (chosen.length > 0) parts.push(`The operator chose: ${chosen.join(', ')}.`)
  if (answer.text?.trim()) parts.push(answer.text.trim())
  // ⛔ Named in the sentence, not left as rows the agent must know to look up. A folder answered
  // with is granted to the task, and the next run's prompt will say so again via the grant list —
  // but the live agent taking this as its tool result has no next prompt, so this is the one place
  // it can read what changed. (It still cannot use it mid-run: a sandbox is fixed at spawn, and a
  // parked answer restarts the work to pick it up.)
  const folders = (answer.attachmentIds ?? [])
    .map((id) => getAttachment(id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.kind === 'folder')
  if (folders.length > 0) {
    parts.push(
      `The operator also attached ${folders.length === 1 ? 'this folder' : 'these folders'}, ` +
        `which ${folders.length === 1 ? 'is' : 'are'} granted to this task: ${folders.map((f) => f.file).join('; ')}.`
    )
  }
  return parts.length > 0 ? parts.join(' ') : 'The operator gave no answer.'
}

// ---------------------------------------------------------------------------- parking

/**
 * The question outlives the session (D1).
 *
 * ⛔ `answered_at` is deliberately left null. This is not a timeout answer and not a refusal — the
 * two things that changed are that the process waiting for it has stopped being worth holding, and
 * that a person now owns the task. The question is untouched and still answerable.
 */
function park(id: string, why: string): QuestionResolution {
  const question = requireQuestion(id)
  if (question.answeredAt || question.parkedAt) {
    return { status: 'void', reply: 'This question is no longer open.', answer: question.answer }
  }

  db().prepare('update questions set parked_at = ? where id = ?').run(Date.now(), id)
  const parked = requireQuestion(id)
  emit({ type: 'question.parked', question: parked })

  if (parked.taskId) {
    // ⚠️ The question itself is already in the thread, written when it was asked. This says
    // only what changed, so a reader is not shown the same sentence twice.
    addMessage(parked.taskId, 'system', 'Still waiting on that decision', null, [], { detail: `${why}.` })
    setStatus(parked.taskId, 'awaiting_human', {
      assignee: 'human',
      holdReason: `the agent asked and is waiting on you: ${parked.question.slice(0, 300)}`
    })
  }
  log.warn(`question ${id.slice(0, 8)} parked: ${why}`)
  // ⛔ A parked question travels on its task's thread; one with no task has nowhere to go, and
  // answering it would reach nobody. Void it rather than leave it on the banner forever.
  if (!parked.taskId) voidTasklessQuestion(id)
  return parkedResolution()
}

function parkedResolution(): QuestionResolution {
  return {
    status: 'parked',
    reply:
      'No answer arrived in time, so this task has been handed to a person with the question ' +
      'attached. Do not guess: stop here, and say what you were about to do next.',
    answer: null
  }
}

const NO_TASK = 'no task to carry the answer'

function voidTasklessQuestion(id: string): void {
  db().prepare("update questions set answered_at = ?, answer_json = ?, answered_by = 'system' where id = ?")
    .run(Date.now(), JSON.stringify({ optionIds: [], text: NO_TASK }), id)
  emit({ type: 'question.answered', question: requireQuestion(id) })
  log.warn(`question ${id.slice(0, 8)} voided: ${NO_TASK}`)
}

/**
 * A session that has gone means nothing can consume the answer in that turn any more.
 *
 * ⛔ Parked, never denied. `voidApprovalsForSession` answers `deny` because a permission it can no
 * longer grant must not be treated as granted; the opposite is true here — a question whose asker
 * died is still the right question, and the person it is waiting on has not stopped existing.
 */
export function parkQuestionsForSession(sessionId: string): number {
  let parked = 0
  for (const question of openQuestions()) {
    if (question.sessionId !== sessionId) continue
    const resolution = park(question.id, 'the session that asked it ended')
    waiters.get(question.id)?.(resolution)
    const timer = timers.get(question.id)
    if (timer) clearTimeout(timer)
    timers.delete(question.id)
    waiters.delete(question.id)
    parked++
  }
  return parked
}

/** A task that was deleted or settled means its open questions are void. */
export function voidQuestionsForTask(taskId: string, reason = 'task deleted'): void {
  const open = rows<QuestionRow>(
    db().prepare('select * from questions where task_id = ? and answered_at is null').all(taskId)
  ).map(toQuestion)
  for (const q of open) {
    const resolution = park(q.id, reason)
    waiters.get(q.id)?.(resolution)
    const timer = timers.get(q.id)
    if (timer) clearTimeout(timer)
    timers.delete(q.id)
    waiters.delete(q.id)
    db().prepare('update questions set answered_at = ?, answer_json = ?, answered_by = ? where id = ?')
      .run(Date.now(), JSON.stringify({ optionIds: [], text: reason }), 'system', q.id)
    emit({ type: 'question.answered', question: requireQuestion(q.id) })
  }
}

/**
 * Sweep any dangling questions on already settled tasks, and any parked question with no task at
 * all — nothing can consume the answer to either.
 */
export function sweepSettledTaskQuestions(): number {
  try {
    const dangling = rows<QuestionRow>(
      db().prepare(`
        select q.* from questions q
        left join tasks t on q.task_id = t.id
        where q.answered_at is null
          and (t.status in ('completed', 'cancelled') or (q.task_id is null and q.parked_at is not null))
      `).all()
    )
    for (const q of dangling) {
      db().prepare(
        "update questions set answered_at = ?, answer_json = ?, answered_by = 'system' where id = ?"
      ).run(Date.now(), JSON.stringify({ optionIds: [], text: q.task_id ? 'task settled' : NO_TASK }), q.id)
    }
    return dangling.length
  } catch {
    return 0
  }
}

// ⛔ Sweep any dangling questions on already settled tasks on startup
sweepSettledTaskQuestions()

onTaskSettled((taskId, status) => {
  if (status === 'completed' || status === 'cancelled') {
    voidQuestionsForTask(taskId, `task ${status}`)
  }
})

onRunStart((taskId) => {
  voidQuestionsForTask(taskId, 'task continued on new run')
})

// ---------------------------------------------------------------------------- reading

export function requireQuestion(id: string): Question {
  const r = row<QuestionRow>(db().prepare('select * from questions where id = ?').get(id))
  if (!r) throw new Error(`no question '${id}'`)
  return toQuestion(r)
}

/** Everything still waiting on a person, parked or not. Both belong in the same place to answer. */
export function openQuestions(): Question[] {
  return rows<QuestionRow>(
    db().prepare(`
      select q.* from questions q
      left join tasks t on q.task_id = t.id
      where q.answered_at is null
        and (q.task_id is null or (t.deleted_at is null and t.status not in ('completed', 'cancelled')))
      order by q.asked_at
    `).all()
  ).map(toQuestion)
}

export function questionsForTask(taskId: string): Question[] {
  return rows<QuestionRow>(
    db()
      // ⛔ `rowid` breaks the tie. Two questions asked in the same millisecond - which one
      // agent turn can easily do - otherwise come back in whatever order SQLite felt like, and
      // 'the newest question' is exactly what a reader of this list is looking for.
      .prepare('select * from questions where task_id = ? order by asked_at desc, rowid desc')
      .all(taskId)
  ).map(toQuestion)
}
