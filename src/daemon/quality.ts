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
  ReviewCredit,
  ReviewFilter,
  ReviewQueuePage,
  UngradedTask
} from '@shared/quality.js'
import { db, rows } from './db.js'
import { adapter, adapterLabels } from './adapters/index.js'
import { pendingReviews } from './review.js'
import { getTasksByIds } from './tasks.js'
import type { Task } from '@shared/tasks.js'
import { defaultGradingModel, listWorkers } from './workers.js'
import { hasBatchReviewer, reviewRange, reviewerAvailability } from './reviewer.js'
import { medianFloat } from './stats.js'

/**
 * What the fleet has actually measured about *quality*, aggregated from stored peer and user reviews.
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
 * rating of a task two adapters both worked on is not evidence about either, and a peer review whose
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
  reviewer_adapter: string | null
  reviewer_model: string | null
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
        // ⚠️ Joined to `tasks` for one reason: a task an operator has excluded from the fleet's
        // statistics is excluded from its grades too. The join is inner, so a review whose task has
        // been hard-deleted drops out as well — which it already did everywhere else.
        `select q.subject_adapter, q.subject_model, q.composite, q.scores_json, q.mixed_authorship,
                q.blinding_leak, q.reviewer_adapter, q.reviewer_model, q.completed_at
           from quality_reviews q join tasks t on t.id = q.task_id
          where q.status = 'complete' and q.composite is not null
            and coalesce(t.stats_excluded, 0) = 0
        union all
         select m.subject_adapter, m.subject_model, m.score as composite, null as scores_json,
                m.mixed_authorship, 0 as blinding_leak, null as reviewer_adapter,
                null as reviewer_model, m.created_at as completed_at
           from manual_reviews m join tasks t on t.id = m.task_id
          where coalesce(t.stats_excluded, 0) = 0
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
  const buckets = new Map<string, { scores: number[]; models: Set<string> }>()
  for (const r of reviews) {
    if (!r.reviewer_adapter) continue
    const bucket = buckets.get(r.reviewer_adapter) ?? { scores: [], models: new Set<string>() }
    bucket.scores.push(r.composite as number)
    // ⛔ Only what was stored. A review whose model was never recorded contributes no name here
    // rather than the adapter's current default, which is a guess about a run that is over.
    if (r.reviewer_model) bucket.models.add(r.reviewer_model)
    buckets.set(r.reviewer_adapter, bucket)
  }
  return [...buckets.entries()]
    .map(([adapterId, bucket]) => {
      const modelBuckets = new Map<string | null, number[]>()
      for (const r of reviews) {
        if (r.reviewer_adapter !== adapterId) continue
        const m = r.reviewer_model ?? null
        const list = modelBuckets.get(m) ?? []
        list.push(r.composite as number)
        modelBuckets.set(m, list)
      }
      const byModel = [...modelBuckets.entries()]
        .map(([model, scores]) => ({
          model,
          reviews: scores.length,
          meanGiven: mean(scores),
          // An empty score series remains explicitly unmeasured in the operator report.
          medianGiven: medianFloat(scores),
          minGiven: scores.length ? Math.min(...scores) : null,
          maxGiven: scores.length ? Math.max(...scores) : null
        }))
        .sort((a, b) => b.reviews - a.reviews)

      return {
        adapterId,
        label: labelFor(adapterId),
        gradingModel: defaultGradingModel(adapterId),
        modelsUsed: [...bucket.models].sort(),
        reviews: bucket.scores.length,
        meanGiven: mean(bucket.scores),
        // An empty score series remains explicitly unmeasured in the operator report.
        medianGiven: medianFloat(bucket.scores),
        minGiven: bucket.scores.length ? Math.min(...bucket.scores) : null,
        maxGiven: bucket.scores.length ? Math.max(...bucket.scores) : null,
        byModel
      }
    })
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
            and coalesce(t.stats_excluded, 0) = 0
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
              and coalesce(t.stats_excluded, 0) = 0
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
            where status = 'completed' and deleted_at is null and quality_review_count > 0
              and coalesce(stats_excluded, 0) = 0`
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
    adapterLabels: adapterLabels(),
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
     and coalesce(t.stats_excluded, 0) = 0
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

/**
 * Who has already graded each of these tasks, in one read rather than one per row.
 *
 * ⚠️ **Adapter *and* model**, distinct on both. Two grades from `openai-compatible` may be two
 * different judges — Codex on one account, a small local model on another — and the row that says
 * why nobody else may grade this task is the row where that difference is worth seeing.
 *
 * ⛔ Eligibility is still burned per *adapter*, and that is `reviewer.ts`'s rule, not this read's to
 * restate: naming both models here does not mean a second model behind the same adapter may grade.
 */
