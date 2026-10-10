import { afterEach, describe, expect, it } from 'vitest'
import { effectiveSide, readThreadSide, toggleSide, writeThreadSide } from './threadside'

describe('toggleSide', () => {
  it('closes the pane that is showing, whichever button asked', () => {
    expect(toggleSide('status', 'status')).toBe('none')
    expect(toggleSide('scratchpad', 'scratchpad')).toBe('none')
  })

  it('swaps one pane for the other rather than showing both', () => {
    expect(toggleSide('status', 'scratchpad')).toBe('scratchpad')
    expect(toggleSide('scratchpad', 'status')).toBe('status')
  })

  it('opens a pane from the hidden state', () => {
    expect(toggleSide('none', 'status')).toBe('status')
    expect(toggleSide('none', 'scratchpad')).toBe('scratchpad')
  })
})

describe('effectiveSide', () => {
  it('falls back to the ledger where the thread has no scratchpad to show', () => {
    expect(effectiveSide('scratchpad', false)).toBe('status')
    expect(effectiveSide('scratchpad', true)).toBe('scratchpad')
  })

  it('leaves the hidden state hidden either way', () => {
    expect(effectiveSide('none', false)).toBe('none')
    expect(effectiveSide('none', true)).toBe('none')
  })
})

describe('the stored choice', () => {
  const stub = (store: Record<string, string> | null, throws = false): void => {
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error('site data disabled')
        return store?.[k] ?? null
      },
      setItem: (k: string, v: string) => {
        if (throws) throw new Error('site data disabled')
        if (store) store[k] = v
      }
    }
    ;(globalThis as { window?: unknown }).window = { localStorage: store === null ? null : storage }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('defaults to the ledger, which is what the thread always had', () => {
    stub({})
    expect(readThreadSide()).toBe('status')
  })

  it('round-trips each pane, including none, as a fresh thread would read it', () => {
    stub({})
    for (const side of ['scratchpad', 'none', 'status'] as const) {
      writeThreadSide(side)
      expect(readThreadSide()).toBe(side)
    }
  })

  it('reads an unrecognised value as the default, not as a blank column', () => {
    stub({ 'warmstart.threadSide': 'sideways' })
    expect(readThreadSide()).toBe('status')
  })

  it('survives storage that is missing or throws', () => {
    stub(null)
    expect(readThreadSide()).toBe('status')
    expect(() => writeThreadSide('none')).not.toThrow()
    stub({}, true)
    expect(readThreadSide()).toBe('status')
    expect(() => writeThreadSide('none')).not.toThrow()
  })
})
