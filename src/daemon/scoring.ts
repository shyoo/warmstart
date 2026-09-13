import { canWork } from '@shared/protocol.js'
import type { QuotaWindow, Session, Worker } from '@shared/protocol.js'
import type { Objective, Project, Task } from '@shared/tasks.js'
import { resolveWorkspaceMode, windowHighWater, WINDOW_HIGH_WATER } from '@shared/tasks.js'
import { WEIGHT_SIGNS } from '@shared/routing.js'
import { adapter } from './adapters/index.js'
import { paceFactors, paceFor, paceValue, type PaceFactors } from './pace.js'
import {
  lastQuota,
  windowsForPool,
  windowResetsAt,
  poolVerdict,
  freshRateLimit
} from './quota.js'
import {
  creditsPurseEmpty,
  inheritedModelFor,
  listWorkers,
  modelRoutingActive,
  routableModelsFor,
  spendingCreditsOn
} from './workers.js'
import { fitnessFor } from './fitness.js'
import { qualityReport } from './quality.js'
import { complexityOf } from './complexity.js'
import { exploreRoute } from './exploration.js'
import { accountRefusal } from './eligibility.js'
import { getProject, policyFor } from './projects.js'
import { addMessage, getTask, quotaOverridden } from './tasks.js'
import { enqueueConsult, hasPendingConsult, latestAnswer } from './controller.js'
import {
  routeDetail,
  routeQuestion,
  type RouteCandidate
} from './judgment.js'
import { sessionsForWorker } from './sessions.js'
import { availability, openClaims, trunkResourceId, workspacePoolId } from './resources.js'
import { workspaceHeldBy } from './worktrees.js'
import { log } from './log.js'
import { settings } from './settings.js'
import { estimateTask, type Estimate } from './estimator.js'
import {
  DEFAULT_CACHE_TTL_MS,
  resolveObjective,
  WEIGHT_FORMULAS,
  weights
} from './objective.js'
import { reserveState } from './reserve.js'
import { costModel } from './costmodel.js'
import { db } from './db.js'
import type { RoutingBasis } from '@shared/routing.js'
import type { WorkerChoice, WorkerRefusal } from './scheduler.js'
import {
  needsBaseline,
  poolFor,
  reopenableFor,
  stickyWorkerFor,
  warmSessionFor
} from './scheduler.js'
/**
 * ⚠️ **`WINDOW_HIGH_WATER` straight from `@shared/tasks.js`, never `scheduler.js`'s `QUOTA_HIGH_WATER`
 * re-export of it.** That re-export sits on the far side of the scheduler.ts <-> scoring.ts import
 * cycle, and `QUOTA_HIGH_WATER` was being read at *module-eval* time (in the `VALUE_MEANS` table
 * below), not inside a function body — the one place in this file the cycle was not safe. A bundler
 * that flattens the cycle into one file can evaluate scoring.ts's module body before scheduler.ts has
 * finished initialising its own top-level `const`, which is a `ReferenceError` in strict ESM
 * (temporal dead zone), not merely a stale value. Measured 2026-09-08: `vitest`'s per-file dynamic
 * imports never hit this ordering and stayed green; the real packaged daemon crashed on boot.
 */
import { atCapacity, evictableResidents, retainedReservations } from './residency.js'

/**
 * What `fitness` and `price` say for their basis while no worker has a routable-model allowlist.
 *
 * ⚠️ A sentence rather than an empty string, because `AGENTS.md` asks every belief to carry its
 * basis and "0" with nothing beside it reads as *measured and bad* rather than *not asked*.
 */
const INERT_BASIS =
  'model-aware routing is inert: no worker has a routable-model allowlist, so every candidate ' +
  'offers the single model it already uses and there is no model choice to score'

/**
 * When two candidates score this close, the arithmetic cannot separate them.
 *
 * ⚠️ A tie is only worth asking about on a task large enough that ε is worth more than the turn the
 * question costs - which is why the floor is deliberately high. Below it the top score wins and
 * nothing is spent. This is the weakest of the four judgment events and it is gated hardest.
 */
