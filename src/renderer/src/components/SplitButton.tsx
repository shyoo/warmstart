import React from 'react'
import { Pill, PillOptions, type PillOption } from './Pill'

/**
 * An action button with a second answer behind a ▼.
 *
 * ⛔ **A button, not a picker, and the distinction is the whole reason this exists.** The Commit and
 * Land controls were `SettingButtonSelect`s — the dark rounded pill with a ✒️ on it that every
 * *setting* in this app wears — sitting in a column next to Finish (green) and Stop (red). Two
 * things followed. They did not read as buttons at all, so the one row on the card that spends a
 * turn looked like a dropdown somebody had left in the wrong column; and a picker has no default
 * action, so pressing it could only ever open a list. What an operator wants from Commit is to press
 * Commit.
 *
 * ⭐ **So the common answer is the button and the rest are behind the arrow.** The main half does the
 * thing with the level this task would use anyway (`defaultLevel`); the ▼ half opens the same ladder
 * for the press that wants something else. The chosen level is not stored — each press is one
 * decision about one branch — which is why the menu is a list of *actions* and picking the level
 * already shown still acts.
 *
 * ⚠️ Built on `Pill`, not on a menu of its own. That component already owns the portal, the flip
 * when there is no room below, the pointer-down dismissal and the arrow keys, and a second copy of
 * any of that is a second place for it to be wrong. What is new here is only the shape and the
 * colour, which are CSS.
 */
export function SplitButton({
  label,
  tone,
  options,
  value,
  onAct,
  disabled = false,
  title,
  ariaLabel,
  menuAriaLabel,
  className
}: {
  /** The verb, and it has to be one word: this column is 110px wide. */
  label: string
  /**
   * Which of the fleet's button colours this action wears.
   *
   * ⛔ Never `ok` or `danger`. Those two are spoken for on this very card — green finishes the task,
   * red stops it — and an action that neither finishes nor stops must not borrow either.
   */
  tone: 'warn' | 'primary'
  options: PillOption[]
  /** The level the main half acts with, and the one the menu ticks. */
  value: string
  onAct: (value: string) => void
  disabled?: boolean
  title?: string
  ariaLabel: string
  menuAriaLabel: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={`split-btn split-btn--${tone}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`btn btn--${tone} split-btn-main`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onClick={() => onAct(value)}
      >
        {label}
      </button>
      {/* ⚠️ Opens leftwards: this column is the left edge of a narrow card, but the menu is far wider
          than the button it hangs off, and anchoring it to the arrow's own left edge would push a
          320px list across the sentence beside it. */}
      <Pill
        className="split-btn-more"
        ariaLabel={menuAriaLabel}
        title={menuAriaLabel}
        disabled={disabled}
        align="left"
        label={<span aria-hidden="true">▼</span>}
        menu={(close) => (
          <PillOptions
            options={options}
            value={value}
            ariaLabel={menuAriaLabel}
            onPick={(next) => {
              close()
              // ⛔ Always, even when it is the level already shown. This is an action: re-picking it
              // means *do it with this one*, where a setting re-picking its own value means nothing.
              onAct(next)
            }}
          />
        )}
      />
    </div>
  )
}
