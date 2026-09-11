import { describe, expect, it } from 'vitest'
import { bubbleSide, promptMessageId } from './threadbubble'
import type { TaskMessage } from '@shared/tasks'

describe('thread bubbles', () => {
  it('puts only human messages on the right', () => {
    expect(bubbleSide('human')).toBe('right')
    expect(bubbleSide('agent')).toBe('left')
    expect(bubbleSide('controller')).toBe('left')
    expect(bubbleSide('system')).toBe('left')
  })
  it('attaches a prompt to the last agent answer for its run', () => {
    const messages = [
      { id: 1, runId: 'r', role: 'system' }, { id: 2, runId: 'r', role: 'agent' }, { id: 3, runId: 'r', role: 'agent' }
    ] as TaskMessage[]
    expect(promptMessageId(messages, 'r')).toBe(3)
    expect(promptMessageId(messages.slice(0, 1), 'r')).toBe(1)
  })
})
