import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Worker } from '@shared/protocol.js'
import type { Run } from '@shared/tasks.js'
import type { WorkerChoice } from './scheduler.js'

/**
 * The routing and reporting faults found in one afternoon of real use, turned into checks.
 *
 * Each is cheap - a temporary database and a file on disk, no CLI and no tokens - and each is a
 * failure that was **invisible until somebody looked at the screen**, which is the kind this project
 * has the least protection against.
 */

let dir: string
let db: typeof import('./db.js')
let quota: typeof import('./quota.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let scoring: typeof import('./scoring.js')
let controller: typeof import('./controller.js')
let complexityOf: typeof import('./complexity.js').complexityOf

/**
 * A worker whose isolation root holds a vendor usage cache, exactly as Claude Code writes one.
 *
 * ⚠️ `fetchedAtMs` is the vendor's clock and does not move when we read it. That is the whole point:
 * it is what makes a re-read produce a row identical to the last one.
 */
function seedWorker(label: string, fetchedAtMs: number): Worker {
  const worker = workers.createWorker({ adapterId: 'claude-code', label, enabled: false })
  writeFileSync(
    join(worker.isolationRoot, '.claude.json'),
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs,
        utilization: {
          limits: [
            { kind: 'session', group: 'session', percent: 6, resets_at: null },
            { kind: 'weekly', group: 'weekly', percent: 0, resets_at: null }
          ]
        }
      }
    })
  )
  return worker
}

let origClaudeInstalled: () => boolean
let origAgyInstalled: () => boolean

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-routing-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  scoring = await import('./scoring.js')
  controller = await import('./controller.js')
  complexityOf = (await import('./complexity.js')).complexityOf
  const { claudeCode } = await import('./adapters/claude-code.js')
  const { antigravityCli } = await import('./adapters/antigravity-cli.js')
  origClaudeInstalled = claudeCode.isInstalled
  origAgyInstalled = antigravityCli.isInstalled
  claudeCode.isInstalled = () => true
  antigravityCli.isInstalled = () => true
  db.openDb(join(dir, 'routing.db'))
})

afterAll(async () => {
  if (origClaudeInstalled) {
    const { claudeCode } = await import('./adapters/claude-code.js')
    claudeCode.isInstalled = origClaudeInstalled
  }
  if (origAgyInstalled) {
    const { antigravityCli } = await import('./adapters/antigravity-cli.js')
    antigravityCli.isInstalled = origAgyInstalled
  }
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('a quota reading that has not changed', () => {
  it('is one reading however often it is read', async () => {
    // ⛔ The defect, exactly as it appeared: the fleet strip grew a second session/weekly pair after
    // ten minutes and a third after fifteen, because `sampled_at` is the *vendor's* fetch time and
    // every poll inserted a fresh row under it. Three polls, one cache, two windows.
    const worker = seedWorker('probe-me', 1_787_000_000_000)
    await quota.probeWorker(worker.id)
    await quota.probeWorker(worker.id)
    await quota.probeWorker(worker.id)

    const seen = quota.lastQuota(worker.id)
    expect(seen?.windows.map((w) => w.id)).toEqual(['session', 'weekly'])
  })

  it('is replaced, not accompanied, when the vendor refreshes it', async () => {
    const worker = seedWorker('refresh-me', 1_787_000_000_000)
    await quota.probeWorker(worker.id)
    writeFileSync(
      join(worker.isolationRoot, '.claude.json'),
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 1_787_000_600_000,
          utilization: { limits: [{ kind: 'session', group: 'session', percent: 44 }] }
        }
      })
    )
    await quota.probeWorker(worker.id)

    const seen = quota.lastQuota(worker.id)
    expect(seen?.windows).toHaveLength(1)
    expect(seen?.windows[0]?.percent).toBe(44)
  })
})

describe('choosing between workers that score the same', () => {
  const base: Worker = {
    id: 'w',
    adapterId: 'claude-code',
    label: 'w',
    isolationRoot: 'w',
    enabled: true,
    humanOccupied: false,
    role: 'both',
    maxConcurrent: 1,
    defaultModel: null,
    defaultEffort: null,
    identity: null,
    credits: null,
    creditsIntent: null,
    health: null,
    sortOrder: 0,
    retiredAt: null,
    createdAt: 0
  }

  it('prefers the account somebody finished setting up', () => {
    // ⛔ The misroute. Every worker on the machine scored identically - the compaction reserve reports
    // `unknown` for all of them until R2 lands, so `quotaRisk` was a constant - and the tie fell to
    // candidate order, which is `created_at`. The first account ever commissioned therefore won every
    // routing decision, and on that machine it was the one nobody had finished setting up.
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    const halfDone = { ...base, identity: { loggedIn: true, setupComplete: false } }
    expect(scoring.unproven(ready, true)).toBeLessThan(scoring.unproven(halfDone, true))
  })

  it('does not penalise an adapter that cannot answer the question', () => {
    // ⚠️ Antigravity keeps its credential in the OS keyring, so `setupComplete` is permanently null.
    // Reading that as a missing step would bench a healthy account for a fact it can never report.
    const cannotTell = { ...base, identity: { loggedIn: true, setupComplete: null } }
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    expect(scoring.unproven(cannotTell, true)).toBe(scoring.unproven(ready, true))
  })

  it('does not penalise an adapter that cannot answer the SIGN-IN question either', () => {
    // ⛔ The bug the test above was one field away from catching, and did not, for a month: it
    // varied `setupComplete` and held `loggedIn: true` throughout. Antigravity's real identity is
    // `loggedIn: null` — `probeIdentity()` returns it unconditionally, because the credential is in
    // the OS keyring and there is no free way to look — and `unproven` scored it with
    // `loggedIn !== true`, which is true for null. So every Antigravity worker carried +0.4 for
    // ever, on top of +0.5 for being unproven, and could shed neither: only a metered turn clears
    // `unproven`, and at 0.9 doubt it lost every dispatch and never got one.
    //
    // ⚠️ Measured on this install 2026-08-27: antigravity-cli had **0 turns ever** against 122 on
    // claude-code. The comment directly above the line already said `=== false`, never falsy — it
    // was applied to one of the two fields.
    const keyring = { ...base, identity: { loggedIn: null, setupComplete: null } }
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    expect(scoring.unproven(keyring, true)).toBe(scoring.unproven(ready, true))
  })

  it('still penalises a worker that is genuinely, checkably signed out', () => {
    // ⚠️ The other half. "Cannot tell" must be free; "we asked and it said no" must not be — or the
    // fix for the above would have thrown away a real signal to buy fairness for a null.
    const signedOut = { ...base, identity: { loggedIn: false, setupComplete: true } }
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    expect(scoring.unproven(signedOut, true)).toBeGreaterThan(scoring.unproven(ready, true))
  })

  it('knows least about a worker nothing has ever probed', () => {
    expect(scoring.unproven(base, false)).toBeGreaterThanOrEqual(1)
  })

  it('prefers an account that has actually produced a turn', () => {
    // ⛔ The strongest input, and the only one that is evidence rather than self-report. Measured
    // 2026-08-27: a never-signed-in Antigravity account — which answers every identity question with
    // "cannot tell", legitimately, because its credential is in the OS keyring — won a dispatch over
    // two working Claude workers, then failed in 0s. Whether a turn has ever come out of an account
    // is the one fact that separates those two cases, and it was not being consulted.
    const proven = { ...base, identity: { loggedIn: true, setupComplete: null } }
    const never = { ...base, identity: { loggedIn: true, setupComplete: null } }
    expect(scoring.unproven(proven, true)).toBeLessThan(scoring.unproven(never, false))
  })

  it('still lets an unproven worker be tried, because nothing else ever becomes proven', () => {
    // ⚠️ A penalty, never a gate. Every fleet starts with no proven account.
    expect(scoring.unproven(base, false)).toBeLessThan(Infinity)
  })
})

describe('a dispatch that produced nothing', () => {
  const session = (patch: Partial<Session> = {}): Session =>
    ({
      id: 's',
      workerId: 'w',
      adapterId: 'claude-code',
      transport: 'stream',
      projectId: null,
      cwd: 'w',
      model: null,
      effort: null,
      state: 'closed',
      pid: null,
      purpose: 'work',
      transcriptPath: null,
    vendorSessionId: null,
    currentBranch: null,
      contextTokens: null,
      contextWindow: null,
      lastRequestStartedAt: null,
      cacheExpiresAt: null,
      tokensSinceCompact: 0,
      clockMove: null,
      clockMoveAt: null,
      clockMoveAttempts: 0,
      clockMoveContext: null,
      startedAt: 0,
      closedAt: null,
      ...patch
    })

  const run = (patch: Partial<Run> = {}): Run =>
    ({
      id: 'r',
      taskId: 't',
      sessionId: 's',
      workerId: 'w',
      kind: 'work',
      startedWarm: null,
      adapterId: null,
      model: null,
      trunkShaBefore: null,
      startedAt: Date.now(),
      endedAt: null,
      outcome: null,
      quotaUnverified: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costModelId: null,
      note: null,
      quotaBefore: null,
      quotaAfter: null,
      prompt: null,
      blockedMs: 0,
      ...patch
    })

  it('is charged to the worker, not to the task', () => {
    expect(scheduler.deadOnArrival(session(), run())).toMatch(/produced no output/)
  })

  it('spares a run that metered anything at all', () => {
    expect(scheduler.deadOnArrival(session(), run({ outputTokens: 12 }))).toBeNull()
  })

  it('spares a run whose turn had started even before the tokens landed', () => {
    // ⚠️ The transcript's final turn is routinely flushed *after* the process is gone, so tokens
    // alone would libel a session that did work and exited quickly.
    expect(scheduler.deadOnArrival(session({ lastRequestStartedAt: 1 }), run())).toBeNull()
  })

  it('spares a long run, whatever it metered', () => {
    const old = run({ startedAt: Date.now() - scheduler.DEAD_ON_ARRIVAL_MS - 1 })
    expect(scheduler.deadOnArrival(session(), old)).toBeNull()
  })
})

describe('a task nobody has picked up', () => {
  it('says why, and stops saying it the moment it moves', () => {
    const task = tasks.createTask({ title: 'held', createdBy: { kind: 'human' } })
    tasks.setHoldReason(task.id, 'ClaudeSecond at capacity')
    expect(tasks.getTask(task.id)?.holdReason).toBe('ClaudeSecond at capacity')

    // ⛔ Every status change clears it. A reason that outlives the state it explains is read as
    // current, which is worse than having none.
    tasks.setStatus(task.id, 'running', { assignee: 'w1' })
    expect(tasks.getTask(task.id)?.holdReason).toBeNull()
  })

  it('loses its worker when it goes back in the queue', () => {
    // ⚠️ `coalesce` read a deliberate null as "leave it alone", so a task re-routed away from a dead
    // worker kept showing the name of the worker that had just failed to run it.
    const task = tasks.createTask({ title: 're-routed', createdBy: { kind: 'human' } })
    tasks.setStatus(task.id, 'running', { assignee: 'w1' })
    expect(tasks.getTask(task.id)?.assignee).toBe('w1')

    tasks.setStatus(task.id, 'ready', { assignee: null })
    expect(tasks.getTask(task.id)?.assignee).toBeNull()
  })
})

