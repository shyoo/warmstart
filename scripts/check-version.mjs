// The version is not in any file, and this refuses the build the moment somebody puts it back.
//
// `scripts/version.mjs` derives it from git (or from `WARMSTART_VERSION` on a release build) and
// `electron-builder.js` stamps it into the package at build time. So `package.json` and the lock
// carry a fixed placeholder, and `version.json` names only the repository the app polls for
// updates. A real version written into either is a second source of truth that would drift from
// the tag the moment the next one is pushed.

import { readFileSync } from 'node:fs'
import { isSemver, PLACEHOLDER_VERSION, resolveVersion } from './version.mjs'

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const versionInfo = readJson('../version.json')
const pkg = readJson('../package.json')
const lock = readJson('../package-lock.json')

if ('version' in versionInfo) {
  throw new Error(
    'version.json must not carry a version: the tag is the version (scripts/version.mjs). Remove the field.'
  )
}
if (!/^[\w.-]+\/[\w.-]+$/.test(versionInfo.releaseRepository)) {
  throw new Error(`version.json has an invalid GitHub repository: ${JSON.stringify(versionInfo.releaseRepository)}`)
}
const placeholders = [pkg.version, lock.version, lock.packages?.['']?.version]
if (placeholders.some((value) => value !== PLACEHOLDER_VERSION)) {
  throw new Error(
    `package.json/package-lock.json must keep the placeholder version ${PLACEHOLDER_VERSION} (found ${placeholders.join(', ')}): ` +
      'the build stamps the real one from git. Never `npm version` here.'
  )
}
const version = resolveVersion()
if (!isSemver(version)) throw new Error(`the resolved version is not semver: ${JSON.stringify(version)}`)
console.log(`version ${version}`)
