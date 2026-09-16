import { describe, expect, it } from 'vitest'
import { scrolledPast } from './scrolledpast'

// The `.content` pane's top edge sits under the title bar and the fleet strip; 190px on the
// showcase fleet at 1440×900 (2026-09-16).
const rootTop = 190

describe('scrolledPast — when the ledger peek is owed', () => {
  it('is false while any of the box is still drawn', () => {
    expect(scrolledPast(1170, rootTop)).toBe(false)
    expect(scrolledPast(191, rootTop)).toBe(false)
  })

  it('is true once the box has gone off the top of the scroll container, the edge included', () => {
    expect(scrolledPast(-1347, rootTop)).toBe(true)
    expect(scrolledPast(190, rootTop)).toBe(true)
  })

  it('⛔ is false for a box still below the fold — unread, so nothing to stand in for', () => {
    expect(scrolledPast(2400, rootTop)).toBe(false)
  })
})
