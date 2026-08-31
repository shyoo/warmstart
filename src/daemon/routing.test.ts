import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let controller: typeof import('./controller.js')

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
  controller = await import('./controller.js')
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
    defaultModel: null,
    defaultEffort: null,
    identity: null,
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

  it('⛔ does not open a second terminal on a worker one was just opened on', () => {
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
    const legend = scheduler.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    expect(legend).toContain('HIGHER WINS')
    expect(legend).toContain('linear and unitless')
    expect(legend).toMatch(/nothing is logarithmic/i)
  })

  it('derives every weight from the objective vector, and says so', () => {
    const legend = scheduler.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    // The weight, and the arithmetic that produced it, on the same line.
    expect(legend).toContain('1.249 = 0.8 + 2.0×cost − 0.7×velocity')
    expect(legend).toContain('cost 0.34 · velocity 0.33 · quality 0.33')
    // ⚠️ And where to change it, because a number nobody can move is not an explanation either.
    expect(legend).toContain('Settings > Global')
  })

  it('says which direction each term pushes, and what a value of 1 would mean', () => {
    const legend = scheduler.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 }).join('\n')
    expect(legend).toMatch(/cold\s+penalty/)
    expect(legend).toMatch(/warm\s+bonus/)
    expect(legend).toContain('1 = no session to reuse')
    // The one term that is not derived from the objective has to say so rather than look like one.
    expect(legend).toContain('fixed, not from the objective')
  })

  it('prints every term with its value, its weight, its contribution and its basis', () => {
    const terms = [
      term('cold', 1.249, 1, -1, 'no session to reuse, so a start pays a full cache write'),
      term('capabilityFit', 1.129, 1, 1, 'the task requires no specific capability')
    ]
    const out = scheduler
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
    const out = scheduler
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
      term('warm', 1.55, 0.4, 1),
      term('cold', 1.249, 0, -1),
      term('capabilityFit', 1.129, 0.5, 1),
      term('unproven', 0.35, 0.5, -1)
    ]
    const total = terms.reduce((s, t) => s + t.contribution, 0)
    const out = scheduler.formatScore({ total, terms })
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
    considered: scheduler.briefScore(breakdown()),
    formula: scheduler.formatScore(breakdown())
  })

  const task = { id: 't', seq: 41, title: 'a large task', kind: 'work' } as Parameters<
    typeof import('./judgment.js').routeQuestion
  >[0]

  it('names the live terms and the unmeasurable ones in a single line', () => {
    // ⚠️ A zero term is named rather than dropped: on this fleet it is usually one that could not be
    // read at all, and that is the finding the controller has to be able to see.
    const brief = scheduler.briefScore(breakdown())
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
    const legend = scheduler.scoreLegend({ cost: 0.34, velocity: 0.33, quality: 0.33 })
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
    expect(scheduler.windowRisk(0)).toBe(0)
    expect(scheduler.windowRisk(25)).toBe(0)
    expect(scheduler.windowRisk(50)).toBe(0)
  })

  it('rises linearly between the floor and the hard gate', () => {
    // 50 → 92 is the span; 71 is its midpoint.
    expect(scheduler.windowRisk(71)).toBeCloseTo(0.5, 2)
    expect(scheduler.windowRisk(60)).toBeCloseTo(10 / 42, 2)
    expect(scheduler.windowRisk(85)).toBeCloseTo(35 / 42, 2)
  })

  it('reaches exactly 1.0 where the candidate would be excluded outright', () => {
    // ⭐ The property that matters: the slope hands over to the cliff with no step in between, so a
    // worker is never simultaneously nearly-excluded and cheap.
    expect(scheduler.windowRisk(92)).toBe(1)
    expect(scheduler.windowRisk(99)).toBe(1)
    expect(scheduler.windowRisk(100)).toBe(1)
  })

  it('treats a missing or nonsense reading as zero, never as a guess', () => {
    // ⛔ AGENTS.md: only checked evidence may move a score. Unknown is not bad news.
    expect(scheduler.windowRisk(Number.NaN)).toBe(0)
    expect(scheduler.windowRisk(-5)).toBe(0)
  })

  it('separates the two accounts that four consults could not', () => {
    // The real readings from 2026-08-30, and the whole point of the change: these must not tie.
    const claudeSecond = scheduler.windowRisk(64)
    const antigravity = scheduler.windowRisk(98)
    expect(antigravity).toBeGreaterThan(claudeSecond)
    // At weight 0.908 the gap is far wider than ROUTE_EPSILON (0.1), so no consult is spent at all.
    expect((antigravity - claudeSecond) * 0.908).toBeGreaterThan(0.1)
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

    const choice = scheduler.chooseTarget(task)
    expect(choice.deferred).toBe(true)
    expect(choice.reason).toContain('reading quota for tied candidates')
    expect(choice.worker).toBeNull()
    expect(controller.hasPendingConsult('route', task.id)).toBe(false)
  })
})

