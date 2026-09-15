/** The worker RPCs an agent reaches through MCP, and the only ones it can. */
import { addMessage, createTask, getTask, messagesFor, requireTask, runForSession, runsFor, setTaskHandoff } from '../tasks.js'
import { landConversationWork } from '../conversationland.js'
import { askQuestion } from '../questions.js'
import { addSplitDependency, applySplit, validateSplit } from '../split.js'
import {
  becomeConversation,
  nextRound,
  recordVerdict,
  renderAgreement,
  seatsOf,
  validateAgreement
} from '../debate.js'
import { cancelTask } from '../cancel.js'
import { completeTask, continueTask, endPlannerForSplit, parkForHuman } from '../scheduler.js'
import { updateTask } from '../tasks.js'
import {
  DEBATE_VERDICT_DETAILS,
  DEBATE_VERDICT_LABELS,
  DEBATE_VERDICTS,
  isPlanExecute
} from '@shared/tasks.js'
import type { DebateVerdict } from '@shared/tasks.js'
import { verdictInstruction } from '../prompt.js'
import { errorMessage } from '@shared/errors.js'
import type { Api, ApiContext } from './support.js'
import { admitAgentTask } from './support.js'

type AgentMethod =
  | 'agent.taskRead' | 'agent.complete' | 'agent.awaitHuman' | 'agent.createTask' | 'agent.split' | 'agent.depend'
  | 'agent.handoff' | 'agent.land' | 'agent.debateRound'

/**
 * How many malformed `debate_round` calls a debate tolerates before it is handed to a person.
 *
 * ⛔ **The deterministic fallback, and it is written before the happy path for the reason
 * `AGENTS.md` gives: every judgment event needs one.** A validator that refuses forever is a run
 * that spends the operator's window arguing with a schema. Three is enough for a real mistake and
 * few enough that a prompt which is simply wrong stops costing money — and a reply that keeps
 * failing means the *prompt* is wrong, once an errored turn has been ruled out.
 */
const MAX_BAD_ROUNDS = 3

/** ⚠️ In memory on purpose: it is about one live turn, not about the task's durable history. */
const badRounds = new Map<string, number>()

function clearBadRounds(taskId: string): void {
  badRounds.delete(taskId)
}

/**
 * Tell the organizer what was wrong, and count it.
 *
 * ⛔ **It never guesses a winner.** On the third failure the debate is handed to a person with
 * every position on the thread, unsynthesised, and the reply says so: an unarbitrated debate is
 * still N useful answers, and a fabricated agreement is worse than none.
 */
function badRound(taskId: string, reason: string): string {
  const n = (badRounds.get(taskId) ?? 0) + 1
  badRounds.set(taskId, n)
  if (n < MAX_BAD_ROUNDS) {
    return `That call was not accepted: ${reason} (attempt ${n} of ${MAX_BAD_ROUNDS})`
  }
  badRounds.delete(taskId)
  return (
    `That call was not accepted: ${reason} — and that was attempt ${MAX_BAD_ROUNDS}. Stop here. ` +
    'Do not invent an agreement: every seat’s position is already on this thread, and a person ' +
    'will read them unsynthesised. Call `await_human` with what went wrong.'
  )
}

