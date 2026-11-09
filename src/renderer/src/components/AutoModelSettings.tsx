import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AutoModelTier, AutoModelTierEntry, ModelOptions } from '@shared/protocol'
import { samePair, tiersFromWorkers } from '@shared/modelroutes'
import { MAX_TAG_LENGTH, TIER_PREFIX, asTierTag, cleanTags, tagKey, tierHeading, tierSlug } from '@shared/modeltags'
import { isLocalModelId, localModelLabel } from '@shared/localmodel'
import { errorMessage } from '@shared/errors.js'
import { rpc, type FleetEntry } from '../lib/daemon'
import { effortLabel, modelLabel } from '../lib/modelname'
import { seedEffort } from '../lib/modeltable'

/**
 * Fleet-wide capability tiers for Auto Model routing and delegation (t1322).
 *
 * ⭐ Replaces per-worker Auto-route and Tag matrices with one page where the operator assigns
 * `(model, effort)` pairs to capability tiers (`High tier [tier:high]`, `Med tier [tier:med]`,
 * `Low tier [tier:low]`, or custom tiers).
 *
 * - A task or delegated piece selects **at most one** capability tier (exclusive), optionally
 *   combined with orthogonal feature tags.
 * - A `(model, effort)` pair may belong to **multiple** tiers at once (for example, placing
 *   `Claude Opus 5.5` in both `Med tier` and `Low tier` so either tier can route to it).
 * - Saving writes `settings.autoModelTiers` and syncs `modelRoutes` across every worker whose
 *   adapter offers those models.
 */
