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
import { spawn, execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { electronBinary, freePort, killTree, makeProject, destroyProject, wait } from '../test/lib/harness.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const ASSETS = join(ROOT, 'docs', 'images')
const only = new Set(process.argv.slice(2))

if (!existsSync(join(ROOT, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run `npm run build` first')
  process.exit(1)
}

// ⚠️ Under `out/` rather than the OS temp directory: the wizard, the worker cards and the thread
// print these paths, and `C:\Users\<you>\AppData\Local\Temp` in a README image is the
// maintainer's account name. `out/` is gitignored and already the build's own scratch space.
const SCRATCH = process.env.WARMSTART_SHOWCASE_ROOT || join(ROOT, 'out', 'showcase')
const DATA = join(SCRATCH, 'data')
const PROJECT_ROOT = join(SCRATCH, 'storefront')
const WIZARD_ROOT = join(SCRATCH, 'billing-service')
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

const require = createRequire(join(ROOT, 'package.json'))
const WebSocket = require('ws')

// ---------------------------------------------------------------------------------------------
// The fictional fleet.
// ---------------------------------------------------------------------------------------------

const H = 3_600_000
const D = 24 * H

/** Five invented accounts. `windows[1]` is the billing window a run is priced against. */
const WORKERS = [
  { adapterId: 'claude-code', label: 'Claude · personal', account: 'alex@example.invalid', plan: 'max_5x', model: 'claude-opus-5', cost: 'anthropic.subscription.2026-08', windows: [['session', 'Claude 5h', 38, 2.4 * H], ['weekly_all', 'Claude 7d', 61, 3.7 * D]] },
  { adapterId: 'claude-code', label: 'Claude · work', account: 'work@example.invalid', plan: 'pro', model: 'claude-sonnet-5', cost: 'anthropic.subscription.2026-08', windows: [['session', 'Claude 5h', 44, 1.7 * H], ['weekly_all', 'Claude 7d', 52, 4.1 * D]] },
  { adapterId: 'openai-compatible', label: 'Codex · work', account: 'codex@example.invalid', plan: 'pro', model: 'gpt-5.6-sol', cost: 'openai.codex.2026-08', windows: [['5h', 'GPT 5h', 54, 1.1 * H], ['7d', 'GPT 7d', 27, 5.2 * D]] },
  { adapterId: 'antigravity-cli', label: 'Antigravity', account: 'gravity@example.invalid', plan: 'ultra', model: 'gemini-3.1-pro-high', cost: 'google.antigravity.2026-08', windows: [['5h', 'Gemini 5h', 18, 4.1 * H], ['weekly:gemini-models', 'Gemini weekly', 43, 2.1 * D]] },
  { adapterId: 'muse-code', label: 'Muse', account: 'muse@example.invalid', plan: 'high', model: 'muse-spark-1.3', cost: 'meta.muse.2026-09', windows: [['5h', 'Muse 5h', 31, 3.4 * H], ['7d', 'Muse 7d', 48, 4.4 * D]] }
]

/** The board. Never `ready`, so nothing here is ever dispatched. `age` is how long ago it was filed. */
const TASKS = [
  { title: 'Polish the storefront first-run experience', priority: 'P1', status: 'running', worker: 0, age: 14 * 60_000 },
  { title: 'Add saved carts to the storefront', priority: 'P1', status: 'running', worker: 1, age: 41 * 60_000 },
  { title: 'Improve checkout address validation', priority: 'P1', status: 'running', worker: 2, age: 27 * 60_000 },
  { title: 'Build the inventory alert panel', priority: 'P1', status: 'running', worker: 3, age: 19 * 60_000 },
  { title: 'Choose a returns policy for marketplace sellers', priority: 'P2', status: 'awaiting_human', worker: 4, age: 2 * H, hold: 'Choose whether marketplace returns use the seller policy or a storefront-wide policy.' },
  { title: 'Approve the new product-card copy', priority: 'P2', status: 'awaiting_human', worker: 1, age: 3 * H, hold: 'The draft is ready for a product decision before the agent lands it.' },
  { title: 'Add gift notes after cart rules land', priority: 'P2', status: 'blocked', dependsOn: 1, age: 3 * H },
  { title: 'Schedule the autumn catalogue import', priority: 'P3', status: 'scheduled', notBefore: 16 * H, age: 5 * H },
  { title: 'Ship mobile order-status notifications', priority: 'P2', status: 'completed', worker: 0, age: 1 * D, minutes: 37 },
  { title: 'Review storefront search relevance', priority: 'P2', status: 'completed', worker: 2, age: 2 * D, minutes: 22 },
  { title: 'Move recommendations into their own pane', priority: 'P2', status: 'completed', worker: 3, age: 3 * D, minutes: 48 },
  { title: 'Add accessible size-selector labels', priority: 'P3', status: 'completed', worker: 4, age: 4 * D, minutes: 31 }
]

/** Older finished work, enough per model for Statistics and the routing pages to trust it. */
const HISTORY = 40
const HISTORY_TITLES = ['Tighten the checkout form validation', 'Cache the catalogue index', 'Add retries to the payment webhook', 'Split the settings page into tabs', 'Fix the cart badge count', 'Migrate the image pipeline to WebP', 'Add stock filters', 'Improve receipt emails']

const THREAD = [
  ['human', 'Please make the first-run experience feel obvious. Focus on the empty state, progressive disclosure, and a path to filing the first task. Keep the scheduler contract unchanged.'],
  ['agent', 'I will map the current first-run path first, then tighten the copy and the interaction. Starting with the project setup dialog and the empty fleet states.'],
  ['agent', 'Found the main friction: the screen explains implementation details before it gives you a next action. I replaced that with one clear choice and kept the diagnostics behind "Why can\'t I start?".'],
  ['human', 'Good. Keep the diagnostics one click away, not hidden behind a settings page.'],
  ['agent', 'Done: the diagnostics open inline under the choice. The focused checks are green; I am reviewing the final diff and will leave the exact behaviour changes in the handoff.']
]

const PROMPT = 'Please take ownership of this work and leave the repository ready to land.'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true }).toString()
}

