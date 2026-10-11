import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { resolveVersion } from '../scripts/version.mjs'
import { REPO, check, checkBuildIsCurrent, electronBinary, freePort, killTree, startDeadline, summary, wait } from './lib/harness.mjs'
const require = createRequire(join(REPO, 'package.json'))
const WebSocket = require('ws')
const root = mkdtempSync(join(tmpdir(), 'warmstart-performance-'))
const debugPort = await freePort()
const codeRoot = mkdtempSync(join(REPO, 'out/performance-code-'))
const bundle = join(codeRoot, 'performance-fixture.mjs')
let app, fixture, socket, endpoint
const deadline = startDeadline(120_000, 'parallel performance', () => {
  if (fixture?.connected) fixture.send('shutdown', () => {})
  killTree(app?.pid, 'electron')
})
const until = async (fn, budget = 15_000) => {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await fn(); if (value) return value; await wait(25) }
  throw new Error('performance fixture wait expired')
}
try {
  checkBuildIsCurrent()
  const newestSource = (dir) => Math.max(0, ...readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs
  }))
  const sourceAt = newestSource(join(REPO, 'src'))
  // Logs/fixture bundles under out must never make a stale app look freshly built.
  const fresh = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']
    .every((path) => statSync(join(REPO, path)).mtimeMs >= sourceAt)
  check('main/preload/renderer products are newer than source, independent of log timestamps', fresh)
  if (!fresh) throw new Error('build the app before the performance benchmark')
  // The fixture is trusted repository code, not an extension loaded from app data. It refuses PTYs.
  await build({ entryPoints: ['test/fixtures/performance-daemon.ts'], outfile: bundle, bundle: true,
    platform: 'node', format: 'esm', packages: 'external',
    alias: { '@shared': join(REPO, 'src/shared'), '@lydell/node-pty': join(REPO, 'test/stubs/node-pty.ts') },
    define: { __APP_VERSION__: JSON.stringify(resolveVersion()) } })
  fixture = spawn(process.execPath, [bundle], { cwd: REPO, env: { ...process.env, WARMSTART_DATA_DIR: root, NODE_PATH: join(REPO, 'node_modules') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let fixtureOutput = ''
  fixture.stdout.on('data', (d) => { fixtureOutput += d })
  fixture.stderr.on('data', (d) => { fixtureOutput += d })
  await until(() => {
    if (fixture.exitCode !== null) throw new Error(`fixture exited: ${fixtureOutput}`)
    try { endpoint = JSON.parse(readFileSync(join(root, 'orchestratord.json'), 'utf8')); return true } catch { return false }
  })
  const direct = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) })
    const body = await response.json()
    if (!body.ok) throw new Error(body.error?.message)
    return body.result
  }
  const env = { ...process.env, WARMSTART_DATA_DIR: root, WARMSTART_HEADLESS: '1', WARMSTART_PERFORMANCE_FRAMES: '1', NODE_PATH: join(REPO, 'node_modules') }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(electronBinary(), [REPO, `--remote-debugging-port=${debugPort}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'], { env, windowsHide: true, stdio: 'ignore' })
  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1000) })).json()
      return pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
    } catch { return false }
  })
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('DevTools open timeout')), 10_000)
    socket.once('open', () => { clearTimeout(timeout); done() }); socket.once('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  socket.on('message', (raw) => { const msg = JSON.parse(String(raw)); if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg) })
  socket.on('close', () => { for (const resolve of pending.values()) resolve({ error: { message: 'DevTools closed' } }) })
  const send = (method, params) => new Promise((done, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)) }, 10_000)
    pending.set(id, (msg) => { clearTimeout(timeout); pending.delete(id); msg.error ? reject(new Error(msg.error.message)) : done(msg.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  await until(() => evaluate(`document.querySelector('.dot--ok') && [...document.querySelectorAll('.nav-item:not(.nav-item--task)')].some(b => b.textContent.includes('Performance fixture'))`))
  await evaluate(`[...document.querySelectorAll('.welcome-actions button')].find(b => /Skip tour/.test(b.textContent))?.click()`)
  await until(() => evaluate(`!document.querySelector('.welcome-tour')`))
  await send('Page.captureScreenshot', { format: 'png' }) // Force an initial compositor surface in a hidden window.
  check('loaded fixture has four work sessions and two review sessions', (await direct('session.list')).filter((s) => s.state === 'live').length === 6)
  const initial = await direct('diagnostics.performance')
  const count = (snapshot, label) => snapshot.rows.find((r) => r.label === label)?.count ?? 0
  const paint = [], data = [], health = []
  for (let turn = 0; turn < 10; turn++) {
    const selector = turn % 2 === 0
      ? `[...document.querySelectorAll('.nav-item:not(.nav-item--task)')].find(b=>b.textContent.includes('Performance fixture'))`
      : `[...document.querySelectorAll('.nav-item--task')].find(b=>b.textContent.includes('Live fixture 1001'))`
    const point = await evaluate(`(()=>{const b=${selector}; if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    if (!point) throw new Error('navigation target missing')
    await evaluate(`window.__perfPaint=null; document.addEventListener('click',(event)=>{const start=event.timeStamp;requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__perfPaint=performance.now()-start}))},{once:true,capture:true})`)
    const start = performance.now()
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await send('Page.captureScreenshot', { format: 'png' })
    paint.push(await until(() => evaluate('window.__perfPaint')))
    await until(() => evaluate(turn % 2 === 0 ? `!!document.querySelector('.content tbody tr')` : `document.querySelector('.detail-head')?.innerText.includes('Live fixture 1001')`))
    data.push(performance.now() - start)
    const hs = performance.now()
    await fetch(`http://127.0.0.1:${endpoint.port}/health`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(10_000) })
    health.push(performance.now() - hs)
    await wait(250)
  }
  const beforeIdle = await direct('diagnostics.performance')
  await wait(5000)
  const stats = await direct('diagnostics.performance')
  const describe = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }
  }
  console.log(JSON.stringify({ historyTasks: 1000, quotaSamples: 80_000, syntheticWorkStreams: 4, syntheticReviews: 2,
    clickToSecondFrameMs: describe(paint), navigationToDataMs: describe(data), healthMs: describe(health),
    loopBusyPercent: stats.loopBusyPercent, diagnostics: stats.rows.filter((r) =>
      ['pricing rebuild', 'RPC total task.list', 'RPC total task.get', 'RPC total task.page', 'loop delay max', 'loop delay p95'].includes(r.label)) }))
  check('native click to second animation frame p95 is within 200 ms', describe(paint).p95 <= 200)
  check('task data arrives within 1 second p95 and 2 seconds max', describe(data).p95 <= 1000 && describe(data).max <= 2000)
  check('streams were actually delivered during the measurement', count(stats, 'event session.stream') - count(initial, 'event session.stream') >= 40)
  check('both synthetic reviews emitted run changes', count(stats, 'event run.changed') - count(initial, 'event run.changed') >= 2)
  check('event bursts do not refetch full task history', count(stats, 'RPC total task.list') - count(beforeIdle, 'RPC total task.list') === 0)
  check('loop delay is measured under load', stats.rows.some((r) => r.label === 'loop delay max' && r.samples > 0))
  await evaluate(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.trim()==='Global').click()`)
  await until(() => evaluate(`[...document.querySelectorAll('.tab')].some(b=>b.textContent.trim()==='Status')`))
  await evaluate(`[...document.querySelectorAll('.tab')].find(b=>b.textContent.trim()==='Status').click()`)
  await until(() => evaluate(`!!document.querySelector('.performance-diagnostics button')`))
  await evaluate(`document.querySelector('.performance-diagnostics button').click()`)
  check('performance capture renders actual UI/daemon timings and workload counts', await until(() => evaluate(`(()=>{const p=document.querySelector('.performance-diagnostics'); return p.innerText.includes('4 work · 2 reviews') && p.innerText.includes('UI RPC') && p.innerText.includes('RPC total task.page') && p.querySelectorAll('tbody tr').length > 0})()`)))
} catch (err) {
  console.error('performance check failed:', err)
  throw err
} finally {
  socket?.close()
  // Stop the window first: otherwise its reconnect timer can start a replacement daemon.
  killTree(app?.pid, 'electron')
  if (app && app.exitCode === null) await until(() => app.exitCode !== null, 5000).catch(() => {})
  if (endpoint) {
    await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, { method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'daemon.shutdown' }) }).catch(() => {})
  }
  if (fixture?.connected) fixture.send('shutdown', () => {})
  if (fixture && fixture.exitCode === null) await until(() => fixture.exitCode !== null, 5000).catch(() => {})
  deadline.clear()
  // The resolved target is exactly the fresh temporary fixture directory, never a project checkout.
  if (relative(resolve(tmpdir()), resolve(root)).startsWith('warmstart-performance-')) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  if (relative(resolve(REPO, 'out'), resolve(codeRoot)).startsWith('performance-code-')) rmSync(codeRoot, { recursive: true, force: true })
}
process.exitCode = summary('parallel performance') ? 1 : 0
