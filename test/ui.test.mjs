import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// ⚠️ Runs in about two minutes on this machine; ten is the ceiling, not the expectation.
const budget = startDeadline(10 * 60 * 1000, 'ui', () => killTree(app?.pid, 'electron'))
let socket = null

try {
  const env = { ...process.env, MULTI_AGENT_CONTROLLER_DATA_DIR: dataDir }
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
  const nav = await evaluate('[...document.querySelectorAll(".nav-item")].map(b => b.innerText.trim())')
  // ⛔ Named, not counted. The sidebar is now Overview (Dashboard, Controller) / one item per project / History (Conversations, Logs) / Settings (Workers, Global), so a count
  // says nothing: it moves whenever a project is added, and it passed all the way through the
  // rewrite that removed Cost and Controller as destinations.
  check(
    'the fixed destinations are reachable',
    ['Dashboard', 'Controller', 'Conversations', 'Logs', 'Workers', 'Global'].every((label) =>
      nav.some((n) => n.startsWith(label))
    ),
    nav.join(' | ')
  )
  check(
    'a project with no projects yet says so rather than showing an empty group',
    nav.some((n) => n.startsWith('No projects yet')),
    nav.join(' | ')
  )

  // ⛔ One row, which is the whole requirement. Measured, not eyeballed: a wrapped title would make
  // the brand block taller than a single line of its own font and push the controls down.
  const brand = await evaluate(`
    JSON.stringify((() => {
      const b = document.querySelector('.brand');
      const h = b?.querySelector('h1');
      const nav = b?.querySelector('.brand-nav');
      if (!b || !h || !nav) return { missing: true };
      const br = b.getBoundingClientRect(), hr = h.getBoundingClientRect(), nr = nav.getBoundingClientRect();
      return {
        buttons: nav.querySelectorAll('button').length,
        titleLines: Math.round(hr.height / parseFloat(getComputedStyle(h).lineHeight || '20')),
        sameRow: Math.abs((hr.top + hr.height / 2) - (nr.top + nr.height / 2)) < 6,
        overflows: nav.getBoundingClientRect().right > br.right + 1
      };
    })())
  `)
  const b = JSON.parse(brand)
  check('the title bar carries back, forward and refresh', b.buttons === 3, brand)
  check('they sit on the same row as the app name', b.sameRow === true, brand)
  check('the app name still fits on one line', b.titleLines <= 1, brand)
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
  await wait(900)
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
  // filed the task were the one being waited on. They are not: it is queued, and this says so.
  check(
    'a queued task shows that it is queued, not that it is finished',
    await evaluate(
      `[...document.querySelectorAll('.tbl tbody tr')].some(
         r => /ready|dispatching|running/i.test(r.innerText) && r.querySelector('.working'))`
    ),
    'the dots are the only thing separating "waiting for the fleet" from "waiting for you"'
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
      const input = row?.querySelector('input');
      const button = row?.querySelector('button');
      if (!row || !input || !button) return { missing: true };
      const i = input.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { overlap: Math.round(i.right - b.left), inputWidth: Math.round(i.width) };
    })())
  `)
  const c = JSON.parse(compose)
  check('the Send button does not sit on top of the message box', c.overlap <= 0, compose)
  check('and the message box gets the room', c.inputWidth > 200, compose)

  // ⛔ Back before anything else is checked. Everything below files a task, and the form lives on
  // the list — so a Back button that did not actually return would fail here as a missing button
  // rather than as the navigation bug it is. Assert the return itself.
  await evaluate(`document.querySelector('.back-to-list')?.click()`)
  await wait(600)
  check(
    'and going back returns to the table it came from',
    await evaluate('!!document.querySelector(".tbl tbody")')
  )

  // ---- filing a task ------------------------------------------------------------------
  // ⛔ Order is the assertion. The prompt is the one field a person came here to fill in, and it used
  // to be first — met before anything had been decided, with three settings rows underneath it that
  // read as an afterthought bolted to a message already written. Settings narrow what the task is;
  // the prompt says what it is for, and it goes last.
  await evaluate(
    `[...document.querySelectorAll('.panel-head button')].find(b => b.innerText.trim() === 'New task')?.click()`
  )
  await wait(800)
  const filing = await evaluate(`
    JSON.stringify((() => {
      const form = document.querySelector('.form');
      if (!form) return { missing: true };
      const labels = [...form.querySelectorAll('.form-row > label')].map(l => l.innerText.trim());
      const ask = form.querySelector('.ask');
      const rows = [...form.querySelectorAll('.form-row')];
      const lastRow = rows.at(-1)?.getBoundingClientRect().bottom ?? 0;
      return {
        labels,
        textarea: !!form.querySelector('textarea.ask-input'),
        promptIsLast: !!ask && ask.getBoundingClientRect().top >= lastRow - 1,
        modelText: rows.find(r => /^model/i.test(r.querySelector('label')?.innerText ?? ''))?.innerText ?? '',
        modelPickers: rows
          .find(r => /^model/i.test(r.querySelector('label')?.innerText ?? ''))
          ?.querySelectorAll('select').length ?? 0,
        finishOptions: [...(form.querySelector('select[aria-label="Finish policy"]')?.options ?? [])]
          .map(o => o.value),
        finishInheritText: form.querySelector('select[aria-label="Finish policy"] option[value="inherit"]')?.innerText ?? '',
        sharingOptions: [...(form.querySelector('select[aria-label="Conversation policy"]')?.options ?? [])]
          .map(o => o.value),
        sharingInheritText: form.querySelector('select[aria-label="Conversation policy"] option[value="inherit"]')?.innerText ?? ''
      };
    })())
  `)
  const f = JSON.parse(filing)
  check(
    'the form asks where and how before it asks what',
    f.labels?.join(' > ').toLowerCase() === 'project > policy > worker > model',
    filing
  )
  check('the prompt sits below every setting', f.promptIsLast === true, filing)
  // ⛔ The finish policy is chosen on the way in, where a checkbox used to ask "I want to check this
  // before it lands". That checkbox could say await-human or nothing; the dropdown reaches all four
  // policies and `inherit`, which is the value that keeps following the project as it changes.
  // ⚠️ This control arrived with no coverage — the suite asserted the form's *order* and never its
  // contents, so swapping the checkbox out broke no test and would have broken none had it rendered
  // nothing at all.
  check(
    'the new-task form offers a finish policy, inherit included',
    Array.isArray(f.finishOptions) &&
      f.finishOptions.includes('inherit') &&
      f.finishOptions.includes('agent-lands'),
    filing
  )
  check(
    'and says which finish policy is inherited',
    typeof f.finishInheritText === 'string' && f.finishInheritText.startsWith('inherit (') && f.finishInheritText.endsWith(')'),
    filing
  )
  check(
    'the new-task form offers a conversation policy, inherit included',
    Array.isArray(f.sharingOptions) &&
      f.sharingOptions.includes('inherit') &&
      f.sharingOptions.includes('on') &&
      f.sharingOptions.includes('off'),
    filing
  )
  check(
    'and says which conversation policy is inherited',
    typeof f.sharingInheritText === 'string' && f.sharingInheritText.startsWith('inherit (') && f.sharingInheritText.endsWith(')'),
    filing
  )
  // ⚠️ A textarea because what goes in it is sent to an agent verbatim, and a prompt worth writing
  // has a second sentence. A single-line box that ate Enter was a lie about what it would accept.
  check('the prompt takes more than one line', f.textarea === true, filing)

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
  // ⛔ Not a greyed-out select. A model list belongs to one CLI, so until an account is pinned there
  // is genuinely nothing to draw — and a dead control would read as a choice being withheld.
  check(
    'no model is offered until an account is pinned',
    f.modelPickers === 0 && /default/i.test(f.modelText),
    filing
  )

  // Pin the account this suite commissioned, and the models its cost model can price appear.
  await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.form-row')];
      const row = rows.find(r => /^worker$/i.test(r.querySelector('label')?.innerText.trim() ?? ''));
      const sel = row?.querySelector('select');
      if (!sel) return 'no worker picker';
      sel.value = [...sel.options].find(o => o.value)?.value ?? '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()
  `)
  await wait(800)
  const pinned = await evaluate(`
    JSON.stringify((() => {
      const rows = [...document.querySelectorAll('.form-row')];
      const row = rows.find(r => /^model/i.test(r.querySelector('label')?.innerText ?? ''));
      const sel = row?.querySelector('select');
      const worker = rows.find(r => /^worker$/i.test(r.querySelector('label')?.innerText.trim() ?? ''));
      return {
        models: sel ? [...sel.options].map(o => o.value).filter(Boolean) : [],
        // ⚠️ "Preferred" would be a lie: the scheduler skips every other candidate outright.
        saysItPins: /pins/i.test(worker?.innerText ?? ''),
        // No built-in CLI takes an effort flag today, so a second picker here would be offering a
        // setting nothing could apply. This is the check that keeps it honest.
        efforts: row?.querySelectorAll('select').length ?? 0
      };
    })())
  `)
  const pin = JSON.parse(pinned)
  check('pinning an account offers the models its cost model can price', pin.models?.length > 0, pinned)
  check(
    'every offered model is one the daemon will accept',
    await evaluate(`
      (async () => {
        const ids = ${JSON.stringify(JSON.parse(pinned).models ?? [])};
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
  check('the worker control says it pins rather than prefers', pin.saysItPins === true, pinned)
  check(
    'no effort is offered where no CLI can be told one',
    pin.efforts === 1,
    'a control that cannot be honoured is worse than no control'
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

  section('cost')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Dashboard')).click()`
  )
  await wait(1500)
  const costPanel = await evaluate('document.querySelector(".content")?.innerText ?? ""')
  check('the cost view renders', costPanel.includes('Cost'))
  check(
    'it states the objective it is working to',
    /cost 0\.\d\d/.test(costPanel),
    'a scheduler that spends money should say what it is optimising for'
  )
  check(
    'an unknown remaining budget says so rather than showing a number',
    costPanel.includes('size unknown') || costPanel.includes('unknown'),
    'this is the honest state on a CLI with no free usage probe'
  )
  check(
    'shows cache clock and reserves sections',
    /cache clock/i.test(costPanel) && /save what it holds/i.test(costPanel)
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
  check('and says that they are stale', /stale/i.test(strip))
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
    'which starts at agent-lands, the shipped default',
    (await evaluate(`${fleetPicker}?.value`)) === 'agent-lands'
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
  await evaluate(`window.agentyard.rpc('settings.set', { finishPolicy: 'agent-lands' })`)

  section('the conversations page')
  // ⛔ The page exists for one number that is invisible everywhere else - how many tasks have been
  // in one conversation. These checks are that it reaches the daemon and renders; the join itself is
  // held by conversations.test.ts.
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim() === 'Conversations')?.click()`
  )
  await wait(1500)
  const convHead = await evaluate(`document.querySelector('.page-head')?.innerText ?? ''`)
  check('Conversations is reachable from the sidebar', /Conversations/i.test(convHead))
  check(
    'and says how many served more than one task, which is what sharing looks like',
    /served more than one task/i.test(convHead)
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

  // ⛔ Global settings: probe frequency selector and fleet intervention toggles
  const probePicker = `[...document.querySelectorAll('select')].find(
     s => s.getAttribute('aria-label') === 'Quota probe frequency')`
  check('the probe frequency control exists under Global', (await evaluate(`!!(${probePicker})`)) === true)
  check('starts at 5 minutes default', (await evaluate(`${probePicker}?.value`)) === '5')
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
  await evaluate(`window.agentyard.rpc('settings.set', { probeIntervalMinutes: 5 })`)

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
  const modelSelect = `document.querySelector('.tbl tbody tr td:nth-child(7) select')`
  check(
    'an account can be given a default model',
    (await evaluate(`${modelSelect}?.tagName`)) === 'SELECT',
    'before this there was no per-account default anywhere in the app'
  )
  check(
    'which starts at the CLI default, not at a model somebody has to undo',
    (await evaluate(`${modelSelect}?.value`)) === '',
    'null means the vendor picks — the state every install ran in before this control existed'
  )
  check(
    '"CLI default" is offered as a real choice, so the setting can be cleared',
    (await evaluate(`${modelSelect}?.options[0]?.text`)) === 'CLI default',
    'a picker with no empty option is one you can set and never unset'
  )
  // ⛔ The list comes from the daemon's cost models, not from a table in the renderer. A second list
  // here would drift the day a model was added to a file and not to this bundle.
  const served = await evaluate(
    `window.agentyard.rpc('model.options').then(o => String(o.find(x => x.adapterId === 'claude-code')?.models.length ?? 0))`
  )
  const offered = await evaluate(`String((${modelSelect}?.options.length ?? 1) - 1)`)
  check(
    'and every model it offers came from the cost model that will price it',
    offered === served && served !== '0',
    `offered ${offered}, served ${served}`
  )

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
