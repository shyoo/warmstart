import type { QuotaSnapshot, QuotaWindow } from '@shared/protocol.js'
import { QUOTA_STALE_AFTER_MS } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { adapter } from './adapters/index.js'
import { stripAnsi } from './stream.js'
import { listWorkers, refreshIdentityIfStale, requireWorker } from './workers.js'
import { settings } from './settings.js'
import { log } from './log.js'
import { bumpPricingEpoch } from './price.js'
import { probeSpendFor } from './spend.js'
import { markRunOverage } from './tasks.js'

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

/**
 * Beyond this, a sample is reported but must not be treated as the current state of the window.
 *
 * ⛔ Re-exported from `@shared/tasks`, not declared here. The fleet strip has to decide the same
 * thing about the same reading — see `quotaFreshness` — and two fifteens in two files is one edit
 * away from a card that calls a reading fresh while the gate that reads it refuses to.
 */
export const STALE_AFTER_MS = QUOTA_STALE_AFTER_MS

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

const SCREEN_PROBE_POLL_MS = 500
const SCREEN_PROBE_RETRY_MS = 5_000

export interface ScreenProbeOptions {
  /**
   * Does this screen say, in the CLI's own words, that it *has* no reading?
   *
   * ⛔ The one answer that is neither a reading nor a failure — see `AgentAdapter.usageUnavailable`.
   */
  unavailable?: (screen: string) => string | null
  /**
   * Wait this long between the command text and the carriage return, instead of writing them
   * together. ⛔ Load-bearing on Muse Code — see `UsageRefresh.submitDelayMs`.
   */
  submitDelayMs?: number
  /** Test seam: the clock this loop waits on. */
  pause?: (ms: number) => Promise<void>
  /** Test seam: the clock this loop reads. */
  now?: () => number
}

export interface ScreenProbeResult {
  screen: string
  windows: QuotaWindow[] | null
  attempts: number
  /** The CLI's own reason for having no numbers to draw, where it gave one. */
  unavailable: string | null
}

/**
 * Drive a screen-answered slash command until it produces a complete reading or its deadline ends.
 *
 * Antigravity startup is not a stable-duration operation: it refreshes experiments and commands
 * before accepting input. A single command after a fixed delay is therefore lossy — when startup
 * takes longer, the TUI swallows the only `/usage` and the probe can never recover. Repeating this
 * client-side command is free, and `parse` is deliberately restricted to returning quota windows.
 */
export async function driveScreenProbe(
  command: string,
  timeoutMs: number,
  write: (data: string) => void,
  read: () => string,
  parse: (screen: string) => QuotaWindow[] | null,
  opts: ScreenProbeOptions = {}
): Promise<ScreenProbeResult> {
  const { unavailable, submitDelayMs, pause = wait, now = Date.now } = opts
  const startedAt = now()
  let nextAttemptAt = startedAt
  let attempts = 0
  let screen: string

  do {
    const current = now()
    if (current >= nextAttemptAt) {
      if (submitDelayMs) {
        // ⛔ Two writes with a gap, because on one CLI the gap *is* the keypress: a return arriving
        // in the same chunk as the text is not one. See `UsageRefresh.submitDelayMs`.
        write(command)
        await pause(submitDelayMs)
        write('\r')
      } else {
        write(`${command}\r`)
      }
      attempts += 1
      nextAttemptAt = now() + SCREEN_PROBE_RETRY_MS
    }
    await pause(Math.min(SCREEN_PROBE_POLL_MS, Math.max(0, startedAt + timeoutMs - now())))
    screen = stripAnsi(read())
    const windows = parse(screen)
    if (windows) return { screen, windows, attempts, unavailable: null }
    // ⛔ Asked only once `parse` has declined, and it ends the drive. A panel that says in words
    // that it has no numbers has *answered*: typing the command four more times cannot produce a
    // reading the provider has not published, and the twenty seconds spent doing it are charged to
    // an operator watching a spinner. ⚠️ The order matters the other way too — a backscroll holding
    // an early unavailable panel *and* a later complete one is a worker whose reading arrived.
    const why = unavailable?.(screen) ?? null
    if (why) return { screen, windows: null, attempts, unavailable: why }
  } while (now() < startedAt + timeoutMs)

  return { screen, windows: null, attempts, unavailable: null }
}

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
  storeAndPublish(snapshot)
  // ⛔ **Money rides the same pacing, deliberately, rather than owning a second timer.** The two
  // readings answer halves of one question — what the subscription bought and what is being billed
  // on top of it — and the account that is worth asking about is the same account in both cases.
  // ⚠️ `probeSpendFor` never throws and never touches the quota reading above it: an adapter that
  // breaks its own contract must not cost this account its window. See spend.ts.
  await probeSpendFor(workerId)
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
  const quota = await readUsage(workerId)
  // ⛔ **After the refresh, not instead of it, and on every path out of it.** A screen-answered
  // refresh never reaches `probeWorker`, so without this the one adapter whose quota is hardest to
  // read would be the one whose meters were never asked about. ⚠️ Cheap twice over: the probe is a
  // file read, and a reading identical to the one already stored writes no row at all (spend.ts).
  await probeSpendFor(workerId)
  return quota
}

