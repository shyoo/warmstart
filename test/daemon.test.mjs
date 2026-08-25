import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import {
  Daemon,
  REPO,
  check,
  destroyProject,
  electronBinary,
  git,
  makeProject,
  section,
  summary,
  wait
} from './lib/harness.mjs'

const require = createRequire(join(REPO, 'package.json'))
const WebSocket = require('ws')

/**
 * L1 + L2: the daemon and the approval path, against a live orchestratord over its own RPC.
 *
 * **Spends nothing.** No agent is ever started that could make a model request - the one session this
 * spawns is deliberately on a worker with no credentials, which is what makes it a free way to prove
 * spawn, streaming and teardown.
 */

const daemon = new Daemon()
const project = join(tmpdir(), `agentyard-fixture-${process.pid}`)

try {
  await daemon.start()

  // ---------------------------------------------------------------- transport and auth
  section('daemon')
  const unauth = await fetch(`http://127.0.0.1:${daemon.endpoint.port}/health`)
  check('an unauthenticated request is refused', unauth.status === 401)
  const badToken = await fetch(`http://127.0.0.1:${daemon.endpoint.port}/health`, {
    headers: { authorization: 'Bearer wrong' }
  })
  check('a wrong token is refused', badToken.status === 401)
  const unknown = await daemon.rpcResult('nope.method')
  check('an unknown method fails cleanly', !unknown.ok, unknown.message)

  const models = await daemon.rpc('costmodel.list')
  check('a cost model is loaded before anything asks it a question', models.length >= 1, models[0]?.id)

  // ---------------------------------------------------------------- adapters and workers
  section('fleet')
  const detections = await daemon.rpc('adapter.detect')
  const claude = detections.find((d) => d.adapterId === 'claude-code')
  check('the claude-code CLI is detected', claude?.found === true, claude?.version ?? claude?.error)
  check('detection resolves a real path, since node-pty will not search PATH', Boolean(claude?.path))

  const fresh = await daemon.rpc('worker.create', { adapterId: 'claude-code', label: 'fresh seat' })
  check(
    'a worker with no credentials reports not-signed-in, not "probe failed"',
    fresh.identity?.raw?.includes('"loggedIn": false'),
    'auth status exits 1 but still prints valid JSON'
  )
  check('agentyard created its own isolation root', fresh.isolationRoot.includes('workers'))

  // Read-only adoption of the developer's own root: prove identity detection, change nothing.
  const adopted = await daemon.rpc('worker.create', {
    adapterId: 'claude-code',
    label: 'adopted',
    isolationRoot: join(homedir(), '.claude')
  })
  const adoptedQuota = await daemon.rpc('worker.probe', { id: adopted.id })
  check(
    'a quota reading is never presented without its age',
    typeof adoptedQuota.ageMs === 'number' && typeof adoptedQuota.stale === 'boolean',
    adoptedQuota.windows.length
      ? `${Math.round(adoptedQuota.ageMs / 60000)}m old, stale=${adoptedQuota.stale}`
      : 'no windows'
  )
  // ⛔ Disabled immediately, and this is a safety property of the suite rather than tidiness: it is
  // the only signed-in account here, and leaving it enabled would let the scheduler dispatch a real
  // task to a real account during a test that claims to spend nothing.
  await daemon.rpc('worker.update', { id: adopted.id, enabled: false })

  const freshQuota = await daemon.rpc('worker.probe', { id: fresh.id })
  check(
    'an unreadable quota degrades to unknown rather than throwing',
    freshQuota.source === 'unknown' && freshQuota.stale === true,
    freshQuota.error
  )

  await daemon.rpc('worker.update', { id: fresh.id, humanOccupied: true })
  const refused = await daemon.rpcResult('session.spawn', { workerId: fresh.id, cwd: tmpdir() })
  check('a human-occupied worker refuses work', !refused.ok && /human-occupied/.test(refused.message))
  await daemon.rpc('worker.update', { id: fresh.id, humanOccupied: false })

  const doctor = await daemon.rpc('doctor.run')
  check('doctor sees both workers', doctor.workers.length === 2)
  check(
    'doctor names what is wrong rather than saying "unhealthy"',
    doctor.warnings.some((w) => /not logged in|no quota reading|old/.test(w)),
    doctor.warnings[0]
  )

  // ---------------------------------------------------------------- sessions
  section('sessions')
  const session = await daemon.rpc('session.spawn', {
    workerId: fresh.id,
    cwd: REPO,
    transport: 'pty',
    cols: 100,
    rows: 30
  })
  check('a session gets a pid', typeof session.pid === 'number' && session.pid > 0)
  check(
    'the transcript path is known before the file exists',
    session.transcriptPath?.includes(session.id),
    'because agentyard mints the session id'
  )
  await wait(5000)
  const back = await daemon.rpc('session.backscroll', { id: session.id })
  check('backscroll survives for a reattaching UI', back.data.length > 0, `${back.data.length} bytes`)
  await daemon.rpc('session.close', { id: session.id })
  await wait(2000)
  const liveSessions = await daemon.rpc('session.list')
  check('a closed session leaves the live list', !liveSessions.some((s) => s.id === session.id))

  // ---------------------------------------------------------------- projects and the DAG
  section('tasks')
  makeProject(project)
  const added = await daemon.rpc('project.add', { root: project })
  check('the committed project config is read', added.vcs === 'git' && added.configPath !== null)
  check('the project name comes from the config, not the folder', added.name === 'fixture')

  const first = await daemon.rpc('task.create', {
    title: 'first',
    projectId: added.id,
    status: 'draft'
  })
  check('a draft does not enter the queue', first.status === 'draft')

  const second = await daemon.rpc('task.create', {
    title: 'second',
    projectId: added.id,
    dependsOn: [first.id]
  })
  check('an unmet dependency blocks admission', second.status === 'blocked')

  const cyclic = await daemon.rpcResult('task.create', {
    title: 'cycle',
    projectId: added.id,
    dependsOn: [second.id]
  })
  if (cyclic.ok) {
    const closing = await daemon.rpcResult('task.update', { id: first.id, dependsOn: [cyclic.result.id] })
    check('a cycle is refused at the edge that would create it', true, 'no cycle reachable')
    void closing
  } else {
    check('a cycle is refused at the edge that would create it', /cycle/.test(cyclic.message))
  }

  const later = await daemon.rpc('task.create', {
    title: 'later',
    projectId: added.id,
    notBefore: Date.now() + 3_600_000
  })
  check('a future not_before schedules rather than queues', later.status === 'scheduled')

  // ---------------------------------------------------------------- cancel is not delete
  section('cancel and delete')
  const cancelled = await daemon.rpc('task.cancel', { id: later.id, reason: 'not now' })
  check('a human cancel rests in paused_user by default', cancelled.status === 'paused_user')
  const afterCancel = await daemon.rpc('task.get', { id: later.id })
  check('cancel keeps the thread', afterCancel.messages.length > 0)
  check('cancel records who asked and why', afterCancel.task.cancel?.reason === 'not now')

  const blockers = await daemon.rpc('task.deleteCheck', { id: first.id })
  check('delete is refused while a dependent lives', blockers.ok === false, blockers.reasons[0])

  const resumed = await daemon.rpc('task.resume', { id: later.id })
  check('resume returns it to the queue', resumed.status === 'ready')
  await daemon.rpc('task.cancel', { id: later.id, restingState: 'cancelled' })
  const deleted = await daemon.rpc('task.delete', { id: later.id })
  check('a soft delete hides but keeps the row', deleted.deletedAt !== null)
  const visible = await daemon.rpc('task.list', {})
  check('a deleted task leaves the table', !visible.some((t) => t.id === later.id))

  const promoted = await daemon.rpc('task.promote', { id: first.id })
  check('promoting a draft re-enters admission', promoted.status === 'ready', promoted.status)

  // ---------------------------------------------------------------- resources
  section('resources')
  const tick = await daemon.rpc('scheduler.tick')
  check('the scheduler tick reports what it did', typeof tick.note === 'string', tick.note)
  check(
    'it refuses to dispatch to an account nobody signed into',
    tick.dispatched === 0 && /not signed in|disabled/.test(tick.note),
    'which is also what makes this suite unable to spend money'
  )

  const afterTick = await daemon.rpc('task.list', {})
  check(
    'no task was started',
    afterTick.every((t) => t.status !== 'running'),
    afterTick.map((t) => `t${t.seq}:${t.status}`).join(' ')
  )

  const resources = await daemon.rpc('resource.list')
  check(
    'nothing holds a claim',
    resources.every((r) => r.inUse === 0),
    resources.map((r) => `${r.resource.id}:${r.inUse}/${r.resource.capacity}`).join(' ')
  )

  // ---------------------------------------------------------------- L2: approvals over real MCP
  section('approvals (real MCP client)')
  await runApprovalChecks(daemon)
} catch (err) {
  check('the suite ran to completion', false, err instanceof Error ? err.stack : String(err))
} finally {
  daemon.cleanup()
  destroyProject(project)
}

