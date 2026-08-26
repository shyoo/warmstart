#!/usr/bin/env node
/**
 * Put the Electron binary on disk, and keep trying for a bit.
 *
 * ⚠️ Electron 44 has **no postinstall**. It ships `install-electron` as a bin and leaves the download
 * to whoever wants it, so `npm ci` finishes with `node_modules/electron/dist` empty and every suite
 * here needs that dist. This step is not belt-and-braces; without it nothing runs.
 *
 * ⚠️ The download is one unretried `fetch` of a ~110MB release asset inside `@electron/get`, and CI
 * lost it once already (run 32937352644, 0.6s in). One blip on a third-party CDN should not read as a
 * failing build, so this retries — and on the last failure it says whether the release host is
 * reachable at all, which is the part `TypeError: fetch failed` hides and the reason that run could
 * not be diagnosed from its own log.
 *
 * ⛔ `install.js` is still the thing that runs. This wrapper does not reimplement the download, the
 * checksum check or the extraction; it only decides when to try again.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const install = join('node_modules', 'electron', 'install.js')
const ATTEMPTS = 4

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  // install.js is idempotent: it checks `dist/version` and `path.txt` first and exits 0 when the
  // binary is already there, so a retry after a partial download costs nothing and a warm cache
  // makes this whole script a no-op.
  const run = spawnSync(process.execPath, [install], { stdio: 'inherit' })
  if (run.status === 0) process.exit(0)

  if (attempt === ATTEMPTS) {
    console.error(`\nElectron did not install after ${ATTEMPTS} attempts.`)
    await diagnose()
    process.exit(1)
  }
  const backoff = attempt * 5000
  console.error(`\nAttempt ${attempt} of ${ATTEMPTS} failed; retrying in ${backoff / 1000}s.`)
  await sleep(backoff)
}

/**
 * Say whether the release host is reachable, so whoever reads the red log knows whether to press
 * re-run or to go looking for a real problem.
 */
async function diagnose() {
  const { version } = JSON.parse(readFileSync(join('node_modules', 'electron', 'package.json'), 'utf8'))
  const url = `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    console.error(
      res.ok
        ? `The release host is reachable (${url} -> ${res.status}), so the asset is not missing; this looks like a transient download failure.`
        : `${url} -> ${res.status} ${res.statusText}. The v${version} release may not carry this artifact.`
    )
  } catch (err) {
    console.error(`Cannot reach ${url}:`, err?.cause ?? err)
  }
}
