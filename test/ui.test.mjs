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
  killTree,
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

const PORT = 9444
const dataDir = mkdtempSync(join(tmpdir(), 'agentyard-ui-'))
let app = null
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
  await new Promise((r) => socket.on('open', r))

  let id = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
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
  // ⛔ Named, not counted. The sidebar is now Overview / one item per project / Settings, so a count
  // says nothing: it moves whenever a project is added, and it passed all the way through the
  // rewrite that removed Cost and Controller as destinations.
  check(
    'the three fixed destinations are reachable',
    ['Overview', 'Workers', 'Global'].every((label) => nav.some((n) => n.startsWith(label))),
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
    'the approvals bar is absent when there is nothing to answer',
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
      await r('task.create', { title: 'A task waiting for a worker', priority: 'P3' });
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

  // ---- the detail pane ----------------------------------------------------------------
  // ⛔ Opened, because everything below only exists once a row is open — and "click the row to find
  // out which session it is on" is exactly the gap this pane was reworked to close.
  await evaluate(`[...document.querySelectorAll('.tbl tbody tr')].at(-1)?.click()`)
  await wait(1200)
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
          ?.querySelectorAll('select').length ?? 0
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
  // ⚠️ A textarea because what goes in it is sent to an agent verbatim, and a prompt worth writing
  // has a second sentence. A single-line box that ate Enter was a lie about what it would accept.
  check('the prompt takes more than one line', f.textarea === true, filing)
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

  section('layout')
  const heights = await evaluate(`
    JSON.stringify({
      approvals: document.querySelector('.approvals')?.getBoundingClientRect().height ?? 0,
      content: document.querySelector('.content')?.getBoundingClientRect().height ?? 0
    })
  `)
  const { approvals, content } = JSON.parse(heights)
  check(
    'the approvals strip stays a strip',
    approvals > 0 && approvals < 90,
    `${Math.round(approvals)}px — a fixed grid-template-rows used to hand it the flexible row`
  )
  check('the content pane takes the remaining height', content > approvals * 3, `${Math.round(content)}px`)

  section('cost')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Overview')).click()`
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
  // On Overview beside cost: the controller answers questions about the fleet, and a consult is not
  // scoped to any one project.
  await wait(500)
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
    `window.agentyard.rpc('worker.create', { adapterId: 'claude-code', label: 'suspect worker', enabled: false }).then(w => w.id)`
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

  await evaluate(`${rowSwitch}.click()`)
  await wait(1200)
  check(
    'and it comes back on, with the account untouched',
    (await evaluate(`${rowSwitch}?.getAttribute('aria-checked')`)) === 'true',
    'off is not retirement — nothing is deleted and nothing needs re-commissioning'
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
