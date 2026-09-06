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
  /** What Settings has this adapter's accounts *configured* to grade on. ⚠️ Not what actually did. */
  gradingModel: string | null
  /**
   * The models that actually produced these reviews, newest configuration or not.
   *
   * ⛔ The adapter id is a transport, not a judge: `openai-compatible` is Codex on one account and a
   * 4B model on a local endpoint on another, and their scores are not the same measurement. A
   * reviewer row that names only the adapter cannot be read as a calibration check at all. Empty
   * when no review recorded its model — an old row, never a claim that the CLI default was used.
   */
  modelsUsed: string[]
  reviews: number
  /** ⚠️ Published as a calibration check, never applied as a correction. */
  meanGiven: number | null
  medianGiven: number | null
  minGiven: number | null
  maxGiven: number | null
  byModel?: QualityReviewerModelTally[]
}

export interface QualityReviewerModelTally {
  model: string | null
  reviews: number
  meanGiven: number | null
  medianGiven: number | null
  minGiven: number | null
  maxGiven: number | null
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
  /** `openai-compatible` → `Codex CLI`. ⚠️ Resolved by the daemon; see `ReviewQueuePage`. */
  adapterLabels: Record<string, string>
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
  ungradable?: number
}

/**
 * One agent as this page has to name it: the adapter it was reached through, and the model that
 * actually did the work.
 *
 * ⛔ **The model is the thing being measured, and the adapter id alone does not identify it.**
 * `openai-compatible` is Codex CLI on one account and a local endpoint serving a 4B model on
 * another; `local-llm` is whatever is loaded. Two grades filed under one adapter id can be two
 * completely different judges, so both halves are carried and the model is the one rendered first.
 *
 * ⚠️ `model` is null for work run before the model was recorded, and that is said out loud rather
 * than filled in with the adapter's current default — the default today is not evidence about what
 * ran months ago.
 */
export interface ReviewCredit {
  adapterId: string
  model: string | null
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
  /** The judges that have already produced a grade — and are therefore no longer candidates. */
  gradedBy: ReviewCredit[]
  /**
   * Whether any commissioned peer could still grade this task at all.
   *
   * ⛔ Requires both a durable peer and an exact, resolvable commit range. Login, health and quota
   * are transient and are re-asked at spawn; hiding a configured reviewer whenever one flickered
   * is the bug `reviewCandidates` documents.
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
  /**
   * `openai-compatible` → `Codex CLI`, for every adapter this build has loaded.
   *
   * ⚠️ Sent once per page rather than per row, and resolved by the daemon rather than by a table in
   * the renderer: the adapters are what they say they are, and a second list of their names over
   * here would go stale the day one was added. An id with no entry is rendered as itself.
   */
  adapterLabels: Record<string, string>
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
  /** The adapter that graded it, where one did. */
  reviewer: string | null
  /** ⚠️ The model behind that adapter — the half of the judge's identity that is the judge. */
  reviewerModel: string | null
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
