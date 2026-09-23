import { describe, expect, it } from 'vitest'
import { defaultModelClass } from './modelclass.js'

describe('modelclass', () => {
  it('identifies default model classes for known models', () => {
    expect(defaultModelClass('claude-opus-5-5')).toBe('high')
    expect(defaultModelClass('claude-opus-5')).toBe('high')
    expect(defaultModelClass('claude-sonnet-5')).toBe('med')
    expect(defaultModelClass('claude-haiku-4-5')).toBe('low')

    expect(defaultModelClass('gpt-6-astra')).toBe('high')
    expect(defaultModelClass('gpt-6-sol')).toBe('high')
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
})
