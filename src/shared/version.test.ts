import { describe, expect, it } from 'vitest'
import versionInfo from '../../version.json'
import { isSemver, versionFromDescribe } from '../../scripts/version.mjs'
import { APP_VERSION, RELEASE_REPOSITORY } from './version.js'

describe('release identity', () => {
  it('carries one valid version, stamped by the build rather than read from a file', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
    expect(versionInfo).not.toHaveProperty('version')
  })

  it('names the GitHub repository update polling reads', () => {
    expect(RELEASE_REPOSITORY).toBe(versionInfo.releaseRepository)
    expect(RELEASE_REPOSITORY).toMatch(/^[\w.-]+\/[\w.-]+$/)
  })
})

describe('versionFromDescribe', () => {
  it('is the tag itself on the tagged commit', () => {
    expect(versionFromDescribe('v0.1.0-0-g0336dce')).toBe('0.1.0')
    expect(versionFromDescribe('v0.2.0-rc.1-0-gabc1234')).toBe('0.2.0-rc.1')
  })

  it('adds the distance and sha as build metadata past the tag, and .dirty for a dirty tree', () => {
    expect(versionFromDescribe('v0.1.0-7-gcced61f')).toBe('0.1.0+7.gcced61f')
    expect(versionFromDescribe('v0.2.0-rc.1-3-gabc1234-dirty')).toBe('0.2.0-rc.1+3.gabc1234.dirty')
    expect(versionFromDescribe('v0.1.0-0-g0336dce-dirty')).toBe('0.1.0+dirty')
  })

  it('refuses a description that is not a version tag', () => {
    expect(versionFromDescribe('nightly-3-gabc1234')).toBeNull()
    expect(versionFromDescribe('v0.1.0')).toBeNull()
    expect(versionFromDescribe('')).toBeNull()
  })

  it('accepts what electron-builder and the updater both parse', () => {
    for (const value of ['0.1.0', '0.2.0-rc.1', '0.1.0+7.gcced61f', '0.0.0+gabc1234']) expect(isSemver(value)).toBe(true)
    for (const value of ['v0.1.0', '0.1', '', 'latest', 0]) expect(isSemver(value)).toBe(false)
  })
})
