import type { ModelOptions, RpcParams, Worker } from '@shared/protocol'
import { modelOffered, notOffered } from '@shared/modelroutes'
import { isLocalModelId, localModelLabel } from '@shared/localmodel'
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
  const name = (model: string): string =>
    isLocalModelId(model) ? localModelLabel(model) : (modelLabel(model) ?? model)

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
      <p className="worker-models-help">{MODEL_TABLE_HELP}</p>
    </div>
  )
}
