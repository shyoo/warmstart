import type { Project, Run, RunQuota, Task, TaskStatus } from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import { lastQuota, refreshUsage } from './quota.js'
import { listWorkers, recordDispatchFailure } from './workers.js'
import { accountUnavailability } from './eligibility.js'
import { getProject, policyFor, reloadProject } from './projects.js'
import {
  admitDependents,
  admitScheduled,
  addMessage,
  finishRun,
  getTask,
  listTasks,
  markDelivered,
  messagesFor,
  runForSession,
  requireRun,
  requireTask,
  runsFor,
  schedulingOrder,
  setHoldReason,
  markFinishAsked,
  setRunQuota,
  setStatus,
  startRun
} from './tasks.js'
import { enqueueConsult, hasPendingConsult, latestAnswer } from './controller.js'
import { decomposeQuestion, routeQuestion, triageQuestion, type RouteCandidate } from './judgment.js'
import { escalateStale, voidApprovalsForSession } from './approvals.js'
import { claim, reassignClaim, releaseAllFor, upsertResource } from './resources.js'
import {
  branchNameFor,
  claimWorkspace,
  parkWorkspace,
  prepareWorkspace,
  releaseWorkspace,
  switchResidentBranch,
  workspaceState,
  type Workspace
} from './worktrees.js'
import {
  backscroll,
  closeAndWait,
  closeSession,
  getSession,
  hasOpenRun,
  noteCurrentBranch,
  resumableSession,
  sendPrompt,
  sessionsForWorker,
  spawnSession
} from './sessions.js'
import { landTask } from './landing.js'
import { decideFinish, resolveFinishPolicy } from './finish.js'
import { stripAnsi } from './stream.js'
import { clearActivity } from './activity.js'
import { log } from './log.js'
import { db } from './db.js'
import { windowResetsAt, lastRateLimit } from './quota.js'
import { reserveState } from './reserve.js'
import { settings } from './settings.js'
import { estimateTask, overrunFactor } from './estimator.js'
import { DEFAULT_OBJECTIVE, policy, resolveObjective, weights } from './objective.js'
import { runCacheClock } from './cacheclock.js'
import { costModel } from './costmodel.js'

/**
 * The scheduler.
 *
 * ⛔ **This loop costs zero tokens, and M4 did not change that.** Dependency resolution, quota gates,
 * resource claims and dispatch are arithmetic. A loop running every ten seconds for weeks must not
 * bill anything, and the fleet has to keep working when the controller's own quota runs out.
 *
 * Where this loop wants judgment it **enqueues a question and carries on**. Answering happens in a
 * different loop, on a different account, at a different rate, and every question has a deterministic
 * fallback that fires on a timer - so the controller being absent, broke or wrong slows the fleet's
 * *judgment* and never its *progress*. See controller.ts.
 */

/** Above this on the 5h window, stop starting new work. Only applied to a reading we trust. */
const QUOTA_HIGH_WATER = 92

/**
 * When two candidates score this close, the arithmetic cannot separate them.
 *
 * ⚠️ A tie is only worth asking about on a task large enough that ε is worth more than the turn the
 * question costs - which is why the floor is deliberately high. Below it the top score wins and
 * nothing is spent. This is the weakest of the four judgment events and it is gated hardest.
 */
const ROUTE_EPSILON = 0.1
const ROUTE_CONSULT_FLOOR_TOKENS = 150_000
/** After this, a routing answer is about a fleet that no longer exists. */
const ROUTE_ANSWER_MAX_AGE_MS = 5 * 60 * 1000

/** A task that has failed this many times is not going to succeed by being retried identically. */
const TRIAGE_AFTER_FAILURES = 2

export const TICK_MS = 10_000

