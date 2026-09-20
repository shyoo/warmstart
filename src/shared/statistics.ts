/**
 * Analytics › Statistics — what the fleet's finished work actually cost, took and scored.
 *
 * ⛔ **This is a description, not a model.** Every other analytics surface answers *why the
 * scheduler chose that account*: `routing.velocity` publishes a shrunk pace **factor**, `fitness`
 * publishes a composite blended toward a benchmark prior, `estimate` publishes a median with a
 * confidence. Each of those is a number built to be *acted on*, so each is deliberately pulled
 * towards a neutral middle by how little evidence stands behind it.
 *
 * ⚠️ **Nothing here is shrunk, blended or clamped**, and that is the whole distinction. A person
 * asking *"what does a task cost me on Opus at high effort"* wants the distribution that was
 * measured, including its tail — and a shrunk factor is by construction the wrong answer to that
 * question. The two families of number will disagree, and the page says so rather than quietly
 * reconciling them.
 *
 * ⛔ **`null` is never `0`.** A row nobody could price, time or grade renders `n/a`; `$0.00` is a
 * claim that something was measured and came to nothing, which is a different statement.
 */

/**
 * The three depths of every table on this page, in the order they nest.
 *
 * ⛔ Carried as data rather than expressed as nested arrays, because the tables are flat and the
 * indent is presentation. A tree of children would make "sort by p99 across every model" — the
 * obvious next request — a rewrite rather than a comparator.
 */
export type StatLevel = 'agent' | 'model' | 'effort'

/**
 * Which layers of money a set of runs was actually billed against.
 *
 * ⛔ **The distinction a subscription fleet cannot do without.** `subscription` dollars are an
 * amortised share of a flat monthly fee that was paid whether the run happened or not;
 * `api` dollars were really billed on top, at a market rate, at the moment the work ran. Averaging
 * the two into one column without saying which is which turns "this agent is cheap" into a sentence
 * that means nothing — see `RunPrice` in `@shared/tasks.ts` for why the layers are kept apart at
 * source.
 *
 * ⚠️ `mixed` is the honest verdict for a group whose tasks were not all billed the same way, and it
 * is common: one account crossing into overage mid-month puts every aggregate above it here.
 */
export type PriceBasis = 'subscription' | 'api' | 'mixed' | 'unknown'

/**
 * A measured distribution, unsmoothed.
 *
 * ⚠️ **`p99` on a handful of samples is the maximum wearing a percentile's name**, and the page
 * prints `n` beside it for exactly that reason rather than hiding the column. Suppressing it below
 * some sample floor would be worse: it would leave a reader assuming the tail had been checked.
 */
export interface Distribution {
  /** How many finished tasks this row folds. ⛔ Never inferred; a row with 0 is not rendered. */
  samples: number
  average: number | null
  p50: number | null
  p99: number | null
  /** The largest sample. Named `p100` because that is what it is, and the worst case is the point. */
  p100: number | null
}

/** One row of the Price or Velocity table. The `level` is what the UI indents on. */
export interface StatRow {
  /** Stable across refreshes: `adapterId/model/effort` with the absent levels left empty. */
  key: string
  level: StatLevel
  /** What to print in the first column at this depth — an agent label, a model, or an effort. */
  label: string
  adapterId: string
  /** Null on an `agent` row, and on a `model` row for work whose model was never recorded. */
  model: string | null
  /** Null except on an `effort` row. */
  effort: string | null
  distribution: Distribution
}

export interface PriceStatRow extends StatRow {
  /**
   * Which dollars this row is in. ⛔ On the model level (and the effort levels under it) one row
   * is one basis: a model whose tasks were billed two ways gets a `subscription` row and a
   * `mixed` row rather than one average in neither currency. The agent level above still folds
   * everything, so the totals reconcile.
   */
  basis: PriceBasis
  /**
   * ⚠️ At least one task in this row could not be priced at all, so `samples` is smaller than the
   * number of tasks the row covers and the distribution describes only what could be measured.
   */
  unpriced: number
}

export interface PriceStats {
  rows: PriceStatRow[]
  /** Finished tasks considered, before pricing dropped any of them. */
  tasks: number
  /** How many of those carried no price at all. */
  unpriced: number
  /**
   * ⚠️ True when any contributing run's share was a split, a stale reading or a partly-unread
   * window — i.e. when the whole table is an estimate. See `RunPrice.estimated`.
   */
  estimated: boolean
}

export interface VelocityStats {
  rows: StatRow[]
  tasks: number
  /** Tasks whose active time came out at zero, which is not a duration anybody can compare. */
  untimed: number
}

/**
 * One row of the Quality table.
 *
 * ⛔ **The baseline is a published benchmark, not a zero and not a half.** Until this fleet's own
 * peer review has graded a key, `prior` is the entire answer and the page says so — `@shared/quality.ts`
 * and `fitness.ts` both refuse to let an ungraded key read as average.
 *
 * ⚠️ An `effort` row carries `cleanComposite` and `clean` only. A benchmark prior is published per
 * *model*, so there is no such thing as a prior for `high` specifically, and inventing one by
 * copying the model's down a level would print the same number three times as though it had been
 * measured three ways.
 */
export interface QualityStatRow {
  key: string
  level: StatLevel
  label: string
  adapterId: string
  model: string | null
  effort: string | null
  /** 0..1 benchmark prior. `null` on an effort row, and on any model nobody has benchmarked. */
  prior: number | null
  priorBasis: string | null
  /** Mean composite over **clean** reviews, on the rubric's own 0..10 scale. */
  cleanComposite: number | null
  /** ⛔ The clean count, never the raw sample count. See `QualityKey.clean`. */
  clean: number
  /** Every complete scored review, clean or not, so the gap between the two is visible. */
  samples: number
  /** The blend `fitness.ts` computes, 0..1. `null` on an effort row and on an unknown key. */
  fitness: number | null
  fitnessBasis: string | null
  /** How many finished tasks this fleet ran on the key, whether or not any were graded. */
  tasks: number
  /**
   * The clean composites themselves, folded like a price or a duration — so the Quality tab can
   * draw the same chart the other two do. `samples` here is `clean`, never `samples` above: the
   * distribution is of the evidence, and a leaked review is not evidence.
   */
  distribution: Distribution
}

export interface QualityStats {
  rows: QualityStatRow[]
  /** Complete scored reviews behind the whole table. ⭐ Zero is the expected state on a new fleet. */
  totalReviews: number
  /** Finished tasks with no review at all — what the Quality tab's Grade button exists to shrink. */
  ungraded: number
  rubricVersion: string
}

/**
 * How far back the page reads.
 *
 * `recent` is the last 200 finished tasks — the same ceiling `paceFactors` uses, so Statistics and
 * the pace factor next door are looking at the same window and a disagreement between them is real.
 * `all` is every completed task the fleet still has. ⚠️ A per-display preference, not a fleet
 * setting: which window somebody wants to read is a property of the person reading.
 */
export type StatisticsWindow = 'recent' | 'all'

export const STATISTICS_WINDOWS: readonly StatisticsWindow[] = ['recent', 'all']

export interface StatisticsReport {
  generatedAt: number
  /**
   * How many finished tasks were read, and the ceiling that read stops at — `null` when the read
   * was asked for every task and stopped at nothing.
   *
   * ⚠️ Published because every number on the page is *of this window*, not of all time, and a
   * reader comparing two visits a month apart is comparing two different windows.
   */
  sampleLimit: number | null
  /** The window that was asked for, echoed so the page can say which one it is showing. */
  window: StatisticsWindow
  price: PriceStats
  velocity: VelocityStats
  quality: QualityStats
}
