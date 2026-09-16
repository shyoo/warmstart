import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
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

/**
 * ⛔ Run as a program, not imported. `scripts/version.mjs` is read three ways — imported by the vite
 * configs, imported by `scripts/pack.mjs`, and *executed* by `release.yml` and the two build scripts
 * as `version=$(node scripts/version.mjs)`. Only the third has ever been wrong, and every import-side
 * test stayed green through it: the file decided whether it had been invoked directly by comparing
 * `import.meta.url` against a hand-built `file:///${process.argv[1]}`, which is only ever true on
 * Windows, so on Linux and macOS it printed nothing. ⭐ That empty string published `v0.1.1-rc.1` as a
 * full release and made it `/releases/latest`, which t474 says an rc must never be (2026-09-16).
 *
 * ⚠️ This check is **green on Windows either way** — that platform was the one the old comparison
 * happened to be right for. It goes red without the fix on Linux and macOS, which is where
 * `release.yml` and `build-mac.sh` run it; CI's `check` job is ubuntu, so CI would have caught it.
 */
describe('scripts/version.mjs as a program', () => {
  it('prints one version on stdout on this platform', () => {
    const script = resolve(import.meta.dirname, '..', '..', 'scripts', 'version.mjs')
    const printed = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    // ⚠️ Asserted as non-empty *first*: an empty stdout is the failure this exists for, and
    // `isSemver('')` reads as "not a version" rather than "said nothing at all".
    expect(printed.trim(), 'node scripts/version.mjs printed nothing').not.toBe('')
    // ⚠️ One line, so a future `console.log` of a diagnostic beside the version fails here rather
    // than reaching a shell that would take the lot as the version.
    expect(printed.trim().split(/\r?\n/)).toHaveLength(1)
    expect(isSemver(printed.trim())).toBe(true)
  })
})
