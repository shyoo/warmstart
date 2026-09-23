import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Analytics › Statistics: the descriptive report.
 *
 * ⛔ **What these pin is the shape of the claim.** Every number on this page is a *description* of
 * what happened, sitting one nav item away from three pages of numbers that are deliberately
 * shrunk, blended and clamped — so the ways this can be wrong are all ways it could quietly become
 * one of those: a zero standing in for an unknown, a level summed from the level below it instead of
 * re-folded, a percentile that has silently dropped the tail it exists to show.
 *
 * ⚠️ The arithmetic is tested directly and the folding through a real database, because those are
 * the two things that can be wrong in an interesting way. The SQL that reads two hundred rows out of
 * `tasks` is not.
 */

let dir: string
let db: typeof import('./db.js')
let stats: typeof import('./statistics.js')
let price: typeof import('./price.js')

const T0 = 1_756_000_000_000
const MIN = 60_000

let seq = 0

/**
 * One completed task with one completed run, and the session that carries its effort.
 *
 * ⚠️ Runs are laid end to end so no two overlap — overlap is `activetime.ts`'s business, and letting
 * two runs share a moment would make these durations mean something other than what they say.
 */
function finishedTask(input: {
  adapter: string
  model: string | null
  effort?: string | null
  activeMs: number
  status?: string
  outcome?: string
  /** Set to give the run a priceable window movement. Omitted leaves the task unpriced. */
  costModel?: string
  /** Percent of the billing window the run is to be seen to have consumed. */
  windowPercent?: number
}): string {
  seq += 1
  const taskId = `task-${seq}`
  const sessionId = `session-${seq}`
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
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, effort, started_at)
       values (?, 'worker-1', ?, 'stream', ?, 'closed', 'work', ?, ?)`
    )
    .run(sessionId, input.adapter, dir, input.effort ?? null, startedAt)
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, session_id, started_at, ended_at, outcome,
                         adapter_id, model, kind, quota_unverified, list_usd,
                         cost_model_id, quota_before_json, quota_after_json)
       values (?,?, 'worker-1', ?,?,?,?,?,?,'work',0,null,?,?,?)`
    )
    .run(
      `run-${seq}`,
      taskId,
      sessionId,
      startedAt,
      startedAt + input.activeMs,
      input.outcome ?? 'completed',
      input.adapter,
      input.model,
      input.costModel ?? null,
      input.costModel ? quotaJson(startedAt, 0) : null,
      input.costModel ? quotaJson(startedAt + input.activeMs, input.windowPercent ?? 5) : null
    )
  return taskId
}

