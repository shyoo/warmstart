import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  Daemon,
  check,
  destroyProject,
  git,
  makeProject,
  section,
  summary,
  wait
} from './lib/harness.mjs'

/**
 * L4: agent in the loop.
 *
 * ⚠️ **This one spends real quota** on whichever account it adopts. It is gated behind
 * `WARMSTART_E2E=1` and must never run in a watch loop or in CI.
 *
 * It exists because it is the only level that can prove the thing the product actually claims: that
 * work filed as a task ends up committed on the trunk without anyone watching. Everything else here
 * is scaffolding around that single assertion list.
 */

if (process.env.WARMSTART_E2E !== '1') {
  console.log('L4 skipped. It spends real quota; set WARMSTART_E2E=1 to run it.')
  process.exit(0)
}

const daemon = new Daemon()
const root = join(tmpdir(), `agentyard-e2e-${process.pid}`)
const TIMEOUT_MS = 8 * 60 * 1000

try {
  await daemon.start()
  const fixture = makeProject(root, { name: 'e2e' })
  const project = await daemon.rpc('project.add', { root })

  // Adopting an already-signed-in root, read-only. The test never logs in or out.
  const worker = await daemon.rpc('worker.create', {
    adapterId: 'claude-code',
    label: 'e2e',
    isolationRoot: join(homedir(), '.claude')
  })
  if (!check('the adopted account is signed in', worker.identity?.raw?.includes('"loggedIn": true'))) {
    throw new Error('no signed-in account to run against')
  }

  section('one real task')
  const task = await daemon.rpc('task.create', {
    title:
      'Create a file named HELLO.md whose only content is the line: hello from agentyard. ' +
      'Then commit it with the message "add HELLO.md". Nothing else.',
    projectId: project.id,
    priority: 'P0'
  })
  console.log(`  dispatching t${task.seq} — this spends real quota`)

  const deadline = Date.now() + TIMEOUT_MS
  let view = null
  let last = ''
  while (Date.now() < deadline) {
    await wait(5000)
    view = await daemon.rpc('task.get', { id: task.id })
    if (view.task.status !== last) {
      last = view.task.status
      console.log(`  t${task.seq}: ${last}`)
    }
    if (['completed', 'failed', 'awaiting_human'].includes(view.task.status)) break
  }

  for (const m of view.messages) console.log(`  [${m.role}] ${m.text.slice(0, 200)}`)

  check('the task reached a terminal state', view.task.status === 'completed', view.task.status)
  const run = view.runs[0]
  check('a run was recorded', Boolean(run))
  check(
    'the run was metered from the transcript, not estimated',
    (run?.inputTokens ?? 0) + (run?.outputTokens ?? 0) + (run?.cacheReadTokens ?? 0) > 0,
    run && `in=${run.inputTokens} out=${run.outputTokens} cacheRead=${run.cacheReadTokens}`
  )
  check(
    'a dispatch made without a trustworthy quota reading is marked, not hidden',
    typeof run?.quotaUnverified === 'boolean',
    `quotaUnverified=${run?.quotaUnverified}`
  )
  check(
    'the branch is named after the task, never the workspace',
    (view.task.branch ?? '').includes(`t${task.seq}`),
    view.task.branch ?? 'none'
  )

  section('landing')
  const originLog = git(fixture.origin, 'log', '--oneline', 'main')
  check('the work landed on origin/main', originLog.includes('add HELLO.md'), originLog.split('\n')[0])
  check(
    'agents never worked in the trunk',
    !existsSync(join(root, 'HELLO.md')),
    'HELLO.md must not appear in the trunk checkout'
  )
  check('the trunk stayed on its branch', git(root, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main')

  const resources = await daemon.rpc('resource.list')
  const pool = resources.find((r) => r.resource.id === `workspace:${project.id}`)
  check('the workspace pool was created', Boolean(pool), `${pool?.resource.members.length} members`)
  check('every claim was released, on both holders', pool?.inUse === 0, `inUse=${pool?.inUse}`)
} catch (err) {
  check('the suite ran to completion', false, err instanceof Error ? err.stack : String(err))
} finally {
  daemon.cleanup()
  destroyProject(root)
}

process.exit(summary('agent in the loop') === 0 ? 0 : 1)
