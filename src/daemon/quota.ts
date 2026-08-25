import type { QuotaSnapshot } from '@shared/protocol.js'
import { db, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { listWorkers, requireWorker } from './workers.js'
import { log } from './log.js'

/**
 * The quota poller.
 *
 * ⚠️ **Read this before trusting a percentage.** The plan assumed `claude -p /usage` was a free live
 * probe. Measured on 2026-08-25 against CLI 2.1.223, it is not: the slash command is taken as a
 * prompt, spends a real assistant turn, and answers in prose. Polling every account on an interval
 * that way would have billed the fleet for the privilege of watching itself.
 *
 * What is actually available is the CLI's own `cachedUsageUtilization` cache, which it refreshes on
 * its own schedule - the reading on the development machine was **19 days old**. So this module's
 * job is not to produce a number. It is to produce a number *with its age attached*, and to let
 * everything downstream refuse a stale one.
 *
 * ⛔ A stale percentage rendered as current is worse than no percentage: it makes the compaction
 * reserve (cost-model.md §5) look satisfied when it is not, and that failure strands context.
 */

/** Beyond this, a sample is reported but must not be treated as the current state of the window. */
export const STALE_AFTER_MS = 15 * 60 * 1000

export interface DatedQuota extends QuotaSnapshot {
  ageMs: number
  stale: boolean
}

function decorate(snapshot: QuotaSnapshot): DatedQuota {
  const ageMs = Math.max(0, Date.now() - snapshot.sampledAt)
  return { ...snapshot, ageMs, stale: ageMs > STALE_AFTER_MS || snapshot.windows.length === 0 }
}

export async function probeWorker(workerId: string): Promise<DatedQuota> {
  const w = requireWorker(workerId)
  const probed = await adapter(w.adapterId).probeQuota(w.isolationRoot)
  const snapshot: QuotaSnapshot = { workerId, ...probed }
  store(snapshot)
  return decorate(snapshot)
}

function store(s: QuotaSnapshot): void {
  const stmt = db().prepare(
    `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  if (s.windows.length === 0) {
    // Record the failure too. A gap in the series is indistinguishable from a healthy quiet period.
    stmt.run(s.workerId, '', '', 0, null, s.source, s.error ?? 'no windows reported', s.sampledAt)
    return
  }
  for (const w of s.windows) {
    stmt.run(s.workerId, w.id, w.label, w.percent, w.resetsAt, s.source, s.error ?? null, s.sampledAt)
  }
}

interface SampleRow {
  window_id: string
  label: string
  percent: number
  resets_at: number | null
  source: string
  error: string | null
  sampled_at: number
}

/** The most recent sample for a worker, however old. Callers must look at `stale`. */
export function lastQuota(workerId: string): DatedQuota | null {
  const latest = db()
    .prepare('select max(sampled_at) as t from quota_samples where worker_id = ?')
    .get(workerId) as { t: number | null } | undefined
  if (!latest?.t) return null

  const list = rows<SampleRow>(
    db()
      .prepare('select * from quota_samples where worker_id = ? and sampled_at = ?')
      .all(workerId, latest.t)
  )
  const first = list[0]
  if (!first) return null

  return decorate({
    workerId,
    windows: list
      .filter((r) => r.window_id !== '')
      .map((r) => ({ id: r.window_id, label: r.label, percent: r.percent, resetsAt: r.resets_at })),
    sampledAt: first.sampled_at,
    source: first.source as QuotaSnapshot['source'],
    ...(first.error ? { error: first.error } : {})
  })
}

export type QuotaListener = (q: DatedQuota) => void

export class QuotaPoller {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly listener: QuotaListener,
    private readonly intervalMs = 5 * 60 * 1000
  ) {}

  start(): void {
    if (this.timer) return
    void this.sweep()
    this.timer = setInterval(() => void this.sweep(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Every failure is swallowed on purpose. A quota probe that throws must never stall the loop that
   * schedules work - the fleet degrades to "unknown, treat conservatively" and keeps running.
   */
  async sweep(): Promise<void> {
    for (const w of listWorkers()) {
      try {
        this.listener(await probeWorker(w.id))
      } catch (err) {
        log.warn(`quota probe failed for ${w.label}:`, err)
      }
    }
  }
}
