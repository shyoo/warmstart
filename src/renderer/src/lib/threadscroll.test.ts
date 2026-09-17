import { describe, expect, it } from 'vitest'
import { isNearThreadBottom, shouldJumpToThreadBottom } from './threadscroll'

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

describe('isNearThreadBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isNearThreadBottom(1000, 700, 300)).toBe(true)
  })

  it('is true within the slack threshold', () => {
    expect(isNearThreadBottom(1000, 690, 300)).toBe(true)
  })

  it('is false once scrolled meaningfully away from the bottom', () => {
    expect(isNearThreadBottom(1000, 400, 300)).toBe(false)
  })

  it('honours a custom threshold', () => {
    expect(isNearThreadBottom(1000, 650, 300, 100)).toBe(true)
    expect(isNearThreadBottom(1000, 650, 300, 10)).toBe(false)
  })
})
