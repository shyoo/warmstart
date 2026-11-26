/**
 * Named custom orchestrator presets (planner + executor model/effort pairs, t1451).
 *
 * A preset is stored on a worker whose adapter declares `customOrchestrator: true` and addressed
 * everywhere in Warmstart (default model, Auto Model routes/tiers, task pins, pickers) by its
 * namespaced model ID:
 *
 *   orchestrator:<slug>
 *
 * ⛔ **Never branch on an adapter name.** Adapters opt in by declaring `customOrchestrator: true`
 * and translating `SpawnRequest.orchestratorPreset` into their CLI's own flags.
 */
export const ORCHESTRATOR_PRESET_PREFIX = 'orchestrator:'

export interface OrchestratorPreset {
  /** Stable namespaced model ID (`orchestrator:<slug>`). */
  id: string
  /** Operator-chosen display name shown in pickers and Settings › Workers. */
  label: string
  /** Base model ID for the planner/orchestrator role (e.g. `gemini-4-neon`, `claude-opus-5-5`). */
  plannerModel: string
  /** Planner reasoning effort, or `null` when the planner model declares no effort levels. */
  plannerEffort: string | null
  /** Base model ID for the executor role (e.g. `gemini-4-hydrogen`, `claude-sonnet-5-5`). */
  executorModel: string
  /** Executor reasoning effort, or `null` when the executor model declares no effort levels. */
  executorEffort: string | null
}

/** True when `id` is a custom orchestrator preset ID (`orchestrator:<non-empty-slug>`). */
export function isOrchestratorPresetId(id: string | null | undefined): boolean {
  return (
    typeof id === 'string' &&
    id.startsWith(ORCHESTRATOR_PRESET_PREFIX) &&
    id.length > ORCHESTRATOR_PRESET_PREFIX.length
  )
}

/**
 * True when `id` names any orchestrator model (either a custom preset or a built-in orchestrator
 * slug such as `gemini-pro-orchestrator*`). Used to keep orchestrators out of the Planner and
 * Executor pickers so presets cannot nest recursively.
 */
export function isOrchestratorModelId(id: string | null | undefined): boolean {
  if (!id) return false
  return isOrchestratorPresetId(id) || /(?:^|-)orchestrator(?:$|-)/i.test(id)
}

/** Slugify a human preset name into a safe lowercase identifier segment. */
export function orchestratorPresetSlug(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'custom'
}

/** Mint a unique `orchestrator:<slug>` ID for a new preset. */
export function makeOrchestratorPresetId(label: string, existingIds?: Iterable<string>): string {
  const taken = new Set(existingIds ?? [])
  const base = `${ORCHESTRATOR_PRESET_PREFIX}${orchestratorPresetSlug(label)}`
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Fallback human label when only the preset ID is in hand (e.g. `modelLabel('orchestrator:neon-sonnet')`
 * → `'Orchestrator: Neon Sonnet'`). Pickers with `ModelOptions` prefer `option.label`, which carries
 * the exact operator-typed name.
 */
export function orchestratorPresetLabel(id: string): string {
  const slug = id.startsWith(ORCHESTRATOR_PRESET_PREFIX) ? id.slice(ORCHESTRATOR_PRESET_PREFIX.length) : id
  const words = slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  return words.length > 0 ? `Orchestrator: ${words.join(' ')}` : 'Orchestrator'
}

/**
 * Parse stored presets from JSON safely; malformed entries are skipped rather than crashing boot.
 */
export function readOrchestratorPresets(raw: unknown): OrchestratorPreset[] {
  if (!Array.isArray(raw)) return []
  const out: OrchestratorPreset[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (
      typeof p.id !== 'string' ||
      !isOrchestratorPresetId(p.id) ||
      seen.has(p.id) ||
      typeof p.label !== 'string' ||
      !p.label.trim() ||
      typeof p.plannerModel !== 'string' ||
      !p.plannerModel.trim() ||
      typeof p.executorModel !== 'string' ||
      !p.executorModel.trim()
    ) {
      continue
    }
    seen.add(p.id)
    out.push({
      id: p.id,
      label: p.label.trim(),
      plannerModel: p.plannerModel.trim(),
      plannerEffort: typeof p.plannerEffort === 'string' && p.plannerEffort.trim() ? p.plannerEffort.trim() : null,
      executorModel: p.executorModel.trim(),
      executorEffort: typeof p.executorEffort === 'string' && p.executorEffort.trim() ? p.executorEffort.trim() : null
    })
  }
  return out
}
