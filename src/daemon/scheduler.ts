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
import { closeSession, getSession, listSessions, sendPrompt, sessionsForWorker, spawnSession } from './sessions.js'
import { landTask } from './landing.js'
import { log } from './log.js'
import { db } from './db.js'
import { windowResetsAt, lastRateLimit } from './quota.js'
import { reserveState } from './reserve.js'
import { estimateTask, overrunFactor } from './estimator.js'
import { DEFAULT_OBJECTIVE, policy, resolveObjective, weights } from './objective.js'
import { runCacheClock } from './cacheclock.js'
import { costModel } from './costmodel.js'

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
  // ⛔ Before dispatching anything: a window about to close, or a run past its estimate, is a cost
  // event that outranks starting new work.
  await runWatchdogs()

  const ready = listTasks()
    .filter((t) => t.status === 'ready')
    .sort(schedulingOrder)

  let dispatched = 0
  const skipped: string[] = []
  const dispatchTargets = new Set<string>()

  for (const task of ready) {
    const choice = chooseTarget(task)
    if (!choice.worker) {
      skipped.push(`t${task.seq}: ${choice.reason}`)
      continue
    }
    try {
      if (choice.session) dispatchTargets.add(choice.session.id)
      await dispatch(task, choice)
      dispatched++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`dispatch of t${task.seq} failed: ${message}`)
      addMessage(task.id, 'system', `Could not start: ${message}`)
      setStatus(task.id, 'failed')
    }
  }

  // The cache clock runs after dispatch, so a session the scheduler just chose is recognised as
  // move 1 - an expiring asset turned into work - rather than being kept alive for its own sake.
  const clock = await runCacheClock({ objective: DEFAULT_OBJECTIVE, dispatchTargets })

  const parts: string[] = []
  if (dispatched) parts.push(`dispatched ${dispatched}`)
  if (clock.acted) parts.push(`cache clock acted on ${clock.acted}`)
  if (!dispatched && skipped.length) parts.push(`held: ${skipped.slice(0, 3).join('; ')}`)
  if (parts.length === 0) parts.push(ready.length ? 'nothing dispatchable' : 'nothing ready')

  return { dispatched, note: parts.join(' · ') }
}

// ---------------------------------------------------------------------------- gates

interface WorkerChoice {
  worker: Worker | null
  /** A live, idle session already holding this task's context. Reusing it is the cheapest move here. */
  session: Session | null
  reason: string
  quotaUnverified: boolean
  score: number
}

/**
 * Is this session live, idle, and already this task's?
 *
 * ⚠️ **Same task only, deliberately.** A reply into a warm session costs `0.1·C`; the same reply into
 * a dead one costs `2.0·C`, and human latency routinely straddles the one-hour TTL - so this is the
 * single most valuable reuse there is, and it is safe because the workspace, the branch and the
 * context all still belong to the same task.
 *
 * Reuse *across* tasks in one project is the bigger prize and is not done here: it needs the workspace
 * claim to move from the task to the session, so that a session outlives the task that opened it
 * without leaking a claim or switching a branch under a running agent. Recorded in HANDOFF.
 */
function warmSessionFor(task: Task): Session | null {
  for (const run of runsFor(task.id)) {
    if (!run.sessionId) continue
    const session = getSession(run.sessionId)
    if (!session || session.state === 'closed' || session.state === 'failed') continue
    // A session with an open run is busy; only an idle one can take work.
    const open = runForSession(session.id)
    if (open && !open.endedAt) continue
    return session
  }
  return null
}

/**
 * Hard gates. Failing one discards the candidate rather than queueing behind it, because a task that
 * cannot run on worker A may run on worker B right now.
 *
 * ⛔ The gates ask capabilities, never adapter names.
 */
function chooseTarget(task: Task): WorkerChoice {
  const reasons: string[] = []
  let quotaUnverified = false
  const objective = resolveObjective(undefined, undefined)
  const w = weights(objective)

  const warm = warmSessionFor(task)
  const candidates: WorkerChoice[] = []

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

    // ⛔ Never dispatch to an account nobody has signed into. Measured 2026-08-25: a `stream` session
    // that cannot authenticate does not exit - it sits on stdin waiting for input it can never act
    // on - so it holds the worker's only concurrency slot indefinitely. A mis-commissioned worker
    // would silently absorb its own capacity and every task routed to it would stall.
    if (worker.identity?.raw?.includes('"loggedIn": false')) {
      reasons.push(`${worker.label} is not signed in`)
      continue
    }

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

    const session = warm && warm.workerId === worker.id ? warm : null
    candidates.push({
      worker,
      session,
      reason: '',
      quotaUnverified,
      score: scoreCandidate(task, worker, session, w)
    })
  }

  if (candidates.length === 0) {
    return {
      worker: null,
      session: null,
      reason: reasons.length ? reasons.slice(0, 2).join('; ') : 'no eligible worker',
      quotaUnverified,
      score: 0
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0] as WorkerChoice
}

