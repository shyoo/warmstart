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
import { MODEL_CLASSES, type ModelClass } from '@shared/modelclass'
import { autoRoutes, classOnWorker, routeClass, type ModelRoute } from '@shared/modelroutes'
import { resolveModelChoice, type Task } from '@shared/tasks'
import { useEffect, useState } from 'react'
import { rpc, type FleetEntry } from '../../lib/daemon'
import { effortLabel, modelLabel } from '../../lib/modelname'
import { effortLookupModel, filedReassignEffort, reassignmentModel } from '../../lib/taskview'
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

const INVALID_AUTO_PREFIX = '__invalid_auto__:'

/** Auto tiers this particular account can actually honour. Kept pure for L1 coverage. */
export function availableAutoClasses(
  worker: { modelRoutes?: ModelRoute[] | null } | null,
  inheritedModel: string | null
): ModelClass[] {
  if (!worker) return []
  const routes = autoRoutes(worker)
  if (routes.length > 0) return MODEL_CLASSES.filter((modelClass) => routes.some((route) => routeClass(route) === modelClass))
  return inheritedModel ? [classOnWorker(worker, inheritedModel)] : []
}

function invalidAutoClass(model: string): ModelClass | null {
  if (!model.startsWith(INVALID_AUTO_PREFIX)) return null
  const value = model.slice(INVALID_AUTO_PREFIX.length)
  return MODEL_CLASSES.includes(value as ModelClass) ? (value as ModelClass) : null
}

function unavailableAutoClass(model: string, available: ModelClass[]): ModelClass | null {
  const requested = model.startsWith('__auto__:') ? (model.slice('__auto__:'.length) as ModelClass) : null
  return requested && MODEL_CLASSES.includes(requested) && !available.includes(requested) ? requested : null
}

/**
 * What the task is on *now*: the latest run's account, the model it answered with, and the effort
 * its session observed. Null until something has run.
 */
export interface CurrentAssignment {
  workerId: string
  model: string | null
  effort: string | null
}

/**
 * The words on the three pills.
 *
 * ⛔ **A pin of "Auto" is not what the task is on.** Once a run has happened the scheduler has made
 * its choice, and a pill reading *Auto model* under a thread whose run said Opus hides the one fact
 * the row is there for (t674). Where the selection is untouched and the pin leaves a field to the
 * scheduler, the pill names what the latest run actually used — but only while the selected account
 * *is* that run's account: a reassignment to another account that has not started yet has no
 * current model, and borrowing the previous account's would be a claim about the wrong CLI.
 */
export function pillLabels(input: {
  workerId: string
  model: string
  effort: string
  changed: boolean
  worker: { label: string; defaultEffort?: string | null } | null
  inheritedLabel: string
  current: CurrentAssignment | null
  currentWorkerLabel: string | null
}): {
  workerLabel: string
  modelLabel: string
  effortLabel: string
  currentEffort: boolean
  selectedWorkerId: string
} {
  const { workerId, model, effort, worker, current } = input
  const onCurrent =
    !input.changed && !!current && (!workerId || workerId === current.workerId)
  const autoModel = !model || model === '__inherit__' || model.startsWith('__auto__')
  const defaultEffort = worker?.defaultEffort
    ? `Auto effort (${effortLabel(worker.defaultEffort) ?? worker.defaultEffort})`
    : 'Auto effort'
  const currentEffort = onCurrent && !effort && !!current?.effort
  const selectedWorkerId =
    onCurrent && !workerId && current?.workerId ? current.workerId : workerId
  return {
    workerLabel: worker
      ? worker.label
      : onCurrent && input.currentWorkerLabel
        ? input.currentWorkerLabel
        : 'Auto worker',
    modelLabel:
      onCurrent && autoModel && current?.model
        ? (modelLabel(current.model) ?? current.model)
        : invalidAutoClass(model)
          ? 'Choose another model'
        : !workerId
          ? 'Auto model'
          : (AUTO_MODEL_LABELS[model] ??
            (!model || model === '__inherit__' ? input.inheritedLabel : (modelLabel(model) ?? model))),
    effortLabel: effort
      ? (effortLabel(effort) ?? effort)
      : currentEffort && current?.effort
        ? (effortLabel(current.effort) ?? current.effort)
        : defaultEffort,
    currentEffort,
    selectedWorkerId
  }
}

