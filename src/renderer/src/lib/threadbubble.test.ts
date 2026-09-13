import { describe, expect, it } from 'vitest'
import { bubbleSide, buildThreadItems, promptMessageId } from './threadbubble'
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

  describe('buildThreadItems', () => {
    const promptMsg = { id: 1, role: 'human', text: 'Start task', ts: 100 } as TaskMessage
    const userMsg = { id: 2, role: 'human', text: 'Can you do X?', ts: 200 } as TaskMessage

    it('returns only messages when showLive is false', () => {
      const items = buildThreadItems([promptMsg], [{ text: 'thinking...', ts: 150 }], false)
      expect(items).toEqual([{ kind: 'message', message: promptMsg }])
    })

    it('returns messages and an empty live tail when activity is empty', () => {
      const items = buildThreadItems([promptMsg], [], true)
      expect(items).toEqual([
        { kind: 'message', message: promptMsg },
        { kind: 'activity', id: 'activity-live-tail', lines: [], isLiveTail: true }
      ])
    })

    it('keeps all activity in live tail when all lines arrived after the last message', () => {
      const lines = [
        { text: 'line 1', ts: 110 },
        { text: 'line 2', ts: 120 }
      ]
      const items = buildThreadItems([promptMsg], lines, true)
      expect(items).toEqual([
        { kind: 'message', message: promptMsg },
        { kind: 'activity', id: 'activity-live-0', lines, isLiveTail: true }
      ])
    })

    it('breaks in-progress thinking bubble when user responds mid-flight', () => {
      const lines = [
        { text: 'agent saying something 1..', ts: 110 },
        { text: 'agent saying something 2..', ts: 120 },
        { text: 'agent saying something 3..', ts: 130 },
        { text: 'agent saying something 4..', ts: 210 }
      ]
      const items = buildThreadItems([promptMsg, userMsg], lines, true)

      expect(items).toHaveLength(4)
      expect(items[0]).toEqual({ kind: 'message', message: promptMsg })
      expect(items[1]).toEqual({
        kind: 'activity',
        id: 'activity-chunk-0',
        lines: [lines[0], lines[1], lines[2]],
        isLiveTail: false
      })
      expect(items[2]).toEqual({ kind: 'message', message: userMsg })
      expect(items[3]).toEqual({
        kind: 'activity',
        id: 'activity-live-1',
        lines: [lines[3]],
        isLiveTail: true
      })
    })

    it('emits an empty live tail if no lines have arrived yet after the user response', () => {
      const lines = [
        { text: 'agent saying something 1..', ts: 110 },
        { text: 'agent saying something 2..', ts: 120 }
      ]
      const items = buildThreadItems([promptMsg, userMsg], lines, true)

      expect(items).toHaveLength(4)
      expect(items[0]).toEqual({ kind: 'message', message: promptMsg })
      expect(items[1]).toEqual({
        kind: 'activity',
        id: 'activity-chunk-0',
        lines,
        isLiveTail: false
      })
      expect(items[2]).toEqual({ kind: 'message', message: userMsg })
      expect(items[3]).toEqual({
        kind: 'activity',
        id: 'activity-live-1',
        lines: [],
        isLiveTail: true
      })
    })
  })
})
