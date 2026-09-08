import { describe, expect, it } from 'vitest'
import { claudeCredits } from './claude-code.js'

const { creditStatus, spendMeters, majorUnits, creditsResetAt } = claudeCredits

/**
 * Claude Code's usage-credits reading, from `.claude.json`.
 *
 * ⛔ Every payload below is **verbatim from a live account**, captured 2026-09-07 off Claude Code
 * 2.1.263 on `ClaudeFirst` and `ClaudeSecond` — both `claude_pro`, both with credits off. That
 * matters more than usual here: an account with credits off publishes a *status* and no numbers, so
 * this is the shape the parser meets almost all the time, and every money field in it is `null`.
 */

/** ClaudeFirst and ClaudeSecond were byte-identical in this block. */
const CREDITS_OFF = {
  cachedUsageUtilization: {
    fetchedAtMs: 1788800775497,
    utilization: {
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
        decimal_places: null,
        disabled_reason: null,
        user_disabled: true,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null
      },
      spend: {
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        limit: null,
        percent: 0,
        severity: 'normal',
        enabled: false,
        disabled_reason: null,
        cap: null,
        balance: null,
        auto_reload: null,
        can_purchase_credits: false,
        can_toggle: false
      }
    }
  },
  oauthAccount: { hasExtraUsageEnabled: false },
  cachedExtraUsageDisabledReason: 'org_level_disabled'
}

/**
 * Live payload captured 2026-09-07 off Claude Code 2.1.263 on ClaudeSecond with extra usage enabled.
 * Notice monthly_limit is 4000 with decimal_places: 2 ($40.00), and spend.limit is { amount_minor: 4000, exponent: 2 }.
 */
const CREDITS_ON = {
  cachedUsageUtilization: {
    fetchedAtMs: 1788812514079,
    utilization: {
      extra_usage: {
        is_enabled: true,
        monthly_limit: 4000,
        used_credits: 0,
        utilization: null,
        currency: 'USD',
        decimal_places: 2,
        disabled_reason: null,
        user_disabled: false,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null
      },
      spend: {
        used: { amount_minor: 0, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 4000, currency: 'USD', exponent: 2 },
        percent: 0,
        severity: 'normal',
        enabled: true,
        disabled_reason: null,
        cap: {
          money: null,
          credits: { amount_minor: 4000, exponent: 2 }
        },
        balance: null,
        auto_reload: null,
        can_purchase_credits: false,
        can_toggle: false
      }
    }
  },
  oauthAccount: { hasExtraUsageEnabled: true },
  cachedExtraUsageDisabledReason: null
}

describe('majorUnits', () => {
  /** ⛔ Minor units and an exponent. Reading `amount_minor` as dollars is off by a factor of 100. */
  it('converts minor units by the exponent the vendor gave', () => {
    expect(majorUnits({ amount_minor: 3787, currency: 'USD', exponent: 2 })).toBe(37.87)
  })

  it('defaults to two decimal places when the vendor omits the exponent', () => {
    expect(majorUnits({ amount_minor: 4769 })).toBe(47.69)
  })

  /** ⚠️ Zero is a reading; absent is not. The two must not collapse into each other. */
  it('reads a genuine zero as zero and an absent amount as nothing', () => {
    expect(majorUnits({ amount_minor: 0, exponent: 2 })).toBe(0)
    expect(majorUnits({ amount_minor: null })).toBeNull()
    expect(majorUnits(null)).toBeNull()
    expect(majorUnits(undefined)).toBeNull()
  })
})

describe('creditStatus, on the live payload with credits off', () => {
  const status = creditStatus(CREDITS_OFF)

  it('reports credits as off', () => {
    expect(status?.enabled).toBe(false)
  })

  /**
   * ⛔ The field that decides whether this app may offer to flip the switch, and the vendor says no.
   * Driving `/usage-credits` on both accounts opened a **login chooser**, not a toggle.
   */
  it('carries the vendor’s word that the CLI cannot toggle it', () => {
    expect(status?.canToggle).toBe(false)
  })

  /** ⚠️ `user_disabled` and `org_level_disabled` are both true at once; neither is derived. */
  it('keeps who turned it off apart from why it cannot be on', () => {
    expect(status?.userDisabled).toBe(true)
    expect(status?.disabledReason).toBe('org_level_disabled')
  })

  it('distinguishes "off" from "never offered"', () => {
    expect(status?.everEnabled).toBe(true)
  })

  /**
   * ⛔ **The rule the whole type is built on.** The operator has real credits on these accounts and
   * the vendor publishes none of it while they are off. Reporting `$0.00` would claim an empty purse.
   */
  it('reports no balance rather than a balance of zero', () => {
    expect(status?.monthlyLimit).toBeNull()
    expect(status?.currency).toBe('USD')
  })

  it('says nothing at all for a config that carries none of the three fields', () => {
    expect(creditStatus({})).toBeNull()
  })
})