export const ROUTE_EPSILON = 0.1
const ROUTE_CONSULT_FLOOR_TOKENS = 150_000
/** After this, a routing answer is about a fleet that no longer exists. */
const ROUTE_ANSWER_MAX_AGE_MS = 5 * 60 * 1000

/**
 * ⭐ **The tie broken by the conversation that already exists, before anybody is asked anything.**
 *
 * `affinity` and `cold` already price reuse, but they are two terms among eleven, and a tie means
 * the rest cancelled them out — so the fleet was buying a controller turn to choose between a
 * candidate holding this task's own prefix and one that would rebuild it from nothing. Within ε that
 * is not a judgment call: the scores say the two are indistinguishable, and reuse is the strictly
 * cheaper of two equals. Measured 2026-08-28, a continued turn read back 41,542 cached tokens and
 * wrote 65, against a cold start that wrote the lot.
 *
 * ⛔ **Only when reuse actually separates the tied field.** If every tied candidate holds a
 * conversation, or none does, this says nothing and the consult goes ahead exactly as before — the
 * tie-break must not become a second, quieter scorer.
 *
 * ⚠️ `session ?? resumable`, the same `held` every term in `scoreCandidate` reads, so a
 * `streamPrompts: 'once'` adapter — which never has a live idle session and so could never win this
 * — is judged on the conversation it can genuinely reopen.
 *
 * ⚠️ Takes the field already sorted by score, and returns the highest-scoring reuser: this breaks a
 * tie, it does not re-rank one.
 *
 * Exported for its own tests: constructing a real ε-tie between a warm candidate and a cold one
 * through the whole scorer would be tuning quota percentages until the arithmetic cooperated, which
 * tests the tuning rather than the rule.
 */
export function reuseTieBreak(tied: WorkerChoice[]): WorkerChoice | null {
  const reusing = tied.filter((c) => c.session ?? c.resumable)
  if (reusing.length === 0 || reusing.length === tied.length) return null
  return reusing[0] ?? null
}

/**
 * Why the operator's "spend credits past the plan limit" did not lift this refusal — or nothing.
 *
 * ⭐ **The switch is inert on its own, and an inert switch that says nothing is indistinguishable
 * from a broken one.** An operator who threw it to get a task moving and watched the same sentence
 * come back tick after tick has no way, from the row, to tell *which* of the three conditions it is
 * waiting on: an account nobody has probed, a vendor that says credits are off, or a monthly purse
 * already spent. Each has a different next move, so each gets named.
 *
 * ⚠️ Silent unless the switch is on and did not apply. With the switch off there is nothing to
 * explain, and where it *did* apply there is no refusal to append to.
 */
function whyCreditsDidNotLift(worker: Worker, switchOn: boolean): string {
  if (!switchOn || spendingCreditsOn(worker, true)) return ''
  const lead = ' — "spend credits past the plan limit" is on, but '
  const credits = worker.credits
  if (!credits) {
    return `${lead}nothing has read this account's credit status yet, so it does not lift this`
  }
  if (creditsPurseEmpty(credits)) {
    const spent = `${credits.used}${credits.currency ? ` ${credits.currency}` : ''}`
    return `${lead}${worker.label} has spent all ${spent} of its monthly credits, so it does not lift this`
  }
  const why = credits.disabledReason ? ` (${credits.disabledReason})` : ''
  return `${lead}${worker.label} reports usage credits off${why}, so it does not lift this`
}

