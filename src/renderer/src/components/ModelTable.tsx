import { useState } from 'react'
import type { ModelOptions, RpcParams, Worker } from '@shared/protocol'
import { MODEL_CLASS_LABELS, MODEL_CLASSES, type ModelClass } from '@shared/modelclass'
import { routeClass, routeLabel, samePair } from '@shared/modelroutes'
import { isLocalModelId, localModelLabel } from '@shared/localmodel'
import { effortLabel, modelLabel } from '../lib/modelname'
import {
  effortLevelsFor,
  isDefaultRow,
  isGradingRow,
  isJudgmentRow,
  isSummaryRow,
  modelTableRows,
  poolOf,
  routesToStore,
  seedEffort,
  type ModelTableRow
} from '../lib/modeltable'

/**
 * The line under a worker's model table — what the tick columns mean, said once.
 *
 * ⛔ **Auto-route is opt-in, and inert until ticked.** A table with nothing ticked is not a gap in
 * the fleet's model-aware routing — it is the honest default, because widening every worker to
 * every model it can price would hand a scorer dozens of candidates a tick that nobody chose.
 * ⚠️ It names the one-per-model rule, because two ticked efforts of one model do not both compete:
 * the router takes the first (strongest) of them, and a class-scoped Auto picks within its class first.
 */
export const MODEL_TABLE_HELP =
  'Sets Auto Model and purpose models (grading, judgment, summaries). You can still choose a model and effort on each task.'

const LABEL_HELP =
  'A user-defined capability label. When filing with Auto Model, choose a label to refine its model selection.'

export type WorkerPatch = Omit<RpcParams<'worker.update'>, 'id'>

/**
 * One worker's models as a table: a line per (model, effort), and a tick for each thing it does
 * (t638). Replaces the default-model, routable-models and grading-model pickers, which were three
 * menus over one question — *what runs where on this account*.
 *
 * ⛔ **Default, Grading and Judgment are one line each; Auto-route is any number.** Default is a
 * radio choice (one per quota pool); a line holding a purpose cannot be removed because the setting
 * would survive with no line to show it.
 *
 * ⚠️ Every edit to a line sends the whole table back (`routesToStore`), in the order it is drawn.
 * That order is the router's order — see `modelTableRows`.
 */
