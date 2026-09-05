import { canWork, sessionEnded } from '@shared/protocol.js'
import type {
  Attachment,
  FinishPolicy,
  PendingWork,
  Project,
  QuestionKind,
  QuestionOption,
  Run,
  RunQuota,
  Task,
  TaskStatus
} from '@shared/tasks.js'
import { describeAttachment } from './attachments.js'
import {
  WINDOW_HIGH_WATER,
  FINISH_LABELS,
  cleanQuestionText,
  isMultiSelectQuestion,
  isOpenConversation,
  policyVerifies,
  resolveCompletionMode,
  resolveModelChoice
} from '@shared/tasks.js'
import type { QuotaWindow, Session, Worker } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import type { ProbeDemand } from './quota.js'
import { paceFactors, paceFor, paceValue, type PaceFactors } from './pace.js'
import { recordRoutingDecision } from './routingdecisions.js'
import type { RoutingBasis, RoutingCandidate } from '@shared/routing.js'
import {
  ensureFreshQuota,
  lastQuota,
  probeWorker,
  refreshNow,
  requestUrgentProbe,
  sessionWindowFor,
  windowsForPool,
  windowExpired
} from './quota.js'
import {
  getWorker,
  listWorkers,
  modelRoutingActive,
  recordDispatchFailure,
  routableModelsFor
} from './workers.js'
import { fitnessFor } from './fitness.js'
import { qualityReport } from './quality.js'
import { complexityOf } from './complexity.js'
import { exploreRoute } from './exploration.js'
import { accountUnavailability } from './eligibility.js'
import { getProject, landingTargetFor, policyFor, reloadProject } from './projects.js'
import {
  admitBlocked,
  admitScheduled,
  quotaParkedTasks,
  resumeQuotaPaused,
  addMessage,
  creditRunListUsd,
  finishRun,
  getTask,
  listTasks,
  markDelivered,
  messagesFor,
  runForSession,
  requireRun,
  requireTask,
  quotaOverridden,
  runsFor,
  schedulingOrder,
  setHoldReason,
  setQuotaPreemptWarning,
  setTaskHandoff,
  markConflictAsked,
  markResolveRetryAsked,
  markFinishAsked,
  setRunQuota,
  setStatus,
  startRun,
  updateTask
} from './tasks.js'
import { childrenOf as splitChildrenOf } from './split.js'
import { enqueueConsult, hasPendingConsult, latestAnswer } from './controller.js'
import {
  decomposeQuestion,
  routeDetail,
  routeQuestion,
  titleQuestion,
  triageQuestion,
  TITLE_SUMMARY_THRESHOLD,
  type RouteCandidate
} from './judgment.js'
import { escalateStale, voidApprovalsForSession } from './approvals.js'
import { fileParkedQuestion, parkQuestionsForSession } from './questions.js'
import { samePath } from './fspath.js'
import {
  Contended,
  availability,
  claim,
  claimsForHolder,
  openClaims,
  reassignClaim,
  release,
  releaseAllFor,
  upsertResource,
  workspacePoolId
} from './resources.js'
import {
  branchNameFor,
  claimWorkspace,
  parkWorkspace,
  prepareWorkspace,
  releaseWorkspace,
  rescueAtTip,
  switchResidentBranch,
  trunkCommitsSince,
  trunkTargetSha,
  workspaceHeldBy,
  workspaceState,
  type Rescue,
  type Workspace
} from './worktrees.js'
import {
  backscroll,
  cacheHasLapsed,
  clearClockMove,
  closeAndWait,
  closeSession,
  finishedConversationsIn,
  getSession,
  hasOpenRun,
  invalidateSessionContext,
  markClockMove,
  noteCurrentBranch,
  reopenable,
  resumableSession,
  sendPrompt,
  sessionsForWorker,
  spawnSession
} from './sessions.js'
import {
  abortRebase,
  beginConflictResolution,
  hasRemote,
  landingBaseFor,
  finishWithoutLanding,
  landTask,
  readMergeability
} from './landing.js'
import {
  describeTree,
  looksStuck,
  quietSince,
  sampleProcessTree,
  MIN_SAMPLE_GAP_MS,
  type TreeSample
} from './stall.js'
import { decideFinish, resolveFinishPolicy, type TrunkReading } from './finish.js'
import {
  mismatch,
  rank,
  resolveSessionSharing,
  wantsCompactionToShare,
  whyNotShared,
  type ShareIntent
} from './sharing.js'
import { stripAnsi } from './stream.js'
import { activityFor, clearActivity } from './activity.js'
import { log } from './log.js'
import { db } from './db.js'
import {
  freshRateLimit,
  isSessionRateWindow,
  parseQuotaResetTime,
  refusalRateLimit,
  sessionRateLimit,
  windowResetsAt,
  type LiveRateLimit
} from './quota.js'
import { reserveState } from './reserve.js'
import { settings } from './settings.js'
import { estimateTask, overrunFactor, type Estimate } from './estimator.js'
import type { Objective } from '@shared/tasks.js'
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_OBJECTIVE,
  policy,
  resolveObjective,
  WEIGHT_FORMULAS,
  weights
} from './objective.js'
import {
  compactOnResume,
  RESUME_COMPACT_WAIT_MS,
  runCacheClock,
  type ResumeCompaction
} from './cacheclock.js'
import {
  compactionInFlight,
  compactionsForTask,
  lastCompactionLandedAt,
  noteCompactionAsked,
  onCompactionLanded
} from './compaction.js'
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

/**
 * Above this on the 5h window, stop starting new work. Only applied to a reading we trust.
 *
 * ⚠️ Exported since 2026-09-01 so the control that *overrules* it can name the same number the gate
 * enforces. A button that said "override the 92% limit" against a constant only this file could see
 * would be a second copy of the threshold, and the pair would disagree the day one of them moved.
 *
 * ⚠️ And the value comes from `WINDOW_HIGH_WATER` rather than being written here, for the same
 * reason one rung up: `reserveState` reads it to decide that an account's live sessions need saving,
 * and the whole point of that pairing is that the tick which refuses a dispatch is the tick which
 * asks for the compaction.
 */
export const QUOTA_HIGH_WATER = WINDOW_HIGH_WATER

/**
 * How long an override lasts when nothing can say when the window it overrules resets.
 *
 * ⛔ A duration, and a short one, precisely because it is the branch with no measurement behind it.
 * The override's whole design is that it expires with its reason; where the reason cannot be dated,
 * the honest substitute is a permission that lapses soon enough to be re-granted deliberately rather
 * than one that quietly outlives every window it was ever about.
 */
export const QUOTA_OVERRIDE_FALLBACK_MS = 60 * 60 * 1000

/**
 * When 5h quota reaches or exceeds this during an active run, preempt the run before hard exhaustion.
 */
export const QUOTA_MIDRUN_PREEMPT_WATER = 95

/**
 * The bar a reading has to clear when the **vendor is warning about that same window too**.
 *
 * ⚠️ Lower than `QUOTA_MIDRUN_PREEMPT_WATER`, and only reachable with two independent signals
 * agreeing. A warning does not replace the evidence; it lowers what the evidence has to show.
 *
 * Set to `QUOTA_RISK_FLOOR` (50%): the point where quota usage enters the risk zone and finishing a
 * large task stops being a safe assumption. A warning on low usage (<50%, measured at 17%, 0%, 19%
 * on t71) is ignored so healthy runs are not disrupted; an elevated baseline (>=50%, e.g. 76% on t75)
 * combined with an in-stream session warning preempts cleanly before hard exhaustion.
 */
export const QUOTA_WARNED_PREEMPT_WATER = 50

/** Time for a watching operator to overrule an automatic, still-avoidable quota preemption. */
export const QUOTA_PREEMPT_WARNING_MS = 60_000

/** How long a task may be parked when nothing will say when the window actually resets. */
const BLIND_PARK_MS = 5 * 60 * 60 * 1000

/**
 * Should this run be wrapped up now, and if so, until when?
 *
 * ⛔ **Written after a run was preempted three times in six hours at 0%, 17% and 19% of the window
 * it was being preempted over** (t71, 2026-08-31), then parked until 2026-09-07. Three separate
 * confusions produced that, and each is answered here by name:
 *
 *  1. **A warning is not a refusal.** `allowed_warning` rides a turn the vendor *served*. It is
 *     evidence that quota is moving, never proof the next call fails - so on its own it no longer
 *     ends a run. `rejected` is the vendor declining, and one of those is enough.
 *  2. **A window is not every window.** Claude Code warns on `five_hour` and `seven_day` from the
 *     same account, and only the first is a pool a single run can drain. A weekly caution now
 *     changes nothing about a run in flight; there is no version of "pause for six days" that beats
 *     letting the turn proceed.
 *  3. **Park against the window that stopped you, never a different one.** `resumeAt` comes from the
 *     sample that produced the verdict, so a five-hour concern cannot write a seven-day `not_before`.
 *
 * ⚠️ `percent` is this fleet's own reading of the pool the run draws from, already checked for
 * freshness and turnover by the caller, or `null` when there is no reading worth trusting. Null is
 * *unknown*, so it corroborates nothing - it cannot combine with a warning to end a run.
 */
export function overrunVerdict(
  workerId: string,
  percent: number | null,
  opts: {
    /**
     * A person has said to spend into this window on this task.
     *
     * ⛔ **It reaches exactly the two branches built out of `percent` and nothing else.** A refusal
     * is the vendor saying the turn did not happen; there is no operator setting that makes a
     * refused turn into a served one, so the first branch below is unreachable from here by
     * construction. An override that could suppress it would be a switch labelled "keep asking an
     * account that is saying no".
     */
    quotaOverride?: boolean
  } = {}
): { reason: string; resumeAt: number; overridable: boolean } | null {
  const park = (sample: LiveRateLimit | null): number =>
    (sample?.resetsAt && sample.resetsAt > Date.now() ? sample.resetsAt : null) ??
    windowResetsAt(workerId)?.at ??
    Date.now() + BLIND_PARK_MS

  // A refusal, on any window. The turn did not happen; nothing here gets to talk it down.
  const refused = refusalRateLimit(workerId)
  if (refused) {
    return {
      reason: `vendor refused the turn (${refused.status} on ${refused.windowId})`,
      resumeAt: park(refused),
      overridable: false
    }
  }

  if (percent === null) return null

  // ⛔ Below the refusal and above everything else. Dispatching a task under an override and then
  // preempting it three points later would be the fleet granting a permission and revoking it before
  // the agent had finished reading its prompt — the override would buy a session and a cold start
  // and nothing else.
  if (opts.quotaOverride) return null

  if (percent >= QUOTA_MIDRUN_PREEMPT_WATER) {
    return {
      reason: `${percent}% of 5h window used`,
      resumeAt: park(sessionRateLimit(workerId)),
      overridable: true
    }
  }

  // Two signals about the *same* window. Neither would act alone at this level.
  const warned = freshRateLimit(workerId)
  if (
    warned &&
    warned.status !== 'allowed' &&
    isSessionRateWindow(warned.windowId) &&
    percent >= QUOTA_WARNED_PREEMPT_WATER
  ) {
    return {
      reason: `${percent}% of 5h window used, and the vendor is warning about it (${warned.status})`,
      resumeAt: park(warned),
      overridable: true
    }
  }

  return null
}

/**
 * When two candidates score this close, the arithmetic cannot separate them.
 *
 * ⚠️ A tie is only worth asking about on a task large enough that ε is worth more than the turn the
 * question costs - which is why the floor is deliberately high. Below it the top score wins and
 * nothing is spent. This is the weakest of the four judgment events and it is gated hardest.
 */
const ROUTE_EPSILON = 0.1
const ROUTE_CONSULT_FLOOR_TOKENS = 150_000

/**
 * What `fitness` and `price` say for their basis while no worker has a routable-model allowlist.
 *
 * ⚠️ A sentence rather than an empty string, because `AGENTS.md` asks every belief to carry its
 * basis and "0" with nothing beside it reads as *measured and bad* rather than *not asked*.
 */
const INERT_BASIS =
  'model-aware routing is inert: no worker has a routable-model allowlist, so every candidate ' +
  'offers the single model it already uses and there is no model choice to score'
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
  // ⛔ Beside it for the same reason `resumeQuotaPaused` is: a different status, held by a different
  // thing. A `blocked` task waits on an *event* — its prerequisite completing — and an event that
  // was missed never comes again, so the graph needs one place that checks rather than remembers.
  // See `admitBlocked`; it logs at warn when it finds one, because finding one means a bug upstream.
  admitBlocked()
  // ⛔ Beside `admitScheduled` and not inside it, because the two read different statuses. A task
  // parked for a quota window is the one kind of hold that ends on a clock rather than on a person,
  // and until this call existed nothing anywhere put one back (t60, 2026-08-31).
  //
  // ⚠️ And a clock is not the only way that hold ends. `quotaReleaseFor` is what lets a *measured*
  // reading beat the estimate the park was made on — see it for the failure that made it necessary.
  resumeQuotaPaused(quotaReleaseFor)
  escalateStale()
  // ⛔ Free: writes at most one consult row and returns. Nothing below waits on it, and nothing it
  // does changes what this tick dispatches.
  askForTitle()
  // ⛔ Before dispatching anything: a window about to close, or a run past its estimate, is a cost
  // event that outranks starting new work.
  await runWatchdogs()

  const ready = listTasks()
    .filter((t) => t.status === 'ready')
    .sort(schedulingOrder)

  let dispatched = 0
  const skipped: string[] = []
  /**
   * The tasks this tick found nowhere to run, as tasks rather than as sentences.
   *
   * ⚠️ `skipped` is prose for an operator and cannot be asked a second question. These are the rows
   * the cache clock needs, because "which conversation would have unblocked this task?" is only
   * answerable from the task itself — see `sessionsWantedForBorrow`.
   */
  const held: Task[] = []
  const dispatchTargets = new Set<string>()
  let planned = 0

  for (const task of ready) {
    // ⛔ **A Plan & Split task is dispatched like any other, and that is the whole of t178.** It used
    // to be handed to the unattended controller instead — which has no tools, cannot read the
    // repository and cannot ask a question, so it answered once in JSON and its children arrived as
    // draft rows with no prompts. Planning is a *reading* job: it needs the repo in front of it and
    // `ask_human` in its hand, which is exactly what a normal dispatch provides.
    //
    // ⚠️ The controller consult survives as the fallback for the one case that still cannot be given
    // an agent turn — a plan task with **no project**, which has no workspace to read and nothing to
    // split work across. That is decision D1: replace the behaviour, keep the escape hatch.
    if (task.kind === 'plan' && !task.projectId) {
      if (askForPlan(task)) planned++
      else {
        const why = 'decomposition was asked for recently and is on cooldown'
        skipped.push(`t${task.seq}: ${why}`)
        setHoldReason(task.id, why)
      }
      continue
    }

    // ⛔ Before `chooseTarget`, because routing can spend a controller consult and a task with
    // nowhere to work is not worth one. See `poolPressure`.
    const pressure = poolPressure(task)
    if (pressure) {
      skipped.push(`t${task.seq}: ${pressure}`)
      setHoldReason(task.id, pressure)
      continue
    }

    const choice = chooseTarget(task)
    if (choice.deferred || !choice.worker) {
      skipped.push(`t${task.seq}: ${choice.reason}`)
      held.push(task)
      // ⛔ Told to the operator, not only to the log. `ready` on its own is unreadable - it is the
      // scheduler's word for "eligible", and a person who has just filed a task reads it as "waiting
      // for me to press something". The reason is already computed; the only change is that it now
      // reaches the row it is about.
      // ⚠️ And the clock beside the sentence, where the refusal has one. A quota hold ends at a
      // known moment; every other hold here ends when something else happens and passes null.
      setHoldReason(task.id, choice.reason, choice.holdUntil ?? null)
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
      const verdict = afterFailedDispatch(err)
      if (verdict.status === 'ready') {
        log.info(`t${task.seq} lost a race for a resource and goes back in the queue: ${verdict.reason}`)
        setStatus(task.id, 'ready')
        setHoldReason(task.id, verdict.reason)
        skipped.push(`t${task.seq}: ${verdict.reason}`)
        continue
      }
      log.warn(`dispatch of t${task.seq} failed: ${verdict.reason}`)
      addMessage(task.id, 'system', `Could not start: ${verdict.reason}`)
      setStatus(task.id, 'failed')
    }
  }

  // The cache clock runs after dispatch, so a session the scheduler just chose is recognised as
  // move 1 - an expiring asset turned into work - rather than being kept alive for its own sake.
  //
  // ⭐ And it is told, in the same breath, which conversations the tasks it could *not* dispatch
  // were waiting on. A conversation too full to lend is the one blockage the clock can clear, and
  // until this it could not see it: the queue's pressure is not visible from a session row.
  const clock = await runCacheClock({
    objective: settings().objective ?? DEFAULT_OBJECTIVE,
    dispatchTargets,
    borrowWanted: sessionsWantedForBorrow(held)
  })

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

/**
 * A dispatch threw. Does the task go back in the queue, or has it failed?
 *
 * ⛔ **`ready`, explicitly, and never left at `assigned`.** `dispatch` marks the task `assigned`
 * before it claims anything, and `assigned` is in `TERMINAL_OR_HELD` — a task put back by hand that
 * kept that status would sit somewhere `admit` refuses to touch, which is a worse bug than the one
 * this fixes because nothing would ever say why.
 *
 * ⚠️ **Only `Contended`.** A retry is correct exactly when the next attempt meets a different world,
 * and the only thing the passage of time reliably changes is who is holding what. A `prepare` hook
 * that exits non-zero, a branch that will not check out, an agent that dies on spawn — those are
 * faults, they will fail identically in ten seconds, and retrying them would turn one legible error
 * into an unbounded loop of the same one.
 */
export function afterFailedDispatch(err: unknown): { status: 'ready' | 'failed'; reason: string } {
  const reason = err instanceof Error ? err.message : String(err)
  return { status: err instanceof Contended ? 'ready' : 'failed', reason }
}

/** What the last tick concluded, so an unchanged conclusion is not logged again. */
let lastTickNote = ''

// ---------------------------------------------------------------------------- the baseline

/**
 * Which metered pool a model draws on, or `null` where the provider has only one.
 *
 * ⛔ Read from the cost model, never inferred from the model's name here. `gemini-*` and `claude-*`
 * look like a rule until a vendor ships a model that breaks it, and this file has no business
 * knowing vendor naming conventions — `docs/adapters.md` and the cost models hold that.
 */