/**
 * Which workspace each live session is sitting in, keyed by **session id**.
 *
 * ⛔ **The session owns the workspace, not the run and not the task.** It was keyed by run before,
 * which meant a worktree was handed back the moment a run ended — and the session holding that
 * task's context stayed alive in a directory it no longer had any claim to. The scheduler's own
 * comment called that out: a task continued by a reply was *"warm in context and homeless on disk"*,
 * and had to re-claim a tree and hope for the same one. Ownership now matches lifetime.
 *
 * ⚠️ In memory on purpose, and safe because `reconcileClaims` releases every claim at startup: a map
 * rebuilt from nothing beside a table cleared to nothing cannot disagree with itself.
 */
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
  let planned = 0

  for (const task of ready) {
    // ⛔ A `plan` task is decomposed, not dispatched. Sending a roadmap to a coding agent produces
    // either a half-built version of all six milestones or a very expensive opinion.
    if (task.kind === 'plan') {
      if (askForPlan(task)) planned++
      else {
        const why = 'decomposition was asked for recently and is on cooldown'
        skipped.push(`t${task.seq}: ${why}`)
        setHoldReason(task.id, why)
      }
      continue
    }

    const choice = chooseTarget(task)
    if (choice.deferred || !choice.worker) {
      skipped.push(`t${task.seq}: ${choice.reason}`)
      // ⛔ Told to the operator, not only to the log. `ready` on its own is unreadable - it is the
      // scheduler's word for "eligible", and a person who has just filed a task reads it as "waiting
      // for me to press something". The reason is already computed; the only change is that it now
      // reaches the row it is about.
      setHoldReason(task.id, choice.reason)
      continue
    }
    // ⛔ A baseline before the spend, not after it. Everything downstream of a run - what it cost
    // against the subscription, whether the reserve was satisfied, whether the estimate was any
    // good - is a *difference*, and a difference taken from one reading is not a measurement. So a
    // worker about to be given work gets its window read first.
    const baseline = needsBaseline(choice.worker)
    if (baseline) {
      skipped.push(`t${task.seq}: ${baseline}`)
      setHoldReason(task.id, baseline)
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
  if (planned) parts.push(`sent ${planned} for decomposition`)
  if (clock.acted) parts.push(`cache clock acted on ${clock.acted}`)
  if (!dispatched && skipped.length) parts.push(`held: ${skipped.slice(0, 3).join('; ')}`)
  if (parts.length === 0) parts.push(ready.length ? 'nothing dispatchable' : 'nothing ready')

  const note = parts.join(' · ')
  // ⛔ **Only when the answer changed.** This loop runs every ten seconds forever; logging each pass
  // would push a day of real events out of a 2000-line buffer inside six hours and make the file
  // useless for the one thing it is for. ⚠️ But the *first* tick that starts holding a task, and the
  // one that stops, are exactly what an operator is looking for — "why is nothing happening?" is
  // answered by a held-reason, and until now that reason existed only on the row it was about.
  if (note !== lastTickNote) {
    log.info(`tick: ${note}`)
    lastTickNote = note
  }

  return { dispatched, note }
}

/** What the last tick concluded, so an unchanged conclusion is not logged again. */
let lastTickNote = ''

// ---------------------------------------------------------------------------- the baseline

/**
 * When was this worker's window last read, and is it worth waiting a tick to read it again?
 *
 * ⛔ The refresh runs **in the background and the tick never waits for it.** `refreshUsage` opens a
 * terminal for the better part of thirty seconds; awaiting that inside the scheduler would put a
 * half-minute stall in a loop that is supposed to be arithmetic. So the task is held for one tick
 * with a reason on its row, and the next tick finds a reading.
 *
 * ⚠️ And it gives up. A worker that cannot answer `/usage` - one whose first-run screens are
 * unanswered swallows the keystroke - would otherwise hold every task assigned to it forever, which
 * is a worse failure than dispatching blind. After one attempt the run goes ahead and is marked
 * `quotaUnverified`, exactly as it was before any of this existed.
 */
const BASELINE_RETRY_MS = 10 * 60 * 1000

const baselineAttempts = new Map<string, { at: number; inFlight: boolean }>()

function needsBaseline(worker: Worker | null): string | null {
  if (!worker) return null
  // Nothing to drive: most CLIs have no usage command, and holding work for a refresh that cannot
  // happen would bench the whole adapter.
  if (!adapter(worker.adapterId).info.usageRefresh) return null

  const quota = lastQuota(worker.id)
  const fresh = quota && !quota.stale && quota.windows.length > 0
  if (fresh) return null

  const attempt = baselineAttempts.get(worker.id)
  if (attempt?.inFlight) {
    return `reading ${worker.label}'s quota first, so this run has a baseline to be measured against`
  }
  if (attempt && Date.now() - attempt.at < BASELINE_RETRY_MS) {
    // Tried recently and still nothing. Dispatch blind rather than never - the run is marked.
    return null
  }

  baselineAttempts.set(worker.id, { at: Date.now(), inFlight: true })
  void refreshUsage(worker.id)
    .catch((err: unknown) => log.warn(`baseline refresh failed for ${worker.label}:`, err))
    .finally(() => baselineAttempts.set(worker.id, { at: Date.now(), inFlight: false }))
  return `reading ${worker.label}'s quota first, so this run has a baseline to be measured against`
}

/** The reading as it is kept beside a run: the numbers, when they were taken, and whether to trust them. */
function runQuota(workerId: string): RunQuota | null {
  const quota = lastQuota(workerId)
  if (!quota || quota.windows.length === 0) return null
  return {
    windows: quota.windows.map((w) => ({ id: w.id, label: w.label, percent: w.percent })),
    sampledAt: quota.sampledAt,
    stale: quota.stale
  }
}

/**
 * Read the window again now that the run is over, and keep it beside the one taken before.
 *
 * ⚠️ Deliberately *after* everything else has been released. This starts a process and takes the
 * better part of a minute, and nothing is waiting on it - the task has already reached its status,
 * the workspace is already back in the pool. If it fails, the run keeps its `before` and no `after`,
 * which renders as "not measured" rather than as a delta of zero.
 */
async function captureQuotaAfter(run: Run): Promise<void> {
  // ⛔ Nothing spent, nothing to measure. A run that produced no metered turn cannot have moved the
  // window, and reading it again would open a terminal for half a minute to confirm a subtraction
  // whose answer is already known - on exactly the workers (dead ones) least able to answer.
  const metered = run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
  if (metered === 0) return

  try {
    await refreshUsage(run.workerId)
  } catch (err) {
    log.warn(`could not read the closing quota for run ${run.id.slice(0, 8)}:`, err)
  }
  setRunQuota(run.id, 'after', runQuota(run.workerId))
}

// ---------------------------------------------------------------------------- gates

interface WorkerChoice {
  worker: Worker | null
  /** A live, idle session already holding this task's context. Reusing it is the cheapest move here. */
  session: Session | null
  reason: string
  quotaUnverified: boolean
  score: number
  /** ⚠️ Not "no worker" - "not yet". A routing question is open and the answer is worth the wait. */
  deferred?: boolean
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
 * Every session this task has ever run on, newest first.
 *
 * ⚠️ Includes the closed and the failed ones, which is the whole point. `warmSessionFor` wants the
 * session that is still up; this wants the conversation that still exists on disk.
 */
function pastSessionsFor(task: Task): Session[] {
  const found: Session[] = []
  for (const run of runsFor(task.id)) {
    if (!run.sessionId) continue
    const session = getSession(run.sessionId)
    if (session && !found.some((s) => s.id === session.id)) found.push(session)
  }
  return found
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
    if (task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId) continue

    // ⛔ Every way an *account* can be unfit to be handed a turn, in one shared list: disabled,
    // human-occupied, no CLI installed, checkably signed out, or held out by a run that produced
    // nothing. These used to be written out here and half-written in the controller, which is how
    // an account this loop had already quarantined stayed eligible for judgment calls. Anything
    // that has to know *what is being asked* stays below, where the task is in scope.
    const unfit = accountUnavailability(worker)
    if (unfit) {
      reasons.push(unfit)
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

    // ⚠️ Work sessions only, matching what spawnSession enforces. `maxConcurrent` bounds *unattended
    // work* - parallel agents editing repositories and spending the window for hours. A consult or a
    // chat is short, holds no workspace, and is bounded separately at one per worker; counting them
    // here would make the fleet undispatchable because somebody asked it a question.
    const busy = sessionsForWorker(worker.id).filter((s) => s.purpose === 'work').length
    if (busy >= worker.maxConcurrent) {
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
      // ⚠️ Every reason, not the first two. This string is now shown on the task row, and "at
      // capacity" for one worker while three others are held out for three different causes is the
      // difference between a fleet that is busy and a fleet that is broken.
      reason: reasons.length ? reasons.join('; ') : 'no eligible worker',
      quotaUnverified,
      score: 0
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0] as WorkerChoice
  const second = candidates[1]

  // ---- the routing judgment event, and every reason not to fire it -------------------------
  //
  // ⛔ Read the conditions rather than the call: this asks for judgment only when the arithmetic has
  // genuinely failed to separate two candidates AND the task is large enough that ε is worth more
  // than the turn. On a one-worker fleet, on a small task, or on any clear win, nothing is spent.
  if (!second || task.kind === 'plan') return best
  const estimate = estimateTask(task).tokens
  const tie = Math.abs(best.score - second.score) <= ROUTE_EPSILON
  if (!tie || estimate < ROUTE_CONSULT_FLOOR_TOKENS) return best

  const answered = latestAnswer('route', task.id, ROUTE_ANSWER_MAX_AGE_MS) as
    | { workerId?: string }
    | null
  if (answered?.workerId) {
    // ⛔ Validated again, here, against the candidate set that exists *now*. The fleet the controller
    // was shown is minutes old; an account can be disabled or hit its window in between.
    const picked = candidates.find((c) => c.worker?.id === answered.workerId)
    if (picked) return picked
  }

  if (hasPendingConsult('route', task.id)) {
    return {
      ...best,
      worker: null,
      deferred: true,
      reason: 'waiting on a routing decision (the top score is used if none arrives)'
    }
  }

  const shortlist: RouteCandidate[] = candidates.slice(0, 4).map((c) => ({
    worker: c.worker as Worker,
    score: c.score,
    warm: !!c.session,
    note: c.quotaUnverified ? 'quota reading not trustworthy' : ''
  }))
  const queued = enqueueConsult({
    kind: 'route',
    subjectId: task.id,
    question: routeQuestion(task, shortlist)
  })
  if (!queued) return best
  return {
    ...best,
    worker: null,
    deferred: true,
    reason: 'asked the controller which worker; the top score is used if no answer arrives'
  }
}

/**
 * Hand a coarse goal to the controller to be broken up.
 *
 * The task leaves the ready pool so it is not re-enqueued every ten seconds, and it comes back as
 * `completed` with draft children, or as `awaiting_human` if no controller could answer. ⛔ Nothing
 * here invents a decomposition: a made-up plan looks exactly like a real one on a board.
 */
function askForPlan(task: Task): boolean {
  const queued = enqueueConsult({
    kind: 'decompose',
    subjectId: task.id,
    question: decomposeQuestion(task)
  })
  if (!queued) return false
  setStatus(task.id, 'assigned', { assignee: 'controller' })
  addMessage(task.id, 'system', 'Queued for decomposition. Its children arrive as drafts.')
  return true
}

/**
 * How risky is spending on this worker, on evidence that was actually checked?
 *
 * ⛔ `unknown` scores **zero**, and that is not the same as scoring it `ok`.
 *
 * It used to score 0.5, which looks cautious and was not. `reserveState` returns `ok` for a worker
 * holding **no live sessions** and `unknown` for one holding any, because `remaining` is null on
 * every Claude account until R2 lands. So the term stopped measuring risk and started measuring
 * *does this worker have a session* — at weight 0.9 that is a 0.45 penalty, two to five times every
 * term that actually discriminates. An idle worker therefore beat a busy one always, no matter what
 * else was true about either. Measured 2026-08-27: a never-signed-in Antigravity account won a
 * dispatch over two working Claude workers on exactly this, then failed in 0s.
 *
 * ⚠️ A term that is identical for the whole fleet contributes nothing and belongs at zero; one that
 * differs *only* because of session count is worse than nothing, because it is a bias wearing a
 * measurement's clothes. Real evidence still counts: `at_risk` is a number that was checked, and a
 * live rate-limit status is the vendor's own word.
 */
export function quotaRiskOf(workerId: string): 0 | 1 {
  const reserve = reserveState(workerId)
  const rate = lastRateLimit(workerId)
  return reserve.verdict === 'at_risk' || (rate && rate.status !== 'allowed') ? 1 : 0
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

  const quotaRisk = quotaRiskOf(worker.id)

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
    w.capabilityFit * fit -
    UNPROVEN_PENALTY * unproven(worker, hasEverWorked(worker.id))
  )
}

/**
 * How much a candidate is preferred for having actually been *seen* to work.
 *
 * ⚠️ Deliberately small and deliberately not a gate. Nothing here says an unproven worker cannot run
 * the task - a signed-in worker that has never finished the CLI's first-run screens runs scheduled
 * work perfectly well, because print mode skips every one of those screens (AGENTS.md). What it says
 * is that when two workers are otherwise indistinguishable, the one somebody has finished setting up
 * is the better bet.
 *
 * ⛔ This is the term that was missing. Every worker on this machine scored identically - the reserve
 * reports `unknown` for all of them until R2 lands, so `quotaRisk` was a constant - and a tie is
 * broken by candidate order, which is `created_at`. So *the first account ever commissioned won every
 * routing decision on the fleet*, and on this machine that account was the one nobody had finished
 * setting up. It looked like a routing bug and it was an absence of any reason to prefer anything.
 */
const UNPROVEN_PENALTY = 0.35

/**
 * Exported for its test: the tie-break is the whole fix, and a silent regression restores the bug.
 *
 * `everWorked` is the strongest of the three inputs and the only one that is *evidence* rather than
 * self-report. An account can answer every identity question perfectly and still be unable to run
 * anything — a keyring credential nobody ever created, an organisation that has disabled the CLI, a
 * lapsed plan — and the one fact that separates those from a working account is whether a turn has
 * ever come out of it. ⚠️ Not a gate: every fleet starts with no proven worker, and a first dispatch
 * has to be allowed to happen or nothing ever becomes proven.
 */
export function unproven(worker: Worker, everWorked: boolean): number {
  let doubt = everWorked ? 0 : 0.5
  const identity = worker.identity
  // Never probed at all: less is known about this account than about one that answered.
  if (!identity) return doubt + 1
  // ⚠️ `=== false`, never falsy, and that applies to **both** of these. `null` is "the adapter
  // cannot tell", which is the normal and permanent answer for a CLI that keeps its credential in
  // the OS keyring, and must not be penalised as though it were a missing step somebody could go
  // and do.
  //
  // ⛔ The second line used to read `loggedIn !== true`, which is the bug this comment was already
  // written to prevent - stated correctly, applied to one line and not the other. Antigravity's
  // `probeIdentity()` returns `loggedIn: null` **by design and permanently**, so every Antigravity
  // worker carried +0.4 doubt for ever, on top of the +0.5 for being unproven. It could not shed
  // either: the only thing that clears `unproven` is a metered turn, and at 0.9 doubt it lost every
  // dispatch to any Claude worker, so it never got one. Measured on this install 2026-08-27:
  // antigravity-cli had **0 turns ever**, against 122 on claude-code.
  //
  // This is the same fault as the reserve one in AGENTS.md, in a different variable: a term that
  // scores *unknown* as though it were *bad* stops measuring risk and starts measuring which
  // provider you are. Only checked evidence may move a score, and `null` is not evidence.
  if (identity.setupComplete === false) doubt += 0.6
  if (identity.loggedIn === false) doubt += 0.4
  return doubt
}

/**
 * Has a single assistant turn ever come out of this account?
 *
 * ⛔ Read from `turns`, which is the exact record and survives a restart, rather than from a run's
 * accumulators. A worker with one metered turn to its name has proved the thing no free probe can
 * establish. Cheap: an indexed existence check, and the scheduler asks it once per candidate per
 * tick.
 */
function hasEverWorked(workerId: string): boolean {
  const found = db()
    .prepare(
      `select 1 from turns t join sessions s on s.id = t.session_id
        where s.worker_id = ? limit 1`
    )
    .get(workerId)
  return found !== undefined
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

  // ⛔ Before the workspace claim, not after the process starts. Everything below this line can take
  // a while - claiming a worktree from the pool, checking out a branch, and running the project's
  // `prepare` hook, which is routinely an `npm install` - and for all of it the task used to sit at
  // `ready` with no assignee, indistinguishable from a task nothing had picked up. The scheduler
  // knows who is taking it and that it has started taking it; saying so costs one row update.
  setStatus(task.id, 'assigned', { assignee: worker.id })

  let workspace: Workspace | null = null
  let branch: string | null = null

  // ⛔ The directory a resumable conversation was in, offered to the pool as a preference.
  // Claude Code files its transcripts under an encoding of the cwd, so `--resume` from a different
  // worktree finds nothing - and it finds nothing *quietly*, starting a fresh conversation and
  // reporting success. Getting the same tree back is what makes resuming possible at all; it is a
  // preference rather than a requirement because a free workspace beats no workspace.
  const past = pastSessionsFor(task)
  const priorCwd = past.find((s) => s.workerId === worker.id)?.cwd

  if (project) {
    // ⚠️ Claimed under the **task's** name, and moved to the session's below. The session's working
    // directory is the workspace, so there is no session to claim on behalf of until there is a
    // workspace to put it in. See `reassignClaim`.
    workspace = await claimWorkspace(project, task.id, priorCwd)
    // ⛔ A pool with nothing free is not necessarily a pool that is busy. Now that a session keeps
    // its workspace for as long as it lives, an idle conversation can sit on a worktree with no run
    // against it — and the cache clock's `let_expire` move leaves such a session alone indefinitely.
    // Without this, one parked task would cost a slot until somebody restarted the daemon.
    if (!workspace) {
      if (await evictResident(project)) workspace = await claimWorkspace(project, task.id, priorCwd)
    }
    if (!workspace) throw new Error(`no free workspace in ${project.name}`)

    branch = project.vcs === 'git' ? branchNameFor(task.seq, task.title) : null
    const prepared = await prepareWorkspace(project, workspace, branch)
    if (!prepared.ok) {
      releaseWorkspace(workspace.claimId)
      throw new Error(prepared.error ?? 'workspace preparation failed')
    }
  }

  // ⛔ Before the process starts, and only for adapters whose approvals are settled by configuration
  // rather than by a callback. There is nobody to ask mid-run on those, so whatever is not allowed
  // now is refused later with no way to escalate - which is the real cost of `settings_rules` and the
  // reason §9.1 says such adapters need a *narrower* allowlist and a higher expected refusal rate.
  applyPermissionRules(worker, project)

  const cwd = workspace?.path ?? process.cwd()
  // ⛔ `stream`, not `pty`, for scheduled work. Two measured reasons, both in sendPrompt: the CLI's
  // workspace-trust dialog is skipped only in non-interactive mode, and would otherwise block every
  // dispatch into a fresh worktree with nobody there to answer; and `--permission-prompt-tool` -
  // the entire structured approval channel - exists only in non-interactive mode.
  // ⛔ The effort is dropped, not forwarded, when the adapter says it cannot take one. A level
  // passed to a CLI with no flag for it is either an argument error charged to somebody's window or
  // — worse, because it is quiet — a task that records a setting nothing ever applied. The form
  // will not have offered the choice for such a worker; this is the guard for every other caller.
  const canSetEffort = adapter(worker.adapterId).info.capabilities.selectableEffort
  // ⭐ The conversation this task was already having, if it is still on disk and this is the same
  // account and the same tree. Resuming costs the read of a cache that is very likely cold by now;
  // *not* resuming costs rebuilding the whole prefix and re-discovering the branch, the files and
  // everything the last run worked out - and it produced an agent that answers a follow-up question
  // having never seen the question it follows.
  const revive = resumableSession(past, worker.id, cwd)
  const session = spawnSession({
    workerId: worker.id,
    cwd,
    transport: 'stream',
    projectId: project?.id ?? null,
    ...(revive ? { resume: revive } : {}),
    ...(task.constraints.model ? { model: task.constraints.model } : {}),
    ...(task.constraints.effort && canSetEffort ? { effort: task.constraints.effort } : {})
  })

  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: project?.id ?? null,
    quotaUnverified,
    costModelId: adapter(worker.adapterId).info.policy.costModelId,
    // ⚠️ Resuming counts as warm. It skips the cold prefix exactly as continuing does - measured
    // 2026-08-28, cache_read 41,542 against a cold turn's 0 - and the estimator must not average
    // the two kinds of run together.
    startedWarm: revive !== null
  })
  setRunQuota(run.id, 'before', runQuota(worker.id))
  // A new attempt, so the peephole starts empty. ⛔ Cleared here and never on completion: what the
  // last run said is exactly what somebody wants to read in the seconds after it fails.
  clearActivity(task.id)

  // ⛔ The claim moves to the session here, and this is the whole of phase 1. It was taken under the
  // task's name a moment ago because the session could not exist until its directory did; from now
  // on the tree is released when the *conversation* ends, not when a run does.
  if (workspace) {
    reassignClaim(workspace.claimId, session.id)
    workspaces.set(session.id, { workspace, projectId: project?.id ?? null })
  }
  // ⚠️ `prepareWorkspace` has already put the tree on this branch, so this records what is true
  // rather than asking for anything. It is what the *next* borrower reads to know what to restore.
  noteCurrentBranch(session.id, branch)
  // ⛔ The lease, even on a cold start. This session is brand new or freshly revived and nothing else
  // can be in it — but a claim taken only on some paths is a claim nobody can reason about, and it is
  // `releaseFor` that hands it back either way.
  acquireSessionLease(session.id, task.id)

  // ⚠️ A revived conversation remembers a tree that has since moved. `prepareWorkspace` switched the
  // worktree while the agent was not running, so nothing warned it — and its context is full of file
  // contents from the branch it was last on.
  const movedSince = revive && revive.currentBranch && branch && revive.currentBranch !== branch
  const branchNotice = movedSince
    ? `⚠️ This workspace has moved since your last turn: it was on \`${revive.currentBranch}\` and ` +
      `is now on \`${branch}\`. Any file you read earlier came from the other branch — re-read ` +
      'anything you are going to rely on rather than trusting what is in this conversation.'
    : null

  setStatus(task.id, 'running', {
    assignee: worker.id,
    ...(branch ? { branch } : {})
  })
  addMessage(
    task.id,
    'system',
    `${revive ? 'Resumed the earlier conversation' : 'Started'} on ${worker.label}` +
      `${branch ? ` in ${workspace?.path} on \`${branch}\`` : ''}` +
      (quotaUnverified ? ' — quota reading was not trustworthy, so this run is marked unverified.' : '')
  )

  // The CLI needs a moment before it starts reading stdin; a message sent too early is dropped.
  setTimeout(() => {
    try {
      sendPrompt(
        session.id,
        [branchNotice, promptFor(task, worker.adapterId, revive !== null)].filter(Boolean).join('\n\n')
      )
    } catch (err) {
      log.warn(`could not send the prompt for t${task.seq}:`, err)
    }
  }, 2500)

  // ⚠️ The *reason* travels with it. "dispatched t5 to ClaudeSecond" says what happened; it does not
  // say why that account rather than the other three, which is the question asked afterwards — and
  // the score and its basis exist right here and were being thrown away.
  log.info(
    `dispatched t${task.seq} to ${worker.label} (run ${run.id.slice(0, 8)}, ` +
      `score ${choice.score.toFixed(2)}: ${choice.reason})` +
      (revive ? `, resuming conversation ${(revive.vendorSessionId ?? revive.id).slice(0, 8)}` : '') +
      (quotaUnverified ? ' — on an unverified quota reading' : '')
  )
}

/**
 * Push the project's allowlist into the worker's own configuration.
 *
 * ⚠️ Silent when the adapter has a permission callback: Claude Code answers through
 * `--permission-prompt-tool`, so writing rules into its settings would duplicate a mechanism that
 * already works and is per-session rather than global.
 */
function applyPermissionRules(worker: Worker, project: ReturnType<typeof getProject>): void {
  const ad = adapter(worker.adapterId)
  if (ad.info.capabilities.approvalChannel !== 'settings_rules' || !ad.writePermissions) return

  const policy = project ? policyFor(project) : null
  const written = ad.writePermissions(worker.isolationRoot, {
    allow: policy?.allowRules ?? [],
    deny: policy?.denyRules ?? []
  })
  if (written.error) {
    log.warn(`could not write permission rules for ${worker.label}: ${written.error}`)
  } else if (written.path) {
    log.info(
      `wrote ${(policy?.allowRules ?? []).length} allow / ${(policy?.denyRules ?? []).length} deny ` +
        `rule(s) for ${worker.label} into ${written.path}`
    )
  }
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
  // ⚠️ The saving is a *claim about this provider's pricing*. Where the cache cannot be priced there
  // is no saving to claim - reusing the session is still right, because the context is already there,
  // but agentyard will not put a number on it that nobody measured.
  const cold = model.costOfColdStart(session.contextTokens ?? 0)
  const warm = model.costOfKeepalive(session)
  const saved = cold !== null && warm !== null ? Math.round(cold - warm) : null

  // ⭐ **A warm session already holds its workspace**, and this is what phase 1 bought. This block
  // used to re-claim one, because the claim died with the run: a task continued by a reply was warm
  // in context and homeless on disk, and had to ask the pool for a tree and hope it got the same one
  // back. The claim now lives as long as the conversation does, so there is nothing to re-take.
  //
  // ⚠️ The fallback stays for the case the map cannot answer for: a session that outlived the claim
  // — a daemon restart clears every claim while the process keeps running — is warm in context with
  // no tree, and re-claiming its own directory is exactly right there.
  const project = task.projectId ? getProject(task.projectId) : null
  let reclaimed: Workspace | null = null
  if (project && !workspaces.has(session.id)) {
    reclaimed = await claimWorkspace(project, task.id, session.cwd)
    if (!reclaimed && (await evictResident(project))) {
      reclaimed = await claimWorkspace(project, task.id, session.cwd)
    }
    if (!reclaimed) throw new Error(`no free workspace in ${project.name} to continue t${task.seq}`)
    reassignClaim(reclaimed.claimId, session.id)
  }

  // ⛔ Before anything is sent into it. Two tasks in one conversation would interleave their turns,
  // bill each other's tokens and race to answer one `task_complete`; the lease makes that
  // unrepresentable rather than merely discouraged. Refusing here is safe — the task stays `ready`
  // and the next tick will find it a session, warm or otherwise.
  if (!acquireSessionLease(session.id, task.id)) {
    throw new Error(
      `the conversation ${session.id.slice(0, 8)} is already in use by another task; t${task.seq} waits`
    )
  }

  // ⚠️ Put the tree on this task's branch, and say so — to the task that was here, to the agent, and
  // in the log. A no-op today, because nothing yet routes a *second* task into a live session; it is
  // built now so that the switch is already proven when phase 3 turns sharing on.
  let notice: string | null = null
  if (project && project.vcs === 'git' && task.branch) {
    const path = workspaces.get(session.id)?.workspace.path ?? session.cwd
    const moved = await switchBorrowedTree(project, session, path, task, task.branch)
    if (!moved.ok) {
      // ⛔ Give the lease back. A task that cannot use the conversation must not hold it shut, and
      // this is the one path between acquiring it and `releaseFor` that does not open a run.
      releaseAllFor(task.id)
      throw new Error(moved.error ?? `could not put ${path} on ${task.branch} for t${task.seq}`)
    }
    notice = moved.notice
  }

  applyPermissionRules(worker, project)

  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: task.projectId,
    quotaUnverified,
    costModelId: adapter(worker.adapterId).info.policy.costModelId,
    // The session never closed, which is the warmest a run gets.
    startedWarm: true
  })
  setRunQuota(run.id, 'before', runQuota(worker.id))
  clearActivity(task.id)
  if (reclaimed) workspaces.set(session.id, { workspace: reclaimed, projectId: project?.id ?? null })

  setStatus(task.id, 'running', { assignee: worker.id })
  addMessage(
    task.id,
    'system',
    `Continued in the session that still holds this task's context` +
      (saved !== null && saved > 0
        ? ` — about ${saved} input-token-equivalents cheaper than a cold start.`
        : saved === null
          ? ' — cheaper than a cold start, though this provider’s cache is not priced, so by how much is unknown.'
          : '.')
  )
  // ⚠️ The branch notice goes **first**, before the task's own words. An agent that reads the work
  // before it reads "the files you remember are from another branch" has already started planning
  // against a tree that is not there.
  sendPrompt(
    session.id,
    // ⛔ `resumed: true` — this session never closed, so it holds the brief already. Restating it
    // here would read as being asked to do the work a second time.
    [notice, promptFor(task, worker.adapterId, true)].filter(Boolean).join('\n\n')
  )
  log.info(
    `t${task.seq} continued warm on ${worker.label} (run ${run.id.slice(0, 8)}, ` +
      `saved ${saved === null ? 'unknown' : `~${saved}`})`
  )
}

