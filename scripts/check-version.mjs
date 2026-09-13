import { readFileSync } from 'node:fs'

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const version = readJson('../version.json')
const pkg = readJson('../package.json')
const lock = readJson('../package-lock.json')

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.version)) {
  throw new Error(`version.json has an invalid semver version: ${JSON.stringify(version.version)}`)
}
if (!/^[\w.-]+\/[\w.-]+$/.test(version.releaseRepository)) {
  throw new Error(`version.json has an invalid GitHub repository: ${JSON.stringify(version.releaseRepository)}`)
}
const versions = [pkg.version, lock.version, lock.packages?.['']?.version]
if (versions.some((value) => value !== version.version)) {
  throw new Error(
    `version mismatch: version.json is ${version.version}; package.json/package-lock.json are ${versions.join(', ')}. ` +
      'Update the package manifests before building a release.'
  )
}