function poolFor(worker: Worker, model: string | null): string | null {
  if (!model) return null
  try {
    return costModel(adapter(worker.adapterId).info.policy.costModelId).modelSpec(model)?.pool ?? null
  } catch {
    // An adapter with no loadable cost model still dispatches; it just gets the pessimistic window.
    return null
  }
}

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
function needsBaseline(worker: Worker | null): string | null {
  if (!worker) return null

  const quota = lastQuota(worker.id)
  if (quota && !quota.stale && quota.windows.length > 0) return null

  // ⭐ **The gate is now the only automatic thing that refreshes a reading** — the poller's clock
  // was retired on 2026-08-31 because it spent terminals on accounts nobody was routing work to
  // while still leaving an idle worker reading `stale` for most of every cycle. Here there is a
  // task about to run on this worker, so the number is about to matter.
  // ⛔ `false` covers three cases that must not bench the task: nothing to drive, a worker that
  // may not be probed, and an attempt too recent to repeat. Dispatch blind and mark the run.
  if (!ensureFreshQuota(worker.id)) return null

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
 * Has the window a task is parked on actually come back, whatever its timer says?
 *
 * ⛔ **The bug this closes.** A quota park carries `not_before`, and on the overrun path that value
 * can be a guess: a rate-limit warning with no reset time attached parks the task `now + 5h` by
 * arithmetic. Measured by hand on 2026-08-31 — a probe read the window at 0% used and every task
 * waiting on that account stayed `paused_quota`, because the only question anything asked was *is
 * it time yet*, never *is there room now*.
 *
 * ⚠️ Held to the same standard as a dispatch, not a looser one. The reading must exist, must be
 * fresh (`stale` is an age test), must not describe a window that has since rolled over, and must
 * sit below the same `QUOTA_HIGH_WATER` the gate uses — otherwise a task released here would be
 * held again on the very next tick, which is worse than staying parked because it costs a message
 * every time. ⛔ An **expired** window is a release on its own terms: `windowExpired` means the
 * window this reading counted no longer exists, which is exactly what the task was waiting for.
 *
 * ⛔ **`quotaOverrideUntil` is deliberately not consulted here.** A person overruling the water mark
 * lifts the *dispatch cut* and the matching mid-run preempt, and explicitly not the window boundary
 * — and a `paused_quota` park is the window boundary. Reading it here would turn "92% is enough for
 * this task" into "start again inside a window the fleet was wrapped up to survive", which is a
 * different permission from the one that was granted.
 *
 * Returns the sentence the operator reads on the task, or null to leave it parked.
 */
export function quotaReleaseFor(task: Task): string | null {
  const workerId = task.ranOn ?? task.assignee ?? null
  if (!workerId) return null
  const worker = getWorker(workerId)
  if (!worker) return null

  const quota = lastQuota(workerId)
  if (!quota || quota.stale || quota.windows.length === 0) return null

  // ⛔ **The reading has to be newer than the park, not merely fresh.** Measured on t108,
  // 2026-09-02: a run was preempted at 07:22:06 on a vendor warning about the 5h window, and 120
  // seconds later this released it again on a cached reading taken at ~07:16 — 83%, under the gate,
  // and *older than the event that stopped the run*. The task redispatched, was preempted again
  // within ten seconds, and the third turn walked into the hard session limit. A reading from
  // before the park cannot answer "has the window come back since", which is the only question
  // being asked here; the urgent probe requested at park time is what supplies one that can.
  if (quota.sampledAt <= task.updatedAt) return null

  const choice = resolveModelChoice(task.constraints, worker, false, quota)
  const windows = windowsForPool(quota.windows, poolFor(worker, choice.model))
  if (windows.length === 0) return null

  const blocking = windows.find((w) => !windowExpired(w) && w.percent >= QUOTA_HIGH_WATER)
  if (blocking) return null

  const age = Math.round(quota.ageMs / 1000)
  const expired = windows.find((w) => windowExpired(w))
  if (expired) {
    return `${worker.label}'s ${expired.label ?? '5h'} window has rolled over since this was parked.`
  }

  const highest = windows.reduce((max, w) => (w.percent > max.percent ? w : max), windows[0]!)
  return (
    `${worker.label} is at ${Math.round(highest.percent)}% of its ${highest.label ?? '5h'} window ` +
    `on a reading ${age}s old, which is below the ${QUOTA_HIGH_WATER}% gate.`
  )
}

/**
 * What the quota poller needs to know to decide when to look next.
 *
 * ⭐ Two facts, both of which live here and neither of which the poller can derive: which accounts
 * have a run in flight (their windows are the only ones moving, so they get the *active* cadence and
 * a real refresh rather than a re-read), and which accounts a parked task is waiting on, so the
 * fleet looks at one the moment its window is due back instead of whenever the interval next comes
 * round.
 *
 * ⚠️ A parked task with no worker and no time contributes nothing: there is no account to look at
 * and no moment to look at it.
 */
export function probeDemand(): ProbeDemand {
  const activeWorkerIds = [
    ...new Set(
      listTasks()
        .filter((t) => t.status === 'running')
        .flatMap((t) => runsFor(t.id).filter((r) => !r.endedAt).map((r) => r.workerId))
    )
  ]
  const releases = new Map<string, number>()
  for (const parked of quotaParkedTasks()) {
    if (!parked.workerId || parked.at === null) continue
    const soonest = releases.get(parked.workerId)
    if (soonest === undefined || parked.at < soonest) releases.set(parked.workerId, parked.at)
  }
  return {
    activeWorkerIds,
    releases: [...releases].map(([workerId, at]) => ({ workerId, at }))
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
    // ⛔ Through `refreshNow`, which is the ledger every other forced refresh claims from — not
    // `refreshUsage` directly, which is what this did and which claimed nothing. A run ending is
    // precisely when a sweep also sees that account as recently active, so the two could open two
    // interactive sessions on one account seconds apart: exactly the collision `claimRefresh` was
    // written to prevent, reached by the one caller that went round it. ⚠️ `0` takes the floor
    // (`MIN_FORCED_GAP_MS`), because inside a minute a second terminal cannot produce a different
    // number, and every longer gap is a real closing reading worth taking.
    if (!(await refreshNow(run.workerId, 0))) {
      // ⚠️ Declined, not failed — something refreshed this account seconds ago, or it may not be
      // driven at all. Either way the closing reading must still be *taken*: the free file read is
      // what the vendor's own cache holds, which is better than recording no `after` and calling
      // the delta unmeasured.
      await probeWorker(run.workerId)
    }
  } catch (err) {
    log.warn(`could not read the closing quota for run ${run.id.slice(0, 8)}:`, err)
  }
  // ⛔ Guarded too, and this is not belt-and-braces. Every caller invokes this as `void
  // captureQuotaAfter(...)`, so there is nobody to catch what it throws: anything escaping here is an
  // unhandled rejection in a daemon that is supposed to outlive the window. Only the `await` above
  // was covered, which left the two calls that read and write the store bare.
  try {
    setRunQuota(run.id, 'after', runQuota(run.workerId))
  } catch (err) {
    log.warn(`could not record the closing quota for run ${run.id.slice(0, 8)}:`, err)
  }
}

// ---------------------------------------------------------------------------- gates

export interface WorkerChoice {
  worker: Worker | null
  /** A live, idle session already holding this task's context. Reusing it is the cheapest move here. */
  session: Session | null
  /** A closed-but-reopenable conversation on this account for this task. */
  resumable?: Session | null
  reason: string
  quotaUnverified: boolean
  score: number
  /**
   * How that score was arrived at, term by term.
   *
   * ⛔ Carried rather than recomputed, so the derivation shown to a person and to the controller is
   * the *same arithmetic* that ordered the candidates — not a second implementation that can drift
   * from it. Absent only on the no-candidate result, where there is nothing to explain.
   */
  breakdown?: ScoreBreakdown
  /** ⚠️ Not "no worker" - "not yet". A routing question is open and the answer is worth the wait. */
  deferred?: boolean
  /**
   * The earliest moment this refusal could stop being true, where the refusal has a clock behind it.
   *
   * ⛔ **A quota hold is the one refusal that ends by itself**, and the reset time is already in
   * hand when the sentence is written — it was being thrown away. Everything else here (at capacity,
   * lacks a capability, signed out) ends when something *else* happens, so it stays null rather than
   * inventing a deadline. ⚠️ The **earliest** of the candidates' resets when more than one worker
   * is held on quota: the task needs any one of them, so the first window to reset is the first
   * moment it could move.
   */
  holdUntil?: number | null
  /** The model this candidate would run, resolved before the spawn. Null where it is the CLI's own. */
  model?: string | null
  /**
   * Every candidate that was scored, in the order they were ranked.
   *
   * ⛔ Carried on the winner rather than recomputed, so the ledger `dispatch` writes holds the *same
   * arithmetic* that ordered them — see `routingdecisions.ts`. Present only on a choice that can
   * actually dispatch; a deferred or empty choice has nothing to record.
   */
  scored?: RoutingCandidate[]
  /** The vector these weights came from — fleet default, project override or task override. */
  objective?: Objective
  /** How the winner was picked. See `RoutingBasis`. */
  routedBy?: RoutingBasis
}

/**
 * A live, idle conversation this task could run in.
 *
 * ⛔ **This task's own comes first, always, and needs no permission.** A reply into a session that
 * already holds this task's context costs `0.1·C` against `2.0·C` into a dead one, the workspace and
 * the branch already belong to it, and nothing is disclosed to anybody. That is the single most
 * valuable reuse there is and it is unconditional.
 *
 * ⚠️ Only when that misses does sharing come into it, and only when somebody has turned it on. A
 * borrowed conversation is a real saving and a real disclosure, which is why it is a setting and the
 * task's own session is not.
 */
function warmSessionFor(task: Task, workerId?: string): Session | null {
  const idle = (session: Session | null): Session | null => {
    if (!session || sessionEnded(session.state)) return null
    // ⛔ Asked per worker, because a conversation belongs to exactly one account and the answer
    // "there is a warm session" is only useful to the candidate that can actually speak in it. This
    // used to be resolved once for the whole fleet and then matched against each worker in the loop,
    // which meant one borrowable conversation on the wrong account hid every other candidate's own.
    // Callers that genuinely mean "on any account" — `poolPressure` — pass nothing.
    if (workerId && session.workerId !== workerId) return null
    // ⛔ A model or an effort the task pinned is not a preference the warm path gets to overrule.
    // A prompt sent into a live conversation is served by the process already running it: the model
    // was fixed at spawn and `dispatchIntoWarmSession` cannot change it. Continuing here would run
    // the task on the model it was started with and record the one it now asks for.
    if (mismatch(pinned(task), session)) return null
    // ⛔ A `streamPrompts: 'once'` session is never warm, whatever its state says. Its CLI reads
    // one prompt from stdin, runs that turn and exits - there is no conversation still sitting there
    // to continue, and handing it a second prompt is a write into a pipe that closed when the first
    // one went out. Reuse here would report a saving that does not exist and deliver nothing.
    if (adapter(session.adapterId).info.capabilities.streamPrompts === 'once') return null
    // A session with an open run is busy; only an idle one can take work.
    return hasOpenRun(session.id) ? null : session
  }

  for (const run of runsFor(task.id)) {
    if (!run.sessionId) continue
    const own = idle(getSession(run.sessionId))
    if (own) return own
  }
  return borrowCandidates(task, workerId).offerable[0] ?? null
}

/**
 * What this task explicitly asked to be run as, and nothing it merely inherited.
 *
 * ⚠️ `task.constraints` only, never `resolveModelChoice`: a worker's default is what the *next*
 * spawn would pick, and a session started before that default changed is not thereby wrong. What a
 * person typed into the model box is a different kind of statement, and it is the only one strong
 * enough to throw away a warm prefix over.
 */
function pinned(task: Task): ShareIntent {
  return { model: task.constraints.model ?? null, effort: task.constraints.effort ?? null }
}

/**
 * The conversations belonging to *other* tasks, split by whether they can be joined now.
 *
 * ⛔ Returns nothing unless sharing is on for this task, and `off` is the shipped default at every
 * tier. ⚠️ The gates are in `sharing.ts` so the answer is the same wherever it is asked; what lives
 * here is the part that needs the scheduler's own knowledge — which conversations are resident,
 * which is leased, and what model this task would get on the account each one belongs to.
 *
 * ⭐ `full` is the second half of the answer and the reason this returns a pair. A conversation
 * refused *only* for being over the share ceiling is not a dead end: it may be the one warm prefix in
 * this project, and compacting it turns it into a conversation the queue can use. Naming those
 * separately is what lets the tick tell the cache clock about them — see `sessionsWantedForBorrow`.
 */
function borrowCandidates(task: Task, workerId?: string): { offerable: Session[]; full: Session[] } {
  const empty = { offerable: [], full: [] }
  if (!task.projectId) return empty
  const project = getProject(task.projectId)
  if (resolveSessionSharing(task, project).sharing !== 'on') return empty

  const offerable: Session[] = []
  const full: Session[] = []
  for (const [sessionId, held] of workspaces) {
    if (held.projectId !== task.projectId) continue
    const session = getSession(sessionId)
    if (!session || sessionEnded(session.state)) continue
    if (workerId && session.workerId !== workerId) continue
    const refusal = whyNotShared(task, session, {
      hasWorkspace: true,
      // ⚠️ Asked of the runs and of the lease, because they answer different questions: a run says
      // somebody is mid-turn, a lease says somebody has been given the right to speak next.
      leased: hasOpenRun(sessionId) || leaseHeld(sessionId),
      intent: intentFor(task, session),
      // These are processes that are still up, and borrowing one means writing a prompt into it.
      continuation: 'live'
    })
    if (refusal === null) offerable.push(session)
    // ⛔ Only `context-too-full`. A conversation held back by any other gate must never be compacted
    // on this task's behalf: the compaction would be spent on a conversation this task still could
    // not have, which is the fleet paying for a saving nobody can collect.
    else if (refusal === 'context-too-full' && wantsCompactionToShare(session)) full.push(session)
  }

  const ranked = rank(offerable)
  const best = ranked[0]
  if (best) {
    log.debug(
      `t${task.seq} may borrow the conversation ${best.id.slice(0, 8)} in ${best.cwd} ` +
        `(${ranked.length} candidate(s) in this project)`
    )
  }
  return { offerable: ranked, full }
}

/**
 * What this task would be run as *in this conversation's account*.
 *
 * ⛔ The same `resolveModelChoice` the dispatch reaches, against the same worker, so the comparison
 * that decides whether a conversation may be borrowed is made against the answer a borrow would
 * actually produce rather than a second guess at it.
 */
function intentFor(task: Task, session: Session): ShareIntent {
  const worker = getWorker(session.workerId)
  const canSetEffort = adapter(session.adapterId).info.capabilities.selectableEffort
  const choice = resolveModelChoice(task.constraints, worker, canSetEffort, lastQuota(session.workerId))
  return { model: choice.model, effort: choice.effort }
}

/**
 * The *finished* conversations of other tasks that this one may reopen.
 *
 * ⭐ **The other half of reuse across tasks, and the half that is nearly always the available one.**
 * `borrowCandidates` can only offer a conversation that is still up, and completing a task closes
 * its session — so on any fleet that finishes what it starts, the warm prefixes are almost all in
 * conversations nobody is talking in. Reviving one is `--resume` on a closed id: measured
 * 2026-08-28, that turn read back **41,542** cached tokens and wrote 65, against a cold start that
 * rebuilds the whole prefix. This is what makes the project's instructions, skills and file layout
 * something the fleet pays for once instead of once per task.
 *
 * ⛔ Every gate `borrowCandidates` applies, applied here too, and for the same reasons — the setting
 * is the same setting, the account, model and effort must still match, and a conversation past the
 * share ceiling is still a false economy. ⚠️ `hasWorkspace: true` because the borrower brings its
 * own: the tree is claimed before this is asked, and `resumableSession` refuses anything whose
 * `cwd` is not that same directory. `leased` is asked of the runs, because a session row marked
 * closed while its run is still open is precisely the disagreement that hands one conversation to
 * two agents.
 */
function lendableConversations(task: Task, workerId: string): Session[] {
  if (!task.projectId) return []
  const project = getProject(task.projectId)
  if (resolveSessionSharing(task, project).sharing !== 'on') return []

  const own = new Set(pastSessionsFor(task).map((s) => s.id))
  const candidates = finishedConversationsIn(task.projectId, workerId).filter((session) => {
    if (own.has(session.id)) return false
    return (
      whyNotShared(task, session, {
        hasWorkspace: true,
        leased: hasOpenRun(session.id),
        intent: intentFor(task, session),
        // ⭐ `revive`, and this is what `codex exec resume` bought: these conversations are closed,
        // so reopening one spawns a fresh process and a one-shot CLI is as able to do that as any
        // other. Gating them `live` would refuse every codex prefix the fleet has ever built.
        continuation: 'revive'
      }) === null
    )
  })
  return rank(candidates)
}

/**
 * The conversations a queued task would borrow if they were not so full.
 *
 * ⭐ **The one place the scheduler tells the clock about a saving only the queue can see.** Move 4
 * compacts a session when it is expected to sit idle past the ~2h break-even; a conversation three
 * tasks are waiting on is the opposite case — it is wanted *now*, and it is exactly the one a pure
 * idle estimate will never nominate. ⚠️ Computed from the tasks that were actually held this tick,
 * so a fleet with nothing queued asks for nothing.
 */
export function sessionsWantedForBorrow(tasks: Task[]): Set<string> {
  const wanted = new Set<string>()
  for (const task of tasks) {
    const { offerable, full } = borrowCandidates(task)
    // ⛔ Only when nothing is already borrowable. A task with a conversation it can join right now
    // has no reason to spend anybody's tokens shrinking a different one.
    if (offerable.length > 0) continue
    for (const session of full) wanted.add(session.id)
  }
  return wanted
}

/** Has somebody already been granted the right to speak next in this conversation? */
function leaseHeld(sessionId: string): boolean {
  return (availability(sessionLeaseId(sessionId))?.free ?? 1) < 1
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
 * The conversation this task was already having on this account, closed but reopenable.
 *
 * ⭐ **The half of "a session already holds this task" that a one-shot CLI can ever have.**
 * `warmSessionFor` can only offer a conversation with a live process, and `codex exec` reads one
 * prompt, runs one turn and exits — so on that adapter there is never a live idle session, and every
 * candidate scored `affinity 0 · warm 0 · cold 1` no matter how recently it had done the work. The
 * dispatch knew better all along: it calls `resumableSession` and reopens the conversation. The score
 * simply could not see what the dispatch was about to do.
 *
 * ⛔ Measured on this install, 2026-09-02. t123 ran on CodexFirst 18:34–18:42, leaving session
 * `bffdc5d2` closed with 175,626 tokens of its context. Asked at 19:02 to retry the commit — twenty
 * minutes later, inside any plausible TTL — the retry scored a cold ClaudeThird above it and rebuilt
 * everything from nothing, because the only thing that could have said otherwise was structurally
 * unavailable to a `streamPrompts: 'once'` adapter.
 *
 * ⚠️ **Not filtered on cache warmth**, deliberately, and `warm` is the term that carries that. A
 * conversation whose prefix has lapsed still remembers the task, which is the greater part of why
 * reopening it beats starting over; it just no longer comes with a discount, and scoring it as though
 * it did would be the lie this function exists to stop telling.
 *
 * ⚠️ **No `mismatch(pinned(task), …)` check, unlike `warmSessionFor`, and the asymmetry is real
 * rather than an oversight.** A prompt sent into a *live* conversation is served by the process
 * already running it, so a pinned model cannot be applied and the warm path has to refuse. A resume
 * spawns a new process and `plan()` passes `--model` to it, so the pin is honoured. Same reason
 * `resumableSession` does not check it either — and this must ask exactly what the dispatch asks.
 */
function reopenableFor(task: Task, workerId: string): Session | null {
  for (const session of pastSessionsFor(task)) {
    if (reopenable(session, workerId)) return session
  }
  return null
}

/**
 * Hard gates. Failing one discards the candidate rather than queueing behind it, because a task that
 * cannot run on worker A may run on worker B right now.
 *
 * ⛔ The gates ask capabilities, never adapter names.
 */
/**
 * The account a conversation is already being had on.
 *
 * ⛔ **Conversations only, and it wins outright rather than adding to a score.** Warmth is one
 * weighted term among nine, so an ordinary task coming back from `awaiting_human` can be routed to
 * whichever account looks cheapest this minute — right for unattended work, and wrong for a thread a
 * person is talking in, where switching accounts silently swaps the model, drops every turn of
 * context and answers the operator's next sentence as a stranger. A conversation's whole value is
 * that it is the *same* conversation.
 *
 * ⛔ **The two escapes are the candidate list, not a special case here**, which is what makes them
 * trustworthy. A person who presses Reassign writes `constraints.workerId`, and the loop above
 * already skips every other worker — so the sticky account is either the one they picked or not in
 * the list at all. An account that has spent its window is removed by the quota gate. In both cases
 * this finds nothing and the ordinary scoring decides, which is exactly the fallback that was asked
 * for: change accounts when a person says so, or when the window runs out, and never otherwise.
 *
 * ⚠️ The most recent session that still exists, by run start. A conversation whose session was
 * evicted still names its account — reviving a closed conversation on the account that holds its
 * transcript is the same continuity, one rung colder.
 */
function stickyWorkerFor(task: Task): string | null {
  if (task.kind !== 'conversation') return null
  const runs = [...runsFor(task.id)].sort((a, b) => b.startedAt - a.startedAt)
  for (const run of runs) {
    if (!run.sessionId) continue
    const session = getSession(run.sessionId)
    if (session) return session.workerId
  }
  return null
}

export function chooseTarget(task: Task, random = Math.random): WorkerChoice {
  const reasons: string[] = []
  /**
   * When the workers held on quota get their windows back — the earliest of them.
   *
   * ⛔ Collected as the gate fires rather than recomputed afterwards, so the number the operator is
   * shown is read from the very sample that refused the dispatch. A second lookup would be a second
   * chance to name a different window.
   */
  let quotaHoldUntil: number | null = null
  let quotaUnverified = false
  // ⚠️ Read once, at the top, so every gate below and the message the dispatch posts all agree about
  // whether a person has overruled the water mark — a tick that changed its mind halfway through
  // would dispatch under an override and then report that there was none.
  const override = quotaOverridden(task)
  const project = task.projectId ? getProject(task.projectId) : undefined
  const objective = resolveObjective(project?.config?.objective, task.objective, settings().objective)
  const w = weights(objective)
  // ⛔ Once per decision, not once per candidate. See `scoreCandidate`'s `pace` parameter.
  const pace = paceFactors()

  // ⛔ Compute task complexity once per decision, not once per candidate.
  const complexity = complexityOf(task)

  /**
   * Whether the `fitness` and `price` terms are live at all. See `modelRoutingActive`.
   *
   * ⛔ Read once per decision, so every candidate in one field is scored under the same rule. A
   * worker commissioned midway through a loop that flipped this would otherwise be compared on a
   * model against candidates that were not.
   */
  const modelRouting = modelRoutingActive()
  /**
   * ⛔ Loaded once per decision, not once per candidate — `paceFactors()` above is hoisted for
   * exactly this reason. `qualityReport()` reads the whole reviews table and runs four more counting
   * queries; calling it inside the candidate loop made a fleet of five accounts with eight routable
   * models each do forty full table scans per task per tick, and the scheduler ticks every 10s.
   * ⚠️ Skipped entirely when the terms are inert: nothing reads it, so nothing should pay for it.
   */
  const qualityKeys = modelRouting ? qualityReport().keys : []

  // ⚠️ Memoise estimateTask per (adapterId, model, warm) for the duration of this decision.
  const estimateCache = new Map<string, Estimate>()
  function cachedEstimate(adapterId: string | null, model: string | null, warm: boolean): Estimate {
    const key = `${adapterId ?? ''}:${model ?? ''}:${warm}`
    let est = estimateCache.get(key)
    if (!est) {
      est = estimateTask(task, {
        adapterId: adapterId ?? null,
        ...(model ? { model } : {}),
        warm
      })
      estimateCache.set(key, est)
    }
    return est
  }

  interface RawCandidate {
    worker: Worker
    session: Session | null
    resumable: Session | null
    model: string | null
    quotaUnverified: boolean
    trustedWindows: QuotaWindow[]
    estimate: Estimate
  }
  const rawCandidates: RawCandidate[] = []

  for (const worker of listWorkers()) {
    if (task.constraints.workerId && task.constraints.workerId !== worker.id) continue
    if (task.constraints.workerIds && task.constraints.workerIds.length > 0 && !task.constraints.workerIds.includes(worker.id)) continue
    if (task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId) continue

    // ⛔ Role gate: an account that does not do work is not offered work. `controller` is reserved
    // for judgment/consults; `none` is held out of both, on purpose, while staying commissioned.
    if (!canWork(worker.role)) {
      reasons.push(
        worker.role === 'none'
          ? `${worker.label} is held out of both work and judgment`
          : `${worker.label} is controller only`
      )
      continue
    }

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
    //
    // ⛔ **The session this task would reuse is not counted, because reusing it starts no process.**
    const reuse = warmSessionFor(task, worker.id)
    const sessions = sessionsForWorker(worker.id)
    const retained = retainedReservations(worker.id, sessions)
    if (atCapacity(sessions, worker.maxConcurrent, reuse, retained)) {
      reasons.push(`${worker.label} at capacity`)
      continue
    }

    const resumable = reuse ? null : reopenableFor(task, worker.id)
    const held = reuse ?? resumable

    // Determine candidate models for this worker:
    // ⛔ A warm or reopenable conversation pins the model.
    // ⛔ A task that pinned a model gets exactly one pair.
    let candidateModels: Array<string | null>
    if (held?.model) {
      candidateModels = [held.model]
    } else if (task.constraints.model) {
      candidateModels = [task.constraints.model]
    } else if (task.constraints.modelsByWorker && task.constraints.modelsByWorker[worker.id]) {
      candidateModels = [task.constraints.modelsByWorker[worker.id]!]
    } else {
      candidateModels = routableModelsFor(worker)
    }

    // Bound the fan-out: cap candidate models per worker to 8
    if (candidateModels.length > 8) {
      log.info(`t${task.seq}: capping candidate models for ${worker.label} from ${candidateModels.length} to 8`)
      candidateModels = candidateModels.slice(0, 8)
    }

    const quota = lastQuota(worker.id)

    // ⭐ **The quota-pool gate is per (worker, model), not per worker.** Antigravity meters Gemini
    // apart from Claude/GPT, so an account can be spent for one pool and untouched for the other;
    // hoisted out here it held a Gemini pair out because the Claude window was full.
    // ⚠️ Named in the operator's reason only when this worker is actually offering more than one
    // model — "(claude-opus-5)" appended to every refusal on a single-model fleet is noise that says
    // nothing, since there was never another pair it could have meant.
    const namesModel = candidateModels.length > 1
    for (const model of candidateModels) {
      let trustedWindows: QuotaWindow[] = []
      if (quota && !quota.stale) {
        const pool = poolFor(worker, model)
        const applicable = windowsForPool(quota.windows, pool)
        const active: QuotaWindow[] = []
        let blockingWindow: QuotaWindow | null = null

        for (const win of applicable) {
          if (windowExpired(win)) {
            quotaUnverified = true
          } else {
            active.push(win)
            if (win.percent >= QUOTA_HIGH_WATER) {
              if (!blockingWindow || win.percent > blockingWindow.percent) {
                blockingWindow = win
              }
            }
          }
        }
        trustedWindows = active

        if (blockingWindow) {
          if (override) {
            log.info(
              `t${task.seq} dispatching to ${worker.label}${namesModel ? ` (${model ?? 'default'})` : ''} at ${Math.round(blockingWindow.percent)}% of its ` +
                `${blockingWindow.label ?? '5h'} window — a person overrode the ${QUOTA_HIGH_WATER}% gate`
            )
          } else {
            const modelSuffix = namesModel ? ` (${model ?? 'default'})` : ''
            reasons.push(
              `${worker.label}${modelSuffix} at ${Math.round(blockingWindow.percent)}% of its ${blockingWindow.label ?? '5h'} window`
            )
            const resetsAt = blockingWindow.resetsAt ?? windowResetsAt(worker.id)?.at ?? null
            if (resetsAt && resetsAt > Date.now()) {
              quotaHoldUntil = quotaHoldUntil === null ? resetsAt : Math.min(quotaHoldUntil, resetsAt)
            }
            continue
          }
        }
      } else {
        quotaUnverified = true
      }

      const session = reuse
      const estimate = cachedEstimate(worker.adapterId, model, !!held)
      rawCandidates.push({
        worker,
        session,
        resumable,
        model,
        quotaUnverified,
        trustedWindows,
        estimate
      })
    }
  }

  if (rawCandidates.length === 0) {
    return {
      worker: null,
      session: null,
      reason: reasons.length ? reasons.join('; ') : 'no eligible worker',
      quotaUnverified,
      score: 0,
      holdUntil: quotaHoldUntil
    }
  }

  // Field-wide price normalization: compare like with like
  const allHaveUsd = rawCandidates.every(
    (c) => c.estimate.usd !== null && c.estimate.usd > 0
  )
  let priceUnit: 'usd' | 'pricedTokens' | 'none' = 'none'
  let cheapestCost = 0
  if (allHaveUsd) {
    priceUnit = 'usd'
    cheapestCost = Math.min(...rawCandidates.map((c) => c.estimate.usd!))
  } else {
    const allHaveTokens = rawCandidates.every(
      (c) => c.estimate.pricedTokens !== null && c.estimate.pricedTokens > 0
    )
    if (allHaveTokens) {
      priceUnit = 'pricedTokens'
      cheapestCost = Math.min(...rawCandidates.map((c) => c.estimate.pricedTokens))
    }
  }

  const candidates: WorkerChoice[] = []
  for (const c of rawCandidates) {
    // Fitness term: sufficiency bar
    const required = { low: 0.35, medium: 0.55, high: 0.75 }[complexity.band]
    const fit = modelRouting ? fitnessFor(c.worker.adapterId, c.model, qualityKeys) : null
    let fitnessValue: number
    let fitnessBasis: string
    if (!fit) {
      // ⛔ Nobody has opted in, so there is no model *choice* here to score. See
      // `modelRoutingActive`: every worker is offering the one model it already uses, and grading
      // that model against a benchmark prior would silently re-rank an existing fleet on upgrade.
      fitnessValue = 0
      fitnessBasis = INERT_BASIS
    } else if (fit.value === null) {
      fitnessValue = 0
      fitnessBasis = 'no public benchmark and no clean review covers this pair'
    } else {
      fitnessValue = Math.max(0, Math.min(1, 1 - Math.max(0, required - fit.value) / 0.25))
      fitnessBasis = `${fit.value.toFixed(2)} blended fitness (required ${required.toFixed(2)} for ${complexity.band} complexity); ${fit.basis}`
    }

    // Price term: penalty relative to cheapest in field
    const thisCost =
      priceUnit === 'usd'
        ? c.estimate.usd!
        : priceUnit === 'pricedTokens'
          ? c.estimate.pricedTokens
          : 0
    let priceValue: number
    let priceBasis: string
    if (!modelRouting) {
      // ⛔ Same gate as `fitness`, and for the same reason: with one model per worker this term
      // would price a choice nobody is making. `warm`, `cold`, `quotaRisk` and `projectSwitch`
      // already carry cost on an un-opted-in fleet, exactly as they did before this landed.
      priceValue = 0
      priceBasis = INERT_BASIS
    } else if (priceUnit === 'none' || cheapestCost <= 0) {
      priceValue = 0
      priceBasis = 'unmeasurable (neither money nor priced tokens available)'
    } else {
      const ratio = thisCost / cheapestCost
      priceValue = Math.max(0, Math.min(1, Math.log(ratio) / Math.log(8)))
      if (priceUnit === 'usd') {
        priceBasis = `$${thisCost.toFixed(4)} estimated ($${cheapestCost.toFixed(4)} cheapest in field; 8× scale)`
      } else {
        priceBasis = `${Math.round(thisCost).toLocaleString()} priced tokens (${Math.round(cheapestCost).toLocaleString()} cheapest in field; money unpriceable for at least one candidate)`
      }
    }

    const breakdown = scoreCandidate(
      task,
      c.worker,
      c.session,
      c.resumable,
      w,
      c.trustedWindows,
      pace,
      c.model,
      { value: fitnessValue, basis: fitnessBasis },
      { value: priceValue, basis: priceBasis }
    )

    candidates.push({
      worker: c.worker,
      session: c.session,
      resumable: c.resumable,
      reason: '',
      quotaUnverified: c.quotaUnverified,
      model: c.model,
      score: breakdown.total,
      breakdown
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0] as WorkerChoice
  const second = candidates[1]

  /**
   * The winner, with the whole ranked field attached so `dispatch` can write it down.
   *
   * ⛔ Built from the same `breakdown` objects that produced the ordering. Nothing here recomputes a
   * score; a second implementation of the arithmetic is the one thing that would make this ledger
   * worse than useless, because it would look authoritative and disagree.
   */
  const decided = (winner: WorkerChoice, basis: RoutingBasis): WorkerChoice => ({
    ...winner,
    objective,
    routedBy: basis,
    // ⚠️ Eight, not four. The consult shortlist is four because a controller reading more than that
    // is paying for prose it will not use; a person auditing a decision months later wants the field.
    scored: candidates.slice(0, 8).map((c) => ({
      workerId: (c.worker as Worker).id,
      label: (c.worker as Worker).label,
      adapterId: (c.worker as Worker).adapterId,
      model: c.model ?? null,
      warm: !!c.session,
      quotaUnverified: c.quotaUnverified,
      score: c.score,
      chosen: (c.worker as Worker).id === winner.worker?.id && (c.model ?? null) === (winner.model ?? null),
      terms: c.breakdown?.terms ?? []
    }))
  })

  function finalizeChoice(choice: WorkerChoice): WorkerChoice {
    const res = exploreRoute({
      task,
      winner: choice,
      candidates,
      complexity,
      settings: settings(),
      random
    })
    if (res.explored) {
      addMessage(
        task.id,
        'system',
        `Model exploration: trying ${res.choice.model ?? 'default'} on ${res.choice.worker?.label} instead of ${res.originalWinner?.model ?? 'default'}, which arithmetic scored highest.`
      )
      return res.choice
    }
    return choice
  }

  // ---- the routing judgment event, and every reason not to fire it -------------------------
  //
  // ⛔ Read the conditions rather than the call: this asks for judgment only when the arithmetic has
  // genuinely failed to separate two candidates AND the task is large enough that ε is worth more
  // than the turn. On a one-worker fleet, on a small task, or on any clear win, nothing is spent.
  // ⚠️ `pinned` when the task named its account: one candidate is not a decision the arithmetic made,
  // and a table that called it `score` would claim a comparison that never happened.
  // ⛔ Before the tie-break, the consult and the score, because it is not a preference between
  // candidates — it is the statement that this task already has a conversation. See `stickyWorkerFor`.
  const sticky = stickyWorkerFor(task)
  if (sticky) {
    const stayed = candidates.find((c) => c.worker?.id === sticky)
    if (stayed) return finalizeChoice(decided(stayed, 'sticky'))
  }

  const isPinned = Boolean(
    task.constraints.workerId ||
      task.constraints.model ||
      (task.constraints.modelsByWorker && best.worker && task.constraints.modelsByWorker[best.worker.id])
  )
  const eligibleWorkerCount = new Set(candidates.map((c) => c.worker?.id).filter(Boolean)).size
  if (eligibleWorkerCount <= 1 || task.kind === 'plan') {
    return finalizeChoice(decided(best, isPinned ? 'pinned' : 'score'))
  }
  // ⚠️ For the *best* candidate, not the fleet. The floor asks "is this task big enough to be worth
  // a controller turn", and on an agent whose runs cost 12x the fleet median the same work clears a
  // floor it would not clear elsewhere — which is the honest answer to the question being asked.
  const estimate = cachedEstimate(
    best.worker?.adapterId ?? null,
    best.model ?? best.session?.model ?? null,
    !!best.session
  ).tokens
  const tie = second !== undefined && Math.abs(best.score - second.score) <= ROUTE_EPSILON
  if (!tie || estimate < ROUTE_CONSULT_FLOOR_TOKENS) return finalizeChoice(decided(best, 'score'))

  const answered = latestAnswer('route', task.id, ROUTE_ANSWER_MAX_AGE_MS) as
    | { workerId?: string; model?: string }
    | null
  if (answered?.workerId) {
    // ⛔ Validated again, here, against the candidate set that exists *now*. The fleet the controller
    // was shown is minutes old; an account can be disabled or hit its window in between.
    const matching = candidates.filter((c) => c.worker?.id === answered.workerId)
    if (matching.length > 0) {
      // ⚠️ The named pair, then the worker's best pair — never nothing. `validateRoute` accepts a
      // bare `workerId` and resolves it to the worker's highest-scoring pair; the same answer must
      // survive here, because the field is re-derived and a pair the controller was shown can have
      // left it since (its quota pool crossed the water mark, its model came off the allowlist).
      // Discarding a valid account because one model of it vanished would throw away the consult
      // that was already paid for and fall through to asking the same question again.
      const named = answered.model ? matching.find((c) => c.model === answered.model) : undefined
      const picked = named ?? [...matching].sort((a, b) => b.score - a.score)[0]
      if (picked) return finalizeChoice(decided(picked, 'controller'))
    }
  }

  if (hasPendingConsult('route', task.id)) {
    return {
      ...best,
      worker: null,
      deferred: true,
      reason: 'waiting on a routing decision (the top score is used if none arrives)'
    }
  }

  // ⛔ Do not spend tokens asking the controller if any of the tied candidates has unverified/stale
  // quota that can be refreshed. Stale quota zeroes out windowRisk and manufactures false ties.
  // Refresh the tied candidates first; if fresh numbers break the tie or gate a worker, no consult
  // is needed.
  const tied = candidates.filter((c) => Math.abs(best.score - c.score) <= ROUTE_EPSILON)
  const refreshing = tied.map((c) => (c.worker ? needsBaseline(c.worker) : null)).filter(Boolean)
  if (refreshing.length > 0) {
    return {
      ...best,
      worker: null,
      deferred: true,
      reason: 'reading quota for tied candidates before asking the controller'
    }
  }

  // Dedupe consult shortlist to one pair per worker before slicing
  const seenWorkers = new Set<string>()
  const dedupedByWorker: WorkerChoice[] = []
  for (const c of candidates) {
    const wid = c.worker?.id
    if (wid && !seenWorkers.has(wid)) {
      seenWorkers.add(wid)
      dedupedByWorker.push(c)
    }
  }
  const shortlist: RouteCandidate[] = dedupedByWorker.slice(0, 4).map((c) => ({
    worker: c.worker as Worker,
    model: c.model ?? null,
    score: c.score,
    warm: !!c.session,
    note: c.quotaUnverified ? 'quota reading not trustworthy' : '',
    // ⛔ Both are built from the *same* breakdown, once. The brief line goes in the question and the
    // table goes in the detail; a second implementation of either could drift from the ordering.
    ...(c.breakdown
      ? { considered: briefScore(c.breakdown), formula: formatScore(c.breakdown) }
      : {})
  }))
  const queued = enqueueConsult({
    kind: 'route',
    subjectId: task.id,
    question: routeQuestion(task, shortlist),
    // ⚠️ Generated in full and stored, never sent: this is what a person reads in the judgment-call
    // UI when they want to check the arithmetic rather than the answer.
    detail: routeDetail(task, shortlist, scoreLegend(objective))
  })
  if (!queued) return finalizeChoice(decided(best, 'score'))
  return {
    ...best,
    worker: null,
    deferred: true,
    reason: 'asked the controller which worker; the top score is used if no answer arrives'
  }
}

/**
 * Ask the controller to name one long task, where the operator has asked for that.
 *
 * ⛔ **One per tick, and only behind `summariseTitles`.** This is the only consult that spends a turn
 * without changing what the fleet does, so it is opted into (settings.ts) and rationed: an install
 * that switches it on with two hundred unlabelled tasks on the board queues them a tick at a time
 * rather than commissioning two hundred questions at once. The 24-hour cooldown in `COOLDOWN_MS`
 * stops any one task being asked about twice — including a task the controller declined to label,
 * which would otherwise be picked up again on the very next tick, forever.
 *
 * ⚠️ Swept rather than fired at task creation, so turning the setting on labels the board an operator
 * already has, not only what they file next. Finished work is skipped: a label is for a board still
 * being read, and buying one for a task nobody will look at again is the purest waste available.
 */
function askForTitle(): void {
  if (!settings().summariseTitles) return
  const next = listTasks().find(
    (t) =>
      !t.titleSummary &&
      t.title.length > TITLE_SUMMARY_THRESHOLD &&
      !['completed', 'cancelled', 'failed'].includes(t.status)
  )
  if (!next) return
  enqueueConsult({ kind: 'title', subjectId: next.id, question: titleQuestion(next) })
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
 * Below this share of a window, being partly spent is not yet a reason to prefer anyone else.
 *
 * ⛔ **Not zero, deliberately.** A term that rises from the first token makes the scheduler prefer
 * the emptiest account always, which is a *load balancer*, not a risk model — and it would fight the
 * one preference this cost model exists to express, that a warm session is the cheapest thing
 * available. Half a window is the point past which finishing a large task on that account stops
 * being a safe assumption.
 */
export const QUOTA_RISK_FLOOR = 50

/**
 * How risky is this window, as a slope rather than a switch.
 *
 * ⭐ **The term t39–t42 needed and did not have.** Until 2026-08-30 `quotaRisk` was binary and both
 * of its triggers were unreachable on this fleet: `at_risk` needs `remainingTokens` in tokens (R2,
 * still open) and the live rate-limit status only turns after the vendor has already refused. So it
 * read 0 for every worker, always, and two accounts — one at 64% of its weekly, one at 98% of a
 * five-hour pool — scored identically through four consecutive routing consults.
 *
 * ⭐ **It saturates exactly where the hard gate begins.** `windowRisk(QUOTA_HIGH_WATER) === 1`, and
 * at that same percentage the candidate is excluded outright, so the soft preference hands over to
 * the cliff with no step in between. A worker is never nearly-excluded and cheap at the same time.
 *
 * ⛔ **Only ever called with a reading the caller already decided to trust.** A stale percentage
 * scoring anything at all is the fault AGENTS.md names: only checked evidence may move a score, and
 * a number nobody re-read is not evidence. Absence of a reading is 0, not a guess.
 */
export function windowRisk(
  percent: number,
  highWater = QUOTA_HIGH_WATER,
  floor = QUOTA_RISK_FLOOR,
  resetsAt?: number | null,
  now = Date.now(),
  windowIdOrLabel?: string
): number {
  if (!Number.isFinite(percent) || percent <= floor) return 0
  const base = highWater <= floor ? 1 : (percent - floor) / (highWater - floor)
  if (!resetsAt || resetsAt <= now) {
    return Math.min(1, base)
  }

  const isWeekly =
    windowIdOrLabel &&
    (windowIdOrLabel.includes('weekly') ||
      windowIdOrLabel.includes('7d') ||
      windowIdOrLabel.includes('Weekly'))
  const is5h =
    windowIdOrLabel &&
    (windowIdOrLabel.includes('5h') || windowIdOrLabel === 'session')
  const durationMs = isWeekly
    ? 7 * 24 * 3600 * 1000
    : is5h
      ? 5 * 3600 * 1000
      : resetsAt - now > 24 * 3600 * 1000
        ? 7 * 24 * 3600 * 1000
        : 5 * 3600 * 1000

  const timeRemainingMs = resetsAt - now
  const fTime = Math.min(1.0, Math.max(0.01, timeRemainingMs / durationMs))
  const fQuota = Math.max(0.01, (100 - percent) / 100)

  const pressureRatio = fTime / fQuota
  const factor = Math.min(2.0, Math.max(0.5, pressureRatio))
  return base * factor
}

function formatResetDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.round(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h`
  const days = Math.floor(totalHours / 24)
  const remainingHours = totalHours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
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
  // ⛔ `freshRateLimit`: a status is only evidence while it still describes the account. Read from
  // `lastRateLimit`, one `allowed_warning` saturated this term for as long as nothing else ran on
  // the worker - and nothing else runs on a worker this term has just pushed to the back of the
  // queue. Routing *should* still flinch at a weekly warning, so the window is deliberately not
  // narrowed here the way the preemption gate narrows it: being ranked lower costs a worker a
  // dispatch, where being preempted costs it a session.
  const rate = freshRateLimit(workerId)
  return reserve.verdict === 'at_risk' || (rate && rate.status !== 'allowed') ? 1 : 0
}

/**
 * ⛔ Every term is a continuous function of the objective vector, never a switch on a mode name. The
 * two requirements the plan wanted fall out of the arithmetic rather than needing features:
 * "add X, test X, document X" lands on one session because `warm` and `affinity` both peak there, and
 * three big independent tasks go to three workers whole because `cold` prices the alternative.
 */
/**
 * One term of the routing score, kept as its parts rather than as a total.
 *
 * ⛔ **Because a number with no derivation cannot be checked, and this one was wrong in a way nobody
 * could see.** Measured on t39–t42 (2026-08-30): ClaudeSecond and Antigravity scored an identical
 * `-0.120` on four consecutive routing consults while holding completely different windows — one at
 * 64% of its weekly, the other at 98% of a five-hour pool. The controller was handed two equal
 * numbers and no way to tell them apart, and spent a turn each time guessing from the worker labels.
 *
 * ⚠️ Every field exists to answer a question a bare number provokes: *where did this weight come
 * from* (`weightFormula`), *why is the value what it is* (`basis`), and *which direction helps*
 * (`sign`). A term that cannot answer all three is not explainable and should not be scored.
 */
export interface ScoreTerm {
  name: string
  /** The objective weight — identical for every candidate, since it derives from the vector alone. */
  weight: number
  /** That weight's own arithmetic, e.g. `0.8 + 2.0×cost − 0.7×velocity`. From `WEIGHT_FORMULAS`. */
  weightFormula: string
  /** What this candidate measured for the term, normally 0..1. */
  value: number
  /** Where that value came from, in words — the reading, the count, or the absence behind it. */
  basis: string
  /** `+1` for terms that help, `-1` for penalties — the sign as it appears in the sum. */
  sign: 1 | -1
  /** `sign * weight * value`. Summing this over every term gives `total`. */
  contribution: number
}

export interface ScoreBreakdown {
  total: number
  terms: ScoreTerm[]
}

/** The direction each weight pushes. ⛔ Must match the signs used in `scoreCandidate`. */
const SIGN_OF: Record<keyof ReturnType<typeof weights>, 1 | -1> = {
  warm: 1,
  affinity: 1,
  contextRot: -1,
  projectSwitch: -1,
  quotaRisk: -1,
  cold: -1,
  capabilityFit: 1,
  // ⛔ `+1` with a **signed** value, which is why it is not listed as a penalty. See `paceValue`:
  // the term is positive for an agent measured faster than the fleet's centre and negative for one
  // measured slower, so a single direction here would be a lie about half of its range.
  pace: 1,
  fitness: 1,
  price: -1
}

/** `score = Σ sign × weight × value`, and nothing else. */
function breakdownOf(
  parts: Array<[string, number, string, number, 1 | -1, string]>
): ScoreBreakdown {
  const terms = parts.map(([name, weight, weightFormula, value, sign, basis]) => ({
    name,
    weight,
    weightFormula,
    value,
    basis,
    sign,
    contribution: sign * weight * value
  }))
  return { total: terms.reduce((sum, t) => sum + t.contribution, 0), terms }
}

/**
 * The shared header: what a score *is*, before any candidate's numbers are read.
 *
 * ⛔ **Printed once, above the candidates, because the weights do not vary between them.** Repeating
 * eight identical weight derivations per candidate would bury the only thing that differs — the
 * values — and that is the whole question being asked.
 *
 * ⚠️ It states the three things a bare number cannot: **higher wins**, the scale is **linear and
 * unitless** (nothing here is logarithmic, normalised or capped), and gaps at or below ε are treated
 * as no difference at all.
 */
export function scoreLegend(objective: Objective, epsilon = ROUTE_EPSILON): string[] {
  const w = weights(objective)
  const vector =
    `cost ${objective.cost.toFixed(2)} · velocity ${objective.velocity.toFixed(2)} · ` +
    `quality ${objective.quality.toFixed(2)}`
  const names = Object.keys(WEIGHT_FORMULAS) as Array<keyof typeof WEIGHT_FORMULAS>
  return [
    'A score is the sum of (± weight × value). HIGHER WINS. The scale is linear and unitless —',
    'nothing is logarithmic, normalised or capped — so a gap of 0.2 is exactly twice a gap of 0.1',
    `and means only that one candidate is preferred by that much. A gap of ${epsilon} or less counts`,
    'as no difference at all, which is why this question is being asked.',
    '',
    `Weights come from the objective vector — ${vector} — set in Settings > Global.`,
    'They are IDENTICAL for every candidate below; only the values differ.',
    '',
    `  ${'term'.padEnd(14)} ${'dir'.padEnd(7)} ${'weight = f(objective)'.padEnd(38)} value means`,
    ...names.map(
      (name) =>
        `  ${name.padEnd(14)} ${(SIGN_OF[name] === 1 ? 'bonus' : 'penalty').padEnd(7)} ` +
        `${(w[name].toFixed(3) + ' = ' + WEIGHT_FORMULAS[name]).padEnd(38)} ${VALUE_MEANS[name]}`
    ),
    `  ${'unproven'.padEnd(14)} ${'penalty'.padEnd(7)} ` +
      `${(UNPROVEN_PENALTY.toFixed(3) + ' = fixed, not from the objective').padEnd(38)} ` +
      `${VALUE_MEANS.unproven}`
  ]
}

/** What a value of 1 would mean for each term, so a reader knows which end is which. */
const VALUE_MEANS: Record<string, string> = {
  // ⚠️ Not "a full hour". The denominator is the provider's own TTL — 60m on Anthropic, 30m on
  // codex — so the term compares fractions of a cache across providers rather than minutes.
  warm: '1 = a full TTL of prompt cache left',
  affinity: '1 = a conversation already holds this task, live or reopenable',
  contextRot: '1 = the context window is full',
  projectSwitch: '1 = the session is on another project',
  quotaRisk: `1 = at ${QUOTA_HIGH_WATER}% of its window (adjusted for reset horizon; 0 below ${QUOTA_RISK_FLOOR}%)`,
  cold: '1 = no conversation to reuse, live or reopenable',
  capabilityFit: '1 = every capability the task needs is present',
  // ⚠️ The only signed value in the table, and the only one whose 0 is a *middle* rather than a
  // floor: 0 is both "exactly the fleet's median pace" and "nothing measured yet".
  pace: '+1 = measured 4x faster than the fleet median task, -1 = 4x slower, 0 = unmeasured',
  fitness: '1 = meets sufficiency bar for task complexity, 0 = 0.25 below bar or unmeasured',
  price: '0 = cheapest candidate in field, 1 = 8x or more expensive than cheapest',
  unproven: '1.5 max = never probed and never worked'
}

/**
 * One candidate's numbers, as lines under its name.
 *
 * ⚠️ **Zero terms are printed, not dropped.** A derivation showing only what contributed reads as
 * though the rest had been weighed and found small; printing `0` beside its basis is what shows that
 * `quotaRisk` is not small but *unmeasurable on this fleet*, which was the finding.
 */
export function formatScore(b: ScoreBreakdown): string[] {
  return [
    `  ${'term'.padEnd(14)} ${'value'.padStart(6)} × ${'weight'.padStart(6)} = ${'contrib'.padStart(7)}   why the value is that`,
    ...b.terms.map(
      (t) =>
        `  ${t.name.padEnd(14)} ${t.value.toFixed(2).padStart(6)} × ` +
        `${((t.sign < 0 ? '-' : '+') + t.weight.toFixed(3)).padStart(6)} = ` +
        `${((t.contribution >= 0 ? '+' : '-') + Math.abs(t.contribution).toFixed(3)).padStart(7)}   ${t.basis}`
    ),
    `  ${'TOTAL'.padEnd(14)} ${' '.repeat(6)}   ${' '.repeat(6)} = ` +
      `${((b.total >= 0 ? '+' : '-') + Math.abs(b.total).toFixed(3)).padStart(7)}`
  ]
}

/**
 * One line of the same breakdown: what actually moved the score, and what could not be read.
 *
 * ⛔ **This is what the controller is shown, and it is the whole finding from t39–t42 in a line.**
 * Two candidates on `-0.120` with no live term between them is a *measurement gap*, and naming the
 * dead terms says so outright — where a table of zeroes reads as though they had been weighed and
 * found small. The full table still exists; it is on the consult's `detail`, for a person.
 *
 * ⚠️ Terms rounding to zero are named, not dropped, for exactly that reason.
 */
export function briefScore(b: ScoreBreakdown): string {
  const live = b.terms.filter((t) => Math.abs(t.contribution) >= 0.0005)
  const dead = b.terms.filter((t) => Math.abs(t.contribution) < 0.0005).map((t) => t.name)
  const parts = live.map(
    (t) => `${t.name} ${(t.contribution >= 0 ? '+' : '-') + Math.abs(t.contribution).toFixed(3)}`
  )
  return [
    parts.length ? parts.join(', ') : 'nothing measurable',
    dead.length ? `(unmeasurable here: ${dead.join(', ')})` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The span the `warm` term divides by: how long a full prompt cache lasts on this conversation's
 * provider.
 *
 * ⛔ An hour is Anthropic's TTL and was written into the score as though it were everybody's. The
 * fallback — `DEFAULT_CACHE_TTL_MS`, shared with the cache clock rather than redeclared here —
 * survives only for a conversation whose cost model declares no TTL at all, and such a conversation
 * has a null `cacheExpiresAt`, so the term is 0 and the denominator never runs.
 */
function warmthDenominatorFor(session: Session | null): number {
  if (!session) return DEFAULT_CACHE_TTL_MS
  try {
    const model = costModel(adapter(session.adapterId).info.policy.costModelId)
    return model.cacheTtlMs() ?? DEFAULT_CACHE_TTL_MS
  } catch {
    // An adapter with no loadable cost model still scores; it simply gets the default span.
    return DEFAULT_CACHE_TTL_MS
  }
}

function scoreCandidate(
  task: Task,
  worker: Worker,
  session: Session | null,
  /**
   * The task's own closed-but-reopenable conversation on this account, where there is no live one.
   * ⛔ Every term below reads `held`, never `session`, so a conversation the dispatch is about to
   * reopen is weighed as what it is. See `reopenableFor`.
   */
  resumable: Session | null,
  w: ReturnType<typeof weights>,
  /** The windows the gate evaluated, or empty when there was nothing trustworthy to read. */
  trustedWindows: QuotaWindow[],
  /**
   * What the fleet has measured about how long each agent takes, read **once** for the whole tick.
   *
   * ⛔ Passed in rather than looked up per candidate: `paceFactors` walks up to 200 finished tasks,
   * and a five-worker fleet would otherwise do that five times to answer the same question with the
   * same answer.
   */
  pace: PaceFactors,
  /** The model this candidate would actually run — the held conversation's, or the resolved default. */
  paceModel: string | null,
  fitnessTerm: { value: number; basis: string },
  priceTerm: { value: number; basis: string }
): ScoreBreakdown {
  const now = Date.now()

  // The conversation this candidate would actually work in — running, or on disk and reopenable.
  const held = session ?? resumable
  const reopened = session === null && resumable !== null

  // ⛔ Divided by **this provider's own TTL**, not by an hour. Sixty minutes is Anthropic's number
  // and it was hard-coded here, so a codex prefix with 15 of its 30 minutes left scored 0.25 where
  // a Claude prefix with 15 of its 60 scored the same — the shorter-TTL provider was penalised for
  // having a shorter TTL, on a term whose entire job is to say *how much is left*. The fraction is
  // the only comparable quantity across providers; the absolute minutes are not.
  // ⚠️ Falls back to an hour only where a cost model declares no TTL at all, in which case
  // `cacheExpiresAt` is null too and the whole term is 0 regardless.
  const ttlMs = warmthDenominatorFor(held)
  const warmth = held?.cacheExpiresAt
    ? Math.max(0, Math.min(1, (held.cacheExpiresAt - now) / ttlMs))
    : 0
  const affinity = held ? 1 : 0
  const cold = held ? 0 : 1
  const projectSwitch = held && held.projectId && held.projectId !== task.projectId ? 1 : 0

  // Context rot is documented rather than folklore, and it does not start at zero context - it bites
  // as the window fills. Roughly nothing below half, rising after.
  let rot = 0
  let rotBasis = 'no session, so no context to have rotted'
  if (held?.contextTokens) {
    const model = costModel(adapter(held.adapterId).info.policy.costModelId)
    const window = model.modelSpec(held.model ?? '')?.context_window ?? 200_000
    const used = held.contextTokens / window
    rot = Math.max(0, (used - 0.5) * 2)
    rotBasis =
      `${Math.round(held.contextTokens / 1000)}k of ${Math.round(window / 1000)}k context used ` +
      `(${Math.round(used * 100)}%), and rot starts above 50%`
  }

  // ⛔ **Two sources, and the worse one wins.** `quotaRiskOf` is the vendor's own word — an
  // `at_risk` reserve or a live status that is no longer `allowed` — and it saturates the term
  // outright. `windowRisk` evaluates across all applicable windows (5h, 7d), modulated by the reset horizon
  // so expiring credits are favored and quota deficits are penalised.
  const evidence = quotaRiskOf(worker.id)
  let maxWindowRisk = 0
  let worstWindow: QuotaWindow | null = null
  let worstRisk = 0
  for (const win of trustedWindows) {
    const r = windowRisk(win.percent, QUOTA_HIGH_WATER, QUOTA_RISK_FLOOR, win.resetsAt, now, win.id)
    if (r > maxWindowRisk || !worstWindow) {
      maxWindowRisk = Math.max(maxWindowRisk, r)
      worstRisk = r
      worstWindow = win
    }
  }

  const quotaRisk = Math.max(evidence, maxWindowRisk)
  const reserve = reserveState(worker.id)
  const rate = freshRateLimit(worker.id)

  let quotaBasis: string
  if (worstWindow && maxWindowRisk > 0) {
    const p = Math.round(worstWindow.percent)
    const label = worstWindow.label ?? worstWindow.id
    const resetInfo =
      worstWindow.resetsAt && worstWindow.resetsAt > now
        ? `, resets in ${formatResetDuration(worstWindow.resetsAt - now)}`
        : ''
    quotaBasis =
      `${p}% of ${label}${resetInfo}; risk ${worstRisk.toFixed(2)}` +
      (evidence > maxWindowRisk ? `. Overridden to 1.0: vendor status ${rate?.status ?? reserve.verdict}` : '')
  } else if (trustedWindows.length > 0) {
    quotaBasis = `all windows below ${QUOTA_RISK_FLOOR}% (${trustedWindows.map((win) => `${win.label ?? win.id} ${Math.round(win.percent)}%`).join(', ')})`
  } else {
    quotaBasis =
      `no quota reading this fleet trusts (reserve verdict ${reserve.verdict})` +
      `${rate ? `, vendor status ${rate.status}` : ''} — unknown scores 0, never a guess`
  }

  const needs = task.constraints.needs ?? []
  const caps = adapter(worker.adapterId).info.capabilities as unknown as Record<string, unknown>
  const met = needs.filter((n) => caps[n] === true)
  const fit = needs.length === 0 ? 1 : met.length / needs.length

  // ⚠️ The model the *conversation* is on wins over the worker's default, because that is the model
  // the turn would actually be served by — the same rule the `warm` term follows when it reads
  // `held` rather than `worker`.
  const measuredPace = paceFor(pace, worker.adapterId, held?.model ?? paceModel)

  const everWorked = hasEverWorked(worker.id)
  const doubt = unproven(worker, everWorked)

  // ⛔ The order and the signs here ARE the formula. Anything added must be added here, or the
  // published derivation stops matching the number it claims to explain.
  return breakdownOf([
    [
      'warm',
      w.warm,
      WEIGHT_FORMULAS.warm,
      warmth,
      1,
      held?.cacheExpiresAt
        ? `${Math.round(Math.max(0, held.cacheExpiresAt - now) / 60000)}m left of a ` +
          `${Math.round(ttlMs / 60000)}m cache TTL` +
          (reopened ? ', on a conversation with no process (it would be reopened)' : '')
        : held
          ? 'this conversation has no cache clock — its cost model declares no TTL'
          : 'no session, so no live prompt cache'
    ],
    [
      'affinity',
      w.affinity,
      WEIGHT_FORMULAS.affinity,
      affinity,
      1,
      reopened
        ? "this task's own closed conversation is on this account and can be reopened"
        : held
          ? 'a session already holds this task'
          : 'no session to reuse'
    ],
    ['contextRot', w.contextRot, WEIGHT_FORMULAS.contextRot, rot, -1, rotBasis],
    [
      'projectSwitch',
      w.projectSwitch,
      WEIGHT_FORMULAS.projectSwitch,
      projectSwitch,
      -1,
      projectSwitch ? 'the reusable conversation is on another project' : 'no project switch involved'
    ],
    ['quotaRisk', w.quotaRisk, WEIGHT_FORMULAS.quotaRisk, quotaRisk, -1, quotaBasis],
    [
      'cold',
      w.cold,
      WEIGHT_FORMULAS.cold,
      cold,
      -1,
      cold
        ? 'no session to reuse, so a start pays a full cache write'
        : reopened
          ? 'reopening a conversation that already holds the context'
          : 'reusing a live session'
    ],
    [
      'capabilityFit',
      w.capabilityFit,
      WEIGHT_FORMULAS.capabilityFit,
      fit,
      1,
      needs.length === 0
        ? 'the task requires no specific capability, so every adapter fits'
        : `${met.length} of ${needs.length} required capabilities present`
    ],
    [
      'pace',
      w.pace,
      WEIGHT_FORMULAS.pace,
      paceValue(measuredPace.factor),
      1,
      measuredPace.basis
    ],
    [
      'fitness',
      w.fitness,
      WEIGHT_FORMULAS.fitness,
      fitnessTerm.value,
      1,
      fitnessTerm.basis
    ],
    [
      'price',
      w.price,
      WEIGHT_FORMULAS.price,
      priceTerm.value,
      -1,
      priceTerm.basis
    ],
    [
      'unproven',
      UNPROVEN_PENALTY,
      'fixed, not from the objective',
      doubt,
      -1,
      everWorked
        ? 'a metered turn has come out of this account'
        : 'no turn has ever come out of this account' +
          (worker.identity ? '' : ', and it has never been probed')
    ]
  ])
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

/**
 * Is there anywhere in this project for the task to work?
 *
 * ⛔ **A contended resource is a hold, never a failure.** `chooseTarget` above asks every question
 * there is about the *worker* — constraints, fitness, capabilities, `maxConcurrent`, quota — and
 * until 2026-08-29 asked none at all about the *project*. The workspace pool was first consulted
 * deep inside `dispatch`, which threw, and the tick's catch-all read every throw as terminal.
 * Measured that day: the fleet could run **five** concurrent sessions (ClaudeSecond at 2, Antigravity
 * at 3) against a pool of **three**, so a fourth task was structurally guaranteed. t40 was routed —
 * at the cost of a controller consult — dispatched, and `failed` at 22:10:23; t38 landed and freed a
 * worktree at **22:10:31**.
 *
 * ⭐ **Held, not made to depend on anybody.** A dependency edge on whoever holds the pool would pin
 * this task behind that specific task forever, so a P0 filed a minute later would still queue behind
 * it — and it would record a relationship that does not exist. A hold is re-decided from scratch
 * every tick against `schedulingOrder`, which is what lets priority actually mean something.
 *
 * ⚠️ **Before `chooseTarget`, deliberately.** Routing can spend a controller consult, and t40's was
 * spent five seconds before the task was thrown away.
 *
 * ⚠️ Three ways to pass that are not "a member is free", and each is load-bearing:
 *  - **No pool declared yet** — `ensurePool` builds it on the first dispatch, and a project nobody
 *    has run yet must not be held for want of a resource that exists to be created.
 *  - **A warm session** — reusing a conversation claims nothing, because the session is already
 *    sitting in the workspace it holds. Gating it would refuse the cheapest move the cost model has.
 *  - **An evictable resident** — an idle conversation on a worktree is a slot `evictResident` can
 *    reclaim, so a parked task must not hold a project shut.
 *
 * This is a *pre-filter over state that can change under it*, not the decision. The claim inside
 * `dispatch` is the truth, and `Contended` is what happens when the two disagree.
 *
 * Exported for its own tests: every branch here is a decision, and each one is worth checking
 * without a worker, a worktree and a process in the way.
 */
export function poolPressure(task: Task): string | null {
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project) return null
  const state = availability(workspacePoolId(project.id))
  if (!state) return null

  // `setProjectPolicy` changes the durable desired size immediately, but a larger pool's next
  // member only exists when `ensurePool` runs before its next claim. Do not let the old, full
  // resource prevent that very dispatch: t89 changed three to four, then this gate kept saying
  // "all 3 workspaces ... busy", so `ensurePool` could never create ws4. Shrinking is the mirror
  // case: respect the newly lower cap before the next claim reconciles the broker's member list.
  const desiredCapacity = policyFor(project).poolSize
  if (state.resource.capacity !== desiredCapacity) {
    if (desiredCapacity > state.resource.capacity) return null
    if (state.inUse < desiredCapacity) return null
    const capacity = desiredCapacity
    return `all ${capacity} workspace(s) in ${project.name} are busy` + poolIsNarrow(project, capacity)
  }

  // A task returning from `awaiting_human` already holds its own member. Its reservation fills the
  // pool by design, but it is not contention: dispatch will transfer that exact claim to the new
  // session without asking the pool for another one.
  if (workspaceHeldBy(project, task.id)) return null
  if (state.free > 0) return null
  if (warmSessionFor(task)) return null
  if (evictableResidents(project.id).length > 0) return null
  const capacity = state.resource.capacity
  return `all ${capacity} workspace(s) in ${project.name} are busy` + poolIsNarrow(project, capacity)
}

/** Projects already told, so a ten-second loop does not repeat itself forever. */
const narrowPools = new Set<string>()

/**
 * The pool against the fleet that will be asked to fill it.
 *
 * ⭐ **Said out loud, and not silently corrected.** `poolSize` is an operator's cap on disk and on
 * parallel git, and growing it behind their back would be the scheduler overriding a number somebody
 * chose. But a fleet three slots wider than its pool holds a task on every single tick, and "why is
 * this always waiting" deserves an answer better than a shrug — so the shortfall is named on the
 * row it is about, and logged once.
 */
function poolIsNarrow(project: Project, capacity: number): string {
  const fleet = listWorkers()
    .filter((w) => w.enabled)
    .reduce((total, w) => total + Math.max(1, w.maxConcurrent), 0)
  if (fleet <= capacity) return ''
  const note = `the fleet can run ${fleet} at once but ${project.name} has ${capacity} workspace(s), so one is always waiting`
  const key = `${project.id}:${fleet}:${capacity}`
  if (!narrowPools.has(key)) {
    narrowPools.add(key)
    log.warn(`${note} — raise workspaces.poolSize for ${project.name} to use the whole fleet`)
  }
  return ` — ${note}`
}

// ---------------------------------------------------------------------------- dispatch

/**
 * Say, on the task, that this dispatch happened only because a person overruled the quota gate.
 *
 * ⚠️ Posted **once per run**, not once per tick: it is called from `dispatch`, which runs when a run
 * starts. ⚠️ Silent unless the override is both live *and* actually load-bearing — a task carrying
 * one that dispatched to an account at 40% was never held by anything, and announcing an override
 * that changed no decision would train the reader to ignore the line that matters.
 */
function noteQuotaOverrideDispatch(task: Task, worker: Worker): void {
  if (!quotaOverridden(task)) return
  const quota = lastQuota(worker.id)
  if (!quota || quota.stale) return
  const choice = resolveModelChoice(task.constraints, worker, false, quota)
  const win = sessionWindowFor(quota.windows, poolFor(worker, choice.model))
  if (!win || windowExpired(win) || win.percent < QUOTA_HIGH_WATER) return
  addMessage(
    task.id,
    'system',
    `Starting on ${worker.label} at ${Math.round(win.percent)}% of its ${win.label ?? '5h'} ` +
      `window. The ${QUOTA_HIGH_WATER}% gate would normally hold this task; it was overridden by ` +
      'hand, so this run is also exempt from being preempted over that percentage. ⚠️ A turn the ' +
      'vendor actually refuses still stops it, and the window boundary itself still applies.'
  )
}

/**
 * Write the routing decision down, and never let a failure to do so stop a dispatch.
 *
 * ⚠️ Wrapped, because this is an *instrument*. Nothing the fleet does depends on the row existing,
 * and a scheduler that refused to start work because an analytics insert threw would be trading the
 * thing that matters for the thing that watches it.
 */
export function noteRoutingDecision(task: Task, choice: WorkerChoice): void {
  if (!choice.scored || !choice.objective) return
  try {
    recordRoutingDecision({
      taskId: task.id,
      taskSeq: task.seq,
      taskTitle: task.titleSummary ?? task.title,
      projectId: task.projectId,
      chosenWorkerId: choice.worker?.id ?? null,
      chosenLabel: choice.worker?.label ?? null,
      objective: choice.objective,
      weights: weights(choice.objective) as unknown as Record<string, number>,
      weightFormulas: WEIGHT_FORMULAS,
      epsilon: ROUTE_EPSILON,
      basis: choice.routedBy ?? 'score',
      warm: !!choice.session,
      candidates: choice.scored
    })
  } catch (err) {
    log.warn(`could not record the routing decision for t${task.seq}:`, err)
  }
}

async function dispatch(task: Task, choice: WorkerChoice): Promise<void> {
  const worker = choice.worker as Worker
  const quotaUnverified = choice.quotaUnverified

  // ⛔ **Here, before anything can fail.** The decision has been made by the time this function is
  // entered; a workspace this dispatch then loses a race for does not un-make it, and a ledger that
  // only recorded the dispatches that succeeded would quietly answer a different question than the
  // one it claims to. See `routingdecisions.ts`.
  noteRoutingDecision(task, choice)

  // ⛔ **In the thread, not only in the log.** A run that only happened because somebody overruled
  // the water mark is the run most likely to end mid-thought when the window closes, and the person
  // reading the transcript afterwards needs the reason to be part of the record rather than
  // something they have to remember pressing. ⚠️ Written before the spawn, so it survives a dispatch
  // that then fails.
  noteQuotaOverrideDispatch(task, worker)

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

  // A question can outlive the process that asked it. In that case the task, rather than a dead
  // session, owns its original workspace until the person answers; reclaiming it here is a transfer
  // to the next session, not a second pool claim.
  let workspace: Workspace | null = project ? workspaceHeldBy(project, task.id) : null
  let branch: string | null = null

  // ⛔ The directory a resumable conversation was in, offered to the pool as a preference.
  // Claude Code files its transcripts under an encoding of the cwd, so `--resume` from a different
  // worktree finds nothing - and it finds nothing *quietly*, starting a fresh conversation and
  // reporting success. Getting the same tree back is what makes resuming possible at all; it is a
  // preference rather than a requirement because a free workspace beats no workspace.
  const past = pastSessionsFor(task)
  // ⚠️ Asked before the workspace is claimed, because the directory is part of the answer. Claude
  // Code files its transcripts under an encoding of the cwd, so a conversation can only be resumed
  // from the tree it was had in — and a lent conversation is therefore also a *preference about
  // which worktree to claim*. Offered second: this task's own tree always outranks somebody else's.
  const lent = lendableConversations(task, worker.id)
  const priorCwd = past.find((s) => s.workerId === worker.id)?.cwd ?? lent[0]?.cwd

  if (project) {
    // ⛔ A task cannot occupy two independent workspaces. If an ended session of this task still holds
    // a workspace claim, release it before claiming so the slot is free and can be reused.
    for (const s of past) {
      if (sessionEnded(s.state)) {
        await releaseWorkspaceOf(s.id)
      }
    }
    workspace ??= workspaceHeldBy(project, task.id)

    // ⚠️ Claimed under the **task's** name, and moved to the session's below. The session's working
    // directory is the workspace, so there is no session to claim on behalf of until there is a
    // workspace to put it in. See `reassignClaim`.
    workspace ??= await claimWorkspace(project, task.id, priorCwd)
    // ⛔ A pool with nothing free is not necessarily a pool that is busy. Now that a session keeps
    // its workspace for as long as it lives, an idle conversation can sit on a worktree with no run
    // against it — and the cache clock's `let_expire` move leaves such a session alone indefinitely.
    // Without this, one parked task would cost a slot until somebody restarted the daemon.
    if (!workspace) {
      if (await evictResident(project)) workspace = await claimWorkspace(project, task.id, priorCwd)
    }
    // ⚠️ `Contended`, not `Error`: the pool is busy, not broken, and the tick puts this task back in
    // the queue rather than failing it. See `Contended` in resources.ts for what that cost on
    // 2026-08-29.
    if (!workspace) {
      throw new Contended(`no free workspace in ${project.name}`, workspacePoolId(project.id))
    }

    // ⛔ Clean up any other workspace claim held by this task. One task works in one workspace only.
    const poolId = workspacePoolId(project.id)
    for (const c of openClaims(poolId)) {
      if (c.holder === task.id && c.member && !samePath(c.member, workspace.path)) {
        release(c.id)
      }
    }

    branch = project.vcs === 'git' ? (task.branch ?? branchNameFor(task.seq, task.title)) : null
    // ⛔ The task goes through, so a split child is cut from its **plan branch** rather than the
    //    project's trunk. Without it child 2 would be branched off `main`, would not contain child 1's
    //    work, and a `depends_on` edge between them would order the runs and deliver nothing.
    const prepared = await prepareWorkspace(project, workspace, branch, task)
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
  // ⛔ Task → worker → the CLI's own choice, resolved in one place shared with the renderer so the
  // form cannot promise an inheritance the scheduler does not perform. `null` at the end is a real
  // answer: let the CLI pick, which is what every dispatch did before there was a default.
  const picked = resolveModelChoice(task.constraints, worker, canSetEffort, lastQuota(worker.id))
  if (choice.model) {
    picked.model = choice.model
  }
  // ⭐ The conversation this task was already having, if it is still on disk and this is the same
  // account and the same tree. Resuming costs the read of a cache that is very likely cold by now;
  // *not* resuming costs rebuilding the whole prefix and re-discovering the branch, the files and
  // everything the last run worked out - and it produced an agent that answers a follow-up question
  // having never seen the question it follows.
  const revive = resumableSession([...past, ...lent], worker.id, cwd)
  // ⛔ Whose conversation this is, and it is never inferred from the prompt later. A revived
  // conversation that belonged to another task is a disclosure — this task's agent is about to read
  // everything that was said in it — and the two things that follow from that, telling the agent and
  // telling the lender, are both wrong if this flag is.
  const borrowed = revive !== null && !past.some((s) => s.id === revive.id)
  // ⚠️ A revived conversation remembers a tree that has since moved. `prepareWorkspace` switched the
  // worktree while the agent was not running, so nothing warned it — and its context is full of file
  // contents from the branch it was last on.
  // ⛔ **Said, or it may as well have been thrown away.** When a run is interrupted with work still
  // uncommitted, `rescueDirt` now commits it onto the task's branch so the next run inherits it. That
  // only helps if the next run is told: an agent that finds a `wip:` commit it has no memory of
  // writing will either ignore it or, worse, treat the branch as somebody else's and start again —
  // which is precisely what t91 and t92 did on 2026-09-01, at 13.3M tokens for one of them, back when
  // the work went to a stash instead and nothing mentioned that either.
  const rescued = branch ? await rescueAtTip(cwd) : null
  if (rescued) {
    addMessage(
      task.id,
      'system',
      `The last run here was interrupted with ${rescued.files} file(s) uncommitted. They were ` +
        `committed onto \`${branch}\` as ${rescued.sha.slice(0, 8)} so this run inherits them, and ` +
        'that commit cannot land until something is finished on top of it.'
    )
  }
  const rescueNotice = rescued
    ? `⚠️ The tip of \`${branch}\` is commit ${rescued.sha.slice(0, 8)}, holding ${rescued.files} ` +
      'file(s) an interrupted earlier run left uncommitted. This tool made that commit, not you: ' +
      'nothing in it has been compiled or checked. **Read it first** (`git show HEAD`) — it is very ' +
      'likely most of the work you are about to be asked for. Amend it or build on top of it; it ' +
      'will not be allowed to land as it stands.'
    : null

  const movedSince = revive && revive.currentBranch && branch && revive.currentBranch !== branch
  const branchNotice = movedSince
    ? `⚠️ This workspace has moved since your last turn: it was on \`${revive.currentBranch}\` and ` +
      `is now on \`${branch}\`. Any file you read earlier came from the other branch — re-read ` +
      'anything you are going to rely on rather than trusting what is in this conversation.'
    : null

  // ⚠️ Said at the top of the first prompt rather than left to be discovered. An agent that reads a
  // conversation full of another task's plan, half-finished edits and conclusions, with no notice,
  // will take all of it for its own memory — the failure mode is not a wrong file, it is an agent
  // that carries on somebody else's work believing it is its own.
  const borrowNotice = borrowed
    ? '⚠️ This conversation was opened for a different task and you are joining it for its context, ' +
      'not for its instructions. Everything above this message belongs to that other task: treat it ' +
      'as background, do not continue it, and re-read any file you are going to rely on. Your own ' +
      'task is stated below and is the only thing you are being asked to do.'
    : null

  // ⛔ `resumed` means *this task* has spoken in this conversation before, which a borrowed one is
  // exactly not. The flag suppresses restating the task's own prompt, on the grounds that the
  // conversation already contains it — true of a revived conversation of one's own, and false in the
  // most damaging way available of somebody else's: the agent would be handed a context full of
  // another task's instructions and never told what it was itself being asked to do.
  const prompt = promptFor(task, worker.adapterId, revive !== null && !borrowed, {
    branchNotice: [borrowNotice, branchNotice, rescueNotice].filter(Boolean).join('\n\n') || null,
    markDelivered: true
  })
  const promptText = prompt.text

  // ⛔ **The spawn happens here, below `promptFor`, and that order is load-bearing.** A
  // `spawn-flag` adapter takes its images as argv on the process that runs the turn — codex has
  // no stdin channel to send one down afterwards — so the file list has to exist before the
  // process does. Everything above is workspace and conversation bookkeeping that the session
  // plays no part in, which is what makes this a move rather than a restructure.
  const session = spawnSession({
    workerId: worker.id,
    cwd,
    transport: 'stream',
    projectId: project?.id ?? null,
    attachments: prompt.attachments,
    ...(revive ? { resume: revive } : {}),
    ...(picked.model ? { model: picked.model } : {}),
    ...(picked.effort ? { effort: picked.effort } : {})
  })

  if (borrowed && revive) {
    // ⛔ Told to the lender as well as to the borrower. "Who else has been in this conversation" is
    // the one question sharing makes unanswerable from every other screen, and a thread that never
    // mentions it leaves the answer only in a log nobody reads.
    const lender = runForSession(revive.id)
    if (lender?.taskId && lender.taskId !== task.id) {
      addMessage(
        lender.taskId,
        'system',
        `t${task.seq} reopened this task's conversation (${revive.id.slice(0, 8)}) to reuse its ` +
          'context. Nothing here was changed, and this task keeps its own branch and its own history.'
      )
    }
    log.info(
      `t${task.seq} is reviving the conversation ${revive.id.slice(0, 8)} from another task in ` +
        `${project?.name ?? cwd}`
    )
  }

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
    startedWarm: revive !== null,
    // ⭐ The tripwire's first half. See `decideFinish`'s `trunk-moved` branch for what it is for.
    trunkShaBefore: project ? await trunkTargetSha(project, landingTargetFor(task, project)) : null,
    prompt: promptText,
    objective: resolveObjective(project?.config?.objective, task.objective, settings().objective)
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

  setStatus(task.id, 'running', {
    assignee: worker.id,
    ...(branch ? { branch } : {})
  })
  addMessage(
    task.id,
    'system',
    `${revive ? 'Resumed the earlier conversation' : 'Started'} on ${worker.label}` +
      `${branch ? ` in ${workspace?.path} on \`${branch}\`` : ''}` +
      (quotaUnverified ? ' — quota reading was not trustworthy, so this run is marked unverified.' : ''),
    run.id
  )

  // The CLI needs a moment before it starts reading stdin; a message sent too early is dropped.
  //
  // ⛔ And a revived conversation may need shrinking before it is spoken to at all — see
  // `openConversation`. The delay is the same either way; what changes is what goes in first.
  setTimeout(() => {
    openConversation(
      session,
      task,
      promptText,
      revive ? compactOnResume(revive, settings()) : null,
      prompt.attachments
    )
  }, PROMPT_DELAY_MS)

  // ⚠️ The *reason* travels with it. "dispatched t5 to ClaudeSecond" says what happened; it does not
  // say why that account rather than the other three, which is the question asked afterwards — and
  // the score and its basis exist right here and were being thrown away.
  log.info(
    `dispatched t${task.seq} to ${worker.label} (run ${run.id.slice(0, 8)}, ` +
      `score ${choice.score.toFixed(2)}: ${choice.reason})` +
      (revive ? `, resuming conversation ${(revive.vendorSessionId ?? revive.id).slice(0, 8)}` : '') +
      (quotaUnverified ? ' — on an unverified quota reading' : '')
  )
  // ⛔ The derivation, on **every** dispatch and not only the consulted ones. A routing decision
  // nobody questioned is exactly the one whose arithmetic goes unchecked for months, which is how a
  // term that had silently stopped discriminating survived four consults before anybody noticed.
  if (choice.breakdown) {
    log.info([`t${task.seq} score:`, ...formatScore(choice.breakdown)].join('\n'))
  }
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
    if (!reclaimed) {
      throw new Contended(
        `no free workspace in ${project.name} to continue t${task.seq}`,
        workspacePoolId(project.id)
      )
    }
    reassignClaim(reclaimed.claimId, session.id)
    workspaces.set(session.id, { workspace: reclaimed, projectId: project.id })
  }

  // ⛔ Before anything is sent into it. Two tasks in one conversation would interleave their turns,
  // bill each other's tokens and race to answer one `task_complete`; the lease makes that
  // unrepresentable rather than merely discouraged. Refusing here is safe — the task stays `ready`
  // and the next tick will find it a session, warm or otherwise.
  if (!acquireSessionLease(session.id, task.id)) {
    if (reclaimed) await releaseWorkspaceOf(session.id)
    throw new Error(
      `the conversation ${session.id.slice(0, 8)} is already in use by another task; t${task.seq} waits`
    )
  }

  // ⛔ **A borrowed task needs a branch of its own, and until now it never got one.** This path was
  // written when a warm session only ever served the *same* task, which already had its branch from
  // its cold dispatch — so it read `task.branch` and never assigned one. A task that has only ever
  // run warm therefore had `branch: null`, which skipped the switch below entirely and left it
  // working on **the lender's branch**. Measured on a real fleet 2026-08-28: t13 borrowed t11's
  // conversation and ran in t11's worktree on t11's branch. It only read files, so nothing was mixed
  // — but a borrower that committed would have put its work on somebody else's branch, which is the
  // exact failure phase 2's switch-and-tell exists to prevent.
  const branch =
    task.branch ?? (project && project.vcs === 'git' ? branchNameFor(task.seq, task.title) : null)

  // Whose conversation this was, read **before** the switch moves the tree off their branch.
  const previousOccupant = session.currentBranch ? taskOnBranch(session.currentBranch) : null

  // ⚠️ Put the tree on this task's branch, and say so — to the task that was here, to the agent, and
  // in the log.
  let notice: string | null = null
  if (project && project.vcs === 'git' && branch) {
    const path = workspaces.get(session.id)?.workspace.path ?? session.cwd
    const moved = await switchBorrowedTree(project, session, path, task, branch)
    if (!moved.ok) {
      // ⛔ Give the lease back. A task that cannot use the conversation must not hold it shut, and
      // this is the one path between acquiring it and `releaseFor` that does not open a run.
      releaseAllFor(task.id)
      if (reclaimed) await releaseWorkspaceOf(session.id)
      throw new Error(moved.error ?? `could not put ${path} on ${branch} for t${task.seq}`)
    }
    notice = moved.notice
  }

  applyPermissionRules(worker, project)

  const continuing = promptFor(task, worker.adapterId, true, {
    branchNotice: notice,
    markDelivered: true
  })
  const promptText = continuing.text

  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: task.projectId,
    quotaUnverified,
    costModelId: adapter(worker.adapterId).info.policy.costModelId,
    // The session never closed, which is the warmest a run gets.
    startedWarm: true,
    trunkShaBefore: project ? await trunkTargetSha(project, landingTargetFor(task, project)) : null,
    prompt: promptText,
    objective: resolveObjective(project?.config?.objective, task.objective, settings().objective)
  })
  setRunQuota(run.id, 'before', runQuota(worker.id))
  clearActivity(task.id)
  if (reclaimed) workspaces.set(session.id, { workspace: reclaimed, projectId: project?.id ?? null })

  // ⚠️ The branch travels with the status, exactly as it does on a cold dispatch. Without it a
  // borrowed task stays `branch: null` forever and the finish path has nothing to land.
  setStatus(task.id, 'running', { assignee: worker.id, ...(branch ? { branch } : {}) })
  // ⛔ Says whose conversation this is. It used to say "the session that still holds **this task's**
  // context" unconditionally - true for a continuation and false for a borrowed one, where the
  // context belongs to somebody else's task and the operator most needs to be told so.
  const borrowed = !runsFor(task.id).some((r) => r.sessionId === session.id && r.id !== run.id)
  addMessage(
    task.id,
    'system',
    (borrowed
      ? `Continued in a conversation opened by another task${
          previousOccupant && previousOccupant.id !== task.id ? ` (t${previousOccupant.seq})` : ''
        } — this agent can see that task's work`
      : `Continued in the session that still holds this task's context`) +
      (saved !== null && saved > 0
        ? ` — about ${saved} input-token-equivalents cheaper than a cold start.`
        : saved === null
          ? ' — cheaper than a cold start, though this provider’s cache is not priced, so by how much is unknown.'
          : '.'),
    run.id
  )
  // ⚠️ The branch notice goes **first**, before the task's own words. An agent that reads the work
  // before it reads "the files you remember are from another branch" has already started planning
  // against a tree that is not there.
  // ⚠️ An image pasted into a note reaches a warm session only where the adapter takes one inline;
  // `sendPrompt` is the gate. On codex there is no second channel at all — its `-i` went with a
  // process that has already run — and the path in the text is what the agent gets instead.
  sendPrompt(session.id, promptText, continuing.attachments)
  log.info(
    `t${task.seq} continued warm on ${worker.label} (run ${run.id.slice(0, 8)}, ` +
      `saved ${saved === null ? 'unknown' : `~${saved}`})`
  )
}

/** The CLI needs a moment before it reads stdin; a prompt sent too early is dropped. */
const PROMPT_DELAY_MS = 2500

/**
 * Put the first prompt into a session — after compacting it, where the conversation is one that was
 * carried over from an earlier run and is big enough to be worth it.
 *
 * ⛔ **`/compact` first, the task's prompt only once the boundary has arrived.** The two cannot be
 * sent together: a prompt delivered mid-compaction is read out of the summary rather than out of the
 * message, and an agent that is handed its instructions while its own history is being rewritten is
 * the one failure this must not introduce in exchange for the tokens it saves.
 *
 * ⚠️ **The prompt is sent exactly once, whatever happens.** Compaction on the `stream` transport is
 * still unmeasured (HANDOFF R6), so the boundary may never come — and a run whose instructions were
 * lost waiting for it would be far more expensive than the prefix it was trying to shrink. The
 * boundary wakes it, `RESUME_COMPACT_WAIT_MS` wakes it, and `sent` makes sure only the first of those
 * is acted on.
 */
export function openConversation(
  session: Session,
  task: Task,
  promptText: string,
  plan: ResumeCompaction | null,
  attachments: Attachment[] = []
): void {
  const send = (why: string): void => {
    try {
      sendPrompt(session.id, promptText, attachments)
      if (why) log.info(`t${task.seq}: sent the prompt after ${why}`)
    } catch (err) {
      log.warn(`could not send the prompt for t${task.seq}:`, err)
    }
  }

  if (!plan?.compact) {
    send('')
    return
  }

  try {
    // ⚠️ Sent on the session's own input channel, exactly as the cache clock sends it, because it is
    // the same request arriving at a different moment.
    sendPrompt(session.id, '/compact')
  } catch (err) {
    // ⛔ The compaction was never issued, so nothing is recorded and nothing is waited for. The run
    // proceeds on the large prefix, which is what it would have done before any of this existed.
    log.warn(`could not compact the resumed conversation for t${task.seq}:`, err)
    send('')
    return
  }

  noteCompactionAsked({
    sessionId: session.id,
    taskId: task.id,
    reason: plan.reason,
    preTokens: session.contextTokens
  })
  // ⛔ The clock's own bookkeeping, written by hand because the clock did not make this move. Without
  // it a `/compact` this path issued would be invisible to `moveOutcome`, and the next tick that
  // found the session near expiry would happily send a second one.
  markClockMove(session.id, 'compact', session.tokensSinceCompact)
  addMessage(
    task.id,
    'system',
    `Compacting before starting: ${plan.reason}. This costs about ${plan.estimatedCost} tokens ` +
      'once, and the prompt goes in as soon as it lands.'
  )
  log.info(
    `t${task.seq}: compacting the resumed conversation ${session.id.slice(0, 8)} before prompting ` +
      `(~${plan.estimatedCost} tokens)`
  )

  let sent = false
  let stopWaiting = (): void => {}
  const once = (why: string, timedOut: boolean): void => {
    if (sent) return
    sent = true
    stopWaiting()
    clearTimeout(timer)
    if (timedOut) {
      // ⛔ The clock's mark is released here rather than left to expire. Left set, it would be read
      // two attempts later as a session that refuses to compact and answered with `handoff_close` —
      // closing a conversation that is at that moment doing the work.
      clearClockMove(session.id)
      addMessage(
        task.id,
        'system',
        'The compaction did not land within ' +
          `${Math.round(RESUME_COMPACT_WAIT_MS / 60000)} minutes, so the work is starting on the ` +
          'full context. The request stays on the record, unlanded.'
      )
    }
    send(why)
  }
  const timer = setTimeout(
    () => once('the compaction did not land in time', true),
    RESUME_COMPACT_WAIT_MS
  )
  // ⚠️ Registered after the send, not before: the boundary cannot arrive until `/compact` has been
  // issued, and a listener left behind by a send that threw would fire on somebody else's compaction.
  stopWaiting = onCompactionLanded(session.id, () => once('the compaction landed', false))
}

// ---------------------------------------------------------------------------- watchdogs

/** No turn for this long while a run is open is a stall worth surfacing. */
const STALL_AFTER_MS = 12 * 60 * 1000

/**
 * How long a task asked to finish may stay silent before the workspace decides it.
 *
 * ⚠️ Three minutes of **no request at all**, not three minutes of work. The instruction is *commit
 * what you already have*, and the one agent measured doing it took seventeen seconds (t58,
 * 2026-08-30). A generous multiple of that is still far short of the twelve minutes a stall is given,
 * because unlike a stall this decides nothing on its own — it re-reads the tree and asks
 * `decideFinish` again.
 */
const FINISH_REPLY_AFTER_MS = 3 * 60 * 1000

/**
 * Has an agent that was asked to finish stopped answering?
 *
 * ⛔ **Both clocks, and the second is the one that matters.** Elapsed time since the ask says only
 * that a while has passed; an agent part-way through a large commit would trip it while working.
 * `quietSince` — the last request it *started* — says no call is in flight, which is the difference
 * between an agent that is taking its time and one that is never going to answer.
 *
 * ⚠️ Deliberately not a stall check. It does not ask whether the process is burning CPU, because it
 * is not deciding whether to accuse anybody of being stuck — it is deciding whether to go and read
 * the workspace, which is safe to do to a healthy run and is the whole reason this may act where
 * `reportStall` may not.
 */
export function finishReplyOverdue(askedAt: number, quietSince: number, now = Date.now()): boolean {
  return now - askedAt > FINISH_REPLY_AFTER_MS && now - quietSince > FINISH_REPLY_AFTER_MS
}
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

/** Give a watching operator one durable minute to overrule an avoidable quota preemption. */
async function warnBeforeQuotaPreempt(
  task: Task,
  session: Session,
  trigger: 'window' | 'overrun',
  resumeAt: number,
  reason: string
): Promise<boolean> {
  const now = Date.now()
  const current = requireTask(task.id)
  if (quotaOverridden(current, now)) {
    if (current.quotaPreemptWarning) setQuotaPreemptWarning(task.id, null)
    return false
  }

  const existing = current.quotaPreemptWarning
  if (!existing || existing.trigger !== trigger) {
    const preemptAt = trigger === 'window'
      ? Math.min(now + QUOTA_PREEMPT_WARNING_MS, resumeAt)
      : now + QUOTA_PREEMPT_WARNING_MS
    const graceSeconds = Math.max(0, Math.ceil((preemptAt - now) / 1000))
    setQuotaPreemptWarning(task.id, { trigger, reason, preemptAt, resumeAt })
    addMessage(
      task.id,
      'system',
      `Quota preemption warning: ${reason}. Automatic preemption in ` +
        `${graceSeconds} seconds unless a person overrides it.`
    )
    log.warn(
      `t${task.seq} will be preempted for quota in ${graceSeconds}s ` +
        `unless overridden (${reason})`
    )
    return true
  }

  // A changing percentage may sharpen the explanation, but it must not restart the countdown.
  const warning =
    existing.reason === reason && existing.resumeAt === resumeAt
      ? existing
      : { ...existing, reason, resumeAt }
  if (warning !== existing) setQuotaPreemptWarning(task.id, warning)
  if (now < warning.preemptAt) return true

  setQuotaPreemptWarning(task.id, null)
  log.warn(`t${task.seq} preempted after its quota override window elapsed (${reason})`)
  await preempt(task, session, resumeAt, reason)
  return true
}

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

    // ⛔ **A compaction in flight is the one silence that means the session is obeying.** `/compact`
    // is answered with a turn that reports nothing until the boundary lands, so for the minute or
    // two it takes, the run has no turn and a process tree that CPU barely registers - which is
    // indistinguishable from the deadlock the checks below exist to catch. Measured on t105,
    // 2026-09-02: issued 06:51:03, landed 06:53:11, and at 06:52:15 the operator was told the task
    // *"looks stuck rather than slow"*. ⚠️ Only the two checks that judge *silence* stand down. A
    // window boundary or a quota overrun is still a reason to preempt, compaction or not - those
    // read the clock and the account, not the agent.
    const compacting = compactionInFlight(session.id)

    // 0. Asked to finish, and never answered.
    //
    // ⛔ **`ask-agent` returns without ending the run, on the bet that the agent reports again.**
    // Nothing ever collected on that bet. `finish_asked_at` is written there and read in exactly two
    // places, both inside `decideFinish` — that is, only by the second `task_complete` that may
    // never arrive. No timer, no re-check, no fallback: the run stays open, the task stays
    // `running`, and its workspace stays held, for as long as the daemon lives.
    //
    // ⭐ Measured on t58, 2026-08-30, from this daemon's own log: asked to commit 9 files at
    // 01:52:00, the agent authored the commit at 01:52:08 and wrote it at 01:52:17 — it obeyed in
    // seventeen seconds — and then never reported. Fifty minutes later the task was still
    // `running` and ws3 was still held. The stall watchdog diagnosed it correctly at 02:05 and, by
    // design, only said so.
    //
    // ⚠️ The trigger is silence, not elapsed time alone: `lastRequestStartedAt` is the same signal
    // check 3 uses, and it means no request is in flight rather than merely that a while has
    // passed. An agent still working on the commit is mid-request and is not touched.
    //
    // ⛔ Safe to be wrong about, which is why it may act where the stall watchdog may not: this
    // re-runs the *same* `decideFinish` against a freshly read tree and takes whatever it says. A
    // clean tree lands. A tree still dirty rests the task at `awaiting_human` with the work intact —
    // never discarded, never swept into a commit nobody wrote. And it cannot loop, because
    // `finish_asked_at` is set by now, so the second decision is never `ask-agent` again.
    if (task.finishAskedAt !== null && !compacting) {
      if (finishReplyOverdue(task.finishAskedAt, session.lastRequestStartedAt ?? session.startedAt)) {
        log.warn(
          `t${task.seq} was asked to finish ${Math.round((Date.now() - task.finishAskedAt) / 60000)}m ` +
            'ago and has not reported since; deciding it from the workspace instead'
        )
        await completeTask(session.id, 'Finished after being asked to commit')
        continue
      }
    }

    // 1. The window boundary. This is the case the whole tool was built for.
    const reset = windowResetsAt(run.workerId)
    const project = task.projectId ? getProject(task.projectId) : null
    const taskObjective = resolveObjective(project?.config?.objective, task.objective, switches.objective)
    const margin = policy(taskObjective).preemptMarginMs

    // A rejection outranks an earlier caution. The turn has already failed, so leaving a stored
    // boundary warning in front of this check would misleadingly offer a choice for another minute.
    const refused =
      switches.autoOverrunPreempt && task.preemptible
        ? overrunVerdict(run.workerId, null, { quotaOverride: quotaOverridden(task) })
        : null
    if (refused) {
      if (task.quotaPreemptWarning) setQuotaPreemptWarning(task.id, null)
      log.warn(`t${task.seq} preempted for quota overrun risk (${refused.reason})`)
      await preempt(task, session, refused.resumeAt, refused.reason)
      continue
    }

    if (switches.autoPreempt && reset && reset.at - Date.now() <= margin && task.preemptible) {
      if (await warnBeforeQuotaPreempt(task, session, 'window', reset.at, reset.source)) continue
    }

    // 2. Active 5h quota exhaustion, or a vendor refusal mid-stream.
    if (switches.autoOverrunPreempt && task.preemptible) {
      const worker = getWorker(run.workerId)
      const quota = lastQuota(run.workerId)
      let percent: number | null = null
      if (worker && quota && !quota.stale) {
        const choice = resolveModelChoice(task.constraints, worker, false, quota)
        const win = sessionWindowFor(quota.windows, poolFor(worker, choice.model))
        if (win && !windowExpired(win)) percent = Math.round(win.percent)
      } else if (worker && run.quotaBefore && !run.quotaBefore.stale) {
        // Fall back to the baseline snapshot taken at dispatch if mid-run staleness elapsed (>15m)
        const pool = poolFor(worker, run.model)
        const win =
          run.quotaBefore.windows.find((w) => isSessionRateWindow(w.id) || (pool && w.id.includes(pool))) ??
          run.quotaBefore.windows.find((w) => isSessionRateWindow(w.id)) ??
          run.quotaBefore.windows[0]
        if (win) percent = Math.round(win.percent)
      }

      const verdict = overrunVerdict(run.workerId, percent, {
        quotaOverride: quotaOverridden(task)
      })
      if (verdict) {
        if (verdict.overridable) {
          if (
            await warnBeforeQuotaPreempt(
              task,
              session,
              'overrun',
              verdict.resumeAt,
              verdict.reason
            )
          ) {
            continue
          }
        } else {
          log.warn(`t${task.seq} preempted for quota overrun risk (${verdict.reason})`)
          await preempt(task, session, verdict.resumeAt, verdict.reason)
        }
        continue
      }
    }

    // The trigger was re-read above and no longer exists. Its prompt must disappear with it.
    if (task.quotaPreemptWarning) setQuotaPreemptWarning(task.id, null)

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

    // 3. A stall. ⛔ Reported, never killed - and since 2026-08-29 it can say *why* it thinks so.
    // ⚠️ `quietSince`, not the request clock alone: on a resumed conversation that clock belongs to
    // the previous run and is hours old, which is how t105 was accused of 947 minutes of silence
    // ninety seconds after it was dispatched.
    const lastTurn = quietSince({
      lastRequestStartedAt: session.lastRequestStartedAt,
      sessionStartedAt: session.startedAt,
      runStartedAt: run.startedAt,
      compactionLandedAt: lastCompactionLandedAt(session.id)
    })
    if (!compacting && Date.now() - lastTurn > STALL_AFTER_MS) {
      await reportStall(task, session, lastTurn)
    }
  }
}

