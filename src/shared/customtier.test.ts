import { describe, expect, it } from 'vitest'
import { asTierTag, isTierTag, matchesModelTags, tagDisplay, tagsLabel } from './modeltags.js'

describe('custom capability tier', () => {
  it('marks a typed tag as a tier and reads it back without the marker', () => {
    expect(asTierTag('Ultra')).toBe('Tier:Ultra')
    expect(asTierTag('High')).toBe('High')
    expect(isTierTag('Tier:Ultra')).toBe(true)
    expect(isTierTag('tier:')).toBe(false)
    expect(isTierTag('Ultra')).toBe(false)
    expect(tagDisplay('Tier:Ultra')).toBe('Ultra')
  })
  it('matches a custom tier as OR with the built-ins, features as AND', () => {
    expect(matchesModelTags(['Tier:Ultra'], ['High', 'Tier:Ultra'])).toBe(true)
    expect(matchesModelTags(['Med'], ['High', 'Tier:Ultra'])).toBe(false)
    expect(matchesModelTags(['Tier:Ultra'], ['Tier:Ultra', 'Audio'])).toBe(false)
    expect(matchesModelTags(['Tier:Ultra', 'Audio'], ['Tier:Ultra', 'Audio'])).toBe(true)
    expect(tagsLabel(['High', 'Tier:Ultra', 'Audio'])).toBe('(High | Ultra) + Audio')
  })
})
