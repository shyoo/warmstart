import { afterEach, describe, expect, it } from 'vitest'
import {
  readFleetDensity,
  writeFleetDensity,
  readQualityGradableOnly,
  writeQualityGradableOnly
} from './prefs.js'

/**
 * ⛔ The default is the interesting case, not the round trip. `narrow` hides the name of every
 * gauge on every card, and it is a mode somebody opted into by pressing a button — so anything
 * this reader is unsure about has to come back `wide`. An unreadable stored value resolving to
 * `narrow` would silently condense the strip of an operator who never asked, with no clue in the
 * UI as to why the labels went.
 */
describe('how dense the fleet strip was left', () => {
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

  it('starts wide, because that is the mode that shows everything', () => {
    stub({})
    expect(readFleetDensity()).toBe('wide')
  })

  it('remembers the one mode you have to ask for', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeFleetDensity('narrow')
    expect(store['multi_agent_controller.fleetDensity']).toBe('narrow')
    expect(readFleetDensity()).toBe('narrow')
    writeFleetDensity('wide')
    expect(readFleetDensity()).toBe('wide')
  })

  it('reads anything it does not recognise as wide', () => {
    stub({ 'multi_agent_controller.fleetDensity': 'condensed' })
    expect(readFleetDensity()).toBe('wide')
  })

  // ⚠️ `localStorage` throws rather than returning null in real configurations — a profile with
  // site data disabled, a private window on some platforms. A preference is never worth a blank
  // screen, so both directions swallow it.
  it('survives a localStorage that throws, in both directions', () => {
    stub({}, true)
    expect(readFleetDensity()).toBe('wide')
    expect(() => writeFleetDensity('narrow')).not.toThrow()
  })

  it('and a renderer with no window at all', () => {
    expect(readFleetDensity()).toBe('wide')
    expect(() => writeFleetDensity('narrow')).not.toThrow()
  })
})

describe('whether quality review filters out ungradable tasks', () => {
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

  it('defaults to false', () => {
    stub({})
    expect(readQualityGradableOnly()).toBe(false)
  })

  it('persists true when set', () => {
    const store: Record<string, string> = {}
    stub(store)
    writeQualityGradableOnly(true)
    expect(store['multi_agent_controller.qualityGradableOnly']).toBe('true')
    expect(readQualityGradableOnly()).toBe(true)
    writeQualityGradableOnly(false)
    expect(readQualityGradableOnly()).toBe(false)
  })

  it('survives throwing localStorage', () => {
    stub({}, true)
    expect(readQualityGradableOnly()).toBe(false)
    expect(() => writeQualityGradableOnly(true)).not.toThrow()
  })
})
