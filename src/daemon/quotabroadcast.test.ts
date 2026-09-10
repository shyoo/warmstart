import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'

/**
 * A reading was written and nobody was told.
 *
 * ⛔ **The measured bug (t86, 2026-09-01).** The fleet strip sat on a three-hour-old percentage
 * across the resume of a task, on an account the dispatch gate had just refreshed. Every rung that
 * *reads* a window was working; what was missing is that only two of the four callers that store one
 * announced it. `QuotaPoller.sweep` called its listener, `worker.probe` emitted by hand, and the two
 * paths that matter most to somebody watching a run — `ensureFreshQuota` at the dispatch gate, and
 * `captureQuotaAfter` when the run ends — wrote a fresh row and said nothing. The renderer patches
 * its fleet on `quota.changed` and had no other way to learn.
 *
 * ⚠️ So the rule under test is not "the poller emits". It is **storing a reading is what emits it**,
 * which is the only version of this that cannot be reintroduced by adding a fifth caller. See
 * `store` in quota.ts and the note on the sink in events.ts.
 */

let dir: string
let db: typeof import('./db.js')
let events: typeof import('./events.js')
let quota: typeof import('./quota.js')

const WORKER = 'dddddddd-0000-4000-8000-000000000001'
/** An adapter with no `usageRefresh` to drive, so the refresh rung degrades to the file read. */
const NO_REFRESH_WORKER = 'dddddddd-0000-4000-8000-000000000002'

const heard: DaemonEvent[] = []
const quotaEvents = (): Array<Extract<DaemonEvent, { type: 'quota.changed' }>> =>
  heard.filter((e): e is Extract<DaemonEvent, { type: 'quota.changed' }> => e.type === 'quota.changed')

/** A good reading on disk, `ageMs` old, as the vendor's cache would have left it. */
function seedReading(ageMs: number, percent = 42): void {
  const at = Date.now() - ageMs
  db.db()
    .prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(WORKER, 'session', 'Claude 5h', percent, at + 3_600_000, 'config-cache', at)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-quotacast-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  events = await import('./events.js')
  quota = await import('./quota.js')
  db.openDb(join(dir, 'quotacast.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    // ⚠️ An isolation root with no `.claude.json` in it, so `probeQuota` answers the way a real
    // failed read does — empty windows and a reason — without a CLI anywhere near this test.
    .run(WORKER, 'test', 'claude-code', join(dir, 'w'), 1, 0, 1, 'worker', Date.now())
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(NO_REFRESH_WORKER, 'local', 'local-llm', join(dir, 'w2'), 1, 0, 1, 'worker', Date.now())
  events.setEventSink((e) => heard.push(e))
})

beforeEach(() => {
  db.db().exec('delete from quota_samples')
  heard.length = 0
})

afterAll(() => {
  events.setEventSink(() => {})
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('storing a reading announces it', () => {
  it('emits quota.changed when a probe writes a sample', async () => {
    await quota.probeWorker(WORKER)
    expect(quotaEvents().map((e) => e.quota.workerId)).toContain(WORKER)
  })

  /**
   * ⛔ The *display* reading, not the raw snapshot that was just stored. A failed probe writes a row
   * with no windows, which is newer than the last good reading and would bury it — the card would
   * read `quota unknown` about an account measured successfully a minute earlier. `lastQuotaReading`
   * is the accessor that already resolves this, and the broadcast has to use the same one or the
   * strip disagrees with what a refetch would give it.
   */
  it('broadcasts the last good numbers when the newest attempt failed', async () => {
    seedReading(60_000, 42)
    await quota.probeWorker(WORKER)

    const last = quotaEvents().at(-1)?.quota
    expect(last?.windows.map((w) => w.percent)).toEqual([42])
    expect(last?.error).toBeTruthy()
  })

  /**
   * The bug as the operator met it: a run is in flight, the gate refreshes the account, and the
   * strip keeps showing the number it had.
   *
   * ⚠️ Driven through `refreshUsage` on an adapter that declares **no** `usageRefresh`, where it
   * falls straight through to the file read — the same store, and no terminal opened by a unit
   * test. `ensureFreshQuota` itself is fire-and-forget by design (the scheduler tick must not wait
   * on a PTY), so what is pinned here is the store it eventually reaches, which is the link that
   * was missing.
   */
  it('reaches the strip on the path the dispatch gate takes', async () => {
    await quota.refreshUsage(NO_REFRESH_WORKER)

    expect(quotaEvents().map((e) => e.quota.workerId)).toContain(NO_REFRESH_WORKER)
  })
})
