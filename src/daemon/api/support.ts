/** The RPC types, the request context, and the validators every domain shares. */
import type { RpcMethod, RpcParams, RpcResult, Worker } from '@shared/protocol.js'
import { canWork } from '@shared/protocol.js'
import type { ChildDefaults, Task, TaskConstraints } from '@shared/tasks.js'
import { windowsForPool } from '@shared/tasks.js'
import { adapter } from '../adapters/index.js'
import { listWorkers, requireWorker, modelRoutingActive, routableModelsFor } from '../workers.js'
import { accountUnavailability } from '../eligibility.js'
import { dispatchCountsByPair } from '../routingdecisions.js'
import type { ModelReport, ModelReportRow, VelocityReport } from '@shared/routing.js'
import { paceFactors, paceFor, paceValue } from '../pace.js'
import { qualityReport } from '../quality.js'
import { weights, WEIGHT_FORMULAS } from '../objective.js'
import { lastQuota } from '../quota.js'
import { benchmarkPrior } from '../benchmarks.js'
import { fitnessFor } from '../fitness.js'
import { sessionsForWorker } from '../sessions.js'
import { costModel } from '../costmodel.js'
import { addMessage, getTask, promoteDraft, requireTask, setStatus, updateTask } from '../tasks.js'
import { enqueueConsult } from '../controller.js'
import { gateQuestion, riskOf } from '../judgment.js'
import { estimateTask } from '../estimator.js'
import { DEFAULT_OBJECTIVE } from '../objective.js'
import { settings } from '../settings.js'

export type Handler<M extends RpcMethod> = (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>
export type Api = { [M in RpcMethod]: Handler<M> }

/**
 * The prerequisites of a task, as rows rather than ids, with deleted ones dropped.
 *
 * ⚠️ Shared by `task.get` and the two edge methods so the pane redraws from exactly what the detail
 * fetch would have given it. A list assembled twice is a list that disagrees with itself.
 */
export function dependenciesFor(taskId: string): Task[] {
  const task = getTask(taskId)
  if (!task) return []
  return (task.dependsOn || [])
    .map((id) => getTask(id))
    .filter((t): t is Task => !!t && t.deletedAt === null)
}

/** "26825 minutes" is technically true and useless. Say it the way a person would. */
export function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

/**
 * Decide what happens to a task an agent just filed.
 *
 * ⛔ The rule-based assessment is what runs on every filing, and it is free. Only what it returns as
 * `controller` costs a turn - the point of a gate is to contain task explosion, not to add a turn to
 * every instance of it. Plan §7.2.
 */
export function admitAgentTask(taskId: string): void {
  const task = requireTask(taskId)
  const risk = riskOf(task)

  if (risk.gate === 'auto') {
    addMessage(task.id, 'system', `Admitted automatically: ${risk.why}.`)
    promoteDraft(task.id)
    return
  }
  if (risk.gate === 'human') {
    addMessage(task.id, 'system', `Held for you: ${risk.why}.`)
    updateTask(task.id, { assigneeHint: 'human' })
    setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `an agent filed this and it needs your decision: ${risk.why}`
    })
    return
  }

  addMessage(task.id, 'system', `Held for the controller to review: ${risk.why}.`)
  // ⚠️ It stays a draft while the question is open. A draft dispatches nothing and holds nothing, so
  // the cost of waiting - including waiting forever, if there is no controller - is only time.
  enqueueConsult({ kind: 'gate', subjectId: task.id, question: gateQuestion(task, risk.why) })
}

export interface ApiContext {
  version: string
  startedAt: number
  port: number
}

/**
 * Is this account's default model — and effort, where it has one — something its CLI could run?
 *
 * ⚠️ `null` is always allowed and never checked: it means "let the CLI pick", which is the state
 * every worker ships in and the one the operator returns to by clearing the box.
 */
