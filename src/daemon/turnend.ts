import type { QuestionKind, QuestionOption, Run, Task } from '@shared/tasks.js'
import { cleanQuestionText, isMultiSelectQuestion, isOpenConversation } from '@shared/tasks.js'
import type { Session } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import { voidApprovalsForSession } from './approvals.js'
import { fileParkedQuestion, parkQuestionsForSession } from './questions.js'
import { compactionsForTask } from './compaction.js'
import { creditRunListUsd, getTask, runForSession, runsFor } from './tasks.js'
import { backscroll, closeSession } from './sessions.js'
import { stripAnsi } from './stream.js'
import { log } from './log.js'
import {
  completeTask,
  completing,
  endConversationTurn,
  endUnfinishedRun,
  releaseWorkspaceOf
} from './scheduler.js'

/**
 * What happens when a turn ends: the two terminal signals a session can arrive at
 * (`onSessionExit`, `onStreamResult`), the two prompt contracts an MCP-less adapter is read
 * against (`needsDecisionIn`, `taskCompletionIn`), the idle-turn note a run leaves when its
 * process stays up with nothing left to say, and the two ways a run's own words can excuse it
 * (`overloadFailureRetry`, `deadOnArrival`).
 */

/**
 * What the agent last said it was waiting on, per session.
 *
 * ⛔ Kept because the record arrives **before** the terminal one and the terminal one cannot carry it.
 * Measured 2026-08-30 on claude-code 2.1.251 (R14.c): an agent that asks a question and stops emits
 * `status_category: "blocked"` with a `needs_action` sentence, then a `result` that is byte-for-byte
 * the shape of a success. By the time `onSessionExit` runs, the only thing that knew why is gone.
 *
 * ⚠️ Last one wins, and a category that is not `blocked` clears it. A turn that blocked and a later
 * turn that did not must not leave a stale sentence behind to be reported as the reason.
 */
export const blockedOn = new Map<string, string>()

/**
 * The turn a work run ended on without saying anything terminal, per session.
 *
 * ⛔ **The hole t249 and t254 both fell through, twice each.** An ordinary run stays open until
 * `task_complete` arrives — that is the whole of its contract — and an agent on a `streamPrompts`
 * transport does not exit when its turn ends: the process sits live and idle waiting for a prompt
 * nobody is going to write. So a turn that finished the work and forgot to report it, or one that
 * stopped for any reason `await_human`, `ask_human` and the error paths do not cover, left the run
 * open, the task reading `running`, its clock counting, its workspace held and its worker slot
 * reserved — for as long as the daemon lived. Measured on t254, 2026-09-06: last request 21:08:10,
 * the agent's closing summary at 21:08:16, and the task still `running` forty-five minutes later
 * when the daemon was restarted out from under it. The only thing that ever cleared one was a
 * restart, and a restart is not a mechanism.
 *
 * ⛔ **Written down, not acted on here.** The `result` record proves the turn is over; it does not
 * prove the session is done being useful, because the daemon itself may write the next prompt into
 * it — a wrap-up, a `/compact`, a person's reply. So this is a note with a timestamp, and
 * `runWatchdogs` is what decides, once nothing has happened since. See `idleTurnOverdue`.
 *
 * ⚠️ Keyed by session and holding the run, so a note cannot outlive what it describes: a new run in
 * the same session, or a session that ends, makes it stale rather than wrong.
 */
const idleTurns = new Map<string, { runId: string; at: number; said: string | null }>()

/**
 * How long a work run may sit on a finished turn before it is handed to a person.
 *
 * ⚠️ Generous on purpose, and for one reason: everything the daemon does *to* an idle session — the
 * wrap-up prompt, the cache clock's `/compact`, a completion still landing — happens within seconds
 * of the turn ending, and each of them clears the note by starting a request. Three minutes is the
 * same patience `FINISH_REPLY_AFTER_MS` gives an agent asked to commit, and it is far short of the
 * twelve a stall is given because unlike a stall this cannot be wrong about whether work is in
 * flight: it has the vendor's own record that the turn is over.
 */
export const IDLE_TURN_AFTER_MS = 3 * 60 * 1000

/** Record that this run's turn ended and nothing terminal was said. Exported for its test. */
export function noteIdleTurn(session: Session, run: Run, said: string | null): void {
  idleTurns.set(session.id, { runId: run.id, at: Date.now(), said: (said ?? '').trim() || null })
}

/** What a session's last unreported turn ending was, if it has one. Exported for its test. */
export function idleTurnFor(sessionId: string): { runId: string; at: number; said: string | null } | null {
  return idleTurns.get(sessionId) ?? null
}

