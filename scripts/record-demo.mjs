/**
 * Record the demo video from the real renderer, driving the same fictional fleet as the README
 * screenshots.
 *
 *   npm run build
 *   node scripts/record-demo.mjs          # writes out/demo/warmstart-demo.mp4 and .gif
 *
 * The story, about seventy seconds: a busy board → a task filed from the composer → routed to the
 * account with window to spare → Flow, three tasks in parallel → the agent reports as it works → it lands →
 * peer-graded → the trade-off charts it feeds.
 *
 * ⛔ **A staged run, not a real one.** Filing the task is a real click through the real composer and
 * a real `task.create`; everything after it — the assignment, the agent's messages, the landing, the
 * grades — is written into the scratch database on a timer, and a harmless `task.setPriority` makes
 * the renderer read it again. The captions are the product's claims; the rows are invented, as
 * every row in `showcase.mjs` is. Say so wherever the video is published.
 *
 * ⛔ **Nothing is ever dispatched.** A filed task is `ready`, and a ready task with an enabled worker
 * is a task the scheduler starts — against whatever CLI this machine has, and Antigravity's keyring
 * is the operator's real one. Hiding the CLIs from `PATH` does not work: the Antigravity adapter
 * also looks in `%LOCALAPPDATA%\agy\bin` and Muse under `%LOCALAPPDATA%\Programs\muse` (tried 2026-09-16, then through `wsl.exe`).
 * So every invented account is set to role `none` — commissioned and measured, but never given work
 * or asked for judgment — and grading is turned off on each, because the reviewer pool reads
 * `gradingEnabled` rather than the role. The fleet strip draws neither. Title summaries must be off
 * too. The script checks all three before filing and, after the take, refuses to encode if the
 * daemon opened any session it did not stage.
 *
 * ⚠️ Captions and the click pulse are DOM injected over the page for the recording only. The
 * renderer's CSP allows inline style; nothing here loads anything.
 *
 * Output lands in `out/demo/` (gitignored). The published copies are `docs/images/demo.{gif,mp4}`,
 * which the README shows, and `warmstart-site/public/demo/`: copy a new take to both and check the
 * SHA-256. `DEMO_DEBUG=1` also writes one PNG per beat, for checking a take without watching it;
 * `DEMO_KEEP=1` leaves the scratch fleet.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  prepare, cleanup, openDb, statements, runQuota, reading, seededReview, branchFor,
  WORKERS, PROMPT, PROJECT_ROOT, wait
} from './showcase.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'out', 'demo')
const FRAMES = join(OUT, 'frames')
const DEBUG = process.env.DEMO_DEBUG === '1'

const DEMO_PROMPT =
  'Add a "Recently viewed" strip to the product page. Keep it server-rendered, cap it at eight items, and cover the empty case with a test.'

/** Codex · work: its billing window is the emptiest in the fleet, which is the point the caption makes. */
const ASSIGNEE = 2

const AGENT_MESSAGES = [
  'Reading the product page and the session store first. Recently viewed items can ride on the existing session cookie, so no new table is needed.',
  'Added `recentlyViewed()` to the session store (newest first, de-duplicated, capped at eight) and a server-rendered `<RecentlyViewed>` strip under the product details.',
  'Tests: the empty session renders no strip, a ninth view drops the oldest, and revisiting an item moves it to the front. `npm test` and `npm run lint` pass locally.'
]

const FINAL_MESSAGE =
  'Done. The product page now shows up to eight recently viewed items, server-rendered from the session. Three new tests cover the empty case, the cap and re-ordering.'

// ---------------------------------------------------------------------------------------------