describe('a worker that work does not survive on', () => {
  it('is held out of dispatch until something proves otherwise', () => {
    const worker = seedWorker('dead-end', 1_787_000_000_000)
    const struck = workers.recordDispatchFailure(worker.id, 'subscription expired', 'r1')
    expect(struck.health?.state).toBe('suspect')

    workers.clearDispatchFailure(worker.id)
    expect(workers.requireWorker(worker.id).health).toBeNull()
  })
})

describe('an account that needs signing in again', () => {
  /**
   * ⛔ Opening a terminal is not free in the way a file read is. On both adapters that have one,
   * `refreshUsage` starts a real interactive session and types into it - so on a worker whose
   * subscription has expired, asking again only watches it fail to authenticate and records
   * `unknown`. Held out of dispatch is effectively the same state as disabled, and treated as one.
   */
  it('is not refreshed automatically once a run has proved work dies on it', () => {
    const worker = seedWorker('expired', Date.now())
    workers.updateWorker(worker.id, { enabled: true })
    expect(quota.mayRefreshUsage(worker.id)).toBe(true)

    workers.recordDispatchFailure(worker.id, 'subscription expired', 'r1')
    expect(quota.mayRefreshUsage(worker.id)).toBe(false)

    // ⛔ And it comes back the moment the hold lifts. A worker that could never be re-read would
    // stay `unknown` forever even after somebody fixed the account.
    workers.clearDispatchFailure(worker.id)
    expect(quota.mayRefreshUsage(worker.id)).toBe(true)
  })

  it('⛔ does not open a second terminal on a worker one was just opened on', async () => {
    // Measured 2026-08-30: **150 probe PTY sessions against 14 that did any work** over four days -
    // ten interactive `claude` processes opened to read a number for every one that touched the
    // operator's code. Each registers a session with the vendor's bridge and accumulates in the
    // desktop app until somebody archives it by hand. The clock that produced them is gone; this
    // floor is what stops the gates that replaced it doing the same thing.
    expect(quota.REFRESH_BACKOFF_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)

    const worker = seedWorker('backoff', Date.now())
    workers.updateWorker(worker.id, { enabled: true })
    quota.forgetRefreshAttempts()

    // The first ask starts one and says so; the second is inside the backoff and starts nothing.
    expect(quota.ensureFreshQuota(worker.id)).toBe(true)
    expect(quota.ensureFreshQuota(worker.id)).toBe(true) // still in flight - the caller waits
    // The explicit Probe action takes this same path. It must see the pending gate refresh rather
    // than trying to open a second TUI and hitting sessions.ts's one-probe-per-worker guard.
    expect(await quota.refreshNow(worker.id, 0)).toBe(false)
  })

  /**
   * ⛔ The starvation this replaced. On the config-cache path a refresh that produced nothing
   * fresher stores the **vendor's** old `sampledAt`, because inventing a timestamp for a number
   * nobody re-read would be worse than an old number. Anything that decides "try again?" from the
   * reading's *age* therefore says yes forever on exactly the worker that cannot answer - and the
   * old sweep allowed one refresh per pass, so that worker re-claimed the slot every five minutes
   * and no worker behind it in `listWorkers()` order was ever refreshed again.
   */
  it('backs off on the attempt, not on the age of the reading it failed to move', () => {
    const worker = seedWorker('never-answers', Date.now())
    workers.updateWorker(worker.id, { enabled: true })
    quota.forgetRefreshAttempts()

    expect(quota.ensureFreshQuota(worker.id)).toBe(true)
    // No reading has appeared and none will. The decision must not be re-derived from that.
    expect(quota.lastQuota(worker.id)?.stale ?? true).toBe(true)
    expect(quota.ensureFreshQuota(worker.id)).toBe(true)
  })

  it('is not refreshed while switched off or signed out either', () => {
    const worker = seedWorker('sweep-gates', Date.now())
    workers.updateWorker(worker.id, { enabled: false })
    expect(quota.mayRefreshUsage(worker.id)).toBe(false)

    workers.updateWorker(worker.id, { enabled: true })
    expect(quota.mayRefreshUsage(worker.id)).toBe(true)
  })

  it('says the fix is signing in, when the CLI said so', async () => {
    const { adapter } = await import('./adapters/index.js')
    const claude = adapter('claude-code')
    // ⚠️ Verbatim from this machine on 2026-08-27 - the run that started all of this.
    expect(
      claude.needsReauth?.(
        'The agent reported a failure (api_error): Your organization has disabled Claude ' +
          'subscription access for Claude Code. Contact your administrator or use an API key.'
      )
    ).toBe(true)
    expect(claude.needsReauth?.('Invalid API key · Please run /login')).toBe(true)
  })

  it('does not send somebody to re-authenticate over an outage', () => {
    const worker = seedWorker('crashed', Date.now())
    // ⛔ `api_error` on its own means nothing about credentials. Telling an operator to sign in
    // again because the vendor had a bad afternoon is how a working account gets signed out.
    workers.recordDispatchFailure(worker.id, 'The agent reported a failure (api_error): 529 overloaded', 'r2')
    const health = workers.requireWorker(worker.id).health
    expect(health?.state).toBe('suspect')
    expect(health?.needsReauth).toBe(false)

    // Still held out, still not refreshed. Only the *advice* differs.
    expect(quota.mayRefreshUsage(worker.id)).toBe(false)
  })

  it('records the verdict on the worker, so the panel does not have to guess', () => {
    const worker = seedWorker('expired-verdict', Date.now())
    workers.recordDispatchFailure(worker.id, 'Your subscription has expired', 'r3')
    expect(workers.requireWorker(worker.id).health?.needsReauth).toBe(true)
    expect(workers.requireWorker(worker.id).health?.subscriptionExpired).toBe(true)
  })
})

describe('a worker the operator has switched off', () => {
  /**
   * ⚠️ The scheduler's gate is not the only one, and testing only the scheduler would say nothing
   * about the paths that never ask it: a warm session being reused, a hand-started terminal, an
   * approval landing on a worker somebody switched off while it queued. The refusal lives where the
   * session is actually created, so all of them hit it.
   */
  it('refuses to have work started on it, whoever asks', async () => {
    const sessions = await import('./sessions.js')
    const worker = seedWorker('switched-off', 1_787_000_000_000)
    expect(workers.requireWorker(worker.id).enabled).toBe(false)

    expect(() => sessions.spawnSession({ workerId: worker.id })).toThrow(/disabled/)

    // ⛔ Signing in is deliberately exempt. Off is not retirement: it holds an account out of
    // dispatch and leaves every way of fixing it open, including the one that needs a terminal. A
    // switch that locked the operator out of repairing what it switched off would be a trap.
    //
    // ⚠️ Asked of the predicate, not by calling `spawnSession({ purpose: 'login' })`. That call does
    // not stop at a check - it goes on to spawn the vendor CLI in a real PTY, which would make the
    // assertion depend on whether this machine has that CLI installed and leave a process behind on
    // the one that does.
    const off = workers.requireWorker(worker.id)
    expect(sessions.whyNoSession(off, 'work')).toMatch(/disabled/)
    expect(sessions.whyNoSession(off, 'probe')).toMatch(/disabled/)
    expect(sessions.whyNoSession(off, 'login')).toBeNull()

    // ⛔ Retirement is not exempt, because there is nothing left to repair.
    expect(sessions.whyNoSession({ ...off, retiredAt: Date.now() }, 'login')).toMatch(/retired/)
  })

  it('comes back with nothing lost, because off is not retirement', () => {
    const worker = seedWorker('back-again', 1_787_000_000_000)
    const root = worker.isolationRoot

    workers.updateWorker(worker.id, { enabled: true })
    const on = workers.requireWorker(worker.id)
    expect(on.enabled).toBe(true)
    expect(on.retiredAt).toBeNull()
    expect(on.isolationRoot).toBe(root)
  })
})

describe('the live peephole', () => {
  it('keeps a bounded tail, so a long run cannot grow without bound', async () => {
    const activity = await import('./activity.js')
    // ⚠️ Settled rows, one per line: a newline-terminated fragment is a row of its own, which is
    // what the bound counts. Streaming fragments without one share a single open line (see below)
    // and would never exercise this.
    for (let i = 0; i < 200; i++) activity.noteActivity('t-peek', `line ${i}\n`, undefined, 'delta')
    const tail = activity.activityFor('t-peek')
    expect(tail.length).toBeLessThanOrEqual(40)
    // ⛔ The *newest* survive. A tail that dropped the latest lines would answer "what was it doing
    // a while ago", which is the one question nobody asks of a running task.
    expect(tail[tail.length - 1]?.text).toBe('line 199')
  })

  it('collapses an agent’s whitespace and caps one line', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-wide')
    activity.noteActivity('t-wide', `  reading\n\n   the   file  `, undefined, 'delta')
    activity.noteActivity('t-wide', 'x'.repeat(5000), undefined, 'delta')
    const tail = activity.activityFor('t-wide')
    expect(tail).toHaveLength(1)
    expect(tail[0]?.text.startsWith('reading the file')).toBe(true)
    expect(tail[0]?.text.length).toBeLessThan(500)
  })

  it('ignores a fragment that says nothing', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-empty')
    activity.noteActivity('t-empty', '   \n  ', undefined, 'delta')
    expect(activity.activityFor('t-empty')).toHaveLength(0)
  })

  it('is cleared for a new attempt', async () => {
    const activity = await import('./activity.js')
    activity.noteActivity('t-clear', 'from the run before')
    activity.clearActivity('t-clear')
    expect(activity.activityFor('t-clear')).toHaveLength(0)
  })

  it('reassembles streamed prose into one row, not one row per word', async () => {
    // ⛔ The defect reported 2026-09-07: a muse turn streamed as `run.output.delta` fragments read
    // `landing / corners.test.ts / pass. The / tree / is clean` — one word per block, because every
    // fragment became its own tail entry and the thread renders each entry as its own row.
    const activity = await import('./activity.js')
    activity.clearActivity('t-stream')
    for (const frag of ['landing', ' corners.test.ts', ' pass. The', ' tree', ' is clean']) {
      activity.noteActivity('t-stream', frag, undefined, 'delta')
    }
    const tail = activity.activityFor('t-stream')
    expect(tail).toHaveLength(1)
    expect(tail[0]?.text).toBe('landing corners.test.ts pass. The tree is clean')
  })

  it('keeps the boundary the fragments spell, including mid-word splits', async () => {
    // ⛔ Concatenated, never re-spaced: the space between `no` and `squ` arrives in its fragment,
    // and none is invented between `squ` and `ashing` — tokenisers split mid-word routinely, and
    // a guessed separator corrupts words (`squ ashing`, measured in the report that prompted this).
    const activity = await import('./activity.js')
    activity.clearActivity('t-split')
    activity.noteActivity('t-split', 'no ', undefined, 'delta')
    activity.noteActivity('t-split', 'squ', undefined, 'delta')
    activity.noteActivity('t-split', 'ashing was', undefined, 'delta')
    activity.noteActivity('t-split', ' needed', undefined, 'delta')
    expect(activity.activityFor('t-split').map((l) => l.text)).toEqual(['no squashing was needed'])
  })

  it('lets a newline-terminated row stand alone beside streaming prose', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-rows')
    activity.noteActivity('t-rows', '· bash\n', undefined, 'delta')
    activity.noteActivity('t-rows', 'landing', undefined, 'delta')
    activity.noteActivity('t-rows', ' corners\n', undefined, 'delta')
    activity.noteActivity('t-rows', '· grep\n', undefined, 'delta')
    expect(activity.activityFor('t-rows').map((l) => l.text)).toEqual([
      '· bash',
      'landing corners',
      '· grep'
    ])
  })

  it('finishes the open line when the newline arrives in a later fragment', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-join')
    activity.noteActivity('t-join', 'hel', undefined, 'delta')
    activity.noteActivity('t-join', 'lo\n', undefined, 'delta')
    activity.noteActivity('t-join', 'next\n', undefined, 'delta')
    expect(activity.activityFor('t-join').map((l) => l.text)).toEqual(['hello', 'next'])
  })

  it('tells watchers to replace the open row, with the whole line each time', async () => {
    const events = await import('./events.js')
    const activity = await import('./activity.js')
    const seen: Array<{ text: string; append?: true; reset?: true }> = []
    events.setEventSink((e) => {
      if (e.type === 'task.activity' && e.taskId === 't-wire') seen.push(e)
    })
    try {
      activity.clearActivity('t-wire')
      seen.length = 0
      activity.noteActivity('t-wire', 'landing', undefined, 'delta')
      activity.noteActivity('t-wire', ' corners', undefined, 'delta')
      activity.noteActivity('t-wire', '· bash\n', undefined, 'delta')
      expect(seen.map((e) => [e.text, e.append ?? false])).toEqual([
        ['landing', false],
        ['landing corners', true],
        // The settled row carries the finished line, so a watcher that missed a fragment still
        // lands on the right text. ⚠️ Abutted, not spaced: a terminated row arriving mid-line is
        // concatenated like any other fragment — in practice tool rows precede the prose, so the
        // open line is empty when they land.
        ['landing corners· bash', true]
      ])
    } finally {
      events.setEventSink(() => {})
    }
  })

  it('keeps the open line in what a pane seeds from and what a run persists', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-seed')
    activity.noteActivity('t-seed', 'landing', 'r-seed', 'delta')
    activity.noteActivity('t-seed', ' corners', 'r-seed', 'delta')
    expect(activity.activityFor('t-seed').map((l) => l.text)).toEqual(['landing corners'])
    expect(activity.runActivityFor('r-seed').map((l) => l.text)).toEqual(['landing corners'])
    expect(activity.consumeRunActivity('r-seed').map((l) => l.text)).toEqual(['landing corners'])
  })
})

