import { defaultModelClass, MODEL_CLASSES, type ModelClass } from './modelclass.js'

/**
 * One row of a worker's model table: a model, the effort it runs at, the capability class it counts
 * as, and whether Auto Model may pick it (t638).
 *
 * ⭐ **A row is a (model, effort) pair, not a model.** `claude-opus-5-5` at `high` and at `medium`
 * are two different things to route to — different cost, different class — so the same model may
 * appear on several rows. That is what the three per-model maps this replaced (`routableModels`,
 * `modelEfforts`, `modelClasses`, migrations 47/79/80) could not say.
 *
 * ⚠️ `auto: false` is a real row, not a deleted one. It still names a pairing an operator can pick
 * by hand for a task, and it is where a worker's default, grading and judgment choices live when
 * they are not also offered to the router.
 */
export interface ModelRoute {
  model: string
  /** `null` only where the adapter takes no effort flag or the model declares no levels. */
  effort: string | null
  /** `null` means the built-in class (`defaultModelClass`); set once an operator overrides it. */
  modelClass: ModelClass | null
  /** May Auto Model route a task here? Unchecked rows are manual picks only. */
  auto: boolean
}

type RoutesHolder = { modelRoutes?: ModelRoute[] | null } | null | undefined

/** The same pairing, compared the way the table compares rows: model and effort, nothing else. */
export function samePair(a: { model: string | null; effort: string | null }, b: { model: string | null; effort: string | null }): boolean {
  return a.model === b.model && (a.effort ?? null) === (b.effort ?? null)
}

/** The class a row counts as: its override, else the built-in heuristic for its model. */
export function routeClass(route: Pick<ModelRoute, 'model' | 'modelClass'>): ModelClass {
  return route.modelClass ?? defaultModelClass(route.model)
}

/**
 * The class a (model, effort) pair counts as on this worker.
 *
 * ⛔ The exact row first, then any row for the model, then the built-in heuristic. A task pinned to
 * a model with no effort still needs *a* class answer for the class filter, and the operator's own
 * word about that model beats a keyword guess.
 */
export function classOnWorker(worker: RoutesHolder, model: string | null | undefined, effort?: string | null): ModelClass {
  if (!model) return 'med'
  const routes = worker?.modelRoutes ?? []
  const exact = effort !== undefined ? routes.find((r) => samePair(r, { model, effort })) : undefined
  const any = exact ?? routes.find((r) => r.model === model)
  return any ? routeClass(any) : defaultModelClass(model)
}

/** Rows Auto Model may pick, in the operator's order. */
export function autoRoutes(worker: RoutesHolder): ModelRoute[] {
  return (worker?.modelRoutes ?? []).filter((r) => r.auto)
}

type RoutableHolder = {
  modelRoutes?: ModelRoute[] | null
  defaultModel?: string | null
  defaultModels?: Record<string, string | null> | null
} | null | undefined

/**
 * Whether this worker names `model` anywhere it would willingly run it: its model table (auto
 * and manual rows alike), its single default, or one of its per-pool defaults (t675).
 *
 * ⛔ A model a transcript reported is not automatically one of these. A vendor may serve — or a
 * CLI may report — a model the operator never listed: measured 2026-09-24, when sessions spawned
 * for `claude-opus-5-5` reported `claude-opus-4-8` mid-conversation and scoring trusted the
 * recording into the next dispatch. Continuity follows recordings only this far; anything else
 * falls back to what the operator configured.
 */
export function isRoutableModel(
  worker: RoutableHolder,
  model: string | null | undefined
): boolean {
  if (!model) return false
  if ((worker?.modelRoutes ?? []).some((r) => r.model === model)) return true
  if (worker?.defaultModel === model) return true
  return Object.values(worker?.defaultModels ?? {}).includes(model)
}

/**
 * What Auto Model may pick on this worker, one pair per model, optionally narrowed to a class.
 *
 * ⛔ **One pair per model.** Price, speed, fitness and quota are all measured per (adapter, model);
 * two efforts of the same model would score identically and spend a tie-break — or a paid consult —
 * choosing between rows nothing can tell apart. The class filter runs *first*, so `Auto (high)` on
 * a worker listing opus at `medium` (med) and at `high` (high) gets the `high` row, and plain Auto
 * gets whichever the operator listed first.
 *
 * ⚠️ Empty when the worker has no auto rows. The caller falls back to the worker's own default —
 * the same "inert until opted in" rule the allowlist always had.
 */
export function autoCandidates(worker: RoutesHolder, modelClass?: ModelClass | null): Array<{ model: string; effort: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ model: string; effort: string | null }> = []
  for (const r of autoRoutes(worker)) {
    if (modelClass && routeClass(r) !== modelClass) continue
    if (seen.has(r.model)) continue
    seen.add(r.model)
    out.push({ model: r.model, effort: r.effort })
  }
  return out
}

/**
 * The effort a dispatch on `model` inherits from this worker's rows, when neither the task nor the
 * worker's default says.
 *
 * ⚠️ An auto row before a manual one, because that is the pairing the router would have picked.
 */
export function routeEffortFor(worker: RoutesHolder, model: string | null): string | null {
  if (!model) return null
  const routes = (worker?.modelRoutes ?? []).filter((r) => r.model === model && r.effort)
  return (routes.find((r) => r.auto) ?? routes[0])?.effort ?? null
}

/**
 * The rows migrations 47/79/80 stored as three maps, as one list.
 *
 * ⛔ Every routable model becomes an auto row carrying its effort and class; a model that only had
 * an effort or a class (never routable) becomes a manual row, so no setting an operator made is
 * dropped by the move. Also the shape a test uses to say "route to these models".
 */
export function routesFromLegacy(
  routable: string[] | null | undefined,
  efforts?: Record<string, string | null> | null,
  classes?: Record<string, ModelClass> | null
): ModelRoute[] {
  const routes: ModelRoute[] = []
  const add = (model: string, auto: boolean): void => {
    if (routes.some((r) => r.model === model)) return
    const cls = classes?.[model]
    routes.push({
      model,
      effort: efforts?.[model] ?? null,
      modelClass: cls && MODEL_CLASSES.includes(cls) ? cls : null,
      auto
    })
  }
  for (const m of routable ?? []) add(m, true)
  for (const m of Object.keys(efforts ?? {})) if (efforts?.[m]) add(m, false)
  for (const m of Object.keys(classes ?? {})) add(m, false)
  return routes
}

/** How a row reads in one line: `claude-opus-5-5 · high`, or the bare id where there is no effort. */
export function routeLabel(route: Pick<ModelRoute, 'model' | 'effort'>): string {
  return route.effort ? `${route.model} · ${route.effort}` : route.model
}

/** How many models Auto Model can choose between here — one per model, however many efforts are ticked. */
export function autoModelCount(worker: RoutesHolder): number {
  return new Set(autoRoutes(worker).map((r) => r.model)).size
}
