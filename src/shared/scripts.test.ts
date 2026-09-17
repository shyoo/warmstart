import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The `scripts/` entry-point guard.
 *
 * ⛔ A module under `scripts/` that is both imported and runnable decides which it is by comparing
 * `import.meta.url` against its own path. Three of them built that URL by hand as
 * `file:///${process.argv[1]}`, which is **only ever true on Windows**: `C:\a` → `file:///C:/a` is
 * right, while a POSIX `/a` → `file:////a` matches nothing. So on Linux and macOS each of those
 * files, run as a program, did nothing at all and exited 0.
 *
 * ⭐ Measured 2026-09-16: `release.yml`'s `version=$(node scripts/version.mjs)` was therefore the
 * empty string, its `case "$version" in *-*)` found no `-`, and `v0.1.1-rc.1` published as a full
 * release and became `/releases/latest` — which t474 says an rc must never be, because installed
 * apps poll that endpoint. `release-tag.mjs` and `check-release-base.mjs` carried the same line: a
 * `cut` that tagged nothing, and a release gate that refused nothing, both reporting success by
 * saying nothing.
 *
 * ⚠️ This is a *shape* check because the behaviour it guards cannot fail on Windows, where this
 * suite is usually run. `src/shared/version.test.ts` runs `version.mjs` as a program, which is the
 * behavioural half and goes red on the platforms that matter (CI's `check` job is ubuntu).
 */

const SCRIPTS = resolve(import.meta.dirname, '..', '..', 'scripts')

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs'))
}

describe('scripts that are both imported and runnable', () => {
  it('detect direct invocation with pathToFileURL, never a hand-built file:// URL', () => {
    const offenders: string[] = []
    for (const name of scriptFiles()) {
      const source = readFileSync(join(SCRIPTS, name), 'utf8')
      // Comments in these files quote the broken form on purpose, so only code counts.
      const code = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
      if (code.includes('file:///$')) offenders.push(name)
    }
    expect(offenders, 'use pathToFileURL(process.argv[1]).href — see this file’s header').toEqual([])
  })

  /**
   * ⚠️ Either direction is fine — `pathToFileURL(argv[1])` against `import.meta.url`, or
   * `resolve(argv[1])` against `fileURLToPath(import.meta.url)` (`link-agent-skills.mjs`). What is
   * not fine is assembling either side by hand, which is what the check above forbids.
   */
  it('and does the conversion with node:url rather than string surgery', () => {
    for (const name of scriptFiles()) {
      const source = readFileSync(join(SCRIPTS, name), 'utf8')
      if (!source.includes('process.argv[1]')) continue
      const converts = source.includes('pathToFileURL') || source.includes('fileURLToPath')
      expect(converts, `${name} compares process.argv[1] without node:url doing the conversion`).toBe(true)
    }
  })
})
