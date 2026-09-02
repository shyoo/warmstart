import { describe, expect, it } from 'vitest'
import { isSubmitKey } from './uisettings.js'

describe('isSubmitKey', () => {
  describe('enterBehavior = send', () => {
    it('returns true on Enter without Shift', () => {
      const event = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false
      } as React.KeyboardEvent
      expect(isSubmitKey(event, 'send')).toBe(true)
    })

    it('returns false on Shift+Enter (allowing newline)', () => {
      const event = {
        key: 'Enter',
        shiftKey: true,
        metaKey: false,
        ctrlKey: false
      } as React.KeyboardEvent
      expect(isSubmitKey(event, 'send')).toBe(false)
    })

    it('returns true on Cmd+Enter or Ctrl+Enter', () => {
      const cmdEvent = {
        key: 'Enter',
        shiftKey: false,
        metaKey: true,
        ctrlKey: false
      } as React.KeyboardEvent
      const ctrlEvent = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: true
      } as React.KeyboardEvent
      expect(isSubmitKey(cmdEvent, 'send')).toBe(true)
      expect(isSubmitKey(ctrlEvent, 'send')).toBe(true)
    })

    it('returns false when IME composition is active', () => {
      const event = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        nativeEvent: { isComposing: true }
      } as unknown as React.KeyboardEvent
      expect(isSubmitKey(event, 'send')).toBe(false)
    })

    it('returns false for non-Enter keys', () => {
      const event = {
        key: 'a',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false
      } as React.KeyboardEvent
      expect(isSubmitKey(event, 'send')).toBe(false)
    })
  })

  describe('enterBehavior = newline', () => {
    it('returns false on plain Enter (allowing newline)', () => {
      const event = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false
      } as React.KeyboardEvent
      expect(isSubmitKey(event, 'newline')).toBe(false)
    })

    it('returns false on Shift+Enter', () => {
      const event = {
        key: 'Enter',
        shiftKey: true,
        metaKey: false,
        ctrlKey: false
      } as React.KeyboardEvent
      expect(isSubmitKey(event, 'newline')).toBe(false)
    })

    it('returns true on Cmd+Enter or Ctrl+Enter', () => {
      const cmdEvent = {
        key: 'Enter',
        shiftKey: false,
        metaKey: true,
        ctrlKey: false
      } as React.KeyboardEvent
      const ctrlEvent = {
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: true
      } as React.KeyboardEvent
      expect(isSubmitKey(cmdEvent, 'newline')).toBe(true)
      expect(isSubmitKey(ctrlEvent, 'newline')).toBe(true)
    })

    it('returns false when IME composition is active even with Cmd', () => {
      const event = {
        key: 'Enter',
        shiftKey: false,
        metaKey: true,
        ctrlKey: false,
        nativeEvent: { isComposing: true }
      } as unknown as React.KeyboardEvent
      expect(isSubmitKey(event, 'newline')).toBe(false)
    })
  })
})
