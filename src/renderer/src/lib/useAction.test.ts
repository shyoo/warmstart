import { describe, expect, it } from 'vitest'

// The hook is React-bound; its decision contract is pinned by this same source-level guard until
// the renderer's L3 harness grows a hook host.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('useAction', () => {
  it('clears feedback, derives optional success feedback, and reports errors', () => {
    const source = readFileSync(fileURLToPath(new URL('./useAction.ts', import.meta.url)), 'utf8')
    expect(source).toContain('setNote(null)')
    expect(source).toContain('options.successNote?.(result) ?? null')
    expect(source).toContain('setNote(errorMessage(err))')
    expect(source).toContain('setBusy(false)')
  })
})
