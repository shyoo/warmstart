import { describe, expect, it } from 'vitest'
import { routableModelsLabel } from './routablelabel'

describe('routableModelsLabel', () => {
  it('returns default model only when no routable models are selected', () => {
    expect(routableModelsLabel([])).toBe('default model only')
    expect(routableModelsLabel([], null)).toBe('default model only')
    expect(routableModelsLabel([], { modelClasses: null, modelEfforts: null })).toBe('default model only')
  })

  it('renders models with resolved classes when no effort is set', () => {
    const label = routableModelsLabel(['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'])
    expect(label).toBe('claude-haiku-4-5-20251001 (low), claude-sonnet-5 (med), claude-opus-5 (high)')
  })

  it('honors worker modelClasses overrides', () => {
    const worker = {
      modelClasses: {
        'claude-sonnet-5': 'high' as const,
        'claude-opus-5': 'med' as const
      },
      modelEfforts: null
    }
    const label = routableModelsLabel(['claude-sonnet-5', 'claude-opus-5'], worker)
    expect(label).toBe('claude-sonnet-5 (high), claude-opus-5 (med)')
  })

  it('renders model with both class and configured effort level', () => {
    const worker = {
      modelClasses: {
        'claude-sonnet-5': 'med' as const,
        'claude-opus-5': 'high' as const
      },
      modelEfforts: {
        'claude-sonnet-5': 'high',
        'claude-opus-5': 'max'
      }
    }
    const label = routableModelsLabel(['claude-sonnet-5', 'claude-opus-5'], worker)
    expect(label).toBe('claude-sonnet-5 (med, high effort), claude-opus-5 (high, max effort)')
  })

  it('handles mixed models where only some have effort configured', () => {
    const worker = {
      modelClasses: null,
      modelEfforts: {
        'claude-sonnet-5': 'high'
      }
    }
    const label = routableModelsLabel(['claude-haiku-4-5-20251001', 'claude-sonnet-5'], worker)
    expect(label).toBe('claude-haiku-4-5-20251001 (low), claude-sonnet-5 (med, high effort)')
  })
})
