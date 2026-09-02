/**
 * Putting the window on the screen, whatever the compositor decides to do.
 *
 * ⛔ **`ready-to-show` is not guaranteed, and relying on it alone loses the app entirely.** It is
 * emitted after the renderer's *first frame*, and a window created with `show: false` has never
 * been composited — so on a GPU path that declines to paint one, the event simply never arrives.
 *
 * Measured on Windows 11, Electron 44, 2026-09-01, against the packaged app and the built main
 * bundle alike: `dom-ready` at 69ms, `did-finish-load` at 72ms, `ready-to-show` **never** — not at
 * 8s, not at 20s. The same build with `--disable-gpu` fired it at 66ms and showed at 90ms. The
 * process stayed alive and healthy throughout, holding the single-instance lock with nothing on
 * screen.
 *
 * ⚠️ That is why the app appeared to need a *second* click: the second launch lost the lock, the
 * first instance's `second-instance` handler called `showWindow()`, and that calls `show()`
 * unconditionally. The first click had already started the app — it just had no window.
 *
 * So `ready-to-show` stays the *preferred* trigger and the rest are backstops. First one wins:
 *
 *   - `ready-to-show` — it painted. Show it; this is the ideal and the ordinary path.
 *   - `did-finish-load` — it loaded but has not painted. Showing now is safe rather than ugly
 *     because `backgroundColor` already matches `--color-bg`, so the window is the app's own dark
 *     ground for the frame or two before React lands, not a white flash.
 *   - `did-fail-load` on the **main frame** — nothing will paint and nothing more will load. An
 *     error an operator can see beats a process they cannot. ⚠️ Subframe failures are ignored: a
 *     failed image or iframe is not a reason to show a half-built window early.
 *   - a last-resort timer — covers a load that neither finishes nor fails.
 *
 * ⛔ This module deliberately imports nothing from Electron, so the contract above is a unit test
 * rather than a claim. What it cannot test is the compositor; what it can test is that no single
 * event is load-bearing.
 */

/** The parts of a `BrowserWindow` this needs, named so a test can supply them. */
export interface Showable {
  show: () => void
  isDestroyed: () => boolean
  onReadyToShow: (fn: () => void) => void
  onDidFinishLoad: (fn: () => void) => void
  onDidFailLoad: (fn: (isMainFrame: boolean) => void) => void
  onClosed: (fn: () => void) => void
}

/** How long to wait for a load that neither finishes nor fails before showing the window anyway. */
export const SHOW_FALLBACK_MS = 5_000

export function showWhenItCan(win: Showable, fallbackMs: number = SHOW_FALLBACK_MS): void {
  let shown = false
  const timer = setTimeout(() => reveal(), fallbackMs)
  // ⚠️ Never keeps the process alive on its own account. The timer exists to rescue a launch, not
  // to hold an app open that has otherwise finished.
  timer.unref?.()

  function reveal(): void {
    if (shown) return
    shown = true
    clearTimeout(timer)
    // ⛔ The window can be closed before anything paints, and `show()` on a destroyed native object
    // throws out of Electron's own emit — the same failure the `closed` handler in index.ts is
    // careful about.
    if (!win.isDestroyed()) win.show()
  }

  win.onReadyToShow(reveal)
  win.onDidFinishLoad(reveal)
  win.onDidFailLoad((isMainFrame) => {
    if (isMainFrame) reveal()
  })
  win.onClosed(() => clearTimeout(timer))
}