export function forgetIdleTurn(sessionId: string): void {
  idleTurns.delete(sessionId)
}

/**
 * Has this run been sitting on a finished turn long enough to hand back?
 *
 * ⛔ **Both clocks, and `quietSince` is the one that matters.** Elapsed time since the turn ended
 * says only that a while has passed. `quietSince` — the last request started, the run's own start,
 * the last compaction that landed — says *nothing has happened since*, which is the difference
 * between a session the daemon has already re-prompted and one nobody is ever going to prompt again.
 * A `/compact` that landed after the note, or a reply typed into the thread, moves that clock past
 * the note and this returns false.
 */
export function idleTurnOverdue(
  noteAt: number,
  quietSince: number,
  now = Date.now(),
  after = IDLE_TURN_AFTER_MS
): boolean {
  return quietSince <= noteAt && now - noteAt > after
}

/** Exported for its test. Sessions are cleaned up by `onSessionExit`, which always runs on exit. */
export function noteTurnStatus(sessionId: string, event: { category: string; detail: string | null; needsAction: string | null }): void {
  const said = (event.needsAction ?? event.detail ?? '').trim()
  if (event.category === 'blocked' && said) blockedOn.set(sessionId, said)
  else blockedOn.delete(sessionId)
}

/**
 * A session ended without reporting completion.
 *
 * That is not a success and not necessarily a failure - it is an unknown, and the honest thing is to
 * say so and hand it to a person rather than guess from an exit code.
 *
 * ⭐ Unless the agent said why, in which case there is no unknown to report. `blockedOn` carries the
 * CLI's own `needs_action` sentence, and quoting it is the difference between "something happened,
 * over to you" and "it is waiting for you to choose between OAuth and session cookies".
 */
export async function onSessionExit(session: Session, exitCode: number | null): Promise<void> {
  voidApprovalsForSession(session.id)
  // ⛔ Parked, not voided, and *before* the run is wound up so the task lands on the more specific
  // reason. An unanswered question is the strongest evidence there is that the agent was waiting
  // rather than broken - stronger than the vendor's own record, because we watched it be asked.
  const parked = parkQuestionsForSession(session.id)
  const waiting = blockedOn.get(session.id)
  blockedOn.delete(session.id)
  // ⛔ The process is gone, so whatever this session's last turn left open is this function's to
  // decide, not the idle-turn watchdog's. Leaving the note behind would let it fire against a run
  // that has already been wound up here.
  forgetIdleTurn(session.id)

  // ⛔ A completion already owns this session's teardown - the run, the workspace and the
  // status - and it has not finished writing yet. Ending the run here would overwrite a reported
  // completion with "nothing here can tell whether the work was finished", which is exactly what
  // happened to t56. Approvals and questions are still voided above, because those die with the
  // process either way. See `completing`.
  if (completing.has(session.id)) {
    log.info(
      `session ${session.id.slice(0, 8)} exited while its completion was still landing; ` +
        'leaving the run to it'
    )
    return
  }

  const run = runForSession(session.id)
  if (run) {
    const clockCompaction = run.taskId
      ? compactionsForTask(run.taskId).findLast(
          (item) =>
            item.sessionId === session.id &&
            item.trigger === 'clock' &&
            item.landedAt !== null &&
            item.landedAt >= run.startedAt
        )
      : null
    const why = waiting
      ? `The agent stopped to ask you something: "${waiting.slice(0, 400)}" ` +
        `The session then ended (exit ${exitCode}) without reporting completion.`
      : parked > 0
        ? `The agent asked ${parked === 1 ? 'a question' : `${parked} questions`} that ` +
          `${parked === 1 ? 'was' : 'were'} still unanswered when the session ended (exit ${exitCode}).`
        : clockCompaction
          ? 'The cache clock compacted this conversation and stopped the interrupted run. ' +
            'The compacted conversation is preserved, but the agent did not report completion; ' +
            'resume it to continue or inspect the work.'
          : `The session ended (exit ${exitCode}) without reporting completion. ` +
          'Nothing here can tell whether the work was finished, so it is over to you.'
    // ⛔ A planner that has just filed its split is the third case, and it is not a failure either.
    //    It was told to stop — the whole design is that the wait costs nothing, which means ending
    //    the process — so its run ended for the best possible reason. Recording `failed` here would
    //    put a red run on every successful Plan & Split and feed the estimator a fault that never
    //    happened.
    const parkedOnItsOwnPlan = run.taskId ? getTask(run.taskId)?.status === 'blocked' : false
    await endUnfinishedRun(
      session,
      run,
      parkedOnItsOwnPlan
        ? 'The agent filed its plan as subtasks and stopped, as instructed. This task waits for ' +
          'them and comes back by itself.'
        : why,
      // ⛔ Not a failure. The agent did the work it was asked for up to the point where it needed
      // an answer, and an unanswered question is not a fault of the run.
      waiting || parked > 0 || clockCompaction || parkedOnItsOwnPlan ? 'blocked' : 'failed'
    )
  }
  // ⛔ Run or no run, and after the run either way. This is the moment the workspace goes back,
  // because the workspace belongs to the **conversation** and the conversation has just ended.
  // ⚠️ The early return this replaced (`if (!run) return`) is exactly the path a session that
  // finished its task and was then closed takes — the common case, and the one that would have
  // leaked every worktree the fleet ever used.
  const task = run?.taskId ? getTask(run.taskId) : null
  await releaseWorkspaceOf(session.id, task?.status === 'awaiting_human' ? task.id : null)
}

