/**
 * Capture the welcome tour's three images from the real renderer, driving the fictional fleet.
 *
 *   npm run build
 *   node scripts/generate-tour-assets.mjs
 *
 * Writes `src/renderer/src/assets/welcome/{project,worker,task}.png`: bare crops of the real Add a
 * project wizard, the Workers panel and the task composer. They replace hand-drawn SVG mockups that
 * looked like the app but were not it. Same fleet, same launch order and same caveats as
 * `generate-readme-assets.mjs` (a window appears for about a minute; never the fleet you use).
 */
import { join, resolve } from 'node:path'
import { prepare, cleanup, WIZARD_ROOT, wait } from './showcase.mjs'

const OUT = join(resolve(import.meta.dirname, '..'), 'src', 'renderer', 'src', 'assets', 'welcome')

let ui = null
const deadline = setTimeout(() => {
  console.error('the tour capture did not finish within 6 minutes; stopping the app')
  void ui?.close().finally(() => process.exit(2))
}, 6 * 60_000)

try {
  ;({ ui } = await prepare())

  await ui.click('button[aria-label="Add a project"]')
  await ui.type('input[aria-label="Project directory"]', WIZARD_ROOT)
  await wait(1500)
  await ui.cropElement(join(OUT, 'project.png'), '.wizard')
  await ui.click('button[aria-label="Close"]')

  await ui.nav('Workers')
  await wait(800)
  await ui.cropElement(join(OUT, 'worker.png'), '.panel tbody tr', { maxHeight: 520 })

  await ui.nav('storefront')
  await ui.click('button.titlebar-new-task')
  await ui.type('textarea[aria-label="Prompt"]', 'Add a "Recently viewed" strip to the product page. Keep it server-rendered, cap it at eight items, and cover the empty case with a test.')
  await ui.cropElement(join(OUT, 'task.png'), '.task-composer-modal', { maxHeight: 560 })
  await ui.click('button[aria-label="Close new task"]')
} finally {
  clearTimeout(deadline)
  await ui?.close()
  await cleanup()
}
