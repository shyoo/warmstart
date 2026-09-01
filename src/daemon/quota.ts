import type { QuotaSnapshot, QuotaWindow } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { adapter } from './adapters/index.js'
import { stripAnsi } from './stream.js'
import { listWorkers, refreshIdentityIfStale, requireWorker } from './workers.js'
import { settings } from './settings.js'
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
 * The shortest gap between two attempts to refresh one worker's reading.
 *
 * ⚠️ **A gap between *attempts*, not a function of how old the reading is** — and that distinction
 * is the whole point. Refreshing is only worth starting when something is about to act on the
 * number, so the clock that used to drive it is gone (see `QuotaPoller.sweep`); what is left is a
 * floor, so that a gate asked twice in a minute opens one terminal rather than two.
 *
 * ⛔ **Keyed on the attempt because a failed refresh cannot move the reading.** On the config-cache
 * path a refresh that produced nothing fresher stores the *vendor's* old `sampledAt` — correctly,
 * since inventing a timestamp for a number nobody re-read is the one thing worse than an old
 * number. Anything deriving "try again?" from the reading's age therefore says *yes* forever on
 * precisely the worker that cannot answer: the old sweep, which allowed one refresh per pass, had
 * that worker re-claim the single slot every five minutes and starve every worker behind it in
 * `listWorkers()` order indefinitely. Recording the attempt is what ends that.
 *
 * ⭐ Ten minutes, matching the dispatch gate's own retry, which this replaced — there is one number
 * now instead of two that could drift apart.
 */
export const REFRESH_BACKOFF_MS = 10 * 60 * 1000

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
  // ⛔ Logged whether it worked or not. This is the cheap rung — a file read, no process — and it is
  // the one that runs on its own every few minutes, so it is also the one an operator is most likely
  // to be asking about: *when did it last look at that account, and what did it see?* It said
  // nothing at all until 2026-08-28, which made a poller that was working indistinguishable from one
  // that had stopped.
  log.info(
    `probed ${w.label}: ` +
      (probed.windows.length
        ? probed.windows.map((x) => `${x.label} ${Math.round(x.percent)}%`).join(' · ')
        : `no reading (${probed.error ?? 'no windows returned'})`)
  )
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

  const { spawnSession, closeSession, writeSession, backscroll, whyNoSession } =
    await import('./sessions.js')

  // ⛔ Asked before trying, not caught afterwards. A worker that cannot host a session is not a
  // failed refresh - it is a worker whose reading has to come off the disk instead, which is
  // exactly what `probeWorker` does. Spawning anyway logged a stack trace under the word
  // `failed` for the entirely expected case of probing a disabled account.
  const blocked = whyNoSession(w, 'probe')
  if (blocked) {
    log.info(`not driving \`${refresh.command}\` on ${w.label}: ${blocked}; reading the cache`)
    return probeWorker(workerId)
  }

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
  return sampleAt(workerId, latestSampleTime(workerId, false))
}

/**
 * The most recent sample that actually carries windows — what a person should be shown.
 *
 * ⛔ **Display only. Never a gate.** `lastQuota` stays the scheduler's accessor and is unchanged;
 * everything that gates still reads the newest attempt and still refuses anything `stale`. This
 * exists because the two questions are different: a gate asks *what is the window now*, and a person
 * reading the strip asks *what do we know about this account*.
 *
 * ⚠️ A failed probe writes a sample with **no windows** — which is newer than the last good reading
 * and therefore buried it. The card then said `quota unknown` about an account that had been read
 * successfully an hour earlier, which is indistinguishable from one that has never been read at all.
 * The reading that comes back here carries its own `sampledAt`, so the age shown is the age of the
 * numbers shown, and `error` is carried across from the newest attempt when that attempt failed.
 */
export function lastQuotaReading(workerId: string): DatedQuota | null {
  const withWindows = sampleAt(workerId, latestSampleTime(workerId, true))
  if (!withWindows) return lastQuota(workerId)
  const newest = lastQuota(workerId)
  // The newest attempt failed and this is an older reading: say so, rather than presenting the old
  // numbers as though nothing had gone wrong since.
  return newest && newest.sampledAt > withWindows.sampledAt && newest.error
    ? { ...withWindows, error: newest.error, stale: true }
    : withWindows
}

