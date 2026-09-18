import { describe, expect, it } from 'vitest'
import { isNearPageBottom, shouldJumpToThreadBottom } from './threadscroll'

describe('shouldJumpToThreadBottom', () => {
  it('jumps when no task has been jumped for yet', () => {
    expect(shouldJumpToThreadBottom(null, 'task-a')).toBe(true)
  })

  it('does not jump again for the task it already jumped for', () => {
    expect(shouldJumpToThreadBottom('task-a', 'task-a')).toBe(false)
  })

  it('jumps when a different task is opened', () => {
    expect(shouldJumpToThreadBottom('task-a', 'task-b')).toBe(true)
  })
})

describe('isNearPageBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isNearPageBottom(1000, 700, 300)).toBe(true)
  })

  it('is true within the slack threshold', () => {
    expect(isNearPageBottom(1000, 690, 300)).toBe(true)
  })

  it('is false once scrolled meaningfully away from the bottom', () => {
    expect(isNearPageBottom(1000, 400, 300)).toBe(false)
  })

  it('does not call the shorter thread bottom the page bottom when an adjacent pane continues', () => {
    // The thread anchor is already visible at y=800, but the taller right pane makes the whole
    // page 1,400px high. At this position 400px remain reachable below the viewport.
    expect(isNearPageBottom(1400, 500, 500)).toBe(false)
  })

  it('honours a custom threshold', () => {
    expect(isNearPageBottom(1000, 650, 300, 100)).toBe(true)
    expect(isNearPageBottom(1000, 650, 300, 10)).toBe(false)
  })
})
