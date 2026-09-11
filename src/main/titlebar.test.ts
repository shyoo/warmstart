import { describe, expect, it } from 'vitest'
import { captionOptions, TITLEBAR_HEIGHT } from './titlebar.js'

describe('the caption area', () => {
  it('hides the native title bar where the renderer draws one', () => {
    // ⛔ The regression this pins: `default` here puts the app's own title bar *under* a native
    // one and the window carries two.
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const options = captionOptions(platform)
      expect(options.titleBarStyle).not.toBe('default')
      expect(options.titleBarOverlay).toBeTruthy()
    }
  })

  it('keeps the native window controls, at the height the renderer reserves', () => {
    const overlay = captionOptions('win32').titleBarOverlay
    expect(typeof overlay === 'object' && overlay?.height).toBe(TITLEBAR_HEIGHT)
    // macOS draws its own traffic lights inset from the corner.
    expect(captionOptions('darwin').titleBarStyle).toBe('hiddenInset')
  })

  it('leaves Linux its own frame, because no overlay would draw the buttons there', () => {
    expect(captionOptions('linux')).toEqual({ titleBarStyle: 'default' })
  })
})
