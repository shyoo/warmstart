import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
let adapters: typeof import('./adapters/index.js')

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
function grade(
  taskId: string,
  reviewerAdapter: string,
  status: string,
  composite: number | null,
  reviewerModel: string | null = 'm'
): void {
  seq += 1
  db.db()
    .prepare(
      `insert into quality_reviews
         (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, reviewer_model,
          subject_adapter, subject_model, mixed_authorship, authorship_json, notable_json,
          scores_json, composite, status, rubric_version, blinded, blinding_leak,
          created_at, completed_at)
       values (?,?,?,?,?,?,'claude-code','claude-sonnet-5',0,'[]','[]','{}',?,?,'1.0',1,0,?,?)`
    )
    .run(
      `q-${seq}`,
      taskId,
      `run-${seq}`,
      `w-${reviewerAdapter}`,
      reviewerAdapter,
      reviewerModel,
      composite,
      status,
      seq,
      seq
    )
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
  adapters = await import('./adapters/index.js')
  // ⛔ L1 does not inherit a host capability. The batch gate correctly checks whether a reviewer
  // can launch now; this fixture establishes that precondition without requiring Antigravity in CI.
  vi.spyOn(adapters.adapter('antigravity-cli'), 'isInstalled').mockReturnValue(true)
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
    expect(row?.gradedBy).toEqual([{ adapterId: 'antigravity-cli', model: 'm' }])
    expect(row?.reviewCount).toBe(1)
  })

  /**
   * ⛔ The reason a grade is credited to a model and not to an adapter id: `openai-compatible` is
   * Codex on one account and a small model on a local endpoint on another, and *graded by
   * openai-compatible* names neither of them.
   */
  it('credits the model that graded, not just the adapter it was reached through', async () => {
    const id = task()
    grade(id, 'openai-compatible', 'complete', 8, 'gpt-5.6-terra')
    grade(id, 'openai-compatible', 'complete', 4, 'qwen3-coder-30b-a3b')
    db.db().prepare('update tasks set quality_review_count = 2 where id = ?').run(id)
    const [row] = (await quality.reviewQueue('many')).rows
    expect(row?.gradedBy).toEqual([
      { adapterId: 'openai-compatible', model: 'gpt-5.6-terra' },
      { adapterId: 'openai-compatible', model: 'qwen3-coder-30b-a3b' }
    ])
  })

  it('says a review that never recorded its model recorded none, rather than guessing one', async () => {
    const id = task()
    grade(id, 'antigravity-cli', 'complete', 7, null)
    db.db().prepare('update tasks set quality_review_count = 1 where id = ?').run(id)
    expect((await quality.reviewQueue('one')).rows[0]?.gradedBy).toEqual([
      { adapterId: 'antigravity-cli', model: null }
    ])
  })

  it("carries the adapters' own display names, so no table in the renderer has to know them", async () => {
    const page = await quality.reviewQueue('none')
    // ⚠️ Whatever this build loaded — the assertion is that they are *sent*, not which exist.
    expect(typeof page.adapterLabels).toBe('object')
    for (const [id, label] of Object.entries<string>(page.adapterLabels)) {
      expect(id.length).toBeGreaterThan(0)
      expect(label.length).toBeGreaterThan(0)
    }
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

    const filtered = await quality.reviewQueue('one', 25, 0, true)
    expect(filtered.rows).toHaveLength(0)
    expect(filtered.total).toBe(0)
    expect(filtered.counts.ungradable).toBe(1)
  })
})

describe('what a batch would attempt', () => {
  it('takes only tasks under the threshold, strictly', async () => {
    worker('w-openai', 'openai-compatible')
    try {
      const none = task()
      graded('antigravity-cli')
      expect((await quality.batchCandidates(1, null)).map((c) => c.taskId)).toEqual([none])
      expect((await quality.batchCandidates(2, null)).map((c) => c.taskId).sort()).toHaveLength(2)
    } finally {
      db.db().exec("delete from workers where id = 'w-openai'")
    }
  })

  it('takes the newest first, because an old commit range is the one that will not resolve', async () => {
    const older = task()
    const newer = task()
    void older
    expect((await quality.batchCandidates(1, 1)).map((c) => c.taskId)).toEqual([newer])
  })

  it('caps ALL rather than letting it be unbounded', async () => {
    for (let i = 0; i < 3; i += 1) task()
    // ⚠️ ALL is `null`, and it is still bounded — 500 — because an unbounded queue on a fleet with a
    // year of history is a request nobody meant to make.
    expect(await quality.batchCandidates(1, null)).toHaveLength(3)
  })

  it('skips tasks that cannot be graded', async () => {
    // A task authored by claude-code that was already graded by antigravity-cli has no eligible peers left
    const t = task()
    grade(t, 'antigravity-cli', 'complete', 8.5)
    // threshold 2 would match it if not checking eligibility
    const candidates = await quality.batchCandidates(2, null)
    expect(candidates.map((c) => c.taskId)).not.toContain(t)
  })

  it('skips tasks whose only peer is at 100% quota', async () => {
    worker('w-openai-quota', 'openai-compatible')
    try {
      // Record 100% 5h quota for the only other worker
      const now = Date.now()
      db.db()
        .prepare(
          `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
           values (?, '5h', '5h', 100, null, 'probe', ?)`
        )
        .run('w-openai-quota', now)

      const t = task()
      grade(t, 'antigravity-cli', 'complete', 8.5)
      // w-openai-quota is the only peer, but at 100% quota
      const candidates = await quality.batchCandidates(2, null)
      expect(candidates.map((c) => c.taskId)).not.toContain(t)
    } finally {
      db.db().exec("delete from workers where id = 'w-openai-quota'")
      db.db().exec("delete from quota_samples where worker_id = 'w-openai-quota'")
    }
  })
})

/** The task row the availability read wants. ⚠️ Read through the store, not assembled here. */
function taskRow(id: string): import('@shared/tasks.js').Task {
  const found = tasks.getTask(id)
  if (!found) throw new Error(`no task ${id}`)
  return found
}
