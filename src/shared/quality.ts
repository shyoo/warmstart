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

// ---------------------------------------------------------------------------- quality review queue

/**
 * Which slice of finished work the Quality Review page is showing.
 *
 * ⛔ **The buckets are counts of *stored grades*, not of attempts.** A task somebody asked three
 * reviews of, all of which timed out, is in `none` — it has no grade, which is the whole question
 * this page exists to answer. `tasks.quality_review_count` is the one number behind every bucket.
 */
export type ReviewFilter = 'all' | 'none' | 'one' | 'many'

/** How many finished tasks sit in each bucket. ⚠️ Over the same universe the table pages through. */
export interface ReviewCounts {
  none: number
  one: number
  /** Two or more. The spec's `>2` bucket, and it includes exactly two. */
  many: number
  total: number
}

/** One row of the Quality Review table. */
export interface ReviewQueueRow {
  taskId: string
  seq: number
  title: string
  projectId: string | null
  finishedAt: number
  /** Who would be graded: the adapter of the last non-failed work run. */
  adapterId: string | null
  model: string | null
  reviewCount: number
  /** The mean of the stored grades, or null when there are none. ⚠️ Never 0 for "ungraded". */
  score: number | null
  /** The adapters that have already produced a grade — and are therefore no longer candidates. */
  gradedBy: string[]
  /**
   * Whether any commissioned peer could still grade this task at all.
   *
   * ⛔ Answered from the durable gates only — authorship, prior grades, grading enabled, read-only
   * capability. Login, health and quota are transient and are re-asked at spawn; hiding a
   * configured reviewer whenever one flickered is the bug `reviewCandidates` documents.
   */
  eligible: boolean
  /** ⛔ Never a bare "unavailable": names every candidate considered and why each was rejected. */
  ineligibleReason: string
  /** A grade is being produced for this task right now. */
  grading: boolean
}

export interface ReviewQueuePage {
  rows: ReviewQueueRow[]
  /** Rows matching the filter, before paging. */
  total: number
  counts: ReviewCounts
}

/** How many reviews one press may commission. ⚠️ `null` is ALL, and the UI says what ALL costs. */
export const BATCH_SIZES: ReadonlyArray<number | null> = [1, 3, 5, 10, 20, 50, null]

/**
 * The thresholds the batch offers, as a strict `reviewCount < n`.
 *
 * ⚠️ Spelled in words in the UI: *less than 1 review* is a sentence nobody says out loud, and the
 * operator is choosing "how thin is too thin", not writing a predicate.
 */
export const BATCH_THRESHOLDS: readonly number[] = [1, 2, 3, 5]

export function thresholdLabel(threshold: number): string {
  return threshold <= 1 ? 'no reviews' : `fewer than ${threshold} reviews`
}

export type BatchState = 'running' | 'done' | 'cancelled'

/** What happened to one task in a batch. */
export interface BatchEntry {
  taskId: string
  seq: number
  title: string
  state: 'queued' | 'grading' | 'graded' | 'skipped'
  composite: number | null
  /** The account that graded it, where one did. */
  reviewer: string | null
  /** Why it was skipped, or the review's own summary when it was graded. */
  reason: string
}

/** A batch, as the page renders it. ⛔ Progress is read from here, never inferred from the table. */
export interface GradeBatch {
  id: string
  startedAt: number
  finishedAt: number | null
  state: BatchState
  /** What was asked for: a count, or null for ALL. */
  requested: number | null
  threshold: number
  entries: BatchEntry[]
  graded: number
  skipped: number
  grading: number
  queued: number
}
