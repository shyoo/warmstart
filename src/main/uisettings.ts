import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_UI_SETTINGS, type UiSettings } from '@shared/ipc.js'

export { DEFAULT_UI_SETTINGS }

/**
 * The preferences the **app** owns, as opposed to the ones the fleet owns.
 *
 * ⛔ Deliberately not in the daemon's `settings` table, and the reason is not tidiness. This governs
 * whether the daemon keeps running at all, so main has to be able to read it **when the daemon is
 * unreachable** — which is exactly the moment it matters. A setting whose enforcement depends on the
 * thing it controls being alive is not a setting, it is a wish.
 *
 * ⚠️ It is also per-install rather than per-fleet: two machines pointed at the same account can
 * reasonably disagree about whether closing a window should leave a scheduler running.
 */

function file(): string {
  return join(app.getPath('userData'), 'ui-settings.json')
}

/** ⚠️ Never throws. A preference file that cannot be read is a default, never a failed launch. */
export function readUiSettings(): UiSettings {
  try {
    const path = file()
    if (!existsSync(path)) return { ...DEFAULT_UI_SETTINGS }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UiSettings>
    // ⛔ Field by field, with the default as the fallback: a file written by a newer build, or by
    // somebody's text editor, must not be able to put a non-boolean into a branch that decides
    // whether a fleet keeps running.
    return {
      tray: typeof parsed.tray === 'boolean' ? parsed.tray : DEFAULT_UI_SETTINGS.tray,
      enterBehavior:
        parsed.enterBehavior === 'send' || parsed.enterBehavior === 'newline'
          ? parsed.enterBehavior
          : DEFAULT_UI_SETTINGS.enterBehavior,
      theme:
        parsed.theme === 'system' || parsed.theme === 'light' || parsed.theme === 'dark'
          ? parsed.theme
          : DEFAULT_UI_SETTINGS.theme
    }
  } catch {
    return { ...DEFAULT_UI_SETTINGS }
  }
}

export function writeUiSettings(next: UiSettings): UiSettings {
  try {
    const path = file()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // The setting still applies to this run; it just will not survive a restart.
  }
  return next
}
