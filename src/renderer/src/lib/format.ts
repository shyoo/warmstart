import type { Session, Worker } from '@shared/protocol'
import { isWorkerSubscriptionExpired, type RunQuota } from '@shared/tasks'
/**
 * Formatting for numbers that update in place.
 *
 * All of these are rendered in tabular figures (see `.num` in app.css). The unit is always shown -
 * a bare "19" next to a quota bar is the kind of thing an operator reads wrong once and distrusts
 * forever.
 */

export function countdown(target: number | null | undefined, now = Date.now()): string {
  if (!target) return '--'
  const left = target - now
  if (left <= 0) return '00:00'
  const totalMinutes = Math.floor(left / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  const seconds = Math.floor((left % 60000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** How long ago something was measured, phrased so that "old" reads as a problem. */
export function age(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * How long something took, at the resolution a person cares about.
 *
 * ⛔ Not `countdown` inverted. A countdown is a deadline and reads down to the second because the
 * seconds matter; a duration is a fact about the past, and "1h 12m" is what somebody wants where
 * "72:14" makes them do arithmetic. Under a minute keeps its seconds, because that is the range
 * where a run being three seconds long is the whole story.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A wall-clock moment, in the reader's own locale. Dates are only ever shown, never parsed back. */
export function when(ts: number | null | undefined): string {
  if (!ts) return '—'
  const date = new Date(ts)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/** A formatted time range (e.g. 01:43 PM – 01:50 PM or 01:43 PM – now). */
export function timeRange(
  startTs: number | null | undefined,
  endTs: number | null | undefined,
  _now = Date.now()
): string {
  if (!startTs) return '—'
  const startStr = when(startTs)
  if (endTs === undefined) return startStr
  if (endTs === null) return `${startStr} – now`
  return `${startStr} – ${when(endTs)}`
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '--'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * A price, or the honest absence of one.
 *
 * ⛔ **`null` is `n/a`, never `$0.00`.** They are opposite claims: `$0.00` says this run spent
 * nothing, `n/a` says nobody can say what it spent. A free account and a run whose window was never
 * read both land on the second, and the tooltip beside this says which.
 *
 * ⚠️ `<$0.01` rather than `$0.00` for a real but tiny amount, for the same reason: a two-decimal
 * round of $0.004 asserts a zero that was not measured.
 */
export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'n/a'
  if (usd === 0) return '$0.00'
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function percent(n: number): string {
  return `${Math.round(n)}%`
}

/** Amber at T+45m, red at T+53m - the last moment a ~2 minute compaction still fits in the hour. */
export function cacheUrgency(expiresAt: number | null, now = Date.now()): 'ok' | 'warn' | 'danger' {
  if (!expiresAt) return 'ok'
  const left = expiresAt - now
  if (left <= 7 * 60 * 1000) return 'danger'
  if (left <= 15 * 60 * 1000) return 'warn'
  return 'ok'
}

/**
 * How much of a session's prompt cache is left, as a fraction of the TTL it was granted.
 *
 * ⛔ Derived from the two stored timestamps, never from a constant. The TTL differs by model and
 * by cost model - five minutes and one hour are both real - so `remaining / (expiry - start)` is
 * the only version that is right for all of them, and it needs nothing on the wire that is not
 * already there.
 *
 * `null` when there is no clock to read: a `stream` session meters usage without ever setting
 * `lastRequestStartedAt`, and a session with no turn yet has neither timestamp. An empty track is
 * the honest drawing of that - a full one would say the cache is fresh, which is the wrong way to
 * be wrong.
 */
export function cacheRemaining(
  session: Pick<Session, 'cacheExpiresAt' | 'lastRequestStartedAt'>,
  now = Date.now()
): number | null {
  const { cacheExpiresAt: expiry, lastRequestStartedAt: started } = session
  if (!expiry || !started || expiry <= started) return null
  return Math.max(0, Math.min(1, (expiry - now) / (expiry - started)))
}

export function quotaUrgency(percentUsed: number): 'ok' | 'warn' | 'danger' {
  if (percentUsed >= 90) return 'danger'
  if (percentUsed >= 70) return 'warn'
  return 'ok'
}

/**
 * Pair the account's opening quota windows with the matching closing reading for a run.
 *
 * ⛔ The opening reading is a baseline, not a cost on its own. Keeping its rows when the closing
 * reading is pending makes that explicit — `48% → n/a` cannot be mistaken for the amount the run
 * spent, while it gives the operator a stable place to watch the eventual reading arrive.
 */
export function quotaWindowDeltas(
  before: RunQuota,
  after: RunQuota | null
): Array<{ label: string; from: number; to: number | null }> {
  return before.windows.map((opening) => ({
    label: opening.label,
    from: opening.percent,
    to: after?.windows.find((closing) => closing.id === opening.id)?.percent ?? null
  }))
}

/**
 * Why a quota cell has no number, phrased as something the operator can act on.
 *
 * ⚠️ The panel used to collapse every one of these into the bare word "unknown", including the
 * common and boring case: the vendor CLI writes its usage cache only after real work, so a freshly
 * signed-in account has nothing to read and never will until someone uses it. Probe dutifully
 * recorded that failure and the cell rendered the same word before and after the click, which is
 * why the button looked broken. The error is diagnostic; hiding it threw away the diagnosis.
 *
 * Returns null when there is a real number to show - the caller renders the windows itself.
 */
export function quotaGap(
  quota: { windows: unknown[]; error?: string; ageMs?: number; stale?: boolean } | null,
  /**
   * The adapter's `capabilities.quotaProbe`. ⛔ `'none'` is a **fifth state**, and collapsing it
   * into the fourth is what made a perfectly healthy Antigravity worker read as broken. The other
   * four — never probed, no usage data yet, stale, failed probe — all describe a reading somebody
   * can go and get, and the word "unknown" invites them to keep pressing Probe. On a provider with
   * no probe there is nothing to press, ever: Antigravity exposes usage only inside an interactive
   * session or a running IDE, `agy -p /usage` was measured spending a turn without answering, and
   * spend is accrued from metered turns instead. A permanent property of the provider has to read
   * as one, not as a number that has gone missing.
   */
  quotaProbe?: 'cli' | 'api' | 'none',
  worker?: Worker | null
): { label: string; hint: string } | null {
  if (quotaProbe === 'none') {
    return {
      label: 'not reported',
      hint:
        'This provider does not expose usage to anything outside an interactive session, so there ' +
        'is no reading to take and nothing to retry. Spend is accrued from the turns this app ' +
        'metered itself, which is a floor rather than a percentage of the window.'
    }
  }
  const isExpired =
    Boolean(worker && isWorkerSubscriptionExpired(worker)) ||
    /subscription.*expired|disabled claude subscription access/i.test(quota?.error ?? '')
  if (isExpired) {
    return {
      label: 'Subscription expired',
      hint:
        'The subscription for this account has expired or access is disabled. ' +
        'Renew the subscription to restore access and quota.'
    }
  }
  if (!quota) {
    return {
      label: 'never probed',
      hint:
        'No reading has been taken for this worker yet. Probe reads the vendor CLI’s own usage ' +
        'cache off disk - it does not spend a token.'
    }
  }
  if (quota.windows.length === 0) {
    // The adapter names the file it could not read. Keep that, but lead with the fix.
    // ⚠️ Codex belongs in this branch too, for the same reason by a different file: its reading
    // lives in a rollout, and a worker that has never run a turn has written none. `unknown` would
    // send the operator back to Probe, which is the one thing that cannot help.
    if (
      /cachedUsageUtilization|no \.claude\.json|no rollout files|no rate_limits record/i.test(
        quota.error ?? ''
      )
    ) {
      return {
        label: 'no usage data yet',
        hint:
          'Signing in does not produce a usage reading. The CLI writes its usage cache only after ' +
          'it has done real work on the account, so start a session on this worker and probe again ' +
          `once it has run. (${quota.error})`
      }
    }
    return {
      label: 'unknown',
      hint: `The last probe returned no windows: ${quota.error ?? 'no reason given'}`
    }
  }
  if (quota.stale) {
    // ⛔ **Old is not the same as wrong, and the word `stale` said the second one.** An idle
    // account's window is not moving, so a reading taken two hours ago is very likely still true -
    // it simply has nothing vouching for it. Calling that a fault sent operators to press Probe on
    // accounts that were fine, and it made the probe interval read as a promise the sweep never
    // made: the sweep re-reads the vendor's cache, and the vendor rewrites that cache only when the
    // account does work. So the age is the finding, and the age is what this says.
    // ⚠️ Unchanged underneath: nothing the scheduler *gates* on will use this reading, and the
    // dispatch gate refreshes it the moment a task is about to run here.
    return {
      label: `read ${age(quota.ageMs ?? 0)}`,
      hint:
        `This reading was taken ${age(quota.ageMs ?? 0)} and nothing has confirmed it since. That ` +
        'is normal on an idle account: the CLI rewrites its usage cache when it does work, so a ' +
        'worker that is not working keeps the last number it had - and its window is not moving ' +
        'either. Nothing the scheduler gates on will use a reading this old; it takes a fresh one ' +
        'when a task is about to run here, and Probe takes one now.'
    }
  }
  return null
}
