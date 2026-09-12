import { describe, expect, it } from 'vitest'
import { patchLineClass, patchLineKind } from './diffline'

/**
 * ⛔ The header lines are the whole point of this suite. `+++ b/file` and `--- a/file` open every
 * file in every patch, and a version that checks `+` before `+++` paints both of them as changes —
 * two lines of green and red at the top of each file that nobody wrote.
 */
describe('classifying a patch line', () => {
  it('reads the file headers as metadata, not as an add and a delete', () => {
    expect(patchLineKind('+++ b/src/daemon/taskdiff.ts')).toBe('meta')
    expect(patchLineKind('--- a/src/daemon/taskdiff.ts')).toBe('meta')
    expect(patchLineKind('diff --git a/a.ts b/a.ts')).toBe('meta')
    expect(patchLineKind('index 0a1b2c3..4d5e6f7 100644')).toBe('meta')
  })

  it('reads an ordinary added and removed line', () => {
    expect(patchLineKind('+const answer = 42')).toBe('add')
    expect(patchLineKind('-const answer = 41')).toBe('del')
  })

  it('reads a hunk header and ordinary context', () => {
    expect(patchLineKind('@@ -1,4 +1,6 @@ export function f()')).toBe('hunk')
    expect(patchLineKind(' unchanged line')).toBe('context')
    expect(patchLineKind('')).toBe('context')
  })

  it('reads git’s own notes as metadata', () => {
    expect(patchLineKind('\\ No newline at end of file')).toBe('meta')
    expect(patchLineKind('rename from before.ts')).toBe('meta')
    expect(patchLineKind('rename to after.ts')).toBe('meta')
    expect(patchLineKind('Binary files a/logo.bin and b/logo.bin differ')).toBe('meta')
  })

  it('never derives anything but a class from the line', () => {
    // ⛔ Content that would be markup if anything here produced markup. The class is the only
    // output, and it is the context class, because the line starts with none of the markers.
    const hostile = '<img src=x onerror="alert(1)">'
    expect(patchLineClass(hostile)).toBe('diff-line')
    expect(patchLineClass(`+${hostile}`)).toBe('diff-line diff-line--add')
  })
})
