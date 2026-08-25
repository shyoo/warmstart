import type { Task } from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import { lastQuota } from './quota.js'
import { listWorkers } from './workers.js'
import { getProject, policyFor, reloadProject } from './projects.js'
import {
  admitScheduled,
  addMessage,
  finishRun,
  getTask,
  listTasks,
  messagesFor,
  runForSession,
  runsFor,
  schedulingOrder,
  setStatus,
  startRun
} from './tasks.js'
import { escalateStale, voidApprovalsForSession } from './approvals.js'
import { releaseAllFor } from './resources.js'
import {
  branchNameFor,
  claimWorkspace,
  parkWorkspace,
  prepareWorkspace,
  releaseWorkspace,
  type Workspace
} from './worktrees.js'
import { closeSession, getSession, sendPrompt, sessionsForWorker, spawnSession } from './sessions.js'
import { landTask } from './landing.js'
import { log } from './log.js'
import { db } from './db.js'

/**
 * The scheduler.
 *
 * ⛔ **This loop costs zero tokens.** Dependency resolution, quota gates, resource claims and
 * dispatch are arithmetic. A loop running every ten seconds for weeks must not bill anything, and the
 * fleet has to keep working when the controller agent's own quota runs out. The LLM is consulted on
 * discrete judgment events only, and none of them are here.
 */

/** Above this on the 5h window, stop starting new work. Only applied to a reading we trust. */
const QUOTA_HIGH_WATER = 92

export const TICK_MS = 10_000

/** Workspaces in flight, so an exit can release exactly what its dispatch claimed. */
const workspaces = new Map<string, { workspace: Workspace; projectId: string | null }>()

export interface TickResult {
  dispatched: number
  note: string
}

export async function tick(): Promise<TickResult> {
  admitScheduled()
  escalateStale()

  const ready = listTasks()
    .filter((t) => t.status === 'ready')
    .sort(schedulingOrder)
  if (ready.length === 0) return { dispatched: 0, note: 'nothing ready' }

  let dispatched = 0
  const skipped: string[] = []

  for (const task of ready) {
    const choice = chooseWorker(task)
    if (!choice.worker) {
      skipped.push(`t${task.seq}: ${choice.reason}`)
      continue
    }
    try {
      await dispatch(task, choice.worker, choice.quotaUnverified)
      dispatched++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`dispatch of t${task.seq} failed: ${message}`)
      addMessage(task.id, 'system', `Could not start: ${message}`)
      setStatus(task.id, 'failed')
    }
  }

  return {
    dispatched,
    note: dispatched
      ? `dispatched ${dispatched}`
      : skipped.length
        ? `held: ${skipped.slice(0, 3).join('; ')}`
        : 'nothing dispatched'
  }
}

// ---------------------------------------------------------------------------- gates

interface WorkerChoice {
  worker: Worker | null
  reason: string
  quotaUnverified: boolean
}

/**
 * Hard gates. Failing one discards the candidate rather than queueing behind it, because a task that
 * cannot run on worker A may run on worker B right now.
 *
 * ⛔ The gates ask capabilities, never adapter names.
 */
function chooseWorker(task: Task): WorkerChoice {
  const reasons: string[] = []
  let quotaUnverified = false

  for (const worker of listWorkers()) {
    if (task.constraints.workerId && task.constraints.workerId !== worker.id) continue
    if (!worker.enabled) {
      reasons.push(`${worker.label} disabled`)
      continue
    }
    // Quota is tracked on a human-occupied worker and never spent by agentyard.
    if (worker.humanOccupied) {
      reasons.push(`${worker.label} human-occupied`)
      continue
    }
    if (task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId) continue

    const info = adapter(worker.adapterId).info
    const needs = task.constraints.needs ?? []
    const missing = needs.filter(
      (need) => (info.capabilities as unknown as Record<string, unknown>)[need] !== true
    )
    if (missing.length) {
      reasons.push(`${worker.label} lacks ${missing.join(', ')}`)
      continue
    }

    if (sessionsForWorker(worker.id).length >= worker.maxConcurrent) {
      reasons.push(`${worker.label} at capacity`)
      continue
    }

    const quota = lastQuota(worker.id)
    if (quota && !quota.stale) {
      const session = quota.windows.find((w) => w.id === 'session' || w.id === '5h')
      if (session && session.percent >= QUOTA_HIGH_WATER) {
        reasons.push(`${worker.label} at ${Math.round(session.percent)}% of its 5h window`)
        continue
      }
    } else {
      // ⚠️ No trustworthy reading. Dispatching anyway is a deliberate choice: refusing would make the
      // tool useless on a CLI with no free usage probe. The run is *marked*, so M3 can find every
      // decision made blind, and the real protection here is `maxConcurrent`, not a percentage.
      quotaUnverified = true
    }

    return { worker, reason: '', quotaUnverified }
  }

  return {
    worker: null,
    reason: reasons.length ? reasons.slice(0, 2).join('; ') : 'no eligible worker',
    quotaUnverified
  }
}

