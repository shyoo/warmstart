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
// The literal observed in the live database. ⛔ Do not substitute a fixture-shaped UUID: migration
// 37 did exactly that, so its regression test proved internally consistent SQL that matched no row.
const T163_WORKER = 'f6ba9f23-5a03-4d47-a197-4e12ae9963c3'
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
  it('repairs a database already at v37 using t163\'s observed worker id', () => {
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

    // Reproduce the deployed failure: migration 37 has already run and left these rows behind.
    db.db().exec(`pragma user_version = ${db.versionBefore('finish t163 malformed Antigravity quota repair')}`)
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
  it('retrospectively prices t207-shaped Antigravity history despite its final panel correction', () => {
    // These are the persisted t207 Run #1 facts: a complete Gemini pair, plus the 41.69% reading
    // the panel corrected to 41.61% after completion. The correction must not turn every task
    // whose timeline contains it into `n/a`.
    seedRun({
      id: 't207-shaped',
      worker: T163_WORKER,
      costModel: 'google.antigravity.2026-08',
      model: 'gemini-3.8-flash-medium',
      startedAt: T0,
      endedAt: T0 + HOUR,
      before: quota(T0, [['5h:gemini', 73.97], ['weekly:gemini', 39.72]]),
      after: quota(T0 + HOUR, [['5h:gemini', 86.53], ['weekly:gemini', 41.61]])
    })
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?, 'weekly:gemini', 'Gemini 7d', 41.69, null, 'cli', ?)`
      )
      .run(T163_WORKER, T0 + 45 * 60_000)

    const priced = price.priceForRun('t207-shaped')!
    expect(priced.reason).toBe('measured')
    expect(priced.usd).not.toBeNull()
    expect(priced.usd!).toBeGreaterThan(0)
    expect(priced.estimated).toBe(true)
    expect(price.priceForTask('task-t207-shaped')!.usd).toBe(priced.usd)
  })

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

/**
 * t210: the closing reading is stamped before the run ended, so the run priced `n/a`.
 *
 * ⛔ **A vendor's `sampledAt` is the vendor's, not ours.** `captureQuotaAfter` asks the CLI for a
 * closing reading the moment a run finishes; what comes back is whatever that provider's own panel
 * last computed, which is routinely a minute or two stale. Every one of these rows is the shape the
 * live database actually holds — `quota_after_json.sampledAt` *earlier* than `runs.ended_at` — and
 * before this was fixed each of them threw away a run whose spend had been measured in full.
 *
 * ⚠️ These go through the real migration replay like everything else in this file, so what they
 * assert is the pass that ships rather than a hand-built object.
 */
describe('a closing reading stamped before the run ended', () => {
  /** The literal t210 timings, in minutes past T0: run 0.42 -> 32.5, last reading at 30.7. */
  const MIN = 60_000

  it('prices the run instead of discarding it, and says the number is a lower bound', () => {
    seedRun({
      id: 't210',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0 + Math.round(0.42 * MIN),
      endedAt: T0 + Math.round(32.5 * MIN),
      before: quota(T0, [['weekly_all', 18], ['session', 0]]),
      // ⛔ 30.7 minutes, against a run that ended at 32.5. This is the whole bug.
      after: quota(T0 + Math.round(30.7 * MIN), [['weekly_all', 22], ['session', 56]])
    })
    replayMigration()
    const p = price.priceForRun('t210')!
    expect(p.reason).toBe('measured')
    expect(p.percent).toBeCloseTo(4, 6)
    // 4% of a $4.60 weekly window.
    expect(p.usd!).toBeCloseTo(0.184, 3)
    expect(p.estimated).toBe(true)
    // ⛔ The tooltip has to say which direction the imprecision runs, or a reader takes the number
    // for the whole run.
    expect(p.basis).toMatch(/At least this much/)
    expect(p.basis).toMatch(/fell outside the window readings/)
  })

  it('names how much of the run went unread, rather than only that some did', () => {
    seedRun({
      id: 'gap',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + 10 * MIN,
      before: quota(T0, [['weekly_all', 10]]),
      after: quota(T0 + 8 * MIN, [['weekly_all', 13]])
    })
    replayMigration()
    expect(price.priceForRun('gap')!.basis).toMatch(/2m of this run fell outside/)
  })

  it('leaves a run whose closing reading landed after it alone, basis and all', () => {
    seedRun({
      id: 'clean',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + 10 * MIN,
      before: quota(T0, [['weekly_all', 10]]),
      // A second past the end, which is what a working probe produces.
      after: quota(T0 + 10 * MIN + 1000, [['weekly_all', 14]])
    })
    replayMigration()
    const p = price.priceForRun('clean')!
    expect(p.percent).toBeCloseTo(4, 6)
    expect(p.estimated).toBe(false)
    expect(p.basis).not.toMatch(/At least this much/)
  })

  /**
   * ⛔ **The property that made this safe to apply to eight days of history.** The fix clamps a
   * run's span to the readings that exist; it cannot move a run those readings already covered.
   * Measured against the live database on 2026-09-04: of 378 runs, exactly two changed — both from
   * `no_reading` to a price — and no already-priced run moved by a cent.
   */
  it('does not disturb a neighbouring run that was already priced', () => {
    seedRun({
      id: 'first',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0,
      endedAt: T0 + 10 * MIN,
      before: quota(T0, [['7d', 10]]),
      after: quota(T0 + 10 * MIN + 1000, [['7d', 13]])
    })
    replayMigration()
    const before = price.priceForRun('first')!.usd
    seedRun({
      id: 'second',
      worker: CODEX,
      costModel: 'openai.codex.2026-08',
      startedAt: T0 + 20 * MIN,
      endedAt: T0 + 40 * MIN,
      before: quota(T0 + 20 * MIN, [['7d', 13]]),
      after: quota(T0 + 38 * MIN, [['7d', 19]])
    })
    replayMigration()
    expect(price.priceForRun('first')!.usd).toBe(before)
    expect(price.priceForRun('second')!.percent).toBeCloseTo(6, 6)
    expect(price.priceForRun('second')!.estimated).toBe(true)
  })

  it('still refuses a run nothing was read during at all', () => {
    seedRun({
      id: 'unread',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      // Both readings predate the run: it ran entirely outside the series.
      startedAt: T0 + 60 * MIN,
      endedAt: T0 + 70 * MIN,
      before: quota(T0, [['weekly_all', 10]]),
      after: quota(T0 + 5 * MIN, [['weekly_all', 12]])
    })
    replayMigration()
    const p = price.priceForRun('unread')!
    expect(p.reason).toBe('no_reading')
    expect(p.usd).toBeNull()
  })

  it('folds a truncated run into its task total and marks the total an estimate', () => {
    seedRun({
      id: 'tt',
      worker: CLAUDE,
      costModel: 'anthropic.subscription.2026-08',
      startedAt: T0,
      endedAt: T0 + 10 * MIN,
      taskId: 'truncated-task',
      before: quota(T0, [['weekly_all', 0]]),
      after: quota(T0 + 8 * MIN, [['weekly_all', 4]])
    })
    replayMigration()
    const total = price.priceForTask('truncated-task')!
    expect(total.usd!).toBeCloseTo(0.184, 3)
    // ⛔ Not `partial`: the run *has* a price. It is `estimated`, which is the flag that says the
    // number could be short — conflating the two would tell a reader a run was missing entirely.
    expect(total.partial).toBe(false)
    expect(total.estimated).toBe(true)
  })
})
