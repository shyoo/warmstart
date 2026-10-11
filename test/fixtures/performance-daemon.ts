/** Isolated load fixture: real store/RPC/events, four synthetic streams and two synthetic reviews.
 * No scheduler, quota poller, agent process or vendor credentials. */
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDb, db, closeDb } from '../../src/daemon/db.js'
import { loadCostModels } from '../../src/daemon/costmodel.js'
import { startServer } from '../../src/daemon/server.js'
import { setEventSink } from '../../src/daemon/events.js'
import { onShutdownRequest, requestShutdown } from '../../src/daemon/lifecycle.js'
import { getTask, requireRun } from '../../src/daemon/tasks.js'
import { bumpPricingEpoch } from '../../src/daemon/price.js'
import { adapters as registeredAdapters } from '../../src/daemon/adapters/index.js'

async function main(): Promise<void> {
for (const adapter of registeredAdapters()) {
  adapter.isInstalled = () => false
  adapter.detect = async () => ({ adapterId: adapter.info.id, found: false, path: null, version: null, error: 'isolated fixture' })
  adapter.probeIdentity = async () => ({ loggedIn: false, raw: 'isolated fixture' })
}
const root = process.env.WARMSTART_DATA_DIR!
const projectRoot = join(root, 'project')
mkdirSync(projectRoot, { recursive: true })
loadCostModels(); openDb(join(root, 'warmstart.db'))
const conn = db()
const now = Date.now()
const base = now - 80_000_000
conn.prepare("insert into projects(id,name,root,vcs,created_at) values('perf-project','Performance fixture',?,'none',?)").run(projectRoot, now)
const adapters = ['claude-code', 'openai-compatible', 'antigravity-cli']
const models = ['claude-sonnet-5', 'gpt-6.1-sol', 'gemini-3.8-flash']
const costs = ['anthropic.subscription.2026-08', 'openai.codex.2026-08', 'google.antigravity.2026-08']
for (let i = 0; i < 3; i++) conn.prepare(`insert into workers(id,label,adapter_id,isolation_root,enabled,max_concurrent,role,created_at)
  values(?,?,?,?,0,4,'worker',?)`).run(`perf-worker-${i}`, `Fixture ${i}`, adapters[i]!, join(root, `worker-${i}`), now)
const putTask = conn.prepare(`insert into tasks(id,seq,project_id,title,status,created_by_json,mandate_json,budget_json,created_at,updated_at)
  values(?,?,'perf-project',?,?,'{"kind":"human"}','{"allowed":["read"]}','{"grantedTokens":0,"spentTokens":0}',?,?)`)
const putRun = conn.prepare(`insert into runs(id,task_id,worker_id,session_id,adapter_id,model,kind,started_at,ended_at,outcome,cost_model_id)
  values(?,?,?,?,?,?,?,?,?,?,?)`)
conn.exec('begin')
for (let i = 1; i <= 1006; i++) {
  const worker = i % 3
  const active = i > 1000
  const review = i > 1004
  putTask.run(`perf-task-${i}`, i, active ? `Live fixture ${i}` : `Historical fixture ${i}`, active && !review ? 'running' : 'completed', base + i * 60_000, active ? now : base + i * 60_000)
  if (!active) {
    for (let j = 0; j < 2; j++) putRun.run(`perf-history-${i}-${j}`, `perf-task-${i}`, `perf-worker-${worker}`, null, adapters[worker]!, models[worker]!, 'work', base + i * 60_000 + j * 5000, base + i * 60_000 + j * 5000 + 4000, 'completed', costs[worker]!)
  } else {
    conn.prepare(`insert into sessions(id,worker_id,adapter_id,transport,project_id,cwd,model,state,started_at,purpose)
      values(?,?,?,'stream','perf-project',?,?,'live',?,?)`).run(`perf-session-${i}`, `perf-worker-${worker}`, adapters[worker]!, projectRoot, models[worker]!, now, review ? 'review' : 'work')
    putRun.run(`perf-run-${i}`, `perf-task-${i}`, `perf-worker-${worker}`, `perf-session-${i}`, adapters[worker]!, models[worker]!, review ? 'quality_review' : 'work', now, null, null, costs[worker]!)
  }
}
const putQuota = conn.prepare(`insert into quota_samples(worker_id,window_id,label,percent,source,sampled_at) values(?,'5h','5h',?,'fixture',?)`)
for (let i = 0; i < 80_000; i++) putQuota.run(`perf-worker-${i % 3}`, (i % 300) / 3, base + i * 1000)
conn.exec('commit')
const token = randomUUID()
const server = await startServer(token, { version: __APP_VERSION__, startedAt: now })
setEventSink(server.broadcast)
writeFileSync(join(root, 'orchestratord.json'), JSON.stringify({ pid: process.pid, port: server.port, token, startedAt: now }))
const timers: ReturnType<typeof setInterval>[] = []
for (let i = 1001; i <= 1004; i++) {
  let seq = 0
  timers.push(setInterval(() => {
    const text = `fixture stream ${i}: ${++seq}`
    server.broadcast({ type: 'session.data', sessionId: `perf-session-${i}`, data: `${text}\r\n` })
    server.broadcast({ type: 'session.stream', sessionId: `perf-session-${i}`, line: { seq, ts: Date.now(), kind: 'text', text } })
    server.broadcast({ type: 'task.activity', taskId: `perf-task-${i}`, text, ts: Date.now() })
    if (seq % 10 === 0) server.broadcast({ type: 'task.changed', task: getTask(`perf-task-${i}`)! })
  }, 100))
}
for (let i = 1005; i <= 1006; i++) timers.push(setInterval(() => {
  conn.prepare('update runs set output_tokens=output_tokens+10 where id=?').run(`perf-run-${i}`)
  bumpPricingEpoch()
  server.broadcast({ type: 'run.changed', run: requireRun(`perf-run-${i}`) })
}, 2500))
onShutdownRequest(() => {
  for (const timer of timers) clearInterval(timer)
  void server.close().then(() => { unlinkSync(join(root, 'orchestratord.json')); closeDb(); process.exit(0) })
})
process.on('message', (message) => {
  if (message === 'shutdown') requestShutdown('fixture parent asked')
})

}
void main().catch((err: unknown) => { console.error(err); process.exit(1) })
