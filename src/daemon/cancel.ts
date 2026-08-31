import type { CancelRecord, RestingState, Task } from '@shared/tasks.js'
import { DELETABLE_FROM } from '@shared/tasks.js'
import { db } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import {
  addMessage,
  admitDependents,
  dependentsOf,
  finishRun,
  getTask,
  listTasks,
  requireTask,
  runsFor,
  setStatus
} from './tasks.js'
import { closeSession, getSession, interruptSession, writeSession } from './sessions.js'
import { releaseAllFor } from './resources.js'
import { adapter } from './adapters/index.js'
import { costModel } from './costmodel.js'

/**
 * Cancel is not delete.
 *
 * **Cancel** stops execution and returns the task to a *resting state*. It destroys nothing - not the
 * thread, not the runs, not the artifacts, not the branch. **Delete** is a separate, explicit,
 * human-only act.
 *
 * `cancelling` is a real state rather than a formality, because a running session has to be stopped
 * *well*: interrupt, ask for a wrap-up, ⛔ release every claim whether or not the wrap-up succeeded,
 * decide the session's fate on the cache clock rather than reflexively, and cancel the subtree with
 * the same resting state.
 */

/** How long a wrap-up gets before the session is closed anyway. Longer than a commit, shorter than a task. */
const WRAP_UP_TIMEOUT_MS = 90_000

const WRAP_UP_PROMPT =
  'Stop what you are doing. Commit anything that currently compiles on this branch, then write a ' +
  'short handoff: what you were doing, what is done, what the next step is. Do not start anything new.'

export interface CancelOptions {
  restingState?: RestingState
  reason?: string
  requestedBy?: CancelRecord['requestedBy']
  /** Skip interrupt and wrap-up. For a session that will not wind down. Records the run `terminated`. */
  hard?: boolean
}

const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota'
])

export async function cancelTask(taskId: string, options: CancelOptions = {}): Promise<Task> {
  const task = requireTask(taskId)
  const requestedBy = options.requestedBy ?? 'human'

  // Default to `paused_user` on a human cancel: that is what "stop" means to a person watching
  // something go wrong. `draft` is for "not like this"; `cancelled` for "not at all".
  const restingState: RestingState =
    options.restingState ?? (requestedBy === 'human' ? 'paused_user' : 'cancelled')

  if (!CANCELLABLE.has(task.status)) {
    // Already at rest or finished. Cancelling again is a no-op rather than an error, because the
    // operator pressing it twice means the same thing both times.
    return task
  }

  const record: CancelRecord = {
    requestedBy,
    requestedAt: Date.now(),
    reason: options.reason ?? null,
    restingState
  }
  db().prepare('update tasks set cancel_json = ? where id = ?').run(JSON.stringify(record), taskId)
  setStatus(taskId, 'cancelling')
  addMessage(
    taskId,
    'system',
    `Cancel requested by ${requestedBy}${options.reason ? `: ${options.reason}` : ''}. ` +
      `Resting state: ${restingState}.`
  )

  // The subtree goes first, and with the same resting state - an operator who paused a parent must
  // not find its children destroyed.
  for (const child of childrenOf(taskId)) {
    await cancelTask(child.id, { ...options, restingState, requestedBy: 'system' })
  }

  await windDown(task, options.hard === true)

  const settled = setStatus(taskId, restingState)
  admitDependents(taskId)
  log.info(`task t${settled.seq} cancelled to ${restingState}`)
  return settled
}

function childrenOf(taskId: string): Task[] {
  return listTasks().filter((t) => t.parentTaskId === taskId)
}

/**
 * Stop the work well.
 *
 * ⛔ Claim release is not conditional on any earlier step succeeding. One leaked exclusive claim
 * stalls a project forever, and the symptom - nothing dispatches, nothing errors - is the worst kind
 * of bug to find later.
 */
async function windDown(task: Task, hard: boolean): Promise<void> {
  const run = runsFor(task.id).find((r) => !r.endedAt)

  try {
    if (run?.sessionId) {
      const session = getSession(run.sessionId)
      if (session && session.state !== 'closed' && session.state !== 'failed') {
        if (hard) {
          closeSession(session.id)
        } else {
          interruptSession(session.id)
          const wrapped = await askForWrapUp(session.id)
          if (!wrapped) log.warn(`session ${session.id.slice(0, 8)} did not wrap up in time`)
          decideSessionFate(task, session.id)
        }
      }
    }
  } catch (err) {
    log.warn(`wind-down of t${task.seq} hit an error; releasing claims anyway:`, err)
  } finally {
    // Held by the run when there is one, and by the task itself for anything claimed before dispatch.
    if (run) releaseAllFor(run.id)
    releaseAllFor(task.id)
    if (run) finishRun(run.id, hard ? 'terminated' : 'cancelled')
  }
}

/**
 * Send the wrap-up and wait for the session to go quiet.
 *
 * "Quiet" is measured as the transcript not advancing, never as anything on screen - the terminal is
 * for humans.
 */
