import { useCallback, useEffect, useId, useRef, useState } from 'react'

/**
 * One setting, drawn as a word you can click.
 *
 * ⛔ **Not a `<select>`.** The composer carries eight of them under a prompt box, and a native
 * picker is sized by its widest option, draws its own chrome, and opens an OS menu that lands
 * wherever the platform decides. Eight of those is the cluttered row this replaced. A pill is as
 * wide as the answer it is currently showing, and the menu is elements this app draws — so it can
 * hold a list of tasks, a date field, or anything else a setting needs to be chosen with.
 *
 * ⚠️ **The menu content is a render prop, not a list.** Two of the composer's controls are not
 * one-of-many — prerequisites are a multi-select and the schedule has a custom time in it — and the
 * open/close/dismiss behaviour is the part worth having once. `PillSelect` below is the ordinary
 * case built on top of this.
 */
export function Pill({
  label,
  title,
  ariaLabel,
  muted,
  disabled,
  align = 'left',
  className,
  menu
}: {
  /** What the button reads once the menu is shut. Short: this row has to stay on one line. */
  label: React.ReactNode
  title?: string
  ariaLabel: string
  /**
   * The value shown is a default rather than a choice — inherited from the project or the fleet, or
   * whatever the CLI does on its own.
   *
   * ⛔ A colour, never the word "(inherited)". The distinction is worth showing on every pill and is
   * not worth eleven characters on any of them; the tooltip says which tier it came from for anyone
   * who wants the answer rather than the glance.
   */
  muted?: boolean
  disabled?: boolean
  /** `right` for pills near the right edge, so the menu opens inwards rather than off-screen. */
  align?: 'left' | 'right'
  className?: string
  /** Called with a `close` it may use once it has taken an answer. */
  menu: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /**
   * ⚠️ Focus goes back to the button *after* the menu has gone, in an effect rather than in the
   * closing call. Dismissing with Escape or picking an option destroys the element focus is
   * currently on, and a browser left to resolve that on its own drops focus to `<body>` — which
   * means the next Tab starts again from the top of the page instead of from the pill you were on.
   */
  const [returnFocus, setReturnFocus] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  const close = useCallback(() => {
    setOpen(false)
    setReturnFocus(true)
  }, [])

  useEffect(() => {
    if (open || !returnFocus) return
    buttonRef.current?.focus()
    setReturnFocus(false)
  }, [open, returnFocus])

  useEffect(() => {
    if (!open) return
    // ⚠️ `pointerdown`, not `click`: a click on another pill's button would otherwise toggle that one
    // open in the same gesture that closed this one, which reads as the menu jumping sideways.
    const onPointerDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  // A control that goes away while its menu is open leaves the menu behind otherwise — the effort
  // pill disappears the moment a model with no levels is chosen, and it can be chosen from here.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div ref={wrapRef} className={`pill-wrap${className ? ` ${className}` : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`pill${muted ? ' pill--muted' : ''}${open ? ' pill--open' : ''}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!disabled) setOpen((v) => !v)
        }}
      >
        {label}
      </button>
      {open && (
        <div
          id={menuId}
          className={`pill-menu${align === 'right' ? ' pill-menu--right' : ''}`}
          role="presentation"
        >
          {menu(close)}
        </div>
      )}
    </div>
  )
}

export interface PillOption {
  value: string
  /** What the menu row reads. Longer than the pill's own label on purpose — there is room here. */
  label: string
  /** A second line under the label, for the part of the answer that does not fit in its name. */
  hint?: string
  disabled?: boolean
}

/**
 * The ordinary pill: one value out of a closed list.
 *
 * ⚠️ Choosing has exactly one effect and the menu shuts. There is no separate confirm, on the same
 * reasoning as the dependency picker: a second click that can only ever mean yes is not a
 * safeguard.
 */
export function PillSelect({
  label,
  value,
  options,
  onChange,
  title,
  ariaLabel,
  muted,
  disabled,
  align,
  className
}: {
  label: React.ReactNode
  value: string
  options: PillOption[]
  onChange: (value: string) => void
  title?: string
  ariaLabel: string
  muted?: boolean
  disabled?: boolean
  align?: 'left' | 'right'
  className?: string
}): React.JSX.Element {
  return (
    <Pill
      label={label}
      title={title}
      ariaLabel={ariaLabel}
      muted={muted}
      disabled={disabled}
      align={align}
      className={className}
      menu={(close) => (
        <PillOptions
          options={options}
          value={value}
          ariaLabel={ariaLabel}
          onPick={(next) => {
            close()
            if (next !== value) onChange(next)
          }}
        />
      )}
    />
  )
}

/**
 * The list inside a menu, with the arrow keys wired up.
 *
 * ⛔ Exported because the schedule menu puts a custom-time field *below* the same list of presets,
 * and a second copy of the keyboard handling is a second place for it to be wrong.
 */
export function PillOptions({
  options,
  value,
  ariaLabel,
  onPick
}: {
  options: PillOption[]
  value: string
  ariaLabel: string
  onPick: (value: string) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // ⚠️ Focus lands on the current answer, not the first row: an eight-rung ladder opened with the
  // top rung focused makes the arrow keys walk away from where you already are.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    const current = rows.find((r) => r.dataset.value === value)
    ;(current ?? rows[0])?.focus()
  }, [value])

  const move = (from: HTMLElement, delta: number): void => {
    const list = listRef.current
    if (!list) return
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    const at = rows.indexOf(from as HTMLButtonElement)
    if (at < 0) return
    // Wraps, because a list this short has no bottom worth stopping at.
    rows[(at + delta + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      ref={listRef}
      className="pill-options"
      role="listbox"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(e.target as HTMLElement, e.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      {options.map((opt) => {
        const on = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            data-value={opt.value}
            aria-selected={on}
            disabled={opt.disabled}
            className={`pill-option${on ? ' pill-option--on' : ''}`}
            onClick={() => onPick(opt.value)}
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
      })}
    </div>
  )
}