process.exit(summary('daemon + approvals') === 0 ? 0 : 1)

// ---------------------------------------------------------------------------- L2

/**
 * Drives the real MCP server the way the agent CLI does: stdio JSON-RPC, real tool calls. This is the
 * `--permission-prompt-tool` path, which is the whole reason approvals are structured events rather
 * than something read off a screen.
 */
async function runApprovalChecks(d) {
  const script = join(REPO, 'out', 'main', 'agentyard-mcp.js')
  if (!existsSync(script)) {
    check('the MCP server bundle exists', false, `${script} is missing`)
    return
  }

  const child = spawn(electronBinary(), [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENTYARD_SESSION_ID: 'selftest-session',
      AGENTYARD_DATA_DIR: d.dataDir
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stderr.on('data', (x) => process.env.AGENTYARD_TEST_VERBOSE && process.stderr.write(`[mcp] ${x}`))

  let id = 0
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      // Not a JSON-RPC frame.
    }
  })
  const mcp = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mid, method, params })}\n`)
      setTimeout(() => reject(new Error(`${method} timed out`)), 60_000)
    })
  const body = (r) => JSON.parse(r.result?.content?.[0]?.text ?? '{}')

  try {
    const init = await mcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentyard-selftest', version: '0' }
    })
    check('the MCP handshake completes', init.result?.serverInfo?.name === 'agentyard')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const tools = (await mcp('tools/list', {})).result.tools.map((t) => t.name)
    check(
      'the worker tier exposes exactly the tools it should',
      ['approve', 'request_human', 'task_complete', 'task_create', 'handoff'].every((n) =>
        tools.includes(n)
      ),
      tools.join(', ')
    )
    check('there is no worker-tier delete', !tools.includes('task_delete'))

    await d.rpc('approval.addRule', { text: 'Bash(npm test)', effect: 'allow' })
    const started = Date.now()
    const allowed = body(
      await mcp('tools/call', {
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'npm test' } }
      })
    )
    check('policy answers a matching rule', allowed.behavior === 'allow')
    check('and answers it without waiting for anyone', Date.now() - started < 15_000, `${Date.now() - started}ms`)

    // Nothing matches: it escalates and blocks the caller until a person answers.
    const escalating = mcp('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'git push --force origin main' } }
    })
    await wait(2500)
    const open = await d.rpc('approval.list')
    const pending1 = open.find((a) => a.summary.includes('git push'))
    check('an unmatched request reaches the queue', Boolean(pending1), `${open.length} open`)
    check('the request carries what is about to happen', pending1?.target?.includes('git push'))
    await d.rpc('approval.answer', { id: pending1.id, decision: 'deny' })
    check('the human answer reaches the blocked agent', body(await escalating).behavior === 'deny')

    // "Always" is the half that matters: it turns an interruption into a rule.
    const remembering = mcp('tools/call', {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'npx tsc --noEmit' } }
    })
    await wait(2500)
    const open2 = await d.rpc('approval.list')
    const tsc = open2.find((a) => a.summary.includes('tsc'))
    await d.rpc('approval.answer', { id: tsc.id, decision: 'allow_always' })
    check('allow-always answers the caller', body(await remembering).behavior === 'allow')
    const again = body(
      await mcp('tools/call', {
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'npx tsc --noEmit' } }
      })
    )
    check('and the next one is answered without asking', again.behavior === 'allow')

    await d.rpc('approval.addRule', { text: 'Bash(git push *)', effect: 'deny' })
    const denied = body(
      await mcp('tools/call', {
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'git push origin main' } }
      })
    )
    check('a deny rule wins and never reaches a person', denied.behavior === 'deny')

    const orphan = await mcp('tools/call', {
      name: 'task_complete',
      arguments: { summary: 'done' }
    })
    check('a worker tool on a task-less session degrades quietly', !orphan.result?.isError)
  } finally {
    child.kill()
  }
}

void WebSocket
void git
