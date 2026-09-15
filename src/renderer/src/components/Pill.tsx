import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, type MenuPlacement } from '../lib/menuposition'

/**
 * One setting, drawn as a word you can click.
 *
 * ⛔ **Not a `<select>`.** The composer carries eight of them under a prompt box, and a native
 * picker is sized by its widest option, draws its own chrome, and opens an OS menu that lands
 * wherever the platform decides. Eight of those is the cluttered row this replaced. A pill is as
 * wide as the answer it is currently showing, and the menu is elements this app draws — so it can
 * hold a list of tasks, a date field, or anything else a setting needs to be chosen with.
 *
 * ⛔ **The menu is rendered into a portal, not into the pill.** It used to be an absolutely
 * positioned child of `.pill-wrap`, which meant any ancestor with a scroll container in it clipped
 * the menu at that ancestor's edge — and the composer's Plan & Split row is exactly that
 * (`overflow-x: auto` makes a box a scroll container in both axes). A Finish or Workers menu opened
 * there was cut off a few pixels tall and the options underneath could not be reached at all. Out at
 * the document root nothing can clip it; `menuPosition` then places it against the button, flipping
 * above when the window has no room below, which is the usual case for a composer near the bottom.
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
   * Null until the menu has been measured once.
   *
   * ⛔ Rendered invisible for that first frame rather than at (0,0): a menu that paints in the corner
   * and then jumps to its pill is a flash the eye follows, and this is a control people open dozens
   * of times per task.
   */
  const [place, setPlace] = useState<MenuPlacement | null>(null)
  /**
   * ⚠️ Focus goes back to the button *after* the menu has gone, in an effect rather than in the
   * closing call. Dismissing with Escape or picking an option destroys the element focus is
   * currently on, and a browser left to resolve that on its own drops focus to `<body>` — which
   * means the next Tab starts again from the top of the page instead of from the pill you were on.
   */
  const [returnFocus, setReturnFocus] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const close = useCallback(() => {
    setOpen(false)
    setReturnFocus(true)
  }, [])

  /**
   * Measure the button and the menu, and put the menu where both fit.
   *
   * ⚠️ The menu is measured *unconstrained* — `maxHeight` from a previous pass is cleared before
   * reading `scrollHeight` — or a menu that was once clamped short would stay short after the window
   * grew or the pill moved up.
   */
  const reposition = useCallback(() => {
    const button = buttonRef.current
    const menu = menuRef.current
    if (!button || !menu) return
    const anchor = button.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.scrollHeight
    setPlace(
      menuPosition(
        { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        align
      )
    )
  }, [align])

  // ⛔ Before paint, so the menu is never seen in the wrong place.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    reposition()
  }, [open, reposition])

  // ⚠️ Scrolling *anything* moves the pill, so the listener is on the capture phase: a scroll inside
  // the composer's own row does not bubble to the window.
  useEffect(() => {
    if (!open) return
    const onMove = (): void => reposition()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, reposition])

  useEffect(() => {
    if (open || !returnFocus) return
    buttonRef.current?.focus()
    setReturnFocus(false)
  }, [open, returnFocus])

  useEffect(() => {
    if (!open) return
    // ⚠️ `pointerdown`, not `click`: a click on another pill's button would otherwise toggle that one
    // open in the same gesture that closed this one, which reads as the menu jumping sideways.
    // ⛔ Both elements, because the menu is no longer inside the wrapper. Checking only the wrapper
    // made every click *inside the menu* read as a click outside it.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
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
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className={`pill-menu${place ? ` pill-menu--${place.placement}` : ' pill-menu--measuring'}`}
            role="presentation"
            style={
              place
                ? { left: place.left, top: place.top, maxHeight: place.maxHeight }
                : { left: 0, top: 0, visibility: 'hidden' }
            }
          >
            {menu(close)}
          </div>,
          document.body
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

export interface SegmentOption {
  value: string
  /** Short: every option is visible at once, so all of them share the composer's one line. */
  label: string
  title?: string
}

/**
 * One setting out of two or three, drawn as a joined button group with the answer highlighted.
 *
 * ⛔ **Not a `PillSelect`.** A pill shows only the current answer and hides the rest in a menu,
 * which is right for eight options and wrong for two: the choice the operator is really making on
 * the new-task composer is *worktree or trunk*, and hiding one half of it behind a click is how a
 * trunk job gets filed by someone who never saw the alternative. Every option stays visible; the
 * selected one carries `aria-pressed` and the highlight.
 *
 * ⛔ No portal, no menu, no keyboard handling to duplicate: the options are buttons in a group,
 * so Tab and Space already do the whole job.
 */
export function SegmentedControl({
  ariaLabel,
  title,
  value,
  options,
  onChange,
  muted
}: {
  ariaLabel: string
  title?: string
  value: string
  options: SegmentOption[]
  onChange: (value: string) => void
  /**
   * The shown answer is a default rather than a choice — same colour rule as `Pill`'s `muted`,
   * and the tooltip still names the tier it came from.
   */
  muted?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`seg${muted ? ' seg--muted' : ''}`}
      role="group"
      aria-label={ariaLabel}
      title={title}
    >
      {options.map((opt) => {
        const on = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            className={`seg-btn${on ? ' seg-btn--on' : ''}`}
            aria-pressed={on}
            title={opt.title}
            onClick={() => {
              if (!on) onChange(opt.value)
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
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