/**
 * What the last look at each stalled session found.
 *
 * ⛔ Keyed by session and holding the turn it was taken against, so a session that produces a turn
 * starts over: the baseline from before the turn describes a run that was demonstrably working, and
 * comparing against it would accuse the next quiet minute of being the same stall.
 */
const stallWatch = new Map<string, { lastTurn: number; sample: TreeSample | null; reported: boolean }>()

/**
 * Say whether a silent run is stuck or merely slow, once, with the evidence.
 *
 * ⛔ **Nothing is stopped and no status is changed.** The signal is good enough to ask a person and
 * not good enough to act on: a run blocked on a slow network call burns no CPU either. Leaving the
 * run's state machine strictly alone is what makes a false positive cost a message rather than a
 * task. ⚠️ The operator's own move — read the tree, decide, kill it — is the one this cannot make
 * for them, and `AGENTS.md` has said since M2 that nothing kills a process it cannot prove is its
 * own.
 */
async function reportStall(task: Task, session: Session, lastTurn: number): Promise<void> {
  const minutes = Math.round((Date.now() - lastTurn) / 60000)
  if (!session.pid) {
    log.warn(`t${task.seq} has had no turn for ${minutes}m (no pid recorded, so nothing to measure)`)
    return
  }

  const previous = stallWatch.get(session.id)
  // A turn since the last look means the run was working; whatever came before describes a
  // different silence and must not be compared against this one.
  const history = previous && previous.lastTurn === lastTurn ? previous : null
  if (history?.reported) return
  if (history?.sample && Date.now() - history.sample.at < MIN_SAMPLE_GAP_MS) return

  const sample = await sampleProcessTree(session.pid)
  if (!sample) {
    // ⚠️ Unmeasurable is not stuck. Fall back to what this line has always said.
    log.warn(
      `t${task.seq} has had no turn for ${minutes}m ` +
        '(reported, not stopped - its process tree could not be read)'
    )
    return
  }

  const stuck = looksStuck(history?.sample ?? null, sample)
  stallWatch.set(session.id, { lastTurn, sample, reported: stuck })
  if (!stuck) {
    log.warn(
      `t${task.seq} has had no turn for ${minutes}m, but its ${sample.processes.length} process(es) ` +
        `have used ${sample.cpuSeconds.toFixed(1)}s of CPU - working, not stuck`
    )
    return
  }

  const idleFor = Math.round((sample.at - (history?.sample?.at ?? sample.at)) / 1000)
  const gained = sample.cpuSeconds - (history?.sample?.cpuSeconds ?? sample.cpuSeconds)
  const headline =
    `t${task.seq} looks stuck rather than slow: no turn for ${minutes}m, and the ` +
    `${sample.processes.length} process(es) under it have used ${gained.toFixed(1)}s of CPU in the ` +
    `last ${idleFor}s`
  log.warn(`${headline} - reported, not stopped`)
  addMessage(
    task.id,
    'system',
    `${headline}. Work burns CPU; a wait on something that will never arrive does not.\n\n` +
      `${describeTree(sample)}\n\n` +
      '⚠️ Nothing has been stopped — this is a report, and a run blocked on a slow network call ' +
      'looks the same. If it is stuck, stop the process above that is holding it and this task ' +
      'will carry on; the fleet will not kill a process it cannot prove is its own.'
  )
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

  // ⛔ The evidence, not just the verdict. A run wrapped up for being at the top of its window while
  // the fleet card over it read 63% is the single most confusing thing this scheduler can do (t70),
  // and the cause is that the two numbers come from different rungs: the trigger can be a *live*
  // signal riding the turn, the card is the last cached reading. Both go in the message.
  const shown = because === 'runaway' ? null : lastQuota(run?.workerId ?? session.workerId)
  const shownLine =
    shown && shown.windows.length
      ? ' The last cached reading for this account was ' +
        shown.windows.map((x) => `${x.label ?? x.id} ${Math.round(x.percent)}%`).join(' · ') +
        ` (${Math.round(shown.ageMs / 60000)}m old${shown.stale ? ', stale' : ''}), which is why the ` +
        'fleet card may show a lower number than the one that stopped this run; a fresh reading has ' +
        'been asked for.'
      : ''
  addMessage(
    task.id,
    'system',
    because === 'runaway'
      ? 'Preempted: this run was well past its estimate.'
      : `Preempted before the quota window closes (${because}). Resuming automatically after the ` +
        `reset, expected ${new Date(resumeAt).toISOString()}.${shownLine}`
  )
  // ⭐ Go and make the displayed number true. The probe itself is the poller's job and its gates
  // still apply; this only says that this account is now worth looking at.
  if (because !== 'runaway') {
    requestUrgentProbe(run?.workerId ?? session.workerId, `a run was preempted here (${because})`)
  }

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
        if (run) {
          await releaseFor(run.id, task.id, task.projectId)
          // ⛔ Preemption is a run ending just as completion or a failed turn is. The urgent probe
          // above refreshes the account card, but it does not attach a closing reading to this run;
          // without this call every watchdog-preempted run permanently had `quotaAfter: null`.
          // Keep it after release, matching the other endings: the slow probe must hold neither the
          // workspace nor the run's resource claims.
          await captureQuotaAfter(requireRun(run.id))
        }
      } finally {
        if (run) preempting.delete(run.id)
      }
    })()
  }, WRAP_UP_GRACE_MS)
}