export function ModelTable({
  worker,
  options,
  busy,
  onPatch
}: {
  worker: Worker
  options: ModelOptions | null
  busy: boolean
  onPatch: (patch: WorkerPatch) => void
}): React.JSX.Element {
  const rows = modelTableRows(worker, options)
  const [adding, setAdding] = useState<{ model: string; effort: string | null } | null>(null)

  const write = (next: ModelTableRow[], extra: WorkerPatch = {}): void => {
    const routes = routesToStore(next)
    onPatch({ modelRoutes: routes.length > 0 ? routes : null, ...extra })
  }
  const withRow = (index: number, change: Partial<ModelTableRow>): ModelTableRow[] =>
    rows.map((r, i) => (i === index ? { ...r, ...change, stored: true } : r))
  const name = (model: string): string =>
    isLocalModelId(model) ? localModelLabel(model) : (modelLabel(model) ?? model)

  // ⚠️ The three single-line ticks write only their own fields, never the table: the line they point
  // at is always drawn (`modelTableRows` ensures it), so ticking Default on a line nobody stored does
  // not turn an untouched table into a stored one — which would switch model-aware scoring on.
  const setDefault = (index: number): void => {
    const r = rows[index]!
    const pool = poolOf(options, r.model)
    if (pool) {
      onPatch({ defaultModels: { ...(worker.defaultModels ?? {}), [pool]: r.model } })
    } else {
      onPatch({ defaultModel: r.model, defaultEffort: r.effort })
    }
  }
  const toggleGrading = (index: number): void => {
    const r = rows[index]!
    const on = isGradingRow(worker, options, r)
    onPatch(on ? { gradingModel: null, gradingEffort: null } : { gradingModel: r.model, gradingEffort: r.effort })
  }
  const toggleJudgment = (index: number): void => {
    const r = rows[index]!
    const on = isJudgmentRow(worker, options, r)
    onPatch(on ? { judgmentModel: null, judgmentEffort: null } : { judgmentModel: r.model, judgmentEffort: r.effort })
  }
  const toggleSummary = (index: number): void => {
    const r = rows[index]!
    const on = isSummaryRow(worker, r)
    onPatch(on ? { summarisingModel: null } : { summarisingModel: r.model })
  }
  // ⛔ A line's effort is the effort of whatever it is ticked for, so the choice moves with it — the
  // Default tick does not stay behind on a (model, effort) pair that no longer has a line.
  const setEffort = (index: number, effort: string): void => {
    const r = rows[index]!
    const extra: WorkerPatch = {}
    if (isDefaultRow(worker, options, r) && !poolOf(options, r.model)) {
      Object.assign(extra, { defaultModel: r.model, defaultEffort: effort })
    }
    if (isGradingRow(worker, options, r)) Object.assign(extra, { gradingModel: r.model, gradingEffort: effort })
    if (isJudgmentRow(worker, options, r)) Object.assign(extra, { judgmentModel: r.model, judgmentEffort: effort })
    write(withRow(index, { effort }), extra)
  }

  const models = options?.models ?? []
  const addLevels = adding ? effortLevelsFor(options, adding.model) : []
  const addTaken = adding ? rows.some((r) => samePair(r, adding)) : false
  const startAdding = (model: string): void =>
    setAdding({ model, effort: seedEffort(effortLevelsFor(options, model), worker.defaultEffort) })

  return (
    <div className="worker-models">
      <div className="worker-models-scroll">
        <table className="worker-models-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Effort</th>
              <th title={LABEL_HELP}>Label</th>
              <th className="worker-models-tick">Default</th>
              <th className="worker-models-tick">Auto-route</th>
              <th className="worker-models-tick">Grading</th>
              <th className="worker-models-tick">Judgment</th>
              <th className="worker-models-tick">Summary</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, index) => {
              const levels = effortLevelsFor(options, r.model)
              const isDefault = isDefaultRow(worker, options, r)
              const isGrading = isGradingRow(worker, options, r)
              const isJudgment = isJudgmentRow(worker, options, r)
              const isSummary = isSummaryRow(worker, r)
              const inUse = isDefault || isGrading || isJudgment || isSummary
              const label = routeLabel(r)
              return (
                <tr
                  key={`${r.model}:${r.effort ?? ''}`}
                  className={`worker-models-row${r.stored || inUse ? '' : ' worker-models-row--idle'}`}
                >
                  <td className="worker-models-name" title={r.model}>
                    {name(r.model)}
                  </td>
                  <td>
                    {levels.length > 0 ? (
                      <select
                        className="worker-models-select"
                        value={r.effort ?? ''}
                        disabled={busy}
                        aria-label={`Effort for ${label} on ${worker.label}`}
                        onChange={(e) => setEffort(index, e.target.value)}
                      >
                        {/* ⚠️ Only while unset, and never choosable back: a line written before
                            efforts were per line says so rather than pretending to a level. */}
                        {r.effort === null && (
                          <option value="" disabled>
                            not set
                          </option>
                        )}
                        {levels.map((lvl) => (
                          <option
                            key={lvl}
                            value={lvl}
                            disabled={lvl !== r.effort && rows.some((o) => samePair(o, { model: r.model, effort: lvl }))}
                          >
                            {effortLabel(lvl) ?? lvl}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="dim" title="This model, or this CLI, takes no effort setting">
                        n/a
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      className="worker-models-select"
                      value={routeClass(r)}
                      disabled={busy}
                      aria-label={`Label for ${label} on ${worker.label}`}
                      title={LABEL_HELP}
                      onChange={(e) => write(withRow(index, { modelClass: e.target.value as ModelClass }))}
                    >
                      {MODEL_CLASSES.map((cls) => (
                        <option key={cls} value={cls}>
                          {MODEL_CLASS_LABELS[cls]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="worker-models-tick">
                    <input
                      type="radio"
                      name={`default:${worker.id}:${poolOf(options, r.model) ?? 'worker'}`}
                      checked={isDefault}
                      disabled={busy}
                      aria-label={`Default: ${label} on ${worker.label}`}
                      title={
                        poolOf(options, r.model)
                          ? "The one default for this model's quota pool"
                          : 'What tasks on this account run on unless they choose their own model.'
                      }
                      onChange={() => setDefault(index)}
                    />
                  </td>
                  <td className="worker-models-tick">
                    <input
                      type="checkbox"
                      checked={r.auto}
                      disabled={busy}
                      aria-label={`Auto-route: ${label} on ${worker.label}`}
                      onChange={() => write(withRow(index, { auto: !r.auto }))}
                    />
                  </td>
                  <td className="worker-models-tick">
                    <input
                      type="checkbox"
                      checked={isGrading}
                      disabled={busy}
                      aria-label={`Grading: ${label} on ${worker.label}`}
                      onChange={() => toggleGrading(index)}
                    />
                  </td>
                  <td className="worker-models-tick">
                    <input
                      type="checkbox"
                      checked={isJudgment}
                      disabled={busy}
                      aria-label={`Judgment: ${label} on ${worker.label}`}
                      onChange={() => toggleJudgment(index)}
                    />
                  </td>
                  <td className="worker-models-tick">
                    <input
                      type="checkbox"
                      checked={isSummary}
                      disabled={busy}
                      aria-label={`Summary: ${label} on ${worker.label}`}
                      title="The model this account uses for optional, asynchronous task-title summaries. Untick to leave this worker out."
                      onChange={() => toggleSummary(index)}
                    />
                  </td>
                  <td className="worker-models-remove">
                    <button
                      type="button"
                      className="worker-models-remove-btn"
                      disabled={busy || inUse}
                      aria-label={`Remove ${label} from ${worker.label}`}
                      title={
                        inUse
                          ? 'Cannot remove: in use as the default, grading, judgment or summary model'
                          : 'Remove this line'
                      }
                      onClick={() => write(rows.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="worker-models-foot">
        {adding ? (
          <div className="worker-models-add">
            <select
              className="worker-models-select"
              value={adding.model}
              aria-label={`Model to add to ${worker.label}`}
              onChange={(e) => startAdding(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m.id)}
                </option>
              ))}
            </select>
            {addLevels.length > 0 && (
              <select
                className="worker-models-select"
                value={adding.effort ?? ''}
                aria-label={`Effort to add to ${worker.label}`}
                onChange={(e) => setAdding({ ...adding, effort: e.target.value })}
              >
                {addLevels.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {effortLabel(lvl) ?? lvl}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || addTaken}
              title={addTaken ? 'That model and effort already has a line' : undefined}
              onClick={() => {
                write([...rows, { ...adding, modelClass: null, auto: false, stored: true }])
                setAdding(null)
              }}
            >
              Add
            </button>
            <button type="button" className="btn" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn worker-models-add-btn"
            disabled={busy || models.length === 0}
            onClick={() => startAdding(models[0]!.id)}
          >
            + Add model/effort
          </button>
        )}
        <p className="worker-models-help">{MODEL_TABLE_HELP}</p>
      </div>
    </div>
  )
}