export function apiAgent(_ctx: ApiContext): Pick<Api, AgentMethod> {
  return {
    /**
     * The worker's native route back to the task record.
     *
     * ⛔ Session → open run → task, rather than a caller-supplied task id. A worker needs the
     * previous thread to recover an earlier reference, but may not turn that into fleet-wide read
     * authority merely by changing an argument in an MCP call.
     */
    'agent.taskRead': (p) => {
      const run = runForSession(p.sessionId)
      const task = run?.taskId ? getTask(run.taskId) : null
      if (!task) return null
      return { task, messages: messagesFor(task.id), runs: runsFor(task.id) }
    },
    'agent.complete': async (p) => {
      await completeTask(p.sessionId, p.summary)
      return { ok: true as const }
    },
    /**
     * ⛔ The other terminal contract. It is deliberately *not* routed through `completeTask`: no
     * finish decision is taken, nothing is landed and nothing is claimed about the work. See
     * `parkForHuman`.
     */
    'agent.awaitHuman': (p) => parkForHuman(p.sessionId, p.reason, p.state),
    'agent.createTask': (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent || !run) {
        return { ok: false, reason: 'this session is not working on a task' }
      }
      const filedAt = Date.now()
      try {
        // ⛔ Bounded by construction: createTask narrows the mandate, shares the budget, enforces the
        // depth and fan-out caps and merges near-duplicates. Nothing here has to be trusted.
        //
        // ⚠️ Filed as a **draft** first, then admitted or not. The risk assessment needs the task's
        // inherited mandate and budget to judge it, and those exist only once it is created - so the
        // safe order is create-held, assess, release. A task that reaches `ready` before it has been
        // assessed can be dispatched by the very next tick.
        const task = createTask({
          title: p.title,
          ...(p.prompt ? { prompt: p.prompt } : {}),
          projectId: parent.projectId,
          parentTaskId: parent.id,
          status: 'draft',
          createdBy: {
            kind: 'agent',
            workerId: run.workerId,
            sessionId: p.sessionId,
            runId: run.id
          },
          ...(p.assigneeHint ? { assigneeHint: p.assigneeHint } : {})
        })
        // A merge into a near-duplicate returns the *existing* task, which has already been through
        // this. Re-gating it would re-open a decision somebody may have already made.
        if (task.createdAt >= filedAt) admitAgentTask(task.id)
        return { ok: true, seq: task.seq }
      } catch (err) {
        return { ok: false, reason: errorMessage(err) }
      }
    },
    /**
     * File a whole Plan & Split, once the operator has approved it.
     *
     * ⛔ **Validated, then approved, then written — in that order.** The operator is never shown a
     * plan that cannot be filed, so every rule `applySplit` enforces is checked *before* the card is
     * raised. And nothing is written until they answer, so a refusal costs a message rather than a
     * cleanup.
     *
     * ⚠️ This blocks for as long as the operator takes, and it holds the planner's worker slot while
     * it does — `awaitingHumanReservations` counts an `awaiting_human` task against `maxConcurrent`
     * so that the answer can resume a warm session. That is the price of a structural approval, and
     * it is the same price `ask_human` already pays.
     */
    'agent.split': async (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent || !run) {
        return { ok: false, reply: 'This session is not working on a task, so it cannot split one.' }
      }

      const pieces = p.pieces ?? []
      const precheck = validateSplit(parent, pieces)
      if (!precheck.ok) {
        return { ok: false, reply: `That split was not filed: ${precheck.reason}` }
      }

      const listed = pieces
        .map((piece, i) => {
          const label = piece.summary?.trim() || piece.title.trim().split(/\r?\n/)[0] || `piece ${i + 1}`
          const waits = piece.dependsOn?.length
            ? ` (after ${piece.dependsOn.map((d) => `#${d + 1}`).join(', ')})`
            : ''
          return `${i + 1}. ${label}${waits}`
        })
        .join('\n')

      // ⛔ **The gate is the same gate; only the sentence about what happens next changes.** A Plan &
      //    Execute approval is the one and only time a person sees the instruction before the
      //    executor runs against it — there is no review turn behind it — and telling them it will be
      //    reviewed would be describing a turn this shape does not have.
      const handoff = isPlanExecute(parent)
      const resolution = await askQuestion({
        sessionId: p.sessionId,
        origin: 'task_split',
        kind: 'choice',
        header: handoff
          ? `Hand t${parent.seq} to an executor?`
          : `Split t${parent.seq} into ${pieces.length}?`,
        question: handoff
          ? `t${parent.seq} has finished planning and wants to hand the whole job to one executor:\n\n${listed}\n\n` +
            'Approving files it and starts it as soon as an account is free. It lands on the ' +
            'project’s own target when it is done — this plan does not come back to review it, which ' +
            'is what makes this two turns instead of three, so this is your look at the ' +
            'instruction. Refusing sends your note back to the planner so it can revise.'
          : `t${parent.seq} wants to split into ${pieces.length} pieces and delegate them:\n\n${listed}\n\n` +
            'Approving files all of them at once and starts them; they branch off this plan’s branch ' +
            'and merge back into it, and nothing reaches the trunk until the whole plan is reviewed. ' +
            'Refusing sends your note back to the planner so it can revise.',
        options: [
          handoff
            ? { id: 'approve', label: 'Hand it over', detail: 'It starts as soon as an account is free' }
            : { id: 'approve', label: `File all ${pieces.length}`, detail: 'They start as soon as an account is free' },
          { id: 'refuse', label: 'Not like this', detail: 'Add a note and the planner revises the plan' }
        ]
      })

      const approved = resolution.status === 'answered' && resolution.answer?.optionIds?.includes('approve')
      if (!approved) {
        // ⚠️ The operator's own words go back verbatim. A planner told only "refused" has nothing to
        // revise towards and will re-file something very close to what was just turned down.
        const note = resolution.answer?.text?.trim()
        return {
          ok: false,
          reply:
            resolution.status === 'answered'
              ? `The operator did not approve that split.${note ? ` They said: ${note}` : ''} ` +
                'Revise the plan and call task_split again, or ask them what they would prefer.'
              : `Nobody answered, so nothing was filed (${resolution.status}). Stop here rather than guessing.`
        }
      }

      const result = applySplit(
        parent.id,
        pieces,
        { kind: 'agent', workerId: run.workerId, sessionId: p.sessionId, runId: run.id },
        parent.childDefaults
      )
      if (!result.ok) return { ok: false, reply: `That split was not filed: ${result.reason}` }

      const seqs = result.children.map((c) => c.seq)
      const named = seqs.map((s) => `t${s}`).join(', ')

      if (handoff) {
        // ⛔ **Completed here, not asked for.** A planner told in its reply to call `task_complete`
        //    can forget, and an agent that forgets leaves the run open, the task reading `running`
        //    and the worker slot reserved for as long as the daemon lives — the t226 failure. This
        //    goes through the ordinary completion path rather than writing a status, so the finish
        //    policy, the run's end, the workspace release and the quota reading are the same ones
        //    every other completed task gets. ⚠️ The planner's own policy is `report-only`: it wrote
        //    no code, and there is nothing of its own to land.
        await completeTask(p.sessionId, `Planned and handed to ${named}`)
        return {
          ok: true,
          seqs,
          reply:
            `Filed ${named} and handed the work over. THIS TASK IS NOW COMPLETE — stop here, and do ` +
            'not start any of the work yourself. You will not be started again on it: there is one ' +
            'piece, so there is nothing for a review turn to integrate.'
        }
      }

      // ⛔ The split's wait costs neither agent time nor a run-held claim.  Do not rely on the
      // planner following the reply below and exiting: the run must stop at the durable transition
      // to `blocked`, while its children are still running.
      await endPlannerForSplit(p.sessionId)

      return {
        ok: true,
        seqs,
        // ⛔ **This text is load-bearing.** It tells the planner to stop, because an agent that keeps
        // working after splitting is spending a billed turn on work it has just delegated — and it
        // says what will wake it, so stopping does not read as abandoning the task.
        reply:
          `Filed ${seqs.length} pieces: ${named}. This task now waits ` +
          'for all of them to settle. STOP NOW — do not start any of this work yourself. You will be ' +
          'started again automatically, with a summary of how every piece turned out, and your job ' +
          'then is to review the result as a whole and finish the task.'
      }
    },
    /**
     * The organizer's one move per round.
     *
     * ⛔ **The deterministic fallback is written first, and it never guesses a winner.** An
     * organizer that calls this with something that will not validate is told exactly what is
     * wrong and may try again — up to `MAX_BAD_ROUNDS` times, after which the debate is handed to
     * a person with every position intact and unsynthesised. An unarbitrated debate is still N
     * useful answers; a fabricated agreement is worse than none.
     *
     * ⚠️ The converged path **blocks for as long as the operator takes**, and holds the
     * organizer's worker slot while it does — the same price `agent.split` and `ask_human` pay,
     * and for the same reason: the answer has to resume a session that still holds the debate.
     */
    'agent.debateRound': async (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent || !run) {
        return { ok: false, reply: 'This session is not working on a task, so it cannot run a debate round.' }
      }
      if (parent.kind !== 'debate' || !parent.debate) {
        return {
          ok: false,
          reply: `t${parent.seq} is not a Debate task. This tool is only for a debate's organizer.`
        }
      }

      const wantsContinue = p.continue === true
      const wantsConverge = p.converged === true
      if (wantsContinue === wantsConverge) {
        return { ok: false, reply: badRound(parent.id, 'call this with exactly one of `continue` or `converged`, not both and not neither.') }
      }

      if (wantsContinue) {
        // ⚠️ `continueTask` is synchronous, and `nextRound` depends on that: the seats have to have
        // left their settled status by the time it re-blocks this task.
        const result = nextRound(parent.id, p.briefs ?? [], (taskId) => {
          continueTask(taskId)
        })
        if (!result.ok) return { ok: false, reply: badRound(parent.id, result.reason) }
        clearBadRounds(parent.id)
        // ⛔ The organizer's run is stopped at the durable transition to `blocked`, exactly as a
        // planner's is after a split — not by trusting it to read the reply below and exit.
        await endPlannerForSplit(p.sessionId)
        const round = requireTask(parent.id).debate?.round ?? 0
        return {
          ok: true,
          reply:
            `Round ${round} is open: every seat has your brief and is answering it. STOP NOW — do ` +
            'not do any of this work yourself. You will be started again automatically when every ' +
            'seat has answered, with their positions in front of you.'
        }
      }

      const checked = validateAgreement({
        agreed: p.agreement ?? '',
        dissent: p.dissent ?? '',
        confidence: p.confidence ?? '',
        unresolved: p.unresolved ?? ''
      })
      if (!checked.ok) return { ok: false, reply: badRound(parent.id, checked.reason) }
      clearBadRounds(parent.id)

      const agreement = renderAgreement(checked.agreement)
      addMessage(parent.id, 'agent', agreement, run.id)

      const resolution = await askQuestion({
        sessionId: p.sessionId,
        origin: 'debate',
        kind: 'choice',
        header: `t${parent.seq}: the debate has an answer — what now?`,
        question:
          `${seatsOf(parent.id).length} agents argued this out over ` +
          `${parent.debate.round} round(s). The organizer reports:

${agreement}

` +
          'Choose what happens next. Nothing is built and nothing is landed until you do.',
        options: DEBATE_VERDICTS.map((v) => ({
          id: v,
          label: DEBATE_VERDICT_LABELS[v],
          detail: DEBATE_VERDICT_DETAILS[v]
        }))
      })

      const chosen = resolution.answer?.optionIds?.find((id): id is DebateVerdict =>
        (DEBATE_VERDICTS as readonly string[]).includes(id)
      )
      if (resolution.status !== 'answered' || !chosen) {
        return {
          ok: false,
          reply:
            `Nobody answered, so nothing happens yet (${resolution.status}). Your agreement is on ` +
            'the thread and the operator can still answer the card. Stop here rather than guessing ' +
            'which of the five they would have picked.'
        }
      }

      recordVerdict(parent.id, chosen)
      const note = resolution.answer?.text?.trim()
      addMessage(parent.id, 'system', `Verdict: ${DEBATE_VERDICT_LABELS[chosen]}`, run.id, [], {
        detail: note ? `The operator added: ${note}` : DEBATE_VERDICT_DETAILS[chosen]
      })

      if (chosen === 'discuss') {
        const became = becomeConversation(parent.id)
        if (!became.ok) return { ok: false, reply: `The verdict could not be applied: ${became.reason}` }
      }
      if (chosen === 'complete') {
        // ⛔ Without this the empty-branch guard hands a finished debate back to a person: the
        // agreement is on the thread and there is nothing on the branch, which is precisely the
        // shape `report-only` exists to describe.
        updateTask(parent.id, { finishPolicy: 'report-only' })
      }
      if (chosen === 'stop') {
        // ⛔ *Cancel is not delete.* Every position, every round and every run stays.
        await cancelTask(parent.id, {
          restingState: 'paused_user',
          reason: 'the operator stopped the work after reading the debate’s agreement',
          requestedBy: 'human'
        })
      }

      return {
        ok: true,
        verdict: chosen,
        reply:
          `The operator chose: ${DEBATE_VERDICT_LABELS[chosen]}.` +
          (note ? ` They said: ${note}` : '') +
          `\n\n` +
          verdictInstruction(chosen, '', '')
      }
    },
    'agent.depend': (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent) return { ok: false, reason: 'this session is not working on a task' }
      return addSplitDependency(parent.id, p.taskSeq, p.dependsOnSeq)
    },
    /**
     * Land a conversation's committed work without ending anything.
     *
     * ⛔ **Session → open run → task, and never a task id from the caller.** Every worker RPC here
     * is scoped to the run the calling process is actually serving; accepting an id would let an
     * agent land a branch belonging to a task it was never given.
     *
     * ⚠️ Deliberately *not* routed through `completeTask`: no finish decision is taken on the
     * task, the run stays open, and the agent goes on working in the branch this returns. The
     * refusals — wrong kind, dirty tree, no commits, no checks, no authority — all come back as
     * `reason`, which the tool passes through verbatim.
     */
    'agent.land': async (p) => {
      const run = runForSession(p.sessionId)
      if (!run?.taskId) return { ok: false, reason: 'this session is not working on a task' }
      const result = await landConversationWork(run.taskId, {
        sessionId: p.sessionId,
        ...(p.rung ? { rung: p.rung } : {})
      })
      // ⚠️ The summary is recorded on the thread rather than used to decide anything. It is what
      // the agent says the landing contains, and the operator reads it beside the landing line.
      if (result.ok && p.summary?.trim()) {
        addMessage(run.taskId, 'agent', p.summary.trim(), run.id)
      }
      return result
    },
    'agent.handoff': (p) => {
      const run = runForSession(p.sessionId)
      if (run?.taskId) {
        setTaskHandoff(run.taskId, p.note)
        addMessage(run.taskId, 'agent', `Handoff recorded:
${p.note}`, run.id)
      }
      return { ok: true as const }
    }
  }
}