// ---------------------------------------------------------------------------- watchdogs

/** No turn for this long while a run is open is a stall worth surfacing. */
const STALL_AFTER_MS = 12 * 60 * 1000
/** Past this multiple of its estimate, a run is not working - it is spending. */
const RUNAWAY_FACTOR = 3

/** How long the agent gets to land a wrap-up before the task is parked out from under it. */
const WRAP_UP_GRACE_MS = 120_000

/**
 * Runs that have already been told to wrap up.
 *
 * ⛔ **Preemption is not instantaneous, and the watchdog that fires it cannot tell.** `preempt` sends
 * a wrap-up prompt and then waits two minutes for it to land - during which the run is still open and
 * the task is still `running`, which is precisely the state `runWatchdogs` scans for. Without this
 * set the same run is preempted again on every 10s tick.
 *
 * ⛔ Measured on t5, 2026-08-28: **13** identical *"about 3.1× the estimate"* notices between
 * 02:42:52 and 02:44:42, and with them 13 copies of *"Wrap up now. Commit anything that compiles"*
 * pushed into a session that had already committed (`ea05929`) and already called `handoff`. The
 * agent spent the whole window answering "already done" - and the loop fed itself, because every one
 * of those turns was more spend, so the factor it was being preempted over climbed 3.1 → 3.9 while
 * nobody was doing any work. A person watching the task sees a commit loop; the loop is here.
 */
