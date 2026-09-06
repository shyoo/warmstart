import { describe, expect, it } from 'vitest'
import { costModel, costModels, loadCostModels } from './costmodel.js'

/**
 * The subscription catalogue, and the one formula that turns a fraction of a window into money.
 *
 * ⛔ **These assert the shipped JSON, not a fixture.** A plan block that stops matching the window
 * ids an adapter emits fails silently at runtime — every run quietly becomes `n/a` and nothing
 * throws. The only way to catch that is to assert the real files against the ids this install has
 * actually been measured writing.
 */

loadCostModels()

/**
 * Window ids **as adapters actually emit them**, measured 2026-09-02 from this install's own
 * `runs.quota_before_json` / `quota_after_json`.
 *
 * ⛔ These are not the ids in each file's own `quota.windows` block, and that mismatch is the whole
 * reason `billing_window.match` is a list matched by containment. claude-code declares `5h`/`7d`
 * and emits `session`/`weekly_all`; antigravity declares `weekly:claude-gpt` and emits
 * `weekly:claude-and-gpt`.
 */
const EMITTED: Record<string, string[]> = {
  'anthropic.subscription.2026-08': ['session', 'weekly_all'],
  'google.antigravity.2026-08': ['5h', 'weekly:gemini', '5h:claude-and-gpt', 'weekly:claude-and-gpt'],
  'openai.codex.2026-08': ['5h', '7d']
}

describe('the money a subscription is worth per window', () => {
  /**
   * ⭐ The ask, made exact: "$20 a month is $5 a week, or slightly less if we have 29+ days per
   * month". Over 365.25/12 days, a 7-day slice of $20 is $4.5996 — so 5% of a week is $0.230.
   */
  it('prices a full weekly window of Claude Pro at $4.5996', () => {
    const priced = costModel('anthropic.subscription.2026-08').priceOfWindowPercent('pro', 100)
    expect(priced!.usd).toBeCloseTo(20 * (7 / (365.25 / 12)), 6)
    expect(priced!.usd).toBeCloseTo(4.5996, 4)
  })

  it('prices 5% of a weekly window of Claude Pro at $0.230', () => {
    const priced = costModel('anthropic.subscription.2026-08').priceOfWindowPercent('pro', 5)
    expect(priced!.usd).toBeCloseTo(0.23, 3)
  })

  it('scales with the plan, not with anything in the code', () => {
    const cm = costModel('anthropic.subscription.2026-08')
    const pro = cm.priceOfWindowPercent('pro', 10)!.usd
    const max20 = cm.priceOfWindowPercent('max_20x', 10)!.usd
    expect(max20 / pro).toBeCloseTo(10, 6)
  })

  /**
   * ⚠️ The 90:10 heuristic, revised by the operator on 2026-09-06 from the 80:20 it was written at
   * on 2026-09-02: Claude/GPT draws its window far faster than Gemini does, so the one $20 is
   * charged 90% against Gemini and 10% against Claude/GPT. ⛔ Neither figure is published; what
   * moved it was that at 80:20 a Claude/GPT task on this provider priced several times a Gemini one
   * on Statistics, on a pool that serves a small minority of the runs here.
   */
  it('charges the antigravity pools 90:10 — Gemini $18, Claude/GPT $2', () => {
    const cm = costModel('google.antigravity.2026-08')
    expect(cm.priceOfWindowPercent('pro', 5, 'gemini')!.usd).toBeCloseTo(0.207, 3)
    expect(cm.priceOfWindowPercent('pro', 5, 'claude')!.usd).toBeCloseTo(0.023, 3)
    expect(cm.priceOfWindowPercent('pro', 5, 'gpt')!.usd).toBeCloseTo(0.023, 3)
  })

  /**
   * ⛔ **The shares sum to 1, and this is what that buys.** A week that filled both pools reports
   * one week of subscription, not two. Under the rejected "full $20 per pool" reading it would have
   * reported $9.20 of spend against a $4.60 week.
   */
  it('never bills more than one subscription for a week that filled every pool', () => {
    const cm = costModel('google.antigravity.2026-08')
    const windows = cm.billingWindowsFor(EMITTED['google.antigravity.2026-08']!)
    const both = cm.priceOfWindowUsage(
      'pro',
      windows.map((w) => ({ window: w, percent: 100 }))
    )!
    expect(both.usd).toBeCloseTo(20 * (7 / (365.25 / 12)), 6)
  })

  it('counts a window once even though claude and gpt both name it', () => {
    const cm = costModel('google.antigravity.2026-08')
    const windows = cm.billingWindowsFor(EMITTED['google.antigravity.2026-08']!)
    expect(windows.map((w) => w.id).sort()).toEqual(['weekly:claude-and-gpt', 'weekly:gemini'])
    expect(windows.reduce((a, w) => a + w.share, 0)).toBeCloseTo(1, 9)
  })

  it('restricts to one pool when the run’s model declares one', () => {
    const cm = costModel('google.antigravity.2026-08')
    const gemini = cm.billingWindowsFor(EMITTED['google.antigravity.2026-08']!, 'gemini')
    expect(gemini.map((w) => w.id)).toEqual(['weekly:gemini'])
    expect(gemini[0]!.share).toBeCloseTo(0.9, 9)
  })

  /**
   * ⛔ **n/a, never $0.00.** A free plan reading 5% of its window spent 5% of nothing; `$0.00` would
   * claim it spent nothing at all, which is a measurement nobody took.
   */
  it('refuses to price a free plan rather than pricing it at zero', () => {
    expect(costModel('openai.codex.2026-08').priceOfWindowPercent('free', 5)).toBeNull()
    expect(costModel('anthropic.subscription.2026-08').priceOfWindowPercent('free', 5)).toBeNull()
  })

  it('refuses to price a local server at all', () => {
    const cm = costModel('local.llm.2026-09')
    expect(cm.canPriceMoney()).toBe(false)
    expect(cm.priceOfWindowPercent('self_hosted', 100)).toBeNull()
    expect(cm.billingWindowsFor(['weekly'])).toEqual([])
  })

  it('carries a basis on every price it gives', () => {
    const priced = costModel('anthropic.subscription.2026-08').priceOfWindowPercent('pro', 5)!
    expect(priced.basis).toContain('$20/month')
    expect(priced.basis).toContain('7-day window')
  })
})