/**
 * ⛔ Every term is a continuous function of the objective vector, never a switch on a mode name. The
 * two requirements the plan wanted fall out of the arithmetic rather than needing features:
 * "add X, test X, document X" lands on one session because `warm` and `affinity` both peak there, and
 * three big independent tasks go to three workers whole because `cold` prices the alternative.
 */
function scoreCandidate(
  task: Task,
  worker: Worker,
  session: Session | null,
  w: ReturnType<typeof weights>
): number {
  const now = Date.now()

  const warmth = session?.cacheExpiresAt
    ? Math.max(0, Math.min(1, (session.cacheExpiresAt - now) / (60 * 60 * 1000)))
    : 0
  const affinity = session ? 1 : 0
  const cold = session ? 0 : 1
  const projectSwitch = session && session.projectId && session.projectId !== task.projectId ? 1 : 0

  // Context rot is documented rather than folklore, and it does not start at zero context - it bites
  // as the window fills. Roughly nothing below half, rising after.
  let rot = 0
  if (session?.contextTokens) {
    const model = costModel(adapter(session.adapterId).info.policy.costModelId)
    const window = model.modelSpec(session.model ?? '')?.context_window ?? 200_000
    const used = session.contextTokens / window
    rot = Math.max(0, (used - 0.5) * 2)
  }

  const reserve = reserveState(worker.id)
  const rate = lastRateLimit(worker.id)
  const quotaRisk =
    reserve.verdict === 'at_risk' || (rate && rate.status !== 'allowed')
      ? 1
      : reserve.verdict === 'unknown'
        ? 0.5
        : 0

  const needs = task.constraints.needs ?? []
  const caps = adapter(worker.adapterId).info.capabilities as unknown as Record<string, unknown>
  const fit = needs.length === 0 ? 1 : needs.filter((n) => caps[n] === true).length / needs.length

  return (
    w.warm * warmth +
    w.affinity * affinity -
    w.contextRot * rot -
    w.projectSwitch * projectSwitch -
    w.quotaRisk * quotaRisk -
    w.cold * cold +
    w.capabilityFit * fit
  )
}

// ---------------------------------------------------------------------------- dispatch

async function dispatch(task: Task, choice: WorkerChoice): Promise<void> {
  const worker = choice.worker as Worker
  const quotaUnverified = choice.quotaUnverified

  // ⛔ Reusing a warm session skips the workspace claim entirely: the session is already sitting in
  // the workspace this task claimed, on this task's branch. Claiming again would double-book the
  // pool, and re-preparing would switch a branch under a live agent.
  if (choice.session) {
    await dispatchIntoWarmSession(task, worker, choice.session, quotaUnverified)
    return
  }

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
 * Send a task back into the session that already holds its context.
 *
 * This is the move the whole cost model exists to make available: `0.1·C` for a read that also
 * refreshes the TTL, against `2.0·C` to rebuild the same prefix from nothing.
 */
async function dispatchIntoWarmSession(
  task: Task,
  worker: Worker,
  session: Session,
  quotaUnverified: boolean
): Promise<void> {
  const model = costModel(adapter(worker.adapterId).info.policy.costModelId)
  const saved = Math.round(model.costOfColdStart(session.contextTokens ?? 0) - model.costOfKeepalive(session))

  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: task.projectId,
    quotaUnverified,
    costModelId: adapter(worker.adapterId).info.policy.costModelId
  })

  setStatus(task.id, 'running', { assignee: worker.id })
  addMessage(
    task.id,
    'system',
    `Continued in the session that still holds this task's context` +
      (saved > 0 ? ` — about ${saved} input-token-equivalents cheaper than a cold start.` : '.')
  )
  sendPrompt(session.id, promptFor(task))
  log.info(`t${task.seq} continued warm on ${worker.label} (run ${run.id.slice(0, 8)}, saved ~${saved})`)
}

// ---------------------------------------------------------------------------- watchdogs

/** No turn for this long while a run is open is a stall worth surfacing. */
const STALL_AFTER_MS = 12 * 60 * 1000
/** Past this multiple of its estimate, a run is not working - it is spending. */
const RUNAWAY_FACTOR = 3

