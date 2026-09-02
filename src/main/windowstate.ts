import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

/** Bounds persisted across restarts so the window reopens where the operator left it. */
export type WindowBounds = Rectangle

function file(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** ⚠️ Never throws, and never returns bounds that would open off-screen (e.g. a since-unplugged monitor). */
export function readWindowBounds(): WindowBounds | null {
  try {
    const path = file()
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowBounds>
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number'
    ) {
      return null
    }
    const bounds: WindowBounds = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height }
    const onScreen = screen
      .getAllDisplays()
      .some((d) => rectanglesOverlap(bounds, d.workArea))
    return onScreen ? bounds : null
  } catch {
    return null
  }
}

export function writeWindowBounds(bounds: WindowBounds): void {
  try {
    const path = file()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(bounds, null, 2)}\n`)
  } catch {
    // The window still opened at the right place for this run; it just will not survive a restart.
  }
}

function rectanglesOverlap(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Debounced so a drag or resize does not write to disk on every pixel. */
export function trackWindowBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => writeWindowBounds(win.getBounds()), 500)
  }
  win.on('resize', save)
  win.on('move', save)
}
