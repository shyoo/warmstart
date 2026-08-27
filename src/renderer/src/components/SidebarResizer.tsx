import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The handle between the sidebar and the work.
 *
 * ⛔ **It writes one CSS variable and nothing else.** `--sidebar-w` already drove
 * `grid-template-columns`, so the layout needs no new concept and no component below here has to
 * know the sidebar can move. Threading a width through props would have put a re-render of the whole
 * shell on every mouse move.
 *
 * ⚠️ The width is a **per-display preference, not a fleet setting**, so it lives in `localStorage`
 * rather than in the daemon's `settings` table. That table is for things that change what the app
 * *does* - `autoCompact` gates spending - and every row in it is one more thing an operator has to
 * reason about when a session behaves unexpectedly. How wide a pane is on this monitor is not that.
 */

const STORAGE_KEY = 'multi_agent_controller.sidebarWidth'

/** 252px is the default: the width that fits the app name and three controls on one row. */
export const SIDEBAR_DEFAULT = 252

/**
 * ⛔ Both bounds are real, not decoration. Below `MIN` the nav items truncate to uselessness and the
 * brand row drops its controls, which is the failure `.brand h1` was already fixed once for. Above
 * `MAX` the sidebar starts eating the pane the work is actually in - and on a narrow window, a drag
 * that could hide the content entirely is a state with no way back except a reset the user has to
 * guess at.
 */
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520

function clamp(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

/**
 * ⚠️ Every read is guarded. `localStorage` throws rather than returning null in a few real
 * situations - a browser set to block site data, some embedded contexts - and a shell that fails to
 * render because it could not recall a pane width would be a spectacular trade.
 */
function stored(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

function remember(px: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(px))
  } catch {
    // A preference that cannot be saved is still a preference for this session.
  }
}

export function SidebarResizer(): React.JSX.Element {
  const [width, setWidth] = useState(stored)
  const dragging = useRef(false)

  // ⛔ Written to the root element, not to `.shell`, because that is where `--sidebar-w` is defined.
  // Setting it on a descendant would work until somebody read the variable from anywhere else.
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
  }, [width])

  const commit = useCallback((px: number) => {
    const next = clamp(px)
    setWidth(next)
    remember(next)
  }, [])

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
    // The pane starts at the window's left edge, so the pointer's x *is* the width.
    setWidth(clamp(e.clientX))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    // ⚠️ Saved on release, never on move: `localStorage` is synchronous, and writing it sixty times
    // a second turns a smooth drag into a stuttering one.
    remember(width)
  }

  /**
   * ⛔ Keyboard-operable, and this is not box-ticking. A pointer-only resizer is unusable to anyone
   * who cannot make a 4px drag - and `role="separator"` with a `tabindex` is a promise that arrow
   * keys work, so the promise has to be kept.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 32 : 8
    if (e.key === 'ArrowLeft') commit(width - step)
    else if (e.key === 'ArrowRight') commit(width + step)
    else if (e.key === 'Home') commit(SIDEBAR_MIN)
    else if (e.key === 'End') commit(SIDEBAR_MAX)
    else return
    e.preventDefault()
  }

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset · arrow keys when focused"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // A way back that needs no guessing, for the drag that went somewhere unhelpful.
      onDoubleClick={() => commit(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  )
}
