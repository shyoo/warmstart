import { describe, expect, it } from 'vitest'
import { bubbleSide, buildThreadItems, promptAnchors } from './threadbubble'
import type { Run, TaskMessage } from '@shared/tasks'

describe('thread bubbles', () => {
  it('puts only human messages on the right', () => {
    expect(bubbleSide('human')).toBe('right')
    expect(bubbleSide('agent')).toBe('left')
    expect(bubbleSide('controller')).toBe('left')
    expect(bubbleSide('system')).toBe('left')
  })
  describe('promptAnchors', () => {
    const run = (id: string, startedAt: number): Run => ({ id, startedAt }) as Run

    it('hangs a run’s prompt under the request that caused it, not the answer', () => {
      const messages = [
        { id: 1, runId: null, role: 'human', ts: 100 },
        { id: 2, runId: 'r', role: 'system', ts: 110 },
        { id: 3, runId: 'r', role: 'agent', ts: 120 }
      ] as TaskMessage[]
      expect(promptAnchors(messages, [run('r', 105)])).toEqual(new Map([[1, 'r']]))
    })

    it('gives each run its own request, in order', () => {
      const messages = [
        { id: 1, runId: null, role: 'human', ts: 100 },
        { id: 2, runId: 'r1', role: 'agent', ts: 120 },
        { id: 3, runId: null, role: 'human', ts: 200 },
        { id: 4, runId: 'r2', role: 'agent', ts: 220 }
      ] as TaskMessage[]
      expect(promptAnchors(messages, [run('r2', 205), run('r1', 105)])).toEqual(
        new Map([
          [1, 'r1'],
          [3, 'r2']
        ])
      )
    })

    it('falls back to the run’s own answer when no unclaimed request precedes it', () => {
      const messages = [
        { id: 1, runId: null, role: 'human', ts: 100 },
        { id: 2, runId: 'r1', role: 'agent', ts: 120 },
        { id: 3, runId: 'r2', role: 'system', ts: 300 },
        { id: 4, runId: 'r2', role: 'agent', ts: 320 }
      ] as TaskMessage[]
      // r2 is a retry with nothing said in between, so it keeps the old anchor.
      expect(promptAnchors(messages, [run('r1', 105), run('r2', 290)])).toEqual(
        new Map([
          [1, 'r1'],
          [4, 'r2']
        ])
      )
    })

    it('anchors a task an agent filed on its opening message', () => {
      const messages = [
        { id: 1, runId: null, role: 'agent', ts: 100 },
        { id: 2, runId: 'r', role: 'agent', ts: 120 }
      ] as TaskMessage[]
      expect(promptAnchors(messages, [run('r', 105)])).toEqual(new Map([[1, 'r']]))
    })

    it('leaves a run unanchored when it has said nothing yet and claimed no request', () => {
      const messages = [
        { id: 1, runId: null, role: 'human', ts: 100 },
        { id: 2, runId: 'r1', role: 'agent', ts: 120 }
      ] as TaskMessage[]
      // The live run has no new note behind it and no message of its own: the tail draws its chip.
      expect(promptAnchors(messages, [run('r1', 105), run('r2', 200)])).toEqual(new Map([[1, 'r1']]))
    })
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
