import { describe, expect, it } from 'vitest'
import { bumpTriple, compareVersions, parseTag, planRelease } from '../../scripts/release-tag.mjs'

/**
 * The version a `/release` tag names, decided from the tags that exist rather than from a file.
 * This repository's own history is the fixture: `v0.1.0-rc.1`, `v0.1.0-rc.2`, `v0.1.0` (2026-09-16).
 */
const shipped = [
  { name: 'v0.1.0-rc.1', commit: 'a'.repeat(40) },
  { name: 'v0.1.0-rc.2', commit: 'b'.repeat(40) },
  { name: 'v0.1.0', commit: 'c'.repeat(40) }
]
const head = 'd'.repeat(40)

describe('parseTag and compareVersions', () => {
  it('reads version tags and nothing else', () => {
    expect(parseTag('v0.2.0-rc.1')).toEqual({ name: 'v0.2.0-rc.1', version: '0.2.0-rc.1', triple: [0, 2, 0], prerelease: 'rc.1' })
    expect(parseTag('v1.0.0')?.prerelease).toBeNull()
    expect(parseTag('nightly')).toBeNull()
    expect(parseTag('v0.1.0+7.gabc')).toBeNull()
  })

  it('orders rcs below their final, numerically', () => {
    const order = ['0.1.0-rc.1', '0.1.0-rc.2', '0.1.0-rc.10', '0.1.0', '0.1.1-rc.1', '0.2.0']
    for (let i = 1; i < order.length; i++) {
      expect(compareVersions(order[i - 1]!, order[i]!)).toBeLessThan(0)
      expect(compareVersions(order[i]!, order[i - 1]!)).toBeGreaterThan(0)
    }
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  it('bumps', () => {
    expect(bumpTriple([0, 1, 0], 'patch')).toEqual([0, 1, 1])
    expect(bumpTriple([0, 1, 0], 'minor')).toEqual([0, 2, 0])
    expect(bumpTriple([0, 1, 4], 'major')).toEqual([1, 0, 0])
  })
})

describe('planRelease', () => {
  it('starts a new rc series a patch above the last final, on origin/main', () => {
    const plan = planRelease({ tags: shipped, request: 'rc', head })
    expect(plan).toMatchObject({ version: '0.1.1-rc.1', commit: head, since: 'v0.1.0' })
  })

  it('bumps minor or major when told', () => {
    expect(planRelease({ tags: shipped, request: 'rc', bump: 'minor', head }).version).toBe('0.2.0-rc.1')
    expect(planRelease({ tags: shipped, request: 'rc', bump: 'major', head }).version).toBe('1.0.0-rc.1')
  })

  it('continues an open rc series rather than opening a second one', () => {
    const tags = [...shipped, { name: 'v0.2.0-rc.1', commit: 'e'.repeat(40) }]
    expect(planRelease({ tags, request: 'rc', head }).version).toBe('0.2.0-rc.2')
    // An explicit bump starts its own series beside the open one.
    expect(planRelease({ tags, request: 'rc', bump: 'patch', head }).version).toBe('0.1.1-rc.1')
    expect(planRelease({ tags, request: 'rc', bump: 'minor', head }).version).toBe('0.2.0-rc.2')
  })

  it('promotes the highest open rc on the rc commit, not on HEAD', () => {
    const tags = [...shipped, { name: 'v0.2.0-rc.1', commit: 'e'.repeat(40) }, { name: 'v0.2.0-rc.2', commit: 'f'.repeat(40) }]
    const plan = planRelease({ tags, request: 'promote', head })
    expect(plan).toMatchObject({ version: '0.2.0', commit: 'f'.repeat(40), since: 'v0.1.0' })
  })

  it('refuses to promote when nothing is open, and never lets a version go backwards', () => {
    expect(() => planRelease({ tags: shipped, request: 'promote', head })).toThrow(/nothing to promote/)
    expect(() => planRelease({ tags: shipped, request: '0.1.0', head })).toThrow(/not above/)
    expect(() => planRelease({ tags: shipped, request: '0.0.9', head })).toThrow(/not above/)
    expect(() => planRelease({ tags: shipped, request: 'latest', head })).toThrow(/not a version/)
    expect(planRelease({ tags: shipped, request: '0.3.0-rc.1', head })).toMatchObject({ version: '0.3.0-rc.1', commit: head })
  })

  it('has a first release to offer before any tag exists', () => {
    expect(planRelease({ tags: [], request: 'rc', head })).toMatchObject({ version: '0.1.0-rc.1', since: null })
  })
})
