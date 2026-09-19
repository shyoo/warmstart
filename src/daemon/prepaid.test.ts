import { describe, expect, it } from 'vitest'
import type { QuotaWindow } from '@shared/protocol.js'
import { costModel } from './costmodel.js'
import {
  normalizePrepaidField,
  prepaidDenominator,
  prepaidEvidence,
  type PrepaidEvidenceInput,
  type PrepaidRawRecord
} from './prepaid.js'

/**
 * Routing Model v1.2 — prepaid expiry pressure (`docs/routing.md` §3.3a).
 *
 * Pure evidence and normalizer tests: no database, no scheduler. The fixtures below mirror the
 * plan's motivating pair — Claude Pro's $20/month over a 7-day window ($4.5996 per full window),
 * 80% of it left ($3.6797), resetting in 24h versus 1h.
 */

const anthropic = () => costModel('anthropic.subscription.2026-08')
const antigravity = () => costModel('google.antigravity.2026-08')
const local = () => costModel('local.llm.2026-09')

function weekly(
  percent: number,
  resetsAt: number | null,
  id = 'weekly',
  label = 'Claude 7d'
): QuotaWindow {
  return { id, label, percent, resetsAt }
}

function input(
  trustedWindows: QuotaWindow[],
  opts: Partial<PrepaidEvidenceInput> & { now: number }
): PrepaidEvidenceInput {
  return {
    costModel: anthropic(),
    subscriptionType: null,
    pool: null,
    trustedWindows,
    inferredIds: new Set(),
    staleEvidence: false,
    payNowBlocking: false,
    ...opts
  }
}

function normalizeOne(record: PrepaidRawRecord) {
  return normalizePrepaidField([record])[0]!
}

