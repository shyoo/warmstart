import { useCallback, useEffect, useRef, useState } from 'react'
import { appKey } from '../lib/storagekeys'

/**
 * The handle between two columns of the shell: the sidebar and the work, or the work and the
 * Diff pane.
 *
 * ⛔ **It writes one CSS variable and nothing else.** `--sidebar-w` already drove
 * `grid-template-columns`, so the layout needs no new concept and no component below here has to
 * know the sidebar can move. Threading a width through props would have put a re-render of the whole
 * shell on every mouse move. The Diff pane's handle does the same with `--diffpane-w`.
 *
 * ⚠️ The width is a **per-display preference, not a fleet setting**, so it lives in `localStorage`
 * rather than in the daemon's `settings` table. That table is for things that change what the app
 * *does* - `autoCompact` gates spending - and every row in it is one more thing an operator has to
 * reason about when a session behaves unexpectedly. How wide a pane is on this monitor is not that.
 */

/** 252px is the default: the width that fits the longest route and project names on one row. */
export const SIDEBAR_DEFAULT = 252

/**
 * ⛔ Both bounds are real, not decoration. Below `MIN` the nav items truncate to uselessness. Above
 * `MAX` the sidebar starts eating the pane the work is actually in - and on a narrow window, a drag
 * that could hide the content entirely is a state with no way back except a reset the user has to
 * guess at.
 */
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520

export interface PaneResizerSpec {
  /** The CSS custom property the width is written to, on the root element. */
  variable: string
  /** The `localStorage` name the width is remembered under, without the app prefix. */
  storage: string
  defaultPx: number
  min: number
  /** A number, or a function of the window's width for a pane that may not eat the work. */
  max: number | (() => number)
  /**
   * Which window edge the pane hangs from. A `left` pane's width is the pointer's x; a `right`
   * pane's is the window's width minus it.
   */
  edge: 'left' | 'right'
  label: string
  /** Added beside `.resizer`, so a test can tell the two handles apart. */
  className?: string
}

/**
 * ⚠️ Every read is guarded. `localStorage` throws rather than returning null in a few real
 * situations - a browser set to block site data, some embedded contexts - and a shell that fails to
 * render because it could not recall a pane width would be a spectacular trade.
 */
function stored(key: string, fallback: number, clamp: (px: number) => number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : fallback
  } catch {
    return fallback
  }
}

function remember(key: string, px: number): void {
  try {
    window.localStorage.setItem(key, String(px))
  } catch {
    // A preference that cannot be saved is still a preference for this session.
  }
}

export function PaneResizer({ spec }: { spec: PaneResizerSpec }): React.JSX.Element {
  const key = appKey(spec.storage)
  const maxNow = useCallback(
    (): number => (typeof spec.max === 'function' ? spec.max() : spec.max),
    [spec]
  )
  const clamp = useCallback(
    (px: number): number => Math.min(maxNow(), Math.max(spec.min, Math.round(px))),
    [maxNow, spec.min]
  )
  const [width, setWidth] = useState(() => stored(key, spec.defaultPx, clamp))
  const dragging = useRef(false)

  // ⛔ Written to the root element, not to `.shell`, because that is where the variable is defined.
  // Setting it on a descendant would work until somebody read the variable from anywhere else.
  useEffect(() => {
    document.documentElement.style.setProperty(spec.variable, `${width}px`)
  }, [spec.variable, width])

  const commit = useCallback(
    (px: number) => {
      const next = clamp(px)
      setWidth(next)
      remember(key, next)
    },
    [clamp, key]
  )

  /**
   * ⚠️ Pointer capture, not a window-level listener. Without it, a drag that outruns the pointer -
   * which happens the moment the width clamps and the handle stops following the cursor - loses the
   * mousemove to whatever is underneath, and the sidebar sticks mid-drag.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    // A pane at the window's left edge: the pointer's x *is* the width. At the right edge, the
    // rest of the window is.
    setWidth(clamp(spec.edge === 'left' ? e.clientX : window.innerWidth - e.clientX))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    // ⚠️ Saved on release, never on move: `localStorage` is synchronous, and writing it sixty times
    // a second turns a smooth drag into a stuttering one.
    remember(key, width)
  }

  /**
   * ⛔ Keyboard-operable, and this is not box-ticking. A pointer-only resizer is unusable to anyone
   * who cannot make a 4px drag - and `role="separator"` with a `tabindex` is a promise that arrow
   * keys work, so the promise has to be kept. ⚠️ The arrows follow the pane, not the pointer: right
   * widens a left-edge pane and narrows a right-edge one, which is the direction its border moves.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = (e.shiftKey ? 32 : 8) * (spec.edge === 'left' ? 1 : -1)
    if (e.key === 'ArrowLeft') commit(width - step)
    else if (e.key === 'ArrowRight') commit(width + step)
    else if (e.key === 'Home') commit(spec.min)
    else if (e.key === 'End') commit(maxNow())
    else return
    e.preventDefault()
  }

  return (
    <div
      className={`resizer${spec.className ? ` ${spec.className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={spec.label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={maxNow()}
      tabIndex={0}
      title="Drag to resize · double-click to reset · arrow keys when focused"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // A way back that needs no guessing, for the drag that went somewhere unhelpful.
      onDoubleClick={() => commit(spec.defaultPx)}
      onKeyDown={onKeyDown}
    />
  )
}

const SIDEBAR_SPEC: PaneResizerSpec = {
  variable: '--sidebar-w',
  storage: 'sidebarWidth',
  defaultPx: SIDEBAR_DEFAULT,
  min: SIDEBAR_MIN,
  max: SIDEBAR_MAX,
  edge: 'left',
  label: 'Sidebar width'
}

export function SidebarResizer(): React.JSX.Element {
  return <PaneResizer spec={SIDEBAR_SPEC} />
}