const preempting = new Set<string>()

/**
 * ⛔ Runs before dispatch on every tick, and costs nothing: every input is already in the database.
 *
 * The three failures worth acting on are all *cost* failures - a window about to close on live work,
 * a run past its estimate, and a reserve breach - which is why they are here rather than in a health
 * check somebody reads later.
 */
async function runWatchdogs(): Promise<void> {
  // ⚠️ Read once per tick, not once per task: a switch thrown mid-loop would otherwise stop one run
  // and not the next, and the operator would have no way to tell which.
  const switches = settings()

  for (const task of listTasks()) {
    if (task.status !== 'running') continue
    const run = runsFor(task.id).find((r) => !r.endedAt)
    if (!run?.sessionId) continue
    // ⛔ Already wrapping up. Every check below is still true of this run and will stay true until it
    // ends, so without this the watchdogs re-fire on it every tick for the whole grace period.
    if (preempting.has(run.id)) continue
    const session = getSession(run.sessionId)
    if (!session) continue

    // 1. The window boundary. This is the case the whole tool was built for.
    const reset = windowResetsAt(run.workerId)
    const margin = policy(DEFAULT_OBJECTIVE).preemptMarginMs
    if (switches.autoPreempt && reset && reset.at - Date.now() <= margin && task.preemptible) {
      await preempt(task, session, reset.at, reset.source)
      continue
    }

    // 2. A runaway. Nothing to compare against means it cannot be one - being first is not a crime.
    // ⛔ Opted into, and off by default. See `autoRunawayStop` in settings.ts for why this trigger is
    // held to a higher bar than the one above it.
    const factor = switches.autoRunawayStop ? overrunFactor(run.id) : null
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
  const run = runsFor(task.id).find((r) => !r.endedAt)
  // ⛔ Claimed before anything is sent, and never re-entered. A second wrap-up prompt is not a
  // harmless duplicate: it is a turn the agent has to pay for in order to say it already finished.
  if (run) {
    if (preempting.has(run.id)) return
    preempting.add(run.id)
  }

  const info = adapter(session.adapterId).info
  const minutes = Math.max(1, Math.round((resumeAt - Date.now()) / 60000))
  const budgetLine = info.policy.needsExplicitBudget
    ? `You have roughly ${minutes} minute(s) of window left and no more. `
    : ''

  try {
    sendPrompt(
      session.id,
      `${budgetLine}Wrap up now. Commit anything that compiles on this branch, then call the ` +
        '`handoff` tool with what you were doing, what is done, and the next step. ' +
        'Do not start new work.'
    )
  } catch (err) {
    log.warn(`could not send the wrap-up for t${task.seq}:`, err)
  }

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
      try {
        // ⚠️ Two minutes is a long time in a fleet. The run may have ended on its own - the agent
        // took the instruction, committed, and called `task_complete` - and parking a task that has
        // since moved on would close a session somebody else's run is now holding.
        const current = run ? runsFor(task.id).find((r) => r.id === run.id) : null
        if (run && (!current || current.endedAt)) return
        if (run) finishRun(run.id, 'preempted', because)
        db()
          .prepare('update tasks set not_before = ?, updated_at = ? where id = ?')
          .run(because === 'runaway' ? null : resumeAt, Date.now(), task.id)
        setStatus(task.id, because === 'runaway' ? 'awaiting_human' : 'paused_quota')
        closeSession(session.id)
        if (run) await releaseFor(run.id, task.id, task.projectId)
      } finally {
        if (run) preempting.delete(run.id)
      }
    })()
  }, WRAP_UP_GRACE_MS)
}