function gradersByTask(taskIds: string[]): Map<string, ReviewCredit[]> {
  const out = new Map<string, ReviewCredit[]>()
  if (taskIds.length === 0) return out
  const marks = taskIds.map(() => '?').join(', ')
  for (const r of rows<{ task_id: string; reviewer_adapter: string; reviewer_model: string | null }>(
    db()
      .prepare(
        `select distinct task_id, reviewer_adapter, reviewer_model from quality_reviews
          where status = 'complete' and composite is not null and task_id in (${marks})
          order by task_id, reviewer_adapter, reviewer_model`
      )
      .all(...taskIds)
  )) {
    out.set(r.task_id, [
      ...(out.get(r.task_id) ?? []),
      { adapterId: r.reviewer_adapter, model: r.reviewer_model }
    ])
  }
  return out
}

export async function isTaskGradable(task: Task): Promise<{ ok: boolean; reason: string }> {
  if (task.nonGradable) {
    return { ok: false, reason: 'marked non-gradable by operator' }
  }
  const peers = reviewerAvailability(task)
  if (!peers.eligible) {
    return { ok: false, reason: peers.reason }
  }
  if (task.projectId) {
    // ⛔ `reviewRange`, never `reviewEligibility`. The peer half of that call is `reviewCandidates`,
    // which `reviewerAvailability` above has already asked; what came back on top of it was the
    // reviewer *menu*, and building one costs a `runs` scan per worker for a `typicalMs` no caller
    // here reads. Measured 2026-09-09: `quality.queue` runs this for every finished task, so on 322
    // tasks × 8 workers that menu was 2,576 table scans and **5.0s of a 5.1s** RPC — long enough,
    // when the page's 3s poll stacked on it during a batch, to block the daemon's event loop for
    // 78s and have node's own header-timeout reaper destroy the UI's live connection under it.
    const range = await reviewRange(task.id)
    if (!range.ok) return { ok: false, reason: range.reason }
  }
  return { ok: true, reason: '' }
}