describe('the compaction reserve as a routing input', () => {
  it('does not make holding a live session look risky', async () => {
    // ⛔ The bug that sent a task to an account nobody had ever signed in to. `reserveState` returns
    // `ok` for a worker holding **no** live sessions and `unknown` for one holding any, because
    // `remaining` is null on every Claude account until R2 lands. Scored at 0.5 against a weight of
    // ~0.9, that was a 0.45 penalty for *having a session* — two to five times every term that
    // actually discriminates — so an idle worker beat a busy one whatever else was true.
    const reserve = await import('./reserve.js')
    const worker = seedWorker('busy-but-fine', 1_787_000_000_000)
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               started_at, context_tokens, tokens_since_compact)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'ffffffff-0000-4000-8000-0000000000f1',
        worker.id,
        'claude-code',
        'stream',
        dir,
        'live',
        'work',
        Date.now(),
        50_000,
        0
      )

    // The verdict itself is still honest — unknown is not ok, and the watchdog reads it.
    expect(reserve.reserveState(worker.id).verdict).toBe('unknown')
    // ⚠️ What changed is that the *scorer* no longer converts that into a preference. This asserts
    // the rule rather than the arithmetic: only checked evidence may move the score.
    expect(scoring.quotaRiskOf(worker.id)).toBe(0)
  })

  it('still penalises a worker the vendor has actually rate-limited', async () => {
    const quota = await import('./quota.js')
    const worker = seedWorker('rejected', 1_787_000_000_000)
    quota.recordRateLimit(worker.id, null, {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Date.now() + 3_600_000
    })
    expect(scoring.quotaRiskOf(worker.id)).toBe(1)
  })
})

describe('what a CLI said, on its way into a sentence', () => {
  it('arrives without the colour codes it was printed with', async () => {
    // ⚠️ Measured 2026-08-27: a benched worker's reason rendered as
    // `It said: <esc>[2m— claude-sonnet-5 · auto<esc>[0m Your organization has…`, which reads as
    // corruption and buries the one sentence that mattered. ⛔ This strips bytes on their way to a
    // person; nothing anywhere reads state out of them.
    const { stripAnsi } = await import('./stream.js')
    const esc = String.fromCharCode(27)
    const raw = `${esc}[2m- claude-sonnet-5 . auto${esc}[0m Your organization has disabled access`
    expect(stripAnsi(raw)).toBe('- claude-sonnet-5 . auto Your organization has disabled access')
  })

  it('leaves ordinary prose exactly as it was', () => {
    expect(scheduler.deadOnArrival).toBeTypeOf('function')
  })
})

describe('the routing score shows its own arithmetic', () => {
  /**
   * ⛔ **Why this exists.** Measured on t39–t42 (2026-08-30): four consecutive routing consults were
   * spent choosing between `-0.120` and `-0.120`, on two accounts holding completely different
   * windows — one at 64% of its weekly, the other at 98% of a five-hour pool. Two equal numbers with
   * no derivation is not a tie, it is a missing input, and every one of those answers reasoned from
   * the *worker labels* because the numbers said nothing.
   *
   * ⚠️ A rendered `-1.249` is no better on its own. These check that the output answers the three
   * questions a bare number provokes: where the weight came from, why the value is what it is, and
   * which direction wins.
   */
  const term = (name: string, weight: number, value: number, sign: 1 | -1, basis = 'because') => ({
    name,
    weight,
    weightFormula: `${weight} = published formula`,
    value,
    basis,
    sign,
    contribution: sign * weight * value
  })

  it('states that higher wins, and on what scale', () => {
    // ⛔ Neither is inferable from a number. `-0.120` could be a rank, a cost, or a log-odds, and a
    // reader with no legend guessed — which is exactly what the controller did four times.
    const legend = scoring.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    expect(legend).toContain('HIGHER WINS')
    expect(legend).toContain('linear and unitless')
    expect(legend).toMatch(/nothing is logarithmic/i)
  })

  it('derives every weight from the objective vector, and says so', () => {
    const legend = scoring.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    // The weight, and the arithmetic that produced it, on the same line.
    expect(legend).toContain('1.249 = 0.8 + 2.0×cost − 0.7×velocity')
    expect(legend).toContain('cost 0.34 · velocity 0.33 · quality 0.33')
    // ⚠️ And where to change it, because a number nobody can move is not an explanation either.
    expect(legend).toContain('Settings > Global')
  })

  it('says which direction each term pushes, and what a value of 1 would mean', () => {
    const legend = scoring.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    expect(legend).toMatch(/cold\s+penalty/)
    expect(legend).toMatch(/cacheWarmth\s+bonus/)
    // ⚠️ "conversation", not "session", and it is the whole 2026-09-02 finding in four words: a
    // closed conversation this task can reopen is one to reuse, and calling only a live process a
    // session is what made a one-shot adapter uniformly cold. See `reopenableFor`.
    expect(legend).toContain('1 = no conversation to reuse, live or reopenable')
    // The one term that is not derived from the objective has to say so rather than look like one.
    expect(legend).toContain('fixed, not from the objective')
  })

  /**
   * ⛔ The velocity axis's measured half, and the only signed value in the whole score. A legend that
   * described it the way it describes every other term — "1 = …" — would tell a reader that 0 is a
   * floor, when 0 here is the *middle*: exactly the fleet's median pace, and also "nothing measured".
   */
  it('says that pace is signed, and that its zero means unmeasured as well as average', () => {
    const legend = scoring.scoreLegend({ cost: 0.3, velocity: 0.3, quality: 0.4 }).join('\n')
    expect(legend).toMatch(/pace\s+bonus/)
    expect(legend).toContain('0.3 + 1.7×velocity')
    expect(legend).toContain('unmeasured')
    expect(legend).toContain('4x slower')
  })

  it('prints every term with its value, its weight, its contribution and its basis', () => {
    const terms = [
      term('cold', 1.249, 1, -1, 'no session to reuse, so a start pays a full cache write'),
      term('capabilityFit', 1.129, 1, 1, 'the task requires no specific capability')
    ]
    const out = scoring
      .formatScore({ total: terms.reduce((s, t) => s + t.contribution, 0), terms })
      .join('\n')
    expect(out).toContain('why the value is that')
    expect(out).toMatch(/cold\s+1\.00 × -1\.249 = {2}-1\.249\s+no session to reuse/)
    expect(out).toMatch(/TOTAL[\s×=]+-0\.120/)
  })

  it('prints the zero terms too, with the reason they are zero', () => {
    // ⛔ The whole finding. Dropping them reads as "considered and found small"; `quotaRisk` is not
    // small, it is unmeasurable on this fleet, and only its basis can say that.
    const terms = [
      term('cold', 1.249, 1, -1),
      term('quotaRisk', 0.908, 0, -1, 'reserve verdict unknown — remaining quota % is not an input')
    ]
    const out = scoring
      .formatScore({ total: terms.reduce((s, t) => s + t.contribution, 0), terms })
      .join('\n')
    expect(out).toContain('quotaRisk')
    expect(out).toContain('remaining quota % is not an input')
    expect(out).toMatch(/quotaRisk\s+0\.00/)
  })

  it('adds up: the printed contributions sum to the printed total', () => {
    // ⚠️ The invariant that makes the table trustworthy — a derivation that does not reconcile with
    // its own total is worse than no derivation.
    const terms = [
      term('cacheWarmth', 1.55, 0.4, 1),
      term('cold', 1.249, 0, -1),
      term('capabilityFit', 1.129, 0.5, 1),
      term('unproven', 0.35, 0.5, -1)
    ]
    const total = terms.reduce((s, t) => s + t.contribution, 0)
    const out = scoring.formatScore({ total, terms })
    const printed = out
      .filter((l) => / = /.test(l) && !l.includes('TOTAL') && !l.includes('contrib'))
      .map((l) => Number((l.split('=')[1] ?? '').trim().split(/\s+/)[0]))
    expect(printed.reduce((s, n) => s + n, 0)).toBeCloseTo(total, 2)
    expect(out.at(-1)).toContain(total.toFixed(3))
  })
})