/**
 * What the agent is actually told.
 *
 * The handoff from a previous run is prepended, because a successor that has to rediscover the state
 * of the branch pays for it twice - once in tokens and once in the mistakes it makes meanwhile.
 */
function promptFor(task: Task, adapterId: string, resumed = false): string {
  const parts: string[] = []
  if (task.handoffNote) {
    parts.push(
      ['Continuing earlier work. Handoff from the previous session:', task.handoffNote, ''].join('\n')
    )
  }
  parts.push(task.title)

  // ⚠️ The first human message is the task's own prompt and is restated: a fresh session after a
  // preemption has no idea what it was asked to do. Everything after it is a *note*, and a note
  // typed into a live session was already answered there - repeating it would charge for it twice and
  // leave the agent unsure what is still outstanding.
  //
  // ⛔ Except into a resumed conversation, which is the one case where the reason above does not
  // hold: that session has the original prompt in its own history and everything it did about it.
  // Restating it there reads as being asked to do the work a second time, which is the failure the
  // delivery bookkeeping exists to prevent - it would just be arriving through the one message the
  // bookkeeping deliberately exempts.
  const thread = messagesFor(task.id).filter((m) => m.role === 'human')
  const outstanding = thread.filter((m, i) => (i === 0 && !resumed) || m.deliveredAt === null)
  for (const message of outstanding) parts.push(message.text)
  markDelivered(outstanding.map((m) => m.id))

  // ⛔ Only name tools this adapter actually gets. `mcp: false` means the daemon spawns it with no
  // MCP server at all - true for Antigravity, whose `agy mcp add` registers globally and so cannot
  // carry the per-session identity the tools need, and true for every declarative adapter.
  //
  // ⚠️ Telling an agent to call a tool it does not have is not a harmless surplus sentence. It is
  // the last instruction in the prompt, so it is what the agent tries to do when it believes it has
  // finished: it hunts for `task_complete`, cannot find it, and burns turns deciding what to do
  // instead - the same trap as `claude -p /usage`, from the other side. And it can never succeed,
  // because `task_complete` is the *only* signal that an agent finished, so every run on such an
  // adapter ends in `awaiting_human` no matter how well the work went.
  //
  // ⚠️ `awaiting_human` remains the honest answer here, and this does not change that: without the
  // tool there is genuinely no signal, and inventing one from a clean exit would be the guess this
  // project refuses to make. What changes is that the operator is told *why* the hand-off is
  // structural rather than being left to read it as the agent having failed.
  if (adapter(adapterId).info.capabilities.mcp) {
    parts.push(
      'When the work is finished, call the MCP tool `task_complete` with a one-line summary. ' +
        'If you need a decision from a person, call `request_human` rather than guessing.'
    )
  } else {
    parts.push(
      'When the work is finished, commit what you have and end with a one-line summary of what ' +
        'changed. If you need a decision from a person, say so plainly and stop rather than guessing.'
    )
  }
  return parts.join('\n\n')
}

/**
 * Say something to a task that is already running.
 *
 * ⛔ This is the cheap half of §18.4: a note into a live session is a cache read - `0.1·C`, and it
 * refreshes the TTL - while the same note delivered by restarting the task is `2.0·C` plus everything
 * the successor has to rediscover. Returns false when there is nothing live, in which case the note
 * waits and is prepended to the next run's prompt instead.
 */