describe('finding the window the money is divided over', () => {
  /**
   * ⛔ The regression this whole match-list exists for. `weekly_all` is not `7d`, and a cost model
   * matching its own declared ids would price no Claude run at all.
   */
  it('matches every window id each adapter has actually been measured emitting', () => {
    for (const [modelId, ids] of Object.entries(EMITTED)) {
      const windows = costModel(modelId).billingWindowsFor(ids)
      expect(windows.length, modelId).toBeGreaterThan(0)
      for (const w of windows) expect(ids, modelId).toContain(w.id)
    }
  })

  it('picks the weekly window and never the session one', () => {
    const windows = costModel('anthropic.subscription.2026-08').billingWindowsFor([
      'session',
      'weekly_all'
    ])
    expect(windows.map((w) => w.id)).toEqual(['weekly_all'])
  })

  it('finds nothing when the account reports no weekly window at all', () => {
    // Codex's free era: one 30-day window and nothing else.
    expect(costModel('openai.codex.2026-08').billingWindowsFor(['30d'])).toEqual([])
  })
})

describe('which subscription a run was on', () => {
  /**
   * ⭐ **The measured free→paid split, and the reason it is read from the shape rather than the
   * model name.** The 8 free-era codex runs on this install recorded no model at all, so deducing
   * the plan from the model — the ask's own suggestion — would have answered nothing for exactly
   * the runs that needed answering. The window shape answers all of them.
   */
  it('reads Codex’s free era from its window shape, not from the identity string', () => {
    const cm = costModel('openai.codex.2026-08')
    // The identity string says "Plus" today, because that is what the account is *today*.
    const free = cm.resolvePlan({ subscriptionType: 'Plus', windowIds: ['30d'] })
    expect(free!.id).toBe('free')
    expect(free!.source).toBe('window_shape')
    expect(free!.priced).toBe(false)
  })

  it('reads Codex’s paid era from its window shape too', () => {
    const paid = costModel('openai.codex.2026-08').resolvePlan({ windowIds: ['5h', '7d'] })
    expect(paid!.id).toBe('plus')
    expect(paid!.source).toBe('window_shape')
    expect(paid!.monthlyUsd).toBe(20)
  })

  it('cannot match both codex shapes at once', () => {
    const cm = costModel('openai.codex.2026-08')
    expect(cm.resolvePlan({ windowIds: ['30d'] })!.id).toBe('free')
    expect(cm.resolvePlan({ windowIds: ['5h', '7d'] })!.id).toBe('plus')
    // Neither shape claims the other's ids, so there is no window list that answers ambiguously.
    expect(cm.resolvePlan({ windowIds: ['30d', '7d'] })!.id).toBe('plus')
  })

  it('falls back to the vendor’s own subscriptionType string', () => {
    const cm = costModel('anthropic.subscription.2026-08')
    expect(cm.resolvePlan({ subscriptionType: 'pro' })!.id).toBe('pro')
    expect(cm.resolvePlan({ subscriptionType: 'Max' })!.id).toBe('max_5x')
    expect(cm.resolvePlan({ subscriptionType: 'Max 20x' })!.id).toBe('max_20x')
    expect(cm.resolvePlan({ subscriptionType: 'pro' })!.source).toBe('identity')
  })

  it('tells Google AI Pro apart from Google AI Ultra', () => {
    const cm = costModel('google.antigravity.2026-08')
    expect(cm.resolvePlan({ subscriptionType: 'Google AI Pro' })!.id).toBe('pro')
    expect(cm.resolvePlan({ subscriptionType: 'Google AI Ultra' })!.id).toBe('ultra')
  })

  /**
   * ⛔ **Never free.** The ask was explicit: when Codex is unsure, assume the paid account.
   * Defaulting to free would print `n/a` over real money, which is the expensive direction to be
   * wrong in — and `plan_source` records that it was a default rather than a reading.
   */
  it('defaults every provider to a paid plan, never to a free one', () => {
    for (const cm of costModels()) {
      const plan = cm.resolvePlan({})
      if (!plan) continue
      expect(plan.source, cm.id).toBe('default')
      if (cm.canPriceMoney()) expect(plan.monthlyUsd, cm.id).toBeGreaterThan(0)
    }
  })

  it('answers null only where a provider declares no plans at all', () => {
    for (const cm of costModels()) expect(cm.resolvePlan({}), cm.id).not.toBeNull()
  })

  it('every catalogue id is priceable by id, and carries a label', () => {
    for (const cm of costModels()) {
      for (const id of cm.planIds()) {
        const plan = cm.planById(id)!
        expect(plan.label.length, `${cm.id} ${id}`).toBeGreaterThan(0)
        expect(plan.source, `${cm.id} ${id}`).toBe('stored')
      }
    }
  })
})
