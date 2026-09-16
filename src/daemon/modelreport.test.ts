import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `routing.models`: every (worker, model) pair the fleet could route to, and what fed its `fitness`
 * and `price` terms.
 *
 * ⛔ What this pins: a row exists for every priced model on a commissioned worker, not only the ones
 * on its allowlist — `routable` is what tells the two apart. A pair nothing has measured renders
 * `n/a` rather than `$0.00` or a guessed fitness. The clean review count feeds the row, never the raw
 * sample count. And a dispatch ledger entry with `basis: 'explore'` is counted separately from an
 * ordinary one, both toward the same pair.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let api: typeof import('./api.js')

let reviewSeq = 0

function review(input: { adapter: string; model: string | null; composite: number; mixed?: boolean }): void {
  reviewSeq += 1
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          quality_review_count, created_at, updated_at)
       values (?,?,?, 'completed', '{}','{}','{}', 1, ?, ?)`
    )
    .run(`mr-task-${reviewSeq}`, reviewSeq, `graded ${reviewSeq}`, reviewSeq, reviewSeq)
  db.db()
    .prepare(
      `insert into quality_reviews
         (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, reviewer_model,
          subject_adapter, subject_model, mixed_authorship, authorship_json, notable_json,
          scores_json, composite, status, rubric_version, blinded, blinding_leak,
          created_at, completed_at)
       values (?,?,?,?,?,?,?,?,?,'[]','[]', '{}', ?, 'complete', '1.0', 1, 0, ?, ?)`
    )
    .run(
      `mr-review-${reviewSeq}`,
      `mr-task-${reviewSeq}`,
      `mr-run-${reviewSeq}`,
      'worker-1',
      'openai-compatible',
      'gpt-5.4-mini',
      input.adapter,
      input.model,
      input.mixed ? 1 : 0,
      input.composite,
      reviewSeq,
      reviewSeq
    )
}

let decisionSeq = 0

/** One `routing_decisions` row whose chosen candidate is `(workerId, model)`. */
function decision(workerId: string, model: string, basis: 'score' | 'explore'): void {
  decisionSeq += 1
  const candidates = [{ chosen: true, workerId, model, label: 'w', adapterId: 'claude-code', warm: false, quotaUnverified: false, score: 1, terms: [] }]
  db.db()
    .prepare(
      `insert into routing_decisions
         (id, task_id, task_seq, task_title, project_id, chosen_worker_id, chosen_label,
          objective_json, weights_json, formulas_json, candidates_json, epsilon, basis, warm, decided_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      `mr-decision-${decisionSeq}`,
      null,
      null,
      'a task',
      null,
      workerId,
      'w',
      '{"cost":0.3,"velocity":0.3,"quality":0.4}',
      '{}',
      '{}',
      JSON.stringify(candidates),
      0.1,
      basis,
      0,
      Date.now()
    )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-modelreport-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'modelreport.db'))
})

beforeEach(() => {
  db.db().exec('delete from routing_decisions')
  db.db().exec('delete from quality_reviews')
  db.db().exec('delete from tasks')
  db.db().exec('delete from quota_samples')
  db.db().exec('delete from workers')
  reviewSeq = 0
  decisionSeq = 0
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('modelReport', () => {
  it('marks the allowlisted model routable and every other priced model on the same worker not', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'ReportWorker' })
    workers.updateWorker(w.id, { routableModels: ['claude-sonnet-5'] })

    const report = api.modelReport()
    const rows = report.rows.filter((r) => r.workerId === w.id)
    expect(rows.length).toBeGreaterThanOrEqual(2)

    const sonnet = rows.find((r) => r.model === 'claude-sonnet-5')
    const opus = rows.find((r) => r.model === 'claude-opus-5')
    expect(sonnet?.routable).toBe(true)
    expect(opus?.routable).toBe(false)
  })

  it('renders n/a (null), never a guess, where nothing has been measured', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'UnmeasuredWorker' })
    const report = api.modelReport()
    const row = report.rows.find((r) => r.workerId === w.id && r.model === 'claude-sonnet-5')
    expect(row).toBeDefined()
    // Nothing has ever completed on this fleet, so the estimator has no key to price from.
    expect(row?.costUsd).toBeNull()
    expect(row?.paceFactor).toBeNull()
    expect(row?.paceSamples).toBe(0)
  })

  it('uses the clean review count, never the raw sample count', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'CleanCountWorker' })
    // Three mixed-authorship reviews (dirty) and two clean ones, all the same composite.
    for (let i = 0; i < 3; i++) review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 8, mixed: true })
    for (let i = 0; i < 2; i++) review({ adapter: 'claude-code', model: 'claude-sonnet-5', composite: 8 })

    const report = api.modelReport()
    const row = report.rows.find((r) => r.workerId === w.id && r.model === 'claude-sonnet-5')
    expect(row?.cleanSamples).toBe(2)
    expect(row?.cleanComposite).toBeCloseTo(8, 6)
  })

  it('counts an explored dispatch separately from an ordinary one, both toward the same pair', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'DispatchCountWorker' })
    decision(w.id, 'claude-sonnet-5', 'score')
    decision(w.id, 'claude-sonnet-5', 'score')
    decision(w.id, 'claude-sonnet-5', 'explore')

    const report = api.modelReport()
    const row = report.rows.find((r) => r.workerId === w.id && r.model === 'claude-sonnet-5')
    expect(row?.dispatches).toBe(3)
    expect(row?.explorations).toBe(1)
  })

  it('carries the leaderboard behind every prior it publishes', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'SourcedWorker' })
    const report = api.modelReport()
    const row = report.rows.find((r) => r.workerId === w.id && r.model === 'claude-opus-5')
    expect(row?.prior).not.toBeNull()
    expect(row?.priorSource).toBeTruthy()
    // ⛔ The name on the row has to resolve in the report's own source list, or the page shows a
    // citation nobody can follow. Only the daemon can read `benchmarks/*.json`, so it ships them.
    const cited = report.benchmarkSources.find((s) => s.name === row?.priorSource)
    expect(cited).toBeDefined()
    expect(cited?.url).toMatch(/^https:\/\//)
    expect(cited?.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('publishes the fitness and price weights and formulas actually in force', () => {
    const report = api.modelReport()
    expect(report.fitnessFormula).toContain('quality')
    expect(report.priceFormula).toContain('cost')
    expect(report.fitnessWeight).toBeGreaterThan(0)
    expect(report.priceWeight).toBeGreaterThan(0)
  })
})
