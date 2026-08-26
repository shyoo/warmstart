#!/usr/bin/env node
/**
 * Regenerate the app icons from the two SVG masters in `resources/`.
 *
 * ⛔ Not part of `npm run build`, and the output is **committed**. This needs ImageMagick, which no
 * CI runner here has and no contributor should need to install to build the app. Run it by hand when
 * a master changes:
 *
 *     node scripts/icons.mjs
 *
 * ⚠️ Two masters, deliberately. `icon.svg` is drawn for 48px and up; `icon-small.svg` is the same
 * mark redrawn for 16-32px, where the hairline border and the breathing room around the mark turn to
 * mud. Feeding one master to every size is what makes an icon look right in the About box and like a
 * grey smudge in the taskbar - and separate layers per size is exactly what the .ico format is for.
 *
 * What electron-builder does with the results (`buildResources: resources`):
 *  - `icon.ico`  - Windows, every target. Read directly.
 *  - `icon.png`  - Linux, and the source electron-builder generates the macOS `.icns` from, which is
 *    why it is 1024 square. ⛔ Do not hand-roll an `.icns`: the generator is better at it than
 *    ImageMagick is, and one fewer committed binary is one fewer thing to get out of sync.
 *  - `src/renderer/public/favicon.svg` is the browser-tab icon under `electron-vite dev`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIG = 'resources/icon.svg'
const SMALL = 'resources/icon-small.svg'

/** Sizes at or below this come from `icon-small.svg`; the rest from `icon.svg`. */
const SMALL_UP_TO = 32
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * ⚠️ Always invoked from the repository root, with repo-relative forward-slashed paths.
 *
 * The `magick` a developer has may be a Cygwin or MSYS build, whose idea of an absolute path is not
 * Windows'. Handed a native temp path it wrote the file somewhere else and then could not read it
 * back ("improper image header"). Relative paths under the repo are the one form every build agrees
 * on, which is also why the scratch directory lives here rather than in the system temp.
 */
function magick(...args) {
  try {
    execFileSync('magick', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        'ImageMagick (`magick`) is not on PATH. It is needed only to regenerate icons; the ' +
          'generated files are committed, so an ordinary build never runs this script.',
        { cause: err }
      )
    }
    throw new Error(`magick ${args.join(' ')}\n${err?.stderr?.toString() ?? err?.message ?? err}`, {
      cause: err
    })
  }
}

const work = mkdtempSync(join(repo, '.icons-'))
const scratch = (name) => `${work.slice(repo.length + 1).replaceAll('\\', '/')}/${name}`

try {
  const layers = ICO_SIZES.map((size) => {
    const out = scratch(`${size}.png`)
    // ⚠️ `-depth 8`: ImageMagick rasterises at Q16 by default, and a 16-bit .ico layer is not
    // something every Windows shell surface reads back correctly.
    const master = size <= SMALL_UP_TO ? SMALL : BIG
    magick('-background', 'none', master, '-resize', `${size}x${size}`, '-depth', '8', '-strip', out)
    return out
  })
  magick(...layers, 'resources/icon.ico')

  magick('-background', 'none', BIG, '-resize', '1024x1024', '-depth', '8', '-strip',
         'resources/icon.png')

  // Vite copies `public/` to the renderer root verbatim.
  const pub = join(repo, 'src', 'renderer', 'public')
  mkdirSync(pub, { recursive: true })
  copyFileSync(join(repo, SMALL), join(pub, 'favicon.svg'))

  console.log(`resources/icon.ico             ${ICO_SIZES.join(', ')}`)
  console.log('resources/icon.png             1024x1024')
  console.log('src/renderer/public/favicon.svg')
} finally {
  rmSync(work, { recursive: true, force: true })
}