export function deliverToLiveSession(taskId: string, messageId: number, text: string): boolean {
  const session = sessionOf(taskId)
  if (!session || (session.state !== 'live' && session.state !== 'idle')) return false
  try {
    sendPrompt(session.id, text)
    markDelivered([messageId])
    return true
  } catch (err) {
    log.warn(`could not deliver a note into t${taskId.slice(0, 8)}'s session:`, err)
    return false
  }
}

/**
 * A person judges a task finished.
 *
 * ⛔ **`awaiting_human` is the one status that is explicitly about the operator, and it was the only
 * one they could not act on.** Every other resting state has a button — Resume, Queue, Cancel,
 * Delete — while the state that means *a decision is wanted from you* offered nowhere to record the
 * decision. So a task whose work was done but had not landed automatically sat there indefinitely,
 * next to a run marked `completed`, and the only ways out were to cancel work that had succeeded or
 * to delete the record of it.
 *
 * ⚠️ This is a **judgment**, not a claim that the machine verified anything, and it is written down
 * as such. `task_complete` remains the only signal that an *agent* finished; this is the separate
 * and equally legitimate signal that a *person* is satisfied.
 *
 * ⛔ Dependents are admitted, exactly as they are on an agent completion. Forgetting that would leave
 * every blocked child of a hand-resolved task waiting on a parent that will never move again.
 */
export function resolveTask(taskId: string, note?: string): Task {
  const task = requireTask(taskId)
  if (task.status === 'completed') return task

  addMessage(
    task.id,
    'system',
    note?.trim()
      ? `Marked done by you: ${note.trim()}`
      : 'Marked done by you. ⚠️ Nothing here verified the work — this records your judgement, not a check.'
  )
  // ⛔ The assignee goes back to the account that did the work, not to the person who signed off.
  // It used to be set to `human` here, which put **you** in the Worker column of a task ClaudeSecond
  // had run — and that column exists so which account is spending is visible without a click.
  // Answering a question is not doing the work; being handed a decision is a temporary assignment,
  // and a *finished* task assigned to a person says nothing anybody can use.
  //
  // ⚠️ Null when nothing ever ran, which is a real case — a task resolved before it was ever
  // dispatched genuinely has no account, and `—` says that. Who answered is in the thread above.
  setStatus(task.id, 'completed', { assignee: task.ranOn ?? null })

  // The session was being kept warm for a reply that is now not coming. Holding it any longer costs
  // this worker its only work slot for a conversation that is over.
  const session = sessionOf(task.id)
  if (session) closeSession(session.id)

  admitDependents(task.id)
  return requireTask(task.id)
}

/**
 * States a human reply can wake work back up from.
 *
 * ⛔ Not `draft` — a draft is deliberately un-queued and promoting it on a comment would dispatch
 * something somebody was still writing. Not `cancelling` — that run is winding down and would be
 * asked to do two contradictory things at once. Everything else here is a task that has come to
 * rest and can sensibly be asked to do one more thing.
 */
const CONTINUABLE_FROM: TaskStatus[] = [
  'completed',
  'awaiting_human',
  'failed',
  'paused_user',
  'paused_quota',
  'cancelled'
]

/**
 * A person said something to a task that had stopped. Start the work again.
 *
 * ⛔ **The message was already being delivered; what was missing was a run.** `deliverToLiveSession`
 * pushed the text straight into the still-warm session and returned true, so from the daemon's point
 * of view it had done its job — and from the operator's, nothing whatsoever happened. There was no
 * run, so nothing was metered, no status moved, no activity appeared, and no landing was attempted
 * when the agent finished. *"Please commit to the main branch"* went into a live process and fell out
 * of the world. Measured 2026-08-27.
 *
 * So a reply to a resting task **re-queues it**, and the scheduler treats the continuation exactly as
 * it treats any other dispatch: gates, quota baseline, metering, landing. It is the same task and the
 * same thread — a new **run**, not a new task — which is what makes the default routing right by
 * construction: `warmSessionFor` prefers the session that already holds this task's context, so the
 * same worker, the same workspace and the same session are chosen because they *score* highest, not
 * because anything here says so.
 *
 * ⚠️ A `running` task is left alone. Its run is already open and the note belongs in it; re-queueing
 * would start a second run against a session mid-turn.
 *
 * Returns what happened, so the caller can tell the person which of the two it was.
 */
export function continueTask(taskId: string): 'delivered' | 'requeued' | 'queued' | 'ignored' {
  const task = getTask(taskId)
  if (!task) return 'ignored'
  if (task.status === 'running' || task.status === 'assigned') return 'delivered'
  if (!CONTINUABLE_FROM.includes(task.status)) return 'queued'

  addMessage(
    task.id,
    'system',
    'Continuing this task with what you just said — same thread, a new run. It goes back to the ' +
      'session that still holds its context where there is one, and starts a fresh one where there ' +
      'is not.'
  )
  // ⛔ `not_before` is cleared. A task parked by preemption carries a resume time, and a person
  // asking for something now should not be told to come back after the window resets.
  db().prepare('update tasks set not_before = null where id = ?').run(task.id)
  setStatus(task.id, 'ready', { assignee: null })
  return 'requeued'
}

// ---------------------------------------------------------------------------- completion

/**
 * Called when an agent reports it is done. ⛔ This is the *only* signal that a task succeeded -
 * a process exiting cleanly says nothing about whether the work was done, and reading the terminal
 * to guess is exactly what this design refuses to do.
 */
export async function completeTask(sessionId: string, summary: string): Promise<void> {
  const run = runForSession(sessionId)
  if (!run?.taskId || run.outcome) return
  const task = getTask(run.taskId)
  if (!task) return

  addMessage(task.id, 'agent', summary, run.id)

  // ⚠️ Keyed by the session, which is what holds the workspace. Keyed by the run this read `MISSING`
  // for every completion the moment ownership moved, and the finish path is gated on it — a missing
  // workspace means no landing, no loose-end scan, and no ask to commit.
  const held = workspaces.get(sessionId)
  const project = task.projectId ? getProject(task.projectId) : null
  log.info(
    `t${task.seq} reported complete: run=${run.id.slice(0, 8)} workspace=${held ? 'held' : 'MISSING'} ` +
      `branch=${task.branch ?? 'none'} project=${project?.name ?? 'none'}/${project?.vcs ?? '-'}`
  )

  if (project && held && task.branch && project.vcs === 'git') {
    // ⛔ One decision function, asked once, with the workspace read once. Everything below acts on
    // what it returns; nothing below decides anything for itself. See finish.ts for why the tool
    // never authors a commit here.
    const policy = policyFor(project)
    const state = await workspaceState(held.workspace.path, policy.landingTarget)
    const decision = decideFinish({ task, project, state, hasChecks: policy.check.length > 0 })
    log.info(`t${task.seq} finish: ${decision.kind} (${resolveFinishPolicy(task, project).policy})`)

    if (decision.kind === 'ask-agent') {
      // ⛔ Returns without ending the run. The agent is still working — it has been handed one more
      // instruction and will report completion again — so closing the run here would orphan a live
      // session and release a workspace out from under it.
      markFinishAsked(task.id)
      addMessage(task.id, 'system', `Not finished yet: ${decision.reason}. Asked the agent to fix it.`)
      try {
        sendPrompt(sessionId, decision.instruction)
      } catch (err) {
        log.warn(`could not send the finish instruction for t${task.seq}:`, err)
        addMessage(task.id, 'system', 'Could not reach the session to ask. Over to you.')
        setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
      }
      return
    }

    if (decision.kind === 'land') {
      const result = await landTask({
        project,
        task,
        workspacePath: held.workspace.path,
        branch: task.branch
      })
      if (result.ok) setStatus(task.id, 'completed')
    } else if (decision.kind === 'await-human') {
      addMessage(task.id, 'system', `Finished, and not landed: ${decision.reason}`)
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
    } else {
      addMessage(task.id, 'system', `Finished — ${decision.reason}`)
      setStatus(task.id, 'completed')
    }
  } else if (task.verification === 'required') {
    addMessage(task.id, 'system', 'Finished, and this task asked for human verification.')
    setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: 'the work is finished and you asked to check it before it lands'
    })
  } else {
    setStatus(task.id, 'completed')
  }

  finishRun(run.id, 'completed', summary)
  // ⛔ After the run is closed, so the reading covers the whole of it. Backgrounded because it opens
  // a terminal for the better part of a minute and nothing is waiting on the answer.
  void captureQuotaAfter(requireRun(run.id))

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
  admitDependents(task.id)
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
  if (run) {
    await endFailedRun(
      session,
      run,
      `The session ended (exit ${exitCode}) without reporting completion. ` +
        'Nothing here can tell whether the work was finished, so it is over to you.'
    )
  }
  // ⛔ Run or no run, and after the run either way. This is the moment the workspace goes back,
  // because the workspace belongs to the **conversation** and the conversation has just ended.
  // ⚠️ The early return this replaced (`if (!run) return`) is exactly the path a session that
  // finished its task and was then closed takes — the common case, and the one that would have
  // leaked every worktree the fleet ever used.
  await releaseWorkspaceOf(session.id)
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
 * has still done work and still metered turns. `endFailedRun` decides which of the two this is from
 * the metering, not from the wording.
 */