describe('the derivation is generated for a person, not sent to the controller', () => {
  /**
   * ⛔ **Why this exists.** The legend and the per-candidate term tables answer "why did the
   * arithmetic land there" for somebody debugging a routing call afterwards. They are not what the
   * controller needs to pick between two ids, and sending them charged every routing consult for
   * roughly a hundred lines of prompt. The split is the point: same arithmetic, generated once,
   * totals and one weighed-line in the question, the full table on `consult.detail`.
   */
  const term = (name: string, weight: number, value: number, sign: 1 | -1, basis = 'because') => ({
    name,
    weight,
    weightFormula: `${weight} = published formula`,
    value,
    basis,
    sign,
    contribution: sign * weight * value
  })

  const breakdown = (): { total: number; terms: ReturnType<typeof term>[] } => {
    const terms = [
      term('cold', 1.249, 1, -1, 'no session to reuse'),
      term('capabilityFit', 1.129, 1, 1, 'the task requires no specific capability'),
      term('quotaRisk', 0.908, 0, -1, 'reserve verdict unknown — remaining quota % is not an input')
    ]
    return { total: terms.reduce((s, t) => s + t.contribution, 0), terms }
  }

  const candidate = (id: string, label: string): Parameters<
    typeof import('./judgment.js').routeQuestion
  >[1][number] => ({
    worker: { id, label } as Worker,
    score: breakdown().total,
    warm: false,
    note: '',
    considered: scoring.briefScore(breakdown()),
    formula: scoring.formatScore(breakdown())
  })

  const task = { id: 't', seq: 41, title: 'a large task', kind: 'work' } as Parameters<
    typeof import('./judgment.js').routeQuestion
  >[0]

  it('names the live terms and the unmeasurable ones in a single line', () => {
    // ⚠️ A zero term is named rather than dropped: on this fleet it is usually one that could not be
    // read at all, and that is the finding the controller has to be able to see.
    const brief = scoring.briefScore(breakdown())
    expect(brief).toContain('cold -1.249')
    expect(brief).toContain('capabilityFit +1.129')
    expect(brief).toContain('unmeasurable here: quotaRisk')
    expect(brief.split('\n')).toHaveLength(1)
  })

  it('keeps the weight table and the term-by-term derivation out of the prompt', async () => {
    const { routeQuestion } = await import('./judgment.js')
    const q = routeQuestion(task, [candidate('w1', 'ClaudeSecond'), candidate('w2', 'Antigravity')])
    // The intermediate working — the legend's weight formulas and the per-candidate table headers.
    expect(q).not.toContain('How a score is built')
    expect(q).not.toContain('why the value is that')
    expect(q).not.toContain('= f(objective)')
    expect(q).not.toContain('0.8 + 2.0×cost')
  })

  it('still gives the controller the totals, the scale and what was weighed', () => {
    // ⛔ The cost saving may not cost the fix from t39–t42: two bare equal numbers with nothing to
    // reason from is what made four consults answer from the worker labels.
    return import('./judgment.js').then(({ routeQuestion }) => {
      const q = routeQuestion(task, [candidate('w1', 'ClaudeSecond'), candidate('w2', 'Antigravity')])
      expect(q).toContain('HIGHER WINS')
      expect(q).toContain('-0.120')
      expect(q).toContain('weighed: cold -1.249')
      expect(q).toContain('unmeasurable here: quotaRisk')
      expect(q).toContain('w1')
      expect(q).toContain('w2')
    })
  })

  it('puts the full derivation on the detail instead, legend and all', async () => {
    const { routeDetail } = await import('./judgment.js')
    const legend = scoring.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 })
    const detail = routeDetail(task, [candidate('w1', 'ClaudeSecond')], legend)
    expect(detail).toContain('How a score is built')
    expect(detail).toContain('HIGHER WINS')
    expect(detail).toContain('why the value is that')
    expect(detail).toContain('remaining quota % is not an input')
    // ⚠️ Says outright that it was not sent, so nobody debugging reads it as the prompt.
    expect(detail).toMatch(/not sent to the controller/i)
  })
})

describe('quota as a slope rather than a switch', () => {
  /**
   * ⛔ **The term that had stopped working.** Until 2026-08-30 `quotaRisk` was binary and both of its
   * triggers were unreachable on this fleet: `at_risk` needs `remainingTokens` in tokens (R2, open)
   * and the live rate-limit status only turns after the vendor has already refused. So it read 0 for
   * every worker, always, at weight 0.908 — and two accounts, one at 64% of its weekly and one at
   * 98% of a five-hour pool, scored an identical -0.120 through four consecutive routing consults.
   */
  it('scores nothing at all below the floor', () => {
    // ⛔ Not a load balancer. A term rising from the first token would prefer the emptiest account
    // always, which fights the one preference this cost model exists to express — that a warm
    // session is the cheapest thing available.
    expect(scoring.windowRisk(0)).toBe(0)
    expect(scoring.windowRisk(25)).toBe(0)
    expect(scoring.windowRisk(50)).toBe(0)
  })

  it('rises linearly between the floor and the hard gate', () => {
    // 50 → 92 is the span; 71 is its midpoint.
    expect(scoring.windowRisk(71)).toBeCloseTo(0.5, 2)
    expect(scoring.windowRisk(60)).toBeCloseTo(10 / 42, 2)
    expect(scoring.windowRisk(85)).toBeCloseTo(35 / 42, 2)
  })

  it('reaches exactly 1.0 where the candidate would be excluded outright', () => {
    // ⭐ The property that matters: the slope hands over to the cliff with no step in between, so a
    // worker is never simultaneously nearly-excluded and cheap.
    expect(scoring.windowRisk(92)).toBe(1)
    expect(scoring.windowRisk(99)).toBe(1)
    expect(scoring.windowRisk(100)).toBe(1)
  })

  it('treats a missing or nonsense reading as zero, never as a guess', () => {
    // ⛔ AGENTS.md: only checked evidence may move a score. Unknown is not bad news.
    expect(scoring.windowRisk(Number.NaN)).toBe(0)
    expect(scoring.windowRisk(-5)).toBe(0)
  })

    it('separates the two accounts that four consults could not', () => {
    // The real readings from 2026-08-30, and the whole point of the change: these must not tie.
    const claudeSecond = scoring.windowRisk(64)
    const antigravity = scoring.windowRisk(98)
    expect(antigravity).toBeGreaterThan(claudeSecond)
    // At weight 0.908 the gap is far wider than ROUTE_EPSILON (0.1), so no consult is spent at all.
    expect((antigravity - claudeSecond) * 0.908).toBeGreaterThan(0.1)
  })

  it('penalises quota deficit and rewards expiring credits based on reset horizon', () => {
    const now = Date.now()
    // Antigravity: 93% on 7d window resetting in 10h (expiring credits, high available rate before reset)
    const antigravity = scoring.windowRisk(93, 92, 50, now + 10 * 3600 * 1000, now, 'weekly:gemini')
    // ClaudeSecond: 97% on 7d window resetting in 33h (1d 9h, low available rate, severe deficit)
    const claudeSecond = scoring.windowRisk(97, 92, 50, now + 33 * 3600 * 1000, now, 'weekly')

    expect(antigravity).toBeLessThan(claudeSecond)
    expect(claudeSecond).toBeGreaterThan(2.0)
    expect(antigravity).toBeLessThan(1.0)
  })

  it('favors a worker with sooner reset and expiring credits over a worker with distant reset (t83 scenario)', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const now = Date.now()
    const claude = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeSecond-t83', enabled: true })
    const agy = workers.createWorker({ adapterId: 'claude-code', label: 'Antigravity-t83', enabled: true })

    // Seed Claude: 0% 5h, 97% 7d (resets in 33h = 1d 9h)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)`
      )
      .run(
        claude.id, 'session', 'Claude 5h', 0, now + 4 * 3600 * 1000, 'cli', now,
        claude.id, 'weekly', 'Claude 7d', 97, now + 33 * 3600 * 1000, 'cli', now
      )

    // Seed Antigravity (represented here with sooner 7d reset): 0% 5h, 93% 7d (resets in 10h)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)`
      )
      .run(
        agy.id, 'session', 'Gemini 5h', 0, now + 4 * 3600 * 1000, 'cli', now,
        agy.id, 'weekly', 'Gemini 7d', 93, now + 10 * 3600 * 1000, 'cli', now
      )

    const task = tasks.createTask({
      title: 't83 dispatch task'
    })
    tasks.setQuotaOverride(task.id, now + 48 * 3600 * 1000)

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(agy.id)
  })

  it('refuses dispatch to a worker whose 7d window is >= 92% (t84 scenario)', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const now = Date.now()
    const claude = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeThird-t84', enabled: true })

    // ClaudeThird has 0% 5h but 99% 7d (resets in 1d 9h)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)`
      )
      .run(
        claude.id, 'session', 'Claude 5h', 0, now + 4 * 3600 * 1000, 'cli', now,
        claude.id, 'weekly', 'Claude 7d', 99, now + 33 * 3600 * 1000, 'cli', now
      )

    const task = tasks.createTask({
      title: 't84 dispatch task',
      constraints: { workerId: claude.id }
    })

    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('ClaudeThird-t84 at 99% of its Claude 7d window')
    expect(choice.holdUntil).toBe(now + 33 * 3600 * 1000)
  })
})

describe('gating controller consults on fresh quota', () => {
  it('defers consulting the controller when tied candidates have stale quota', async () => {
    const w1 = seedWorker('tie-worker-1', 1_787_000_000_000)
    const w2 = seedWorker('tie-worker-2', 1_787_000_000_000)
    workers.updateWorker(w1.id, { enabled: true })
    workers.updateWorker(w2.id, { enabled: true })

    const task = tasks.createTask({
      title: 'Large task that could trigger consult',
      estTokens: 200_000
    })

    const choice = scoring.chooseTarget(task)
    expect(choice.deferred).toBe(true)
    expect(choice.reason).toContain('reading quota for tied candidates')
    expect(choice.worker).toBeNull()
    expect(controller.hasPendingConsult('route', task.id)).toBe(false)
  })
})

/**
 * The conversation a one-shot CLI leaves behind, and the twenty minutes it was invisible for.
 *
 * ⛔ **t123, measured on this install 2026-09-02.** The task ran on CodexFirst 18:34–18:42, ending
 * with session `bffdc5d2` closed and holding 175,626 tokens of its context. At 19:02 the operator
 * asked it to retry the commit. The retry went to ClaudeThird — a different account, a cold start,
 * nothing about the task in its context — and rebuilt everything from scratch.
 *
 * Nothing was misweighted. `cacheWarmth`, `contextHeld` and `cold` all read the live-session slot, and
 * `codex exec` is `streamPrompts: 'once'`: it takes one prompt, runs one turn and exits, so a codex
 * conversation is **never** a live idle session. The one candidate that had actually done the work
 * could not be described by the vocabulary the score had. It scored `contextHeld 0 · cacheWarmth 0 · cold 1`,
 * which is exactly what a worker that has never heard of the task scores.
 *
 * ⛔ Three things had to be true together, and each was separately false: the adapter had to be able
 * to reopen a conversation (`resumeSession` was false), the conversation had to carry a cache clock
 * (`creditStreamTurn` wrote none), and the score had to look past the live slot (`reopenableFor`
 * did not exist). Fixing any one alone would have changed nothing.
 */
