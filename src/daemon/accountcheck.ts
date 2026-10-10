/**
 * Asking the vendor whether it will run a turn on an account, where nothing free can tell (t961).
 *
 * ⛔ **Why this exists.** MuseFirst's subscription lapsed on 2026-10-06 and Meta answered every model
 * call with `402 … Billing verification failed … (billing_error)`. The worker went on reading as
 * healthy for a day: its identity probe reads `auth.json`, which stayed valid; its `/usage` panel read
 * "Currently unavailable", which is also what an untouched window reads; the 402 from a quality review
 * was written on the review and nowhere else; and every Probe press lifted the hold the one work run
 * had recorded. A model call is the only thing that can answer, so this makes one — over the
 * adapter's `stream` transport, so the verdict comes off the vendor's terminal record and the
 * adapter's own classifiers, never off a screen.
 *
 * ⚠️ Free while the vendor refuses (the refusal comes before the model is called) and one small turn
 * on a live account. Every caller is bounded: the warm-up it replaces (once per silent streak), a
 * person's Probe press, and the sweep's re-check of an expired account (`RECHECK_EXPIRED_MS`).
 */
import type { AccountCheck, AdapterInfo } from '@shared/protocol.js'
import type { AgentAdapter } from './adapters/types.js'
import type { StreamEvent } from './stream.js'
import { adapter } from './adapters/index.js'
import { log } from './log.js'
import { clearDispatchFailure, getWorker, noteAccountFault, recordOutage, requireWorker } from './workers.js'

/**
 * How often an account held as expired is asked again, so a renewal is noticed without a person.
 *
 * ⭐ The operator's choice (t961): six hours. ⚠️ Free every time the vendor still refuses — the 402
 * arrives before any model runs — and one small turn on the check that finds it renewed.
 */
export const RECHECK_EXPIRED_MS = 6 * 60 * 60 * 1000

/** How long a spawned check is given before its prompt goes in, as a consult is. */
const PROMPT_DELAY_MS = 2500

export type AccountCheckVerdict =
  /** The vendor ran the turn: the account works. */
  | 'ok'
  /** The vendor refused to bill it. */
  | 'expired'
  /** The vendor rejected the credential. */
  | 'reauth'
  /** The vendor's servers failed the turn; nothing is said about the account. */
  | 'outage'
  /** The turn failed for a reason none of the adapter's classifiers recognise. */
  | 'failed'
  /** No terminal record arrived in time, or the session could not start. */
  | 'inconclusive'

export interface AccountCheckResult {
  verdict: AccountCheckVerdict
  /** The vendor's own sentence where there was one, or what stopped the check. */
  reason: string
  at: number
}

/**
 * What one terminal record says about the account.
 *
 * ⛔ The adapter reads its own CLI's words — the same `subscriptionExpired`, `needsReauth` and
 * `overloaded` the dispatch path asks — and nothing here names a vendor. Order matters: a billing
 * refusal is checked before an outage, because t954 measured a request id that holds `503` by chance.
 */
export function classifyAccountCheck(
  ad: Pick<AgentAdapter, 'subscriptionExpired' | 'needsReauth' | 'overloaded'>,
  result: { text: string; isError: boolean } | null
): { verdict: AccountCheckVerdict; reason: string } {
  if (!result) return { verdict: 'inconclusive', reason: 'the vendor said nothing before the check timed out' }
  const reason = result.text.trim() || (result.isError ? 'the turn failed and said nothing about it' : 'the turn completed')
  if (!result.isError) return { verdict: 'ok', reason }
  if (ad.subscriptionExpired?.(reason)) return { verdict: 'expired', reason }
  if (ad.needsReauth?.(reason)) return { verdict: 'reauth', reason }
  if (ad.overloaded?.(reason)) return { verdict: 'outage', reason }
  return { verdict: 'failed', reason }
}

/**
 * May the sweep re-ask this account now? Only one held as expired, only where its adapter has a check,
 * and only once `RECHECK_EXPIRED_MS` has passed since the vendor last refused.
 */
export function expiredRecheckDue(workerId: string, now = Date.now()): boolean {
  const w = getWorker(workerId)
  if (!w || w.retiredAt || !w.enabled || w.humanOccupied) return false
  if (!adapter(w.adapterId).info.accountCheck) return false
  if (w.health?.state !== 'suspect' || w.health.subscriptionExpired !== true) return false
  const last = w.health.checkedAt ?? w.health.since
  return now - last >= RECHECK_EXPIRED_MS
}

/**
 * Does a person's Probe press ask the vendor to run a turn on this account first? (t1010)
 *
 * ⛔ Yes wherever the adapter has a check and its usage refresh does not run it from inside: only a
 * screen-answered refresh does (`readUsage`, when its panel reads unavailable). Claude's types
 * `/usage` and reads a cache file, and both read healthy on an account whose access was withdrawn —
 * measured on ClaudeSecond, 2026-10-09 — so before this its Probe said *no usage data*, never
 * *expired*. An account already held as expired is always re-asked.
 */
export function probeAsksVendor(
  info: Pick<AdapterInfo, 'accountCheck' | 'usageRefresh'>,
  health: { subscriptionExpired?: boolean } | null | undefined
): boolean {
  if (!info.accountCheck) return false
  return health?.subscriptionExpired === true || info.usageRefresh?.answer !== 'screen'
}

