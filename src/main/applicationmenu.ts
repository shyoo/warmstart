import type { MenuItemConstructorOptions } from 'electron'

/**
 * Keep the native Edit menu on macOS even though Warmstart draws its own application chrome.
 *
 * Chromium routes the macOS standard editing commands through the application menu. Removing
 * Electron's menu entirely therefore removes ⌘C/⌘V/⌘X from text controls as well; the same fields
 * still accept typed input, which makes this look like a renderer clipboard bug.
 */
export function applicationMenuTemplate(
  platform: NodeJS.Platform
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [{ role: 'appMenu' }, { role: 'editMenu' }]
}
