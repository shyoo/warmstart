import type { QuotaSnapshot } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { stripAnsi } from './stream.js'
import { listWorkers, refreshIdentityIfStale, requireWorker } from './workers.js'
import { log } from './log.js'

/**
 * The quota poller.
 *
 * ⚠️ **Read this before trusting a percentage.** The plan assumed `claude -p /usage` was a free live
 * probe. Measured on 2026-08-25 against CLI 2.1.223, it is not: the slash command is taken as a
 * prompt, spends a real assistant turn, and answers in prose. Polling every account on an interval
 * that way would have billed the fleet for the privilege of watching itself.
 *
 * ⭐ **But that is a fact about print mode, and for three months it was read as a fact about the
 * product.** Measured 2026-08-27: `/usage` typed into an *interactive* session is a client-side
 * command, spends nothing, and rewrites `cachedUsageUtilization` on disk. `refreshUsage` below does
 * exactly that, and a cache that had been 20 days stale came back seconds old. The claim that this
 * project had no free quota probe was true of one code path and repeated everywhere.
 *
 * So there are two rungs and they are not the same operation. `probeWorker` **reads** the CLI's
 * `cachedUsageUtilization`, which the vendor refreshes on its own schedule and may leave for weeks.
 * `refreshUsage` **makes** that cache current, at the price of a process rather than a token. Both
 * report a number *with its age attached*, and everything downstream may still refuse a stale one.
 *
 * ⛔ A stale percentage rendered as current is worse than no percentage: it makes the compaction
 * reserve (cost-model.md §5) look satisfied when it is not, and that failure strands context.
 */

/** Beyond this, a sample is reported but must not be treated as the current state of the window. */
export const STALE_AFTER_MS = 15 * 60 * 1000

/**
 * How old a reading has to be before it is worth starting a process to replace it.
 *
 * ⚠️ Deliberately longer than `STALE_AFTER_MS`, and the gap is not an oversight. Fifteen minutes is
 * how long a number may be *trusted*; thirty is how often it is worth *spending a terminal* to
 * renew one. Setting these equal would mean a fleet permanently refreshing, since a reading becomes
 * untrusted at exactly the moment it becomes renewable.
 */
export const REFRESH_AFTER_MS = 30 * 60 * 1000

/** How long a stored answer to "who is signed in, and is this root set up?" may go unchecked. */
export const IDENTITY_STALE_AFTER_MS = 15 * 60 * 1000

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

/**
 * Make the CLI go and get a fresh number, then read it.
 *
 * ⭐ This is the free live probe the project spent three months believing it could not have.
 * `probeWorker` reads a cache the vendor refreshes on its own schedule — 20 days stale on this
 * machine — and `refreshUsage` is what makes that cache current: open a TUI, type the adapter's
 * declared command into it, wait, close it, read the file. Measured 2026-08-27 on claude 2.1.223:
 * `fetchedAtMs` moved from 2026-08-06T23:35Z to 2026-08-27T00:16Z, and the reading it produced
 * (79% of the weekly window) disagreed with the stale one (98%) by enough to change every decision
 * downstream.
 *
 * ⛔ Costs no tokens. A slash command is handled by the client, which is the same property that makes
 * `/compact` a function call rather than a prompt. ⚠️ It is not free of *everything*: it starts a
 * process and takes the better part of thirty seconds, so it belongs on a slow timer and on the
 * button a person pressed — never in a scheduler tick.
 */
