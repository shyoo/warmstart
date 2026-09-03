import { describe, expect, it } from 'vitest'
import type { Budget, RunPrice } from '@shared/tasks'
import { runPriceTitle, taskPriceTitle } from './Price'

/**
 * The sentence beside the number.
 *
 * ⛔ **A `*` with no explanation is worse than no `*` at all.** The whole reason a shared window is
 * marked is so a reader knows the figure is a split rather than a measurement — and that is only
 * true if hovering it says so, in words, naming who it was split with. Five of the seven reasons a
 * price cannot be given are different facts, and this is where they stay different.
 */

function price(over: Partial<RunPrice>): RunPrice {
  return {
    usd: 0.23,
    percent: 5,
    estimated: false,
    reason: 'measured',
    basis: 'Claude Pro, $20/month over a 7-day window',
    planId: 'pro',
    planLabel: 'Claude Pro',
    planSource: 'identity',
    windowId: 'weekly_all',
    parallelRunIds: [],
    ...over
  }
}

function budget(over: Partial<Budget>): Budget {
  return { grantedTokens: 0, spentTokens: 1_200_000, ...over }
}

describe('what the tooltip on a run’s price says', () => {
  it('calls a solo run a measurement, and names its share of the window', () => {
    const title = runPriceTitle(price({}))
    expect(title).toMatch(/measured/i)
    expect(title).toContain('5.00% of weekly_all')
    expect(title).toContain('Claude Pro')
  })

  it('says a shared run was split, and how many it was split with', () => {
    const title = runPriceTitle(
      price({ estimated: true, reason: 'shared_window', parallelRunIds: ['x', 'y'] })
    )
    expect(title).toMatch(/2 other runs/)
    expect(title).toMatch(/split by how long each one was open/i)
  })

  it('uses the singular for one parallel run', () => {
    const title = runPriceTitle(
      price({ estimated: true, reason: 'shared_window', parallelRunIds: ['x'] })
    )
    expect(title).toMatch(/1 other run\b/)
    expect(title).not.toMatch(/1 other runs/)
  })

  it('explains an estimate that came from a stale anchor rather than from a neighbour', () => {
    const title = runPriceTitle(price({ estimated: true, parallelRunIds: [] }))
    expect(title).toMatch(/still in flight|too far from its edges/i)
  })

  /** ⛔ Five different facts, five different sentences. A reader must be able to tell them apart. */
  it('gives each n/a its own reason', () => {
    const reset = runPriceTitle(price({ usd: null, percent: null, reason: 'window_reset' }))
    const noRead = runPriceTitle(price({ usd: null, percent: null, reason: 'no_reading' }))
    const free = runPriceTitle(
      price({ usd: null, percent: null, reason: 'unpriced_plan', planLabel: 'Codex Free' })
    )
    const noWindow = runPriceTitle(price({ usd: null, percent: null, reason: 'no_window' }))
    const noPlan = runPriceTitle(price({ usd: null, percent: null, reason: 'no_plan' }))
    expect(reset).toMatch(/rolled over/i)
    expect(noRead).toMatch(/no complete pair of window readings/i)
    expect(free).toContain('Codex Free')
    expect(noWindow).toMatch(/no billing window/i)
    expect(noPlan).toMatch(/which subscription/i)
    expect(new Set([reset, noRead, free, noWindow, noPlan]).size).toBe(5)
  })

  it('says something useful even when there is no price object at all', () => {
    expect(runPriceTitle(null)).toMatch(/cannot be priced/i)
    expect(runPriceTitle(undefined)).toMatch(/cannot be priced/i)
  })
})

describe('what the tooltip on a task’s total says', () => {
  it('calls a complete total what it is', () => {
    const title = taskPriceTitle(budget({ spentUsd: 0.5, spentUsdPartial: false }))
    expect(title).toContain('$0.50')
    expect(title).not.toMatch(/lower bound/i)
  })

  /** ⚠️ The difference between "cost $0.10" and "cost at least $0.10", said out loud. */
  it('says a total missing some of its runs is a lower bound', () => {
    const title = taskPriceTitle(budget({ spentUsd: 0.1, spentUsdPartial: true }))
    expect(title).toMatch(/lower bound/i)
  })

  it('says when part of a total is a split rather than a measurement', () => {
    const title = taskPriceTitle(budget({ spentUsd: 0.1, spentUsdEstimated: true }))
    expect(title).toMatch(/shared its account/i)
  })

  it('says n/a when nothing about the task could be priced', () => {
    expect(taskPriceTitle(budget({ spentUsd: null }))).toMatch(/n\/a/)
    expect(taskPriceTitle(budget({}))).toMatch(/n\/a/)
  })

  /** ⛔ The two numbers are never presented as one. docs/cost-model.md §5. */
  it('says the price is not derived from the token count beside it', () => {
    const title = taskPriceTitle(budget({ spentUsd: 0.5 }))
    expect(title).toMatch(/not from the 1\.2M of tokens/i)
  })
})
