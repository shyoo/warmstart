/**
 * Where a pill's menu goes, given the button it hangs off and the room the window has.
 *
 * ⛔ **Pure, and separated from the component on purpose.** The menu is rendered into a portal at the
 * document root precisely so that no ancestor can clip it — the composer's Plan & Split row is a
 * horizontal scroller (`overflow-x: auto`), which makes it a scroll container in *both* axes, and a
 * menu positioned inside it was cut off at the row's own height. Once the menu is out of the flow,
 * every decision about where it lands is arithmetic on four rectangles, and arithmetic is the part
 * worth testing without a browser in the way.
 *
 * ⚠️ The viewport is passed in rather than read from `window` for the same reason.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export interface MenuPlacement {
  left: number
  top: number
  /**
   * How tall the menu may be here — the room actually available, never more than it asked for.
   *
   * ⛔ Always a number. A menu taller than the window has to scroll *itself*, because the thing that
   * would otherwise scroll it is the ancestor this whole file exists to escape.
   */
  maxHeight: number
  /** Which side of the button it ended up on, for the caller's own styling and for the tests. */
  placement: 'below' | 'above'
}

/** Kept off the window edges so a menu never looks welded to the frame. */
const MARGIN = 8
/** The button-to-menu gap, matching what the CSS used to add with `top: calc(100% + 4px)`. */
const GAP = 4
/** Below this there is no point flipping: a menu 80px tall is a scroller either way. */
const MIN_USEFUL = 120

/**
 * ⛔ **Flips before it shrinks.** A pill near the bottom of the window — which is where the composer
 * lives — has almost no room below it and the whole window above it, so a menu that merely clamped
 * its height there would render as a two-row scroller under a full-height empty space. Flipping is
 * what makes the bottom-anchored composer usable at all, and it is the case the operator hit.
 */
export function menuPosition(
  anchor: Rect,
  menu: { width: number; height: number },
  viewport: Viewport,
  align: 'left' | 'right' = 'left'
): MenuPlacement {
  const roomBelow = viewport.height - (anchor.top + anchor.height) - GAP - MARGIN
  const roomAbove = anchor.top - GAP - MARGIN

  // Below unless it does not fit and above is genuinely better. ⚠️ `MIN_USEFUL` stops a menu
  // flipping into a space that is just as unusable, which would only move the problem.
  const flip = menu.height > roomBelow && roomAbove > roomBelow && roomAbove >= MIN_USEFUL
  const placement: 'below' | 'above' = flip ? 'above' : 'below'
  const room = Math.max(0, flip ? roomAbove : roomBelow)
  const maxHeight = Math.max(0, Math.min(menu.height || room, room))
  const height = Math.min(menu.height || maxHeight, maxHeight)

  const top = flip ? anchor.top - GAP - height : anchor.top + anchor.height + GAP

  // `right` means *aligned to the button's right edge*, which is what keeps a menu on a pill near the
  // right edge from opening off-screen. The clamp below is the backstop for both.
  const wanted = align === 'right' ? anchor.left + anchor.width - menu.width : anchor.left
  const left = clamp(wanted, MARGIN, Math.max(MARGIN, viewport.width - menu.width - MARGIN))

  return { left, top: Math.max(MARGIN, top), maxHeight, placement }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