export async function refreshUsage(workerId: string): Promise<DatedQuota> {
  const w = requireWorker(workerId)
  const refresh = adapter(w.adapterId).info.usageRefresh

  if (!refresh) {
    // Not a failure. Most CLIs have nothing to drive, and saying so beats a probe that quietly
    // returns the same stale number every time it is asked.
    return probeWorker(workerId)
  }

  // What we are trying to beat. A refresh that changes nothing must not come back looking fresh.
  const before = lastQuota(workerId)?.sampledAt ?? 0

  const { spawnSession, closeSession, writeSession, backscroll } = await import('./sessions.js')
  let sessionId: string | null = null
  let screen: string | null = null
  try {
    const session = spawnSession({
      workerId,
      purpose: 'probe',
      transport: 'pty',
      // ⚠️ Load-bearing for a screen-answered refresh, and the adapter is what knows how big its own
      // panel is. Measured 2026-08-27 against the live account: at 30 rows Antigravity's `/usage`
      // panel scrolled and one group's five-hour window fell below the fold — three windows read
      // where there were four, with no error, and the missing one a candidate for the `5h` gate.
      cols: refresh.cols ?? 100,
      rows: refresh.rows ?? 30
    })
    sessionId = session.id
    log.info(`refreshing usage on ${w.label} via \`${refresh.command}\``)

    await wait(refresh.readyMs)
    writeSession(session.id, `${refresh.command}\r`)
    await wait(refresh.settleMs)
    // ⛔ Read before the session is closed - `backscroll` is keyed on a live session.
    if (refresh.answer === 'screen') screen = stripAnsi(backscroll(session.id))
  } catch (err) {
    // ⚠️ Never fatal. A refresh that fails leaves the previous reading exactly as it was, with its
    // age attached, which is the state everything downstream already knows how to distrust.
    log.warn(`usage refresh failed on ${w.label}:`, err)
  } finally {
    // ⛔ By session id, which is how this app kills anything: `closeSession` stops only the pid it
    // recorded and only after checking the process is still the one it started.
    if (sessionId) closeSession(sessionId)
  }

  // ⛔ The screen path, for a provider that writes the number nowhere. It never falls through to
  // `probeWorker`, because there is no file for it to read - `probeQuota()` on such an adapter says
  // exactly that. See UsageRefresh.answer, and parseUsageScreen for why this exception exists.
  if (refresh.answer === 'screen') {
    const parse = adapter(w.adapterId).parseUsage
    const windows = screen && parse ? parse(screen) : null
    if (!windows) {
      // ⚠️ A rendering that did not parse is an unknown, not a zero. The commonest cause is real and
      // worth naming: this CLI asks about folder trust per directory and swallows every keystroke
      // until it is answered, so the command can be typed into a dialog and vanish.
      const why =
        `\`${refresh.command}\` was typed into ${w.label} but its usage panel did not appear. ` +
        (screen === null
          ? 'The probe session did not start, so nothing was read.'
          : 'The session may still have been starting, or a folder-trust dialog may have taken the ' +
            'keystrokes - this CLI asks that question per directory and swallows input until it is ' +
            'answered.')
      log.warn(why)
      const failed: QuotaSnapshot = {
        workerId,
        windows: [],
        sampledAt: Date.now(),
        source: 'unknown',
        error: why
      }
      store(failed)
      return decorate(failed)
    }
    const snapshot: QuotaSnapshot = {
      workerId,
      windows,
      // ⚠️ Our clock, deliberately, unlike the config-cache path where the key is the *vendor's*
      // fetch time. There is no vendor timestamp to borrow here: the CLI just refreshed on being
      // asked, so the reading is as old as this moment and no older.
      sampledAt: Date.now(),
      source: 'cli'
    }
    store(snapshot)
    log.info(
      `usage on ${w.label}: ${windows.map((x) => `${x.label} ${Math.round(x.percent)}% used`).join(' · ')}`
    )
    return decorate(snapshot)
  }

  const after = await probeWorker(workerId)

  // ⚠️ Did it actually work? Measured 2026-08-27: on a **commissioned worker** it does not, and the
  // failure is silent unless something checks. `claude auth login` writes the credential but not the
  // first-run flags, so an isolation root has `oauthAccount` and no `hasCompletedOnboarding` — and an
  // interactive session there opens the theme picker, then the login-method chooser. The keystroke
  // meant for `/usage` is eaten by onboarding and the cache is never written. Print mode skips all of
  // that, which is why scheduled work on the same root runs perfectly well and hides the problem.
  if (after.windows.length === 0 || after.sampledAt <= before) {
    // ⛔ Report what was checked, not what is usually true. The first version of this message named
    // onboarding as "the usual cause" and kept saying so after onboarding was finished — sending
    // somebody to redo a step they had already done while the real cause (an unanswered folder-trust
    // dialog eating the keystroke) went unmentioned. A diagnosis nobody verified is a guess wearing
    // a diagnosis's clothes.
    const fresh = requireWorker(workerId)
    const why =
      `\`${refresh.command}\` was typed into ${w.label} but no fresher reading appeared. ` +
      (fresh.identity?.setupComplete === false
        ? 'This worker has not finished the CLI\'s first-run questions — a theme, a login method, ' +
          'and whether it trusts the folder the session opens in. Until they are answered the CLI ' +
          'swallows anything typed at it. Use Finish setup on this worker.'
        : 'Its first-run state looks complete, so this is something else — the CLI may have changed ' +
          'what the command does, or the session may need longer than the adapter allows.')
    log.warn(why)
    const snapshot: QuotaSnapshot = {
      workerId,
      windows: after.windows,
      sampledAt: after.sampledAt,
      source: after.source,
      error: why
    }
    store(snapshot)
    return decorate(snapshot)
  }

  return after
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Record a reading.
 *
 * ⛔ `insert or replace`, keyed on (worker, window, `sampled_at`), because `sampled_at` is the
 * *vendor's* fetch time and not ours. Reading a cache the CLI has not refreshed since the last poll
 * produces a row identical to the one already there, and a plain insert kept both - which is what
 * made the fleet strip grow a second `session`/`weekly` pair every five minutes and a third five
 * minutes after that. Re-reading the same reading is not a new sample.
 */
function store(s: QuotaSnapshot): void {
  const stmt = db().prepare(
    `insert or replace into quota_samples
       (worker_id, window_id, label, percent, resets_at, source, error, sampled_at)
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

  // ⚠️ Deduplicated here as well as in the index. A database written by an older build carries the
  // duplicates the unique index now prevents, and this is what a person sees - one row per window is
  // a claim the reader can check, and a strip showing `weekly` three times is one they cannot.
  const byWindow = new Map<string, SampleRow>()
  for (const r of list) if (r.window_id !== '' && !byWindow.has(r.window_id)) byWindow.set(r.window_id, r)

  return decorate({
    workerId,
    windows: [...byWindow.values()].map((r) => ({
      id: r.window_id,
      label: r.label,
      percent: r.percent,
      resetsAt: r.resets_at
    })),
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
    // ⚠️ **At most one per sweep, and only when the reading is genuinely old.** Reading the cache is
    // a file read; refreshing it starts a real process for the better part of a minute. Refreshing
    // every worker every five minutes would turn a free probe into a fleet that spends its day
    // opening terminals to look at itself — which is the shape of the mistake `-p /usage` already
    // made once, in tokens rather than in processes.
    let refreshed = false

    for (const w of listWorkers()) {
      try {
        // ⚠️ Identity is a cached belief and nothing used to expire it. ClaudeFirst read "not signed
        // in" on 2026-08-27 while its isolation root held a valid credential, because the `false`
        // was written before somebody signed in and only a button nobody knew about would have
        // corrected it. Free: a local subprocess, and only when the answer is genuinely old.
        await refreshIdentityIfStale(w.id, IDENTITY_STALE_AFTER_MS)
        if (!refreshed && this.shouldRefresh(w.id)) {
          refreshed = true
          this.listener(await refreshUsage(w.id))
          continue
        }
        this.listener(await probeWorker(w.id))
      } catch (err) {
        log.warn(`quota probe failed for ${w.label}:`, err)
      }
    }
  }

  /**
   * Is it worth opening a terminal to find out?
   *
   * ⛔ `loggedIn === false` is excluded rather than merely deprioritised: a TUI on an account nobody
   * is signed in to sits on its login screen for the whole timeout and answers nothing. `null` is
   * allowed through, as everywhere else — unknown is not the same as no.
   */
  private shouldRefresh(workerId: string): boolean {
    const w = requireWorker(workerId)
    if (w.retiredAt || !w.enabled) return false
    if (w.identity?.loggedIn === false) return false
    if (!adapter(w.adapterId).info.usageRefresh) return false

    const last = lastQuota(workerId)
    // Never read at all, or read so long ago that nothing downstream is allowed to use it.
    return !last || last.windows.length === 0 || last.ageMs > REFRESH_AFTER_MS
  }
}
