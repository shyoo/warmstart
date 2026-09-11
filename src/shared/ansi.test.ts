import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi.js'

describe('stripAnsi', () => {
  it('removes colour and style codes and keeps every word', () => {
    // ⚠️ The exact bytes vitest put into t344's thread on 2026-09-11.
    const red =
      '[31m⎯⎯⎯[39m[1m[41m Failed Tests 1 [49m[22m FAIL [2m > [22msrc/daemon/x.test.ts'
    expect(stripAnsi(red)).toBe('⎯⎯⎯ Failed Tests 1  FAIL  > src/daemon/x.test.ts')
  })

  it('leaves plain prose alone, arrows and brackets included', () => {
    const plain = 'Landed as `a41f9c2` onto `main` — [6/7] ← not an escape'
    expect(stripAnsi(plain)).toBe(plain)
  })
})
