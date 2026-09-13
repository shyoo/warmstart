import { describe, expect, it } from 'vitest'
import { splitPatch } from './sidebyside'

/**
 * ⛔ The pairing is the whole point of this suite. A removed run followed by an added run must
 * zip top-to-top onto shared rows, and a surplus line must stand alone on its own side — a
 * version that renders dels then adds as separate rows shows every edit twice, once per column.
 */
describe('splitting a unified patch into two-column rows', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,4 +1,5 @@',
    ' context',
    '-old one',
    '-old two',
    '+new one',
    '+new two',
    '+new three',
    ' tail',
    '@@ -10 +11 @@',
    '-gone',
    '+back'
  ].join('\n')

  it('keeps the file headers as meta above the first block', () => {
    const [first] = splitPatch(patch)
    expect(first?.header).toBe('@@ -1,4 +1,5 @@')
    expect(first?.meta).toEqual(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts'])
  })

  it('numbers context lines on both sides from the hunk header', () => {
    const [first] = splitPatch(patch)
    const context = first?.rows[0]
    expect(context?.kind).toBe('context')
    expect(context?.left).toEqual({ no: 1, text: 'context' })
    expect(context?.right).toEqual({ no: 1, text: 'context' })
  })

  it('zips a removed run and an added run top-to-top, with the surplus standing alone', () => {
    const [first] = splitPatch(patch)
    const kinds = first?.rows.map((r) => r.kind)
    expect(kinds).toEqual(['context', 'change', 'change', 'add', 'context'])
    const pair = first?.rows[1]
    expect(pair?.left).toEqual({ no: 2, text: 'old one' })
    expect(pair?.right).toEqual({ no: 2, text: 'new one' })
    const surplus = first?.rows[3]
    expect(surplus?.left).toBeNull()
    expect(surplus?.right).toEqual({ no: 4, text: 'new three' })
    // The tail context resumes after both runs on each side's own numbering.
    const tail = first?.rows[4]
    expect(tail?.left?.no).toBe(4)
    expect(tail?.right?.no).toBe(5)
  })

  it('restarts the numbering at every hunk header', () => {
    const second = splitPatch(patch)[1]
    expect(second?.header).toBe('@@ -10 +11 @@')
    expect(second?.rows[0]?.left).toEqual({ no: 10, text: 'gone' })
    expect(second?.rows[0]?.right).toEqual({ no: 11, text: 'back' })
  })

  it('skips git’s no-newline note without shifting the numbers below it', () => {
    const rows = splitPatch('@@ -1,3 +1,3 @@\n a\n-b\n+c\n\\ No newline at end of file\n d').flatMap(
      (b) => b.rows
    )
    expect(rows.map((r) => r.kind)).toEqual(['context', 'change', 'context'])
    expect(rows[2]?.left?.no).toBe(3)
    expect(rows[2]?.right?.no).toBe(3)
  })

  it('keeps a patch of headers and no hunks as meta rather than dropping it', () => {
    const blocks = splitPatch('diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.rows).toEqual([])
    expect(blocks[0]?.meta).toContain('rename from a.ts')
  })

  it('never derives markup from hostile content — text survives verbatim', () => {
    const hostile = '<img src=x onerror="alert(1)">'
    const rows = splitPatch(`@@ -1 +1 @@\n-${hostile}\n+ok`).flatMap((b) => b.rows)
    expect(rows[0]?.left?.text).toBe(hostile)
  })
})
