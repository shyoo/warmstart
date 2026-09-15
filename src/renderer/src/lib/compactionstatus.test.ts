import { describe, expect, it } from 'vitest'
import type { Compaction } from '@shared/tasks'
import { supersededAskIds } from './compactionstatus'

/**
 * ⛔ t446, measured 2026-09-14: ask 88 (preemption, 17:14:37, never honoured) read "failed" on
 * t445's thread while ask 89 (clock, 17:18:37, landed 17:21:31) sat orphaned off-thread. Once the
 * ledger attributes both, the thread must tell the two apart: the dead ask is superseded, not
 * merely failed, because the session *was* compacted — just not by it.
 */
function ask(id: number, session: string, askedAt: number, landedAt: number | null): Compaction {
  return {
    id,
    sessionId: session,
    taskId: 'task-1',
    trigger: 'clock',
    reason: 'quota preemption',
    preTokens: 174_732,
    postTokens: null,
    durationMs: null,
    askedAt,
    landedAt,
    ts: askedAt
  }
}

describe('naming superseded compaction asks', () => {
  it('marks the dead ask when a newer ask on the same session landed', () => {
    const rows = [ask(88, 's1', 1000, null), ask(89, 's1', 2000, 3000)]
    expect(supersededAskIds(rows)).toEqual(new Set([88]))
  })

  it('marks nothing when nothing later landed', () => {
    const rows = [ask(88, 's1', 1000, null), ask(89, 's1', 2000, null)]
    expect(supersededAskIds(rows)).toEqual(new Set())
  })

  it('does not let another session’s landing excuse this ask', () => {
    const rows = [ask(88, 's1', 1000, null), ask(89, 's2', 2000, 3000)]
    expect(supersededAskIds(rows)).toEqual(new Set())
  })

  it('never marks a landed ask, however old', () => {
    const rows = [ask(88, 's1', 1000, 1500), ask(89, 's1', 2000, 3000)]
    expect(supersededAskIds(rows)).toEqual(new Set())
  })

  it('orders by when asked, not by row id', () => {
    // A backfilled row can carry a lower id than the ask it supersedes; the clock order decides.
    const rows = [ask(9, 's1', 2000, 3000), ask(88, 's1', 1000, null)]
    expect(supersededAskIds(rows)).toEqual(new Set([88]))
  })
})