/**
 * ⛔ Runs before dispatch on every tick, and costs nothing: every input is already in the database.
 *
 * The three failures worth acting on are all *cost* failures - a window about to close on live work,
 * a run past its estimate, and a reserve breach - which is why they are here rather than in a health
 * check somebody reads later.
 */
async function runWatchdogs(): Promise<void> {
  for (const task of listTasks()) {
    if (task.status !== 'running') continue
    const run = runsFor(task.id).find((r) => !r.endedAt)
    if (!run?.sessionId) continue
    const session = getSession(run.sessionId)
    if (!session) continue

    // 1. The window boundary. This is the case the whole tool was built for.
    const reset = windowResetsAt(run.workerId)
    const margin = policy(DEFAULT_OBJECTIVE).preemptMarginMs
    if (reset && reset.at - Date.now() <= margin && task.preemptible) {
      await preempt(task, session, reset.at, reset.source)
      continue
    }

    // 2. A runaway. Nothing to compare against means it cannot be one - being first is not a crime.
    const factor = overrunFactor(run.id)
    if (factor !== null && factor > RUNAWAY_FACTOR) {
      addMessage(
        task.id,
        'system',
        `This run has spent about ${factor.toFixed(1)}× the estimate for work like it. ` +
          'Stopping it and handing it back rather than letting it keep spending.'
      )
      await preempt(task, session, Date.now(), 'runaway')
      continue
    }

    // 3. A stall. Reported, never killed: a long-running tool call looks exactly like this.
    const lastTurn = session.lastRequestStartedAt ?? session.startedAt
    if (Date.now() - lastTurn > STALL_AFTER_MS) {
      log.warn(
        `t${task.seq} has had no turn for ${Math.round((Date.now() - lastTurn) / 60000)}m ` +
          '(reported, not stopped - a long tool call looks the same)'
      )
    }
  }
}

/**
 * Wrap up before the window closes.
 *
 * ⛔ The task goes to `paused_quota`, **not** cancelled: it carries `not_before = resets_at` and
 * resumes itself. Collapsing the two would have the fleet abandon work it was told to pause.
 *
 * ⚠️ Model-aware. Sonnet and Haiku receive injected remaining-budget tags and can self-manage against
 * them; Opus 4.7+ and Fable do not - so for those the instruction must *state* the budget rather than
 * assume the model knows. That is a per-model policy field, not a special case here.
 */
async function preempt(
  task: Task,
  session: Session,
  resumeAt: number,
  because: string
): Promise<void> {
  const info = adapter(session.adapterId).info
  const minutes = Math.max(1, Math.round((resumeAt - Date.now()) / 60000))
  const budgetLine = info.policy.needsExplicitBudget
    ? `You have roughly ${minutes} minute(s) of window left and no more. `
    : ''

  try {
    sendPrompt(
      session.id,
      `${budgetLine}Wrap up now. Commit anything that compiles on this branch, then call the ` +
        'agentyard `handoff` tool with what you were doing, what is done, and the next step. ' +
        'Do not start new work.'
    )
  } catch (err) {
    log.warn(`could not send the wrap-up for t${task.seq}:`, err)
  }

  const run = runsFor(task.id).find((r) => !r.endedAt)
  addMessage(
    task.id,
    'system',
    because === 'runaway'
      ? 'Preempted: this run was well past its estimate.'
      : `Preempted before the quota window closes (${because}). Resuming automatically after the reset.`
  )

  // Give the wrap-up a turn to land, then park the task so it resumes itself.
  setTimeout(() => {
    void (async () => {
      if (run) finishRun(run.id, 'preempted', because)
      db()
        .prepare('update tasks set not_before = ?, updated_at = ? where id = ?')
        .run(because === 'runaway' ? null : resumeAt, Date.now(), task.id)
      setStatus(task.id, because === 'runaway' ? 'awaiting_human' : 'paused_quota')
      closeSession(session.id)
      if (run) await releaseFor(run.id, task.id, task.projectId)
    })()
  }, 120_000)
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

  finishRun(run.id, 'completed', summary)

  // ⛔ A task now waiting on a person keeps its session. A reply into a warm session costs 0.1·C; the
  // same reply into a dead one costs 2.0·C, and human latency routinely straddles the one-hour TTL.
  // The cache clock decides from here whether to keepalive it, compact it, or let it go.
  const settled = getTask(task.id)
  if (settled?.status === 'awaiting_human') {
    log.info(`t${task.seq} is waiting on a person - keeping its session warm for the reply`)
  } else {
    closeSession(sessionId)
  }
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
