import { canWork } from '@shared/protocol'
import {
  AUTO_COMPACT_LABELS,
  COMPLETION_LABELS,
  FINISH_LABELS,
  FINISH_ORDER,
  OBJECTIVE_PRESET_ORDER,
  SHARING_LABELS,
  presetOf,
  type Objective,
  type ResolvedAutoCompact,
  type ResolvedCompletionMode,
  type ResolvedFinishPolicy,
  type ResolvedSessionSharing,
  type Run,
  type Task
} from '@shared/tasks'
import { duration } from './format'
import type { FleetEntry } from './daemon'
import type { SettingOption } from '../components/SettingButtonSelect'

/**
 * The arithmetic behind the task thread, extracted from the components that draw it.
 *
 * ⛔ **This file exists to be tested.** Nothing at L1 covers the renderer and `test/ui.test.mjs`
 * never opens a project, so a helper left inside `TaskThread.tsx` is a helper no suite can reach —
 * which is why the option lists below, all of which decide what an operator is offered, were
 * unproven while they lived there. Keep this module pure: no JSX, no hooks, no `rpc`.
 */

/** The tone class a run's row wears. A run with no outcome yet is *running*, not *failed*. */
export function outcomeClass(outcome: Run['outcome']): string {
  if (outcome === 'completed') return 'ok'
  if (outcome === 'blocked') return 'state-human'
  return outcome ? 'warn' : 'state-running'
}

/** How long a review usually takes here, or an honest admission that nothing has measured it yet. */
export function paceNote(typicalMs: number | null): string {
  return typicalMs === null
    ? 'How long it takes here is not yet known: it has not finished a review on this fleet.'
    : `Its last reviews here took about ${duration(typicalMs)}.`
}

/** What a picker shows: the option that is selected, the menu, and what the button reads. */
export interface SettingChoice {
  value: string
  options: SettingOption[]
  displayLabel?: string
}

/**
 * The label for a resolved value, falling back when the daemon sent nothing.
 *
 * ⚠️ `labels[value] ?? value` on purpose: a value this build has no label for is shown raw rather
 * than as the fallback, because printing *the default* for a setting that is not on the default is
 * the one wrong answer here.
 */
export function inheritedLabel<T extends string>(
  labels: Partial<Record<T, string>>,
  value: T | undefined,
  fallback: string
): string {
  return value ? labels[value] ?? value : fallback
}

/**
 * A three-tier setting: `inherit` plus this setting's own values.
 *
 * ⛔ **`inherit` names what it resolves to, in both places and differently.** The menu entry reads
 * `inherit (await human)` so that choosing it is an informed choice, while the button reads
 * `await human` alone — what is actually in effect, which is what somebody scanning the pane is
 * asking. That asymmetry is `displayLabel`, and it is why this returns three things rather than two.
 */
export function tieredChoice(
  current: string,
  inherited: string,
  choices: SettingOption[]
): SettingChoice {
  return {
    value: current,
    options: [{ value: 'inherit', label: `inherit (${inherited})` }, ...choices],
    ...(current === 'inherit' ? { displayLabel: inherited } : {})
  }
}

/** What happens to this task's work when it is done. */
export function finishChoice(task: Task, inherited: ResolvedFinishPolicy | undefined): SettingChoice {
  return tieredChoice(
    task.finishPolicy,
    inheritedLabel(FINISH_LABELS, inherited?.policy, 'agent lands it'),
    FINISH_ORDER.map((p) => ({ value: p, label: FINISH_LABELS[p] }))
  )
}

/** Whether this task may borrow a conversation somebody else has been having. */
export function sharingChoice(task: Task, inherited: ResolvedSessionSharing | undefined): SettingChoice {
  return tieredChoice(
    task.sessionSharing,
    inheritedLabel(SHARING_LABELS, inherited?.sharing, 'always start a new one'),
    [
      { value: 'on', label: 'reuse one if possible' },
      { value: 'off', label: 'always start a new one' }
    ]
  )
}

