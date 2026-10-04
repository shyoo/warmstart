/**
 * When an account is next billed, as far as anything on this machine can say (t906).
 *
 * ⛔ **Two bases, and the difference is shown, never smoothed over.** Measured 2026-10-03 on this
 * install's six workers:
 *
 * - **Codex publishes it.** The `id_token` in `<isolationRoot>/auth.json` carries
 *   `https://api.openai.com/auth` → `chatgpt_subscription_active_start` / `_active_until` and
 *   `chatgpt_subscription_last_checked` (CodexFirst: `free`, until 2026-10-02T03:22:22Z, checked
 *   2026-10-01). That is the end of the paid period, stated by the vendor, read for free.
 * - **Claude does not.** `.claude.json` → `oauthAccount` carries `subscriptionCreatedAt` and
 *   `billingType: stripe_subscription`; neither it nor `cachedUsageUtilization` (five_hour,
 *   seven_day, extra_usage, spend, limits …) has a renewal date. The next charge is taken to be the
 *   monthly anniversary of the subscription — the same inference `creditsResetAt` already makes for
 *   the credits refill — and is labelled *inferred*. ⚠️ An annual plan renews yearly, and would be
 *   wrong here by up to eleven months; nothing local says which one an account is on.
 * - **Muse and Antigravity carry nothing.** Muse's `auth.json` holds tokens and an email; the Google
 *   `oauth_creds.json` id_token has identity claims only. No billing is `null`, which reads *unknown*.
 *
 * ⚠️ An inferred date is stored as its *anchor*, not as a date. Identity is re-read on a probe or a
 * sign-in, which can be weeks apart, and a stored "next anniversary" would quietly go into the past;
 * the anchor rolls forward at the moment it is read.
 */

export interface WorkerBilling {
  basis: 'published' | 'inferred'
  /** `published`: the end of the paid period, as the vendor states it. */
  periodEndsAt: number | null
  /** `inferred`: the subscription start the monthly anniversary is counted from. */
  monthlyFrom: number | null
  /** Where the date came from, in one sentence a person can check. */
  source: string
  /** When the vendor itself last confirmed the subscription, where it says. */
  vendorCheckedAt: number | null
}

/**
 * The first monthly anniversary of `anchor` strictly after `now`, or null for an unusable anchor.
 *
 * ⚠️ UTC throughout: a billing anniversary is a calendar date, and local DST must not move it. A
 * day past the end of a short month lands on its last day (31 Jan → 28 Feb).
 */
export function nextMonthlyAnniversary(anchor: number, now: number): number | null {
  if (!Number.isFinite(anchor)) return null
  const start = new Date(anchor)
  const day = start.getUTCDate()
  const time = [start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()] as const
  const at = (y: number, m: number): number => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return Date.UTC(y, m, Math.min(day, last), time[0], time[1], time[2], time[3])
  }
  const nowDate = new Date(now)
  let y = nowDate.getUTCFullYear()
  let m = nowDate.getUTCMonth()
  let candidate = at(y, m)
  // A charge later today is still ahead; one already past rolls to next month. Twelve steps is
  // more than enough and bounds the loop absolutely.
  for (let i = 0; i < 12 && candidate <= now; i++) {
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
    candidate = at(y, m)
  }
  return candidate > now ? candidate : null
}

/** The date this reading points at, as of `now`. Null when nothing is known. */
export function billingDate(billing: WorkerBilling | null | undefined, now: number): number | null {
  if (!billing) return null
  if (billing.basis === 'published') return billing.periodEndsAt
  return billing.monthlyFrom === null ? null : nextMonthlyAnniversary(billing.monthlyFrom, now)
}

/**
 * Claude: the monthly anniversary of `oauthAccount.subscriptionCreatedAt`.
 *
 * ⛔ Null where there is no live subscription to bill — `billingType: none` is how a lapsed account
 * reads (see `probeIdentity`), and an anniversary of a subscription that has ended is no date at all.
 */
export function claudeBilling(
  account: { subscriptionCreatedAt?: string | null; billingType?: string | null } | null | undefined
): WorkerBilling | null {
  if (!account?.subscriptionCreatedAt || account.billingType === 'none') return null
  const anchor = Date.parse(account.subscriptionCreatedAt)
  if (!Number.isFinite(anchor)) return null
  return {
    basis: 'inferred',
    periodEndsAt: null,
    monthlyFrom: anchor,
    source:
      `Monthly anniversary of the subscription start (${account.subscriptionCreatedAt.slice(0, 10)}, ` +
      '`.claude.json` → oauthAccount.subscriptionCreatedAt). Claude publishes no renewal date, and an ' +
      'annual plan would renew yearly instead.',
    vendorCheckedAt: null
  }
}

/** Codex: the `id_token`'s `chatgpt_subscription_active_until`, as published. */
export function codexBilling(authClaim: Record<string, unknown> | null | undefined): WorkerBilling | null {
  const until = authClaim?.chatgpt_subscription_active_until
  if (typeof until !== 'string') return null
  const end = Date.parse(until)
  if (!Number.isFinite(end)) return null
  const checked =
    typeof authClaim?.chatgpt_subscription_last_checked === 'string'
      ? Date.parse(authClaim.chatgpt_subscription_last_checked)
      : NaN
  return {
    basis: 'published',
    periodEndsAt: end,
    monthlyFrom: null,
    source: 'The end of the paid period, as ChatGPT states it in the sign-in token (chatgpt_subscription_active_until).',
    vendorCheckedAt: Number.isFinite(checked) ? checked : null
  }
}
