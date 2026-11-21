/**
 * The worker / model / effort a task's next run asks for, chosen from pills under the composer.
 *
 * ⛔ **One choice, read by two controls.** The composer's primary button turns into *Reassign* the
 * moment this differs from what the task is pinned to, and the settle strip's *Resolve & retry*
 * hands a landing repair to the same selection. Two private copies of these three selectors is what
 * the old card had — one on the quota card, one on the decision card — and a pick in one was not a
 * pick in the other (t669).
 *
 * ⛔ **Three pills in the row (`Worker · Model · Effort`), never a bare tier pill.** Clicking the
 * Model pill opens Auto Model capability tiers (`High`/`Med`/`Low`/custom), optional feature tags,
 * Account default (when pinned), and concrete models (across enabled workers when on Auto worker).
 */
import { canWork, type ModelOptions } from '@shared/protocol'
import { routableTags, tagsRoutable, type ModelRoute } from '@shared/modelroutes'
import {
  BUILTIN_TAGS,
  cleanTags,
  fleetTags,
  isTierTag,
  sameTags,
  tagDisplay,
  tagKey,
  tagsLabel,
  toggleExclusiveTierTag
} from '@shared/modeltags'
import { resolveModelChoice, type Task } from '@shared/tasks'
import { useEffect, useRef, useState } from 'react'
import { rpc, type FleetEntry } from '../../lib/daemon'
import { effortLabel, modelLabel } from '../../lib/modelname'
import { effortLookupModel, filedReassignEffort, reassignmentModel } from '../../lib/taskview'
import { Pill, PillSelect, type PillOption } from '../Pill'

export function initialSelectedModel(
  model?: string,
  modelPolicy?: 'auto' | 'inherit',
  modelTags?: readonly string[]
): string {
  if (model) return model
  if (modelPolicy === 'auto') return '__auto__'
  // ⛔ A tag requirement is filed without a policy (the composer never stores `'auto'`), and it is
  // still Auto — not the account's default.
  if (modelTags && modelTags.length > 0 && modelPolicy !== 'inherit') return '__auto__'
  return ''
}

/** The tags this particular account can honour for Auto Model. Kept pure for L1 coverage. */
export function availableAutoTags(
  worker: { modelRoutes?: ModelRoute[] | null; defaultEffort?: string | null } | null,
  inheritedModel: string | null
): string[] {
  return routableTags(worker, inheritedModel)
}

/**
 * The requirement `tags` asks for that the selected account cannot honour, or null.
 *
 * ⛔ **No account selected is not an account with no routes (t899).** On an Auto-worker task the
 * scheduler picks the account, so there is no table to test the tags against; treating "no worker" as
 * "no route" made *Auto Model (Med)* read as unrunnable on a task that was filed with it and had run
 * on a Med row. ⚠️ All of them on one pair: `High` and `Audio` each on the table, but on two pairs,
 * is not a route.
 */
export function unavailableAutoTags(
  model: string,
  tags: readonly string[],
  worker: { modelRoutes?: ModelRoute[] | null; defaultEffort?: string | null } | null,
  inheritedModel: string | null
): string[] | null {
  if (!worker || !model.startsWith('__auto__') || tags.length === 0) return null
  return tagsRoutable(worker, tags, inheritedModel) ? null : [...tags]
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
  invalidConcreteModel?: boolean
  /** The selected Auto tags have no pair on the selected account. */
  invalidAutoTags?: boolean
  tags?: readonly string[]
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
        : input.invalidAutoTags
          ? 'Choose another model'
        : input.invalidConcreteModel
          ? `Invalid model: ${modelLabel(model) ?? model}`
        : model.startsWith('__auto__') || (!workerId && Boolean(input.tags && input.tags.length > 0))
          ? input.tags && input.tags.length > 0
            ? `Auto Model · ${tagsLabel(input.tags)}`
            : 'Auto Model'
        : !workerId
          ? 'Auto model'
          : !model || model === '__inherit__'
            ? input.inheritedLabel
            : (modelLabel(model) ?? model),
    effortLabel: effort
      ? (effortLabel(effort) ?? effort)
      : currentEffort && current?.effort
        ? (effortLabel(current.effort) ?? current.effort)
        : defaultEffort,
    currentEffort,
    selectedWorkerId
  }
}

export interface FleetModelChoice {
  workerId: string
  workerLabel: string
  modelId: string
  label: string
}