if (!existsSync(join(ROOT, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run `npm run build` first')
  process.exit(1)
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  console.error('ffmpeg is not on PATH; it encodes the video')
  process.exit(1)
}

/**
 * Take every invented account out of dispatch and judgment through the daemon's own RPC, and prove
 * it took. ⛔ Throws rather than records: a take that could start a real CLI is not worth having.
 */
async function standDown(ui, ids) {
  const report = await ui.evaluate(`(async () => {
    const r = window.agentyard.rpc
    for (const id of ${JSON.stringify(ids.workers)}) await r('worker.update', { id, role: 'none', gradingEnabled: false })
    const fleet = await r('fleet.list')
    const settings = await r('settings.get')
    return { workers: fleet.map((e) => ({ label: e.worker.label, role: e.worker.role, grading: e.worker.gradingEnabled })), titles: settings.summariseTitles }
  })()`)
  const live = report.workers.filter((w) => w.role !== 'none' || w.grading !== false)
  if (live.length > 0 || report.titles !== false) {
    throw new Error(`refusing to record: ${JSON.stringify(report)} could still start a CLI`)
  }
}

/** Finish the seeded running tasks at `indexes` (into `TASKS`): run ended, session idle, worktree released. */
function finishSeeded(ids, indexes) {
  const db = openDb()
  try {
    db.exec('begin')
    const now = Date.now()
    for (const i of indexes) {
      // Finished hours ago, so the board still opens on the running work rather than on these.
      db.prepare("update tasks set status = 'completed', updated_at = ? where id = ?").run(now - 3 * 3_600_000, ids.tasks[i])
      db.prepare("update runs set ended_at = ?, outcome = 'completed' where id = ?").run(now - 60_000, `showcase-run-live-${i}`)
      db.prepare("update sessions set state = 'idle' where id = ?").run(`showcase-session-${i}`)
      db.prepare('delete from resource_claims where id = ?').run(`showcase-claim-${i}`)
    }
    db.exec('commit')
  } finally {
    db.close()
  }
}

/** Sessions the daemon opened on its own. The staged run's and the seeded ones are expected. */
function unstagedSessions() {
  const db = openDb()
  try {
    return db.prepare("select id, adapter_id from sessions where id not like 'showcase-%' and id not like 'demo-%'").all()
  } finally {
    db.close()
  }
}

let ui = null
const deadline = setTimeout(() => {
  console.error('the demo did not finish within 8 minutes; stopping the app')
  void ui?.close().finally(() => process.exit(2))
}, 8 * 60_000)

try {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })

  let ids
  ;({ ui, ids } = await prepare())

  await standDown(ui, ids)

  // Two running tasks, not four: Flow reads at a glance with three lanes, and it frees worktrees.
  finishSeeded(ids, [2, 3])
  await ui.evaluate('location.reload()')
  await wait(1500)
  await ui.until(() => ui.evaluate("!!document.querySelector('.dot--ok')"), 'the renderer to reload', 45_000)
  await wait(1500)

  const director = makeDirector(ui)
  await director.film(async () => await story(ui, ids, director))
  const spawned = unstagedSessions()
  if (spawned.length > 0) throw new Error(`the daemon opened sessions during the take: ${JSON.stringify(spawned)}`)
  await encode()
} finally {
  clearTimeout(deadline)
  await ui?.close()
  if (process.env.DEMO_KEEP !== '1') await cleanup()
}

// ---------------------------------------------------------------------------------------------
// The story.
// ---------------------------------------------------------------------------------------------

async function story(ui, ids, d) {
  await ui.nav('storefront')
  await ui.tab('Tasks')
  await wait(800)
  await d.caption('Five subscriptions, one board. Two tasks are already running.')
  await d.hold(4000, 'board')

  await d.caption('File a task. No model picked: Warmstart assigns one.')
  await d.press('button.titlebar-new-task')
  await wait(600)
  await d.typeSlowly('textarea[aria-label="Prompt"]', DEMO_PROMPT, 3200)
  await d.hold(1500, 'composer')
  await d.press('.task-composer-modal button.btn--primary')
  await wait(1200)

  const task = newestTask(ids)
  const stage = stager(ids, task)
  await d.caption('Routed on quality, cost and speed, to the account with the most window left.')
  stage.assign()
  await nudge(ui, task)
  await d.hold(3500, 'assigned')

  await d.pressText('.tab', 'Flow')
  await wait(900)
  await d.caption('Three tasks in parallel, each on its own branch in its own worktree.')
  await d.hold(5000, 'flow')
  await d.pressText('.tab', 'Tasks')
  await wait(900)

  await d.pressText('.tbl-title', task.title.slice(0, 24))
  await wait(900)
  await d.caption('The agent reports as it works; you can reply mid-run.')
  for (const text of AGENT_MESSAGES) {
    stage.say(text)
    await nudge(ui, task)
    await d.hold(3800, 'working')
  }

  await d.caption('The project checks run, and only then does it land on main.')
  stage.landing()
  await nudge(ui, task)
  await d.hold(2600, 'landing')
  stage.landed()
  await nudge(ui, task)
  await d.hold(3800, 'landed')

  await d.caption('Then two other vendors’ models grade the diff blind: 8.4 out of 10.')
  stage.reviewed()
  await nudge(ui, task)
  await ui.tab('Tasks')
  await d.hold(5000, 'priced')

  await d.caption('Every run feeds the trade-off: quality, speed and cost, per model.')
  await ui.nav('Statistics')
  await wait(1500)
  await ui.evaluate("document.querySelector('.scatter-plots')?.scrollIntoView({ block: 'center', behavior: 'smooth' })")
  await d.hold(6500, 'statistics')

  await d.endCard('Warmstart', 'Your subscriptions, fully used.  ·  warmstart.dev')
  await d.hold(3500, 'end')
}

