import type { DebatePreview } from '@shared/protocol.js'
import type { DebateSeat, Task, TaskKind } from '@shared/tasks.js'
import { adapterSpread, ROOT_MANDATE } from '@shared/tasks.js'
import { estimateTask, type Confidence, type Estimate } from './estimator.js'
import { getWorker } from './workers.js'
import { getProject, policyFor } from './projects.js'

/**
 * What a debate would cost, before one exists.
 *
 * ⛔ **Pure arithmetic in its own module, with its own L1 tests, because the renderer does not
 * compute money.** Every figure here carries its basis and `usd` is `null` — never `$0.00` — where
 * nothing behind it could be priced, which is the rule `task.estimate` already keeps.
 *
 * ⚠️ It reuses `estimateTask` and the cost factors unchanged. The only new thing is that it accepts
 * a *description* of a task instead of a row, because the whole point of the cost notice is that it
 * appears before anything is filed.
 */

/** The confidence ladder, so two answers can be combined by taking the weaker. */
const RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 }
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b)

export interface DebatePreviewInput {
  title: string
  projectId?: string | null
  kind?: TaskKind
  seats?: DebateSeat[]
  rounds?: number
  organizerWorkerId?: string | null
  organizerModel?: string | null
}

/**
 * A task-shaped object that is **not** in the database and never will be.
 *
 * ⛔ `estimateTask` reads exactly three things off a task — `estTokens`, `projectId` and (through
 * `complexityOf`, where a caller asks for it) its id — so this is the smallest honest stand-in.
 * The synthetic id resolves to no attachments and no dependents, which is the truth about a task
 * nobody has filed.
 */