describe('creditStatus, when the account is spending', () => {
  /**
   * ⛔ Three fields, three code paths, and the first one *present* answers. Each of these payloads
   * carries exactly one of them, so each is the one that answers.
   */
  it.each([
    ['extra_usage.is_enabled', { cachedUsageUtilization: { utilization: { extra_usage: { is_enabled: true } } } }],
    ['spend.enabled', { cachedUsageUtilization: { utilization: { spend: { enabled: true } } } }],
    ['oauthAccount.hasExtraUsageEnabled', { oauthAccount: { hasExtraUsageEnabled: true } }]
  ])('reports enabled when %s says so', (_label, config) => {
    expect(creditStatus(config)?.enabled).toBe(true)
  })

  it('prefers the credit block’s own numbers, falling back to the spend block', () => {
    const status = creditStatus({
      cachedUsageUtilization: {
        utilization: {
          extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, currency: 'USD' },
          spend: { used: { amount_minor: 999, exponent: 2 }, limit: 10, enabled: true }
        }
      }
    })
    expect(status).toMatchObject({ enabled: true, monthlyLimit: 50, used: 12.5, currency: 'USD' })
  })

  /**
   * ⛔ **Precedence, not a vote, and this is the case that separates them.** `hasExtraUsageEnabled`
   * is an account-level cache that lags a change made elsewhere; `extra_usage.is_enabled` is the
   * vendor's direct statement. An OR would take the stale cheerful answer and stand the quota guards
   * down on an account that is not in fact spending — which costs the run its wrap-up, its commit
   * and its handoff, and earns a hard vendor refusal instead.
   */
  it('lets the direct statement overrule a stale account-level cache', () => {
    const status = creditStatus({
      cachedUsageUtilization: { utilization: { extra_usage: { is_enabled: false } } },
      oauthAccount: { hasExtraUsageEnabled: true }
    })
    expect(status?.enabled).toBe(false)
  })

  it('falls back to the spend block when the credit block reports no numbers', () => {
    const status = creditStatus({
      cachedUsageUtilization: {
        utilization: { spend: { used: { amount_minor: 3787, exponent: 2 }, limit: 100, enabled: true } }
      }
    })
    expect(status).toMatchObject({ enabled: true, monthlyLimit: 100, used: 37.87 })
  })

  it('converts spend.limit minor units object when falling back', () => {
    const status = creditStatus({
      cachedUsageUtilization: {
        utilization: { spend: { used: { amount_minor: 0, exponent: 2 }, limit: { amount_minor: 4000, exponent: 2 }, enabled: true } }
      }
    })
    expect(status).toMatchObject({ enabled: true, monthlyLimit: 40, used: 0 })
  })
})

describe('creditStatus, on the live payload with credits enabled', () => {
  const status = creditStatus(CREDITS_ON)

  it('reports credits as enabled', () => {
    expect(status?.enabled).toBe(true)
  })

  it('converts monthly_limit by decimal_places to dollars ($40.00, not $4000.00)', () => {
    expect(status?.monthlyLimit).toBe(40)
  })

  it('converts used credits to dollars', () => {
    expect(status?.used).toBe(0)
  })

  it('reports currency as USD', () => {
    expect(status?.currency).toBe('USD')
  })
})

