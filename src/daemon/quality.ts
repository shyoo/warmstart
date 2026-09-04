import {
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
  rubricFor,
  type DimensionScore,
  type RubricDimension
} from '@shared/review.js'
import type { QualityKey, QualityReport, QualityReviewerTally, UngradedTask } from '@shared/quality.js'
import { db, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { defaultGradingModel, listWorkers } from './workers.js'
import { requestReview, reviewEligibility } from './reviewer.js'
import { log } from './log.js'

/**
 * What the fleet has actually measured about *quality*, aggregated from stored peer reviews.
 *
 * ⛔ **A read, and only a read.** Nothing here grades anything, nothing here changes a task, and — as
 * `@shared/review.ts` says at the top — no routing decision reads the number this produces. It is an
 * instrument for a person: "is this agent worse at this repository's UI code, or did it just draw the
 * hard tasks?" The one *action* in this file is `gradeUngraded`, and it is only ever reached by
 * somebody pressing a button.
 *
 * ⛔ **Every aggregate is computed from the reviews' own stored rubric version.** A weight change
 * must not reinterpret a score produced under the old weights, so a key's composite is the mean of
 * the composites that were stored, never a re-weighting of the dimensions underneath them.
 *
 * ⚠️ **`clean` is the number to compare agents on, and it is routinely smaller than `samples`.** A
 * review of a task two adapters both worked on is not evidence about either, and a review whose
 * blinding leaked a vendor name is not a blind review. Both are counted and both are excluded from
 * `cleanComposite`, so the difference can be *seen* rather than assumed away.
 */

interface ReviewAggRow {
  subject_adapter: string
  subject_model: string | null
  composite: number | null
  scores_json: string | null
  mixed_authorship: number
  blinding_leak: number
  reviewer_adapter: string
  completed_at: number | null
}

function keyId(adapterId: string, model: string | null): string {
  return `${adapterId}/${model ?? '?'}`
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
}

/**
 * Every scored dimension a key has, averaged.
 *
 * ⚠️ A `null` dimension score is *skipped*, never read as 0 — the whole reason `DimensionScore.score`
 * is nullable. A pure-CSS change has no tests to grade, and averaging that in as a zero would make
 * the agent that draws the CSS work look like the agent that never writes tests.
 */
function dimensionMeans(
  entries: Array<Partial<Record<RubricDimension, DimensionScore>>>
): Partial<Record<RubricDimension, number>> {
  const out: Partial<Record<RubricDimension, number>> = {}
  for (const dimension of RUBRIC_DIMENSIONS) {
    const values: number[] = []
    for (const scores of entries) {
      const entry = scores[dimension]
      if (entry && entry.score !== null) values.push(entry.score)
    }
    const m = mean(values)
    if (m !== null) out[dimension] = m
  }
  return out
}

function loadReviews(): ReviewAggRow[] {
  return rows<ReviewAggRow>(
    db()
      .prepare(
        `select subject_adapter, subject_model, composite, scores_json, mixed_authorship,
                blinding_leak, reviewer_adapter, completed_at
           from quality_reviews
          where status = 'complete' and composite is not null
          order by completed_at desc`
      )
      .all()
  )
}

function qualityKeys(reviews: ReviewAggRow[]): QualityKey[] {
  const buckets = new Map<
    string,
    {
      adapterId: string
      model: string | null
      all: ReviewAggRow[]
      clean: ReviewAggRow[]
    }
  >()
  for (const r of reviews) {
    const key = keyId(r.subject_adapter, r.subject_model)
    const bucket =
      buckets.get(key) ?? { adapterId: r.subject_adapter, model: r.subject_model, all: [], clean: [] }
    bucket.all.push(r)
    if (r.mixed_authorship === 0 && r.blinding_leak === 0) bucket.clean.push(r)
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .map((bucket) => {
      const composites = bucket.all.map((r) => r.composite as number)
      const cleanComposites = bucket.clean.map((r) => r.composite as number)
      const parsed = bucket.all.map((r) =>
        r.scores_json
          ? (JSON.parse(r.scores_json) as Partial<Record<RubricDimension, DimensionScore>>)
          : {}
      )
      return {
        adapterId: bucket.adapterId,
        model: bucket.model,
        samples: composites.length,
        clean: cleanComposites.length,
        mixedAuthorship: bucket.all.filter((r) => r.mixed_authorship === 1).length,
        blindingLeaks: bucket.all.filter((r) => r.blinding_leak === 1).length,
        composite: mean(composites),
        cleanComposite: mean(cleanComposites),
        best: composites.length ? Math.max(...composites) : null,
        worst: composites.length ? Math.min(...composites) : null,
        dimensions: dimensionMeans(parsed),
        lastGradedAt: bucket.all[0]?.completed_at ?? null
      }
    })
    .sort((a, b) => (b.cleanComposite ?? b.composite ?? 0) - (a.cleanComposite ?? a.composite ?? 0))
}

/**
 * Who has been doing the grading.
 *
 * ⚠️ Published because a judge with a mean of 8.9 over forty reviews and one with a mean of 5.2 over
 * three are not producing comparable numbers, and the only way to notice is to see both. ⛔ Not a
 * correction: nothing here rescales a score by its reviewer's generosity, because there is no
 * measurement on this fleet that would justify choosing a scale factor.
 */
function reviewerTallies(reviews: ReviewAggRow[]): QualityReviewerTally[] {
  const buckets = new Map<string, number[]>()
  for (const r of reviews) {
    const list = buckets.get(r.reviewer_adapter) ?? []
    list.push(r.composite as number)
    buckets.set(r.reviewer_adapter, list)
  }
  return [...buckets.entries()]
    .map(([adapterId, values]) => ({
      adapterId,
      label: labelFor(adapterId),
      gradingModel: defaultGradingModel(adapterId),
      reviews: values.length,
      meanGiven: mean(values)
    }))
    .sort((a, b) => b.reviews - a.reviews)
}

function labelFor(adapterId: string): string {
  try {
    return adapter(adapterId).info.label
  } catch {
    return adapterId
  }
}

/**
 * The finished work nothing has graded.
 *
 * ⛔ **Completed tasks only.** A cancelled or failed task has no result to judge, and a running one
 * has not produced its diff yet. ⚠️ Ordered newest first, because a review reads a commit range and
 * the ladder in `resolveRange` gets less able to answer the further back it reaches.
 */
export function ungradedTasks(limit = 50): UngradedTask[] {
  return rows<{
    id: string
    seq: number
    title: string
    project_id: string | null
    updated_at: number
    adapter_id: string | null
    model: string | null
  }>(
    db()
      .prepare(
        `select t.id, t.seq, t.title, t.project_id, t.updated_at,
                (select r.adapter_id from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as adapter_id,
                (select r.model from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as model
           from tasks t
          where t.status = 'completed'
            and t.deleted_at is null
            and t.quality_review_count = 0
            -- ⛔ Something must have run on it. A task completed by hand has no agent work to grade,
            -- and offering to spend a reviewer's turn on it would buy a score about nobody.
            and exists (select 1 from runs r where r.task_id = t.id and r.kind = 'work')
          order by t.updated_at desc
          limit ?`
      )
      .all(Math.max(1, Math.min(200, Math.floor(limit))))
  ).map((r) => ({
    taskId: r.id,
    seq: r.seq,
    title: r.title.slice(0, 400),
    projectId: r.project_id,
    finishedAt: r.updated_at,
    adapterId: r.adapter_id,
    model: r.model
  }))
}

function ungradedCount(): number {
  return (
    (
      db()
        .prepare(
          `select count(*) as n from tasks t
            where t.status = 'completed' and t.deleted_at is null and t.quality_review_count = 0
              and exists (select 1 from runs r where r.task_id = t.id and r.kind = 'work')`
        )
        .get() as { n: number } | undefined
    )?.n ?? 0
  )
}

function gradedCount(): number {
  return (
    (
      db()
        .prepare(
          `select count(*) as n from tasks
            where status = 'completed' and deleted_at is null and quality_review_count > 0`
        )
        .get() as { n: number } | undefined
    )?.n ?? 0
  )
}

/** How many reviews were asked for and did not produce a number, and why. Published, not hidden. */
function failures(): Array<{ status: string; count: number; lastReason: string | null }> {
  return rows<{ status: string; n: number; reason: string | null }>(
    db()
      .prepare(
        `select status, count(*) as n,
                (select failure_reason from quality_reviews q2
                  where q2.status = q1.status and q2.failure_reason is not null
                  order by q2.created_at desc limit 1) as reason
           from quality_reviews q1
          where status in ('failed', 'refused', 'pending')
          group by status`
      )
      .all()
  ).map((r) => ({ status: r.status, count: r.n, lastReason: r.reason }))
}

/** Everything the quality tab renders, in one read. */
export function qualityReport(): QualityReport {
  const reviews = loadReviews()
  const rubric = rubricFor(RUBRIC_VERSION)
  return {
    generatedAt: Date.now(),
    rubricVersion: RUBRIC_VERSION,
    weights: rubric?.weights ?? ({} as Record<RubricDimension, number>),
    labels: rubric?.labels ?? ({} as Record<RubricDimension, { label: string; asks: string }>),
    keys: qualityKeys(reviews),
    reviewers: reviewerTallies(reviews),
    // ⚠️ Every commissioned account with its grading model and whether it may grade at all, so
    // "nothing has been graded" can be told apart from "nothing here is allowed to grade".
    graders: listWorkers()
      .filter((w) => !w.retiredAt)
      .map((w) => ({
        workerId: w.id,
        label: w.label,
        adapterId: w.adapterId,
        model: w.gradingModel ?? defaultGradingModel(w.adapterId),
        enabled: w.gradingEnabled !== false
      })),
    totalReviews: reviews.length,
    gradedTasks: gradedCount(),
    ungradedTasks: ungradedCount(),
    failures: failures()
  }
}

/**
 * How many tasks one press of the button may grade.
 *
 * ⛔ A hard cap, not a default. Each of these spends a real turn on a real account, and a button that
 * could quietly commission forty of them on a fleet with a hundred ungraded tasks is a button that
 * empties a quota window by accident.
 */
export const GRADE_BATCH_MAX = 5

export interface GradeBatchResult {
  taskId: string
  seq: number
  ok: boolean
  /** The stored score, where one was produced. Null on any outcome that is not a complete review. */
  composite: number | null
  reason: string
}

/**
 * Grade up to `GRADE_BATCH_MAX` ungraded tasks, one after another.
 *
 * ⛔ **Sequential, deliberately.** Five reviews in parallel is five agent processes spawned at once
 * on a machine that is probably already running work, and `pickReviewer` would hand several of them
 * the same account — it excludes a worker that is *already* reviewing, and three simultaneous calls
 * all read "not reviewing" before any of them spawns.
 *
 * ⚠️ Every task is checked with `reviewEligibility` first, so a task with no resolvable commit range
 * or no peer to grade it is *skipped with its reason* rather than costing a spawn to discover the
 * same thing. The reasons come back to the caller and are shown; a batch that graded two of five is
 * a useful answer, not a failure.
 */
export async function gradeUngraded(limit = GRADE_BATCH_MAX): Promise<{
  results: GradeBatchResult[]
  graded: number
  skipped: number
}> {
  const wanted = Math.max(1, Math.min(GRADE_BATCH_MAX, Math.floor(limit)))
  // ⚠️ A wider slice than `wanted`: tasks are skipped for reasons only `reviewEligibility` knows, and
  // taking exactly five candidates would return "graded 0 of 5" on a fleet where the sixth was fine.
  const candidates = ungradedTasks(wanted * 4)
  const results: GradeBatchResult[] = []
  let graded = 0

  for (const candidate of candidates) {
    if (graded >= wanted) break
    const eligible = await reviewEligibility(candidate.taskId)
    if (!eligible.ok) {
      results.push({
        taskId: candidate.taskId,
        seq: candidate.seq,
        ok: false,
        composite: null,
        reason: eligible.reason
      })
      continue
    }
    const outcome = await requestReview(candidate.taskId)
    if (!outcome.ok) {
      results.push({
        taskId: candidate.taskId,
        seq: candidate.seq,
        ok: false,
        composite: null,
        reason: outcome.reason
      })
      continue
    }
    graded += 1
    const review = outcome.review
    results.push({
      taskId: candidate.taskId,
      seq: candidate.seq,
      // ⛔ `status`, not the presence of the row. A review that was asked for and came back
      // unparseable is stored, is a real fact about that model, and is not a grade.
      ok: review.status === 'complete' && review.composite !== null,
      composite: review.composite,
      reason:
        review.status === 'complete'
          ? review.summary ?? ''
          : (review.failureReason ?? `the review ended ${review.status}`)
    })
    log.info(
      `graded t${candidate.seq}: ${review.composite ?? 'no score'} (${review.status}) by ${review.reviewerAdapter}`
    )
  }

  return { results, graded, skipped: results.length - graded }
}
