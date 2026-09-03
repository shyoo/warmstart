import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunQuota } from '@shared/tasks.js'

/**
 * The database half: migration 35's backfill, and the pass that turns stored rows into dollars.
 *
 * ⛔ **Driven through the real migration, not a copy of it.** `versionBefore` rewinds `user_version`
 * and reopening replays the migration that actually ships — which is the only way to find out that
 * a backfill is not replay-safe, and the only way to be testing the SQL the app runs.
 */

let dir: string
let db: typeof import('./db.js')
let price: typeof import('./price.js')

const CLAUDE = 'aaaaaaaa-0000-4000-8000-00000000c1a0'
const CODEX = 'aaaaaaaa-0000-4000-8000-00000000c0de'
const T163_WORKER = 'f6ba9f23-3cb1-4c14-a439-5c84ba987be9'
const T163_RUN = 'cf22425a-d555-4756-9993-2cd0e5954420'
const T163_SAMPLE_AT = 1_788_459_715_254

const HOUR = 3_600_000
const T0 = 1_756_000_000_000

function quota(at: number, windows: Array<[string, number]>): string {
  const q: RunQuota = {
    windows: windows.map(([id, percent]) => ({ id, label: id, percent })),
    sampledAt: at,
    stale: false
  }
  return JSON.stringify(q)
}

let seq = 0
function seedRun(opts: {
  id: string
  worker: string
  costModel: string
  startedAt: number
  endedAt: number | null
  before?: string | null
  after?: string | null
  model?: string | null
  taskId?: string
}): void {
  seq += 1
  const taskId = opts.taskId ?? `task-${opts.id}`
  db.db()
    .prepare(
      `insert or ignore into tasks (id, seq, title, status, created_by_json, mandate_json,
                                    budget_json, created_at, updated_at)
       values (?,?,?,'completed','{}','{}','{"grantedTokens":0,"spentTokens":0}',?,?)`
    )
    .run(taskId, seq, taskId, T0, T0)
  db.db()
    .prepare(
      `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, quota_unverified,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                         cost_model_id, model, quota_before_json, quota_after_json)
       values (?,?,?,?,?,'completed',0,0,0,0,0,?,?,?,?)`
    )
    .run(
      opts.id,
      taskId,
      opts.worker,
      opts.startedAt,
      opts.endedAt,
      opts.costModel,
      opts.model ?? null,
      opts.before ?? null,
      opts.after ?? null
    )
}

function planOf(id: string): { plan_id: string | null; plan_source: string | null } {
  return db.db().prepare('select plan_id, plan_source from runs where id = ?').get(id) as never
}

/** Rewind to just before migration 35 and reopen, which replays it against whatever is there now. */
function replayMigration(): void {
  db.db().exec(`pragma user_version = ${db.versionBefore('which subscription each run was billed')}`)
  db.db().exec('update runs set plan_id = null, plan_raw = null, plan_source = null')
  db.closeDb()
  db.openDb(join(dir, 'runprice.db'))
  price.bumpPricingEpoch()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-runprice-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  price = await import('./price.js')
  db.openDb(join(dir, 'runprice.db'))
  const worker = db.db().prepare(
    `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                          max_concurrent, role, identity_json, created_at)
     values (?, ?, ?, ?, 1, 0, 1, 'worker', ?, ?)`
  )
  worker.run(CLAUDE, 'ClaudeSecond', 'claude-code', join(dir, 'c'), '{"subscriptionType":"pro"}', T0)
  worker.run(CODEX, 'CodexFirst', 'openai-compatible', join(dir, 'x'), '{"subscriptionType":"Plus"}', T0)
  worker.run(T163_WORKER, 'Antigravity', 'antigravity-cli', join(dir, 'a'), '{}', T0)
})

beforeEach(() => {
  db.db().exec('delete from runs')
  db.db().exec('delete from tasks')
  db.db().exec('delete from quota_samples')
  price.bumpPricingEpoch()
  seq = 0
})

