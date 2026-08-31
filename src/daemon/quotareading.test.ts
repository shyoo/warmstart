import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DatedQuota } from './quota.js'

/**
 * What the operator is shown about an account's window, as opposed to what the scheduler gates on.
 *
 * ⛔ These are two different questions and one accessor was answering both. A gate asks *what is the
 * window right now*, and must refuse anything it cannot trust. A person reading the fleet strip asks
 * *what do we know about this account*, and `quota unknown` is a bad answer to that whenever there is
 * a reading — it makes an account measured an hour ago look exactly like one that has never been
 * measured at all, and the operator's next move differs between the two.
 *
 * ⚠️ Two ways a good reading got buried, both fixed here, neither of which changes a gate:
 *   1. **Age.** Past `STALE_AFTER_MS` the strip printed the words `quota unknown` over the numbers.
 *   2. **A failed probe.** A probe that fails writes a sample with *no windows*, which is newer than
 *      the last good reading and therefore hid it.
 */

let dir: string
let db: typeof import('./db.js')
let quota: typeof import('./quota.js')

const WORKER = 'cccccccc-0000-4000-8000-000000000001'

/** A reading, `ageMs` old. `window_id` empty is how a failed probe is stored — one row, no window. */
function sample(opts: {
  ageMs: number
  windows?: Array<[string, number]>
  error?: string
}): void {
  const at = Date.now() - opts.ageMs
  if (!opts.windows) {
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
         values (?,?,?,?,?,?,?,?)`
      )
      .run(WORKER, '', '', 0, null, 'unknown', opts.error ?? 'probe failed', at)
    return
  }
  for (const [id, pct] of opts.windows) {
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(WORKER, id, id, pct, at + 3_600_000, 'config cache', at)
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotaread-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  db.openDb(join(dir, 'quotaread.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(WORKER, 'test', 'claude-code', join(dir, 'w'), 0, 0, 1, 'worker', Date.now())
})

beforeEach(() => db.db().exec('delete from quota_samples'))

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('a reading that has gone stale', () => {
  it('still comes back, with its numbers and its age', () => {
    sample({ ageMs: 20 * 3600_000, windows: [['session', 11], ['weekly', 16]] })
    const reading = quota.lastQuotaReading(WORKER)
    expect(reading?.windows.map((w) => w.percent)).toEqual([11, 16])
    expect(reading?.ageMs).toBeGreaterThan(quota.STALE_AFTER_MS)
  })

  it('is still marked stale, because that is what stops anything acting on it', () => {
    // ⛔ The whole safety of showing it. `stale` is what `reserveState` and every gate check; this
    // change moved where the *numbers* are drawn, never whether they may be trusted.
    sample({ ageMs: 20 * 3600_000, windows: [['session', 11]] })
    expect(quota.lastQuotaReading(WORKER)?.stale).toBe(true)
  })

  it('is not marked stale when it is fresh', () => {
    sample({ ageMs: 60_000, windows: [['session', 42]] })
    expect(quota.lastQuotaReading(WORKER)?.stale).toBe(false)
  })
})

describe('a probe that failed on top of a reading that worked', () => {
  it('does not bury the reading', () => {
    // ⛔ The measured case: a launch probes every account, and an account that cannot be read writes
    // a windowless sample over an hour-old reading that was perfectly good.
    sample({ ageMs: 3600_000, windows: [['session', 11], ['weekly', 16]] })
    sample({ ageMs: 1000, error: 'no cachedUsageUtilization in .claude.json' })

    const shown = quota.lastQuotaReading(WORKER)
    expect(shown?.windows).toHaveLength(2)
    // ⚠️ The age is the age of *these numbers*, not of the attempt that failed. A card saying
    // "last seen 2s ago" over an hour-old reading would be a lie told by a true timestamp.
    expect(shown?.ageMs).toBeGreaterThan(3_500_000)
  })

  it('says the last check failed, so old is not confused with broken', () => {
    sample({ ageMs: 3600_000, windows: [['session', 11]] })
    sample({ ageMs: 1000, error: 'no cachedUsageUtilization in .claude.json' })
    expect(quota.lastQuotaReading(WORKER)?.error).toMatch(/cachedUsageUtilization/)
  })

  it('carries no error when the newest attempt is the reading itself', () => {
    sample({ ageMs: 1000, windows: [['session', 11]] })
    expect(quota.lastQuotaReading(WORKER)?.error).toBeUndefined()
  })

  it('marks a recent reading stale when the newest check failed', () => {
    sample({ ageMs: 60_000, windows: [['session', 11]] })
    sample({ ageMs: 1000, error: 'probe failed' })
    const reading = quota.lastQuotaReading(WORKER)
    expect(reading?.stale).toBe(true)
    expect(reading?.error).toBe('probe failed')
    expect(reading?.windows).toHaveLength(1)
  })

  it('still answers "nothing" for an account that has never been read', () => {
    // ⚠️ `never probed` and `we last saw 11%` are different states and the card draws them
    // differently. Inventing a reading here would be the opposite failure to the one being fixed.
    sample({ ageMs: 1000, error: 'no cachedUsageUtilization in .claude.json' })
    const shown = quota.lastQuotaReading(WORKER)
    expect(shown?.windows).toHaveLength(0)
    expect(shown?.error).toMatch(/cachedUsageUtilization/)
  })
})

describe('what the scheduler reads, which did not change', () => {
  it('is the newest attempt, failure included', () => {
    // ⛔ `lastQuota` is the gate's accessor and must keep reporting the *current* state of the
    // account. A gate handed the last good reading instead would be a gate satisfied by history.
    sample({ ageMs: 3600_000, windows: [['session', 11]] })
    sample({ ageMs: 1000, error: 'probe failed' })

    const gated = quota.lastQuota(WORKER)
    expect(gated?.windows).toHaveLength(0)
    expect(gated?.stale).toBe(true)
  })
})

describe('QuotaPoller.sweep', () => {
  const DISABLED = 'cccccccc-0000-4000-8000-000000000002'
  const AGY = 'cccccccc-0000-4000-8000-000000000003'
  const SUSPECT = 'cccccccc-0000-4000-8000-000000000004'

  beforeAll(() => {
    db.db()
      .prepare(
        `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                              max_concurrent, role, health_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(DISABLED, 'disabled-worker', 'claude-code', join(dir, 'w2'), 0, 0, 1, 'worker', null, Date.now())

    db.db()
      .prepare(
        `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                              max_concurrent, role, health_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(AGY, 'agy-worker', 'antigravity-cli', join(dir, 'w3'), 1, 0, 1, 'worker', null, Date.now())

    db.db()
      .prepare(
        `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                              max_concurrent, role, health_json, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        SUSPECT,
        'suspect-worker',
        'claude-code',
        join(dir, 'w4'),
        1,
        0,
        1,
        'worker',
        JSON.stringify({ state: 'suspect', reason: 'dead run' }),
        Date.now()
      )
  })

  it('skips disabled and suspect workers during background sweep', async () => {
    sample({ ageMs: 60_000, windows: [['session', 10]] })
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(AGY, 'session', 'session', 25, Date.now() + 3600_000, 'cli', Date.now() - 60_000)
    const heard: DatedQuota[] = []
    const poller = new quota.QuotaPoller((q) => heard.push(q))

    await poller.sweep()

    expect(heard.some((q) => q.workerId === DISABLED)).toBe(false)
    expect(heard.some((q) => q.workerId === SUSPECT)).toBe(false)
  })

  /**
   * ⛔ **The sweep starts no process, however old the reading is.** It used to: one worker per pass
   * whose reading had aged past a floor got a real interactive session opened on it and `/usage`
   * typed in. That spent terminals on accounts nobody was about to route work to — 150 probe
   * sessions against 14 that did any work in four days — and *still* left an idle worker reading
   * stale for most of every cycle, because a reading is trusted for 15m and the floor was 2h
   * (measured on ClaudeSecond, 2026-08-31). Freshness belongs at the gate that needs it.
   */
  it('opens nothing on a worker whose reading is hours old', async () => {
    const at = Date.now() - 3 * 3600_000
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(AGY, 'session', 'session', 25, at + 3600_000, 'cli', at)

    const poller = new quota.QuotaPoller(() => {})
    await poller.sweep()

    // Untouched: the sweep neither refreshed it nor overwrote it with an empty probe.
    const after = quota.lastQuota(AGY)
    expect(after?.sampledAt).toBe(at)
    expect(after?.windows).toHaveLength(1)
    // ⚠️ And no session was opened to do it. This is the assertion the old sweep would fail.
    const sessions = db.row<{ n: number }>(`select count(*) as n from sessions`)
    expect(sessions?.n ?? 0).toBe(0)
  })

  it('does not wipe out screen-answered adapter reading with probeWorker when not refreshing', async () => {
    sample({ ageMs: 60_000, windows: [['session', 10]] })
    // Seed an existing reading on AGY
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(AGY, 'session', 'session', 25, Date.now() + 3600_000, 'cli', Date.now() - 60_000)

    const heard: DatedQuota[] = []
    const poller = new quota.QuotaPoller((q) => heard.push(q))

    await poller.sweep()

    // It should not have probed AGY with probeWorker (which would write windows: [] sample)
    const after = quota.lastQuota(AGY)
    expect(after?.windows).toHaveLength(1)
    expect(after?.windows[0]?.percent).toBe(25)
  })
})

