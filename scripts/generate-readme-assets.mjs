/**
 * Capture the README screenshots from the real renderer, driving a fictional fleet.
 *
 *   npm run build
 *   node scripts/generate-readme-assets.mjs             # every scene
 *   node scripts/generate-readme-assets.mjs thread flow  # only these
 *
 * ⛔ **A window appears on your desktop for about a minute.** This is on purpose: with
 * `WARMSTART_HEADLESS=1` the window is never shown, Chromium never paints it, and
 * `Page.captureScreenshot` waits for a frame that never comes (measured 2026-09-11, and again
 * 2026-09-14 on the script this replaced — which also died before that, on an adapter id that does
 * not exist). Everything the L3 harness knows about driving the app still applies; the one
 * difference is the missing flag.
 *
 * ⛔ **Never the fleet you use.** The app runs against a temp `WARMSTART_DATA_DIR` and a throwaway
 * git repository under the OS temp directory; this checkout is never registered as a project.
 * Every account, task, run and quota reading is invented, and nothing here signs in or spawns a
 * CLI: workers are created disabled and enabled only behind the daemon's back, no task is ever
 * `ready`, and the rows that make the fleet look busy are written straight into the scratch
 * database.
 *
 * ⚠️ **Two launches, and the order is load-bearing.** Run prices are memoised in the daemon per
 * pricing epoch, and nothing an outside process can call bumps the epoch — so the finished history
 * has to be on disk *before* the daemon that serves the screenshots starts. The live state has the
 * opposite constraint: `reconcileTasks` at startup reaps every `running` task whose daemon died, so
 * running tasks, their sessions and workspace claims must be written *after* it. Phase one seeds
 * the history and closes the app; phase two starts it again, seeds the live rows, and captures.
 *
 * ⚠️ A scene is a click path through the real UI, so a renamed button breaks a scene rather than
 * silently drawing the wrong screen. `SCENES` below is the list; the README names the files.
 */
import { prepare, cleanup, WIZARD_ROOT, wait } from './showcase.mjs'

const only = new Set(process.argv.slice(2))

// ---------------------------------------------------------------------------------------------
// Scenes. Each one is a click path; the file it writes is what the README references.
// ---------------------------------------------------------------------------------------------

const DEBATE_PROMPT = 'Should the catalogue move from REST to GraphQL for the mobile app, or stay and add a BFF? Argue it from the client cost, the cache story and the migration risk.'

const SCENES = {
  dashboard: async (ui) => {
    await ui.nav('Dashboard')
    // ⚠️ Five accounts do not fit the fleet strip at this window width, and a hero image with the
    // fifth card half off the right edge says the app cannot show your fleet. `Narrow` is the app's
    // own answer to exactly that; the button's label is what it will switch *to*.
    await ui.evaluate(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Narrow')?.click()`
    )
    await wait(800)
    await ui.shot('dashboard')
  },
  workers: async (ui) => {
    await ui.nav('Workers')
    await wait(800)
    await ui.shot('workers')
  },
  'new-project': async (ui) => {
    await ui.click('button[aria-label="Add a project"]')
    await ui.type('input[aria-label="Project directory"]', WIZARD_ROOT)
    await wait(1500)
    await ui.shot('new-project')
    await ui.click('button[aria-label="Close"]')
  },
  'new-task': async (ui) => {
    await ui.nav('storefront')
    await ui.click('button.titlebar-new-task')
    await ui.type('textarea[aria-label="Prompt"]', 'Add a "Recently viewed" strip to the product page. Keep it server-rendered, cap it at eight items, and cover the empty case with a test.')
    await ui.shot('new-task')
    await ui.click('button[aria-label="Close new task"]')
  },
  debate: async (ui) => {
    await ui.nav('storefront')
    await ui.click('button.titlebar-new-task')
    await ui.type('textarea[aria-label="Prompt"]', DEBATE_PROMPT)
    await ui.click('.task-composer-modal button.pill[aria-label="What this files"]')
    await ui.clickText('.pill-option', 'Debate')
    await wait(800)
    await ui.shot('debate')
    await ui.click('button[aria-label="Close new task"]')
  },
  tasks: async (ui) => {
    await ui.nav('storefront')
    await ui.tab('Tasks')
    await ui.shot('tasks')
  },
  thread: async (ui) => {
    await ui.nav('storefront')
    await ui.tab('Tasks')
    // ⚠️ A prefix of TASKS[0].title, and it has to stay one: a scene is a click path through the
    // real UI, so renaming the fictional task without renaming this is a run that dies here.
    await ui.clickText('.tbl-title', 'Polish the storefront first-run')
    await wait(1200)
    await ui.shot('thread')
  },
  flow: async (ui) => {
    await ui.nav('storefront')
    await ui.tab('Flow')
    await wait(800)
    await ui.shot('flow')
  },
  statistics: async (ui) => {
    await ui.nav('Statistics')
    await wait(1200)
    await ui.shotElement('statistics', '.stat-graph-box')
  },
  tradeoffs: async (ui) => {
    await ui.nav('Statistics')
    await wait(1200)
    await ui.shotElement('tradeoffs', '.scatter-plots')
  }
}

const unknown = [...only].filter((name) => !(name in SCENES))
if (unknown.length > 0) {
  console.error(`unknown scene(s): ${unknown.join(', ')}. Known: ${Object.keys(SCENES).join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------

let ui = null
const deadline = setTimeout(() => {
  console.error('the showcase did not finish within 6 minutes; stopping the app')
  void ui?.close().finally(() => process.exit(2))
}, 6 * 60_000)

try {
  ;({ ui } = await prepare())
  for (const [name, scene] of Object.entries(SCENES)) {
    if (only.size > 0 && !only.has(name)) continue
    await scene(ui)
  }
} finally {
  clearTimeout(deadline)
  await ui?.close()
  await cleanup()
}
