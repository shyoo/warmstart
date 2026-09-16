import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * How electron-builder is invoked, pinned — because the way it is invoked can fail *silently*.
 *
 * ⛔ t485 moved the version out of every tracked file (right: it is the tag) and computed it in an
 * ESM `electron-builder.js` that `extends:` the settings yml (wrong: on Windows CI that made
 * `electron-builder --dir` exit **0** having printed nothing and written no `release/` — run
 * 35158401830, twice, 2026-09-16, on the same runner image, Node 22.23.2 and electron-builder 26.16.1
 * that built `v0.1.0` green, and not reproducible on a Windows developer machine through `npx`, `npm
 * run pack`, or `CI=true npm run pack`). A packaging step that reports success without packaging
 * anything is the worst shape a build failure can take; `test:pack` was the only check that saw it,
 * and it only saw it because it refuses to test a `release/` it did not just watch appear.
 *
 * ⚠️ This suite cannot reproduce that failure — it runs no build. It pins the *shape* of the fix, so
 * that reintroducing a computed config file is a deliberate act with this comment attached to it.
 * The behaviour itself is proven only by `npm run test:pack` on Windows CI.
 */

const REPO = resolve(import.meta.dirname, '..', '..')

const read = (relative: string): string => readFileSync(join(REPO, relative), 'utf8')

/** Every script that builds a package, by name. ⛔ A new `dist:*` is covered without editing this. */
function packagingScripts(): [string, string][] {
  const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  return Object.entries(manifest.scripts).filter(([name]) => name === 'pack' || name.startsWith('dist'))
}

describe('the packaging entry point', () => {
  it('is the only electron-builder config, and it is the yml', () => {
    // ⛔ Anything electron-builder would *discover* beside the yml, in its own discovery order. The
    // yml must be alone: a second config is a second answer to "what is being built".
    const configs = readdirSync(REPO).filter((name) => /^electron-builder\./.test(name))
    expect(configs, 'electron-builder.js is what broke the Windows CI pack — see the file header').toEqual([
      'electron-builder.yml'
    ])
  })

  it('leaves the version out of the config file', () => {
    const yml = read('electron-builder.yml')
    // ⚠️ Settings, not prose: the file's header deliberately discusses `extraMetadata.main`, and
    // `${version}` in `artifactName` is the substitution. Only a real top-level key is the bug.
    expect(yml).not.toMatch(/^version:/m)
    expect(yml).not.toMatch(/^extraMetadata:/m)
  })

  it('runs electron-builder through scripts/pack.mjs and nothing else', () => {
    const scripts = packagingScripts()
    expect(scripts.length, 'package.json still has pack/dist scripts').toBeGreaterThan(0)
    for (const [name, body] of scripts) {
      expect(body, `${name} goes through scripts/pack.mjs`).toContain('node scripts/pack.mjs')
      // ⛔ Not `electron-builder` by name: on Windows that is a batch shim, and one fewer shim
      // between an npm script and the packager is the point of the wrapper.
      expect(body.replace('node scripts/pack.mjs', ''), `${name} does not also call electron-builder`).not.toMatch(
        /electron-builder/
      )
    }
  })

  it('passes the git-derived version to electron-builder on the command line', () => {
    const pack = read('scripts/pack.mjs')
    expect(pack).toContain("from './version.mjs'")
    expect(pack).toContain('-c.extraMetadata.version=')
  })

  it('forwards the arguments it was given, so --dir still means --dir', () => {
    expect(read('scripts/pack.mjs')).toContain('process.argv.slice(2)')
  })
})
