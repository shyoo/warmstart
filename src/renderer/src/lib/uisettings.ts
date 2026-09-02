import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_UI_SETTINGS, type EnterBehavior, type UiSettings } from '@shared/ipc.js'

let cachedUiSettings: UiSettings | null = null
const listeners = new Set<(settings: UiSettings) => void>()

/**
 * Hook to access and update UI settings persisted in `ui-settings.json` via the main process.
 */
export function useUiSettings(): {
  settings: UiSettings
  updateUiSettings: (patch: Partial<UiSettings>) => Promise<UiSettings>
} {
  const [settings, setSettings] = useState<UiSettings>(cachedUiSettings ?? DEFAULT_UI_SETTINGS)

  useEffect(() => {
    if (!cachedUiSettings && typeof window !== 'undefined' && window.agentyard?.getUiSettings) {
      void window.agentyard.getUiSettings().then((s) => {
        cachedUiSettings = s
        setSettings(s)
      })
    }
    const listener = (next: UiSettings) => setSettings(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const updateUiSettings = useCallback(async (patch: Partial<UiSettings>) => {
    if (typeof window !== 'undefined' && window.agentyard?.setUiSettings) {
      const next = await window.agentyard.setUiSettings(patch)
      cachedUiSettings = next
      for (const l of listeners) l(next)
      return next
    }
    const next = { ...(cachedUiSettings ?? DEFAULT_UI_SETTINGS), ...patch }
    cachedUiSettings = next
    for (const l of listeners) l(next)
    return next
  }, [])

  return { settings, updateUiSettings }
}

/**
 * Determines whether a keydown event should submit the form/message based on Enter key behavior setting.
 *
 * - When `enterBehavior === 'send'`: Enter (without Shift) or ⌘/Ctrl+Enter submits; Shift+Enter adds newline.
 * - When `enterBehavior === 'newline'`: ⌘/Ctrl+Enter submits; Enter or Shift+Enter adds newline.
 */
export function isSubmitKey(
  e: React.KeyboardEvent | KeyboardEvent,
  enterBehavior: EnterBehavior
): boolean {
  if (e.key !== 'Enter') return false
  const isComposing = 'nativeEvent' in e ? e.nativeEvent.isComposing : e.isComposing
  if (isComposing) return false
  if (enterBehavior === 'send') {
    return !e.shiftKey || e.metaKey || e.ctrlKey
  }
  return e.metaKey || e.ctrlKey
}
