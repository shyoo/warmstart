import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import {
  Daemon,
  PROBE_ARGV,
  PROBE_ID,
  REPO,
  check,
  checkBuildIsCurrent,
  destroyProject,
  detectClis,
  electronBinary,
  git,
  makeProject,
  section,
  skip,
  summary,
  wait,
  writeProbeAdapter
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
  // ⚠️ Before the daemon starts: adapters are read once at boot. See `writeProbeAdapter`.
  writeProbeAdapter(daemon.dataDir)
  await daemon.start()

  // ---------------------------------------------------------------- transport and auth
  // ⛔ Before anything else: this suite drives `out/` and does not build it.
  section('daemon')
  checkBuildIsCurrent()
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
  // ⛔ A bare CI runner has no agent CLI, and that is a normal machine rather than a broken one.
  // Everything about scheduling, tasks, cancellation, approvals, the controller and the cost
  // arithmetic is testable without one; only *spawning a real agent* needs a real binary. So the
  // CLI-dependent checks are skipped **visibly**, with a reason, and the summary counts them.
  const clis = await detectClis(daemon)
  const detections = clis.all
  const claude = detections.find((d) => d.adapterId === 'claude-code')

  // ⛔ The three built-ins by name, not a count. A length check also asserted that nobody ever
  // declares an external adapter - which M6 exists to allow, and this suite now does itself.
  check(
    'every adapter answers detection rather than throwing',
    ['claude-code', 'antigravity-cli', 'openai-compatible'].every((id) =>
      detections.some((d) => d.adapterId === id)
    ) && detections.every((d) => typeof d.found === 'boolean'),
    detections.map((d) => `${d.adapterId}:${d.found ? d.version : 'absent'}`).join(' ')
  )
  check(
    'an absent CLI is reported with a reason, not a bare false',
    detections.every((d) => d.found || (d.error ?? '').length > 0),
    detections.find((d) => !d.found)?.error ?? 'all present'
  )

  if (clis.has('claude-code')) {
    check(
      'detection resolves a real path, since node-pty will not search PATH',
      Boolean(claude?.path),
      claude?.path
    )
  } else {
    skip('detection resolves a real path', 'claude is not installed here')
  }

  const fresh = await daemon.rpc('worker.create', { adapterId: 'claude-code', label: 'fresh seat' })
  if (clis.has('claude-code')) {
    check(
      'a worker with no credentials reports not-signed-in, not "probe failed"',
      fresh.identity?.raw?.includes('"loggedIn": false'),
      'auth status exits 1 but still prints valid JSON'
    )
  } else {
    // ⛔ Still a real assertion, not a shrug. With no binary at all the honest answer is *unknown*
    // with a stated reason - never `false`, which would read as "we asked and nobody is signed in".
    check(
      'with no CLI installed, sign-in state is unknown with a reason, never a confident false',
      fresh.identity?.loggedIn !== false && (fresh.identity?.raw ?? '').length > 0,
      (fresh.identity?.raw ?? '').slice(0, 80)
    )
  }
  check('agentyard created its own isolation root', fresh.isolationRoot.includes('workers'))

  // Read-only adoption of the developer's own root: prove identity detection, change nothing.
  // ⚠️ Only where such a root exists. On a runner it does not, and inventing one would prove nothing.
  const realRoot = join(homedir(), '.claude')
  const adopted = existsSync(realRoot)
    ? await daemon.rpc('worker.create', {
        adapterId: 'claude-code',
        label: 'adopted',
        isolationRoot: realRoot,
        // ⛔ Closed to work at creation, not a line later. This is the only signed-in account here,
        // and the scheduler ticks every ten seconds - "disable it straight after" is not soon enough
        // for a suite that claims it cannot spend.
        enabled: false
      })
    : null

  if (adopted) {
    const adoptedQuota = await daemon.rpc('worker.probe', { id: adopted.id })
    check(
      'a quota reading is never presented without its age',
      typeof adoptedQuota.ageMs === 'number' && typeof adoptedQuota.stale === 'boolean',
      adoptedQuota.windows.length
        ? `${Math.round(adoptedQuota.ageMs / 60000)}m old, stale=${adoptedQuota.stale}`
        : 'no windows'
    )
  } else {
    skip('a quota reading is never presented without its age', `no credential root at ${realRoot}`)
  }

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
  check(
    'doctor sees every commissioned worker',
    doctor.workers.length === (adopted ? 2 : 1),
    `${doctor.workers.length} worker(s)`
  )
  check(
    'doctor names what is wrong rather than saying "unhealthy"',
    doctor.warnings.some((w) => /not logged in|no quota reading|old/.test(w)),
    doctor.warnings[0]
  )

  // ---------------------------------------------------------------- sessions
  section('sessions')
  // ⛔ The one section that genuinely cannot run without a binary: it starts a real process in a real
  // pseudo-terminal. The session it spawns is deliberately on a worker with **no credentials**, which
  // is what makes proving spawn, streaming and teardown free.
  if (!clis.has('claude-code')) {
    skip('a session gets a pid', 'claude is not installed here')
    skip('the transcript path is known before the file exists', 'no CLI to spawn')
    skip('backscroll survives for a reattaching UI', 'no CLI to spawn')
    skip('a closed session leaves the live list', 'no CLI to spawn')

    // Worth proving even with nothing installed: a spawn that cannot find its CLI must fail with a
    // message naming the command, not with an opaque ENOENT from somewhere inside node-pty.
    const missing = await daemon.rpcResult('session.spawn', {
      workerId: fresh.id,
      cwd: REPO,
      transport: 'pty'
    })
    check(
      'a spawn with no CLI installed fails by name rather than opaquely',
      !missing.ok && /not on PATH|claude/i.test(missing.message ?? ''),
      missing.message
    )
  } else {
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
    check(
      'backscroll survives for a reattaching UI',
      back.data.length > 0,
      `${back.data.length} bytes`
    )
    await daemon.rpc('session.close', { id: session.id })
    await wait(2000)
    const liveSessions = await daemon.rpc('session.list')
    check('a closed session leaves the live list', !liveSessions.some((s) => s.id === session.id))
  }

  // ---------------------------------------------------------------- a session that exits at once
  section('short-lived sessions')
  // ⛔ A regression, and it was a real defect rather than a flaky check. `handleExit` dropped the
  // entry from `live`, `emitData` returned early without one, and `backscroll` read `live` - so a
  // process that wrote and exited in the same tick lost every byte, and anything asking afterwards
  // got ''. Windows never showed it: conpty delivers data before the exit. Linux CI did.
  //
  // ⚠️ The output most worth keeping is exactly this shape: a `login` session that fails prints its
  // reason and exits, and the pane went blank at that moment.
  const probeWorker = await daemon.rpc('worker.create', {
    adapterId: PROBE_ID,
    label: 'exit probe',
    // ⛔ Closed to work, like every worker this suite commissions.
    enabled: false
  })
  const probeSession = await daemon.rpc('session.spawn', {
    workerId: probeWorker.id,
    cwd: tmpdir(),
    transport: 'pty',
    purpose: 'login',
    argv: PROBE_ARGV,
    cols: 80,
    rows: 24
  })
  check('a probe session opens a pseudo-terminal', typeof probeSession.pid === 'number')

  // ⛔ Both conditions, in one loop: the session must be *gone from the live list*, and the read must
  // still return what it said. Checking only the second would pass on a session that had not exited
  // yet - which is the state that already worked and is not the bug.
  const goneBy = Date.now() + 20_000
  let gone = false
  let said = ''
  while (Date.now() < goneBy) {
    // ⛔ Absent from the list, full stop. `session.list` already excludes closed and failed, so
    // that *is* "no longer live". Written as `state === 'running'` this was vacuous - there is no
    // such state (`starting | live | idle | closed | failed`), so `gone` was true on the first
    // iteration and the check passed against the unfixed daemon. Verified by reverting the fix and
    // watching it fail.
    gone = !(await daemon.rpc('session.list', {})).some((x) => x.id === probeSession.id)
    said = (await daemon.rpc('session.backscroll', { id: probeSession.id })).data ?? ''
    if (gone && said.length > 0) break
    await wait(250)
  }
  check(
    'a session that has already exited still knows what it said',
    gone && said.includes('agentyard-pty-probe'),
    gone ? `${said.length} bytes after exit` : 'the session never left the live list'
  )

  // ⛔ The bug that made commissioning useless. Identity was written once at `worker.create` - when
  // the true answer is "nobody is signed in yet" - and nothing ever read it again. A worker signed
  // in successfully therefore kept `loggedIn: false` for the rest of its life, and the scheduler's
  // gate refused to dispatch to it forever. The sign-in appeared to work and produced a dead seat.
  //
  // ⚠️ The probe adapter cannot report a real sign-in, and does not need to: what must be true is
  // that a *login* session ending causes identity to be read **again**, which `checkedAt` shows.
  const identityBefore = probeWorker.identity?.checkedAt ?? 0
  const readAgainBy = Date.now() + 15_000
  let identityAfter = identityBefore
  while (Date.now() < readAgainBy && identityAfter <= identityBefore) {
    const entry = (await daemon.rpc('fleet.list')).find((x) => x.worker.id === probeWorker.id)
    identityAfter = entry?.worker.identity?.checkedAt ?? 0
    if (identityAfter <= identityBefore) await wait(250)
  }
  check(
    'a login session ending makes agentyard re-read who is signed in',
    identityAfter > identityBefore,
    identityAfter > identityBefore
      ? `re-read ${identityAfter - identityBefore}ms after commissioning`
      : 'identity was never read a second time'
  )

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

  // ---------------------------------------------------------------- continuing a task
  //
  // ⛔ Measured 2026-08-27: a reply typed at a finished task went into the still-warm session and
  // produced nothing anybody could see - no run, no metering, no status, no landing. The UI said it
  // was "prepended to the next run's prompt", which is true of the code and false of the world,
  // because a finished task has no next run.
  section('a reply continues the task')
  const finished = await daemon.rpc('task.create', { title: 'answer me', projectId: added.id })
  await daemon.rpc('task.cancel', { id: finished.id, restingState: 'paused_user' })
  const replied = await daemon.rpc('task.message', { id: finished.id, text: 'now commit it' })
  check(
    'saying something to a stopped task starts another run on it',
    replied.outcome === 'requeued',
    replied.outcome
  )
  const woken = (await daemon.rpc('task.list', {})).find((t) => t.id === finished.id)
  check('and the task goes back in the queue rather than waiting forever', woken?.status === 'ready')
  check(
    'it is the same task, not a new one',
    (await daemon.rpc('task.list', {})).filter((t) => t.title === 'answer me').length === 1,
    'a continuation is a run on one thread; filing a second task would split the history'
  )
  const thread = await daemon.rpc('task.get', { id: finished.id })
  check(
    'and the thread records why it ran again',
    thread.messages.some((m) => /same thread, a new run/.test(m.text))
  )
  await daemon.rpc('task.cancel', { id: finished.id, restingState: 'cancelled' })

  // ---------------------------------------------------------------- the decision it is asking for
  //
  // ⛔ `awaiting_human` is the one status explicitly about the operator, and it was the only one they
  // could not act on. Measured 2026-08-27: t3's work was done and committed by hand, landing declined
  // it, and the task sat there next to a run marked `completed` — the only exits being to cancel work
  // that had succeeded or delete the record of it.
  section('answering a task that waits on a person')
  const waiting = await daemon.rpc('task.create', { title: 'needs a decision', projectId: added.id })
  const blocked = await daemon.rpc('task.create', {
    title: 'waits on the decision',
    projectId: added.id,
    dependsOn: [waiting.id]
  })
  check('a dependent starts blocked', blocked.status === 'blocked')

  const resolved = await daemon.rpc('task.resolve', { id: waiting.id, note: 'checked it myself' })
  check('a person can record that they are satisfied', resolved.status === 'completed')
  const judged = await daemon.rpc('task.get', { id: waiting.id })
  check(
    'and it is written down as a judgement, not as a verification',
    judged.messages.some((m) => /Marked done by you: checked it myself/.test(m.text)),
    'task_complete stays the only signal that an agent finished'
  )
  // ⛔ The DAG's only moving part. The scheduler carried a private copy of admitDependents that
  // re-set each dependent to the status it already had, so no completed task ever unblocked anything.
  const released = (await daemon.rpc('task.list', {})).find((t) => t.id === blocked.id)
  check(
    'finishing a task releases what was waiting on it',
    released?.status === 'ready',
    released?.status
  )
  await daemon.rpc('task.cancel', { id: blocked.id, restingState: 'cancelled' })

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
    // ⚠️ Three refusals, not one. "Not signed in" is the interesting case, but a bare CI runner never
    // reaches it: the not-installed gate fires first and holds with a different sentence. Matching
    // only the sentence this machine happens to produce is how a suite starts asserting where it is
    // running rather than what the code does — CI found exactly that here.
    //
    // ⛔ What must hold on every machine is `dispatched === 0` **with a reason from the closed set**.
    // A hold for some fourth reason is not the same result, and is not allowed to pass quietly.
    'it refuses to dispatch to a seat that is not installed, not signed in, or disabled',
    tick.dispatched === 0 && /not installed|not signed in|disabled/.test(tick.note),
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

  // ---------------------------------------------------------------- cost intelligence
  section('cost')
  const cost = await daemon.rpc('cost.report')
  check('the objective is a unit vector', Math.abs(
    cost.objective.cost + cost.objective.velocity + cost.objective.quality - 1
  ) < 0.001)
  // ⛔ Against the fleet doctor sees, never a literal. This said `=== 2`, which was true only on a
  // machine with a `~/.claude` to adopt read-only; a runner commissions one worker and the check
  // failed for having nothing to fail about. The claim is *every* worker, so count the workers.
  // ⚠️ Doctor asked again here, not reused from the fleet section. More workers have been
  // commissioned since, and a stale count is the same class of mistake as the literal it replaced.
  const fleetNow = await daemon.rpc('doctor.run')
  check(
    'every worker gets a reserve verdict',
    cost.reserves.length === fleetNow.workers.length,
    `${cost.reserves.length} reserve(s) for ${fleetNow.workers.length} worker(s)`
  )
  check(
    'a worker holding nothing needs no reserve',
    cost.reserves.every((r) => r.liveSessions > 0 || r.requiredTokens === 0),
    cost.reserves.map((r) => `${r.verdict}:${r.requiredTokens}`).join(' ')
  )
  check(
    'an unknown remaining budget is reported as unknown, never as a number',
    cost.workers.every((w) => w.remainingTokens === null || typeof w.remainingTokens === 'number')
  )
  check(
    'every belief carries its basis',
    cost.workers.every((w) => typeof w.remainingBasis === 'string' && w.remainingBasis.length > 0),
    cost.workers[0]?.remainingBasis
  )
  check(
    'human latency has a measured default rather than a magic number',
    cost.medianHumanLatencyMs > 0,
    `${Math.round(cost.medianHumanLatencyMs / 60000)}m`
  )
  check(
    'the clock reports a decision for every live session',
    Array.isArray(cost.decisions),
    `${cost.decisions.length} decision(s)`
  )
  check(
    'a session with no cached prefix is left alone',
    cost.decisions.every((d) => d.move !== 'keepalive' || d.expiresAt !== null),
    'a keepalive on a session with nothing cached would be pure waste'
  )

  // ---------------------------------------------------------------- M5: multi-provider
  //
  // ⛔ Against the **real, installed CLIs**. codex 0.149.1 and agy 1.1.20 were installed on this
  // machine on 2026-08-25, which is what turned two adapters written from documentation into two
  // adapters that were measured - and corrected several claims that would have failed on first
  // spawn. Nothing here signs in, prompts, or spends: detection and commissioning only.
  section('multi-provider')

  const all = await daemon.rpc('adapter.list')
  // ⚠️ At least the three built-ins, each with its verification level. An exact count would fail the
  // moment anyone declares an external adapter, which is a supported thing to do.
  check(
    'three adapters are registered',
    ['claude-code', 'antigravity-cli', 'openai-compatible'].every((id) =>
      all.some((a) => a.id === id)
    ),
    all.map((a) => `${a.id} (${a.verification.level})`).join(', ')
  )

  const detected = await daemon.rpc('adapter.detect')
  for (const d of detected) {
    // ⚠️ Asserts the *shape of the answer*, not that the CLI exists. A runner with none installed
    // still proves that every adapter reports rather than throws, which is the contract.
    check(
      `${d.adapterId} detection answers rather than throwing`,
      typeof d.found === 'boolean' && (d.found ? Boolean(d.path) : Boolean(d.error)),
      d.found ? `v${d.version} at ${d.path}` : d.error
    )
  }

  const agy = all.find((a) => a.id === 'antigravity-cli')
  const codex = all.find((a) => a.id === 'openai-compatible')

  // ---- the capability consequences, read from the daemon rather than from the source ----
  check(
    'an adapter without compaction falls back to a handoff wrap-up',
    agy?.capabilities.manualCompact === false && agy?.policy.wrapUpProtocol === 'handoff',
    'plan §9: no /compact is not a special case - it removes two cache-clock moves'
  )
  check(
    'a classifier-less adapter never defaults to an auto mode',
    all
      .filter((a) => !a.capabilities.classifierBackedAuto)
      .every((a) => a.policy.defaultPermissionMode !== 'auto'),
    `agy defaults to '${agy?.policy.defaultPermissionMode}' - what plan §9.1 predicted`
  )
  check(
    'an adapter with no credential isolation is capped at one account',
    agy?.isolationEnvVar === null && agy?.capabilities.maxAccounts === 1,
    'credentials live in the OS keyring; there is no directory to point elsewhere'
  )
  check(
    'an adapter with a config-dir variable is not capped',
    codex?.isolationEnvVar === 'CODEX_HOME' && codex?.capabilities.maxAccounts === null,
    'two CLIs, both without a classifier, and only one can hold a fleet'
  )
  check(
    'an adapter with no readable transcript says where its numbers come from instead',
    agy?.capabilities.metering === 'stream',
    'agy writes conversations as SQLite, so the tailer reads nothing - but usage is in the stream'
  )

  // ---- commissioning enforces the account limit ----
  // ⛔ `enabled: false` at creation, not afterwards, and this is a safety property of the suite
  // rather than tidiness. `codex` is genuinely signed in on this machine, so a worker adopting it is
  // dispatchable the instant its row exists - and the daemon's own scheduler ticks every ten seconds.
  // Creating enabled and disabling a line later leaves a real window in which real work could be
  // dispatched to a real account by a suite that claims to spend nothing. This was found by the M4
  // controller checks failing: a background tick had seen two eligible workers and queued a routing
  // consult for a task that had none before.
  const firstAgy = await daemon.rpc('worker.create', {
    adapterId: 'antigravity-cli',
    label: 'antigravity seat',
    enabled: false
  })
  check('a keyring-backed adapter commissions its one account', Boolean(firstAgy.id))
  const secondAgy = await daemon.rpcResult('worker.create', {
    adapterId: 'antigravity-cli',
    label: 'antigravity seat 2',
    enabled: false
  })
  check(
    'and refuses a second, rather than letting two rows share one window',
    !secondAgy.ok && /only 1 account/i.test(secondAgy.message ?? ''),
    secondAgy.message
  )
  check(
    'the refusal explains why and what to do instead',
    /keyring/i.test(secondAgy.message ?? '') && /retire/i.test(secondAgy.message ?? ''),
    'a bare "no" is the kind of error nobody can act on'
  )

  const codexWorker = await daemon.rpc('worker.create', {
    adapterId: 'openai-compatible',
    label: 'codex seat',
    enabled: false
  })
  const codexTwo = await daemon.rpcResult('worker.create', {
    adapterId: 'openai-compatible',
    label: 'codex seat 2',
    enabled: false
  })
  check('an isolatable adapter commissions as many as you like', codexTwo.ok, 'CODEX_HOME per account')
  check(
    'a worker can be commissioned closed to work, with no window in which it could be dispatched to',
    codexWorker.enabled === false && firstAgy.enabled === false,
    'the scheduler ticks every ten seconds; "disable it straight after" is not soon enough'
  )

  const providerTick = await daemon.rpc('scheduler.tick')
  check(
    'nothing dispatches to any of them',
    providerTick.dispatched === 0,
    'every new worker was disabled the moment it was commissioned'
  )

  const doc = await daemon.rpc('doctor.run')
  check(
    'doctor says when metering comes from a stream rather than a file, and what that costs',
    doc.warnings.some((w) => /metered from its live stream/i.test(w)),
    doc.warnings.find((w) => /metered from its live stream/i.test(w))
  )
  check(
    'doctor warns that orphans of a non-minting adapter will not be stopped',
    doc.warnings.some((w) => /orphaned/i.test(w)),
    'agentyard kills only what it can prove is its own'
  )

  // ---------------------------------------------------------------- M4: the controller
  //
  // ⛔ Every check here runs with **no account able to answer** — one worker is not signed in, the
  // other is disabled. That is the normal state on a fresh install, and it is precisely the state
  // the fallbacks exist for. So this section proves the property that makes an LLM controller safe:
  // the fleet keeps working when it cannot be asked anything, and nothing is spent trying.
  section('controller')

  const idle = await daemon.rpc('controller.report', {})
  check(
    'no account can answer a judgment call in this fixture',
    idle.controllers.every((c) => !c.available),
    idle.controllers.map((c) => `${c.label}: ${c.reason}`).join(' · ') || 'none designated'
  )
  check('a fresh fleet has spent nothing on judgment', idle.spentTokens === 0)

  const plan = await daemon.rpc('task.plan', { title: 'Ship the thing end to end' })
  check('a goal is filed as a plan, not as work', plan.kind === 'plan', plan.status)

  const planTick = await daemon.rpc('scheduler.tick')
  const planned = await daemon.rpc('task.get', { id: plan.id })
  check(
    'a plan task is decomposed, never dispatched',
    planned.task.status === 'assigned' && planned.task.assignee === 'controller',
    `${planned.task.status}/${planned.task.assignee}`
  )
  check('so the tick started no agent for it', planTick.dispatched === 0, planTick.note)

  const queued = await daemon.rpc('controller.report', {})
  check(
    'the question is queued, not answered inside the free loop',
    queued.pending === 1,
    `${queued.pending} pending`
  )
  check('and queuing it spent nothing', queued.spentTokens === 0)

  await daemon.rpc('scheduler.tick')
  const requeued = await daemon.rpc('controller.report', {})
  check(
    'a tick that runs every ten seconds does not queue the same question again',
    requeued.pending === 1,
    `${requeued.pending} pending after a second tick`
  )

  const drained = await daemon.rpc('controller.drain')
  check('draining with nobody to ask answers nothing', drained.answered === 0, drained.note)
  check(
    'and says why, rather than failing silently',
    /no controller|not signed in|disabled|designated/i.test(drained.note),
    drained.note
  )
  const afterDrain = await daemon.rpc('controller.report', {})
  check('nothing was spent trying', afterDrain.spentTokens === 0)

  const chat = await daemon.rpc('chat.send', { text: 'what is the fleet doing?' })
  check(
    'chat refuses out loud rather than queueing silently',
    chat.ok === false && Boolean(chat.reason),
    chat.reason
  )
  const chatLog = await daemon.rpc('chat.history', {})
  check(
    'and the refusal appears in the thread where you would look for it',
    chatLog.some((m) => m.role === 'system'),
    chatLog.at(-1)?.text?.slice(0, 80)
  )

  const estimate = await daemon.rpc('task.estimate', { id: plan.id })
  check(
    'an estimate never arrives without its basis',
    typeof estimate.basis === 'string' && estimate.basis.length > 0,
    `${estimate.tokens} tokens, ${estimate.confidence} — ${estimate.basis}`
  )

  const noteTarget = await daemon.rpc('task.create', { title: 'a task with nothing running' })
  await daemon.rpc('task.message', { id: noteTarget.id, text: 'one more thing' })
  const noted = await daemon.rpc('task.get', { id: noteTarget.id })
  check(
    'a note to a task with no live session waits for the next run',
    noted.messages.at(-1)?.deliveredAt === null,
    'undelivered notes are prepended to the next prompt; delivered ones are not repeated'
  )

  const roles = await daemon.rpc('fleet.list')
  check(
    'a commissioned worker can do work and answer questions by default',
    roles.every((f) => f.worker.role === 'both'),
    'a one-account install has a controller without configuring anything'
  )
  const dedicated = await daemon.rpc('worker.update', { id: roles[0].worker.id, role: 'worker' })
  check('an account can be taken out of the judgment rota', dedicated.role === 'worker')
  await daemon.rpc('worker.update', { id: roles[0].worker.id, role: 'both' })

  // ---------------------------------------------------------------- L2: approvals over real MCP
  section('approvals (real MCP client)')
  await runApprovalChecks(daemon)

  // ---------------------------------------------------------------- L2: the controller tier
  section('controller tier (real MCP client)')
  await runControllerTierChecks(daemon)
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
/**
 * A real MCP client over stdio, spawned the way the agent CLI spawns it - including the tier, which
 * comes from the config file the daemon writes and not from anything the agent can set for itself.
 */
async function openMcp(d, tier) {
  const script = join(REPO, 'out', 'main', 'agentyard-mcp.js')
  if (!existsSync(script)) {
    check('the MCP server bundle exists', false, `${script} is missing`)
    return null
  }

  const child = spawn(electronBinary(), [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MULTI_AGENT_CONTROLLER_SESSION_ID: 'selftest-session',
      MULTI_AGENT_CONTROLLER_TIER: tier,
      MULTI_AGENT_CONTROLLER_DATA_DIR: d.dataDir
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stderr.on('data', (x) => process.env.MULTI_AGENT_CONTROLLER_TEST_VERBOSE && process.stderr.write(`[mcp] ${x}`))

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

  const init = await mcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentyard-selftest', version: '0' }
  })
  check(`the ${tier}-tier MCP handshake completes`, init.result?.serverInfo?.name === 'multi-agent-controller')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  return {
    mcp,
    body: (r) => JSON.parse(r.result?.content?.[0]?.text ?? '{}'),
    tools: async () => (await mcp('tools/list', {})).result.tools.map((t) => t.name),
    close: () => child.kill()
  }
}

/**
 * ⛔ The controller tier is a boundary, not a convenience. This proves the tier is decided by what
 * the daemon wrote, that the reach is wider than a worker's, and that neither tier can delete
 * anything - an agent that can delete the record of its own failed work is an agent that can hide it.
 */
async function runControllerTierChecks(d) {
  const client = await openMcp(d, 'controller')
  if (!client) return
  try {
    const tools = await client.tools()
    check(
      'the controller tier can read the fleet and move work about',
      ['fleet_status', 'task_list', 'task_create', 'task_promote', 'task_cancel', 'approval_answer'].every(
        (n) => tools.includes(n)
      ),
      tools.join(', ')
    )
    check(
      'and it is a different tool set, not a worker tier with extras bolted on',
      !tools.includes('task_complete') && !tools.includes('handoff')
    )
    check('there is no controller-tier delete either', !tools.includes('task_delete'))
    check(
      'it still answers permission prompts, because it is a session like any other',
      tools.includes('approve')
    )

    const listed = client.body(await client.mcp('tools/call', { name: 'task_list', arguments: {} }))
    check('a controller tool reaches the daemon and returns real data', Array.isArray(listed))

    const filed = await client.mcp('tools/call', {
      name: 'task_create',
      arguments: { title: 'something the controller proposed', status: 'draft' }
    })
    const said = filed.result?.content?.[0]?.text ?? ''
    check('the controller can file a draft', /Filed as t\d+ \(draft\)/.test(said), said)
  } finally {
    client.close()
  }
}

async function runApprovalChecks(d) {
  const client = await openMcp(d, 'worker')
  if (!client) return
  const { mcp, body } = client

  try {
    const tools = await client.tools()
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
    client.close()
  }
}

void WebSocket
void git
