import { describe, expect, it } from 'vitest'
import type { SessionStreamLine } from '@shared/protocol'
import { STREAM_VIEW_LINES, mergeStreamLines } from './streamview'

const line = (seq: number, text = `line ${seq}`): SessionStreamLine => ({
  seq,
  ts: 1_000 + seq,
  kind: 'text',
  text
})

describe('folding a session.stream event into a live view', () => {
  /**
   * ⛔ **The overlap is guaranteed, not hypothetical.** A pane opens, asks for `session.streamlog`
   * and starts receiving events in the same breath — so every line published between the request and
   * the answer arrives twice. Without a key, the agent appears to say everything twice at exactly
   * the moment somebody opened the pane to read it.
   */
  it('drops a line the backfill already delivered', () => {
    const backfill = [line(1), line(2), line(3)]
    expect(mergeStreamLines(backfill, line(2))).toBe(backfill)
  })

  it('appends a new line', () => {
    expect(mergeStreamLines([line(1)], line(2)).map((l) => l.seq)).toEqual([1, 2])
  })

  it('keeps rows in order when one arrives behind its neighbour', () => {
    expect(mergeStreamLines([line(1), line(5)], line(3)).map((l) => l.seq)).toEqual([1, 3, 5])
  })

  /**
   * ⚠️ Bounded on the watcher's side as well as the daemon's, for a different reason: the daemon is
   * bounding its own memory, this is bounding a React array re-rendered on every line. The daemon
   * keeps more, so the two do not disagree about what happened — the older rows are simply not drawn.
   */
  it('is bounded, and keeps the newest rows', () => {
    let rows: SessionStreamLine[] = []
    for (let i = 1; i <= STREAM_VIEW_LINES + 50; i++) rows = mergeStreamLines(rows, line(i))
    expect(rows).toHaveLength(STREAM_VIEW_LINES)
    expect(rows[rows.length - 1]?.seq).toBe(STREAM_VIEW_LINES + 50)
  })
})