/**
 * A prompt and the images that go with it.
 *
 * ⚠️ The paths of these attachments are already written into `text`; the list is here because
 * the *bytes* travel by a route the sentence cannot express, and each adapter takes a different
 * one. See `AdapterCapabilities.imageInput`.
 */
export interface BuiltPrompt {
  text: string
  attachments: Attachment[]
}

/**
 * What the agent is actually told, and what it is being handed along with it.
 *
 * The handoff from a previous run is prepended, because a successor that has to rediscover the state
 * of the branch pays for it twice - once in tokens and once in the mistakes it makes meanwhile.
 *
 * ⛔ Returns the attachments as well as the text, rather than only the text with the paths written
 * into it. The caller needs the list itself: a `spawn-flag` adapter puts the files in its argv, an
 * `inline` one puts the bytes in the envelope, and neither can be recovered from a sentence.
 */
/**
 * Which turn of a Plan & Split task this is.
 *
 * ⛔ Derived from whether the plan has pieces yet, not from a stored phase. A phase column would be a
 * second copy of a fact the edges already carry, and the two would disagree the first time a split
 * half-failed. ⚠️ `planning` is also the answer for a planner whose split was refused, which is
 * correct: it is being asked to plan again.
 */
export function planPhaseOf(task: Task): 'planning' | 'resolving' {
  return splitChildrenOf(task.id).length > 0 ? 'resolving' : 'planning'
}