/** ⚠️ `window_id != ''` is how a failed probe is stored: one row, no window, an error beside it. */
function latestSampleTime(workerId: string, mustHaveWindows: boolean): number | null {
  const r = db()
    .prepare(
      `select max(sampled_at) as t from quota_samples where worker_id = ?` +
        (mustHaveWindows ? " and window_id != ''" : '')
    )
    .get(workerId) as { t: number | null } | undefined
  return r?.t ?? null
}

function sampleAt(workerId: string, at: number | null): DatedQuota | null {
  const latest = { t: at }
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
 * How long a rate-limit *status* is worth acting on.
 *
 * ⚠️ The reset time on a sample stays true until it passes; the status does not. `allowed_warning`
 * describes the account as it was during one turn, and a gate reading it an hour later is quoting a
 * measurement, not taking one. Kept separate from expiry for exactly that reason - see
 * `freshRateLimit` against `lastRateLimit`.
 */
export const RATE_STATUS_FRESH_MS = 10 * 60 * 1000

/**
 * The vendor window names that mean *the short pool a single run can plausibly exhaust*.
 *
 * ⛔ **A worker has more than one rate-limit window and they disagree.** Claude Code emits
 * `five_hour` and `seven_day` for the same account minutes apart, and `lastRateLimit` used to return
 * whichever landed last - so a weekly advisory arrived wearing a five-hour one's clothes. Measured
 * 2026-08-31 on t71: at 22:00:50 the `five_hour` sample read `allowed`; twelve seconds later a
 * `seven_day` `allowed_warning` arrived, the run was preempted, and the task was parked against the
 * **seven-day** reset - `not_before` a full week out, on an account whose 5h window read 0% and
 * whose weekly read 25%.
 *
 * ⚠️ An open list, like `status`. A window this does not recognise is treated as *not* the session
 * pool, which is the conservative direction: it can still stop a run on a refusal, but it cannot
 * park one against a reset that may be days away.
 */
const SESSION_RATE_WINDOWS = new Set(['five_hour', '5h', 'session'])

export function isSessionRateWindow(windowId: string): boolean {
  return SESSION_RATE_WINDOWS.has(windowId)
}

/**
 * Did the vendor actually **refuse**, or merely caution?
 *
 * ⛔ The distinction the preemption bug turned on. `rejected` is a refusal: the turn did not
 * happen, and nothing downstream gets to second-guess it. `allowed_warning` is a turn that *was
 * served* alongside a caution - evidence that quota is moving, never proof that the next call fails.
 * Treating the two the same is what threw away a warm 278k-token session three times in six hours at
 * 0%, 17% and 19% of the very window being warned about.
 */
const REFUSAL_STATUS = 'rejected'

export function isRefusal(status: string): boolean {
  return status === REFUSAL_STATUS
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

/**
 * The newest sample **whose window has not already turned over**.
 *
 * ⛔ The expiry test is the same rule `windowExpired` applies to a quota reading, and it is here for
 * the same reason: a sample describing a window that has since reset is not old news, it is news
 * about something that no longer exists. Without it a single `allowed_warning` lingers as the
 * account's status until the next turn happens to produce a sample - which, on an account nothing is
 * running on, is never.
 *
 * ⚠️ This returns a sample of **any** window, so it answers "when does something reset" and not
 * "is this worker in trouble". A gate wants `freshRateLimit`; a five-hour decision wants
 * `sessionRateLimit`. Reaching for this one to make a judgement is the bug it was split up to stop.
 */
export function lastRateLimit(workerId: string, windowId?: string): LiveRateLimit | null {
  return pickRateLimit(workerId, { windowId })
}

/**
 * The newest unexpired sample on the **session** pool - the short window a single run can exhaust,
 * and the only one whose reset is close enough that parking a task against it is a pause rather
 * than an abandonment.
 */
export function sessionRateLimit(workerId: string): LiveRateLimit | null {
  return pickRateLimit(workerId, { sessionOnly: true })
}

/**
 * The newest sample that is both unexpired **and** recent enough to still describe the account.
 *
 * ⛔ The only one a gate may act on. See `RATE_STATUS_FRESH_MS`.
 */
export function freshRateLimit(workerId: string, windowId?: string): LiveRateLimit | null {
  return pickRateLimit(workerId, { windowId, maxAgeMs: RATE_STATUS_FRESH_MS })
}

/**
 * A live **refusal** on any window, whatever has arrived since.
 *
 * ⛔ Not `freshRateLimit(...)` plus an `isRefusal` test, and the difference is the whole point: the
 * samples are one stream shared by several windows, so a `seven_day` advisory landing a second after
 * a `five_hour` refusal makes the refusal invisible to anything that reads only the newest row. A
 * refusal is the strongest thing a vendor says and it has to be found on purpose.
 */
export function refusalRateLimit(workerId: string): LiveRateLimit | null {
  return pickRateLimit(workerId, { refusalsOnly: true, maxAgeMs: RATE_STATUS_FRESH_MS })
}

function pickRateLimit(
  workerId: string,
  opts: { windowId?: string; sessionOnly?: boolean; maxAgeMs?: number; refusalsOnly?: boolean }
): LiveRateLimit | null {
  const now = Date.now()
  const where = ['worker_id = ?', '(resets_at is null or resets_at > ?)']
  const args: Array<string | number> = [workerId, now]
  if (opts.windowId) {
    where.push('window_id = ?')
    args.push(opts.windowId)
  }
  if (opts.sessionOnly) {
    const names = [...SESSION_RATE_WINDOWS]
    where.push(`window_id in (${names.map(() => '?').join(',')})`)
    args.push(...names)
  }
  if (opts.maxAgeMs !== undefined) {
    where.push('sampled_at >= ?')
    args.push(now - opts.maxAgeMs)
  }
  if (opts.refusalsOnly) {
    where.push('status = ?')
    args.push(REFUSAL_STATUS)
  }
  const r = row<{
    status: string
    window_id: string
    resets_at: number | null
    sampled_at: number
  }>(
    db()
      .prepare(
        `select status, window_id, resets_at, sampled_at from rate_limit_samples
          where ${where.join(' and ')} order by sampled_at desc limit 1`
      )
      .get(...args)
  )
  return r
    ? { status: r.status, windowId: r.window_id, resetsAt: r.resets_at, sampledAt: r.sampled_at }
    : null
}

/**
 * A window that has already turned over, and therefore counts nothing.
 *
 * ⛔ **`stale` is an age test and this is not.** A reading taken two minutes before a reset is as
 * fresh as a reading gets, and every number in it stops being true the moment the window rolls. The
 * dispatch gate believed one for the better part of two hours: measured on t60, 2026-08-31,
 * ClaudeThird's 5h window read `percent: 88` with `resetsAt` 06:39:59Z and was still offered as 88%
 * at 06:46Z, on an account whose window had emptied.
 *
 * ⚠️ Expired means **unknown**, never zero. What the new window holds cannot be derived from the old
 * one, and a caller that reads this as free capacity is making up a number.
 *
 * ⭐ `windowResetsAt` has always discarded a reset in the past for exactly this reason; this is that
 * rule applied to the percentage sitting beside it.
 */
export function windowExpired(window: QuotaWindow, now = Date.now()): boolean {
  return window.resetsAt !== null && window.resetsAt !== undefined && window.resetsAt <= now
}

/**
 * When this worker's current window resets, from the best source available.
 *
 * Preferred: a live `rate_limit_event`, which is current by construction. Fallback: whatever
 * `resets_at` the config cache carried, which may be from a window that has already turned over -
 * so a reset time in the past is discarded rather than treated as "any moment now".
 */
export function windowResetsAt(workerId: string): { at: number; source: string } | null {
  // ⛔ `sessionRateLimit`, not `lastRateLimit`. Every caller of this treats the answer as *the*
  // window boundary - preemption parks a task until it, and `not_before` is written from it - so
  // handing back a seven-day reset here parks a run for a week over a five-hour concern. That is
  // not hypothetical: t71 sat at `not_before` 2026-09-07 from a 2026-08-31 advisory.
  const live = sessionRateLimit(workerId)
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
  private intervalMs: number

  constructor(
    private readonly listener: QuotaListener,
    intervalMs?: number
  ) {
    const configuredMinutes = settings().probeIntervalMinutes ?? 5
    this.intervalMs = intervalMs ?? configuredMinutes * 60 * 1000
  }

  setIntervalMinutes(minutes: number): void {
    const safeMinutes = Math.max(1, Math.min(1440, minutes))
    const ms = safeMinutes * 60 * 1000
    if (this.intervalMs === ms) return
    this.intervalMs = ms
    log.info(`quota poller interval set to ${safeMinutes}m`)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = setInterval(() => void this.sweep(), this.intervalMs)
      this.timer.unref?.()
    }
  }

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
   * Read every worker's cache off disk. **Nothing here starts a process.**
   *
   * ⛔ **The sweep no longer refreshes anything, and that is the point.** It used to open one
   * interactive session per pass on whichever worker's reading had aged past a two-hour gate — a
   * clock, spending a terminal on accounts nobody was about to route work to. Measured 2026-08-30:
   * **150 probe PTY sessions against 14 that did any work** over four days, each registering with
   * the vendor's bridge and accumulating in the desktop app until somebody archived it by hand.
   * Raising the gate 30m → 2h cut the count and bought nothing else: a reading is *trusted* for
   * fifteen minutes, so an idle worker still read `stale` for 1h50 of every 2h05 (measured on
   * ClaudeSecond, 2026-08-31 — `transient_docs/quota_staleness_2026-08-31.md`), and the operator
   * reasonably read a five-minute probe interval as a promise of a five-minute-old number.
   *
   * ⭐ So freshness moved to where it is *used*: `ensureFreshQuota` at the dispatch gate, and again
   * when a run ends. A worker nothing is about to dispatch to keeps whatever reading it has, which
   * costs nothing and is honest — and an idle account's window is not moving anyway.
   *
   * Every failure is swallowed on purpose. A quota probe that throws must never stall the loop that
   * schedules work - the fleet degrades to "unknown, treat conservatively" and keeps running.
   */
  async sweep(): Promise<void> {
    for (const w of listWorkers()) {
      if (w.retiredAt || !w.enabled || w.health?.state === 'suspect') continue
      try {
        // ⚠️ Identity is a cached belief and nothing used to expire it. ClaudeFirst read "not signed
        // in" on 2026-08-27 while its isolation root held a valid credential, because the `false`
        // was written before somebody signed in and only a button nobody knew about would have
        // corrected it. Free: a local subprocess, and only when the answer is genuinely old.
        await refreshIdentityIfStale(w.id, IDENTITY_STALE_AFTER_MS)
        // ⛔ An adapter whose usage is screen-answered writes no cache to disk: `probeQuota` returns
        // empty windows with an error. Running it here would wipe out the last successful reading and
        // replace it with `quota unknown` every five minutes.
        const a = adapter(w.adapterId)
        if (a.info.usageRefresh?.answer === 'screen' || a.info.capabilities.quotaProbe === 'none') {
          continue
        }
        // ⭐ Free, and not pointless: the vendor rewrites this cache on **any** use of the account,
        // including this fleet's own work sessions. A worker that is running tasks therefore keeps
        // its own reading current at the price of a file read.
        await probeWorker(w.id)
        const reading = lastQuotaReading(w.id)
        if (reading) this.listener(reading)
      } catch (err) {
        log.warn(`quota probe failed for ${w.label}:`, err)
      }
    }
  }

}

/**
 * May we open a terminal on this worker to read its usage, at all?
 *
 * ⛔ `loggedIn === false` is excluded rather than merely deprioritised: a TUI on an account nobody
 * is signed in to sits on its login screen for the whole timeout and answers nothing. `null` is
 * allowed through, as everywhere else — unknown is not the same as no.
 *
 * ⛔ An account a run has already proved work dies on is not asked either. The refresh is not free
 * in the way a file read is: on both adapters it opens a real interactive session and types into
 * it, so on a worker whose subscription has expired this would spawn a CLI to watch it fail to
 * authenticate and record `unknown` either way. Effectively the same state as disabled, and
 * treated as one.
 *
 * ⚠️ The *automatic* paths only. `probeWorker` and `refreshUsage` still run when the operator
 * presses Probe - that is one of the two things that lifts the hold, and a quarantine nobody can
 * attempt to clear by hand is the fault this whole mechanism was careful to avoid.
 */
export function mayRefreshUsage(workerId: string): boolean {
  const w = requireWorker(workerId)
  if (w.retiredAt || !w.enabled) return false
  if (w.identity?.loggedIn === false) return false
  if (w.health?.state === 'suspect') return false
  return Boolean(adapter(w.adapterId).info.usageRefresh)
}

interface RefreshAttempt {
  at: number
  inFlight: boolean
}

const refreshAttempts = new Map<string, RefreshAttempt>()

/**
 * Ask for this worker's reading to be made current, because something is about to act on it.
 *
 * ⭐ **This is the gate-time replacement for the background clock.** The caller is a decision that
 * needs a number it may trust — today the dispatch gate, which holds the task for one pass while
 * the terminal opens. Returns `true` when a refresh is running and the caller should wait, `false`
 * when there will not be one: the worker cannot host a probe, or one was attempted too recently to
 * be worth repeating (`REFRESH_BACKOFF_MS`). ⛔ `false` is not a failure and must not bench the
 * task — a fleet that refuses to dispatch without a fresh percentage is a fleet stopped by its own
 * instrument. Dispatch blind and mark the run `quotaUnverified`, which is what that flag is for.
 *
 * ⚠️ Never awaited. `refreshUsage` opens a PTY for the better part of thirty seconds, and the
 * scheduler tick that calls this is on a ten-second loop that must not block behind it.
 */
export function ensureFreshQuota(workerId: string): boolean {
  if (!mayRefreshUsage(workerId)) return false

  const prior = refreshAttempts.get(workerId)
  if (prior?.inFlight) return true
  if (prior && Date.now() - prior.at < REFRESH_BACKOFF_MS) return false

  refreshAttempts.set(workerId, { at: Date.now(), inFlight: true })
  void refreshUsage(workerId)
    .catch((err: unknown) => log.warn(`quota refresh failed for ${workerId}:`, err))
    // ⚠️ Timed from when it *finished*, not when it started, so a refresh that took half a minute
    // does not have that half minute counted against its own backoff.
    .finally(() => refreshAttempts.set(workerId, { at: Date.now(), inFlight: false }))
  return true
}

/** Test seam: the attempt ledger is process-local state, and a test that seeds a fleet needs it empty. */
export function forgetRefreshAttempts(): void {
  refreshAttempts.clear()
}

/**
 * The five-hour window that governs *this* model, on a provider that meters more than one pool.
 *
 * ⛔ **The pessimistic fallback is still the default, and has to be.** With no model in hand — the
 * reset countdown, the reserve's sample query — the only safe reading is the busiest pool, which the
 * Antigravity adapter aliases to the bare id `5h` for exactly that reason. This function is for the
 * one caller that *does* know: the dispatch gate, which resolves a task's model before it spawns.
 *
 * ⭐ Measured 2026-08-27: an Antigravity account carries two five-hour windows and two weeklies.
 * Holding a Gemini task out because the Claude/GPT pool is nearly spent is a refusal with no cause —
 * the pools do not share, so the task would have run fine.
 *
 * ⚠️ Containment, not equality. The group slug comes from the panel's own heading and `CLAUDE & GPT`,
 * `CLAUDE AND GPT` and `CLAUDE/GPT` slugify three different ways; `claude` and `gpt` are substrings
 * of all three. A pool that matches nothing falls back rather than returning no window, because an
 * unrecognised pool is ignorance, not permission.
 */
export { sessionWindowFor } from '@shared/tasks.js'

