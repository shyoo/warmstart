import { join } from 'node:path'

/**
 * The file a native tray uses, rather than the icon compiled into the executable.
 *
 * ⛔ Electron's Windows tray does not inherit the executable icon. It needs a runtime `.ico`, and
 * `buildResources` only supplies electron-builder while packaging — it does not copy a file beside
 * the packaged app. Keep the path choice separate from Electron so this packaging contract is
 * testable without creating a system tray icon.
 */
export function trayIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string,
  dirname: string
): string {
  const file = platform === 'win32' ? 'icon.ico' : 'icon.png'
  return packaged ? join(resourcesPath, file) : join(dirname, '..', '..', 'resources', file)
}
