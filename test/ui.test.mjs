import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import {
  REPO,
  check,
  checkBuildIsCurrent,
  electronBinary,
  freePort,
  killTree,
  skip,
  startDeadline,
  section,
  summary,
  wait
} from './lib/harness.mjs'

const require = createRequire(join(REPO, 'package.json'))
const WebSocket = require('ws')

/**
 * L3: the built app, driven over the DevTools protocol.
 *
 * Reads back **what actually rendered**, which is the only way to catch the class of bug that
 * typechecks perfectly — a strip absorbing the flexible row, an empty state that never clears, a
 * number rendered without its units.
 *
 * Spends nothing: it seeds through the app's own bridge and never starts an agent.
 */

// ⛔ **Private to this run, never a fixed number.** Two agents running this suite in their own
// worktrees started four runs inside three and a half minutes on 2026-08-29; all four asked for 9444,
// one got it, and the losers attached to a *stranger's* application because a page found on a shared
// port carries no evidence of whose it is. See `freePort`.
const PORT = await freePort()
const dataDir = mkdtempSync(join(tmpdir(), 'agentyard-ui-'))
let app = null
// ⚠️ A real directory with a real repo in it: `project.add` refuses a root that does not exist, and
// the workspace-pool control is a git capability. Cleaned up beside the data dir.
let projectRoot = null
// ⚠️ A second real directory: the add-project wizard is driven end to end against one, and it writes
// a committed config and three starter files into whatever it is pointed at. Cleaned up beside the rest.
let wizardRoot = null
// ⚠️ Runs in about two minutes on this machine; ten is the ceiling, not the expectation.
const budget = startDeadline(10 * 60 * 1000, 'ui', () => killTree(app?.pid, 'electron'))
let socket = null

