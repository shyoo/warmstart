/**
 * Screen zoom control for increasing / decreasing font sizes and scaling the UI.
 *
 * ⛔ webFrame.setZoomFactor controls the Chromium zoom factor directly (1.0 = 100%).
 * Zoom factor is persisted in localStorage so user's chosen zoom level survives restarts.
 */

import { appKey } from './storagekeys'

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 3.0
export const DEFAULT_ZOOM = 1.0
export const ZOOM_STEP = 0.1

const ZOOM_KEY = appKey('zoomFactor')

export function clampZoom(factor: number): number {
  const rounded = Math.round(factor * 10) / 10
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rounded))
}

export function readZoomFactor(): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_ZOOM
    const raw = window.localStorage.getItem(ZOOM_KEY)
    if (!raw) return DEFAULT_ZOOM
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) {
      return clampZoom(parsed)
    }
    return DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

export function writeZoomFactor(factor: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(ZOOM_KEY, factor.toFixed(2))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

export function applyZoomFactor(factor: number): void {
  try {
    if (typeof window !== 'undefined' && window.agentyard?.setZoomFactor) {
      window.agentyard.setZoomFactor(factor)
    }
  } catch {
    // Ignore when running outside Electron
  }
}
