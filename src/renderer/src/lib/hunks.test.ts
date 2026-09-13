import { describe, expect, it } from 'vitest'
import { gapBefore, gapsBefore, parseHunkHeader } from './hunks'

describe('reading a hunk header', () => {
  it('reads both ranges, with a missing length meaning one line', () => {
    expect(parseHunkHeader('@@ -587,6 +587,12 @@ some context')).toEqual({
      oldStart: 587,
      oldLen: 6,
      newStart: 587,
      newLen: 12
    })
    expect(parseHunkHeader('@@ -1 +1 @@')).toEqual({ oldStart: 1, oldLen: 1, newStart: 1, newLen: 1 })
  })

  it('is null for anything that is not a header', () => {
    expect(parseHunkHeader('+@@ not a header')).toBeNull()
    expect(parseHunkHeader('diff --git a/x b/x')).toBeNull()
    expect(parseHunkHeader('')).toBeNull()
  })
})

describe('the unmodified lines between hunks', () => {
  it('counts the lines above the first hunk from where it starts', () => {
    // The screenshot's case: a hunk starting at 587 sits under 586 unchanged lines.
    expect(gapBefore(null, { oldStart: 587, oldLen: 6, newStart: 587, newLen: 12 })).toBe(586)
    expect(gapBefore(null, { oldStart: 1, oldLen: 4, newStart: 1, newLen: 6 })).toBe(0)
  })

  it('counts nothing above the first hunk of a new file', () => {
    // `-0,0 +1,N`: the old side does not exist, and −1 must not come out of it.
    expect(gapBefore(null, { oldStart: 0, oldLen: 0, newStart: 1, newLen: 40 })).toBe(0)
  })

  it('counts the lines between two hunks on either side of the file', () => {
    const first = { oldStart: 74, oldLen: 10, newStart: 74, newLen: 12 }
    // Old side: 74+10 = 84 → next at 200 leaves 116. New side: 74+12 = 86 → 202 leaves 116 too.
    expect(gapBefore(first, { oldStart: 200, oldLen: 3, newStart: 202, newLen: 3 })).toBe(116)
  })

  it('never goes negative on headers that overlap', () => {
    const first = { oldStart: 10, oldLen: 20, newStart: 10, newLen: 20 }
    expect(gapBefore(first, { oldStart: 12, oldLen: 2, newStart: 12, newLen: 2 })).toBe(0)
  })
})

describe('the gaps of a whole patch', () => {
  it('gives one number per line, zero for everything but a hunk header', () => {
    const lines = [
      'diff --git a/x b/x',
      '@@ -10,3 +10,4 @@',
      ' context',
      '+added',
      '@@ -20,2 +21,2 @@',
      '-gone'
    ]
    expect(gapsBefore(lines)).toEqual([0, 9, 0, 0, 7, 0])
  })

  it('treats a null entry as not a header', () => {
    expect(gapsBefore([null, '@@ -5,1 +5,1 @@', null])).toEqual([0, 4, 0])
  })
})
