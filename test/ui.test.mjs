import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// ⚠️ Runs in about two minutes on this machine; ten is the ceiling, not the expectation.
const budget = startDeadline(10 * 60 * 1000, 'ui', () => killTree(app?.pid, 'electron'))
let socket = null

try {
  // ⛔ **Driven, not displayed.** The window is created and the renderer runs in full — that is what
  // this suite reads back — but it is never shown, so a suite that takes two minutes does not throw
  // a window over the operator's work and steal the focus on the machine it is running on.
  const env = {
    ...process.env,
    MULTI_AGENT_CONTROLLER_DATA_DIR: dataDir,
    MULTI_AGENT_CONTROLLER_HEADLESS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(electronBinary(), [REPO, `--remote-debugging-port=${PORT}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  // ⚠️ Always kept, printed only when something goes wrong. This was verbose-only, so when the app
  // failed to open a debugging target on Linux the suite could say nothing beyond "it did not".
  const appOutput = []
  const record = (d) => {
    appOutput.push(String(d))
    if (process.env.MULTI_AGENT_CONTROLLER_TEST_VERBOSE) process.stderr.write(`[app] ${d}`)
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
        : `MainWindowHandle ${handle} (title: "${title}"): a real window is on screen, so MULTI_AGENT_CONTROLLER_HEADLESS is not being honoured`
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
    ['Dashboard', 'Controller', 'Routing Model', 'Statistics', 'Conversations', 'Logs', 'Workers', 'Global'].every((label) =>
      nav.some((n) => n.startsWith(label))
    ),
    nav.join(' | ')
  )
  check(
    'a project with no projects yet says so rather than showing an empty group',
    nav.some((n) => n.startsWith('No projects yet')),
    nav.join(' | ')
  )

  // ⛔ One row, with nav controls and zoom controls.
  const brand = await evaluate(`
    JSON.stringify((() => {
      const b = document.querySelector('.brand');
      const nav = b?.querySelector('.brand-nav');
      const zoom = b?.querySelector('.brand-zoom');
      if (!b || !nav || !zoom) return { missing: true };
      const br = b.getBoundingClientRect(), zr = zoom.getBoundingClientRect();
      return {
        navButtons: nav.querySelectorAll('button').length,
        zoomButtons: zoom.querySelectorAll('button').length,
        hasTitle: !!b.querySelector('h1'),
        overflows: zr.right > br.right + 1
      };
    })())
  `)
  const b = JSON.parse(brand)
  check('the navigation bar carries back, forward and refresh', b.navButtons === 3, brand)
  check('the zoom bar carries zoom in and zoom out controls', b.zoomButtons >= 2, brand)
  check('the app title is removed from the sidebar toolbar', b.hasTitle === false, brand)
  check('nothing overflows the sidebar', b.overflows === false, brand)

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
      (await evaluate(`window.localStorage.getItem('multi_agent_controller.taskViews')`)) ?? '[]'
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

  // ⛔ On every message. A thread with no clock cannot say whether the agent replied to something or
  // was already saying it — and on a task that ran across two days it cannot even say which day.
  check(
    'every message says when it was said',
    await evaluate(`(() => {
      const msgs = [...document.querySelectorAll('.thread--task .msg')].filter(m => !m.classList.contains('msg--live'));
      // ⛔ length > 0 is half the assertion. Without it this passes on a thread with no messages,
      // which is exactly how it was first written and exactly what it did.
      return msgs.length > 0 && msgs.every(m => (m.querySelector('.msg-when')?.innerText ?? '').trim().length > 0);
    })()`)
  )


  // ⛔ Measured, not eyeballed. The Send button used to be painted on top of the box somebody was
  // typing into, because an unlabelled row borrowed a three-column grid built for labelled forms.
  const compose = await evaluate(`
    JSON.stringify((() => {
      const row = document.querySelector('.compose-row');
      const input = row?.querySelector('input, textarea');
      const button = row?.querySelector('button');
      if (!row || !input || !button) return { missing: true };
      const i = input.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { overlap: Math.round(i.right - b.left), inputWidth: Math.round(i.width) };
    })())
  `)
  const c = JSON.parse(compose)
  check('the Send button does not sit on top of the message box', c.overlap <= 0, compose)
  check('and the message box gets the room', c.inputWidth > 200, compose)

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
        // The order of the row, left to right: what you type in, then Stop, then Send.
        ordered: !!(stop && send && input)
          && input.getBoundingClientRect().right <= stop.getBoundingClientRect().left + 1
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
      return {
        pills,
        textarea: !!composer.querySelector('textarea.ask-input'),
        promptIsFirst:
          !!ask && !!bar && ask.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1,
        // The three things the old form did that this one must not: labelled rows, native pickers,
        // and the word "inherited" written out on every control that has a default.
        legacyRows: composer.querySelectorAll('.form-row').length,
        selects: composer.querySelectorAll('select').length,
        saysInherited: (bar?.innerText ?? '').toLowerCase().includes('inherit'),
        sendsInsideTheBox: !!ask?.querySelector('.composer-send'),
        clock: !!ask?.querySelector('.pill--clock button'),
        buttons: [...(ask?.querySelectorAll('.composer-send button') ?? [])].map(b => b.innerText.trim())
      };
    })())
  `)
  const f = JSON.parse(filing)
  const pillNames = (f.pills ?? []).map((p) => p.name)
  check('the prompt is the first thing in the composer', f.promptIsFirst === true, filing)
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
  check(
    'draft, send and the scheduled send sit together inside the box',
    f.sendsInsideTheBox === true && f.clock === true && f.buttons?.includes('Send'),
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
        sendLabel: ([...composer.querySelectorAll('.composer-send button')]
          .find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim()
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
          .find(b => b.classList.contains('btn--primary'))?.innerText ?? '').trim()
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
    '⚠️ while keeping everything a conversation still chooses — account, model, priority, project',
    ['Worker', 'Model', 'Priority'].every((n) => convo.names?.includes(n)),
    chat
  )
  check('the send button says Start rather than Send', convo.sendLabel === 'Start', chat)

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

  // ⛔ Disabled, not absent. A model list belongs to one CLI, so until an account is pinned there is
  // genuinely nothing to draw — and a pill that vanished would take the row's shape with it every
  // time somebody moved back to Auto.
  check(
    'no model can be chosen until an account is pinned',
    (f.pills ?? []).find((p) => p.name === 'Model')?.disabled === true,
    filing
  )

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
  const modelValues = (await menuValues('Model')).filter(Boolean)
  check(
    'pinning an account offers the models its cost model can price',
    modelValues.length > 0,
    JSON.stringify(modelValues)
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
  await evaluate(
    `[...document.querySelectorAll('.panel-head button')].find(b => b.innerText.trim() === 'Cancel')?.click()`
  )
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

  await evaluate(
    `[...document.querySelectorAll('.panel-head button')].find(b => b.innerText.trim() === 'Cancel')?.click()`
  )
  await wait(500)

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
    'it says how much finished work has no grade, and offers to grade some',
    /ungraded/i.test(qualityPanel) && /Grade up to 5/.test(qualityPanel),
    'the count without the button is a complaint; the button without the count is a gamble'
  )
  check(
    'it says the button spends real turns',
    /spends one real turn/i.test(qualityPanel),
    'a button that costs money has to say so before it is pressed'
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
    (await evaluate(`window.localStorage.getItem('multi_agent_controller.sidebarWidth')`)) ===
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
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
    const at = Date.now() - 20 * 3600 * 1000
    for (const [id, pct] of [['session', 11], ['weekly', 16]]) {
      store
        .prepare(
          `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
           values (?,?,?,?,?,?,?)`
        )
        .run(staleWorker, id, id, pct, at + 7_200_000, 'config cache', at)
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

  // ⛔ A suspect worker without quota windows shows `error · see Settings > Workers` and suppresses `quota unknown`
  const suspectWorkerId = await evaluate(
    `window.agentyard.rpc('worker.create', { adapterId: 'claude-code', label: 'suspect worker', enabled: true }).then(w => w.id)`
  )
  {
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
    const health = JSON.stringify({
      state: 'suspect',
      reason: 'subscription expired',
      strikes: 1,
      since: Date.now(),
      runId: null,
      needsReauth: false
    })
    store.prepare('update workers set health_json = ? where id = ?').run(health, suspectWorkerId)
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
  await evaluate(`${densityBtn}?.click()`)
  await wait(300)

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
    (await evaluate(`window.localStorage.getItem('multi_agent_controller.fleetCollapsed')`)) === 'true'
  )

  await evaluate(`${toggleBtn}?.click()`)
  await wait(600)
  const isExpanded = await evaluate(
    `!document.querySelector('.fleet-wrap--collapsed') && getComputedStyle(document.querySelector('.fleet')).display !== 'none'`
  )
  check('clicking again expands the fleet strip', isExpanded === true)
  check(
    'and the expanded state is persisted',
    (await evaluate(`window.localStorage.getItem('multi_agent_controller.fleetCollapsed')`)) === 'false'
  )

  section('finishing work')
  // ⛔ Three tiers resolve into one answer, and the failure this guards is the answer disappearing
  // from the one place a person can change it. The daemon-side resolution is held by
  // finish.test.ts; these checks are that the controls exist and reach the daemon.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Global')?.click()`
  )
  await wait(1500)
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
  // ⛔ Sharing is an information boundary, so the check that matters most is the *default*: an
  // install that upgrades into this build must not start sharing because it upgraded. The tier
  // resolution itself is held by sharing.test.ts; these are that the controls exist, reach the
  // daemon, and ship off.
  const sharePicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Fleet session sharing')`
  check('the fleet tier has a sharing control', (await evaluate(`!!(${sharePicker})`)) === true)
  check(
    'which ships OFF, so upgrading never widens who sees whose work',
    (await evaluate(`${sharePicker}?.value`)) === 'off'
  )
  check(
    'and the daemon agrees, which is the opinion that gates dispatch',
    (await evaluate(`window.agentyard.rpc('settings.get', {}).then(s => s.sessionSharing)`)) === 'off'
  )
  await evaluate(`
    (() => {
      const s = ${sharePicker};
      s.value = 'on';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `)
  await wait(1200)
  check(
    'turning it on reaches the daemon',
    (await evaluate(
      `window.agentyard.rpc('settings.get', {}).then(s => s.sessionSharing)`
    )) === 'on'
  )
  // ⚠️ Put back, so the rest of the suite runs against the shipped default.
  await evaluate(`window.agentyard.rpc('settings.set', { sessionSharing: 'off' })`)

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
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
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

  // ⛔ Ten headers, ten <col>s. Nine of them summed to 100%, so the actions column was allotted no
  // width at all and its buttons stacked one per line inside a cell as wide as one button.
  const colCount = await evaluate(
    `JSON.stringify([
       document.querySelectorAll('.tbl-workers colgroup col').length,
       document.querySelectorAll('.tbl-workers thead th').length
     ])`
  )
  check('the workers card fields describe every setting the header declares', colCount === '[12,12]', colCount)

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
    check('which spans the card rather than sitting in one field', seen.span === 12, String(seen.span))
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
  const routableBtn = `document.querySelector('.tbl tbody tr td:nth-child(9) .pill')`
  const routableBtnTag = await evaluate(`${routableBtn}?.tagName`)
  check(
    'a routable-models control sits beside the default model',
    routableBtnTag === 'BUTTON',
    `tagName: ${routableBtnTag}`
  )
  const routableEmptyLabel = await evaluate(`${routableBtn}?.textContent.trim()`)
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
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
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
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
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
    const store = new DatabaseSync(join(dataDir, 'multi_agent_controller.db'))
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
      readFileSync(join(projectRoot, '.multi_agent_controller', 'project.json'), 'utf8')
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

  section('global settings')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Global')).click()`
  )
  await wait(800)
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

  section('what the thread ledger says a task cost')
  // ⭐ The right pane's two money-adjacent rows, read back from the built app. Price and tokens are
  // two measurements docs/cost-model.md §5 never reconciles, and they were drawn as one number with
  // a caption under it — which reads as the token count *explaining* the price. Two labelled rows,
  // and the unit lives in the label so the value stays a number.
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