export function checkWorkerDefaults(
  adapterId: string,
  patch: {
    defaultModel?: string | null
    gradingModel?: string | null
    defaultEffort?: string | null
    defaultModels?: Record<string, string | null> | null
    routableModels?: string[] | null
  }
): void {
  const info = adapter(adapterId).info
  const cm = costModel(info.policy.costModelId)

  if (patch.defaultModel) {
    if (!cm.modelSpec(patch.defaultModel)) {
      throw new Error(`'${patch.defaultModel}' is not a model ${info.label} can be priced for`)
    }
  }

  if (patch.gradingModel && !cm.modelSpec(patch.gradingModel)) {
    throw new Error(`'${patch.gradingModel}' is not a model ${info.label} can be priced for`)
  }

  if (patch.defaultModels) {
    for (const [pool, m] of Object.entries(patch.defaultModels)) {
      if (m) {
        const spec = cm.modelSpec(m)
        if (!spec) {
          throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
        }
        const matchesPool =
          spec.pool === pool ||
          (pool === 'claude' && (spec.pool === 'claude' || spec.pool === 'gpt'))
        if (spec.pool && !matchesPool) {
          throw new Error(`'${m}' does not belong to pool '${pool}'`)
        }
      }
    }
  }

  if (patch.routableModels) {
    for (const m of patch.routableModels) {
      // ⛔ The same rule `'model.options'` documents: a model that can be chosen is one that can be
      // priced, gated and estimated for. An allowlist entry the cost model does not declare is
      // refused on write, never stored — the ladder in `routableModelsFor` and part 2's scorer both
      // trust that everything in this column is legal.
      if (!cm.modelSpec(m)) {
        throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
      }
    }
  }

  if (patch.defaultEffort) {
    if (!info.capabilities.selectableEffort) {
      // ⛔ Not "ignored" — measured 2026-08-29, agy *refuses* the flag and the dispatch fails
      // outright, so accepting an effort here would store a value that breaks every run.
      throw new Error(`${info.label} takes no effort flag, so it has no default effort to set`)
    }
    // The effort has to be legal for the model it will be sent with, and that is the default model
    // unless a task overrides both. ⚠️ Checked against the *stored* model only when one is set here;
    // a task that pins a different model is checked again by `checkConstraints` on its own way in.
    const spec = patch.defaultModel ? cm.modelSpec(patch.defaultModel) : null
    if (spec && !spec.effort_levels.includes(patch.defaultEffort)) {
      throw new Error(`'${patch.defaultModel}' has no effort level '${patch.defaultEffort}'`)
    }
  }
}

/**
 * Every model this task could actually be dispatched on when it pins none of its own.
 *
 * ⚠️ Plural on purpose. A multi-pool account holds one default per pool and the scheduler picks
 * between them at dispatch on live quota, so an effort level has to be legal for *all* of them —
 * validating only the one that happens to win today would let the other pool fail at dispatch.
 */
export function inheritedModels(worker: Worker | null): string[] {
  if (!worker) return []
  const models = Object.values(worker.defaultModels ?? {}).filter(
    (m): m is string => typeof m === 'string' && m.trim() !== ''
  )
  if (worker.defaultModel) models.push(worker.defaultModel)
  return [...new Set(models)]
}

/**
 * Validate the accounts and models a plan's pieces are to be filed with.
 *
 * ⛔ Through `checkConstraints`, never a second copy of the same rules. The Pieces row carries the
 * same three questions the task's own row does — which account, which model, which effort — and two
 * validators for one question is how they drift.
 */
export function checkedChildAccounts(defaults: ChildDefaults): Partial<ChildDefaults> {
  const checked = checkConstraints({
    ...(defaults.workerIds?.length ? { workerIds: defaults.workerIds } : {}),
    ...(defaults.modelsByWorker ? { modelsByWorker: defaults.modelsByWorker } : {}),
    ...(defaults.effortsByWorker ? { effortsByWorker: defaults.effortsByWorker } : {})
  })
  return {
    ...(checked.workerIds ? { workerIds: checked.workerIds } : {}),
    ...(checked.modelsByWorker ? { modelsByWorker: checked.modelsByWorker } : {}),
    ...(checked.effortsByWorker ? { effortsByWorker: checked.effortsByWorker } : {})
  }
}

/**
 * Reject a constraint that names something that does not exist, here, at the door.
 *
 * ⛔ Admission is the only cheap place to say no. A bad worker id makes a task that no candidate loop
 * can ever match and that sits in `ready` looking like a scheduling problem; a model the cost model
 * cannot price is one agentyard cannot gate, estimate for or reason about the context window of, and
 * it would surface minutes later as a CLI argument error charged to a real window. `knownModels` in
 * judgment.ts refuses an unpriceable model from the *controller* for exactly these reasons - a person
 * filing a task deserves the same door.
 *
 * ⚠️ The adapter is derived from the pinned worker rather than taken on trust. Two fields that can
 * disagree about which CLI will run this are two fields that will eventually disagree.
 */
