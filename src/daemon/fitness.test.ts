import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Fitness: the benchmark prior blended with this fleet's own clean peer reviews.
 *
 * ⛔ What this pins: the blend moves only a little on one review and most of the way on twenty, each
 * of the three degenerate cases answers exactly what `fitness.ts` documents, the adapter-wide rung
 * answers when the exact key has nothing, and — the one easy way to get this wrong — a key with ten
 * reviews of which two are clean shrinks as though it had two, never ten.
 */

let dir: string
let db: typeof import('./db.js')
let fitness: typeof import('./fitness.js')

let seq = 0

function review(input: {
  adapter: string
  model: string | null
  composite: number
  mixed?: boolean
  leak?: boolean
}): void {
  seq += 1
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
       values (?,?,?,?,?,?,?,?,?,'[]','[]', '{}', ?, 'complete', '1.0', 1, ?, ?, ?)`
    )
    .run(
      `review-${seq}`,
      `task-${seq}`,
      `run-${seq}`,
      'worker-1',
      'openai-compatible',
      'gpt-5.4-mini',
      input.adapter,
      input.model,
      input.mixed ? 1 : 0,
      input.composite,
      input.leak ? 1 : 0,
      seq,
      seq
    )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-fitness-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  fitness = await import('./fitness.js')
  db.openDb(join(dir, 'fitness.db'))
})

beforeEach(() => {
  db.db().exec('delete from quality_reviews')
  db.db().exec('delete from tasks')
  seq = 0
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('fitnessFor', () => {
  it('rests on the prior alone when nothing has been graded', () => {
    const f = fitness.fitnessFor('claude-code', 'claude-opus-5')
    expect(f.prior).not.toBeNull()
    expect(f.measured).toBeNull()
    expect(f.samples).toBe(0)
    expect(f.value).toBeCloseTo(f.prior!, 6)
    expect(f.basis.toLowerCase()).toContain('nothing has been graded')
  })

  it('rests on the reviews alone when no benchmark prior exists for the model', () => {
    const unbenchmarked = 'a-model-no-leaderboard-has-ever-heard-of'
    for (let i = 0; i < 5; i++) review({ adapter: 'claude-code', model: unbenchmarked, composite: 9 })
    const f = fitness.fitnessFor('claude-code', unbenchmarked)
    expect(f.prior).toBeNull()
    expect(f.measured).toBeCloseTo(0.9, 6)
    expect(f.samples).toBe(5)
    expect(f.value).toBeCloseTo(0.9, 6)
    expect(f.basis.toLowerCase()).toContain('no benchmark prior')
  })

  it('is null — never 0, never 0.5 — when neither a prior nor a review exists', () => {
    const f = fitness.fitnessFor('claude-code', 'a-model-nobody-has-ever-heard-of')
    expect(f.prior).toBeNull()
    expect(f.measured).toBeNull()
    expect(f.value).toBeNull()
    expect(f.basis.toLowerCase()).toContain('neither')
  })

  it('one clean review barely moves the value off the prior', () => {
    const before = fitness.fitnessFor('claude-code', 'claude-opus-5')
    // A deliberately low composite (measured = 0.1) far from the prior (0.846), so any pull toward
    // it would be obvious if K were not doing its job.
    review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 1 })
    const after = fitness.fitnessFor('claude-code', 'claude-opus-5')
    expect(after.samples).toBe(1)
    expect(after.value).not.toBeNull()
    expect(after.value!).toBeLessThan(before.value!)
    // K=8 keeps a single review from pulling the value past the midpoint: it lands closer to the
    // prior than to what the one review said.
    expect(Math.abs(after.value! - before.value!)).toBeLessThan(Math.abs(after.value! - 0.1))
  })

  it('twenty clean reviews pull the value most of the way to the measured number', () => {
    for (let i = 0; i < 20; i++) review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 1 })
    const f = fitness.fitnessFor('claude-code', 'claude-opus-5')
    expect(f.samples).toBe(20)
    expect(f.measured).toBeCloseTo(0.1, 6)
    // Now the value sits much closer to what was measured (0.1) than to the prior (0.846).
    expect(Math.abs(f.value! - 0.1)).toBeLessThan(Math.abs(f.value! - f.prior!))
  })

  it('shrinks on the clean count, not the raw sample count', () => {
    // Ten reviews, eight of them mixed-authorship — dirty evidence, excluded from `clean`.
    for (let i = 0; i < 8; i++) {
      review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 1, mixed: true })
    }
    for (let i = 0; i < 2; i++) review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 1 })
    const dirty = fitness.fitnessFor('claude-code', 'claude-opus-5')
    expect(dirty.samples).toBe(2)

    db.db().exec('delete from quality_reviews')
    db.db().exec('delete from tasks')
    seq = 0
    for (let i = 0; i < 2; i++) review({ adapter: 'claude-code', model: 'claude-opus-5', composite: 1 })
    const clean = fitness.fitnessFor('claude-code', 'claude-opus-5')

    // Same clean count, same value — the eight dirty reviews must not have shrunk it any further.
    expect(dirty.value).toBeCloseTo(clean.value!, 6)
  })

  it('falls back to the adapter-wide rung when the exact model has no reviews', () => {
    for (let i = 0; i < 6; i++) review({ adapter: 'claude-code', model: null, composite: 1 })
    const f = fitness.fitnessFor('claude-code', 'claude-opus-5')
    expect(f.samples).toBe(6)
    expect(f.basis.toLowerCase()).toContain('adapter-wide')
  })
})

describe('fitnessTable', () => {
  it('covers every model every built-in adapter can price', () => {
    const table = fitness.fitnessTable()
    expect(table.length).toBeGreaterThan(20)
    expect(table.some((f) => f.adapterId === 'claude-code' && f.model === 'claude-opus-5')).toBe(true)
    expect(table.some((f) => f.adapterId === 'local-llm')).toBe(true)
  })
})
