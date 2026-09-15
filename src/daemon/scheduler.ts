import { sessionEnded } from '@shared/protocol.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Attachment,
  Project,
  Run,
  RunQuota,
  Task,
  TaskStatus
} from '@shared/tasks.js'
import {
  WINDOW_HIGH_WATER,
  windowHighWater,
  resolveModelChoice,
  TERMINAL_STATUSES
} from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'
import type { ProbeDemand } from './quota.js'
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
  windowExpired,
  poolVerdict
} from './quota.js'
import {
  getWorker,
  inheritedModelFor,
  recordDispatchFailure,
  spendingCreditsOn
} from './workers.js'
import {
  getProject,
  landingTargetFor,
  listProjects,
  policyFor,
  reloadProject,
  reloadProjectIfPresent
} from './projects.js'

import {
  admitBlocked,
  admitScheduled,
  quotaParkedTasks,
  resumeQuotaPaused,
  addMessage,
  finishRun,
  getTask,
  isIntegrationParent,
  listTasks,
  lastRunForSession,
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
  markFinishAsked,
  setRunQuota,
  setStatus,
  startRun,
  taskOfSession
} from './tasks.js'
import { claimedByAnotherTask, landedCommits, recordTaskCommits, taskCommitShas } from './taskcommits.js'
import { openDebate, seatsOf } from './debate.js'
import { enqueueConsult } from './controller.js'
import {
  decomposeQuestion,
  titleQuestion,
  triageQuestion,
  TITLE_SUMMARY_THRESHOLD
} from './judgment.js'
import { escalateStale } from './approvals.js'
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
  trunkResourceId,
  upsertResource,
  workspacePoolId
} from './resources.js'
import {
  branchNameFor,
  claimTrunk,
  claimWorkspace,
  surveyTrunk,
  trunkHolder,
  type TrunkSurvey,
  commitsOnlyOn,
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
  isHousekeepingTurn,
  lastRequestEvidenceAt,
  markClockMove,
  noteCurrentBranch,
  reopenable,
  resumableSession,
  sendPrompt,
  spawnSession
} from './sessions.js'
import {
  abortRebase,
  beginConflictResolution,
  finishWithoutLanding,
  landTask,
  readMergeability
} from './landing.js'
import {
  describeTree,
  looksStuck,
  quietSince,
  sampleProcessTree,
  stallConfirmed,
  MIN_SAMPLE_GAP_MS,
  STALL_CONFIRM_AFTER_MS,
  type TreeSample
} from './stall.js'
import { decideFinish, decideTrunkFinish, resolveFinishPolicy, type TrunkReading } from './finish.js'
import {
  mismatch,
  rank,
  resolveSessionSharing,
  wantsCompactionToShare,
  whyNotShared,
  type ShareIntent
} from './sharing.js'
import { stripAnsi } from './stream.js'
import {
  activityFor,
  clearActivity,
  closingProse,
  proseOf,
  REPORT_PROSE_CHARS,
  runActivityFor,
  withClosingProse
} from './activity.js'
import { log } from './log.js'
import { git } from './git.js'
import { clockTime, oneLine, shortDuration } from './threadline.js'
import { RESTART_REAP_NOTE } from './activetime.js'
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
import { lastSpend } from './spend.js'
import { settings } from './settings.js'
import { overrunFactor } from './estimator.js'
import type { Objective } from '@shared/tasks.js'
import { isOpenConversation, resolveWorkspaceMode, trunkPolicyConflict } from '@shared/tasks.js'
import {
  DEFAULT_OBJECTIVE,
  policy,
  resolveObjective,
  WEIGHT_FORMULAS,
  weights
} from './objective.js'
import {
  compactOnResume,
  mayCompact,
  RESUME_COMPACT_WAIT_MS,
  runCacheClock,
  type ResumeCompaction
} from './cacheclock.js'
import {
  COMPACTION_GRACE_MS,
  compactionInFlight,
  lastCompactionLandedAt,
  latestOpenCompactionId,
  noteCompactionAsked,
  onCompactionLanded
} from './compaction.js'
import { costModel } from './costmodel.js'
import { errorMessage } from '@shared/errors.js'
import { framingLapsed, promptFor } from './prompt.js'
import {
  chooseTarget,
  formatScore,
  poolPressure,
  ROUTE_EPSILON,
  type ScoreBreakdown
} from './scoring.js'
import { evictableResidents, leastValuableResident, sessionLeaseId } from './residency.js'
import {
  blockedOn,
  deadOnArrival,
  forgetIdleTurn,
  idleTurnFor,
  idleTurnOverdue,
  MAX_OVERLOAD_ATTEMPTS,
  overloadFailureRetry
} from './turnend.js'
import { resolveRetryOnTask, retryQueuedLandings } from './resolutions.js'

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
export const workspaces = new Map<string, { workspace: Workspace; projectId: string | null }>()

export interface TickResult {
  dispatched: number
  note: string
}

/**
 * How long a standing refusal has to survive before the task behind it is handed to a person.
 *
 * ⛔ **Not zero, and the reason is measured.** A bridged adapter's `isInstalled()` answers *no* until
 * its first background probe returns — that is the contract, not a bug (see `muse-code.ts`) — and a
 * daemon that had just started would otherwise escalate every task pinned to that account inside ten
 * seconds of a restart. Ten minutes is longer than any cold start here and far shorter than the
 * forever this replaces.
 */
export const STANDING_HOLD_GRACE_MS = 10 * 60 * 1000

/**
 * Standing holds this process has seen, and since when.
 *
 * ⚠️ Process-local on purpose, like the quota refresh ledger: a restart re-starts the clock, which
 * is the safe direction to be wrong in — it delays a hand-over, it never invents one. The reason is
 * part of the key, so a task whose refusal changes gets a fresh grace period rather than inheriting
 * the age of a different problem.
 */
const standingHolds = new Map<string, { reason: string; since: number }>()

/** ⛔ A task that moved is no longer being held: dispatched, given up on, or refused transiently. */
function clearStandingHold(taskId: string): void {
  standingHolds.delete(taskId)
}

/** Test seam: the ledger is process state, and a test that seeds a fleet needs it empty. */
export function forgetStandingHolds(): void {
  standingHolds.clear()
}

/**
 * A task nothing in this fleet will ever start, handed to the person who can change that.
 *
 * ⛔ **The question t268 asked: how does a queued task unblock itself?** It does not, when what is
 * holding it is standing — a CLI that is not installed, an account signed out or retired, a
 * capability no adapter here has. Before this, such a task sat at `ready` with a sentence on its row
 * for as long as the daemon ran, indistinguishable at a glance from one waiting behind a busy
 * account, and the fleet reported *"held"* on every tick for ever.
 *
 * ⚠️ `awaiting_human`, not `failed`. Nothing failed: no run was attempted, no work was lost, and the
 * task is one act away from being runnable — install the CLI, sign the account in, or re-file
 * without the pin. `failed` is a settled status that releases dependents and closes runs, and it
 * would say the work was tried and did not survive. `awaiting_human` is the resting state that says
 * *this needs you* and that a reply puts straight back in the queue (`continueTask`).
 *
 * Returns whether the task was handed over on this pass.
 */
