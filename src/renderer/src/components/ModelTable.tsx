import { useState } from 'react'
import type { ModelOptions, OrchestratorPreset, RpcParams, Worker } from '@shared/protocol'
import { modelOffered, notOffered } from '@shared/modelroutes'
import { isLocalModelId, localModelLabel } from '@shared/localmodel'
import { isOrchestratorModelId, makeOrchestratorPresetId } from '@shared/orchestrator'
import { effortLabel, modelLabel } from '../lib/modelname'
import { defaultSelectionPatch, effectiveEffort, effortLevelsFor, seedEffort } from '../lib/modeltable'

/**
 * The line under a worker's default model control in Settings → Workers (t1322).
 *
 * ⭐ Auto-routable models and capability tiers moved to Settings → Auto model, so each worker row
 * here sets only the account's own default model and effort (what Inherit resolves to).
 */
export const MODEL_TABLE_HELP =
  'Sets this account’s default model and effort. Auto-routable models and capability tiers are configured in Settings › Auto model.'

export type WorkerPatch = Omit<RpcParams<'worker.update'>, 'id'>

export function ModelTable({
  worker,
  options,
  busy,
  onPatch
}: {
  worker: Worker
  options: ModelOptions | null
  fleetTags?: readonly string[]
  busy: boolean
  onPatch: (patch: WorkerPatch) => void
}): React.JSX.Element {
  const models = options?.models ?? []
  const pools = options?.pools && options.pools.length >= 2 ? options.pools : null
  const presets = worker.orchestratorPresets ?? []
  const name = (model: string): string => {
    const custom =
      options?.models.find((m) => m.id === model)?.label ??
      presets.find((p) => p.id === model)?.label
    if (custom) return custom
    return isLocalModelId(model) ? localModelLabel(model) : (modelLabel(model) ?? model)
  }

  const baseModels = models.filter((m) => !isOrchestratorModelId(m.id) && modelOffered(worker, m.id))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftPlanner, setDraftPlanner] = useState('')
  const [draftPlannerEffort, setDraftPlannerEffort] = useState<string | null>(null)
  const [draftExecutor, setDraftExecutor] = useState('')
  const [draftExecutorEffort, setDraftExecutorEffort] = useState<string | null>(null)

  const openNewPreset = (): void => {
    const first = baseModels[0]?.id ?? ''
    const second = baseModels[1]?.id ?? first
    setEditingId('new')
    setDraftLabel('')
    setDraftPlanner(first)
    setDraftPlannerEffort(seedEffort(effortLevelsFor(options, first), 'high'))
    setDraftExecutor(second)
    setDraftExecutorEffort(seedEffort(effortLevelsFor(options, second), 'high'))
  }

  const openEditPreset = (preset: OrchestratorPreset): void => {
    setEditingId(preset.id)
    setDraftLabel(preset.label)
    setDraftPlanner(preset.plannerModel)
    setDraftPlannerEffort(effectiveEffort(options, preset.plannerModel, preset.plannerEffort))
    setDraftExecutor(preset.executorModel)
    setDraftExecutorEffort(effectiveEffort(options, preset.executorModel, preset.executorEffort))
  }

  const closeEditor = (): void => {
    setEditingId(null)
  }

  const savePreset = (): void => {
    const label = draftLabel.trim()
    if (!label || !draftPlanner || !draftExecutor) return
    const plannerLevels = effortLevelsFor(options, draftPlanner)
    const executorLevels = effortLevelsFor(options, draftExecutor)
    const entry: OrchestratorPreset = {
      id: editingId === 'new' ? makeOrchestratorPresetId(label, presets.map((p) => p.id)) : editingId!,
      label,
      plannerModel: draftPlanner,
      plannerEffort: plannerLevels.length > 0 ? (draftPlannerEffort ?? seedEffort(plannerLevels, 'high')) : null,
      executorModel: draftExecutor,
      executorEffort: executorLevels.length > 0 ? (draftExecutorEffort ?? seedEffort(executorLevels, 'high')) : null
    }
    const next =
      editingId === 'new' ? [...presets, entry] : presets.map((p) => (p.id === entry.id ? entry : p))
    onPatch({ orchestratorPresets: next })
    setEditingId(null)
  }

  const removePreset = (id: string): void => {
    const next = presets.filter((p) => p.id !== id)
    if (editingId === id) setEditingId(null)
    onPatch({ orchestratorPresets: next.length > 0 ? next : null })
  }

  const plannerLevels = draftPlanner ? effortLevelsFor(options, draftPlanner) : []
  const executorLevels = draftExecutor ? effortLevelsFor(options, draftExecutor) : []

  const currentModel = worker.defaultModel ?? ''
  const levels = currentModel ? effortLevelsFor(options, currentModel) : []
  const currentEffort = currentModel ? (effectiveEffort(options, currentModel, worker.defaultEffort) ?? '') : ''
  const hasStoredUnknown = Boolean(currentModel && !models.some((m) => m.id === currentModel))

  return (
    <div className="worker-models">
      {pools ? (
        <div className="worker-models-pools">
          {pools.map((pool) => {
            const poolModel = worker.defaultModels?.[pool.id] ?? ''
            const poolLevels = poolModel ? effortLevelsFor(options, poolModel) : []
            const poolEffort =
              poolModel && worker.defaultModel === poolModel
                ? (effectiveEffort(options, poolModel, worker.defaultEffort) ?? '')
                : (seedEffort(poolLevels, worker.defaultEffort) ?? '')
            return (
              <div key={pool.id} className="worker-models-default-row">
                <span className="dim">{pool.label}</span>
                <select
                  className="worker-models-select"
                  value={poolModel}
                  disabled={busy}
                  aria-label={`Default ${pool.label} model for ${worker.label}`}
                  onChange={(e) => {
                    const nextModel = e.target.value
                    if (!nextModel) {
                      const nextMap = { ...(worker.defaultModels ?? {}) }
                      delete nextMap[pool.id]
                      onPatch({
                        defaultModels: Object.keys(nextMap).length > 0 ? nextMap : null,
                        ...(worker.defaultModel === poolModel ? { defaultModel: null, defaultEffort: null } : {})
                      })
                      return
                    }
                    const nextEffort = seedEffort(effortLevelsFor(options, nextModel), worker.defaultEffort)
                    onPatch(
                      defaultSelectionPatch(worker, options, {
                        model: nextModel,
                        effort: nextEffort,
                        tags: [],
                        auto: false
                      })
                    )
                  }}
                >
                  <option value="">CLI default</option>
                  {pool.models.map((id) => {
                    const unoffered = !modelOffered(worker, id)
                    return (
                      <option
                        key={id}
                        value={id}
                        disabled={unoffered && id !== poolModel}
                        title={unoffered ? notOffered(worker, id) : undefined}
                      >
                        {name(id)}
                        {unoffered ? ' · not on this plan' : ''}
                      </option>
                    )
                  })}
                </select>
                {poolLevels.length > 0 && (
                  <select
                    className="worker-models-select"
                    value={poolEffort}
                    disabled={busy}
                    aria-label={`Effort for ${poolModel} on ${worker.label}`}
                    onChange={(e) =>
                      onPatch(
                        defaultSelectionPatch(worker, options, {
                          model: poolModel,
                          effort: e.target.value,
                          tags: [],
                          auto: false
                        })
                      )
                    }
                  >
                    {poolLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {effortLabel(lvl) ?? lvl}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="worker-models-default-row">
          <select
            className="worker-models-select"
            value={currentModel}
            disabled={busy || (models.length === 0 && !currentModel)}
            aria-label={`Default model for ${worker.label}`}
            onChange={(e) => {
              const nextModel = e.target.value
              if (!nextModel) {
                onPatch({ defaultModel: null, defaultEffort: null })
                return
              }
              const nextLevels = effortLevelsFor(options, nextModel)
              const nextEffort = nextLevels.length > 0 ? seedEffort(nextLevels, worker.defaultEffort) : null
              onPatch({ defaultModel: nextModel, defaultEffort: nextEffort })
            }}
          >
            <option value="">CLI default</option>
            {hasStoredUnknown && (
              <option value={currentModel}>{name(currentModel)}</option>
            )}
            {models.map((m) => {
              const unoffered = !modelOffered(worker, m.id)
              return (
                <option
                  key={m.id}
                  value={m.id}
                  disabled={unoffered && m.id !== currentModel}
                  title={unoffered ? notOffered(worker, m.id) : undefined}
                >
                  {name(m.id)}
                  {unoffered ? ' · not on this plan' : ''}
                </option>
              )
            })}
          </select>
          {levels.length > 0 && (
            <select
              className="worker-models-select"
              value={currentEffort}
              disabled={busy}
              aria-label={`Effort for ${currentModel} on ${worker.label}`}
              onChange={(e) => onPatch({ defaultModel: currentModel, defaultEffort: e.target.value })}
            >
              {levels.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {effortLabel(lvl) ?? lvl}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {options?.customOrchestrator && (
        <div className="worker-presets">
          <div className="worker-presets-head">
            <span className="dim">Custom orchestrators</span>
            {editingId === null && (
              <button
                type="button"
                className="btn-link"
                disabled={busy || baseModels.length === 0}
                onClick={openNewPreset}
              >
                + Add preset
              </button>
            )}
          </div>
          {presets.length > 0 && (
            <div className="worker-presets-list">
              {presets.map((p) => {
                const plannerText = modelLabel(p.plannerModel, p.plannerEffort) ?? p.plannerModel
                const executorText = modelLabel(p.executorModel, p.executorEffort) ?? p.executorModel
                return (
                  <div key={p.id} className="worker-preset-row">
                    <div className="worker-preset-info" title={`${p.id}\nPlanner: ${p.plannerModel}${p.plannerEffort ? ` (${p.plannerEffort})` : ''}\nExecutor: ${p.executorModel}${p.executorEffort ? ` (${p.executorEffort})` : ''}`}>
                      <span className="worker-preset-name">{p.label}</span>
                      <span className="dim worker-preset-pair">
                        {plannerText} → {executorText}
                      </span>
                    </div>
                    <div className="worker-preset-actions">
                      <button
                        type="button"
                        className="btn-link"
                        disabled={busy}
                        onClick={() => openEditPreset(p)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-link danger-link"
                        disabled={busy}
                        aria-label={`Remove ${p.label}`}
                        onClick={() => removePreset(p.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {editingId !== null && (
            <div className="worker-preset-form">
              <input
                type="text"
                className="worker-preset-input"
                placeholder="Preset name (e.g. Neon + Sonnet)"
                maxLength={80}
                value={draftLabel}
                disabled={busy}
                aria-label="Orchestrator preset name"
                onChange={(e) => setDraftLabel(e.target.value)}
              />
              <div className="worker-preset-role-row">
                <span className="dim worker-preset-role-label">Planner</span>
                <select
                  className="worker-models-select"
                  value={draftPlanner}
                  disabled={busy}
                  aria-label="Planner model"
                  onChange={(e) => {
                    const next = e.target.value
                    setDraftPlanner(next)
                    setDraftPlannerEffort(seedEffort(effortLevelsFor(options, next), draftPlannerEffort ?? 'high'))
                  }}
                >
                  {baseModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelLabel(m.id) ?? m.id}
                    </option>
                  ))}
                </select>
                {plannerLevels.length > 0 && (
                  <select
                    className="worker-models-select"
                    value={draftPlannerEffort ?? ''}
                    disabled={busy}
                    aria-label="Planner effort"
                    onChange={(e) => setDraftPlannerEffort(e.target.value || null)}
                  >
                    {plannerLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {effortLabel(lvl) ?? lvl}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="worker-preset-role-row">
                <span className="dim worker-preset-role-label">Executor</span>
                <select
                  className="worker-models-select"
                  value={draftExecutor}
                  disabled={busy}
                  aria-label="Executor model"
                  onChange={(e) => {
                    const next = e.target.value
                    setDraftExecutor(next)
                    setDraftExecutorEffort(seedEffort(effortLevelsFor(options, next), draftExecutorEffort ?? 'high'))
                  }}
                >
                  {baseModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {modelLabel(m.id) ?? m.id}
                    </option>
                  ))}
                </select>
                {executorLevels.length > 0 && (
                  <select
                    className="worker-models-select"
                    value={draftExecutorEffort ?? ''}
                    disabled={busy}
                    aria-label="Executor effort"
                    onChange={(e) => setDraftExecutorEffort(e.target.value || null)}
                  >
                    {executorLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {effortLabel(lvl) ?? lvl}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="worker-preset-form-actions">
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={busy || !draftLabel.trim() || !draftPlanner || !draftExecutor}
                  onClick={savePreset}
                >
                  {editingId === 'new' ? 'Save preset' : 'Update preset'}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={busy}
                  onClick={closeEditor}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="worker-models-help">{MODEL_TABLE_HELP}</p>
    </div>
  )
}
