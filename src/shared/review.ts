/**
 * Peer quality review — the rubric, and the shape of a grade.
 *
 * ⛔ **Nothing gates on any of this.** No task changes status because of a score, no routing
 * decision reads one, and the estimator never sees a review run. It is an *instrument*: a number
 * kept beside the work so that "is this agent actually worse at this repository's UI code, or did it
 * just draw the hard tasks?" has data behind it in three months instead of a memory. Wiring a score
 * into routing before it has been shown to measure anything is the mistake this project has already
 * made once and written down.
 *
 * ⚠️ Shared rather than daemon-only, and deliberately: the weights are *published* — the same
 * argument `objective.ts` makes for its weight vector — and the thread renders each dimension beside
 * the weight it carried. A second copy of these numbers in the renderer is a second thing to keep in
 * step with the daemon that computes the composite from them.
 *
 * The design, the measurements behind it and the sources for the rubric are in
 * `transient_docs/quality_review_2026-09-03.md`.
 */

/** The seven dimensions, in the order they are asked for and displayed. */
export const RUBRIC_DIMENSIONS = [
  'requirement_fidelity',
  'correctness',
  'tests',
  'codebase_fit',
  'scope_discipline',
  'maintainability',
  'self_sufficiency'
] as const

export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number]

/**
 * The weight vector, published because it is a judgment call rather than a fact.
 *
 * ⛔ Requirement fidelity and correctness are **40% between them**: a beautifully crafted patch that
 * does the wrong thing is a failure, and the number has to say so numerically or it does not mean
 * it. Codebase fit is 15% and never more — it is the dimension a judge is most confident and least
 * right about.
 *
 * ⚠️ Renormalised over the dimensions actually scored (see `composite`). A `null` — the dimension
 * does not apply, as tests do not to a pure-CSS change — must neither drag the mean down nor
 * silently redistribute its weight to whichever dimension happens to be listed next.
 */
const RUBRIC_WEIGHTS_1_0: Record<RubricDimension, number> = {
  requirement_fidelity: 0.2,
  correctness: 0.2,
  tests: 0.15,
  codebase_fit: 0.15,
  scope_discipline: 0.1,
  maintainability: 0.1,
  self_sufficiency: 0.1
}

/** What each dimension is called on screen, and the one question it asks. */
const RUBRIC_LABELS_1_0: Record<RubricDimension, { label: string; asks: string }> = {
  requirement_fidelity: {
    label: 'Requirement fidelity',
    asks: 'Did it do what was actually asked — all of it, and only it?'
  },
  correctness: {
    label: 'Correctness & robustness',
    asks: 'Does the change do what it claims, including on the paths nobody exercised?'
  },
  tests: {
    label: 'Test & verification',
    asks: 'Would the new tests have failed before this change, and do they test behaviour?'
  },
  codebase_fit: {
    label: 'Codebase fit',
    asks: 'Does it look like the code around it, and reuse what is already there?'
  },
  scope_discipline: {
    label: 'Scope discipline',
    asks: 'Is the diff the size the job needed?'
  },
  maintainability: {
    label: 'Maintainability',
    asks: 'Can the next person change this safely without asking the author?'
  },
  self_sufficiency: {
    label: 'Self-sufficiency',
    asks: 'How much did it cost in retries, questions and hand-holding to get here?'
  }
}

/**
 * The rubric's own version, stored on every review.
 *
 * ⛔ Bump it whenever a dimension, an anchor or a weight changes. Two scores produced under
 * different rubrics are not comparable, and the only way to find that out later is to have written
 * down which rubric produced each one.
 */
export interface RubricDefinition {
  version: string
  weights: Record<RubricDimension, number>
  labels: Record<RubricDimension, { label: string; asks: string }>
}

/**
 * Append-only rubric catalogue. A review is interpreted with the definition it stored, never with
 * whichever weights happen to be current when it is read months later.
 */
export const RUBRICS: Readonly<Record<string, RubricDefinition>> = Object.freeze({
  '1.0': Object.freeze({
    version: '1.0',
    weights: Object.freeze(RUBRIC_WEIGHTS_1_0),
    labels: Object.freeze(RUBRIC_LABELS_1_0)
  })
})

export const RUBRIC_VERSION = '1.0'
export const RUBRIC_WEIGHTS = RUBRICS[RUBRIC_VERSION]!.weights
export const RUBRIC_LABELS = RUBRICS[RUBRIC_VERSION]!.labels

export function rubricFor(version: string): RubricDefinition | null {
  return RUBRICS[version] ?? null
}

export interface DimensionScore {
  /** 0–10, or `null` when the dimension does not apply to this change. ⛔ Never 0 for "unknown". */
  score: number | null
  rationale: string
}

/** `cancelled` is an operator stopping an in-flight grade, never a verdict on the task. */
export type ReviewStatus = 'pending' | 'complete' | 'failed' | 'refused' | 'cancelled'

/** One entry of `authorship`: an adapter that contributed non-failed work runs to the task. */
export interface ReviewAuthor {
  adapterId: string
  model: string | null
  runs: number
  lastAt: number
}

export interface QualityReview {
  id: string
  taskId: string
  /** ⛔ The metering, and the timeline entry. A review is a run; see the daemon's `review.ts`. */
  runId: string
  reviewerWorkerId: string
  reviewerAdapter: string
  reviewerModel: string | null
  /** The agent credited with the work being graded. Stored, never derived at read time. */
  subjectAdapter: string
  subjectModel: string | null
  /** More than one adapter contributed non-failed work runs. Such a score is not clean evidence. */
  mixedAuthorship: boolean
  authorship: ReviewAuthor[]
  baseSha: string | null
  headSha: string | null
  diffFiles: number | null
  diffInsertions: number | null
  diffDeletions: number | null
  diffTruncated: boolean
  scores: Partial<Record<RubricDimension, DimensionScore>> | null
  /** ⚠️ Null when the review failed. Never 0 — that is a real grade and would be a lie. */
  composite: number | null
  summary: string | null
  notable: string[]
  status: ReviewStatus
  failureReason: string | null
  rubricVersion: string
  blinded: boolean
  /** A name blinding could not remove survived in the prose. See the daemon's `blind`. */
  blindingLeak: boolean
  createdAt: number
  completedAt: number | null
}

/**
 * The headline number: a weighted mean over the dimensions that were actually scored.
 *
 * ⛔ Computed here from the stored dimension scores and **never read from the model's reply**.
 * Holistic scoring is where LLM judges are least reliable on long agentic outputs, and computing it
 * means the model cannot smuggle in a holistic score. Historical reviews use their stored rubric
 * version, so a later weight change cannot reinterpret them.
 *
 * ⚠️ Returns null when nothing was scored — an honest "no number", distinct from a zero.
 */
export function composite(
  scores: Partial<Record<RubricDimension, DimensionScore>>,
  rubricVersion = RUBRIC_VERSION
): number | null {
  const rubric = rubricFor(rubricVersion)
  if (!rubric) return null
  let weighted = 0
  let total = 0
  for (const dimension of RUBRIC_DIMENSIONS) {
    const entry = scores[dimension]
    if (!entry || entry.score === null) continue
    const weight = rubric.weights[dimension]
    weighted += weight * entry.score
    total += weight
  }
  if (total === 0) return null
  return Math.round((weighted / total) * 10) / 10
}
