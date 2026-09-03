import type { JSX } from 'react'
import type { Budget, RunPrice } from '@shared/tasks'
import { money, tokens } from '../lib/format'

/**
 * Money over tokens, in the one place both surfaces read it from.
 *
 * ⛔ **The `*` and its tooltip are never written by a caller.** An estimate that renders as a bare
 * number somewhere is worse than one that renders nowhere: the reader has no way to know which of
 * the two they are looking at. Marking it here means every surface that shows a price shows the
 * caveat, and a new surface cannot forget to.
 *
 * ⚠️ `n/a` is not `$0.00` — see `money()`. The five reasons a price cannot be given are five
 * different facts, and the title says which one this is.
 */

/** One sentence a person can act on, for a run's price. */
export function runPriceTitle(price: RunPrice | null | undefined): string {
  if (!price) return 'Nothing about this run says what it was billed against, so it cannot be priced.'
  const head =
    price.usd === null
      ? naHead(price)
      : price.estimated
        ? estimatedHead(price)
        : 'Measured: this run held the account’s billing window on its own for its whole life.'
  const share =
    price.percent === null
      ? ''
      : ` It is credited with ${price.percent.toFixed(2)}% of ${price.windowId ?? 'the window'}.`
  return `${head}${share} ${price.basis}`.trim()
}

function naHead(price: RunPrice): string {
  switch (price.reason) {
    case 'window_reset':
      return 'n/a — the account’s window rolled over while this run was in flight, so the difference either side of it is not a cost.'
    case 'no_reading':
      return 'n/a — this run has no complete pair of window readings, one before and one after, so there is no difference to price.'
    case 'unpriced_plan':
      return `n/a — ${price.planLabel ?? 'this plan'} has no subscription price to divide. That is not the same as free work: it is a cost this tool cannot meter.`
    case 'no_window':
      return 'n/a — this provider reports no billing window, so there is nothing to take a fraction of.'
    default:
      return 'n/a — nothing on this run says which subscription it was billed against.'
  }
}

function estimatedHead(price: RunPrice): string {
  if (price.parallelRunIds.length > 0) {
    const n = price.parallelRunIds.length
    return (
      `Estimate — this run shared its account with ${n} other run${n === 1 ? '' : 's'} at the same ` +
      'time, so its share of the window is a split by how long each one was open, not a measurement.'
    )
  }
  return (
    'Estimate — either this run is still in flight, or the nearest window readings either side of ' +
    'it were taken too far from its edges to be called a measurement.'
  )
}

/** The same sentence for a whole task, whose total is a sum of its runs. */
export function taskPriceTitle(budget: Budget): string {
  if (budget.spentUsd === null || budget.spentUsd === undefined) {
    return 'n/a — none of this task’s runs could be priced. Open the task to see why for each one.'
  }
  const parts = [
    `${money(budget.spentUsd)} — this task’s share of the subscription, summed over every run.`
  ]
  if (budget.spentUsdPartial) {
    parts.push(
      '⚠️ A lower bound: at least one run could not be priced at all, so the real figure is higher.'
    )
  }
  if (budget.spentUsdEstimated) {
    parts.push(
      'At least one run shared its account with another, so part of this is a split rather than a measurement.'
    )
  }
  parts.push(
    `Derived from the account’s own window readings, not from the ${tokens(budget.spentTokens || null)} of tokens below.`
  )
  return parts.join(' ')
}

/** A price with its estimate mark. ⛔ The `*` is part of the number, never optional decoration. */
export function Money({
  usd,
  estimated,
  partial,
  title
}: {
  usd: number | null | undefined
  estimated?: boolean | undefined
  /** A total missing some of its runs. Shown as `≥`, which is a different claim from `*`. */
  partial?: boolean | undefined
  title: string
}): JSX.Element {
  const na = usd === null || usd === undefined
  return (
    <span className={na ? 'price price--na' : 'price'} title={title}>
      {partial && !na ? '≥' : ''}
      {money(usd)}
      {estimated && !na && <span className="price-est">*</span>}
    </span>
  )
}