/**
 * The CLI said the turn failed.
 *
 * ⛔ **This is the case `onSessionExit` cannot catch, and it was the one that mattered.** Measured
 * on this machine 2026-08-27: a worker whose organisation had disabled Claude Code subscription
 * access answered with `is_error` and `terminal_reason: api_error`, printing *"Your organization has
 * disabled Claude subscription access for Claude Code"* — and then **did not exit**. AGENTS.md has
 * recorded since M1 that a `stream` session which cannot authenticate sits on stdin waiting for input
 * it can never act on; what was missing is that nothing was listening to the record it sent first. So
 * the error was rendered into the session pane for a person to read, the run stayed open, the task
 * stayed `running`, and the worker's only concurrency slot stayed held. Indefinitely.
 *
 * ⚠️ A failed *result* is not always a failed *run*: an agent that hits a tool error and reports it
 * has still done work and still metered turns. `endUnfinishedRun` decides which of the two this is from
 * the metering, not from the wording.
 */
export async function onStreamResult(
  session: Session,
  result: {
    isError: boolean
    text: string | null
    terminalReason: string | null
    /**
     * ⚠️ The vendor's list price for the invocation so far, where the adapter reports one. It was
     * decoded onto `StreamEvent.costUsd` and then dropped here, because this function took three
     * fields of a record that carries four.
     */
    costUsd?: number | null
  }
): Promise<void> {
  // ⛔ **First, and before every early return below.** This record is the only place the number is
  // ever offered, and each of the branches that follow ends the run — so crediting it anywhere else
  // in this function means losing it on whichever path the turn actually took.
  creditRunListUsd(session.id, result.costUsd ?? null)
  const mcpLess = Boolean(session.adapterId && !adapter(session.adapterId).info.capabilities.mcp)
  // An MCP-less adapter cannot call task_complete, so its prompt gives it two deliberately exact
  // terminal contracts. Antigravity can occasionally report ERROR after it has already returned a
  // complete response (t163, 2026-09-03, `context canceled`); its status is not allowed to erase
  // the explicit completion signal, but a plausible-sounding paragraph still is not one.
  const completion = mcpLess ? taskCompletionIn(result.text) : null
  // ⚠️ Read once, above the branches, because a conversation's turn ends on *every* clean path
  // through them and each one used to be able to answer "which task is this" differently.
  const openRun = runForSession(session.id)
  const runTask = openRun?.taskId ? getTask(openRun.taskId) : null

  if (!result.isError) {
    if (mcpLess) {
      // ⛔ An adapter with no MCP has no `ask_human`, so the only channel left is the prompt
      // contract it was given: end with `NEEDS DECISION:` and stop. A run that did is **not**
      // complete, and completing it would file an unanswered question as finished work.
      //
      // ⚠️ This is a contract, not prose parsing. The agent was told this exact prefix and the
      // match is anchored to a line start - nothing here reads intent out of generated text, which
      // is the inference this project refuses to make.
      const asked = needsDecisionIn(result.text)
      if (asked) {
        const run = runForSession(session.id)
        if (run) {
          // ⛔ **Filed as a real question, not only quoted into `hold_reason`.** The card, the
          // options and the box the answer is typed into are all written against a `Question` row,
          // and until this existed an MCP-less agent's question produced no row - so the operator
          // got a sentence on the task and no way to reply to it (t63, 2026-08-30, antigravity).
          //
          // ⚠️ Before the run is wound up, so the thread reads in the order it happened: the
          // question, then what became of the run that asked it.
          fileParkedQuestion({
            sessionId: session.id,
            origin: 'ask_human',
            kind: asked.kind,
            question: asked.question,
            ...(asked.options.length > 0 ? { options: asked.options } : {})
          })
          await endUnfinishedRun(
            session,
            run,
            `The agent stopped to ask you something: "${asked.question.slice(0, 400)}"`,
            'blocked'
          )
          closeSession(session.id)
          return
        }
      }
      // ⛔ Ahead of the completion below, because on this adapter a conversation that has not been
      // asked to finish has no way to say "I am done" and must never be read as having said it. An
      // explicit `TASK COMPLETE:` line is still honoured — that is the operator's contract with the
      // agent, and an agent that writes it has been told to.
      if (isOpenConversation(runTask) && !completion) {
        if (openRun && runTask) await endConversationTurn(session, openRun, runTask, result.text)
        return
      }
      await completeTask(session.id, completion ?? (result.text?.trim() || 'Completed'))
      return
    }
    // ⛔ The turn that has just ended on an MCP adapter, which nothing else closes. See
    // `endConversationTurn` for why the run ends here and the session does not.
    if (isOpenConversation(runTask) && openRun && runTask && !openRun.outcome) {
      await endConversationTurn(session, openRun, runTask, result.text)
      return
    }
    // ⛔ **A work run whose turn ended without a completion signal is not left to be noticed.** The
    // run stays open here — that is still the contract, and `task_complete` is still the only thing
    // that may claim the work is done — but the *fact* that the agent went idle is now written down,
    // and `runWatchdogs` reads it. See `noteIdleTurn`.
    if (openRun && runTask && !openRun.outcome) noteIdleTurn(session, openRun, result.text)
    return
  }
  if (completion) {
    await completeTask(session.id, completion)
    return
  }
  const run = runForSession(session.id)
  if (!run) return

  const said = stripAnsi(result.text ?? '').replace(/\s+/g, ' ').trim()
  const backscrollText = stripAnsi(backscroll(session.id)).replace(/\s+/g, ' ').trim()
  // ⛔ If the stream result has no text but the session backscroll has content, use that. The error
  // message from the CLI is the only thing a person can act on, and losing it to an empty result
  // means losing the fact that the account's quota is the reason the turn failed.
  const errorDetails = said || backscrollText.slice(-400)
  const why =
    `The agent reported a failure${result.terminalReason ? ` (${result.terminalReason})` : ''}` +
    (errorDetails ? `: ${errorDetails}` : ' and said nothing about it.')

  await endUnfinishedRun(session, run, why, 'failed')
  // ⛔ Closed here, and this is not tidiness. The process does not exit on an `api_error`; leaving it
  // would hold this worker's only work slot against a session that can never make progress.
  closeSession(session.id)
}

