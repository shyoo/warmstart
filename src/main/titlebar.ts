import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * How much of the window's caption area Electron draws, and how much the renderer does.
 *
 * ⛔ **`titleBarStyle: 'default'` is the bug this exists to prevent.** The renderer draws a title
 * bar of its own — panel, history, refresh, zoom, the app name and the global **New task** — and
 * with a native caption above it the window has *two* title bars, one of them empty (t354 shipped
 * exactly that; t356 fixed it). The row is only chrome if it replaces the caption rather than
 * hanging under it.
 *
 * ⛔ **`titleBarStyle`, never `frame: false`.** A frameless window on Windows loses the native
 * resize borders and the snap gestures with them; a hidden title bar keeps both.
 *
 * ⚠️ **Linux keeps its own frame.** `titleBarOverlay` is Windows and macOS only, so `'hidden'`
 * there would leave a window with no close button and nothing drawing one — worse than a spare row.
 * The renderer's strip reserves no caption width on that platform, which is what
 * `env(titlebar-area-*)` being absent already tells it.
 */
export const TITLEBAR_HEIGHT = 36

export function captionOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'linux') return { titleBarStyle: 'default' }
  return {
    // `hiddenInset` on macOS: the traffic lights stay, inset from the corner, and the renderer is
    // told where they end by `env(titlebar-area-x)`.
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: {
      // Matches --color-surface and --color-text-dim in tokens.css, so the native buttons sit in
      // the same strip the renderer paints rather than on a light patch of their own.
      // ⚠️ Ignored on macOS, which takes only the height — the traffic lights are system-drawn.
      color: '#16191e',
      symbolColor: '#9aa1ad',
      height: TITLEBAR_HEIGHT
    }
  }
}
