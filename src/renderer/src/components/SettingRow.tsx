/**
 * One setting, one shape: title, one line saying what the current state does, control on the right.
 *
 * ⛔ Every settings row on every settings page uses this, switches and pickers alike. Before it,
 * each section invented its own arrangement — a switch led its row while a picker sat at the end of
 * a title line, and both were wrapped in a heading that repeated the title underneath it — so a page
 * of ten settings had no column an eye could run down.
 *
 * ⚠️ `description` is one line about the state the control is *in*, not the reasoning behind the
 * setting. Long-form reasoning belongs in `docs/`; a person flipping a switch should not have to
 * re-read a paragraph to find the sentence that changed.
 */
export function SettingRow({
  title,
  description,
  control,
  children
}: {
  title: string
  description: React.ReactNode
  control: React.ReactNode
  /** Rendered full-width under the row, for a control that needs more than its own column. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div>
        <p className="setting-row-title">{title}</p>
        <p className="setting-row-desc">{description}</p>
      </div>
      <div className="setting-row-control">{control}</div>
      {children ? <div className="setting-row-extra">{children}</div> : null}
    </div>
  )
}

/**
 * The switch itself, split out so a row's control column holds one element whatever kind it is.
 *
 * ⛔ `role="switch"` with `aria-checked` is what makes this a control to a screen reader — the
 * visual is entirely track and knob, so without them it is a button with no name and no state.
 */
export function SettingSwitch({
  label,
  on,
  busy,
  onToggle
}: {
  label: string
  on: boolean
  busy: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      className={`switch ${on ? 'switch--on' : ''}`}
      onClick={onToggle}
    >
      <span className="switch-knob" />
    </button>
  )
}
