import { describe, expect, it } from 'vitest'
import type { DebatePreview } from '@shared/protocol'
import { costNotice, debateNotices, heterogeneityNotice, returnsNotice, serialNotice } from './debatenotice'

/**
 * What the composer says under the Debate row.
 *
 * ⛔ **The notices are advisory and must stay advisory.** These assertions are about wording and
 * about what is never omitted — the honest caveat, the basis, the `n/a` that is not `$0.00` — not
 * about the arithmetic, which is proved in `debatecost.test.ts` where it is computed.
 */

const preview = (over: Partial<DebatePreview> = {}): DebatePreview => ({
  perSeatTokens: 120_000,
  perSeatUsd: 1.5,
  totalTokens: 720_000,
  totalUsd: 9,
  multiple: 6,
  usdConfidence: 'medium',
  confidence: 'medium',
  basis: '2 seat(s) × 3 round(s) plus 3 organizer turn(s).',
  assumed: false,
  adapterSpread: 2,
  parallelSeats: 2,
  seatCount: 2,
  ...over
})

describe('the heterogeneity notice', () => {
  // ⛔ Counted on the adapter, not the model name: two Claude models are one family.
  it('says so, approvingly, when the roster spans two families', () => {
    const notice = heterogeneityNotice(preview({ adapterSpread: 2 }))
    expect(notice.tone).toBe('neutral')
    expect(notice.text).toContain('2 model families')
  })

  // ⛔ Never a refusal: not every operator has a second provider, and the notice says which of
  // theirs would help.
  it('cautions a one-family roster and names the change that would help', () => {
    const notice = heterogeneityNotice(preview({ adapterSpread: 1 }))
    expect(notice.tone).toBe('caution')
    expect(notice.text).toContain('same model family')
    expect(notice.text).toContain('another CLI')
    expect(notice.text).toContain('not a refusal')
  })
})

describe('the cost notice', () => {
  it('leads with the multiple, because that is what an operator reads', () => {
    expect(costNotice(preview()).text).toMatch(/^About 6\.0× the cost of asking this question once/)
  })

  it('carries the basis it was handed, never a re-derived one', () => {
    expect(costNotice(preview()).text).toContain('2 seat(s) × 3 round(s)')
  })

  /**
   * ⛔ **`n/a`, never `$0.00`.** They are opposite claims: `$0.00` says this debate costs nothing,
   * `n/a` says nobody can say what it costs.
   */
  it('says money is n/a rather than zero where nothing could be priced', () => {
    const notice = costNotice(preview({ totalUsd: null, perSeatUsd: null, usdConfidence: 'none' }))
    expect(notice.text).toContain('money n/a')
    expect(notice.text).toContain('nothing here could be priced')
    expect(notice.text).not.toContain('$0.00')
  })

  it('says when the numbers rest on assumed factors', () => {
    expect(costNotice(preview({ assumed: true })).text).toContain('assumed rather than measured')
  })

  it('says the cost is unknown rather than inventing a multiple', () => {
    expect(costNotice(preview({ multiple: null })).text).toContain('Cost unknown')
  })
})

describe('the diminishing-return notice', () => {
  /**
   * ⛔ **The honest caveat is not optional**, at any seat count and any round count. It is the
   * sentence that makes this feature trustworthy, on the screen where the money is committed.
   */
  it('carries the caveat that debate may not beat one strong agent, always', () => {
    for (const [seats, rounds] of [
      [2, 1],
      [3, 3],
      [5, 5]
    ] as const) {
      const text = returnsNotice(seats, rounds).text
      expect(text).toContain('was measured on this fleet')
      expect(text).toContain('does not beat one strong agent at the same token budget')
    }
  })

  it('is quiet about flattening at three or fewer of each, and names both when past', () => {
    expect(returnsNotice(3, 3).tone).toBe('neutral')
    expect(returnsNotice(3, 3).text).not.toContain('flatten')
    const past = returnsNotice(5, 5)
    expect(past.tone).toBe('caution')
    expect(past.text).toContain('5 seats and 5 rounds')
    expect(past.text).toContain('rounds alone diminish')
  })
})

describe('the serialisation notice', () => {
  it('says nothing when every seat can run at once', () => {
    expect(serialNotice(preview({ seatCount: 2, parallelSeats: 2 }))).toBeNull()
  })

  /**
   * ⛔ **Said out loud, never silently corrected.** `maxConcurrent` commissions at 1, so the
   * commonest install runs a three-seat debate serially.
   */
  it('names the arithmetic and what would change it, and that the answer is unaffected', () => {
    const notice = serialNotice(preview({ seatCount: 3, parallelSeats: 1 }))
    expect(notice?.text).toContain('Only 1 of 3 seats')
    expect(notice?.text).toContain('workspace pool')
    // ⚠️ Blindness survives serialisation: every seat is its own session, filed sharing-off.
    expect(notice?.text).toContain('own session')
  })
})

describe('the notices the composer draws', () => {
  it('is three when everything runs in parallel, and four when it does not', () => {
    expect(debateNotices(preview(), 3).map((n) => n.id)).toEqual(['heterogeneity', 'cost', 'returns'])
    expect(debateNotices(preview({ seatCount: 3, parallelSeats: 1 }), 3).map((n) => n.id)).toEqual([
      'heterogeneity',
      'cost',
      'serial',
      'returns'
    ])
  })
})