/** Order capability tier tags cleanly (`High`, `Med`, `Low`, then custom tiers alphabetically). */
export function orderedAutoTierTags(
  tagOptions: readonly string[],
  selectedTags: readonly string[] = []
): string[] {
  return cleanTags([...tagOptions, ...selectedTags])
    .filter(isTierTag)
    .sort((a, b) => {
      const ia = BUILTIN_TAGS.findIndex((t) => tagKey(t) === tagKey(a))
      const ib = BUILTIN_TAGS.findIndex((t) => tagKey(t) === tagKey(b))
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      }
      return tagDisplay(a).localeCompare(tagDisplay(b))
    })
}

/** Update selected tags for an exclusive Auto Model tier pick, keeping orthogonal feature tags intact. */
export function nextTagsForAutoTier(currentTags: readonly string[], tier: string | null): string[] {
  if (tier === null) return currentTags.filter((t) => !isTierTag(t))
  const key = tagKey(tier)
  if (currentTags.some((t) => tagKey(t) === key)) return [...currentTags]
  return toggleExclusiveTierTag(currentTags, tier)
}

/** Build the exact `task.setWorker` RPC payload for a Reassign selection. */
export function reassignApplyPayload(input: {
  taskId: string
  workerId: string
  model: string
  tags: readonly string[]
  filedEffort: string | null
}): {
  id: string
  workerId: string | null
  model?: string | null
  modelPolicy?: 'auto' | 'inherit' | null
  modelTags?: string[]
  effort?: string | null
} {
  const { taskId, workerId, model, tags, filedEffort } = input
  const isAuto = model.startsWith('__auto__')
  const modelPolicy = isAuto ? 'auto' : !model || model === '__inherit__' ? 'inherit' : null
  const modelTags = isAuto ? [...tags] : []
  const pinned = isAuto || model === '__inherit__' ? null : model || null
  return {
    id: taskId,
    workerId: workerId || null,
    ...(workerId ? { model: pinned, modelPolicy, modelTags, effort: filedEffort } : { modelTags: [...tags] })
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
  /** Pick Auto Model with an exclusive capability tier (or null for Any), preserving feature tags. */
  pickAutoTier: (tier: string | null) => void
  /** Atomically pick a worker and concrete model (used from Auto worker's combined model list). */
  pickWorkerModel: (workerId: string, modelId: string) => void
  reset: () => void
  /** Writes the selection as the task's pin, in one RPC. Does not start a run. */
  apply: () => Promise<void>
  workerOptions: PillOption[]
  modelOptions: PillOption[]
  concreteModelOptions: PillOption[]
  fleetModelOptions: FleetModelChoice[]
  inheritedModelLabel: string
  effortOptions: PillOption[]
  workerLabel: string
  modelLabel: string
  effortLabel: string
  /** The effort pill names the latest run's effort, which is worth showing even with no list to pick from. */
  currentEffort: boolean
  /** A previously selected Auto tag requirement cannot run on the newly picked account. */
  invalidModelMessage: string | null
  /** The tags Auto Model must find on one pair. Meaningful only while `model` is Auto. */
  tags: string[]
  setTags: (tags: string[]) => void
  /** What the Model menu offers under Auto Model: this account's, or the fleet's while none is chosen. */
  tagOptions: string[]
  /** Whether the selection is currently router-chosen (Auto Model). */
  showsTags: boolean
}

export function useReassignChoice(
  task: Task,
  fleet: FleetEntry[],
  options: ModelOptions[],
  current: CurrentAssignment | null = null
): ReassignChoice {
  const c = task.constraints
  const pinnedModel = initialSelectedModel(c.model, c.modelPolicy, c.modelTags)
  const pinnedTags = pinnedModel === '__auto__' ? (c.modelTags ?? []) : []
  const pinnedTagsKey = pinnedTags.join('\u0000')
  const [workerId, setWorkerId] = useState<string>(c.workerId ?? '')
  const [model, setModel] = useState<string>(pinnedModel)
  const [tags, setTags] = useState<string[]>(pinnedTags)
  const [effort, setEffort] = useState<string>(c.effort ?? '')
  const [userPickedWorker, setUserPickedWorker] = useState(false)

  const reset = (): void => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setTags(pinnedTags)
    setEffort(c.effort ?? '')
    setUserPickedWorker(false)
  }
  // ⚠️ The pin moved underneath (a write from here, another window, the scheduler): follow it.
  useEffect(() => {
    setWorkerId(c.workerId ?? '')
    setModel(pinnedModel)
    setTags(pinnedTags)
    setEffort(c.effort ?? '')
    setUserPickedWorker(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinnedTags is derived from pinnedTagsKey
  }, [c.workerId, pinnedModel, pinnedTagsKey, c.effort])

  const entry = fleet.find((e) => e.worker.id === workerId) ?? null
  const worker = entry?.worker ?? null
  const adapter = worker
    ? (options.find((o) => o.workerId === worker.id) ??
      options.find((o) => o.adapterId === worker.adapterId && !o.workerId) ??
      options.find((o) => o.adapterId === worker.adapterId))
    : undefined
  const offeredModels = adapter?.models ?? []
  const canSetEffort = adapter?.selectableEffort ?? false
  const inheritedModel = resolveModelChoice(null, worker, canSetEffort, entry?.quota).model
  const autoTagOptions = worker ? availableAutoTags(worker, inheritedModel) : fleetTags(fleet.map((e) => e.worker))
  const unavailableTags = unavailableAutoTags(model, tags, worker, inheritedModel)
  const isInvalidConcreteModel = Boolean(
    model &&
    !model.startsWith('__auto__') &&
    model !== '__inherit__' &&
    offeredModels.length > 0 &&
    !offeredModels.some((m) => m.id === model)
  )
  const offeredEfforts = canSetEffort
    ? (offeredModels.find((m) => m.id === effortLookupModel(model, inheritedModel))?.effortLevels ?? [])
    : []

  const workerChanged =
    workerId !== (c.workerId ?? '') ||
    (userPickedWorker && !workerId && !!current?.workerId && current.workerId !== (c.workerId ?? ''))
  const changed =
    workerChanged ||
    model !== pinnedModel ||
    (model === '__auto__' && !sameTags(tags, pinnedTags)) ||
    effort !== (c.effort ?? '')
  const filedEffort = filedReassignEffort(model, effort, offeredEfforts)

  const pickWorker = (next: string): void => {
    setUserPickedWorker(true)
    setWorkerId(next)
    if (!next) {
      // ⚠️ Tags survive "Auto worker": the scheduler picks the account, and the tags are what it is
      // asked to find on it. Dropping them here is what made tags unreachable without a pinned account.
      setModel(tags.length > 0 ? '__auto__' : '')
      setEffort('')
      return
    }
    const w = fleet.find((e) => e.worker.id === next)?.worker
    const nextAdapter = w
      ? (options.find((o) => o.workerId === w.id) ??
        options.find((o) => o.adapterId === w.adapterId && !o.workerId) ??
        options.find((o) => o.adapterId === w.adapterId))
      : undefined
    const offered = nextAdapter?.models ?? []
    const nextInherited = resolveModelChoice(null, w ?? null, nextAdapter?.selectableEffort ?? false, fleet.find((e) => e.worker.id === next)?.quota).model
    // ⚠️ Tags the new account cannot honour are *kept* and flagged (`unavailableTags`), never
    // cleared: dropping them would quietly turn a "ZDR + Audio" request into plain Auto.
    void nextInherited
    if (model && !model.startsWith('__auto__') && model !== '__inherit__' && !offered.some((m) => m.id === model)) {
      setModel(reassignmentModel(model, offered))
      setEffort('')
    }
  }

  const pickAutoTier = (tier: string | null): void => {
    setModel('__auto__')
    setEffort('')
    setTags((prev) => nextTagsForAutoTier(prev, tier))
  }

  const pickWorkerModel = (targetWorkerId: string, targetModelId: string): void => {
    setUserPickedWorker(true)
    setWorkerId(targetWorkerId)
    setModel(targetModelId)
    setEffort('')
    setTags([])
  }

  const apply = async (): Promise<void> => {
    if (unavailableTags) throw new Error('choose other tags or another model before reassigning')
    if (isInvalidConcreteModel) throw new Error('choose another model before reassigning')
    // ⛔ One write. The scheduler can dispatch after the worker write, so a following model write
    // is too late — it was how an explicit Opus reassignment resumed on the account's Haiku default.
    await rpc(
      'task.setWorker',
      reassignApplyPayload({ taskId: task.id, workerId, model, tags, filedEffort })
    )
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
      : null,
    invalidConcreteModel: isInvalidConcreteModel,
    invalidAutoTags: unavailableTags !== null,
    tags
  })

  const concreteModelOptions: PillOption[] = offeredModels.map((m) => ({
    value: m.id,
    label: modelLabel(m.id) ?? m.id
  }))

  const fleetModelOptions: FleetModelChoice[] = !workerId
    ? fleet
        .filter((e) => e.worker.enabled && canWork(e.worker.role))
        .flatMap((e) => {
          const workerOpts =
            options.find((o) => o.workerId === e.worker.id) ??
            options.find((o) => o.adapterId === e.worker.adapterId && !o.workerId) ??
            options.find((o) => o.adapterId === e.worker.adapterId)
          return (workerOpts?.models ?? []).map((m) => ({
            workerId: e.worker.id,
            workerLabel: e.worker.label,
            modelId: m.id,
            label: modelLabel(m.id) ?? m.id
          }))
        })
    : []

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
      // Tags belong to an Auto choice; a pin or the account default has none to ask for.
      if (!next.startsWith('__auto__')) setTags([])
    },
    pickAutoTier,
    pickWorkerModel,
    tags,
    setTags: (next) => {
      setTags(next)
      if (!workerId) setModel(next.length > 0 ? '__auto__' : '')
      else if (next.length > 0 && !model.startsWith('__auto__')) {
        setModel('__auto__')
        setEffort('')
      }
    },
    tagOptions: autoTagOptions,
    showsTags: model.startsWith('__auto__') || !workerId,
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
      ...(isInvalidConcreteModel
        ? [{ value: model, label: `Invalid model: ${modelLabel(model) ?? model}`, hint: `This account cannot run '${model}'. Choose another model.`, disabled: true }]
        : []),
      ...(unavailableTags
        ? [{ value: model, label: 'Choose another model', hint: `This account has no Auto Model (${tagsLabel(unavailableTags)}) route.`, disabled: true }]
        : []),
      ...(autoTagOptions.length > 0 || !worker
        ? [{ value: '__auto__', label: 'Auto Model (scheduler decides)' }]
        : []),
      { value: '', label: inheritedModel ? `account default (${inheritedLabel})` : 'CLI default model' },
      // ⚠️ The label is written for a person; the value stays the id the CLI and cost model use.
      ...concreteModelOptions
    ],
    concreteModelOptions,
    fleetModelOptions,
    inheritedModelLabel: inheritedLabel,
    effortOptions: offeredEfforts.length
      ? [
          { value: '', label: defaultEffort },
          ...offeredEfforts.map((level) => ({ value: level, label: effortLabel(level) ?? level }))
        ]
      : [],
    ...labels,
    invalidModelMessage: unavailableTags
      ? `This account has no pair with ${tagsLabel(unavailableTags)} for Auto Model. Choose other tags or another model.`
      : isInvalidConcreteModel
        ? `This account cannot run model '${model}'. Choose another model.`
        : null
  }
}

