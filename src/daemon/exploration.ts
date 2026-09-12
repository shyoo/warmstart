import type { Task } from '@shared/tasks.js'
import type { WorkerChoice } from './scheduler.js'
import type { Complexity } from './complexity.js'
import { fitnessFor } from './fitness.js'
import { qualityReport } from './quality.js'

/**
 * Model exploration: break the feedback loop in model-aware routing.
 *
 * ⛔ **Off by default, and opted into.**
 * The scheduler deliberately dispatches work to a model the arithmetic did not choose: a real cost
 * paid for information, on the same principle as `autoRunawayStop` and `summariseTitles`.
 *
 * Scoring can starve itself: `fitness` scores 0 for a pair with no prior and no clean review;
 * `price` and `pace` learn only from runs that happened. So today's winner earns the samples that
 * make it win tomorrow, and a model that never wins is never measured — which looks like evidence
 * and is only silence.
 *
 * ε-greedy rule:
 * - With probability `modelExplorationRate`, swap the winner with a random other model on the SAME worker.
 * - Same worker, never a different account: swapping accounts would change quota pool, cache, capabilities.
 * - Never fire when:
 *   1. Flag is off (`modelExploration: false`)
 *   2. Task pinned a model (`task.constraints.model` or `constraints.modelsByWorker`)
 *   3. Winner is warm, reopenable or sticky (switching models drops context, costing more than the sample)
 *   4. `task.kind` is `plan` or `debate`
 *   5. Task complexity band is `high` (experiment on cheap work, not the task that matters)
 *   6. Worker offers only 1 routable model
 * - Prefer an alternative whose fitness is unmeasured (`fitnessFor().value === null`), falling back to uniform.
 */

export interface ExploreOptions {
  task: Task
  winner: WorkerChoice
  candidates: WorkerChoice[]
  complexity: Complexity
  settings: {
    modelExploration: boolean
    modelExplorationRate: number
  }
  random?: () => number
}

export interface ExploreResult {
  choice: WorkerChoice
  explored: boolean
  originalWinner?: WorkerChoice
}

export function exploreRoute(options: ExploreOptions): ExploreResult {
  const { task, winner, candidates, complexity, settings, random = Math.random } = options

  if (!settings.modelExploration) {
    return { choice: winner, explored: false }
  }

  if (!winner.worker) {
    return { choice: winner, explored: false }
  }

  // ⛔ Task pinned a model: pins are mandates, never preferences.
  const workerId = winner.worker.id
  if (
    task.constraints?.model ||
    (task.constraints?.modelsByWorker && task.constraints.modelsByWorker[workerId])
  ) {
    return { choice: winner, explored: false }
  }

  // ⛔ Winner is warm, reopenable, or sticky: switching model throws away conversation context.
  if (
    Boolean(winner.session) ||
    Boolean((winner as { resumable?: unknown }).resumable) ||
    winner.routedBy === 'sticky'
  ) {
    return { choice: winner, explored: false }
  }

  // ⛔ Plan and debate tasks are not experimental work. ⚠️ A debate **seat** needs no clause here:
  // its model is the operator's roster, pinned through `task.constraints.model`, and a pinned model
  // already refuses exploration above. Swapping one would silently make a heterogeneous debate
  // homogeneous — the one substitution this feature cannot survive.
  if (task.kind === 'plan' || task.kind === 'debate') {
    return { choice: winner, explored: false }
  }

  // ⛔ High complexity tasks: experiment on cheap work, not on what matters most.
  if (complexity.band === 'high') {
    return { choice: winner, explored: false }
  }

  // Same worker only: find alternative routable models scored in the field.
  const alternatives = candidates.filter(
    (c) => c.worker?.id === workerId && c.model !== winner.model
  )
  if (alternatives.length === 0) {
    return { choice: winner, explored: false }
  }

  const rate = settings.modelExplorationRate
  if (rate <= 0) {
    return { choice: winner, explored: false }
  }

  // Roll ε-greedy threshold
  const roll = random()
  if (roll >= rate) {
    return { choice: winner, explored: false }
  }

  // Prefer unmeasured fitness model over measured ones.
  // ⛔ One quality report for the whole filter, not one per alternative — see `fitnessFor`'s `keys`.
  // ⚠️ Read only after the ε roll has passed, so a fleet with exploration on but a rate that rarely
  // fires pays for this on the ticks that explore rather than on every tick.
  const keys = qualityReport().keys
  const unmeasured = alternatives.filter(
    (c) => fitnessFor(winner.worker!.adapterId, c.model ?? null, keys).value === null
  )
  const pool = unmeasured.length > 0 ? unmeasured : alternatives
  const pickIndex = pool.length === 1 ? 0 : Math.floor(random() * pool.length)
  const picked = pool[pickIndex]
  if (!picked) {
    return { choice: winner, explored: false }
  }

  // Update chosen candidate in ranked field ledger
  const updatedScored = winner.scored?.map((sc) => ({
    ...sc,
    chosen: sc.workerId === picked.worker?.id && (sc.model ?? null) === (picked.model ?? null)
  }))

  const choice: WorkerChoice = {
    ...picked,
    worker: picked.worker ?? null,
    objective: winner.objective,
    routedBy: 'explore',
    scored: updatedScored
  }

  return {
    choice,
    explored: true,
    originalWinner: winner
  }
}