describe('prepaid expiry pressure (v1.2)', () => {
  it('scores the same dollars resetting in 1h exactly 24× the same dollars resetting in 24h', () => {
    const now = Date.now()
    const a = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    const b = prepaidEvidence(
      input([weekly(20, now + 1 * 3600 * 1000)], { now })
    )
    const [termA, termB] = normalizePrepaidField([a, b])
    expect(termB!.value).toBeCloseTo(1, 10)
    expect(termA!.value).toBeCloseTo(1 / 24, 10)
    expect(termB!.value / termA!.value).toBeCloseTo(24, 8)
  })

  it('holds the 24× ratio at 80% used, independently of the leftover wording', () => {
    const now = Date.now()
    const a = prepaidEvidence(
      input([weekly(80, now + 24 * 3600 * 1000)], { now })
    )
    const b = prepaidEvidence(
      input([weekly(80, now + 1 * 3600 * 1000)], { now })
    )
    const [termA, termB] = normalizePrepaidField([a, b])
    expect(termB!.value).toBeCloseTo(1, 10)
    expect(termB!.value / termA!.value).toBeCloseTo(24, 8)
  })

  it('prices a 10× dearer plan at 10× the raw pressure for the same percentage and time', () => {
    const now = Date.now()
    const pro = prepaidEvidence(
      input([weekly(20, now + 10 * 3600 * 1000)], { now })
    )
    const max = prepaidEvidence(
      input([weekly(20, now + 10 * 3600 * 1000)], {
        now,
        subscriptionType: 'max 20'
      })
    )
    expect(max.rawPressure / pro.rawPressure).toBeCloseTo(10, 8)
  })

  it('holds equal dollars per hour equal across different plans', () => {
    const now = Date.now()
    // $3.6797 left on Pro over 24h, and the same dollars left on Max 20x over 24h (8% of $45.996).
    const pro = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    const max = prepaidEvidence(
      input([weekly(92, now + 24 * 3600 * 1000)], {
        now,
        subscriptionType: 'max 20'
      })
    )
    expect(max.rawPressure).toBeCloseTo(pro.rawPressure, 8)
    const [termPro, termMax] = normalizePrepaidField([pro, max])
    expect(termMax!.value).toBeCloseTo(termPro!.value, 10)
  })

  it('applies a pooled plan’s share exactly once per window', () => {
    const now = Date.now()
    const cm = antigravity()
    const trusted: QuotaWindow[] = [
      { id: 'weekly:gemini', label: 'Gemini 7d', percent: 20, resetsAt: now + 24 * 3600 * 1000 },
      { id: 'weekly:claude-gpt', label: 'Claude/GPT 7d', percent: 40, resetsAt: now + 24 * 3600 * 1000 }
    ]
    const record = prepaidEvidence({
      costModel: cm,
      subscriptionType: null,
      pool: null,
      trustedWindows: trusted,
      inferredIds: new Set(),
      staleEvidence: false,
      payNowBlocking: false,
      now
    })
    // `claude` and `gpt` are two pool keys over the one Claude/GPT window — it must appear once.
    expect(record.windows.map((w) => w.ref.id).sort()).toEqual([
      'weekly:claude-gpt',
      'weekly:gemini'
    ])
    const plan = cm.resolvePlan({ windowIds: trusted.map((w) => w.id) })!
    const gemini = cm.priceOfWindowUsage(plan.id, [
      { window: { id: 'weekly:gemini', days: 7, pool: 'gemini', share: 0.9 }, percent: 80 }
    ])!.usd
    const claude = cm.priceOfWindowUsage(plan.id, [
      { window: { id: 'weekly:claude-gpt', days: 7, pool: 'claude', share: 0.1 }, percent: 60 }
    ])!.usd
    expect(record.rawPressure).toBeCloseTo((gemini + claude) / 24, 8)
  })

  it('scores 0 with a distinct reason for each unmeasurable shape', () => {
    const now = Date.now()
    const cases: Array<{ name: string; record: PrepaidRawRecord; reason: RegExp }> = [
      {
        name: 'null reset',
        record: prepaidEvidence(input([weekly(20, null)], { now })),
        reason: /no trusted reset/
      },
      {
        name: 'past reset',
        record: prepaidEvidence(input([weekly(20, now - 1000)], { now })),
        reason: /no trusted reset/
      },
      {
        name: 'no trusted window at all',
        record: prepaidEvidence(input([], { now })),
        reason: /no trusted billing-window reading/
      },
      {
        name: 'stale probe behind the empty reading',
        record: prepaidEvidence(input([], { now, staleEvidence: true })),
        reason: /probe reading is stale/
      },
      {
        name: 'unknown billing (no cost model)',
        record: prepaidEvidence(input([weekly(20, now + 3600 * 1000)], { now, costModel: null })),
        reason: /billing is unknown/
      },
      {
        name: 'unpriced plan (local)',
        record: prepaidEvidence({
          costModel: local(),
          subscriptionType: null,
          pool: null,
          trustedWindows: [weekly(20, now + 3600 * 1000)],
          inferredIds: new Set(),
          staleEvidence: false,
          payNowBlocking: false,
          now
        }),
        reason: /no prepaid allowance/
      }
    ]
    // Null and past resets share one reason; every other shape names its own.
    const reasons = new Set(cases.map((c) => c.reason.source))
    expect(reasons.size).toBe(cases.length - 1)
    for (const c of cases) {
      const term = normalizeOne(c.record)
      expect(term.value, c.name).toBe(0)
      expect(term.basis, c.name).toMatch(c.reason)
      expect(term.behindScheduleWindowIds, c.name).toEqual([])
    }
  })

  it('counts a vendor-silent inferred window, and says the reset was projected', () => {
    const now = Date.now()
    const record = prepaidEvidence(
      input([weekly(0, now + 4 * 24 * 3600 * 1000)], {
        now,
        inferredIds: new Set(['weekly'])
      })
    )
    const term = normalizeOne(record)
    expect(term.value).toBeCloseTo(1, 10)
    expect(term.basis).toContain('inferred, reset projected')
    expect(term.basis).not.toContain('observed')
  })

  it('keeps pay-now at −1 and out of the field denominator', () => {
    const now = Date.now()
    const sub = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    const pay = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now, payNowBlocking: true })
    )
    expect(prepaidDenominator([sub, pay])).toBeCloseTo(sub.rawPressure, 10)
    const [termSub, termPay] = normalizePrepaidField([sub, pay])
    expect(termPay!.value).toBe(-1)
    expect(termSub!.value).toBeCloseTo(1, 10)
  })

  it('marks windows behind their spend schedule, and only those', () => {
    const now = Date.now()
    // 20% used with a day left spends far behind the rate that would use the window in time.
    const behind = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    // 99% used is ahead of any steady rate — nothing to prefer here.
    const ahead = prepaidEvidence(
      input([weekly(99, now + 24 * 3600 * 1000)], { now })
    )
    expect(normalizeOne(behind).behindScheduleWindowIds).toEqual(['weekly'])
    expect(normalizeOne(ahead).behindScheduleWindowIds).toEqual([])
    expect(normalizeOne(behind).skipNote).toContain('behind its spend schedule')
  })

  it('names dollars, hours, raw pressure, denominator and observed status in every positive basis', () => {
    const now = Date.now()
    const a = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    const b = prepaidEvidence(
      input([weekly(20, now + 1 * 3600 * 1000, 'weekly', 'Claude 7d')], { now })
    )
    const [termA] = normalizePrepaidField([a, b])
    expect(termA!.basis).toContain('$3.680 left')
    expect(termA!.basis).toContain('24.0h to reset')
    expect(termA!.basis).toContain('$0.153/h')
    expect(termA!.basis).toContain('observed')
    expect(termA!.basis).toMatch(/field denominator \$3\.680\/h/)
  })

  it('keeps the stored remainder, hours, raw pressure, denominator and value on the term', () => {
    const now = Date.now()
    const record = prepaidEvidence(
      input([weekly(20, now + 24 * 3600 * 1000)], { now })
    )
    expect(record.rawPressure).toBeGreaterThan(0)
    expect(record.steadyPressure).toBeGreaterThan(0)
    expect(record.plan?.id).toBe('pro')
    expect(record.plan?.source).toBe('default')
    expect(record.windows).toHaveLength(1)
    expect(record.windows[0]!.remainingUsd).toBeCloseTo(3.6797, 3)
    expect(record.windows[0]!.hoursLeft).toBeCloseTo(24, 6)
  })
})