/**
 * The question an MCP-less agent was told to end with, and the options it offered.
 *
 * ⛔ Anchored to the start of a line and to the exact words the prompt asked for. A looser
 * match - anywhere in the text, or any sentence that sounds like a question - would be reading intent
 * out of generated prose, and would fire on an agent merely *describing* a decision it had made.
 *
 * ⛔ **The options are read from a contract too, and only from directly beneath the question.** The
 * prompt asks for one `- label — what it means` bullet per choice on the lines that follow, and the
 * first line that is not such a bullet ends the list. Measured on t63, 2026-08-30, antigravity wrote
 * its three choices inline — *"(Option A) ... (Option B) ... (Option C)"* — and there is deliberately
 * no attempt to recover them from that: pulling choices out of a sentence is the inference this
 * project refuses to make, and a question with no parsed options is still perfectly answerable in
 * prose, which is why the card always has a text box.
 *
 * ⚠️ Capped at eight, and the em-dash separator is required for a detail. `- Use OAuth` is a label
 * with no detail; splitting on a bare hyphen would cut hyphenated labels in half.
 */
export function needsDecisionIn(
  text: string | null
): { question: string; options: QuestionOption[]; kind: QuestionKind } | null {
  if (!text) return null
  const lines = stripAnsi(text).split(/\r?\n/)
  const at = lines.findIndex((line) => /^[ \t>*-]*NEEDS DECISION:/i.test(line))
  if (at === -1) return null
  const rawQuestion = (/^[ \t>*-]*NEEDS DECISION:[ \t]*(.*)$/i.exec(lines[at] ?? '')?.[1] ?? '').trim()
  if (!rawQuestion) return null

  const question = cleanQuestionText(rawQuestion)

  const options: QuestionOption[] = []
  for (const line of lines.slice(at + 1)) {
    const bullet = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+(.+)$/.exec(line)
    if (!bullet) break
    const body = (bullet[1] ?? '').trim()
    if (!body) break
    const [label, ...rest] = body.split(/\s+[—–]\s+/)
    const detail = rest.join(' — ').trim()
    options.push({
      id: `opt${options.length + 1}`,
      label: (label ?? body).trim().slice(0, 200),
      ...(detail ? { detail: detail.slice(0, 500) } : {})
    })
    if (options.length === 8) break
  }

  const isMulti = isMultiSelectQuestion(rawQuestion, options)
  const kind: QuestionKind = options.length === 0 ? 'text' : isMulti ? 'multi' : 'choice'
  return { question, options, kind }
}