describe('repairing t163\'s malformed Antigravity quota reading', () => {
  it('clears both the false sample and the matching run snapshot, without touching a neighbour', () => {
    seedRun({
      id: T163_RUN,
      worker: T163_WORKER,
      costModel: 'google.antigravity.2026-08',
      startedAt: T163_SAMPLE_AT,
      endedAt: T163_SAMPLE_AT + HOUR,
      before: JSON.stringify({ windows: [], sampledAt: T163_SAMPLE_AT, stale: false })
    })
    const sample = db.db().prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    sample.run(T163_WORKER, '5h:gemini', 'Gemini 5h', 0, null, 'cli', T163_SAMPLE_AT)
    sample.run(T163_WORKER, 'weekly:gemini', 'Gemini 7d', 0, null, 'cli', T163_SAMPLE_AT)
    sample.run(T163_WORKER, '5h', 'Claude/GPT 5h', 68.53, null, 'cli', T163_SAMPLE_AT)
    sample.run(T163_WORKER, 'weekly:claude-and-gpt', 'Claude/GPT 7d', 100, null, 'cli', T163_SAMPLE_AT)
    sample.run(T163_WORKER, 'unrelated', 'Unrelated', 42, null, 'cli', T163_SAMPLE_AT)

    db.db().exec(`pragma user_version = ${db.versionBefore('remove t163 malformed Antigravity quota reading')}`)
    db.closeDb()
    db.openDb(join(dir, 'runprice.db'))

    expect(db.db().prepare('select quota_before_json from runs where id = ?').get(T163_RUN)).toEqual({
      quota_before_json: null
    })
    expect(
      db.db().prepare('select window_id from quota_samples where worker_id = ? and sampled_at = ? order by id').all(T163_WORKER, T163_SAMPLE_AT)
    ).toEqual([{ window_id: 'unrelated' }])
  })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('migration 35 — which subscription each run was billed against', () => {
  /**
   * ⭐ **The measurement this whole migration exists for.** The operator switched Codex from free to
   * paid partway through this install's history. The identity string says `Plus` for *both* eras,
   * because it describes the account now — the window shape is what tells them apart, and it does so
   * exactly: one `30d` window on the free side, `5h` + `7d` on the paid one.
   */
  it('splits Codex’s free era from its paid one on the window shape, not the identity string', () => {
    seedRun({
      id: 'free-era',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['30d', 4]]),
      after: quota(T0 + HOUR, [['30d', 6]])
    })
    seedRun({
      id: 'paid-era',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0 + 40 * HOUR,
      endedAt: T0 + 41 * HOUR,
      before: quota(T0 + 40 * HOUR, [['5h', 2], ['7d', 10]]),
      after: quota(T0 + 41 * HOUR, [['5h', 9], ['7d', 15]])
    })
    replayMigration()
    expect(planOf('free-era')).toMatchObject({ plan_id: 'free', plan_source: 'window_shape' })
    expect(planOf('paid-era')).toMatchObject({ plan_id: 'plus', plan_source: 'window_shape' })
  })

  /**
   * ⭐ A run that took no reading of its own sits between two that did. The nearer one wins — which
   * is what carries the free/paid split onto the runs either side of it.
   */
  it('carries a shape verdict onto the nearest unread run on the same worker', () => {
    seedRun({
      id: 'free-anchor',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['30d', 4]])
    })
    seedRun({
      id: 'silent-early',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0 + 2 * HOUR,
      endedAt: T0 + 3 * HOUR
    })
    seedRun({
      id: 'paid-anchor',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0 + 100 * HOUR,
      endedAt: T0 + 101 * HOUR,
      before: quota(T0 + 100 * HOUR, [['5h', 1], ['7d', 3]])
    })
    seedRun({
      id: 'silent-late',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0 + 102 * HOUR,
      endedAt: T0 + 103 * HOUR
    })
    replayMigration()
    expect(planOf('silent-early')).toMatchObject({ plan_id: 'free', plan_source: 'neighbour' })
    expect(planOf('silent-late')).toMatchObject({ plan_id: 'plus', plan_source: 'neighbour' })
  })

  it('falls back to the worker’s own subscriptionType where no shape exists', () => {
    seedRun({
      id: 'claude-run',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['session', 3], ['weekly_all', 20]])
    })
    replayMigration()
    // ⚠️ No `detect` clause in the Anthropic catalogue, so the shape says nothing and the vendor's
    // own string is the next-best evidence.
    expect(planOf('claude-run')).toMatchObject({ plan_id: 'pro', plan_source: 'identity' })
    expect(
      (db.db().prepare('select plan_raw from runs where id = ?').get('claude-run') as { plan_raw: string })
        .plan_raw
    ).toBe('pro')
  })

  it('replays without changing anything the second time', () => {
    seedRun({
      id: 'r1',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['5h', 1], ['7d', 3]])
    })
    replayMigration()
    const first = planOf('r1')
    // ⛔ Rewind again *without* clearing the columns: the `plan_id is null` scope is what makes the
    // second pass a no-op, and a migration that is not replay-safe fails a suite about something
    // else entirely six months from now.
    db.db().exec(`pragma user_version = ${db.versionBefore('which subscription each run was billed')}`)
    db.closeDb()
    db.openDb(join(dir, 'runprice.db'))
    expect(planOf('r1')).toEqual(first)
  })
})

