import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Analytics › Quality Review — the coverage read, and the rule that keeps a batch from paying twice.
 *
 * ⛔ **What these pin is that an agent is asked about a task at most once.** A second grade from a
 * judge that has already answered costs a real turn on a real account to reproduce a number that is
 * already stored, and on a batch of fifty that is the difference between measuring the fleet and
 * emptying a quota window. ⚠️ The exclusion is by **adapter**, so two Claude accounts are one judge —
 * the same reason authorship is excluded by adapter — and it counts only reviews that actually
 * produced a score, so an adapter whose review timed out is asked again rather than burned.
 */

let dir: string
let db: typeof import('./db.js')
let quality: typeof import('./quality.js')
let review: typeof import('./review.js')
let reviewer: typeof import('./reviewer.js')
let tasks: typeof import('./tasks.js')

let seq = 0

/** A completed task with one work run — the three conditions that make a task gradeable at all. */
function task(input: { adapter?: string; grades?: number } = {}): string {
  seq += 1
  const id = `t-${seq}`
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          quality_review_count, created_at, updated_at)
       values (?,?,?, 'completed', '{}','{}','{}', ?, ?, ?)`
    )
    .run(id, seq, `task ${seq}`, input.grades ?? 0, seq, seq)
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, adapter_id, model,
                         kind, quota_unverified)
       values (?,?, 'w-claude', ?, ?, 'completed', ?, 'claude-sonnet-5', 'work', 0)`
    )
    .run(`r-${seq}`, id, seq, seq + 1, input.adapter ?? 'claude-code')
  return id
}

/** One stored review. `composite: null` is the shape a review that answered with nothing has. */
function grade(taskId: string, reviewerAdapter: string, status: string, composite: number | null): void {
  seq += 1
  db.db()
    .prepare(
      `insert into quality_reviews
         (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, reviewer_model,
          subject_adapter, subject_model, mixed_authorship, authorship_json, notable_json,
          scores_json, composite, status, rubric_version, blinded, blinding_leak,
          created_at, completed_at)
       values (?,?,?,?,?,'m','claude-code','claude-sonnet-5',0,'[]','[]','{}',?,?,'1.0',1,0,?,?)`
    )
    .run(`q-${seq}`, taskId, `run-${seq}`, `w-${reviewerAdapter}`, reviewerAdapter, composite, status, seq, seq)
}

/** A task whose stored grade count matches its stored grades — what `completeReview` maintains. */
function graded(reviewerAdapter: string, status = 'complete', composite: number | null = 8): string {
  const id = task()
  grade(id, reviewerAdapter, status, composite)
  if (status === 'complete' && composite !== null) {
    db.db().prepare('update tasks set quality_review_count = 1 where id = ?').run(id)
  }
  return id
}