/** The completion contract for adapters that cannot call the MCP task_complete tool. */
export function taskCompletionIn(text: string | null): string | null {
  if (!text) return null
  const line = stripAnsi(text)
    .split(/\r?\n/)
    .find((value) => /^[ \t>*-]*TASK COMPLETE:[ \t]*\S/i.test(value))
  if (!line) return null
  return (/^[ \t>*-]*TASK COMPLETE:[ \t]*(.*)$/i.exec(line)?.[1] ?? '').trim() || null
}

export const OVERLOAD_RETRY_MS = 60_000
export const MAX_OVERLOAD_ATTEMPTS = 3

/**
 * Did this run fail because the remote provider was overloaded / experiencing a temporary outage?
 *
 * ⛔ **t153, 2026-09-03.** Claude answered `api_error: API Error: 529 Overloaded. This is a
 * server-side issue, usually temporary — try again in a moment. If it persists, check
 * https://status.claude.com.`
 * A temporary server-side 529 error is not a fault in the prompt or code, nor is it an account
 * authentication failure. Quarantining the worker would take healthy accounts out of commission,
 * and moving the task to `awaiting_human` halts work that could proceed automatically once the
 * provider recovers.
 *
 * ⚠️ Automatically schedules an attempt after a timeout with exponential backoff
 * (1m, 2m, 4m), bounded by `MAX_OVERLOAD_ATTEMPTS`. If the provider remains overloaded past the
 * limit, it falls back to `awaiting_human` for human intervention.
 */
export function overloadFailureRetry(
  session: Session,
  run: Run,
  why: string,
  task: Task
): { retryAt: number; attempt: number } | null {
  const ad = adapter(session.adapterId)
  const isOverload =
    Boolean(ad.overloaded?.(why) || (session.id ? ad.overloaded?.(stripAnsi(backscroll(session.id))) : false))
  if (!isOverload) return null

  const pastRuns = runsFor(task.id).filter((r) => r.id !== run.id)
  let pastOverloads = 0
  for (const past of pastRuns) {
    if (past.note && ad.overloaded?.(past.note)) {
      pastOverloads++
    } else {
      break
    }
  }
  const attempt = pastOverloads + 1
  if (attempt > MAX_OVERLOAD_ATTEMPTS) {
    return null
  }

  const delayMs = OVERLOAD_RETRY_MS * Math.pow(2, attempt - 1)
  return { retryAt: Date.now() + delayMs, attempt }
}

/**
 * A dispatch that produced **no assistant turn at all**, and why - or null if the run did something.
 *
 * ⛔ Two conditions, and both are needed. *No metered turn* on its own would libel a long run whose
 * final turn had not been flushed yet; *a short life* on its own would libel a small task that
 * finished quickly. Together they describe one thing: the process started, produced nothing a
 * transcript could meter, and stopped. The measured cause on this machine was an account whose
 * subscription had lapsed - the CLI printed its complaint and exited in under two seconds.
 *
 * ⚠️ The reason is taken from the CLI's own last words. `backscroll` keeps what a session said after
 * it exited precisely so this is possible, and the `stream` transport pipes stderr into it - so the
 * message an operator reads is the vendor's, not a guess assembled from an exit code.
 */
export const DEAD_ON_ARRIVAL_MS = 90_000

/** Exported for its test. Both halves of the conjunction matter; see the note above. */
export function deadOnArrival(session: Session, run: Run): string | null {
  const lived = Date.now() - run.startedAt
  if (lived > DEAD_ON_ARRIVAL_MS) return null
  const metered =
    run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens > 0 ||
    session.lastRequestStartedAt !== null
  if (metered) return null

  // ⛔ Stripped, because this becomes a sentence in a table cell. See stripAnsi.
  const said = stripAnsi(backscroll(session.id)).replace(/\s+/g, ' ').trim()
  const tail = said.slice(-300)
  return tail
    ? `the agent exited after ${Math.round(lived / 1000)}s having produced no output. It said: ${tail}`
    : `the agent exited after ${Math.round(lived / 1000)}s having produced no output and said nothing.`
}
