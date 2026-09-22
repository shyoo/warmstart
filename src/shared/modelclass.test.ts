import { describe, expect, it } from 'vitest'
import { defaultModelClass, resolveModelClass } from './modelclass.js'

describe('modelclass', () => {
  it('identifies default model classes for known models', () => {
    expect(defaultModelClass('claude-opus-5')).toBe('high')
    expect(defaultModelClass('claude-sonnet-5')).toBe('med')
    expect(defaultModelClass('claude-haiku-4-5')).toBe('low')

    expect(defaultModelClass('gpt-6-astra')).toBe('high')
    expect(defaultModelClass('gpt-5.6-sol')).toBe('high')
    expect(defaultModelClass('gpt-5.6-terra')).toBe('med')
    expect(defaultModelClass('gpt-5.6-mini')).toBe('low')

    expect(defaultModelClass('gemini-3.8-flash-high')).toBe('high')
    expect(defaultModelClass('gemini-3.8-flash-medium')).toBe('med')
    expect(defaultModelClass('gemini-3.8-flash-low')).toBe('low')
  })

  it('uses heuristics for unlisted models', () => {
    expect(defaultModelClass('custom-opus-v2')).toBe('high')
    expect(defaultModelClass('custom-model-ultra')).toBe('high')
    expect(defaultModelClass('llama-3-small-mini')).toBe('low')
    expect(defaultModelClass('unknown-balanced-model')).toBe('med')
  })

  it('honors worker overrides over built-in defaults', () => {
    const worker = {
      modelClasses: {
        'claude-sonnet-5': 'high' as const,
        'claude-opus-5': 'med' as const
      }
    }
    expect(resolveModelClass('claude-sonnet-5', worker)).toBe('high')
    expect(resolveModelClass('claude-opus-5', worker)).toBe('med')
    // Unoverridden model falls back to default
    expect(resolveModelClass('claude-haiku-4-5', worker)).toBe('low')
  })
})