try {
  // ⛔ **Driven, not displayed.** The window is created and the renderer runs in full — that is what
  // this suite reads back — but it is never shown, so a suite that takes two minutes does not throw
  // a window over the operator's work and steal the focus on the machine it is running on.
  const env = {
    ...process.env,
    WARMSTART_DATA_DIR: dataDir,
    WARMSTART_HEADLESS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  // ⛔ **The size CI draws at, on every machine.** `createWindow()` opens at 1440×900, but the Windows
  // runner's screen clamps that to a 1024×720 work area (viewport read back from run 34872370257),
  // so a layout that only breaks narrow passed here and failed there — the reorder arrows landed on
  // `main` green locally and red on the more expensive runner. `readWindowBounds` takes this file
  // as a restored window, so the suite pins the smaller of the two rather than hoping the screens agree.
  mkdirSync(join(dataDir, 'ui'), { recursive: true })
  writeFileSync(
    join(dataDir, 'ui', 'window-state.json'),
    JSON.stringify({ x: 0, y: 0, width: 1024, height: 720 })
  )
  app = spawn(electronBinary(), [REPO, `--remote-debugging-port=${PORT}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  // ⚠️ Always kept, printed only when something goes wrong. This was verbose-only, so when the app
  // failed to open a debugging target on Linux the suite could say nothing beyond "it did not".
  const appOutput = []
  const record = (d) => {
    appOutput.push(String(d))
    if (process.env.WARMSTART_TEST_VERBOSE) process.stderr.write(`[app] ${d}`)
  }
  app.stdout.on('data', record)
  app.stderr.on('data', record)
  app.on('error', (err) => record(`spawn failed: ${err.message}`))

  const page = await waitForPage(appOutput)
  socket = new WebSocket(page.webSocketDebuggerUrl)
  // ⛔ Opening is not guaranteed either. Awaiting only `open` meant a refused or dropped connection
  // hung here with no output and no timeout, which is the same defect as the one below.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the DevTools socket did not open within 15s')), 15_000)
    socket.on('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`the DevTools socket failed to open: ${err.message}`))
    })
  })

  let id = 0
  const pending = new Map()

  /**
   * ⛔ **Every request is bounded, and a dead connection fails all of them.**
   *
   * This resolved and never rejected: no timeout, and no handler for `close` or `error`. So when the
   * app went away mid-suite — measured 2026-08-29, when a second run on the same debugging port
   * killed the application this one was driving — the pending `Runtime.evaluate` never settled and
   * the process sat at **0.1 seconds of CPU for thirty-five minutes**, printing nothing. Every wait
   * *above* this function was bounded (45s for the page, 30s in `until` and `waitFor`); the primitive
   * underneath all of them was not, so none of those budgets could ever be reached.
   *
   * ⚠️ A stuck suite must fail, not hang. An agent waiting on this has no way to tell the difference
   * between a slow test and a dead one, and neither has the fleet: `orchestratord` logged "no turn
   * for 35m (reported, not stopped — a long tool call looks the same)" once every ten seconds.
   */
  let dead = null
  const failAll = (why) => {
    dead ??= why
    for (const entry of pending.values()) entry.reject(new Error(why))
    pending.clear()
  }
  socket.on('close', () => failAll('the app closed the DevTools connection'))
  socket.on('error', (err) => failAll(`the DevTools connection failed: ${err.message}`))
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    const entry = msg.id ? pending.get(msg.id) : undefined
    if (entry) {
      pending.delete(msg.id)
      entry.resolve(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(new Error(`${method} was not sent: ${dead}`))
        return
      }
      const mid = ++id
      // ⚠️ 60s, not the 30s the callers use, so that a slow-but-working call fails on the *caller's*
      // budget with the caller's message rather than on this one.
      const timer = setTimeout(() => {
        pending.delete(mid)
        reject(new Error(`${method} got no reply from the app within 60s`))
      }, 60_000)
      pending.set(mid, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      socket.send(JSON.stringify({ id: mid, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    const details = res.result?.exceptionDetails
    if (details) throw new Error(details.exception?.description ?? JSON.stringify(details))
    return res.result?.result?.value
  }

  // ⛔ Before anything else: this suite drives `out/` and does not build it.
  section('shell')
  checkBuildIsCurrent()

  await waitFor(() => evaluate('!!document.querySelector(".statusbar")'), 'the shell to render')
  // ⚠️ Polled, not read once. The shell renders before the daemon has finished starting, so a bare
  // read here asserts "the daemon connected *within the time this machine took to paint*" - true on
  // a warm development box, false on a cold runner, and it failed on all three in CI. Everything
  // after this seeds through the app's own bridge, so an early read also turned one honest race into
  // a second failure reading `orchestratord is not connected`.
  const connected = await until(() => evaluate('!!document.querySelector(".dot--ok")'))
  check('the daemon connected', connected, connected ? '' : 'no .dot--ok within 30s')

  // ⛔ A clean profile has never completed the welcome tour, so it opens as a modal shade over
  // everything else this suite is about to click. Dismissed once, up front, rather than letting
  // every later section rediscover it as an unexplained miss on `elementFromPoint`.
  await evaluate(
    `[...document.querySelectorAll('.welcome-actions button')].find(b => /Skip tour/i.test(b.textContent))?.click()`
  )
  await waitFor(() => evaluate('!document.querySelector(".welcome-tour")'), 'the welcome tour to close')

  /*
   * ⛔ **Driven, never displayed.** Asked of the OS, and asked *here* — after the shell has rendered
   * and the daemon has connected, which is long past both of `createWindow`'s show paths, so a
   * window that was going to appear has appeared by now.
   *
   * ⚠️ **Not `document.visibilityState`.** Measured 2026-09-01: a window created `show: false` and
   * never shown still reports `visible` to its own renderer — Chromium was never told it was
   * hidden, because no hide ever happened. The page cannot see this property; only the window
   * manager can. `MainWindowHandle` is the first *visible* top-level window of a process, so it is
   * `0` for a window that exists, is being driven, and has never been put on a screen: measured 0
   * headless against a real handle without the flag, on this machine, the same day.
   */
  if (process.platform === 'win32') {
    const handle = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).MainWindowHandle`],
      { encoding: 'utf8' }
    ).trim()
    const title = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue).MainWindowTitle`],
      { encoding: 'utf8' }
    ).trim()
    const hidden = handle === '0' || handle === '' || title === ''
    check(
      'the app under test never opens a window on the operator’s screen',
      hidden,
      hidden
        ? 'MainWindowHandle 0 (or unmapped title) - a window driven over DevTools, and nobody has to look at it'
        : `MainWindowHandle ${handle} (title: "${title}"): a real window is on screen, so WARMSTART_HEADLESS is not being honoured`
    )
  } else {
    // ⚠️ A capability of the machine, per `skip`'s rule: there is no equivalent one-liner for "does
    // this process own a mapped window" on macOS or on a Linux runner, and CI has no display for one
    // to be mapped to in the first place. The flag is set identically on every platform.
    skip(
      'the app under test never opens a window on the operator’s screen',
      `no window-manager query on ${process.platform}`
    )
  }
  const nav = await evaluate('[...document.querySelectorAll(".nav-item")].map(b => b.innerText.trim())')
  // ⛔ Named, not counted. The sidebar is now Overview (Dashboard, Controller) / one item per project / History (Conversations, Logs) / Settings (Workers, Global), so a count
  // says nothing: it moves whenever a project is added, and it passed all the way through the
  // rewrite that removed Cost and Controller as destinations.
  check(
    'the fixed destinations are reachable',
    ['Dashboard', 'Controller', 'Routing Model', 'Statistics', 'Quality Review', 'Conversations', 'Logs', 'Workers', 'Global'].every((label) =>
      nav.some((n) => n.startsWith(label))
    ),
    nav.join(' | ')
  )
  // ⛔ t419: the computer picker decides what every entry below it is about, so it sits above
  // Overview. A clean profile has nothing paired, so this computer is selected and it is the only one.
  const picker = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const select = document.querySelector('.sidebar .machine-picker-select')
        const overview = [...document.querySelectorAll('.sidebar h2')].find(h => h.textContent?.trim() === 'Overview')
        return {
          present: !!select,
          aboveOverview: !!select && !!overview && select.getBoundingClientRect().bottom <= overview.getBoundingClientRect().top,
          selected: select?.selectedOptions?.[0]?.textContent?.trim() ?? null,
          options: select ? [...select.options].map(o => o.textContent?.trim()) : []
        }
      })())
    `)
  )
  check(
    'the computer picker sits above Overview, on this computer, with the way to pair another',
    picker.present && picker.aboveOverview && picker.selected === 'This computer' && picker.options.length === 2 && /another computer/.test(picker.options[1] ?? ''),
    JSON.stringify(picker)
  )
  check(
    'a project with no projects yet says so rather than showing an empty group',
    nav.some((n) => n.startsWith('No projects yet')),
    nav.join(' | ')
  )
  const sidebarLayout = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const sidebar = document.querySelector('.sidebar')
        const bottom = sidebar?.querySelector('.sidebar-bottom')
        const headings = [...(bottom?.querySelectorAll('h2') ?? [])].map(h => h.textContent?.trim())
        return {
          anchored: bottom && sidebar
            ? Math.abs(bottom.getBoundingClientRect().bottom - sidebar.getBoundingClientRect().bottom) < 1
            : false,
          headings
        }
      })())
    `)
  )
  check(
    'utility navigation is bottom-anchored after the top-level project list',
    sidebarLayout.anchored && JSON.stringify(sidebarLayout.headings) === JSON.stringify(['Analytics', 'History', 'Settings']),
    JSON.stringify(sidebarLayout)
  )

  // ⛔ The other half of the claim, and the half `margin-top: auto` can get wrong. Anchoring to the
  // foot of a *spare* sidebar is easy; the failure mode is a full one, where the anchored groups end
  // up somewhere the operator cannot get to rather than merely lower down.
  //
  // ⚠️ The height is injected rather than seeded from real projects — this fixture opens none — so
  // what is measured is the real sidebar's own overflow behaviour under a tall child. The spacer is
  // `flex-shrink: 0` because an empty flex child shrinks back to nothing and would measure a sidebar
  // that never overflowed at all; real nav groups cannot shrink below their own text. It is removed
  // again before anything else reads the DOM.
  //
  // ⛔ **`scrollTop` is not evidence of scrollability.** An `overflow-y: hidden` box is still a
  // scroll container: `scrollHeight` exceeds `clientHeight` and assigning `scrollTop` moves it, so a
  // check written only from those two passed against a sidebar the user could not scroll at all
  // (measured while writing this, t338). The computed `overflow-y` is read for that reason alone —
  // it is the one thing separating "the content is down there" from "the operator can get to it".
  const sidebarFull = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const sidebar = document.querySelector('.sidebar')
        const bottom = sidebar?.querySelector('.sidebar-bottom')
        if (!sidebar || !bottom) return { overflows: false, userScrollable: false, lastReachable: false }
        const spacer = document.createElement('div')
        spacer.style.height = '2000px'
        spacer.style.flexShrink = '0'
        spacer.dataset.testSpacer = '1'
        sidebar.insertBefore(spacer, bottom)
        try {
          const overflowY = getComputedStyle(sidebar).overflowY
          const overflows = sidebar.scrollHeight > sidebar.clientHeight
          sidebar.scrollTop = sidebar.scrollHeight
          const items = bottom.querySelectorAll('.nav-item')
          const last = items[items.length - 1]
          const lastRect = last.getBoundingClientRect()
          const frame = sidebar.getBoundingClientRect()
          return {
            overflows,
            userScrollable: overflowY === 'auto' || overflowY === 'scroll',
            overflowY,
            lastLabel: last.innerText.trim(),
            lastReachable: lastRect.top >= frame.top - 1 && lastRect.bottom <= frame.bottom + 1
          }
        } finally {
          spacer.remove()
          sidebar.scrollTop = 0
        }
      })())
    `)
  )
  check(
    'and a sidebar too full to anchor scrolls to it rather than hiding it',
    sidebarFull.overflows &&
      sidebarFull.userScrollable &&
      sidebarFull.lastReachable &&
      sidebarFull.lastLabel === 'Global',
    JSON.stringify(sidebarFull)
  )

  // ⛔ **One title bar, and it is ours.** t354 drew this strip *under* the native caption and the
  // window carried two; the shell now hides the native one (`main/titlebar.ts`), which makes this
  // row the top of the window. So: it starts at y=0, the sidebar and the work begin below it, the
  // controls that used to be in the sidebar are in here, and none of them is inside the drag region
  // that moves the window.
  const titlebar = await evaluate(`
    JSON.stringify((() => {
      const strip = document.querySelector('.titlebar');
      const sidebar = document.querySelector('.sidebar');
      const work = document.querySelector('.main');
      if (!strip || !sidebar || !work) return { missing: true };
      const r = strip.getBoundingClientRect();
      const style = getComputedStyle(strip);
      const padLeft = parseFloat(style.paddingLeft), padRight = parseFloat(style.paddingRight);
      const buttons = [...strip.querySelectorAll('button')];
      return {
        top: Math.round(r.top),
        spansTheWindow: Math.round(r.width) >= Math.round(document.documentElement.clientWidth),
        aboveTheSidebar: r.bottom <= sidebar.getBoundingClientRect().top + 1,
        aboveTheWork: r.bottom <= work.getBoundingClientRect().top + 1,
        controls: buttons.map(b => (b.getAttribute('aria-label') ?? b.innerText).trim()),
        draggable: style.webkitAppRegion,
        clickable: buttons.every(b => getComputedStyle(b).webkitAppRegion === 'no-drag'),
        // The padding is the space the platform's own window buttons are overlaid into, read from
        // env(titlebar-area-*) — so nothing of ours may be drawn inside it.
        reservedForTheCaption: Math.round(Math.max(padLeft, padRight)),
        insideTheCaption: buttons.every(b => {
          const br = b.getBoundingClientRect();
          return br.left >= r.left + padLeft - 1 && br.right <= r.right - padRight + 1;
        }),
        sidebarStillHasControls: !!sidebar.querySelector('.brand, .brand-nav, .brand-zoom')
      };
    })())
  `)
  const t = JSON.parse(titlebar)
  check('the app draws its own title bar at the very top of the window', t.top === 0, titlebar)
  check(
    'and the sidebar and the work start below it, so the window has only one title bar',
    t.spansTheWindow === true && t.aboveTheSidebar === true && t.aboveTheWork === true,
    titlebar
  )
  check(
    'it carries the panel toggle, back, forward, refresh, both zooms and New task',
    ['Hide panel', 'Back', 'Forward', 'Refresh', 'Zoom out (Ctrl -)', 'Zoom in (Ctrl +)'].every(
      (name) => t.controls?.includes(name)
    ) && t.controls?.includes('New task'),
    titlebar
  )
  // ⛔ Both halves. `drag` with no `no-drag` on the controls is a strip whose buttons move the window
  // instead of doing anything, which is indistinguishable from a dead title bar.
  check(
    'the strip drags the window and its controls still take clicks',
    t.draggable === 'drag' && t.clickable === true,
    titlebar
  )
  check('nothing of ours is drawn under the window buttons', t.insideTheCaption === true, titlebar)
  // ⚠️ Windows only, and it is the measurement that proves the *shell* half of the fix: the caption
  // buttons are an overlay there (three of them, ~138px), so a reserved width of nothing means the
  // renderer never learned about the overlay and the native title bar is still being drawn.
  if (process.platform === 'win32') {
    check(
      'and the window-controls overlay reserved its width in this row',
      t.reservedForTheCaption > 100,
      titlebar
    )
  } else {
    skip(
      'and the window-controls overlay reserved its width in this row',
      `no overlay on ${process.platform}: Windows gets titleBarOverlay, macOS its traffic lights, Linux keeps its own frame`
    )
  }
  check('the controls it took over are gone from the sidebar', t.sidebarStillHasControls === false, titlebar)

  section('title bar controls')
  // ⛔ The sidebar and resizer disappear from grid auto-placement when hidden. Without `.main`
  // explicitly living in column three, it is then placed into the first, 0px column and the whole
  // page appears broken. Check both the state transition and the work surface's actual rectangle.
  const panelState = async () =>
    JSON.parse(
      await evaluate(`
        JSON.stringify((() => {
          const shell = document.querySelector('.shell')
          const main = document.querySelector('.main')
          const toggle = document.querySelector('button[aria-label="Show panel"], button[aria-label="Hide panel"]')
          if (!shell || !main || !toggle) return { missing: true }
          const shellRect = shell.getBoundingClientRect()
          const mainRect = main.getBoundingClientRect()
          return {
            label: toggle.getAttribute('aria-label'),
            sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
            resizerVisible: getComputedStyle(document.querySelector('.resizer')).display !== 'none',
            mainStartsAtShellEdge: Math.abs(mainRect.left - shellRect.left) < 1,
            mainFillsShell: Math.abs(mainRect.right - shellRect.right) < 1,
            mainHasArea: mainRect.width > 100,
            statusbarVisible: !!shell.querySelector('.statusbar')
          }
        })())
      `)
    )
  await evaluate(`document.querySelector('button[aria-label="Hide panel"]')?.click()`)
  await wait(250)
  const hiddenPanel = await panelState()
  check(
    'Hide panel leaves the work surface visible across the full window',
    hiddenPanel.label === 'Show panel' &&
      hiddenPanel.sidebarVisible === false &&
      hiddenPanel.resizerVisible === false &&
      hiddenPanel.mainStartsAtShellEdge === true &&
      hiddenPanel.mainFillsShell === true &&
      hiddenPanel.mainHasArea === true &&
      hiddenPanel.statusbarVisible === true,
    JSON.stringify(hiddenPanel)
  )
  await evaluate(`document.querySelector('button[aria-label="Show panel"]')?.click()`)
  await wait(250)
  const shownPanel = await panelState()
  check(
    'Show panel restores the navigation and resize handle',
    shownPanel.label === 'Hide panel' && shownPanel.sidebarVisible === true && shownPanel.resizerVisible === true,
    JSON.stringify(shownPanel)
  )

  // ⛔ t434: the status bar used to live inside `.main`'s own flex column, so its border stopped
  // at the sidebar's edge instead of running under it - a resizable sidebar means that edge moves,
  // so the seam read as a small gap rather than a fixed, deliberate one.
  const seam = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const sidebar = document.querySelector('.sidebar')
        const statusbar = document.querySelector('.statusbar')
        if (!sidebar || !statusbar) return { missing: true }
        const sidebarRect = sidebar.getBoundingClientRect()
        const statusbarRect = statusbar.getBoundingClientRect()
        return {
          sidebarBottom: sidebarRect.bottom,
          statusbarTop: statusbarRect.top,
          statusbarLeft: statusbarRect.left,
          shellLeft: document.querySelector('.shell').getBoundingClientRect().left
        }
      })())
    `)
  )
  check(
    'the status bar runs the full width, meeting the sidebar with no seam',
    Math.abs(seam.sidebarBottom - seam.statusbarTop) < 1 && Math.abs(seam.statusbarLeft - seam.shellLeft) < 1,
    JSON.stringify(seam)
  )

  await evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Controller')?.click()`)
  await wait(250)
  await evaluate(`document.querySelector('button[aria-label="Back"]')?.click()`)
  await wait(250)
  check(
    'Back returns to the previous destination',
    (await evaluate(`document.querySelector('.content')?.innerText.includes('Loose ends') ?? false`)) === true
  )
  await evaluate(`document.querySelector('button[aria-label="Forward"]')?.click()`)
  await wait(250)
  check(
    'Forward returns to the destination that Back left',
    (await evaluate(`document.querySelector('.content')?.innerText.includes('Controller') ?? false`)) === true
  )

  await evaluate(`document.querySelector('button[aria-label="Refresh"]')?.click()`)
  const refreshSettled = await until(
    () => evaluate(`!document.querySelector('button[aria-label="Refresh"]')?.disabled`),
    5_000
  )
  check('Refresh completes and leaves the connected shell usable', refreshSettled, String(refreshSettled))

  const zoomFactor = () => evaluate(`window.localStorage.getItem('warmstart.zoomFactor')`)
  await evaluate(`document.querySelector('button[aria-label="Zoom in (Ctrl +)"]')?.click()`)
  check(
    'Zoom in changes and persists the zoom, exposing its reset control',
    (await zoomFactor()) === '1.10' &&
      (await evaluate(`document.querySelector('.zoom-badge')?.innerText ?? ''`)) === '110%',
    `${await zoomFactor()} / ${await evaluate(`document.querySelector('.zoom-badge')?.innerText ?? ''`)}`
  )
  await evaluate(`document.querySelector('.zoom-badge')?.click()`)
  check(
    'the zoom readout resets zoom to 100% and stays visible, disabled',
    (await zoomFactor()) === '1.00' &&
      (await evaluate(`document.querySelector('.zoom-badge')?.innerText ?? ''`)) === '100%' &&
      (await evaluate(`document.querySelector('.zoom-badge')?.disabled`)) === true,
    String(await zoomFactor())
  )
  await evaluate(`document.querySelector('button[aria-label="Zoom out (Ctrl -)"]')?.click()`)
  check(
    'Zoom out changes and persists the zoom',
    (await zoomFactor()) === '0.90' &&
      (await evaluate(`document.querySelector('.zoom-badge')?.innerText ?? ''`)) === '90%',
    `${await zoomFactor()} / ${await evaluate(`document.querySelector('.zoom-badge')?.innerText ?? ''`)}`
  )
  await evaluate(`document.querySelector('.zoom-badge')?.click()`)

  await evaluate(`[...document.querySelectorAll('.titlebar button')].find(b => b.innerText.trim() === 'New task')?.click()`)
  await wait(250)
  check(
    'New task opens the global composer from the title bar',
    (await evaluate(`!!document.querySelector('.task-composer-modal[role="dialog"]')`)) === true
  )
  await evaluate(`document.querySelector('button[aria-label="Close new task"]')?.click()`)
  await wait(250)
  check(
    'and its close button returns to the route underneath',
    (await evaluate(`!document.querySelector('.task-composer-modal')`)) === true
  )

  section('zero state')
  check(
    'an empty fleet says so rather than showing furniture',
    (await evaluate('document.querySelector(".fleet").innerText')).includes('no workers'),
    'this is what a stranger sees on first launch'
  )
  check(
    'the attention bar is absent when there is nothing to answer',
    (await evaluate('!!document.querySelector(".approvals")')) === false
  )

  section('with content')
  await evaluate(`
    (async () => {
      const r = window.agentyard.rpc;
      await r('worker.create', { adapterId: 'claude-code', label: 'ui worker' });
      await r('task.create', { title: 'A task the UI can render', priority: 'P1' });
      const t = await r('task.create', { title: 'A draft that must not dispatch', status: 'draft' });
      await r('task.cancel', { id: (await r('task.list', {}))[0].id, reason: 'ui test' });
      // One task left in the queue on purpose: everything else this suite files is at rest, and a
      // table with nothing in flight cannot show whether in-flight is legible. The one worker here
      // has no credentials, so this is held rather than dispatched.
      // ⚠️ With a prompt, so the thread has something in it. A task filed with only a title has an
      // empty message list, and a check that every message carries a timestamp passes vacuously on
      // a thread with no messages — which is what it did the first time it was written.
      await r('task.create', {
        title: 'A task waiting for a worker',
        priority: 'P3',
        prompt: 'Say what you would do first.'
      });
      return t.seq;
    })()
  `)
  await wait(1500)

  // These tasks are filed with no project, which is still legal. The sidebar carries an Unassigned
  // entry for exactly that case - work with no project would otherwise be unreachable in a shell
  // built out of projects. ⚠️ It is temporary: it disappears when the last orphan is given a home.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Unassigned'))?.click()`
  )
  await wait(1200)
  check(
    'work with no project is still reachable',
    await evaluate(
      `[...document.querySelectorAll('.nav-item')].some(b => b.innerText.trim().startsWith('Unassigned'))`
    ),
    'a project-shaped sidebar must not hide tasks that have no project'
  )

  const table = await evaluate('document.querySelector(".tbl")?.innerText ?? ""')
  check('the task table renders rows', table.includes('A task the UI can render'))
  check('a cancelled task shows its resting state', table.includes('paused_user'), 'not "cancelled"')
  check('a draft is visible but not queued', table.includes('draft'))

  // ---- filtering the table ------------------------------------------------------------
  // ⛔ The chips are the only thing standing between an operator and a table that grows without
  // bound. Three tasks are seeded above and they land in three different buckets, which is what
  // makes a narrowing observable at all.
  const chips = await evaluate(`[...document.querySelectorAll('.chip')].map(c => c.innerText.trim())`)
  check('the table offers view filters', chips.length === 6, JSON.stringify(chips))
  check(
    'including the one an operator actually scans for',
    chips.some((c) => c.startsWith('Needs you')),
    'a task waiting on a person is stopped and nothing in the fleet will restart it'
  )

  const rowsNow = () => evaluate('document.querySelectorAll(".tbl tbody tr").length')
  const countsNow = () =>
    evaluate(`JSON.stringify([...document.querySelectorAll('.chip')].map(c => c.innerText.trim()))`)

  const unfilteredRows = await rowsNow()
  const countsBefore = await countsNow()
  check('every task is listed before anything is filtered', unfilteredRows === 3, String(unfilteredRows))

  await evaluate(
    `[...document.querySelectorAll('.chip')].find(c => c.innerText.trim().startsWith('Needs you'))?.click()`
  )
  await wait(900)
  const narrowed = await rowsNow()
  check('choosing a view narrows the table', narrowed === 1, `${unfilteredRows} rows -> ${narrowed}`)

  // ⭐ The property worth pinning, and the one that is wrong in most tables that do this: a count
  // computed from the rows on screen would read `Blocked 0` while a draft sat one click away.
  check(
    'and the counts keep describing every bucket, not the filtered rows',
    (await countsNow()) === countsBefore,
    'a chip whose count followed the filter would only ever be right for the chip already clicked'
  )

  // ⛔ Multi-select. Two buckets is a union, not a replacement - the second click must add rather
  // than switch, or the chips are a tab bar wearing a different shape.
  await evaluate(
    `[...document.querySelectorAll('.chip')].find(c => c.innerText.trim().startsWith('Blocked'))?.click()`
  )
  await wait(900)
  const twoViews = await rowsNow()
  check('selecting a second view adds to the first rather than replacing it', twoViews === 2, String(twoViews))

  check(
    'and the choice is remembered, so a reopened window keeps the view',
    JSON.parse(
      (await evaluate(`window.localStorage.getItem('warmstart.taskViews')`)) ?? '[]'
    ).length === 2
  )

  await evaluate(
    `[...document.querySelectorAll('.chip')].find(c => c.innerText.trim().startsWith('All'))?.click()`
  )
  await waitFor(async () => (await rowsNow()) === 3, 'All filter to restore 3 rows')
  check('All puts every task back', (await rowsNow()) === 3)

  // ⛔ Both dates. "How long has this been sitting here" and "is anything still happening" are
  // different questions, and one column answers neither on its own.
  const headers = await evaluate(`document.querySelector('.tbl thead')?.innerText ?? ''`)
  check('the table says when each task was filed and when it last moved', /CREATED/i.test(headers) && /UPDATED/i.test(headers), headers)
  check(
    'and the column it is sorted by is the only one marked',
    (await evaluate(`document.querySelectorAll('.sort-head--on').length`)) === 1,
    'an arrow on every header hides the one actually in force'
  )

  // ⛔ Which account is spending on a task is the first thing an operator checks. It used to be
  // reachable only by clicking the row open, which is where a misroute went unnoticed for an hour.
  // ⚠️ Case-insensitive: `innerText` is what *rendered*, and the header is upper-cased by CSS.
  check(
    'the table says which worker has each task',
    /worker/i.test(await evaluate('document.querySelector(".tbl thead")?.innerText ?? ""')),
    'a routing mistake is invisible until this column exists'
  )
  // ⚠️ `ready` reads as a resting state beside `completed` and `failed` — as though the person who
  // filed the task were the one being waited on. It is in the queue, and its status says so.
  check(
    'a queued task shows that it is queued, not that it is finished',
    await evaluate(
      `[...document.querySelectorAll('.tbl tbody tr')].some(
         r => /ready|dispatching|queued/i.test(r.innerText))`
    ),
    'the task is in the queue rather than completed or failed'
  )
  check(
    'a queued task does not show animated working dots when not running',
    await evaluate(
      `![...document.querySelectorAll('.tbl tbody tr')].some(
         r => /ready|queued/i.test(r.innerText) && r.querySelector('.working'))`
    ),
    'the animated dots only appear when an agent is actively running'
  )

  // A tick with nothing dispatchable, driven rather than waited for. The one worker this suite
  // commissions has no credentials, so every ready task is held - which is exactly the case that
  // used to render as a task sitting at `ready` with no explanation at all.
  await evaluate(`window.agentyard.rpc('scheduler.tick')`)
  await wait(1500)
  check(
    'a task that is not moving says why',
    /not signed in|at capacity|no eligible worker|is held out|not installed/i.test(
      await evaluate('document.querySelector(".tbl tbody")?.innerText ?? ""')
    ),
    'the scheduler already computed the reason; it now reaches the row it is about'
  )
  // ⛔ In the line under the row, not as small print inside the Status cell. The reason a task has
  // not moved and what the agent says once it is moving are the same question — what is happening
  // to this task — and they used to be answered in two different places, so the answer visibly
  // jumped out of the column and down under the row the instant a run started.
  check(
    'and it says so in the same place a running task does',
    await evaluate(
      `[...document.querySelectorAll('.tbl tbody .tbl-live-line')].some(
         el => /not signed in|at capacity|no eligible worker|is held out|not installed/i.test(el.innerText))
       && !document.querySelector('.tbl tbody .status + .tbl-sub')`
    ),
    'a status message that moves as the task progresses reads as a new event, not the same one'
  )

  // ⛔ Money over tokens, in the column that used to be headed "Tokens". Both lines, because the
  // price is derived from the account's own window and the token count from the agent's transcript
  // — different measurements of the same work, and docs/cost-model.md §5 is explicit that they are
  // never reconciled. A build that renders only one of them has dropped a fact, not tidied one.
  check(
    'the task table prices work in money, not only in tokens',
    await evaluate(
      `[...document.querySelectorAll('.tbl thead th')].some(
         el => el.innerText.trim().toLowerCase() === 'price')`
    ),
    'the header should read Price'
  )
  check(
    'and keeps the token count beneath it, quietly',
    await evaluate(`(() => {
      const cell = document.querySelector('.tbl tbody td .price')?.closest('td');
      if (!cell) return false;
      return !!cell.querySelector('.tbl-model');
    })()`),
    'the price cell should stack a faint token line under the money'
  )
  // ⛔ `n/a`, never `$0.00`. This suite commissions a worker with no credentials, so nothing has
  // ever run and no window has ever been read — and a confident zero over an unmeasured run is the
  // one rendering of this feature that would be actively misleading.
  check(
    'an unmeasurable price reads n/a rather than a confident zero',
    await evaluate(
      `[...document.querySelectorAll('.tbl tbody td .price')].every(el => el.innerText.trim() === 'n/a')`
    ),
    'nothing in this suite has run, so nothing can be priced'
  )

  // ---- the thread ---------------------------------------------------------------------
  // ⛔ Opened, because everything below only exists once a task is open — and "click the row to find
  // out which session it is on" is exactly the gap this pane was reworked to close.
  // ⚠️ The first row, not the last. The table now sorts most-recently-touched first, so the last row
  // is the stalest task in the project — which is not what "open a task" should mean, and in this
  // suite is a task nobody has said anything on.
  await evaluate(`document.querySelector('.tbl tbody tr')?.click()`)
  await wait(1200)

  // ⛔ A destination, not a pane below the table. The detail used to render underneath the list,
  // which put the thing you had just clicked on below every row of the thing you clicked it from —
  // further off screen the more work a project had.
  check(
    'clicking a task leaves the table behind rather than growing it',
    await evaluate('!document.querySelector(".tbl tbody")'),
    'the list should be gone, not scrolled past'
  )
  check(
    'and the thread offers the way back, above the messages',
    await evaluate(`(document.querySelector('.back-to-list')?.innerText ?? '').includes('←')`),
    'a screen you navigate to needs its exit where the eye starts'
  )

  const detail = await evaluate('document.querySelector(".detail")?.innerText ?? ""')
  check('opening a task shows a ledger beside the thread', /STATUS|WORKER|SESSION/i.test(detail), detail.slice(0, 80))
  check(
    'it says which session the work is on',
    /session/i.test(detail),
    'a worker id says which account paid; only the session says whether the context survived'
  )
  check('it says how long, not only how much', /took/i.test(detail))
  check(
    'the token count is called tokens',
    /tokens/i.test(detail),
    '"spent" was read as money by everybody who saw it'
  )
  // ⛔ The same two lines as the table, in the thread's own ledger — and in the per-run facts below
  // it. A price shown in one surface and not the other is a number a reader cannot check.
  check(
    'and the money is shown beside it, as a price',
    /price/i.test(detail) && /n\/a|\$/.test(detail),
    'the thread should name what the task cost, or say plainly that it cannot be said'
  )

  // ⛔ One scroll container, not two. The live output used to sit in its own bordered pane below the
  // thread, which meant following one conversation by moving your eyes between two boxes — with the
  // composer for replying below both, furthest from the words it was answering.
  check(
    'the live pane is gone as a separate box',
    (await evaluate('!!document.querySelector(".peek")')) === false,
    'what the agent is saying now is the continuation of what it said a minute ago'
  )
  check(
    'the thread and the composer are the same column, in that order',
    await evaluate(`(() => {
      const thread = document.querySelector('.thread--task');
      const compose = document.querySelector('.compose');
      if (!thread || !compose) return false;
      return thread.getBoundingClientRect().bottom <= compose.getBoundingClientRect().top + 4;
    })()`),
    'a reply box above the thing it replies to is not a chat'
  )

  // ⛔ On every message, and under the bubble rather than inside it. A thread with no clock cannot
  // say whether the agent replied to something or was already saying it — and on a task that ran
  // across two days it cannot even say which day (t374 took it out of the bubble and, by mistake,
  // out of the thread; t378 put it back below). Read off geometry: the stamp's top at or below the
  // bubble's bottom, not merely a different parent.
  const clocks = JSON.parse(
    await evaluate(`(() => {
      const msgs = [...document.querySelectorAll('.thread--task .msg')].filter(m => !m.classList.contains('msg--live'));
      // ⛔ length > 0 is half the assertion. Without it this passes on a thread with no messages,
      // which is exactly how it was first written and exactly what it did.
      const stamped = msgs.filter(m => (m.querySelector('.msg-when')?.innerText ?? '').trim().length > 0);
      const below = msgs.filter(m => {
        const when = m.querySelector('.msg-when');
        const bubble = m.querySelector('.msg-bubble');
        return when && bubble && !bubble.contains(when) && when.getBoundingClientRect().top >= bubble.getBoundingClientRect().bottom - 1;
      });
      // And on the bubble's own side: flush with its right edge under a person's bubble, with its
      // left edge under everyone else's.
      const aligned = msgs.filter(m => {
        const w = m.querySelector('.msg-when')?.getBoundingClientRect();
        const b = m.querySelector('.msg-bubble')?.getBoundingClientRect();
        if (!w || !b) return false;
        return m.classList.contains('msg--right') ? Math.abs(w.right - b.right) <= 6 : Math.abs(w.left - b.left) <= 6;
      });
      return JSON.stringify({ msgs: msgs.length, stamped: stamped.length, below: below.length, aligned: aligned.length });
    })()`)
  )
  check(
    'every message says when it was said, under its bubble and on its side',
    clocks.msgs > 0 && clocks.stamped === clocks.msgs && clocks.below === clocks.msgs && clocks.aligned === clocks.msgs,
    JSON.stringify(clocks)
  )

  // ⛔ A chat, not a log: what the person said sits on the right, everything else on the left. Read
  // off geometry rather than class names, because a class that is applied and a stylesheet that
  // ignores it look identical to a selector. ⚠️ At least one person's bubble is half the claim — the
  // filed prompt is a human message on every task, so an empty set means the check measured nothing.
  const sides = JSON.parse(
    await evaluate(`(() => {
      const thread = document.querySelector('.thread--task');
      if (!thread) return JSON.stringify({ human: 0, left: 0, ok: false });
      const t = thread.getBoundingClientRect();
      // ⚠️ Gaps, not the midline: a long prompt fills 82% of the row and crosses the middle whichever
      // edge it hugs, so only "which edge is nearer" tells right-aligned from left-aligned.
      const hugsRight = (b) => {
        const r = b.getBoundingClientRect();
        return t.right - r.right < r.left - t.left;
      };
      const bubbles = [...thread.querySelectorAll('.msg:not(.msg--live) .msg-bubble')];
      const human = bubbles.filter(b => b.closest('.msg--human'));
      const others = bubbles.filter(b => !b.closest('.msg--human'));
      return JSON.stringify({
        human: human.length,
        left: others.length,
        ok: human.every(hugsRight) && others.every(b => !hugsRight(b)),
        noRoleColumn: !thread.querySelector('.msg-role')
      });
    })()`)
  )
  check(
    '⛔ the person’s bubbles sit on the right, the agent’s and the system’s on the left, with no role column',
    sides.human > 0 && sides.ok && sides.noRoleColumn,
    JSON.stringify(sides)
  )

  // ---- the seven settings, now one component ------------------------------------------
  // ⛔ **The tier this row was missing.** The thread's settings were seven copies of one component
  // and are now one (`TaskSettingPicker`, 2026-09-08); the menus behind them are pure and tested at
  // L1 in `lib/threadview.test.ts`. What no L1 check can say is whether the component is *wired* —
  // whether the button an operator presses reaches the daemon and comes back. That is this section,
  // and without it the refactor rests on a suite that never renders the pane.
  const pickers = JSON.parse(
    await evaluate(`
      JSON.stringify([...document.querySelectorAll('.detail .setting-btn-select')].map(b => ({
        label: b.getAttribute('aria-label'),
        text: b.innerText.trim()
      })))
    `)
  )
  const labelled = (name) => pickers.find((p) => p.label === name)
  check(
    'the thread draws all seven of its settings',
    ['Finish policy', 'Session sharing', 'Completion mode', 'Automatic compaction',
      'Optimization objective', 'Worker', 'Priority'].every((l) => labelled(l)),
    `drew: ${pickers.map((p) => p.label).join(', ')}`
  )
  // ⛔ The button says what is *in effect*, the menu says what choosing it means. A task on
  // `inherit` that displayed the word "inherit" would answer a question nobody asked.
  check(
    'a setting left on inherit shows the value it resolves to',
    !/^inherit/.test(labelled('Finish policy')?.text ?? 'inherit'),
    `the finish button reads "${labelled('Finish policy')?.text}"`
  )
  await evaluate(
    `document.querySelector('.detail .setting-btn-select[aria-label="Finish policy"]')?.click()`
  )
  await wait(200)
  check(
    'and its menu still names inherit as a choice, with what it resolves to',
    await evaluate(`
      [...document.querySelectorAll('.setting-btn-select-menu [role="option"]')]
        .some(o => /^inherit \\(.+\\)/.test(o.innerText.trim()))
    `),
    'choosing inherit has to be an informed choice'
  )
  await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await wait(200)

  // ⛔ **The round trip, which is the only part a person had to click through before.** The value
  // below is re-read from the daemon after the write — the pane refetches rather than trusting what
  // was clicked — so a picker wired to nothing fails here even though it renders perfectly.
  const openSeq = Number(
    (await evaluate(`document.querySelector('.detail-head h3')?.innerText ?? ''`)).match(/t(\d+)/)?.[1]
  )
  const priorityOf = async () =>
    await evaluate(`
      window.agentyard.rpc('task.page', { limit: 200 })
        .then(p => p.tasks.find(t => t.seq === ${openSeq})?.priority ?? null)
    `)
  const wasPriority = await priorityOf()
  const pick = async (label, option) => {
    await evaluate(
      `document.querySelector('.detail .setting-btn-select[aria-label=${JSON.stringify(label)}]')?.click()`
    )
    await wait(200)
    await evaluate(`
      [...document.querySelectorAll('.setting-btn-select-menu [role="option"]')]
        .find(o => o.innerText.trim().startsWith(${JSON.stringify(option)}))?.click()
    `)
    await wait(600)
  }
  await pick('Priority', 'P0')
  let landed = null
  await waitFor(async () => (landed = await priorityOf()) === 'P0', 'the priority write to land')
  check('choosing a setting writes it through to the daemon', landed === 'P0', `daemon says ${landed}`)
  check(
    'and the button reads back what the daemon returned, not what was clicked',
    await evaluate(
      `(document.querySelector('.detail .setting-btn-select[aria-label="Priority"]')?.innerText ?? '').includes('P0')`
    )
  )
  // ⚠️ Put back, through the same control, so nothing below inherits a task this section reordered.
  await pick('Priority', wasPriority)
  await waitFor(async () => (await priorityOf()) === wasPriority, 'the priority to be restored')

  // ⛔ Measured, not eyeballed. The Send button used to be painted on top of the box somebody was
  // typing into, because an unlabelled row borrowed a three-column grid built for labelled forms.
  const compose = await evaluate(`
    JSON.stringify((() => {
      const row = document.querySelector('.compose-row');
      // The message box by class, and Send by its primary style: the row also carries a hidden
      // file <input> and the [+] attachment pill (t527), so the first input and the first button
      // are no longer the ones this measures.
      const input = row?.querySelector('.compose-input');
      const button = row?.querySelector('button.btn--primary');
      if (!row || !input || !button) return { missing: true };
      const i = input.getBoundingClientRect(), b = button.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      // Every control, so the assertion does not depend on how many sit beside the box: the row
      // carries an optional Stop as well as Send. .compose-actions is the group that keeps those
      // two together across a wrap, not a control — it is opened up and its buttons counted.
      const others = [...row.children]
        .flatMap((el) => (el.classList.contains('compose-actions') ? [...el.children] : [el]))
        .filter((el) => el !== input)
        .map((el) => Math.round(el.getBoundingClientRect().width));
      // Overlap needs both axes: when the row wraps the controls under the box (its textarea has a
      // 150px flex basis, so this happens with wide fonts in a narrow pane), Send sits *below* the
      // box, and a horizontal difference alone would call that an overlap. Stacked reads as the
      // vertical gap, negated, so the number still says "how far apart".
      const sameLine = Math.max(i.top, b.top) < Math.min(i.bottom, b.bottom);
      return {
        overlap: Math.round(sameLine ? i.right - b.left : -(b.top - i.bottom)),
        stacked: !sameLine,
        inputWidth: Math.round(i.width),
        rowWidth: Math.round(r.width),
        firstButtonWidth: Math.round(b.width),
        others
      };
    })())
  `)
  const c = JSON.parse(compose)
  check('the Send button does not sit on top of the message box', c.overlap <= 0, compose)
  // ⛔ **The box is the widest thing in the row — not a pixel count, and not a percentage either.**
  // This asserted `inputWidth > 200`, which is the width the box happens to have on a 1440-wide
  // window and says nothing about the layout: Windows CI clamps the window to a smaller screen, so
  // the identical correct layout measured 183 and the job stayed red while `overlap` was -8, the box
  // and the button adjacent exactly as intended (run 34430693395).
  //
  // ⚠️ A share of the row was the *second* wrong answer and is recorded here because it looked
  // right: the row carries fixed-width controls — Send, and a Stop that appears only while a run is
  // stoppable — so the flexible box takes 76% of an 806px row and 48% of a 378px one for the same
  // correct layout (run 34442707136). Any ratio threshold is a window-size assumption wearing a
  // percent sign. What the check is *for* is that the composer is never squeezed by the controls
  // beside it, which is true at every width and needs no constant at all.
  check('and the message box gets the room', c.others.every((w) => c.inputWidth > w), compose)

  // ⛔ Stopping used to mean leaving the thread. The only Stop outside `awaiting_human` lived in the
  // action menu on the task table, so an operator reading a run go wrong had to go back to the list,
  // find the row again and open a menu — three navigations away from the words that made them want
  // to stop. It belongs beside the box they would otherwise type into, because "say something to it"
  // and "stop it" are the same decision.
  const stopBtn = await evaluate(`
    JSON.stringify((() => {
      const row = document.querySelector('.compose-row');
      const status = (document.querySelector('.detail-side .status')?.innerText ?? '').trim();
      const buttons = [...(row?.querySelectorAll('button') ?? [])];
      const stop = buttons.find(b => /^stop/i.test(b.innerText.trim()));
      const send = buttons.find(b => /^send/i.test(b.innerText.trim()));
      const input = row?.querySelector('textarea');
      return {
        status,
        hasStop: !!stop,
        // The order of the row, left to right: what you type in, then Stop, then Send. When the
        // row has wrapped the two actions under the box (narrow pane, wide fonts — Linux CI), Stop
        // is *below* the box instead of to its right, and still directly left of Send.
        ordered: !!(stop && send && input)
          && (input.getBoundingClientRect().right <= stop.getBoundingClientRect().left + 1
            || stop.getBoundingClientRect().top >= input.getBoundingClientRect().bottom - 1)
          && stop.getBoundingClientRect().right <= send.getBoundingClientRect().left + 1,
        // ⚠️ Never disabled by the composer being empty. Stopping a run has nothing to do with
        // whether there is a draft reply sitting in the box.
        enabled: !!stop && !stop.disabled
      };
    })())
  `)
  const sb = JSON.parse(stopBtn)
  // ⚠️ Keyed off the status the pane itself is showing, not off a fixture we assume is running. The
  // set of statuses that draw the button is asserted exhaustively in `taskview.test.ts`; what this
  // has to prove is that the two agree once React, the daemon and the stylesheet are all involved.
  const working = /^(running|dispatching|queued|ready|blocked|scheduled)$/i.test(sb.status)
  check(
    working
      ? 'a task that is being worked on offers Stop beside the composer'
      : 'a task at rest offers no Stop beside the composer',
    sb.hasStop === working,
    stopBtn
  )
  if (working) {
    check('and it sits between the message box and Send, without overlapping either', sb.ordered, stopBtn)
    check('and an empty message box does not disable it', sb.enabled, stopBtn)
  }

  // ---- the ledger peek (t477) ----------------------------------------------------------
  // ⛔ A long conversation pushes the status box off the top of the page, and the only way to
  // learn whether the task was still running was to scroll back up and lose your place. Once the
  // ledger has scrolled off, a small box pinned to the top of its column repeats the task, its
  // status and — once the timeline has gone too — the latest run. ⚠️ The fixture thread is short,
  // so the conversation column is given the height a hundred-message thread has; what is being
  // measured is the scroll response, not the fixture's length.
  const peekAt = async (scrollTop) => {
    await evaluate(`document.querySelector('.content')?.scrollTo(0, ${scrollTop})`)
    // ⚠️ A hidden window is not reliably handed its scroll events at all (measured 2026-09-16: a
    // synthetic `scroll` dispatched by hand drew the peek where the real `scrollTo` had not), so
    // what this waits for is the page's once-a-second render, which re-measures on its own.
    await wait(1500)
    return JSON.parse(
      await evaluate(`
        JSON.stringify((() => {
          const content = document.querySelector('.content');
          const ledger = document.querySelector('.detail-side > .detail-side-box');
          const peek = document.querySelector('.ledger-peek');
          const top = content.getBoundingClientRect().top;
          return {
            scrollTop: Math.round(content.scrollTop),
            ledgerGone: ledger.getBoundingClientRect().bottom <= top,
            peek: peek ? peek.innerText.replace(/\\s+/g, ' ').trim() : null,
            // Pinned: drawn inside the pane's top edge, not wherever the column has scrolled to.
            pinnedTop: peek ? Math.round(peek.getBoundingClientRect().top - top) : null,
            ledgerStatus: (ledger.querySelector('.status')?.innerText ?? '').trim(),
            peekStatus: (peek?.querySelector('.status')?.innerText ?? '').trim(),
            runRows: document.querySelectorAll('.side-run').length,
            peekRun: !!peek?.querySelector('.ledger-peek-section--run')
          };
        })())
      `)
    )
  }
  await evaluate(`document.querySelector('.detail-main').style.minHeight = '4000px'`)
  const atTop = await peekAt(0)
  check('no ledger peek while the ledger itself is on screen', atTop.peek === null && !atTop.ledgerGone, JSON.stringify(atTop))
  const atBottom = await peekAt(99_999)
  check('⛔ the ledger peek appears once the ledger has scrolled off the top', atBottom.ledgerGone && atBottom.peek !== null, JSON.stringify(atBottom))
  check('and it repeats the status the ledger shows, word for word', atBottom.peekStatus !== '' && atBottom.peekStatus === atBottom.ledgerStatus, JSON.stringify(atBottom))
  check('and it is pinned inside the top of the pane', atBottom.pinnedTop !== null && atBottom.pinnedTop >= 0 && atBottom.pinnedTop < 40, JSON.stringify(atBottom))
  // ⚠️ Half the claim: the task had to have run for a run half to exist. The fixture task above
  // is one the daemon worked on, so `runRows` is non-empty and the second half is asserted.
  check(
    atBottom.runRows > 0
      ? 'and past the timeline it names the latest run as well'
      : 'and a task that never ran gets no run half',
    atBottom.peekRun === atBottom.runRows > 0,
    JSON.stringify(atBottom)
  )
  await evaluate(`document.querySelector('.ledger-peek-section')?.click()`)
  await wait(1500)
  const afterJump = await peekAt(await evaluate(`document.querySelector('.content').scrollTop`))
  check('and pressing it scrolls the ledger back into view, and the peek goes', !afterJump.ledgerGone && afterJump.peek === null, JSON.stringify(afterJump))
  await evaluate(`document.querySelector('.detail-main').style.minHeight = ''`)
  await evaluate(`document.querySelector('.content')?.scrollTo(0, 0)`)

  // ⛔ Back before anything else is checked. Everything below files a task, and the form lives on
  // the list — so a Back button that did not actually return would fail here as a missing button
  // rather than as the navigation bug it is. Assert the return itself.
  await evaluate(`document.querySelector('.back-to-list')?.click()`)
  await wait(600)
  check(
    'and going back returns to the table it came from',
    await evaluate('!!document.querySelector(".tbl tbody")')
  )

  // ---- tasks list controls and layout -------------------------------------------------
  const tasksView = await evaluate(`
    JSON.stringify((() => {
      const searchInput = document.querySelector('.tasks-search input[type="search"]');
      const titleEl = document.querySelector('.tbl-title');
      const titleStyle = titleEl ? window.getComputedStyle(titleEl) : null;
      return {
        hasSearch: !!searchInput,
        titleNowrap: titleStyle ? titleStyle.whiteSpace === 'nowrap' : false,
        titleEllipsis: titleStyle ? titleStyle.textOverflow === 'ellipsis' : false
      };
    })())
  `)
  const tv = JSON.parse(tasksView)
  check('tasks view offers a search input', tv.hasSearch === true, tasksView)
  check('task titles do not wrap in table rows', tv.titleNowrap === true && tv.titleEllipsis === true, tasksView)

  // Verify search filtering and clearing
  await evaluate(`(() => {
    const input = document.querySelector('.tasks-search input[type="search"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'nonexistent_task_query_term_xyz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await wait(600)
  check(
    'searching for a missing query shows clear-search empty state',
    await evaluate(`!!document.querySelector('.empty-inline button') && document.querySelector('.empty-inline button')?.innerText.includes('Clear search')`)
  )
  await evaluate(`document.querySelector('.empty-inline button')?.click()`)
  await wait(600)
  check(
    'clearing search restores the tasks table',
    await evaluate('!!document.querySelector(".tbl tbody tr")')
  )

  // ⛔ Delete is the destructive row action. The first click may only ask; No must leave the task
  // intact, and the affirmative choice is the only route from this UI to `task.delete`.
  const deleteFixtureTitle = 'Delete confirmation UI fixture'
  const deleteFixtureId = await evaluate(`
    (async () => {
      const task = await window.agentyard.rpc('task.create', {
        title: ${JSON.stringify(deleteFixtureTitle)}, status: 'draft'
      });
      return task.id;
    })()
  `)
  await wait(600)
  const openDelete = async () => {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.tbl tbody tr')]
        .find(r => r.innerText.includes(${JSON.stringify(deleteFixtureTitle)}));
      row?.querySelector('button[aria-label^="Actions for"]')?.click();
    })()`)
    await wait(100)
    await evaluate(`
      [...document.querySelectorAll('[role="menuitem"]')]
        .find(b => b.innerText.trim() === 'Delete')?.click()
    `)
    await wait(150)
  }
  await openDelete()
  const confirmation = await evaluate(`
    JSON.stringify((() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const buttons = [...(dialog?.querySelectorAll('button') ?? [])];
      return {
        text: dialog?.innerText ?? '',
        no: buttons.some(b => b.innerText.trim() === 'No'),
        yes: buttons.some(b => b.innerText.trim() === 'Yes, delete'),
        focused: document.activeElement?.innerText?.trim() ?? ''
      };
    })())
  `)
  const dc = JSON.parse(confirmation)
  check(
    'Delete asks for a Yes or No confirmation and defaults focus to No',
    dc.text.includes(deleteFixtureTitle) && dc.no === true && dc.yes === true && dc.focused === 'No',
    confirmation
  )
  await evaluate(`
    [...document.querySelectorAll('[role="alertdialog"] button')]
      .find(b => b.innerText.trim() === 'No')?.click()
  `)
  await wait(100)
  const declinedDelete = await evaluate(`
    (async () => {
      const task = await window.agentyard.rpc('task.get', { id: ${JSON.stringify(deleteFixtureId)} });
      return !document.querySelector('[role="alertdialog"]') && task.task.id === ${JSON.stringify(deleteFixtureId)};
    })()
  `)
  check('choosing No keeps the task', declinedDelete === true)

  await openDelete()
  await evaluate(`
    [...document.querySelectorAll('[role="alertdialog"] button')]
      .find(b => b.innerText.trim() === 'Yes, delete')?.click()
  `)
  await wait(400)
  const acceptedDelete = await evaluate(`
    (async () => {
      const page = await window.agentyard.rpc('task.page', {
        views: [], sort: 'updated', asc: false, limit: 10, offset: 0,
        query: ${JSON.stringify(deleteFixtureTitle)}
      });
      return !document.querySelector('[role="alertdialog"]') && page.total === 0;
    })()
  `)
  check('only choosing Yes deletes the task', acceptedDelete === true)

  // ⛔ **And the same way out from inside the draft.** A draft opened from the table could be edited
  // and filed and nothing else: every route to delete was a row action on a page the reader had
  // already left. The banner asks with the same dialog, and the pane goes back to the list rather
  // than re-reading a task that no longer exists.
  const draftThreadTitle = 'Delete a draft from its own thread'
  await evaluate(`
    window.agentyard.rpc('task.create', {
      title: ${JSON.stringify(draftThreadTitle)}, status: 'draft'
    })
  `)
  await wait(600)
  await evaluate(`
    [...document.querySelectorAll('.tbl tbody tr')]
      .find(r => r.innerText.includes(${JSON.stringify(draftThreadTitle)}))?.click()
  `)
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.draft-banner')`),
    'the draft banner in the task thread'
  )
  check(
    'a draft thread offers to delete the draft',
    await evaluate(`
      [...document.querySelectorAll('.draft-banner-actions button')]
        .some(b => b.innerText.trim() === 'Delete draft')
    `),
    'the only way out of a draft used to be filing it'
  )
  await evaluate(`
    [...document.querySelectorAll('.draft-banner-actions button')]
      .find(b => b.innerText.trim() === 'Delete draft')?.click()
  `)
  await waitFor(
    async () => await evaluate(`!!document.querySelector('[role="alertdialog"]')`),
    'the delete confirmation over the draft'
  )
  await evaluate(`
    [...document.querySelectorAll('[role="alertdialog"] button')]
      .find(b => b.innerText.trim() === 'Yes, delete')?.click()
  `)
  await wait(600)
  const draftGone = JSON.parse(await evaluate(`
    (async () => {
      const page = await window.agentyard.rpc('task.page', {
        views: [], sort: 'updated', asc: false, limit: 10, offset: 0,
        query: ${JSON.stringify(draftThreadTitle)}
      });
      return JSON.stringify({
        listed: page.total,
        banner: !!document.querySelector('.draft-banner'),
        onList: !!document.querySelector('.tbl tbody tr')
      });
    })()
  `))
  // ⚠️ Both halves: the task is gone, and the pane left rather than sitting on its own tombstone.
  check(
    'deleting it removes the task and returns to the list',
    draftGone.listed === 0 && draftGone.banner === false && draftGone.onList === true,
    JSON.stringify(draftGone)
  )

  // Verify First and End pager navigation
  await evaluate(`(() => {
    const sel = document.querySelector('select[aria-label="Tasks per page"]');
    if (!sel) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(sel, '1');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await wait(600)

  const pagerState = await evaluate(`
    JSON.stringify((() => {
      const buttons = [...document.querySelectorAll('.pager-nav button')];
      const first = buttons.find(b => /first/i.test(b.innerText));
      const newer = buttons.find(b => /newer/i.test(b.innerText));
      const older = buttons.find(b => /older/i.test(b.innerText));
      const end = buttons.find(b => /end/i.test(b.innerText));
      return {
        firstDisabled: first?.disabled,
        newerDisabled: newer?.disabled,
        olderDisabled: older?.disabled,
        endDisabled: end?.disabled
      };
    })())
  `)
  const ps = JSON.parse(pagerState)
  check('on first page, First and Newer are disabled, Older and End are enabled', ps.firstDisabled === true && ps.newerDisabled === true && ps.olderDisabled === false && ps.endDisabled === false, pagerState)

  await evaluate(`[...document.querySelectorAll('.pager-nav button')].find(b => /end/i.test(b.innerText))?.click()`)
  await wait(600)
  const endState = await evaluate(`
    JSON.stringify((() => {
      const buttons = [...document.querySelectorAll('.pager-nav button')];
      const first = buttons.find(b => /first/i.test(b.innerText));
      const end = buttons.find(b => /end/i.test(b.innerText));
      return { firstDisabled: first?.disabled, endDisabled: end?.disabled };
    })())
  `)
  const es = JSON.parse(endState)
  check('navigating with End reaches the last page disabling End and enabling First', es.endDisabled === true && es.firstDisabled === false, endState)

  await evaluate(`[...document.querySelectorAll('.pager-nav button')].find(b => /first/i.test(b.innerText))?.click()`)
  await wait(600)

  // Restore page size to 50
  await evaluate(`(() => {
    const sel = document.querySelector('select[aria-label="Tasks per page"]');
    if (!sel) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(sel, '50');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await wait(600)

  // ---- filing a task ------------------------------------------------------------------
  // ⛔ Order is the assertion, and since 2026-09-02 it is the reverse of what it was. The prompt used
  // to sit *under* five labelled setting rows, on the reasoning that settings narrow what a task is
  // and the prompt says what it is for. The reasoning held and the shape did not: every one of those
  // rows is answered the same way on almost every task, so the first thing anybody met was five
  // controls they were about to leave alone. The settings are all still here, one click deep, on a
  // row of pills under the box.
  await evaluate(
    `[...document.querySelectorAll('.panel-head button')].find(b => b.innerText.trim() === 'New task')?.click()`
  )
  await wait(800)
  const filing = await evaluate(`
    JSON.stringify((() => {
      const composer = document.querySelector('.composer');
      if (!composer) return { missing: true };
      const ask = composer.querySelector('.ask');
      const bar = composer.querySelector('.composer-bar');
      const pills = [...(bar?.querySelectorAll('button.pill') ?? [])].map(p => ({
        name: p.getAttribute('aria-label'),
        label: p.innerText.trim(),
        muted: p.classList.contains('pill--muted'),
        disabled: p.disabled
      }));
      const head = composer.querySelector('.composer-head');
      const project = head?.querySelector('button.pill[aria-label="Project"]');
      return {
        pills,
        textarea: !!composer.querySelector('textarea.ask-input'),
        promptIsFirst:
          !!ask && !!bar && ask.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1,
        // ⛔ The project is the one setting with no default, so it is in the head row with the
        // title — not at the end of the pill row, which is where t354 left it.
        isModal: !!composer.closest('.task-composer-modal[role="dialog"]'),
        projectInTheHead: !!project,
        projectOnThePillRow: pills.some(p => p.name === 'Project'),
        projectIsTopLeft: !!project && !!ask &&
          project.getBoundingClientRect().bottom <= ask.getBoundingClientRect().top + 1 &&
          project.getBoundingClientRect().left <
            head.getBoundingClientRect().left + head.getBoundingClientRect().width / 2,
        closeIsTopRight: (() => {
          const x = head?.querySelector('button[aria-label="Close new task"]');
          if (!x || !head) return false;
          const hr = head.getBoundingClientRect();
          return x.getBoundingClientRect().right >= hr.right - 1;
        })(),
        // The three things the old form did that this one must not: labelled rows, native pickers,
        // and the word "inherited" written out on every control that has a default.
        legacyRows: composer.querySelectorAll('.form-row').length,
        selects: composer.querySelectorAll('select').length,
        saysInherited: (bar?.innerText ?? '').toLowerCase().includes('inherit'),
        sendsInsideTheBox: !!ask?.querySelector('.composer-send'),
        attachmentInsideTheBox: !!ask?.querySelector('.composer-send button[aria-label="Add attachment"]'),
        clock: !!ask?.querySelector('.pill--clock button'),
        buttons: [...(ask?.querySelectorAll('.composer-send button') ?? [])].map(b => b.innerText.trim())
      };
    })())
  `)
  const f = JSON.parse(filing)
  const pillNames = (f.pills ?? []).map((p) => p.name)
  check('the prompt is the first thing in the composer', f.promptIsFirst === true, filing)
  check('the composer opens as a modal over the whole window', f.isModal === true, filing)
  // ⛔ **Where, not merely whether.** The project decides the workspace, the branch and the policy
  // every other control inherits, and `Send` is disabled until it is answered — so it is asked
  // first, in the head row, with the way out at the other end of the same row.
  check(
    'the project is chosen at the top left, beside the title, and not from the pill row',
    f.projectInTheHead === true && f.projectIsTopLeft === true && f.projectOnThePillRow === false,
    filing
  )
  check('and the way out is at the top right of the same row', f.closeIsTopRight === true, filing)
  check(
    'and every setting is a pill under it rather than a labelled row',
    f.legacyRows === 0 && f.selects === 0 && f.pills?.length >= 6,
    filing
  )
  check(
    'the settings row carries priority, kind, dependencies, both policies and the account',
    [
      'Priority',
      'What this files',
      'Wait for other tasks',
      'Conversation policy',
      'Finish policy',
      'Worker',
      'Model'
    ].every((name) => pillNames.includes(name)),
    filing
  )
  // ⛔ A colour, not eleven characters of the word. Eight pills each spelling out "(inherited)" is
  // the clutter this replaced; the dim ones are the answers nobody has chosen, and the tooltip still
  // names the tier for anyone who wants the answer rather than the glance.
  check(
    'an inherited answer is shown dimmed rather than labelled',
    f.saysInherited === false && (f.pills ?? []).some((p) => p.muted),
    filing
  )
  // ⚠️ The workspace choice is a joined `.seg` button group, not a pill — but it only renders
  // once a git project is selected, and no project exists yet at this point in the suite (the
  // `ui project` fixture arrives later), so there is nothing to assert here. Drive it by hand
  // with a git project selected: three segments, one pressed, Trunk filing onto the checkout.
  check(
    'draft, send and the scheduled send sit together inside the box',
    f.sendsInsideTheBox === true && f.attachmentInsideTheBox === true && f.clock === true && f.buttons?.includes('Send'),
    filing
  )
  // ⚠️ The verb, not the noun. `Draft` beside `Send` reads as a second kind of thing to file rather
  // than as what it does to the one being written.
  check(
    'and the draft button says what pressing it does',
    f.buttons?.includes('Save as Draft'),
    filing
  )
  // ⚠️ A textarea because what goes in it is sent to an agent verbatim, and a prompt worth writing
  // has a second sentence. A single-line box that ate Enter was a lie about what it would accept.
  check('the prompt takes more than one line', f.textarea === true, filing)

  // ⛔ **Plan & Split, which is the whole of t182.** The kind pill said `Plan` and every other
  // control vanished — honest while a plan task was never dispatched and nothing would have read
  // them, and wrong the moment one is. A planning turn is a real run on a real account, so it has a
  // worker, a model and an effort; and its pieces have their own, which is decision D5.
  //
  // ⚠️ Driven in the built app because the failure was *visual*: the settings were reachable in
  // state and drawn by nothing. A unit test on the prefs module would have passed throughout.
  await evaluate(
    `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === 'What this files')?.click()`
  )
  await wait(300)
  await evaluate(
    `[...document.querySelectorAll('.pill-menu [role="option"]')].find(o => o.dataset.value === 'plan')?.click()`
  )
  await wait(500)
  const planned = await evaluate(`
    JSON.stringify((() => {
      const composer = document.querySelector('.composer');
      const bars = [...composer.querySelectorAll('.composer-bar')];
      const names = bars.flatMap(bar =>
        [...bar.querySelectorAll('button.pill')].map(p => p.getAttribute('aria-label'))
      ).filter(Boolean);
      return {
        rows: bars.length,
        planner: names.filter(n => !n.startsWith('Piece')),
        pieces: names.filter(n => n.startsWith('Piece')),
        labels: [...composer.querySelectorAll('.composer-plan-label')].map(e => e.innerText.trim()),
        kindFirst: composer.querySelector('.composer-plan-table tr:first-child td:first-child button')?.innerText.trim(),
        controlsInsideTheBox: {
          draft: [...composer.querySelectorAll('.composer-send button')].some(b => b.innerText.trim() === 'Save as Draft'),
          clock: !!composer.querySelector('.composer-send .pill--clock button')
        },
        sendLabel: ([...composer.querySelectorAll('.composer-send button')]
          .find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim(),
        shape: composer.querySelector('.composer-shape svg')?.getAttribute('aria-label') ?? null,
        notices: composer.querySelectorAll('.composer-notices .composer-notice').length
      };
    })())
  `)
  const p = JSON.parse(planned)
  check(
    '⛔ Plan & Split draws the pieces’ settings rather than hiding every control',
    p.planner?.length > 0 && p.pieces?.length > 0,
    planned
  )
  // ⚠️ One row, not two. The two-row shape this once asserted was replaced by a single bar
  // that prefixes every piece control with the word `Piece`, which is what tells the two apart now —
  // so the naming is the thing worth pinning, and asserting `rows === 2` was testing a dead layout.
  check(
    'and names the piece controls apart from the planner’s, because two identical pills tell you nothing',
    p.pieces?.length > 0 && p.pieces.every((n) => n.startsWith('Piece ')),
    planned
  )
  check(
    'the planner row keeps the account, model and effort the planning turn runs as',
    ['Worker', 'Model', 'Priority', 'Finish policy'].every((n) => p.planner?.includes(n)),
    planned
  )
  // ⛔ `Piece workers` is the multi-select that carries an account *and* a per-account model, which
  // is the closed list `pieceConstraints()` files each child against. If it ever stops being drawn,
  // the composer silently files pieces with no constraints and the dispatcher picks the biggest model
  // it can — which is exactly the fault t197 was reported for.
  check(
    '⛔ and the pieces have their own account and model — "plan with one, build with another"',
    ['Piece workers', 'Piece Priority', 'Piece Limit', 'Piece Finish Policy'].every((n) =>
      p.pieces?.includes(n)
    ),
    planned
  )
  check('the send button says what it will do', p.sendLabel === 'Plan & Split', planned)
  check(
    'Plan & Split labels the planner and executor rows, with the kind first',
    p.kindFirst?.includes('Plan&Split') && p.labels?.join('|') === 'Planner|Executor',
    planned
  )
  check(
    'a plan can also be saved as a draft or scheduled from its prompt box',
    p.controlsInsideTheBox?.draft === true && p.controlsInsideTheBox?.clock === true,
    planned
  )
  // ⛔ **The shape is drawn, not described (t456).** Plan & Split and Plan & Execute differ in a
  // topology — three turns against two — and a sentence has to say a topology in the order the words
  // come. The picture is what somebody choosing between the two options actually reads, so its
  // absence is a regression the prefs module cannot see.
  check(
    'Plan & Split draws its three-turn shape beside the settings',
    typeof p.shape === 'string' && p.shape.includes('several executors'),
    planned
  )

  // ⛔ **Plan & Execute, which is the whole of t456.** The same `plan` kind and the same two rows,
  // with the fan-out filed as one — so no review turn, no plan branch to merge into, and a planner
  // that can only report. What the built app alone can say is which controls are *not* drawn: a
  // fan-out pill reading `<=1` and a planner finish pill offering five landings that will never
  // happen are both choices that are not on the table, and a unit test on the prefs module would
  // pass with either of them on screen.
  await evaluate(
    `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === 'What this files')?.click()`
  )
  await wait(300)
  const kindsOffered = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.pill-menu [role="option"]')].map(o => o.dataset.value))`
  )
  check(
    'the kind pill offers the five shapes in the order the composer teaches them',
    JSON.parse(kindsOffered).join('|') === 'task|conversation|execute|plan|debate',
    kindsOffered
  )
  await evaluate(
    `[...document.querySelectorAll('.pill-menu [role="option"]')].find(o => o.dataset.value === 'execute')?.click()`
  )
  await wait(500)
  const handed = await evaluate(`
    JSON.stringify((() => {
      const composer = document.querySelector('.composer');
      const bars = [...composer.querySelectorAll('.composer-bar')];
      const names = bars.flatMap(bar =>
        [...bar.querySelectorAll('button.pill')].map(p => p.getAttribute('aria-label'))
      ).filter(Boolean);
      return {
        planner: names.filter(n => !n.startsWith('Piece')),
        pieces: names.filter(n => n.startsWith('Piece')),
        labels: [...composer.querySelectorAll('.composer-plan-label')].map(e => e.innerText.trim()),
        kindFirst: composer.querySelector('.composer-plan-table tr:first-child td:first-child button')?.innerText.trim(),
        sendLabel: ([...composer.querySelectorAll('.composer-send button')]
          .find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim(),
        shape: composer.querySelector('.composer-shape svg')?.getAttribute('aria-label') ?? null,
        caption: composer.querySelector('.composer-shape figcaption')?.innerText.trim() ?? null,
        notices: [...composer.querySelectorAll('.composer-notices .composer-notice')].map(n => n.innerText.trim())
      };
    })())
  `)
  const h = JSON.parse(handed)
  check('the send button says Plan & Execute', h.sendLabel === 'Plan & Execute', handed)
  check(
    'Plan & Execute keeps the Planner and Executor rows, with the kind first',
    h.kindFirst?.includes('Plan&Execute') && h.labels?.join('|') === 'Planner|Executor',
    handed
  )
  check(
    'the planner row keeps its account, model and priority',
    ['Worker', 'Model', 'Priority'].every((n) => h.planner?.includes(n)),
    handed
  )
  // ⛔ Absence is the assertion, both times. A planner that writes no code and abandons its branch at
  // the handoff is `report-only` and nothing else; a fan-out of one is the *kind*, not a setting.
  check(
    '⛔ and loses the planner finish pill — report-only is the only answer, so it is not a choice',
    h.planner?.length > 0 && !h.planner.includes('Finish policy'),
    handed
  )
  check(
    '⛔ the executor row loses the fan-out pill — one piece is the shape, not a setting',
    ['Piece workers', 'Piece Priority', 'Piece Finish Policy'].every((n) => h.pieces?.includes(n)) &&
      !h.pieces.includes('Piece Limit'),
    handed
  )
  check(
    'the diagram swaps to the two-turn shape and its caption says so',
    typeof h.shape === 'string' && h.shape.includes('one executor') && /Two turns/.test(h.caption ?? ''),
    handed
  )
  // ⛔ Two notices, and every notice carries its basis: the pairing (nobody named an executor on this
  // profile, so the scheduler picks) and the shape (no review turn; the executor lands). Neither is a
  // gate — the send button above is enabled with nothing named.
  check(
    'and two notices say what the shape trades, with their basis',
    h.notices?.length === 2 &&
      h.notices.some((n) => /review turn/.test(n)) &&
      h.notices.some((n) => /lands on the project/.test(n)),
    handed
  )

  // ⛔ **Conversation, and what it *removes* from the row.** A conversation is `Reuse` + `await
  // human`, and both come from the kind rather than from a pill — `resolveFinishPolicy` and
  // `resolveSessionSharing` answer them off the task above project and fleet. So the two controls
  // are absent, and absence is the assertion: a Finish pill on a conversation would offer a landing
  // the resolver will not perform, and somebody would set it and wait for a merge that never comes.
  //
  // ⚠️ Driven here rather than unit-tested for the same reason the Plan row is. The resolver is
  // covered by `conversationkind.test.ts`; what only the built app can say is whether the pills that
  // must not be drawn are in fact not drawn.
  await evaluate(
    `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === 'What this files')?.click()`
  )
  await wait(300)
  await evaluate(
    `[...document.querySelectorAll('.pill-menu [role="option"]')].find(o => o.dataset.value === 'conversation')?.click()`
  )
  await wait(500)
  const chat = await evaluate(`
    JSON.stringify((() => {
      const composer = document.querySelector('.composer');
      const names = [...composer.querySelectorAll('.composer-bar button.pill')]
        .map(p => p.getAttribute('aria-label')).filter(Boolean);
      return {
        names,
        kind: ([...composer.querySelectorAll('button.pill')]
          .find(p => p.getAttribute('aria-label') === 'What this files')?.innerText ?? '').trim(),
        sendLabel: ([...composer.querySelectorAll('.composer-send button')]
          .find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim(),
        controlsInsideTheBox: {
          draft: [...composer.querySelectorAll('.composer-send button')].some(b => b.innerText.trim() === 'Save as Draft'),
          clock: !!composer.querySelector('.composer-send .pill--clock button')
        }
      };
    })())
  `)
  const convo = JSON.parse(chat)
  check('the composer offers Conversation as a third kind', convo.kind?.includes('Conversation'), chat)
  check(
    '⛔ and drops the Finish and Conversation pills, because the kind already answers both',
    !convo.names?.includes('Finish policy') && !convo.names?.includes('Conversation policy'),
    chat
  )
  check(
    '⚠️ while keeping everything a conversation still chooses — account, model, priority',
    ['Worker', 'Model', 'Priority'].every((n) => convo.names?.includes(n)),
    chat
  )
  check('the send button says Start rather than Send', convo.sendLabel === 'Start', chat)
  check(
    'a conversation can also be saved as a draft or scheduled',
    convo.controlsInsideTheBox?.draft === true && convo.controlsInsideTheBox?.clock === true,
    chat
  )

  // Back to Task, so nothing below inherits the plan kind.
  await evaluate(
    `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === 'What this files')?.click()`
  )
  await wait(300)
  await evaluate(
    `[...document.querySelectorAll('.pill-menu [role="option"]')].find(o => o.dataset.value === 'task')?.click()`
  )
  await wait(400)

  // A pill's menu is elements this app draws, so it is opened and read the way a person would.
  //
  // ⛔ Every read is scoped to *its own* pill's wrapper, and every menu is dismissed with a real
  // `pointerdown`. Both matter: `.click()` fires no pointer event, so the first version of this
  // block left every menu it opened standing, and a query across the document then answered the
  // Worker pill's question with the schedule presets still on screen — which picked `now` as a
  // worker id and reported green all the way to the check that finally could not parse it.
  const closeMenus = async () => {
    await evaluate(
      `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`
    )
    await wait(200)
  }
  const openPill = async (name) => {
    await closeMenus()
    await evaluate(
      `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === ${JSON.stringify(
        name
      )})?.click()`
    )
    await wait(300)
  }
  // ⛔ Found through `aria-controls`, not through the pill's parent. The menu is rendered into a
  // portal at the document root so that no scroll container can clip it, so it is not a sibling of
  // the button any more — and the id the button already publishes is the only honest link between
  // the two.
  const menuOf = (name) => `
    (() => {
      const pill = [...document.querySelectorAll('button.pill')]
        .find(p => p.getAttribute('aria-label') === ${JSON.stringify(name)});
      const id = pill?.getAttribute('aria-controls');
      return id ? document.getElementById(id) : null;
    })()
  `
  const menuValues = async (name) =>
    JSON.parse(
      await evaluate(`
        JSON.stringify((() => {
          const menu = ${menuOf(name)};
          return [...(menu?.querySelectorAll('[role="option"]') ?? [])].map(o => o.dataset.value);
        })())
      `)
    )
  const pickInMenu = async (name, value) => {
    await evaluate(`
      (() => {
        const v = ${JSON.stringify(value)};
        const menu = ${menuOf(name)};
        const row = [...(menu?.querySelectorAll('[role="option"]') ?? [])].find(o => o.dataset.value === v);
        row?.click();
        return !!row;
      })()
    `)
    await wait(400)
  }
  const pillLabel = async (name) =>
    (
      await evaluate(
        `([...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === ${JSON.stringify(
          name
        )})?.innerText ?? '')`
      )
    ).trim()

  // ⛔ The finish policy reaches every rung of the ladder plus `inherit`, which is the value that
  // keeps following the project as it changes.
  // ⚠️ And the list comes from FINISH_ORDER rather than a hand-written copy: three dropdowns each
  // carried their own and all three still offered `agent-lands` after it was renamed. Drift here is
  // silent — a stale option looks fine and sets a value the daemon no longer understands.
  await openPill('Finish policy')
  const finishOptions = await menuValues('Finish policy')
  check(
    'the finish pill offers every rung of the ladder, inherit included',
    finishOptions.includes('inherit') &&
      ['commit-only', 'commit-and-verify', 'commit-and-merge', 'commit-and-push'].every((p) =>
        finishOptions.includes(p)
      ),
    JSON.stringify(finishOptions)
  )
  check(
    'and the list comes from FINISH_ORDER rather than a hand-written copy',
    !finishOptions.includes('agent-lands'),
    JSON.stringify(finishOptions)
  )
  await closeMenus()

  await openPill('Conversation policy')
  const sharingOptions = await menuValues('Conversation policy')
  check(
    'the conversation policy offers inherit, reuse and fresh',
    ['inherit', 'on', 'off'].every((v) => sharingOptions.includes(v)),
    JSON.stringify(sharingOptions)
  )
  await closeMenus()

  // ⛔ **A menu opened inside the modal has to paint above the modal's own shade.** It is portalled
  // to `<body>`, which makes it a *sibling* of that shade rather than a descendant, and at the
  // z-index it carried in t354 every dropdown in the composer opened underneath the dialog that
  // owns it — reported as a drop-down that was clipped away. So this is hit-tested at the centre of
  // a real option: "is the menu in the DOM" was true the whole time it was invisible.
  await openPill('Project')
  const reachable = await evaluate(`
    (async () => {
      // ⚠️ Asked of the daemon rather than assumed: this suite adds its project much later, so the
      // honest count here is *however many exist now* plus the row that says one is required.
      const known = await window.agentyard.rpc('project.list', {});
      const pill = [...document.querySelectorAll('button.pill')]
        .find(p => p.getAttribute('aria-label') === 'Project');
      const menu = document.getElementById(pill?.getAttribute('aria-controls') ?? '');
      const row = menu?.querySelector('[role="option"]');
      if (!menu || !row) return JSON.stringify({ missing: true });
      const r = row.getBoundingClientRect(), mr = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const rows = [...menu.querySelectorAll('[role="option"]')];
      return JSON.stringify({
        options: rows.length,
        projects: known.length,
        firstSaysItIsRequired: (rows[0]?.innerText ?? '').includes('Choose project'),
        onTop: !!hit && menu.contains(hit),
        covering: hit ? (hit.getAttribute('class') || hit.tagName) : null,
        insideTheWindow:
          mr.top >= -1 && mr.left >= -1 &&
          mr.bottom <= window.innerHeight + 1 && mr.right <= window.innerWidth + 1,
        height: Math.round(mr.height)
      });
    })()
  `)
  const reach = JSON.parse(reachable)
  check(
    'the project picker offers every project this fleet has, and says one is required',
    reach.options === reach.projects + 1 && reach.firstSaysItIsRequired === true,
    reachable
  )
  check(
    '⛔ and its menu is on top of the modal rather than behind it, so an option can be clicked',
    reach.onTop === true && reach.height > 20,
    reachable
  )
  check(
    'and it opens inside the window, flipping above the pill when there is no room below',
    reach.insideTheWindow === true,
    reachable
  )
  await closeMenus()

  // ⚠️ The scheduled send is on the clock beside Send now, not in a row of its own. `now` is in the
  // same list so that disarming a schedule is one click where it was armed.
  await openPill('When to send')
  const scheduleOptions = await menuValues('When to send')
  check(
    'the clock beside Send offers presets and a time of your own',
    ['now', '30m', '1h', '2h', '4h', 'custom'].every((v) => scheduleOptions.includes(v)),
    JSON.stringify(scheduleOptions)
  )
  await closeMenus()

  // Dynamic prompt textarea sizing: expands with multiline/wrapping text, shrinks when cleared.
  const sizing = await evaluate(`
    JSON.stringify((() => {
      const ta = document.querySelector('textarea.ask-input');
      if (!ta) return { missing: true };
      const h0 = ta.getBoundingClientRect().height;
      const setVal = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
      setVal.call(ta, 'Line 1\\nLine 2\\nLine 3\\nLine 4\\nLine 5\\nLine 6\\nLine 7\\nLine 8');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const hMulti = ta.getBoundingClientRect().height;
      const longWrapped = 'A very long prompt sentence without explicit newlines that provides extensive and detailed instructions to the agent describing a multi-step task in full detail with background information, architecture constraints, acceptance criteria, and specific edge cases to consider, which is intentionally made very long so that it is guaranteed to wrap across multiple lines in any display or window width, demonstrating that dynamic textarea auto-sizing accurately accommodates text wrapping as well as explicit newlines.';
      setVal.call(ta, longWrapped);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const hWrap = ta.getBoundingClientRect().height;
      setVal.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const hReset = ta.getBoundingClientRect().height;
      return { h0, hMulti, hWrap, hReset, grew: hMulti > h0, wrapped: hWrap > h0, shrunk: Math.abs(hReset - h0) <= 2 };
    })())
  `)
  const s = JSON.parse(sizing)
  check('the prompt textarea dynamically resizes with content and wrap', s.grew && s.wrapped && s.shrunk, sizing)

  // ⛔ Never disabled, and never absent. A model list belongs to one CLI, so until an account is
  // pinned there is no list to draw — but *let the router choose* and *use whatever the account
  // defaults to* are answerable without knowing which account, and a locked pill said the opposite.
  const unpinnedModel = (f.pills ?? []).find((p) => p.name === 'Model')
  check(
    'the model pill is answerable before an account is pinned',
    unpinnedModel?.disabled === false && unpinnedModel?.label === 'Auto Model',
    filing
  )
  await openPill('Model')
  const unpinnedModelValues = (await menuValues('Model')).filter(Boolean)
  check(
    // ⚠️ Two, and no model ids: an id belongs to one CLI, so there is genuinely nothing to name yet.
    'and offers exactly the two answers that are not a model',
    unpinnedModelValues.length === 2 &&
      unpinnedModelValues.includes('policy:auto') &&
      unpinnedModelValues.includes('policy:inherit'),
    JSON.stringify(unpinnedModelValues)
  )
  await closeMenus()

  // Pin the account this suite commissioned, and the models its cost model can price appear.
  await openPill('Worker')
  const workerValues = await menuValues('Worker')
  const firstWorker = workerValues.find((v) => v)
  check(
    'the worker pill offers Auto and every enabled account',
    !!firstWorker,
    JSON.stringify(workerValues)
  )
  await pickInMenu('Worker', firstWorker ?? '')
  await openPill('Model')
  const modelPillValues = (await menuValues('Model')).filter(Boolean)
  // ⚠️ The two policy answers are on this pill too, and they are not model ids. They are dropped
  // here rather than being asked to price, which is the one thing they cannot be.
  const modelValues = modelPillValues.filter((v) => !v.startsWith('policy:'))
  check(
    'pinning an account offers the models its cost model can price',
    modelValues.length > 0,
    JSON.stringify(modelPillValues)
  )
  check(
    'and keeps both policy answers beside them, so neither has to be inferred from a blank',
    modelPillValues.includes('policy:auto') && modelPillValues.includes('policy:inherit'),
    JSON.stringify(modelPillValues)
  )
  check(
    'every offered model is one the daemon will accept',
    await evaluate(`
      (async () => {
        const ids = ${JSON.stringify(modelValues)};
        const opts = await window.agentyard.rpc('model.options');
        const priced = new Set(opts.flatMap(o => o.models.map(m => m.id)));
        // ⛔ Non-empty first. every() on an empty array is true, so an empty picker would have
        // reported this check green — which is exactly what it did the first time it ran, while
        // the row it was inspecting had not been found at all.
        // ⚠️ No backticks in here: this whole block is a template literal, and one would end it.
        return ids.length > 0 && ids.every(id => priced.has(id));
      })()
    `),
    'a model the cost model cannot price is one that cannot be gated or estimated for'
  )
  await closeMenus()
  check(
    'the worker pill says it pins rather than prefers',
    // ⚠️ "Preferred" would be a lie: the scheduler skips every other candidate outright.
    /pins/i.test(
      await evaluate(
        `[...document.querySelectorAll('button.pill')].find(p => p.getAttribute('aria-label') === 'Worker')?.title ?? ''`
      )
    ),
    'the tooltip is where the consequence of pinning is stated'
  )
  check(
    'no effort is offered where no CLI can be told one',
    await evaluate(
      `![...document.querySelectorAll('button.pill')].some(p => p.getAttribute('aria-label') === 'Effort')`
    ),
    'a control that cannot be honoured is worse than no control'
  )

  // ⭐ The pills remember. Inheritance supplies the first value a control ever shows and nothing
  // after that — somebody who files every task at P0 against one account should not have to choose
  // both again on the next one, which is what recomputing from the project on each open made them do.
  await openPill('Priority')
  await pickInMenu('Priority', 'P0')
  check('a chosen priority shows on the pill', (await pillLabel('Priority')) === 'P0')
  await evaluate(`document.querySelector('button[aria-label="Close new task"]')?.click()`)
  await wait(400)
  await evaluate(
    `[...document.querySelectorAll('.panel-head button')].find(b => b.innerText.trim() === 'New task')?.click()`
  )
  await wait(800)
  const remembered = await evaluate(`
    JSON.stringify((() => {
      const at = (name) => [...document.querySelectorAll('button.pill')]
        .find(p => p.getAttribute('aria-label') === name);
      return {
        priority: at('Priority')?.innerText.trim() ?? null,
        worker: at('Worker')?.innerText.trim() ?? null,
        workerMuted: at('Worker')?.classList.contains('pill--muted') ?? null,
        modelEnabled: at('Model') ? !at('Model').disabled : null
      };
    })())
  `)
  const r = JSON.parse(remembered)
  check('a reopened composer comes back on what it was last set to', r.priority === 'P0', remembered)
  check(
    'including the pinned account, which is what makes the model list survive with it',
    r.worker !== 'Auto' && r.workerMuted === false && r.modelEnabled === true,
    remembered
  )

  // ⛔ Pasting an image into the composer, driven as a real `paste` event on the real textarea.
  //
  // ⚠️ Through `clipboardData.items`, not `.files`, because that is the shape a screenshot arrives
  // in — and it is the shape the handler reads. A test that built `.files` would pass against a
  // handler that could never see a real screenshot.
  const pasted = await evaluate(`
    (async () => {
      const ta = document.querySelector('textarea.ask-input');
      if (!ta) return JSON.stringify({ missing: true });
      // A real 1x1 PNG. The daemon checks the magic number, so this cannot be a stub.
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const file = new File([bytes], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      // The upload is a round trip to the daemon; give it one.
      for (let i = 0; i < 40 && document.querySelectorAll('.chip-thumb').length === 0; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      const thumb = document.querySelector('.chip-thumb');
      return JSON.stringify({
        chips: document.querySelectorAll('.chip-thumb').length,
        isDataUrl: (thumb?.getAttribute('src') ?? '').startsWith('data:image/png;base64,'),
        removable: !!document.querySelector('.chip-x'),
        error: document.querySelector('.chip-note--bad')?.innerText ?? null
      });
    })()
  `)
  const paste = JSON.parse(pasted)
  check('pasting an image into the new-task form produces a chip', paste.chips === 1, pasted)
  check('the chip shows the image rather than a filename', paste.isDataUrl === true, pasted)
  check('and it can be taken off again before the task is filed', paste.removable === true, pasted)
  check('nothing was refused on the way', paste.error === null, pasted)

  // ⛔ And the whole way through: an uploaded image, onto a task, into the prompt an agent is given.
  // The chip above proves the renderer; this proves the thing the renderer was for.
  const carried = await evaluate(`
    (async () => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const made = await window.agentyard.rpc('attachment.create', { dataBase64: b64, mediaType: 'image/png', width: 1, height: 1 });
      const task = await window.agentyard.rpc('task.create', {
        title: 'A task filed with a screenshot on it', status: 'draft', attachmentIds: [made.id]
      });
      const page = await window.agentyard.rpc('task.get', { id: task.id });
      const onFirst = page.messages[0]?.attachments ?? [];
      const back = await window.agentyard.rpc('attachment.read', { id: made.id });
      await window.agentyard.rpc('task.delete', { id: task.id, hard: true });
      return JSON.stringify({
        count: onFirst.length,
        boundToTask: onFirst[0]?.taskId === task.id,
        // ⛔ Out of pending and under the task it belongs to.
        movedOutOfPending: !(onFirst[0]?.file ?? 'pending').includes('pending'),
        // ⛔ The path is in the prompt on every adapter, which is the fallback the whole design
        // rests on: agy cannot be sent bytes at all, and this sentence is its only channel.
        promptNamesTheFile: (page.previewPrompt ?? '').includes(onFirst[0]?.file ?? 'no-such-file'),
        readsBackTheSameBytes: back.dataBase64 === b64
      });
    })()
  `)
  const carriedResult = JSON.parse(carried)
  check('an uploaded image binds to the message the task was filed with', carriedResult.count === 1 && carriedResult.boundToTask === true, carried)
  check('its bytes move out of pending and under the task', carriedResult.movedOutOfPending === true, carried)
  check('the prompt the agent would get names the file by absolute path', carriedResult.promptNamesTheFile === true, carried)
  check('and the thread can read the same bytes back for its thumbnail', carriedResult.readsBackTheSameBytes === true, carried)

  // ⚠️ The scheduled send is armed on the clock beside Send, so the two things worth checking are
  // that a time of your own can be typed *in the menu that armed it*, and that the button somebody
  // is about to press stops saying Send once it will not.
  const readSend = async () =>
    await evaluate(
      `([...document.querySelectorAll('.composer-send button')].find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim()`
    )
  const hasCustomField = async () =>
    await evaluate(`!!document.querySelector('.pill-menu input[type="datetime-local"]')`)

  await openPill('When to send')
  const dateBefore = await hasCustomField()
  await pickInMenu('When to send', 'custom')
  const dateAfter = await hasCustomField()
  const sendWhenArmed = await readSend()
  await pickInMenu('When to send', 'now')
  const dateReset = await hasCustomField()
  const sendWhenNot = await readSend()
  await closeMenus()
  check(
    'choosing a time of your own reveals a field to type it in',
    dateBefore === false && dateAfter === true && dateReset === false,
    JSON.stringify({ dateBefore, dateAfter, dateReset })
  )
  // ⛔ The menu stays open on `custom` rather than arming a schedule with no time on it, which is
  // the one option here whose answer is not the click that chose it.
  check(
    'and the send button says which of the two it is about to do',
    sendWhenArmed === 'Schedule' && sendWhenNot === 'Send',
    JSON.stringify({ sendWhenArmed, sendWhenNot })
  )

  // ⚠️ The dialog's own close button. This read `.panel-head` `Cancel` until t356 — a button that
  // has not existed since the composer became a modal, so it matched nothing and every check below
  // ran with the dialog still open over the window it was inspecting.
  await evaluate(`document.querySelector('button[aria-label="Close new task"]')?.click()`)
  await wait(500)
  check(
    'closing the composer leaves the window with no dialog over it',
    (await evaluate(`!document.querySelector('.task-composer-modal')`)) === true,
    'the modal is the only thing between the operator and their work'
  )

  // An approval with no live session: the deadline is genuinely unknown and must render as such.
  await evaluate(`
    void window.agentyard.rpc('approval.request', {
      sessionId: 'ui-test', origin: 'permission_prompt', tool: 'Bash',
      target: 'rm -rf build', summary: 'Bash: rm -rf build'
    }).catch(() => {}); 'sent'
  `)
  await wait(2500)
  const bar = await evaluate('document.querySelector(".approvals")?.innerText ?? ""')
  check('an approval appears as a strip above the work', bar.includes('rm -rf build'))
  check('it offers allow, always and deny', /Allow/.test(bar) && /Always/.test(bar) && /Deny/.test(bar))
  check(
    'an unknown deadline renders as unknown, not as zero',
    bar.includes('--:--'),
    'the session it belongs to does not exist'
  )

  // ⛔ A question is not an approval, and the bar has to carry both without flattening either. This
  // is the case `request_human` could not express at all: three options with prose, answered with a
  // choice, where the old path could only offer allow/deny.
  await evaluate(`
    void window.agentyard.rpc('question.ask', {
      sessionId: 'ui-test', origin: 'ask_human', kind: 'choice',
      question: 'Which authentication approach should this use?', header: 'Auth approach',
      options: [
        { id: 'oauth', label: 'OAuth', detail: 'No password storage.' },
        { id: 'cookies', label: 'Session cookies' },
        { id: 'magic', label: 'Magic link' }
      ]
    }).catch(() => {}); 'sent'
  `)
  await wait(2500)
  const bothWaiting = await evaluate('document.querySelector(".approvals")?.innerText ?? ""')
  check(
    'a question and an approval queue in the same strip',
    bothWaiting.includes('rm -rf build') && bothWaiting.includes('more'),
    bothWaiting
  )

  // Clear the approval so the question becomes the one on show. Oldest first, across both kinds.
  await evaluate(`
    (async () => {
      const open = await window.agentyard.rpc('approval.list')
      for (const a of open) await window.agentyard.rpc('approval.answer', { id: a.id, decision: 'deny' })
    })(); 'answered'
  `)
  await wait(2000)
  const asking = await evaluate(`
    JSON.stringify({
      text: document.querySelector('.approvals')?.innerText ?? '',
      question: !!document.querySelector('.approvals--question'),
      buttons: [...document.querySelectorAll('.attention-answers button')].map(b => b.innerText.trim())
    })
  `)
  const ask = JSON.parse(asking)
  check('the question takes the strip once the approval is answered', ask.text.includes('Auth approach'), ask.text)
  check(
    'and it is not dressed as a warning',
    ask.question === true,
    'amber says something may be about to go wrong; an agent asking which design you want is not that'
  )
  check(
    'its own options are the buttons, not allow/deny',
    ask.buttons.join('|') === 'OAuth|Session cookies|Magic link',
    ask.buttons.join(', ')
  )

  section('layout')
  const heights = await evaluate(`
    JSON.stringify({
      approvals: document.querySelector('.approvals')?.getBoundingClientRect().height ?? 0,
      content: document.querySelector('.content')?.getBoundingClientRect().height ?? 0
    })
  `)
  const { approvals, content } = JSON.parse(heights)
  check(
    'the attention strip stays a strip',
    approvals > 0 && approvals < 90,
    `${Math.round(approvals)}px — a fixed grid-template-rows used to hand it the flexible row`
  )
  check('the content pane takes the remaining height', content > approvals * 3, `${Math.round(content)}px`)

  // ⛔ One click answers it, and the answer is the option's own label. The whole point of the object.
  await evaluate(
    `[...document.querySelectorAll('.attention-answers button')].find(b => b.innerText.trim() === 'Session cookies')?.click()`
  )
  await wait(2000)
  const settled = await evaluate(`
    (async () => JSON.stringify({
      bar: !!document.querySelector('.approvals'),
      open: (await window.agentyard.rpc('question.list')).length
    }))()
  `)
  const done = JSON.parse(settled)
  check('answering a question in one click empties the bar', done.bar === false && done.open === 0, settled)

  section('dashboard')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Dashboard')).click()`
  )
  await wait(1500)
  const dashboardPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the loose ends view renders on dashboard', dashboardPanel.includes('Loose ends'))

  section('routing model > cost')
  // ⛔ Cost is no longer a sibling of Routing Model in the sidebar — it is the cost axis *of* the
  // routing model and is a tab under it. The page itself is unchanged, so every check below is the
  // one it has always been; only how the page is reached moved.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Routing Model')).click()`
  )
  await wait(800)
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Cost').click()`
  )
  await wait(1500)
  const costModelPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the cost model analytics view renders', costModelPanel.includes('Cost Model'))
  check(
    'it states the objective it is working to',
    /cost 0\.\d\d/.test(costModelPanel),
    'a scheduler that spends money should say what it is optimising for'
  )
  check(
    'an unknown remaining budget says so rather than showing a number',
    costModelPanel.includes('size unknown') || costModelPanel.includes('unknown'),
    'this is the honest state on a CLI with no free usage probe'
  )
  check(
    'shows cache clock and compaction reserves sections',
    /cache clock/i.test(costModelPanel) && /compaction reserve/i.test(costModelPanel)
  )
  check(
    'it leads with what a run costs in money, not in tokens',
    /what a run costs in money/i.test(costModelPanel),
    'every agent on this fleet is on a subscription, so tokens are a proxy for a bill nobody pays'
  )
  check(
    'it names the three layers and says the list price is excluded',
    /subscription/i.test(costModelPanel) &&
      /overage/i.test(costModelPanel) &&
      /list price/i.test(costModelPanel),
    'usd = subscription + overage; listUsd rides beside it and is never summed in'
  )
  check(
    'it says unpriced work is n/a rather than free',
    /n\/a/i.test(costModelPanel) && /\$0\.00/.test(costModelPanel),
    'a run nobody could price and a run that cost nothing are different facts'
  )
  check(
    'it shows where the money is measured, or that no meter reported',
    /spend meters/i.test(costModelPanel),
    'a dollar figure whose source is invisible is a dollar figure nobody can check'
  )
  check(
    'it keeps the token arithmetic as the stated fallback',
    /token normalization/i.test(costModelPanel) && /fall(s|ing|back| back)/i.test(costModelPanel),
    'money-first is only honest if the page says what happens when there is no price'
  )
  check(
    'it lists active cost models loaded in the daemon',
    /active cost models/i.test(costModelPanel)
  )
  check(
    'it says what each agent costs, or that nothing has been measured yet',
    /what each agent costs/i.test(costModelPanel) &&
      (/×\d/.test(costModelPanel) || /nothing has completed yet/i.test(costModelPanel)),
    'the estimator multiplies by these; a multiplier nobody can see is a multiplier nobody can check'
  )
  check(
    'it explains how the multiplier is calculated',
    /multiplier/i.test(costModelPanel) && /shrinkage/i.test(costModelPanel)
  )

  section('routing model > overview')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Routing Model')).click()`
  )
  await wait(1500)
  const routingTabs = await evaluate('[...document.querySelectorAll(".tab")].map(b => b.innerText.trim())')
  check(
    'the routing model is one page per axis, plus the overview that ties them together',
    ['Overview', 'Quality', 'Cost', 'Velocity', 'Models'].every((label) => routingTabs.includes(label)),
    routingTabs.join(' | ')
  )
  const routingPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the routing model view renders', routingPanel.includes('Routing Model'))
  check(
    'it publishes the sum a score actually is, rather than describing it',
    /weight/.test(routingPanel) && /value/.test(routingPanel) && /2\.2×cost/.test(routingPanel),
    'a rendered number nobody can derive is a number nobody can check'
  )
  check(
    'it states the balanced vector as quality 40 / cost 30 / velocity 30',
    /quality 0\.40/.test(routingPanel) &&
      /cost 0\.30/.test(routingPanel) &&
      /velocity 0\.30/.test(routingPanel),
    routingPanel.slice(0, 400)
  )
  check(
    'it shows the recorded decisions, or says plainly that none have been recorded',
    /routing decisions/i.test(routingPanel) &&
      (/Show the arithmetic/.test(routingPanel) || /Nothing has been dispatched/i.test(routingPanel)),
    'the table is the point of the page; an empty one has to say why it is empty'
  )

  section('routing model > quality')
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Quality').click()`
  )
  await wait(1500)
  const qualityPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'it explains the peer review in plain language, not as a list of fields',
    /never the author/i.test(qualityPanel) && /blind/i.test(qualityPanel),
    'the two claims the whole feature rests on'
  )
  check(
    'it publishes the rubric with its weights',
    /Requirement fidelity/i.test(qualityPanel) && /Self-sufficiency/i.test(qualityPanel) && /0\.20/.test(qualityPanel)
  )
  check(
    'it says how much finished work has no grade',
    /ungraded/i.test(qualityPanel),
    'a page about scores that never says how much work carries none is a page with a blind spot'
  )
  check(
    '⛔ it no longer spends turns itself, and sends you to the one page that does',
    !/Grade up to 5/.test(qualityPanel) && /Quality Review/i.test(qualityPanel),
    'two buttons spending turns on the same accounts under different caps is a way to empty a ' +
      'quota window by pressing the wrong one'
  )

  section('routing model > velocity')
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Velocity').click()`
  )
  await wait(1500)
  const velocityPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'it separates availability from measured pace',
    /available/i.test(velocityPanel) && /pace/i.test(velocityPanel),
    'a gate and a preference fail differently and must not be shown as one number'
  )
  check(
    'it names the gates in the order they are asked',
    /concurrency/i.test(velocityPanel) && /quota water mark/i.test(velocityPanel) && /capabilit/i.test(velocityPanel)
  )
  check(
    'it says the pace factor is learned from active time, never wall-clock',
    /active time/i.test(velocityPanel) && /wall-clock/i.test(velocityPanel),
    'the whole reason the number is not the span the task existed inside'
  )
  check(
    'it admits what the measurement cannot separate',
    /gets the long tasks/i.test(velocityPanel),
    'a factor presented without its confound is a confident unsourced number'
  )

  section('routing model > models')
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Models').click()`
  )
  await wait(1500)
  const modelsPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'it explains that a candidate is a (worker, model) pair, not an account',
    /\(worker, model\) pair/i.test(modelsPanel),
    'the reason this tab exists rather than being a column on another one'
  )
  check(
    'it says the allowlist is opt-in and inert until touched',
    /inert until touched/i.test(modelsPanel),
    'model-aware routing must not silently widen every worker to every model it can price'
  )
  check(
    'it publishes the sufficiency bar for every complexity band',
    /low/.test(modelsPanel) && /medium/.test(modelsPanel) && /high/i.test(modelsPanel) && /0\.35/.test(modelsPanel) && /0\.75/.test(modelsPanel),
    'a routing decision nobody can check is a routing decision nobody can trust'
  )
  check(
    'it names the shrinkage constant and says why it is larger than the other two',
    /K = 8/.test(modelsPanel) && /K=5/.test(modelsPanel) && /K=4/.test(modelsPanel),
    'the least calibrated of the three quantities this fleet shrinks should move the slowest'
  )
  check(
    'it admits a low-fitness pair is unmeasured, not bad',
    /unmeasured/i.test(modelsPanel) && /not.*bad/i.test(modelsPanel),
    'the same "unknown is a verdict" rule the rest of the fleet holds quota and pace readings to'
  )
  check(
    'it explains exploration and says it is off by default',
    /exploration/i.test(modelsPanel) && /off by default/i.test(modelsPanel)
  )
  check(
    'the fleet table is non-empty: at least the priced models on the commissioned worker appear',
    /claude-opus-5/.test(modelsPanel) && /claude-sonnet-5/.test(modelsPanel),
    'the UI worker has no credentials, so this is the one part of the page that must not pass on an empty table'
  )
  check(
    'an unmeasured cost renders n/a, never $0.00',
    /n\/a/i.test(modelsPanel),
    'nothing on this install has ever priced a run'
  )
  // ⛔ A prior is a belief, and AGENTS.md says every belief carries its basis. The page must name
  // the leaderboard each number was read off, not merely print the number.
  check(
    'every prior cites where it came from, with the file and the retrieval date',
    /Prior source/i.test(modelsPanel) &&
      /vals-terminal-bench-2\.1/.test(modelsPanel) &&
      /coding-agents\.2026-09/.test(modelsPanel) &&
      /2026-09-04/.test(modelsPanel),
    'the priors table is the one place an operator can check the numbers routing ranks models by'
  )
  const priorLinks = JSON.parse(
    await evaluate(`(() => {
      const links = [...document.querySelectorAll('.content a[href^="https://"]')]
        .filter(a => a.target === '_blank');
      return JSON.stringify({ n: links.length, hrefs: links.slice(0, 3).map(a => a.href) });
    })()`)
  )
  check(
    'each source opens in the real browser rather than navigating the shell',
    priorLinks.n > 0 && priorLinks.hrefs.every((h) => /^https:\/\//.test(h)),
    JSON.stringify(priorLinks)
  )

  section('routing model > the paper as a whole')
  // ⛔ Every table is centred in the column — read off geometry, because a `margin: 0 auto` that a
  // `width: 100%` elsewhere overrides looks identical to a selector. A table wider than the column
  // used to run off its right edge (Table 12 by 52px at 76ch, 2026-09-12); that is the failure
  // mode this reads for, so a table is also required to sit inside the column.
  const paperTables = JSON.parse(
    await evaluate(`(() => {
      const paper = document.querySelector('.paper');
      if (!paper) return JSON.stringify({ n: 0 });
      const p = paper.getBoundingClientRect();
      const tables = [...paper.querySelectorAll('table')].map(t => {
        const b = t.getBoundingClientRect();
        // Measured against the table's own container, which for a two-up pair is a grid cell.
        const c = t.parentElement.getBoundingClientRect();
        return { left: Math.round(b.left - c.left), right: Math.round(c.right - b.right), inside: b.left >= p.left - 1 && b.right <= p.right + 1 };
      });
      return JSON.stringify({ n: tables.length, tables, ok: tables.every(t => Math.abs(t.left - t.right) <= 2 && t.inside) });
    })()`)
  )
  check(
    'every table in the paper is centred in its column and inside it',
    paperTables.n > 0 && paperTables.ok,
    JSON.stringify(paperTables)
  )
  // ⚠️ The document can be narrower than its preferred reading measure when the sidebar is open.
  // Constrain the real scroll surface rather than changing the browser viewport: the assertion is
  // about the page column and its tables sharing a centre line, not about a platform window size.
  const narrowPaper = JSON.parse(
    await evaluate(`(() => {
      const content = document.querySelector('.content');
      const paper = document.querySelector('.paper');
      if (!content || !paper) return JSON.stringify({ ok: false, why: 'paper missing' });
      const prior = content.getAttribute('style');
      content.style.width = '620px';
      content.style.flex = '0 0 620px';
      // ⚠️ The client box, not the border box: a classic (Windows) scrollbar takes ~10px from the
      // right of \`.content\`, and the page is centred in the space that remains.
      const b = content.getBoundingClientRect();
      const c = { left: b.left + content.clientLeft, right: b.left + content.clientLeft + content.clientWidth };
      const p = paper.getBoundingClientRect();
      const tables = [...paper.querySelectorAll('table')].map(t => t.getBoundingClientRect());
      if (prior === null) content.removeAttribute('style'); else content.setAttribute('style', prior);
      return JSON.stringify({
        ok: Math.abs((p.left + p.right) / 2 - (c.left + c.right) / 2) <= 1 &&
          tables.every(t => t.left >= p.left - 1 && t.right <= p.right + 1),
        paper: { left: Math.round(p.left - c.left), right: Math.round(c.right - p.right) },
        tables: tables.map((t, i) => ({
          left: Math.round(t.left - p.left),
          right: Math.round(p.right - t.right),
          caption: (paper.querySelectorAll('table')[i].caption?.textContent ?? '').slice(0, 40)
        }))
      });
    })()`)
  )
  check(
    'a narrowed routing-model page and every table in it remain centred and unclipped',
    narrowPaper.ok,
    JSON.stringify(narrowPaper)
  )
  check(
    'a numeric column is centred under its head',
    await evaluate(`(() => {
      const cells = [...document.querySelectorAll('.paper .tbl--paper td.tbl-num')];
      return cells.length > 0 && cells.every(td => getComputedStyle(td).textAlign === 'center');
    })()`)
  )
  // The pager at the foot of a section: the last section has only Previous, the first only Next,
  // and turning the page lands on the top of the next section rather than at its foot.
  const pagerOnLast = await evaluate(
    `[...document.querySelectorAll('.paper-pager-link')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`
  )
  check(
    'the last section offers Previous and not Next',
    pagerOnLast.length === 1 && /^Previous §4 The velocity axis$/.test(pagerOnLast[0]),
    pagerOnLast.join(' | ')
  )
  await evaluate(`document.querySelector('.paper-pager-link--previous').click()`)
  await wait(800)
  const turned = JSON.parse(
    await evaluate(`(() => {
      const active = document.querySelector('.paper-contents .tab--active')?.innerText.trim();
      const links = [...document.querySelectorAll('.paper-pager-link')].map(b => b.innerText.replace(/\\s+/g, ' ').trim());
      const heading = [...document.querySelectorAll('.paper .doc-section h3')][0];
      const r = heading?.getBoundingClientRect();
      return JSON.stringify({ active, links, headingTop: r ? Math.round(r.top) : null, viewport: window.innerHeight });
    })()`)
  )
  check(
    'Previous turns to §4 and shows it from the top, with both links at its foot',
    turned.active === 'Velocity' &&
      turned.links.length === 2 &&
      /^Previous §3 The cost axis$/.test(turned.links[0]) &&
      /^Next §5 Choosing a model, not only an account$/.test(turned.links[1]) &&
      turned.headingTop !== null &&
      turned.headingTop >= 0 &&
      turned.headingTop < turned.viewport,
    JSON.stringify(turned)
  )
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Overview').click()`
  )
  await wait(800)
  const pagerOnFirst = await evaluate(
    `[...document.querySelectorAll('.paper-pager-link')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`
  )
  check(
    'the first section offers Next and not Previous',
    pagerOnFirst.length === 1 && /^Next §2 The quality axis$/.test(pagerOnFirst[0]),
    pagerOnFirst.join(' | ')
  )
  const motivation = await evaluate(
    `[...document.querySelectorAll('.paper .doc-section')].find(s => /1\\.1 Motivation/.test(s.querySelector('h3')?.innerText ?? ''))?.innerText ?? ''`
  )
  check(
    '1.1 Motivation is addressed to a developer, not an operator',
    /developer/.test(motivation) && !/operator/.test(motivation),
    motivation.slice(0, 200)
  )

  section('statistics')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Statistics')).click()`
  )
  await wait(1500)
  const statsTabs = await evaluate('[...document.querySelectorAll(".tab")].map(b => b.innerText.trim())')
  check(
    'statistics is three tabs: what a task cost, what it took, and what it scored',
    ['Model Price per Task', 'Velocity per Task', 'Quality per Task'].every((label) =>
      statsTabs.includes(label)
    ),
    statsTabs.join(' | ')
  )
  const pricePanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the statistics view renders', pricePanel.includes('Statistics'))
  const centredStatsPage = JSON.parse(
    await evaluate(`(() => {
      const content = document.querySelector('.content');
      const page = document.querySelector('.statistics-paper');
      if (!content || !page) return JSON.stringify({ ok: false, why: 'statistics page missing' });
      const prior = content.getAttribute('style');
      content.style.width = '1400px';
      content.style.flex = '0 0 1400px';
      const c = content.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      if (prior === null) content.removeAttribute('style'); else content.setAttribute('style', prior);
      return JSON.stringify({
        ok: Math.abs((p.left + p.right) / 2 - (c.left + c.right) / 2) <= 1,
        left: Math.round(p.left - c.left), right: Math.round(c.right - p.right)
      });
    })()`)
  )
  check(
    'a page column remains centred when the content pane is wider than its measure',
    centredStatsPage.ok,
    JSON.stringify(centredStatsPage)
  )
  check(
    '⛔ it says out loud that it is not the number the router reads',
    /not.*the number the router reads/i.test(pricePanel) && /shrunk/i.test(pricePanel),
    'sitting one nav item from three pages of shrunk numbers, a descriptive page that does not say ' +
      'so is a page whose numbers will be read as the routing ones'
  )
  check(
    'it distinguishes an amortised subscription share from money billed on top',
    /subs/i.test(pricePanel) && /API rate/i.test(pricePanel) && /mixed/i.test(pricePanel),
    pricePanel.slice(0, 300)
  )
  check(
    'an empty table says why it is empty rather than rendering nothing',
    /completed tasks only/i.test(pricePanel) || /Agent \/ Model \/ Effort/i.test(pricePanel),
    'this install finishes no tasks, so the empty state is the state under test'
  )

  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Velocity per Task').click()`
  )
  await wait(800)
  const statsVelocity = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'velocity here is active time, and it says so before any number',
    /active time/i.test(statsVelocity) && /wall-clock/i.test(statsVelocity),
    statsVelocity.slice(0, 300)
  )
  check(
    '⚠️ and it warns that it will not match the pace factor next door',
    /will not match/i.test(statsVelocity) && /pace factor/i.test(statsVelocity),
    'two velocity numbers that disagree, with nothing saying which question each answers, is worse ' +
      'than one'
  )

  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Quality per Task').click()`
  )
  await wait(800)
  const statsQuality = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'with nothing graded it offers the benchmark baseline and names it as such',
    /baseline/i.test(statsQuality) && /benchmark/i.test(statsQuality),
    statsQuality.slice(0, 300)
  )
  check(
    '⛔ an ungraded key reads unknown, never 0 and never average',
    /unknown/i.test(statsQuality) && /never 0/i.test(statsQuality),
    'the same "unknown is a verdict" rule the rest of the fleet holds its readings to'
  )
  check(
    'it repeats that nothing here gates a routing decision',
    /gates? a routing decision/i.test(statsQuality),
    'a leaderboard nobody says is inert is a leaderboard people assume is live'
  )

  section('quality review')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Quality Review')).click()`
  )
  await wait(1500)
  const reviewPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the quality review view renders', reviewPanel.includes('Quality Review'))
  check(
    'it counts finished work by how many grades it carries',
    /no review/i.test(reviewPanel) &&
      /1 review/i.test(reviewPanel) &&
      /2 or more/i.test(reviewPanel),
    reviewPanel.slice(0, 400)
  )
  check(
    '⛔ it says an agent is never asked to grade the same task twice',
    /grade a task twice|asked to grade a task twice|graded a task twice/i.test(reviewPanel) ||
      /No agent is asked to grade a task twice/i.test(reviewPanel),
    'the rule that stops a batch of fifty paying twice for an answer it already has'
  )
  check(
    '⚠️ and that each review spends a real turn, before anything is pressed',
    /real turn/i.test(reviewPanel) && /ALL/.test(reviewPanel),
    'ALL is unbounded work on real accounts and has to say so'
  )
  const batchControls = await evaluate(
    '[...document.querySelectorAll(".content select")].map(s => [...s.options].map(o => o.text).join(","))'
  )
  check(
    'the batch offers a size and a threshold, both in plain words',
    batchControls.some((opts) => opts.includes('ALL')) &&
      batchControls.some((opts) => /no reviews/.test(opts) && /fewer than 2 reviews/.test(opts)),
    batchControls.join(' | ')
  )
  check(
    'an empty bucket says why it is empty rather than rendering nothing',
    /Nothing in this bucket/i.test(reviewPanel) || /Can still be graded/i.test(reviewPanel),
    'this install grades nothing, so the empty state is the state under test'
  )

  section('controller')
  // Controller has its own destination under Overview in the sidebar.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Controller')).click()`
  )
  await wait(1500)
  const controllerPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the controller view renders', controllerPanel.includes('Controller'))
  check(
    'it says up front that it is never in the critical path',
    /deterministic answer/i.test(controllerPanel),
    'an operator has to know the fleet keeps working when this is down'
  )
  check(
    'an account that cannot be asked says why, in words',
    /not signed in|disabled|human-occupied|window/i.test(controllerPanel),
    '"not now" on its own is the kind of state nobody can act on'
  )
  check(
    'the ledger is present even before anything has needed judgment',
    /judgment calls/i.test(controllerPanel),
    'what it decided and what that cost is the reason to trust or override it'
  )
  check(
    'the hourly cap is visible without being asked for',
    /\d+\/\d+ this hour/.test(controllerPanel),
    'the one loop that can spend should show its ceiling'
  )

  section('app settings')
  // ⛔ These are the app's own preferences, not the fleet's: they go through the main process rather
  // than the daemon, because whether closing the window stops orchestratord is a decision main has
  // to make when the daemon is NOT answering - which is exactly when it matters.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Global')).click()`
  )
  await wait(1500)
  // ⚠️ Global opens on **Fleet settings** since t422 split it into tabs, and the window preferences
  // moved behind **App behavior**. These four checks went red in that commit rather than in the one
  // that noticed: the switch is still there, still a switch, and still says what turning it off ends
  // — the suite was simply looking at the tab in front of it. Reaching the tab is the whole fix.
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'App behavior')?.click()`
  )
  await wait(1000)
  const globalPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'the Global page offers the tray switch',
    /keep running in the tray/i.test(globalPanel),
    JSON.stringify(globalPanel.slice(0, 60))
  )
  check(
    'it defaults to off, so closing the window means what it looks like it means',
    (await evaluate(
      `window.agentyard.getUiSettings().then(s => String(s.tray))`
    )) === 'false'
  )
  // ⚠️ Both consequences have to be stated, because each is a surprise in the other direction: off
  // and a close can end an agent mid-run; on and a scheduler outlives the only window showing it.
  check(
    'and off says what it will stop',
    /ends every running agent/i.test(globalPanel),
    'a quit that silently discards the context an agent holds is not a preference anybody set'
  )

  const traySwitch = `[...document.querySelectorAll('.switch')].find(
     s => s.getAttribute('aria-label') === 'Keep running in the tray')`
  check(
    'the tray control is a real switch',
    (await evaluate(`${traySwitch}?.getAttribute('role')`)) === 'switch'
  )
  await evaluate(`${traySwitch}.click()`)
  await wait(1200)
  check(
    'turning it on is persisted by the main process, not just painted',
    (await evaluate(`window.agentyard.getUiSettings().then(s => String(s.tray))`)) === 'true',
    'the switch reads back what main returned, never the value that was clicked'
  )
  const onPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'and on explains that the fleet now outlives the window',
    /tray icon brings the window back|scheduler keeps working/i.test(onPanel),
    JSON.stringify(onPanel.slice(onPanel.search(/keep running in the tray/i), 0 + 120))
  )
  await evaluate(`${traySwitch}.click()`)
  await wait(1200)
  check(
    'and it goes back off',
    (await evaluate(`${traySwitch}?.getAttribute('aria-checked')`)) === 'false'
  )

  // ⭐ The one switch on this panel that defaults **on**, and the asymmetry is the point: a host
  // left running to take work sleeps mid-run and the session's context is gone, which the operator
  // learns from the task table the next morning. Reported 2026-09-13 against a remote macOS machine.
  // ⛔ The default is the whole feature — nobody opens the settings panel on the machine this
  // matters most on — so it is read back from main rather than off the painted switch.
  check(
    'the Global page offers a keep-awake switch',
    /keep this computer awake/i.test(globalPanel),
    JSON.stringify(globalPanel.slice(0, 60))
  )
  check(
    '⛔ and it defaults on, unlike every other switch here',
    (await evaluate(`window.agentyard.getUiSettings().then(s => String(s.preventSleep))`)) === 'true'
  )
  // ⚠️ It asks the OS not to *idle*-sleep. Saying so is what stops a closed lid reading as a bug.
  check(
    'and says what it cannot do, so a lid closed on it is not read as a failure',
    /closed lid/i.test(globalPanel),
    'a promise this switch cannot keep would be worse than no switch'
  )
  const sleepSwitch = `[...document.querySelectorAll('.switch')].find(
     s => s.getAttribute('aria-label') === 'Keep this computer awake')`
  await evaluate(`${sleepSwitch}.click()`)
  await wait(1200)
  check(
    'turning it off is persisted by main, not just painted',
    (await evaluate(`window.agentyard.getUiSettings().then(s => String(s.preventSleep))`)) === 'false',
    'the switch reads back what main returned, never the value that was clicked'
  )
  check(
    'and off names what a sleeping machine costs',
    /context is not|suspended with it/i.test(
      await evaluate('document.querySelector(".content")?.innerText ?? ""')
    ),
    'committed work survives a sleep; the session holding the context does not'
  )
  await evaluate(`${sleepSwitch}.click()`)
  await wait(1200)
  check(
    'and back on, which is where a fresh install starts',
    (await evaluate(`${sleepSwitch}?.getAttribute('aria-checked')`)) === 'true'
  )

  check(
    'the Global page offers enter key behavior setting',
    /enter key behavior/i.test(globalPanel)
  )
  check(
    'enter key behavior defaults to send',
    (await evaluate(
      `window.agentyard.getUiSettings().then(s => s.enterBehavior)`
    )) === 'send'
  )
  const enterPicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Enter key behavior')`
  check(
    'the enter key behavior control is present',
    (await evaluate(`Boolean(${enterPicker})`)) === true
  )
  await evaluate(`${enterPicker}.value = 'newline'; ${enterPicker}.dispatchEvent(new Event('change', { bubbles: true }))`)
  await wait(800)
  check(
    'changing enter behavior to newline is persisted',
    (await evaluate(`window.agentyard.getUiSettings().then(s => s.enterBehavior)`)) === 'newline'
  )
  await evaluate(`${enterPicker}.value = 'send'; ${enterPicker}.dispatchEvent(new Event('change', { bubbles: true }))`)
  await wait(800)
  check(
    'changing enter behavior back to send is persisted',
    (await evaluate(`window.agentyard.getUiSettings().then(s => s.enterBehavior)`)) === 'send'
  )

  section('chrome')
  // ⛔ `color-scheme` is what stops the browser painting UA surfaces light on a dark app - the
  // scrollbars most visibly, but also over-scroll and form-control internals. Styling
  // `::-webkit-scrollbar` alone leaves all of that, which is why this is checked rather than the
  // pseudo-element: it is the half that is easy to forget and impossible to see in a diff.
  check(
    'the app declares its colour scheme, so UA-drawn surfaces follow the theme',
    /dark|light/.test(
      await evaluate(`getComputedStyle(document.documentElement).colorScheme`)
    ),
    await evaluate(`getComputedStyle(document.documentElement).colorScheme`)
  )
  check(
    'and the scrollbar thumb is a theme colour rather than the default',
    (await evaluate(`getComputedStyle(document.documentElement).scrollbarColor`)) !== 'auto',
    await evaluate(`getComputedStyle(document.documentElement).scrollbarColor`)
  )

  // The sidebar is resizable, and the handle is keyboard-operable - `role="separator"` with a
  // tabindex promises arrow keys work, so the promise is tested.
  const widthNow = `parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)`
  const before = await evaluate(widthNow)
  check('the sidebar has a resize handle', before > 0, String(before))
  check(
    'which announces itself as a separator with a range',
    (await evaluate(
      `(() => { const r = document.querySelector('.resizer');
                return r ? [r.getAttribute('role'), r.getAttribute('aria-valuemin') !== null,
                            r.tabIndex >= 0].join(',') : 'absent' })()`
    )) === 'separator,true,true'
  )
  await evaluate(
    `(() => { const r = document.querySelector('.resizer'); r.focus();
              r.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })()`
  )
  await wait(400)
  const wider = await evaluate(widthNow)
  check('and the arrow keys move it', wider > before, `${before} -> ${wider}`)

  // ⚠️ Persisted on this display only, deliberately: a pane width is not a fleet setting and has no
  // business in the daemon's settings table beside the switches that gate spending.
  check(
    'the new width is remembered',
    (await evaluate(`window.localStorage.getItem('warmstart.sidebarWidth')`)) ===
      String(wider),
    String(wider)
  )
  await evaluate(
    `(() => { const r = document.querySelector('.resizer');
              r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
  )
  await wait(400)
  check(
    'and a double-click puts it back, so a bad drag is recoverable',
    (await evaluate(widthNow)) === 252,
    String(await evaluate(widthNow))
  )

  section('fleet strip')
  // ⛔ A reading that has gone stale is *shown*, dimmed and labelled — it used to be replaced by the
  // words `quota unknown`, which made an account measured yesterday indistinguishable from one that
  // has never been measured at all. ⚠️ The numbers only; nothing downstream may act on them, and
  // `quotareading.test.ts` is what holds that line. This check is about what a person sees.
  const staleWorker = await evaluate(
    `window.agentyard.rpc('fleet.list', {}).then(f => f[0].worker.id)`
  )
  {
    // Seeded through the store, because no RPC can file a reading from twenty hours ago and the
    // suite must not wait twenty hours to find out how one is drawn.
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    const at = Date.now() - 20 * 3600 * 1000
    // ⚠️ Labelled the way an adapter labels them — pool name and window length — because what the
    // card does with that pair is checked below.
    for (const [id, label, pct] of [
      ['session', 'Claude 5h', 11],
      ['weekly', 'Claude 7d', 16]
    ]) {
      store
        .prepare(
          `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
           values (?,?,?,?,?,?,?)`
        )
        .run(staleWorker, id, label, pct, at + 7_200_000, 'config cache', at)
    }
    store.close()
  }
  // A worker event is what makes the strip re-read the fleet; the edit itself is a no-op.
  await evaluate(
    `window.agentyard.rpc('worker.update', { id: ${JSON.stringify(staleWorker)}, maxConcurrent: 1 })`
  )
  await wait(1500)
  const strip = await evaluate(`document.querySelector('.fleet')?.innerText ?? ''`)
  check('a stale reading still shows its numbers', /11%/.test(strip), JSON.stringify(strip.slice(0, 90)))
  // ⛔ **The age, not the word.** An idle account's reading is old because nothing has used the
  // account — its window is not moving either — and printing `stale` over that sent operators to
  // press Probe on accounts that were fine. The word is still the *gate* (`quotareading.test.ts`);
  // it is no longer the label.
  check('and says how old they are, rather than calling them stale', /(?:read\s+)?20h ago/i.test(strip), JSON.stringify(strip.slice(0, 120)))
  check('⛔ without the word that made old read as broken', !/stale/i.test(strip))
  check(
    'rather than calling a measured account unknown',
    !/quota unknown/i.test(strip),
    'an account read yesterday and one never read are different states'
  )

  // ⛔ The pool name on a window label is the card's own title repeated down the rows, and it is
  // charged to the one column the bars are competing with. It comes off when what is left still
  // names a different window on each row — Antigravity's two pools are the case where it does not,
  // and `fleetcard.test.ts` holds that half, which needs no card to be true.
  const windowLabels = JSON.parse(
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.wcard')].find(c => c.querySelector('.wcard-windows'));
      const gauge = card?.querySelector('.wcard-windows .gauge');
      return JSON.stringify({
        labels: [...(card?.querySelectorAll('.wcard-windows .gauge-label') ?? [])].map(n => n.innerText),
        titles: [...(card?.querySelectorAll('.wcard-windows .gauge') ?? [])].map(n => n.title),
        column: gauge ? getComputedStyle(gauge).gridTemplateColumns.split(' ')[0] : null
      });
    })()`)
  )
  check(
    'a one-pool card drops the pool name its own title already says',
    JSON.stringify(windowLabels.labels) === JSON.stringify(['5h', '7d']),
    JSON.stringify(windowLabels)
  )
  check(
    '⚠️ and keeps the full name on the row, for whoever needs it named',
    JSON.stringify(windowLabels.titles) === JSON.stringify(['Claude 5h', 'Claude 7d']),
    JSON.stringify(windowLabels.titles)
  )
  // The 84px default is in the stylesheet for `Claude/GPT 5h`, which only a two-pool account draws.
  check(
    'and the width those names needed goes to the bar instead',
    windowLabels.column === '44px',
    JSON.stringify(windowLabels.column)
  )

  // ⛔ A suspect worker without quota windows shows `error · see Settings > Workers` and suppresses `quota unknown`
  const suspectWorkerId = await evaluate(
    `window.agentyard.rpc('worker.create', { adapterId: 'claude-code', label: 'suspect worker', enabled: true }).then(w => w.id)`
  )
  {
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    const health = JSON.stringify({
      state: 'suspect',
      reason: 'subscription expired',
      strikes: 1,
      since: Date.now(),
      runId: null,
      needsReauth: false
    })
    store.prepare('update workers set health_json = ? where id = ?').run(health, suspectWorkerId)
    // ⛔ Seeded in the same breath as the health row above, and deliberately not in a round-trip of
    // its own: every extra `worker.update` + settle in this section is time the scheduler spends
    // dispatching, and a later check reads a task that must not have run.
    //
    // ⚠️ Seeded at all because credits have never been enabled on a live account — this is the
    // populated shape the vendor documents, which is exactly the shape nothing has yet observed, so
    // a rendering check is the only pin available for it.
    store
      .prepare('update workers set credits_json = ? where id = ?')
      .run(
        JSON.stringify({
          enabled: true,
          userDisabled: false,
          disabledReason: null,
          canToggle: false,
          everEnabled: true,
          monthlyLimit: 50,
          used: 12.34,
          currency: 'USD',
          resetsAt: Date.now() + 26 * 86_400_000
        }),
        staleWorker
      )
    store.close()
  }
  await evaluate(
    `window.agentyard.rpc('worker.update', { id: ${JSON.stringify(suspectWorkerId)}, maxConcurrent: 1 })`
  )
  await wait(1500)
  const suspectCard = await evaluate(
    `[...document.querySelectorAll('.wcard')].find(c => c.innerText.includes('suspect worker'))?.innerText ?? ''`
  )
  check('a suspect worker without quota shows the error banner', /error · see Settings/i.test(suspectCard))
  check('and suppresses quota unknown when suspect', !/quota unknown/i.test(suspectCard))

  // ⛔ A quota gauge is a share of a fee already paid; usage credits are a bill accruing now, so the
  // card says it in dollars rather than leaving an operator to infer it from a window at 100%.
  const creditCard = await evaluate(
    `[...document.querySelectorAll('.wcard')].find(c => c.querySelector('.wcard-credits'))?.innerText ?? ''`
  )
  check(
    'an account spending usage credits shows the money on its card',
    /\$12\.34/.test(creditCard),
    JSON.stringify(creditCard)
  )
  check(
    '⚠️ and the ceiling beside it, so the number has something to be a share of',
    /\/\$50\.00/.test(creditCard),
    JSON.stringify(creditCard)
  )
  check(
    'and whole days to the refill in the reset column, like every session row',
    /\b2[56]d\b/.test(creditCard),
    JSON.stringify(creditCard)
  )
  // ⛔ **Off is not zero**, which is the rule the whole `CreditStatus` type is built on: with credits
  // off the vendor publishes no balance at all, so the row is absent rather than reading `$0.00` for
  // a purse that has merely not been shown.
  check(
    '⛔ and the row belongs to the account the vendor says is spending, not to every card',
    (await evaluate(`document.querySelectorAll('.wcard-credits').length`)) === 1
  )

  // ---- fleet density and hide / show controls -----------------------------------------
  const densityBtn = `document.querySelector('.fleet-density-btn')`
  check('fleet strip has a narrow/wide density button', (await evaluate(`!!(${densityBtn})`)) === true)
  const fleetControls = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const label = document.querySelector('.fleet-label');
        const density = document.querySelector('.fleet-density-btn');
        const card = document.querySelector('.wcard');
        if (!label || !density || !card) return { missing: true };
        const l = label.getBoundingClientRect(), d = density.getBoundingClientRect(), c = card.getBoundingClientRect();
        return { below: d.top >= l.bottom - 1, leftOfCards: d.right <= c.left + 1, sameRail: Math.abs(l.left - d.left) <= 1 };
      })())
    `)
  )
  check(
    'Narrow sits below Fleet in the rail beside the worker cards',
    fleetControls.below === true && fleetControls.leftOfCards === true && fleetControls.sameRail === true,
    JSON.stringify(fleetControls)
  )
  check(
    'the density button starts wide',
    (await evaluate(`${densityBtn}?.getAttribute('aria-pressed')`)) === 'false' &&
      /narrow/i.test(await evaluate(`${densityBtn}?.innerText ?? ''`))
  )
  await evaluate(`${densityBtn}?.click()`)
  await wait(300)
  check(
    'clicking Narrow condenses the cards',
    (await evaluate(`${densityBtn}?.getAttribute('aria-pressed')`)) === 'true' &&
      /wide/i.test(await evaluate(`${densityBtn}?.innerText ?? ''`)) &&
      (await evaluate(`!!document.querySelector('.wcard--narrow')`)) === true
  )
  // ⛔ `1 / 2` on the sessions divider (t549): slots in use against Max parallel instances, drawn
  // on every card whether or not it has a session, words in wide and the bare count in narrow.
  const instancesShown = `(() => {
    const card = document.querySelector('.wcard');
    const n = card?.querySelector('.wcard-instances');
    if (!n) return 'missing';
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? n.innerText.trim() : 'invisible';
  })()`
  // ⚠️ The word is clipped, not removed — still read aloud — so `innerText` keeps it; what is
  // asserted is what is drawn: the count visible, the word collapsed to nothing.
  const narrowInstances = JSON.parse(
    await evaluate(`JSON.stringify((() => {
      const n = document.querySelector('.wcard .wcard-instances');
      const num = n?.querySelector('.num'), word = n?.querySelector('.wcard-instances-word');
      if (!num || !word) return { missing: true };
      return { count: num.innerText.trim(), countW: num.getBoundingClientRect().width, wordW: word.getBoundingClientRect().width };
    })())`)
  )
  check(
    'a narrow card shows its instance count without the word',
    /^\d+ \/ \d+$/.test(narrowInstances.count ?? '') && narrowInstances.countW > 0 && narrowInstances.wordW <= 1,
    JSON.stringify(narrowInstances)
  )
  await evaluate(`${densityBtn}?.click()`)
  await wait(300)
  const wideInstances = await evaluate(instancesShown)
  check('a wide card says N / M in use on its sessions divider', /^\d+ \/ \d+ in use$/i.test(wideInstances), wideInstances)
  check(
    'the instance count says what it counts on hover',
    /parallel instances? in use/.test(await evaluate(`document.querySelector('.wcard-instances')?.title ?? ''`))
  )
  check(
    'no card counts extra sessions as +N more',
    (await evaluate(`[...document.querySelectorAll('.wcard')].some(c => /\\+\\d+ more/.test(c.innerText))`)) === false
  )

  // ---- hide / show fleet strip toggle -------------------------------------------------
  const toggleBtn = `document.querySelector('.fleet-toggle-btn')`
  check('fleet strip has a hide/show toggle button', (await evaluate(`!!(${toggleBtn})`)) === true)
  check(
    'the toggle button starts expanded',
    (await evaluate(`${toggleBtn}?.getAttribute('aria-expanded')`)) === 'true' &&
      /hide/i.test(await evaluate(`${toggleBtn}?.innerText ?? ''`))
  )

  await evaluate(`${toggleBtn}?.click()`)
  await wait(600)
  const isCollapsed = await evaluate(
    `!!document.querySelector('.fleet-wrap--collapsed') && getComputedStyle(document.querySelector('.fleet')).display === 'none'`
  )
  check('clicking the toggle collapses the fleet strip', isCollapsed === true)
  check(
    'the toggle button updates to Show fleet',
    (await evaluate(`${toggleBtn}?.getAttribute('aria-expanded')`)) === 'false' &&
      /show fleet/i.test(await evaluate(`${toggleBtn}?.innerText ?? ''`))
  )

  check(
    'and the collapsed preference is saved to localStorage',
    (await evaluate(`window.localStorage.getItem('warmstart.fleetCollapsed')`)) === 'true'
  )

  await evaluate(`${toggleBtn}?.click()`)
  await wait(600)
  const isExpanded = await evaluate(
    `!document.querySelector('.fleet-wrap--collapsed') && getComputedStyle(document.querySelector('.fleet')).display !== 'none'`
  )
  check('clicking again expands the fleet strip', isExpanded === true)
  check(
    'and the expanded state is persisted',
    (await evaluate(`window.localStorage.getItem('warmstart.fleetCollapsed')`)) === 'false'
  )

  section('finishing work')
  // ⛔ Three tiers resolve into one answer, and the failure this guards is the answer disappearing
  // from the one place a person can change it. The daemon-side resolution is held by
  // finish.test.ts; these checks are that the controls exist and reach the daemon.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Global')?.click()`
  )
  await wait(1500)
  // ⚠️ Global remembers the tab it was last on, and the section above leaves it on **App behavior**.
  // Naming the tab is what makes each section independent of the one before it — which is the
  // property the suite had for free while Global was a single page (t422 split it).
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Fleet settings')?.click()`
  )
  await wait(1000)
  const fleetPicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Fleet finish policy')`
  check('the fleet tier has a control', (await evaluate(`!!(${fleetPicker})`)) === true)
  check(
    'which starts at commit-and-merge, the shipped default',
    (await evaluate(`${fleetPicker}?.value`)) === 'commit-and-merge'
  )
  check(
    '⛔ and the shipped default does not push',
    !['commit-and-push', 'pull-request'].includes(await evaluate(`${fleetPicker}?.value`)),
    'every push to main started a ten-job CI matrix; 103 runs in five days exhausted the allowance'
  )
  await evaluate(`
    (() => {
      const s = ${fleetPicker};
      s.value = 'await-human';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `)
  await wait(1200)
  check(
    'and a change reaches the daemon, not just the select',
    (await evaluate(
      `window.agentyard.rpc('settings.get', {}).then(s => s.finishPolicy)`
    )) === 'await-human',
    'the control reads back what the daemon returned, never the value that was chosen'
  )
  // ⚠️ Put back, so the rest of the suite runs against the shipped default.
  await evaluate(`window.agentyard.rpc('settings.set', { finishPolicy: 'commit-and-merge' })`)

  section('the conversations page')
  // ⛔ The page exists for two things invisible everywhere else — how many *tasks* have been in one
  // conversation, and in what order the runs inside it happened. These checks are that it reaches
  // the daemon and renders; the join itself is held by conversations.test.ts.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Conversations')?.click()`
  )
  await wait(1500)
  // ⚠️ `.panel-head`, not `.page-head`. This page was rebuilt on the same furniture the task table
  // uses, which is the whole reason it now looks like the rest of the app.
  const convHead = await evaluate(`document.querySelector('.content .panel-head')?.innerText ?? ''`)
  check('Conversations is reachable from the sidebar', /Conversations/i.test(convHead))
  check(
    'and leads with how many runs there are, not just how many sessions',
    /\bruns?\b/i.test(convHead),
    convHead.split('\n').join(' / ')
  )
  check(
    'the daemon answers the query behind it',
    Array.isArray(await evaluate(`window.agentyard.rpc('conversation.list', {})`))
  )
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Global')?.click()`
  )
  await wait(1200)

  section('reusing conversations')
  // ⛔ Sharing is an information boundary, so the check that matters most is the *default*: a clean
  // install ships with reuse ON (2026-09-19). The tier resolution itself is held by sharing.test.ts;
  // these are that the controls exist, reach the daemon, and ship on.
  const sharePicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Fleet session sharing')`
  check('the fleet tier has a sharing control', (await evaluate(`!!(${sharePicker})`)) === true)
  check(
    'which ships ON, so a clean install reuses warm sessions',
    (await evaluate(`${sharePicker}?.value`)) === 'on'
  )
  check(
    'and the daemon agrees, which is the opinion that gates dispatch',
    (await evaluate(`window.agentyard.rpc('settings.get', {}).then(s => s.sessionSharing)`)) === 'on'
  )
  await evaluate(`
    (() => {
      const s = ${sharePicker};
      s.value = 'off';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `)
  await wait(1200)
  check(
    'turning it off reaches the daemon',
    (await evaluate(
      `window.agentyard.rpc('settings.get', {}).then(s => s.sessionSharing)`
    )) === 'off'
  )
  // ⚠️ Put back, so the rest of the suite runs against the shipped default.
  await evaluate(`window.agentyard.rpc('settings.set', { sessionSharing: 'on' })`)

  // ⛔ Global settings: the two probe cadences and the fleet intervention toggles.
  //
  // ⚠️ Two controls, not one, since 2026-08-31. A single interval had to serve both an account
  // spending its window right now and a fleet with nothing running, and it answered neither: the
  // number said five minutes while the reading behind it could be two hours old.
  const probePicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Quota probe frequency while running')`
  const idlePicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Quota probe frequency when idle')`
  check('the running probe frequency control exists under Global', (await evaluate(`!!(${probePicker})`)) === true)
  check('the idle probe frequency control exists beside it', (await evaluate(`!!(${idlePicker})`)) === true)
  check('starts at 5 minutes default', (await evaluate(`${probePicker}?.value`)) === '5')
  check('and the idle cadence starts at 20', (await evaluate(`${idlePicker}?.value`)) === '20')
  await evaluate(`
    (() => {
      const s = ${probePicker};
      s.value = '10';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `)
  await wait(1200)
  check(
    'probe frequency change reaches daemon',
    (await evaluate(`window.agentyard.rpc('settings.get', {}).then(s => s.probeIntervalMinutes)`)) === 10
  )
  await evaluate(`
    (() => {
      const s = ${idlePicker};
      s.value = '60';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `)
  await wait(1200)
  check(
    'the idle cadence is a separate setting, stored separately',
    (await evaluate(`window.agentyard.rpc('settings.get', {}).then(s => s.idleProbeIntervalMinutes)`)) === 60
  )
  check(
    'and the panel says what ignores both of them',
    (await evaluate('document.querySelector(".content")?.innerText ?? ""')).includes(
      'within 30 seconds of the reset time'
    ),
    'a parked task is probed at its release time and a rate-limit warning is probed at once - if the ' +
      'panel does not say so, the operator reads the interval as the whole story'
  )
  await evaluate(`window.agentyard.rpc('settings.set', { probeIntervalMinutes: 5, idleProbeIntervalMinutes: 20 })`)

  const autoCompactBtn = `[...document.querySelectorAll('button[role="switch"]')].find(
     b => b.getAttribute('aria-label') === 'Automatic compaction')`
  check('automatic compaction toggle exists on Global', (await evaluate(`!!(${autoCompactBtn})`)) === true)
  await evaluate(`${autoCompactBtn}?.click()`)
  await wait(1200)
  const afterToggle = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check(
    'turning it off says so, and says what happens instead',
    afterToggle.includes('never compacts on its own') && afterToggle.includes('hands off and closes'),
    'off has to state its consequence - a session that would have compacted now closes instead'
  )
  await evaluate(`${autoCompactBtn}?.click()`)
  await wait(1200)
  check(
    'and it goes back on',
    (await evaluate(`${autoCompactBtn}?.getAttribute('aria-checked')`)) === 'true'
  )

  const autoPreemptBtn = `[...document.querySelectorAll('button[role="switch"]')].find(
     b => b.getAttribute('aria-label') === 'Wrap up before a quota window closes')`
  check('preemption toggle exists on Global', (await evaluate(`!!(${autoPreemptBtn})`)) === true)
  const runawayBtn = `[...document.querySelectorAll('button[role="switch"]')].find(
     b => b.getAttribute('aria-label') === 'Stop a run that is far past its estimate')`
  check('runaway stop toggle exists on Global', (await evaluate(`!!(${runawayBtn})`)) === true)

  check(
    'a task carries its own tier, defaulting to inherit',
    (await evaluate(
      `window.agentyard.rpc('task.create', { title: 'finish tier check' }).then(t => t.finishPolicy)`
    )) === 'inherit',
    'inherit is a value, not a blank: a task set to it follows its project as the project changes'
  )
  check(
    'and the loose-ends scan answers without a project configured',
    Array.isArray(await evaluate(`window.agentyard.rpc('looseend.list', {}).then(e => e)`)),
    'it runs on Overview for every project on every load, so it must never throw'
  )

  section('logs')
  // ⛔ The daemon has always written a log and nothing ever displayed it, which is the same as not
  // having one: the premise of the product is that it runs while nobody watches. These checks are
  // about the two halves being present — the live buffer, and the files behind it.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Logs')?.click()`
  )
  await wait(1500)
  const logPanel = await evaluate(`document.querySelector('.content')?.innerText ?? ''`)
  const lines = await evaluate(`document.querySelectorAll('.log-line').length`)
  check('the log panel shows lines the daemon has already written', lines > 0, `${lines} line(s)`)
  check(
    'including the startup line, which happened before this window existed',
    /orchestratord .* ready|scheduler started/i.test(logPanel),
    'a live event stream alone would show a panel opened afterwards nothing at all'
  )
  check(
    'and it names the directory the files are kept in',
    /logs/.test(logPanel) && /On disk/i.test(logPanel)
  )
  // ⚠️ Asserted through the RPC as well as the DOM: the panel could render a hard-coded row and
  // still look right, and the file on disk is the half that outlives the window.
  const onDisk = await evaluate(
    `window.agentyard.rpc('log.files', {}).then(r => JSON.stringify(r.files.map(f => f.name)))`
  )
  check(
    'a file is on disk, named for the day',
    /orchestratord-\d{4}-\d{2}-\d{2}\.log/.test(onDisk),
    onDisk
  )

  section('workers')
  // ⛔ Held out of dispatch is a state the operator sets and has to be able to *see*. It lived for
  // four milestones as a cleared checkbox in the last column, which is indistinguishable at a
  // glance from a worker that simply had no work — and the fleet strip had been saying `off` on its
  // card since M2, so the two views disagreed about the same fact.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Workers')).click()`
  )
  await wait(1200)

  // ---- the shape of the table itself --------------------------------------------------
  //
  // ⛔ Measured, not eyeballed. All three of the faults this covers typecheck perfectly and pass
  // every unit test: a <col> missing from a `table-layout: fixed` colgroup, an unbreakable account
  // name painted across the column beside it, and a sentence from a vendor set in a 13% cell. They
  // are only visible in a laid-out document, which is what this level is for.
  {
    // Seeded, because the states that break the layout are the ones a healthy fleet never reaches:
    // a long sign-in address, an account that never finished onboarding, and one held out of
    // dispatch carrying the vendor's own explanation.
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    store
      .prepare('update workers set identity_json = ? where id = ?')
      .run(
        JSON.stringify({
          loggedIn: true,
          account: 'a.very.long.sign-in.address@some-organisation.example.com',
          subscriptionType: 'max20',
          setupComplete: true
        }),
        staleWorker
      )
    store
      .prepare('update workers set identity_json = ? where id = ?')
      .run(
        JSON.stringify({ loggedIn: true, account: 'held@example.com', setupComplete: false }),
        suspectWorkerId
      )
    store.close()
  }
  await evaluate(
    `window.agentyard.rpc('worker.update', { id: ${JSON.stringify(staleWorker)}, maxConcurrent: 1 })`
  )
  await wait(1500)

  // ⛔ The headers, fixed-layout columns and card fields are one sequence. t334 added Summary
  // model to the table but not the card's positional labels, which relabelled Role as Actions and
  // left the actions with no label at all.
  const colCount = await evaluate(
    `JSON.stringify([
       document.querySelectorAll('.tbl-workers colgroup col').length,
       document.querySelectorAll('.tbl-workers thead th').length
     ])`
  )
  check('the workers card fields describe every setting the header declares', colCount === '[15,15]', colCount)

  const cardLabels = await evaluate(
    `JSON.stringify([...document.querySelector('.tbl-workers tbody tr:not(.tbl-row--note)').children]
      .slice(2)
      .map(td => getComputedStyle(td, '::before').content.replaceAll('"', '')))`
  )
  check(
    'every worker card field keeps its own label after Summary model',
    cardLabels === JSON.stringify([
      'Adapter', 'Config location', 'Account', 'Quota', 'Max parallel instances', 'Default model',
      'Routable models', 'Grading model', 'Summary model', 'Role', 'Unattended', 'Usage credits', 'Actions'
    ]),
    cardLabels
  )

  // Cards have enough horizontal room to expose their three actions without a hidden menu.
  const actionRows = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.tbl-workers tbody tr:not(.tbl-row--note)')].map(row => [
       row.querySelectorAll('.tbl-action-cell .action-menu-btn').length,
       row.querySelectorAll('.tbl-action-cell .btn').length
     ]))`
  )
  check('every worker card exposes sign-in, probe and retire', JSON.parse(actionRows).length > 0 && JSON.parse(actionRows).every(([menus, loose]) => menus === 0 && loose === 3), actionRows)

  // ⛔ Overflow, which under a fixed layout is not clipped and not wrapped — it is painted over the
  // next column. An account name is an email; an email has no space to break at.
  const accountOverflow = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.tbl-workers .tbl-account')]
       .map(el => [el.scrollWidth, el.clientWidth]))`
  )
  check(
    'no account name is painted past its column into the quota beside it',
    JSON.parse(accountOverflow).length >= (await evaluate(
      `document.querySelectorAll('.tbl-workers tbody tr:not(.tbl-row--note)').length`
    )) && JSON.parse(accountOverflow).length > 0 && JSON.parse(accountOverflow).every(([scroll, client]) => scroll <= client + 1),
    `[scrollWidth, clientWidth]: ${accountOverflow}`
  )

  // ⛔ The vendor's sentence belongs on a row, not in a cell. In the cell it wrapped to five lines
  // and made every other cell on that row five lines tall.
  const noteCell = await evaluate(
    `JSON.stringify({
       rows: document.querySelectorAll('.tbl-workers .tbl-row--note').length,
       note: document.querySelector('.tbl-workers .tbl-row--note')?.innerText ?? '',
       span: document.querySelector('.tbl-workers .tbl-row--note td')?.colSpan ?? 0,
       inAccountColumn: [...document.querySelectorAll('.tbl-workers tbody tr:not(.tbl-row--note) td:nth-child(5)')]
         .some(td => td.innerText.includes('subscription expired'))
     })`
  )
  {
    const seen = JSON.parse(noteCell)
    check('an account with something wrong gets a note row of its own', seen.rows >= 1, noteCell)
    check('which spans the card rather than sitting in one field', seen.span === 14, String(seen.span))
    check(
      'and carries the reason the run failed, plus what to do about it',
      /subscription expired/.test(seen.note) && /Recheck/.test(seen.note),
      JSON.stringify(seen.note.slice(0, 160))
    )
    check(
      'while the Account column keeps the label and gives the sentence up',
      seen.inAccountColumn === false,
      'the prose was still being set in a 13% cell'
    )
  }

  // ⚠️ The point of all of the above: rows a person can scan. With the sentence set in the Account
  // cell and the buttons stacked in a column of no width, the tallest row on this seed measured
  // 174px — six lines, for one account. It is 72px now, and this holds that.
  const tallest = await evaluate(
    `Math.max(...[...document.querySelectorAll('.tbl-workers tbody tr:not(.tbl-row--note)')]
       .map(r => Math.round(r.getBoundingClientRect().height)))`
  )
  check('and every worker is a readable settings card', tallest >= 220 && tallest <= 650, `${tallest}px`)

  const rowSwitch = `document.querySelector('.tbl tbody tr .switch')`
  check(
    'a commissioned worker can be switched off from its own row',
    (await evaluate(`!!(${rowSwitch})`)) === true,
    'the control the scheduler already honours had no obvious affordance'
  )
  check(
    'and it is a real switch, not a styled div',
    (await evaluate(`${rowSwitch}?.getAttribute('role')`)) === 'switch'
  )
  check(
    'which starts on, because commissioning a worker means using it',
    (await evaluate(`${rowSwitch}?.getAttribute('aria-checked')`)) === 'true'
  )

  await evaluate(`${rowSwitch}.click()`)
  await wait(1200)
  const offRow = await evaluate(
    `document.querySelector('.tbl tbody tr')?.innerText ?? ''`
  )
  check(
    'turning it off says so on the row itself',
    /disabled/i.test(offRow),
    JSON.stringify(offRow.slice(0, 90))
  )
  check(
    'the row is dimmed so a switched-off account reads as one at a glance',
    (await evaluate(
      `!!document.querySelector('.tbl tbody tr.tbl-row--off')`
    )) === true,
    'the same 0.55 the fleet strip uses, so `off` looks like one thing in both views'
  )
  // ⚠️ The state has to come back from the daemon rather than from the click. A toggle that paints
  // itself and persists nothing is exactly the failure this switch would be used to rule out.
  const persisted = await evaluate(
    `window.agentyard.rpc('fleet.list').then(f => String(f[0]?.worker?.enabled))`
  )
  check('and the daemon agrees, which is the only opinion that gates dispatch', persisted === 'false', persisted)

  const firstLabel = await evaluate(
    `window.agentyard.rpc('fleet.list').then(f => f[0]?.worker?.label)`
  )
  const stripWithOff = await evaluate(
    `[...document.querySelectorAll('.wcard .wcard-name')].map(n => n.innerText)`
  )
  check('and disabled worker is hidden from the fleet strip', !stripWithOff.includes(firstLabel))

  await evaluate(`${rowSwitch}.click()`)
  await wait(1200)
  check(
    'and it comes back on, with the account untouched',
    (await evaluate(`${rowSwitch}?.getAttribute('aria-checked')`)) === 'true',
    'off is not retirement — nothing is deleted and nothing needs re-commissioning'
  )
  const stripWithOn = await evaluate(
    `[...document.querySelectorAll('.wcard .wcard-name')].map(n => n.innerText)`
  )
  check('and turning it back on restores it to the fleet strip', stripWithOn.includes(firstLabel))

  // ⭐ The manual probe. The strip's readings are refreshed by the scheduler when a task is about
  // to run somewhere, which for an idle fleet can be a long time — and until 2026-09-02 the only
  // way to ask for a number now was Settings > Workers, two clicks from the strip that shows it.
  const cards = await evaluate(`document.querySelectorAll('.wcard').length`)
  const buttons = await evaluate(
    `document.querySelectorAll('.wcard .wcard-head button.wcard-refresh').length`
  )
  check(
    'every card carries its own probe button, in the head row',
    cards > 0 && buttons === cards,
    `${buttons} button(s) across ${cards} card(s)`
  )

  // ⛔ The user asked for this specifically: the emoji it replaces (🔃) brings its own colour, and on
  // the dark surface it outshone the numbers the strip exists to show. A stroke icon takes the
  // corner's faint colour like the chevron below the strip does.
  const drawn = await evaluate(`
    (() => {
      const b = document.querySelector('.wcard-refresh')
      const svg = b?.querySelector('svg')
      return JSON.stringify({
        svg: !!svg,
        stroke: svg?.getAttribute('stroke') ?? '',
        text: (b?.innerText ?? '').trim()
      })
    })()
  `)
  const icon = JSON.parse(drawn)
  check(
    'and it is drawn, not typed — an SVG that inherits the corner colour, with no glyph in it',
    icon.svg && icon.stroke === 'currentColor' && icon.text === '',
    drawn
  )

  // ⛔ The load-bearing one. The card's height may not change on its own or the whole strip moves
  // under the operator's eyes; a button drawn on every card at all times cannot cause that, and
  // pressing it must not either — not while the probe is in flight, and not when it comes back.
  //
  // ⚠️ Pressed on the card that is *already* suspect, deliberately. This suite's accounts have no
  // credentials, so a probe here always fails and marks its worker suspect — which grows a note row
  // in the Workers table and shifts every row index below it. Probing the healthy account left the
  // reorder checks further down reading a note row as a worker row. Re-probing an account that has
  // already failed asks the same question of the same button and changes nothing else.
  const sameHeight = await evaluate(`
    (async () => {
      const card = [...document.querySelectorAll('.wcard')].find((c) => c.querySelector('.tag--suspect'))
      if (!card) return JSON.stringify(['no suspect card in the strip', ''])
      const before = card.getBoundingClientRect().height
      card.querySelector('.wcard-refresh')?.click()
      await new Promise((r) => setTimeout(r, 1500))
      return JSON.stringify([before, card.getBoundingClientRect().height])
    })()
  `)
  const [tallBefore, tallAfter] = JSON.parse(sameHeight)
  check(
    'and pressing it leaves the card exactly the height it was',
    tallBefore > 0 && Math.abs(tallBefore - tallAfter) <= 2,
    `${tallBefore}px -> ${tallAfter}px`
  )

  // ⭐ How many tasks one account may run at once. The daemon has gated on this since M1 —
  // `atCapacity` before dispatch, `spawnSession` at the door — and until 2026-08-29 the Workers
  // table printed it as text and nothing in the app could change it. So a single-account fleet ran
  // one task at a time, and the `queued` hold that said so read as a fact about the provider.
  const maxInput = `document.querySelector('.tbl tbody tr .num-input')`
  check(
    'the concurrency limit is something you can change, not a printed number',
    (await evaluate(`${maxInput}?.tagName`)) === 'INPUT',
    'it was a plain table cell for six milestones'
  )
  check(
    'it starts at one, which is the commissioning default and a cost decision',
    (await evaluate(`${maxInput}?.value`)) === '1',
    'parallel requests on one cached prefix each pay a cache write — cost-model.md §1'
  )
  check(
    'and it refuses zero in the control as well as in the daemon',
    (await evaluate(`${maxInput}?.getAttribute('min')`)) === '1',
    'a max of 0 is a worker that stays enabled and silently never takes a task'
  )

  // ⭐ The box is also where somebody about to raise it finds out what raising it costs. A hold
  // that reads `<account> at capacity` points here; the sentence beside the control has to say what
  // the number does and what a second parallel run spends, or the fix reads as free.
  const maxHelp = await evaluate(`${maxInput}?.getAttribute('title') ?? ''`)
  check(
    'the parallel-instances box explains the hold it causes and what raising it costs',
    maxHelp.includes('at capacity') &&
      maxHelp.includes('next tick') &&
      maxHelp.includes('quota') &&
      maxHelp.includes('warm session'),
    maxHelp
  )

  // ⚠️ React owns the value, so a plain assignment is discarded on the next render. The native
  // setter plus a bubbling `input` event is what a real keystroke looks like from React's side.
  await evaluate(
    `(() => { const el = ${maxInput};` +
      ` const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;` +
      ` set.call(el, '3'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`
  )
  await wait(1200)
  // ⛔ Read back from the daemon, not from the box. A control that paints itself and persists
  // nothing would leave the scheduler still refusing the second task, with the UI claiming otherwise.
  const width = await evaluate(
    `window.agentyard.rpc('fleet.list').then(f => String(f[0]?.worker?.maxConcurrent))`
  )
  check('raising it reaches the daemon, which is the only opinion that gates dispatch', width === '3', width)

  // ⭐ The account's default model — what every task routed here runs on unless it pins its own.
  // The New Task form has had a model picker since M3, but only when a worker was pinned, and there
  // was nowhere at all to say "this account normally uses X".
  // ⚠️ Column 7, not 6: the reorder arrows took the first cell on 2026-08-29 and shifted every
  // column after them. A positional selector is the one thing that breaks silently when a table
  // grows a column, so it is called out rather than quietly renumbered.
  // ⚠️ A `SettingButtonSelect`, not a `<select>`, since 2026-09-02 — the same control Settings >
  // Global uses, so the fleet's pickers and the app's pickers are one thing to learn. It paints a
  // button carrying the current label and opens its options on click, which is why the list has to
  // be opened before it can be counted.
  const modelBtn = `document.querySelector('.tbl tbody tr td:nth-child(8) .setting-btn-select')`
  check(
    'an account can be given a default model',
    (await evaluate(`${modelBtn}?.tagName`)) === 'BUTTON',
    'before this there was no per-account default anywhere in the app'
  )
  check(
    'which starts at the CLI default, not at a model somebody has to undo',
    (await evaluate(`${modelBtn}?.querySelector('.setting-btn-select-value')?.innerText.trim()`)) ===
      'CLI default',
    'null means the vendor picks — the state every install ran in before this control existed'
  )
  await evaluate(`${modelBtn}?.click()`)
  await wait(200)
  const modelMenu = `document.querySelector('.tbl tbody tr td:nth-child(8) .setting-btn-select-menu')`
  check(
    '"CLI default" is offered as a real choice, so the setting can be cleared',
    (await evaluate(
      `${modelMenu}?.querySelector('.setting-btn-select-option .setting-btn-select-option-label')?.innerText.trim()`
    )) === 'CLI default',
    'a picker with no empty option is one you can set and never unset'
  )
  // ⛔ The list comes from the daemon's cost models, not from a table in the renderer. A second list
  // here would drift the day a model was added to a file and not to this bundle.
  const served = await evaluate(
    `window.agentyard.rpc('model.options').then(o => String(o.find(x => x.adapterId === 'claude-code')?.models.length ?? 0))`
  )
  const offered = await evaluate(
    `String((${modelMenu}?.querySelectorAll('.setting-btn-select-option').length ?? 1) - 1)`
  )
  check(
    'and every model it offers came from the cost model that will price it',
    offered === served && served !== '0',
    `offered ${offered}, served ${served}`
  )
  // ⚠️ Closed again. An open menu is absolutely positioned over the rows underneath it, and the
  // order-arrow checks below click by position.
  await evaluate(`document.body.click()`)
  await wait(150)

  // ⭐ Routable models: the opt-in allowlist beside the account's default model. Its whole point is
  // that leaving it alone is inert, so the honest check is that the empty state reads as a sentence
  // rather than a blank, and that checking one box actually reaches the daemon.
  const routableValue = `document.querySelector('.tbl tbody tr td:nth-child(9) .routable-models-value')`
  const routableBtn = `document.querySelector('.tbl tbody tr td:nth-child(9) .routable-models-edit .pill')`
  const routableBtnTag = await evaluate(`${routableBtn}?.tagName`)
  check(
    'a separate edit control sits beside the routable-models value',
    routableBtnTag === 'BUTTON',
    `tagName: ${routableBtnTag}`
  )
  const routableEmptyLabel = await evaluate(`${routableValue}?.textContent.trim()`)
  check(
    'and its empty state reads as a deliberate default, not a blank',
    routableEmptyLabel === 'default model only',
    routableEmptyLabel
  )
  await evaluate(`${routableBtn}?.click()`)
  await wait(200)
  const firstCheckbox = `document.querySelector('.pill-menu .workers-menu-list input[type=checkbox]')`
  const firstCheckboxType = await evaluate(`${firstCheckbox}?.type`)
  check(
    'opening it offers this account\'s priceable models as checkboxes',
    firstCheckboxType === 'checkbox',
    `input type: ${firstCheckboxType}`
  )
  await evaluate(`${firstCheckbox}?.click()`)
  await wait(400)
  const routableAfter = await evaluate(
    `window.agentyard.rpc('fleet.list').then(list => JSON.stringify(list.find(e => e.worker.adapterId === 'claude-code')?.worker.routableModels))`
  )
  check(
    'checking one reaches the daemon, which is the only opinion that gates dispatch',
    routableAfter !== 'null' && JSON.parse(routableAfter)?.length === 1,
    routableAfter
  )
  // ⛔ Names, not a count: `2 models` says nothing to an operator choosing where a task lands,
  // so the pill lists the allowlist (ellipsised, full list on the tooltip) while the menu stays
  // the editor for adding or dropping models.
  const secondCheckbox = `document.querySelectorAll('.pill-menu .workers-menu-list input[type=checkbox]')[1]`
  await evaluate(`${secondCheckbox}?.click()`)
  await wait(400)
  const routableNames = await evaluate(
    `[...document.querySelectorAll('.pill-menu .workers-menu-list label')].filter(l => l.querySelector('input:checked')).map(l => l.querySelector('.workers-menu-worker-name')?.textContent.trim()).join('|')`
  )
  const routableTwo = await evaluate(`${routableValue}?.textContent.trim()`)
  check(
    'checking a second reads as both model names',
    routableNames.split('|').length === 2 && routableTwo === routableNames.split('|').join(', '),
    `${routableTwo} vs ${routableNames}`
  )
  await evaluate(`document.body.click()`)
  await wait(150)

  // ⭐ Ordering the fleet. The strip is a row of cards people learn the shape of, and until
  // 2026-08-29 that shape was the order the accounts were commissioned in, changeable only by
  // retiring one and signing it in again. ⛔ The point of the check is that *both* views move: the
  // table owns the control, the strip reads the same `listWorkers()` order, and a fix that only
  // reordered the table would be worse than none.
  const orderBefore = await evaluate(
    `window.agentyard.rpc('fleet.list').then(f => f.map(e => e.worker.label).join('|'))`
  )
  check(
    'the suite has more than one worker to order',
    orderBefore.split('|').length > 1,
    orderBefore
  )
  const upOnSecond = `document.querySelectorAll('.tbl tbody tr')[1]?.querySelector('.order-btn:not([disabled])')`
  check(
    'each worker row carries a control for where it sits in the fleet',
    (await evaluate(`!!(${upOnSecond})`)) === true,
    'commissioning order was the only order there was'
  )
  // ⛔ Hit-tested, not merely queried. The workers table is re-laid-out as cards, and the order
  // cell shares its grid area with the worker cell that draws the account — so `.order-btn` existed,
  // was enabled, and answered `.click()` from a script while the *pointer* never reached it: the
  // overlapping cell was on top, and once `.tbl tr:hover td` gave that cell a background the arrows
  // were painted over as well. The operator's report was "the button disappears when I hover and
  // moving up does nothing" (2026-09-13). `elementFromPoint` at the arrow's own centre is the only
  // form of this check that would have been red, because every DOM-level assertion above was green.
  // ⚠️ Scrolled to first, as the operator would. `elementFromPoint` answers only for the visible
  // viewport: at CI's 1024×720 the row sat at y=711 inside `.content`, below the status bar at 695,
  // so the point read `statusbar` here and null on the runner (run 34872370257) — an off-screen
  // point, not a covered button. Scrolled into view the same arrow hit-tests as itself, and with the
  // cell's `z-index` removed it still reads as the worker cell.
  const topmostAtUpArrow = `(() => {
    const btn = ${upOnSecond}
    if (!btn) return 'no button'
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return 'button has no box'
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!hit) return 'nothing at that point'
    return btn.contains(hit) || hit === btn ? 'the button' : hit.className || hit.tagName
  })()`
  check(
    'the reorder arrows stay on top of the cell they overlap',
    (await evaluate(topmostAtUpArrow)) === 'the button',
    `a click at the arrow's centre would land on ${await evaluate(topmostAtUpArrow)}`
  )
  check(
    'and the first row cannot be moved up, rather than silently doing nothing',
    (await evaluate(
      `String(document.querySelector('.tbl tbody tr .order-btn')?.disabled)`
    )) === 'true'
  )
  await evaluate(`${upOnSecond}.click()`)
  await wait(1200)
  const orderAfter = await evaluate(
    `window.agentyard.rpc('fleet.list').then(f => f.map(e => e.worker.label).join('|'))`
  )
  const swapped = orderBefore.split('|')
  ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
  check(
    'moving a worker up reaches the daemon, which is what the strip reads',
    orderAfter === swapped.join('|'),
    `${orderBefore} -> ${orderAfter}`
  )
  // ⛔ Read off the strip itself. `fleet.list` agreeing proves the write landed; only the cards
  // prove the thing the operator asked for.
  const stripOrder = await evaluate(
    `[...document.querySelectorAll('.wcard .wcard-name')].map(n => n.innerText).join('|')`
  )
  check(
    'and the fleet strip is drawn in that order too',
    stripOrder === orderAfter,
    `strip ${stripOrder}, daemon ${orderAfter}`
  )

  // ⭐ What the sidebar badge counts. It said `4` for a fleet of four commissioned accounts of which
  // none could take a task — signed out, switched off, held out after a failed run all counted the
  // same as ready. ⚠️ This suite's workers have no credentials, so `ready` here is legitimately 0
  // and that is exactly the state the old badge could not express.
  const badge = await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Workers'))?.querySelector('.nav-count')?.innerText ?? ''`
  )
  check(
    'the Workers badge says running / active / total rather than a bare count',
    /^\d+\/\d+\/\d+$/.test(badge),
    badge
  )
  check(
    'and its last number is still the whole commissioned fleet',
    badge.split('/')[2] === String(orderAfter.split('|').length),
    `${badge} against ${orderAfter.split('|').length} workers`
  )
  check(
    'while active counts enabled workers in the fleet',
    badge.split('/')[1] === String(orderAfter.split('|').length),
    'both commissioned workers are enabled'
  )

  // ⭐ Where the sign-in is going to happen, said before the operator commits to it. Reported
  // 2026-09-13: commissioning a worker while driving another computer opened the vendor's browser on
  // *that* computer's screen, and the Sign in terminal here simply waited. ⚠️ This window is local,
  // so the local wording is the one under test — the remote wording is the same component reading
  // `useTarget()`, and this suite has no paired computer to select. ⛔ The form is opened and closed
  // again: `Add worker` is a toggle and everything after this section reads the table it covers.
  const addWorkerButton = `[...document.querySelectorAll('.panel-head .btn')].find(b => b.innerText.trim() === 'Add worker')`
  await evaluate(`${addWorkerButton}?.click()`)
  await wait(250)
  const commissionWarning = await evaluate(
    `(document.querySelector('.form .login-remote-warning')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`
  )
  check(
    'commissioning warns that the browser opens on the computer running Warmstart',
    /browser/i.test(commissionWarning) && /remote desktop/i.test(commissionWarning),
    commissionWarning || 'no warning drawn above Create and sign in'
  )
  check(
    '⛔ and it sits above the button, where it can still change the decision',
    await evaluate(`(() => {
      const warn = document.querySelector('.form .login-remote-warning')
      const btn = document.querySelector('.form .form-actions .btn')
      if (!warn || !btn) return false
      return warn.getBoundingClientRect().bottom <= btn.getBoundingClientRect().top + 1
    })()`),
    'a warning read after the click is a report, not a warning'
  )
  await evaluate(
    `[...document.querySelectorAll('.panel-head .btn')].find(b => b.innerText.trim() === 'Cancel')?.click()`
  )
  await wait(250)
  check(
    'and the form closes again, leaving the table as this section found it',
    (await evaluate(`!!document.querySelector('.tbl-workers') && !document.querySelector('.form .login-remote-warning')`)) === true
  )

  // ⛔ Left to the end on purpose: each of these three rewrites the task table's statuses to put the
  // app into the state being drawn, and every earlier section reads those statuses.
  section('a project held on quota')
  // ⭐ Reported 2026-08-31. The dot before a project name is the whole of what the sidebar says
  // about a project you are not looking at, and a task stopped on an exhausted account drew the
  // same hollow ring as a project with nothing in it - so *stopped, and the account is why* read as
  // *nothing going on here*. ⚠️ Seeded through the store: no RPC parks a task on quota, and this
  // suite has no credentials to exhaust.
  const orphanIds = JSON.parse(
    await evaluate(
      `window.agentyard.rpc('task.list', {}).then(t => JSON.stringify(t.filter(x => x.projectId === null).map(x => x.id)))`
    )
  )
  const heldId = orphanIds[0]
  const dotClass = async () =>
    await evaluate(
      `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Unassigned'))?.querySelector('.project-dot')?.className ?? ''`
    )
  {
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    // Everything else at rest, so the one status under test is the one the dot is answering.
    store.prepare('update tasks set status = ?').run('completed')
    // ⛔ **With a `not_before` in the future, or this is a race the suite loses on a slow runner.**
    // `resumeQuotaPaused` treats a null `not_before` as *the window has already reset* and puts the
    // task straight back to `ready` on the next 10s tick — so the dot read `working`, and the
    // `.project-dot--paused` lookup below then threw on a null element and took the rest of the
    // suite with it (CI, ui · windows-latest, 2026-09-02, 167 of 200 checks reached). The seeded
    // state has to be one the scheduler agrees is still parked.
    store
      .prepare('update tasks set status = ?, not_before = ? where id = ?')
      .run('paused_quota', Date.now() + 60 * 60 * 1000, heldId)
    store.close()
  }
  // A task event is what makes the sidebar re-read; the edit itself changes nothing.
  await evaluate(
    `window.agentyard.rpc('task.setPriority', { id: ${JSON.stringify(heldId)}, priority: 'P2' })`
  )
  await wait(1500)
  const heldDot = await dotClass()
  check(
    'a task held on quota gives the project a dot of its own',
    /project-dot--paused\b/.test(heldDot),
    heldDot
  )
  check(
    'and it is not the idle ring',
    !/project-dot--idle\b/.test(heldDot),
    'idle is the state of a project with nothing in it, which this is not'
  )
  // ⛔ Yellow, and actually painted. The class name is half the assertion - a rule that never
  // landed in the stylesheet leaves a correctly-named element drawn as nothing at all.
  const heldColour = await evaluate(
    `getComputedStyle(document.querySelector('.project-dot--paused')).backgroundColor`
  )
  const warn = await evaluate(
    `getComputedStyle(document.documentElement).getPropertyValue('--state-warn').trim()`
  )
  check(
    'the dot is drawn in the warning colour rather than left transparent',
    heldColour !== 'rgba(0, 0, 0, 0)' && heldColour !== 'transparent',
    `${heldColour} against --state-warn ${warn}`
  )

  section('reassigning a task that is waiting on you')
  // ⭐ Three selectors - worker, model, effort - that each sized themselves to their own longest
  // label and so wrapped onto a line each in a column this narrow, turning one decision into a
  // stack. They share the row now and ellipsize.
  {
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    store
      .prepare('update tasks set status = ?, assignee = ? where id = ?')
      .run('awaiting_human', 'human', heldId)
    store.close()
  }
  await evaluate(
    `window.agentyard.rpc('task.setPriority', { id: ${JSON.stringify(heldId)}, priority: 'P1' })`
  )
  await wait(1200)
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Unassigned'))?.click()`
  )
  await wait(1200)
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('awaiting_human'))?.click()`
  )
  await wait(1500)
  check(
    'the decide panel offers a reassignment',
    (await evaluate(`!!document.querySelector('.reassign-row')`)) === true,
    'the panel only renders while the task is waiting on a person'
  )
  // Pick a real worker, which is what brings the model selector - and on a selectable-effort
  // adapter the effort selector - onto the row beside it. Three is the crowded case.
  await evaluate(`document.querySelector('.reassign-row .setting-btn-select')?.click()`)
  await wait(600)
  await evaluate(
    `[...document.querySelectorAll('.reassign-row .setting-btn-select-option')].find(o => !o.innerText.includes('Auto'))?.click()`
  )
  await wait(1500)
  const row = JSON.parse(
    await evaluate(`
      (() => {
        const wrap = document.querySelector('.reassign-row');
        const kids = [...document.querySelectorAll('.reassign-select')];
        return JSON.stringify({
          count: kids.length,
          tops: kids.map(k => Math.round(k.getBoundingClientRect().top)),
          widest: Math.max(0, ...kids.map(k => Math.round(k.getBoundingClientRect().width))),
          row: Math.round(wrap.getBoundingClientRect().width),
          height: Math.round(wrap.getBoundingClientRect().height),
          overflows: kids.some(k => k.getBoundingClientRect().right > wrap.getBoundingClientRect().right + 1)
        });
      })()
    `)
  )
  check(
    'choosing a worker brings its model out beside it, not under it',
    row.count >= 2,
    JSON.stringify(row)
  )
  check(
    'and every selector sits on the same row',
    new Set(row.tops).size === 1,
    `tops ${row.tops.join(', ')} - an auto flex-basis sized each one to its own longest label`
  )
  check(
    'none of them is wider than the row it shares',
    !row.overflows && row.widest <= row.row,
    JSON.stringify(row)
  )
  check(
    'so the whole choice is one line high',
    row.height < 40,
    `${row.height}px - three stacked selectors ran to about 80`
  )

  section('a quota preemption warning')
  // ⛔ t458: `.decide-option` is a two-column grid, and "Compact & pause" / "Hand off & pause" were
  // two separate grid items rather than one — so the second button auto-placed into the
  // *description's* column and the description that followed both auto-placed into the *button*
  // column on the row under it. Seeded through the store like the other quota states above: this
  // suite spends nothing and cannot make a real vendor warn.
  const warnFixtureTitle = 'Preemption warning UI fixture'
  const warnFixtureId = await evaluate(`
    (async () => {
      const task = await window.agentyard.rpc('task.create', { title: ${JSON.stringify(warnFixtureTitle)} });
      return task.id;
    })()
  `)
  const redirectWorkerId = await evaluate(
    `window.agentyard.rpc('worker.create', { adapterId: 'claude-code', label: 'redirect target', enabled: true }).then(w => w.id)`
  )
  const runningWorkerId = await evaluate(
    `window.agentyard.rpc('fleet.list').then(fs => (fs.find(f => f.worker.label === 'ui worker') ?? fs[0])?.worker.id ?? '')`
  )
  await wait(300)
  {
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    store
      .prepare('update tasks set status = ?, assignee = ?, quota_preempt_json = ? where id = ?')
      .run(
        'running',
        runningWorkerId,
        JSON.stringify({
          trigger: 'window',
          reason: 'Claude 5h resets soon',
          preemptAt: Date.now() + 5 * 60_000,
          resumeAt: Date.now() + 60 * 60_000,
          action: 'handoff',
          canCompact: false
        }),
        warnFixtureId
      )
    store.close()
  }
  await evaluate(`document.querySelector('.back-to-list')?.click()`)
  await wait(600)
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes(${JSON.stringify(warnFixtureTitle)}))?.click()`
  )
  await wait(1200)
  const layout = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const wrap = document.querySelector('.decide--quota .decide-buttons');
        const desc = wrap?.closest('.decide-option')?.querySelector('.decide-what');
        const buttons = [...(wrap?.querySelectorAll('button') ?? [])];
        return {
          labels: buttons.map(b => b.innerText.trim()),
          lefts: buttons.map(b => Math.round(b.getBoundingClientRect().left)),
          tops: buttons.map(b => Math.round(b.getBoundingClientRect().top)),
          wrapRight: wrap ? Math.round(wrap.getBoundingClientRect().right) : null,
          descLeft: desc ? Math.round(desc.getBoundingClientRect().left) : null
        };
      })())
    `)
  )
  check(
    'compaction is not offered on a worker that cannot do it',
    !layout.labels.some((l) => /Compact/.test(l)),
    JSON.stringify(layout)
  )
  check(
    'both wrap-up buttons render in the same column',
    layout.lefts.length === 2 && new Set(layout.lefts).size === 1,
    JSON.stringify(layout)
  )
  check(
    'the two buttons stack rather than one straying beside the description',
    layout.tops.length === 2 && layout.tops[1] > layout.tops[0],
    JSON.stringify(layout)
  )
  check(
    'the description sits beside the button column, not under half of it',
    layout.wrapRight !== null && layout.descLeft !== null && layout.wrapRight <= layout.descLeft,
    JSON.stringify(layout)
  )
  // Choose a destination, then ask to hand off and reassign rather than pause here.
  await evaluate(`document.querySelector('.decide--quota .reassign-row .setting-btn-select')?.click()`)
  await wait(400)
  await evaluate(
    `[...document.querySelectorAll('.decide--quota .setting-btn-select-option')].find(o => o.innerText.includes('redirect target'))?.click()`
  )
  await wait(400)
  await evaluate(
    `[...document.querySelectorAll('.decide--quota .decide-buttons button')].find(b => b.innerText.trim() === 'Hand off & reassign')?.click()`
  )
  await wait(1000)
  const warningAfter = JSON.parse(
    await evaluate(
      `window.agentyard.rpc('task.list', {}).then(ts => JSON.stringify(ts.find(t => t.id === ${JSON.stringify(warnFixtureId)})?.quotaPreemptWarning ?? null))`
    )
  )
  check(
    'choosing a destination and Hand off & reassign records the redirect',
    warningAfter?.action === 'handoff' && warningAfter?.reassignWorkerId === redirectWorkerId,
    JSON.stringify(warningAfter)
  )
  const primaryLabel = await evaluate(
    `document.querySelector('.decide--quota .decide-buttons .btn--primary')?.innerText.trim() ?? ''`
  )
  check('the chosen wrap-up highlights', primaryLabel === 'Hand off & reassign', primaryLabel)

  section('an answer that is not on the list')
  // ⭐ A question's options are one agent's guess at what you might say, and the answer set is
  // genuinely open. The free-text box was always there, but under a list of choices it reads as a
  // footnote to whichever one you picked - so *none of these* had no row to click. Claude Code's own
  // AskUserQuestion offers Other for the same reason.
  // ⚠️ Fired and not awaited. `question.ask` is the *asker's* side of the call and does not return
  // until somebody answers - awaiting it here would hang this suite for exactly as long as the
  // agent it is standing in for would have hung.
  await evaluate(`
    void window.agentyard.rpc('question.ask', {
      sessionId: 'ui-test-other', origin: 'ask_human', kind: 'choice',
      taskId: ${JSON.stringify(heldId)},
      question: 'Which database should this use?', header: 'Storage',
      options: [
        { id: 'sqlite', label: 'SQLite' },
        { id: 'postgres', label: 'Postgres' }
      ]
    }).catch(() => {}); 'sent'
  `)
  await wait(2500)
  const askedId = await evaluate(
    `window.agentyard.rpc('question.list').then(qs => qs[0]?.id ?? '')`
  )
  check('the question is open and waiting on a person', askedId !== '', askedId)
  {
    // ⚠️ Attached to the task through the store. A question takes its task from the *run* of the
    // session that asked, and this suite spends nothing and so starts no run - so the join that
    // puts the card in a thread has to be made by hand here.
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    store.prepare('update questions set task_id = ? where id = ?').run(heldId, askedId)
    store.close()
  }
  // Leave the thread and come back, so the card re-reads the questions for this task.
  await evaluate(`document.querySelector('.back-to-list')?.click()`)
  await wait(1000)
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('awaiting_human'))?.click()`
  )
  await wait(1500)
  const otherRow = await evaluate(
    `document.querySelector('.question-card .question-option--other')?.innerText ?? ''`
  )
  check(
    'a question card offers a row for an answer nobody listed',
    /other/i.test(otherRow),
    JSON.stringify(otherRow)
  )
  await evaluate(`document.querySelector('.question-card .question-option--other')?.click()`)
  await wait(600)
  check(
    'choosing it marks the row, so the card says which answer is being given',
    (await evaluate(
      `!!document.querySelector('.question-card .question-option--other.question-option--on')`
    )) === true
  )
  // ⚠️ React owns the value; the native setter plus a bubbling input event is what a keystroke
  // looks like from its side.
  await evaluate(
    `(() => { const el = document.querySelector('.question-card .question-input');` +
      ` if (!el) return 'no box';` +
      ` const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;` +
      ` set.call(el, 'Neither - it already has one.');` +
      ` el.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`
  )
  await wait(600)
  await evaluate(
    `[...document.querySelectorAll('.question-card .question-actions .btn')].find(b => /Answer/.test(b.innerText))?.click()`
  )
  await wait(2000)
  const written = JSON.parse(
    await evaluate(`
      window.agentyard.rpc('question.forTask', { taskId: ${JSON.stringify(heldId)} })
        .then(qs => JSON.stringify(qs.find(q => q.id === ${JSON.stringify(askedId)})?.answer ?? null))
    `)
  )
  check(
    'and the typed answer is what reaches the agent',
    written?.text === 'Neither - it already has one.',
    JSON.stringify(written)
  )
  check(
    '⛔ on its own, with no option attached to it',
    Array.isArray(written?.optionIds) && written.optionIds.length === 0,
    'Other plus a choice would hand the agent both, which is not what the word means'
  )

  section('adding a project')
  // ⛔ **Driven from the sidebar, because that is where the control now is.** Adding a project was a
  // one-input form on Settings › Global whose entire validation was that the directory existed; the
  // workspace directory, the five policies and the check list were discovered afterwards on three
  // other screens. This drives the whole wizard against a real directory and reads back the two
  // things a unit test cannot see: that the daemon's findings reached the screen, and that the files
  // it said it would write are on disk.
  wizardRoot = mkdtempSync(join(tmpdir(), 'agentyard-ui-wizard-'))
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: wizardRoot, stdio: 'ignore' })
  // ⚠️ Create commits the scaffolding it writes (t506), and a commit with no identity fails into a
  // warning the wizard deliberately stays open on — which on a CI runner with no global git config
  // read as "timed out waiting for the wizard to … close" (run 35404098242). The identity is the
  // fixture's, not the host's.
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: wizardRoot, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wizardRoot, stdio: 'ignore' })
  writeFileSync(
    join(wizardRoot, 'package.json'),
    JSON.stringify({ name: 'wizard-fixture', scripts: { lint: 'x', test: 'x' } })
  )

  await evaluate(`document.querySelector('.nav-add')?.click()`)
  await waitFor(async () => await evaluate(`!!document.querySelector('.wizard')`), 'the add-project wizard to open')
  const wizardSteps = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.wizard-step')].map(s => s.innerText.trim()))`
  )
  check(
    'the sidebar’s + opens a three-step wizard rather than a text box',
    JSON.parse(wizardSteps).length === 3,
    wizardSteps
  )
  check(
    'and it offers the OS directory picker beside the path field',
    await evaluate(
      `[...document.querySelectorAll('.wizard-path button')].some(b => b.innerText.trim().startsWith('Choose'))`
    ),
    'a person should not have to paste an absolute path in by hand'
  )

  await evaluate(`(() => {
    const input = document.querySelector('.wizard-path input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(wizardRoot)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.wizard-facts')`),
    'the wizard to report what is in the directory'
  )
  const findings = await evaluate(`document.querySelector('.wizard-findings').innerText`)
  // ⛔ Non-empty assertions, per this suite's own rule: a findings box that rendered its labels and
  // none of its answers would pass a "does it contain the word Repository" check.
  check(
    'it says what is in the directory before anything is created',
    /git/i.test(findings) && /node/.test(findings) && /missing README\.md, AGENTS\.md, HANDOFF\.md/.test(findings),
    findings.replace(/\n+/g, ' | ')
  )
  check(
    'and Next is available once the directory checks out',
    await evaluate(
      `!([...document.querySelectorAll('.wizard-foot button')].find(b => b.innerText.trim() === 'Next')?.disabled)`
    ),
    await evaluate(`document.querySelector('.wizard-blockers')?.innerText ?? ''`)
  )

  await evaluate(
    `[...document.querySelectorAll('.wizard-foot button')].find(b => b.innerText.trim() === 'Next')?.click()`
  )
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.wizard-body .setting-list')`),
    'the policy step to render'
  )
  const setupStep = await evaluate(`document.querySelector('.wizard-body').innerText`)
  check(
    'the policy step recommends a workspace directory beside the project and names it',
    setupStep.includes(`${wizardRoot}_workspaces`),
    setupStep.split('\n').find((l) => l.includes('_workspaces')) ?? setupStep.slice(0, 200)
  )
  check(
    'and it offers every policy tier that resolves task → project → fleet',
    ['Finish policy', 'Landing target', 'Session sharing', 'Completion mode', 'Workspace pool'].every(
      (t) => setupStep.includes(t)
    ),
    setupStep.replace(/\n+/g, ' | ').slice(0, 300)
  )
  // ⚠️ `.value`, not `innerText`. A textarea's text is its value and never its rendered content, so
  // reading it the way every other check on this page reads a panel would pass against a blank box.
  const proposedChecks = await evaluate(
    `document.querySelector('.wizard-body .checks-input')?.value ?? ''`
  )
  check(
    'and it proposes the check commands this project’s own manifest declares',
    /npm run lint/.test(proposedChecks) && /npm run test/.test(proposedChecks),
    JSON.stringify(proposedChecks)
  )

  // ⛔ Geometry, because this dialog is the tallest thing in the app and its footer carries the only
  // way forward. A wizard whose Create button is below the fold is a wizard nobody finishes, and
  // nothing but a rendered measurement can say whether that is true.
  const wizardBox = await evaluate(`
    JSON.stringify((() => {
      const w = document.querySelector('.wizard');
      const foot = w.querySelector('.wizard-foot');
      const body = w.querySelector('.wizard-body');
      const wr = w.getBoundingClientRect(), fr = foot.getBoundingClientRect();
      return {
        fitsWindow: wr.bottom <= window.innerHeight + 1 && wr.top >= -1,
        footVisible: fr.bottom <= wr.bottom + 1 && fr.top >= wr.top,
        bodyScrolls: getComputedStyle(body).overflowY === 'auto',
        dialogClips: getComputedStyle(w).overflowY === 'visible'
      };
    })())
  `)
  const wb = JSON.parse(wizardBox)
  check('the wizard fits the window rather than running off the bottom of it', wb.fitsWindow === true, wizardBox)
  check('⛔ and its footer — the only way forward — is always on screen', wb.footVisible === true, wizardBox)
  check('because the body scrolls and the dialog does not', wb.bodyScrolls === true && wb.dialogClips === true, wizardBox)

  await evaluate(
    `[...document.querySelectorAll('.wizard-foot button')].find(b => b.innerText.trim() === 'Next')?.click()`
  )
  await waitFor(
    async () => await evaluate(`document.querySelectorAll('.wizard-doc').length === 3`),
    'the starter files to be proposed'
  )
  const plan = await evaluate(`document.querySelector('.wizard-plan').innerText`)
  check(
    'the last step says exactly what pressing Create will write',
    /project\.json/.test(plan) && /README\.md, AGENTS\.md, HANDOFF\.md/.test(plan),
    plan.replace(/\n+/g, ' | ')
  )
  // ⛔ t554: the git fate of project.json is asked, never assumed — the review step carries the
  // choice beside the plan that states its consequence, so neither answer happens silently.
  const gitFate = await evaluate(`document.querySelector('.wizard-body').innerText`)
  check(
    'the review step asks what project.json becomes in git',
    /project\.json in git/i.test(gitFate) && /Commit/.test(gitFate),
    gitFate.replace(/\n+/g, ' | ').slice(0, 300)
  )
  // ⚠️ The control is a popover: closed, it renders the chosen label only, so both answers are
  // only visible - and only assertable - with the menu open.
  await evaluate(
    `document.querySelector('.wizard-body button[aria-label="project.json in git"]')?.click()`
  )
  const gitFateOptions = await evaluate(
    `[...document.querySelectorAll('.setting-btn-select-menu[aria-label="project.json in git"] [role="option"]')].map(o => o.innerText.trim()).join(', ')`
  )
  check(
    'and offers both answers, neither taken silently',
    /Commit/.test(gitFateOptions) && /Ignore/.test(gitFateOptions),
    gitFateOptions
  )
  // Close it by choosing the committed answer the rest of this case then verifies on disk.
  await evaluate(
    `[...document.querySelectorAll('.setting-btn-select-menu[aria-label="project.json in git"] [role="option"]')].find(o => o.innerText.trim().startsWith('Commit'))?.click()`
  )
  await waitFor(
    async () => await evaluate(`!document.querySelector('.setting-btn-select-menu')`),
    'the git-fate menu to close'
  )

  await evaluate(
    `[...document.querySelectorAll('.wizard-foot button')].find(b => b.innerText.trim() === 'Create project')?.click()`
  )
  await waitFor(
    async () => await evaluate(`!document.querySelector('.wizard')`),
    'the wizard to create the project and close'
  )
  check(
    'creating writes the committed policy file',
    existsSync(join(wizardRoot, '.warmstart', 'project.json')),
    join(wizardRoot, '.warmstart', 'project.json')
  )
  const wizardConfig = JSON.parse(
    readFileSync(join(wizardRoot, '.warmstart', 'project.json'), 'utf8')
  )
  check(
    'and the check commands the wizard proposed are in it',
    Array.isArray(wizardConfig.check) && wizardConfig.check.join(',') === 'npm run lint,npm run test',
    JSON.stringify(wizardConfig.check)
  )
  check(
    'and the three orientation docs are on disk, named for the project',
    ['README.md', 'AGENTS.md', 'HANDOFF.md'].every((f) => existsSync(join(wizardRoot, f))) &&
      readFileSync(join(wizardRoot, 'AGENTS.md'), 'utf8').includes('never directly on `main`'),
    'README.md, AGENTS.md, HANDOFF.md'
  )
  check(
    'and the sidebar opens the project it just made',
    await until(async () =>
      (await evaluate(`document.querySelector('.nav-item--active')?.innerText.trim() ?? ''`)).startsWith(
        'wizard-fixture'
      )
    ),
    await evaluate(`document.querySelector('.nav-item--active')?.innerText.trim() ?? '(none)'`)
  )

  section('project settings')
  // ⛔ The one tab in this app that writes into somebody's **repository**. Its policy tier — finish,
  // sharing, completion — resolved through the project since M2 and could only be *set* by hand-
  // editing committed JSON, so a control that reads back what it wrote is the whole point of the
  // section rather than a nicety.
  projectRoot = mkdtempSync(join(tmpdir(), 'agentyard-ui-project-'))
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: projectRoot, stdio: 'ignore' })
  await evaluate(
    `window.agentyard.rpc('project.add', { root: ${JSON.stringify(projectRoot)}, name: 'ui project' })`
  )
  await wait(1200)
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('ui project'))?.click()`
  )
  await wait(800)
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Settings')?.click()`
  )
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.setting-row')`),
    'the project settings tab to render'
  )

  const panelHeads = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.content .panel-head h2')].map(h => h.innerText.trim()))`
  )
  const heads = JSON.parse(panelHeads)
  check(
    'the page opens with what the project *is*, not with a list of shell commands',
    heads[0] === 'Project settings',
    heads.join(' | ')
  )
  check(
    'and the policy it sets comes before the commands that verify it',
    heads.indexOf('Policy') > 0 && heads.indexOf('Policy') < heads.indexOf('Verification'),
    heads.join(' | ')
  )
  check(
    'one project at a time: no other project’s row is on it',
    (await evaluate(
      `[...document.querySelectorAll('.content .tbl tbody tr')].length >= 1 &&
       !document.querySelector('.content').innerText.includes('Add project')`
    )) === true,
    'this tab used to embed the fleet-wide project table, add form and all'
  )

  // ⛔ A textarea holding the commands that gate every landing, which borrowed the composer's
  // deliberately invisible styling: `border: 0`, `background: transparent`. On a light theme it was
  // indistinguishable from the paragraph above it.
  const checksBox = await evaluate(`
    (() => {
      const el = document.querySelector('.checks-input');
      if (!el) return null;
      const s = getComputedStyle(el);
      return JSON.stringify({ border: s.borderTopWidth, bg: s.backgroundColor });
    })()
  `)
  const box = checksBox ? JSON.parse(checksBox) : null
  check(
    'the check-command box is drawn as a box',
    box !== null && Number.parseFloat(box.border) > 0 && box.bg !== 'rgba(0, 0, 0, 0)',
    checksBox ?? 'no .checks-input on the page'
  )

  // ⛔ The fix itself: the middle tier is settable, and what it resolves to says where it came from.
  const inheritedRow = await evaluate(
    `[...document.querySelectorAll('.setting-row')].find(r => r.innerText.includes('Finish policy'))?.innerText ?? ''`
  )
  check(
    'a project that has decided nothing says it is inheriting, and from where',
    inheritedRow.includes('from the fleet'),
    inheritedRow.split('\n')[0]
  )
  const finishLayout = JSON.parse(
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.setting-row')].find(r => r.innerText.includes('Finish policy'));
        const title = row?.querySelector('.setting-row-title')?.getBoundingClientRect();
        const control = row?.querySelector('.setting-row-control')?.getBoundingClientRect();
        return JSON.stringify({ titleRight: title?.right ?? 0, controlLeft: control?.left ?? 0 });
      })()
    `)
  )
  check(
    'project policy controls align on the right, like Global Settings',
    finishLayout.controlLeft > finishLayout.titleRight,
    JSON.stringify(finishLayout)
  )

  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.setting-row')].find(r => r.innerText.includes('Finish policy'));
      row.querySelector('.setting-btn-select').click();
    })()
  `)
  await wait(400)
  await evaluate(`
    (() => {
      const opts = [...document.querySelectorAll('.setting-btn-select-option')];
      opts.find(o => o.innerText.includes('commit only')).click();
    })()
  `)
  await wait(1500)
  check(
    'choosing one writes it into the project’s committed config',
    JSON.parse(
      readFileSync(join(projectRoot, '.warmstart', 'project.json'), 'utf8')
    ).landing?.finish === 'commit-only',
    'project.setPolicy is the only write path this page has'
  )
  const decidedRow = await evaluate(
    `[...document.querySelectorAll('.setting-row')].find(r => r.innerText.includes('Finish policy'))?.innerText ?? ''`
  )
  check(
    'and the page then says the answer came from the project',
    decidedRow.includes('from the project'),
    decidedRow.split('\n')[0]
  )

  section('project tabs')
  // ⛔ **Two nouns, two tabs.** The tab that draws a live agent's terminal was called `Sessions`,
  // which read as "this project's sessions" — a real and different thing that now has its own tab
  // and is called Conversations. A pane that renders a TTY has to say so in its name, or the two
  // questions ("what is it doing right now?" and "what has it done?") land on one screen that
  // answers only the first.
  const tabs = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.tabs .tab')].map(t => t.innerText.trim()))`
    )
  )
  check(
    'the project offers Conversations and Session TUI as separate destinations',
    tabs.includes('Conversations') && tabs.includes('Session TUI'),
    tabs.join(' | ')
  )
  check(
    '⛔ and nothing is called just "Sessions" any more',
    !tabs.includes('Sessions'),
    tabs.join(' | ')
  )
  check(
    'Conversations sits before the terminal that shows one of them live',
    tabs.indexOf('Conversations') < tabs.indexOf('Session TUI'),
    tabs.join(' | ')
  )

  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Conversations')?.click()`
  )
  // ⚠️ Waits for the *answer*, not for the heading. The heading paints before the first
  // `conversation.list` returns, so asserting on it catches the loading line and reads as a missing
  // empty state — the exact race this suite exists to keep out of the checks it reports.
  await waitFor(
    async () =>
      await evaluate(
        `!/Reading conversations/.test(document.querySelector('.content .empty-inline')?.innerText ?? '')
         && [...document.querySelectorAll('.content .panel-head h2')].some(h => h.innerText.trim() === 'Conversations')`
      ),
    'the project conversations tab to render'
  )
  // ⚠️ This project has never dispatched anything, so the honest content is the empty state — and an
  // empty state that says nothing is how a working screen gets reported as broken.
  const convEmpty = await evaluate(
    `document.querySelector('.content .empty-inline')?.innerText ?? ''`
  )
  check(
    'a project with no conversations says what would create one',
    /No conversations yet/i.test(convEmpty) && /dispatched/i.test(convEmpty),
    convEmpty.split('\n').join(' / ')
  )
  // ⛔ The filters are the same control the task table uses, for the same reason: this list grows
  // without bound, and `Trouble 0` is the answer somebody is scanning for before they click.
  const convChips = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.content .chip')].map(c => c.innerText.trim()))`
    )
  )
  check(
    'the conversation list can be narrowed to the ones worth looking at',
    convChips.length === 4 &&
      convChips.some((c) => c.startsWith('Shared')) &&
      convChips.some((c) => c.startsWith('Trouble')),
    convChips.join(' | ')
  )

  // ⛔ The same component, at fleet scope. If History rendered a second table the two would drift
  // about what a conversation is, which is the whole reason there is one of them.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Conversations'))?.click()`
  )
  await waitFor(
    async () =>
      await evaluate(
        `[...document.querySelectorAll('.content .panel-head h2')].some(h => h.innerText.trim() === 'Conversations')`
      ),
    'the global conversations page to render'
  )
  const globalChips = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.content .chip')].map(c => c.innerText.trim()))`
    )
  )
  check(
    'History shows the same conversation view, not a second one',
    globalChips.length === 4,
    globalChips.join(' | ')
  )
  const globalHeads = await evaluate(
    `[...document.querySelectorAll('.content .tbl thead th')].map(h => h.innerText.trim()).join('|')`
  )
  check(
    '⛔ and it says Worker, which is what every other screen calls that column',
    globalHeads === '' || (/Worker/.test(globalHeads) && !/Account/i.test(globalHeads)),
    globalHeads || '(no conversations on this install, so no header to read)'
  )

  section('open conversations in the sidebar, and renaming from the convoHeading')
  // ⛔ Switching between two conversations meant Tasks board → find the row → open it, every time
  // (t479). A project now lists the conversations it is in the middle of under itself in the
  // sidebar, and one press lands on the thread. ⚠️ Filed through the RPC rather than the composer,
  // because the point is the sidebar and the thread, not the form; the one worker has no
  // credentials, so this conversation is held unfinished, which is exactly the state that lists it.
  const sideConvo = JSON.parse(
    await evaluate(`
      (async () => {
        const r = window.agentyard.rpc;
        const projects = await r('project.list');
        const project = projects.find(p => p.name === 'ui project');
        const t = await r('task.create', {
          title: 'can you look at why the tests hang',
          kind: 'conversation',
          projectId: project.id,
          prompt: 'can you look at why the tests hang'
        });
        const done = await r('task.create', {
          title: 'a conversation that is over',
          kind: 'conversation',
          projectId: project.id
        });
        // ⚠️ Resolved, not cancelled: Cancel winds a task down into a *resting* state (paused_user
        // here), and a paused conversation is still one you are in the middle of, so it stays listed.
        // Mark done is what finishes it.
        await r('task.resolve', { id: done.id });
        return JSON.stringify({ id: t.id, seq: t.seq, status: t.status, doneSeq: done.seq });
      })()
    `)
  )
  await wait(1500)
  const sidebarRows = async () =>
    JSON.parse(
      await evaluate(`
        JSON.stringify([...document.querySelectorAll('.nav-item--conversation')].map(b => ({
          text: b.innerText.replace(/\\s+/g, ' ').trim(),
          title: b.getAttribute('title') ?? '',
          active: b.classList.contains('nav-item--active')
        })))
      `)
    )
  let sideRows = await sidebarRows()
  check(
    '⛔ an unfinished conversation is listed under its project in the sidebar',
    sideRows.some((r) => r.text.includes('why the tests hang')),
    JSON.stringify(sideRows)
  )
  check(
    'and a finished one is not',
    !sideRows.some((r) => r.title.includes(`t${sideConvo.doneSeq} `)),
    JSON.stringify(sideRows)
  )
  check(
    'each row carries the conversation mark',
    sideRows.every((r) => r.text.startsWith('💬')),
    JSON.stringify(sideRows)
  )
  // ⚠️ Half the claim: the row has to be there for the click to prove anything.
  await evaluate(
    `[...document.querySelectorAll('.nav-item--conversation')].find(b => b.innerText.includes('why the tests hang'))?.click()`
  )
  await wait(1200)
  const convoHeading = await evaluate(`document.querySelector('.detail-head h3')?.innerText ?? ''`)
  check(
    'pressing it opens that conversation’s thread directly',
    convoHeading.includes(`t${sideConvo.seq}`) && convoHeading.includes('why the tests hang'),
    convoHeading || '(no thread convoHeading on the page)'
  )
  sideRows = await sidebarRows()
  check(
    'and the row reads as the open one',
    sideRows.some((r) => r.text.includes('why the tests hang') && r.active),
    JSON.stringify(sideRows)
  )

  // ⛔ A title had no editor outside a draft. The convoHeading is the control now, and the write goes
  // through the daemon: the name below is read back from `task.list`, not from the input.
  await evaluate(`document.querySelector('.title-rename')?.click()`)
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.title-editor-input')`),
    'the title editor to open'
  )
  await evaluate(
    `(() => { const el = document.querySelector('.title-editor-input');` +
      ` const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;` +
      ` set.call(el, 'The hanging tests'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`
  )
  await evaluate(`document.querySelector('.title-editor')?.requestSubmit()`)
  let renamedJson = null
  await waitFor(
    async () =>
      (renamedJson = await evaluate(
        `window.agentyard.rpc('task.list', {}).then(ts => ts.find(t => t.id === ${JSON.stringify(sideConvo.id)}))
          .then(t => JSON.stringify({ title: t.title, status: t.status, summary: t.titleSummary }))`
      )) && JSON.parse(renamedJson).title === 'The hanging tests',
    'the rename to reach the daemon'
  )
  const renamedTask = JSON.parse(renamedJson)
  check('renaming from the heading writes the title through to the daemon', renamedTask.title === 'The hanging tests', renamedJson)
  // ⚠️ The status this suite can reach is the held `ready` (no credentialed worker); the
  // `awaiting_human` case, which is the one a person actually renames, is pinned at L1 in
  // `titlesummary.test.ts`. What this proves is that the write changed the name and nothing else.
  check(
    '⛔ and changes nothing but the name',
    renamedTask.status === sideConvo.status && renamedTask.summary === null,
    `${renamedJson} (was ${sideConvo.status})`
  )
  await wait(800)
  const afterHeading = await evaluate(`document.querySelector('.detail-head h3')?.innerText ?? ''`)
  sideRows = await sidebarRows()
  check(
    'the heading and the sidebar row both read the new name',
    afterHeading.includes('The hanging tests') && sideRows.some((r) => r.text.includes('The hanging tests')),
    `heading: ${afterHeading} · rows: ${JSON.stringify(sideRows)}`
  )

  // The fold: the toggle on the project row hides the list and remembers it.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('ui project'))?.querySelector('.nav-fold')?.click()`
  )
  await wait(400)
  const foldedRows = await sidebarRows()
  const foldCount = await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('ui project'))?.querySelector('.nav-fold')?.innerText.trim() ?? ''`
  )
  check('the project row folds its conversations away and shows how many are folded', foldedRows.length === 0 && /1/.test(foldCount), `sideRows: ${foldedRows.length}, fold: ${foldCount}`)
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('ui project'))?.querySelector('.nav-fold')?.click()`
  )
  await wait(400)
  check('and unfolds them again', (await sidebarRows()).length === 1)

  // Finishing the conversation takes it off the list — the list is what you are in the middle of.
  const resolved = await evaluate(
    `window.agentyard.rpc('task.resolve', { id: ${JSON.stringify(sideConvo.id)} }).then(t => t.status, e => 'error: ' + e.message)`
  )
  await waitFor(
    async () => (await sidebarRows()).length === 0,
    `the finished conversation to leave the sidebar (resolve said: ${resolved})`
  )
  check('a conversation leaves the sidebar once it is finished', (await sidebarRows()).length === 0, resolved)

  section('global settings')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Global')).click()`
  )
  await wait(800)
  // ⚠️ The Projects table, and the Workspaces column these checks read, moved onto **Status** when
  // t422 split Global into tabs. Naming the tab is what keeps the check about the column rather than
  // about which tab Global happened to remember.
  await evaluate(
    `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Status')?.click()`
  )
  await wait(1000)
  // ⛔ Removed 2026-08-31. A read-only roll-up of every pool and lock in the fleet, one screen away
  // from the project each belongs to, under a heading that says Settings — it read as a page of
  // things you could change and was not. The free/capacity number survives where it is useful: the
  // Workspaces column on each project's own row.
  const globalHeadings = await evaluate(
    `[...document.querySelectorAll('.content h2, .content h3')].map(h => h.innerText.trim()).join('|')`
  )
  check(
    'Settings > Global no longer carries a fleet-wide Resources table',
    !/(^|\|)Resources(\||$)/.test(globalHeadings),
    globalHeadings
  )
  check(
    '⚠️ but each project still says how much of its pool is free',
    await evaluate(
      `[...document.querySelectorAll('.content .tbl thead th')].some(h => /Workspaces/i.test(h.innerText))`
    ),
    globalHeadings
  )

  section('saying one task waits for another, in the thread')
  // ⭐ The half of the DAG a person could not reach. The New Task form's picker is covered above by
  // the row it adds to the form; this is the *other* control — the one used when the ordering is
  // learned halfway through, about two tasks that already exist — driven through the real app,
  // because an edge that is recorded without re-deriving the status looks identical from the daemon
  // side and is a task the scheduler dispatches while it is supposed to be waiting.
  await evaluate(`
    (async () => {
      const r = window.agentyard.rpc;
      await r('task.create', { title: 'ui prerequisite task', priority: 'P2' });
      await r('task.create', { title: 'ui dependent task', priority: 'P2' });
      return 'filed';
    })()
  `)
  await waitFor(
    async () =>
      await evaluate(
        `[...document.querySelectorAll('.nav-item')].some(b => b.innerText.trim().startsWith('Unassigned'))`
      ),
    'Unassigned nav item'
  )
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Unassigned'))?.click()`
  )
  await waitFor(
    async () =>
      await evaluate(
        `[...document.querySelectorAll('.tbl tbody tr')].some(r => r.innerText.includes('ui dependent task'))`
      ),
    'ui dependent task row'
  )
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('ui dependent task'))?.click()`
  )
  await waitFor(
    async () =>
      await evaluate(
        `!!document.querySelector('.detail-side button[aria-label="Add a prerequisite"]')`
      ),
    'the prerequisite picker in the task ledger'
  )
  await evaluate(`document.querySelector('.detail-side button[aria-label="Add a prerequisite"]')?.click()`)
  await waitFor(
    async () =>
      await evaluate(
        `document.querySelectorAll('.detail-side .setting-btn-select-option').length > 1`
      ),
    'the prerequisite options menu in the task ledger'
  )
  const offeredPrereqs = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.detail-side .setting-btn-select-option')]
       .map(o => o.innerText))`
  )
  check(
    'the ledger offers other tasks by number and title',
    JSON.parse(offeredPrereqs).some((o) => /^t\d+ · ui prerequisite task/.test(o)),
    offeredPrereqs
  )
  check(
    '⛔ and never the task itself, which would be an edge nothing could ever satisfy',
    !JSON.parse(offeredPrereqs).some((o) => /ui dependent task/.test(o)),
    offeredPrereqs
  )
  await evaluate(
    `[...document.querySelectorAll('.detail-side .setting-btn-select-option')].find(o => /ui prerequisite task/.test(o.innerText))?.click()`
  )
  await wait(2000)
  const ledger = `
    JSON.stringify((() => {
      const facts = [...document.querySelectorAll('.detail-side .fact')];
      const at = (re) => facts.find(f => re.test(f.querySelector('.fact-label')?.innerText ?? ''));
      const deps = at(/depends on/i);
      return {
        // ⚠️ The list, not the whole fact. The picker beside it holds every candidate as an
        // option element and innerText includes them, so an assertion made against the fact passes
        // whether or not the edge was ever drawn — and would still pass after it was removed.
        deps: deps?.querySelector('.dep-list')?.innerText.replace(/\\s+/g, ' ') ?? 'none',
        removable: !!deps?.querySelector('.dep-remove'),
        status: at(/^status/i)?.innerText.replace(/\\s+/g, ' ') ?? ''
      };
    })())
  `
  const withDep = JSON.parse(await evaluate(ledger))
  check('choosing one writes it into the ledger', /ui prerequisite task/.test(withDep.deps), JSON.stringify(withDep))
  check(
    '⛔ and the task is blocked on the same click, not at the next tick',
    /blocked/i.test(withDep.status),
    JSON.stringify(withDep)
  )
  check('and the row it made offers the way back out', withDep.removable === true, JSON.stringify(withDep))
  await evaluate(`document.querySelector('.detail-side .dep-remove')?.click()`)
  await wait(2000)
  const cleared = JSON.parse(await evaluate(ledger))
  check(
    'removing it lets the task go again',
    !/ui prerequisite task/.test(cleared.deps) && !/blocked/i.test(cleared.status),
    JSON.stringify(cleared)
  )

  section('identifiers in a thread message read as identifiers')
  // ⛔ Every message this codebase writes names refs, branches, shas and files in backticks —
  // *"Landed as `98f200ab` onto `main`"* — and the thread printed the backticks. The reader got the
  // punctuation and none of the distinction it was there to make. ⚠️ A **person's** own message is
  // still read this way and only this way — see `MessageText` and `lib/markdown.ts`.
  await evaluate(`
    (async () => {
      const id = await window.agentyard.rpc('task.page', { limit: 100 })
        .then(p => p.tasks.find(t => t.title === 'ui dependent task')?.id);
      await window.agentyard.rpc('task.message', { id, text: 'Landed as \`98f200ab\` onto \`main\`. literally **two** asterisks' });
      return id;
    })()
  `)
  let fenced = null
  await waitFor(async () => {
    const got = await evaluate(`
      JSON.stringify((() => {
        const codes = [...document.querySelectorAll('.thread--task .msg-text code.msg-code')]
          .map(c => c.innerText);
        if (codes.length === 0) return null;
        const said = [...document.querySelectorAll('.thread--task .msg-text')]
          .map(t => t.innerText).join(' ');
        return {
          codes,
          backticks: said.includes('\`'),
          asterisks: said.includes('**two**'),
          markdownInMine: document.querySelectorAll('.msg--human .md').length
        };
      })())
    `)
    fenced = got === 'null' || got == null ? null : JSON.parse(got)
    return fenced !== null
  }, 'a fenced identifier in the thread')

  check(
    'a branch, a ref or a sha is set apart from the sentence around it',
    fenced.codes.includes('98f200ab') && fenced.codes.includes('main'),
    JSON.stringify(fenced)
  )
  check(
    '⛔ and the fences themselves are gone, not printed as punctuation',
    fenced.backticks === false,
    JSON.stringify(fenced)
  )
  // ⛔ **A person's own message is not reinterpreted, and this is the half that protects it.** Agent,
  // controller and system text is read as markdown since t369 — `lib/markdown.ts` — but somebody who
  // typed `**` into the box typed two asterisks, can see exactly what they sent, and must get them
  // back. `task.message` writes a `human` row, which is the only role this suite can author.
  check(
    '⛔ a person’s own asterisks come back as asterisks, not as bold',
    fenced.asterisks === true && fenced.markdownInMine === 0,
    JSON.stringify(fenced)
  )

  section('the prompt chip hangs under the request, not under the answer')
  // ⛔ **The sender's side.** A prompt is what somebody sent, so the `📋 1,475` chip belongs under
  // the message that asked — the person's own `/push`, or the opening message of a task an agent
  // filed — not under the agent's last answer two bubbles below, which is where it sat until t478
  // and read as though the agent had been handed its own reply. `promptAnchors` decides; this reads
  // back which bubble the built app actually drew it under.
  const chipTaskId = await evaluate(`
    window.agentyard.rpc('task.page', { limit: 100 })
      .then(p => p.tasks.find(t => t.title === 'ui dependent task')?.id)
  `)
  {
    // Seeded through the store: a run carries a prompt only once an agent has been dispatched, and
    // this suite's worker has no credentials, so there is no honest way to author one over an RPC.
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    const workerId = store.prepare('select id from workers limit 1').get().id
    const startedAt = Date.now()
    store
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, ended_at, outcome, prompt)
         values (?,?,?,?,?,?,?)`
      )
      .run('ui-chip-run', chipTaskId, workerId, startedAt, startedAt + 1000, 'success', 'the prompt this run was sent')
    store
      .prepare(
        `insert into task_messages (task_id, role, text, run_id, ts) values (?,?,?,?,?)`
      )
      .run(chipTaskId, 'agent', 'Done — landed it.', 'ui-chip-run', startedAt + 1000)
    store.close()
  }
  // Leaving the task and coming back is what re-reads the thread and its runs.
  await evaluate(`document.querySelector('.detail-head .back-to-list')?.click()`)
  await waitFor(
    async () =>
      await evaluate(
        `[...document.querySelectorAll('.tbl tbody tr')].some(r => r.innerText.includes('ui dependent task'))`
      ),
    'the task list to come back'
  )
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('ui dependent task'))?.click()`
  )
  let chipAt = null
  await waitFor(async () => {
    const got = await evaluate(`
      JSON.stringify((() => {
        const chips = [...document.querySelectorAll('.thread--task .prompt-chip')];
        if (chips.length === 0) return null;
        return {
          n: chips.length,
          on: chips.map(c => {
            const msg = c.closest('.msg');
            return {
              role: [...msg.classList].find(k => k.startsWith('msg--') && k !== 'msg--right' && k !== 'msg--left'),
              side: msg.classList.contains('msg--right') ? 'right' : 'left',
              said: msg.querySelector('.msg-text')?.innerText.slice(0, 40) ?? ''
            };
          })
        };
      })())
    `)
    chipAt = got === 'null' || got == null ? null : JSON.parse(got)
    return chipAt !== null
  }, 'the prompt chip on the seeded run')
  check(
    'the chip sits under the human message that asked, on its own side of the thread',
    // ⚠️ Every chip, not exactly one: `task.message` above requeued this task, and whether the
    // daemon then dispatched a real run with a prompt of its own before this section (it does on
    // a developer machine, not on CI) is a fact about the host, not about where a chip hangs.
    chipAt.n >= 1 && chipAt.on.every((c) => c.role === 'msg--human' && c.side === 'right'),
    JSON.stringify(chipAt)
  )
  check(
    '⛔ and not under the agent’s answer, which is where it used to be',
    chipAt.on.every((c) => c.role !== 'msg--agent'),
    JSON.stringify(chipAt)
  )

  section('what the thread ledger says a task cost')
  // ⭐ The right pane's two money-adjacent rows, read back from the built app. Price and tokens are
  // two measurements docs/cost-model.md §5 never reconciles, and they were drawn as one number with
  // a caption under it — which reads as the token count *explaining* the price. Two labelled rows,
  // and the unit lives in the label so the value stays a number.
  // ⛔ **Opened deliberately, because this section used to read whichever pane was still on screen.**
  // The section above leaves `t8 · ui dependent task` open, whose model row is a label with an empty
  // value — nothing has run on it and no account is named — so the model check below only passed
  // while the read landed on the pane before it, and it was measured reading `Opus 5 confirmed by
  // the transcript`, which is a different task's run. Adding four seconds anywhere earlier in the
  // suite flipped it (2026-09-08). The task named here has never run and has nothing pinned, which
  // is the case all four of these checks are about.
  await evaluate(`document.querySelector('.detail-head .back-to-list')?.click()`)
  await waitFor(
    async () =>
      await evaluate(
        `[...document.querySelectorAll('.tbl tbody tr')].some(r => r.innerText.includes('A task the UI can render'))`
      ),
    'the task list to come back'
  )
  await evaluate(
    `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('A task the UI can render'))?.click()`
  )
  // ⚠️ Bounded at the resource, not slept past: the row's answer comes from `model.options`, which
  // is fetched on mount, so it is a label with nothing under it while that request is in flight.
  await waitFor(
    async () =>
      await evaluate(`(() => {
        const facts = [...document.querySelectorAll('.detail-side .fact')];
        const model = facts.find(f => /^model$/i.test(f.querySelector('.fact-label')?.innerText ?? ''));
        return (model?.querySelector('.fact-value')?.innerText ?? '').trim().length > 0;
      })()`),
    'the model row to say what the next dispatch would ask for'
  )
  const cost = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const facts = [...document.querySelectorAll('.detail-side .fact')];
        const at = (re) => facts.find(f => re.test(f.querySelector('.fact-label')?.innerText ?? ''));
        const val = (re) => at(re)?.querySelector('.fact-value')?.innerText.replace(/\\s+/g, ' ').trim() ?? null;
        return { price: val(/^price$/i), tokens: val(/^tokens$/i), model: val(/^model$/i) };
      })())
    `)
  )
  check('price is its own row', cost.price !== null, JSON.stringify(cost))
  check('and tokens is another', cost.tokens !== null, JSON.stringify(cost))
  check(
    '⛔ neither row repeats its unit in the value — the label already carries it',
    !/tokens/i.test(cost.tokens ?? 'tokens') && !/\$/.test(cost.tokens ?? '$'),
    JSON.stringify(cost)
  )
  check(
    '⚠️ a task that has never run is priced n/a, which is not $0.00',
    /n\/a/i.test(cost.price ?? ''),
    JSON.stringify(cost)
  )
  // ⚠️ Nothing has run, so there is no measurement to lead with and no second line to disagree with
  // it. The model row says what the next dispatch would ask for, and says only that.
  check(
    'the model row names the CLI’s own choice when nobody has pinned one',
    /CLI default/.test(cost.model ?? ''),
    JSON.stringify(cost)
  )

  section('the three views of a project are the same width')
  // ⛔ Flow, Tasks and Thread are looked at one after another. A 1100px cap on one of them and not
  // the others made the task table jump narrow on the way in from the board beside it.
  await evaluate(`document.querySelector('.detail-head .back-to-list')?.click()`)
  await waitFor(
    async () => await evaluate(`!!document.querySelector('.panel .tbl tbody tr')`),
    'the task list this thread was opened from'
  )
  const widths = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        // ⚠️ The panel the task table is actually in, not one built here: the point is that this
        // screen opts out of the cap, which a synthetic element could not tell us.
        const el = document.querySelector('.panel .tbl')?.closest('.panel');
        const plain = document.createElement('div');
        plain.className = 'panel';
        document.body.appendChild(plain);
        const out = {
          wide: el ? getComputedStyle(el).maxWidth : null,
          classes: el ? el.className : null,
          plain: getComputedStyle(plain).maxWidth
        };
        plain.remove();
        return out;
      })())
    `)
  )
  check('a task list takes the whole window', widths.wide === 'none', JSON.stringify(widths))
  check(
    '⚠️ while an ordinary panel keeps its reading measure',
    widths.plain === '1100px',
    JSON.stringify(widths)
  )

  section('how much of a title the task table will show')
  // ⛔ Two truncations were fighting and the wrong one won. The cell ellipsises at the column's real
  // edge; the renderer *also* cut the string at 70 characters first, so a stretched window drew an
  // `…` with empty space after it — a truncation mark that was not telling the truth. The cut is now
  // a bound on the payload (240) well past the widest the column can be, which leaves CSS to decide.
  const LONG_TITLE = 'Please make the landing message self explanatory and let the title column '
    + 'take the slack when the window is stretched, because it is the only text-heavy column here'
  const titleShown = JSON.parse(
    await evaluate(`
      (async () => {
        const t = await window.agentyard.rpc('task.create', { title: ${JSON.stringify(LONG_TITLE)} });
        return JSON.stringify({ id: t.id });
      })()
    `)
  )
  // ⚠️ `waitFor` reports only that the condition held, so the reading is kept as it is taken. The
  // table re-fetches on the daemon's own event, which arrives after `task.create` returns.
  let shown = null
  await waitFor(async () => {
    const got = await evaluate(`
      JSON.stringify((() => {
        const cells = [...document.querySelectorAll('.tbl--tasks .tbl-title .tbl-strong')];
        const hit = cells.map(c => c.innerText.trim()).find(t => t.startsWith('Please make the landing'));
        if (!hit) return null;
        const cell = document.querySelector('.tbl--tasks .tbl-title-cell');
        const num = document.querySelector('.tbl--tasks tbody tr td.tbl-num');
        return { text: hit, cell: cell?.offsetWidth ?? 0, num: num?.offsetWidth ?? 0 };
      })())
    `)
    shown = got === 'null' || got == null ? null : JSON.parse(got)
    return shown !== null
  }, 'the long-titled task in the table')

  check(
    'the row shows more of a long title than the 70 characters it used to stop at',
    shown.text.length > 70,
    JSON.stringify({ length: shown.text.length, text: shown.text.slice(0, 90) })
  )
  check(
    '⚠️ and the ellipsis, when there is one, is drawn by the column rather than by the string',
    !shown.text.slice(0, -1).includes('…'),
    JSON.stringify({ text: shown.text.slice(-40) })
  )
  check(
    '⛔ the title column is the one that takes the slack, not an equal share of it',
    shown.cell > shown.num * 4,
    JSON.stringify({ title: shown.cell, numeric: shown.num })
  )
  // ⚠️ Left in place rather than deleted: `task.delete` refuses a `ready` task by design — cancel
  // comes first — and cancelling one to tidy a fixture would be spending two RPCs to assert nothing.
  // The whole data directory goes in `finally`.
  void titleShown

  // ⛔ **A collapsed column is not a narrow one, and it paints nothing.** Measured 2026-09-13 in
  // Electron 44 on a `visibility: collapse; width: 0` <col>: its cell reads clientWidth 0 and
  // scrollWidth 75, its computed visibility is still `visible`, and its nowrap span's right edge sits
  // 75px past the next cell's left — the exact shape of an overflow and a collision — while a
  // screenshot of the same table shows nothing of it. The two sections below were written at a
  // 1440px window where every column is drawn, and read that shape as six faults across both CI
  // runners (run 34795442043): Windows clamps the window to a 1024px screen and Xvfb leaves the panel
  // under 1050px beside the default sidebar, so Created and Updated were collapsed by the very rule
  // *the task table responds to its own width* proves.
  //
  // So first take the widest layout this screen allows — the sidebar at its own minimum, read off the
  // separator rather than hard-coded — and measure only what is drawn there. A column still collapsed
  // after that is a fact about the display, which is `skip`'s rule; a check over the collapsed cells
  // would fail a layout nobody can see, and one over an empty list would pass while proving nothing.
  const drawnDates = `[...document.querySelectorAll('.tbl--tasks tbody td.tbl-when')].filter((c) => c.clientWidth > 0).length`
  const sidebarBefore = await evaluate(`document.documentElement.style.getPropertyValue('--sidebar-w')`)
  const widened = (await evaluate(drawnDates)) === 0
  if (widened) {
    await evaluate(`(() => {
      const min = document.querySelector('.resizer')?.getAttribute('aria-valuemin');
      if (min) document.documentElement.style.setProperty('--sidebar-w', min + 'px');
    })()`)
    await wait(200)
  }
  const wideLayout = JSON.parse(
    await evaluate(`
      JSON.stringify({
        viewport: window.innerWidth,
        panel: Math.round(document.querySelector('.tbl--tasks')?.closest('.panel')?.getBoundingClientRect().width ?? 0),
        sidebar: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
        drawnDates: ${drawnDates}
      })
    `)
  )
  check(
    'the widest layout this screen allows draws the date columns, or its panel is under the 1050px they collapse at',
    wideLayout.drawnDates > 0 || wideLayout.panel <= 1050,
    JSON.stringify({ ...wideLayout, widened })
  )

  section('the table headings each fit on one line')
  // ⭐ Reported 2026-09-13: at 100% zoom *Took* was drawn as two rows, which makes the whole header
  // row two rows deep and pushes every label out of line with the numbers under it. The headings are
  // uppercase with letter-spacing, and the sorted one carries an arrow, so this is a measurement
  // rather than a guess about four characters — taken in the built app, in the font it actually loads.
  //
  // ⛔ **Every heading, and each while it is the sorted one.** Any column can be sorted, so the
  // arrow can appear on any of them; measuring only the column that happens to be sorted passes a
  // table that breaks the moment somebody clicks a different one. Two of the three faults this found
  // were not the one reported — `ACTION` wrapped and `QUALITY` overflowed.
  const headRows = []
  const headLabels = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.tbl--tasks thead th')].map(th => (th.querySelector('.sort-head') ?? th).innerText.replace(/\\s+/g, ' ').trim()))`
    )
  )
  for (let i = 0; i < headLabels.length; i += 1) {
    // Sortable headings are measured while sorted; the rest as they are drawn.
    await evaluate(
      `document.querySelectorAll('.tbl--tasks thead th')[${i}]?.querySelector('.sort-head')?.click()`
    )
    await wait(150)
    headRows.push(
      JSON.parse(
        await evaluate(`
          JSON.stringify((() => {
            const th = document.querySelectorAll('.tbl--tasks thead th')[${i}];
            if (!th) return null;
            const text = th.querySelector('.sort-head') ?? th;
            // ⛔ A Range over the label's own contents, not the element's box. Two ways of
            // measuring this were wrong before this one: scrollWidth on a *wrapping* box reports
            // the box's own width, so it reads the column back at itself and calls any overflow a
            // fit; and an element's height includes the cell's padding, which rounded the one
            // heading with no button inside it (ACTION) up to two lines that were never there.
            // A Range measures the text, whatever markup does or does not wrap it.
            const range = document.createRange();
            range.selectNodeContents(text);
            const box = range.getBoundingClientRect();
            // One line box per distinct top: the arrow is its own rect beside the word, so counting
            // rects would read every sorted heading as two lines.
            const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
            const style = getComputedStyle(th);
            const room = th.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return {
              label: text.innerText.replace(/\\s+/g, ' ').trim(),
              lines,
              width: Math.ceil(box.width),
              room: Math.round(room),
              // A collapsed column's heading has no room and is never painted (see above).
              drawn: th.clientWidth > 0
            };
          })())
        `)
      )
    )
  }
  const headSizes = headRows.filter((r) => r !== null && r.drawn)
  const collapsedHeads = headRows.filter((r) => r !== null && !r.drawn).map((r) => r.label)
  check(
    'the table draws its headings',
    headSizes.length > 0 && headSizes.some((r) => /^TOOK/i.test(r.label)),
    JSON.stringify({ drawn: headSizes.map((r) => r.label), collapsed: collapsedHeads })
  )
  check(
    '⛔ every heading is a single line, the sorted one included',
    headSizes.every((r) => r.lines === 1),
    JSON.stringify(headSizes.filter((r) => r.lines !== 1))
  )
  // ⚠️ The measurement itself is the record: every label with what it needs and what it is given,
  // so the next person to widen or rename a column can read the margin off a passing run. A heading
  // named under `collapsed` was not measured, because at this width it is not drawn.
  check(
    '⚠️ and each fits the room its column leaves it, so nothing is painted on a neighbour',
    headSizes.every((r) => r.width <= r.room + 1),
    JSON.stringify({ fit: headSizes.map((r) => [r.label, r.width, r.room]), collapsed: collapsedHeads })
  )

  section('the task table responds to its own width')
  // ⭐ Reported 2026-09-13 at a 1342px window: the resizable sidebar left roughly 960px for the
  // table, but viewport breakpoints still saw 1342px and retained every fixed-width column. Make
  // that mismatch explicit at the suite's ordinary window width; a viewport query cannot pass it.
  const narrowTable = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const root = document.documentElement;
        const previous = root.style.getPropertyValue('--sidebar-w');
        root.style.setProperty('--sidebar-w', '400px');
        const table = document.querySelector('.tbl--tasks');
        const panel = table?.closest('.panel');
        const dates = [...(table?.querySelectorAll('tbody td.tbl-when') ?? [])];
        const heads = [...(table?.querySelectorAll('thead th') ?? [])];
        // ⚠️ Measured by geometry: a collapsed column keeps its cells in the DOM at table-cell. A
        // \`display: none\` <col> left all 14 of these drawn (2026-09-13), which is why \`width > 0\`.
        const visibleHeads = heads.filter((th) => th.getBoundingClientRect().width > 0);
        const collisions = visibleHeads.slice(0, -1).filter((th, i) => {
          const text = th.querySelector('.sort-head') ?? th;
          return text.getBoundingClientRect().right > visibleHeads[i + 1].getBoundingClientRect().left + 1;
        }).length;
        // ⛔ And each drawn heading's text against its own room, the sorted one included: a
        // neighbour-to-neighbour collision misses a column narrowed under the arrow it carries.
        const squeezed = visibleHeads.filter((th) => {
          const text = th.querySelector('.sort-head') ?? th;
          const range = document.createRange();
          range.selectNodeContents(text);
          const style = getComputedStyle(th);
          const room = th.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return range.getBoundingClientRect().width > room + 1;
        }).map((th) => th.textContent.trim());
        const out = {
          viewport: window.innerWidth,
          panel: Math.round(panel?.getBoundingClientRect().width ?? 0),
          dates: dates.length,
          datesVisible: dates.filter((cell) => cell.getBoundingClientRect().width > 0).length,
          title: Math.round(table?.querySelector('.tbl-title-cell')?.getBoundingClientRect().width ?? 0),
          // ⚠️ The table as well as the title: a collapsed column Chromium subtracts from the table
          // leaves the title short by a gap no heading owns, which a title-only check can miss.
          table: Math.round(table?.getBoundingClientRect().width ?? 0),
          heads: visibleHeads.map((th) => [th.textContent.trim(), Math.round(th.getBoundingClientRect().width)]),
          collisions,
          squeezed
        };
        previous
          ? root.style.setProperty('--sidebar-w', previous)
          : root.style.removeProperty('--sidebar-w');
        return out;
      })())
    `)
  )
  // ⚠️ The first half asks the container to differ from the viewport, which a 1024px screen cannot
  // stage: Windows CI clamps the window to one (run 34795442043), and there a viewport query would
  // drop the dates too, so the check would be reading the wrong rule's answer. The display, not the
  // code. The second half — nothing squeezed, the title readable — holds at every width and runs.
  if (narrowTable.viewport > 1050) {
    check(
      '⭐ a narrow task panel drops its date columns even while the viewport remains wide',
      narrowTable.panel <= 1050 && narrowTable.dates > 0 && narrowTable.datesVisible === 0,
      JSON.stringify(narrowTable)
    )
  } else {
    skip(
      '⭐ a narrow task panel drops its date columns even while the viewport remains wide',
      `a ${narrowTable.viewport}px window cannot hold a panel under 1050px beside a viewport over it`
    )
  }
  check(
    'and the remaining headings do not collide while the title keeps readable space',
    narrowTable.collisions === 0 && narrowTable.squeezed.length === 0 && narrowTable.title >= 160 && narrowTable.table >= narrowTable.panel - 1,
    JSON.stringify(narrowTable)
  )

  section('the date columns stay inside their own columns')
  // ⛔ Reported 2026-09-12 against t376: Created and Updated were drawn straight over Status. The
  // columns are sized in pixels under `table-layout: fixed`, so an overflowing stamp does not widen
  // anything — it paints on its neighbour. Two things are measured, because either alone passes on
  // the wrong machine: that nothing overflows *here*, and that the widest stamp a 12-hour locale can
  // produce would still fit, which is the case the pixel width was originally set too narrow for.
  const stamps = JSON.parse(
    await evaluate(`
      JSON.stringify((() => {
        const cells = [...document.querySelectorAll('.tbl--tasks tbody tr td.tbl-when')];
        if (!cells.length) return { cells: 0 };
        // Only what is painted: a collapsed cell is 0px wide with its content laid out past it.
        const drawn = cells.filter(c => c.clientWidth > 0).length;
        const overflowing = cells.filter(c => c.clientWidth > 0 && c.scrollWidth > c.clientWidth + 1).length;
        // The stamp is built from spans so the cell has an honest place to fold; a bare string
        // would break between the minutes and the meridiem.
        const parts = cells.filter(c => c.querySelector('span')).length;
        // Every drawn part must stop short of the Status cell on its own row.
        let collisions = 0;
        for (const row of document.querySelectorAll('.tbl--tasks tbody tr')) {
          const status = row.querySelector('td .status');
          if (!status) continue;
          const edge = status.getBoundingClientRect().left;
          for (const cell of row.querySelectorAll('td.tbl-when')) {
            if (cell.clientWidth === 0) continue;
            for (const span of cell.querySelectorAll('span')) {
              if (span.getBoundingClientRect().right > edge + 1) collisions++;
            }
          }
        }
        // What a 12-hour clock costs, measured in the cell's own font rather than guessed.
        const host = cells.find(c => c.querySelector('span')) ?? cells[0];
        const probe = document.createElement('span');
        probe.style.whiteSpace = 'nowrap';
        probe.textContent = '11:45 PM';
        host.appendChild(probe);
        const widest = probe.getBoundingClientRect().width;
        probe.remove();
        const style = getComputedStyle(host);
        const room = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { cells: cells.length, drawn, overflowing, parts, collisions, widest, room };
      })())
    `)
  )
  check(
    'the stamps are drawn, and each as its own date and time parts',
    stamps.cells > 0 && stamps.parts > 0,
    JSON.stringify(stamps)
  )
  if (stamps.drawn > 0) {
    check(
      '⛔ no date cell overflows its column',
      stamps.overflowing === 0,
      JSON.stringify({ cells: stamps.cells, drawn: stamps.drawn, overflowing: stamps.overflowing })
    )
    check(
      '⛔ and nothing in one reaches the Status cell beside it',
      stamps.collisions === 0,
      JSON.stringify({ collisions: stamps.collisions })
    )
    check(
      '⚠️ the column has room for `11:45 PM`, the widest single line a 12-hour locale draws',
      stamps.room >= stamps.widest,
      JSON.stringify({ room: stamps.room, widest: stamps.widest })
    )
  } else {
    // ⚠️ The display, not the code: the panel is under 1050px with the sidebar at its minimum, so
    // the columns are collapsed by design and there is no drawn cell to measure. Windows CI's 1024px
    // screen is the known case; the fit is measured wherever the screen allows it.
    const why = `a ${wideLayout.viewport}px window leaves the panel ${wideLayout.panel}px with the sidebar at ${wideLayout.sidebar}, under the 1050px the date columns collapse at`
    skip('⛔ no date cell overflows its column', why)
    skip('⛔ and nothing in one reaches the Status cell beside it', why)
    skip('⚠️ the column has room for `11:45 PM`, the widest single line a 12-hour locale draws', why)
  }
  if (widened) {
    await evaluate(
      sidebarBefore
        ? `document.documentElement.style.setProperty('--sidebar-w', ${JSON.stringify(sidebarBefore)})`
        : `document.documentElement.style.removeProperty('--sidebar-w')`
    )
  }

  section('settling a conversation from its thread')
  // ⭐ Reported 2026-09-07 against t280. The thread's own hold reason read *"use Finish, Stop or
  // Commit below"* and there was no Commit below: the conversation's workspace claim had been
  // released when its session closed, `pendingWorkFor` looked only at the claims, and the card hid
  // every settle-it control on *I could not look*. The files were still sitting in ws2 on the
  // task's branch the whole time.
  //
  // ⚠️ Seeded through the store and real git: no RPC releases a claim, and the question is what a
  // worktree has checked out — a stub would pass against the bug.
  const convoProjectId = JSON.parse(
    await evaluate(
      `window.agentyard.rpc('project.list', {}).then(p => JSON.stringify(p.find(x => x.name === 'ui project')?.id ?? null))`
    )
  )
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  gitIn(projectRoot, 'config', 'user.email', 'ui@test.invalid')
  gitIn(projectRoot, 'config', 'user.name', 'ui test')
  writeFileSync(join(projectRoot, 'README.md'), '# ui fixture\n')
  gitIn(projectRoot, 'add', '-A')
  gitIn(projectRoot, 'commit', '-m', 'initial')

  const convoWorkspace = join(dataDir, 'convo-ws1')
  gitIn(projectRoot, 'worktree', 'add', '--detach', convoWorkspace)
  const settleTask = JSON.parse(
    await evaluate(`
      window.agentyard.rpc('task.create', {
        title: 'A conversation with work left in its workspace',
        kind: 'conversation',
        projectId: ${JSON.stringify(convoProjectId)}
      }).then(t => JSON.stringify({ id: t.id, seq: t.seq }))
    `)
  )
  const convoBranch = `warmstart/t${settleTask.seq}-ui-settling`
  gitIn(convoWorkspace, 'switch', '-c', convoBranch)
  gitIn(convoWorkspace, 'config', 'user.email', 'ui@test.invalid')
  gitIn(convoWorkspace, 'config', 'user.name', 'ui test')
  writeFileSync(join(convoWorkspace, 'edited.txt'), 'not committed yet\n')
  {
    const store = new DatabaseSync(join(dataDir, 'warmstart.db'))
    // ⛔ The pool is declared with this worktree in it and **no claim on it** — the state a
    // conversation rests in once its session has ended.
    store
      .prepare(
        `insert into resources (id, project_id, kind, label, capacity, members_json, meta_json)
         values (?, ?, 'counted', 'ui project workspaces', 1, ?, '{}')
         on conflict(id) do update set members_json = excluded.members_json`
      )
      .run(`workspace:${convoProjectId}`, convoProjectId, JSON.stringify([convoWorkspace]))
    store
      .prepare('update tasks set status = ?, assignee = ?, branch = ?, hold_reason = ? where id = ?')
      .run(
        'awaiting_human',
        'human',
        convoBranch,
        // ⚠️ The reason `endConversationTurn` writes, verbatim: the card drops it from its head.
        'your turn',
        settleTask.id
      )
    store.close()
  }

  const openConvoThread = async () => {
    await evaluate(
      `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('ui project'))?.click()`
    )
    await wait(800)
    await evaluate(
      `[...document.querySelectorAll('.tab')].find(b => b.innerText.trim() === 'Tasks')?.click()`
    )
    await wait(800)
    await evaluate(
      `[...document.querySelectorAll('.tbl tbody tr')].find(r => r.innerText.includes('A conversation with work left'))?.click()`
    )
  }
  await openConvoThread()
  // ⚠️ Waits for the control rather than for a fixed pause: `task.pendingWork` runs git, so the row
  // it decides appears a beat after the card does.
  let settleLabels = '[]'
  await waitFor(async () => {
    settleLabels = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.decide .commit-select .split-btn-main')].map(b => b.innerText.trim()))`
    )
    return /Commit|Land/.test(settleLabels)
  }, 'a settle-it control on the conversation thread')
  check(
    'a conversation with uncommitted work offers Commit, even though nothing holds its workspace',
    /Commit/.test(settleLabels),
    settleLabels
  )
  // ⭐ The explanation lives on the button's tooltip now, not beside it.
  const commitTitle = await evaluate(
    `document.querySelector('.decide .commit-select .split-btn-main')?.title ?? ''`
  )
  check(
    'and the Commit tooltip names the branch the files are sitting on',
    commitTitle.includes(convoBranch) && /land_work/.test(commitTitle),
    commitTitle.slice(0, 400)
  )

  // ⭐ The card stopped being a wall of text: one row of actions, the prose on their tooltips, and
  // only the lines that protect work left inline. ⚠️ Both halves asserted non-empty: an empty card
  // has no paragraph either.
  const cardShape = JSON.parse(
    await evaluate(`
      (() => {
        const card = document.querySelector('.decide:not(.decide--quota)');
        const lines = (card?.innerText ?? '').split('\\n').map(l => l.trim()).filter(Boolean);
        return JSON.stringify({
          buttons: [...(card?.querySelectorAll('.decide-actions .btn') ?? [])].map(b => b.innerText.trim()),
          paragraphs: card ? card.querySelectorAll('.decide-what').length : -1,
          longest: lines.reduce((a, l) => (l.length > a.length ? l : a), ''),
          multi: lines.filter(l => (l.match(/[.!?]\\s+[A-Z⚠]/g) ?? []).length >= 1)
        });
      })()
    `)
  )
  check(
    '⛔ the conversation card is one row of actions with no explanatory paragraph',
    cardShape.buttons.length >= 3 &&
      cardShape.buttons.includes('Finish') &&
      cardShape.buttons.includes('Stop') &&
      cardShape.paragraphs === 0 &&
      cardShape.multi.length === 0,
    JSON.stringify(cardShape)
  )
  const headCopy = await evaluate(`document.querySelector('.decide:not(.decide--quota) .decide-head')?.innerText ?? ''`)
  check(
    'and the head says "your call" without repeating "your turn" beside it',
    /your call/i.test(headCopy) && !/your turn/i.test(headCopy),
    JSON.stringify(headCopy)
  )
  // ⛔ Finish over a dirty tree still arms first, and the arming is the one warning kept inline.
  await evaluate(
    `[...document.querySelectorAll('.decide .decide-actions .btn')].find(b => b.innerText.trim() === 'Finish')?.click()`
  )
  await wait(400)
  const armed = JSON.parse(
    await evaluate(`
      JSON.stringify({
        label: [...document.querySelectorAll('.decide .decide-actions .btn')].map(b => b.innerText.trim()).find(t => /^Finish/.test(t)) ?? '',
        warn: [...document.querySelectorAll('.decide .decide-note.decide-warn')].map(n => n.innerText.trim()).join(' | '),
        status: document.querySelector('.detail-side .status')?.innerText.trim() ?? ''
      })
    `)
  )
  check(
    '⛔ Finish over uncommitted files arms with a one-line warning rather than finishing',
    armed.label === 'Finish anyway' &&
      /1 uncommitted file — press again to finish anyway/.test(armed.warn) &&
      /awaiting_human/.test(armed.status),
    JSON.stringify(armed)
  )

  // The other half: commit the work in that same worktree, and the card must offer to land it.
  gitIn(convoWorkspace, 'add', '-A')
  gitIn(convoWorkspace, 'commit', '-m', 'the conversation’s work')
  // ⚠️ Any write to the task re-reads the workspace: the card asks again whenever `updatedAt` moves.
  await evaluate(
    `window.agentyard.rpc('task.setPriority', { id: ${JSON.stringify(settleTask.id)}, priority: 'P1' })`
  )
  let landLabels = '[]'
  await waitFor(async () => {
    landLabels = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.decide .commit-select .split-btn-main')].map(b => b.innerText.trim()))`
    )
    return /Land/.test(landLabels)
  }, 'the Land control once the work is committed')
  check(
    '⛔ committed work with nowhere to go offers Land, which used to have no button at all',
    /Land/.test(landLabels) && !/Commit/.test(landLabels),
    landLabels
  )
  // ------------------------------------------------------------------ the diff at the gate
  // ⛔ **The check this panel exists for.** Before it, the only diff fact this screen had was the
  // boolean `pending.hasDiff`, so a person deciding whether to press Land had to leave the app and
  // run git. ⚠️ Asserted against a *non-empty* file list: an empty `.diff-file` set would pass every
  // "it did not crash" check while showing nobody anything.
  section('the diff a person reads before pressing Land')
  let diffFiles = '[]'
  await waitFor(async () => {
    diffFiles = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.diff-panel .diff-file-path')].map(e => e.textContent.trim()))`
    )
    return JSON.parse(diffFiles).length > 0
  }, 'the diff panel to list the committed file')
  check(
    'the panel lists the file the conversation actually committed',
    JSON.parse(diffFiles).includes('edited.txt'),
    diffFiles
  )
  const diffHead = await evaluate(
    `document.querySelector('.diff-panel .diff-panel-meta')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`
  )
  check(
    'and its header counts the files and the lines, so the size is visible unopened',
    /1 file/.test(diffHead) && /\+1/.test(diffHead),
    diffHead
  )
  // ⭐ Renamed 2026-09-13. *Review the change* is an instruction, and the panel is now drawn on
  // finished tasks too — where there is nothing left to review and the words describe a decision
  // that was already taken.
  // ⚠️ `textContent`, not `innerText`: the title is uppercased by CSS, and `innerText` reports the
  // transformed text — so an assertion on the words as they are written has to read the node.
  const diffTitle = await evaluate(
    `document.querySelector('.diff-panel .diff-panel-title')?.textContent.trim() ?? ''`
  )
  check(
    '⛔ the panel is titled for what it holds, not for a decision that may be over',
    diffTitle === 'Changes in this task',
    diffTitle
  )
  // ⭐ Collapsed by default even at the gate (reported 2026-09-14): it used to spring open on its
  // own the moment a task landed at `awaiting_human`, which read as a surprise rather than a nudge.
  const diffOpenAtGate = await evaluate(`document.querySelector('.diff-panel')?.hasAttribute('open') ?? null`)
  check(
    'the panel stays collapsed at the gate until pressed, even with files to show',
    diffOpenAtGate === false,
    diffOpenAtGate
  )
  // Press a file: since t425 the patch is drawn in the **Diff pane** at the right of the window,
  // fetched one file at a time, on demand — the inline list only names the files.
  // ⚠️ No longer opens itself; open it explicitly before pressing a file inside it.
  await evaluate(`document.querySelector('.diff-panel')?.setAttribute('open', '')`)
  await wait(200)
  await evaluate(
    `[...document.querySelectorAll('.diff-panel .diff-file-head')].find(b => b.textContent.includes('edited.txt'))?.click()`
  )
  let diffPatch = '{}'
  await waitFor(async () => {
    diffPatch = await evaluate(`JSON.stringify({
      lines: [...document.querySelectorAll('.diffpane .diff-patch .diff-line')].length,
      added: [...document.querySelectorAll('.diffpane .diff-line--add')].map(e => e.textContent.trim()),
      meta: [...document.querySelectorAll('.diffpane .diff-line--meta')].map(e => e.textContent.trim()),
      html: document.querySelector('.diffpane .diff-patch')?.innerHTML ?? ''
    })`)
    return JSON.parse(diffPatch).lines > 0
  }, 'the patch text for the pressed file, in the Diff pane')
  const diffShown = JSON.parse(diffPatch)
  check(
    'pressing a file opens the Diff pane on its added line, which is the content that will land',
    diffShown.added.some((l) => l.includes('not committed yet')),
    JSON.stringify(diffShown.added)
  )
  // ⛔ `+++ b/edited.txt` starts with the add character without being an addition. A version that
  // checked `+` before `+++` paints two header lines green and red at the top of every file.
  check(
    '⛔ the `+++` and `---` headers are drawn as metadata, not as an add and a delete',
    diffShown.meta.some((l) => l.startsWith('+++')) && diffShown.meta.some((l) => l.startsWith('---')),
    JSON.stringify(diffShown.meta)
  )
  // ⛔ The untrusted-text invariant, checked on the rendered DOM rather than on the source. Every
  // line is a `<span>` this codebase wrote around a text node; nothing in a patch may become markup.
  // ⚠️ The boundary is an explicit "followed by a non-letter" class rather than a
  // backslash-b: a backslash-b in this literal was silently turned into a backspace byte by a
  // shell heredoc once already, and the broken form matched its own correct output. A check
  // that fails green is worse than no check.
  const strayTag = /<(?!\/?(?:span|pre)[^a-z])[a-z]/i.exec(diffShown.html)
  check(
    '⛔ the patch is drawn as text nodes only — no tags a patch could have introduced',
    strayTag === null && diffShown.lines > 0,
    JSON.stringify({
      lines: diffShown.lines,
      // The *offending* text, not the first 160 characters: a truncated passing prefix says
      // nothing about why this failed.
      stray: strayTag
        ? diffShown.html.slice(Math.max(0, strayTag.index - 40), strayTag.index + 40)
        : null
    })
  )

  // ⭐ Two layouts, asked for 2026-09-13: the unified patch above, and the old and new side by side.
  // ⛔ The two-column view is a `<table>` of cells this codebase writes — the untrusted-text rule is
  // the same one, and it is checked the same way, on the rendered DOM.
  await evaluate(
    `[...document.querySelectorAll('.diff-view-toggle button')].find(b => /Side by side/i.test(b.innerText))?.click()`
  )
  await wait(300)
  const splitShown = JSON.parse(
    await evaluate(`JSON.stringify({
      unified: document.querySelectorAll('.diffpane .diff-patch').length,
      rows: [...document.querySelectorAll('.diffpane .diff-split-row')].length,
      cells: [...document.querySelectorAll('.diffpane .diff-split-row')].map(r => r.children.length),
      added: [...document.querySelectorAll('.diffpane .diff-split-cell--add .diff-split-text')].map(e => e.textContent),
      numbered: [...document.querySelectorAll('.diffpane .diff-split-no')].map(e => e.textContent).filter(Boolean).length,
      html: document.querySelector('.diffpane .diff-split-wrap')?.innerHTML ?? ''
    })`)
  )
  check(
    'switching to side by side draws the patch as two columns',
    splitShown.rows > 0 && splitShown.cells.every((n) => n === 2) && splitShown.unified === 0,
    JSON.stringify({ rows: splitShown.rows, cells: splitShown.cells, unified: splitShown.unified })
  )
  check(
    'the added line is on its own side, and both sides carry line numbers',
    splitShown.added.some((l) => l.includes('not committed yet')) && splitShown.numbered > 0,
    JSON.stringify({ added: splitShown.added, numbered: splitShown.numbered })
  )
  const straySplitTag = /<(?!\/?(?:span|pre|table|tbody|tr|td|div)[^a-z])[a-z]/i.exec(splitShown.html)
  check(
    '⛔ the two-column view is text nodes in cells — no tags a patch could have introduced',
    straySplitTag === null,
    JSON.stringify({
      stray: straySplitTag
        ? splitShown.html.slice(Math.max(0, straySplitTag.index - 40), straySplitTag.index + 40)
        : null
    })
  )
  // ⚠️ And back, because the choice is remembered: leaving it on `split` would change what every
  // later section of this suite reads.
  await evaluate(
    `[...document.querySelectorAll('.diff-view-toggle button')].find(b => /Single column/i.test(b.innerText))?.click()`
  )
  await wait(300)
  const backToUnified = await evaluate(
    `document.querySelectorAll('.diffpane .diff-patch').length`
  )
  check('and back to one column, which is the layout it opens in', Number(backToUnified) === 1, String(backToUnified))
  // ⚠️ Closed again, so the commit section below starts from no pane, as it asserts.
  await evaluate(`document.querySelector('.diffpane-close')?.click()`)
  await wait(200)

  // ⭐ t283: the card says which landing strategy the button will use, and it is the project's
  // answer rather than the bottom rung of the ladder. `ui project` inherits the fleet default.
  const landTitle = await evaluate(
    `[...document.querySelectorAll('.decide .commit-select .split-btn-main')].pop()?.title ?? ''`
  )
  check(
    'and its tooltip names the landing strategy it will use, taken from the project or the fleet',
    /commit, verify and merge into main/i.test(landTitle) && /fleet default|project/i.test(landTitle),
    landTitle.slice(0, 600)
  )
  // ⚠️ The arming from the Finish press above must not outlive the files it warned about: the tree
  // is clean now, so the button is an ordinary Finish again.
  const finishAfterCommit = await evaluate(
    `[...document.querySelectorAll('.decide .decide-actions .btn')].map(b => b.innerText.trim()).find(t => /^Finish/.test(t)) ?? ''`
  )
  check(
    'and once the tree is clean the Finish arming is gone again',
    finishAfterCommit === 'Finish',
    finishAfterCommit
  )
  // ⚠️ Opened, then read on a later turn: the menu is React state, so a query in the same
  // evaluate as the click reads the DOM one render too early and finds nothing.
  await evaluate(
    `[...document.querySelectorAll('.decide .commit-select')].pop()?.querySelector('.split-btn-more .pill')?.click()`
  )
  await wait(500)
  const landRungs = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.pill-menu [role=option]')].map(o => o.innerText.trim()))`
    )
  )
  check(
    'and its ▼ offers only the rungs the tool itself acts on',
    landRungs.some((o) => /merge into main/i.test(o)) &&
      !landRungs.some((o) => /^Commit — commit only/i.test(o)),
    JSON.stringify(landRungs)
  )
  // ⚠️ The tick is on the rung the button would use, so opening the menu confirms the default
  // rather than presenting a list with nothing chosen — which is what t283 was reported for.
  const landTicked = await evaluate(
    `document.querySelector('.pill-menu [role=option][aria-selected=true]')?.innerText.trim() ?? ''`
  )
  check(
    'and the rung it would use is the one already ticked',
    /merge into main/i.test(landTicked),
    landTicked
  )
  // ⚠️ Closed again, so the portal menu is not left over the next section's clicks.
  await evaluate(`document.body.click()`)
  await wait(300)

  // ------------------------------------------------------------- one commit's own diff, afterwards
  // ⭐ Asked for 2026-09-13: *make each git commit have a link to show the diff, and show total + and
  // − lines as a summary for each commit.* ⛔ Driven by **actually landing** this conversation rather
  // than by seeding a row, because the thing under test is the whole path — a real merge into the
  // seeded repo, the commit row the landing records, and `task.commitDiff` reading `<sha>^!` back out
  // of git afterwards. A fixture would have proved only that the component renders.
  section('the diff of one commit a task landed')
  // ⛔ **A landing will not merge a project that proves nothing.** `commit-and-merge` refuses where
  // no check commands are configured — correctly, and it is the fixture's job to give it one rather
  // than the test's job to pick a rung that skips the proof. One trivial command, which is enough for
  // the verify step to have actually run something.
  await evaluate(`
    window.agentyard.rpc('project.setChecks', {
      id: ${JSON.stringify(convoProjectId)},
      checks: ['node --version']
    })
  `)
  // ⚠️ And committed in the trunk, because `setChecks` writes `.warmstart/project.json` there — and
  // a landing refuses a dirty trunk, which is the guard working rather than something to route around.
  gitIn(projectRoot, 'add', '-A')
  gitIn(projectRoot, 'commit', '-m', 'declare the project checks')
  // ⚠️ The tool's own answer is read rather than assumed: a landing that refused says so, and a
  // suite that only waited for a row would report the refusal as a missing panel.
  const landOutcome = await evaluate(`
    (async () => {
      try {
        // ⛔ task.landConversation, which is what the card's own Land button calls. task.land is
        // the scheduler's re-landing of a *task* and refuses a conversation waiting on a person —
        // a real distinction, and calling the wrong one here tested nothing at all.
        const r = await window.agentyard.rpc('task.landConversation', {
          id: ${JSON.stringify(settleTask.id)},
          finishPolicy: 'commit-and-merge'
        });
        return JSON.stringify({ landed: r.ok, reason: r.reason ?? null });
      } catch (e) {
        return JSON.stringify({ threw: String(e && e.message ? e.message : e) });
      }
    })()
  `)
  check(
    'the landing this section needs actually landed',
    /"landed":\s*true/.test(landOutcome),
    String(landOutcome).slice(0, 600)
  )
  let commitRows = '[]'
  await waitFor(async () => {
    commitRows = await evaluate(`
      JSON.stringify([...document.querySelectorAll('.detail-side-box .side-commit-link')].map(b => ({
        sha: b.textContent.replace(/[^0-9a-f]/gi, ''),
        counts: b.parentElement?.querySelector('.diff-counts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''
      })))
    `)
    const rows = JSON.parse(commitRows)
    // ⚠️ Both, and in this order: the row is rendered from the record the landing wrote, and its
    // totals arrive one `git` call later. Reading the counts the instant the row appears is a race,
    // and it lost — which is worth a sentence here, because the eager read is the feature.
    return rows.length > 0 && rows[0].counts !== ''
  }, 'the landed commit to appear in the ledger, with the totals its own read fills in')
  const landedRows = JSON.parse(commitRows)
  check(
    'the commit the landing recorded is a link, with its own line totals beside it',
    landedRows.length > 0 && /^[0-9a-f]{8}$/.test(landedRows[0].sha) && /\+/.test(landedRows[0].counts),
    commitRows
  )
  // ⭐ t425, 2026-09-13: *the side pane's width is too small for a diff.* The sha no longer unfolds
  // a patch in the 300px ledger; it opens the **Diff pane**, a column of the shell at the right of
  // the window. ⚠️ Read on the press, not on render: the totals are one `git` call per row and
  // each patch another per file, so a row nobody opened must not have read one.
  const noPaneYet = await evaluate(`document.querySelectorAll('.diffpane').length`)
  check('no Diff pane is open before anything is pressed', noPaneYet === 0, String(noPaneYet))
  await evaluate(`document.querySelector('.detail-side-box .side-commit-link')?.click()`)
  let paneState = '{}'
  await waitFor(async () => {
    paneState = await evaluate(`JSON.stringify({
      shell: document.querySelector('.shell')?.classList.contains('shell--diffpane') ?? false,
      title: document.querySelector('.diffpane-title')?.innerText.trim() ?? '',
      files: [...document.querySelectorAll('.diffpane .diffpane-file .diff-file-path')].map(e => e.textContent.trim()),
      toggle: [...document.querySelectorAll('.diffpane-tools .diff-view-toggle button')].map(b => b.innerText.trim()),
      // ⛔ The budget opens a small change by itself: the patch is on the screen with no second press.
      added: [...document.querySelectorAll('.diffpane .diff-line--add')].map(e => e.textContent.trim()),
      html: document.querySelector('.diffpane .diff-patch')?.innerHTML ?? '',
      paneW: document.querySelector('.diffpane')?.getBoundingClientRect().width ?? 0,
      mainRight: document.querySelector('.main')?.getBoundingClientRect().right ?? 0,
      windowW: window.innerWidth,
      pressed: document.querySelector('.detail-side-box .side-commit-link')?.getAttribute('aria-pressed') ?? ''
    })`)
    return JSON.parse(paneState).added.length > 0
  }, 'the Diff pane to open on the landed commit, with its first file already expanded')
  const pane = JSON.parse(paneState)
  check(
    'pressing the sha opens the Diff pane on that commit, with both layouts offered',
    pane.shell && /^t\d+ · [0-9a-f]{8}/.test(pane.title) && pane.files.includes('edited.txt') && pane.toggle.length === 2,
    paneState.slice(0, 400)
  )
  check(
    '⛔ the pane is a column of the shell, not a box inside the ledger: the work narrows to make room',
    pane.paneW >= 360 && pane.mainRight <= pane.windowW - pane.paneW,
    JSON.stringify({ paneW: pane.paneW, mainRight: pane.mainRight, windowW: pane.windowW })
  )
  const strayCommitTag = /<(?!\/?(?:span|pre)[^a-z])[a-z]/i.exec(pane.html)
  check(
    'and the patch it shows is that commit’s own, as text nodes only',
    pane.added.some((l) => l.includes('not committed yet')) && strayCommitTag === null,
    JSON.stringify({ added: pane.added.slice(0, 3), stray: strayCommitTag?.[0] ?? null })
  )
  check('the row that opened it says so', pane.pressed === 'true', pane.pressed)
  // The inline list at the gate still names every file; pressing one opens the pane on the
  // *branch*, focused on that file, and replaces what the pane was showing.
  await evaluate(
    `[...document.querySelectorAll('.diff-panel .diff-file-head')].find(b => b.textContent.includes('edited.txt'))?.click()`
  )
  let branchPane = '{}'
  await waitFor(async () => {
    branchPane = await evaluate(`JSON.stringify({
      title: document.querySelector('.diffpane-title')?.innerText.trim() ?? '',
      focused: document.querySelector('.diffpane-file--focused .diff-file-path')?.textContent.trim() ?? '',
      open: document.querySelector('.diffpane-file--focused .diffpane-file-head')?.getAttribute('aria-expanded') ?? ''
    })`)
    const got = JSON.parse(branchPane)
    return /Changes in this task/.test(got.title) && got.focused !== ''
  }, 'the Diff pane to switch to the branch when a file of the inline list is pressed')
  const onBranch = JSON.parse(branchPane)
  check(
    'a file in the inline list opens the pane on the branch, at that file, expanded',
    onBranch.focused === 'edited.txt' && onBranch.open === 'true',
    branchPane
  )
  await evaluate(`document.querySelector('.diffpane-close')?.click()`)
  await wait(300)
  const afterClose = await evaluate(`JSON.stringify({
    panes: document.querySelectorAll('.diffpane').length,
    shell: document.querySelector('.shell')?.classList.contains('shell--diffpane') ?? false,
    handles: document.querySelectorAll('.resizer--diffpane').length
  })`)
  check(
    'the close button takes the pane and its handle out of the grid',
    afterClose === JSON.stringify({ panes: 0, shell: false, handles: 0 }),
    afterClose
  )
  // ⛔ **The other half of the report, and it needs the task actually settled.** Landing a
  // conversation deliberately leaves it open for another turn, so the panel is still at its gate
  // here. So: finish it, then look again.
  await evaluate(
    `window.agentyard.rpc('task.resolve', { id: ${JSON.stringify(settleTask.id)} })`
  )
  let afterSettled = { panels: 0 }
  await waitFor(async () => {
    const got = await evaluate(`
      (async () => {
        const t = await window.agentyard.rpc('task.get', { id: ${JSON.stringify(settleTask.id)} });
        const panel = document.querySelector('.diff-panel');
        return JSON.stringify({
          status: t.task.status,
          panels: document.querySelectorAll('.diff-panel').length,
          title: panel?.querySelector('.diff-panel-title')?.textContent.trim() ?? '',
          open: panel?.hasAttribute('open') ?? false,
          files: [...document.querySelectorAll('.diff-panel .diff-panel-body .diff-file-path')].length
        });
      })()
    `)
    afterSettled = JSON.parse(got)
    return afterSettled.status === 'completed'
  }, 'the conversation to settle as completed')
  check(
    '⛔ the change is still on the screen after the task has finished',
    afterSettled.panels === 1 && afterSettled.title === 'Changes in this task' && afterSettled.files > 0,
    JSON.stringify(afterSettled)
  )
  check(
    '⚠️ open state is the person\'s own, not the task\'s: it stays as they left it across the settle',
    afterSettled.open === true,
    JSON.stringify(afterSettled)
  )
  // ⛔ The pane follows the route. Back to the Tasks tab keeps the open task on the route — that is
  // the tab rule, *the open task survives a tab change* — so the pane stays; leaving for Overview
  // names no task, and the pane closes by itself rather than standing beside a screen it is not
  // about.
  await evaluate(`document.querySelector('.detail-side-box .side-commit-link')?.click()`)
  await waitFor(
    async () => (await evaluate(`document.querySelectorAll('.diffpane').length`)) === 1,
    'the Diff pane to open again on the settled task'
  )
  await evaluate(`document.querySelector('.back-to-list')?.click()`)
  await wait(300)
  const afterBack = await evaluate(`JSON.stringify({
    panes: document.querySelectorAll('.diffpane').length,
    onThread: document.querySelectorAll('.detail').length
  })`)
  check(
    'Back to the Tasks tab keeps the pane, because the route still names the task',
    afterBack === JSON.stringify({ panes: 1, onThread: 0 }),
    afterBack
  )
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Dashboard')?.click()`
  )
  await wait(300)
  const afterLeave = await evaluate(`document.querySelectorAll('.diffpane').length`)
  check('and leaving the task closes the Diff pane with it', afterLeave === 0, String(afterLeave))

  const errors = await evaluate('window.__agentyardErrors?.length ?? 0')
  check('no uncaught renderer errors', errors === 0)
} catch (err) {
  check('the suite ran to completion', false, err instanceof Error ? err.stack : String(err))
} finally {
  socket?.close()
  // ⛔ By pid, and the whole tree: Electron's renderer and GPU children outlive a plain kill and one
  // of them keeps the debugging port, which fails the *next* run for no reason anyone can see.
  // Verified before it fires - see killTree. The dev build runs from node_modules/electron.
  killTree(app?.pid, 'electron')
  await wait(500)
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (wizardRoot) rmSync(wizardRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (wizardRoot) rmSync(`${wizardRoot}_workspaces`, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A locked profile directory is not worth failing a passing test over.
  }
}

budget.clear()
process.exit(summary('ui') === 0 ? 0 : 1)

async function waitForPage(appOutput = []) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    await wait(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // Not listening yet.
    }
  }
  throw new Error(
    `the app did not expose a debugging target within 45s; it said: ${
      appOutput.join('').trim().slice(-1500) || '(nothing)'
    }`
  )
}

/** Poll until `fn` is truthy, and answer whether it ever was. ⛔ For a check: never throws. */
async function until(fn, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await wait(500)
  }
  return false
}

async function waitFor(fn, what) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await fn()) return
    await wait(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

void writeFileSync
