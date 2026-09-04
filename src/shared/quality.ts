import type { RubricDimension } from './review.js'

/**
 * The aggregate view of peer quality review — what the fleet has measured about each agent.
 *
 * ⛔ **Nothing gates on any of it.** The same sentence `@shared/review.ts` opens with, and it stays
 * true here: no routing decision reads a composite, no task changes status because of one, and the
 * estimator never sees a review run. Aggregating an instrument does not turn it into a control.
 *
 * ⚠️ Shared because the Analytics UI renders the rubric's own weights and labels beside the numbers,
 * and a second copy of them in the renderer is a second thing to keep in step with the daemon.
 */

/** One (agent, model) key's measured quality. */
export interface QualityKey {
  adapterId: string
  /** Null is the adapter-wide rung: work whose model was never recorded. */
  model: string | null
  /** Every complete, scored review of this key's work. */
  samples: number
  /**
   * The subset that is clean evidence: single-author, and blinded without a leak.
   *
   * ⛔ The number to compare agents on. A review of a task two adapters both worked on is not
   * evidence about either, and one whose blinding left a vendor name in the prose was not blind.
   */
  clean: number
  mixedAuthorship: number
  blindingLeaks: number
  /** Mean composite over `samples`. Null when nothing scored. ⚠️ Never 0 for "unknown". */
  composite: number | null
  /** Mean composite over `clean` alone. */
  cleanComposite: number | null
  best: number | null
  worst: number | null
  /** Mean per dimension, over the reviews that scored it. A null dimension is skipped, never zeroed. */
  dimensions: Partial<Record<RubricDimension, number>>
  lastGradedAt: number | null
}

/** One grading agent, and how generously it has scored. */
export interface QualityReviewerTally {
  adapterId: string
  label: string
  gradingModel: string | null
  reviews: number
  /** ⚠️ Published as a calibration check, never applied as a correction. */
  meanGiven: number | null
}

export interface UngradedTask {
  taskId: string
  seq: number
  title: string
  projectId: string | null
  finishedAt: number
  /** Who would be graded: the adapter of the last non-failed work run. */
  adapterId: string | null
  model: string | null
}

export interface QualityReport {
  generatedAt: number
  rubricVersion: string
  weights: Record<RubricDimension, number>
  labels: Record<RubricDimension, { label: string; asks: string }>
  keys: QualityKey[]
  reviewers: QualityReviewerTally[]
  /** Every commissioned account, its grading model, and whether it may be picked as a peer at all. */
  graders: Array<{
    workerId: string
    label: string
    adapterId: string
    model: string | null
    enabled: boolean
  }>
  totalReviews: number
  gradedTasks: number
  ungradedTasks: number
  /** Reviews that were asked for and produced no number, by status, with the most recent reason. */
  failures: Array<{ status: string; count: number; lastReason: string | null }>
}

export interface GradeBatchOutcome {
  taskId: string
  seq: number
  ok: boolean
  composite: number | null
  reason: string
}
