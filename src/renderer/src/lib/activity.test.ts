import { describe, expect, it } from 'vitest'
import { applyActivityEvent, type ActivityLine } from './daemon.js'

/**
 * The thread renders one row per tail entry, so how events fold into the tail *is* how the
 * streamed output reads. Reported 2026-09-07: a muse turn arrived as one fragment per few tokens
 * and each pushed its own row, reading one word per line.
 */
describe('applyActivityEvent', () => {
  it('replaces the open row on append, so streamed prose grows in place', () => {
    let state: Record<string, ActivityLine[]> = {}
    state = applyActivityEvent(state, { taskId: 't', text: 'landing', ts: 1 })
    state = applyActivityEvent(state, { taskId: 't', text: 'landing corners', ts: 2, append: true })
    state = applyActivityEvent(state, {
      taskId: 't',
      text: 'landing corners pass. The',
      ts: 3,
      append: true
    })
    expect(state['t']?.map((l) => l.text)).toEqual(['landing corners pass. The'])
  })

  it('carries a reply boundary through both new lines and streaming replacements', () => {
    let state: Record<string, ActivityLine[]> = {}
    state = applyActivityEvent(state, { taskId: 't', text: 'Before reply', ts: 100, afterMessageId: 1 })
    state = applyActivityEvent(state, { taskId: 't', text: 'After', ts: 99, afterMessageId: 2 })
    state = applyActivityEvent(state, { taskId: 't', text: 'After reply', ts: 98, afterMessageId: 2, append: true })
    expect(state.t).toEqual([
      { text: 'Before reply', ts: 100, afterMessageId: 1 },
      { text: 'After reply', ts: 98, afterMessageId: 2 }
    ])
  })

  it('pushes a settled row beside the streaming one', () => {
    let state: Record<string, ActivityLine[]> = {}
    state = applyActivityEvent(state, { taskId: 't', text: 'landing', ts: 1 })
    state = applyActivityEvent(state, { taskId: 't', text: '· bash', ts: 2 })
    expect(state['t']?.map((l) => l.text)).toEqual(['landing', '· bash'])
  })

  it('pushes when an append arrives with no row to replace', () => {
    // A watcher that missed the fragment that opened the line still shows the line.
    const state = applyActivityEvent({}, { taskId: 't', text: 'landing corners', ts: 1, append: true })
    expect(state['t']?.map((l) => l.text)).toEqual(['landing corners'])
  })

  it('starts a new attempt with an empty pane', () => {
    const filled = { t: [{ text: 'from the run before', ts: 1 }] }
    expect(applyActivityEvent(filled, { taskId: 't', text: '', ts: 2, reset: true })).toEqual({
      t: []
    })
  })

  it('bounds the tail a fast model can produce', () => {
    let state: Record<string, ActivityLine[]> = {}
    for (let i = 0; i < 200; i++) {
      state = applyActivityEvent(state, { taskId: 't', text: `line ${i}`, ts: i })
    }
    expect(state['t']).toHaveLength(40)
    expect(state['t']?.[39]?.text).toBe('line 199')
  })
})