function handOverStandingHold(task: Task, reason: string, now = Date.now()): boolean {
  const prior = standingHolds.get(task.id)
  if (!prior || prior.reason !== reason) {
    standingHolds.set(task.id, { reason, since: now })
    return false
  }
  if (now - prior.since < STANDING_HOLD_GRACE_MS) return false
  standingHolds.delete(task.id)
  addMessage(task.id, 'system', `Cannot start as filed: ${oneLine(reason)}`, null, [], {
    detail:
      `Nothing in this fleet can start this task as it is filed: ${reason}. That is not a queue — ` +
      'waiting will not change it, so it is over to you: fix the account (install the CLI, sign in, ' +
      're-enable it) or re-file this task without the pin that names it. Say anything here once it ' +
      'is sorted and this goes straight back in the queue.'
  })
  setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: reason })
  log.warn(
    `t${task.seq} handed to a person after ${Math.round((now - prior.since) / 60000)}m of a hold ` +
      `nothing clears by itself: ${reason}`
  )
  return true
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
  // ⛔ The two halves of trunk mode's holds, each ended by something on this clock: a lease whose
  // task has settled goes back, and a landing that queued for the trunk is re-attempted once the
  // trunk is free. Both zero tokens.
  sweepTrunkLeases()
  await retryQueuedLandings()
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
    // ⛔ **A debate needs a project, and there is no escape hatch for it.** Seats read a
    // repository; a debate about nothing in particular has no seats worth paying for. The plan
    // guard below routes to the controller consult instead, which works for a plan because a
    // consult can still answer one JSON question — it cannot run a debate, which is N dispatched
    // agent sessions arbitrated by a third. So this refuses with a reason rather than degrading.
    if (task.kind === 'debate' && !task.projectId) {
      const why =
        'a debate needs a project: its seats read a repository, and nothing here can arbitrate one ' +
        'without a workspace. Move this task into a project, or file it as a single task.'
      skipped.push(`t${task.seq}: ${why}`)
      setHoldReason(task.id, why)
      continue
    }

    // ⛔ **A debate with no seats is seated here, not dispatched.** `task.debate` seats a debate the
    // moment it is filed, but a debate filed as a **draft** has nothing to seat until somebody
    // promotes it — and `promoteDraft` is a plain status change in `tasks.ts`, which cannot import
    // this module's neighbour without closing a cycle. So the seating phase is a backstop on the
    // tick, where `debatePhaseOf` already says it is: without it a promoted draft dispatches its
    // organizer into an empty room and it arbitrates nothing.
    //
    // ⚠️ Idempotent by construction — `openDebate` refuses a parent that already has seats — so a
    // debate seated at filing time never passes through here twice.
    if (task.kind === 'debate' && task.debate && seatsOf(task.id).length === 0) {
      const opened = openDebate(task.id, { kind: 'human' })
      if (opened.ok) {
        skipped.push(`t${task.seq}: seated ${opened.seats.length} debate seats; arbitrating when they settle`)
      } else {
        skipped.push(`t${task.seq}: ${opened.reason}`)
        setHoldReason(task.id, opened.reason)
      }
      continue
    }

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
      // ⛔ Before the hold is recorded, because a hand-over is not a hold: the task stops being
      // `ready` and there is nothing left for the cache clock to try to unblock. ⚠️ Never on a
      // `deferred` result — that is a routing question in flight, which is the opposite of standing.
      if (!choice.deferred && choice.standing && handOverStandingHold(task, choice.reason)) {
        skipped.push(`t${task.seq}: ${choice.reason} — handed to a person`)
        continue
      }
      if (!choice.standing) clearStandingHold(task.id)
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
      clearStandingHold(task.id)
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
      addMessage(task.id, 'system', `Could not start: ${oneLine(verdict.reason)}`, null, [], {
        ...(oneLine(verdict.reason) === verdict.reason ? {} : { detail: verdict.reason })
      })
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
  const reason = errorMessage(err)
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
export function poolFor(worker: Worker, model: string | null): string | null {
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
export function needsBaseline(worker: Worker | null): string | null {
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
  // ⚠️ Best-effort and unbracketed by freshness: a meter nobody has ever read for this worker
  // contributes nothing, and the thread pairs only what both readings carry. `lastSpend` answers
  // with the newest probe whatever it found, so a balance of `null` (asked, published nothing)
  // is kept as `null` rather than read as zero.
  const spend = lastSpend(workerId)?.meters
  return {
    // ⛔ `group` travels too. Without it the run's two readings pair windows by bare id, and
    // Antigravity's busiest pool holds the bare `5h` id — so a reading taken before the run and
    // one taken after can hold that id on different pools, and the thread shows one pool's spend
    // on the other's row (t273).
    windows: quota.windows.map((w) => ({ id: w.id, label: w.label, percent: w.percent, group: w.group })),
    ...(spend && spend.length > 0
      ? {
          spend: spend.map((m) => ({
            meterId: m.id,
            label: m.label,
            balance: m.balance,
            direction: m.direction,
            usdPerUnit: m.usdPerUnit
          }))
        }
      : {}),
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

  // ⭐ **Credits release a park on their own evidence, before any reading is consulted.** t282: a
  // task parked when the 7d window filled stayed parked after the operator turned "spend credits
  // past the plan limit" on, because every test below asks *has the window come back* — and the
  // answer is still no, for ever, until the reset. It is the wrong question for an account that has
  // been given permission to spend straight past the limit. The dispatch gate stands down for the
  // same pair of conditions, so a task released here is one that will actually run.
  //
  // ⛔ Not the same permission as `quotaOverrideUntil`, which is deliberately *not* read here: an
  // override says "92% is enough room for this task" and stops at the window boundary; credits say
  // "bill me past the boundary", which is exactly this park.
  if (spendingCreditsOn(worker, settings().spendCreditsPastLimit)) {
    return (
      `${worker.label} reports usage credits enabled and "spend credits past the plan limit" is on, ` +
      'so work on this account carries on past the limit and is billed against those credits.'
    )
  }

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

  const blocking = windows.find((w) => !windowExpired(w) && w.percent >= windowHighWater(w))
  if (blocking) return null

  const age = Math.round(quota.ageMs / 1000)
  const expired = windows.find((w) => windowExpired(w))
  if (expired) {
    return `${worker.label}'s ${expired.label ?? '5h'} window has rolled over since this was parked.`
  }

  const highest = windows.reduce((max, w) => (w.percent > max.percent ? w : max), windows[0]!)
  const gate = windowHighWater(highest)
  return (
    `${worker.label} is at ${Math.round(highest.percent)}% of its ${highest.label ?? '5h'} window ` +
    `on a reading ${age}s old, which is below the ${gate}% gate.`
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
/**
 * Take an opening credit reading on a worker that is actually spending them.
 *
 * ⛔ **Only where credits are on, and that narrowing is the whole design.** A forced refresh opens a
 * terminal for the better part of thirty seconds; paying that on every dispatch to bracket a meter
 * that reads the same zero on both sides would tax the entire fleet for a number that never moves.
 * The account the operator wants bracketed exactly is the one being billed, and this is that test.
 *
 * ⛔ **`run.quotaBefore` is a *stored* reading — up to a sweep old — and for money that is not good
 * enough.** A window percent drifts; a credit balance is a bill. So this forces the vendor's cache
 * current, which is what puts a real sample on the series just before the run's own spending starts.
 *
 * ⚠️ Fire-and-forget, exactly like `captureQuotaAfter`, and for the same reason: nothing is waiting
 * on it and the run must not be held for half a minute behind a reading. The consequence is that the
 * first few seconds of the run fall outside the bracket, which `price.ts` already reports honestly
 * as `unmeasuredMs` rather than silently absorbing.
 */
async function captureSpendBefore(run: Run): Promise<void> {
  if (!spendingCreditsOn(getWorker(run.workerId), settings().spendCreditsPastLimit)) return
  try {
    // ⚠️ Declined is fine and common — something refreshed this account seconds ago, in which case
    // the sample already on the series *is* the opening reading and forcing a second terminal would
    // buy nothing. See `captureQuotaAfter` for the same argument on the closing side.
    if (!(await refreshNow(run.workerId, 0))) await probeWorker(run.workerId)
  } catch (err) {
    log.warn(`could not read the opening credit balance for run ${run.id.slice(0, 8)}:`, err)
  }
}

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

/** One account the dispatch gates refused, and which gate it was. */
export interface WorkerRefusal {
  workerId: string
  /** `quota` — a window is spent. `capacity` — every slot is busy. `account` — the account itself cannot take a turn (disabled, signed out, no CLI, wrong role, missing capability). */
  kind: 'quota' | 'capacity' | 'account'
  why: string
}

export interface WorkerChoice {
  worker: Worker | null
  /** A live, idle session already holding this task's context. Reusing it is the cheapest move here. */
  session: Session | null
  /** A closed-but-reopenable conversation on this account for this task. */
  resumable?: Session | null
  reason: string
  quotaUnverified: boolean
  score: number
  /** The controller's rationale, carried from its stored route answer to the dispatched run. */
  controllerWhy?: string
  /**
   * Every account the gates turned away, with the kind of gate that did it.
   *
   * ⛔ The thread's *Worker switched … — quota* line is read from here, not from the previous run:
   * a run's own fields say how it ended, not why its account was not chosen again. Present on
   * both the decided and the empty result; absent only on a deferred one.
   */
  refusals?: WorkerRefusal[]
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
  /**
   * Is every refusal behind this one a **standing** one — something no amount of waiting changes?
   *
   * ⛔ **The other half of what an operator is owed, beside `holdUntil`.** That says when a refusal
   * could stop being true; this says that it never will on its own. A task pinned to an account
   * whose CLI is not installed, that is signed out, retired, or that simply cannot do what the task
   * requires, is not queued behind anything — it is waiting for a person, and `runTick` escalates it
   * to `awaiting_human` once the same standing hold has survived `STANDING_HOLD_GRACE_MS`.
   *
   * ⚠️ False whenever *any* refusal in the field was transient, because the task needs only one
   * worker and one of them may free up. Absent on a result that chose somebody.
   */
  standing?: boolean
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
export function warmSessionFor(task: Task, workerId?: string): Session | null {
  const project = task.projectId ? getProject(task.projectId) : null
  const trunkWanted = project !== null && resolveWorkspaceMode(task, project).mode === 'trunk'
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
    const worker = session.workerId ? getWorker(session.workerId) : null
    if (mismatch(pinned(task, worker), session)) return null
    // ⛔ A `streamPrompts: 'once'` session is never warm, whatever its state says. Its CLI reads
    // one prompt from stdin, runs that turn and exits - there is no conversation still sitting there
    // to continue, and handing it a second prompt is a write into a pipe that closed when the first
    // one went out. Reuse here would report a saving that does not exist and deliver nothing.
    if (adapter(session.adapterId).info.capabilities.streamPrompts === 'once') return null
    // ⛔ **A conversation is in one kind of tree, and a task wants one kind.** A trunk task continued
    // in a worktree session would commit to a branch nobody lands; a worktree task continued in the
    // trunk would put its branch's work on the operator's checkout.
    if (project && project.vcs === 'git' && samePath(session.cwd, project.root) !== trunkWanted) return null
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
function pinned(task: Task, worker?: Worker | null): ShareIntent {
  let model = task.constraints.model ?? null
  if (!model && worker && task.constraints.modelsByWorker?.[worker.id]) {
    model = task.constraints.modelsByWorker[worker.id]!
  } else if (!model && task.constraints.modelPolicy === 'inherit' && worker) {
    model = inheritedModelFor(worker)[0] ?? null
  }
  return { model, effort: task.constraints.effort ?? null }
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
  const mode = project ? resolveWorkspaceMode(task, project).mode : 'worktree'
  for (const [sessionId, held] of workspaces) {
    if (held.projectId !== task.projectId) continue
    // ⛔ Only a conversation in the kind of tree this task works in. See `warmSessionFor`.
    if ((held.workspace.kind ?? 'worktree') !== mode) continue
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
 * candidate scored `contextHeld 0 · cacheWarmth 0 · cold 1` no matter how recently it had done the work. The
 * dispatch knew better all along: it calls `resumableSession` and reopens the conversation. The score
 * simply could not see what the dispatch was about to do.
 *
 * ⛔ Measured on this install, 2026-09-02. t123 ran on CodexFirst 18:34–18:42, leaving session
 * `bffdc5d2` closed with 175,626 tokens of its context. Asked at 19:02 to retry the commit — twenty
 * minutes later, inside any plausible TTL — the retry scored a cold ClaudeThird above it and rebuilt
 * everything from nothing, because the only thing that could have said otherwise was structurally
 * unavailable to a `streamPrompts: 'once'` adapter.
 *
 * ⚠️ **Not filtered on cache warmth**, deliberately, and `cacheWarmth` is the term that carries that. A
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
export function reopenableFor(task: Task, workerId: string): Session | null {
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
export function stickyWorkerFor(task: Task): string | null {
  if (task.kind !== 'conversation') return null
  const runs = [...runsFor(task.id)].sort((a, b) => b.startedAt - a.startedAt)
  for (const run of runs) {
    if (!run.sessionId) continue
    const session = getSession(run.sessionId)
    if (session) return session.workerId
  }
  return null
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
  addMessage(task.id, 'system', 'Queued for decomposition', null, [], { detail: 'Its children arrive as drafts.' })
  return true
}


// ---------------------------------------------------------------------------- dispatch

/**
 * Say, on the task, that this dispatch happened only because a person overruled the quota gate.
 *
 * ⚠️ Posted **once per run**, not once per tick: it is called from `dispatch`, which runs when a run
 * starts. ⚠️ Silent unless the override is both live *and* actually load-bearing — a task carrying
 * one that dispatched to an account at 40% was never held by anything, and announcing an override
 * that changed no decision would train the reader to ignore the line that matters.
 *
 * ⚠️ Exported alongside `noteCreditsDispatch`, so a test can hold the two side by side and show
 * that exactly one of them ever speaks.
 */
export function noteQuotaOverrideDispatch(task: Task, worker: Worker): void {
  if (!quotaOverridden(task)) return
  // ⛔ The gate consults credits *first*, so on a credit-enabled account the override is not what
  // let this run start and saying it was would be false — `noteCreditsDispatch` writes the true one.
  if (spendingCreditsOn(worker, settings().spendCreditsPastLimit)) return
  const quota = lastQuota(worker.id)
  // ⚠️ Age is not asked about here, for the reason the dispatch gate no longer asks either: the
  // override was load-bearing against whatever reading the gate actually read, stale or not.
  if (!quota || quota.windows.length === 0) return
  const choice = resolveModelChoice(task.constraints, worker, false, quota)
  const pool = poolFor(worker, choice.model)
  const blocking = poolVerdict(windowsForPool(quota.windows, pool)).blocking
  if (!blocking) return
  const win = blocking.window
  const gate = blocking.threshold
  addMessage(
    task.id,
    'system',
    `Starting on ${worker.label} at ${Math.round(win.percent)}% — quota gate overridden`,
    null,
    [],
    {
      detail:
        `Starting on ${worker.label} at ${Math.round(win.percent)}% of its ${win.label ?? '5h'} ` +
        `window. The ${gate}% gate would normally hold this task; it was overridden by ` +
        'hand, so this run is also exempt from being preempted over that percentage. ⚠️ A turn the ' +
        'vendor actually refuses still stops it, and the window boundary itself still applies.'
    }
  )
}

/**
 * Say, on the task, that this run started over a full window because the account is on credits.
 *
 * ⛔ **A run that starts at 100% has to say why, or it reads as a bug.** The board shows the
 * window full and the run going; without this line the only two explanations available to a reader
 * are "the gate is broken" and "the gate was overridden", and neither is true. ⚠️ It names both
 * conditions and the money, because carrying on past the plan limit is what is being billed.
 *
 * ⚠️ Once per run, from `dispatch`, and silent unless the stand-down was load-bearing — a
 * credit-enabled account dispatched at 40% was never held by anything.
 *
 * ⚠️ Exported for its own test: reaching it through a real dispatch would need a spawned process
 * and a workspace, neither of which the sentence depends on.
 */
export function noteCreditsDispatch(task: Task, worker: Worker): void {
  if (!spendingCreditsOn(worker, settings().spendCreditsPastLimit)) return
  const quota = lastQuota(worker.id)
  if (!quota || quota.windows.length === 0) return
  const choice = resolveModelChoice(task.constraints, worker, false, quota)
  const blocking = poolVerdict(windowsForPool(quota.windows, poolFor(worker, choice.model))).blocking
  if (!blocking) return
  const win = blocking.window
  addMessage(
    task.id,
    'system',
    `Starting on ${worker.label} at ${Math.round(win.percent)}% — spending credits`,
    null,
    [],
    {
      detail:
        `Starting on ${worker.label} at ${Math.round(win.percent)}% of its ${win.label ?? '5h'} window. ` +
        `The ${blocking.threshold}% gate would normally hold this task; "spend credits past the plan ` +
        'limit" is on and this account reports usage credits enabled, so the run goes ahead and is ' +
        'billed against those credits. ⚠️ Turn the switch off in Settings › Fleet to go back to ' +
        'waiting for the window.'
    }
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
      // ⛔ `RoutingDecision.warm` says the winner was reusing a conversation, and a reopened one is
      // reuse — the dispatch calls `resumableSession` and continues it.
      warm: !!(choice.session ?? choice.resumable),
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
  // ⚠️ Beside it, and for the same reason: the stand-down that let this run start is invisible
  // otherwise. Exactly one of the two ever speaks — credits outrank an override, because that is
  // the order the gate itself asks in.
  noteCreditsDispatch(task, worker)

  // ⛔ Reusing a warm session skips the workspace claim entirely: the session is already sitting in
  // the workspace this task claimed, on this task's branch. Claiming again would double-book the
  // pool, and re-preparing would switch a branch under a live agent.
  if (choice.session) {
    await dispatchIntoWarmSession(task, worker, choice.session, quotaUnverified, choice)
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

  // ⭐ Where this task works, decided once. A trunk task takes the project's single trunk lease and
  // runs in the checkout itself; everything below that prepares a pooled worktree is skipped for it.
  const trunkMode = project !== null && resolveWorkspaceMode(task, project).mode === 'trunk'
  let trunkSurvey: TrunkSurvey | null = null

  if (project && trunkMode) {
    for (const s of past) {
      if (sessionEnded(s.state)) await releaseWorkspaceOf(s.id)
    }
    // ⛔ Refused before anything is claimed: this combination can only arrive by a project's policy
    // changing under a task, and guessing a different finish would be worse than saying so.
    const conflict = trunkPolicyConflict(resolveFinishPolicy(task, project).policy)
    if (conflict) throw new Error(`cannot run t${task.seq} in the trunk: ${conflict}`)
    workspace ??= workspaceHeldBy(project, task.id)
    if (workspace && workspace.kind !== 'trunk') {
      releaseWorkspace(workspace.claimId)
      workspace = null
    }
    workspace ??= claimTrunk(project, task.id)
    if (!workspace && (await evictResident(project, 'trunk'))) workspace = claimTrunk(project, task.id)
    // ⚠️ `Contended`: another trunk task has the checkout, which is a hold, never a failure.
    if (!workspace) {
      const holder = trunkHolder(project)
      throw new Contended(
        `the trunk of ${project.name} is held by ${holder ? holderLabel(holder.holder) : 'another task'}`,
        trunkResourceId(project.id)
      )
    }
    trunkSurvey = await surveyTrunk(project)
  } else if (project) {
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
      if (await evictResident(project, 'worktree')) workspace = await claimWorkspace(project, task.id, priorCwd)
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

    branch = project.vcs === 'git' ? (task.branch ?? branchNameFor(task.seq, task.title, task.branchUnit)) : null
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
  // ⛔ An effort the *model* has no levels for is dropped here, the same way one the *adapter* cannot
  // take is dropped above. claude-code takes the flag and haiku-4.5 takes no effort at all (measured
  // 2026-08-29), so an account whose default effort is `medium` sent `--effort medium` on every haiku
  // dispatch and the thread reported the run as "Haiku 4.5 Med" — a setting nothing applied.
  // ⚠️ Only where the cost model actually declares the model. An id it cannot price says nothing
  // about which levels exist, and dropping there would throw away a level the CLI would have honoured.
  if (picked.effort && picked.model) {
    const spec = costModel(adapter(worker.adapterId).info.policy.costModelId).modelSpec(picked.model)
    if (spec && Array.isArray(spec.effort_levels) && spec.effort_levels.length === 0) {
      picked.effort = null
    }
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
      `Rescued ${rescued.files} uncommitted file(s) as ${rescued.sha.slice(0, 8)} on \`${branch}\``,
      null,
      [],
      {
        detail:
          `The last run here was interrupted with ${rescued.files} file(s) uncommitted. They were ` +
          `committed onto \`${branch}\` as ${rescued.sha.slice(0, 8)} so this run inherits them, and ` +
          'that commit cannot land until something is finished on top of it.'
      }
    )
  }
  const trunkNotice =
    trunkSurvey && project ? trunkArrivalNotice(trunkSurvey, landingTargetFor(task, project)) : null
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
  // ⛔ **Decided here rather than at the send, because the prompt has to know.** This plan is what
  // `openConversation` acts on below, and it is also the difference between a session that will
  // still be holding this task's instructions when the prompt lands and one that will be holding a
  // summary of them — see `promptFor`'s `compacted`. One decision, read twice; asking twice would
  // let the two answers differ across the ~1s between them and send a subtracted prompt into a
  // conversation that was about to be compacted anyway.
  const resumeCompaction = revive ? compactOnResume(revive, settings()) : null
  const prompt = promptFor(task, worker.adapterId, revive !== null && !borrowed, {
    branchNotice: [borrowNotice, branchNotice, rescueNotice, trunkNotice].filter(Boolean).join('\n\n') || null,
    markDelivered: true,
    // ⚠️ Either compaction counts: the one about to happen, and any that already landed in this
    // conversation since this task last spoke in it.
    compacted:
      revive !== null &&
      (resumeCompaction?.compact === true || framingLapsed(task.id, revive.id))
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
        `t${task.seq} reopened this task's conversation (${revive.id.slice(0, 8)})`,
        null,
        [],
        {
          detail:
            `t${task.seq} reopened this conversation to reuse its context. Nothing here was changed, ` +
            'and this task keeps its own branch and its own history.'
        }
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
    ...(trunkSurvey ? { trunkDirtyBefore: [...trunkSurvey.dirtyFiles, ...trunkSurvey.untrackedFiles] } : {}),
    prompt: promptText,
    objective: resolveObjective(project?.config?.objective, task.objective, settings().objective)
  })
  setRunQuota(run.id, 'before', runQuota(worker.id))
  // ⛔ The money half of the same bracket, and only on an account that is spending credits.
  // See `captureSpendBefore` for why it is narrowed and why nothing waits on it.
  void captureSpendBefore(run)
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
  announceWorker(
    task,
    worker,
    picked.model ?? worker.defaultModel,
    run,
    dispatchDetail({ choice, workspace: workspace?.path ?? cwd, branch, revive: !!revive, quotaUnverified }),
    choice
  )

  // The CLI needs a moment before it starts reading stdin; a message sent too early is dropped.
  //
  // ⛔ And a revived conversation may need shrinking before it is spoken to at all — see
  // `openConversation`. The delay is the same either way; what changes is what goes in first.
  setTimeout(() => {
    openConversation(session, task, promptText, resumeCompaction, prompt.attachments)
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
 * Everything the old *Started on X in <path> on <branch>* and *Controller routed this to X …*
 * messages said, as the expandable detail under the one line that replaced them.
 *
 * ⚠️ `unverified` is the only fact here that also earns a line of its own — see `announceWorker`.
 */
export function dispatchDetail(input: {
  choice: Pick<WorkerChoice, 'reason' | 'controllerWhy'> & { score?: number }
  workspace: string
  branch: string | null
  revive: boolean
  quotaUnverified: boolean
}): string {
  const { choice } = input
  return [
    choice.controllerWhy ? `Controller: ${choice.controllerWhy}` : null,
    `Routing: ${choice.reason}${choice.score === undefined ? '' : ` (score ${choice.score.toFixed(2)})`}.`,
    `Workspace: ${input.workspace}${input.branch ? ` on ${input.branch}` : ''}.`,
    input.revive ? 'Conversation: resumed.' : 'Conversation: cold start.',
    input.quotaUnverified ? 'Quota reading was not trustworthy; this run is marked unverified.' : null
  ]
    .filter(Boolean)
    .join('\n')
}

/** The few words a *Worker switched* line ends with. The full basis goes in the entry's detail. */
export type WorkerSwitchReason = 'reassigned by you' | 'quota' | 'previous worker unavailable' | 'scheduler choice'

/**
 * Write the worker line a run owes the thread — and only when it says something new.
 *
 * ⛔ **One line per material change, not one per run.** The first run says who has the task; a run
 * on the same account says nothing, because a thread that repeats *Started on Claude* under every
 * reply is a thread nobody reads; a run on a different account says so and says why. The evidence
 * that used to be the message — the controller's rationale, the workspace, the branch, cold or
 * resumed, the quota caveat — travels in `detail`, expandable and never in the way.
 *
 * ⛔ **And there is no exception for an untrusted quota reading.** There used to be: a continuation
 * on the *same* account re-announced itself whenever `quotaUnverified` was set, on the argument that
 * the caveat wants to sit beside the run it applies to. It does — but a thread is a conversation,
 * and *Worker assigned: ClaudeSecond (claude-opus-5)* printed in the middle of one, under a reply the
 * operator had just typed, reads as the task changing hands when nothing changed at all (t369,
 * reported 2026-09-11: two announcements in one thread, the second of them only because the quota
 * reading was stale). The caveat is a fact about the *run*, so it is shown on the run —
 * `RunRow` draws a `quota: unverified` fact off `run.quotaUnverified` — and the thread stays quiet.
 *
 * ⛔ The switch reason is *read off the decision*, not inferred from the thread. `choice.refusals`
 * is the gate that turned the previous account away, written by the same pass that chose this one;
 * a pin on this worker outranks it because a person reassigning a task is the one case where the
 * scheduler had no say. Only `work` runs count as *previous*: a peer quality review runs under this
 * task on a different account by design, and is not a worker this task ever moved off.
 */
export function announceWorker(
  task: Task,
  worker: Worker,
  model: string | null,
  run: Run,
  detail: string,
  choice: Pick<WorkerChoice, 'refusals' | 'scored'> = {}
): void {
  const previous = runsFor(task.id).find((candidate) => candidate.id !== run.id && candidate.kind === 'work')
  const assigned = (): void => {
    addMessage(task.id, 'system', `Worker assigned: ${worker.label} (${model ?? 'default'})`, run.id, [], {
      event: 'worker.assigned',
      detail
    })
  }
  if (!previous) {
    assigned()
    return
  }
  if (previous.workerId === worker.id) return
  const previousWorker = getWorker(previous.workerId)
  const refused = choice.refusals?.find((r) => r.workerId === previous.workerId) ?? null
  const contended = choice.scored?.some((c) => c.workerId === previous.workerId) ?? false
  const reason: WorkerSwitchReason =
    task.constraints.workerId === worker.id
      ? 'reassigned by you'
      : contended
        ? 'scheduler choice'
        : refused?.kind === 'quota'
          ? 'quota'
          : refused || !previousWorker || previousWorker.retiredAt
            ? 'previous worker unavailable'
            : 'scheduler choice'
  const previousLabel = previousWorker?.label ?? previous.workerId.slice(0, 8)
  addMessage(
    task.id,
    'system',
    `Worker switched to ${worker.label} (${model ?? 'default'}) — ${reason}`,
    run.id,
    [],
    {
      event: 'worker.switched',
      detail: [
        `Previously on ${previousLabel}${refused ? `: ${refused.why}` : contended ? ', which scored lower this time' : ''}.`,
        detail
      ].join('\n')
    }
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
  quotaUnverified: boolean,
  choice: Pick<WorkerChoice, 'refusals' | 'scored'> = {}
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
  // ⛔ Same answer as the cold path: a trunk task continues only in a conversation sitting in the
  // trunk (`warmSessionFor` guarantees that), and re-takes the trunk lease rather than a pool member.
  const trunkMode = project !== null && resolveWorkspaceMode(task, project).mode === 'trunk'
  if (project && trunkMode && !workspaces.has(session.id)) {
    reclaimed = workspaceHeldBy(project, task.id) ?? claimTrunk(project, task.id)
    if (!reclaimed || reclaimed.kind !== 'trunk') {
      if (reclaimed) releaseWorkspace(reclaimed.claimId)
      const holder = trunkHolder(project)
      throw new Contended(
        `the trunk of ${project.name} is held by ${holder ? holderLabel(holder.holder) : 'another task'}`,
        trunkResourceId(project.id)
      )
    }
    reassignClaim(reclaimed.claimId, session.id)
    workspaces.set(session.id, { workspace: reclaimed, projectId: project.id })
  } else if (project && !workspaces.has(session.id)) {
    reclaimed = await claimWorkspace(project, task.id, session.cwd)
    if (!reclaimed && (await evictResident(project, 'worktree'))) {
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
  const branch = trunkMode
    ? null
    : (task.branch ?? (project && project.vcs === 'git' ? branchNameFor(task.seq, task.title, task.branchUnit) : null))

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
    markDelivered: true,
    // ⚠️ Nothing compacts a session on this path — it never closed — but the CLI may have compacted
    // itself mid-run, and a summary is a summary however it was bought.
    compacted: framingLapsed(task.id, session.id)
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
  // ⛔ The money half of the same bracket, and only on an account that is spending credits.
  // See `captureSpendBefore` for why it is narrowed and why nothing waits on it.
  void captureSpendBefore(run)
  clearActivity(task.id)
  if (reclaimed) workspaces.set(session.id, { workspace: reclaimed, projectId: project?.id ?? null })

  // ⚠️ The branch travels with the status, exactly as it does on a cold dispatch. Without it a
  // borrowed task stays `branch: null` forever and the finish path has nothing to land.
  setStatus(task.id, 'running', { assignee: worker.id, ...(branch ? { branch } : {}) })
  const borrowed = !runsFor(task.id).some((r) => r.sessionId === session.id && r.id !== run.id)
  if (borrowed) {
    const owner = previousOccupant && previousOccupant.id !== task.id ? `t${previousOccupant.seq}` : 'another task'
    addMessage(task.id, 'system', `Joined ${owner}'s conversation — this agent can see that task's work`, run.id, [], {
      event: 'conversation.joined',
      detail: saved !== null && saved > 0
        ? `About ${saved} input-token-equivalents cheaper than a cold start.`
        : 'Continued warm; this provider’s cache saving is not priced.'
    })
  }
  announceWorker(
    task,
    worker,
    session.model ?? worker.defaultModel,
    run,
    dispatchDetail({
      choice: {
        reason: `warm continuation (${saved === null ? 'saving unknown' : `~${saved} input-token-equivalents saved`})`
      },
      workspace: session.cwd,
      branch,
      revive: true,
      quotaUnverified
    }),
    choice
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
  addMessage(task.id, 'system', `Compacting before starting (≈${plan.estimatedCost} tokens)`, null, [], {
    event: 'compaction',
    detail:
      `Compacting before starting: ${plan.reason}. This costs about ${plan.estimatedCost} tokens ` +
      'once, and the prompt goes in as soon as it lands.'
  })
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
        `Compaction did not land in ${Math.round(RESUME_COMPACT_WAIT_MS / 60000)}m — starting on the full context`,
        null,
        [],
        {
          event: 'compaction',
          detail:
            'The compaction did not land within ' +
            `${Math.round(RESUME_COMPACT_WAIT_MS / 60000)} minutes, so the work is starting on the ` +
            'full context. The request stays on the record, unlanded.'
        }
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
 * the workspace, which is safe to do to a healthy run and is the whole reason this may act on one
 * reading where a stall needs two.
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
    const protocol = adapter(session.adapterId).info.policy.wrapUpProtocol
    const worker = getWorker(session.workerId)
    const onCredits = worker ? spendingCreditsOn(worker, settings().spendCreditsPastLimit) : false
    const quota = lastQuota(session.workerId)
    const pool = worker ? poolFor(worker, session.model) : null
    const blocking = quota ? poolVerdict(windowsForPool(quota.windows, pool)).blocking : null
    const exhausted = blocking?.exhausted && !onCredits
    const refused = refusalRateLimit(session.workerId) !== null
    const permitted = mayCompact(session, settings().autoCompact, settings().spendCreditsPastLimit, 'quota').allowed
    const canCompact = protocol === 'compact' && !refused && !exhausted && permitted
    const action = canCompact ? 'compact' : 'handoff'
    const preemptAt = trigger === 'window'
      ? Math.min(now + QUOTA_PREEMPT_WARNING_MS, resumeAt)
      : now + QUOTA_PREEMPT_WARNING_MS
    const graceSeconds = Math.max(0, Math.ceil((preemptAt - now) / 1000))
    setQuotaPreemptWarning(task.id, { trigger, reason, preemptAt, resumeAt, action, canCompact })
    addMessage(task.id, 'system', `Quota preemption in ${graceSeconds}s unless overridden`, null, [], {
      event: 'quota.preempted',
      detail:
        `Quota preemption warning: ${reason}. Automatic ${action} in ` +
        `${graceSeconds} seconds unless a person changes or overrides it.`
    })
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
  await preempt(task, session, resumeAt, reason, warning.action)
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
      // ⛔ The same blindness as the stall clock below, and here it decides rather than reports: an
      // agent asked to commit answers with *one long turn*, and on an adapter that writes no turn
      // until that turn ends `lastRequestStartedAt` cannot say a call is in flight. A commit that
      // takes longer than three minutes would be decided out from under an agent that was doing it.
      // `lastRequestEvidenceAt` is the mid-turn half of the same question.
      const quietForFinish = quietSince({
        lastRequestStartedAt: session.lastRequestStartedAt,
        sessionStartedAt: session.startedAt,
        lastActivityAt: lastRequestEvidenceAt(session.id)
      })
      if (finishReplyOverdue(task.finishAskedAt, quietForFinish)) {
        log.warn(
          `t${task.seq} was asked to finish ${Math.round((Date.now() - task.finishAskedAt) / 60000)}m ` +
            'ago and has not reported since; deciding it from the workspace instead'
        )
        await completeTask(session.id, 'Finished after being asked to commit')
        continue
      }
    }

    // 0b. The turn ended, nothing terminal was said, and nothing has happened since.
    //
    // ⛔ **This is the t249/t254 hole, and it is closed here rather than in `onStreamResult`**
    // because the `result` record alone does not prove the session is finished being useful — the
    // daemon may write the next prompt into it. What proves it is the same silence check the finish
    // fallback above uses, applied to a turn we *know* ended. See `idleTurns`.
    //
    // ⛔ **It claims nothing about the work.** `parkForHuman` is the `await_human` verdict the agent
    // should have reached for itself: the run closes as `blocked` — it did work and metered turns
    // and is one answer away from carrying on — the task comes to rest at `awaiting_human` carrying
    // the agent's own last words, and nothing is landed, committed, discarded or graded. The session
    // stays warm, so a person's reply is a `continueTask` into the same thread.
    //
    // ⚠️ Skipped while a completion is still landing, for the t56 reason: `completeTask` owns this
    // session's teardown and parking underneath it would overwrite a reported completion. If that
    // completion then throws and leaves the run open, this is what eventually notices.
    const idle = idleTurnFor(session.id)
    if (idle && idle.runId === run.id && !compacting && !completing.has(session.id)) {
      const quiet = quietSince({
        lastRequestStartedAt: session.lastRequestStartedAt,
        sessionStartedAt: session.startedAt,
        runStartedAt: run.startedAt,
        compactionLandedAt: lastCompactionLandedAt(session.id),
        // ⚠️ Here it can only ever delay the hand-over, and that is the correct direction: the record
        // that proved the turn ended is excluded from this clock (`NO_REQUEST_EVIDENCE`), so anything
        // it does see arrived *after* that — a session that has started talking again.
        lastActivityAt: lastRequestEvidenceAt(session.id)
      })
      if (idleTurnOverdue(idle.at, quiet)) {
        const minutes = Math.round((Date.now() - idle.at) / 60000)
        log.warn(
          `t${task.seq} ended its turn ${minutes}m ago without reporting completion and nothing has ` +
            'happened since; handing it to a person rather than leaving the run open'
        )
        forgetIdleTurn(session.id)
        // ⭐ The CLI's own `needs_action` sentence where the turn carried one, for the same reason
        // `onSessionExit` prefers it: "it is waiting for you to choose between OAuth and session
        // cookies" is a better thing to read than "something happened, over to you".
        // ⚠️ Taken, not merely read: the sentence has now been reported once, and a later turn on
        // this same session that stops for a different reason must not inherit it.
        const waiting = blockedOn.get(session.id)
        blockedOn.delete(session.id)
        await parkForHuman(
          session.id,
          'The agent finished its turn without calling `task_complete`, `await_human` or ' +
            `\`ask_human\`, and has done nothing for ${minutes} minutes since. Nothing has been ` +
            'landed, committed or discarded — the work is exactly as the agent left it. ' +
            (waiting
              ? `It stopped to ask you something: "${waiting.slice(0, 400)}"`
              : idle.said
                ? `The last thing it said was: "${idle.said.slice(0, 400)}"`
                : 'It said nothing on the way out.')
        )
        continue
      }
    }

    // 1. The window boundary. This is the case the whole tool was built for.
    // The account may meter several model families independently. This run's session records the
    // model that actually started, so it outranks a task constraint a person may have edited for a
    // later retry. Asking for an unqualified worker reset here would let another pool preempt it.
    const watchdogWorker = getWorker(run.workerId)
    const runningModel = session.model ?? run.model
    const reset = windowResetsAt(
      run.workerId,
      watchdogWorker ? poolFor(watchdogWorker, runningModel) : null
    )
    const project = task.projectId ? getProject(task.projectId) : null
    const taskObjective = resolveObjective(project?.config?.objective, task.objective, switches.objective)
    const margin = policy(taskObjective).preemptMarginMs

    // ⛔ **The plan limit is where usage credits start doing their job.** Both halves have to hold:
    // the operator's fleet switch, and the vendor's own word that *this* account has credits on.
    // Where they do, the quota preempts below stand down — wrapping a run up at the limit is exactly
    // what defeats the credits it was bought to spend. Where the worker has no credits the guards
    // stay up, because a run pushed into an exhausted window with nothing behind it does not get a
    // reprieve, it gets a hard vendor refusal and loses the commit the wrap-up would have made.
    //
    // ⛔ **Read here, acted on at each trigger, and never announced before one fires.** An earlier
    // draft said the stand-down the moment a run began on a credit-enabled worker, which put a
    // paragraph about the plan limit on the thread of every run that never went near it. The
    // sentence is only true, and only wanted, at the moment an intervention would actually have
    // happened — so each of the three triggers below asks for it by name.
    const onCredits = spendingCreditsOn(getWorker(run.workerId), switches.spendCreditsPastLimit)

    // A rejection outranks an earlier caution. The turn has already failed, so leaving a stored
    // boundary warning in front of this check would misleadingly offer a choice for another minute.
    const refused =
      switches.autoOverrunPreempt && task.preemptible
        ? overrunVerdict(run.workerId, null, { quotaOverride: quotaOverridden(task) })
        : null
    if (refused && onCredits) {
      noteCreditsStandDown(run, task, 'preempt')
    } else if (refused) {
      if (task.quotaPreemptWarning) setQuotaPreemptWarning(task.id, null)
      log.warn(`t${task.seq} preempted for quota overrun risk (${refused.reason})`)
      await preempt(task, session, refused.resumeAt, refused.reason)
      continue
    }

    // A reset clock says when this window turns over, not that the account is about to refuse a
    // turn.  It needs a fresh reading from this run's own pool at the same high-water mark that
    // stops new work; otherwise a healthy Codex run at 59% can be interrupted merely because its
    // periodic config-cache reset is nearby (t418, 2026-09-13).
    const boundaryQuota = lastQuota(run.workerId)
    const boundaryWindow = watchdogWorker && boundaryQuota && !boundaryQuota.stale
      ? sessionWindowFor(boundaryQuota.windows, poolFor(watchdogWorker, runningModel))
      : null
    const boundaryAtRisk =
      boundaryWindow !== null &&
      boundaryWindow !== undefined &&
      !windowExpired(boundaryWindow) &&
      boundaryWindow.percent >= windowHighWater(boundaryWindow)

    if (
      switches.autoPreempt &&
      boundaryAtRisk &&
      reset &&
      reset.at - Date.now() <= margin &&
      task.preemptible
    ) {
      if (onCredits) {
        noteCreditsStandDown(run, task, 'preempt')
      } else if (await warnBeforeQuotaPreempt(task, session, 'window', reset.at, reset.source)) {
        continue
      }
    }

    // 2. Active 5h quota exhaustion, or a vendor refusal mid-stream.
    if (switches.autoOverrunPreempt && task.preemptible) {
      const worker = watchdogWorker
      const quota = lastQuota(run.workerId)
      let percent: number | null = null
      if (worker && quota && !quota.stale) {
        const choice = resolveModelChoice(task.constraints, worker, false, quota)
        const win = sessionWindowFor(quota.windows, poolFor(worker, runningModel ?? choice.model))
        if (win && !windowExpired(win)) percent = Math.round(win.percent)
      } else if (worker && run.quotaBefore && !run.quotaBefore.stale) {
        // Fall back to the baseline snapshot taken at dispatch if mid-run staleness elapsed (>15m)
        const pool = poolFor(worker, run.model)
        const win =
          run.quotaBefore.windows.find(
            (w) => isSessionRateWindow(w.id) || (pool && (w.group?.includes(pool) ?? false))
          ) ??
          run.quotaBefore.windows.find((w) => isSessionRateWindow(w.id) || (pool && w.id.includes(pool))) ??
          run.quotaBefore.windows.find((w) => isSessionRateWindow(w.id)) ??
          run.quotaBefore.windows[0]
        if (win) percent = Math.round(win.percent)
      }

      const verdict = overrunVerdict(run.workerId, percent, {
        quotaOverride: quotaOverridden(task)
      })
      if (verdict && onCredits) {
        // ⛔ The window is exhausted and the account is spending credits: this is the case the
        // switch was bought for, and it is the one place a person is owed the sentence.
        noteCreditsStandDown(run, task, 'preempt')
      } else if (verdict) {
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
      addMessage(task.id, 'system', `Runaway: ${factor.toFixed(1)}× the estimate — stopping`, null, [], {
        detail:
          `This run has spent about ${factor.toFixed(1)}× the estimate for work like it. ` +
          'Stopping it and handing it back rather than letting it keep spending.'
      })
      await preempt(task, session, Date.now(), 'runaway')
      continue
    }

    // 3. A stall. ⛔ Reported once and never killed; parked if a second reading confirms it.
    // ⚠️ `quietSince`, not the request clock alone: on a resumed conversation that clock belongs to
    // the previous run and is hours old, which is how t105 was accused of 947 minutes of silence
    // ninety seconds after it was dispatched.
    //
    // ⛔ **And `lastRequestEvidenceAt`, because a turn that has not ended has written no clock.** On
    // an adapter that takes one prompt and then works, `lastRequestStartedAt` does not move until the
    // turn is over, so this read the run's age and called it silence — t366, 2026-09-11: *"no turn for
    // 12m"* about a run with nine model responses behind it, and then *"no turn for 13m"* for a
    // silence two minutes old. The CPU half of the verdict is what kept the first of those from being
    // reported; this is the half that makes the number true.
    const lastTurn = quietSince({
      lastRequestStartedAt: session.lastRequestStartedAt,
      sessionStartedAt: session.startedAt,
      runStartedAt: run.startedAt,
      compactionLandedAt: lastCompactionLandedAt(session.id),
      lastActivityAt: lastRequestEvidenceAt(session.id)
    })
    if (!compacting && Date.now() - lastTurn > STALL_AFTER_MS) {
      await judgeStall(task, session, lastTurn)
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
 * Say whether a silent run is stuck or merely slow, with the evidence, and hand it over if it says so
 * twice.
 *
 * ⛔ **Nothing is ever killed here.** `AGENTS.md` has said since M2 that the fleet does not kill a
 * process it cannot prove is its own, and reading a flat CPU total is not that proof. The operator's
 * own move — read the tree, stop the thing that is holding it — stays theirs.
 *
 * ⭐ **The first verdict is a message; the second parks the task** (owner's decision, 2026-09-11,
 * after t366 sat `running` for 32 minutes on a tool call `agy` had backgrounded and then waited on
 * forever). One reading is good enough to ask a person and not good enough to act on, because a run
 * blocked on a slow network call burns no CPU either — but a tree that was flat for a stall window,
 * was told so, and is still flat `STALL_CONFIRM_AFTER_MS` later has had twenty-four minutes to come
 * back and has not. ⚠️ What the second verdict buys is bounded deliberately: `parkForHuman` closes the
 * run as `blocked` and the task rests at `awaiting_human` — nothing is landed, committed, discarded or
 * graded, and the work is exactly as the agent left it. A false positive costs one reply.
 */
async function judgeStall(task: Task, session: Session, lastTurn: number): Promise<void> {
  const minutes = Math.round((Date.now() - lastTurn) / 60000)
  if (!session.pid) {
    log.warn(`t${task.seq} has had no turn for ${minutes}m (no pid recorded, so nothing to measure)`)
    return
  }

  const previous = stallWatch.get(session.id)
  // A turn since the last look means the run was working; whatever came before describes a
  // different silence and must not be compared against this one.
  const history = previous && previous.lastTurn === lastTurn ? previous : null
  if (history?.reported && history.sample) {
    await confirmStall(task, session, lastTurn, history.sample, minutes)
    return
  }
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
  addMessage(task.id, 'system', `Looks stuck: no turn for ${minutes}m (reported, not stopped)`, null, [], {
    detail:
      `${headline}. Work burns CPU; a wait on something that will never arrive does not.\n\n` +
      `${describeTree(sample)}\n\n` +
      '⚠️ Nothing has been stopped — this is a report, and a run blocked on a slow network call ' +
      'looks the same. If it is stuck, stop the process above that is holding it and this task ' +
      'will carry on; the fleet will not kill a process it cannot prove is its own. ' +
      `If the tree is still flat in ${Math.round(STALL_CONFIRM_AFTER_MS / 60000)} minutes the task ` +
      'will be handed to you rather than left running — still without stopping anything.'
  })
}

/**
 * The second reading of a tree that has already been reported, and the hand-over.
 *
 * ⛔ **The baseline is the sample the report was written from**, which is what makes this a second
 * verdict rather than the first one taken again: the run is being asked what it has done since a
 * person was told it looked stuck.
 *
 * ⚠️ An unreadable tree leaves the baseline in place and decides nothing, for the reason the first
 * verdict has always given — not being able to measure is not evidence. ⭐ And a tree that *has*
 * moved replaces the baseline, so the clock starts again: a run that burns a second of CPU every ten
 * minutes is odd, but it is not this.
 */
async function confirmStall(
  task: Task,
  session: Session,
  lastTurn: number,
  reported: TreeSample,
  minutes: number
): Promise<void> {
  if (!session.pid) return
  if (Date.now() - reported.at < STALL_CONFIRM_AFTER_MS) return
  const sample = await sampleProcessTree(session.pid)
  if (!sample) return
  if (!stallConfirmed(reported, sample)) {
    stallWatch.set(session.id, { lastTurn, sample, reported: true })
    log.info(
      `t${task.seq} still has had no turn for ${minutes}m, but its tree has used ` +
        `${(sample.cpuSeconds - reported.cpuSeconds).toFixed(1)}s of CPU since the report - not parking it`
    )
    return
  }

  const overMinutes = Math.round((sample.at - reported.at) / 60_000)
  const gained = sample.cpuSeconds - reported.cpuSeconds
  const headline =
    `t${task.seq} is confirmed stuck: no turn for ${minutes}m, and the ${sample.processes.length} ` +
    `process(es) under it have used ${gained.toFixed(1)}s of CPU in the ${overMinutes}m since it was ` +
    'reported'
  log.warn(`${headline} - handing it to a person`)
  // ⛔ The evidence as its own line, before the hand-over, because `parkForHuman` writes the reason
  //    and a process table is not a reason. Same shape as the report above, so the two read as one
  //    thread: what was seen, and then what was decided.
  addMessage(task.id, 'system', `Confirmed stuck: no turn for ${minutes}m, twice measured`, null, [], {
    detail: `${headline}. Work burns CPU; a wait on something that will never arrive does not.\n\n${describeTree(sample)}`
  })
  // ⚠️ Keyed state dropped: the next run on this session is a different silence, and a baseline from
  //    this one would accuse it of inheriting the stall.
  stallWatch.delete(session.id)
  await parkForHuman(
    session.id,
    `It has had no turn for ${minutes} minutes and its process tree has used ${gained.toFixed(1)}s of ` +
      `CPU in the ${overMinutes} minutes since that was first reported, so it is stuck rather than ` +
      'slow. Nothing has been landed, committed, discarded or stopped — the work is exactly as the ' +
      'agent left it, and the processes are still running, because the fleet will not kill a process ' +
      'it cannot prove is its own. If the one named in the report above is still holding it, stop that ' +
      'first: replying here starts a new run, and a reply into a session that is genuinely hung goes ' +
      'nowhere.'
  )
}

/**
 * Which runs have already been told that the credit switch is holding the quota guards down.
 *
 * ⛔ **In memory and keyed by run, because the message is about a decision rather than an event.**
 * The scheduler re-reaches these checks on every tick; a thread line per tick would bury the run's
 * actual conversation under a standing fact. Its correct lifetime is the run — a restart returns
 * running tasks to `awaiting_human` anyway, so a set that survived one would be describing work that
 * no longer exists. Same reasoning as `activity.ts`.
 *
 * ⚠️ Never emptied entry by entry, which is the cheaper of the two mistakes available: an entry is
 * two short strings, and only a run that actually reached the plan limit on a credit-enabled account
 * ever adds one. Clearing it as each run ends would need a hook in `finishRun`, which lives in
 * `tasks.ts` and must not import this module back.
 */
const creditStandDownSaid = new Set<string>()

/**
 * Say, once, that an intervention was skipped because this account is spending usage credits.
 *
 * ⛔ **An intervention that does not happen leaves no trace, and that is the problem.** A run
 * carrying on at 100% of its window looks identical to a run the scheduler forgot about, and the
 * operator has no way to tell which from the board. This is the sentence that tells them, and it
 * names *both* conditions — the fleet switch and this worker's own credit status — because either
 * one being off is what they would need to change.
 */
function noteCreditsStandDown(run: Run, task: Task, what: 'preempt' | 'compact'): void {
  const key = `${run.id}:${what}`
  if (creditStandDownSaid.has(key)) return
  creditStandDownSaid.add(key)
  const worker = getWorker(run.workerId)
  const doing = what === 'preempt' ? 'wrap this run up at the plan limit' : 'compact this session'
  addMessage(task.id, 'system', `Not going to ${doing} — spending credits`, null, [], {
    detail:
      `Not going to ${doing}: "spend credits past the plan limit" is on, and ${worker?.label ?? 'this worker'} ` +
      'reports usage credits enabled, so the run carries on past the limit and is billed against ' +
      'those credits. Turn the switch off in Settings › Fleet to go back to wrapping up instead.'
  })
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
  because: string,
  requestedAction?: 'compact' | 'handoff'
): Promise<void> {
  const run = runsFor(task.id).find((r) => !r.endedAt)
  // ⛔ Claimed before anything is sent, and never re-entered. A second wrap-up prompt is not a
  // harmless duplicate: it is a turn the agent has to pay for in order to say it already finished.
  if (run) {
    if (preempting.has(run.id)) return
    preempting.add(run.id)
  }

  const info = adapter(session.adapterId).info
  const worker = getWorker(session.workerId)
  const onCredits = worker ? spendingCreditsOn(worker, settings().spendCreditsPastLimit) : false
  const quota = lastQuota(session.workerId)
  const pool = worker ? poolFor(worker, session.model) : null
  const blocking = quota ? poolVerdict(windowsForPool(quota.windows, pool)).blocking : null
  const exhausted = blocking?.exhausted && !onCredits
  const refused = refusalRateLimit(session.workerId) !== null
  const permitted = mayCompact(session, settings().autoCompact, settings().spendCreditsPastLimit, 'quota').allowed
  const canCompact = info.policy.wrapUpProtocol === 'compact' && !refused && !exhausted && permitted
  const automaticAction = canCompact ? 'compact' : 'handoff'
  const action = requestedAction === 'compact' && !canCompact
    ? 'handoff'
    : (requestedAction ?? automaticAction)
  const minutes = Math.max(1, Math.round((resumeAt - Date.now()) / 60000))
  const budgetLine = info.policy.needsExplicitBudget
    ? `You have roughly ${minutes} minute(s) of window left and no more. `
    : ''

  // ⛔ The row id, not just the fact of the ask. If the run ends on its own before the boundary
  // (t446: the agent answered the `/compact` with a prose wrap-up and stopped), `park` still owes
  // the thread a verdict on *this* ask — but only if no newer ask has since taken over the story.
  let askId: number | null = null
  if (action === 'compact') {
    try {
      sendPrompt(session.id, '/compact', [], { housekeeping: true })
      askId = noteCompactionAsked({
        sessionId: session.id,
        taskId: task.id,
        reason: `quota preemption: ${because}`,
        preTokens: session.contextTokens
      })
      markClockMove(session.id, 'compact', session.tokensSinceCompact)
    } catch (err) {
      log.warn(`could not send the preemption compaction for t${task.seq}:`, err)
    }
  } else {
    const handoffFile = existsSync(join(session.cwd, 'HANDOFF.md'))
    try {
      sendPrompt(
        session.id,
        `${budgetLine}Wrap up now. Commit anything that safely compiles on this branch. ` +
          (handoffFile
            ? 'Update HANDOFF.md with what is done, what remains, validation status, and the next step. '
            : '') +
          'Then call the `handoff` tool with what you were doing, what is done, validation status, and the next step. ' +
          'Do not start new work.'
      )
    } catch (err) {
      log.warn(`could not send the wrap-up for t${task.seq}:`, err)
    }
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
      ? `Preempted: ${action === 'compact' ? 'compacting' : 'wrapping up'} — well past its estimate`
      : `Preempted for quota — ${action === 'compact' ? 'compacting' : 'wrapping up'}, resumes ${clockTime(resumeAt)}`,
    null,
    [],
    {
      event: 'quota.preempted',
      detail:
        because === 'runaway'
          ? `This run was well past its estimate and is ${action === 'compact' ? 'compacting' : 'writing a handoff'} before it stops.`
          : `Preempting before the quota window closes (${because}) by ${action === 'compact' ? 'compacting the conversation' : 'committing and writing a handoff'}. Resuming automatically after the ` +
             `reset, expected ${new Date(resumeAt).toISOString()}.${shownLine}`
    }
  )
  // ⭐ Go and make the displayed number true. The probe itself is the poller's job and its gates
  // still apply; this only says that this account is now worth looking at.
  if (because !== 'runaway') {
    requestUrgentProbe(run?.workerId ?? session.workerId, `a run was preempted here (${because})`)
  }

  // Give the selected protocol time to land, then park the task so it resumes itself. Compaction
  // closes as soon as its boundary arrives; handoff has no structured completion event, so it uses
  // the existing bounded grace period.
  let settled = false
  let stopWaiting = (): void => {}
  const park = (landed: boolean): void => {
    if (settled) return
    settled = true
    stopWaiting()
    clearTimeout(timer)
    void (async () => {
      try {
        // ⚠️ Two minutes is a long time in a fleet. The run may have ended on its own - the agent
        // took the instruction, committed, and called `task_complete` - and parking a task that has
        // since moved on would close a session somebody else's run is now holding.
        const current = run ? runsFor(task.id).find((r) => r.id === run.id) : null
        if (run && (!current || current.endedAt)) {
          // The pause is moot, but the compaction verdict is still owed when this ask is the one
          // still outstanding: t446's preemption ask sat unlanded with no message because the run
          // ended 26s after it was asked. A superseding ask owns the story instead, so stay silent.
          if (action === 'compact' && !landed && askId !== null && latestOpenCompactionId(session.id) === askId) {
            addMessage(task.id, 'system', 'Compaction did not land before the run ended', null, [], {
              event: 'compaction',
              detail: 'The run ended on its own before a compaction boundary arrived, so this compaction request remains recorded as unlanded and the session was not compacted by it.'
            })
          }
          return
        }
        if (action === 'compact' && !landed) {
          addMessage(task.id, 'system', 'Compaction did not land before the wrap-up deadline', null, [], {
            event: 'compaction',
            detail: 'The task is still paused safely and the compaction request remains recorded as unlanded.'
          })
        }
        if (action === 'handoff' && !requireTask(task.id).handoffNote) {
          setTaskHandoff(task.id, 'Preemption closed the session before the agent recorded a handoff. Inspect the branch and workspace before continuing.')
        }
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
  }
  const waitMs = action === 'compact' ? COMPACTION_GRACE_MS : WRAP_UP_GRACE_MS
  const timer = setTimeout(() => park(false), waitMs)
  if (action === 'compact') stopWaiting = onCompactionLanded(session.id, () => park(true))
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
        other.landingTarget === task.landingTarget
    )
    .flatMap((other) => {
      // ⚠️ Every commit a sibling landed, not just the tip of its last landing. `landedHeadSha` is
      // one SHA, so a sibling that landed twice — or landed a branch with two commits on it — left
      // commits on the shared target that this subtraction did not account for, and the tripwire
      // then blamed *this* task for them. `taskCommitShas` names the whole set; the head is the
      // fallback for a sibling that landed before those rows existed and could not be salvaged.
      const commits = taskCommitShas(other.id)
      if (commits.length > 0) return commits
      return other.landedHeadSha ? [other.landedHeadSha] : []
    })
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

  addMessage(task.id, 'system', 'Marked done by you', null, [], {
    detail: note?.trim()
      ? note.trim()
      : '⚠️ Nothing here verified the work — this records your judgement, not a check.'
  })

  // ⛔ Finish any open run BEFORE calling setStatus. If a run was still open when the task was
  // resolved by hand, it must be closed with the specific note about hand resolution or the clock
  // will keep ticking. This was t249's bug. setStatus will try to finish runs when the task
  // settles, so we need to do this first with the correct note.
  const session = sessionOf(task.id)
  if (session) {
    const run = runForSession(session.id)
    if (run && run.endedAt === null) {
      finishRun(run.id, 'completed', 'task resolved by hand while run was still open')
    }
  }

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
  if (session) {
    closeSession(session.id)
  }

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

  // ⛔ Requeuing this task for continuation starts a fresh run. Any lingering open run from an
  // earlier attempt (e.g. after approval escalation or process interruption) must be finished.
  for (const run of runsFor(task.id)) {
    if (!run.endedAt) {
      finishRun(run.id, 'terminated', 'task requeued for continuation')
    }
  }
  // A parked question can leave its old run's session lease behind: its waiter timed out, so the
  // task is requeued instead of receiving the answer in that live turn.  The next warm dispatch is
  // this same task taking that same lease again, and treating its old claim as somebody else's makes
  // it wait forever.  Release only session leases here: an awaiting-human task can separately hold
  // its workspace while the old conversation is parked, and that claim must survive until dispatch.
  for (const held of claimsForHolder(task.id)) {
    if (held.resourceId.startsWith('session:')) release(held.id)
  }
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
export const completing = new Set<string>()

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
    const proseLines = proseOf(activityFor(task.id))
    if (proseLines.length > 0) {
      effectiveSummary = proseLines.slice(-3).join('\n')
    } else {
      effectiveSummary = 'Completed'
    }
  } else if (task.finishPolicy === 'report-only') {
    // ⭐ **A report-only task's deliverable is the thread, so what it said on the way is kept.**
    //    `task_complete` describes its summary as *one line*, and a debate seat that obeys the tool
    //    over its prompt leaves a sentence where its whole position should be — t382 (2026-09-12)
    //    paid for three seats per round and could arbitrate one. Appended, never replacing: the
    //    summary is the agent's own choice of words and stays first. The run's tail, not the
    //    task's — it holds five times as many lines, and the position is the last thing said.
    effectiveSummary = withClosingProse(effectiveSummary, closingProse(runActivityFor(run.id), REPORT_PROSE_CHARS))
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
  // ⛔ Re-read from disk, not the cached row. Everything the finish gate below turns on — `check`,
  // `landing.target`, `landing.finish` — lives in a file in the user's own repo, and the row is
  // only refreshed on a *cold* dispatch. See `reloadProjectIfPresent` for the run this cost.
  const project = task.projectId ? reloadProjectIfPresent(task.projectId) : null
  log.info(
    `t${task.seq} reported complete: run=${run.id.slice(0, 8)} workspace=${held ? 'held' : 'MISSING'} ` +
      `branch=${task.branch ?? 'none'} project=${project?.name ?? 'none'}/${project?.vcs ?? '-'}`
  )

  if (project && held && held.workspace.kind === 'trunk' && project.vcs === 'git') {
    // ⭐ **A trunk task's finish.** Its own ladder (`decideTrunkFinish`): there is no branch to read,
    // so everything below that measures one is skipped, and the acts are the same four — ask once,
    // hand to a person, verify-and-maybe-push, or done.
    const resolved = resolveFinishPolicy(task, project)
    const target = landingTargetFor(task, project)
    const survey = await surveyTrunk(project)
    const decision = decideTrunkFinish({
      task,
      project,
      policy: resolved.policy,
      instruction: resolved.instruction,
      target,
      survey,
      dirtyBefore: run.trunkDirtyBefore ?? [],
      commitsThisRun: await trunkCommitsOfRun(project, task, run.trunkShaBefore),
      hasChecks: policyFor(project).check.length > 0
    })
    log.info(`t${task.seq} trunk finish: ${decision.kind} (${resolved.policy})`)

    if (decision.kind === 'ask-agent') {
      const finishing = getSession(sessionId)
      const oneShot =
        finishing !== null && adapter(finishing.adapterId).info.capabilities.streamPrompts === 'once'
      if (!oneShot) {
        markFinishAsked(task.id)
        addMessage(task.id, 'system', `Asked the agent to finish: ${oneLine(decision.reason)}`, null, [], {
          detail: decision.instruction
        })
        try {
          sendPrompt(sessionId, decision.instruction)
          return
        } catch (err) {
          log.warn(`could not send the trunk finish instruction for t${task.seq}:`, err)
        }
      }
      addMessage(task.id, 'system', `Not finished: ${oneLine(decision.reason)} — over to you`, null, [], {
        event: 'finish.held',
        detail: `${decision.reason}. The agent could not be asked, so this is over to you; the trunk was left exactly as it is.`
      })
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
    } else if (decision.kind === 'land') {
      const result = await landTask({
        project,
        task,
        workspacePath: project.root,
        branch: target,
        policy: resolved.policy,
        trunkBase: run.trunkShaBefore
      })
      if (result.ok) setStatus(task.id, 'completed')
      else if (!result.trunkBusy) automaticRetry = true
    } else if (decision.kind === 'await-human') {
      // ⭐ Recorded now, not at a landing that may never come: the diff at the gate and the quality
      // review both read `task_commits`, and a trunk task has no branch to fall back to.
      await recordTrunkRunCommits(project, task, run.trunkShaBefore, target)
      addMessage(task.id, 'system', `Finished, not verified: ${oneLine(decision.reason)}`, null, [], {
        event: 'finish.held',
        detail: decision.reason
      })
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: decision.reason })
    } else {
      await recordTrunkRunCommits(project, task, run.trunkShaBefore, target)
      const why = 'reason' in decision ? decision.reason : 'finished in the trunk'
      addMessage(task.id, 'system', `Finished — ${oneLine(why)}`, null, [], {})
      setStatus(task.id, 'completed')
    }
  } else if (project && held && task.branch && project.vcs === 'git') {
    // ⛔ One decision function, asked once, with the workspace read once. Everything below acts on
    // what it returns; nothing below decides anything for itself. See finish.ts for why the tool
    // never authors a commit here.
    const policy = policyFor(project)
    const finishPolicy = resolveFinishPolicy(task, project).policy
    const measured = await workspaceState(held.workspace.path, landingTargetFor(task, project))
    // ⛔ **A report-only branch is judged by what only it holds.** It is cut from the *local* target
    // and lands nowhere, so `landedRef`'s count is the trunk's unpushed history, not this task's —
    // t393–t395 each read as 15 commits with none of their own. `decideFinish` now refuses `done`
    // on anything left, so this is the difference between a finished seat and a stalled one.
    // ⚠️ A branch git cannot measure keeps the conservative reading.
    const state =
      finishPolicy === 'report-only' && measured.branch
        ? {
            ...measured,
            unlandedCommits: await commitsOnlyOn(
              held.workspace.path,
              measured.branch,
              landingTargetFor(task, project)
            ).catch(() => measured.unlandedCommits)
          }
        : measured
    // ⛔ Read **before** anything lands. `landTask` fast-forwards the trunk itself on a project with
    // no remote, so a reading taken afterwards would report the tool's own push as the movement it
    // is looking for — a tripwire that fires on its own footsteps is worse than none.
    const trunk = await readTrunkMovement(project, landingTargetFor(task, project), run)
    // ⭐ Asked **before** the decision, and it touches nothing — `merge-tree` merges in memory. This
    // is what lets a conflict be handed back to the live conversation instead of becoming a dead-end
    // `awaiting_human` discovered inside `landTask` two branches later. See `readMergeability`.
    // ⛔ The *finish* policy, not the project policy beside it. It decides which ref the landing
    // will rebase onto, so the mergeability check has to be told it or it answers about another.
    const merge = await readMergeability(project, held.workspace.path, task.branch, finishPolicy, task)
    const decision = decideFinish({
      task,
      project,
      state,
      hasChecks: policy.check.length > 0,
      trunk,
      merge,
      siblingLanded: siblingLandedShas(task),
      // ⭐ And this task's own landings, which a conversation makes ordinary in exactly the way
      // Plan & Split made a sibling's ordinary. See `FinishInputs.ownLanded`.
      ownLanded: taskCommitShas(task.id)
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
        addMessage(task.id, 'system', `Not finished: ${oneLine(decision.reason)} — over to you`, null, [], {
          event: 'finish.held',
          detail:
            `${decision.reason}. ${adapter(finishing.adapterId).info.label} runs one turn and exits, ` +
            'so it cannot be asked to finish the job afterwards — this one is over to you. Its next ' +
            'run is told to land its own work.'
        })
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
      // ⚠️ The instruction is sent whole; the thread keeps it behind the line.
      addMessage(task.id, 'system', `Asked the agent to finish: ${oneLine(decision.reason)}`, null, [], {
        detail: decision.instruction
      })
      try {
        sendPrompt(sessionId, decision.instruction)
      } catch (err) {
        log.warn(`could not send the finish instruction for t${task.seq}:`, err)
        addMessage(task.id, 'system', 'Could not reach the session to ask — over to you', null, [], {
          event: 'finish.held',
          detail: `${decision.reason}. The finish instruction could not be delivered to the session.`
        })
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
        addMessage(task.id, 'system', `Conflict with \`${decision.base}\` — over to you`, null, [], {
          event: 'finish.held',
          // ⛔ `decision.reason`, not a sentence composed fresh here: finish.ts's `landOrResolve`
          // names the branch and says "has a conflict" on purpose, and this is also exactly the
          // sentence `holdReason` gets two lines down — the detail in the thread and the reason on
          // the task must read as the same fact, not two summaries of it that could drift apart.
          detail:
            `${decision.reason}. ${adapter(finishing.adapterId).info.label} runs one turn and exits, ` +
            'so it cannot be asked to resolve the conflict mid-session — this one is over to you. ' +
            `Conflicts with \`${decision.base}\` in ${decision.paths.join(', ') || 'unknown files'}.`
        })
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
        // ⚠️ The instruction is sent whole; the thread keeps it behind the line.
        addMessage(task.id, 'system', `Asked the agent to resolve a conflict with \`${decision.base}\``, null, [], {
          detail: decision.instruction
        })
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
          addMessage(task.id, 'system', 'Could not reach the session — rebase put back, over to you', null, [], {
            event: 'finish.held',
            detail:
              'Could not reach the session to ask, so the rebase was put back and nothing was lost. ' +
              `Over to you: \`${task.branch}\` conflicts with \`${decision.base}\` in ` +
              `${paths.join(', ') || 'unknown files'}.`
          })
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
      else if (!result.trunkBusy) automaticRetry = true
    } else if (decision.kind === 'await-human') {
      addMessage(task.id, 'system', `Finished, not landed: ${oneLine(decision.reason)}`, null, [], {
        event: 'finish.held',
        detail: decision.reason
      })
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
      addMessage(task.id, 'system', `Not finished: the trunk moved and \`${task.branch}\` is empty`, null, [], {
        event: 'finish.held',
        detail: `${decision.reason}${listed}`
      })
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
      addMessage(task.id, 'system', 'Finished — nothing to land', null, [], {
        detail: `${decision.reason}${retired.note}`
      })
      setStatus(task.id, 'completed')
    } else {
      // ⚠️ Narrowed by hand: the chain now opens on `landNow` rather than on a kind, so TypeScript
      //    cannot rule out the kinds that carry no reason. `relandTask` reads it the same way.
      const why = 'reason' in decision ? decision.reason : 'nothing to land'
      // ⛔ **A report-only `done` retires its branch**, or every seat of every debate round leaves
      // a name under Loose ends. `decideFinish` only says `done` on that rung once the branch holds
      // nothing of its own and the tree is clean — the same licence `nothing-to-land` retires on.
      const retired =
        decision.kind === 'done' && finishPolicy === 'report-only'
          ? await finishWithoutLanding(held.workspace.path, task.branch, landingTargetFor(task, project))
          : null
      const said = `${why}${retired?.note ?? ''}`
      addMessage(task.id, 'system', `Finished — ${oneLine(why)}`, null, [], {
        ...(said === oneLine(why) ? {} : { detail: said })
      })
      setStatus(task.id, 'completed')
    }
  } else if (task.verification === 'required') {
    addMessage(task.id, 'system', 'Finished — waiting for your verification', null, [], {
      event: 'finish.held',
      detail: 'This task asked for human verification before it lands.'
    })
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
export async function endConversationTurn(
  session: Session,
  run: Run,
  task: Task,
  resultText?: string | null
): Promise<void> {
  const why = 'your turn'
  finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')

  let effectiveAnswer = (resultText ?? '').trim()
  if (!effectiveAnswer) {
    const proseLines = proseOf(activityFor(task.id))
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

export async function endUnfinishedRun(
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
      addMessage(task.id, 'system', `Parked on quota until ${clockTime(parkAt)}`, null, [], {
        event: 'quota.parked',
        detail:
          `${why} That is this account's quota window, not a fault in the work — parked until it ` +
          `resets, expected ${new Date(parkAt).toISOString()}, and the fleet puts this back in the ` +
          'queue by itself then (sooner, if a reading shows the window has already come back).'
      })
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
        `Provider overloaded — retrying in ${shortDuration(delaySec * 1000)} (${overloadRetry.attempt}/${MAX_OVERLOAD_ATTEMPTS})`,
        null,
        [],
        {
          event: 'provider.overloaded',
          detail:
            `${why} This is a temporary server-side issue from the provider — attempting again ` +
            `automatically in ${delaySec}s (attempt ${overloadRetry.attempt} of ${MAX_OVERLOAD_ATTEMPTS}, ` +
            `expected ${new Date(overloadRetry.retryAt).toISOString()}).`
        }
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
          addMessage(task.id, 'system', 'Nothing ran on this worker — back in the queue for another', null, [], {
            detail:
              `Nothing ran on this worker. ${reason} That account is held out of dispatch until it is ` +
              'probed again; this task goes back in the queue for another one.'
          })
        } else {
          log.warn(
            `conversation ${session.id.slice(0, 8)} failed to resume on ${run.workerId}; ` +
              `cleared prefix without holding out worker: ${reason}`
          )
          addMessage(task.id, 'system', 'Resuming the conversation failed — restarting cold', null, [], {
            detail:
              `Resuming conversation ${session.id.slice(0, 8)} failed (${reason}). ` +
              'The conversation prefix has been cleared; this task will restart cold.'
          })
        }
        setStatus(task.id, 'ready', { assignee: null })
      } else {
        recordDispatchFailure(run.workerId, reason, run.id)
        addMessage(task.id, 'system', 'Nothing ran on this worker — back in the queue for another', null, [], {
          detail:
            `Nothing ran on this worker. ${reason} That account is held out of dispatch until it is ` +
            'probed again; this task goes back in the queue for another one.'
        })
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
      addMessage(task.id, 'system', `Provider still overloaded after ${MAX_OVERLOAD_ATTEMPTS} attempts — over to you`, null, [], {
        event: 'provider.overloaded',
        detail: msg
      })
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: msg })
    } else {
      addMessage(task.id, 'system', oneLine(why), null, [], { ...(oneLine(why) === why ? {} : { detail: why }) })
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
 * End the planning turn once it has delegated its work.
 *
 * ⛔ A Plan & Split planner is blocked on its pieces, not on its own agent.  The old path changed
 * the task to `blocked` and relied on the agent obeying "STOP NOW" and exiting before it wound the
 * run up.  A planner that remained alive after its `task_split` response therefore kept accruing
 * active time (and retained its run's claims) for the entire time its pieces worked.  Filing a
 * successful split is itself the terminal event for this turn, so the control plane ends it here.
 */
export async function endPlannerForSplit(sessionId: string): Promise<void> {
  const run = runForSession(sessionId)
  if (!run?.taskId) return

  const task = getTask(run.taskId)
  // ⛔ Narrow to the state `applySplit` or `nextRound` has just written. A task can be blocked for ordinary
  // dependencies too, and that is not authority to stop its agent.
  if (!isIntegrationParent(task) || task?.status !== 'blocked') return

  const why =
    task.kind === 'debate'
      ? (task.debate?.verdict
          ? 'The debate organizer filed its plan as subtasks and stopped. This task waits for them and comes back by itself.'
          : 'The debate organizer sent briefs for the next round and stopped. This task waits for them and comes back by itself.')
      : 'The planner filed its plan as subtasks and stopped. This task waits for them and comes back by itself.'
  finishRun(run.id, 'blocked', why)
  void captureQuotaAfter(requireRun(run.id))
  await releaseFor(run.id, task.id, task.projectId)

  // `closeSession` only asks; `onSessionExit` releases the workspace after the process is actually
  // gone.  The run is deliberately closed before that asynchronous exit so its active clock stops
  // at the split, even if a CLI takes time to honour the close.
  closeSession(sessionId)
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
export async function releaseFor(
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
export async function releaseWorkspaceOf(sessionId: string, retainForTaskId: string | null = null): Promise<void> {
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
    // ⛔ **A trunk lease outlives the conversation while its task is only resting.** Decided
    // 2026-09-12: a paused, preempted or questioning trunk task keeps the checkout, because its
    // uncommitted files are sitting in it and the resume has to find them there — and nothing may
    // land over them meanwhile. It goes back to the task, exactly as a pool member does for
    // `awaiting_human`; a task that settles gives it up in `sweepTrunkLeases`.
    if (held.workspace.kind === 'trunk') {
      const owner = taskOfSession(sessionId)
      if (owner && !TERMINAL_STATUSES.has(owner.status)) {
        reassignClaim(held.workspace.claimId, owner.id)
      } else {
        releaseWorkspace(held.workspace.claimId)
      }
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
    if (retainForTaskId && (c.resourceId.startsWith('workspace:') || c.resourceId.startsWith('trunk:'))) {
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
      ? `Rescued ${rescue.files} uncommitted file(s) as ${rescue.sha.slice(0, 8)} on \`${rescue.branch}\``
      : `Stashed ${rescue.files} uncommitted file(s) — recover by hand`,
    null,
    [],
    {
      detail:
        rescue.kind === 'commit'
          ? `This run stopped with ${rescue.files} file(s) uncommitted. They were committed onto ` +
            `\`${rescue.branch}\` as ${rescue.sha.slice(0, 8)}, so the next run picks up where this one ` +
            'stopped. It cannot land until something is finished on top of it.'
          : `This run stopped with ${rescue.files} file(s) uncommitted, and they could not be committed ` +
            'onto the branch — they are in a git stash in this workspace instead. ⚠️ A stash does not ' +
            'travel to the next run: recover it by hand with `git stash list`.'
    }
  )
}

// ------------------------------------------------------------------- borrowing a conversation

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
    addMessage(previous.id, 'system', `Conversation borrowed by t${task.seq} — \`${result.from}\` untouched`, null, [], {
      detail:
        `The conversation this task was running in has been borrowed by t${task.seq}, and its ` +
        `workspace ${path} is now on \`${branch}\`. ⛔ Your branch \`${result.from}\` is untouched — ` +
        'nothing was committed, stashed or discarded. The workspace switches back when this task ' +
        'runs again, and the agent is told.'
    })
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

/** Whose branch is this? ⚠️ By name, because the branch *is* the task's name — see `branchNameFor`. */
function taskOnBranch(branch: string): Task | null {
  return listTasks().find((t) => t.branch === branch) ?? null
}


/**
 * How many commits reached the target during a trunk run that no other task is recorded as landing.
 *
 * ⚠️ The subtraction is the whole point: a worktree landing can fast-forward the trunk between two
 * of this run's turns (once it is free), and those commits are somebody else's. `null` when there is
 * no baseline to count from.
 */
async function trunkCommitsOfRun(project: Project, task: Task, before: string | null): Promise<number | null> {
  if (!before) return null
  try {
    const out = await git(project.root, ['rev-list', `${before}..HEAD`])
    const shas = out.split(/\s+/).filter(Boolean)
    const claimed = claimedByAnotherTask(task.id, shas)
    return shas.filter((sha) => !claimed.has(sha.toLowerCase())).length
  } catch {
    return null
  }
}

/**
 * Write a trunk run's own commits into `task_commits`, when no landing will.
 *
 * ⚠️ Same subtraction as `trunkCommitsOfRun`, and never throws: a finish must not fail because a
 * `git log` afterwards did not run.
 */
async function recordTrunkRunCommits(project: Project, task: Task, before: string | null, target: string): Promise<void> {
  if (!before) return
  try {
    const head = await git(project.root, ['rev-parse', 'HEAD'])
    const enumerated = await landedCommits(project.root, before, head)
    const claimed = claimedByAnotherTask(task.id, enumerated.map((c) => c.sha))
    const mine = enumerated.filter((c) => !claimed.has(c.sha.toLowerCase()))
    if (mine.length > 0) recordTaskCommits(task.id, mine, target)
  } catch (err) {
    log.warn(`could not record t${task.seq}'s trunk commits: ${String(err)}`)
  }
}

/** `t402` for a task or a session working on one, for a sentence a person reads. */
function holderLabel(holder: string): string {
  const id = holder.startsWith('reland:') ? holder.slice('reland:'.length) : holder
  const task = getTask(id) ?? taskOfSession(id)
  return task ? `t${task.seq}` : 'another task'
}

/**
 * What a trunk task is told about the checkout it has just been given.
 *
 * ⛔ **Said, never tidied** (decided 2026-09-12). The tool does not stash, commit or abort anything
 * in the operator's checkout to make room; it names what is there so the agent can work around it —
 * or, for a merge in progress, recognise that finishing it may be the job.
 */
export function trunkArrivalNotice(survey: TrunkSurvey, target: string): string {
  const lines: string[] = [
    `⚠️ You are working **directly in this project's trunk checkout**, not in a worktree. There is no ` +
      `task branch: commit on \`${target}\` itself. Do not create, switch or delete branches, do not ` +
      'stash, and do not reset — other people and other agents rely on this checkout.'
  ]
  if (survey.branch !== target) {
    lines.push(
      `⚠️ The checkout is on ${survey.branch ? `\`${survey.branch}\`` : 'a detached HEAD'}, not ` +
        `\`${target}\`. Do not commit there; if your task does not say otherwise, stop and ask.`
    )
  }
  if (survey.operation) {
    lines.push(
      `⚠️ A ${survey.operation} is in progress here` +
        (survey.conflicted.length ? `, with conflicts in ${survey.conflicted.slice(0, 10).join(', ')}` : '') +
        '. Finish it (resolve, `git add`, continue) only if that is what your task asks for; never abort it.'
    )
  }
  const loose = [...survey.dirtyFiles, ...survey.untrackedFiles]
  if (loose.length > 0) {
    lines.push(
      `⚠️ ${loose.length} file(s) were already uncommitted when you arrived and are not yours: ` +
        `${loose.slice(0, 10).join(', ')}${loose.length > 10 ? ', …' : ''}. Leave them as they are and ` +
        'do not include them in your commits unless your task is about them.'
    )
  }
  return lines.join('\n\n')
}

/**
 * Give back a trunk lease whose holder is no longer going anywhere.
 *
 * ⛔ **The thing that ends the hold** (AGENTS.md: every held status needs one). A lease moves to its
 * task when the conversation ends and the task is only resting; this frees it once that task has
 * settled — cancelled, completed, failed — or the holder names nothing that exists any more.
 * Zero tokens, one query per project with a lease.
 */
export function sweepTrunkLeases(): number {
  let freed = 0
  for (const project of listProjects()) {
    for (const c of openClaims(trunkResourceId(project.id))) {
      if (workspaces.has(c.holder)) continue
      const task = getTask(c.holder.startsWith('reland:') ? c.holder.slice('reland:'.length) : c.holder)
      const session = task ? null : getSession(c.holder)
      const alive = task ? !TERMINAL_STATUSES.has(task.status) : session !== null && !sessionEnded(session.state)
      if (alive) continue
      release(c.id)
      freed += 1
      log.info(`released the trunk lease of ${project.name} held by ${task ? `t${task.seq}` : c.holder.slice(0, 8)}`)
    }
  }
  return freed
}

async function evictResident(project: { id: string; name: string }, kind: 'worktree' | 'trunk'): Promise<boolean> {
  const now = Date.now()
  const victim = leastValuableResident(evictableResidents(project.id, kind), now)

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
      if (!run.endedAt) finishRun(run.id, 'terminated', RESTART_REAP_NOTE)
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
      addMessage(task.id, 'system', 'Restarted while cancelling — paused', null, [], { detail: why })
      setStatus(task.id, 'paused_user', { assignee: null, holdReason: why })
    } else {
      const why = 'orchestratord restarted while this was running; awaiting human input before resuming.'
      addMessage(task.id, 'system', 'Restarted while running — over to you', null, [], { detail: why })
      setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: why })
    }
  }

  // ⛔ Also reap any orphaned runs on tasks that were NOT in stuck (e.g. completed, failed, cancelled,
  // or awaiting_human tasks where an old run was left open). Across a restart, no supervisor is running
  // any prior process, so no run may remain open.
  const stuckIds = new Set(stuck.map((t) => t.id))
  for (const task of listTasks()) {
    if (stuckIds.has(task.id)) continue
    for (const run of runsFor(task.id)) {
      if (!run.endedAt) {
        const outcome =
          task.status === 'completed' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'terminated'
        finishRun(run.id, outcome, RESTART_REAP_NOTE)
        releaseAllFor(run.id)
        if (run.sessionId) releaseAllFor(run.sessionId)
      }
    }
  }

  if (stuck.length) log.warn(`recovered ${stuck.length} task(s) interrupted by a restart`)
  return stuck.length
}

/**
 * A resting conversation whose agent has started speaking again, on its own.
 *
 * ⭐ **t369, reported 2026-09-11.** The operator asked what the next step was; the agent answered
 * *"I'll report back when CI completes"*, its turn ended, and the task went to `awaiting_human`. CI
 * finished eight minutes later, the CLI's own background-task machinery handed the result back to
 * the agent, and it worked for several more minutes — visibly, in the session pane, and **nowhere
 * else**. `runForSession` finds only an *open* run, so every one of those assistant messages was
 * dropped on the floor in `onStream`: no peephole, no thread message, no metering, and a task still
 * reading *your turn* while its agent was mid-sentence.
 *
 * ⛔ **The answer is a run, because that is what work is here.** AGENTS.md: *work is visible, gated
 * and billed only as a run*. Attributing the output to the closed run would bill a turn that had
 * already been paid for and reopen a record that is supposed to be final; carrying it as loose
 * activity beside a resting task would make it visible and leave it unbilled and unrecorded. Opening
 * a run puts it back on the one path that already handles all of it — `noteActivity` finds the run,
 * `creditStreamTurn` finds the run, and `onStreamResult` ends it through `endConversationTurn`,
 * which writes the agent's words into the thread and rests the task again.
 *
 * ⛔ **It is not a dispatch and asks no dispatch question.** There is no quota gate, no scoring and
 * no eligibility check, because there is nothing to decide: the agent is *already talking*, on an
 * account that is already spending, in a session this task already holds. Refusing here would not
 * save a token; it would only lose the record of tokens being spent.
 *
 * ⚠️ **Four conditions, and each one is a way this could be wrong.** The conversation must still be
 * open (a finished task's session saying something more is not new work on it); the task must be
 * resting rather than running (a live run is the ordinary case and is already handled); the daemon
 * must not be the one who spoke (`isHousekeepingTurn` — a keepalive's reply is our turn, not the
 * task's); and the session lease must be free, because a conversation another task has borrowed is
 * that task's to answer for.
 */
export const RESUME_QUIET_MS = 5000

export function resumeIdleConversation(session: Session): Run | null {
  if (sessionEnded(session.state)) return null
  if (isHousekeepingTurn(session.id)) return null
  if (runForSession(session.id)) return null

  const last = lastRunForSession(session.id)
  const task = last?.taskId ? getTask(last.taskId) : null
  if (!task || !isOpenConversation(task)) return null
  if (task.status !== 'awaiting_human') return null
  // ⚠️ **A quiet period, because the last word of a turn can arrive after the record that ended
  // it.** `onStreamResult` closes the run on the vendor's `result`, and a trailing `assistant_text`
  // milliseconds later is the tail of the turn that just ended, not a new one — opening a run for it
  // would leave an empty run sitting open until a watchdog noticed. An agent woken by its own
  // background tooling comes back seconds to minutes later, never in the same breath. ⚠️ The
  // threshold is chosen to sit between those two, not measured against a distribution of either.
  if (last?.endedAt && Date.now() - last.endedAt < RESUME_QUIET_MS) return null

  const worker = getWorker(session.workerId)
  if (!worker) return null
  if (!acquireSessionLease(session.id, task.id)) return null

  const project = task.projectId ? getProject(task.projectId) : null
  const run = startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: task.projectId,
    quotaUnverified: false,
    costModelId: adapter(worker.adapterId).info.policy.costModelId,
    // The session never closed and nobody rebuilt its prefix, which is the warmest a run gets.
    startedWarm: true,
    trunkShaBefore: null,
    // ⛔ No prompt, and the null is the record: nothing was sent into this session. A `prompt` here
    // would invent a turn's instructions, and the thread's `📋` chip would offer words nobody wrote.
    prompt: null,
    objective: resolveObjective(project?.config?.objective, task.objective, settings().objective)
  })
  setRunQuota(run.id, 'before', runQuota(worker.id))
  clearActivity(task.id)
  setStatus(task.id, 'running', { assignee: worker.id })
  addMessage(task.id, 'system', 'The agent picked this up again by itself', run.id, [], {
    event: 'conversation.resumed',
    detail:
      'Nobody prompted this turn. The agent’s own tooling woke it — a command it left running in ' +
      'the background finished, most often — and it started speaking again in the session it was ' +
      'already resting in. It is metered as an ordinary turn, and the task goes back to waiting on ' +
      'you when it ends.'
  })
  log.info(
    `t${task.seq}: ${worker.label} resumed its conversation unprompted (run ${run.id.slice(0, 8)})`
  )
  return run
}

export function sessionOf(taskId: string): Session | null {
  const run = runsFor(taskId).find((r) => !r.endedAt)
  return run?.sessionId ? getSession(run.sessionId) : null
}

export { policyFor }
