/**
 * Why an account the operator asked to spend usage credits is not spending them.
 *
 * ⭐ **`CreditStatus.enabled === false` is four different situations, and until 2026-09-13 every one
 * of them read *Vendor reports credits off.*** Measured that day on `ClaudeFirst` (Claude Code
 * 2.1.270): the operator had turned usage credits on at the vendor — `hasExtraUsageEnabled: true`,
 * `user_disabled: false` — and the account still reported `is_enabled: false`, because
 * `used_credits` (`$20.57`) had passed `monthly_limit` (`$17.30`) and the vendor had cut credits off
 * for the rest of the billing month (`spend_limit_reached: true`,
 * `disabled_reason: "org_level_disabled_until"`). The sentence on the row said the switch was off.
 * The switch was on; the *purse* was empty, and the next move was a date rather than a toggle.
 *
 * ⛔ **One module, because three readers say this and they must not drift.** The account row's
 * warning, the Doctor warning, and the once-per-cause suppression in `CreditsIntent.reportedKind`
 * are the same judgement rendered three ways. `creditsPurseEmpty` lives here too — it is the rule
 * `spendingCreditsOn` gates dispatch on, and a second copy of it deciding what the UI says is
 * exactly how a row comes to contradict the scheduler.
 */

import type { CreditStatus, CreditsMismatchKind } from './protocol.js'

/**
 * Has this account already spent every credit it was allowed this month?
 *
 * ⛔ **A purse with nothing in it is credits *off* for every decision that matters.** `enabled`
 * says the vendor is willing to bill past the plan limit; it does not say there is anything left to
 * bill against. Standing the quota guards down on an emptied purse is the worst of both answers —
 * the run is not wrapped up cleanly *and* the vendor refuses the turn anyway, which is exactly the
 * outcome `spendingCreditsOn` exists to avoid.
 *
 * ⛔ **The vendor's own statement first, the arithmetic second.** `spendLimitReached` is
 * `extra_usage.spend_limit_reached`, which 2.1.270 sets beside `used_credits: 2057` against
 * `monthly_limit: 1730` — the same answer, from the party that decides it rather than from a
 * comparison of two numbers the vendor may round, prorate or cap differently. ⚠️ Only `true` is
 * taken from it: an adapter that publishes nothing here, and every row written before the field
 * existed, reads `null`/`undefined` and falls through to the comparison as before.
 *
 * ⚠️ Both numbers or nothing. A vendor that publishes no ceiling, or no spend against it, has
 * said nothing about the purse being empty — and an unknown is not an exhaustion.
 */
export function creditsPurseEmpty(credits: CreditStatus | null | undefined): boolean {
  if (!credits) return false
  if (credits.spendLimitReached === true) return true
  const { monthlyLimit, used } = credits
  if (monthlyLimit === null || monthlyLimit <= 0 || used === null) return false
  return used >= monthlyLimit
}

/**
 * Which of the four it is — or `null` where there is no mismatch to name.
 *
 * ⛔ Ordered by what the operator would do next, not by which field is most specific. An emptied
 * purse outranks `userDisabled` because it is the condition that will still be true after they go
 * and check the switch: on the measured account both a `disabled_reason` and a spent allowance were
 * present, and only one of them was actionable.
 *
 * ⚠️ `null` for an account nothing has read (`credits === null`) as well as for one that is
 * spending: neither is a mismatch, and *not knowing* is reported by the caller that knows it has
 * never probed, in its own words.
 */
export function creditsMismatchKind(
  credits: CreditStatus | null | undefined
): CreditsMismatchKind | null {
  if (!credits || credits.enabled) return null
  if (creditsPurseEmpty(credits)) return 'purse-empty'
  if (credits.userDisabled === true) return 'user-off'
  if (credits.everEnabled === false) return 'never-offered'
  return 'off'
}

/**
 * Should the fleet card draw its credits gauge at all?
 *
 * ⛔ **A spent allowance is the reading most worth seeing, and it was the one reading that
 * disappeared.** The gauge was drawn on `enabled === true` alone, for the good reason that an
 * account with credits off publishes no numbers and `$0.00/$0.00` would claim an empty purse that
 * had merely not been shown. But the account measured 2026-09-13 publishes `$20.57` *because* it is
 * off — the vendor cut credits when the allowance ran out — so the card went blank on the worker
 * with the largest bill on it.
 *
 * ⚠️ Still nothing to draw without a number: `used === null` is *not reported*, and a zero under
 * credits-off is the unavailable-balance shape `spendMeters` refuses for the same reason.
 */
export function creditGaugeVisible(credits: CreditStatus | null | undefined): boolean {
  if (!credits) return false
  if (credits.enabled) return true
  return credits.used !== null && credits.used > 0
}

/**
 * A price, or the honest absence of one, in whatever currency the vendor named.
 *
 * ⛔ `null` is *not reported* and renders as `n/a`, never `$0.00` — the rule the whole of
 * `CreditStatus` is built on. ⚠️ A non-USD currency is printed as `20.57 EUR` rather than converted:
 * the same reason `SpendMeter.usdPerUnit` goes `null`, which is that a guessed rate puts a
 * fabricated figure on somebody's bill.
 */
export function creditAmount(value: number | null, currency: string | null): string {
  if (value === null) return 'n/a'
  const fixed = value.toFixed(2)
  if (currency === null || currency === 'USD') return `$${fixed}`
  return `${fixed} ${currency}`
}

/**
 * Whole days until the purse refills, as a phrase — or `''` where there is no date to name.
 *
 * ⚠️ On `claude-code` the date itself is inferred from the subscription anniversary (see
 * `CreditStatus.resetsAt`), so this says *refills in 9 days* and never prints a timestamp the
 * vendor never published. Anything at or before `now` reads as nothing rather than as *in 0 days*,
 * because a refill that has not landed is unknown, not imminent.
 */
export function creditRefillPhrase(resetsAt: number | null | undefined, now: number): string {
  if (!resetsAt || resetsAt <= now) return ''
  const days = Math.ceil((resetsAt - now) / 86_400_000)
  return `refills in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * The short clause for the account row: what the vendor is doing, and what would change it.
 *
 * ⛔ Names the numbers wherever the vendor published them. *Monthly credits spent* is a claim, and
 * `$20.57 of $17.30 used` is the evidence for it — the same rule every other reading in this app
 * follows, and the difference between a sentence an operator can act on and one they have to go and
 * verify in a browser.
 *
 * ⚠️ Returns `''` when there is nothing wrong, so a caller can render it unconditionally.
 */
export function creditsMismatchNote(credits: CreditStatus | null | undefined, now: number): string {
  const kind = creditsMismatchKind(credits)
  if (!kind || !credits) return ''
  const why = credits.disabledReason ? ` (${credits.disabledReason})` : ''
  if (kind === 'purse-empty') {
    const spent = creditAmount(credits.used, credits.currency)
    const against =
      credits.monthlyLimit === null
        ? ''
        : ` — ${spent} of ${creditAmount(credits.monthlyLimit, credits.currency)} used`
    const refill = creditRefillPhrase(credits.resetsAt, now)
    return `This month’s usage credits are spent${against}${refill ? `, ${refill}` : ''}.`
  }
  if (kind === 'user-off') {
    return `Usage credits are switched off on the account${why}, not by this app.`
  }
  if (kind === 'never-offered') {
    return `This account has never been offered usage credits${why}.`
  }
  return `Vendor reports credits off${why}.`
}
