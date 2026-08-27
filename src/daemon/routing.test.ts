import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session, Worker } from '@shared/protocol.js'
import type { Run } from '@shared/tasks.js'

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

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-routing-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  quota = await import('./quota.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  db.openDb(join(dir, 'routing.db'))
})

afterAll(() => {
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
    identity: null,
    health: null,
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
    expect(scheduler.unproven(ready, true)).toBeLessThan(scheduler.unproven(halfDone, true))
  })

  it('does not penalise an adapter that cannot answer the question', () => {
    // ⚠️ Antigravity keeps its credential in the OS keyring, so `setupComplete` is permanently null.
    // Reading that as a missing step would bench a healthy account for a fact it can never report.
    const cannotTell = { ...base, identity: { loggedIn: true, setupComplete: null } }
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    expect(scheduler.unproven(cannotTell, true)).toBe(scheduler.unproven(ready, true))
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
    expect(scheduler.unproven(keyring, true)).toBe(scheduler.unproven(ready, true))
  })

  it('still penalises a worker that is genuinely, checkably signed out', () => {
    // ⚠️ The other half. "Cannot tell" must be free; "we asked and it said no" must not be — or the
    // fix for the above would have thrown away a real signal to buy fairness for a null.
    const signedOut = { ...base, identity: { loggedIn: false, setupComplete: true } }
    const ready = { ...base, identity: { loggedIn: true, setupComplete: true } }
    expect(scheduler.unproven(signedOut, true)).toBeGreaterThan(scheduler.unproven(ready, true))
  })

  it('knows least about a worker nothing has ever probed', () => {
    expect(scheduler.unproven(base, false)).toBeGreaterThanOrEqual(1)
  })

  it('prefers an account that has actually produced a turn', () => {
    // ⛔ The strongest input, and the only one that is evidence rather than self-report. Measured
    // 2026-08-27: a never-signed-in Antigravity account — which answers every identity question with
    // "cannot tell", legitimately, because its credential is in the OS keyring — won a dispatch over
    // two working Claude workers, then failed in 0s. Whether a turn has ever come out of an account
    // is the one fact that separates those two cases, and it was not being consulted.
    const proven = { ...base, identity: { loggedIn: true, setupComplete: null } }
    const never = { ...base, identity: { loggedIn: true, setupComplete: null } }
    expect(scheduler.unproven(proven, true)).toBeLessThan(scheduler.unproven(never, false))
  })

  it('still lets an unproven worker be tried, because nothing else ever becomes proven', () => {
    // ⚠️ A penalty, never a gate. Every fleet starts with no proven account.
    expect(scheduler.unproven(base, false)).toBeLessThan(Infinity)
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
   * ⛔ The background sweep is not free in the way a file read is. On both adapters that have one,
   * `refreshUsage` opens a real interactive session and types into it - so on a worker whose
   * subscription has expired it spawned a CLI every thirty minutes to watch it fail to authenticate,
   * recorded `unknown`, and did it again. Held out of dispatch is effectively the same state as
   * disabled, and the sweep now treats it as one.
   */
  it('is not probed in the background once a run has proved work dies on it', () => {
    const worker = seedWorker('expired', Date.now())
    workers.updateWorker(worker.id, { enabled: true })
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(true)

    workers.recordDispatchFailure(worker.id, 'subscription expired', 'r1')
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(false)

    // ⛔ And it comes back the moment the hold lifts. A worker that could never be re-read would
    // stay `unknown` forever even after somebody fixed the account.
    workers.clearDispatchFailure(worker.id)
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(true)
  })

  it('is not probed while switched off or signed out either', () => {
    const worker = seedWorker('sweep-gates', Date.now())
    workers.updateWorker(worker.id, { enabled: false })
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(false)

    workers.updateWorker(worker.id, { enabled: true })
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(true)
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

    // Still held out, still not probed. Only the *advice* differs.
    expect(quota.shouldBackgroundRefresh(worker.id)).toBe(false)
  })

  it('records the verdict on the worker, so the panel does not have to guess', () => {
    const worker = seedWorker('expired-verdict', Date.now())
    workers.recordDispatchFailure(worker.id, 'Your subscription has expired', 'r3')
    expect(workers.requireWorker(worker.id).health?.needsReauth).toBe(true)
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

    // ⛔ Signing in is deliberately exempt from this gate. Off is not retirement: it holds an
    // account out of dispatch and leaves every way of fixing it open, including the one that needs
    // a terminal. A switch that locked the operator out of repairing what it switched off would be
    // a trap.
    //
    // ⚠️ Asserted by reading the gate, not by calling it with `purpose: 'login'`. That call does
    // not stop at a check - it goes on to spawn the vendor CLI in a real PTY, which makes the
    // assertion depend on whether this machine has that CLI installed, and leaves a process behind
    // on the one where it does. A test that passes for a different reason on CI than on a laptop is
    // worse than no test.
    const gate = readFileSync(new URL('sessions.ts', import.meta.url), 'utf8')
    expect(gate).toMatch(
      new RegExp(
        "if \\(purpose !== 'login'\\) \\{\\s*if \\(!worker\\.enabled\\)"
      )
    )
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
    for (let i = 0; i < 200; i++) activity.noteActivity('t-peek', `line ${i}`)
    const tail = activity.activityFor('t-peek')
    expect(tail.length).toBeLessThanOrEqual(40)
    // ⛔ The *newest* survive. A tail that dropped the latest lines would answer "what was it doing
    // a while ago", which is the one question nobody asks of a running task.
    expect(tail[tail.length - 1]?.text).toBe('line 199')
  })

  it('collapses an agent’s whitespace and caps one fragment', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-wide')
    activity.noteActivity('t-wide', `  reading\n\n   the   file  `)
    activity.noteActivity('t-wide', 'x'.repeat(5000))
    const tail = activity.activityFor('t-wide')
    expect(tail[0]?.text).toBe('reading the file')
    expect(tail[1]?.text.length).toBeLessThan(500)
  })

  it('ignores a fragment that says nothing', async () => {
    const activity = await import('./activity.js')
    activity.clearActivity('t-empty')
    activity.noteActivity('t-empty', '   \n  ')
    expect(activity.activityFor('t-empty')).toHaveLength(0)
  })

  it('is cleared for a new attempt', async () => {
    const activity = await import('./activity.js')
    activity.noteActivity('t-clear', 'from the run before')
    activity.clearActivity('t-clear')
    expect(activity.activityFor('t-clear')).toHaveLength(0)
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
    expect(scheduler.quotaRiskOf(worker.id)).toBe(0)
  })

  it('still penalises a worker the vendor has actually rate-limited', async () => {
    const quota = await import('./quota.js')
    const worker = seedWorker('rejected', 1_787_000_000_000)
    quota.recordRateLimit(worker.id, null, {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Date.now() + 3_600_000
    })
    expect(scheduler.quotaRiskOf(worker.id)).toBe(1)
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
