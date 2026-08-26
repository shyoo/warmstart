import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { REPO, check, electronBinary, killTree, section, summary, wait } from './lib/harness.mjs'

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
  app = spawn(electronBinary(), [REPO, `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, AGENTYARD_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  app.stderr.on('data', (d) => process.env.AGENTYARD_TEST_VERBOSE && process.stderr.write(`[app] ${d}`))

  const page = await waitForPage()
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

  section('shell')
  await waitFor(() => evaluate('!!document.querySelector(".statusbar")'), 'the shell to render')
  // ⚠️ Polled, not read once. The shell renders before the daemon has finished starting, so a bare
  // read here asserts "the daemon connected *within the time this machine took to paint*" - true on
  // a warm development box, false on a cold runner, and it failed on all three in CI. Everything
  // after this seeds through the app's own bridge, so an early read also turned one honest race into
  // a second failure reading `orchestratord is not connected`.
  const connected = await until(() => evaluate('!!document.querySelector(".dot--ok")'))
  check('the daemon connected', connected, connected ? '' : 'no .dot--ok within 30s')
  const nav = await evaluate('[...document.querySelectorAll(".nav-item")].map(b => b.innerText.trim())')
  check('every section is reachable', nav.length >= 5, nav.join(' | '))

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
      return t.seq;
    })()
  `)
  await wait(1500)

  const table = await evaluate('document.querySelector(".tbl")?.innerText ?? ""')
  check('the task table renders rows', table.includes('A task the UI can render'))
  check('a cancelled task shows its resting state', table.includes('paused_user'), 'not "cancelled"')
  check('a draft is visible but not queued', table.includes('draft'))

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
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Cost')).click()`)
  await wait(1500)
  const costPanel = await evaluate('document.querySelector(".panel")?.innerText ?? ""')
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

  section('controller')
  await evaluate(
    `[...document.querySelectorAll('.nav-item')].find(b => b.innerText.trim().startsWith('Controller')).click()`
  )
  await wait(1500)
  const controllerPanel = await evaluate('document.querySelector(".panel")?.innerText ?? ""')
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

async function waitForPage() {
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
  throw new Error('the app did not expose a debugging target within 45s')
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