function worker(id: string, adapterId: string): void {
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?, 1, 0, 1, 'worker', ?)`
    )
    .run(id, id, adapterId, join(dir, id), Date.now())
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-reviewqueue-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quality = await import('./quality.js')
  review = await import('./review.js')
  reviewer = await import('./reviewer.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'queue.db'))
  worker('w-claude', 'claude-code')
  worker('w-antigravity', 'antigravity-cli')
})

beforeEach(() => {
  db.db().exec('delete from quality_reviews')
  db.db().exec('delete from runs')
  db.db().exec('delete from tasks')
  seq = 0
})

afterAll(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('which finished work has been graded', () => {
  it('buckets finished tasks by how many grades they carry', () => {
    task()
    task()
    graded('antigravity-cli')
    const both = task()
    grade(both, 'antigravity-cli', 'complete', 7)
    grade(both, 'openai-compatible', 'complete', 9)
    db.db().prepare('update tasks set quality_review_count = 2 where id = ?').run(both)

    expect(quality.reviewCounts()).toEqual({ none: 2, one: 1, many: 1, total: 4 })
  })

  it('counts a task nobody has finished, or nobody has run, in no bucket at all', () => {
    // ⛔ Not gradeable, so not on this page: a cancelled task has no result to judge, and a task
    // completed by hand has no agent work to grade. Counting them would put rows on the page that
    // every batch would then skip for ever.
    seq += 1
    db.db()
      .prepare(
        `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                            quality_review_count, created_at, updated_at)
         values ('by-hand', 999, 'no runs', 'completed', '{}','{}','{}', 0, 1, 1)`
      )
      .run()
    expect(quality.reviewCounts()).toEqual({ none: 0, one: 0, many: 0, total: 0 })
  })

  it('pages one bucket and reports the total behind it', async () => {
    task()
    task()
    graded('antigravity-cli')
    const page = await quality.reviewQueue('none', 1, 0)
    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(2)
    expect(page.counts.one).toBe(1)
  })

  it('names who has already graded a task, so the row says why nobody else may', async () => {
    const id = graded('antigravity-cli')
    const [row] = (await quality.reviewQueue('one')).rows
    expect(row?.taskId).toBe(id)
    expect(row?.gradedBy).toEqual(['antigravity-cli'])
    expect(row?.reviewCount).toBe(1)
  })
})

describe('an agent is asked about a task at most once', () => {
  it('burns an adapter that produced a score', () => {
    const id = graded('antigravity-cli')
    expect([...review.gradedAdaptersOf(id)]).toEqual(['antigravity-cli'])
  })

  it('⛔ does not burn an adapter whose review failed — it never answered', () => {
    const id = task()
    grade(id, 'antigravity-cli', 'failed', null)
    expect([...review.gradedAdaptersOf(id)]).toEqual([])
  })

  it('⛔ does not burn an adapter whose review completed with nothing scored', () => {
    // ⚠️ `tasks.quality_review_count` does not count this one either, so the two numbers agree. If
    // they did not, the page would show an ungraded task with nobody left to ask about it.
    const id = task()
    grade(id, 'antigravity-cli', 'complete', null)
    expect([...review.gradedAdaptersOf(id)]).toEqual([])
  })

  it('leaves a task nobody has graded with a peer that could', () => {
    const id = task({ adapter: 'claude-code' })
    expect(reviewer.reviewerAvailability(taskRow(id)).eligible).toBe(true)
  })

  it('⛔ reports no eligible review agent once the only peer has graded it, and says why', async () => {
    const id = graded('antigravity-cli')
    const availability = reviewer.reviewerAvailability(taskRow(id))
    expect(availability.eligible).toBe(false)
    // ⛔ Never a bare "unavailable": both peers are named with their own reason, so an operator can
    // tell "commission another agent" from "wait".
    expect(availability.reason).toContain('did this work')
    expect(availability.reason).toContain('already graded this task')

    const [row] = (await quality.reviewQueue('one')).rows
    expect(row?.eligible).toBe(false)
    expect(row?.ineligibleReason).toContain('already graded this task')
  })
})

describe('what a batch would attempt', () => {
  it('takes only tasks under the threshold, strictly', () => {
    const none = task()
    graded('antigravity-cli')
    expect(quality.batchCandidates(1, null).map((c) => c.taskId)).toEqual([none])
    expect(quality.batchCandidates(2, null).map((c) => c.taskId).sort()).toHaveLength(2)
  })

  it('takes the newest first, because an old commit range is the one that will not resolve', () => {
    const older = task()
    const newer = task()
    void older
    expect(quality.batchCandidates(1, 1).map((c) => c.taskId)).toEqual([newer])
  })

  it('caps ALL rather than letting it be unbounded', () => {
    for (let i = 0; i < 3; i += 1) task()
    // ⚠️ ALL is `null`, and it is still bounded — 500 — because an unbounded queue on a fleet with a
    // year of history is a request nobody meant to make.
    expect(quality.batchCandidates(1, null)).toHaveLength(3)
  })
})

/** The task row the availability read wants. ⚠️ Read through the store, not assembled here. */
function taskRow(id: string): import('@shared/tasks.js').Task {
  const found = tasks.getTask(id)
  if (!found) throw new Error(`no task ${id}`)
  return found
}