export interface ReassignChoice {
  workerId: string
  model: string
  effort: string
  /** What `apply` would file for effort: `effort`, unless it is a level an Auto choice is not offering. */
  filedEffort: string | null
  /**
   * The worker shown as selected by the worker pill's dropdown menu. Matches `workerId` when explicitly
   * chosen or pinned, or the latest run's worker when left to the scheduler (`onCurrent`).
   */
  selectedWorkerId: string
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
  /** The effort pill names the latest run's effort, which is worth showing even with no list to pick from. */
  currentEffort: boolean
  /** A previously selected Auto tier cannot run on the newly picked account. */
  invalidModelMessage: string | null
}

export function useReassignChoice(
  task: Task,
  fleet: FleetEntry[],
  options: ModelOptions[],
  current: CurrentAssignment | null = null
): ReassignChoice {
  const c = task.constraints
  const pinnedModel = initialSelectedModel(c.model, c.modelPolicy, c.modelClass)
  const [workerId, setWorkerId] = useState<string>(c.workerId ?? '')
  const [model, setModel] = useState<string>(pinnedModel)
  const [effort, setEffort] = useState<string>(c.effort ?? '')
  const [userPickedWorker, setUserPickedWorker] = useState(false)

  const reset = (): void => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setEffort(c.effort ?? '')
    setUserPickedWorker(false)
  }
  // ⚠️ The pin moved underneath (a write from here, another window, the scheduler): follow it.
  useEffect(() => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setEffort(c.effort ?? '')
    setUserPickedWorker(false)
  }, [c.workerId, pinnedModel, c.effort])

  const entry = fleet.find((e) => e.worker.id === workerId) ?? null
  const worker = entry?.worker ?? null
  const adapter = options.find((o) => o.adapterId === worker?.adapterId)
  const offeredModels = adapter?.models ?? []
  const canSetEffort = adapter?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, worker, canSetEffort, entry?.quota).model
  const autoClasses = availableAutoClasses(worker, inheritedModel)
  const unavailableClass = invalidAutoClass(model) ?? unavailableAutoClass(model, autoClasses)
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === effortLookupModel(model, inheritedModel))?.effortLevels ?? [])
    : []

  const workerChanged =
    workerId !== (c.workerId ?? '') ||
    (userPickedWorker && !workerId && !!current?.workerId && current.workerId !== (c.workerId ?? ''))
  const changed = workerChanged || model !== pinnedModel || effort !== (c.effort ?? '')
  const filedEffort = filedReassignEffort(model, effort, offeredEfforts)

  const pickWorker = (next: string): void => {
    setUserPickedWorker(true)
    setWorkerId(next)
    if (!next) {
      setModel('')
      setEffort('')
      return
    }
    const w = fleet.find((e) => e.worker.id === next)?.worker
    const offered = options.find((o) => o.adapterId === w?.adapterId)?.models ?? []
    const nextAdapter = options.find((o) => o.adapterId === w?.adapterId)
    const nextInherited = resolveModelChoice(null, w ?? null, nextAdapter?.selectableEffort ?? false, fleet.find((e) => e.worker.id === next)?.quota).model
    const nextAutoClasses = availableAutoClasses(w ?? null, nextInherited)
    const requestedClass = model.startsWith('__auto__:') ? model.split(':')[1] as ModelClass : null
    if (requestedClass && !nextAutoClasses.includes(requestedClass)) {
      setModel(`${INVALID_AUTO_PREFIX}${requestedClass}`)
      setEffort('')
      return
    }
    if (model && !model.startsWith('__auto__') && model !== '__inherit__' && !offered.some((m) => m.id === model)) {
      setModel(reassignmentModel(model, offered))
      setEffort('')
    }
  }

  const apply = async (): Promise<void> => {
    if (unavailableClass) throw new Error('choose another model or Auto tier before reassigning')
    const isAuto = model.startsWith('__auto__')
    const modelPolicy = isAuto ? 'auto' : !model || model === '__inherit__' ? 'inherit' : null
    const modelClass = isAuto && model.includes(':') ? (model.split(':')[1] as ModelClass) : null
    const pinned = isAuto || model === '__inherit__' ? null : model || null
    // ⛔ One write. The scheduler can dispatch after the worker write, so a following model write
    // is too late — it was how an explicit Opus reassignment resumed on the account's Haiku default.
    await rpc('task.setWorker', {
      id: task.id,
      workerId: workerId || null,
      ...(workerId ? { model: pinned, modelPolicy, modelClass, effort: filedEffort } : {})
    })
  }

  const inheritedLabel = inheritedModel ? (modelLabel(inheritedModel) ?? inheritedModel) : 'CLI default model'
  const defaultEffort = worker?.defaultEffort
    ? `Auto effort (${effortLabel(worker.defaultEffort) ?? worker.defaultEffort})`
    : 'Auto effort'
  const labels = pillLabels({
    workerId,
    model,
    effort,
    changed,
    worker,
    inheritedLabel,
    current,
    currentWorkerLabel: current
      ? (fleet.find((e) => e.worker.id === current.workerId)?.worker.label ?? current.workerId.slice(0, 8))
      : null
  })

  return {
    workerId,
    model,
    effort,
    filedEffort,
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
        .filter(
          (e) =>
            (e.worker.enabled && canWork(e.worker.role)) ||
            e.worker.id === workerId ||
            e.worker.id === labels.selectedWorkerId
        )
        .map((e) => ({ value: e.worker.id, label: `${e.worker.label} (${e.worker.adapterId})` })),
      ...(labels.selectedWorkerId && !fleet.some((e) => e.worker.id === labels.selectedWorkerId)
        ? [{ value: labels.selectedWorkerId, label: labels.workerLabel }]
        : [])
    ],
    modelOptions: [
      ...(unavailableClass
        ? [{ value: model, label: 'Choose another model', hint: `This account has no Auto Model (${unavailableClass}) route.`, disabled: true }]
        : []),
      ...(autoClasses.length > 0
        ? [
            { value: '__auto__', label: 'Auto Model (scheduler decides)' },
            ...autoClasses.map((modelClass) => ({ value: `__auto__:${modelClass}`, label: `Auto Model (${modelClass})` }))
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
    ...labels,
    invalidModelMessage: unavailableClass
      ? `This account cannot run Auto Model (${unavailableClass}). Choose another model or tier.`
      : null
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
  disabledReason,
  extra
}: {
  choice: ReassignChoice
  disabled: boolean
  disabledReason?: string
  /** Controls that sit in the same row but are not part of the next-run choice (the Delegate pill). */
  extra?: React.ReactNode
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
        value={choice.selectedWorkerId}
        options={choice.workerOptions}
        onChange={choice.setWorker}
        ariaLabel="Reassign worker"
        title={hint}
        muted={!choice.selectedWorkerId}
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
      {(choice.effortOptions.length > 0 || choice.currentEffort) && (
        <PillSelect
          className={cls}
          label={choice.effortLabel}
          value={choice.effort}
          options={choice.effortOptions}
          onChange={choice.setEffort}
          ariaLabel="Reassign effort"
          title={choice.effortOptions.length > 0 ? hint : 'Pick a worker first — the effort list is that account’s'}
          muted={!choice.effort}
          disabled={disabled || choice.effortOptions.length === 0}
        />
      )}
      {choice.changed && !disabled && (
        <button type="button" className="compose-assign-reset" onClick={choice.reset}>
          undo
        </button>
      )}
      {extra}
      {choice.invalidModelMessage && <p className="compose-assign-error" role="alert">{choice.invalidModelMessage}</p>}
    </div>
  )
}