/** One reading of the weekly window, in the shape `price.ts` reads off a run. */
function quotaJson(at: number, percent: number): string {
  return JSON.stringify({
    windows: [{ id: 'weekly', label: 'Weekly', percent, resetsAt: null }],
    sampledAt: at,
    stale: false
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-statistics-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  stats = await import('./statistics.js')
  price = await import('./price.js')
  db.openDb(join(dir, 'statistics.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, identity_json, created_at)
       values ('worker-1', 'W', 'claude-code', ?, 1, 0, 1, 'worker', ?, ?)`
    )
    .run(join(dir, 'w1'), '{"subscriptionType":"pro"}', Date.now())
})

beforeEach(() => {
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from tasks')
  db.db().exec('delete from quality_reviews')
  db.db().exec('delete from spend_samples')
  price.bumpPricingEpoch()
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

describe('percentiles', () => {
  it('answers the ordinary median, so it cannot disagree with pace.ts about the same data', () => {
    // ⛔ The reason for linear interpolation rather than nearest-rank. `pace.ts` averages the two
    //    middle values; two medians of one dataset differing by a definition nobody printed is the
    //    kind of unexplained disagreement this codebase treats as a fault.
    expect(stats.percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(stats.percentile([1, 2, 3], 50)).toBe(2)
  })

  it('answers the maximum at p100, because the worst case is the point of the column', () => {
    expect(stats.percentile([1, 2, 3, 40], 100)).toBe(40)
  })

  it('is a real answer on one sample rather than null or NaN', () => {
    expect(stats.percentile([7], 50)).toBe(7)
    expect(stats.percentile([7], 99)).toBe(7)
  })

  it('says nothing when it has been given nothing', () => {
    expect(stats.percentile([], 50)).toBeNull()
  })

  it('keeps the tail: a single outlier moves p100 and barely moves p50', () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100]
    expect(stats.percentile(values, 50)).toBe(1)
    expect(stats.percentile(values, 100)).toBe(100)
  })
})

describe('a distribution', () => {
  it('reports every column as null on no samples, never as zero', () => {
    // ⛔ `$0.00` is a claim that something was measured and came to nothing. Nothing was measured.
    expect(stats.distributionOf([])).toEqual({
      samples: 0,
      average: null,
      p50: null,
      p99: null,
      p100: null
    })
  })

  it('does not disturb the caller’s array, which is read again for other levels', () => {
    const values = [3, 1, 2]
    stats.distributionOf(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('averages and orders independently, so a skewed sample shows both', () => {
    const d = stats.distributionOf([1, 1, 1, 97])
    expect(d.average).toBe(25)
    expect(d.p50).toBe(1)
    expect(d.p100).toBe(97)
  })
})

describe('which layers of money a group was billed against', () => {
  it('calls a group with no priced task unknown, which is not a synonym for free', () => {
    expect(stats.basisOf([{ subscription: null, overage: null }])).toBe('unknown')
  })

  it('separates an amortised subscription share from money billed on top', () => {
    expect(stats.basisOf([{ subscription: 0.4, overage: null }])).toBe('subscription')
    expect(stats.basisOf([{ subscription: 0, overage: 1.2 }])).toBe('api')
  })

  it('calls a group carrying both mixed, which is what an account crossing into overage does', () => {
    expect(
      stats.basisOf([
        { subscription: 0.4, overage: 0 },
        { subscription: 0, overage: 1.2 }
      ])
    ).toBe('mixed')
  })

  it('classifies on a strict positive, not on a rounded cent', () => {
    // ⚠️ A task billed fourteen thousandths of a dollar of real overage was billed at an API rate.
    //    Rounding first would file it as pure subscription on the strength of a display decision.
    expect(stats.basisOf([{ subscription: 0, overage: 0.0014 }])).toBe('api')
  })

  it('reads a priced group that came to nothing as subscription, not as unknown', () => {
    // A free local endpoint is measured and nothing was billed on top; that is a verdict.
    expect(stats.basisOf([{ subscription: 0, overage: 0 }])).toBe('subscription')
  })
})

describe('the sample set', () => {
  it('reads completed tasks only', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN, status: 'cancelled' })
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN, status: 'failed' })
    // ⛔ A cancelled or failed task stopped for reasons that say nothing about what work on that
    //    agent costs or takes; folding them in makes the most-interrupted agent look cheapest.
    expect(stats.samples().length).toBe(1)
  })

  it('drops a task no run can be credited to rather than pooling it under an unnamed agent', () => {
    const orphan = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN })
    db.db().prepare('update runs set adapter_id = null where task_id = ?').run(orphan)
    expect(stats.samples()).toEqual([])
  })

  it('credits a task to the agent of its last non-failed work run, as review.ts grades it', () => {
    const taskId = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN })
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, adapter_id,
                           model, kind, quota_unverified)
         values ('later', ?, 'worker-1', ?, ?, 'completed', 'openai-compatible', 'gpt', 'work', 0)`
      )
      .run(taskId, T0 + 90 * 24 * 3_600_000, T0 + 90 * 24 * 3_600_000 + MIN)
    expect(stats.samples()[0]?.adapterId).toBe('openai-compatible')
  })

  it('leaves out a task an operator has excluded from the fleet’s statistics', () => {
    // ⛔ The escape hatch for a measurement that is wrong. It has to reach all three tabs from one
    //    place: price, duration and grade are folded over the same sample set precisely so they
    //    cannot disagree about which tasks exist.
    const kept = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 5 * MIN })
    const dropped = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 900 * MIN })
    db.db().prepare('update tasks set stats_excluded = 1 where id = ?').run(dropped)
    expect(stats.samples().map((s: { taskId: string }) => s.taskId)).toEqual([kept])
  })

  it('carries the effort off the crediting run’s session, which is where effort lives', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 5 * MIN })
    expect(stats.samples()[0]?.effort).toBe('high')
  })

  it('stops at the last 200 finished tasks by default, and at nothing when asked for all', () => {
    // t361: a fleet past its two-hundredth task was reading a window that quietly dropped its oldest
    // work, with nothing on the page but a number saying so.
    for (let i = 0; i < 203; i++) {
      finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: MIN })
    }
    const recent = stats.statisticsReport(Date.now(), 'recent')
    expect(recent.sampleLimit).toBe(200)
    expect(recent.window).toBe('recent')
    expect(recent.price.tasks).toBe(200)

    const all = stats.statisticsReport(Date.now(), 'all')
    expect(all.sampleLimit).toBeNull()
    expect(all.window).toBe('all')
    expect(all.price.tasks).toBe(203)
    // ⚠️ And the default is the bounded read, so nothing that never asked gets an unbounded one.
    expect(stats.statisticsReport().price.tasks).toBe(200)
  })
})

