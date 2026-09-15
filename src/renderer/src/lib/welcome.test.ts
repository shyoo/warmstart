import { afterEach, describe, expect, it } from 'vitest'
import { completeWelcome, welcomePending } from './welcome.js'

describe('the first-launch welcome tour', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  it('appears until the person completes or skips it', () => {
    const store: Record<string, string> = {}
    ;(globalThis as { window?: unknown }).window = { localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value }
    } }
    expect(welcomePending()).toBe(true)
    completeWelcome()
    expect(store['warmstart.welcomeComplete']).toBe('true')
    expect(welcomePending()).toBe(false)
  })

  it('does not trap somebody when storage is unavailable', () => {
    ;(globalThis as { window?: unknown }).window = { localStorage: {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') }
    } }
    expect(welcomePending()).toBe(false)
    expect(() => completeWelcome()).not.toThrow()
  })
})
