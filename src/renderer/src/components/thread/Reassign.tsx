/**
 * The worker / model / effort a task's next run asks for, chosen from pills under the composer.
 *
 * ⛔ **One choice, read by two controls.** The composer's primary button turns into *Reassign* the
 * moment this differs from what the task is pinned to, and the settle strip's *Resolve & retry*
 * hands a landing repair to the same selection. Two private copies of these three selectors is what
 * the old card had — one on the quota card, one on the decision card — and a pick in one was not a
 * pick in the other (t669).
 */
import { canWork, type ModelOptions } from '@shared/protocol'
import { resolveModelChoice, type ModelClass, type Task } from '@shared/tasks'
import { useEffect, useState } from 'react'
import { rpc, type FleetEntry } from '../../lib/daemon'
import { effortLabel, modelLabel } from '../../lib/modelname'
import { effortLookupModel, reassignmentModel } from '../../lib/taskview'
import { PillSelect, type PillOption } from '../Pill'

export function initialSelectedModel(
  model?: string,
  modelPolicy?: 'auto' | 'inherit',
  modelClass?: ModelClass
): string {
  if (model) return model
  if (modelPolicy === 'auto') {
    return modelClass ? `__auto__:${modelClass}` : '__auto__'
  }
  return ''
}

const AUTO_MODEL_LABELS: Record<string, string> = {
  __auto__: 'Auto Model',
  '__auto__:high': 'Auto Model (high)',
  '__auto__:med': 'Auto Model (med)',
  '__auto__:low': 'Auto Model (low)'
}

export interface ReassignChoice {
  workerId: string
  model: string
  effort: string
  /** The selection differs from what the task is pinned to now. */
  changed: boolean
  setWorker: (workerId: string) => void
  setModel: (model: string) => void
  setEffort: (effort: string) => void
  reset: () => void
  /** Writes the selection as the task's pin, in one RPC. Does not start a run. */
  apply: () => Promise<void>
  workerOptions: PillOption[]
  modelOptions: PillOption[]
  effortOptions: PillOption[]
  workerLabel: string
  modelLabel: string
  effortLabel: string
}

