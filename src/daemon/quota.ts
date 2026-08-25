import type { QuotaSnapshot } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
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

// ---------------------------------------------------------------------------- the live rung

export interface LiveRateLimit {
  status: string
  windowId: string
  resetsAt: number | null
  sampledAt: number
}

/**
 * Record a `rate_limit_event` from the stream transport.
 *
 * This is the one quota signal that is both **live and free** - it rides a turn already being paid
 * for. It carries no size, so it cannot satisfy the compaction reserve on its own; what it does give
 * is a trustworthy **reset time** (which preemption needs) and an early warning when the status stops
 * being `allowed`.
 */
export function recordRateLimit(
  workerId: string,
  sessionId: string | null,
  info: { status: string; rateLimitType: string; resetsAt: number | null }
): void {
  db()
    .prepare(
      `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
       values (?,?,?,?,?,?)`
    )
    .run(workerId, sessionId, info.rateLimitType, info.status, info.resetsAt, Date.now())

  if (info.status !== 'allowed') {
    log.warn(`worker ${workerId.slice(0, 8)} rate limit status is '${info.status}' (${info.rateLimitType})`)
  }
}

export function lastRateLimit(workerId: string): LiveRateLimit | null {
  const r = row<{
    status: string
    window_id: string
    resets_at: number | null
    sampled_at: number
  }>(
    db()
      .prepare('select * from rate_limit_samples where worker_id = ? order by sampled_at desc limit 1')
      .get(workerId)
  )
  return r
    ? { status: r.status, windowId: r.window_id, resetsAt: r.resets_at, sampledAt: r.sampled_at }
    : null
}

/**
 * When this worker's current window resets, from the best source available.
 *
 * Preferred: a live `rate_limit_event`, which is current by construction. Fallback: whatever
 * `resets_at` the config cache carried, which may be from a window that has already turned over -
 * so a reset time in the past is discarded rather than treated as "any moment now".
 */
export function windowResetsAt(workerId: string): { at: number; source: string } | null {
  const live = lastRateLimit(workerId)
  if (live?.resetsAt && live.resetsAt > Date.now()) {
    return { at: live.resetsAt, source: 'live rate-limit record' }
  }
  const cached = lastQuota(workerId)
  const window = cached?.windows.find((w) => w.id === 'session' || w.id === '5h')
  if (window?.resetsAt && window.resetsAt > Date.now()) {
    return { at: window.resetsAt, source: 'config cache' }
  }
  return null
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
