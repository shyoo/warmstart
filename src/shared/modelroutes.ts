import { defaultModelClass, MODEL_CLASSES, type ModelClass } from './modelclass.js'
import { classTag, cleanTags, hasAllTags, inferredTags } from './modeltags.js'

/**
 * One row of a worker's model table: a model, the effort it runs at, the tags the operator put on
 * that pair, and whether Auto Model may pick it (t638; tags t1042).
 *
 * ⭐ **A row is a (model, effort) pair, not a model.** `claude-opus-5-5` at `high` and at `medium`
 * are two different things to route to — different cost, different tags — so the same model may
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
  /**
   * Operator-maintained routing assertions about *this pair* (`modeltags.ts`): Low, Med, High, ZDR,
   * Audio, anything. A task requiring tags needs all of them here. Empty is valid — plain Auto Model
   * may still pick the row — but satisfies no tagged request.
   *
   * ⚠️ Tags belong to the pair, never to the model: `opus · high` may carry `Audio` while
   * `opus · medium` does not.
   */
  tags: string[]
  /** May Auto Model route a task here? Unchecked rows are manual picks only. */
  auto: boolean
}

/**
 * Stored rows as this build reads them, whatever build wrote them.
 *
 * ⛔ **A row written before tags carried `modelClass` and no `tags`** (migration 90 rewrites them,
 * and this is the same rule for anything that slipped past it — a settings file, an old backup, a
 * test fixture). Its *effective* class becomes its one tag: the override, else the built-in for its
 * model. A row that already has `tags` keeps exactly those, even an empty list. Malformed rows are
 * dropped rather than crashing a start.
 */
export function readRoutes(raw: unknown): ModelRoute[] {
  if (!Array.isArray(raw)) return []
  const out: ModelRoute[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const row = r as { model?: unknown; effort?: unknown; tags?: unknown; modelClass?: unknown; auto?: unknown }
    if (typeof row.model !== 'string' || !row.model) continue
    const legacy = MODEL_CLASSES.find((c) => c === row.modelClass)
    out.push({
      model: row.model,
      effort: typeof row.effort === 'string' ? row.effort : null,
      tags: Array.isArray(row.tags) ? cleanTags(row.tags) : [classTag(legacy ?? defaultModelClass(row.model))],
      auto: row.auto === true
    })
  }
  return out
}

/**
 * What an account's own plan offers, where its CLI said (`WorkerIdentity.availableModels`).
 *
 * ⛔ `null`/absent is *unknown*, never *none*: a worker whose CLI never listed its models offers
 * everything the cost model can price, exactly as before this existed. A list is a **subset** of the
 * adapter's catalogue — a model the cost model prices may still be one this plan cannot run (Codex on
 * a free ChatGPT account answers `400 The 'gpt-6-sol' model is not supported when using Codex with a
 * ChatGPT account`, measured t866).
 */
type OfferHolder = { identity?: { availableModels?: string[] | null } | null } | null | undefined

type RoutesHolder = ({ modelRoutes?: ModelRoute[] | null } & OfferHolder) | null | undefined

/** Does this worker's plan offer `model`? True wherever the account never said what it offers. */
export function modelOffered(worker: OfferHolder, model: string | null | undefined): boolean {
  const offered = worker?.identity?.availableModels
  if (!model || !offered || offered.length === 0) return true
  return offered.includes(model)
}

/** The same pairing, compared the way the table compares rows: model and effort, nothing else. */
export function samePair(a: { model: string | null; effort: string | null }, b: { model: string | null; effort: string | null }): boolean {
  return a.model === b.model && (a.effort ?? null) === (b.effort ?? null)
}

/**
 * The tags a (model, effort) pair carries on this worker.
 *
 * ⛔ The exact row first, then any row for the model, then the model's built-in class as its one tag.
 * A task pinned to a model with no effort still needs *an* answer for the tag filter, and the
 * operator's own word about that model beats a keyword guess. ⚠️ A pair with **no row** carries only
 * what the built-in class says — never a custom tag, which nobody asserted.
 */
export function tagsOnWorker(worker: RoutesHolder, model: string | null | undefined, effort?: string | null): string[] {
  if (!model) return inferredTags(model)
  const routes = worker?.modelRoutes ?? []
  const exact = effort !== undefined ? routes.find((r) => samePair(r, { model, effort })) : undefined
  const any = exact ?? routes.find((r) => r.model === model)
  return any ? any.tags : inferredTags(model)
}

/**
 * The pair a candidate named by model alone runs as under `tags` here, or null if none does.
 *
 * ⛔ **Never `tagsOnWorker(worker, model)` with the effort left out** (t697 ← t691, 2026-09-25).
 * That answers with the model's *first* row, so a worker listing `muse-spark · xhigh` (High) above
 * `muse-spark · medium` (Med) read as having nothing in `Med`. t691's retry resumed a session that
 * had run at `medium` and held for ever on *"MuseFirst: no routable models in 'med' class"*.
 *
 * ⭐ `preferredEffort` is the effort the candidate already carries — a resumed session's own — and
 * wins when its row has every tag. Otherwise any row of the model with every tag answers, an auto
 * row before a manual one, and its effort is carried so the dispatch runs the pair that matched.
 * ⛔ Never a row that is merely *the same model*: another effort's tags do not make this pair match.
 * A model with no row at all falls back to its built-in class tag, as `tagsOnWorker` does.
 */
