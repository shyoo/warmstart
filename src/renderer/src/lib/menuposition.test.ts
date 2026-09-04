import { describe, expect, it } from 'vitest'
import { menuPosition } from './menuposition'

/**
 * Where a pill menu lands.
 *
 * ⛔ The case the operator hit is the first one: a composer sitting near the bottom of the window,
 * whose menus were clipped to nothing. Every assertion here is about a menu staying *inside the
 * window* — the guarantee the portal exists to provide, and the one no ancestor can take away.
 */

const viewport = { width: 1200, height: 800 }

describe('menuPosition', () => {
  it('hangs a menu below its pill when there is room', () => {
    const at = menuPosition(
      { left: 100, top: 100, width: 80, height: 24 },
      { width: 240, height: 200 },
      viewport
    )
    expect(at.placement).toBe('below')
    expect(at.top).toBe(128)
    expect(at.left).toBe(100)
    expect(at.maxHeight).toBe(200)
  })

  it('flips above a pill near the bottom rather than clamping it to a sliver', () => {
    // The composer's own geometry: a pill 40px from the bottom of an 800px window.
    const at = menuPosition(
      { left: 100, top: 736, width: 80, height: 24 },
      { width: 240, height: 300 },
      viewport
    )
    expect(at.placement).toBe('above')
    // Entirely above the pill, and clear of the top of the window.
    expect(at.top).toBeGreaterThanOrEqual(8)
    expect(at.top + at.maxHeight).toBeLessThanOrEqual(736)
  })

  it('never lets a flipped menu run off the top of the window', () => {
    const at = menuPosition(
      { left: 10, top: 700, width: 80, height: 24 },
      { width: 240, height: 5000 },
      viewport
    )
    expect(at.top).toBeGreaterThanOrEqual(8)
    expect(at.maxHeight).toBeLessThanOrEqual(700)
  })

  it('scrolls itself rather than overflowing when neither side has room', () => {
    const at = menuPosition(
      { left: 10, top: 380, width: 80, height: 24 },
      { width: 240, height: 4000 },
      { width: 1200, height: 800 }
    )
    expect(at.maxHeight).toBeLessThan(4000)
    expect(at.top + at.maxHeight).toBeLessThanOrEqual(800)
  })

  it('keeps a right-aligned menu on a pill at the right edge inside the window', () => {
    const at = menuPosition(
      { left: 1150, top: 100, width: 40, height: 24 },
      { width: 380, height: 200 },
      viewport,
      'right'
    )
    expect(at.left).toBeGreaterThanOrEqual(8)
    expect(at.left + 380).toBeLessThanOrEqual(1200 - 8 + 1)
  })

  it('pulls a left-aligned menu back when the pill is close to the right edge', () => {
    const at = menuPosition(
      { left: 1100, top: 100, width: 60, height: 24 },
      { width: 300, height: 120 },
      viewport
    )
    expect(at.left).toBe(1200 - 300 - 8)
  })

  it('does not flip into a space that is no better', () => {
    // A pill at the very top: below is small, above is smaller. Flipping would only move the problem.
    const at = menuPosition(
      { left: 10, top: 20, width: 60, height: 24 },
      { width: 240, height: 900 },
      viewport
    )
    expect(at.placement).toBe('below')
  })
})
