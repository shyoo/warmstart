import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'

/**
 * The estimator, once it stopped answering one number for every agent.
 *
 * ⛔ What these tests pin is the *separation*: an agent whose runs cost 80x the fleet median must not
 * make every other agent's task look expensive, and must not be called a runaway for costing what it
 * always costs. Measured on this install 2026-08-30, that is not a hypothetical spread —
 * `antigravity-cli/gemini-3.7-flash-medium` medians 12,477,352 tokens a run against
 * `claude-code/claude-sonnet-5` at 153,091.
 *
 * ⚠️ The numbers below are shaped like that measurement but are not it. A test that asserted the
 * real medians would fail the first time somebody ran a task.
 */

let dir: string
let db: typeof import('./db.js')
let costmodel: typeof import('./costmodel.js')
let estimator: typeof import('./estimator.js')
let price: typeof import('./price.js')

const CHEAP_WORKER = 'aaaaaaaa-0000-4000-8000-000000000001'
const DEAR_WORKER = 'aaaaaaaa-0000-4000-8000-000000000002'
const ANTHROPIC = 'anthropic.subscription.2026-08'
const GOOGLE = 'google.antigravity.2026-08'

let seq = 0

/** One completed run, with the shape of a real one: almost all of the total is cache reads. */
function run(input: {
  worker: string
  adapter: string
  model: string | null
  costModel: string
  total: number
  warm?: boolean | null
  project?: string | null
  outcome?: string
  taskId?: string | null
  kind?: string
  /**
   * A real clock span and the window percentages read at each end of it.
   *
   * ⚠️ Money needs all three. `price.ts` anchors a run between the reading before it started and the
   * one after it ended; a run with no such pair prices `n/a`, which is the default here and is the
   * state most of this file's fixtures are deliberately left in.
   */
  priced?: { startedAt: number; endedAt: number; from: number; to: number }
}): void {
  seq += 1
  const output = Math.round(input.total * 0.005)
  const cacheRead = input.total - output
  db.db()
    .prepare(
      `insert into runs (id, task_id, project_id, session_id, worker_id, started_at, outcome,
                         quota_unverified, cost_model_id, started_warm, adapter_id, model,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, kind,
                         ended_at, quota_before_json, quota_after_json)
       values (?,?,?,null,?,?,?,0,?,?,?,?,0,?,?,0,?,?,?,?)`
    )
    .run(
      `run-${seq}`,
      input.taskId ?? null,
      input.project ?? null,
      input.worker,
      input.priced ? input.priced.startedAt : Date.now() + seq,
      input.outcome ?? 'completed',
      input.costModel,
      input.warm === undefined || input.warm === null ? null : input.warm ? 1 : 0,
      input.adapter,
      input.model,
      output,
      cacheRead,
      input.kind ?? 'work',
      input.priced ? input.priced.endedAt : null,
      input.priced ? quota(input.priced.startedAt, input.priced.from) : null,
      input.priced ? quota(input.priced.endedAt, input.priced.to) : null
    )
  // ⛔ Prices are memoised against an epoch, not a clock, and this is the writer that changes them.
  price.bumpPricingEpoch()
}

const T0 = 1_756_000_000_000
const HOUR = 3_600_000

/** One quota reading, in the shape a run carries. */
function quota(at: number, percent: number): string {
  return JSON.stringify({
    windows: [{ id: 'weekly_all', label: 'weekly_all', percent }],
    sampledAt: at,
    stale: false
  })
}

/**
 * ⛔ **A fleet whose money ordering and token ordering disagree, on purpose.**
 *
 * The dear agent burns 80x the tokens per run and one *tenth* the billing window. Nothing measured
 * in priced tokens can produce the money answer here, so any test that comes out the money way is
 * reading the money series and not a proxy for it.
 *
 * ⚠️ Both agents are billed against the Anthropic file, because that is the loaded cost model with
 * a priced subscription plan to divide. The vendor is not what these cases are about.
 */
