import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RubricDimension } from '@shared/review.js'

/**
 * The quality aggregate — what the fleet has measured about each agent.
 *
 * ⛔ What these pin is the two honesty properties the whole page rests on. **A null dimension is
 * skipped, never zeroed**: a pure-CSS change has no tests to grade, and averaging that in as a 0
 * would mark down whichever agent draws the CSS work. And **`clean` excludes what is not evidence**:
 * a review of a task two adapters both worked on says nothing about either, and a review whose
 * blinding leaked a vendor name was not blind. Both are counted and both are visible, so the
 * difference can be checked rather than assumed away.
 */

let dir: string
let db: typeof import('./db.js')
let quality: typeof import('./quality.js')

let seq = 0

function scores(values: Partial<Record<RubricDimension, number | null>>): string {
  const out: Record<string, { score: number | null; rationale: string }> = {}
  for (const [key, score] of Object.entries(values)) {
    out[key] = { score: score ?? null, rationale: 'because' }
  }
  return JSON.stringify(out)
}

function review(input: {
  adapter: string
  model: string | null
  composite: number
  mixed?: boolean
  leak?: boolean
  reviewer?: string
  scoresJson?: string
  status?: string
}): void {
  seq += 1
  // ⚠️ The review's task has to exist: `quality_reviews.task_id` is a real foreign key, so a fixture
  // that skipped it would be testing an aggregate over rows the database would never hold.
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          quality_review_count, created_at, updated_at)
       values (?,?,?, 'completed', '{}','{}','{}', 1, ?, ?)`
    )
    .run(`task-${seq}`, seq, `graded ${seq}`, seq, seq)
  db.db()
    .prepare(
      `insert into quality_reviews
         (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, reviewer_model,
          subject_adapter, subject_model, mixed_authorship, authorship_json, notable_json,
          scores_json, composite, status, rubric_version, blinded, blinding_leak,
          created_at, completed_at)
       values (?,?,?,?,?,?,?,?,?,'[]','[]',?,?,?,'1.0',1,?,?,?)`
    )
    .run(
      `review-${seq}`,
      `task-${seq}`,
      `run-${seq}`,
      'worker-1',
      input.reviewer ?? 'openai-compatible',
      'gpt-5.4-mini',
      input.adapter,
      input.model,
      input.mixed ? 1 : 0,
      input.scoresJson ?? scores({ correctness: input.composite, tests: input.composite }),
      input.composite,
      input.status ?? 'complete',
      input.leak ? 1 : 0,
      seq,
      seq
    )
}

/** A completed task with one work run, which is what makes it gradeable. */
function completedTask(input: { graded: boolean; adapter?: string }): void {
  seq += 1
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          quality_review_count, created_at, updated_at)
       values (?,?,?, 'completed', '{}','{}','{}', ?, ?, ?)`
    )
    .run(`t-${seq}`, seq, `task ${seq}`, input.graded ? 1 : 0, seq, seq)
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, adapter_id, model,
                         kind, quota_unverified)
       values (?,?, 'worker-1', ?, ?, 'completed', ?, 'claude-sonnet-5', 'work', 0)`
    )
    .run(`r-${seq}`, `t-${seq}`, seq, seq + 1, input.adapter ?? 'claude-code')
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quality-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quality = await import('./quality.js')
  db.openDb(join(dir, 'quality.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values ('worker-1', 'W', 'claude-code', ?, 1, 0, 1, 'worker', ?)`
    )
    .run(join(dir, 'w1'), Date.now())
})

beforeEach(() => {
  db.db().exec('delete from quality_reviews')
  db.db().exec('delete from runs')
  db.db().exec('delete from tasks')
  seq = 0
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows holds the file briefly; the temp directory is disposable either way. */
  }
})

describe('per-model quality', () => {
  it('groups by agent and model, because one number for an account is a number for nothing', () => {
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 8 })
    review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 6 })
    const keys = quality.qualityReport().keys
    expect(keys).toHaveLength(2)
    expect(keys.map((k) => k.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('reports the clean mean apart from the all-reviews mean, and both are visible', () => {
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 9 })
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 3, mixed: true })
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 3, leak: true })
    const key = quality.qualityReport().keys[0]
    expect(key?.samples).toBe(3)
    expect(key?.clean).toBe(1)
    expect(key?.composite).toBe(5)
    // ⛔ The clean number is the one to compare agents on, and it is not dragged by the two that are
    // not evidence about this agent at all.
    expect(key?.cleanComposite).toBe(9)
    expect(key?.mixedAuthorship).toBe(1)
    expect(key?.blindingLeaks).toBe(1)
  })

  it('skips a dimension the judge scored null rather than averaging it in as zero', () => {
    review({
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      composite: 8,
      scoresJson: scores({ correctness: 8, tests: null })
    })
    review({
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      composite: 8,
      scoresJson: scores({ correctness: 8, tests: 6 })
    })
    const key = quality.qualityReport().keys[0]
    expect(key?.dimensions.correctness).toBe(8)
    // ⛔ 6, not 3. One review had no tests to grade; averaging its null as a zero would have said
    // this agent writes half the tests it does.
    expect(key?.dimensions.tests).toBe(6)
  })

  it('counts no review that did not produce a number, in either direction', () => {
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 8 })
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 0, status: 'failed' })
    const report = quality.qualityReport()
    expect(report.totalReviews).toBe(1)
    expect(report.keys[0]?.composite).toBe(8)
    expect(report.failures.find((f) => f.status === 'failed')?.count).toBe(1)
  })

  it('publishes what each judge has given, as a calibration check', () => {
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 9, reviewer: 'openai-compatible' })
    review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 5, reviewer: 'antigravity-cli' })
    const reviewers = quality.qualityReport().reviewers
    expect(reviewers).toHaveLength(2)
    expect(reviewers.find((r) => r.adapterId === 'openai-compatible')?.meanGiven).toBe(9)
  })

  it('publishes the rubric it aggregated under, so a weight change cannot reinterpret history', () => {
    const report = quality.qualityReport()
    expect(report.rubricVersion).toBe('1.0')
    expect(report.weights.requirement_fidelity + report.weights.correctness).toBeCloseTo(0.4, 10)
  })
})

describe('ungraded work', () => {
  it('counts finished tasks that carry no grade, and none that do', () => {
    completedTask({ graded: false })
    completedTask({ graded: false })
    completedTask({ graded: true })
    const report = quality.qualityReport()
    expect(report.ungradedTasks).toBe(2)
    expect(report.gradedTasks).toBe(1)
  })

  it('offers no task nothing ever ran on, because there is no agent work to grade', () => {
    seq += 1
    db.db()
      .prepare(
        `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                            quality_review_count, created_at, updated_at)
         values ('t-manual', 99, 'closed by hand', 'completed', '{}','{}','{}', 0, 1, 1)`
      )
      .run()
    expect(quality.qualityReport().ungradedTasks).toBe(0)
    expect(quality.ungradedTasks()).toEqual([])
  })

  it('names who would be graded, so the button is not a blind spend', () => {
    completedTask({ graded: false, adapter: 'antigravity-cli' })
    const [next] = quality.ungradedTasks()
    expect(next?.adapterId).toBe('antigravity-cli')
    expect(next?.model).toBe('claude-sonnet-5')
  })

  it('caps what one press may grade, because each one spends a real turn', () => {
    expect(quality.GRADE_BATCH_MAX).toBe(5)
  })
})