describe('the agent → model → effort tree', () => {
  it('folds each level from the raw samples, never from the level below it', () => {
    // ⛔ A median of medians is not a median and a p99 of p99s is not anything at all. The agent row
    //    has to re-fold the four tasks, not average its two model rows.
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 1 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 3 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'haiku', activeMs: 5 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'haiku', activeMs: 7 * MIN })

    const rows = stats.statisticsReport().velocity.rows
    const agent = rows.find((r) => r.level === 'agent')
    expect(agent?.distribution.samples).toBe(4)
    expect(agent?.distribution.p50).toBe(4 * MIN)
    expect(agent?.distribution.p100).toBe(7 * MIN)

    const opus = rows.find((r) => r.level === 'model' && r.label === 'opus')
    expect(opus?.distribution.samples).toBe(2)
    expect(opus?.distribution.p50).toBe(2 * MIN)
  })

  it('gives a model that ran at two efforts a row for each', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 6 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'low', activeMs: 2 * MIN })
    const efforts = stats.statisticsReport().velocity.rows.filter((r) => r.level === 'effort')
    expect(efforts.map((r) => r.label).sort()).toEqual(['high', 'low'])
  })

  it('suppresses a lone effort row, which would only restate its parent', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 6 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 2 * MIN })
    expect(stats.statisticsReport().velocity.rows.filter((r) => r.level === 'effort')).toEqual([])
  })

  it('gives a task whose effort was never recorded no effort row at all', () => {
    // ⛔ A `?` level under a model is a bucket nobody can act on, sitting in the table looking like a
    //    setting somebody chose.
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: null, activeMs: 6 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 2 * MIN })
    expect(stats.statisticsReport().velocity.rows.filter((r) => r.level === 'effort')).toEqual([])
  })

  it('keeps two agents apart rather than pooling the fleet', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 2 * MIN })
    finishedTask({ adapter: 'openai-compatible', model: 'gpt', activeMs: 8 * MIN })
    const agents = stats.statisticsReport().velocity.rows.filter((r) => r.level === 'agent')
    expect(agents.length).toBe(2)
    expect(agents.map((r) => r.distribution.p50).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      2 * MIN,
      8 * MIN
    ])
  })
})

describe('velocity', () => {
  it('excludes a task that measured no active time, and counts how many it excluded', () => {
    // ⛔ Zero is not a duration. Averaging one in makes whichever agent caught the no-op resumes
    //    look like the fast one.
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 0 })
    const velocity = stats.statisticsReport().velocity
    expect(velocity.tasks).toBe(2)
    expect(velocity.untimed).toBe(1)
    expect(velocity.rows.find((r) => r.level === 'agent')?.distribution.samples).toBe(1)
  })

  it('counts agent time, not the hours a task spent waiting on a person', () => {
    const taskId = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 60 * MIN })
    const startedAt = T0 + 24 * 3_600_000
    db.db()
      .prepare(
        `insert into questions (id, session_id, run_id, task_id, origin, kind, question, asked_at,
                                answered_at)
         values ('q1', ?, 'run-1', ?, 'ask_human', 'text', 'which?', ?, ?)`
      )
      .run(`session-1`, taskId, startedAt + 10 * MIN, startedAt + 40 * MIN)
    // 60 minutes of run, 30 of them spent waiting on a person.
    expect(stats.statisticsReport().velocity.rows[0]?.distribution.p50).toBe(30 * MIN)
  })
})