function pricedFleet(): void {
  let cheap = 0
  let dear = 0
  for (let i = 0; i < 6; i += 1) {
    // Non-overlapping hours: a shared window would split the movement between the two runs across
    // it, which is `price.ts`'s business and not this file's.
    run({
      worker: CHEAP_WORKER,
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      costModel: ANTHROPIC,
      total: 150_000,
      warm: false,
      priced: { startedAt: T0 + i * 4 * HOUR, endedAt: T0 + i * 4 * HOUR + HOUR, from: cheap, to: cheap + 10 }
    })
    cheap += 10
    run({
      worker: DEAR_WORKER,
      adapter: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium',
      costModel: ANTHROPIC,
      total: 12_000_000,
      warm: false,
      priced: {
        startedAt: T0 + i * 4 * HOUR + 2 * HOUR,
        endedAt: T0 + i * 4 * HOUR + 3 * HOUR,
        from: dear,
        to: dear + 1
      }
    })
    dear += 1
  }
}

function task(patch: Partial<Task> = {}): Task {
  return { estTokens: null, projectId: null, ...patch } as Task
}

/** A fleet where one agent costs about eighty times the other, which is what was measured. */
function twoAgents(): void {
  for (let i = 0; i < 12; i += 1) {
    run({
      worker: CHEAP_WORKER,
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      costModel: ANTHROPIC,
      total: 150_000,
      warm: false
    })
    run({
      worker: DEAR_WORKER,
      adapter: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium',
      costModel: GOOGLE,
      total: 12_000_000,
      warm: false
    })
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-estimator-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  costmodel = await import('./costmodel.js')
  estimator = await import('./estimator.js')
  price = await import('./price.js')
  db.openDb(join(dir, 'estimator.db'))
  costmodel.loadCostModels()
  const workers = db
    .db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, identity_json, created_at)
       values (?, ?, ?, ?, 1, 0, 1, 'worker', ?, ?)`
    )
  // ⚠️ Both carry a subscription, because a plan with a monthly fee is what there is to divide; a
  // worker with no identity prices `n/a` however many readings its runs carry.
  workers.run(CHEAP_WORKER, 'Claude', 'claude-code', join(dir, 'w1'), '{"subscriptionType":"pro"}', Date.now())
  workers.run(DEAR_WORKER, 'Antigravity', 'antigravity-cli', join(dir, 'w2'), '{"subscriptionType":"pro"}', Date.now())
})

beforeEach(() => {
  db.db().exec('delete from runs')
  seq = 0
  estimator.resetCostFactors()
  price.bumpPricingEpoch()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what an agent costs', () => {
  it('learns a factor per agent and model, not one median for the fleet', () => {
    twoAgents()
    const factors = estimator.costFactors()
    const dear = factors.keys.find((k) => k.model === 'gemini-3.7-flash-medium')
    const cheap = factors.keys.find((k) => k.model === 'claude-sonnet-5')

    expect(dear?.samples).toBe(12)
    expect(cheap?.samples).toBe(12)
    // ⛔ The one assertion that matters: they are on opposite sides of 1. A fleet median put both on
    // the same side of it and described neither.
    expect(dear?.factor).toBeGreaterThan(2)
    expect(cheap?.factor).toBeLessThan(0.5)
  })

  it('estimates the same task differently depending on who would run it', () => {
    twoAgents()
    const cheap = estimator.estimateTask(task(), { adapterId: 'claude-code', model: 'claude-sonnet-5' })
    const dear = estimator.estimateTask(task(), {
      adapterId: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium'
    })
    expect(dear.tokens).toBeGreaterThan(cheap.tokens * 10)
    // Both say which agent's answer they are, so a number on a screen can be traced back.
    expect(dear.basis).toContain('antigravity-cli/gemini-3.7-flash-medium')
    expect(cheap.basis).toContain('claude-code/claude-sonnet-5')
  })

  it('answers fleet-neutral when nobody says who would run it', () => {
    twoAgents()
    const neutral = estimator.estimateTask(task())
    expect(neutral.factor).toBe(1)
    expect(neutral.basis).not.toContain('×')
  })

  it('pulls a barely-measured key toward 1 rather than believing it', () => {
    twoAgents()
    // One run, ten times the fleet's dearest. ⛔ Shrinkage is the whole defence against a single
    // unlucky run becoming an agent's reputation: nothing here has ever run the same task twice on
    // two agents, so the apparent ratio is not evidence of much.
    run({
      worker: DEAR_WORKER,
      adapter: 'antigravity-cli',
      model: 'gemini-3.1-pro-high',
      costModel: GOOGLE,
      total: 120_000_000
    })
    estimator.resetCostFactors()
    const key = estimator.costFactors().keys.find((k) => k.model === 'gemini-3.1-pro-high')
    expect(key?.samples).toBe(1)
    // ratio^(1/6): a sixth of the distance in the space multipliers actually live in.
    expect(key?.factor).toBeCloseTo(key!.ratio ** (1 / 6), 6)
    expect(key?.factor).toBeLessThan(key!.ratio / 3)
  })

  it('falls back to the adapter when the model was never recorded', () => {
    // 17 of this install's 52 Antigravity runs are in exactly this state: the session that knew the
    // model was closed and rewritten before anything asked it.
    twoAgents()
    const estimate = estimator.estimateTask(task(), {
      adapterId: 'antigravity-cli',
      model: 'gemini-3.6-flash-low'
    })
    expect(estimate.basis).toContain('adapter-wide level')
    expect(estimate.factor).toBeGreaterThan(2)
  })

  it('applies no factor at all for an agent nothing has completed on', () => {
    twoAgents()
    const estimate = estimator.estimateTask(task(), { adapterId: 'openai-compatible' })
    expect(estimate.factor).toBe(1)
    expect(estimate.basis).toContain('nothing has completed on openai-compatible yet')
  })

  it('scales a stated estimate too, because a person estimates the work and not the CLI', () => {
    twoAgents()
    const stated = task({ estTokens: 400_000 })
    const cheap = estimator.estimateTask(stated, { adapterId: 'claude-code', model: 'claude-sonnet-5' })
    const dear = estimator.estimateTask(stated, {
      adapterId: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium'
    })
    expect(cheap.tokens).toBeLessThan(400_000)
    expect(dear.tokens).toBeGreaterThan(400_000)
    expect(cheap.basis).toContain('stated on the task')
  })

  it('is pessimistic, not absent, before anything has been measured', () => {
    const estimate = estimator.estimateTask(task(), { adapterId: 'claude-code' })
    expect(estimate.confidence).toBe('none')
    expect(estimate.tokens).toBe(250_000)
  })

  it('never reports more confidence than the factor it applied can support', () => {
    twoAgents()
    run({
      worker: DEAR_WORKER,
      adapter: 'antigravity-cli',
      model: 'claude-sonnet-4-6',
      costModel: GOOGLE,
      total: 8_000_000
    })
    estimator.resetCostFactors()
    const estimate = estimator.estimateTask(task(), {
      adapterId: 'antigravity-cli',
      model: 'claude-sonnet-4-6'
    })
    // The size is measured from 25 runs; the factor from one. The answer is a one-sample answer.
    expect(estimate.confidence).toBe('low')
  })
})

/**
 * ⛔ **A quality review is a `runs` row, and the estimator must not learn from it.** A review is one
 * cheap read-only turn on somebody else's task; folded into the median for "what does a task cost on
 * this agent" it drags the factor down, and every routing, admission and overrun gate reads that
 * number. This is the acceptance criterion for the `kind` column — not that it exists.
 */
describe('a quality review is not training data', () => {
  it('does not enter the per-agent factor, however many of them there are', () => {
    twoAgents()
    const before = estimator.costFactors()
    const cheapBefore = before.keys.find((k) => k.model === 'claude-sonnet-5')

    // Twenty reviews on the cheap agent, each a fraction of a real run.
    for (let i = 0; i < 20; i += 1) {
      run({
        worker: CHEAP_WORKER,
        adapter: 'claude-code',
        model: 'claude-sonnet-5',
        costModel: ANTHROPIC,
        total: 20_000,
        warm: false,
        kind: 'quality_review'
      })
    }

    const after = estimator.costFactors()
    const cheapAfter = after.keys.find((k) => k.model === 'claude-sonnet-5')
    expect(cheapAfter?.samples).toBe(cheapBefore?.samples)
    expect(cheapAfter?.factor).toBe(cheapBefore?.factor)
  })

  it('cannot be called a runaway, because it is not measured against work at all', () => {
    twoAgents()
    db.db()
      .prepare(
        `insert or replace into tasks (id, seq, title, status, created_by_json, mandate_json,
                                       budget_json, created_at, updated_at)
         values ('task-reviewed', 900, 'a reviewed task', 'completed', '{}', '{}', '{}', ?, ?)`
      )
      .run(Date.now(), Date.now())
    run({
      worker: CHEAP_WORKER,
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      costModel: ANTHROPIC,
      total: 40_000,
      taskId: 'task-reviewed',
      kind: 'quality_review'
    })
    const reviewRun = db
      .db()
      .prepare("select id from runs where kind = 'quality_review' order by rowid desc limit 1")
      .get() as { id: string }
    expect(estimator.overrunFactor(reviewRun.id)).toBeNull()
  })
})

describe('the unit', () => {
  it('prices a run rather than counting it, so cache reads cost what they cost', () => {
    twoAgents()
    const estimate = estimator.estimateTask(task(), { adapterId: 'claude-code', model: 'claude-sonnet-5' })
    // ⛔ A run that is 99.5% cache reads is priced at about a tenth of its raw total (§1). If these
    // two were ever equal, the estimator would be back to measuring how long a run was.
    expect(estimate.pricedTokens).toBeLessThan(estimate.tokens / 3)
  })

  it('says when a provider that publishes no cache multipliers was priced with assumed ones', () => {
    twoAgents()
    const google = estimator.estimateTask(task(), {
      adapterId: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium'
    })
    expect(google.assumed).toBe(true)
  })
})

describe('overrun', () => {
  function taskRow(id: string): void {
    db.db()
      .prepare(
        `insert or replace into tasks (id, seq, title, status, created_by_json, mandate_json,
                                       budget_json, created_at, updated_at)
         values (?, 1, 'a task', 'running', '{}', '{}', '{}', ?, ?)`
      )
      .run(id, Date.now(), Date.now())
  }

  it('does not call an expensive agent a runaway for costing what it always costs', () => {
    twoAgents()
    taskRow('task-1')
    // A live Antigravity run, sitting exactly on its own key's median.
    run({
      worker: DEAR_WORKER,
      adapter: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium',
      costModel: GOOGLE,
      total: 12_000_000,
      outcome: 'running',
      taskId: 'task-1'
    })
    estimator.resetCostFactors()
    const factor = estimator.overrunFactor(`run-${seq}`)
    expect(factor).not.toBeNull()
    // ⛔ Under the fleet-median estimator this same run measured about 80x and would have been
    // stopped by a watchdog that fires at 3x.
    expect(factor!).toBeLessThan(2)
  })

  it('still catches a run that is expensive for its own agent', () => {
    twoAgents()
    taskRow('task-1')
    run({
      worker: CHEAP_WORKER,
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      costModel: ANTHROPIC,
      total: 150_000 * 12,
      outcome: 'running',
      taskId: 'task-1'
    })
    estimator.resetCostFactors()
    expect(estimator.overrunFactor(`run-${seq}`)!).toBeGreaterThan(5)
  })
})

/**
 * ⛔ **Money is the primary indicator, and money is not always there.**
 *
 * This fleet runs on subscriptions, so a token count is a proxy for a bill nobody pays; what the
 * operator evaluates the cost axis on is dollars. But a run prices `n/a` for six distinct reasons
 * (price.ts), so every case below is really about the *pair*: the money answer where there is one,
 * and provably the old token answer where there is not.
 */
describe('the unit is money, with a token fallback', () => {
  function taskRow(id: string): void {
    db.db()
      .prepare(
        `insert or replace into tasks (id, seq, title, status, created_by_json, mandate_json,
                                       budget_json, created_at, updated_at)
         values (?, 1, 'a task', 'running', '{}', '{}', '{}', ?, ?)`
      )
      .run(id, Date.now(), Date.now())
  }

  /**
   * ⭐ **The case the whole change exists for.** In tokens the dear agent is 80x the cheap one; in
   * money it is a *tenth* of it, because it burns cache reads and barely touches the billing
   * window. A factor learned from priced tokens puts these two on the wrong sides of 1.
   */
  it('learns a key’s factor from dollars once it has enough priced runs', () => {
    pricedFleet()
    estimator.resetCostFactors()
    const keys = estimator.costFactors().keys
    const cheap = keys.find((k) => k.model === 'claude-sonnet-5')!
    const dear = keys.find((k) => k.model === 'gemini-3.7-flash-medium')!

    expect(cheap.learnedFrom).toBe('usd')
    expect(dear.learnedFrom).toBe('usd')
    expect(cheap.usdSamples).toBe(6)
    // 10% of a weekly window on Claude Pro against 1%. ⚠️ Unrounded: the integer median the token
    // series uses would report both of these as $0.
    expect(cheap.medianUsd!).toBeCloseTo(0.46, 2)
    expect(dear.medianUsd!).toBeCloseTo(0.046, 3)

    // ⛔ The token series says the opposite, and loudly. If the factors followed it they could not
    // come out this way round, so this is the money series being read and not a proxy for it.
    expect(cheap.medianPriced).toBeLessThan(dear.medianPriced / 10)
    expect(cheap.factor).toBeGreaterThan(1)
    expect(dear.factor).toBeLessThan(1)
  })

  it('estimates a task in dollars, and says so in the basis', () => {
    pricedFleet()
    estimator.resetCostFactors()
    const estimate = estimator.estimateTask(task(), {
      adapterId: 'claude-code',
      model: 'claude-sonnet-5'
    })
    expect(estimate.usd).not.toBeNull()
    expect(estimate.usd!).toBeGreaterThan(0)
    expect(estimate.basis).toContain('in dollars from 12 priced run(s)')
    expect(estimate.basis).toContain('learned from 6 priced run(s) in dollars')
    // The token answer is still there beside it: it is the fallback *and* the historical series.
    expect(estimate.pricedTokens).toBeGreaterThan(0)
  })

  /**
   * ⛔ **The strict-extension case for a single key.** Nothing here can be priced, so `learnedFrom`
   * must be the token series and every money field must be absent rather than zero — a `$0.00`
   * would be read as "this was free", which is the opposite of what is true.
   */
  it('falls back to priced tokens where no run could be priced, with an explicit basis', () => {
    twoAgents()
    estimator.resetCostFactors()
    const key = estimator.costFactors().keys.find((k) => k.model === 'claude-sonnet-5')!
    expect(key.learnedFrom).toBe('priced_tokens')
    expect(key.medianUsd).toBeNull()
    expect(key.medianUsd).not.toBe(0)
    expect(key.usdSamples).toBe(0)
    expect(estimator.costFactors().neutralUsd).toBeNull()

    const estimate = estimator.estimateTask(task(), {
      adapterId: 'claude-code',
      model: 'claude-sonnet-5'
    })
    expect(estimate.usd).toBeNull()
    expect(estimate.usdConfidence).toBe('none')
    expect(estimate.basis).toContain('no run behind this estimate could be priced in money')
    expect(estimate.basis).toContain('none of its runs could be priced in money')
  })

  /**
   * ⚠️ **A key's dollar samples are a subset of its samples.** Conflating the two would claim
   * twelve dollar measurements where there are six, and shrink the factor as though it had them.
   */
  it('counts a mixed key’s dollar samples apart from its samples', () => {
    pricedFleet()
    for (let i = 0; i < 6; i += 1) {
      run({
        worker: CHEAP_WORKER,
        adapter: 'claude-code',
        model: 'claude-sonnet-5',
        costModel: ANTHROPIC,
        total: 150_000,
        warm: false
      })
    }
    estimator.resetCostFactors()
    const factors = estimator.costFactors()
    const cheap = factors.keys.find((k) => k.model === 'claude-sonnet-5')!

    expect(cheap.samples).toBe(12)
    expect(cheap.usdSamples).toBe(6)
    expect(cheap.usdSamples).toBeLessThan(cheap.samples)
    // Six is still above the line, so the key keeps its money factor - on six readings, not twelve.
    expect(cheap.learnedFrom).toBe('usd')
    expect(cheap.factor).toBeCloseTo(cheap.ratio ** (6 / 11), 6)

    // The fleet-wide count is a subset in exactly the same way.
    expect(factors.samples).toBe(18)
    expect(factors.usdSamples).toBe(12)
  })

  /**
   * ⛔ **Below the line a key keeps the token answer.** One priced run out of many is not a
   * reputation; it is whichever run happened to be sampled while somebody was reading the window.
   */
  it('will not learn money from one reading', () => {
    twoAgents()
    run({
      worker: CHEAP_WORKER,
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      costModel: ANTHROPIC,
      total: 150_000,
      warm: false,
      priced: { startedAt: T0, endedAt: T0 + HOUR, from: 0, to: 40 }
    })
    estimator.resetCostFactors()
    const cheap = estimator.costFactors().keys.find((k) => k.model === 'claude-sonnet-5')!
    expect(cheap.usdSamples).toBe(1)
    expect(cheap.medianUsd).not.toBeNull()
    expect(cheap.learnedFrom).toBe('priced_tokens')
  })

  describe('overrun', () => {
    /**
     * ⭐ A run of perfectly ordinary *size* that ate 40% of a weekly window. The token ratio is
     * about 1 — it is exactly the median run for its key — so a watchdog reading tokens sees
     * nothing at all, and only the money path can catch it.
     */
    it('measures a runaway in dollars where both sides are priced', () => {
      pricedFleet()
      taskRow('task-money')
      run({
        worker: CHEAP_WORKER,
        adapter: 'claude-code',
        model: 'claude-sonnet-5',
        costModel: ANTHROPIC,
        total: 150_000,
        warm: false,
        outcome: 'running',
        taskId: 'task-money',
        // ⚠️ `running` with a real end anchor: the run must be priceable without becoming a
        // completed sample, which would fold its own cost into the median it is measured against.
        priced: { startedAt: T0 + 24 * HOUR, endedAt: T0 + 25 * HOUR, from: 60, to: 100 }
      })
      estimator.resetCostFactors()
      const factor = estimator.overrunFactor(`run-${seq}`)
      expect(factor).not.toBeNull()
      expect(factor!).toBeGreaterThan(3)
    })

    it('falls back to the priced-token ratio when either side has no price', () => {
      pricedFleet()
      taskRow('task-tokens')
      // No anchors, so this run prices `n/a` however well the fleet around it is measured.
      run({
        worker: CHEAP_WORKER,
        adapter: 'claude-code',
        model: 'claude-sonnet-5',
        costModel: ANTHROPIC,
        total: 150_000 * 12,
        warm: false,
        outcome: 'running',
        taskId: 'task-tokens'
      })
      estimator.resetCostFactors()
      const runId = `run-${seq}`
      // The run itself is the unpriced half: the fleet around it is fully measured in dollars.
      expect(price.priceForRun(runId)?.usd ?? null).toBeNull()

      const factor = estimator.overrunFactor(runId)
      // ⛔ Not null. An unpriceable run is not exempt from the watchdog; it is measured in the unit
      // that is available, which is what this function did before money existed.
      expect(factor).not.toBeNull()
      // ⛔ And measured in *that* unit, exactly: 5×9,000 output + 0.1×1,791,000 cache reads is
      // 224,100 input-token-equivalents, over the same task's estimate on the same key. A money
      // ratio cannot be this number, so this pins which side of the fallback was taken.
      const estimate = estimator.estimateTask(task(), {
        adapterId: 'claude-code',
        model: 'claude-sonnet-5',
        warm: false
      })
      expect(factor!).toBeCloseTo(224_100 / estimate.pricedTokens, 9)
    })

    it('still refuses to judge a task nothing has measured', () => {
      taskRow('task-first')
      run({
        worker: CHEAP_WORKER,
        adapter: 'claude-code',
        model: 'claude-sonnet-5',
        costModel: ANTHROPIC,
        total: 150_000,
        outcome: 'running',
        taskId: 'task-first',
        priced: { startedAt: T0, endedAt: T0 + HOUR, from: 0, to: 40 }
      })
      estimator.resetCostFactors()
      // Killing work for the crime of being first is the failure this guard exists to avoid, and a
      // dollar figure on one side of the ratio does not make the other side measured.
      expect(estimator.overrunFactor(`run-${seq}`)).toBeNull()
    })
  })

  /**
   * ⛔ **The proof that this is a strict extension and not a rewrite.**
   *
   * Every number below was measured from the implementation as it stood at 1a27420, before money
   * entered this file at all, on this exact fixture. A fleet with no priced run must still produce
   * them to the last digit: the money branches are gated on dollar samples that do not exist here,
   * so nothing they do can reach these values.
   */
  it('is byte-identical to the pre-money answer when nothing can be priced', () => {
    twoAgents()
    estimator.resetCostFactors()
    const f = estimator.costFactors()
    const dear = f.keys.find((k) => k.model === 'gemini-3.7-flash-medium')!
    const cheap = f.keys.find((k) => k.model === 'claude-sonnet-5')!

    expect(dear.samples).toBe(12)
    expect(dear.medianPriced).toBe(1_494_000)
    expect(dear.ratio).toBe(8.944271909999182)
    expect(dear.factor).toBe(4.6954672842399)
    expect(cheap.medianPriced).toBe(18_675)
    expect(cheap.ratio).toBe(0.11180339887498977)
    expect(cheap.factor).toBe(0.21297134863583295)
    expect(f.warmFactor).toBe(1)
    expect(f.coldFactor).toBe(1.174821163691458)
    expect(f.neutralPriced).toBe(172_736)
    expect(f.neutralRaw).toBe(1_387_435)

    const onCheap = estimator.estimateTask(task(), {
      adapterId: 'claude-code',
      model: 'claude-sonnet-5'
    })
    const onDear = estimator.estimateTask(task(), {
      adapterId: 'antigravity-cli',
      model: 'gemini-3.7-flash-medium'
    })
    const stated = estimator.estimateTask(task({ estTokens: 400_000 }), {
      adapterId: 'claude-code',
      model: 'claude-sonnet-5'
    })
    expect([onCheap.tokens, onCheap.pricedTokens, onCheap.factor]).toEqual([
      295_484, 36_788, 0.21297134863583295
    ])
    expect([onDear.tokens, onDear.pricedTokens, onDear.factor]).toEqual([
      6_514_656, 811_076, 4.6954672842399
    ])
    expect([stated.tokens, stated.pricedTokens, stated.factor]).toEqual([
      85_189, 10_606, 0.21297134863583295
    ])
    expect(onCheap.confidence).toBe('medium')

    // And the money fields are absent rather than zero, which is the whole difference between
    // "we could not measure this" and "this was free".
    for (const e of [onCheap, onDear, stated]) {
      expect(e.usd).toBeNull()
      expect(e.usdConfidence).toBe('none')
    }
  })
})