describe('what a stored run costs', () => {
  it('prices a solo Claude run from the weekly window either side of it', () => {
    seedRun({
      id: 'solo',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['session', 3], ['weekly_all', 20]]),
      after: quota(T0 + HOUR, [['session', 9], ['weekly_all', 25]])
    })
    replayMigration()
    const p = price.priceForRun('solo')!
    expect(p.reason).toBe('measured')
    expect(p.percent).toBeCloseTo(5, 6)
    // 5% of a $20/month subscription over a 7-day window.
    expect(p.usd!).toBeCloseTo(0.23, 3)
    expect(p.planLabel).toBe('Claude Pro')
    expect(p.estimated).toBe(false)
  })

  /**
   * ⛔ **The cross-contamination case, end to end.** Two runs on one account, overlapping. Neither
   * gets the whole 10%, both get the `*`, and each names the other.
   */
  it('splits two overlapping runs on one account and marks both estimates', () => {
    seedRun({
      id: 'a',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + 2 * HOUR,
      before: quota(T0, [['weekly_all', 0]]),
      after: quota(T0 + 2 * HOUR, [['weekly_all', 10]])
    })
    seedRun({
      id: 'b',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + 2 * HOUR,
      before: quota(T0, [['weekly_all', 0]]),
      after: quota(T0 + 2 * HOUR, [['weekly_all', 10]])
    })
    replayMigration()
    const a = price.priceForRun('a')!
    const b = price.priceForRun('b')!
    expect(a.percent).toBeCloseTo(5, 6)
    expect(b.percent).toBeCloseTo(5, 6)
    expect(a.estimated).toBe(true)
    expect(a.reason).toBe('shared_window')
    expect(a.parallelRunIds).toEqual(['b'])
    expect(b.parallelRunIds).toEqual(['a'])
  })

  it('reads the quota_samples timeline, not only the run’s own two snapshots', () => {
    // ⭐ Q3's answer: hundreds of samples exist, and a boundary landing *inside* a long run is what
    // makes the split close to the truth. Here the run carries no snapshots at all.
    seedRun({
      id: 'sampled',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0 + HOUR,
      endedAt: T0 + 2 * HOUR
    })
    const stmt = db.db().prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,null,'cli',?)`
    )
    stmt.run(CLAUDE, 'weekly_all', 'weekly', 10, T0 + HOUR)
    stmt.run(CLAUDE, 'weekly_all', 'weekly', 13, T0 + 2 * HOUR)
    replayMigration()
    const p = price.priceForRun('sampled')!
    expect(p.percent).toBeCloseTo(3, 6)
    expect(p.usd!).toBeGreaterThan(0)
  })

  it('says n/a for a free Codex run rather than $0.00', () => {
    seedRun({
      id: 'freebie',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['30d', 4]]),
      after: quota(T0 + HOUR, [['30d', 6]])
    })
    replayMigration()
    const p = price.priceForRun('freebie')!
    expect(p.usd).toBeNull()
    expect(p.reason).toBe('unpriced_plan')
    expect(p.planLabel).toBe('Codex Free')
  })

  it('says n/a for a run whose window rolled over mid-flight', () => {
    seedRun({
      id: 'rolled',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['weekly_all', 98]]),
      after: quota(T0 + HOUR, [['weekly_all', 2]])
    })
    replayMigration()
    const p = price.priceForRun('rolled')!
    expect(p.usd).toBeNull()
    expect(p.reason).toBe('window_reset')
  })

  it('says n/a for a run with only one reading', () => {
    seedRun({
      id: 'half',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['weekly_all', 12]])
    })
    replayMigration()
    expect(price.priceForRun('half')!.reason).toBe('no_reading')
  })

  /**
   * ⚠️ A task's total is a **lower bound** whenever any of its runs is n/a. Presenting a short
   * number as a complete one is the failure this flag exists to prevent.
   */
  it('folds a task’s runs into a total, and says when that total is short', () => {
    seedRun({
      id: 'p1',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      taskId: 'shared-task',
      before: quota(T0, [['weekly_all', 0]]),
      after: quota(T0 + HOUR, [['weekly_all', 5]])
    })
    seedRun({
      id: 'p2',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0 + 5 * HOUR,
      endedAt: T0 + 6 * HOUR,
      taskId: 'shared-task',
      before: quota(T0 + 5 * HOUR, [['weekly_all', 5]])
    })
    replayMigration()
    const total = price.priceForTask('shared-task')!
    expect(total.usd!).toBeCloseTo(0.23, 3)
    expect(total.partial).toBe(true)
  })

  it('throws the memo away when a reading lands', () => {
    seedRun({
      id: 'memo',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['weekly_all', 0]])
    })
    replayMigration()
    expect(price.priceForRun('memo')!.reason).toBe('no_reading')
    db.db()
      .prepare('update runs set quota_after_json = ? where id = ?')
      .run(quota(T0 + HOUR, [['weekly_all', 4]]), 'memo')
    // ⛔ Without the bump the answer would still be the memoised n/a — which is exactly the bug
    // every writer of a run or a reading calls this to avoid.
    price.bumpPricingEpoch()
    expect(price.priceForRun('memo')!.percent).toBeCloseTo(4, 6)
  })
})
