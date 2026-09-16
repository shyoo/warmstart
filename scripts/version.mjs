// The one place the app's version is decided, and it is decided by git, not by a file.
//
// Until 2026-09-16 the version lived in `version.json` and was mirrored into `package.json`, which
// made every release candidate and every promotion a source commit: bump, push, wait for CI, tag,
// and then the same again to turn the rc into the final. Measured on `v0.1.0` (runs 35062655991 →
// 35066743396): four agent turns and two "Prepare vX" commits whose only content was the version.
//
// Now the tag *is* the version:
//
//   - a release build is told its version by the workflow (`WARMSTART_VERSION`, from the tag name);
//   - any other build asks `git describe`: on the tagged commit that is the tag itself (`0.1.0`),
//     past it the same version with build metadata (`0.1.0+7.gcced61f`, 7 commits after `v0.1.0`),
//     and `.dirty` when the tree has uncommitted changes;
//   - without git, or before any tag, it is `0.0.0` plus whatever sha can be read.
//
// ⭐ Build metadata orders nothing (`isNewerVersion`, `src/main/updates.ts` compares the triple and
// the pre-release flag only), so a trunk-built app between releases sees `/releases/latest` as its
// own version and is not nagged; the first *newer* triple is the first thing it is offered.
//
//   node scripts/version.mjs        # prints the version this checkout would build as

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const PLACEHOLDER_VERSION = '0.0.0'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** Is this a version electron-builder, GitHub and `parseVersion` will all accept? */
export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value)
}

/**
 * `git describe --tags --match 'v*' --long --dirty` → a version.
 *
 * `v0.1.0-7-gcced61f` is seven commits past `v0.1.0`; `v0.2.0-rc.1-0-gabc1234` is exactly the rc
 * tag. ⚠️ The pre-release part may itself contain `-` (`0.2.0-rc.1`), so the description is read
 * from the right: `-dirty`, then `-g<sha>`, then `-<count>`, and whatever is left is the tag.
 */
export function versionFromDescribe(description) {
  let rest = description.trim()
  const dirty = rest.endsWith('-dirty')
  if (dirty) rest = rest.slice(0, -'-dirty'.length)
  const found = /^v?(.+)-(\d+)-g([0-9a-f]+)$/.exec(rest)
  if (!found) return null
  const [, tag, count, sha] = found
  if (!isSemver(tag) || tag.includes('+')) return null
  const metadata = []
  if (Number(count) > 0) metadata.push(count, `g${sha}`)
  if (dirty) metadata.push('dirty')
  return metadata.length === 0 ? tag : `${tag}+${metadata.join('.')}`
}

const git = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/**
 * The version this checkout builds as. `WARMSTART_VERSION` (with or without a leading `v`) wins
 * when set, because a release build must carry the tag's version even from a checkout whose
 * history is too shallow to describe.
 */
export function resolveVersion({ cwd = process.cwd(), env = process.env } = {}) {
  const told = (env.WARMSTART_VERSION ?? '').trim().replace(/^v/, '')
  if (told) {
    if (!isSemver(told)) throw new Error(`WARMSTART_VERSION is not a semver version: ${JSON.stringify(told)}`)
    return told
  }
  try {
    const described = versionFromDescribe(git(cwd, 'describe', '--tags', '--match', 'v*', '--long', '--dirty'))
    if (described) return described
  } catch {
    // No git, no tag reachable, or a shallow checkout: fall through to the placeholder.
  }
  try {
    return `${PLACEHOLDER_VERSION}+g${git(cwd, 'rev-parse', '--short', 'HEAD')}`
  } catch {
    return PLACEHOLDER_VERSION
  }
}

// ⛔ `pathToFileURL`, not a hand-built `file:///${argv[1]}`. That construction is Windows-shaped —
// `C:\a\b` becomes `file:///C:/a/b`, which is right, while a POSIX `/a/b` becomes `file:////a/b`,
// which matches nothing — so on Linux and macOS this file printed *nothing at all* when run
// directly. ⭐ Measured 2026-09-16: `release.yml`'s `version=$(node scripts/version.mjs)` was
// therefore empty, its `case "$version" in *-*)` test found no `-`, and `v0.1.1-rc.1` published as a
// full release and became `/releases/latest` — the one thing t474 says an rc must never be. Every
// consumer that *imports* `resolveVersion()` was unaffected, which is why no build looked wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(resolveVersion())
}