/**
 * What the planner is told on its first turn.
 *
 * ⛔ **"Do not write code" is the load-bearing sentence.** An agent handed a repository and a
 * requirement will start building it, and a planner that builds the first piece itself has spent the
 * expensive context on the cheapest part of the job and left its own split with nothing to do.
 */
function planningInstruction(checkLead: string): string {
  void checkLead
  return [
    'You are PLANNING this work, not doing it.',
    '',
    'Read enough of the repository to be concrete — real file names, real functions, real ' +
      'constraints. Use `ask_human` for anything that changes what gets built; that is what this ' +
      'phase is for, and a question now is far cheaper than three subtasks built on a guess.',
    '',
    'When the requirement is settled, call `task_split` ONCE with the whole plan. Each piece must be ' +
      'completable by an agent that has NOT read this conversation, so its instruction has to carry ' +
      'its own context: what to change, where, and what "done" looks like. The dispatcher treats ' +
      'pieces without dependency edges as parallel work. If your plan says pieces must run or land ' +
      'sequentially, encode that ordering with `depends_on` even when the reason is integration or ' +
      'risk rather than a direct code dependency. Otherwise use `depends_on` only where one piece ' +
      'genuinely needs an earlier piece — an edge you did not need costs a subtask’s wait for nothing.',
    '',
    'The operator approves the whole split before anything is filed, so make each piece legible on a ' +
      'card. Do NOT write code, and do NOT start any of the pieces yourself. After the split ' +
      'returns, stop — you will be started again once every piece has settled.'
  ].join('\n')
}

