import { describe, expect, it } from 'vitest'
import type { CreditStatus } from './protocol.js'
import {
  creditAmount,
  creditGaugeVisible,
  creditRefillPhrase,
  creditsMismatchKind,
  creditsMismatchNote,
  creditsPurseEmpty
} from './credits.js'

/**
 * What the app says about an account that was asked to spend usage credits and is not.
 *
 * ⛔ **The bug this file exists to keep fixed, measured 2026-09-13 on `ClaudeFirst` (Claude Code
 * 2.1.270).** The operator turned usage credits on at the vendor and the account row still read
 * *Vendor reports credits off.* Both statements were true and the sentence was useless: the vendor's
 * switch was on (`hasExtraUsageEnabled: true`, `user_disabled: false`) and the *month's allowance*
 * was spent — `$20.57` used against a `$17.30` limit, `spend_limit_reached: true` — so credits were
 * off until the refill and there was nothing to go and switch. Four situations were collapsing into
 * one `enabled: false`, and the one sentence described whichever of them it liked.
 */

/** Verbatim off the live account, as `creditStatus` parses it. */
const SPENT: CreditStatus = {
  enabled: false,
  userDisabled: false,
  disabledReason: 'org_level_disabled_until',
  canToggle: false,
  everEnabled: true,
  spendLimitReached: true,
  monthlyLimit: 17.3,
  used: 20.57,
  currency: 'USD',
  resetsAt: Date.UTC(2026, 8, 21, 12, 17, 45, 681)
}

/** Credits off because a person turned them off — the 2026-09-07 shape, every money field null. */
const USER_OFF: CreditStatus = {
  enabled: false,
  userDisabled: true,
  disabledReason: 'org_level_disabled',
  canToggle: false,
  everEnabled: true,
  spendLimitReached: false,
  monthlyLimit: null,
  used: null,
  currency: 'USD',
  resetsAt: null
}

const ON: CreditStatus = { ...SPENT, enabled: true, spendLimitReached: false, used: 4.5 }

const NOW = Date.UTC(2026, 8, 13, 5)

describe('creditsPurseEmpty', () => {
  /**
   * ⛔ The vendor's own statement, ahead of the arithmetic. `monthly_limit` is a number the vendor
   * may round, prorate or cap differently from the counter it compares against; `spend_limit_reached`
   * is the party that decides saying so.
   */
  it('takes the vendor’s word that the allowance is spent', () => {
    expect(creditsPurseEmpty({ ...SPENT, monthlyLimit: null, used: null })).toBe(true)
  })

  it('still compares the numbers where the vendor publishes no verdict', () => {
    expect(creditsPurseEmpty({ ...SPENT, spendLimitReached: null })).toBe(true)
    expect(creditsPurseEmpty({ ...SPENT, spendLimitReached: null, used: 1 })).toBe(false)
  })

  /** ⚠️ Only `true` is taken from it: a row written before the field existed must read as unknown. */
  it('treats a missing verdict as unknown rather than as spent', () => {
    // ⚠️ Built the way an old row arrives — parsed out of `credits_json` with the key simply
    // absent — rather than by deleting it off a typed literal, which the type would not allow.
    const { spendLimitReached: _absent, ...legacy } = USER_OFF
    expect(creditsPurseEmpty(legacy as CreditStatus)).toBe(false)
    expect(creditsMismatchKind(legacy as CreditStatus)).toBe('user-off')
  })

  it('says nothing about a purse the vendor never described', () => {
    expect(creditsPurseEmpty(USER_OFF)).toBe(false)
    expect(creditsPurseEmpty(null)).toBe(false)
  })
})