describe('routing a retry back to the account that already has the context', () => {
  let codexInstalled: (() => boolean) | undefined

  const seedConversation = (opts: {
    sessionId: string
    workerId: string
    adapterId: string
    taskId: string | null
    cwd: string
    contextTokens: number
    /** ms from now; negative means the prefix has already lapsed. */
    cacheLeftMs: number | null
  }): void => {
    const now = Date.now()
    const lastRequest = now - 60_000
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, started_at,
                               closed_at, tokens_since_compact, purpose, context_tokens,
                               last_request_started_at, cache_expires_at, vendor_session_id)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        opts.sessionId,
        opts.workerId,
        opts.adapterId,
        'stream',
        opts.cwd,
        'closed',
        now - 600_000,
        now - 300_000,
        0,
        'work',
        opts.contextTokens,
        lastRequest,
        opts.cacheLeftMs === null ? null : now + opts.cacheLeftMs,
        'vendor-' + opts.sessionId
      )
    // ⛔ A recorded turn, because `reopenable` requires one — a resume onto an id the CLI never
    // wrote fails the process outright rather than starting fresh (cost-model.md §7).
    db.db()
      .prepare('insert into turns (session_id, request_id, ts, input_tokens) values (?,?,?,?)')
      .run(opts.sessionId, 'req-' + opts.sessionId, lastRequest, 10)
    if (opts.taskId) {
      db.db()
        .prepare(
          `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, outcome)
           values (?,?,?,?,?,?,?)`
        )
        .run(
          'run-' + opts.sessionId,
          opts.taskId,
          opts.sessionId,
          opts.workerId,
          now - 600_000,
          now - 300_000,
          'success'
        )
    }
  }

  const termsOf = (choice: ReturnType<typeof scoring.chooseTarget>) =>
    Object.fromEntries((choice.breakdown?.terms ?? []).map((t) => [t.name, t]))

  beforeAll(async () => {
    const { openaiCompatible } = await import('./adapters/openai-compatible.js')
    codexInstalled = openaiCompatible.isInstalled
    openaiCompatible.isInstalled = () => true
  })

  afterAll(async () => {
    if (codexInstalled) {
      const { openaiCompatible } = await import('./adapters/openai-compatible.js')
      openaiCompatible.isInstalled = codexInstalled
    }
  })

  it('picks the account holding this task closed conversation over a cold one', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const codex = workers.createWorker({
      adapterId: 'openai-compatible',
      label: 'CodexFirst-t123',
      enabled: true
    })
    const claude = workers.createWorker({
      adapterId: 'claude-code',
      label: 'ClaudeThird-t123',
      enabled: true
    })

    const task = tasks.createTask({ title: 't123 retry the commit' })

    // The conversation that did the work, closed because `codex exec` exits after its turn.
    seedConversation({
      sessionId: 'codex-t123',
      workerId: codex.id,
      adapterId: 'openai-compatible',
      taskId: task.id,
      cwd: dir,
      contextTokens: 175_626,
      cacheLeftMs: 10 * 60 * 1000
    })
    // ⚠️ ClaudeThird gets a conversation too, on **another** task. Without it this would prove only
    // that a proven account beats an unproven one — `unproven` is a 0.35 penalty and would carry the
    // result by itself. Both accounts have now demonstrably produced a turn, so the term under test
    // is the one left between them.
    seedConversation({
      sessionId: 'claude-other',
      workerId: claude.id,
      adapterId: 'claude-code',
      taskId: null,
      cwd: dir,
      contextTokens: 40_000,
      cacheLeftMs: 30 * 60 * 1000
    })

    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(codex.id)

    const terms = termsOf(choice)
    expect(terms.contextHeld?.value).toBe(1)
    expect(terms.cold?.value).toBe(0)
    // ⛔ 10 of 30 minutes on codex is a third of its cache, not a sixth of an hour. Dividing by a
    // hard-coded 60m — which is what the score did — penalised the shorter-TTL provider for having
    // a shorter TTL, on the one term whose whole job is to say how much is left.
    expect(terms.cacheWarmth?.value).toBeCloseTo(1 / 3, 2)
    expect(terms.cacheWarmth?.basis).toContain('30m cache TTL')
    expect(terms.contextHeld?.basis).toContain('can be reopened')
  })

  it('still prefers it once the prefix has lapsed, and says the cache is gone', () => {
    // ⚠️ Two separate claims. A lapsed conversation still *remembers the task*, which is the greater
    // part of why reopening beats starting over — so `contextHeld` holds. What it no longer comes with
    // is a discount, and `cacheWarmth` is the term that has to say so. Scoring a cold prefix as warm would
    // be the lie this whole change exists to stop telling.
    db.db().prepare('update workers set enabled = 0').run()
    const codex = workers.createWorker({
      adapterId: 'openai-compatible',
      label: 'CodexFirst-lapsed',
      enabled: true
    })
    const task = tasks.createTask({ title: 'retry after the TTL ran out' })
    seedConversation({
      sessionId: 'codex-lapsed',
      workerId: codex.id,
      adapterId: 'openai-compatible',
      taskId: task.id,
      cwd: dir,
      contextTokens: 120_000,
      cacheLeftMs: -60_000
    })

    const terms = termsOf(scoring.chooseTarget(tasks.requireTask(task.id)))
    expect(terms.contextHeld?.value).toBe(1)
    expect(terms.cacheWarmth?.value).toBe(0)
  })

  it('will not reopen a conversation on an adapter that cannot resume', () => {
    // ⛔ The gate that keeps the promise honest. `reopenableFor` asks `reopenable`, which is the same
    // list `resumableSession` asks — so the score can never promise a warm continuation that the
    // dispatch would then decline to make.
    db.db().prepare('update workers set enabled = 0').run()
    const local = workers.createWorker({
      adapterId: 'local-llm',
      label: 'qwen-no-resume',
      enabled: true
    })
    const task = tasks.createTask({ title: 'no resume here' })
    seedConversation({
      sessionId: 'local-1',
      workerId: local.id,
      adapterId: 'local-llm',
      taskId: task.id,
      cwd: dir,
      contextTokens: 90_000,
      cacheLeftMs: 20 * 60 * 1000
    })

    const terms = termsOf(scoring.chooseTarget(tasks.requireTask(task.id)))
    expect(terms.contextHeld?.value).toBe(0)
    expect(terms.cold?.value).toBe(1)
  })
})

/**
 * The conversation that already exists, and the consult that used to be spent choosing against it.
 *
 * ⛔ **t269, read off the judgment call itself.** Two candidates were offered within ε of each other;
 * one already held the task's own conversation and the other did not, and the question described
 * *both* as a cold start against one fleet-wide cost figure. Nothing the controller was shown could
 * see the reuse, so the answer could not weigh it — the tie was decided on the labels again.
 */
describe('a tie between a conversation that exists and one that does not', () => {
  const held = { id: 's1' } as Session

  const candidate = (
    label: string,
    reuse: { session?: Session | null; resumable?: Session | null } = {}
  ): WorkerChoice => ({
    worker: { id: label, label } as Worker,
    session: reuse.session ?? null,
    resumable: reuse.resumable ?? null,
    reason: '',
    quotaUnverified: false,
    score: -0.12
  })

  it('is won by the live conversation, so no controller turn is spent', () => {
    const warm = candidate('warm', { session: held })
    const winner = scoring.reuseTieBreak([warm, candidate('cold')])
    expect(winner).toBe(warm)
  })

  it('is won by a closed conversation this task can reopen, too', () => {
    // ⛔ The half a one-shot CLI can ever have. `codex exec` never leaves a live idle session, so
    // reading `session` alone would hand every tie on that adapter to a cold start.
    const reopenable = candidate('reopenable', { resumable: held })
    const winner = scoring.reuseTieBreak([candidate('cold'), reopenable])
    expect(winner).toBe(reopenable)
  })

  it('takes the highest-scoring reuser, because this breaks a tie rather than re-ranking one', () => {
    const first = candidate('warm-first', { session: held })
    const second = candidate('warm-second', { session: held })
    expect(scoring.reuseTieBreak([first, second, candidate('cold')])).toBe(first)
  })

  it('says nothing when reuse does not separate the field', () => {
    // Every candidate holds one, or none does: either way the consult is still the honest answer.
    expect(scoring.reuseTieBreak([candidate('a'), candidate('b')])).toBeNull()
    expect(
      scoring.reuseTieBreak([
        candidate('a', { session: held }),
        candidate('b', { resumable: held })
      ])
    ).toBeNull()
    expect(scoring.reuseTieBreak([])).toBeNull()
  })
})

/**
 * What the controller is told about where a candidate would be starting from.
 *
 * ⚠️ Pure prose checks. The question is the only thing the controller ever sees, so a candidate the
 * scorer priced as warm and the sentence called cold is a defect in the *question*, not the score.
 */
describe('the routing question describes reuse the way the score does', () => {
  const task = { id: 't', seq: 269, title: 'a large task', kind: 'work' } as Parameters<
    typeof import('./judgment.js').routeQuestion
  >[0]

  const candidate = (
    label: string,
    extra: Partial<Parameters<typeof import('./judgment.js').routeQuestion>[1][number]> = {}
  ): Parameters<typeof import('./judgment.js').routeQuestion>[1][number] => ({
    worker: { id: label, label } as Worker,
    score: -0.12,
    warm: false,
    note: '',
    ...extra
  })

  it('never calls a reopenable conversation a cold start', async () => {
    const { routeQuestion } = await import('./judgment.js')
    const q = routeQuestion(task, [
      candidate('opus', { warm: true, reuse: 'reopen' }),
      candidate('sonnet')
    ])
    const line = (id: string) => q.split(/\r?\n/).find((l) => l.startsWith(`- ${id}`)) ?? ''
    expect(line('opus')).toContain('closed but reopenable')
    expect(line('opus')).not.toContain('cold start')
    // ⚠️ The candidate that really has nothing is still described as having nothing.
    expect(line('sonnet')).toContain('cold start')
  })

  it('prices each candidate from where it starts, not the fleet from nowhere', async () => {
    const { routeQuestion } = await import('./judgment.js')
    const estimate = (usd: number) =>
      ({ usd, tokens: 200_000, pricedTokens: 200_000, basis: 'measured', confidence: 'high' }) as
        Parameters<typeof import('./judgment.js').routeQuestion>[1][number]['estimate']
    const q = routeQuestion(task, [
      candidate('opus', { warm: true, reuse: 'live', estimate: estimate(0.04) }),
      candidate('sonnet', { estimate: estimate(0.31) })
    ])
    expect(q).toContain('$0.04')
    expect(q).toContain('$0.31')
    // ⛔ The one fleet-wide `pessimisticOn()` figure is dropped once each candidate carries its own:
    // two different quantities under the same word is how both candidates came to look identical.
    expect(q).not.toMatch(/^estimated /m)
  })

  it('tells the controller outright to prefer the conversation that already exists', async () => {
    const { routeQuestion } = await import('./judgment.js')
    const q = routeQuestion(task, [candidate('opus', { warm: true, reuse: 'live' }), candidate('sonnet')])
    expect(q).toMatch(/pick the candidate that already holds this task/i)
  })

  it('gives a person auditing the decision the same sentence', async () => {
    const { routeDetail } = await import('./judgment.js')
    const detail = routeDetail(task, [candidate('opus', { warm: true, reuse: 'reopen' })])
    expect(detail).toContain('closed but reopenable')
  })
})

