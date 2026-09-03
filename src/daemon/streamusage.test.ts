/**
 * The arithmetic that decides what a stream-metered turn cost and how full its window is.
 *
 * ⛔ The numbers in the first test are **verbatim from a measured run** — `agy` 1.1.25, three
 * prompts down one conversation on 2026-09-03, raw NDJSON. They are the evidence for the claim in
 * `streamusage.ts` that `result.usage` is cumulative over the conversation, so they are asserted
 * as-is rather than rounded into something tidier.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { StreamUsage } from './stream.js'
import { forgetStreamUsage, noteStepUsage, takeTurnUsage } from './streamusage.js'

const SESSION = 'aaaaaaaa-0000-4000-8000-00000000beef'

function usage(input: number, output = 0, cacheRead = 0): StreamUsage {
  return { input, output, thinking: 0, cacheRead, cacheWrite: 0 }
}

beforeEach(() => {
  forgetStreamUsage(SESSION)
})

describe('a run that reported per-call usage', () => {
  it('bills the sum of its calls, not the conversation-cumulative terminal record', () => {
    // Run 1 of the measured conversation: three model calls, and a `result` that agrees with them.
    noteStepUsage(SESSION, usage(14_687, 181))
    noteStepUsage(SESSION, usage(14_947, 125))
    noteStepUsage(SESSION, usage(15_151, 129))
    const first = takeTurnUsage(SESSION, usage(44_785, 435))
    expect(first.usage.input).toBe(44_785)
    expect(first.usage.output).toBe(435)

    // Run 2, resuming the same conversation: one call of 15,599, and a `result` that reports
    // 60,384 — run 1's total all over again. Crediting that would bill run 1 twice.
    noteStepUsage(SESSION, usage(15_599, 23))
    const second = takeTurnUsage(SESSION, usage(60_384, 458))
    expect(second.usage.input).toBe(15_599)
    expect(second.usage.output).toBe(23)
  })

  it('reports the last call as the context level, not the sum of the calls', () => {
    noteStepUsage(SESSION, usage(500_000))
    noteStepUsage(SESSION, usage(700_000))
    noteStepUsage(SESSION, usage(800_000))
    const turn = takeTurnUsage(SESSION, usage(2_000_000))
    // The window held 800k. 2.0M is what drew `2.0M/1.0M` on the gauge.
    expect(turn.contextTokens).toBe(800_000)
    expect(turn.usage.input).toBe(2_000_000)
  })

  it('counts cached prompt tokens in the context level, since they are a disjoint category', () => {
    noteStepUsage(SESSION, usage(40_000, 0, 600_000))
    const turn = takeTurnUsage(SESSION, usage(40_000, 0, 600_000))
    expect(turn.contextTokens).toBe(640_000)
    expect(turn.usage.cacheRead).toBe(600_000)
  })
})

describe('a run that reported nothing but its terminal record', () => {
  it('takes the terminal record as the turn and says nothing about the window', () => {
    const turn = takeTurnUsage(SESSION, usage(75_000, 100))
    expect(turn.usage.input).toBe(75_000)
    // ⚠️ Null, not zero: the caller has its own fallback and must be able to tell the difference.
    expect(turn.contextTokens).toBeNull()
  })
})

describe('the accumulator does not leak between turns or sessions', () => {
  it('is consumed by the turn that closes it, so a replayed record cannot double-count', () => {
    noteStepUsage(SESSION, usage(1_000))
    expect(takeTurnUsage(SESSION, usage(9_999)).usage.input).toBe(1_000)
    // The same terminal record arriving twice now falls through to the terminal figure rather than
    // adding the steps again.
    const replay = takeTurnUsage(SESSION, usage(9_999))
    expect(replay.usage.input).toBe(9_999)
    expect(replay.contextTokens).toBeNull()
  })

  it('forgets a run that ended without a terminal record', () => {
    noteStepUsage(SESSION, usage(1_234))
    forgetStreamUsage(SESSION)
    expect(takeTurnUsage(SESSION, usage(42)).usage.input).toBe(42)
  })

  it('keeps one session’s calls out of another’s turn', () => {
    const other = 'bbbbbbbb-0000-4000-8000-00000000beef'
    noteStepUsage(SESSION, usage(1_000))
    noteStepUsage(other, usage(7_000))
    expect(takeTurnUsage(SESSION, usage(0)).usage.input).toBe(1_000)
    expect(takeTurnUsage(other, usage(0)).usage.input).toBe(7_000)
  })
})