export async function onStreamResult(
  session: Session,
  result: { isError: boolean; text: string | null; terminalReason: string | null }
): Promise<void> {
  if (!result.isError) {
    if (session.adapterId && !adapter(session.adapterId).info.capabilities.mcp) {
      await completeTask(session.id, result.text ?? 'Completed')
    }
    return
  }
  const run = runForSession(session.id)
  if (!run) return

  const said = stripAnsi(result.text ?? '').replace(/\s+/g, ' ').trim()
  const why =
    `The agent reported a failure${result.terminalReason ? ` (${result.terminalReason})` : ''}` +
    (said ? `: ${said.slice(0, 400)}` : ' and said nothing about it.')

  await endFailedRun(session, run, why)
  // ⛔ Closed here, and this is not tidiness. The process does not exit on an `api_error`; leaving it
  // would hold this worker's only work slot against a session that can never make progress.
  closeSession(session.id)
}

/**
 * One place where a run that did not report completion is wound up.
 *
 * ⛔ Both callers ask the same question first, and it is not "did this fail" — it is **who failed**.
 * A run that never produced a metered turn did not fail at the work; it failed at the account, and
 * charging it to the task sends somebody to debug a prompt that was never delivered to anything.
 */
async function endFailedRun(session: Session, run: Run, why: string): Promise<void> {
  const task = run.taskId ? getTask(run.taskId) : null
  finishRun(run.id, 'failed', why)

  const dead = deadOnArrival(session, run)

  if (task && (task.status === 'running' || task.status === 'assigned')) {
    if (dead) {
      // ⚠️ The vendor's own words, where the stream gave any. `why` is a sentence a person can act
      // on — "your organization has disabled…" — while `deadOnArrival` can only report silence.
      const reason = session.lastRequestStartedAt === null && why.length > dead.length ? why : dead
      recordDispatchFailure(run.workerId, reason, run.id)
      addMessage(
        task.id,
        'system',
        `Nothing ran on this worker. ${reason} That account is held out of dispatch until it is ` +
          'probed again; this task goes back in the queue for another one.'
      )
      // ⚠️ Back to `ready`, not to a person. The gate added by `recordDispatchFailure` means the next
      // tick cannot choose the same account, so this re-routes rather than loops - and when there is
      // no other eligible worker the task holds at `ready` with the reason on its row, which is the
      // true statement. ⛔ It is not marked `failed`: nothing about the work has been attempted.
      setStatus(task.id, 'ready', { assignee: null })
    } else {
      addMessage(task.id, 'system', why)
      // ⛔ The deterministic outcome happens first and unconditionally, so the task is already in a
      // safe and visible state whether or not a controller ever answers.
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
      maybeTriage(task.id)
    }
  }

  await releaseFor(run.id, task?.id ?? null, task?.projectId ?? null)
  void captureQuotaAfter(requireRun(run.id))
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

/**
 * Ask why a task keeps failing - once it has failed often enough to be a pattern rather than a
 * mishap. One failure is a bad day; two is usually a bad instruction, which is something judgment can
 * fix and arithmetic cannot.
 */
function maybeTriage(taskId: string): void {
  const task = getTask(taskId)
  if (!task) return
  const failures = runsFor(taskId).filter((r) => r.outcome === 'failed').length
  if (failures < TRIAGE_AFTER_FAILURES) return
  try {
    enqueueConsult({ kind: 'triage', subjectId: taskId, question: triageQuestion(task) })
  } catch (err) {
    // ⛔ A failed enqueue must never turn one failed task into a failed daemon.
    log.warn(`could not queue triage for t${task.seq}:`, err)
  }
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
  _projectId: string | null
): Promise<void> {
  // ⛔ **The workspace is deliberately not released here any more.** It belongs to the session, and
  // the session may well outlive this run — a task resting at `awaiting_human` keeps its session
  // warm for the reply, and taking its worktree away in the meantime is what used to leave it warm
  // in context and homeless on disk. `releaseWorkspaceOf` runs when the conversation ends.
  //
  // ⚠️ Everything a *run* took is still released here, and unconditionally. One leaked exclusive
  // claim stalls a project forever, and the symptom — nothing dispatches, nothing errors — is the
  // worst kind of bug to find later.
  releaseAllFor(runId)
  if (taskId) releaseAllFor(taskId)
}

/**
 * Park and hand back the workspace a conversation was living in.
 *
 * ⛔ Idempotent, and it has to be: it is reached from a session exiting, from eviction, and from the
 * shutdown sweep, and two of those can happen within a millisecond of each other.
 *
 * ⚠️ Parking runs `rescueDirt`, which stashes anything the agent left behind rather than resetting
 * over it — so this must not run until the process is actually gone. Every caller waits for the exit
 * rather than for `closeSession` to return; see `closeAndWait`.
 */
async function releaseWorkspaceOf(sessionId: string): Promise<void> {
  const held = workspaces.get(sessionId)
  if (!held) return
  workspaces.delete(sessionId)
  const project = held.projectId ? getProject(held.projectId) : null
  if (project) await parkWorkspace(project, held.workspace.path)
  releaseWorkspace(held.workspace.claimId)
  releaseAllFor(sessionId)
}

// ------------------------------------------------------------------- borrowing a conversation

/** The exclusive resource one task holds while it is the one talking in a conversation. */
export function sessionLeaseId(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * Take the right to be the task speaking in this conversation, or fail.
 *
 * ⛔ **An exclusive Resource rather than a check.** The glossary states the rule this follows — *if
 * the scheduler owns the claim, the lock is unnecessary* — and it buys the same thing here it buys
 * for workspaces: two tasks cannot be handed one conversation, because the second claim simply is not
 * granted. A boolean field guarded by an `if` would be a lock with extra steps and a race between the
 * read and the write.
 *
 * ⚠️ Held by the **task**, so `releaseAllFor(task.id)` in `releaseFor` returns it at the end of every
 * run, on every exit path, without a second thing to remember. A task parked at `awaiting_human`
 * therefore does *not* keep the lease: its conversation may be borrowed while it waits, which is the
 * whole point, and it takes the lease again when it is replied to.
 */
function acquireSessionLease(sessionId: string, taskId: string): boolean {
  const id = sessionLeaseId(sessionId)
  upsertResource({
    id,
    projectId: null,
    kind: 'exclusive',
    label: `conversation ${sessionId.slice(0, 8)}`,
    members: [],
    meta: { sessionId }
  })
  return claim(id, taskId, 1) !== null
}

/**
 * Put the borrowed conversation's worktree on this task's branch, and tell everyone who is affected.
 *
 * Three readers, three different things they need to know, and the switch is not safe to make quietly
 * for any of them:
 *
 *  - **The task that was here** gets a note in its thread, because from its side the tree it was
 *    working in has silently moved and a person reading it later would have no way to know.
 *  - **The agent**, in its prompt, because its conversation holds file contents read from the *other*
 *    branch. Nothing about the context says they are stale. This is the hazard the owner accepted
 *    when choosing switch-and-tell over one long-lived branch, and the warning is the mitigation.
 *  - **The operator**, in the log, because a worktree changing branches between two tasks is the
 *    single most confusing thing this feature does when read from the outside.
 *
 * ⚠️ **Restoring is this same call in the other direction.** When the borrowed task runs again its
 * branch is the one that differs, so the tree moves back and the borrower's task gets the note. There
 * is deliberately no separate restore path: two functions that must stay each other's inverse are two
 * functions that will eventually disagree.
 *
 * Returns the notice to prepend to the agent's prompt, or null when nothing moved.
 */
async function switchBorrowedTree(
  project: Project,
  session: Session,
  path: string,
  task: Task,
  branch: string
): Promise<{ ok: boolean; notice: string | null; error?: string }> {
  const from = session.currentBranch
  if (from === branch) return { ok: true, notice: null }

  const result = await switchResidentBranch(project, path, branch)
  if (!result.ok) {
    log.info(
      `t${task.seq} cannot borrow the conversation in ${path}: ${result.error ?? 'switch failed'}`
    )
    return { ok: false, notice: null, ...(result.error ? { error: result.error } : {}) }
  }

  noteCurrentBranch(session.id, branch)

  // ⚠️ Only into a task that is actually still open. A completed task's thread is a record, and
  // appending to it what happened to somebody else's work afterwards would be noise in the one place
  // a person goes to read what this task did.
  const previous = result.from ? taskOnBranch(result.from) : null
  if (previous && previous.id !== task.id && !TERMINAL_STATUSES.has(previous.status)) {
    addMessage(
      previous.id,
      'system',
      `The conversation this task was running in has been borrowed by t${task.seq}, and its ` +
        `workspace ${path} is now on \`${branch}\`. ⛔ Your branch \`${result.from}\` is untouched — ` +
        'nothing was committed, stashed or discarded. The workspace switches back when this task ' +
        'runs again, and the agent is told.'
    )
  }

  log.info(
    `${path} switched from ${result.from ?? 'a detached head'} to ${branch} for t${task.seq}, ` +
      `in the conversation ${session.id.slice(0, 8)} was already having`
  )

  return {
    ok: true,
    notice:
      `⚠️ This workspace has moved to a different branch since your last turn. It was on ` +
      `\`${result.from ?? 'a detached head'}\` and is now on \`${branch}\`, for a different task. ` +
      'Any file you read earlier came from the other branch and may be different or absent now — ' +
      're-read anything you are going to rely on rather than trusting what is in this conversation.'
  }
}

/** Statuses after which a task's thread is a record rather than a place to leave notes. */
const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'cancelled', 'failed'])