/**
 * Fresh and wrong at the same time.
 *
 * ⛔ `stale` is an age test, and age is not the only way a percentage stops being true. A reading
 * taken two minutes before a window resets is as fresh as a reading gets, and every number in it
 * expires with the window it counted — while `STALE_AFTER_MS` keeps vouching for it for hours.
 * Measured on t60, 2026-08-31: ClaudeThird's 5h window read `percent: 88` with `resetsAt` 06:39:59Z
 * and was still being offered as 88% at 06:46Z, on an account whose window had emptied.
 */
describe('a window that has already turned over', () => {
  it('is expired once its reset has passed, however new the reading is', () => {
    const now = Date.now()
    expect(quota.windowExpired({ id: 'session', label: '5h', percent: 88, resetsAt: now - 1 })).toBe(
      true
    )
    expect(
      quota.windowExpired({ id: 'session', label: '5h', percent: 88, resetsAt: now + 60_000 })
    ).toBe(false)
  })

  it('says nothing about a window that never carried a reset time', () => {
    // ⚠️ Absent is not past. A provider that reports no reset — codex's 30d window among them — must
    //    not have its readings thrown away on a field it does not send.
    expect(quota.windowExpired({ id: '30d', label: '30d', percent: 37, resetsAt: null })).toBe(false)
  })
})