describe('creditsResetAt, the monthly refill the vendor never dates', () => {
  // ⛔ Measured 2026-09-07 across three live accounts: `extra_usage`, `spend` and `limits[]` carry
  // no credits reset date. The refill is inferred from `oauthAccount.subscriptionCreatedAt`, which
  // the live accounts do publish (e.g. `2026-07-03T20:41:50Z` — a monthly allowance on a
  // `stripe_subscription` refills on the subscription-month anniversary).
  const SUB = '2026-07-03T20:41:50.158Z'

  it('names the next subscription-month anniversary after now', () => {
    // 2026-09-07 → the October anniversary, 26 days out.
    expect(creditsResetAt(SUB, Date.UTC(2026, 8, 7, 12))).toBe(Date.UTC(2026, 9, 3, 20, 41, 50, 158))
  })

  it('keeps a refresh later today ahead instead of rolling a month', () => {
    expect(creditsResetAt(SUB, Date.UTC(2026, 9, 3, 12))).toBe(Date.UTC(2026, 9, 3, 20, 41, 50, 158))
  })

  it('rolls to next month once today’s anniversary has passed', () => {
    expect(creditsResetAt(SUB, Date.UTC(2026, 9, 3, 21))).toBe(Date.UTC(2026, 10, 3, 20, 41, 50, 158))
  })

  it('rolls the year when the anniversary is in December', () => {
    // Dec 4 is past the Dec 3 anniversary, so the refill is January's — across the year boundary.
    expect(creditsResetAt(SUB, Date.UTC(2026, 11, 4))).toBe(Date.UTC(2027, 0, 3, 20, 41, 50, 158))
    expect(creditsResetAt('2026-12-15T00:00:00Z', Date.UTC(2026, 11, 16))).toBe(Date.UTC(2027, 0, 15))
  })

  it('clamps to the last day where the anniversary month is short', () => {
    // A subscription opened on the 31st refills on Feb 28, not March 3rd.
    expect(creditsResetAt('2026-01-31T10:00:00Z', Date.UTC(2026, 1, 1))).toBe(Date.UTC(2026, 1, 28, 10))
  })

  it('reads null where the vendor said nothing usable', () => {
    expect(creditsResetAt(null, Date.UTC(2026, 8, 7))).toBeNull()
    expect(creditsResetAt(undefined, Date.UTC(2026, 8, 7))).toBeNull()
    expect(creditsResetAt('not a date', Date.UTC(2026, 8, 7))).toBeNull()
  })

  it('rides creditStatus off the account block', () => {
    const status = creditStatus(
      {
        cachedUsageUtilization: {
          utilization: { extra_usage: { is_enabled: true, monthly_limit: 4000, used_credits: 0, decimal_places: 2 } }
        },
        oauthAccount: { hasExtraUsageEnabled: true, subscriptionCreatedAt: SUB }
      },
      Date.UTC(2026, 8, 7, 12)
    )
    expect(status?.resetsAt).toBe(Date.UTC(2026, 9, 3, 20, 41, 50, 158))
  })

  it('reads null on the live payloads, which publish no subscription date', () => {
    expect(creditStatus(CREDITS_OFF)?.resetsAt).toBeNull()
    expect(creditStatus(CREDITS_ON)?.resetsAt).toBeNull()
  })
})

describe('spendMeters', () => {
  /**
   * ⛔ A cumulative monthly counter, so a **fall is a billing-period rollover** rather than a refund.
   * That is exactly what `direction: 'spend_rises'` means to `price.ts::attribute()`, and it is how
   * the monthly reset is handled without a special case anywhere.
   */
  it('does not mistake the disabled payload’s zero-shaped counter for a zero balance', () => {
    const meters = spendMeters(CREDITS_OFF.cachedUsageUtilization.utilization.spend)
    expect(meters).toEqual([
      {
        id: 'claude-extra-usage',
        label: 'Claude usage credits',
        unit: 'usd',
        balance: 0,
        direction: 'spend_rises',
        usdPerUnit: 1
      }
    ])
    expect(spendMeters(CREDITS_OFF.cachedUsageUtilization.utilization.spend, creditStatus(CREDITS_OFF)?.enabled)).toEqual([])
  })

  it('reads an enabled monthly counter as a rising meter', () => {
    const meters = spendMeters(CREDITS_ON.cachedUsageUtilization.utilization.spend, creditStatus(CREDITS_ON)?.enabled)
    expect(meters).toEqual([
      {
        id: 'claude-extra-usage',
        label: 'Claude usage credits',
        unit: 'usd',
        balance: 0,
        direction: 'spend_rises',
        usdPerUnit: 1
      }
    ])
  })

  /** ⛔ A purse, whose *rise* is a top-up — the opposite direction, and only when actually reported. */
  it('adds a falling meter when the vendor publishes a balance', () => {
    const meters = spendMeters({ used: { amount_minor: 500, exponent: 2 }, balance: 37.87 })
    expect(meters.map((m) => [m.id, m.direction, m.balance])).toEqual([
      ['claude-extra-usage', 'spend_rises', 5],
      ['claude-credit-balance', 'balance_falls', 37.87]
    ])
  })

  /** ⚠️ An absent meter is a different statement from a meter reading zero. */
  it('reports no meter at all where the vendor reported no amount', () => {
    expect(spendMeters(undefined)).toEqual([])
    expect(spendMeters({ used: null, balance: null })).toEqual([])
  })

  /**
   * ⛔ Real but unpriceable, which renders `n/a` and never `$0.00`. Guessing a conversion would put
   * a fabricated dollar figure on an operator's bill.
   */
  it('refuses to price a meter the vendor bills in another currency', () => {
    const meters = spendMeters({ used: { amount_minor: 1000, currency: 'EUR', exponent: 2 } })
    expect(meters[0]).toMatchObject({ balance: 10, usdPerUnit: null })
  })
})