export function useReassignChoice(task: Task, fleet: FleetEntry[], options: ModelOptions[]): ReassignChoice {
  const c = task.constraints
  const pinnedModel = initialSelectedModel(c.model, c.modelPolicy, c.modelClass)
  const [workerId, setWorkerId] = useState<string>(c.workerId ?? '')
  const [model, setModel] = useState<string>(pinnedModel)
  const [effort, setEffort] = useState<string>(c.effort ?? '')

  const reset = (): void => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setEffort(c.effort ?? '')
  }
  // ⚠️ The pin moved underneath (a write from here, another window, the scheduler): follow it.
  useEffect(() => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setEffort(c.effort ?? '')
  }, [c.workerId, pinnedModel, c.effort])

  const entry = fleet.find((e) => e.worker.id === workerId) ?? null
  const worker = entry?.worker ?? null
  const adapter = options.find((o) => o.adapterId === worker?.adapterId)
  const offeredModels = adapter?.models ?? []
  const canSetEffort = adapter?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, worker, canSetEffort, entry?.quota).model
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === effortLookupModel(model, inheritedModel))?.effortLevels ?? [])
    : []

  const changed = workerId !== (c.workerId ?? '') || model !== pinnedModel || effort !== (c.effort ?? '')

  const pickWorker = (next: string): void => {
    setWorkerId(next)
    if (!next) {
      setModel('')
      setEffort('')
      return
    }
    const w = fleet.find((e) => e.worker.id === next)?.worker
    const offered = options.find((o) => o.adapterId === w?.adapterId)?.models ?? []
    if (model && !model.startsWith('__auto__') && model !== '__inherit__' && !offered.some((m) => m.id === model)) {
      setModel(reassignmentModel(model, offered))
      setEffort('')
    }
  }

  const apply = async (): Promise<void> => {
    const isAuto = model.startsWith('__auto__')
    const modelPolicy = isAuto ? 'auto' : !model || model === '__inherit__' ? 'inherit' : null
    const modelClass = isAuto && model.includes(':') ? (model.split(':')[1] as ModelClass) : null
    const pinned = isAuto || model === '__inherit__' ? null : model || null
    // ⛔ One write. The scheduler can dispatch after the worker write, so a following model write
    // is too late — it was how an explicit Opus reassignment resumed on the account's Haiku default.
    await rpc('task.setWorker', {
      id: task.id,
      workerId: workerId || null,
      ...(workerId ? { model: pinned, modelPolicy, modelClass, effort: effort || null } : {})
    })
  }

  const inheritedLabel = inheritedModel ? (modelLabel(inheritedModel) ?? inheritedModel) : 'CLI default model'
  const defaultEffort = worker?.defaultEffort
    ? `Auto effort (${effortLabel(worker.defaultEffort) ?? worker.defaultEffort})`
    : 'Auto effort'

  return {
    workerId,
    model,
    effort,
    changed,
    setWorker: pickWorker,
    setModel: (next) => {
      setModel(next)
      setEffort('')
    },
    setEffort,
    reset,
    apply,
    workerOptions: [
      { value: '', label: 'Auto (scheduler decides)' },
      /* ⛔ Deactivated accounts are not offered: the scheduler would never hand one a turn. The
         account this task is already pinned to stays listed so the pill reads its name. */
      ...fleet
        .filter((e) => (e.worker.enabled && canWork(e.worker.role)) || e.worker.id === workerId)
        .map((e) => ({ value: e.worker.id, label: `${e.worker.label} (${e.worker.adapterId})` }))
    ],
    modelOptions: [
      ...(offeredModels.length > 1
        ? [
            { value: '__auto__', label: 'Auto Model (scheduler decides)' },
            { value: '__auto__:high', label: 'Auto Model (high)' },
            { value: '__auto__:med', label: 'Auto Model (med)' },
            { value: '__auto__:low', label: 'Auto Model (low)' }
          ]
        : []),
      { value: '', label: inheritedModel ? `account default (${inheritedLabel})` : 'CLI default model' },
      // ⚠️ The label is written for a person; the value stays the id the CLI and cost model use.
      ...offeredModels.map((m) => ({ value: m.id, label: modelLabel(m.id) ?? m.id }))
    ],
    effortOptions: offeredEfforts.length
      ? [
          { value: '', label: defaultEffort },
          ...offeredEfforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))
        ]
      : [],
    workerLabel: worker ? worker.label : 'Auto worker',
    modelLabel: !workerId
      ? 'Auto model'
      : (AUTO_MODEL_LABELS[model] ??
        (!model || model === '__inherit__' ? inheritedLabel : (modelLabel(model) ?? model))),
    effortLabel: effort ? (effortLabel(effort) ?? effort) : defaultEffort
  }
}

/**
 * The three pills under the composer. Clicking one opens its list; a pick that differs from the
 * task's pin highlights the row and turns Send into Reassign.
 *
 * ⚠️ Read-only while a run is live: the pin only decides the *next* dispatch, and a Reassign button
 * that could not move the run in front of you would be a promise the press does not keep.
 */
export function AssignPills({
  choice,
  disabled,
  disabledReason
}: {
  choice: ReassignChoice
  disabled: boolean
  disabledReason?: string
}): React.JSX.Element {
  const hint = disabled
    ? disabledReason
    : 'Choose who takes the next turn. Send becomes Reassign, and your message goes with it.'
  const cls = choice.changed ? 'compose-assign-pill compose-assign-pill--changed' : 'compose-assign-pill'
  return (
    <div className={`compose-assign${choice.changed ? ' compose-assign--changed' : ''}`}>
      <PillSelect
        className={cls}
        label={choice.workerLabel}
        value={choice.workerId}
        options={choice.workerOptions}
        onChange={choice.setWorker}
        ariaLabel="Reassign worker"
        title={hint}
        muted={!choice.workerId}
        disabled={disabled}
      />
      <PillSelect
        className={cls}
        label={choice.modelLabel}
        value={choice.model}
        options={choice.modelOptions}
        onChange={choice.setModel}
        ariaLabel="Reassign model"
        title={choice.workerId ? hint : 'Pick a worker first — the model list is that account’s'}
        muted={!choice.model || choice.model.startsWith('__auto__')}
        disabled={disabled || !choice.workerId || choice.modelOptions.length <= 1}
      />
      {choice.effortOptions.length > 0 && (
        <PillSelect
          className={cls}
          label={choice.effortLabel}
          value={choice.effort}
          options={choice.effortOptions}
          onChange={choice.setEffort}
          ariaLabel="Reassign effort"
          title={hint}
          muted={!choice.effort}
          disabled={disabled}
        />
      )}
      {choice.changed && !disabled && (
        <button type="button" className="compose-assign-reset" onClick={choice.reset}>
          undo
        </button>
      )}
    </div>
  )
}