export function checkConstraints(c: TaskConstraints): TaskConstraints {
  const checked: TaskConstraints = { ...c }

  if (c.workerIds) {
    for (const id of c.workerIds) {
      const w = requireWorker(id)
      if (!canWork(w.role)) {
        throw new Error(`${w.label} has role '${w.role}' and cannot be assigned to work tasks`)
      }
    }
  }

  if (c.modelsByWorker) {
    for (const [wId, model] of Object.entries(c.modelsByWorker)) {
      if (!model) continue
      const w = requireWorker(wId)
      const info = adapter(w.adapterId).info
      const cm = costModel(info.policy.costModelId)
      const spec = cm.modelSpec(model)
      if (!spec) {
        throw new Error(`'${model}' is not a model ${info.label} can be priced for`)
      }
    }
  }

  if (c.effortsByWorker) {
    for (const [wId, effort] of Object.entries(c.effortsByWorker)) {
      if (!effort) continue
      const w = requireWorker(wId)
      const info = adapter(w.adapterId).info
      if (!info.capabilities.selectableEffort) {
        throw new Error(`${info.label} takes no effort flag — effort is set inside the session`)
      }
      const cm = costModel(info.policy.costModelId)
      const model = c.modelsByWorker?.[wId]
      if (model) {
        const spec = cm.modelSpec(model)
        if (spec && !spec.effort_levels.includes(effort)) {
          throw new Error(`'${model}' has no effort level '${effort}'`)
        }
      }
    }
  }

  if (c.pieceConstraints) {
    checked.pieceConstraints = checkConstraints(c.pieceConstraints)
  }

  let worker: Worker | null = null
  if (c.workerId) {
    worker = requireWorker(c.workerId)
    if (!canWork(worker.role)) {
      throw new Error(`${worker.label} has role '${worker.role}' and cannot be assigned to work tasks`)
    }
    checked.adapterId = worker.adapterId
  }

  const adapterId = checked.adapterId
  if (c.model || c.effort) {
    if (!adapterId) {
      // Nothing pins the adapter, so nothing can price the model. ⛔ Dropped rather than guessed:
      // picking a default adapter here would let a model chosen for one CLI be passed to another.
      throw new Error('choose a worker before choosing a model — the model list belongs to its CLI')
    }
    const info = adapter(adapterId).info
    const cm = costModel(info.policy.costModelId)

    if (c.effort && !info.capabilities.selectableEffort) {
      throw new Error(`${info.label} takes no effort flag — effort is set inside the session`)
    }

    if (c.model) {
      const spec = cm.modelSpec(c.model)
      if (!spec) {
        throw new Error(`'${c.model}' is not a model ${info.label} can be priced for`)
      }
      if (c.effort && !spec.effort_levels.includes(c.effort)) {
        throw new Error(`'${c.model}' has no effort level '${c.effort}'`)
      }
    } else if (c.effort) {
      // ⭐ Leaving the model on *inherit* is not leaving it unanswered. `resolveModelChoice` falls to
      // the account's own default, which is the model the New Task form names in the inherit option
      // and offers these very effort levels for — so the level is checked against that model rather
      // than refused for naming none. Refusing here made "the usual model, but think harder"
      // unfileable, which is the one combination the resolver exists to support.
      const inherited = inheritedModels(worker)
      if (inherited.length === 0) {
        // Nothing here or on the account names a model, so the CLI picks one at dispatch and no
        // level can be checked against it. ⛔ Still refused: an unverifiable effort flag fails the
        // whole run later rather than this call now.
        throw new Error('an effort level means nothing without a model to apply it to')
      }
      for (const m of inherited) {
        const spec = cm.modelSpec(m)
        if (!spec) {
          throw new Error(`'${m}' is not a model ${info.label} can be priced for`)
        }
        if (!spec.effort_levels.includes(c.effort)) {
          throw new Error(`'${m}' has no effort level '${c.effort}'`)
        }
      }
    }
  }

  return checked
}

/**
 * Who can take work right now, and how fast each account has been measured to work.
 *
 * ⛔ **The two halves are read from the two places that own them**, never re-derived here:
 * availability from `accountUnavailability` — the one shared list of account gates, which work and
 * judgment both read — and pace from `pace.ts`, which is what the `pace` scoring term reads. A third
 * copy of either would be a third answer to a question the scheduler has already answered.
 *
 * ⚠️ Capacity is reported rather than folded into `unavailable`: a worker at its concurrency limit is
 * busy, not unfit, and the two look identical in a single boolean.
 */