/**
 * Portalled Model popover combining Auto Model tiers, optional feature tags, Account default (when
 * pinned), and concrete models (across enabled workers when on Auto worker).
 */
export function ReassignModelMenu({
  choice,
  close
}: {
  choice: ReassignChoice
  close: () => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const isAuto = !choice.model || choice.model === '__auto__' || choice.model === '__inherit__'
  const selectedTierTag = choice.tags.find(isTierTag) ?? null
  const isAnyAutoActive =
    (choice.model.startsWith('__auto__') || (!choice.workerId && !choice.model)) && !selectedTierTag
  const tiers = orderedAutoTierTags(choice.tagOptions, choice.tags)
  const features = cleanTags([...choice.tagOptions, ...choice.tags]).filter((t) => !isTierTag(t))

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    const current = rows.find((r) => r.getAttribute('aria-selected') === 'true')
    ;(current ?? rows[0])?.focus()
  }, [])

  const move = (from: HTMLElement, delta: number): void => {
    const list = listRef.current
    if (!list) return
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    const at = rows.indexOf(from as HTMLButtonElement)
    if (at < 0) return
    rows[(at + delta + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      ref={listRef}
      className="pill-options reassign-model-menu"
      role="listbox"
      aria-label="Reassign model"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(e.target as HTMLElement, e.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      {choice.invalidModelMessage && (
        <div className="reassign-model-notice" role="status">
          {choice.invalidModelMessage}
        </div>
      )}

      <div className="reassign-model-section-title">Auto Model (by tier)</div>
      <button
        type="button"
        role="option"
        aria-selected={isAnyAutoActive}
        className={`pill-option${isAnyAutoActive ? ' pill-option--on' : ''}`}
        onClick={() => {
          choice.pickAutoTier(null)
          close()
        }}
      >
        <span className="pill-option-text">
          <span className="pill-option-label">Auto Model (Any)</span>
        </span>
        {isAnyAutoActive && (
          <span className="pill-option-check" aria-hidden="true">
            ✓
          </span>
        )}
      </button>

      {tiers.map((tier) => {
        const active =
          (choice.model.startsWith('__auto__') || (!choice.workerId && isAuto)) &&
          selectedTierTag !== null &&
          tagKey(selectedTierTag) === tagKey(tier)
        return (
          <button
            key={tagKey(tier)}
            type="button"
            role="option"
            aria-selected={active}
            className={`pill-option${active ? ' pill-option--on' : ''}`}
            onClick={() => {
              choice.pickAutoTier(tier)
              close()
            }}
          >
            <span className="pill-option-text">
              <span className="pill-option-label">{`Auto Model · ${tagDisplay(tier)}`}</span>
            </span>
            {active && (
              <span className="pill-option-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        )
      })}

      {features.length > 0 && (
        <div className="reassign-model-features">
          <div className="reassign-model-section-title">Feature tags</div>
          <ul className="reassign-model-feature-list">
            {features.map((tag) => {
              const key = tagKey(tag)
              const checked = choice.tags.some((t) => tagKey(t) === key)
              return (
                <li key={key} className="tag-picker-row">
                  <label className="tag-picker-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? choice.tags.filter((t) => tagKey(t) !== key)
                          : [...choice.tags, tag]
                        choice.setTags(next)
                      }}
                    />
                    <span className="tag-picker-name">{tagDisplay(tag)}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {choice.workerId && (
        <>
          <div className="reassign-model-section-title">Account default</div>
          <button
            type="button"
            role="option"
            aria-selected={!choice.model || choice.model === '__inherit__'}
            className={`pill-option${!choice.model || choice.model === '__inherit__' ? ' pill-option--on' : ''}`}
            onClick={() => {
              choice.setModel('')
              close()
            }}
          >
            <span className="pill-option-text">
              <span className="pill-option-label">
                {choice.inheritedModelLabel ? `Account default (${choice.inheritedModelLabel})` : 'CLI default model'}
              </span>
            </span>
            {(!choice.model || choice.model === '__inherit__') && (
              <span className="pill-option-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        </>
      )}

      {(choice.workerId ? choice.concreteModelOptions.length > 0 : choice.fleetModelOptions.length > 0) && (
        <div className="reassign-model-section-title">Models</div>
      )}

      {choice.workerId
        ? choice.concreteModelOptions.map((opt) => {
            const on = choice.model === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={on}
                disabled={opt.disabled}
                className={`pill-option${on ? ' pill-option--on' : ''}`}
                onClick={() => {
                  choice.setModel(opt.value)
                  close()
                }}
              >
                <span className="pill-option-text">
                  <span className="pill-option-label">{opt.label}</span>
                  {opt.hint && <span className="pill-option-hint">{opt.hint}</span>}
                </span>
                {on && (
                  <span className="pill-option-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            )
          })
        : choice.fleetModelOptions.map((opt) => (
            <button
              key={`${opt.workerId}:${opt.modelId}`}
              type="button"
              role="option"
              aria-selected={false}
              className="pill-option"
              onClick={() => {
                choice.pickWorkerModel(opt.workerId, opt.modelId)
                close()
              }}
            >
              <span className="pill-option-text">
                <span className="pill-option-label">{opt.label}</span>
                <span className="pill-option-hint">{opt.workerLabel}</span>
              </span>
            </button>
          ))}
    </div>
  )
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
  extra,
  notices
}: {
  choice: ReassignChoice
  disabled: boolean
  disabledReason?: string
  /** Controls that sit in the same row but are not part of the next-run choice (the Delegate pill). */
  extra?: React.ReactNode
  /** Notices rendered underneath the single-line pill row (for example delegation hints/errors). */
  notices?: React.ReactNode
}): React.JSX.Element {
  const hint = disabled
    ? disabledReason
    : 'Choose who takes the next turn. Send becomes Reassign, and your message goes with it.'
  const cls = choice.changed ? 'compose-assign-pill compose-assign-pill--changed' : 'compose-assign-pill'
  return (
    <div className={`compose-assign${choice.changed ? ' compose-assign--changed' : ''}`}>
      <div className="compose-assign-row">
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
        <Pill
          className={cls}
          menuClassName="pill-menu--model"
          label={choice.modelLabel}
          ariaLabel="Reassign model"
          title={hint}
          muted={!choice.model || choice.model.startsWith('__auto__')}
          disabled={disabled}
          menu={(close) => <ReassignModelMenu choice={choice} close={close} />}
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
      </div>
      {notices}
      {choice.invalidModelMessage && <p className="compose-assign-error" role="alert">{choice.invalidModelMessage}</p>}
    </div>
  )
}
