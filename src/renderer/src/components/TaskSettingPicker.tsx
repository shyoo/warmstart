import React from 'react'
import { SettingButtonSelect } from './SettingButtonSelect'
import { useAction } from '../lib/useAction'
import type { SettingChoice } from '../lib/threadview'

/**
 * One setting on a task, chosen from a menu and written straight through to the daemon.
 *
 * ⛔ **One component, seven uses.** The thread's finish, conversation, completion, compaction,
 * objective, worker and priority controls were seven copies of this shape — the same `useAction`,
 * the same `disabled={busy}`, the same note under the button — differing only in which RPC they
 * called and what they offered. What varies is passed in: the menu comes from
 * [`lib/threadview.ts`](../lib/threadview.ts), which is pure and tested, and the write comes from
 * `save`, which each call site still spells out so the RPC and its payload stay typed by name
 * rather than assembled from a string.
 *
 * ⚠️ **The note is not decoration.** Two of the seven copies dropped `note` on the floor, so a
 * failed pin or a rejected priority looked exactly like a successful one. Every use draws it now.
 */
export function TaskSettingPicker<Result>({
  choice,
  ariaLabel,
  title,
  save,
  successNote,
  onChanged,
  disabled = false,
  footer
}: {
  choice: SettingChoice
  ariaLabel: string
  title: string
  /** ⚠️ Takes the option's raw `value`; the call site narrows it to that setting's own choice type. */
  save: (value: string) => Promise<Result>
  successNote?: (result: Result) => string | null
  onChanged?: () => Promise<void>
  /** Over and above `busy` — for a setting the agent on this task cannot honour. */
  disabled?: boolean
  /** Drawn under the control, for the one caller that has something to add. */
  footer?: React.ReactNode
}): React.JSX.Element {
  const { busy, note, run: choose } = useAction(save, {
    ...(successNote ? { successNote } : {}),
    ...(onChanged ? { onSuccess: onChanged } : {})
  })

  return (
    <>
      <SettingButtonSelect
        value={choice.value}
        options={choice.options}
        disabled={busy || disabled}
        ariaLabel={ariaLabel}
        title={title}
        displayLabel={choice.displayLabel}
        onChange={(value) => void choose(value)}
      />
      {note && <div className="note">{note}</div>}
      {footer}
    </>
  )
}