/**
 * The sentence that closes the loop this project spent t226 falling into.
 *
 * ⛔ **An agent that stops without saying so is indistinguishable from one that is still working.**
 * An ordinary run stays open until `task_complete` arrives — that is the whole of its contract — so
 * a turn that ends any other way leaves the run open, the task reading `running`, the workspace held
 * and the worker slot reserved, for as long as the daemon lives. `await_human` is the tool that says
 * it; this is what makes the agent aware it has one, at the exact moment it would otherwise go quiet.
 *
 * ⭐ Measured on t226, 2026-09-05: the operator answered *"go with option C — I will close it out
 * myself"*, the agent obeyed and stopped, and the board showed the task running for the rest of the
 * evening because nothing it could call meant *"I have stopped"*.
 *
 * ⚠️ Deliberately appended to the sentence that asks for completion rather than offered beside it.
 * Named on its own it reads as an exit, and an agent handed an exit takes it.
 */
const HAND_BACK_CLAUSE =
  ' If the rest genuinely needs a person — a step only they can take, or work they have said they ' +
  'will close out themselves — call `await_human` with the reason instead of simply stopping. ' +
  'Ending your turn without calling one of these leaves the task reading as still running.'

/**
 * What the planner is told when its pieces have all settled.
 *
 * ⛔ The table of outcomes is prepended by the caller, because "some of them failed" is the normal
 * case and the resolution turn exists precisely to deal with it. A planner woken with no idea what
 * happened would start by re-reading every child's thread at full price.
 */
function resolutionInstruction(task: Task, checkLead: string, commitHygiene: string): string {
  // ⛔ Named with their outcomes, because "some of them failed" is the normal case and a planner
  //    woken with no idea what happened would re-read every child's thread at full price to find out.
  const roll = splitChildrenOf(task.id)
    .map((child) => {
      const label = child.titleSummary ?? child.title.split(/\r?\n/)[0] ?? ''
      const why = child.status === 'completed' ? '' : ` — ${child.holdReason ?? 'no reason recorded'}`
      return `  t${child.seq} · ${child.status}${why}: ${label.slice(0, 160)}`
    })
    .join('\n')
  return [
    'Every piece of your plan has settled, and this branch already contains everything they merged ' +
      'into it. Some may have failed — that is why you are here rather than the task simply closing.',
    '',
    'How each piece turned out:',
    roll,
    '',
    'Review the result as a WHOLE: the pieces were built by agents that could not see each other’s ' +
      'work, so the seams between them are where the problems are. Small gaps you fix here. Large ' +
      'ones, or anything that changes what was agreed, ask about with `ask_human`.',
    '',
    'Work to the end without stopping between phases. ' +
      checkLead +
      'When the work is finished, call the MCP tool `task_complete` with a one-line summary. ' +
      commitHygiene +
      HAND_BACK_CLAUSE
  ].join('\n')
}

/**
 * What a conversation is told at the end of every turn, instead of "finish the job".
 *
 * ⛔ **The whole of the difference between this kind and `work`, and it is a subtraction.** The
 * ordinary closing instruction says run to the end, run the checks, commit, squash, report complete
 * — which is exactly right for a task dispatched at 3am and exactly wrong when a person is reading
 * each turn as it lands. Left in place it makes every reply in a conversation end with a landing
 * nobody asked for, and an agent that has been told to commit will commit half-finished work rather
 * than appear to have disobeyed.
 *
 * ⛔ **`task_complete` is still named, and is still the only completion signal.** What changes is
 * who decides to send it: the agent is told not to reach for it on its own judgement, because the
 * person it is talking to has a Finish button and that button is the judgement. Leaving the tool
 * unmentioned would be worse than either — see the note in `promptFor` about naming tools an agent
 * has not got, which has the same failure mode in reverse.
 *
 * ⚠️ Nothing is said about the project's checks or about squashing. Both belong to a commit, the
 * Commit button is what asks for one, and that button re-enters the ordinary instruction above with
 * the rung the operator picked. Saying it here would be telling the agent to do work whose result it
 * has just been told not to commit.
 *
 * ⚠️ Two endings, because the terminal contract is not the same on both. An MCP adapter is told not
 * to *call* `task_complete`; an MCP-less one is told not to *write* the line that stands in for it.
 * Naming the wrong one would be naming a channel the agent has not got, which is the failure the
 * note on `capabilities.mcp` in `promptFor` describes.
 */
function conversationInstruction(mcpLess: boolean): string {
  return (
    'This is an ongoing conversation, not a one-shot task. Answer what has just been asked and ' +
    'stop there — you will get another turn, so there is no need to finish everything now and no ' +
    'need to leave the work in a shippable state at the end of every turn. ' +
    'Do not commit, merge, push, or run this project’s checks unless you are asked to: a person ' +
    'decides when this work is committed, from the buttons on this thread. ' +
    (mcpLess
      ? 'Do not end a reply with a line beginning `TASK COMPLETE: ` on your own judgement — that ' +
        'line reports the whole task finished, so write it only if you are told the work is done. ' +
        'If you need a decision from a person, end your reply with a line beginning `NEEDS DECISION:` ' +
        'followed by the question, and stop rather than guessing. If you are choosing between ' +
        'specific options, put each one on its own line directly under it as ' +
        '`- <the option> — <what choosing it means>`, so they can be offered as buttons.'
      : 'Do not call `task_complete` on your own judgement — call it only if you are told the work ' +
        'is done. If you need a decision from a person, call `ask_human` rather than guessing — ' +
        'offer the options you are choosing between, and it waits for a real answer.')
  )
}


export function promptFor(
  task: Task,
  adapterId: string,
  resumed = false,
  opts: { markDelivered?: boolean; branchNotice?: string | null } = { markDelivered: true }
): BuiltPrompt {
  const parts: string[] = []
  const attachments: Attachment[] = []
  if (opts.branchNotice) {
    parts.push(opts.branchNotice)
  }
  if (task.handoffNote) {
    parts.push(
      ['Continuing earlier work. Handoff from the previous session:', task.handoffNote, ''].join('\n')
    )
  }
  // ⚠️ The first prompt-bearing message is the task's own prompt and is restated: a fresh session after a
  // preemption has no idea what it was asked to do. Everything after it is a *note*, and a note
  // typed into a live session was already answered there - repeating it would charge for it twice and
  // leave the agent unsure what is still outstanding.
  //
  // ⛔ Except into a resumed conversation, which is the one case where the reason above does not
  // hold: that session has the original prompt in its own history and everything it did about it.
  // Restating it there reads as being asked to do the work a second time, which is the failure the
  // delivery bookkeeping exists to prevent - it would just be arriving through the one message the
  // bookkeeping deliberately exempts.
  const thread = messagesFor(task.id).filter(
    (m, i) => m.role === 'human' || m.role === 'controller' || (m.role === 'agent' && i === 0)
  )
  const outstanding = thread.filter((m, i) => (i === 0 && !resumed) || m.deliveredAt === null)
  const initialPrefixCount = (opts.branchNotice ? 1 : 0) + (task.handoffNote ? 1 : 0)
  if (thread.length === 0 && !resumed) {
    parts.push(task.title)
  } else {
    for (const message of outstanding) {
      if (parts.length === initialPrefixCount && message.text !== task.title) {
        parts.push(task.title)
      }
      parts.push(message.text)
    }
  }
  // ⛔ **The attachments that travel are the attachments of the messages that travel**, and this is
  // the only rule that is right in every case. Anything else either replays a screenshot on every
  // run of a long task — paying for it each time — or drops it on the fresh session a preemption
  // starts, where the agent is being handed the original prompt and needs the picture that came
  // with it. The delivery bookkeeping already decides this; the images just follow it.
  for (const message of outstanding) attachments.push(...message.attachments)
  if (opts.markDelivered && outstanding.length > 0) {
    markDelivered(outstanding.map((m) => m.id))
  }

  // ⛔ **The absolute path goes in the text on every adapter, including the ones that also get the
  // bytes.** It costs ~20 tokens, all three CLIs read a PNG off disk with their own view tool
  // (measured 2026-08-31, agy included), and it is what rescues a run whose inline block a vendor
  // update quietly stopped accepting. On antigravity, which cannot be sent bytes at all, it is not
  // a fallback — it is the whole channel.
  if (attachments.length > 0) {
    parts.push(
      (attachments.length === 1 ? 'Attached context: ' : 'Attached context: ') +
        attachments.map(describeAttachment).join('; ') +
        '. Open the file if you need to see it.'
    )
  }

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
  const project = task.projectId ? getProject(task.projectId) : null
  const { policy } = resolveFinishPolicy(task, project)
  const checks = policyVerifies(policy) ? (project?.config?.check ?? []) : []
  // Keep a task branch reviewable and cheap to rebase. This is conditional: a branch can legitimately
  // carry separate commits when it contains independently useful work, and the agent must never
  // rewrite anything that is already on the landing target.
  const commitHygiene =
    'When committing, if two or more commits ahead of this task branch’s landing target all belong ' +
    'to this task, squash them into one coherent commit where safe. Do not rewrite commits already ' +
    'on the landing target, force-push, or use a destructive reset.'

  // ⛔ **A plan task's closing instruction is a different instruction**, and it is selected on
  // `task.kind` — which is a domain fact, not a mode name. (The rule this codebase enforces against
  // branching on a name is about adapters and objectives, which are *data*; what kind of thing a task
  // is is not.) Phase 1 delegates and stops; phase 2 reviews what came back and finishes.
  const planPhase = task.kind === 'plan' ? planPhaseOf(task) : null

  if (adapter(adapterId).info.capabilities.mcp) {
    // ⛔ The completion mode changes what "finished" means, so it belongs in the same sentence
    // as `task_complete` rather than somewhere earlier in the prompt. ⚠️ `ask_human` is offered
    // in **both** modes: stopping for a decision that changes what you build is never the thing being
    // discouraged, and an autonomous agent that guessed instead would be the failure this all exists
    // to prevent.
    const checkpointed =
      resolveCompletionMode(
        task,
        task.projectId ? getProject(task.projectId) : null,
        settings().completionMode
      ).mode === 'checkpointed'
    const checkLead =
      checks.length > 0
        ? `Before reporting complete, run this project's checks (${checks.map((c) => `\`${c}\``).join(', ')}) and ensure they pass. `
        : ''
    if (isOpenConversation(task)) {
      parts.push(conversationInstruction(false))
    } else if (planPhase === 'planning') {
      parts.push(planningInstruction(checkLead))
    } else if (planPhase === 'resolving') {
      parts.push(resolutionInstruction(task, checkLead, commitHygiene))
    } else
    parts.push(
      (checkpointed
        ? 'Work in phases. At each phase boundary call the MCP tool `checkpoint` with what you have ' +
          'done and what you propose to do next, and wait for the answer before starting the next ' +
          'phase. When every phase is done, ' +
          (checkLead ? checkLead.toLowerCase() : '') +
          'call `task_complete` with a one-line summary. '
        : 'Work to the end without stopping between phases. ' +
          checkLead +
          'When the work is finished, call the MCP tool `task_complete` with a one-line summary. ') +
        commitHygiene + ' If you need a decision from a person, call `ask_human` rather than guessing — offer the ' +
        'options you are choosing between, and it waits for a real answer.' + HAND_BACK_CLAUSE
    )
  } else {
    // ⛔ The options are asked for in the same breath as the question, because the operator's side
    // of this is a card with buttons on it. A question whose choices are written into the sentence -
    // *"(Option A) ... (Option B)"*, which is what antigravity did on t63 - arrives answerable only
    // in prose, and nothing here will guess the choices back out of it.
    const checkLead =
      checks.length > 0
        ? `Before finishing, run this project's checks (${checks.map((c) => `\`${c}\``).join(', ')}) and ensure they pass cleanly. `
        : ''
    // ⛔ The same subtraction as above, in the vocabulary this adapter was given. An MCP-less agent's
    // terminal contract is a line of text rather than a tool call, so a conversation has to be told
    // not to write that line rather than not to call that tool — but it still has to be told what
    // the line *is*, because being asked to finish is a thing that can happen to it later.
    parts.push(
      isOpenConversation(task)
        ? conversationInstruction(true)
        : checkLead +
        'When the work is finished, commit what you have and end with a line beginning `TASK COMPLETE: ` ' +
        'followed by a one-line summary of what changed. ' + commitHygiene + ' If you need a decision from a person, end your reply with a line beginning ' +
        '`NEEDS DECISION:` followed by the question, and stop rather than guessing. If you are ' +
        'choosing between specific options, put each one on its own line directly under it as ' +
        '`- <the option> — <what choosing it means>`, so they can be offered as buttons. ' +
        'If multiple options can be chosen (checkboxes), indicate that with `NEEDS DECISION: [multi] <question>` ' +
        'or include `(multi-select)` / `(select all that apply)` in the question.'
    )
  }

  // ⛔ **A conversation stops here, and skipping the block below is the point rather than an
  // omission.** What follows tells a `streamPrompts: 'once'` CLI that it gets one turn and must
  // commit everything in it — the exact instruction a conversation exists to withhold. The reason
  // that block exists still holds for such an adapter (its process really does end with the turn),
  // but the consequence does not: a conversation's next turn arrives on a *revived* session, its
  // workspace is retained across the wait, and the commit is the operator's to ask for.
  if (isOpenConversation(task)) {
    return { text: parts.join('\n\n'), attachments }
  }

  // ⛔ A `streamPrompts: 'once'` CLI gets its landing instruction **here or never**. The
  // `ask-agent` finish - *tell the still-live agent to commit* - requires a live session, and such a
  // process exits the instant its one turn ends. That is structural, not unlucky: measured on t56,
  // 2026-08-30, where the instruction was composed, could not be sent, and the task rested with two
  // uncommitted files it had been told to commit only in the vaguest terms.
  //
  // ⚠️ Deliberately narrow. A `conversation` adapter may still be reachable afterwards, and
  // whether Antigravity's print-mode process outlives its turn has **not been measured** - so it
  // keeps the existing behaviour rather than being guessed at.
  if (adapter(adapterId).info.capabilities.streamPrompts === 'once') {
    const project = task.projectId ? getProject(task.projectId) : null
    // ⛔ Through `resolveFinishPolicy`, never by reading `landing.finishInstruction` directly.
    // That field is defined as *what a `custom` finish tells the agent*, and the resolver is the
    // one place that gate lives - it returns an instruction only when the resolved policy really
    // is `custom`. Read raw, it fired under every policy: measured on t56, 2026-08-30, where a
    // project on `commit-and-merge` sent codex *"Run /commit and follow every one of its six
    // steps. Do not push."* - a Claude Code skill codex has not got, whose sixth step **is** the
    // push the same sentence forbids. Two contradictions and a dead command, in the one turn the
    // agent had.
    const { policy, instruction } = resolveFinishPolicy(task, project)
    // ⛔ The plain fallback says what the *resolved policy* actually wants, rather than "commit"
    // and nothing else. Silence about pushing is not neutral: the agent has to guess, and t56's
    // operator had written "Do not push" by hand precisely because the prompt would not say it.
    // Only the two policies that want a remote ask for one.
    const pushes = policy === 'commit-and-push' || policy === 'pull-request'
    const plain =
      'Commit everything you change' +
      (task.branch ? ` on \`${task.branch}\`` : '') +
      ' before your turn ends. ' +
      commitHygiene + ' ' +
      (pushes
        ? 'Then push it — nothing will do that for you afterwards.'
        : 'Do not push; the tool takes it from there. Nothing will ask you again.')
    parts.push(
      'You get one turn and no follow-up, so finish the job in it. ' + (instruction ?? plain)
    )

    // ⛔ Say who runs the checks, because the agent cannot find out and guessing costs it the turn.
    // `runChecks` executes this list in the **daemon**, outside whatever sandbox the worker is in.
    // Measured on t56, 2026-08-30: codex ran `npm test` itself under `--sandbox workspace-write`,
    // was denied the WMI query one test needed, could not tell a denied query from a regression it
    // had caused, and stopped to ask about a suite that passes unsandboxed on the same machine.
    //
    // ⚠️ Only when the policy actually verifies *and* commands are declared. On any other rung, or
    // an empty list, nothing runs them afterwards and telling the agent otherwise would be a lie
    // that talks it out of the only checking anybody does.
    const checks = policyVerifies(policy) ? (project?.config?.check ?? []) : []
    if (checks.length > 0) {
      parts.push(
        'You do not have to run this project’s checks yourself: after you commit, the tool runs ' +
          `${checks.map((c) => `\`${c}\``).join(', ')} outside your sandbox and reports the ` +
          'result. Run what you need to be confident in the change, but a command that fails ' +
          'because your environment forbids it is not a reason to stop — say so and commit.'
      )
    }
  }
  return { text: parts.join('\n\n'), attachments }
}

/**
 * The commits this task's **siblings** put on their shared landing target.
 *
 * ⛔ **The third leg of the trunk tripwire, and Plan & Split is why it is needed.** The tripwire
 * refuses a verdict when a task's branch is empty *and* its target moved during the run — the t17
 * signature, an agent that worked in the trunk instead of on its branch. Under a split that pairing
 * stops being evidence of anything: children land onto the shared plan branch **while their siblings
 * run**, by design and constantly, so a child that legitimately committed nothing would be refused
 * its verdict and named in the log as a tripwire hit.
 *
 * ⛔ Attribution rather than exemption. Exempting children would hand back exactly the hole t17 came
 * through, on the tasks that write the most code — a child that commits onto the plan branch instead
 * of its own branch is the same failure one level down. So sibling commits are *subtracted*, and
 * anything left unaccounted for still fires.
 *
 * ⚠️ Empty for every task that is not part of a split, which leaves the rule exactly as it was.
 */
function siblingLandedShas(task: Task): string[] {
  if (!task.parentTaskId || !task.landingTarget) return []
  return listTasks()
    .filter(
      (other) =>
        other.id !== task.id &&
        other.parentTaskId === task.parentTaskId &&
        other.landingTarget === task.landingTarget &&
        !!other.landedHeadSha
    )
    .map((other) => other.landedHeadSha as string)
}

/**
 * What the trunk's landing target did while this run was in flight.
 *
 * ⛔ Returns null unless there are **two** readings. A run dispatched before the tripwire existed has
 * no `trunkShaBefore`, and a project whose target cannot be resolved has no `after` — in both cases
 * the honest answer is "cannot say", and `decideFinish` declines to fire on it. Null is never
 * "the trunk did not move", which would be a guess pointing the wrong way.
 */
async function readTrunkMovement(
  project: Project,
  target: string,
  run: Run
): Promise<TrunkReading | null> {
  const before = run.trunkShaBefore
  if (!before) return null
  const after = await trunkTargetSha(project, target)
  if (!after || after === before) return null
  return { before, after, commits: await trunkCommitsSince(project, before, after) }
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

  // ⚠️ Dependents are admitted by the `setStatus` above, for every path that completes a task. The
  // explicit call that used to sit here was one of three, and the four paths without one is how
  // t193 stayed blocked behind a finished t192.
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
/**
 * Sessions whose completion is still landing.
 *
 * ⛔ **Claimed synchronously, before the first `await`.** `completeTask` closes its run on its
 * last line, after three git reads - so for the whole of that window the run has no outcome and no
 * `ended_at`, and `runForSession` still hands it to anyone who asks. Both entry points are
 * `void`-invoked from index.ts, so nothing serialised them.
 *
 * Measured on t56, 2026-08-30: codex reported complete at 20:35:45.653, its process exited 668ms
 * later while `completeTask` was still reading the workspace, and `onSessionExit` marked the run
 * `failed` and the task `awaiting_human` - *"nothing here can tell whether the work was finished"* -
 * for a run that had already reported it was. The completion then resumed and tried to ask a dead
 * session to commit.
 *
 * ⚠️ Every adapter has this race; a `streamPrompts: 'once'` CLI loses it every time, because
 * its process exits the instant the turn ends. It stayed invisible until codex could complete at all.
 */
const completing = new Set<string>()

export async function completeTask(sessionId: string, summary: string): Promise<void> {
  const run = runForSession(sessionId)
  if (!run?.taskId || run.outcome) return
  const task = getTask(run.taskId)
  if (!task) return
  if (completing.has(sessionId)) return
  completing.add(sessionId)
  try {
    await landCompletion(sessionId, run, task, summary)
  } catch (err) {
    log.error(`could not complete task ${task.id} on session ${sessionId}:`, err)
    const session = getSession(sessionId)
    if (session && sessionEnded(session.state)) {
      await releaseWorkspaceOf(sessionId, task.id)
    }
    throw err
  } finally {
    completing.delete(sessionId)
  }
}

/**
 * The agent has gone as far as it can, and the rest is a person's to do.
 *
 * ⛔ **The other terminal contract, and the one that was missing.** An ordinary run stays open
 * until `task_complete` arrives — that is the whole of its contract — so an agent that finishes its
 * turn without calling it leaves the run open, the task reading `running`, the workspace held and the
 * worker slot reserved, for as long as the daemon lives. `endConversationTurn` closes that gap for a
 * conversation; nothing closed it for a task.
 *
 * ⭐ Measured on t226, 2026-09-05. The agent landed its work by hand, the trunk tripwire refused to
 * close the task — correctly — and the operator answered *"go with option C: I will close it out
 * myself."* The agent then did exactly what it was told and stopped. It had no way to **say** that it
 * had stopped: `task_complete` would have asserted a success the tripwire had just refused, `handoff`
 * records a note and ends nothing, and `ask_human` asks a question it did not have. So the turn ended,
 * the session sat live and idle, and the board showed the task running for the rest of the evening.
 *
 * ⛔ **This is not a quieter `task_complete`, and it must never become one.** It claims nothing about
 * the work, lands nothing, commits nothing, runs no checks and moves no branch — the task comes to
 * rest at `awaiting_human` carrying the agent's own reason, which is the same resting place every
 * `await-human` verdict in finish.ts already uses. What it buys is that the *stopping* is recorded
 * rather than inferred from silence.
 *
 * ⚠️ The session is kept warm exactly as a completion that parks does, because the next thing to
 * happen is a person typing, and `continueTask` turns that reply into a new run on the same thread.
 */
export async function parkForHuman(
  sessionId: string,
  reason: string,
  state?: string
): Promise<{ ok: boolean; reply: string }> {
  const run = runForSession(sessionId)
  if (!run?.taskId || run.outcome) {
    return { ok: false, reply: 'This session has no open run, so there is nothing to hand over.' }
  }
  const task = getTask(run.taskId)
  if (!task) {
    return { ok: false, reply: 'This session is not working on a task.' }
  }
  // ⛔ A completion already owns this session's teardown and has not finished writing yet. Parking
  //    underneath it would overwrite a reported completion with a hand-off, which is the t56 race in
  //    the other direction.
  if (completing.has(sessionId)) {
    return {
      ok: false,
      reply: 'A completion for this task is still landing. Wait for it rather than handing over now.'
    }
  }

  const why = reason.trim() || 'the agent stopped and asked for a person'
  log.info(`t${task.seq} handed to a person by the agent: ${why.slice(0, 200)}`)

  addMessage(task.id, 'agent', `Over to you: ${why}`, run.id)
  // ⭐ Recorded as the handoff too when the agent wrote one, so a successor run does not pay to
  //    rediscover the state of the branch. Same note, two places, one call.
  if (state?.trim()) {
    setTaskHandoff(task.id, state.trim())
    addMessage(task.id, 'agent', `Where things stand:
${state.trim()}`, run.id)
  }
  setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
  // ⛔ `blocked`, never `completed`. The run did work and metered turns and is one answer away from
  //    continuing; filing it as `failed` would say the opposite of what happened, and filing it as
  //    `completed` would feed the estimator a job that stopped half way through as if it were a
  //    measurement of the whole one. See `RunOutcome`.
  finishRun(run.id, 'blocked', why)
  void captureQuotaAfter(requireRun(run.id))

  const project = task.projectId ? getProject(task.projectId) : null
  const session = getSession(sessionId)
  if (session && !sessionEnded(session.state)) {
    log.info(`t${task.seq} is waiting on a person - keeping its session warm for the reply`)
  } else {
    await releaseWorkspaceOf(sessionId, task.id)
  }
  await releaseFor(run.id, task.id, project?.id ?? null)

  return {
    ok: true,
    reply:
      `Recorded. t${task.seq} is now waiting for a person and this run is closed. Nothing was ` +
      'landed, committed or discarded. STOP HERE — you will be started again if they reply.'
  }
}

async function landCompletion(
  sessionId: string,
  run: Run,
  task: Task,
  summary: string
): Promise<void> {

  // A first landing failure gets one fresh run. This is carried to the common teardown below so the
  // run and workspace are closed before the retry becomes dispatchable.
  let automaticRetry = false

  let effectiveSummary = (summary ?? '').trim()
  if (!effectiveSummary || effectiveSummary === 'Completed') {
    const recentActivity = activityFor(task.id)
    const proseLines = recentActivity
      .map((a) => a.text)
      .filter(
        (t) =>
          t &&
          !t.startsWith('[Tool:') &&
          !t.startsWith('[run:') &&
          !t.startsWith('[search:') &&
          !t.startsWith('[find:') &&
          !t.startsWith('[list:') &&
          !t.startsWith('[fetch:')
      )
    if (proseLines.length > 0) {
      effectiveSummary = proseLines.slice(-3).join('\n')
    } else {
      effectiveSummary = 'Completed'
    }
  }

  const existing = messagesFor(task.id).filter((m) => m.runId === run.id && m.role === 'agent')
  const alreadyAdded = existing.some((m) => m.text.trim() === effectiveSummary.trim())
  if (!alreadyAdded) {
    addMessage(task.id, 'agent', effectiveSummary, run.id)
  }

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
    const state = await workspaceState(held.workspace.path, landingTargetFor(task, project))
    // ⛔ Read **before** anything lands. `landTask` fast-forwards the trunk itself on a project with
    // no remote, so a reading taken afterwards would report the tool's own push as the movement it
    // is looking for — a tripwire that fires on its own footsteps is worse than none.
    const trunk = await readTrunkMovement(project, landingTargetFor(task, project), run)
    // ⭐ Asked **before** the decision, and it touches nothing — `merge-tree` merges in memory. This
    // is what lets a conflict be handed back to the live conversation instead of becoming a dead-end
    // `awaiting_human` discovered inside `landTask` two branches later. See `readMergeability`.
    // ⛔ The *finish* policy, not the project policy beside it. It decides which ref the landing
    // will rebase onto, so the mergeability check has to be told it or it answers about another.
    const finishPolicy = resolveFinishPolicy(task, project).policy
    const merge = await readMergeability(project, held.workspace.path, task.branch, finishPolicy, task)
    const decision = decideFinish({
      task,
      project,
      state,
      hasChecks: policy.check.length > 0,
      trunk,
      merge,
      siblingLanded: siblingLandedShas(task)
    })
    log.info(`t${task.seq} finish: ${decision.kind} (${finishPolicy})`)


    if (decision.kind === 'ask-agent') {
      // ⛔ Not attempted at all on a one-shot CLI. The ask needs a live session and such a
      // process is already gone by definition, so trying produces a warning in a log nobody is
      // reading and a hold reason that does not say why. It fails every single time, which makes it
      // a fact about the adapter rather than an error - and the operator is told that.
      const finishing = getSession(sessionId)
      const oneShot =
        finishing !== null &&
        adapter(finishing.adapterId).info.capabilities.streamPrompts === 'once'
      if (oneShot) {
        addMessage(
          task.id,
          'system',
          `${decision.reason}. ${adapter(finishing.adapterId).info.label} runs one turn and exits, ` +
            'so it cannot be asked to finish the job afterwards — this one is over to you. Its next ' +
            'run is told to land its own work.'
        )
        setStatus(task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: `${decision.reason}, and this CLI cannot be asked after its turn ends`
        })
        finishRun(run.id, 'completed', summary)
        await releaseFor(run.id, task.id, project.id)
        await releaseWorkspaceOf(sessionId, task.id)
        await resolveRetryOnTask(task.id, true)
        return
      }
      // ⛔ Returns without ending the run. The agent is still working — it has been handed one more
      // instruction and will report completion again — so closing the run here would orphan a live
      // session and release a workspace out from under it.
      markFinishAsked(task.id)
      addMessage(task.id, 'system', decision.instruction)
      try {
        sendPrompt(sessionId, decision.instruction)
      } catch (err) {
        log.warn(`could not send the finish instruction for t${task.seq}:`, err)
        addMessage(task.id, 'system', 'Could not reach the session to ask. Over to you.')
        setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
        finishRun(run.id, 'completed', summary)
        await releaseFor(run.id, task.id, project.id)
        await releaseWorkspaceOf(sessionId, task.id)
      }
      return
    }

    // ⚠️ Not `decision.kind === 'land'` any more: a conflict that resolves itself below arrives here
    //    with kind `resolve-conflict` and still has to land. Reading the kind directly is what made
    //    the first draft of this fall through the whole chain and silently land nothing.
    let landNow = decision.kind === 'land'

    if (decision.kind === 'resolve-conflict') {
      // ⛔ Not attempted at all on a one-shot CLI, exactly like `ask-agent` above and for the same
      // reason: the ask needs a live session, and such a process is already gone by definition. Left
      // unchecked here, `sendPrompt` below throws, the rebase this function had just started gets
      // aborted to hand the workspace back, and the operator is told only that the send failed — not
      // that the CLI could never have answered. Measured on t102, 2026-09-01: CodexFirst (`codex`,
      // `streamPrompts: 'once'`) reported complete, hit `resolve-conflict`, and the task landed at
      // `awaiting_human` with the rebase never started for it to resume from.
      const finishing = getSession(sessionId)
      const oneShot =
        finishing !== null &&
        adapter(finishing.adapterId).info.capabilities.streamPrompts === 'once'
      if (oneShot) {
        addMessage(
          task.id,
          'system',
          // ⛔ `decision.reason`, not a message composed fresh here: finish.ts's `landOrResolve`
          // names the branch and says "has a conflict" on purpose, and this is also exactly the
          // sentence `holdReason` gets two lines down — the message in the thread and the reason on
          // the task must read as the same fact, not two summaries of it that could drift apart.
          `${decision.reason}. ${adapter(finishing.adapterId).info.label} runs one turn and exits, ` +
            'so it cannot be asked to resolve the conflict mid-session — this one is over to you. ' +
            `Conflicts with \`${decision.base}\` in ${decision.paths.join(', ') || 'unknown files'}.`
        )
        setStatus(task.id, 'awaiting_human', {
          assignee: 'human',
          holdReason: `${decision.reason}, and this CLI cannot be asked after its turn ends`
        })
        finishRun(run.id, 'completed', summary)
        await releaseFor(run.id, task.id, project.id)
        await releaseWorkspaceOf(sessionId, task.id)
        await resolveRetryOnTask(task.id, true)
        return
      }
      // ⛔ Returns without ending the run, exactly like `ask-agent` above: the agent is still working
      //    and will report completion again, so closing the run here would orphan a live session and
      //    release the workspace holding the half-finished rebase.
      //
      // ⭐ The rebase is started *here* and deliberately left stopped at the conflict. `landTask`
      //    aborts on conflict — correctly, because nobody holds that workspace — and an agent handed
      //    an aborted rebase has to reproduce it before it can begin. This one finds the markers
      //    already in its tree.
      const begun = await beginConflictResolution(held.workspace.path, decision.base)
      if (begun.resolved) {
        // ⭐ Another task landed between the probe and here and took the conflict with it. Nothing to
        //    ask, and ⛔ nothing to *mark* — a task that was never asked keeps its one ask.
        log.info(`t${task.seq} conflict resolved itself before the agent was asked; landing`)
        landNow = true
      } else {
        const paths = begun.paths.length ? begun.paths : decision.paths
        addMessage(task.id, 'system', decision.instruction)
        // ⛔ Marked before the prompt goes out, and only on the path that actually prompts. A send
        //    that throws still counts as an ask — the failure path hands the task to a person — but
        //    a conflict that never needed asking about must not spend the one ask.
        markConflictAsked(task.id)
        try {
          sendPrompt(sessionId, decision.instruction)
          log.info(
            `t${task.seq} asked to resolve ${paths.length} conflicted path(s) onto ${decision.base}`
          )
        } catch (err) {
          // ⛔ Abort before giving up. A workspace left mid-rebase cannot be parked — `git switch`
          //    refuses — so a slot abandoned in this state is one slot fewer for the fleet until
          //    somebody notices by hand.
          log.warn(`could not send the conflict instruction for t${task.seq}:`, err)
          await abortRebase(held.workspace.path)
          addMessage(
            task.id,
            'system',
            'Could not reach the session to ask, so the rebase was put back and nothing was lost. ' +
              `Over to you: \`${task.branch}\` conflicts with \`${decision.base}\` in ` +
              `${paths.join(', ') || 'unknown files'}.`
          )
          setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
          finishRun(run.id, 'completed', summary)
          await releaseFor(run.id, task.id, project.id)
          await releaseWorkspaceOf(sessionId, task.id)
        }
        return
      }
    }

    if (landNow) {
      const result = await landTask({
        project,
        task,
        workspacePath: held.workspace.path,
        branch: task.branch,
        // ⛔ The resolved policy chooses the strategy. Without it `landTask` fell back to the
        // project's legacy `landing.strategy`, so the policy resolved task > project > fleet and the
        // action that ran were two different answers - a project set to `pull-request` with no
        // `strategy` would have had its trunk pushed.
        policy: resolveFinishPolicy(task, project).policy
      })
      if (result.ok) setStatus(task.id, 'completed')
      else automaticRetry = true
    } else if (decision.kind === 'await-human') {
      addMessage(task.id, 'system', `Finished, and not landed: ${decision.reason}`)
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
    } else if (decision.kind === 'trunk-moved') {
      // ⛔ Handed to a person rather than reported as finished. The run is still closed normally by
      //    the tail below — what is refused is the *verdict*, because commits that reached the trunk
      //    directly were seen by none of the checks, the rebase or the landing policy.
      //
      // ⚠️ Logged at warn, and the log line is the one an operator greps for after the fact.
      log.warn(
        `t${task.seq} trunk tripwire: \`${landingTargetFor(task, project)}\` moved during run ` +
          `${run.id.slice(0, 8)} while \`${task.branch}\` stayed empty`
      )
      const listed = decision.commits.length
        ? `\n\nWhat appeared in the trunk while it ran:\n${decision.commits
            .map((c) => `  ${c}`)
            .join('\n')}`
        : ''
      addMessage(task.id, 'system', `${decision.reason}${listed}`)
      setStatus(task.id, 'awaiting_human', {
        assignee: 'human',
        holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
      })
    } else if (decision.kind === 'nothing-to-land') {
      // ⭐ **Retire the branch here too, and this is the path that actually fires.** `decideFinish`
      //    reaches this verdict by proving `unlandedCommits === 0` against `state.landedRef`, which
      //    is the same proof `landTask`'s own early return uses — but this decision never calls
      //    `landTask`, so fixing only that early return left the branch stranded anyway.
      //    ⚠️ Measured 2026-08-29: t22's agent pushed its own work, and the dead branch it left was
      //    swept by hand. Once `landedRef` made that outcome legible, *every* such task takes this
      //    exact path, so the leak went from occasional to one per agent-pushed task.
      // ⛔ Only with a branch to retire. A project with no VCS has none, and `task.branch` is null
      //    for a task that never reached a workspace.
      // ⚠️ `state.landedRef`, not the local target: it is the ref `decideFinish` just compared
      //    against, and the message must name the same one the decision used.
      const retired = await finishWithoutLanding(held.workspace.path, task.branch, state.landedRef)
      addMessage(task.id, 'system', `Finished — ${decision.reason}${retired.note}`)
      setStatus(task.id, 'completed')
    } else {
      // ⚠️ Narrowed by hand: the chain now opens on `landNow` rather than on a kind, so TypeScript
      //    cannot rule out the kinds that carry no reason. `relandTask` reads it the same way.
      const why = 'reason' in decision ? decision.reason : 'nothing to land'
      addMessage(task.id, 'system', `Finished — ${why}`)
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
    const session = getSession(sessionId)
    if (session && !sessionEnded(session.state)) {
      log.info(`t${task.seq} is waiting on a person - keeping its session warm for the reply`)
    } else {
      await releaseWorkspaceOf(sessionId, task.id)
    }
  } else {
    await closeAndWait(sessionId)
    await releaseWorkspaceOf(sessionId)
  }
  await releaseFor(run.id, task.id, project?.id ?? null)
  if (automaticRetry) await resolveRetryOnTask(task.id, true)
  // ⚠️ No `admitDependents` here any more: `setStatus` does it on the transition into `completed`,
  // above, for this path and for the ones that never had a call at all. It lands a moment earlier
  // than it used to — before the workspace is released — which can cost a dependent one tick.
}

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
const blockedOn = new Map<string, string>()

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
    }
    return
  }
  if (completion) {
    await completeTask(session.id, completion)
    return
  }
  const run = runForSession(session.id)
  if (!run) return

  const said = stripAnsi(result.text ?? '').replace(/\s+/g, ' ').trim()
  const why =
    `The agent reported a failure${result.terminalReason ? ` (${result.terminalReason})` : ''}` +
    (said ? `: ${said.slice(0, 400)}` : ' and said nothing about it.')

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