describe('warmth as a fraction of what the provider granted', () => {
  it('scores a full prefix as 1 whatever window it was granted', async () => {
    const { costModel } = await import('./costmodel.js')
    const anthropic = costModel('anthropic.subscription.2026-08')
    const codex = costModel('openai.codex.2026-08')

    const now = Date.now()
    // Both sessions made a request one minute ago, so both hold an almost untouched prefix.
    const started = now - 60_000
    const warmthOf = (model: ReturnType<typeof costModel>): number => {
      const expiry = model.cacheExpiryFor({ contextTokens: 40_000, lastRequestStartedAt: started })
      const ttl = model.cacheTtlMs()
      expect(expiry).not.toBeNull()
      expect(ttl).not.toBeNull()
      return Math.max(0, Math.min(1, ((expiry as number) - now) / (ttl as number)))
    }

    expect(warmthOf(anthropic)).toBeGreaterThan(0.95)
    // ⛔ The assertion that was false: against a fixed hour this was 0.48.
    expect(warmthOf(codex)).toBeGreaterThan(0.95)
  })
})

/**
 * The accounts a split's pieces are allowed to run on.
 *
 * ⛔ **The whole of the operator's complaint in t197, at the layer that decides.** They named two
 * small, cheap accounts for the pieces; a piece was dispatched to the largest model in the fleet.
 * The list has to be a *gate* — a candidate that is not on it is discarded, not merely scored lower —
 * because scoring can always be outweighed and a routing preference is not what was asked for.
 *
 * ⚠️ Every account here is `claude-code`. The adapter is irrelevant to the rule and Antigravity
 * permits exactly one account per machine, so using it would test the commissioning limit instead.
 */
