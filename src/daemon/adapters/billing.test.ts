import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { billingDate, claudeBilling, codexBilling, nextMonthlyAnniversary } from '@shared/billing.js'
import { readCodexAuthIdentity } from './openai-compatible.js'

describe('billing dates (t906)', () => {
  // The shapes measured 2026-10-03 on this install's ClaudeFirst and CodexFirst.
  const CLAUDE = { billingType: 'stripe_subscription', subscriptionCreatedAt: '2026-06-21T12:17:45.681833Z' }
  const CODEX = {
    chatgpt_plan_type: 'plus',
    chatgpt_subscription_active_start: '2026-09-02T03:22:22+00:00',
    chatgpt_subscription_active_until: '2026-10-02T03:22:22+00:00',
    chatgpt_subscription_last_checked: '2026-10-01T02:08:49.998435+00:00'
  }

  it('infers Claude from the subscription anniversary, and rolls it forward when read later', () => {
    const billing = claudeBilling(CLAUDE)
    expect(billing?.basis).toBe('inferred')
    expect(billingDate(billing, Date.UTC(2026, 9, 3))).toBe(Date.UTC(2026, 9, 21, 12, 17, 45, 681))
    // ⛔ Stored as an anchor: a reading taken in October still answers in December.
    expect(billingDate(billing, Date.UTC(2026, 11, 25))).toBe(Date.UTC(2027, 0, 21, 12, 17, 45, 681))
  })

  it('has nothing to say about a Claude account with no live subscription', () => {
    expect(claudeBilling({ ...CLAUDE, billingType: 'none' })).toBeNull()
    expect(claudeBilling({ billingType: 'stripe_subscription' })).toBeNull()
    expect(claudeBilling(null)).toBeNull()
  })

  it('takes Codex as published, with when the vendor last checked', () => {
    const billing = codexBilling(CODEX)
    expect(billing).toMatchObject({
      basis: 'published',
      periodEndsAt: Date.parse('2026-10-02T03:22:22Z'),
      vendorCheckedAt: Date.parse('2026-10-01T02:08:49.998Z')
    })
    expect(codexBilling({ chatgpt_plan_type: 'plus' })).toBeNull()
    expect(codexBilling({ chatgpt_subscription_active_until: 'soon' })).toBeNull()
  })

  it('clamps an anniversary to the end of a short month', () => {
    expect(nextMonthlyAnniversary(Date.UTC(2026, 0, 31, 10), Date.UTC(2026, 1, 1))).toBe(Date.UTC(2026, 1, 28, 10))
  })

  describe('read off a Codex auth.json', () => {
    let dir: string | null = null
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = null
    })

    it('carries the id_token claim through the identity probe', () => {
      dir = mkdtempSync(join(tmpdir(), 'ws-billing-'))
      const jwt = (payload: unknown): string =>
        `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
      writeFileSync(
        join(dir, 'auth.json'),
        JSON.stringify({ tokens: { id_token: jwt({ email: 'a@example.com', 'https://api.openai.com/auth': CODEX }) } })
      )
      const identity = readCodexAuthIdentity(dir)
      expect(identity?.subscriptionType).toBe('Plus')
      expect(identity?.billing?.periodEndsAt).toBe(Date.parse(CODEX.chatgpt_subscription_active_until))
    })
  })
})