/** Whose branch is this? ⚠️ By name, because the branch *is* the task's name — see `branchNameFor`. */
function taskOnBranch(branch: string): Task | null {
  return listTasks().find((t) => t.branch === branch) ?? null
}

/** Is this session's prompt cache already gone, making its context no cheaper than a cold start? */
export function cacheHasLapsed(session: Session, now = Date.now()): boolean {
  return session.cacheExpiresAt !== null && session.cacheExpiresAt <= now
}

/**
 * Of the conversations sitting on a workspace, which one costs least to lose?
 *
 * ⛔ **A lapsed cache first, always.** Such a session's context is no cheaper to reach than a cold
 * start already, so closing it destroys nothing that had value — and a still-warm session ranked
 * ahead of a lapsed one would be the scheduler throwing away the exact thing it exists to preserve.
 *
 * ⚠️ Among equals, the one idle longest, measured from its **last request** rather than from when it
 * started. A conversation that opened an hour ago and spoke a second ago is the busiest thing here,
 * not the oldest; ranking by `startedAt` would evict it first and reliably pick the wrong session.
 * `startedAt` is the fallback only for a session that has never made a request.
 *
 * Exported for its own tests: the ranking is where the judgement is, and it is worth being able to
 * check it without a pool, a worktree and a process.
 */
export function leastValuableResident(candidates: Session[], now = Date.now()): Session | null {
  const ranked = [...candidates].sort((a, b) => {
    const [al, bl] = [cacheHasLapsed(a, now), cacheHasLapsed(b, now)]
    if (al !== bl) return al ? -1 : 1
    return (a.lastRequestStartedAt ?? a.startedAt) - (b.lastRequestStartedAt ?? b.startedAt)
  })
  return ranked[0] ?? null
}

/**
 * Close the least valuable conversation holding a workspace in this project, so somebody else can
 * have the tree. Returns whether anything was actually freed.
 *
 * ⛔ **Never one with an open run.** A conversation mid-turn is an agent working; evicting it would
 * kill a run to start another, which is not a trade this scheduler is allowed to make on its own.
 *
 * ⚠️ The victim is the one whose prompt cache has already lapsed — its context is no cheaper to
 * reach than a cold start, so it is the one session whose loss costs nothing measurable. Only if
 * none has lapsed does this fall back to the longest idle, and that case is a genuine cost: it is
 * the pool being too small for the work, and the log says so in those words.
 */
async function evictResident(project: { id: string; name: string }): Promise<boolean> {
  const now = Date.now()
  const candidates = [...workspaces.entries()]
    .filter(([sessionId, held]) => held.projectId === project.id && !hasOpenRun(sessionId))
    .map(([sessionId]) => getSession(sessionId))
    .filter((s): s is Session => s !== null)

  const victim = leastValuableResident(candidates, now)
  if (!victim) return false
  const cold = cacheHasLapsed(victim, now)
  log.info(
    `evicting session ${victim.id.slice(0, 8)} from ${victim.cwd} to free a workspace in ` +
      `${project.name}` +
      (cold
        ? ' — its cache had already lapsed, so nothing warm was lost'
        : ' — ⚠️ its cache was still warm, which means this pool is too small for the work in it')
  )
  // ⚠️ Waits for the process, not for the request. `releaseWorkspaceOf` parks the tree with git, and
  // an agent that still has file handles in it makes that fail for reasons nobody can reproduce.
  await closeAndWait(victim.id)
  await releaseWorkspaceOf(victim.id)
  return true
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
      if (run.sessionId) releaseAllFor(run.sessionId)
    }
    releaseAllFor(task.id)
    // ⚠️ `workspaces.delete(task.id)` stood here and had never once matched: the map has never been
    // keyed by task. Harmless, but it read as the line that cleaned up after a restart, which is why
    // it survived. Nothing needs to clean the map at startup — it is in memory and starts empty, and
    // `reconcileClaims` releases the rows beside it.
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

// ---------------------------------------------------------------------------- landing later

/**
 * Land a branch whose task already finished.
 *
 * ⛔ **The case t5 had no answer for.** A task completed, its branch carried a real commit
 * (`ea05929`), the workspace was released, and nothing in the app could ever land it again — the
 * only path to `landTask` ran inside the completion that had already happened. It sat for a day and
 * was recovered by hand.
 *
 * ⚠️ This claims a workspace and prepares it on the branch rather than operating from the trunk.
 * The trunk holds the landing target checked out; rebasing a task branch there would move the
 * operator's own checkout under them, and AGENTS.md has said since M2 that nothing works in the
 * trunk. `prepareWorkspace` already switches to an existing branch, so the pooled path is also the
 * shorter one.
 */
export async function relandTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (!task.branch) return { ok: false, reason: 'this task has no branch' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }

  const workspace = await claimWorkspace(project, `reland:${task.id}`)
  if (!workspace) return { ok: false, reason: 'every workspace is busy; try again in a moment' }

  try {
    const prepared = await prepareWorkspace(project, workspace, task.branch)
    if (!prepared.ok) return { ok: false, reason: prepared.error ?? 'could not prepare a workspace' }

    const policy = policyFor(project)
    const state = await workspaceState(workspace.path, policy.landingTarget)
    // ⛔ The same decision as a first completion, not a shortcut past it. A branch reaching this by
    // a button press gets the identical bar: authority, checks, a clean tree, real commits.
    const decision = decideFinish({ task, project, state, hasChecks: policy.check.length > 0 })
    if (decision.kind !== 'land') {
      const reason = 'reason' in decision ? decision.reason : 'nothing to land'
      addMessage(task.id, 'system', `Asked to land again, and did not: ${reason}`)
      return { ok: false, reason }
    }

    const result = await landTask({ project, task, workspacePath: workspace.path, branch: task.branch })
    if (result.ok) setStatus(task.id, 'completed')
    return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) }
  } finally {
    // ⚠️ Parked and released in every path, including the refusals above. A workspace held by a
    // failed button press is one slot fewer for the fleet, permanently.
    await parkWorkspace(project, workspace.path)
    releaseWorkspace(workspace.claimId)
  }
}
