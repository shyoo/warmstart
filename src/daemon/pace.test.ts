import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * How long an agent takes, learned per model.
 *
 * ⛔ What these pin is the shape of the claim, not a measurement: a factor that rests on one task
 * must not be allowed to say what a factor resting on thirty says, an unmeasured key must score
 * exactly zero rather than something plausible, and the number must be built from *active* time so
 * that a task which sat overnight waiting for a person is not recorded as an agent that took
 * overnight. Every one of those is a way this term could be confidently wrong.
 */

let dir: string
let db: typeof import('./db.js')
let pace: typeof import('./pace.js')

const MIN = 60_000
const T0 = 1_756_000_000_000

let seq = 0

/**
 * One completed task with one completed run of a given duration.
 *
 * ⚠️ Runs are laid end to end from `T0` so no two overlap: overlap is `activetime.ts`'s business and
 * would make these durations mean something other than what they say.
 */
function finishedTask(input: {
  adapter: string
  model: string | null
  activeMs: number
  status?: string
  outcome?: string
}): string {
  seq += 1
  const taskId = `task-${seq}`
  const startedAt = T0 + seq * 24 * 3_600_000
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?,?,?,?,'{}','{}','{}',?,?)`
    )
    .run(taskId, seq, `t${seq}`, input.status ?? 'completed', startedAt, startedAt + input.activeMs)
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, adapter_id, model,
                         kind, quota_unverified)
       values (?,?,?,?,?,?,?,?,'work',0)`
    )
    .run(
      `run-${seq}`,
      taskId,
      'worker-1',
      startedAt,
      startedAt + input.activeMs,
      input.outcome ?? 'completed',
      input.adapter,
      input.model
    )
  return taskId
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-pace-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  pace = await import('./pace.js')
  db.openDb(join(dir, 'pace.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values ('worker-1', 'W', 'claude-code', ?, 1, 0, 1, 'worker', ?)`
    )
    .run(join(dir, 'w1'), Date.now())
})

beforeEach(() => {
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

describe('the pace value', () => {
  it('is zero at the fleet centre, and zero is also what unmeasured means', () => {
    expect(pace.paceValue(1)).toBe(0)
  })

  it('is positive for faster and negative for slower, saturating at a factor of four', () => {
    expect(pace.paceValue(0.25)).toBeCloseTo(1, 10)
    expect(pace.paceValue(4)).toBeCloseTo(-1, 10)
    // ⛔ Clamped, because beyond 4x the difference stops being information about the agent.
    expect(pace.paceValue(0.01)).toBe(1)
    expect(pace.paceValue(100)).toBe(-1)
  })

  it('is symmetric in log space: half the time and twice the time are equal and opposite', () => {
    expect(pace.paceValue(0.5)).toBeCloseTo(-pace.paceValue(2), 10)
  })

  it('refuses a nonsensical factor rather than producing NaN', () => {
    expect(pace.paceValue(0)).toBe(0)
    expect(pace.paceValue(-3)).toBe(0)
  })
})

describe('shrinkage', () => {
  it('leaves a one-sample ratio barely moved from 1, so one task cannot mint a multiplier', () => {
    const shrunk = pace.shrinkPace(8, 1)
    expect(shrunk).toBeGreaterThan(1)
    // 8^(1/5) ≈ 1.52 — a direction, not a verdict.
    expect(shrunk).toBeLessThan(2)
  })

  it('lets a well-sampled key keep most of what it measured', () => {
    expect(pace.shrinkPace(8, 40)).toBeGreaterThan(6)
  })

  it('pulls a fast key and a slow key by the same proportion', () => {
    // ⛔ In log space. A linear pull would leave ×2 nearly untouched while dragging ×0.5 to 1, which
    // would invert which agent looked faster on a two-agent fleet.
    expect(pace.shrinkPace(2, 6) * pace.shrinkPace(0.5, 6)).toBeCloseTo(1, 10)
  })
})

describe('the factors, learned from finished tasks', () => {
  it('separates two agents whose tasks took an order of magnitude apart', () => {
    for (let i = 0; i < 10; i += 1) {
      finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 10 * MIN })
      finishedTask({ adapter: 'antigravity-cli', model: 'gemini-3.7', activeMs: 100 * MIN })
    }
    const factors = pace.paceFactors()
    const fast = pace.paceFor(factors, 'claude-code', 'claude-sonnet-5')
    const slow = pace.paceFor(factors, 'antigravity-cli', 'gemini-3.7')
    expect(fast.factor).toBeLessThan(1)
    expect(slow.factor).toBeGreaterThan(1)
    // Faster earns score, slower loses it — the whole point of the term.
    expect(pace.paceValue(fast.factor)).toBeGreaterThan(0)
    expect(pace.paceValue(slow.factor)).toBeLessThan(0)
  })

  it('scores a key nothing has finished on at exactly zero, never at a plausible guess', () => {
    finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 10 * MIN })
    const factors = pace.paceFactors()
    const unknown = pace.paceFor(factors, 'openai-compatible', 'gpt-5.4')
    expect(unknown.samples).toBe(0)
    expect(unknown.factor).toBe(1)
    expect(pace.paceValue(unknown.factor)).toBe(0)
    expect(unknown.basis).toMatch(/unmeasured scores 0, never a guess/)
  })

  it('falls back to the account’s other models before calling a new model average', () => {
    for (let i = 0; i < 8; i += 1) {
      finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 5 * MIN })
      finishedTask({ adapter: 'antigravity-cli', model: 'gemini-3.7', activeMs: 200 * MIN })
    }
    const factors = pace.paceFactors()
    const newModel = pace.paceFor(factors, 'claude-code', 'claude-opus-5')
    expect(newModel.samples).toBeGreaterThan(0)
    expect(newModel.factor).toBeLessThan(1)
    expect(newModel.basis).toMatch(/other models are pooled/)
  })

  it('counts only completed tasks, so an interrupted one does not make its agent look slow', () => {
    finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 10 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 600 * MIN, status: 'cancelled' })
    const factors = pace.paceFactors()
    expect(factors.samples).toBe(1)
    expect(pace.paceFor(factors, 'claude-code', 'claude-sonnet-5').medianActiveMs).toBe(10 * MIN)
  })

  it('ignores a task that finished in seconds, which is evidence about nothing', () => {
    finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 20 * 1000 })
    expect(pace.paceFactors().samples).toBe(0)
  })

  it('publishes a basis that names the numbers behind the factor', () => {
    for (let i = 0; i < 5; i += 1) {
      finishedTask({ adapter: 'claude-code', model: 'claude-sonnet-5', activeMs: 30 * MIN })
    }
    const measured = pace.paceFor(pace.paceFactors(), 'claude-code', 'claude-sonnet-5')
    expect(measured.basis).toMatch(/median active time over 5 finished task/)
    expect(measured.basis).toMatch(/shrunk to/)
  })
})
