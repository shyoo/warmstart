import { describe, expect, it } from 'vitest'
import { shouldJumpToThreadBottom } from './threadscroll'

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