export function chooseTarget(task: Task, random = Math.random): WorkerChoice {
  const reasons: string[] = []
  /**
   * ⛔ Standing until something transient is met, not the other way round. A field of refusals is
   * only *standing* if every one of them is — the task needs one worker, and one that is merely
   * busy is a task that will run without anybody being asked anything.
   */
  let standing = true
  /**
   * The same refusals, one per (worker, reason), with the *kind* of gate that fired.
   *
   * ⛔ Kept apart from `reasons` because a different reader wants them: the sentence is for the
   * operator's row, the kind is for the thread — *why did this task move off the account it was
   * on* is answered by finding the previous worker here, and matching it against prose that names
   * a window percentage would be a heuristic over a string this file also writes.
   */
  const refusals: WorkerRefusal[] = []
  function refuse(worker: Worker, kind: WorkerRefusal['kind'], why: string, isStanding = false): void {
    reasons.push(why)
    refusals.push({ workerId: worker.id, kind, why })
    if (!isStanding) standing = false
  }
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
  // ⚠️ Read once for the same reason `override` is: the credits stand-down below and the sentence
  // an operator reads when it does *not* apply both have to describe one settings snapshot.
  const switches = settings()
  const project = task.projectId ? getProject(task.projectId) : undefined
  const objective = resolveObjective(project?.config?.objective, task.objective, switches.objective)
  /**
   * Does this project refuse to run unattended work at full user authority?
   *
   * ⛔ Read once per decision, like every other project fact here, so every candidate in one field
   * is judged against the same snapshot. ⚠️ A task with no project cannot express the preference and
   * is not gated by it — there is no repository whose owner could have chosen.
   */
  const unattendedNeedsSandbox = project
    ? policyFor(project).unattendedAuthority === 'sandboxed-only'
    : false
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
    if (task.constraints.workerId) {
      if (task.constraints.workerId !== worker.id) continue
    } else if (task.constraints.workerIds && task.constraints.workerIds.length > 0) {
      if (!task.constraints.workerIds.includes(worker.id)) continue
    }
    if (task.constraints.adapterId && task.constraints.adapterId !== worker.adapterId) continue

    // ⛔ Role gate: an account that does not do work is not offered work. `controller` is reserved
    // for judgment/consults; `none` is held out of both, on purpose, while staying commissioned.
    if (!canWork(worker.role)) {
      // ⚠️ Standing: a role is a setting on the account, and no tick changes one.
      refuse(
        worker,
        'account',
        worker.role === 'none'
          ? `${worker.label} is held out of both work and judgment`
          : `${worker.label} is controller only`,
        true
      )
      continue
    }

    // ⛔ Every way an *account* can be unfit to be handed a turn, in one shared list: disabled,
    // human-occupied, no CLI installed, checkably signed out, or held out by a run that produced
    // nothing. These used to be written out here and half-written in the controller, which is how
    // an account this loop had already quarantined stayed eligible for judgment calls. Anything
    // that has to know *what is being asked* stays below, where the task is in scope.
    const unfit = accountRefusal(worker)
    if (unfit) {
      refuse(worker, 'account', unfit.why, unfit.standing)
      continue
    }

    const info = adapter(worker.adapterId).info
    const needs = task.constraints.needs ?? []
    const missing = needs.filter(
      (need) => (info.capabilities as unknown as Record<string, unknown>)[need] !== true
    )
    if (missing.length) {
      // ⚠️ Standing: an adapter does not grow a capability while a task waits for it.
      refuse(worker, 'account', `${worker.label} lacks ${missing.join(', ')}`, true)
      continue
    }

    /**
     * ⛔ **The project's containment choice, enforced as a refusal rather than as a downgrade.**
     * A project set to `sandboxed-only` will not hand unattended work to an adapter that runs with
     * the operator's full authority — and the honest outcome is that the task *holds*, visibly,
     * with this sentence on its row. Running it on that adapter "but sandboxed" is the other
     * option, and it is the t250 stall: a headless CLI that cannot ask turns every command into a
     * denial and burns a window discovering it.
     *
     * ⚠️ Standing, because an adapter does not acquire a sandbox while a task waits — a person
     * either changes the project setting or signs in an account that has one. The refusal names the
     * setting, because the task is unrunnable until somebody decides one way or the other.
     *
     * ⛔ Asks `headlessAuthority`, never an adapter name. A project names a property it needs; which
     * adapters have it is theirs to declare.
     */
    if (unattendedNeedsSandbox && info.policy.headlessAuthority !== 'sandboxed') {
      refuse(
        worker,
        'account',
        `${worker.label} runs unattended work with full user authority, and this project is set to ` +
          'sandboxed adapters only',
        true
      )
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
      refuse(worker, 'capacity', `${worker.label} at capacity`)
      continue
    }

    const resumable = reuse ? null : reopenableFor(task, worker.id)
    const held = reuse ?? resumable

    // Determine candidate models for this worker:
    // ⛔ A task that pinned a model gets exactly one pair.
    // ⛔ An explicit inherit policy takes the account's own default and routes nothing else.
    // ⛔ A live warm conversation pins the model (its process is already running it).
    // ⛔ A reopenable conversation preserves its model when no explicit policy is given.
    let candidateModels: Array<string | null>
    if (task.constraints.model) {
      candidateModels = [task.constraints.model]
    } else if (task.constraints.modelsByWorker && task.constraints.modelsByWorker[worker.id]) {
      candidateModels = [task.constraints.modelsByWorker[worker.id]!]
    } else if (task.constraints.modelPolicy === 'inherit') {
      // ⛔ The account's own default, and nothing scored against it. A task filed this way asked for
      // the model the account uses, which is a different answer from *any of the models it may be
      // routed to* the moment somebody widens the worker's allowlist.
      candidateModels = inheritedModelFor(worker)
    } else if (reuse?.model) {
      // A live conversation is served by the process already running it: the model was fixed at spawn
      // and dispatchIntoWarmSession cannot change it.
      candidateModels = [reuse.model]
    } else if (task.constraints.modelPolicy === 'auto') {
      candidateModels = routableModelsFor(worker)
    } else if (held?.model) {
      // For tasks with no explicit model or policy, preserve conversational continuity on resume.
      candidateModels = [held.model]
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
    /**
     * Is this account billing past its plan limit right now, with the operator's say-so?
     *
     * ⭐ **The half of "spend credits past the plan limit" that was missing, and the whole of t282.**
     * The switch stood the three *mid-run* guards down — compaction, the window boundary, the
     * overrun preempt — and did nothing at all at the *start* of a run. So a task filed against a
     * 7d window at 100% was refused by the dispatch gate; turning the switch on changed no answer
     * the gate gave, and neither did stopping and resuming by hand. The task waited for a window
     * reset it had been given permission to spend straight past.
     *
     * ⛔ Per worker, never per fleet: it is `spendingCreditsOn`'s two conditions, and the vendor's
     * word is about *this* account.
     */
    const onCredits = spendingCreditsOn(worker, switches.spendCreditsPastLimit)
    for (const model of candidateModels) {
      let trustedWindows: QuotaWindow[] = []
      if (quota && quota.windows.length > 0) {
        const pool = poolFor(worker, model)
        const verdict = poolVerdict(windowsForPool(quota.windows, pool))
        if (verdict.turnedOver) quotaUnverified = true
        // ⛔ **Only a reading this fleet trusts may *score*.** `trustedWindows` feeds `quotaRisk`,
        // which is a preference over how much room an account has left — and a percentage nobody
        // re-read is not evidence of room. It is, however, still evidence of *no* room, which is
        // why the refusal below reads `verdict` rather than this list.
        if (quota.stale) quotaUnverified = true
        else trustedWindows = verdict.active

        if (verdict.blocking) {
          const win = verdict.blocking.window
          const gate = verdict.blocking.threshold
          const modelSuffix = namesModel ? ` (${model ?? 'default'})` : ''
          const label = win.label ?? '5h'
          // ⛔ **An override buys a turn the vendor would have served, and nothing else.** At 100%
          // there is no such turn: t276 was dispatched to CodexFirst on a 7d window the vendor had
          // already emptied and came back `paused_quota` five seconds later, having bought a
          // process, a cold start and a preempted run. See `WINDOW_EXHAUSTED`.
          if (onCredits) {
            // ⛔ **Including at 100%, and that is the point.** The exhaustion rule below exists
            // because an ordinary account at 100% has no turn to buy — the vendor refuses it. An
            // account spending usage credits does have one: the plan limit is precisely where the
            // credits start being what pays, so a full window is a bill rather than a refusal. This
            // is the same stand-down the three mid-run guards already make (`noteCreditsStandDown`),
            // applied at the moment a run *starts* instead of only once it is under way.
            log.info(
              `t${task.seq} dispatching to ${worker.label}${modelSuffix} at ${Math.round(win.percent)}% of its ` +
                `${label} window — "spend credits past the plan limit" is on and the account reports credits enabled`
            )
          } else if (override && !verdict.blocking.exhausted) {
            log.info(
              `t${task.seq} dispatching to ${worker.label}${modelSuffix} at ${Math.round(win.percent)}% of its ` +
                `${label} window — a person overrode the ${gate}% gate`
            )
          } else {
            // ⭐ **A reading too old to score is not too old to refuse, and this is the whole of
            // t277.** Spend inside a window only ever goes up until the window resets, and the
            // sample carries the `resetsAt` of the window instance it measured — so an unexpired
            // window read as full *is* full, however many minutes ago somebody read it. The gate
            // used to skip itself entirely on `quota.stale`, and at 20:33:59Z on 2026-09-07 a
            // reading of CodexFirst's GPT 7d window at 100% crossed fifteen minutes old and the
            // account went from refused, with that percentage on the row, to silently routable.
            const staleness = quota.stale
              ? ` (read ${Math.max(1, Math.round(quota.ageMs / 60_000))}m ago; a window that has not reset cannot have refilled)`
              : ''
            const spent = verdict.blocking.exhausted && override ? ', which no override can buy a turn on' : ''
            refuse(
              worker,
              'quota',
              `${worker.label}${modelSuffix} at ${Math.round(win.percent)}% of its ${label} window${spent}` +
                `${staleness}${whyCreditsDidNotLift(worker, switches.spendCreditsPastLimit)}`
            )
            const resetsAt = win.resetsAt ?? windowResetsAt(worker.id)?.at ?? null
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
      refusals,
      quotaUnverified,
      score: 0,
      holdUntil: quotaHoldUntil,
      // ⛔ **An empty field is standing too.** `no eligible worker` is what a task pinned to a
      // retired account, or one naming an adapter this fleet has none of, comes back with — every
      // worker was filtered out before it could refuse — and waiting changes that least of all.
      standing: reasons.length === 0 || standing
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
      // would price a choice nobody is making. `cacheWarmth`, `cold`, `quotaRisk` and `projectSwitch`
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
    refusals,
    // ⚠️ Eight, not four. The consult shortlist is four because a controller reading more than that
    // is paying for prose it will not use; a person auditing a decision months later wants the field.
    scored: candidates.slice(0, 8).map((c) => ({
      workerId: (c.worker as Worker).id,
      label: (c.worker as Worker).label,
      adapterId: (c.worker as Worker).adapterId,
      model: c.model ?? null,
      // ⛔ Live *or* reopenable, matching `held` in `scoreCandidate` and the `warm` this row's own
      // `affinity`/`cold` terms were computed from. See the shortlist below.
      warm: !!(c.session ?? c.resumable),
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
      addMessage(task.id, 'system', `Exploring ${res.choice.model ?? 'default'} on ${res.choice.worker?.label}`, null, [], {
        detail: `Model exploration: trying ${res.choice.model ?? 'default'} on ${res.choice.worker?.label} instead of ${res.originalWinner?.model ?? 'default'}, which arithmetic scored highest.`
      })
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
  // ⚠️ A debate is as pinned as a plan: its organizer is a named account and model, so there is
  // nothing for a routing consult to decide and it would spend a controller turn saying so.
  if (eligibleWorkerCount <= 1 || task.kind === 'plan' || task.kind === 'debate') {
    return finalizeChoice(decided(best, isPinned ? 'pinned' : 'score'))
  }
  // ⚠️ For the *best* candidate, not the fleet. The floor asks "is this task big enough to be worth
  // a controller turn", and on an agent whose runs cost 12x the fleet median the same work clears a
  // floor it would not clear elsewhere — which is the honest answer to the question being asked.
  const estimate = cachedEstimate(
    best.worker?.adapterId ?? null,
    best.model ?? best.session?.model ?? null,
    // ⚠️ `session ?? resumable`, as everywhere else: a task whose own conversation is on disk is
    // priced for the reopen the dispatch is about to do, not for a cold start nobody will pay for.
    !!(best.session ?? best.resumable)
  ).tokens
  const tie = second !== undefined && Math.abs(best.score - second.score) <= ROUTE_EPSILON
  if (!tie || estimate < ROUTE_CONSULT_FLOOR_TOKENS) return finalizeChoice(decided(best, 'score'))

  const answered = latestAnswer('route', task.id, ROUTE_ANSWER_MAX_AGE_MS) as
    | { workerId?: string; model?: string; why?: string }
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
      if (picked) {
        return finalizeChoice({
          ...decided(picked, 'controller'),
          controllerWhy: typeof answered.why === 'string' ? answered.why.trim() : ''
        })
      }
    }
  }

  const tied = candidates.filter((c) => Math.abs(best.score - c.score) <= ROUTE_EPSILON)

  const winner = reuseTieBreak(tied)
  if (winner) {
    log.info(
      `t${task.seq}: tie within ε broken by reuse — ${winner.worker?.label} already holds this ` +
        `task's conversation${winner.session ? '' : ' (closed, reopenable)'}, so no consult is spent`
    )
    return finalizeChoice(decided(winner, 'reuse'))
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
    // ⛔ `session ?? resumable`, the same `held` every term in `scoreCandidate` reads. Read from
    // `session` alone, this line called a candidate whose own conversation was sitting on disk a
    // "cold start" while the table under it showed `affinity 1 · cold 0` — the controller was being
    // asked to choose between a description and the arithmetic.
    warm: !!(c.session ?? c.resumable),
    reuse: c.session ? 'live' : c.resumable ? 'reopen' : null,
    // ⛔ Priced from where this candidate starts. `cachedEstimate` is memoised per
    // (adapter, model, warm), so this is the same object the `price` term was built from.
    estimate: cachedEstimate(
      c.worker?.adapterId ?? null,
      c.model ?? c.session?.model ?? null,
      !!(c.session ?? c.resumable)
    ),
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
  highWater = WINDOW_HIGH_WATER,
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
 * "add X, test X, document X" lands on one session because `cacheWarmth` and `contextHeld` both peak
 * there, and
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

/**
 * The direction each weight pushes — `WEIGHT_SIGNS` in `@shared/routing.ts`, the one table the
 * Routing Model page prints and this sum uses. ⛔ Must match the signs used in `scoreCandidate`.
 */
const SIGN_OF: Record<keyof ReturnType<typeof weights>, 1 | -1> = WEIGHT_SIGNS

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
  cacheWarmth: '1 = a full TTL of prompt cache left',
  contextHeld: '1 = a conversation already holds this task, live or reopenable',
  contextRot: '1 = the context window is full',
  projectSwitch: '1 = the session is on another project',
  quotaRisk: `1 = at ${WINDOW_HIGH_WATER}% of its window (adjusted for reset horizon; 0 below ${QUOTA_RISK_FLOOR}%)`,
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
 * The span the `cacheWarmth` term divides by: how long a full prompt cache lasts on this conversation's
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
  const contextHeld = held ? 1 : 0
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
    const r = windowRisk(win.percent, windowHighWater(win), QUOTA_RISK_FLOOR, win.resetsAt, now, win.id)
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
  // the turn would actually be served by — the same rule the `cacheWarmth` term follows when it reads
  // `held` rather than `worker`.
  const measuredPace = paceFor(pace, worker.adapterId, held?.model ?? paceModel)

  const everWorked = hasEverWorked(worker.id)
  const doubt = unproven(worker, everWorked)

  // ⛔ The order and the signs here ARE the formula. Anything added must be added here, or the
  // published derivation stops matching the number it claims to explain.
  return breakdownOf([
    [
      'cacheWarmth',
      w.cacheWarmth,
      WEIGHT_FORMULAS.cacheWarmth,
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
      'contextHeld',
      w.contextHeld,
      WEIGHT_FORMULAS.contextHeld,
      contextHeld,
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
  // ⭐ A trunk task asks the trunk, not the pool: a free worktree is no use to it, and a full pool
  // is no reason to hold it. Same three ways through — its own lease, a warm session, an evictable
  // resident — for the same reasons.
  if (resolveWorkspaceMode(task, project).mode === 'trunk') {
    const holder = openClaims(trunkResourceId(project.id))[0]
    if (!holder || holder.holder === task.id) return null
    if (warmSessionFor(task)) return null
    if (evictableResidents(project.id, 'trunk').length > 0) return null
    const owner = getTask(holder.holder)
    return `the trunk of ${project.name} is in use${owner ? ` by t${owner.seq}` : ''}`
  }
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
  if (evictableResidents(project.id, 'worktree').length > 0) return null

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
