import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clampZoom,
  readZoomFactor,
  writeZoomFactor,
  applyZoomFactor,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP
} from './zoom.js'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

describe('zoom', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    const storage = new MemoryStorage()
    const mockWindow = {
      localStorage: storage,
      agentyard: {
        setZoomFactor: () => {},
        getZoomFactor: () => 1.0
      }
    }
    globalThis.window = mockWindow as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    globalThis.window = originalWindow
  })

  it('clamps zoom within MIN_ZOOM and MAX_ZOOM', () => {
    expect(ZOOM_STEP).toBe(0.1)
    expect(clampZoom(0.2)).toBe(MIN_ZOOM)
    expect(clampZoom(4.0)).toBe(MAX_ZOOM)
    expect(clampZoom(1.23)).toBe(1.2)
    expect(clampZoom(1.0)).toBe(1.0)
  })

  it('reads default zoom when localStorage is empty', () => {
    expect(readZoomFactor()).toBe(DEFAULT_ZOOM)
  })

  it('writes and reads back zoom factor', () => {
    writeZoomFactor(1.2)
    expect(readZoomFactor()).toBe(1.2)
  })

  it('falls back to DEFAULT_ZOOM when localStorage holds invalid data', () => {
    window.localStorage.setItem('multi_agent_controller.zoomFactor', 'invalid')
    expect(readZoomFactor()).toBe(DEFAULT_ZOOM)
  })

  it('clamps stored value when read', () => {
    window.localStorage.setItem('multi_agent_controller.zoomFactor', '9.99')
    expect(readZoomFactor()).toBe(MAX_ZOOM)
  })

  it('calls window.agentyard.setZoomFactor when available', () => {
    let setFactor: number | null = null
    window.agentyard = {
      ...window.agentyard,
      setZoomFactor: (f: number) => {
        setFactor = f
      }
    }

    applyZoomFactor(1.3)
    expect(setFactor).toBe(1.3)
  })
})