/** A second repository the add-project wizard can inspect without registering it. */
function makeWizardRepo(root) {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'showcase')
  git(root, 'config', 'user.email', 'showcase@example.invalid')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'billing-service', scripts: { test: 'vitest run', lint: 'eslint .' } }, null, 2))
  writeFileSync(join(root, 'README.md'), '# billing-service\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
}

const branchFor = (seq, title) => `warmstart/t${seq}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`

/** Has the daemon this data directory belongs to exited? The lock file names its pid. */
function daemonGone() {
  const lock = join(DATA, 'orchestratord.lock')
  if (!existsSync(lock)) return true
  const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
  if (!Number.isFinite(pid)) return true
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function openDb() {
  return new DatabaseSync(join(DATA, 'warmstart.db'))
}

function statements(db) {
  return {
    quota: db.prepare('insert into quota_samples(worker_id, window_id, label, percent, resets_at, source, sampled_at, window_group) values (?, ?, ?, ?, ?, ?, ?, ?)'),
    run: db.prepare(
      `insert into runs(id, task_id, project_id, session_id, worker_id, started_at, ended_at, outcome, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_model_id, adapter_id, model, kind, prompt, quota_before_json, quota_after_json)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'work', ?, ?, ?)`
    ),
    task: db.prepare('update tasks set status = ?, assignee = ?, branch = ?, hold_reason = ?, not_before = ?, created_at = ?, updated_at = ?, quality_review_score = ?, quality_review_count = ?, quality_reviewer = ? where id = ?')
  }
}

/** One reading of every window of one worker, with the billing window at `percent`. */
function reading(stmt, ids, wi, at, percent) {
  for (const [id, label, base, resetsIn] of WORKERS[wi].windows) {
    const value = id === WORKERS[wi].windows[1][0] ? percent : Math.max(2, base - 12 + ((at / 7e6) % 9))
    stmt.run(ids.workers[wi], id, label, Math.round(value * 10) / 10, at + resetsIn, 'showcase', at, id.includes(':') ? id.split(':')[1] : null)
  }
}

/** The reading a run keeps beside it, in the shape the thread's ledger reads. */
function runQuota(wi, at, percent) {
  return JSON.stringify({
    windows: WORKERS[wi].windows.map(([id, label, base]) => ({
      id, label, percent: id === WORKERS[wi].windows[1][0] ? percent : base, ...(id.includes(':') ? { group: id.split(':')[1] } : {})
    })),
    sampledAt: at,
    stale: false
  })
}

/**
 * Phase one: accounts, finished work and the quota series that prices it.
 *
 * A run is priced as the movement of its billing window between the reading before it and the
 * reading after it, so each worker gets a rising series with one pair per run — inserted oldest
 * first — that ends below the fixture reading the fleet strip shows.
 */
function seedHistory(db, ids, now) {
  const s = statements(db)
  const updateWorker = db.prepare('update workers set enabled = 1, identity_json = ?, default_model = ? where id = ?')
  WORKERS.forEach((w, i) => {
    const identity = { loggedIn: true, account: w.account, subscriptionType: w.plan, setupComplete: true, cliVersion: '2.1.0', checkedAt: now - 6 * 60_000 }
    updateWorker.run(JSON.stringify(identity), w.model, ids.workers[i])
  })

  const insertTask = db.prepare(
    `insert into tasks(id, seq, project_id, title, status, priority, created_by_json, mandate_json, budget_json, assignee, branch,
       created_at, updated_at, quality_review_score, quality_review_count, quality_reviewer, kind)
     values (?, ?, ?, ?, 'completed', 'P2', '{"kind":"human"}', ?, '{"grantedTokens":0,"spentTokens":0,"spentUsd":0}', ?, ?, ?, ?, ?, 2, ?, 'work')`
  )
  const mandate = JSON.stringify({ allowed: ['read', 'write', 'commit', 'land'], projectIds: 'creator', maxLineageDepth: 3, maxChildren: 5 })

  const finished = []
  for (let i = 0; i < HISTORY; i++) {
    const wi = i % WORKERS.length
    const started = now - (i + 4) * 7 * H
    const minutes = 14 + ((i * 7) % 31) + wi * 6
    finished.push({ id: `showcase-task-${i}`, seq: 100 + i, title: `${HISTORY_TITLES[i % HISTORY_TITLES.length]} (${i + 1})`, wi, started, ended: started + minutes * 60_000, insert: true, n: i })
  }
  TASKS.forEach((t, i) => {
    if (t.status !== 'completed') return
    const started = now - t.age
    finished.push({ id: ids.tasks[i], seq: i + 1, title: t.title, wi: t.worker, started, ended: started + t.minutes * 60_000, insert: false, n: i })
  })
  finished.sort((a, b) => a.started - b.started)

  const series = WORKERS.map((w) => ({ at: w.windows[1][2] * 0.35, step: (w.windows[1][2] * 0.6) / (finished.length / WORKERS.length) }))
  for (const f of finished) {
    const w = WORKERS[f.wi]
    const score = Math.round(([8.6, 8.2, 7.7, 8.1, 7.9][f.wi] + ((f.n % 5) - 2) * 0.3) * 10) / 10
    const reviewer = ids.workers.find((_, candidate) => WORKERS[candidate].adapterId !== WORKERS[f.wi].adapterId)
    if (f.insert) {
      insertTask.run(f.id, f.seq, ids.project, f.title, mandate, ids.workers[f.wi], branchFor(f.seq, f.title), f.started - 20 * 60_000, f.ended, score, reviewer)
    } else {
      s.task.run('completed', ids.workers[f.wi], branchFor(f.seq, f.title), null, null, f.started - 20 * 60_000, f.ended, score, 2, reviewer, f.id)
    }
    const q = series[f.wi]
    const before = q.at
    q.at += q.step * 0.4 * (0.7 + (f.n % 4) * 0.2)
    const after = q.at
    q.at += q.step * 0.6
    reading(s.quota, ids, f.wi, f.started - 45_000, before)
    reading(s.quota, ids, f.wi, f.ended + 45_000, after)
    s.run.run(`showcase-run-${f.id}`, f.id, ids.project, null, ids.workers[f.wi], f.started, f.ended, 'completed', 900 + f.n * 40, 2_400 + f.wi * 900 + (f.n % 4) * 300,
      38_000 + f.wi * 14_000 + (f.n % 6) * 5_000, 6_000 + (f.n % 3) * 1_500, w.cost, w.adapterId, w.model, PROMPT,
      runQuota(f.wi, f.started - 45_000, before), runQuota(f.wi, f.ended + 45_000, after))
  }

  // The reading the fleet strip shows: three minutes old, and the newest of every series.
  for (let wi = 0; wi < WORKERS.length; wi++) reading(s.quota, ids, wi, now - 3 * 60_000, WORKERS[wi].windows[1][2])
}

/** Phase two: what is happening right now — written after the daemon's startup reconciliation. */
function seedLive(db, ids, now) {
  const s = statements(db)
  const pool = JSON.parse(db.prepare('select members_json from resources where id = ?').get(`workspace:${ids.project}`).members_json)
  const insertClaim = db.prepare('insert into resource_claims(id, resource_id, member, holder, amount, acquired_at) values (?, ?, ?, ?, 1, ?)')
  const insertSession = db.prepare(
    `insert into sessions(id, worker_id, adapter_id, transport, project_id, cwd, model, effort, state, context_tokens,
       last_request_started_at, cache_expires_at, tokens_since_compact, started_at, purpose, current_branch)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'work', ?)`
  )

  TASKS.forEach((t, i) => {
    if (t.status === 'completed') return
    const id = ids.tasks[i]
    const worker = t.worker === undefined ? null : ids.workers[t.worker]
    const created = now - t.age
    const branch = t.status === 'scheduled' || t.status === 'blocked' ? null : branchFor(i + 1, t.title)
    s.task.run(t.status, worker, branch, t.hold ?? null, t.notBefore ? now + t.notBefore : null, created, now - 90_000, null, 0, null, id)
    if (t.status !== 'running') return
    const w = WORKERS[t.worker]
    insertClaim.run(`showcase-claim-${i}`, `workspace:${ids.project}`, pool[i] ?? null, id, created)
    insertSession.run(`showcase-session-${i}`, worker, w.adapterId, 'pipe', ids.project, pool[i] ?? PROJECT_ROOT, w.model, 'high', 'busy',
      18_400 + i * 9_200, now - 40_000, now + 55 * 60_000, 4_200 + i * 800, created, branch)
    s.run.run(`showcase-run-live-${i}`, id, ids.project, `showcase-session-${i}`, worker, created, null, null, 1_200, 3_800 + i * 900,
      61_000 + i * 20_000, 9_400, w.cost, w.adapterId, w.model, PROMPT, runQuota(t.worker, created, WORKERS[t.worker].windows[1][2] - 1.5), null)
  })

  // The live thread: the prompt the daemon filed, the ledger entry it would have written, and a conversation.
  const thread = ids.tasks[0]
  const t0 = now - TASKS[0].age
  db.prepare('update task_messages set ts = ? where task_id = ?').run(t0, thread)
  const insertMessage = db.prepare('insert into task_messages(task_id, role, text, ts, event, detail, run_id) values (?, ?, ?, ?, ?, ?, ?)')
  insertMessage.run(thread, 'system', 'Worker assigned: Claude · personal (claude-opus-5)', t0 + 3_000, 'worker.assigned',
    `Routing: quality 0.83 · cost 0.71 · velocity 0.64 (score 0.74).\nWorkspace: ${pool[0]} on ${branchFor(1, TASKS[0].title)}.\nConversation: cold start.`, 'showcase-run-live-0')
  THREAD.forEach(([role, text], i) => insertMessage.run(thread, role, text, t0 + 60_000 + i * 150_000, null, null, 'showcase-run-live-0'))
}

// ---------------------------------------------------------------------------------------------
// One launch of the app over the DevTools protocol. Every send is bounded and a closed socket
// fails everything in flight — the two rules test/ui.test.mjs learned the hard way (2026-08-29).
// ---------------------------------------------------------------------------------------------

async function launch() {
  const port = await freePort()
  // ⛔ No WARMSTART_HEADLESS here: see the file comment. Everything else matches the L3 harness.
  const env = { ...process.env, WARMSTART_DATA_DIR: DATA }
  mkdirSync(join(DATA, 'ui'), { recursive: true })
  writeFileSync(join(DATA, 'ui', 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1440, height: 900 }))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.WARMSTART_HEADLESS
  const app = spawn(electronBinary(), [ROOT, `--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true })

  const pending = new Map()
  let dead = null
  let socket = null
  let rpcId = 0

  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolveSend, reject) => {
      if (dead) return reject(new Error(dead))
      const id = ++rpcId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolveSend(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluation failed')
    }
    return reply.result?.result?.value
  }

  const until = async (fn, what, timeout = 30_000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        const value = await fn()
        if (value) return value
      } catch {
        // The renderer is still starting; try again.
      }
      await wait(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  /**
   * ⛔ Ask the daemon to stop before the app goes. `Browser.close` ends the Electron process
   * without its quit path, and orchestratord is a separate process that outlived it — six of them
   * were found holding six scratch databases after the first afternoon of this script, and the
   * second launch was quietly reusing the first one's daemon. The daemon exits within four seconds
   * of the request; the lock file names its pid, which is how the wait knows. The tree kill is the
   * backstop, by pid and verified.
   */
  const close = async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        const answer = await evaluate("window.agentyard.rpc('daemon.shutdown').then(() => 'ok', (e) => e.message)")
        if (answer !== 'ok') console.warn(`the daemon did not take the shutdown request: ${answer}`)
        await until(daemonGone, 'the daemon to exit', 15_000)
        // With no tray, the app follows its daemon out; if it is still here, close it.
        if (!dead) await send('Browser.close', {}, 5_000)
      } catch (error) {
        if (!dead) console.warn(`the app did not close cleanly: ${error.message}`)
      }
    }
    socket?.close()
    const end = Date.now() + 10_000
    while (Date.now() < end && app.exitCode === null) await wait(250)
    if (app.exitCode === null) killTree(app.pid, 'electron')
  }

  try {
    const page = await until(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      return (await res.json()).find((p) => p.type === 'page')
    }, 'the DevTools page target', 45_000)
    socket = new WebSocket(page.webSocketDebuggerUrl)
    const failAll = (why) => {
      dead ??= why
      for (const entry of pending.values()) entry.reject(new Error(why))
      pending.clear()
    }
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      const entry = msg.id ? pending.get(msg.id) : undefined
      if (entry) {
        pending.delete(msg.id)
        entry.resolve(msg)
      }
    })
    socket.on('close', () => failAll('the app closed the DevTools connection'))
    socket.on('error', (err) => failAll(`the DevTools connection failed: ${err.message}`))
    await new Promise((resolveOpen, reject) => {
      socket.once('open', resolveOpen)
      socket.once('error', reject)
    })
    await until(() => evaluate("!!document.querySelector('.dot--ok')"), 'the daemon to connect', 45_000)
  } catch (error) {
    await close()
    throw error
  }

  /** Click the first element matching `selector` whose trimmed text starts with `text`. */
  const clickText = async (selector, text) => {
    const found = await evaluate(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]` +
        `.find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)})); el?.click(); return !!el })()`
    )
    if (!found) throw new Error(`nothing matching ${selector} reads "${text}"`)
    await wait(700)
  }
  const click = async (selector) => {
    const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return !!el })()`)
    if (!found) throw new Error(`nothing matches ${selector}`)
    await wait(700)
  }
  /** Type into a React-controlled field: set the value the way React expects and fire `input`. */
  const type = async (selector, value) => {
    const ok = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;` +
        ` const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;` +
        ` Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});` +
        ` el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
    )
    if (!ok) throw new Error(`no field matches ${selector}`)
    await wait(700)
  }
  /** Capture the window; with `focus`, scrolled so that element sits at the top of the pane. */
  const shot = async (name, focus = null) => {
    await evaluate(
      focus
        ? `document.querySelector(${JSON.stringify(focus)})?.scrollIntoView({ block: 'start' })`
        : "document.querySelector('.main')?.scrollTo(0, 0)"
    )
    await wait(400)
    const reply = await send('Page.captureScreenshot', { format: 'png' }, 20_000)
    if (!reply.result?.data) throw new Error(`no image data for ${name}: ${JSON.stringify(reply.error ?? reply)}`)
    const composite = await evaluate(`(async () => { const img = new Image(); img.src = 'data:image/png;base64,${reply.result.data}'; await img.decode(); const pad = Math.round(img.width * 0.06), r = 18, W = img.width + pad * 2, H = img.height + pad * 2; const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d'); const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f1218'); g.addColorStop(1, '#1a2036'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); const glow = (x,y,rad,color) => { const rg = ctx.createRadialGradient(x,y,0,x,y,rad); rg.addColorStop(0,color); rg.addColorStop(1,'rgba(0,0,0,0)'); ctx.fillStyle=rg; ctx.fillRect(0,0,W,H) }; glow(0,0,W*.65,'rgba(122,162,247,.28)'); glow(W,H,W*.6,'rgba(240,163,94,.22)'); ctx.save(); ctx.shadowColor='rgba(0,0,0,.65)'; ctx.shadowBlur=pad*.7; ctx.shadowOffsetY=pad*.25; ctx.fillStyle='#0e1013'; ctx.beginPath(); ctx.roundRect(pad,pad,img.width,img.height,r); ctx.fill(); ctx.restore(); ctx.save(); ctx.beginPath(); ctx.roundRect(pad,pad,img.width,img.height,r); ctx.clip(); ctx.drawImage(img,pad,pad); ctx.restore(); ctx.strokeStyle='rgba(255,255,255,.10)'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.roundRect(pad+.75,pad+.75,img.width-1.5,img.height-1.5,r); ctx.stroke(); return c.toDataURL('image/png').split(',')[1] })()`)
    writeFileSync(join(ASSETS, `${name}.png`), Buffer.from(composite, 'base64'))
    console.log(`wrote docs/images/${name}.png`)
  }

  const shotElement = async (name, selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`)
    await wait(400)
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: Math.max(0,r.x-12), y: Math.max(0,r.y-12), width: r.width+24, height: r.height+24 } })()`)
    if (!box) throw new Error(`no element matches ${selector}`)
    const reply = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } }, 20_000)
    if (!reply.result?.data) throw new Error(`no image data for ${name}`)
    const composite = await evaluate(`(async () => { const img = new Image(); img.src='data:image/png;base64,${reply.result.data}'; await img.decode(); const p=Math.round(img.width*.06), W=img.width+p*2,H=img.height+p*2,c=document.createElement('canvas'); c.width=W;c.height=H;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,W,H);g.addColorStop(0,'#0f1218');g.addColorStop(1,'#1a2036');x.fillStyle=g;x.fillRect(0,0,W,H);x.save();x.shadowColor='rgba(0,0,0,.65)';x.shadowBlur=p*.7;x.fillStyle='#0e1013';x.beginPath();x.roundRect(p,p,img.width,img.height,18);x.fill();x.restore();x.save();x.beginPath();x.roundRect(p,p,img.width,img.height,18);x.clip();x.drawImage(img,p,p);x.restore();return c.toDataURL('image/png').split(',')[1] })()`)
    writeFileSync(join(ASSETS, `${name}.png`), Buffer.from(composite, 'base64'))
  }

  return {
    evaluate,
    until,
    close,
    clickText,
    click,
    type,
    shot,
    shotElement,
    nav: (text) => clickText('.nav-item', text),
    tab: (text) => clickText('.tab', text)
  }
}

// ---------------------------------------------------------------------------------------------
// Scenes. Each one is a click path; the file it writes is what the README references.
// ---------------------------------------------------------------------------------------------

const DEBATE_PROMPT = 'Should the catalogue move from REST to GraphQL for the mobile app, or stay and add a BFF? Argue it from the client cost, the cache story and the migration risk.'

const SCENES = {
  dashboard: async (ui) => {
    await ui.nav('Dashboard')
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
    await ui.clickText('.tbl-title', 'Polish the first-run')
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
  mkdirSync(ASSETS, { recursive: true })
  makeProject(PROJECT_ROOT, { name: 'storefront', poolSize: 4, check: ['npm test', 'npm run lint'] })
  makeWizardRepo(WIZARD_ROOT)

  // Phase one. What the real RPCs can create, they create — so ids, seqs and defaults are the
  // daemon's own. Workers start disabled and tasks start as drafts; the seed changes both.
  ui = await launch()
  const ids = await ui.evaluate(`(async () => {
    const r = window.agentyard.rpc
    const workers = []
    for (const w of ${JSON.stringify(WORKERS.map((w) => ({ adapterId: w.adapterId, label: w.label })))}) {
      workers.push((await r('worker.create', { ...w, enabled: false })).id)
    }
    const project = await r('project.add', { root: ${JSON.stringify(PROJECT_ROOT)}, name: 'storefront' })
    // Builds the four real worktrees now, so Flow has a pool for the running tasks to hold.
    await r('project.setPolicy', { id: project.id, poolSize: 4 })
    const tasks = []
    for (const t of ${JSON.stringify(TASKS.map((t) => ({ title: t.title, priority: t.priority, dependsOn: t.dependsOn })))}) {
      tasks.push((await r('task.create', {
        projectId: project.id, title: t.title, priority: t.priority, status: 'draft', prompt: ${JSON.stringify(PROMPT)},
        dependsOn: t.dependsOn === undefined ? [] : [tasks[t.dependsOn]]
      })).id)
    }
    return { workers, project: project.id, tasks }
  })()`)
  await ui.close()
  ui = null

  const now = Date.now()
  let db = openDb()
  try {
    db.exec('begin')
    seedHistory(db, ids, now)
    db.exec('commit')
  } finally {
    db.close()
  }

  // Phase two: the daemon starts over the history, reconciles nothing, and only then learns
  // what is running.
  ui = await launch()
  db = openDb()
  try {
    db.exec('begin')
    seedLive(db, ids, now)
    db.exec('commit')
  } finally {
    db.close()
  }
  // The daemon emits nothing for rows written behind its back, so the renderer reads it all again.
  await ui.evaluate('location.reload()')
  await wait(1500)
  await ui.until(() => ui.evaluate("!!document.querySelector('.dot--ok')"), 'the renderer to reload', 45_000)
  await wait(1500)

  for (const [name, scene] of Object.entries(SCENES)) {
    if (only.size > 0 && !only.has(name)) continue
    await scene(ui)
  }
} finally {
  clearTimeout(deadline)
  await ui?.close()
  await wait(500)
  destroyProject(PROJECT_ROOT)
  try {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (error) {
    console.warn(`showcase scratch data remains at ${SCRATCH}: ${error.message}`)
  }
}