const inFlight = new Map<string, Promise<AccountCheckResult>>()

/**
 * Run the adapter's account check once and write what it proved onto the worker.
 *
 * ⛔ One at a time per account: a second caller while one is running shares its answer rather than
 * spending a second turn. Never throws — a check that cannot run is `inconclusive`, which changes
 * nothing on the worker.
 */
export function checkAccount(workerId: string, why: string): Promise<AccountCheckResult> {
  const running = inFlight.get(workerId)
  if (running) return running
  const job = runCheck(workerId, why).finally(() => inFlight.delete(workerId))
  inFlight.set(workerId, job)
  return job
}

async function runCheck(workerId: string, why: string): Promise<AccountCheckResult> {
  const w = requireWorker(workerId)
  const ad = adapter(w.adapterId)
  const check: AccountCheck | undefined = ad.info.accountCheck
  const at = Date.now()
  if (!check) return { verdict: 'inconclusive', reason: `${ad.info.label} declares no account check`, at }

  const { spawnSession, closeSession, onSessionStream, onSessionEnd, sendPrompt, whyNoSession } = await import('./sessions.js')
  // ⛔ Asked before trying, as the usage refresh does: a check is a turn on a live account, and an
  // account closed to work (disabled, retired, human-occupied) is not spent — t1010 relies on this,
  // because Probe now asks Claude's accounts, and the L2 suite probes a disabled copy of a real one.
  const blocked = whyNoSession(w, 'probe')
  if (blocked) return { verdict: 'inconclusive', reason: `not asked: ${blocked}`, at }
  let sessionId: string | null = null
  let result: { text: string; isError: boolean } | null
  try {
    const session = spawnSession({
      workerId,
      purpose: 'probe',
      transport: 'stream',
      ...(check.effort ? { effort: check.effort } : {})
    })
    sessionId = session.id
    log.info(`checking ${w.label}'s account with one headless turn: ${why}`)
    result = await new Promise<{ text: string; isError: boolean } | null>((resolve) => {
      let text = ''
      let done = false
      const finish = (value: { text: string; isError: boolean } | null): void => {
        if (done) return
        done = true
        offStream()
        offEnd()
        clearTimeout(timer)
        resolve(value)
      }
      const offStream = onSessionStream(session.id, (event: StreamEvent) => {
        if (event.kind === 'assistant_text') text += event.text
        if (event.kind === 'result') finish({ text: event.text ?? text, isError: event.isError })
      })
      // ⚠️ An exit with no terminal record says nothing about the account: inconclusive, not failed.
      const offEnd = onSessionEnd(session.id, () => finish(null))
      const timer = setTimeout(() => finish(null), check.timeoutMs)
      setTimeout(() => {
        try {
          sendPrompt(session.id, check.prompt)
        } catch (err) {
          log.warn(`could not send ${w.label}'s account check:`, err)
          finish(null)
        }
      }, PROMPT_DELAY_MS)
    })
  } catch (err) {
    log.warn(`could not check ${w.label}'s account:`, err)
    return { verdict: 'inconclusive', reason: `the check could not start: ${String(err)}`, at }
  } finally {
    if (sessionId) closeSession(sessionId)
  }

  const { verdict, reason } = classifyAccountCheck(ad, result)
  applyVerdict(workerId, verdict, reason)
  log.info(`${w.label}'s account check: ${verdict} (${reason.slice(0, 200)})`)
  return { verdict, reason, at: Date.now() }
}

/**
 * Write a verdict onto the worker. ⛔ Only `ok` lifts a hold, and only because the vendor ran a turn —
 * the same evidence a metered work turn is. `failed` and `inconclusive` leave everything as it was.
 */
function applyVerdict(workerId: string, verdict: AccountCheckVerdict, reason: string): void {
  if (verdict === 'ok') clearDispatchFailure(workerId)
  else if (verdict === 'expired' || verdict === 'reauth') noteAccountFault(workerId, reason, null)
  else if (verdict === 'outage') recordOutage(workerId, reason)
}

/**
 * What a failed turn on *any* session says about its account (t961).
 *
 * ⛔ The dispatch path has recorded account faults since M4 and the judgment path since t-consult,
 * but a quality review or a chat that hit `402 billing_error` wrote it on the review and nowhere
 * else — measured 2026-10-07, MuseFirst's last run before this change. One hook on the stream, read
 * by the adapter's classifiers, so a purpose added later cannot forget.
 *
 * ⚠️ `work` keeps its own richer handling in the scheduler for faults (it carries the run id and
 * re-queues the task), and a `probe` applies its own verdict; both still report an outage here.
 */
export function noteTurnFailure(
  session: { workerId: string; adapterId: string; purpose: string },
  event: { text: string | null; isError: boolean }
): void {
  if (!event.isError) return
  const text = (event.text ?? '').trim()
  if (!text) return
  const ad = adapter(session.adapterId)
  if (session.purpose !== 'work' && session.purpose !== 'probe' && noteAccountFault(session.workerId, text, null)) return
  if (!ad.subscriptionExpired?.(text) && !ad.needsReauth?.(text) && ad.overloaded?.(text)) {
    recordOutage(session.workerId, text)
  }
}