async function readUsage(workerId: string): Promise<DatedQuota> {
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
  // ⛔ The CLI's own words for *there is no reading yet*, kept apart from the screen. It is not a
  // failure of this probe and it is not a reading, and the operator is owed the difference.
  let unavailable: string | null = null
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
    if (refresh.answer === 'screen') {
      const parse = adapter(w.adapterId).parseUsage
      if (!parse) throw new Error(`${w.adapterId} declares a screen usage refresh without a parser`)
      const driven = await driveScreenProbe(
        refresh.command,
        refresh.settleMs,
        (data) => writeSession(session.id, data),
        () => backscroll(session.id),
        parse,
        {
          unavailable: adapter(w.adapterId).usageUnavailable,
          ...(refresh.submitDelayMs ? { submitDelayMs: refresh.submitDelayMs } : {})
        }
      )
      screen = driven.screen
      unavailable = driven.unavailable
      log.info(`drove \`${refresh.command}\` ${driven.attempts} time(s) on ${w.label}`)
    } else if (refresh.submitDelayMs) {
      writeSession(session.id, refresh.command)
      await wait(refresh.submitDelayMs)
      writeSession(session.id, '\r')
      await wait(refresh.settleMs)
    } else {
      writeSession(session.id, `${refresh.command}\r`)
      await wait(refresh.settleMs)
    }
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
      // ⛔ **The panel drew and said it has nothing.** Measured 2026-09-07 on a newly commissioned
      // Muse Code account: `/usage` renders its Subscription block as `Currently unavailable` until
      // that account has completed one turn. Reported as *the panel did not appear* it read as a
      // broken probe, and the sentence underneath it sent the operator to look for a folder-trust
      // dialog that was not there. The adapter knows its own CLI's wording, so it says why.
      const stated = screen !== null ? (unavailable ?? adapter(w.adapterId).usageUnavailable?.(screen) ?? null) : null
      const why = stated
        ? `${w.label}: ${stated}`
        : `\`${refresh.command}\` was typed into ${w.label} but its usage panel did not appear. ` +
          (screen === null
            ? 'The probe session did not start, so nothing was read.'
            : 'The session may still have been starting, or a folder-trust dialog may have taken the ' +
              'keystrokes - this CLI asks that question per directory and swallows input until it is ' +
              'answered.')
      // ⚠️ `info` where the CLI explained itself: an expected state a person can act on is not a
      // fault of this fleet, and warning about it every sweep teaches the operator to skip the log.
      if (stated) log.info(why)
      else log.warn(why)
      const failed: QuotaSnapshot = {
        workerId,
        windows: [],
        sampledAt: Date.now(),
        source: 'unknown',
        error: why
      }
      storeAndPublish(failed)
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
    storeAndPublish(snapshot)
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
    storeAndPublish(snapshot)
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
  // ⛔ A new reading moves a segment boundary, which changes what every run open across it is
  // answerable for — not just the run that happens to be running now. The whole memo goes.
  bumpPricingEpoch()
  const stmt = db().prepare(
    `insert or replace into quota_samples
       (worker_id, window_id, label, percent, resets_at, source, error, sampled_at, window_group)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  if (s.windows.length === 0) {
    // Record the failure too. A gap in the series is indistinguishable from a healthy quiet period.
    stmt.run(s.workerId, '', '', 0, null, s.source, s.error ?? null, s.sampledAt, null)
    return
  }
  for (const w of s.windows) {
    // ⛔ `group` goes in. It is what `sessionWindowFor` finds a task's own pool by, and dropping it
    // here made every gate that reads this table fall back to the busiest window on the account.
    stmt.run(
      s.workerId,
      w.id,
      w.label,
      w.percent,
      w.resetsAt,
      s.source,
      s.error ?? null,
      s.sampledAt,
      w.group ?? null
    )
  }
}

/**
 * Write a reading **and say so**.
 *
 * ⭐ **The fix for t86, and the reason it is here rather than at each caller.** The strip showed a
 * three-hour-old percentage across the resume of a task on an account the dispatch gate had just
 * refreshed. Nothing was wrong with the refresh: the row was written and correct. What was missing
 * is that announcing it was a *caller's* job, and only two of the four callers did it — the poller's
 * sweep, through its listener, and the Probe button, by hand. `ensureFreshQuota` at the gate and
 * `captureQuotaAfter` at the end of a run each wrote a fresh row in silence, which are precisely the
 * two moments somebody is watching the card.
 *
 * ⛔ So the announcement moved to the write. "A mutation is only half done when the row is written"
 * is the rule the event sink exists for (events.ts), and the only version of it that a fifth caller
 * cannot quietly opt out of is the one where it is not a caller's decision.
 *
 * ⚠️ **`lastQuotaReading`, not the snapshot just stored.** A failed probe writes a row with no
 * windows that is newer than the last good reading, so broadcasting the raw snapshot would put
 * `quota unknown` on a card measured successfully a minute earlier — the exact regression
 * `lastQuotaReading` was written to prevent. Emitting through the same accessor `fleet.list` serves
 * is also what keeps a patched card and a refetched one from disagreeing.
 */
function storeAndPublish(s: QuotaSnapshot): void {
  store(s)
  const reading = lastQuotaReading(s.workerId)
  if (reading) emit({ type: 'quota.changed', quota: reading })
}

interface SampleRow {
  window_id: string
  label: string
  percent: number
  resets_at: number | null
  source: string
  error: string | null
  sampled_at: number
  /** ⚠️ Null on every row written before the column existed, and on every single-pool provider. */
  window_group: string | null
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
      resetsAt: r.resets_at,
      ...(r.window_group ? { group: r.window_group } : {})
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
  info: {
    status: string
    rateLimitType: string
    resetsAt: number | null
    /** ⚠️ The vendor's own words for the overage state, when it says anything at all. */
    overageStatus?: string
    isUsingOverage?: boolean
  }
): void {
  db()
    .prepare(
      `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
       values (?,?,?,?,?,?)`
    )
    .run(workerId, sessionId, info.rateLimitType, info.status, info.resetsAt, Date.now())

  // ⛔ **The other half of this record, which was decoded and then dropped.** `isUsingOverage` and
  // `overageStatus` say that the turn now running is being billed as *extra usage* — real money, on
  // top of the subscription — and this event is the only place either is ever stated. It cannot
  // price anything by itself; what it does is mark which runs were burning it, and without that mark
  // no overage arithmetic is possible at all. See `markRunOverage`.
  if (sessionId) markRunOverage(sessionId, info)

  if (info.status !== 'allowed') {
    log.warn(`worker ${workerId.slice(0, 8)} rate limit status is '${info.status}' (${info.rateLimitType})`)
    // ⭐ **The side channel, connected.** This record is the vendor telling us, for free and in the
    // middle of a paid turn, that the window it is billing against has moved somewhere worth
    // knowing about. Recording it and stopping there is how t70 came to be preempted at the top of
    // its window while the fleet card over it still read 63%: the gate had a new fact and the
    // operator had an old one. Asking for a refresh here is what makes the two agree — the probe
    // itself still happens in the poller, under the poller's gates and its cooldown.
    requestUrgentProbe(
      workerId,
      `the CLI reported rate-limit status '${info.status}' on the ${info.rateLimitType} window`
    )
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

/**
 * Attempt to read a reset time from an agent CLI's quota or usage limit refusal prose.
 *
 * ⚠️ Used as a fallback when `windowResetsAt` has no cached or live rate-limit sample.
 * Supports:
 * - Codex / ChatGPT format: `try again at 12:03 PM`
 * - Claude Code format: `resets 4am (America/Los_Angeles)` or `resets at 4:30 PM`
 * - Relative durations: `try again in 25m`, `resets in 2 hours`, `retry after 300s`
 */
export function parseQuotaResetTime(text: string, now = Date.now()): number | null {
  if (!text) return null
  const MAX_FUTURE_MS = 6 * 60 * 60 * 1000

  // 1. Relative duration: "try again in 25m", "resets in 2 hours", "retry after 300s"
  const rel =
    /(?:try again in|resets?\s+in|retry\s+after)\s+(\d+)\s*(s(?:ec(?:ond)?)?|m(?:in(?:ute)?)?|h(?:our)?|d(?:ay)?)s?\b/i.exec(
      text
    )
  if (rel && rel[1] && rel[2]) {
    const val = parseInt(rel[1], 10)
    const unit = rel[2].toLowerCase()[0]
    const ms =
      unit === 's'
        ? val * 1000
        : unit === 'm'
          ? val * 60_000
          : unit === 'h'
            ? val * 3_600_000
            : val * 86_400_000
    return ms <= MAX_FUTURE_MS ? now + ms : null
  }

  // 2. Absolute time: "try again at 12:03 PM", "resets 4am", "resets at 4:30 PM"
  const abs =
    /(?:try again at|resets?(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?/i.exec(
      text
    )
  if (!abs || !abs[1]) return null

  let hours = parseInt(abs[1], 10)
  const minutes = abs[2] ? parseInt(abs[2], 10) : 0
  const seconds = abs[3] ? parseInt(abs[3], 10) : 0
  const meridiem = abs[4]?.toLowerCase()

  if (meridiem === 'pm' && hours < 12) hours += 12
  else if (meridiem === 'am' && hours === 12) hours = 0

  const d = new Date(now)
  d.setHours(hours, minutes, seconds, 0)

  if (d.getTime() > now && d.getTime() - now <= MAX_FUTURE_MS) {
    return d.getTime()
  }

  // If the stated time is within the last 2 minutes, truncated seconds or vendor clock skew
  // placed it just barely in the past (e.g. "try again at 12:03 PM" when now is 12:03:27 PM).
  // Park for 60 seconds rather than blindly falling back to 5 hours.
  if (d.getTime() <= now && now - d.getTime() <= 2 * 60 * 1000) {
    return now + 60_000
  }

  const tomorrow = d.getTime() + 24 * 60 * 60 * 1000
  if (tomorrow > now && tomorrow - now <= MAX_FUTURE_MS) {
    return tomorrow
  }

  return null
}


/**
 * ⛔ **The poller has no listener and must not grow one back.** It used to take a callback that
 * `index.ts` wired to `emit`, which made announcing a reading the business of whoever happened to
 * store it — and three of the four callers that store one did not (t86; see `storeAndPublish`). The
 * sweep now stores through the same door as everything else and the broadcast follows from that.
 */

/**
 * How long after a parked task's release time the fleet looks at that account.
 *
 * ⚠️ Not zero. `resetsAt` is the vendor's own boundary and the window it describes is emptied *at*
 * it, not before; probing on the dot reads the old window one last time and parks the task for
 * another whole interval on a number that expired a second later.
 */
export const RELEASE_PROBE_GRACE_MS = 30_000

/**
 * However good the reason, never two terminals on one account inside this.
 *
 * ⚠️ A floor under whatever `minGapMs` a caller passes, not a replacement for `REFRESH_BACKOFF_MS`.
 * A live rate-limit warning and a run in flight are both real reasons to look now; neither is a
 * reason to look every ten seconds.
 */
const MIN_FORCED_GAP_MS = 60_000

/** Even a poller with something urgent to do does not spin. */
const MIN_DELAY_MS = 1_000

/**
 * What the fleet needs looked at right now, asked of the scheduler rather than derived here.
 *
 * ⛔ Injected, not imported. The poller decides *when* to look at an account; only the scheduler
 * knows which accounts are running something and which tasks are parked on a window. Importing
 * `tasks.js` here would put the quota module inside the task module's cycle for the sake of two
 * lists, and would make every poller test drag the whole scheduler in behind it.
 */
export interface ProbeDemand {
  /** Workers with a run in flight. Their windows are the only ones actually moving. */
  activeWorkerIds: string[]
  /**
   * Every task parked on a quota window, as (worker, when it is due back).
   *
   * ⭐ This is what makes an automatic resume timely rather than eventual. A task parked until
   * 06:39 used to wait for whichever background sweep happened next — up to a full interval past
   * its own release time, on a fleet whose whole premise is unattended progress.
   */
  releases: Array<{ workerId: string; at: number }>
}

const NO_DEMAND: ProbeDemand = { activeWorkerIds: [], releases: [] }

export interface QuotaPollerOptions {
  /** Overrides the configured *active* cadence. Tests only; the setting is the real control. */
  intervalMs?: number
  /** Overrides the configured *idle* cadence. Tests only. */
  idleIntervalMs?: number
  demand?: () => ProbeDemand
}

// ------------------------------------------------------------------- the side channel

/**
 * Accounts something has just learned a new fact about, and why.
 *
 * ⭐ **The gap this closes.** A `rate_limit_event` rides a turn already being paid for and is the
 * only quota signal that is both live and free — and until 2026-08-31 it was recorded and then sat
 * there. So a run could be preempted at `allowed_warning` while the fleet card beside it still
 * showed the last cached percentage, hours old and much lower: measured on t70, a card reading 63%
 * over a run wrapped up at the top of its window. Two numbers about one account, and nothing in the
 * app to reconcile them.
 *
 * ⚠️ A request, not a probe. It is drained by the poller's next sweep, which is woken immediately —
 * so the expensive part (a process) still happens in one place, under one set of gates.
 */
const urgentProbes = new Map<string, string>()

/** Pollers that are running, so a signal anywhere can wake the loop that acts on it. */
const livePollers = new Set<QuotaPoller>()

/**
 * Ask for this account to be looked at now, because something just said its window moved.
 *
 * ⛔ Deliberately callable with no poller running: the request is stored either way and the next
 * sweep takes it. A daemon starting up mid-signal must not lose the signal.
 */
export function requestUrgentProbe(workerId: string, why: string): void {
  const existing = urgentProbes.get(workerId)
  urgentProbes.set(workerId, existing && existing !== why ? `${existing}; ${why}` : why)
  for (const poller of livePollers) poller.kick()
}

/** ⚠️ Test seam. What is queued and not yet serviced. */
export function pendingUrgentProbes(): Map<string, string> {
  return new Map(urgentProbes)
}

export function clearUrgentProbes(): void {
  urgentProbes.clear()
}

export class QuotaPoller {
  private timer: NodeJS.Timeout | null = null
  private intervalMs: number | null
  private idleIntervalMs: number | null
  private readonly demand: () => ProbeDemand
  private running = false
  private sweeping = false
  private resweep = false
  /** The last release time already probed for a worker, so a due release is serviced once. */
  private serviced = new Map<string, number>()

  constructor(options: QuotaPollerOptions = {}) {
    this.intervalMs = options.intervalMs ?? null
    this.idleIntervalMs = options.idleIntervalMs ?? null
    this.demand = options.demand ?? (() => NO_DEMAND)
  }

  /** The cadence while a run is in flight. */
  private activeMs(): number {
    return this.intervalMs ?? Math.max(1, settings().probeIntervalMinutes ?? 5) * 60_000
  }

  /** The cadence when nothing is running. ⚠️ Never faster than the active one. */
  private idleMs(): number {
    const configured =
      this.idleIntervalMs ?? Math.max(1, settings().idleProbeIntervalMinutes ?? 20) * 60_000
    return Math.max(configured, this.activeMs())
  }

  setIntervalMinutes(minutes: number): void {
    const safeMinutes = Math.max(1, Math.min(1440, minutes))
    const ms = safeMinutes * 60 * 1000
    if (this.intervalMs === ms) return
    this.intervalMs = ms
    log.info(`quota poller active interval set to ${safeMinutes}m`)
    this.reschedule()
  }

  setIdleIntervalMinutes(minutes: number): void {
    const safeMinutes = Math.max(1, Math.min(1440, minutes))
    const ms = safeMinutes * 60 * 1000
    if (this.idleIntervalMs === ms) return
    this.idleIntervalMs = ms
    log.info(`quota poller idle interval set to ${safeMinutes}m`)
    this.reschedule()
  }

  /**
   * When the next sweep is due, from what the fleet is actually doing.
   *
   * ⛔ Three inputs, and the soonest wins: something urgent (now), the cadence for the fleet's
   * current state (active or idle), and the release time of the earliest task parked on a window.
   * ⚠️ Public because it is the arithmetic worth testing directly — it is the whole difference
   * between a task that comes back thirty seconds after its window resets and one that comes back
   * in twenty minutes.
   */
  nextDelayMs(now = Date.now()): number {
    if (urgentProbes.size > 0) return MIN_DELAY_MS
    const demand = this.readDemand()
    let delay = demand.activeWorkerIds.length > 0 ? this.activeMs() : this.idleMs()
    for (const release of this.pendingReleases(demand, now)) {
      delay = Math.min(delay, Math.max(0, release.at + RELEASE_PROBE_GRACE_MS - now))
    }
    return Math.max(MIN_DELAY_MS, delay)
  }

  start(): void {
    if (this.running) return
    this.running = true
    livePollers.add(this)
    void this.cycle()
  }

  stop(): void {
    this.running = false
    livePollers.delete(this)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Something happened; look now rather than at the end of the interval. */
  kick(): void {
    if (!this.running) return
    if (this.sweeping) {
      this.resweep = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.cycle()
  }

  private reschedule(): void {
    if (!this.running || this.sweeping) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.cycle(), this.nextDelayMs())
    this.timer.unref?.()
  }

  private async cycle(): Promise<void> {
    this.timer = null
    this.sweeping = true
    try {
      await this.sweep()
    } catch (err) {
      log.warn('quota sweep failed:', err)
    } finally {
      this.sweeping = false
    }
    if (!this.running) return
    if (this.resweep) {
      this.resweep = false
      void this.cycle()
      return
    }
    this.timer = setTimeout(() => void this.cycle(), this.nextDelayMs())
    this.timer.unref?.()
  }

  private readDemand(): ProbeDemand {
    try {
      return this.demand()
    } catch (err) {
      // ⚠️ Never fatal. A poller that cannot ask what the fleet is doing falls back to the idle
      // cadence, which is the pre-2026-08-31 behaviour and is merely slower, never wrong.
      log.warn('could not read what the fleet needs probed:', err)
      return NO_DEMAND
    }
  }

  /** Releases this poller has not already gone and looked at. */
  private pendingReleases(
    demand: ProbeDemand,
    now: number
  ): Array<{ workerId: string; at: number }> {
    const live = new Set(demand.releases.map((r) => r.workerId))
    for (const workerId of [...this.serviced.keys()]) {
      if (!live.has(workerId)) this.serviced.delete(workerId)
    }
    void now
    return demand.releases.filter((r) => this.serviced.get(r.workerId) !== r.at)
  }

  /**
   * Why this worker is being *refreshed* rather than merely re-read, if it is.
   *
   * ⭐ The distinction the old sweep did not make. `probeWorker` reads a file the vendor writes on
   * its own schedule; `refreshUsage` makes that file current. A five-minute cadence that only ever
   * did the former is a five-minute cadence over a number that can be two hours old — which is what
   * "the probe interval is set to 5m and the percentage does not move" actually was.
   *
   * ⚠️ Public for the same reason `mayRefreshUsage` is: this is the decision worth testing,
   * and driving a sweep to reach it opens real processes against real accounts.
   */
  forcedRefresh(
    workerId: string,
    demand: ProbeDemand,
    now: number
  ): { why: string; release?: number } | null {
    const urgent = urgentProbes.get(workerId)
    if (urgent) return { why: urgent }

    const due = this.pendingReleases(demand, now).find(
      (r) => r.workerId === workerId && r.at + RELEASE_PROBE_GRACE_MS <= now
    )
    if (due) {
      return { why: 'a task is parked on this window and its reset time has passed', release: due.at }
    }

    if (demand.activeWorkerIds.includes(workerId)) {
      const last = lastQuota(workerId)
      if (!last || last.windows.length === 0 || last.ageMs >= this.activeMs()) {
        return { why: 'a run is in flight on this account' }
      }
    }
    return null
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
    // ⛔ **The sweep starts no process on its own account, and asks for one where the fleet has
    // named a reason.** Those are the same rule rather than two: a terminal is worth spending
    // exactly when something is about to act on the number. A run in flight *is* acting on it; a
    // task parked on a window whose reset has passed is about to; a live rate-limit warning has just
    // changed it. An account nobody is routing work to is none of those and keeps the reading it
    // has — which is what retiring the refresh clock (2026-08-31) was for.
    const now = Date.now()
    const demand = this.readDemand()

    for (const w of listWorkers()) {
      // ⛔ The queued request is consumed with the worker it names, serviceable or not. A signal
      // about an account nobody may probe must not sit in the queue forever holding the loop at its
      // floor.
      const forced = this.forcedRefresh(w.id, demand, now)
      urgentProbes.delete(w.id)
      if (w.retiredAt || !w.enabled || w.health?.state === 'suspect') continue
      try {
        // ⚠️ Identity is a cached belief and nothing used to expire it. ClaudeFirst read "not signed
        // in" on 2026-08-27 while its isolation root held a valid credential, because the `false`
        // was written before somebody signed in and only a button nobody knew about would have
        // corrected it. Free: a local subprocess, and only when the answer is genuinely old.
        await refreshIdentityIfStale(w.id, IDENTITY_STALE_AFTER_MS)

        // ⚠️ Marked serviced whether or not a terminal opens. Otherwise the poller holds itself at
        // its floor forever, re-deciding every second that an account it may not touch is overdue.
        if (forced?.release !== undefined) this.serviced.set(w.id, forced.release)

        if (forced) {
          // ⛔ Through the same ledger the dispatch gate uses, so two reasons to refresh one account
          // inside a minute open one terminal between them rather than two. The floor is the
          // caller's: see `refreshNow` and `forcedGapMs`.
          if (await refreshNow(w.id, this.forcedGapMs(forced))) {
            log.info(`refreshed ${w.label}'s quota: ${forced.why}`)
            continue
          }
        }
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
      } catch (err) {
        log.warn(`quota probe failed for ${w.label}:`, err)
      }
    }
  }

  /**
   * How long this account may go between forced refreshes, by the reason it is being refreshed for.
   *
   * ⭐ A run in flight is watched at the cadence the operator chose, because that is the account
   * whose window is moving and the reason the control exists at all. A one-off — a release that has
   * come due, a live warning — takes the floor: asking twice inside a minute cannot produce a
   * different answer.
   */
  private forcedGapMs(forced: { release?: number }): number {
    return forced.release === undefined ? this.activeMs() : MIN_FORCED_GAP_MS
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
  const claim = claimRefresh(workerId, REFRESH_BACKOFF_MS)
  if (claim !== 'start') return claim === 'in-flight'
  void refreshUsage(workerId)
    .catch((err: unknown) => log.warn(`quota refresh failed for ${workerId}:`, err))
    .finally(() => endRefresh(workerId))
  return true
}