describe('price', () => {
  const CLAUDE = 'anthropic.subscription.2026-08'

  /** Money really billed on top, over the whole window these tasks run in. */
  function overageMeter(balances: Array<[number, number]>): void {
    const insert = db.db().prepare(
      `insert into spend_samples (worker_id, meter_id, label, unit, balance, direction,
                                  usd_per_unit, source, sampled_at)
       values ('worker-1', 'purse', 'Extra usage', 'usd', ?, 'balance_falls', 1, 'cli', ?)`
    )
    for (const [at, balance] of balances) insert.run(balance, at)
    price.bumpPricingEpoch()
  }

  it('drops a level nothing could be priced at all rather than drawing a table of n/a', () => {
    // ⛔ The count is where the fact belongs. A table of `n/a` reads as a rendering fault, and
    //    dropping the row without saying how many were dropped would hide the gap entirely.
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    const report = stats.statisticsReport().price
    expect(report.rows).toEqual([])
    expect(report.tasks).toBe(1)
    expect(report.unpriced).toBe(1)
  })

  it('prices a task off its window movement and files it as subscription', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    price.bumpPricingEpoch()
    const row = stats.statisticsReport().price.rows.find((r) => r.level === 'agent')
    expect(row?.distribution.samples).toBe(1)
    expect(row?.distribution.p50).toBeGreaterThan(0)
    // ⚠️ Amortised, not cash: nobody was charged this at the moment the run happened.
    expect(row?.basis).toBe('subscription')
    expect(row?.unpriced).toBe(0)
  })

  it('files an agent whose tasks drew on both layers as mixed', () => {
    // ⭐ The state one account crossing into overage mid-month puts every total above it in.
    const plain = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    const billed = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    const at = db.db().prepare('select started_at, ended_at from runs where task_id = ?').get(billed) as {
      started_at: number
      ended_at: number
    }
    overageMeter([
      [at.started_at, 40],
      [at.ended_at, 39.25]
    ])
    void plain
    const row = stats.statisticsReport().price.rows.find((r) => r.level === 'agent')
    expect(row?.distribution.samples).toBe(2)
    expect(row?.basis).toBe('mixed')
  })

  it('splits the model level by billing basis instead of averaging subs with overage', () => {
    // ⛔ The mean of an amortised subscription share and money really billed on top is a number in
    // neither currency. One account crossing into overage mid-month puts the two layers on the
    // same model, so the model level carries one row per basis while the agent level above keeps
    // folding everything (t285).
    const plain = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    const billed = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    const at = db.db().prepare('select started_at, ended_at from runs where task_id = ?').get(billed) as {
      started_at: number
      ended_at: number
    }
    overageMeter([
      [at.started_at, 40],
      [at.ended_at, 39.25]
    ])
    void plain
    const report = stats.statisticsReport().price
    const models = report.rows.filter((r) => r.level === 'model')
    expect(models.map((r) => r.basis).sort()).toEqual(['mixed', 'subscription'])
    expect(models.map((r) => r.distribution.samples).sort()).toEqual([1, 1])
    // ⚠️ Two rows share the model label, so the keys are what keep them apart.
    expect(new Set(models.map((r) => r.key)).size).toBe(2)
    const agent = report.rows.find((r) => r.level === 'agent')
    expect(agent?.basis).toBe('mixed')
    expect(agent?.distribution.samples).toBe(2)
  })

  it('counts an unpriced task in the row it belongs to without folding it into the numbers', () => {
    // ⛔ `unpriced` is not `free`. The row's distribution describes only what could be measured,
    //    and the count beside it is what stops the average reading as the whole story.
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN, costModel: CLAUDE })
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    price.bumpPricingEpoch()
    const row = stats.statisticsReport().price.rows.find((r) => r.level === 'agent')
    expect(row?.distribution.samples).toBe(1)
    expect(row?.unpriced).toBe(1)
  })
})