/** How far the agent is expected to get before it stops. */
export function completionChoice(
  task: Task,
  inherited: ResolvedCompletionMode | undefined
): SettingChoice {
  return tieredChoice(
    task.completionMode,
    inheritedLabel(COMPLETION_LABELS, inherited?.mode, 'run to the end'),
    [
      { value: 'autonomous', label: 'run to the end' },
      { value: 'checkpointed', label: 'check in at each phase' }
    ]
  )
}

/** Whether the cache clock may spend a `/compact` on this task's conversation. */
export function compactionChoice(task: Task, inherited: ResolvedAutoCompact | undefined): SettingChoice {
  return tieredChoice(
    task.autoCompact,
    inheritedLabel(AUTO_COMPACT_LABELS, inherited?.autoCompact, AUTO_COMPACT_LABELS.on),
    [
      { value: 'on', label: AUTO_COMPACT_LABELS.on },
      { value: 'off', label: AUTO_COMPACT_LABELS.off }
    ]
  )
}

/** The queue order. ⚠️ Four fixed rungs and no `inherit`: every task has a priority of its own. */
export function priorityChoice(task: Task): SettingChoice {
  return {
    value: task.priority,
    options: (['P0', 'P1', 'P2', 'P3'] as const).map((p) => ({ value: p, label: p }))
  }
}

/**
 * The objective picker, which is the one that cannot read its own value off the task.
 *
 * ⚠️ `task.objective` is a preset name, *a weight vector*, or absent — three shapes for one control.
 * A vector that matches a preset is shown as that preset; one that does not is `custom`, and
 * `custom` is offered as an option only while it is the answer, because it is not something an
 * operator can choose here (the weights come from the composer).
 */
export function objectiveChoice(
  // ⚠️ Widened past `Task['objective']` on purpose: the type says a task always has one, and a
  // detail payload from an older daemon does not. Absent means `inherit`, which is the answer.
  objective: Task['objective'] | null | undefined,
  inherited: Objective | undefined
): SettingChoice {
  const preset = inherited ? presetOf(inherited) : null
  const label =
    preset ??
    (inherited
      ? `${Math.round(inherited.cost * 100)}%/${Math.round(inherited.velocity * 100)}%/${Math.round(inherited.quality * 100)}%`
      : 'balanced')
  const current =
    typeof objective === 'string' ? objective : objective ? presetOf(objective) ?? 'custom' : 'inherit'

  return tieredChoice(current, label, [
    ...OBJECTIVE_PRESET_ORDER.map((p) => ({ value: p, label: p })),
    ...(current === 'custom' ? [{ value: 'custom', label: 'custom' }] : [])
  ])
}

/**
 * Which accounts this task may be pinned to.
 *
 * ⛔ Only accounts that are enabled *and* hold the work role. A judgment-only or `none` account can
 * never be handed this task, so offering it would be offering a pin the scheduler will not honour.
 * ⚠️ Not a three-tier setting: the empty value is *auto*, not *inherit* — there is no tier above a
 * task here, only the scheduler's own choice.
 */
export function workerChoice(task: Task, fleet: FleetEntry[]): SettingChoice {
  return {
    value: task.constraints.workerId ?? '',
    options: [
      { value: '', label: 'Auto — scheduler choice' },
      ...fleet
        .filter((e) => e.worker.enabled && canWork(e.worker.role))
        .map((e) => ({ value: e.worker.id, label: e.worker.label }))
    ]
  }
}

/** Which account last ran this task, named if the fleet still lists it and abbreviated if not. */
export function ranOnLabel(task: Task, fleet: FleetEntry[]): string | null {
  if (!task.ranOn) return null
  return fleet.find((f) => f.worker.id === task.ranOn)?.worker.label ?? task.ranOn.slice(0, 8)
}
