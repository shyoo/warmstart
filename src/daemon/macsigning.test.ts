import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The macOS signing guard.
 *
 * ⛔ Notarisation requires the hardened runtime, and the hardened runtime is the single setting most
 * likely to break this app: it enforces library validation on every `.node` loaded, and
 * `@lydell/node-pty` is loaded out of `app.asar.unpacked` and spawns a helper binary of its own.
 * That risk was carried for months as a comment saying it had not been tested; the settings that
 * turn it on are now in the tree, and this pins them so a later edit is a deliberate act.
 *
 * ⚠️ This suite runs on every platform and proves **only what the configuration asks for**. It
 * cannot prove the request was honoured: the hardened runtime is a *signing* flag, so a machine
 * with no "Developer ID Application" certificate builds an unsigned bundle that never had it
 * applied. `scripts/build-mac.sh` reads the produced bundle with `codesign` and says which happened.
 * ⛔ Do not let this file's greenness stand in for a Mac — `docs/development.md` §3 has the checklist.
 */

const REPO = resolve(import.meta.dirname, '..', '..')

function read(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8')
}

/** The mac block only. Reading the whole file would match `hardenedRuntime` from a comment elsewhere. */
function macBlock(): string {
  const yml = read('electron-builder.base.yml')
  const start = yml.indexOf('\nmac:\n')
  expect(start, 'electron-builder.base.yml has a top-level `mac:` block').toBeGreaterThan(-1)
  const rest = yml.slice(start + 1)
  const end = rest.search(/\n[a-z]/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Settings, not prose: a commented-out line is not a setting and must not satisfy these. */
function settings(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of block.split('\n')) {
    const m = /^ {2}([a-zA-Z]+):\s*(\S.*)$/.exec(line)
    if (m?.[1] && m[2]) out.set(m[1], m[2].trim())
  }
  return out
}

const APP_PLIST = 'resources/entitlements.mac.plist'
const INHERIT_PLIST = 'resources/entitlements.mac.inherit.plist'
const PLISTS = [APP_PLIST, INHERIT_PLIST]

describe('macOS signing configuration', () => {
  it('asks for the hardened runtime', () => {
    expect(settings(macBlock()).get('hardenedRuntime')).toBe('true')
  })

  it('does not disable signing with a null identity', () => {
    // ⛔ Measured in app-builder-lib 26.15.3, `macPackager.js` `sign()`: `identity: null` takes the
    // `handleNullIdentity()` branch and returns before anything else runs. Notarisation is called
    // from *inside* `sign()`, so a null identity silently disables both, and the hardened runtime
    // with it. Absent means auto-discovery, which is what this project wants.
    expect(settings(macBlock()).has('identity')).toBe(false)
  })

  it('keeps notarisation out of the local build', () => {
    // A release build turns it on through `dist:mac:release`, so the slow, credential-dependent
    // step happens in exactly one place. Left unset, app-builder-lib notarises whenever the Apple
    // environment variables happen to be present, which makes a local build's duration depend on
    // the operator's shell.
    expect(settings(macBlock()).get('notarize')).toBe('false')
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['dist:mac:release']).toContain('-c.mac.notarize=true')
  })

  it.each(PLISTS)('%s carries the keys electron-builder\'s own template does', (plist) => {
    // ⛔ These files REPLACE the built-in template rather than extending it
    // (`MacTargetHelper.getOptionsForFile`), so dropping a key here drops it from the build. The
    // list is the template's own, read from app-builder-lib 26.15.3.
    const xml = read(plist)
    for (const key of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation'
    ]) {
      expect(xml, `${plist} sets ${key}`).toContain(`<key>${key}</key>`)
    }
  })

  it('signs the helpers with the same entitlements as the app', () => {
    // ⛔ The inherit file exists for one measured reason: a child binary falls back to
    // electron-builder's *built-in* template when `entitlements.mac.inherit.plist` is absent, even
    // though the app itself is using ours. The app and the helper that opens the PTY would then be
    // signed with two different entitlement sets, and no build log would say so.
    const keys = (plist: string) =>
      [...read(plist).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort()
    expect(keys(INHERIT_PLIST)).toEqual(keys(APP_PLIST))
  })
})