describe('a task pinned to a list of accounts', () => {
  it('is never dispatched to an account that is not on the list', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const chosen = workers.createWorker({ adapterId: 'claude-code', label: 'Small-pieces-A', enabled: true })
    const notChosen = workers.createWorker({ adapterId: 'claude-code', label: 'Expensive-default', enabled: true })

    // ⛔ The excluded account is given the *emptiest* window, which makes it the one scoring would
    // reach for. The gate has to beat the score, or the operator's list is only a preference.
    const now = Date.now()
    const sample = db.db().prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
       values (?,?,?,?,?,?,?)`
    )
    sample.run(chosen.id, 'session', 'Claude 5h', 40, now + 4 * 3600 * 1000, 'cli', now)
    sample.run(notChosen.id, 'session', 'Claude 5h', 0, now + 4 * 3600 * 1000, 'cli', now)

    const task = tasks.createTask({
      title: 'a piece of somebody else’s plan',
      constraints: { workerIds: [chosen.id] }
    })

    const choice = scoring.chooseTarget(task)
    expect(choice.worker?.id).toBe(chosen.id)
  })

  it('waits rather than routing around a list whose accounts are all switched off', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const offline = workers.createWorker({ adapterId: 'claude-code', label: 'Named-but-off', enabled: false })
    workers.createWorker({ adapterId: 'claude-code', label: 'Tempting-substitute', enabled: true })

    const task = tasks.createTask({
      title: 'a piece whose accounts are unavailable',
      constraints: { workerIds: [offline.id] }
    })

    // ⛔ No worker, not "the next best one". Silently substituting an account the operator excluded
    // is the failure this gate exists to make impossible.
    expect(scoring.chooseTarget(task).worker).toBeNull()
  })

  it('gives each named account the model chosen for it, not one model for the fleet', async () => {
    const { resolveModelChoice } = await import('@shared/tasks.js')
    const first = workers.createWorker({ adapterId: 'claude-code', label: 'Per-worker-model-A', enabled: true })
    const second = workers.createWorker({ adapterId: 'claude-code', label: 'Per-worker-model-B', enabled: true })

    const constraints = {
      workerIds: [first.id, second.id],
      modelsByWorker: { [first.id]: 'claude-haiku-4-5-20251001', [second.id]: 'claude-sonnet-5' }
    }
    expect(resolveModelChoice(constraints, first, false).model).toBe('claude-haiku-4-5-20251001')
    expect(resolveModelChoice(constraints, second, false).model).toBe('claude-sonnet-5')
  })

  it('rejects workers with role controller from taking work tasks', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const ctrl = workers.createWorker({ adapterId: 'claude-code', label: 'Ctrl-only', enabled: true })
    db.db().prepare('update workers set role = ? where id = ?').run('controller', ctrl.id)
    const workTask = tasks.createTask({
      title: 'a work task',
      constraints: { workerId: ctrl.id }
    })
    const choice = scoring.chooseTarget(workTask)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('controller only')
  })

  /**
   * ⛔ `none` is the role an operator lands on by unticking both boxes, and the work gate has to
   * read it as "not a worker". Written as `role === 'controller'` the gate would have offered this
   * account every task, because a role that does nothing is not literally `controller`.
   */
  it('rejects workers held out of both roles from taking work tasks', () => {
    db.db().prepare('update workers set enabled = 0').run()
    const idle = workers.createWorker({ adapterId: 'claude-code', label: 'Neither', enabled: true })
    db.db().prepare('update workers set role = ? where id = ?').run('none', idle.id)
    const workTask = tasks.createTask({
      title: 'a work task',
      constraints: { workerId: idle.id }
    })
    const choice = scoring.chooseTarget(workTask)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('held out of both work and judgment')
  })
})

describe('model-aware routing', () => {
  beforeEach(() => {
    db.db().prepare('update workers set enabled = 0').run()
  })

  it('headline: with empty allowlist, candidate set and every score are identical to single-model behavior', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'SingleModelW', enabled: true })
    const task = tasks.createTask({ title: 'A single model task', constraints: { workerId: w.id } })
    const choice = scoring.chooseTarget(task)
    expect(choice.worker?.id).toBe(w.id)
    expect(choice.scored).toHaveLength(1)
    expect(choice.scored?.[0]?.model).toBeNull()
    expect(choice.model).toBeNull()
  })

  /**
   * ⛔ **The safety property this whole feature rests on, asserted on the arithmetic rather than on
   * the candidate list.** The test above checks that an un-opted-in worker still produces one
   * candidate; that is necessary and it is not the claim. The claim is that *the scores do not
   * move*, and for a while they did: `routableModelsFor` hands back the worker's current default
   * model — a real id, not null — so `fitness` read a benchmark prior for it and `price` estimated
   * it. Two accounts defaulting to different models then scored 0.549 apart on a medium-complexity
   * task and 1.040 apart on a high one, against a `ROUTE_EPSILON` of 0.10, on a fleet where nobody
   * had asked for model-aware routing at all. Both terms are pinned at exactly 0 until some worker
   * has an allowlist — see `modelRoutingActive`.
   */
  it('holds both new terms at zero on a fleet where no worker has an allowlist, whatever the defaults are', () => {
    const a = workers.createWorker({ adapterId: 'claude-code', label: 'DefaultOpus', enabled: true })
    const b = workers.createWorker({ adapterId: 'claude-code', label: 'DefaultHaiku', enabled: true })
    // ⚠️ Deliberately far apart in prior: opus-5 is published at 0.846 and haiku-4-5 is inferred at
    // 0.418, the widest gap this fleet's own cost models can produce.
    workers.updateWorker(a.id, { defaultModel: 'claude-opus-5' })
    workers.updateWorker(b.id, { defaultModel: 'claude-haiku-4-5-20251001' })
    expect(workers.modelRoutingActive()).toBe(false)

    // ⚠️ A prompt heavy enough to clear the `low` band, where both priors clear the 0.35 bar and tie
    // regardless — asserting there would pass vacuously and catch nothing.
    const prompt =
      'Refactor the authentication middleware across src/daemon/auth.ts and src/shared/session.ts, ' +
      'migrate every caller to the new token shape, and add regression tests. Acceptance criteria: ' +
      '1. no caller reads the legacy field 2. the suites stay green 3. the migration is replay-safe.'

    // ⛔ One pinned task per worker rather than one open field: a two-worker field on identical
    // accounts ties, and a tie defers to a controller consult that returns before any score is
    // attached. Pinning asks the same question — what did `fitness` and `price` score for this
    // pair — without routing the answer through a consult.
    for (const w of [a, b]) {
      const task = tasks.createTask({ title: prompt, constraints: { workerId: w.id } })
      expect(complexityOf(task).band).not.toBe('low')
      const choice = scoring.chooseTarget(task)
      const scored = choice.scored ?? []
      expect(scored, `${w.label} produced a scored field`).toHaveLength(1)
      for (const name of ['fitness', 'price']) {
        const term = scored[0]?.terms.find((t) => t.name === name)
        expect(term, `${w.label} has a ${name} term`).toBeDefined()
        expect(term?.value, `${w.label} ${name} value`).toBe(0)
        // ⚠️ `toBeCloseTo`, not `toBe`: `price` carries sign −1, so its zero contribution is −0,
        // and `Object.is(-0, 0)` is false. The term is off either way.
        expect(term?.contribution, `${w.label} ${name} contribution`).toBeCloseTo(0, 12)
        // ⚠️ `AGENTS.md`: every belief carries its basis. A silent 0 reads as *measured and bad*.
        expect(term?.basis, `${w.label} ${name} basis`).toContain('inert')
      }
    }
  })

  it('switches both terms on for the whole field as soon as one worker opts in', () => {
    const a = workers.createWorker({ adapterId: 'claude-code', label: 'OptedIn', enabled: true })
    workers.updateWorker(a.id, { routableModels: ['claude-opus-5', 'claude-haiku-4-5-20251001'] })
    expect(workers.modelRoutingActive()).toBe(true)

    const task = tasks.createTask({
      title:
        'Refactor the authentication middleware across src/daemon/auth.ts and src/shared/session.ts, ' +
        'migrate every caller to the new token shape, and add regression tests. Acceptance criteria: ' +
        '1. no caller reads the legacy field 2. the suites stay green 3. the migration is replay-safe.',
      constraints: { workerId: a.id }
    })
    expect(complexityOf(task).band).not.toBe('low')
    const scored = scoring.chooseTarget(task).scored ?? []
    expect(scored).toHaveLength(2)

    // ⛔ Neither term may still be claiming inertness once a worker has opted in.
    for (const cand of scored) {
      for (const name of ['fitness', 'price']) {
        expect(cand.terms.find((t) => t.name === name)?.basis).not.toContain('inert')
      }
    }

    // ⭐ The prior actually separates the pair: opus clears the bar for this band and haiku does not.
    const byModel = new Map(scored.map((c) => [c.model, c]))
    const opus = byModel.get('claude-opus-5')?.terms.find((t) => t.name === 'fitness')
    const haiku = byModel.get('claude-haiku-4-5-20251001')?.terms.find((t) => t.name === 'fitness')
    expect(opus?.value).toBeGreaterThan(haiku?.value ?? 1)

    // ⚠️ `price` is asserted only to be *live*, not to be non-zero. It divides by the cheapest
    // candidate in the field, and on a database with no finished runs every pair estimates the same
    // cold fallback — so a ratio of exactly 1, and a value of 0, is the honest answer here rather
    // than a term that failed to fire. See `estimateTask`: `usd` comes from priced run history, and
    // no cost model in this repo carries a per-mtok price to substitute for it.
    for (const cand of scored) {
      const price = cand.terms.find((t) => t.name === 'price')
      expect(price?.value).toBeGreaterThanOrEqual(0)
    }
  })

  /**
   * ⚠️ An allowlist only counts on an account that could actually be handed a turn. A `controller`
   * account is reserved for judgment and consults, `none` is held out of both (t223), and a
   * switched-off account is skipped before it is ever scored — so widening any of the three would
   * switch the two model-aware terms on for every *other* account while the widened one never
   * entered a field. `modelRoutingActive` asks `enabled` and `canWork` for the same reason it
   * excludes retired accounts.
   */
  it('is not switched on by an allowlist on an account that could never be handed a turn', () => {
    const pair = ['claude-opus-5', 'claude-haiku-4-5-20251001']

    const judge = workers.createWorker({ adapterId: 'claude-code', label: 'JudgeOnly', enabled: true })
    workers.updateWorker(judge.id, { role: 'controller', routableModels: pair })
    expect(workers.modelRoutingActive(), 'controller-only').toBe(false)

    const held = workers.createWorker({ adapterId: 'claude-code', label: 'HeldOut', enabled: true })
    workers.updateWorker(held.id, { role: 'none', routableModels: pair })
    expect(workers.modelRoutingActive(), 'held out of both').toBe(false)

    const off = workers.createWorker({ adapterId: 'claude-code', label: 'SwitchedOff', enabled: false })
    workers.updateWorker(off.id, { routableModels: pair })
    expect(workers.modelRoutingActive(), 'switched off').toBe(false)

    // ⭐ And one account that could be handed a turn is enough, which is the other half of the claim.
    const doer = workers.createWorker({ adapterId: 'claude-code', label: 'Doer', enabled: true })
    workers.updateWorker(doer.id, { routableModels: ['claude-opus-5'] })
    expect(workers.modelRoutingActive(), 'one that can work').toBe(true)
  })

  it('warm session yields 1 pair at session model', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'WarmWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'] })
    const task = tasks.createTask({ title: 'Warm session task', constraints: { workerId: w.id } })

    const sId = 'session-warm-1'
    db.db().prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, purpose, started_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sId, w.id, 'claude-code', 'stream', w.isolationRoot, 'claude-sonnet-5', 'live', 'work', Date.now())
    db.db().prepare(
      `insert into runs (id, task_id, session_id, worker_id, kind, started_at, ended_at, outcome)
       values (?, ?, ?, ?, 'work', ?, ?, 'complete')`
    ).run('run-warm-1', task.id, sId, w.id, Date.now() - 1000, Date.now())

    const choice = scoring.chooseTarget(task)
    expect(choice.session?.id).toBe(sId)
    const candidates = choice.scored?.filter((s) => s.workerId === w.id)
    expect(candidates).toHaveLength(1)
    expect(candidates?.[0]?.model).toBe('claude-sonnet-5')
  })

  it('pinned model yields 1 pair (via constraints.model and modelsByWorker)', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'PinnedWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'] })

    const task1 = tasks.createTask({
      title: 'Pinned model task',
      constraints: { model: 'claude-haiku-4-5-20251001', workerId: w.id }
    })
    const choice1 = scoring.chooseTarget(task1)
    const candidates1 = choice1.scored?.filter((s) => s.workerId === w.id)
    expect(candidates1).toHaveLength(1)
    expect(candidates1?.[0]?.model).toBe('claude-haiku-4-5-20251001')

    const task2 = tasks.createTask({
      title: 'ModelsByWorker task',
      constraints: { modelsByWorker: { [w.id]: 'claude-opus-5' }, workerId: w.id }
    })
    const choice2 = scoring.chooseTarget(task2)
    const candidates2 = choice2.scored?.filter((s) => s.workerId === w.id)
    expect(candidates2).toHaveLength(1)
    expect(candidates2?.[0]?.model).toBe('claude-opus-5')
  })

  /**
   * ⭐ The composer's *Inherit — <model>* answer, which used to be the same silence as *Auto* and
   * therefore was not an answer at all: a CodexFirst pin reading `Inherit — GPT 5.6 Sol` dispatched
   * whatever the router scored best out of the account's allowlist, and the thread reported a model
   * nobody had picked. `modelPolicy: 'inherit'` is that choice said out loud.
   */
  it('modelPolicy inherit yields the account default alone, not the allowlist', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'InheritWorker', enabled: true })
    workers.updateWorker(w.id, {
      defaultModel: 'claude-sonnet-5',
      routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']
    })

    const auto = tasks.createTask({ title: 'Auto model task', constraints: { workerId: w.id } })
    expect(scoring.chooseTarget(auto).scored?.filter((s) => s.workerId === w.id)).toHaveLength(3)

    const inherit = tasks.createTask({
      title: 'Inherited model task',
      constraints: { workerId: w.id, modelPolicy: 'inherit' }
    })
    const candidates = scoring.chooseTarget(inherit).scored?.filter((s) => s.workerId === w.id)
    expect(candidates).toHaveLength(1)
    expect(candidates?.[0]?.model).toBe('claude-sonnet-5')
  })

  describe('reassign routing scenarios and model constraints (t254 bug fix)', () => {
    it('reassigning to a worker with account default (modelPolicy inherit) chooses default model alone, ignoring cheaper routable models', () => {
      db.db().prepare('update workers set enabled = 0').run()
      const w = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst-OpusDefault', enabled: true })
      workers.updateWorker(w.id, {
        defaultModel: 'claude-opus-5',
        routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']
      })

      // Task reassigned with modelPolicy: 'inherit' (as done when selecting account default in UI)
      const task = tasks.createTask({
        title: 'Reassigned task',
        constraints: { workerId: w.id, modelPolicy: 'inherit' }
      })

      const choice = scoring.chooseTarget(task)
      const candidates = choice.scored?.filter((s) => s.workerId === w.id)
      expect(candidates).toHaveLength(1)
      expect(candidates?.[0]?.model).toBe('claude-opus-5')
      expect(choice.worker?.id).toBe(w.id)
      expect(choice.model).toBe('claude-opus-5')
    })

    it('prior session on a different model (Haiku) cannot override task.constraints.model (Opus)', () => {
      db.db().prepare('update workers set enabled = 0').run()
      const w = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst-PriorSession', enabled: true })
      workers.updateWorker(w.id, {
        defaultModel: 'claude-opus-5',
        routableModels: ['claude-haiku-4-5-20251001', 'claude-opus-5']
      })

      const task = tasks.createTask({
        title: 'Task with past Haiku session',
        constraints: { workerId: w.id, model: 'claude-opus-5' }
      })

      // Seed a closed past session that ran on haiku
      const now = Date.now()
      db.db()
        .prepare(
          `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, started_at,
                                 closed_at, tokens_since_compact, purpose, context_tokens,
                                 last_request_started_at, cache_expires_at, vendor_session_id)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'sess-haiku-past',
          w.id,
          'claude-code',
          'stream',
          dir,
          'claude-haiku-4-5-20251001',
          'closed',
          now - 600_000,
          now - 300_000,
          0,
          'work',
          10_000,
          now - 300_000,
          now + 600_000,
          'vendor-haiku'
        )
      db.db()
        .prepare('insert into turns (session_id, request_id, ts, input_tokens) values (?,?,?,?)')
        .run('sess-haiku-past', 'req-haiku', now - 300_000, 10)
      db.db()
        .prepare(
          `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, outcome, model)
           values (?,?,?,?,?,?,?,?)`
        )
        .run('run-haiku-past', task.id, 'sess-haiku-past', w.id, now - 600_000, now - 300_000, 'success', 'claude-haiku-4-5-20251001')

      const choice = scoring.chooseTarget(task)
      const candidates = choice.scored?.filter((s) => s.workerId === w.id)
      expect(candidates).toHaveLength(1)
      expect(candidates?.[0]?.model).toBe('claude-opus-5')
      expect(choice.model).toBe('claude-opus-5')
    })

    it('prior session on a different model (Haiku) cannot override modelPolicy inherit (Opus)', () => {
      db.db().prepare('update workers set enabled = 0').run()
      const w = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst-InheritPrior', enabled: true })
      workers.updateWorker(w.id, {
        defaultModel: 'claude-opus-5',
        routableModels: ['claude-haiku-4-5-20251001', 'claude-opus-5']
      })

      const task = tasks.createTask({
        title: 'Task with past Haiku session and inherit policy',
        constraints: { workerId: w.id, modelPolicy: 'inherit' }
      })

      const now = Date.now()
      db.db()
        .prepare(
          `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, started_at,
                                 closed_at, tokens_since_compact, purpose, context_tokens,
                                 last_request_started_at, cache_expires_at, vendor_session_id)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'sess-haiku-past-2',
          w.id,
          'claude-code',
          'stream',
          dir,
          'claude-haiku-4-5-20251001',
          'closed',
          now - 600_000,
          now - 300_000,
          0,
          'work',
          10_000,
          now - 300_000,
          now + 600_000,
          'vendor-haiku-2'
        )
      db.db()
        .prepare('insert into turns (session_id, request_id, ts, input_tokens) values (?,?,?,?)')
        .run('sess-haiku-past-2', 'req-haiku-2', now - 300_000, 10)
      db.db()
        .prepare(
          `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, outcome, model)
           values (?,?,?,?,?,?,?,?)`
        )
        .run('run-haiku-past-2', task.id, 'sess-haiku-past-2', w.id, now - 600_000, now - 300_000, 'success', 'claude-haiku-4-5-20251001')

      const choice = scoring.chooseTarget(task)
      const candidates = choice.scored?.filter((s) => s.workerId === w.id)
      expect(candidates).toHaveLength(1)
      expect(candidates?.[0]?.model).toBe('claude-opus-5')
      expect(choice.model).toBe('claude-opus-5')
    })

    it('live warm session on Haiku is rejected by warmSessionFor when task specifies modelPolicy inherit (Opus default)', () => {
      const w = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst-LiveHaiku', enabled: true })
      workers.updateWorker(w.id, {
        defaultModel: 'claude-opus-5',
        routableModels: ['claude-haiku-4-5-20251001', 'claude-opus-5']
      })

      const task = tasks.createTask({
        title: 'Task wanting Opus default',
        constraints: { workerId: w.id, modelPolicy: 'inherit' }
      })

      const now = Date.now()
      db.db()
        .prepare(
          `insert into sessions (id, worker_id, adapter_id, transport, cwd, model, state, started_at,
                                 closed_at, tokens_since_compact, purpose, context_tokens,
                                 last_request_started_at, cache_expires_at, vendor_session_id)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'sess-live-haiku',
          w.id,
          'claude-code',
          'stream',
          dir,
          'claude-haiku-4-5-20251001',
          'idle',
          now - 60_000,
          null,
          0,
          'work',
          10_000,
          now - 10_000,
          now + 600_000,
          'vendor-live-haiku'
        )
      db.db()
        .prepare(
          `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, outcome, model)
           values (?,?,?,?,?,?,?,?)`
        )
        .run('run-live-haiku', task.id, 'sess-live-haiku', w.id, now - 60_000, null, null, 'claude-haiku-4-5-20251001')

      // Since session is running Haiku but task asks for Opus via inherit policy, warmSessionFor must refuse
      expect(scheduler.warmSessionFor(task, w.id)).toBeNull()
    })

    it('explicit modelPolicy auto evaluates all routable models for the worker', () => {
      const w = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst-Auto', enabled: true })
      workers.updateWorker(w.id, {
        defaultModel: 'claude-opus-5',
        routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5']
      })

      const task = tasks.createTask({
        title: 'Auto model task',
        constraints: { workerId: w.id, modelPolicy: 'auto' }
      })

      const choice = scoring.chooseTarget(task)
      const candidates = choice.scored?.filter((s) => s.workerId === w.id)
      expect(candidates).toHaveLength(3)
    })
  })

  it('multiple allowlisted models yield multiple candidate pairs', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'MultiModelWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'] })
    const task = tasks.createTask({ title: 'Multi model task', constraints: { workerId: w.id } })
    const choice = scoring.chooseTarget(task)
    const candidates = choice.scored?.filter((s) => s.workerId === w.id)
    expect(candidates).toHaveLength(2)
    const models = candidates?.map((c) => c.model)
    expect(models).toContain('claude-haiku-4-5-20251001')
    expect(models).toContain('claude-sonnet-5')
  })

  it('antigravity account with Claude pool at 95% and Gemini pool at 20% offers Gemini pair and not Claude', () => {
    const agy = workers.createWorker({ adapterId: 'antigravity-cli', label: 'AgyMultiPool', enabled: true })
    workers.updateWorker(agy.id, { routableModels: ['claude-sonnet-4-6', 'gemini-3.7-flash-high'] })

    const now = Date.now()
    const sample = db.db().prepare(
      `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at, window_group)
       values (?,?,?,?,?,?,?,?)`
    )
    sample.run(agy.id, 'session', 'Claude 5h', 95, now + 4 * 3600 * 1000, 'cli', now, 'claude-and-gpt')
    sample.run(agy.id, 'gemini_session', 'Gemini 5h', 20, now + 4 * 3600 * 1000, 'cli', now, 'gemini')

    const task = tasks.createTask({ title: 'Multi-pool quota task', constraints: { workerId: agy.id } })
    const choice = scoring.chooseTarget(task)

    expect(choice.worker?.id).toBe(agy.id)
    expect(choice.model).toBe('gemini-3.7-flash-high')
    const scoredModels = choice.scored?.map((s) => s.model)
    expect(scoredModels).toContain('gemini-3.7-flash-high')
    expect(scoredModels).not.toContain('claude-sonnet-4-6')
  })

  it('dispatch preserves the chosen model in routing_decisions', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'DispatchWorker', enabled: true })
    const task = tasks.createTask({ title: 'Dispatch model test' })
    const choice: WorkerChoice = {
      worker: w,
      session: null,
      reason: 'test choice',
      quotaUnverified: false,
      score: 1.5,
      model: 'claude-haiku-4-5-20251001',
      objective: { cost: 0.3, velocity: 0.3, quality: 0.4 },
      routedBy: 'score',
      scored: [
        {
          chosen: true,
          workerId: w.id,
          label: w.label,
          adapterId: w.adapterId,
          model: 'claude-haiku-4-5-20251001',
          warm: false,
          quotaUnverified: false,
          score: 1.5,
          terms: []
        }
      ]
    }
    scheduler.noteRoutingDecision(task, choice)
    const record = db.row<{ candidates_json: string; basis: string }>(
      db.db().prepare('select candidates_json, basis from routing_decisions where task_id = ?').get(task.id)
    )
    expect(record?.basis).toBe('score')
    const parsedCandidates = JSON.parse(record?.candidates_json ?? '[]') as Array<{ chosen: boolean; model: string }>
    expect(parsedCandidates.find((c) => c.chosen)?.model).toBe('claude-haiku-4-5-20251001')
  })

  it('model cap bounds candidate pairs to 8 per worker', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'CappedWorker', enabled: true })
    const tenModels = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']
    workers.updateWorker(w.id, { routableModels: tenModels })
    const task = tasks.createTask({ title: 'Cap test task', constraints: { workerId: w.id } })
    const choice = scoring.chooseTarget(task)
    const candidateCount = choice.scored?.filter((s) => s.workerId === w.id).length
    expect(candidateCount).toBe(8)
  })

  it('low-complexity task picks cheap sufficient model over dear excellent one; high-complexity task flips it', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'ComplexityWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-opus-5'] })

    // Low complexity task: required = 0.35. Haiku prior 0.418 meets bar (fitness = 1.0) and is cheaper
    const lowTask = tasks.createTask({
      title: 'Fix typo',
      prompt: 'Fix typo',
      estTokens: 1_000,
      constraints: { workerId: w.id }
    })
    const lowChoice = scoring.chooseTarget(lowTask)
    expect(lowChoice.model).toBe('claude-haiku-4-5-20251001')

    // High complexity task: required = 0.75. Haiku (0.418 < 0.75) gets fitness value 0. Opus (0.846 >= 0.75) gets 1.0.
    const highTask = tasks.createTask({
      title: 'Architectural refactor of distributed migration engine with backwards compatibility',
      prompt: 'Refactor database migration architecture across distributed microservices with breaking schema changes',
      estTokens: 500_000,
      objective: { cost: 0.1, velocity: 0.1, quality: 0.8 },
      constraints: { workerId: w.id }
    })
    const highChoice = scoring.chooseTarget(highTask)
    expect(highChoice.model).toBe('claude-opus-5')
  })

  it('unmeasured fitness pair scores 0 for fitness with basis explaining absence and is still a candidate', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'UnmeasuredWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['custom-unmeasured-model-xyz'] })
    const task = tasks.createTask({ title: 'Unmeasured fitness task', constraints: { workerId: w.id } })
    const choice = scoring.chooseTarget(task)
    expect(choice.worker?.id).toBe(w.id)
    expect(choice.model).toBe('custom-unmeasured-model-xyz')
    const candidate = choice.scored?.find((s) => s.model === 'custom-unmeasured-model-xyz')
    expect(candidate).toBeDefined()
    const fitTerm = candidate?.terms.find((t) => t.name === 'fitness')
    expect(fitTerm).toBeDefined()
    expect(fitTerm?.value).toBe(0)
    expect(fitTerm?.basis).toContain('no public benchmark and no clean review')
  })

  it('price term is 0 for cheapest and saturates at 8x', () => {
    const priceValue = (cost: number, cheapest: number): number => {
      const ratio = cost / cheapest
      return Math.max(0, Math.min(1, Math.log(ratio) / Math.log(8)))
    }
    expect(priceValue(0.05, 0.05)).toBe(0)
    expect(priceValue(0.40, 0.05)).toBeCloseTo(1.0, 4)
    expect(priceValue(0.80, 0.05)).toBe(1.0)
    expect(priceValue(0.1414, 0.05)).toBeCloseTo(0.5, 2)
  })

  it('fallback to priced tokens when usd unavailable for any candidate', () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'PriceTokensWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'] })
    const task = tasks.createTask({ title: 'Tokens fallback task', constraints: { workerId: w.id } })
    const choice = scoring.chooseTarget(task)
    const candidates = choice.scored?.filter((s) => s.workerId === w.id)
    expect(candidates).toHaveLength(2)
    for (const c of candidates ?? []) {
      const pTerm = c.terms.find((t) => t.name === 'price')
      expect(pTerm).toBeDefined()
    }
  })

  it('memoization prevents calling estimateTask redundantly across candidates', async () => {
    const estimator = await import('./estimator.js')
    const spy = vi.spyOn(estimator, 'estimateTask')
    const w1 = workers.createWorker({ adapterId: 'claude-code', label: 'MemoW1', enabled: true })
    const w2 = workers.createWorker({ adapterId: 'claude-code', label: 'MemoW2', enabled: true })
    workers.updateWorker(w1.id, { routableModels: ['claude-sonnet-5'] })
    workers.updateWorker(w2.id, { routableModels: ['claude-sonnet-5'] })

    const task = tasks.createTask({ title: 'Memo test task' })
    spy.mockClear()
    scoring.chooseTarget(task)

    const matchingCalls = spy.mock.calls.filter(
      (call) => call[1]?.adapterId === 'claude-code' && call[1]?.model === 'claude-sonnet-5' && call[1]?.warm === false
    )
    expect(matchingCalls.length).toBe(1)
    spy.mockRestore()
  })

  it('explored decision records basis: explore, keeps full ranked field, and posts thread message', async () => {
    const w = workers.createWorker({ adapterId: 'claude-code', label: 'ExploreWorker', enabled: true })
    workers.updateWorker(w.id, { routableModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'] })
    const task = tasks.createTask({ title: 'Explore decision task', constraints: { workerId: w.id } })

    const { setSetting } = await import('./settings.js')
    try {
      setSetting('modelExploration', true)
      setSetting('modelExplorationRate', 1.0)

      const choice = scoring.chooseTarget(task)
      expect(choice.routedBy).toBe('explore')
      expect(choice.scored).toHaveLength(2)
      const chosenInScored = choice.scored?.find((s) => s.chosen)
      expect(chosenInScored?.model).toBe(choice.model)

      const messages = tasks.messagesFor(task.id)
      const exploreMsg = messages.find((m) => m.text.includes('Model exploration: trying'))
      expect(exploreMsg).toBeDefined()
    } finally {
      setSetting('modelExploration', false)
      setSetting('modelExplorationRate', 0.10)
    }
  })

  it('worked scenario with real numbers (docs/routing.md §5 Scenario 5)', async () => {
    const { weights } = await import('./objective.js')
    const obj = { cost: 0.3, velocity: 0.3, quality: 0.4 }
    const w = weights(obj)

    expect(w.fitness).toBeCloseTo(1.040, 3)
    expect(w.price).toBeCloseTo(1.100, 3)
    expect(w.cold).toBeCloseTo(1.190, 3)
    expect(w.capabilityFit).toBeCloseTo(1.220, 3)

    // Baseline cold + capabilityFit = -1.190 + 1.220 = +0.030
    const baseline = -w.cold + w.capabilityFit
    expect(baseline).toBeCloseTo(0.030, 3)

    // Low complexity task: required = 0.35
    // Model A: cheap ($0.05), fitness prior = 0.418 (Haiku). Since 0.418 >= 0.35, fitness value = 1.0
    // Price value = 0.0 (cheapest)
    // Score A = 0.030 + 1.040 * 1.0 - 1.100 * 0.0 = +1.070
    const scoreA = baseline + w.fitness * 1.0 - w.price * 0.0
    expect(scoreA).toBeCloseTo(1.070, 3)

    // Model B: expensive ($0.40, 8x), fitness prior = 0.846 (Opus). Since 0.846 >= 0.35, fitness value = 1.0
    // Price value = log(8)/log(8) = 1.0
    // Score B = 0.030 + 1.040 * 1.0 - 1.100 * 1.0 = -0.030
    const scoreB = baseline + w.fitness * 1.0 - w.price * 1.0
    expect(scoreB).toBeCloseTo(-0.030, 3)

    // Score gap = 1.070 - (-0.030) = 1.100 >> 0.10. Cheap model wins cleanly!
    expect(scoreA - scoreB).toBeCloseTo(1.100, 3)
  })
})