function draftTask(input: DebatePreviewInput): Task {
  return {
    id: `preview:${input.title.slice(0, 32)}`,
    seq: 0,
    projectId: input.projectId ?? null,
    title: input.title,
    titleSummary: null,
    kind: input.kind ?? 'debate',
    status: 'draft',
    priority: 'P2',
    createdBy: { kind: 'human' },
    parentTaskId: null,
    lineageDepth: 0,
    assignee: null,
    assigneeHint: null,
    mandate: ROOT_MANDATE,
    budget: { grantedTokens: 0, spentTokens: 0 },
    dependsOn: [],
    notBefore: null,
    deadline: null,
    requires: [],
    constraints: {},
    verification: 'auto',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    completionMode: 'inherit',
    objective: 'inherit',
    autoCompact: 'inherit',
    finishAskedAt: null,
    conflictAskedAt: null,
    resolveRetryAskedAt: null,
    preemptible: true,
    estTokens: null,
    cancel: null,
    handoffNote: null,
    holdReason: null,
    holdUntil: null,
    quotaOverrideUntil: null,
    quotaPreemptWarning: null,
    branch: null,
    branchUnit: 1,
    landingTarget: null,
    childDefaults: null,
    debate: null,
    landedBaseSha: null,
    landedHeadSha: null,
    qualityReviewId: null,
    qualityScore: null,
    qualityReviewCount: 0,
    qualityReviewedAt: null,
    qualityReviewer: null,
    qualityManualCount: 0,
    gradingWorkerId: null,
    excludedFromStats: false,
    nonGradable: false,
    firstRunAt: null,
    lastRunEndedAt: null,
    activeMs: 0,
    activeSince: null,
    ranOn: null,
    ranModel: null,
    deletedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * How many seats can actually be in flight at once.
 *
 * ⛔ **Said out loud, never silently corrected**, in the same voice `poolIsNarrow` uses for the
 * pool. `maxConcurrent` defaults to **1** per worker and a project's workspace pool defaults to
 * **3**, so on the commonest install — one account, default pool — a three-seat debate is three
 * serial runs. That is a fact about the fleet, not a bug to route around, and the composer states
 * it next to the seat count.
 */
export function parallelSeatsFor(seats: DebateSeat[], projectId: string | null | undefined): number {
  if (seats.length === 0) return 0
  const byWorker = new Map<string, number>()
  for (const seat of seats) {
    byWorker.set(seat.workerId, (byWorker.get(seat.workerId) ?? 0) + 1)
  }
  let slots = 0
  for (const [workerId, wanted] of byWorker) {
    const worker = getWorker(workerId)
    // ⚠️ An account this fleet does not know contributes one slot, not zero: the honest reading of
    // an unknown is *at least one*, and zero would report a debate that can never start.
    slots += Math.min(wanted, Math.max(1, worker?.maxConcurrent ?? 1))
  }
  const project = projectId ? getProject(projectId) : null
  const pool = project ? policyFor(project).poolSize : seats.length
  return Math.max(1, Math.min(seats.length, slots, pool))
}

/**
 * ⚠️ A single estimate for one turn on one (adapter, model). Absent worker means fleet-neutral,
 * which is what a roster entry naming an account this fleet has forgotten honestly deserves.
 */
function turnEstimate(task: Task, workerId: string | null | undefined, model: string | null | undefined): Estimate {
  const worker = workerId ? getWorker(workerId) : null
  return estimateTask(
    task,
    worker ? { adapterId: worker.adapterId, ...(model ? { model } : {}) } : undefined
  )
}

export function debatePreview(input: DebatePreviewInput): DebatePreview {
  const seats = input.seats ?? []
  const rounds = Math.max(1, Math.round(input.rounds ?? 1))
  const task = draftTask(input)

  // ⛔ Per seat, not one estimate multiplied: a heterogeneous roster is the whole point, and this
  // install measures an 81x spread between its two best-sampled (adapter, model) keys.
  const seatEstimates = seats.map((seat) => turnEstimate(task, seat.workerId, seat.model))
  const organizer = turnEstimate(task, input.organizerWorkerId, input.organizerModel)

  const seatTokensPerRound = seatEstimates.reduce((sum, e) => sum + e.tokens, 0)
  const totalTokens = seatTokensPerRound * rounds + organizer.tokens * rounds

  // ⛔ Money is `null` the moment *any* contributing estimate could not be priced. A partial sum
  // presented as a total is the `$0.00`-for-`n/a` mistake wearing a different hat.
  const priceable = [...seatEstimates, organizer].every((e) => e.usd !== null)
  const seatUsdPerRound = priceable ? seatEstimates.reduce((sum, e) => sum + (e.usd ?? 0), 0) : null
  const totalUsd =
    priceable && seatUsdPerRound !== null ? seatUsdPerRound * rounds + (organizer.usd ?? 0) * rounds : null

  // ⚠️ The headline the operator actually reads: how many times the same question asked *once* of
  // the organizer's own agent this debate is. Null where the baseline itself is unmeasured.
  const baseline = organizer.tokens
  const multiple = baseline > 0 ? totalTokens / baseline : null

  const confidence = [...seatEstimates, organizer].reduce<Confidence>(
    (acc, e) => weaker(acc, e.confidence),
    'high'
  )
  const usdConfidence = priceable
    ? [...seatEstimates, organizer].reduce<Confidence>((acc, e) => weaker(acc, e.usdConfidence), 'high')
    : 'none'

  const adapterIds = seats.map((seat) => getWorker(seat.workerId)?.adapterId ?? null)
  const parallelSeats = parallelSeatsFor(seats, input.projectId)

  return {
    perSeatTokens: seats.length > 0 ? Math.round(seatTokensPerRound / seats.length) : 0,
    perSeatUsd: seatUsdPerRound !== null && seats.length > 0 ? seatUsdPerRound / seats.length : null,
    totalTokens: Math.round(totalTokens),
    totalUsd,
    multiple,
    usdConfidence,
    confidence,
    basis:
      `${seats.length} seat(s) × ${rounds} round(s) plus ${rounds} organizer turn(s), each estimated ` +
      `on its own account and model. Seat 1's basis: ${seatEstimates[0]?.basis ?? 'no seats named'}. ` +
      `The multiple is against the same question asked once of the organizer's own agent.`,
    assumed: [...seatEstimates, organizer].some((e) => e.assumed),
    adapterSpread: adapterSpread(adapterIds),
    parallelSeats,
    seatCount: seats.length
  }
}
