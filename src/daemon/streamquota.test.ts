import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The quota reading that arrives free, in the middle of a turn.
 *
 * ⭐ Measured 2026-09-13 on claude 2.1.270: every `rate_limit_event` carries
 * `unifiedWindows: {five_hour: {utilization, resetsAt}, seven_day: {…}}`, riding a turn already being
 * paid for. The alternative is `probeQuota`, which reads a vendor cache that only moves when a
 * `/usage` PTY drive runs — measured 19 days stale on this machine.
 *
 * ⛔ **The reason this is guarded rather than simply published**: a snapshot is atomic. `sampleAt`
 * returns every row sharing the newest `sampled_at`, so a reading naming two windows *replaces* one
 * that named three — an account with a separate Opus pool would stop having one, at full confidence,
 * with no error anywhere. So the live reading is published only where it names every window the
 * newest stored reading named.
 */

let dir: string
let db: typeof import('./db.js')
let quota: typeof import('./quota.js')

const WORKER = 'dddddddd-0000-4000-8000-000000000001'

function storedWindows(): Array<{ id: string; percent: number }> {
  return (quota.lastQuotaReading(WORKER)?.windows ?? []).map((w) => ({
    id: w.id,
    percent: w.percent
  }))
}

function cached(windows: Array<[string, number]>, ageMs = 3_600_000): void {
  const at = Date.now() - ageMs
  for (const [id, pct] of windows) {
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(WORKER, id, id, pct, null, 'config-cache', at)
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-streamquota-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  db.openDb(join(dir, 'streamquota.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(WORKER, 'test', 'claude-code', join(dir, 'w'), 1, 0, 1, 'worker', Date.now())
})

beforeEach(() => {
  db.db().exec('delete from quota_samples')
  db.db().exec('delete from rate_limit_samples')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('windows volunteered by a rate-limit record', () => {
  it('become a reading of their own, stamped with our clock rather than the cache’s', () => {
    const before = Date.now()
    quota.recordRateLimit(WORKER, null, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: null,
      windows: [
        { id: 'session', label: 'Claude 5h', percent: 12, resetsAt: null },
        { id: 'weekly_all', label: 'Claude 7d', percent: 43, resetsAt: null }
      ]
    })
    const reading = quota.lastQuotaReading(WORKER)
    expect(reading?.source).toBe('stream')
    expect(reading?.windows.map((w) => w.percent)).toEqual([12, 43])
    // ⚠️ Ours, deliberately. The record describes the request happening now, so the age shown is
    // seconds — where a config-cache reading is stamped with whenever the vendor last refreshed it.
    expect(reading?.sampledAt).toBeGreaterThanOrEqual(before)
  })

  it('replaces a stale cached reading of the same windows', () => {
    cached([['session', 90], ['weekly_all', 91]])
    quota.recordRateLimit(WORKER, null, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: null,
      windows: [
        { id: 'session', label: 'Claude 5h', percent: 12, resetsAt: null },
        { id: 'weekly_all', label: 'Claude 7d', percent: 43, resetsAt: null }
      ]
    })
    expect(storedWindows()).toEqual([
      { id: 'session', percent: 12 },
      { id: 'weekly_all', percent: 43 }
    ])
  })

  /**
   * ⛔ The case the guard exists for. An account with an Opus pool has three windows in its cache,
   * and a record naming two would delete the third by being newer. The honest outcome is to decline
   * the whole reading: the account keeps the cadence it already had, which is what it had anyway.
   */
  it('is declined entirely when it would drop a window the account is known to have', () => {
    cached([['session', 90], ['weekly_all', 91], ['weekly_opus', 62]])
    quota.recordRateLimit(WORKER, null, {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: null,
      windows: [
        { id: 'session', label: 'Claude 5h', percent: 12, resetsAt: null },
        { id: 'weekly_all', label: 'Claude 7d', percent: 43, resetsAt: null }
      ]
    })
    expect(storedWindows()).toEqual([
      { id: 'session', percent: 90 },
      { id: 'weekly_all', percent: 91 },
      { id: 'weekly_opus', percent: 62 }
    ])
  })

  it('publishes nothing at all for a record that named no windows', () => {
    quota.recordRateLimit(WORKER, null, {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt: null
    })
    expect(quota.lastQuotaReading(WORKER)).toBeNull()
    // ⚠️ The rate-limit sample itself is still recorded: the *status* is what preemption reads, and
    // it arrives whether or not the vendor also sent sizes.
    expect(quota.lastRateLimit(WORKER)?.status).toBe('allowed_warning')
  })
})
