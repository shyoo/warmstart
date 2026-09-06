import {
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
  rubricFor,
  type DimensionScore,
  type RubricDimension
} from '@shared/review.js'
import type {
  QualityKey,
  QualityReport,
  QualityReviewerTally,
  ReviewCounts,
  ReviewFilter,
  ReviewQueuePage,
  UngradedTask
} from '@shared/quality.js'
import { db, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { pendingReviews } from './review.js'
import { getTask } from './tasks.js'
import { defaultGradingModel, listWorkers } from './workers.js'
import { reviewEligibility, reviewerAvailability } from './reviewer.js'

/**
 * What the fleet has actually measured about *quality*, aggregated from stored peer reviews.
 *
 * ⛔ **A read, and only a read.** Nothing here grades anything, nothing here changes a task, and — as
 * `@shared/review.ts` says at the top — no routing decision reads the number this produces. It is an
 * instrument for a person: "is this agent worse at this repository's UI code, or did it just draw the
 * hard tasks?" ⛔ **Nothing in this file grades anything at all any more** — commissioning a review
 * is `gradebatch.ts`, reached only by somebody pressing Batch, and the reads here are what that page
 * and the Routing Model tab render.
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

// ---------------------------------------------------------------------------- the review queue

/**
 * The universe the Quality Review page pages through, and the one the batch draws from.
 *
 * ⛔ **Completed tasks that something actually ran on.** A cancelled or failed task has no result to
 * judge, a running one has not produced its diff yet, and a task somebody completed by hand has no
 * agent work to grade — offering to spend a reviewer's turn on it would buy a score about nobody.
 * The same three conditions `ungradedTasks` has always used, lifted out so the counts, the table and
 * the batch cannot drift into disagreeing about which tasks exist.
 */
const FINISHED = `from tasks t
   where t.status = 'completed' and t.deleted_at is null
     and exists (select 1 from runs r where r.task_id = t.id and r.kind = 'work')`

/** The `where` fragment for one bucket. ⚠️ `many` is two *or more*, so exactly two is in it. */
function filterClause(filter: ReviewFilter): string {
  if (filter === 'none') return ' and t.quality_review_count = 0'
  if (filter === 'one') return ' and t.quality_review_count = 1'
  if (filter === 'many') return ' and t.quality_review_count >= 2'
  return ''
}

function scalar(sql: string): number {
  return ((db().prepare(sql).get() as { n: number } | undefined)?.n ?? 0)
}

export function reviewCounts(): ReviewCounts {
  const none = scalar(`select count(*) as n ${FINISHED} and t.quality_review_count = 0`)
  const one = scalar(`select count(*) as n ${FINISHED} and t.quality_review_count = 1`)
  const many = scalar(`select count(*) as n ${FINISHED} and t.quality_review_count >= 2`)
  return { none, one, many, total: none + one + many }
}

interface QueueRow {
  id: string
  seq: number
  title: string
  project_id: string | null
  updated_at: number
  quality_review_count: number
  quality_review_score: number | null
  adapter_id: string | null
  model: string | null
}

/**
 * The tasks in one bucket, newest first.
 *
 * ⚠️ Newest first for the reason `ungradedTasks` is: a review reads a commit range, and
 * `resolveRange` gets less able to answer the further back it reaches. A page of the oldest work is
 * a page of tasks that will mostly refuse.
 */
function queueRows(filter: ReviewFilter, limit: number, offset: number): QueueRow[] {
  return rows<QueueRow>(
    db()
      .prepare(
        `select t.id, t.seq, t.title, t.project_id, t.updated_at, t.quality_review_count,
                t.quality_review_score,
                (select r.adapter_id from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as adapter_id,
                (select r.model from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as model
           ${FINISHED}${filterClause(filter)}
          order by t.updated_at desc
          limit ? offset ?`
      )
      .all(limit, offset)
  )
}

/** Who has already graded each of these tasks, in one read rather than one per row. */
function gradersByTask(taskIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (taskIds.length === 0) return out
  const marks = taskIds.map(() => '?').join(', ')
  for (const r of rows<{ task_id: string; reviewer_adapter: string }>(
    db()
      .prepare(
        `select distinct task_id, reviewer_adapter from quality_reviews
          where status = 'complete' and composite is not null and task_id in (${marks})
          order by task_id, reviewer_adapter`
      )
      .all(...taskIds)
  )) {
    out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.reviewer_adapter])
  }
  return out
}

/** One page of the Quality Review table, with the bucket counts the tabs above it print. */
export async function reviewQueue(
  filter: ReviewFilter = 'none',
  limit = 25,
  offset = 0
): Promise<ReviewQueuePage> {
  const take = Math.max(1, Math.min(200, Math.floor(limit)))
  const skip = Math.max(0, Math.floor(offset))
  const found = queueRows(filter, take, skip)
  const graders = gradersByTask(found.map((r) => r.id))
  const grading = new Set(pendingReviews().map((r) => r.taskId))
  const counts = reviewCounts()
  const total =
    filter === 'none' ? counts.none : filter === 'one' ? counts.one : filter === 'many' ? counts.many : counts.total

  return {
    counts,
    total,
    rows: await Promise.all(found.map(async (r) => {
      const task = getTask(r.id)
      // ⚠️ A row whose task vanished between the two reads is not an eligibility answer, and saying
      // "no eligible reviewer" about it would be a claim this code cannot support.
      // The column promises whether the task can be graded, not merely whether a peer exists. A
      // missing commit range is permanent and belongs here before a batch discovers it by skipping.
      const peers = task ? reviewerAvailability(task) : null
      const eligibility = !task
        ? { ok: false, reason: 'this task is no longer readable' }
        : peers && !peers.eligible
          ? { ok: false, reason: peers.reason }
          : await reviewEligibility(task.id)
      return {
        taskId: r.id,
        seq: r.seq,
        title: r.title.slice(0, 400),
        projectId: r.project_id,
        finishedAt: r.updated_at,
        adapterId: r.adapter_id,
        model: r.model,
        reviewCount: r.quality_review_count,
        score: r.quality_review_score,
        gradedBy: graders.get(r.id) ?? [],
        eligible: eligibility.ok,
        ineligibleReason: eligibility.ok ? '' : eligibility.reason,
        grading: grading.has(r.id)
      }
    }))
  }
}

/**
 * The tasks a batch would grade: fewer than `threshold` stored grades, newest first.
 *
 * ⛔ `count` is what will be **attempted**, not what will be graded. The batch this replaced took a
 * wider slice and kept going until it had graded its number, which is right for a button that says
 * *grade five* and wrong for a queue an operator is watching: a row that was skipped has to stay
 * visible as a skip with its reason, and silently substituting the next task for it hides exactly
 * the fleet fact — no peer left, no resolvable range — the page was opened to find.
 */
export function batchCandidates(threshold: number, count: number | null): UngradedTask[] {
  const under = Math.max(1, Math.floor(threshold))
  const take = count === null ? 500 : Math.max(1, Math.min(500, Math.floor(count)))
  return rows<QueueRow>(
    db()
      .prepare(
        `select t.id, t.seq, t.title, t.project_id, t.updated_at, t.quality_review_count,
                t.quality_review_score,
                (select r.adapter_id from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as adapter_id,
                (select r.model from runs r
                  where r.task_id = t.id and r.kind = 'work'
                    and coalesce(r.outcome, '') <> 'failed'
                  order by r.started_at desc limit 1) as model
           ${FINISHED} and t.quality_review_count < ?
          order by t.updated_at desc
          limit ?`
      )
      .all(under, take)
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