export function pairWithTags(
  worker: RoutesHolder,
  model: string | null | undefined,
  preferredEffort: string | null | undefined,
  tags: readonly string[]
): { model: string; effort: string | null } | null {
  if (!model) return null
  const rows = (worker?.modelRoutes ?? []).filter((r) => r.model === model)
  if (rows.length === 0) {
    return hasAllTags(inferredTags(model), tags) ? { model, effort: preferredEffort ?? null } : null
  }
  const matching = rows.filter((r) => hasAllTags(r.tags, tags))
  const row =
    (preferredEffort ? matching.find((r) => r.effort === preferredEffort) : undefined) ??
    matching.find((r) => r.auto) ??
    matching[0]
  return row ? { model, effort: row.effort } : null
}

/**
 * The effort `model` runs at when the task asked for Auto Model with `tags`.
 *
 * ⛔ **The tags name a (model, effort) row, so they own the effort too** (t811, 2026-09-28). t809
 * and t810 were filed `Auto Model (med)` on a worker whose `med` row is `claude-opus-5-5 · medium`,
 * with a stale `effort: high` the composer no longer showed. Scoring picked the `med` row and the
 * dispatch then ran the task's own effort over it, so both ran Opus at `high` — the `high` class
 * the operator had not asked for.
 *
 * ⭐ A task effort survives only where its own row has every tag (`pairWithTags` prefers it); any
 * other is replaced by the matching row's effort. With no tags, or no row matching, the effort passes
 * through unchanged: scoring has already held a task with nothing matching.
 */
export function tagBoundEffort(
  worker: RoutesHolder,
  model: string | null | undefined,
  effort: string | null,
  tags: readonly string[] | null | undefined
): string | null {
  if (!tags || tags.length === 0 || !model) return effort
  return pairWithTags(worker, model, effort, tags)?.effort ?? effort
}

/** Why a model is refused on an account whose plan does not list it — the daemon's one wording. */
export function notOffered(
  worker: { label: string; identity?: { subscriptionType?: string | null; availableModels?: string[] | null } | null },
  model: string
): string {
  const plan = worker.identity?.subscriptionType
  return (
    `${worker.label}${plan ? ` (${plan} plan)` : ''} does not offer '${model}' — its CLI lists only ` +
    `${(worker.identity?.availableModels ?? []).join(', ')}`
  )
}

/**
 * Rows Auto Model may pick, in the operator's order.
 *
 * ⛔ A ticked row for a model the account's plan does not offer is not routable: the tick is the
 * operator's stored setting and stays, but the router skips it (`modelOffered`).
 */
export function autoRoutes(worker: RoutesHolder): ModelRoute[] {
  return (worker?.modelRoutes ?? []).filter((r) => r.auto && modelOffered(worker, r.model))
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
 * What Auto Model may pick on this worker, one pair per model, optionally narrowed to tags.
 *
 * ⛔ **One pair per model, and the filter runs first.** Price, speed, fitness and quota are all
 * measured per (adapter, model); two efforts of the same model would score identically and spend a
 * tie-break — or a paid consult — choosing between rows nothing can tell apart. Filtering *before*
 * the reduction is what makes `Auto (Audio)` on a worker listing opus at `medium` (no tag) and at
 * `high` (Audio) get the `high` row: reduce first and the model's first row would be tested, found
 * wanting, and the model lost. Plain Auto gets whichever the operator listed first.
 *
 * ⚠️ Empty when the worker has no auto rows. The caller falls back to the worker's own default —
 * the same "inert until opted in" rule the allowlist always had.
 */
export function autoCandidates(worker: RoutesHolder, tags?: readonly string[] | null): Array<{ model: string; effort: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ model: string; effort: string | null }> = []
  for (const r of autoRoutes(worker)) {
    if (!hasAllTags(r.tags, tags)) continue
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
 * ⛔ Every routable model becomes an auto row carrying its effort and its class as a tag; a model
 * that only had an effort or a class (never routable) becomes a manual row, so no setting an
 * operator made is dropped by the move. Also the shape a test uses to say "route to these models".
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
      tags: [classTag(cls && MODEL_CLASSES.includes(cls) ? cls : defaultModelClass(model))],
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

type DefaultPairHolder = ({ modelRoutes?: ModelRoute[] | null; defaultEffort?: string | null } & OfferHolder) | null | undefined

/**
 * Every tag this worker can honour for Auto Model: those on its auto-routable rows, or — with no
 * auto rows — those its default pair carries.
 *
 * ⚠️ One tag alone is not a promise: a task asking for `High + Audio` needs both on **one** pair
 * (`tagsRoutable`). This is the list a picker offers, not a verdict.
 */
export function routableTags(worker: DefaultPairHolder, inheritedModel: string | null): string[] {
  if (!worker) return []
  const routes = autoRoutes(worker)
  if (routes.length > 0) return cleanTags(routes.flatMap((r) => r.tags))
  return inheritedModel ? cleanTags(tagsOnWorker(worker, inheritedModel, worker.defaultEffort)) : []
}

/**
 * Could this worker take a task asking for Auto Model with `tags`, right now, by its table?
 *
 * ⛔ The same test `routableCandidatesFor` makes in the daemon, kept here so the picker that warns
 * and the door that refuses read one rule: auto rows if there are any, else the default *pair*. An
 * empty requirement is always routable. ⚠️ A table fact, not a quota one — a spent account still
 * files the task and holds it, so the tag stays selectable.
 */
export function tagsRoutable(worker: DefaultPairHolder, tags: readonly string[], inheritedModel: string | null): boolean {
  if (tags.length === 0) return true
  if (!worker) return false
  if (autoRoutes(worker).length > 0) return autoCandidates(worker, tags).length > 0
  return !!inheritedModel && hasAllTags(tagsOnWorker(worker, inheritedModel, worker.defaultEffort), tags)
}
