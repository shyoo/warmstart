import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TAGS,
  checkTags,
  classTag,
  cleanTags,
  fleetTags,
  hasAllTags,
  inferredTags,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  missingTags,
  sameTags,
  tagClass,
  tagsFromLegacyClass,
  tagsLabel,
  upgradeLegacyClass
} from './modeltags.js'

describe('tag normalization (t1042)', () => {
  it('trims, collapses spaces, drops blanks, and keeps the first spelling of a repeated tag', () => {
    expect(cleanTags(['  ZDR ', 'zdr', 'Audio', '', '   ', 'Long   name', 'long name'])).toEqual(['ZDR', 'Audio', 'Long name'])
  })

  it('reads a malformed stored value as fewer tags, never a throw', () => {
    expect(cleanTags(undefined)).toEqual([])
    expect(cleanTags('ZDR')).toEqual([])
    expect(cleanTags(['ZDR', 7, null, { a: 1 }])).toEqual(['ZDR'])
  })

  it('⛔ refuses an over-long tag instead of truncating it into a different tag', () => {
    expect(() => checkTags(['x'.repeat(MAX_TAG_LENGTH + 1)], 'tags')).toThrow(/longer than 24/)
    expect(checkTags(['x'.repeat(MAX_TAG_LENGTH)], 'tags')).toHaveLength(1)
  })

  it('refuses a wrong shape and too many tags, but only tidies duplicates and blanks', () => {
    expect(() => checkTags('ZDR', 'modelTags')).toThrow(/must be a list/)
    expect(() => checkTags([1], 'modelTags')).toThrow(/only text/)
    const many = Array.from({ length: MAX_TAGS + 1 }, (_v, i) => `t${i}`)
    expect(() => checkTags(many, 'modelTags')).toThrow(/at most 12/)
    expect(checkTags(['a', 'A', ' '], 'modelTags')).toEqual(['a'])
    expect(checkTags(undefined, 'modelTags')).toEqual([])
    expect(checkTags(null, 'modelTags')).toEqual([])
  })
})

describe('matching: every required tag, on the same pair', () => {
  it('needs all of them, ignoring case and order', () => {
    expect(hasAllTags(['ZDR', 'Audio', 'High'], ['audio', 'ZDR'])).toBe(true)
    expect(hasAllTags(['ZDR'], ['ZDR', 'Audio'])).toBe(false)
    expect(missingTags(['ZDR'], ['zdr', 'Audio'])).toEqual(['Audio'])
  })

  it('no requirement matches anything; a requirement matches nothing untagged', () => {
    expect(hasAllTags([], [])).toBe(true)
    expect(hasAllTags(undefined, undefined)).toBe(true)
    expect(hasAllTags([], ['Low'])).toBe(false)
    expect(hasAllTags(undefined, ['Low'])).toBe(false)
  })

  it('compares two selections as sets', () => {
    expect(sameTags(['A', 'b'], ['B', 'a'])).toBe(true)
    expect(sameTags(['A'], ['A', 'B'])).toBe(false)
    expect(sameTags(undefined, [])).toBe(true)
  })

  it('reads a requirement the way the hold reason prints it', () => {
    expect(tagsLabel(['ZDR', 'Audio'])).toBe('ZDR + Audio')
  })
})

describe('the old classes are ordinary tags now', () => {
  it('spells each class as one tag and reads the spelling back, including Medium', () => {
    expect(['low', 'med', 'high'].map((c) => classTag(c as 'low'))).toEqual(['Low', 'Med', 'High'])
    expect(tagClass('High')).toBe('high')
    expect(tagClass('medium')).toBe('med')
    expect(tagClass('Med')).toBe('med')
    expect(tagClass('ZDR')).toBeNull()
    expect(BUILTIN_TAGS).toEqual(['High', 'Med', 'Low'])
  })

  it('infers only the built-in class tag for a model, never a custom tag', () => {
    expect(inferredTags('claude-opus-5-5')).toEqual(['High'])
    expect(inferredTags('claude-haiku-4-5')).toEqual(['Low'])
    expect(inferredTags('something-unknown')).toEqual(['Med'])
  })

  it('turns the one-class spelling of a request into one tag and refuses a class that is not one', () => {
    expect(tagsFromLegacyClass('low')).toEqual(['Low'])
    expect(tagsFromLegacyClass(null)).toEqual([])
    expect(tagsFromLegacyClass(undefined)).toEqual([])
    expect(() => tagsFromLegacyClass('ultra')).toThrow(/invalid modelClass 'ultra'/)
  })

  it('upgrades a stored object, letting existing tags win and dropping an unknown class', () => {
    expect(upgradeLegacyClass({ model: 'x', modelClass: 'high' })).toEqual({ model: 'x', modelTags: ['High'] })
    expect(upgradeLegacyClass({ modelClass: 'high', modelTags: ['ZDR'] })).toEqual({ modelTags: ['ZDR'] })
    expect(upgradeLegacyClass({ modelClass: 'ultra' })).toEqual({})
    expect(upgradeLegacyClass({ modelClass: null })).toEqual({})
    expect(upgradeLegacyClass({ reassignModelClass: 'low' }, 'reassignModelClass', 'reassignModelTags')).toEqual({
      reassignModelTags: ['Low']
    })
    const untouched = { model: 'x' }
    expect(upgradeLegacyClass(untouched)).toBe(untouched)
  })
})

describe('the fleet’s tag suggestions', () => {
  it('lists the built-ins, then every tag a pair carries, with no catalogue to maintain', () => {
    const tags = fleetTags([
      { modelRoutes: [{ tags: ['ZDR', 'High'] }, { tags: ['audio'] }] },
      { modelRoutes: [{ tags: ['Audio', 'XHigh'] }] },
      null,
      { modelRoutes: null }
    ])
    expect(tags).toEqual(['High', 'Med', 'Low', 'ZDR', 'audio', 'XHigh'])
  })
})
