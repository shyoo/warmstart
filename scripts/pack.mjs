// The one place electron-builder is invoked, and the one place the version reaches it.
//
//   node scripts/pack.mjs --dir        # npm run pack
//   node scripts/pack.mjs --win        # npm run dist:win
//
// The version is still a git fact and lives in no tracked file (`scripts/version.mjs`); it arrives
// as `-c.extraMetadata.version` on electron-builder's own command line. ⭐ Measured 2026-09-16 on
// 26.16.1: the override reaches the packaged `package.json` (`9.9.9-probe` read back out of
// `app.asar`) and leaves the project's own `package.json` untouched.
//
// ⛔ **Do not move that computation into an `electron-builder.js` beside the yml.** t485 did, as an
// ESM config that `extends:` the settings file, and it worked on Linux, on macOS and on a Windows
// developer machine — while on Windows CI it made `electron-builder --dir` exit **0** having printed
// nothing at all and produced no `release/` (run 35158401830, twice, 2026-09-16, on the same runner
// image, Node 22.23.2 and electron-builder 26.16.1 that were green for `v0.1.0`; not reproducible
// here through `npx electron-builder`, `npm run pack`, or `CI=true npm run pack`). A packaging step
// that reports success without packaging anything is the worst shape a build failure can take, and
// `npm run test:pack` was the only check that saw it. `electron-builder.yml` — discovered by
// electron-builder itself, exactly as it was for every release up to `v0.1.0` — is the only config.
//
// ⭐ electron-builder is spawned as `node <its own cli.js>`, resolved out of its `bin` field, rather
// than by name through `node_modules/.bin`: one less shim between an npm script and the packager, on
// the platform where that shim is a batch file.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { resolveVersion } from './version.mjs'

const REPO = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const manifest = require('electron-builder/package.json')
const entry = join(dirname(require.resolve('electron-builder/package.json')), manifest.bin['electron-builder'])

const version = resolveVersion({ cwd: REPO })
const forwarded = process.argv.slice(2)

// ⚠️ Printed before the packager says anything, so a log that stops here names the version it was
// about to build — the Windows CI failure above produced no line of its own at all.
console.log(`packaging warmstart ${version} with electron-builder ${manifest.version} ${forwarded.join(' ')}`)

const argv = [entry, ...forwarded, `-c.extraMetadata.version=${version}`]
const { status, signal, error } = spawnSync(process.execPath, argv, { cwd: REPO, stdio: 'inherit' })
if (error) throw error
// ⛔ A signal is not a success: `status` is null when the child was killed, and `?? 0` there would
// report a package that does not exist.
if (signal) throw new Error(`electron-builder was killed by ${signal}`)
process.exit(status ?? 1)