describe('creditsMismatchKind', () => {
  /**
   * ⛔ Ordered by the operator's next move, not by which field is most specific. The live account
   * carries a `disabled_reason` *and* a spent allowance, and only the second is actionable.
   */
  it('calls a spent allowance spent, even beside a vendor reason', () => {
    expect(creditsMismatchKind(SPENT)).toBe('purse-empty')
  })

  it('separates a switch somebody threw from a vendor that only says no', () => {
    expect(creditsMismatchKind(USER_OFF)).toBe('user-off')
    expect(creditsMismatchKind({ ...USER_OFF, userDisabled: false })).toBe('off')
    expect(creditsMismatchKind({ ...USER_OFF, userDisabled: null, everEnabled: false })).toBe(
      'never-offered'
    )
  })

  /** ⚠️ Neither a spending account nor an unprobed one is a mismatch. */
  it('names nothing where there is no mismatch', () => {
    expect(creditsMismatchKind(ON)).toBeNull()
    expect(creditsMismatchKind(null)).toBeNull()
    expect(creditsMismatchKind(undefined)).toBeNull()
  })
})

describe('creditsMismatchNote', () => {
  /** ⛔ The claim *and* the evidence for it, because an operator cannot act on the claim alone. */
  it('says the allowance is spent, with the numbers and the refill', () => {
    const note = creditsMismatchNote(SPENT, NOW)
    expect(note).toContain('$20.57 of $17.30 used')
    expect(note).toContain('refills in 9 days')
    // ⛔ Never this sentence for this account: the vendor's switch is on.
    expect(note).not.toContain('switched off')
  })

  it('leaves out a refill it cannot date and a ceiling the vendor did not publish', () => {
    const note = creditsMismatchNote({ ...SPENT, resetsAt: null, monthlyLimit: null }, NOW)
    expect(note).toBe('This month’s usage credits are spent.')
  })

  it('names the vendor’s reason for the kinds where the reason is the answer', () => {
    expect(creditsMismatchNote(USER_OFF, NOW)).toContain('org_level_disabled')
    expect(creditsMismatchNote(USER_OFF, NOW)).toContain('on the account')
    expect(creditsMismatchNote({ ...USER_OFF, userDisabled: false }, NOW)).toContain(
      'Vendor reports credits off'
    )
  })

  it('is empty where nothing is wrong, so a caller can render it unconditionally', () => {
    expect(creditsMismatchNote(ON, NOW)).toBe('')
    expect(creditsMismatchNote(null, NOW)).toBe('')
  })
})

describe('creditGaugeVisible', () => {
  /**
   * ⛔ The account with the largest bill on it was the one card that drew no credits gauge: the
   * gauge tested `enabled === true`, and the vendor had turned credits off *because* `$20.57` had
   * been spent.
   */
  it('draws a spent allowance the vendor has cut off', () => {
    expect(creditGaugeVisible(SPENT)).toBe(true)
  })

  it('draws an account that is spending', () => {
    expect(creditGaugeVisible(ON)).toBe(true)
  })

  /** ⚠️ Nothing to draw without a number — and a zero under credits-off is an unavailable balance. */
  it('draws nothing where the vendor published no amount', () => {
    expect(creditGaugeVisible(USER_OFF)).toBe(false)
    expect(creditGaugeVisible({ ...USER_OFF, used: 0 })).toBe(false)
    expect(creditGaugeVisible(null)).toBe(false)
  })
})

describe('creditAmount and creditRefillPhrase', () => {
  /** ⛔ `null` is *not reported* and reads `n/a`; `$0.00` is the opposite claim. */
  it('prints an absent amount as n/a and a real zero as zero', () => {
    expect(creditAmount(null, 'USD')).toBe('n/a')
    expect(creditAmount(0, 'USD')).toBe('$0.00')
    expect(creditAmount(20.57, null)).toBe('$20.57')
  })

  /** ⛔ Real but unpriceable: a guessed rate would put a fabricated figure on somebody's bill. */
  it('leaves another currency in its own units', () => {
    expect(creditAmount(20.5, 'EUR')).toBe('20.50 EUR')
  })

  it('counts whole days to the refill and says nothing about one that has passed', () => {
    expect(creditRefillPhrase(NOW + 86_400_000, NOW)).toBe('refills in 1 day')
    expect(creditRefillPhrase(NOW + 3 * 86_400_000, NOW)).toBe('refills in 3 days')
    expect(creditRefillPhrase(NOW - 1, NOW)).toBe('')
    expect(creditRefillPhrase(null, NOW)).toBe('')
  })
})
