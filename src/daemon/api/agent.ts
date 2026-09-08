/** The six RPCs an agent reaches through MCP, and the only ones it can. */
import { addMessage, createTask, getTask, runForSession, setTaskHandoff } from '../tasks.js'
import { askQuestion } from '../questions.js'
import { addSplitDependency, applySplit, validateSplit } from '../split.js'
import { completeTask, parkForHuman } from '../scheduler.js'
import { errorMessage } from '@shared/errors.js'
import type { Api, ApiContext } from './support.js'
import { admitAgentTask } from './support.js'

type AgentMethod =
  | 'agent.complete' | 'agent.awaitHuman' | 'agent.createTask' | 'agent.split' | 'agent.depend'
  | 'agent.handoff'

export function apiAgent(_ctx: ApiContext): Pick<Api, AgentMethod> {
  return {
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

      const resolution = await askQuestion({
        sessionId: p.sessionId,
        origin: 'task_split',
        kind: 'choice',
        header: `Split t${parent.seq} into ${pieces.length}?`,
        question:
          `t${parent.seq} wants to split into ${pieces.length} pieces and delegate them:\n\n${listed}\n\n` +
          'Approving files all of them at once and starts them; they branch off this plan’s branch ' +
          'and merge back into it, and nothing reaches the trunk until the whole plan is reviewed. ' +
          'Refusing sends your note back to the planner so it can revise.',
        options: [
          { id: 'approve', label: `File all ${pieces.length}`, detail: 'They start as soon as an account is free' },
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
      return {
        ok: true,
        seqs,
        // ⛔ **This text is load-bearing.** It tells the planner to stop, because an agent that keeps
        // working after splitting is spending a billed turn on work it has just delegated — and it
        // says what will wake it, so stopping does not read as abandoning the task.
        reply:
          `Filed ${seqs.length} pieces: ${seqs.map((s) => `t${s}`).join(', ')}. This task now waits ` +
          'for all of them to settle. STOP NOW — do not start any of this work yourself. You will be ' +
          'started again automatically, with a summary of how every piece turned out, and your job ' +
          'then is to review the result as a whole and finish the task.'
      }
    },
    'agent.depend': (p) => {
      const run = runForSession(p.sessionId)
      const parent = run?.taskId ? getTask(run.taskId) : null
      if (!parent) return { ok: false, reason: 'this session is not working on a task' }
      return addSplitDependency(parent.id, p.taskSeq, p.dependsOnSeq)
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