/** One visible page of the Quality Review table. Coverage totals are read separately. */
export async function reviewQueue(
  filter: ReviewFilter = 'none',
  limit = 25,
  offset = 0,
  gradableOnly = false
): Promise<ReviewQueuePage> {
  const take = Math.max(1, Math.min(200, Math.floor(limit)))
  const skip = Math.max(0, Math.floor(offset))
  // ⛔ Read and validate the visible page first. The old shape collected up to 1,000 finished
  // tasks and resolved every one of their git ranges before returning 25 rows. That made opening
  // this page get slower with history, even though the reader could not see those rows yet.
  // `reviewCoverage` deliberately keeps the whole-history read, but it is requested after this
  // response has painted the page.
  const raw = queueRows(filter, gradableOnly ? 1000 : take, gradableOnly ? 0 : skip)
  // ⛔ One batched fetch, not `getTask` per row: `TASK_SELECT`'s correlated subqueries and its
  // timing lookup are each designed to run once for the whole page, and calling `getTask` in this
  // loop paid for both of them per task instead. See `getTasksByIds`.
  const tasksById = getTasksByIds(raw.map((r) => r.id))
  const gradableMap = new Map<string, { ok: boolean; reason: string }>()

  await Promise.all(
    raw.map(async (r) => {
      const task = tasksById.get(r.id) ?? null
      const gradable = task
        ? await isTaskGradable(task)
        : { ok: false, reason: 'this task is no longer readable' }
      gradableMap.set(r.id, gradable)
    })
  )

  const found = gradableOnly ? raw.filter((r) => gradableMap.get(r.id)?.ok).slice(skip, skip + take) : raw
  // A precise total after filtering to eligible work requires the same fleet-wide validation as
  // the coverage tiles. Keep that deliberate, opt-in filter honest; ordinary page navigation is
  // a cheap SQL count and never touches historical git ranges.
  const total = gradableOnly
    ? raw.filter((r) => gradableMap.get(r.id)?.ok).length
    : scalar(`select count(*) as n ${FINISHED}${filterClause(filter)}`)

  const graders = gradersByTask(found.map((r) => r.id))
  const grading = new Set(pendingReviews().map((r) => r.taskId))

  return {
    total,
    adapterLabels: adapterLabels(),
    rows: found.map((r) => {
      const gradable = gradableMap.get(r.id) ?? { ok: false, reason: 'unknown' }
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
        eligible: gradable.ok,
        ineligibleReason: gradable.ok ? '' : gradable.reason,
        grading: grading.has(r.id)
      }
    })
  }
}

/**
 * The exact totals behind the coverage tiles and tab badges.
 *
 * ⛔ Kept separate from `reviewQueue`: this validates historical git ranges, so it grows with
 * history. The renderer asks only after the visible page has arrived; correctness remains the
 * same, but a reader no longer waits for work outside the page they opened.
 */
export async function reviewCoverage(): Promise<ReviewCounts> {
  const allFinished = queueRows('all', 1000, 0)
  const tasksById = getTasksByIds(allFinished.map((r) => r.id))
  const gradable = await Promise.all(
    allFinished.map(async (r) => {
      const task = tasksById.get(r.id)
      return task ? (await isTaskGradable(task)).ok : false
    })
  )
  let none = 0
  let one = 0
  let many = 0
  for (let i = 0; i < allFinished.length; i += 1) {
    if (!gradable[i]) continue
    const count = allFinished[i]?.quality_review_count ?? 0
    if (count === 0) none += 1
    else if (count === 1) one += 1
    else many += 1
  }
  return { none, one, many, total: none + one + many, ungradable: allFinished.length - (none + one + many) }
}

/**
 * The tasks a batch would grade: fewer than `threshold` stored grades, newest first.
 *
 * ⛔ **Skips ungradable tasks** (e.g. missing commit range or no peer). `count` is what will be
 * **attempted**, or null for all matching.
 */
export async function batchCandidates(threshold: number, count: number | null): Promise<UngradedTask[]> {
  const under = Math.max(1, Math.floor(threshold))
  const targetCount = count === null ? 500 : Math.max(1, Math.min(500, Math.floor(count)))
  const candidateRows = rows<QueueRow>(
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
          order by t.updated_at desc`
      )
      .all(under)
  )

  const tasksById = getTasksByIds(candidateRows.map((r) => r.id))
  const result: UngradedTask[] = []
  for (const r of candidateRows) {
    if (result.length >= targetCount) break
    const task = tasksById.get(r.id) ?? null
    if (!task) continue
    const gradable = await isTaskGradable(task)
    if (!gradable.ok) continue
    if (!hasBatchReviewer(task)) continue
    result.push({
      taskId: r.id,
      seq: r.seq,
      title: r.title.slice(0, 400),
      projectId: r.project_id,
      finishedAt: r.updated_at,
      adapterId: r.adapter_id,
      model: r.model
    })
  }
  return result
}
