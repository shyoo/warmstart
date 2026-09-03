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
}): void {
  seq += 1
  const output = Math.round(input.total * 0.005)
  const cacheRead = input.total - output
  db.db()
    .prepare(
      `insert into runs (id, task_id, project_id, session_id, worker_id, started_at, outcome,
                         quota_unverified, cost_model_id, started_warm, adapter_id, model,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, kind)
       values (?,?,?,null,?,?,?,0,?,?,?,?,0,?,?,0,?)`
    )
    .run(
      `run-${seq}`,
      input.taskId ?? null,
      input.project ?? null,
      input.worker,
      Date.now() + seq,
      input.outcome ?? 'completed',
      input.costModel,
      input.warm === undefined || input.warm === null ? null : input.warm ? 1 : 0,
      input.adapter,
      input.model,
      output,
      cacheRead,
      input.kind ?? 'work'
    )
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
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  costmodel = await import('./costmodel.js')
  estimator = await import('./estimator.js')
  db.openDb(join(dir, 'estimator.db'))
  costmodel.loadCostModels()
  const workers = db
    .db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?, ?, ?, ?, 1, 0, 1, 'worker', ?)`
    )
  workers.run(CHEAP_WORKER, 'Claude', 'claude-code', join(dir, 'w1'), Date.now())
  workers.run(DEAR_WORKER, 'Antigravity', 'antigravity-cli', join(dir, 'w2'), Date.now())
})

beforeEach(() => {
  db.db().exec('delete from runs')
  seq = 0
  estimator.resetCostFactors()
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
    expect(estimate.basis).toContain('adapter-wide rung')
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