/**
 * One place where a run that did not report completion is wound up.
 *
 * ⛔ Both callers ask the same question first, and it is not "did this fail" — it is **who failed**.
 * A run that never produced a metered turn did not fail at the work; it failed at the account, and
 * charging it to the task sends somebody to debug a prompt that was never delivered to anything.
 *
 * ⛔ And there is a third answer, which is **nobody**. A run that stopped because the agent asked a
 * person something has not failed at anything: it did the work up to the question, metered its turns,
 * and needs one answer to carry on. It used to be filed as `failed` on no evidence beyond the absence
 * of a completion signal — which also meant three questions in a row looked like a task that kept
 * failing and would summon `maybeTriage` to explain a pattern that was not there.
 */
/**
 * A conversation's turn is over, and that is not the end of anything else.
 *
 * ⛔ **Something has to end a conversation's turn, because nothing else will.** An ordinary run stays
 * open until `task_complete` arrives — that is the whole of its contract, and it is why the prompt
 * insists on it. A conversation is told the opposite, so without this its run would stay open, its
 * task would stay `running`, and the operator would be left watching a finished reply with no Finish,
 * no Stop and no Commit in front of them until the stall watchdog eventually mentioned it.
 *
 * ⛔ **The run ends; the session, the workspace and the branch do not.** That split is the feature.
 * Closing the run is what returns the task to a person and what keeps the metering honest — a turn
 * that has been paid for is a turn that has ended. Keeping the session live is what makes the reply
 * warm: `warmSessionFor` finds this task's own idle session first and unconditionally, `atCapacity`
 * exempts the session a task would reuse, and `releaseFor` deliberately leaves the workspace with the
 * conversation rather than with the run. So the next turn is a prompt written into a process that
 * still has every one of these turns in its context, standing in the same worktree on the same branch.
 *
 * ⚠️ The cost of that is one of the account's `maxConcurrent` slots, held until somebody presses
 * Finish or Stop. It is the same reservation a task resting on a question already makes, it is
 * counted (`retainedReservations`), and it is the price of the warm prefix the whole cost model is
 * built to buy.
 */
async function endConversationTurn(
  session: Session,
  run: Run,
  task: Task,
  resultText?: string | null
): Promise<void> {
  const why =
    'The agent finished this turn. Reply to carry on in the same conversation, or use Finish, Stop ' +
    'or Commit below. Nothing has been committed and nothing has been landed.'
  finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')

  let effectiveAnswer = (resultText ?? '').trim()
  if (!effectiveAnswer) {
    const recentActivity = activityFor(task.id)
    const proseLines = recentActivity
      .map((a) => a.text)
      .filter(
        (t) =>
          t &&
          !t.startsWith('[Tool:') &&
          !t.startsWith('[run:') &&
          !t.startsWith('[search:') &&
          !t.startsWith('[find:') &&
          !t.startsWith('[list:') &&
          !t.startsWith('[fetch:')
      )
    if (proseLines.length > 0) {
      effectiveAnswer = proseLines.slice(-3).join('\n')
    } else {
      effectiveAnswer = 'Completed turn'
    }
  }

  const existing = messagesFor(task.id).filter((m) => m.runId === run.id && m.role === 'agent')
  const alreadyAdded = existing.some((m) => m.text.trim() === effectiveAnswer.trim())
  if (!alreadyAdded) {
    addMessage(task.id, 'agent', effectiveAnswer, run.id)
  }

  addMessage(task.id, 'system', why)
  // ⚠️ The run ends either way; the *reason* is only written over a task that was still working. A
  // conversation whose agent asked a question is already resting on that question, and replacing
  // "the agent asked and is waiting on you: …" with this sentence would hide the one thing the
  // operator actually has to answer.
  if (task.status === 'running' || task.status === 'assigned') {
    setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
  }
  // ⛔ `releaseFor`, never `releaseWorkspaceOf`. The run's own claims go back so nothing it took
  // leaks; the worktree stays with the session, which is still standing in it.
  await releaseFor(run.id, task.id, task.projectId)
  void captureQuotaAfter(requireRun(run.id))
}

async function endUnfinishedRun(
  session: Session,
  run: Run,
  why: string,
  outcome: 'failed' | 'blocked'
): Promise<void> {
  const task = run.taskId ? getTask(run.taskId) : null

  // ⛔ **Asked before the run is wound up, because it changes what the run *was*.** A turn the
  // vendor refused for want of quota is not a failure of the work; it is the same event the mid-run
  // watchdog handles by parking the task, arriving by a different door. See `quotaFailurePark`.
  const parkAt = task && outcome === 'failed' ? quotaFailurePark(session, run, why) : null
  const overloadRetry =
    task && outcome === 'failed' && parkAt === null
      ? overloadFailureRetry(session, run, why, task)
      : null
  const ad = adapter(session.adapterId)
  const isOverload =
    Boolean(ad.overloaded?.(why) || (session.id ? ad.overloaded?.(stripAnsi(backscroll(session.id))) : false))

  finishRun(run.id, parkAt !== null || overloadRetry !== null ? 'preempted' : outcome, why)

  // ⛔ A blocked run is never dead on arrival, and the check is skipped rather than merely failing:
  // `deadOnArrival` reports on a dispatch that produced nothing, and this one produced a question.
  // Benching the worker over it would take a healthy account out of the fleet for doing its job.
  // Likewise for a provider overload (529): the worker's account is healthy, so benching the
  // worker over a temporary outage would quarantine working accounts.
  const dead = outcome === 'blocked' || isOverload ? null : deadOnArrival(session, run)

  if (task && (task.status === 'running' || task.status === 'assigned')) {
    if (parkAt !== null) {
      // ⛔ Ahead of the dead-on-arrival branch as well as the ordinary one. A run refused at the
      // first turn produces no metered turn and looks exactly like a lapsed account from here, and
      // benching a healthy worker over a window that will reopen on its own is the wrong answer to
      // both halves: the account is not broken, and the task has a time it can run again.
      addMessage(
        task.id,
        'system',
        `${why} That is this account's quota window, not a fault in the work — parked until it ` +
          `resets, expected ${new Date(parkAt).toISOString()}, and the fleet puts this back in the ` +
          'queue by itself then (sooner, if a reading shows the window has already come back).'
      )
      // ⛔ `not_before` before the status, and both before anything else can see the row: a task at
      // `paused_quota` with no reset time is one `resumeQuotaPaused` releases immediately, straight
      // back into the account that just refused it.
      db()
        .prepare('update tasks set not_before = ?, updated_at = ? where id = ?')
        .run(parkAt, Date.now(), task.id)
      setStatus(task.id, 'paused_quota', { assignee: null })
      // ⭐ The same nudge preemption sends. The poller schedules its next look from
      // `quotaParkedTasks`, and a reading taken now is what lets this come back early if the vendor
      // was quoting a limit that has since rolled over.
      requestUrgentProbe(run.workerId, `a run here was refused for quota (t${task.seq})`)
    } else if (overloadRetry !== null) {
      const delaySec = Math.round((overloadRetry.retryAt - Date.now()) / 1000)
      addMessage(
        task.id,
        'system',
        `${why} This is a temporary server-side issue from the provider — attempting again ` +
          `automatically in ${delaySec}s (attempt ${overloadRetry.attempt} of ${MAX_OVERLOAD_ATTEMPTS}, ` +
          `expected ${new Date(overloadRetry.retryAt).toISOString()}).`
      )
      db()
        .prepare('update tasks set not_before = ?, updated_at = ? where id = ?')
        .run(overloadRetry.retryAt, Date.now(), task.id)
      setStatus(task.id, 'scheduled', {
        assignee: null,
        holdReason: `Provider overloaded (attempt ${overloadRetry.attempt}/${MAX_OVERLOAD_ATTEMPTS})`,
        holdUntil: overloadRetry.retryAt
      })
    } else if (dead) {
      // ⚠️ The vendor's own words, where the stream gave any. `why` is a sentence a person can act
      // on — "your organization has disabled…" — while `deadOnArrival` can only report silence.
      const reason = session.lastRequestStartedAt === null && why.length > dead.length ? why : dead
      if (run.startedWarm) {
        invalidateSessionContext(session.id)
        const isAccountFault = Boolean(ad.needsReauth?.(reason) || ad.subscriptionExpired?.(reason))
        if (isAccountFault) {
          recordDispatchFailure(run.workerId, reason, run.id)
          addMessage(
            task.id,
            'system',
            `Nothing ran on this worker. ${reason} That account is held out of dispatch until it is ` +
              'probed again; this task goes back in the queue for another one.'
          )
        } else {
          log.warn(
            `conversation ${session.id.slice(0, 8)} failed to resume on ${run.workerId}; ` +
              `cleared prefix without holding out worker: ${reason}`
          )
          addMessage(
            task.id,
            'system',
            `Resuming conversation ${session.id.slice(0, 8)} failed (${reason}). ` +
              'The conversation prefix has been cleared; this task will restart cold.'
          )
        }
        setStatus(task.id, 'ready', { assignee: null })
      } else {
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
      }
    } else if (isOverload) {
      const statusPage =
        session.adapterId === 'openai-compatible' ? 'https://status.openai.com' : 'https://status.claude.com'
      const msg =
        `The provider remains overloaded after ${MAX_OVERLOAD_ATTEMPTS} attempts (${why}). ` +
        `Paused for human intervention — if it persists, check ${statusPage}.`
      addMessage(task.id, 'system', msg)
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: msg })
    } else {
      addMessage(task.id, 'system', why)
      // ⛔ The deterministic outcome happens first and unconditionally, so the task is already in a
      // safe and visible state whether or not a controller ever answers.
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
      // ⚠️ Not for a blocked run. `maybeTriage` exists to ask why a task keeps *failing*, and a task
      // that keeps asking good questions is the system working. It would find nothing, having counted
      // no failures - but a consult that can only answer "nothing is wrong" should not be enqueued.
      if (outcome !== 'blocked') maybeTriage(task.id)
    }
  }

  await releaseFor(run.id, task?.id ?? null, task?.projectId ?? null)
  void captureQuotaAfter(requireRun(run.id))
}

/**
 * Did this run fail because the account ran out of window — and if so, when may it try again?
 *
 * ⛔ **The gap t108 fell through** (2026-09-02). This fleet meets an exhausted window three ways.
 * The watchdog sees it coming and preempts; a `rejected` rate-limit record on the stream ends the
 * turn; and — the one nothing handled — the CLI simply answers the turn with an error whose text is
 * the refusal: `api_error: You've hit your session limit · resets 4am (America/Los_Angeles)`. The
 * first two park the task at `paused_quota` carrying `not_before`, which `resumeQuotaPaused` gives
 * back on the tick after the window reopens. The third took the ordinary failure path to
 * `awaiting_human`, which is a hold that ends only when a person types something. Measured on t108:
 * failed 07:25:41Z, window back at 11:00Z, still sitting there at 14:17Z when a human typed
 * "resume". Nothing was wrong with the work, and nothing was going to happen.
 *
 * ⚠️ The wording is the adapter's to recognise (`outOfQuota`), for the same reason `needsReauth` is:
 * it is one vendor's sentence, and an adapter that does not implement it gets exactly the behaviour
 * that existed before. What is decided here is the *consequence*, which is this scheduler's.
 *
 * ⚠️ `BLIND_PARK_MS` when nothing will say when the window resets — the same fallback
 * `overrunVerdict` parks on. A wrong guess costs a wait that `quotaReleaseFor` can cut short the
 * moment a probe reads the account; no guess at all costs a task that never moves.
 */