// ---------------------------------------------------------------------------- dispatch

async function dispatch(task: Task, worker: Worker, quotaUnverified: boolean): Promise<void> {
  const project = task.projectId ? reloadProject(task.projectId) : null

  let workspace: Workspace | null = null
  let branch: string | null = null

  if (project) {
    workspace = await claimWorkspace(project, task.id)
    if (!workspace) throw new Error(`no free workspace in ${project.name}`)

    branch = project.vcs === 'git' ? branchNameFor(task.seq, task.title) : null
    const prepared = await prepareWorkspace(project, workspace, branch)
    if (!prepared.ok) {
      releaseWorkspace(workspace.claimId)
      throw new Error(prepared.error ?? 'workspace preparation failed')
    }
  }

  const cwd = workspace?.path ?? process.cwd()
  // ⛔ `stream`, not `pty`, for scheduled work. Two measured reasons, both in sendPrompt: the CLI's
  // workspace-trust dialog is skipped only in non-interactive mode, and would otherwise block every
  // dispatch into a fresh worktree with nobody there to answer; and `--permission-prompt-tool` -
  // the entire structured approval channel - exists only in non-interactive mode.
  const session = spawnSession({
    workerId: worker.id,
    cwd,
    transport: 'stream',
    ...(task.constraints.model ? { model: task.constraints.model } : {})
  })

  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: project?.id ?? null,
    quotaUnverified,
    costModelId: adapter(worker.adapterId).info.policy.costModelId
  })

  if (workspace) workspaces.set(run.id, { workspace, projectId: project?.id ?? null })

  setStatus(task.id, 'running', {
    assignee: worker.id,
    ...(branch ? { branch } : {})
  })
  addMessage(
    task.id,
    'system',
    `Started on ${worker.label}${branch ? ` in ${workspace?.path} on \`${branch}\`` : ''}` +
      (quotaUnverified ? ' — quota reading was not trustworthy, so this run is marked unverified.' : '')
  )

  // The CLI needs a moment before it starts reading stdin; a message sent too early is dropped.
  setTimeout(() => {
    try {
      sendPrompt(session.id, promptFor(task))
    } catch (err) {
      log.warn(`could not send the prompt for t${task.seq}:`, err)
    }
  }, 2500)

  log.info(`dispatched t${task.seq} to ${worker.label} (run ${run.id.slice(0, 8)})`)
}

/**
 * What the agent is actually told.
 *
 * The handoff from a previous run is prepended, because a successor that has to rediscover the state
 * of the branch pays for it twice - once in tokens and once in the mistakes it makes meanwhile.
 */
function promptFor(task: Task): string {
  const parts: string[] = []
  if (task.handoffNote) {
    parts.push(`Continuing earlier work. Handoff from the previous session:\n${task.handoffNote}\n`)
  }
  parts.push(task.title)
  const thread = messagesFor(task.id).filter((m) => m.role === 'human')
  for (const message of thread) parts.push(message.text)
  parts.push(
    'When the work is finished, call the agentyard MCP tool `task_complete` with a one-line summary. ' +
      'If you need a decision from a person, call `request_human` rather than guessing.'
  )
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------- completion

/**
 * Called when an agent reports it is done. ⛔ This is the *only* signal that a task succeeded -
 * a process exiting cleanly says nothing about whether the work was done, and reading the terminal
 * to guess is exactly what this design refuses to do.
 */
export async function completeTask(sessionId: string, summary: string): Promise<void> {
  const run = runForSession(sessionId)
  if (!run?.taskId) return
  const task = getTask(run.taskId)
  if (!task) return

  addMessage(task.id, 'agent', summary, run.id)
  finishRun(run.id, 'completed', summary)

  const held = workspaces.get(run.id)
  const project = task.projectId ? getProject(task.projectId) : null
  log.info(
    `t${task.seq} reported complete: run=${run.id.slice(0, 8)} workspace=${held ? 'held' : 'MISSING'} ` +
      `branch=${task.branch ?? 'none'} project=${project?.name ?? 'none'}/${project?.vcs ?? '-'}`
  )

  if (project && held && task.branch && project.vcs === 'git') {
    const result = await landTask({
      project,
      task,
      workspacePath: held.workspace.path,
      branch: task.branch
    })
    if (result.ok) setStatus(task.id, 'completed')
  } else if (task.verification === 'required') {
    addMessage(task.id, 'system', 'Finished, and this task asked for human verification.')
    setStatus(task.id, 'awaiting_human', { assignee: 'human' })
  } else {
    setStatus(task.id, 'completed')
  }

  closeSession(sessionId)
  await releaseFor(run.id, task.id, project?.id ?? null)
  admitDependentsOf(task.id)
}

function admitDependentsOf(taskId: string): void {
  // Imported lazily through the tasks module to keep the dependency direction one-way.
  const dependents = db()
    .prepare('select task_id from task_deps where depends_on = ?')
    .all(taskId) as Array<{ task_id: string }>
  for (const d of dependents) {
    const dependent = getTask(d.task_id)
    if (dependent) setStatus(d.task_id, dependent.status)
  }
}

/**
 * A session ended without reporting completion.
 *
 * That is not a success and not necessarily a failure - it is an unknown, and the honest thing is to
 * say so and hand it to a person rather than guess from an exit code.
 */
export async function onSessionExit(session: Session, exitCode: number | null): Promise<void> {
  voidApprovalsForSession(session.id)
  const run = runForSession(session.id)
  if (!run) return

  const task = run.taskId ? getTask(run.taskId) : null
  finishRun(run.id, exitCode === 0 ? 'failed' : 'failed', `session exited with ${exitCode}`)

  if (task && task.status === 'running') {
    addMessage(
      task.id,
      'system',
      `The session ended (exit ${exitCode}) without reporting completion. ` +
        'Nothing here can tell whether the work was finished, so it is over to you.'
    )
    setStatus(task.id, 'awaiting_human', { assignee: 'human' })
  }

  await releaseFor(run.id, task?.id ?? null, task?.projectId ?? null)
}

/**
 * ⛔ Every dispatch path ends here, success or not. A leaked workspace claim stalls a project, and
 * the symptom - nothing dispatches, nothing errors - is the worst kind of bug to find later.
 *
 * Claims are released by **both** holders on purpose. A workspace is claimed by the task (it outlives
 * any single run of it) while resources taken mid-run are held by the run, and releasing only one of
 * the two is exactly how a pool quietly drains to zero.
 */
async function releaseFor(
  runId: string,
  taskId: string | null,
  projectId: string | null
): Promise<void> {
  const held = workspaces.get(runId)
  if (held) {
    const project = projectId ? getProject(projectId) : null
    if (project) await parkWorkspace(project, held.workspace.path)
    releaseWorkspace(held.workspace.claimId)
    workspaces.delete(runId)
  }
  releaseAllFor(runId)
  if (taskId) releaseAllFor(taskId)
}

// ---------------------------------------------------------------------------- loop

let timer: NodeJS.Timeout | null = null
let running = false

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tick()
      .catch((err) => log.error('scheduler tick failed:', err))
      .finally(() => {
        running = false
      })
  }, TICK_MS)
  timer.unref?.()
  log.info(`scheduler started (tick ${TICK_MS / 1000}s, zero tokens)`)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** At startup, tasks left `running` by a dead daemon are lies - their sessions went with it. */
export function reconcileTasks(): number {
  const stuck = listTasks().filter(
    (t) => t.status === 'running' || t.status === 'assigned' || t.status === 'cancelling'
  )
  for (const task of stuck) {
    for (const run of runsFor(task.id)) {
      if (!run.endedAt) finishRun(run.id, 'terminated', 'orchestratord restarted')
      releaseAllFor(run.id)
    }
    releaseAllFor(task.id)
    workspaces.delete(task.id)
    addMessage(task.id, 'system', 'orchestratord restarted while this was running; returned to ready.')
    setStatus(task.id, task.status === 'cancelling' ? 'paused_user' : 'ready')
  }
  if (stuck.length) log.warn(`recovered ${stuck.length} task(s) interrupted by a restart`)
  return stuck.length
}

export function sessionOf(taskId: string): Session | null {
  const run = runsFor(taskId).find((r) => !r.endedAt)
  return run?.sessionId ? getSession(run.sessionId) : null
}

export { policyFor }
