import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { trayIconPath } from './trayicon.js'

describe('the tray icon', () => {
  it('uses the multi-resolution Windows icon rather than a generated substitute', () => {
    expect(trayIconPath('win32', false, 'C:/app/resources', 'C:/repo/out/main')).toBe(
      join('C:/repo/out/main', '..', '..', 'resources', 'icon.ico')
    )
    expect(trayIconPath('win32', true, 'C:/app/resources', 'C:/repo/out/main')).toBe(
      join('C:/app/resources', 'icon.ico')
    )
  })

  it('uses the runtime PNG on platforms whose tray does not take a Windows icon', () => {
    expect(trayIconPath('linux', true, '/app/resources', '/repo/out/main')).toBe(
      join('/app/resources', 'icon.png')
    )
  })
})