function quotaFailurePark(session: Session, run: Run, why: string): number | null {
  const ad = adapter(session.adapterId)
  const said = why + (session.id ? ` ${stripAnsi(backscroll(session.id))}` : '')
  if (!ad.outOfQuota?.(why) && !ad.outOfQuota?.(said)) return null
  return windowResetsAt(run.workerId)?.at ?? parseQuotaResetTime(said) ?? Date.now() + BLIND_PARK_MS
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
async function releaseWorkspaceOf(sessionId: string, retainForTaskId: string | null = null): Promise<void> {
  const held = workspaces.get(sessionId)
  if (held) {
    workspaces.delete(sessionId)
    if (retainForTaskId) {
      // The task is waiting on a person, not finished. Holding the exact tree prevents both another
      // task taking its branch and a one-slot worker starting unrelated work before the reply arrives.
      reassignClaim(held.workspace.claimId, retainForTaskId)
      releaseAllFor(sessionId)
      return
    }
    const project = held.projectId ? getProject(held.projectId) : null
    if (project) announceRescue(await parkWorkspace(project, held.workspace.path))
    releaseWorkspace(held.workspace.claimId)
    releaseAllFor(sessionId)
    return
  }

  // Fallback: If not in the in-memory map, clean up any open workspace claims held in the database.
  const open = claimsForHolder(sessionId)
  for (const c of open) {
    if (retainForTaskId && c.resourceId.startsWith('workspace:')) {
      reassignClaim(c.id, retainForTaskId)
    } else {
      release(c.id)
    }
  }
  releaseAllFor(sessionId)
}

/**
 * Put what an interrupted run left behind on its own task thread.
 *
 * ⚠️ At the moment it happens, rather than only when the task is next dispatched — a task preempted
 * over a five-hour window is not dispatched again for five hours, and "where did my afternoon go" is
 * a question the operator has in the meantime.
 *
 * ⚠️ Found by branch, because the branch is the only thing a park knows about. A rescue on a branch
 * no task claims is still logged by `rescueDirt`; there is simply no thread to put it on.
 */
function announceRescue(rescue: Rescue | null): void {
  if (!rescue?.branch) return
  const task = listTasks().find((t) => t.branch === rescue.branch)
  if (!task) return
  addMessage(
    task.id,
    'system',
    rescue.kind === 'commit'
      ? `This run stopped with ${rescue.files} file(s) uncommitted. They were committed onto ` +
        `\`${rescue.branch}\` as ${rescue.sha.slice(0, 8)}, so the next run picks up where this one ` +
        'stopped. It cannot land until something is finished on top of it.'
      : `This run stopped with ${rescue.files} file(s) uncommitted, and they could not be committed ` +
        'onto the branch — they are in a git stash in this workspace instead. ⚠️ A stash does not ' +
        'travel to the next run: recover it by hand with `git stash list`.'
  )
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

  const result = await switchResidentBranch(project, path, branch, task)
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

/**
 * Has this account got a slot for this task?
 *
 * ⛔ **The session the task would reuse does not count**, because reusing it starts no process.
 * `maxConcurrent` bounds how many agents run at once; a turn sent into a session that is already open
 * adds none. Counting it made a one-slot worker — the default — refuse the single most valuable move
 * the cost model has: a task resting at `awaiting_human` keeps its session warm for the reply, that
 * idle session filled the only slot, and the reply was then held at *"at capacity"* indefinitely.
 *
 * ⚠️ Measured on a real fleet 2026-08-28 while trying to share a conversation, but the bug was never
 * about sharing: the same gate had been silently blocking every warm continuation on a one-slot
 * worker since long before sharing existed, and a one-slot worker is what the app creates by default.
 *
 * ⚠️ Safe because the only session ever passed as `reuse` came from `warmSessionFor`, which returns
 * idle sessions only, and the lease stops two tasks being handed the same one.
 */
export function atCapacity(
  sessions: Session[],
  maxConcurrent: number,
  reuse: Session | null,
  retainedAwaitingHuman = 0
): boolean {
  const busy = sessions.filter((s) => s.purpose === 'work' && s.id !== reuse?.id).length
  return busy + retainedAwaitingHuman >= maxConcurrent
}

/**
 * Closed sessions are absent from `sessionsForWorker`, but a task they parked at `awaiting_human`
 * still owns one worker slot. Do not count one whose session is live: that session is already in the
 * ordinary concurrency total.
 */
export function awaitingHumanReservations(workerId: string, sessions: Session[]): number {
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  return listTasks().filter((task) => {
    if (task.status !== 'awaiting_human' || task.ranOn !== workerId) return false
    return !runsFor(task.id).some((run) => run.sessionId && liveSessionIds.has(run.sessionId))
  }).length
}

/**
 * Closed sessions are absent from `sessionsForWorker`, but a task that is still running (e.g.
 * completing or landing after its CLI process has exited, such as with one-shot adapters like Codex)
 * still owns one worker slot. Do not count one whose session is live: that session is already in the
 * ordinary concurrency total.
 */
export function runningTaskReservations(workerId: string, sessions: Session[]): number {
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  return listTasks().filter((task) => {
    const isRunningOnWorker =
      task.status === 'running' && (task.assignee === workerId || task.ranOn === workerId)
    const hasOpenRunOnWorker = runsFor(task.id).some(
      (run) => run.workerId === workerId && run.endedAt === null && (run.kind === 'work' || !run.kind)
    )
    if (!isRunningOnWorker && !hasOpenRunOnWorker) return false
    return !runsFor(task.id).some((run) => run.sessionId && liveSessionIds.has(run.sessionId))
  }).length
}

/**
 * Total slots held on this worker by tasks whose sessions are not currently in `sessions`
 * (both tasks parked at `awaiting_human` and tasks still `running` while completing/landing).
 */
export function retainedReservations(workerId: string, sessions: Session[]): number {
  return awaitingHumanReservations(workerId, sessions) + runningTaskReservations(workerId, sessions)
}

// ⛔ Re-exported, not redefined. It moved to `sessions.ts` so `sharing.ts` could ask it without
// closing an import cycle back through this module; every caller and test that named it here still
// finds it here.
export { cacheHasLapsed }

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
function evictableResidents(projectId: string): Session[] {
  return [...workspaces.entries()]
    .filter(([sessionId, held]) => held.projectId === projectId && !hasOpenRun(sessionId))
    .map(([sessionId]) => getSession(sessionId))
    .filter((s): s is Session => s !== null)
}

async function evictResident(project: { id: string; name: string }): Promise<boolean> {
  const now = Date.now()
  const victim = leastValuableResident(evictableResidents(project.id), now)
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
  //
  // ⛔ **And the answer is acted on.** `closeAndWait` returns `false` when the wait ran out — the
  // process was asked to go and did not — and that answer was thrown away here, so a session that
  // would not die had its workspace parked and handed to the next task anyway. Two agents then held
  // one worktree, which is the single thing the pool exists to make impossible: the stuck one still
  // had the directory, the new one was dispatched into it, and the panel named only the newcomer.
  // A tree whose last occupant is still breathing is not free, so nothing is released and the pool
  // stays honestly full — `Contended` is the right answer to that, and it retries every tick.
  if (!(await closeAndWait(victim.id))) {
    log.warn(
      `session ${victim.id.slice(0, 8)} did not exit, so ${victim.cwd} stays with it — ` +
        'it is still in that tree, and handing it on would put two agents in one workspace'
    )
    return false
  }
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
    if (task.status === 'cancelling') {
      const why = 'orchestratord restarted while this was cancelling; paused.'
      addMessage(task.id, 'system', why)
      setStatus(task.id, 'paused_user', { assignee: null, holdReason: why })
    } else {
      const why = 'orchestratord restarted while this was running; awaiting human input before resuming.'
      addMessage(task.id, 'system', why)
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
    }
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
/**
 * Hand a failed landing back to an agent, with the rebase named.
 *
 * ⛔ **The fourth option a stuck landing needed.** When `landTask` fails on a conflict the task
 * rests at `awaiting_human`, and the three choices offered there were *mark done*, *stop here* and
 * *reassign* — none of which is the thing anybody actually wants, which is **fix the conflict and
 * commit again**. Measured on t59, 2026-08-30: the branch was sound, the work was committed, and a
 * migration collided with one that had landed while it ran. The operator's only routes were to
 * declare unverified work finished, park it, or pay for a whole fresh run on a different worker.
 *
 * ⚠️ It does **not** start the rebase first, unlike the `resolve-conflict` verdict inside
 * `landCompletion`. That path has the workspace already held by a live session and can leave the
 * markers in the tree; this one runs after everything was released, and the next run may be handed
 * a different workspace from the pool — so a rebase started here could be started in a directory
 * the agent never sees. Naming the command is reliable where pre-running it is not.
 *
 * ⭐ The base comes from `landingBaseFor`, so the instruction names the ref the landing will really
 * use. Telling an agent to rebase onto `origin/main` when the policy merges onto `main` is the
 * mismatch that caused this conflict to be missed in the first place.
 */
export async function resolveConflictOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (!task.branch) return { ok: false, reason: 'this task has no branch to rebase' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running' || task.status === 'assigned') {
    // ⚠️ A live run will be asked by `decideFinish` when it reports, and that path can hand it the
    // conflict with the markers already in the tree. Cutting in here would be the worse version.
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ **The task's own target, not the project's.** A piece of a Plan & Split lands onto its
  // planner's branch, and `landingBaseFor` answers about the project's trunk unless it is handed the
  // task — so this instruction told a split child to rebase onto `main` and commit there. It did.
  // The prompt is the whole of the agent's picture of where its work goes; a wrong ref here is not a
  // wrong sentence, it is work put on the wrong branch by an agent doing exactly as it was told.
  const base = landingBaseFor(project, resolveFinishPolicy(task, project).policy, await hasRemote(project.root), task)
  const checks = policyVerifies(resolveFinishPolicy(task, project).policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '
  const instruction =
    `The landing failed because \`${task.branch}\` does not rebase cleanly onto \`${base}\`. ` +
    `Run \`git rebase ${base}\`, resolve every conflict, and finish the rebase. ` +
    'Keep both sides of the change wherever they are compatible — the other side is work that has ' +
    'already landed, so discarding it is never the answer. ' +
    `Once the rebase is clean, if two or more commits ahead of \`${base}\` all belong to this task, ` +
    `squash them into one coherent commit (for example, \`git rebase -i ${base}\`). ` +
    'Do not rewrite commits already on the landing target, force-push, or use a destructive reset. ' +
    checkStep +
    'Confirm there are no conflict markers and the tree is clean, commit or amend any fixes, then report the task complete again.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to rebase onto ${base} and resolve (${outcome})`)
  return { ok: true }
}

/**
 * Hand a failed check verification back to an agent, with the failure output named.
 */
export async function resolveChecksOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /landing failed|checks failed/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'Project checks failed')
  const checks = project.config.check ?? []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) again after the fix. `
      : 'Rerun the failing command after the fix. '

  const instruction =
    `The landing failed because project verification checks failed on \`${branch}\`:\n\n` +
    `${failureDetail}\n\n` +
    'Please inspect and fix the failing checks (e.g. typecheck, lint, or tests). ' +
    'If two or more commits ahead of this task branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe; do not rewrite commits already on the landing target, ' +
    'force-push, or use a destructive reset. ' +
    checkStep +
    `Commit or amend the fixes on \`${branch}\` only after the checks pass, then report the task complete again.`

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to fix failing checks (${outcome})`)
  return { ok: true }
}

/**
 * Hand uncommitted work or a failed commit back to an agent to commit and report complete again.
 */
export async function resolveCommitOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ Clear finish_asked_at so that when the new run reports complete and needs finish processing,
  // it is not immediately treated as already-asked and rejected.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'Uncommitted changes remain')

  const instruction =
    `The landing could not proceed because changes on \`${branch}\` are uncommitted:\n\n` +
    `${failureDetail}\n\n` +
    'Please review your work. If two or more commits ahead of this task branch’s landing target all ' +
    'belong to this task, squash them into one coherent commit where safe; do not rewrite commits ' +
    'already on the landing target, force-push, or use a destructive reset. ' +
    `Commit all intended changes on \`${branch}\`, then report the task complete again.`

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to commit uncommitted work (${outcome})`)
  return { ok: true }
}

export async function resolveTrunkMovedOnTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const branch = task.branch
  if (!branch) return { ok: false, reason: 'task has no branch' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running') {
    return { ok: false, reason: 'this task is already running; it will be asked when it reports' }
  }

  // ⛔ Clear finish_asked_at so that when the new run reports complete and needs finish processing,
  // it is not immediately treated as already-asked and rejected.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const msgs = messagesFor(task.id)
  const lastSystem = [...msgs].reverse().find((m) => m.role === 'system' && /trunk moved|trunk tripwire|branch is empty/i.test(m.text))
  const failureDetail = lastSystem ? lastSystem.text : (task.holdReason ?? 'The trunk moved during this run and this branch is empty')

  // ⛔ **The task's own target, not the project's.** A piece of a Plan & Split lands onto its
  // planner's branch, and `landingBaseFor` answers about the project's trunk unless it is handed the
  // task — so this instruction told a split child to rebase onto `main` and commit there. It did.
  // The prompt is the whole of the agent's picture of where its work goes; a wrong ref here is not a
  // wrong sentence, it is work put on the wrong branch by an agent doing exactly as it was told.
  const base = landingBaseFor(project, resolveFinishPolicy(task, project).policy, await hasRemote(project.root), task)
  const checks = policyVerifies(resolveFinishPolicy(task, project).policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run every project check (${checks.map((check) => `\`${check}\``).join(', ')}) after the final commit state is ready, and fix any failure before reporting complete. `
      : 'Run the relevant project checks after the final commit state is ready, and fix any failure before reporting complete. '

  const instruction =
    `The landing could not proceed because \`${base}\` moved while your run was in flight and \`${branch}\` carries no commits:\n\n` +
    `${failureDetail}\n\n` +
    `If you made commits directly to \`${base}\`, or if changes need to be rebased onto \`${base}\`, ` +
    `rebase \`${branch}\` onto \`${base}\`, ensure all intended changes are committed on \`${branch}\`. ` +
    'If two or more commits ahead of this task branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe; do not rewrite commits already on the landing target, ' +
    'force-push, or use a destructive reset. ' +
    checkStep +
    'Confirm the tree is clean, then report the task complete again.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked an agent to resolve trunk-moved changes on ${branch} (${outcome})`)
  return { ok: true }
}

/**
 * The one recovery action behind every failed-landing button.
 *
 * ⚠️ The wording is deliberately broader than a conflict: a branch can need a rebase, a check fix,
 * or a deliberate commit. They all need the same thing from the scheduler — another run on the same
 * thread — and presenting them as separate recovery verbs taught people to pick the wrong one.
 */
export async function resolveRetryOnTask(
  taskId: string,
  automatic = false
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  if (automatic && task.resolveRetryAskedAt !== null) {
    return { ok: false, reason: 'automatic resolve-and-retry was already attempted; review this failure' }
  }

  const reason = task.holdReason ?? ''
  const resolver =
    /conflict|rebase/i.test(reason)
      ? resolveConflictOnTask
      : /checks? failed|verification failed/i.test(reason)
        ? resolveChecksOnTask
        : /uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(reason)
          ? resolveCommitOnTask
          : /trunk moved.*branch is empty/i.test(reason)
            ? resolveTrunkMovedOnTask
            : null
  if (!resolver) return { ok: false, reason: 'this landing failure needs human review' }

  if (automatic) {
    // ⛔ Before asking: a send/dispatch that fails still spent the one automatic chance.
    markResolveRetryAsked(task.id)
    addMessage(task.id, 'system', 'Automatically retrying once with the failure details. A second failure will wait for your review.')
  }
  return resolver(task.id)
}

/**
 * Is there work in this task's workspace that pressing Finish would walk away from?
 *
 * ⛔ **Read from the tree, at the moment it is asked, and never inferred.** The alternative was to
 * decide whether to draw the Commit button from what the task *says* — a run that reported, a hold
 * reason mentioning "uncommitted" — and every one of those is a record of something that was true
 * once. An agent that edited three files and did not mention it leaves no such record at all, and a
 * Finish button drawn without a warning on top of three uncommitted files is the one failure this
 * whole card exists to prevent.
 *
 * ⛔ **The workspace is found by holder, in the two places a holder can be.** A conversation resting
 * between turns has its claim reassigned to the *task* (`releaseWorkspaceOf`, retaining); one whose
 * agent is still live has it held by the *session*. Looking in only one place answers "no diff" for
 * half the states this is asked in, which is a wrong answer that reads exactly like a right one.
 *
 * ⚠️ Every failure is reported as `supported: false` with a reason rather than as an absence of
 * work. "There is nothing to commit" and "I could not look" are different sentences, and the UI
 * shows the second one instead of hiding a button.
 */
export async function pendingWorkFor(taskId: string): Promise<PendingWork> {
  const none: PendingWork = {
    supported: false,
    reason: '',
    branch: null,
    dirtyFiles: 0,
    untrackedFiles: 0,
    unlandedCommits: 0,
    hasDiff: false
  }
  const task = getTask(taskId)
  if (!task) return { ...none, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') {
    return { ...none, reason: 'this task has no git project, so there is nothing to commit' }
  }
  const held =
    workspaceHeldBy(project, task.id) ??
    (() => {
      const session = sessionOf(task.id)
      return session ? workspaceHeldBy(project, session.id) : null
    })()
  if (!held) {
    return { ...none, reason: 'this task is not holding a workspace' }
  }
  const state = await workspaceState(held.path, landingTargetFor(task, project))
  return {
    supported: true,
    reason: '',
    branch: state.branch,
    dirtyFiles: state.dirtyFiles.length,
    untrackedFiles: state.untrackedFiles.length,
    unlandedCommits: state.unlandedCommits,
    // ⛔ Uncommitted files only, and deliberately not `holdsWork`. An unlanded *commit* is work that
    // is already safe on the branch — Finish leaves it exactly where the agent put it, and warning
    // about it would be crying wolf on the ordinary end of every conversation that did commit.
    hasDiff: state.dirtyFiles.length > 0 || state.untrackedFiles.length > 0
  }
}

/**
 * Ask the agent to commit this thread's work, on the rung the operator picked.
 *
 * ⛔ **It asks rather than commits, because the daemon does not author commits** — the rule
 * `decideFinish` is built on, and the reason `commit-after-verified` cannot exist. The button is
 * shown precisely when the tree is dirty, so there is nothing here that could be landed without a
 * turn, and a second code path that landed a clean tree directly would be a button that does two
 * different things depending on state nobody can see.
 *
 * ⛔ **The rung is written to `finishPolicy` first, and that write does two jobs.** It is what the
 * landing will read when the agent reports complete — so `commit·verify·merge` really merges — and
 * it is what takes this task out of `isOpenConversation`, which switches the next turn back to the
 * ordinary closing instruction. Without the second, the agent would be handed the conversation
 * instruction that tells it *not* to commit, in the same turn it is being asked to commit, and would
 * quite reasonably do nothing.
 */
export async function commitConversation(
  taskId: string,
  policy: FinishPolicy
): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return { ok: false, reason: 'not a git project' }
  if (task.status === 'running' || task.status === 'assigned') {
    return { ok: false, reason: 'this task is already running; wait for the turn to end' }
  }
  const branch = task.branch ?? branchNameFor(task.seq, task.title)
  if (!branch) return { ok: false, reason: 'this task has no branch' }

  updateTask(task.id, { finishPolicy: policy })
  // ⛔ Cleared for the same reason `resolveCommitOnTask` clears it: the next `task_complete` has to
  // reach a real finish decision rather than being turned away as already-asked.
  db().prepare('update tasks set finish_asked_at = null where id = ?').run(task.id)

  const checks = policyVerifies(policy) ? (project.config.check ?? []) : []
  const checkStep =
    checks.length > 0
      ? `Run this project's checks (${checks.map((check) => `\`${check}\``).join(', ')}) and fix any failure before you report complete. `
      : ''
  const after =
    policy === 'commit-only'
      ? 'Nothing will be merged or pushed afterwards. '
      : policy === 'commit-and-verify'
        ? 'Nothing will be merged or pushed afterwards; the tool runs the checks again on its side. '
        : policy === 'pull-request'
          ? 'The tool pushes the branch and opens the pull request afterwards — do not open one yourself. '
          : 'The tool takes it from there and lands the branch afterwards. '

  const instruction =
    `Please commit this conversation's work now: ${FINISH_LABELS[policy]}.\n\n` +
    `Commit everything you have changed on \`${branch}\`. ` +
    'If two or more commits ahead of this branch’s landing target all belong to this task, squash ' +
    'them into one coherent commit where safe. Do not rewrite commits already on the landing ' +
    'target, force-push, or use a destructive reset. ' +
    checkStep +
    after +
    'When the commit is in place, call `task_complete` with a one-line summary of what it contains.'

  addMessage(task.id, 'human', instruction)
  const outcome = continueTask(task.id)
  log.info(`t${task.seq}: asked the agent to commit this conversation as ${policy} (${outcome})`)
  return { ok: true }
}

export async function relandTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  // ⛔ A retry is a decision a person just made. Returning a reason only to the RPC caller made the
  // button appear to bounce back: the renderer refreshes the task immediately, then has nowhere to
  // render a false `landed` result. Keep the outcome on the task as well as returning it, so it is
  // visible after that refresh and remains in the thread for somebody who opens it later.
  const didNotLand = (reason: string): { ok: false; reason: string } => {
    const detail = `Retry landing failed: ${reason}`
    setHoldReason(task.id, detail)
    addMessage(task.id, 'system', detail)
    return { ok: false, reason }
  }

  if (!task.branch) return didNotLand('this task has no branch')
  if (/trunk moved.*branch is empty/i.test(task.holdReason ?? '')) {
    return didNotLand('the branch carries no commits; use Mark done if the work in trunk is finished, or Resolve & retry to rebase')
  }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project || project.vcs !== 'git') return didNotLand('not a git project')

  // A task that stopped for a person may already be holding its own worktree. Reuse it for landing:
  // asking the pool for another member would either fail at capacity or try to check out the branch
  // in two worktrees at once.
  const retained = workspaceHeldBy(project, task.id)
  const workspace = retained ?? (await claimWorkspace(project, `reland:${task.id}`))
  if (!workspace) return didNotLand('every workspace is busy; try again in a moment')

  try {
    const prepared = await prepareWorkspace(project, workspace, task.branch, task)
    if (!prepared.ok) return didNotLand(prepared.error ?? 'could not prepare a workspace')

    const policy = policyFor(project)
    const state = await workspaceState(workspace.path, landingTargetFor(task, project))
    // ⛔ The same decision as a first completion, not a shortcut past it. A branch reaching this by
    // a button press gets the identical bar: authority, checks, a clean tree, real commits.
    const decision = decideFinish({ task, project, state, hasChecks: policy.check.length > 0 })
    if (decision.kind !== 'land') {
      const reason = 'reason' in decision ? decision.reason : 'nothing to land'
      return didNotLand(reason)
    }

    const result = await landTask({
      project,
      task,
      workspacePath: workspace.path,
      branch: task.branch,
      policy: resolveFinishPolicy(task, project).policy
    })
    if (result.ok) {
      setStatus(task.id, 'completed')
      // ⛔ And close the run this task was still in the middle of, if it had one.
      //
      // ⚠️ It usually has none — this is the *land again* button on a task that finished long ago.
      // But a `running` task can reach here now, and setting the status without ending its run
      // leaves a completed task owning an open run, a live session and a claimed workspace that
      // nothing will ever release. Measured by doing it: t58, landed by hand on 2026-08-30, came
      // back `completed` with `run 44ad4938 … ended=OPEN` and ws3 still claimed. ⭐ Only
      // `reconcileClaims` at the next startup would have freed it, because `reconcileTasks` sweeps
      // `running` tasks and this one is no longer running — the status change is what hides it.
      const open = runsFor(task.id).find((r) => !r.endedAt)
      if (open) {
        finishRun(open.id, 'completed', 'landed by hand while the run was still open')
        await releaseFor(open.id, task.id, project.id)
        if (open.sessionId) releaseAllFor(open.sessionId)
      }
    }
    if (!result.ok) return didNotLand(result.reason ?? 'landing did not complete')
    return { ok: true, ...(result.reason ? { reason: result.reason } : {}) }
  } finally {
    // ⚠️ Parked and released in every path, including the refusals above. A workspace held by a
    // failed button press is one slot fewer for the fleet, permanently.
    await parkWorkspace(project, workspace.path)
    releaseWorkspace(workspace.claimId)
  }
}