async function askForWrapUp(sessionId: string): Promise<boolean> {
  try {
    writeSession(sessionId, `${WRAP_UP_PROMPT}\r`)
  } catch {
    return false
  }
  const deadline = Date.now() + WRAP_UP_TIMEOUT_MS
  let lastTurn = getSession(sessionId)?.lastRequestStartedAt ?? 0
  let quietSince = 0

  while (Date.now() < deadline) {
    await delay(2000)
    const session = getSession(sessionId)
    if (!session || session.state === 'closed' || session.state === 'failed') return true
    const turn = session.lastRequestStartedAt ?? 0
    if (turn !== lastTurn) {
      lastTurn = turn
      quietSince = 0
    } else {
      quietSince += 2000
      // Two quiet turns' worth after at least one response is a wrap-up that finished.
      if (quietSince >= 8000 && lastTurn > 0) return true
    }
  }
  return false
}

/**
 * ⛔ Not reflexive. A `paused_user` task whose context is still warm and which may resume in ten
 * minutes is worth keeping; one going to `cancelled` is worth closing now. Killing a warm session
 * that is about to be resumed costs `2.0·C` to rebuild - see docs/cost-model.md §3.
 */
function decideSessionFate(task: Task, sessionId: string): void {
  const session = getSession(sessionId)
  if (!session) return
  const resting = task.cancel?.restingState ?? 'cancelled'

  if (resting === 'cancelled') {
    closeSession(sessionId)
    return
  }

  const model = costModel(adapter(session.adapterId).info.policy.costModelId)
  const expiry = model.cacheExpiryFor(session)
  const warm = expiry !== null && expiry > Date.now()
  if (!warm) {
    closeSession(sessionId)
    return
  }
  log.info(
    `keeping session ${sessionId.slice(0, 8)} open for t${task.seq}: cache warm for another ` +
      `${Math.round(((expiry ?? 0) - Date.now()) / 60000)}m, and a resumed reply costs 0.1x context`
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------- resume

/** Leaving `paused_user` keeps everything: thread, handoff, branch, estimates. */
export function resumeTask(taskId: string): Task {
  const task = requireTask(taskId)
  // ⛔ `paused_quota` included, and it was the one that needed it most. That status is reached by the
  // machine rather than by a person, so it had no Resume button at all and this function turned it
  // away — an operator who could see the window had reset had no way to say so. ⚠️ Its `not_before`
  // is cleared with it: resuming by hand *is* the statement that the wait is over, and leaving a
  // resume time behind would let `resumeQuotaPaused` argue with the person who pressed the button.
  if (task.status !== 'paused_user' && task.status !== 'cancelled' && task.status !== 'paused_quota') {
    return task
  }
  db().prepare('update tasks set cancel_json = null, not_before = null where id = ?').run(taskId)
  addMessage(taskId, 'system', 'Resumed.')
  setStatus(taskId, task.status === 'cancelled' ? 'draft' : 'ready')
  return requireTask(taskId)
}

// ---------------------------------------------------------------------------- delete

export interface DeleteBlockers {
  ok: boolean
  reasons: string[]
}

/** Delete cannot wind a session down, so a running task must be cancelled first. */
export function deleteBlockers(taskId: string): DeleteBlockers {
  const task = requireTask(taskId)
  const reasons: string[] = []

  if (!DELETABLE_FROM.includes(task.status)) {
    reasons.push(`t${task.seq} is ${task.status} — cancel it first`)
  }
  for (const child of childrenOf(taskId)) {
    if (!child.deletedAt) reasons.push(`t${child.seq} ("${child.title}") is a child of this task`)
  }
  for (const id of dependentsOf(taskId)) {
    const dependent = getTask(id)
    if (dependent && !dependent.deletedAt) {
      reasons.push(`t${dependent.seq} ("${dependent.title}") depends on this task`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Delete a task. **Human-only** - an agent that can delete the record of its own failed work is an
 * agent that can hide it, so there is no worker-tier tool for this.
 *
 * Soft by default: the row is hidden and recoverable. ⛔ Runs are never removed either way; they are
 * the estimator's training data and the record of real spend, and they detach to the project's cost
 * history instead. A tool that lets an operator erase what a month cost is lying to them about the
 * next month.
 */
export function deleteTask(taskId: string, opts: { hard?: boolean; force?: boolean } = {}): Task {
  const task = requireTask(taskId)
  const blockers = deleteBlockers(taskId)
  if (!blockers.ok && !opts.force) {
    throw new Error(`cannot delete t${task.seq}:\n- ${blockers.reasons.join('\n- ')}`)
  }

  if (opts.hard) {
    // Detach the runs, then remove the task. `on delete set null` on runs.task_id does the detaching;
    // messages and dependency edges go with it, because they mean nothing without the task.
    db().prepare('update runs set task_id = null, note = coalesce(note, ?) where task_id = ?')
      .run(`from deleted task t${task.seq}: ${task.title}`, taskId)
    db().prepare('delete from tasks where id = ?').run(taskId)
    log.info(`hard-deleted task t${task.seq}; ${runsFor(taskId).length} run(s) detached, not removed`)
    emit({ type: 'task.changed', task: { ...task, deletedAt: Date.now() } })
    return { ...task, deletedAt: Date.now() }
  }

  db().prepare('update tasks set deleted_at = ?, updated_at = ? where id = ?')
    .run(Date.now(), Date.now(), taskId)
  const deleted = requireTask(taskId)
  emit({ type: 'task.changed', task: deleted })
  return deleted
}

export function restoreTask(taskId: string): Task {
  db().prepare('update tasks set deleted_at = null, updated_at = ? where id = ?').run(Date.now(), taskId)
  const task = requireTask(taskId)
  emit({ type: 'task.changed', task })
  return task
}