describe('quality', () => {
  it('offers the benchmark prior as the baseline when nothing has been graded', () => {
    // ⭐ The state the tab exists to be honest about: no review, so the prior is the whole answer.
    finishedTask({ adapter: 'claude-code', model: 'claude-opus-4-1', activeMs: 4 * MIN })
    const quality = stats.statisticsReport().quality
    expect(quality.totalReviews).toBe(0)
    const model = quality.rows.find((r) => r.level === 'model')
    expect(model).toBeDefined()
    expect(model?.cleanComposite).toBeNull()
    expect(model?.clean).toBe(0)
    // ⛔ Whatever the prior resolves to, it must never be 0 standing in for "unknown".
    const prior = model?.prior ?? null
    expect(prior === null || prior > 0).toBe(true)
  })

  it('carries a prior and a fitness on the model level and on no other', () => {
    // ⛔ Both are properties of a *model*. There is no benchmark for `claude-code` in general or
    //    for `high` in particular, and copying the model's number up or down would print it three
    //    times as though it had been measured three ways. The table draws these as a dash rather
    //    than as `unknown`, because *not measured* and *does not exist at this depth* are different
    //    sentences and must not share a cell.
    finishedTask({ adapter: 'claude-code', model: 'claude-opus-4-1', effort: 'high', activeMs: 6 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'claude-opus-4-1', effort: 'low', activeMs: 2 * MIN })
    const rowsOut = stats.statisticsReport().quality.rows
    for (const row of rowsOut.filter((r) => r.level !== 'model')) {
      expect(row.prior, row.level).toBeNull()
      expect(row.fitness, row.level).toBeNull()
    }
    // ⚠️ And the model level really does carry one, or the assertion above passes vacuously.
    expect(rowsOut.filter((r) => r.level === 'model').some((r) => r.prior !== null)).toBe(true)
  })

  it('still counts the tasks and the reviews on every level, which are not model-only', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'high', activeMs: 6 * MIN })
    finishedTask({ adapter: 'claude-code', model: 'opus', effort: 'low', activeMs: 2 * MIN })
    const agent = stats.statisticsReport().quality.rows.find((r) => r.level === 'agent')
    expect(agent?.tasks).toBe(2)
  })

  it('averages the composite over clean reviews and counts the rest separately', () => {
    const clean = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    const leaked = finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    const insert = db.db().prepare(
      `insert into quality_reviews (id, task_id, run_id, reviewer_worker_id, reviewer_adapter,
                                    subject_adapter, subject_model, mixed_authorship, composite,
                                    status, rubric_version, blinded, blinding_leak, created_at)
       values (?,?,'r','worker-1','claude-code','claude-code','opus',0,?, 'complete','v1',1,?,?)`
    )
    insert.run('rev-clean', clean, 8, 0, T0)
    // ⛔ A review whose blinding left a vendor name in the prose was not blind, so it is counted and
    //    excluded from the composite — the gap between the two columns is the point.
    insert.run('rev-leaked', leaked, 2, 1, T0)

    const model = stats.statisticsReport().quality.rows.find((r) => r.level === 'model')
    expect(model?.cleanComposite).toBe(8)
    expect(model?.clean).toBe(1)
    expect(model?.samples).toBe(2)
    // ⭐ The chart folds the same clean composites the mean is over: one review, so every
    //    percentile is that review, and the leaked one is nowhere in it.
    expect(model?.distribution).toEqual({ samples: 1, average: 8, p50: 8, p99: 8, p100: 8 })
  })

  it('carries an empty distribution, never a zero, on a level nothing clean has graded', () => {
    finishedTask({ adapter: 'claude-code', model: 'opus', activeMs: 4 * MIN })
    const model = stats.statisticsReport().quality.rows.find((r) => r.level === 'model')
    expect(model?.distribution).toEqual({ samples: 0, average: null, p50: null, p99: null, p100: null })
  })
})

describe('ordering by power in statistics tree', () => {
  it('orders models from most powerful to least powerful', () => {
    const list = [
      'gemini-3.7-flash-high',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-pro'
    ]
    const sorted = [...list].sort(stats.compareModelPower)
    expect(sorted).toEqual([
      'gemini-3.8-pro',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.7-flash-high'
    ])
  })

  it('puts Codex Astra above Sol and Sol above Terra', () => {
    expect(['gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol'].sort(stats.compareModelPower)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-5.6-sol',
      'gpt-5.6-terra'
    ])
    expect(['claude-opus-5', 'claude-opus-5-5'].sort(stats.compareModelPower)).toEqual([
      'claude-opus-5-5',
      'claude-opus-5'
    ])
  })

  it('orders efforts from highest to lowest', () => {
    const efforts = ['low', 'max', 'medium', 'high', 'xhigh', 'min']
    const sorted = [...efforts].sort(stats.compareEffortPower)
    expect(sorted).toEqual(['max', 'xhigh', 'high', 'medium', 'low', 'min'])
  })

  it('merges dated Claude model ids and omits an unrecorded model level', () => {
    finishedTask({ adapter: 'claude-code', model: 'claude-haiku-4-5-20251001', activeMs: MIN })
    finishedTask({ adapter: 'claude-code', model: 'claude-haiku-4-5', activeMs: 2 * MIN })
    finishedTask({ adapter: 'claude-code', model: null, activeMs: 3 * MIN })

    const rows = stats.statisticsReport().velocity.rows
    const models = rows.filter((row) => row.level === 'model')
    expect(models).toHaveLength(1)
    expect(models[0]?.label).toBe('claude-haiku-4-5')
    expect(models[0]?.distribution.samples).toBe(2)
    expect(rows.find((row) => row.level === 'agent')?.distribution.samples).toBe(3)
  })
})