/** The task the composer just filed: the newest in the project. */
function newestTask(ids) {
  const db = openDb()
  try {
    const row = db.prepare('select id, seq, title, priority, created_at from tasks where project_id = ? order by created_at desc limit 1').get(ids.project)
    if (!row || !/recently viewed/i.test(`${row.title}`)) throw new Error(`the composer did not file the demo task (newest is ${row?.title})`)
    return row
  } finally {
    db.close()
  }
}

/** Make every open view read the task again. Same priority: the change is the event, not the value. */
async function nudge(ui, task) {
  await ui.evaluate(`window.agentyard.rpc('task.setPriority', { id: ${JSON.stringify(task.id)}, priority: ${JSON.stringify(task.priority)} })`)
}

/** The staged run, one database write per beat. */
function stager(ids, task) {
  const w = WORKERS[ASSIGNEE]
  const worker = ids.workers[ASSIGNEE]
  const branch = branchFor(task.seq, task.title)
  const runId = 'demo-run'
  const sessionId = 'demo-session'
  const billing = w.windows[1][2]
  let started = 0
  let workspace = PROJECT_ROOT

  const write = (fn) => {
    const db = openDb()
    try {
      db.exec('begin')
      fn(db, statements(db))
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw error
    } finally {
      db.close()
    }
  }
  const message = (db, role, text, event = null, detail = null) =>
    db.prepare('insert into task_messages(task_id, role, text, ts, event, detail, run_id) values (?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, role, text, Date.now(), event, detail, runId)

  return {
    assign: () => write((db, s) => {
      started = Date.now()
      const pool = JSON.parse(db.prepare('select members_json from resources where id = ?').get(`workspace:${ids.project}`).members_json)
      const held = new Set(db.prepare('select member from resource_claims where resource_id = ?').all(`workspace:${ids.project}`).map((r) => r.member))
      workspace = pool.find((m) => !held.has(m)) ?? PROJECT_ROOT
      // Anything the scheduler said about a task no installed CLI could take is not part of this story.
      db.prepare('delete from task_messages where task_id = ? and role = ?').run(task.id, 'system')
      s.task.run('running', worker, branch, null, null, task.created_at, started, null, 0, null, task.id)
      db.prepare('insert into resource_claims(id, resource_id, member, holder, amount, acquired_at) values (?, ?, ?, ?, 1, ?)')
        .run('demo-claim', `workspace:${ids.project}`, workspace, task.id, started)
      db.prepare(
        `insert into sessions(id, worker_id, adapter_id, transport, project_id, cwd, model, effort, state, context_tokens,
           last_request_started_at, cache_expires_at, tokens_since_compact, started_at, purpose, current_branch)
         values (?, ?, ?, 'pipe', ?, ?, ?, 'high', 'live', ?, ?, ?, ?, ?, 'work', ?)`
      ).run(sessionId, worker, w.adapterId, ids.project, workspace, w.model, 21_300, started, started + 55 * 60_000, 3_100, started, branch)
      reading(s.quota, ids, ASSIGNEE, started - 30_000, billing)
      s.run.run(runId, task.id, ids.project, sessionId, worker, started, null, null, 1_100, 900, 42_000, 7_800, w.cost, w.adapterId, w.model,
        PROMPT, runQuota(ASSIGNEE, started - 30_000, billing), null)
      message(db, 'system', `Worker assigned: ${w.label} (${w.model})`, 'worker.assigned',
        `Routing: quality 0.81 · cost 0.88 · velocity 0.77 (score 0.83).\nWorkspace: ${workspace} on ${branch}.\nConversation: cold start.`)
    }),
    say: (text) => write((db) => message(db, 'agent', text)),
    landing: () => write((db) => message(db, 'system', `Landing \`${branch}\` onto \`main\``, 'landing.started',
      'The tool fetches the landing target, rebases this branch onto it, runs the project’s check commands where this rung asks for them, and only then merges or pushes.')),
    landed: () => write((db, s) => {
      const ended = Date.now()
      message(db, 'system', 'Landed as `3f9c2a1e` onto `main` and pushed to `origin/main`', 'landing.landed',
        'Verified: 2 project checks passed (npm test, npm run lint) on the rebased branch.')
      message(db, 'agent', FINAL_MESSAGE)
      // Priced as the movement of the billing window across the run, like every run in the history.
      reading(s.quota, ids, ASSIGNEE, ended + 20_000, billing + 0.6)
      db.prepare('update runs set ended_at = ?, outcome = ?, output_tokens = ?, quota_after_json = ? where id = ?')
        .run(ended, 'completed', 6_400, runQuota(ASSIGNEE, ended + 20_000, billing + 0.6), runId)
      db.prepare('update sessions set state = ? where id = ?').run('idle', sessionId)
      db.prepare('delete from resource_claims where id = ?').run('demo-claim')
      s.task.run('completed', worker, branch, null, null, task.created_at, ended, null, 0, null, task.id)
    }),
    reviewed: () => write((db, s) => {
      const at = Date.now()
      const graders = [0, 3] // Claude and Antigravity: never the subject's own vendor.
      const grades = graders.map((gi, k) => ({ gi, ...seededReview(8.4 + (k === 0 ? -0.1 : 0.1)) }))
      grades.forEach((g, k) => {
        const grader = WORKERS[g.gi]
        s.review.run(`demo-review-${k}`, task.id, `demo-review-run-${k}`, ids.workers[g.gi], grader.adapterId, grader.model,
          w.adapterId, w.model, JSON.stringify([{ adapterId: w.adapterId, model: w.model }]), 'demobase', 'demohead', 4, 132, 6,
          JSON.stringify(g.scores), g.composite, 'Reviewed against the rubric; no blocking findings.', at - 60_000, at)
      })
      const score = Math.round((grades.reduce((sum, g) => sum + g.composite, 0) / grades.length) * 10) / 10
      s.task.run('completed', worker, branch, null, null, task.created_at, at, score, 2, ids.workers[graders[0]], task.id)
    })
  }
}

// ---------------------------------------------------------------------------------------------
// The camera: a screencast of the page, captions and a click pulse drawn over it.
// ---------------------------------------------------------------------------------------------

function makeDirector(ui) {
  const frames = []
  let beat = 0

  const overlay = (js) => ui.evaluate(`(() => { ${js} })()`)

  return {
    frames,
    async film(scene) {
      const stop = ui.listen((msg) => {
        if (msg.method !== 'Page.screencastFrame') return
        const file = `f${String(frames.length).padStart(5, '0')}.jpg`
        writeFileSync(join(FRAMES, file), Buffer.from(msg.params.data, 'base64'))
        frames.push({ file, t: msg.params.metadata.timestamp })
        void ui.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {})
      })
      await ui.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })
      try {
        await scene()
      } finally {
        await ui.send('Page.stopScreencast').catch(() => {})
        stop()
        writeFrameList(frames)
      }
      console.log(`captured ${frames.length} frames`)
    },
    async caption(text) {
      await overlay(`
        let el = document.getElementById('demo-caption')
        if (!el) {
          el = document.createElement('div'); el.id = 'demo-caption'; document.body.appendChild(el)
          el.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;" +
            "background:rgba(10,12,18,.94);color:#eef1f7;font:600 21px/1.4 'Segoe UI',system-ui,sans-serif;padding:14px 28px;" +
            "border-radius:12px;border:1px solid rgba(122,162,247,.5);box-shadow:0 12px 40px rgba(0,0,0,.6);max-width:78%;text-align:center"
        }
        el.textContent = ${JSON.stringify(text)}
        el.animate([{ opacity: 0, transform: 'translateX(-50%) translateY(8px)' }, { opacity: 1, transform: 'translateX(-50%)' }], { duration: 350, easing: 'ease-out' })
      `)
    },
    async endCard(title, line) {
      await overlay(`
        document.getElementById('demo-caption')?.remove()
        const el = document.createElement('div'); document.body.appendChild(el)
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;" +
          "background:linear-gradient(135deg,#0f1218,#1a2036);color:#eef1f7;font-family:'Segoe UI',system-ui,sans-serif"
        el.innerHTML = '<div style="font-size:64px;font-weight:700;letter-spacing:-1px"></div><div style="font-size:26px;color:#9aa7c2"></div>'
        el.children[0].textContent = ${JSON.stringify(title)}
        el.children[1].textContent = ${JSON.stringify(line)}
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500 })
      `)
    },
    /** Pulse over the element, then click it — so a viewer sees where the click went. */
    async press(selector) {
      await this.pulse(`document.querySelector(${JSON.stringify(selector)})`)
      await ui.click(selector)
    },
    async pressText(selector, text) {
      await this.pulse(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.innerText.trim().startsWith(${JSON.stringify(text)}))`)
      await ui.clickText(selector, text)
    },
    async pulse(find) {
      const ok = await overlay(`
        const target = ${find}
        if (!target) return false
        const r = target.getBoundingClientRect()
        const dot = document.createElement('div'); document.body.appendChild(dot)
        dot.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:46px;height:46px;border-radius:50%;' +
          'border:3px solid #7aa2f7;background:rgba(122,162,247,.18);left:' + (r.left + r.width / 2 - 23) + 'px;top:' + (r.top + r.height / 2 - 23) + 'px'
        dot.animate([{ transform: 'scale(.5)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 650, easing: 'ease-out' }).finished.then(() => dot.remove())
        return true
      `)
      if (!ok) throw new Error(`nothing to press: ${find}`)
      await wait(450)
    },
    /** Type the way a person does: a few characters at a time over `ms`. */
    async typeSlowly(selector, text, ms) {
      const steps = Math.ceil(text.length / 3)
      for (let i = 1; i <= steps; i++) {
        const ok = await overlay(`
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return false
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}.slice(0, ${i * 3}))
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        `)
        if (!ok) throw new Error(`no field matches ${selector}`)
        await wait(ms / steps)
      }
    },
    async hold(ms, name) {
      await wait(ms)
      if (DEBUG) {
        const reply = await ui.send('Page.captureScreenshot', { format: 'png' }, 20_000)
        writeFileSync(join(OUT, `debug-${String(++beat).padStart(2, '0')}-${name}.png`), Buffer.from(reply.result.data, 'base64'))
      }
    }
  }
}

/** An ffconcat list that holds each frame until the next one arrived: the screencast only sends changes. */
function writeFrameList(frames) {
  if (frames.length === 0) throw new Error('the screencast sent no frames')
  const lines = ['ffconcat version 1.0']
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1.5
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(3)}`)
  })
  // ⚠️ The concat demuxer ignores the last entry's duration unless the file is listed again.
  lines.push(`file '${frames.at(-1).file}'`)
  writeFileSync(join(FRAMES, 'frames.txt'), `${lines.join('\n')}\n`)
}

async function encode() {
  const mp4 = join(OUT, 'warmstart-demo.mp4')
  const gif = join(OUT, 'warmstart-demo.gif')
  const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  ff(['-f', 'concat', '-safe', '0', '-i', join(FRAMES, 'frames.txt'),
    '-vf', 'fps=30,scale=1920:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', mp4])
  ff(['-i', mp4, '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif])
  rmSync(FRAMES, { recursive: true, force: true })
  for (const file of readdirSync(OUT).filter((f) => !f.startsWith('debug-'))) {
    console.log(`wrote out/demo/${file} (${(statSync(join(OUT, file)).size / 1e6).toFixed(1)} MB)`)
  }
}
