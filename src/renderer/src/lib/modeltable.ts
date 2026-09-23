import type { ModelOptions, Worker } from '@shared/protocol'
import { samePair, type ModelRoute } from '@shared/modelroutes'

/**
 * One line of the model table in Settings → Workers (t638).
 *
 * ⭐ **Every model the adapter can price has a line, whether or not anybody stored one.** The
 * operator's ask was to see all of them and tick which does what, rather than open a menu to find
 * out what exists. A line nobody has touched is `stored: false` and is not written back: it names a
 * model, a seeded effort and the built-in class, and nothing about it is a setting until it is.
 */
export interface ModelTableRow extends ModelRoute {
  /** Written back on the next edit. False for a line drawn only so the model is on screen. */
  stored: boolean
}

type TableWorker = Pick<
  Worker,
  | 'modelRoutes'
  | 'defaultModel'
  | 'defaultEffort'
  | 'defaultModels'
  | 'gradingModel'
  | 'gradingEffort'
  | 'judgmentModel'
  | 'judgmentEffort'
  | 'summarisingModel'
>

/**
 * The levels a line may be set to, or none.
 *
 * ⛔ Both halves, as everywhere else: the CLI must take an effort flag *and* the model must declare
 * levels. `claude-haiku-4-5` declares none, so its line reads `n/a` rather than offering a choice
 * that fails at dispatch.
 */
export function effortLevelsFor(options: ModelOptions | null, model: string): string[] {
  if (!options?.selectableEffort) return []
  return options.models.find((m) => m.id === model)?.effortLevels ?? []
}

/**
 * The effort a line is drawn with before anybody picks one.
 *
 * ⛔ **Never "CLI default".** The operator asked for that choice to go: a line is a (model, effort)
 * pair and says which effort. The account's own default effort where this model has it, else
 * `medium`, else the middle level. ⚠️ `null` only where there are no levels to choose from.
 */
export function seedEffort(levels: string[], accountDefault: string | null): string | null {
  if (levels.length === 0) return null
  if (accountDefault && levels.includes(accountDefault)) return accountDefault
  if (levels.includes('medium')) return 'medium'
  return levels[Math.floor(levels.length / 2)] ?? null
}

/**
 * The effort a stored choice really carries for this model.
 *
 * ⚠️ An account defaulting to `medium` on `claude-haiku-4-5` sends no effort at all — the dispatch
 * drops a level the model does not declare — so that choice is the haiku line with no effort, not a
 * second haiku line at `medium` that no dispatch could ever run.
 */
export function effectiveEffort(options: ModelOptions | null, model: string, effort: string | null | undefined): string | null {
  if (!effort) return null
  const known = options?.models.find((m) => m.id === model)
  if (!options?.selectableEffort) return options ? null : effort
  if (known && known.effortLevels.length === 0) return null
  return effort
}

const pairOf = (options: ModelOptions | null, model: string | null | undefined, effort: string | null | undefined) =>
  model ? { model, effort: effectiveEffort(options, model, effort) } : null

/** A model's quota pool on a multi-pool adapter (Antigravity), where the default is per pool. */
export function poolOf(options: ModelOptions | null, model: string): string | null {
  if (!options?.pools || options.pools.length < 2) return null
  return options.pools.find((p) => p.models.includes(model))?.id ?? null
}

/** Is this line the account's default? Per pool on a multi-pool adapter. */
export function isDefaultRow(worker: TableWorker, options: ModelOptions | null, row: ModelRoute): boolean {
  const pool = poolOf(options, row.model)
  if (pool) return worker.defaultModels?.[pool] === row.model
  const pair = pairOf(options, worker.defaultModel, worker.defaultEffort)
  return pair !== null && samePair(row, pair)
}

export function isGradingRow(worker: TableWorker, options: ModelOptions | null, row: ModelRoute): boolean {
  const pair = pairOf(options, worker.gradingModel, worker.gradingEffort)
  return pair !== null && samePair(row, pair)
}

export function isJudgmentRow(worker: TableWorker, options: ModelOptions | null, row: ModelRoute): boolean {
  const pair = pairOf(options, worker.judgmentModel, worker.judgmentEffort)
  return pair !== null && samePair(row, pair)
}

export function isSummaryRow(worker: TableWorker, row: ModelRoute): boolean {
  return worker.summarisingModel !== null && worker.summarisingModel === row.model
}

/**
 * Every line of one worker's table, in the order it is drawn and written back.
 *
 * ⛔ **Canonical order: the adapter's model order, then effort strongest first.** The order is
 * load-bearing, because plain Auto takes the first auto line of each model (`autoCandidates`) — so
 * it is the strongest effort ticked, and `Auto (class)` narrows to the class before that. Writing
 * back in the drawn order is what keeps the order on screen and the order the router reads the same.
 *
 * ⚠️ The default, grading, judgment and summary choices always have a line. A choice with no line to tick
 * would be a setting the table could show no trace of, and unticking it would be impossible.
 */
export function modelTableRows(worker: TableWorker, options: ModelOptions | null): ModelTableRow[] {
  const rows: ModelTableRow[] = (worker.modelRoutes ?? []).map((r) => ({ ...r, stored: true }))
  const ensure = (model: string | null | undefined, effort: string | null | undefined): void => {
    const pair = pairOf(options, model, effort)
    if (!pair) return
    if (rows.some((r) => samePair(r, pair))) return
    rows.push({ ...pair, modelClass: null, auto: false, stored: false })
  }
  ensure(worker.defaultModel, worker.defaultEffort)
  for (const model of Object.values(worker.defaultModels ?? {})) ensure(model, null)
  ensure(worker.gradingModel, worker.gradingEffort)
  ensure(worker.judgmentModel, worker.judgmentEffort)
  if (worker.summarisingModel && !rows.some((r) => r.model === worker.summarisingModel)) {
    ensure(worker.summarisingModel, seedEffort(effortLevelsFor(options, worker.summarisingModel), worker.defaultEffort))
  }
  const order = (options?.models ?? []).map((m) => m.id)
  const modelRank = (model: string): number => {
    const i = order.indexOf(model)
    return i < 0 ? order.length : i
  }
  const effortRank = (row: ModelRoute): number => {
    const levels = options?.models.find((m) => m.id === row.model)?.effortLevels ?? []
    // Strongest first; an unset effort sorts after every level.
    return row.effort === null ? Number.MAX_SAFE_INTEGER : -levels.indexOf(row.effort)
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        modelRank(a.row.model) - modelRank(b.row.model) ||
        effortRank(a.row) - effortRank(b.row) ||
        a.index - b.index
    )
    .map((x) => x.row)
}

/**
 * The rows to write back after an edit: every stored line, and any line the edit touched.
 *
 * ⛔ A line drawn only so the model is on screen is not written, so a table nobody has ticked stays
 * `null` in the store — the "inert until opted in" state `routableCandidatesFor` reads.
 */
export function routesToStore(rows: ModelTableRow[]): ModelRoute[] {
  return rows.filter((r) => r.stored).map(({ model, effort, modelClass, auto }) => ({ model, effort, modelClass, auto }))
}
