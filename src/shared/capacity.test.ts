import { describe, expect, it } from 'vitest'
import { capacityHoldReason, capacitySpawnError, parallelUse, PARALLEL_TRADEOFF } from './capacity.js'

describe('capacity copy', () => {
  it('keeps the `<label> at capacity` opening the scheduler suites match on', () => {
    // ⛔ Load-bearing: `dispatching.test.ts` and `scheduling.test.ts` assert a hold reason by this
    // prefix, and so does anybody reading a task row back. The sentence grows to the right.
    expect(capacityHoldReason('ClaudeFirst', 1, 1)).toMatch(/^ClaudeFirst at capacity/)
  })

  it('says what is full, what to change and where', () => {
    const reason = capacityHoldReason('ClaudeFirst', 1, 1)
    expect(reason).toContain('1 of 1 parallel instance in use')
    expect(reason).toContain('Raise Max parallel instances for ClaudeFirst in Workers')
    expect(reason).toContain('starts on the next tick')
  })

  it('names the cost of raising it, so the fix is not offered as free', () => {
    for (const text of [capacityHoldReason('W', 2, 2), capacitySpawnError('W', 2, 2)]) {
      expect(text).toContain(PARALLEL_TRADEOFF)
      expect(text).toMatch(/quota/)
      expect(text).toMatch(/warm sessions/)
    }
  })

  it('agrees its noun with the limit', () => {
    expect(parallelUse(1, 1)).toBe('1 of 1 parallel instance')
    expect(parallelUse(2, 3)).toBe('2 of 3 parallel instances')
  })

  it('keeps the spawn refusal recognisable as a concurrency limit', () => {
    expect(capacitySpawnError('CodexOne', 1, 1)).toMatch(
      /worker 'CodexOne' is at its concurrency limit \(1 of 1 parallel instance in use\)/
    )
  })
})