export function AutoModelSettings({
  fleet,
  refresh
}: {
  fleet: FleetEntry[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [storedTiers, setStoredTiers] = useState<AutoModelTier[] | null>(null)
  const [options, setOptions] = useState<ModelOptions[]>([])
  const [drafts, setDrafts] = useState<Record<string, { model: string; effort: string | null }>>({})
  const [newTierName, setNewTierName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [settings, baseOpts] = await Promise.all([rpc('settings.get'), rpc('model.options')])
      setStoredTiers(settings.autoModelTiers ?? null)
      setOptions(baseOpts)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const tiers = useMemo<AutoModelTier[]>(
    () => storedTiers ?? tiersFromWorkers(fleet.map((f) => f.worker)),
    [storedTiers, fleet]
  )

  const catalog = useMemo(() => {
    const seen = new Map<string, { id: string; effortLevels: string[] }>()
    for (const opt of options) {
      for (const m of opt.models) {
        if (!seen.has(m.id)) {
          seen.set(m.id, {
            id: m.id,
            effortLevels: opt.selectableEffort ? m.effortLevels : []
          })
        }
      }
    }
    return [...seen.values()]
  }, [options])

  const nameOf = (model: string): string =>
    isLocalModelId(model) ? localModelLabel(model) : (modelLabel(model) ?? model)

  const entryChipLabel = (entry: AutoModelTierEntry): string => {
    const base = nameOf(entry.model)
    if (!entry.effort) return base
    return `${base} ${effortLabel(entry.effort) ?? entry.effort}`
  }

  const levelsFor = useCallback(
    (modelId: string): string[] => catalog.find((m) => m.id === modelId)?.effortLevels ?? [],
    [catalog]
  )

  const draftFor = (tierTag: string): { model: string; effort: string | null } => {
    const key = tagKey(tierTag)
    const existing = drafts[key]
    if (existing && catalog.some((m) => m.id === existing.model)) return existing
    const firstModel = catalog[0]?.id ?? ''
    const levels = levelsFor(firstModel)
    const hintEffort =
      key === 'high' && levels.includes('high')
        ? 'high'
        : key === 'low' && levels.includes('low')
          ? 'low'
          : seedEffort(levels, null)
    return { model: firstModel, effort: hintEffort }
  }

  const saveTiers = async (next: AutoModelTier[]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const updated = await rpc('settings.set', { autoModelTiers: next })
      setStoredTiers(updated.autoModelTiers ?? next)
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const addEntry = (tierTag: string): void => {
    const draft = draftFor(tierTag)
    if (!draft.model) return
    const key = tagKey(tierTag)
    const next = tiers.map((tier) => {
      if (tagKey(tier.tag) !== key) return tier
      if (tier.entries.some((e) => samePair(e, draft))) return tier
      return { ...tier, entries: [...tier.entries, { model: draft.model, effort: draft.effort }] }
    })
    void saveTiers(next)
  }

  const removeEntry = (tierTag: string, index: number): void => {
    const key = tagKey(tierTag)
    const next = tiers.map((tier) =>
      tagKey(tier.tag) === key
        ? { ...tier, entries: tier.entries.filter((_, i) => i !== index) }
        : tier
    )
    void saveTiers(next)
  }

  const removeTier = (tierTag: string): void => {
    const key = tagKey(tierTag)
    void saveTiers(tiers.filter((t) => tagKey(t.tag) !== key))
  }

  const addTier = (): void => {
    const [cleaned] = cleanTags([newTierName])
    if (!cleaned) return
    const tag = asTierTag(cleaned)
    if (!tag || tag.length > MAX_TAG_LENGTH) return
    setNewTierName('')
    if (tiers.some((t) => tagKey(t.tag) === tagKey(tag))) return
    void saveTiers([...tiers, { tag, entries: [] }])
  }

  return (
    <div className="panel auto-model-settings">
      <header className="panel-head">
        <div>
          <h2>Auto model</h2>
          <p className="panel-sub">
            Assign models and efforts to capability tiers across the fleet. Tasks and delegated pieces pick at
            most one tier (such as <code>[tier:high]</code>, <code>[tier:med]</code>, or <code>[tier:low]</code>),
            while the same model may be placed in multiple tiers.
          </p>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="stack">
        {tiers.length === 0 ? (
          <div className="empty-inline">
            <p>No capability tiers configured.</p>
            <p className="dim">Add a tier below to group models for Auto Model routing and delegation.</p>
          </div>
        ) : (
          tiers.map((tier) => {
            const heading = tierHeading(tier.tag)
            const slug = tierSlug(tier.tag)
            const draft = draftFor(tier.tag)
            const draftLevels = levelsFor(draft.model)
            const alreadyInTier = Boolean(draft.model && tier.entries.some((e) => samePair(e, draft)))
            return (
              <section
                key={tagKey(tier.tag)}
                className="panel auto-model-tier"
                aria-label={heading}
                data-tier={slug}
              >
                <header className="panel-head">
                  <div>
                    <h3>
                      {heading} <span className="dim mono">[{slug}]</span>
                    </h3>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy}
                    aria-label={`Remove ${heading}`}
                    title={`Remove ${heading} ([${slug}])`}
                    onClick={() => removeTier(tier.tag)}
                  >
                    Remove tier
                  </button>
                </header>

                <div className="auto-model-tier-entries">
                  {tier.entries.length === 0 ? (
                    <span className="dim">No models in this tier yet.</span>
                  ) : (
                    <span className="tag-chips auto-model-chips">
                      {tier.entries.map((entry, idx) => {
                        const label = entryChipLabel(entry)
                        return (
                          <span
                            key={`${entry.model}:${entry.effort ?? ''}`}
                            className="tag-chip auto-model-chip"
                            data-model={entry.model}
                            data-effort={entry.effort ?? ''}
                          >
                            <span>({label})</span>
                            <button
                              type="button"
                              className="tag-picker-remove"
                              disabled={busy}
                              aria-label={`Remove ${label} from ${heading}`}
                              title={`Remove ${label} from ${heading}`}
                              onClick={() => removeEntry(tier.tag, idx)}
                            >
                              ×
                            </button>
                          </span>
                        )
                      })}
                    </span>
                  )}
                </div>

                {catalog.length > 0 && (
                  <div className="worker-models-add auto-model-tier-add">
                    <select
                      className="worker-models-select"
                      value={draft.model}
                      disabled={busy}
                      aria-label={`Model to add to ${heading}`}
                      onChange={(e) => {
                        const nextModel = e.target.value
                        const nextLevels = levelsFor(nextModel)
                        setDrafts((prev) => ({
                          ...prev,
                          [tagKey(tier.tag)]: {
                            model: nextModel,
                            effort: seedEffort(nextLevels, draft.effort)
                          }
                        }))
                      }}
                    >
                      {catalog.map((m) => (
                        <option key={m.id} value={m.id}>
                          {nameOf(m.id)}
                        </option>
                      ))}
                    </select>
                    {draftLevels.length > 0 && (
                      <select
                        className="worker-models-select"
                        value={draft.effort ?? ''}
                        disabled={busy}
                        aria-label={`Effort to add to ${heading}`}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [tagKey(tier.tag)]: { ...draft, effort: e.target.value }
                          }))
                        }
                      >
                        {draftLevels.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {effortLabel(lvl) ?? lvl}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !draft.model || alreadyInTier}
                      aria-label={`Add model to ${heading}`}
                      title={alreadyInTier ? 'Already in this tier' : `Add to ${heading}`}
                      onClick={() => addEntry(tier.tag)}
                    >
                      + Add model
                    </button>
                  </div>
                )}
              </section>
            )
          })
        )}

        <form
          className="worker-models-add auto-model-add-tier"
          onSubmit={(e) => {
            e.preventDefault()
            addTier()
          }}
        >
          <input
            type="text"
            className="tag-picker-input"
            value={newTierName}
            maxLength={MAX_TAG_LENGTH - TIER_PREFIX.length}
            disabled={busy}
            placeholder="New tier name (e.g. Ultra)"
            aria-label="New tier name"
            onChange={(e) => setNewTierName(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || cleanTags([newTierName]).length === 0}
          >
            + Add tier
          </button>
        </form>
      </div>
    </div>
  )
}