/**
 * The same request, awaited, for the one caller that is allowed to wait: the poller's own sweep.
 *
 * ⛔ **Not a second policy — the same ledger.** A dispatch gate and a sweep can want one account
 * refreshed within seconds of each other, and two ledgers would open two terminals on it.
 *
 * ⚠️ `minGapMs` is the caller's floor rather than a fixed ten minutes, and that is the only place
 * the two rungs differ. Ten minutes is right for *a task is about to run here* — asked again a
 * minute later the answer has not moved. It is wrong for an account with a run **in flight**, which
 * is the one window actually moving and the one the operator chose a cadence for.
 * ⛔ Never below `MIN_FORCED_GAP_MS`, so no setting can turn this into a terminal per sweep.
 */
export async function refreshNow(workerId: string, minGapMs = REFRESH_BACKOFF_MS): Promise<boolean> {
  if (claimRefresh(workerId, Math.max(MIN_FORCED_GAP_MS, minGapMs)) !== 'start') return false
  try {
    await refreshUsage(workerId)
  } catch (err) {
    log.warn(`quota refresh failed for ${workerId}:`, err)
  } finally {
    endRefresh(workerId)
  }
  return true
}

/** ⛔ The whole of "may we, and is it worth it?", in one place, for both rungs. */
function claimRefresh(workerId: string, minGapMs: number): 'start' | 'in-flight' | 'too-soon' | 'no' {
  if (!mayRefreshUsage(workerId)) return 'no'
  const prior = refreshAttempts.get(workerId)
  if (prior?.inFlight) return 'in-flight'
  if (prior && Date.now() - prior.at < minGapMs) return 'too-soon'
  refreshAttempts.set(workerId, { at: Date.now(), inFlight: true })
  return 'start'
}

/**
 * ⚠️ Timed from when it *finished*, not when it started, so a refresh that took half a minute does
 * not have that half minute counted against its own backoff.
 */
function endRefresh(workerId: string): void {
  refreshAttempts.set(workerId, { at: Date.now(), inFlight: false })
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
export { sessionWindowFor, windowsForPool, windowExpired, poolVerdict } from '@shared/tasks.js'
