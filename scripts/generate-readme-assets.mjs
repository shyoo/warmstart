/**
 * Build the README gallery from the real renderer against an isolated showcase fleet.
 * Run `npm run build` first, then `node scripts/generate-readme-assets.mjs`.
 */
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { freePort, killTree } from '../test/lib/harness.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const ASSETS = join(ROOT, 'docs', 'images')
const DATA = mkdtempSync(join(tmpdir(), 'warmstart-showcase-'))
const require = createRequire(join(ROOT, 'package.json'))
const WebSocket = require('ws')
const electron = require('electron')
const port = await freePort()
let app
let socket
let rpcId = 0
const pending = new Map()

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
async function until(fn, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch { /* renderer is starting */ }
    await wait(200)
  }
  throw new Error('timed out waiting for the showcase renderer')
}

function send(method, params = {}) {
  return new Promise((resolveSend, reject) => {
    const id = ++rpcId
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolveSend(v) } })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluation failed')
  return reply.result?.result?.value
}

async function click(text, scope = 'document') {
  const found = await evaluate(`(() => { const root=${scope}; const el=[...root.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)}); el?.click(); return !!el })()`)
  if (!found) throw new Error(`could not find button ${text}`)
  await wait(900)
}

async function nav(text) {
  const found = await evaluate(`(() => { const el=[...document.querySelectorAll('.nav-item')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(text)})); el?.click(); return !!el })()`)
  if (!found) throw new Error(`could not find navigation item ${text}`)
  await wait(1200)
}

async function shot(name) {
  await evaluate('window.scrollTo(0,0)')
  const reply = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(ASSETS, name), Buffer.from(reply.result.data, 'base64')))
  console.log(`wrote docs/images/${name}`)
}

