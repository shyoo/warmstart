import packageJson from '../../package.json'
import versionInfo from '../../version.json'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, RELEASE_REPOSITORY } from './version.js'

describe('release identity', () => {
  it('has one valid release version across app and package metadata', () => {
    expect(APP_VERSION).toBe(versionInfo.version)
    expect(packageJson.version).toBe(APP_VERSION)
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  })

  it('names the GitHub repository update polling reads', () => {
    expect(RELEASE_REPOSITORY).toBe(versionInfo.releaseRepository)
    expect(RELEASE_REPOSITORY).toMatch(/^[\w.-]+\/[\w.-]+$/)
  })
})