export function velocityReport(): VelocityReport {
  const objective = settings().objective ?? DEFAULT_OBJECTIVE
  const factors = paceFactors()
  const w = weights(objective)
  return {
    generatedAt: Date.now(),
    objective,
    paceWeight: w.pace,
    paceFormula: WEIGHT_FORMULAS.pace,
    neutralActiveMs: factors.neutralActiveMs,
    samples: factors.samples,
    workers: listWorkers()
      .filter((worker) => !worker.retiredAt)
      .map((worker) => {
        const measured = paceFor(factors, worker.adapterId, worker.defaultModel)
        const quota = lastQuota(worker.id)
        // ⚠️ The *tightest* applicable window, not the 5h one by name: an account can be fine on its
        // five hours and nearly out of its week, and routing is held by whichever bites first.
        const window =
          quota && !quota.stale
            ? [...quota.windows].sort((a, b) => b.percent - a.percent)[0] ?? null
            : null
        return {
          workerId: worker.id,
          label: worker.label,
          adapterId: worker.adapterId,
          medianActiveMs: measured.medianActiveMs,
          samples: measured.samples,
          factor: measured.factor,
          value: paceValue(measured.factor),
          basis: measured.basis,
          running: sessionsForWorker(worker.id).filter((session) => session.purpose === 'work').length,
          maxConcurrent: worker.maxConcurrent,
          unavailable: accountUnavailability(worker),
          windowPercent: window ? window.percent : null,
          windowLabel: window ? (window.label ?? window.id) : null
        }
      })
  }
}

/**
 * Every (worker, model) pair the fleet could route to, and what fed its `fitness` and `price` terms.
 *
 * ⛔ **Every priced model on every commissioned worker, not only its allowlist.** `routable` is what
 * tells the two apart: an operator deciding whether to *add* a model needs to see its prior and its
 * fitness before it has ever run a task, which is exactly the row an allowlist-only report would omit.
 *
 * ⚠️ `costUsd` is `estimateTask` on a fleet-neutral pseudo-task — `{ estTokens: null, projectId:
 * null }` — the same object shape `overrunFactor` (`estimator.ts`) builds when it has a real task's
 * numbers and nothing else. It answers "what would an average task cost on this pair", never "what
 * would *this* task cost", because there is no task in a table of pairs.
 */
export function modelReport(): ModelReport {
  const objective = settings().objective ?? DEFAULT_OBJECTIVE
  const w = weights(objective)
  const pace = paceFactors()
  const dispatchCounts = dispatchCountsByPair()
  // ⛔ One quality report for the whole table. This loop runs every priced model on every
  // commissioned worker — a hundred-odd rows on a mixed fleet — and `fitnessFor` would otherwise
  // reload the reviews table for each. See its `keys` parameter.
  const qualityKeys = qualityReport().keys
  const rows: ModelReportRow[] = []

  for (const worker of listWorkers()) {
    if (worker.retiredAt) continue
    let ids: string[]
    let cm: ReturnType<typeof costModel>
    try {
      cm = costModel(adapter(worker.adapterId).info.policy.costModelId)
      ids = cm.modelIds()
    } catch {
      continue
    }
    const routable = new Set(routableModelsFor(worker).filter((m): m is string => m !== null))
    const quota = lastQuota(worker.id)

    for (const model of ids) {
      const prior = benchmarkPrior(model)
      const fit = fitnessFor(worker.adapterId, model, qualityKeys)
      const estimate = estimateTask({ estTokens: null, projectId: null } as Task, {
        adapterId: worker.adapterId,
        model
      })
      const paced = paceFor(pace, worker.adapterId, model)
      const pool = cm.modelSpec(model)?.pool ?? null
      const windows = quota && !quota.stale ? windowsForPool(quota.windows, pool) : []
      const worst = windows.reduce<(typeof windows)[number] | null>(
        (max, win) => (!max || win.percent > max.percent ? win : max),
        null
      )
      const counts = dispatchCounts.get(`${worker.id}:${model}`)

      rows.push({
        workerId: worker.id,
        label: worker.label,
        adapterId: worker.adapterId,
        model,
        routable: routable.has(model),
        prior: prior.agentic,
        priorBasis: prior.basis,
        priorSource: prior.source,
        cleanComposite: fit.measured === null ? null : fit.measured * 10,
        cleanSamples: fit.samples,
        fitness: fit.value,
        fitnessBasis: fit.basis,
        costUsd: estimate.usd,
        costConfidence: estimate.usdConfidence,
        paceFactor: paced.samples > 0 ? paced.factor : null,
        paceSamples: paced.samples,
        pool,
        poolPercent: worst ? worst.percent : null,
        dispatches: counts?.dispatches ?? 0,
        explorations: counts?.explorations ?? 0
      })
    }
  }

  return {
    generatedAt: Date.now(),
    objective,
    active: modelRoutingActive(),
    fitnessWeight: w.fitness,
    fitnessFormula: WEIGHT_FORMULAS.fitness,
    priceWeight: w.price,
    priceFormula: WEIGHT_FORMULAS.price,
    rows
  }
}