try {
  if (!existsSync(join(ROOT, 'out', 'renderer', 'index.html'))) throw new Error('run npm run build first')
  mkdirSync(ASSETS, { recursive: true })
  const env = { ...process.env, WARMSTART_DATA_DIR: DATA, WARMSTART_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(electron, [ROOT, '--disable-gpu', `--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true })
  const page = await until(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const pages = await res.json()
    return pages.find((p) => p.type === 'page')
  })
  socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    const entry = msg.id ? pending.get(msg.id) : undefined
    if (entry) {
      pending.delete(msg.id)
      entry.resolve(msg)
    }
  })
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject) })
  await until(() => evaluate("!!document.querySelector('.dot--ok')"))

  const seeded = await evaluate(`(async()=>{
    const r=window.agentyard.rpc;
    const workers=[];
    workers.push(await r('worker.create',{adapterId:'claude-code',label:'Claude · Product',enabled:false}));
    workers.push(await r('worker.create',{adapterId:'codex',label:'Codex · Engineering',enabled:false}));
    workers.push(await r('worker.create',{adapterId:'muse-code',label:'Muse · Research',enabled:false}));
    const project=await r('project.add',{root:${JSON.stringify(ROOT)},name:'Warmstart'});
    const specs=[
      ['Polish onboarding and empty states','P1'],['Add keyboard shortcuts palette','P2'],
      ['Investigate flaky Windows packaging','P1'],['Review routing cost calibration','P2'],
      ['Ship mobile approval notifications','P2'],['Document plugin integration','P3']
    ];
    const tasks=[];
    for(const [title,priority] of specs) tasks.push(await r('task.create',{projectId:project.id,title,priority,prompt:'Please take ownership of this work, explain your choices, and leave the repository ready to land.'}));
    return {workers:workers.map(w=>w.id),project:project.id,tasks:tasks.map(t=>t.id)};
  })()`)

  const db = new DatabaseSync(join(DATA, 'warmstart.db'))
  const now = Date.now()
  const quotas = [[seeded.workers[0],38,61],[seeded.workers[1],54,27],[seeded.workers[2],18,43]]
  for (const [worker, short, long] of quotas) {
    db.prepare('insert into quota_samples(worker_id,window_id,label,percent,resets_at,source,sampled_at) values(?,?,?,?,?,?,?)').run(worker,'5h','5h',short,now+2.4e6,'showcase fixture',now-42_000)
    db.prepare('insert into quota_samples(worker_id,window_id,label,percent,resets_at,source,sampled_at) values(?,?,?,?,?,?,?)').run(worker,'7d','7d',long,now+3.2e8,'showcase fixture',now-42_000)
  }
  const states = ['running','running','awaiting_human','blocked','ready','completed']
  seeded.tasks.forEach((id, i) => db.prepare('update tasks set status=?,assignee=?,branch=?,hold_reason=?,updated_at=? where id=?').run(states[i], seeded.workers[i%3], `warmstart/t${i+1}-showcase`, i===2?'Choose whether to keep backward compatibility with the legacy config format.':i===3?'Waiting for a free workspace slot.':null, now-i*420_000,id))
  for (let i=0;i<2;i++) db.prepare('insert into sessions(id,worker_id,adapter_id,transport,project_id,cwd,model,effort,state,context_tokens,last_request_started_at,cache_expires_at,tokens_since_compact,started_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`showcase-session-${i}`,seeded.workers[i],i?'codex':'claude-code','pipe',seeded.project,ROOT,i?'gpt-5.6-codex':'claude-sonnet-4-6','high','busy',18400+i*6200,now-90_000,now+2600_000,4200,now-1800_000)
  const thread=seeded.tasks[0]
  const messages=[
    ['user','Please make the first-run experience feel obvious. Focus on the empty state, progressive disclosure, and a path to filing the first task.'],
    ['assistant','I’ll map the current first-run path, then tighten the copy and interaction without changing the scheduler contract. I’m starting with the project setup and empty fleet states.'],
    ['assistant','I found the main friction: the screen explains implementation details before it gives the operator a next action. I’ve replaced that with one clear choice and kept the diagnostics behind “Why can’t I start?”'],
    ['assistant','The focused checks are green. I’m reviewing the final diff now and will leave the exact behavior changes in the handoff.']
  ]
  messages.forEach(([role,text],i)=>db.prepare('insert into task_messages(task_id,role,text,ts) values(?,?,?,?)').run(thread,role,text,now-(messages.length-i)*95_000))
  for(let i=0;i<18;i++){
    const task=seeded.tasks[i%seeded.tasks.length]
    db.prepare('insert into runs(id,task_id,project_id,worker_id,started_at,ended_at,outcome,quota_unverified,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_model_id,note,adapter_id,model,effort) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`showcase-run-${i}`,task,seeded.project,seeded.workers[i%3],now-(i+4)*86400000,now-(i+4)*86400000+(22+i%7)*60000,'completed',0,9000+i*850,700+i*45,6200+i*500,800,'anthropic.subscription.2026-08','showcase measurement',i%3===0?'claude-code':i%3===1?'codex':'muse-code',i%3===1?'gpt-5.6-codex':'claude-sonnet-4-6',i%2?'high':'medium')
  }
  db.close()
  await evaluate(`window.agentyard.rpc('worker.update',{id:${JSON.stringify(seeded.workers[0])},enabled:false})`)
  await wait(1500)

  await nav('Dashboard'); await shot('fleet-overview.png')
  await nav('Warmstart'); await click('Tasks'); await shot('parallel-tasks.png')
  await evaluate(`(()=>{const row=[...document.querySelectorAll('tbody tr')].find(r=>r.innerText.includes('Polish onboarding')); row?.click(); return !!row})()`); await wait(1200); await shot('agent-thread.png')
  await click('Flow'); await shot('work-flow.png')
  await evaluate(`document.querySelector('button[aria-label="New task"]')?.click()`); await wait(600); await click('Debate', "document.querySelector('.task-composer-modal')"); await shot('debate-mode.png'); await evaluate(`document.querySelector('button[aria-label="Close new task"]')?.click()`)
  await nav('Routing Model'); await shot('routing-overview.png')
  await click('Quality'); await shot('routing-quality.png')
  await click('Cost'); await shot('routing-cost.png')
  await click('Velocity'); await shot('routing-velocity.png')
  await nav('Statistics'); await shot('fleet-statistics.png')
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close') } catch { /* the process may already have closed */ }
  }
  socket?.close()
  if (app?.pid && app.exitCode === null) killTree(app.pid, 'electron')
  try { rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch (error) {
    console.warn(`showcase scratch data remains at ${DATA}: ${error.message}`)
  }
}
