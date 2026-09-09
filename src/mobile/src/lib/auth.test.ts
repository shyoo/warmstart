import { describe, expect, it } from 'vitest'
import { createTokenStore, DEVICE_TOKEN_KEY, isPairingFailure } from './auth.js'

function memory() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  }
}

describe('device token store', () => {
  it('round-trips under one key and clears', () => {
    const backing = memory()
    const store = createTokenStore(backing)
    expect(store.get()).toBeNull()
    store.set('tok-1')
    expect(store.get()).toBe('tok-1')
    expect(backing.getItem(DEVICE_TOKEN_KEY)).toBe('tok-1')
    store.clear()
    expect(store.get()).toBeNull()
  })
})

describe('pairing-failure classification', () => {
  it('treats only 401 as pair-again, never a hiccup or a refusal', () => {
    expect(isPairingFailure(401)).toBe(true)
    for (const s of [null, 400, 403, 404, 429, 500, 503]) expect(isPairingFailure(s)).toBe(false)
  })
})
