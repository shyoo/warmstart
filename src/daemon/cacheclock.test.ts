import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * The compact loop, and the switch that turns compaction off.
 *
 * ⛔ The bug these are written against, measured on this machine 2026-08-26: session c17ce7 sat at
 * 68001 context tokens and was sent `/compact` on **every 10s tick** - thirteen identical rows in
 * two minutes, same session, same reason, same 35k estimate. Nothing was wrong with the decision.
 * What was missing was any memory that it had already been made: `decide()` is a pure function of
 * the session row, compaction takes ~2 minutes, and nothing in the row moves in between.
 *
 * ⚠️ Each repeat was a real user message pushed into a live session, so a *free* decision loop was
 * writing a **billable** turn every ten seconds - the "a loop running every 10 seconds for weeks
 * must not bill anything" invariant broken by the one component that exists to save tokens. That is
 * why these are unit tests over `moveOutcome()` rather than an integration check: the property has
 * to hold on every tick, not on average.
 */

let dir: string
let clock: typeof import('./cacheclock.js')
let db: typeof import('./db.js')
let settings: typeof import('./settings.js')
let reserve: typeof import('./reserve.js')
let workers: typeof import('./workers.js')

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-clock-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  clock = await import('./cacheclock.js')
  settings = await import('./settings.js')
  reserve = await import('./reserve.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'clock.db'))
})

afterAll(() => {
  db.closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const NOW = 1_700_000_000_000

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'c17ce700-0000-0000-0000-000000000000',
    workerId: 'w1',
    adapterId: 'claude-code',
    transport: 'stream',
    projectId: null,
    cwd: '/tmp',
    model: null,
    effort: null,
    state: 'live',
    pid: null,
    purpose: 'work',
    transcriptPath: null,
    vendorSessionId: null,
    currentBranch: null,
    contextTokens: 68001,
    contextWindow: null,
    lastRequestStartedAt: null,
    cacheExpiresAt: NOW + 10 * 60 * 1000,
    tokensSinceCompact: 35_000,
    clockMove: null,
    clockMoveAt: null,
    clockMoveAttempts: 0,
    clockMoveContext: null,
    startedAt: NOW - 60 * 60 * 1000,
    closedAt: null,
    ...patch
  }
}

describe('a move is a request, not an outcome', () => {
  it('a session nobody has asked anything of has no outstanding move', () => {
    expect(clock.moveOutcome(session(), NOW)).toBe('none')
  })

  it('a compact asked for seconds ago is in flight, not repeatable', () => {
    // The exact shape of the loop: one tick later, nothing has changed yet.
    const s = session({ clockMove: 'compact', clockMoveAt: NOW - 10_000, clockMoveContext: 35_000 })
    expect(clock.moveOutcome(s, NOW)).toBe('in_flight')
  })

  it('it is still in flight at the slowest compaction ever measured', () => {
    // 161s is the slowest of three samples (139k · 116k · 161k ms). A settle window that expired
    // before that would re-issue a compaction that was about to succeed.
    const s = session({ clockMove: 'compact', clockMoveAt: NOW - 161_000, clockMoveContext: 35_000 })
    expect(clock.moveOutcome(s, NOW)).toBe('in_flight')
  })

  it('a compact that reset tokens_since_compact landed', () => {
    // ⛔ The evidence is the reset, not a turn. recordCompaction() zeroes it on a real
    // compact_boundary record and nothing else does.
    const s = session({
      clockMove: 'compact',
      clockMoveAt: NOW - 120_000,
      clockMoveContext: 35_000,
      tokensSinceCompact: 0
    })
    expect(clock.moveOutcome(s, NOW)).toBe('landed')
  })

  it('a compact that only produced a reply did NOT land', () => {
    // An agent answering "I don't understand /compact" is a perfectly good turn that compacted
    // nothing. Counting a turn as proof is the mistake that would keep the loop alive.
    const s = session({
      clockMove: 'compact',
      clockMoveAt: NOW - 300_000,
      clockMoveContext: 35_000,
      tokensSinceCompact: 41_000,
      lastRequestStartedAt: NOW - 200_000
    })
    expect(clock.moveOutcome(s, NOW)).toBe('ignored')
  })

  it('a keepalive landed when the TTL moved, which is the whole point of it', () => {
    const s = session({
      clockMove: 'keepalive',
      clockMoveAt: NOW - 60_000,
      lastRequestStartedAt: NOW - 30_000
    })
    expect(clock.moveOutcome(s, NOW)).toBe('landed')
  })

  it('a keepalive that never produced a turn is ignored once its shorter window passes', () => {
    const s = session({ clockMove: 'keepalive', clockMoveAt: NOW - 120_000 })
    expect(clock.moveOutcome(s, NOW)).toBe('ignored')
  })

  it('the compact window is longer than the keepalive one', () => {
    // One is a two-minute operation, the other is a one-word turn. A single shared timeout would be
    // wrong for both.
    expect(clock.COMPACT_SETTLE_MS).toBeGreaterThan(clock.KEEPALIVE_SETTLE_MS)
    expect(clock.COMPACT_SETTLE_MS).toBeGreaterThan(161_000)
  })

  it('gives up after a bounded number of attempts rather than never', () => {
    // ⛔ Whether `/compact` is honoured on the stream transport is unverified (HANDOFF R6). If it is
    // not, this bound is the difference between two wasted turns and an unbounded spend.
    expect(clock.MAX_MOVE_ATTEMPTS).toBeGreaterThanOrEqual(1)
    expect(clock.MAX_MOVE_ATTEMPTS).toBeLessThanOrEqual(3)
  })
})

describe('the automatic-compaction switch', () => {
  it('is on unless somebody turned it off', () => {
    expect(settings.DEFAULT_SETTINGS.autoCompact).toBe(true)
    expect(settings.settings().autoCompact).toBe(true)
  })

  it('persists, and reads back as what was written', () => {
    expect(settings.setSetting('autoCompact', false).autoCompact).toBe(false)
    expect(settings.settings().autoCompact).toBe(false)
    expect(settings.setSetting('autoCompact', true).autoCompact).toBe(true)
  })

  it('an unwritten key still answers with its default', () => {
    db.db().prepare('delete from settings').run()
    expect(settings.settings().autoCompact).toBe(true)
  })

  it('a corrupt value falls back to the default rather than taking the fleet down', () => {
    // A switch written by something that is not this build must not be able to stop the daemon
    // starting. It is a preference, not a credential.
    db.db()
      .prepare('insert into settings (key, value, updated_at) values (?,?,?)')
      .run('autoCompact', 'not json', Date.now())
    expect(settings.settings().autoCompact).toBe(true)
    db.db().prepare('delete from settings').run()
  })
})

/**
 * ⛔ **The reason `autoCompact` did nothing for five days.** Switched on 2026-08-31 at 07:48Z; by
 * 23:30Z `clock_events` still held nothing newer than 2026-08-27, while a session sat at 278k
 * context tokens. The switch was fine and `decide()` was fine. The arithmetic underneath was not:
 * `expectedIdleMs` returns exactly **2h** whenever any task is in flight, and the balanced
 * objective computes a compaction threshold of **2.02h** - so the keepalive branch always matched
 * first and move 4 was unreachable on any fleet that was doing anything at all. The one day it did
 * compact was the day the fleet was completely idle and `idle.ms` was infinite.
 *
 * ⚠️ Driven through the real `expectedIdleMs` with a real task row rather than through an injected
 * number, because the bug was not in either constant. It was in the two of them meeting.
 */
describe('the threshold two constants landed exactly on', () => {
  const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }

  /** A session that wants to compact: deep in its last-chance window, big context, plenty since. */
  const ripe = (patch: Partial<Session> = {}): Session =>
    session({
      contextTokens: 278_275,
      tokensSinceCompact: 618_405,
      cacheExpiresAt: NOW + 8 * 60 * 1000,
      ...patch
    })

  beforeAll(async () => {
    const tasks = await import('./tasks.js')
    const t = tasks.createTask({ title: 'something in flight', createdBy: { kind: 'human' } })
    tasks.setStatus(t.id, 'running')
  })

  it('a fleet with one task in flight expects exactly two hours of idleness', () => {
    expect(clock.expectedIdleMs(ripe(), NOW).ms).toBe(2 * 60 * 60 * 1000)
  })

  it('and the balanced objective puts the break-even just past it', async () => {
    const { policy } = await import('./objective.js')
    expect(policy(OBJECTIVE).compactThresholdMs).toBeGreaterThan(2 * 60 * 60 * 1000)
    expect(policy(OBJECTIVE).compactThresholdMs).toBeLessThan(2.1 * 60 * 60 * 1000)
  })

  it('⭐ compacts a 278k context anyway, which is what it never did before', () => {
    const decision = clock.decide(ripe(), { objective: OBJECTIVE, now: NOW })
    expect(decision.move).toBe('compact')
  })

  it('says out loud that the switch is why, when the switch is why', () => {
    const decision = clock.decide(ripe(), {
      objective: OBJECTIVE,
      now: NOW,
      settings: { ...settings.DEFAULT_SETTINGS, autoCompact: false }
    })
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('switched off')
  })

  it('leaves a small context alone: the break-even is about size, not only about time', () => {
    const decision = clock.decide(
      ripe({ contextTokens: 4_000, tokensSinceCompact: 1_000 }),
      { objective: OBJECTIVE, now: NOW }
    )
    expect(decision.move).not.toBe('compact')
  })
})

/**
 * ⛔ **The reserve that had never once been at risk, on a fleet where the window was full.**
 *
 * Measured 2026-08-31 (t73) from this install's own database. At 17:31 a run was routed to
 * ClaudeThird and immediately held: its five-hour window read **92%**, which is the dispatch gate.
 * On that same account session `ef5e90dc` had been open since 10:38, holding **401,341** tokens of
 * context and **1,401,019** tokens since its last compaction - and no `/compact` was ever sent. The
 * `compactions` table was empty and `clock_events` had not gained a row since 2026-08-26.
 *
 * The reason is one join that never returns: `remainingTokens` needs a `tokens_per_percent`
 * calibration, the `calibration` table on this install has **zero rows**, so `reserveState` answered
 * `unknown` for every worker holding a session and move 5 - *the reserve is at risk, compact now
 * regardless* - was unreachable by construction. Move 4 could not cover for it either: it is gated
 * behind the TTL window, and this session's prefix had hours left.
 *
 * ⚠️ The percentage is not promoted to a token count anywhere. It answers a different question,
 * which is the only one it can answer: this account is at the mark where the fleet has *already
 * stopped giving it work*, so what it still holds should be saved while there is window left to pay
 * for saving it.
 */
describe('the compaction the full window never asked for', () => {
  const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }
  let workerId: string

  /** The real session, at the sizes it really held. */
  const stranded = (patch: Partial<Session> = {}): Session =>
    session({
      workerId,
      contextTokens: 401_341,
      tokensSinceCompact: 1_401_019,
      // ⚠️ Nowhere near expiry: this must fire on the reserve alone, never on the TTL clock.
      cacheExpiresAt: NOW + 55 * 60 * 1000,
      ...patch
    })

  function seedWindow(percent: number, opts: { resetsAt?: number; sampledAt?: number } = {}): void {
    db.db().prepare('delete from quota_samples where worker_id = ?').run(workerId)
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(
        workerId,
        '5h',
        '5h',
        percent,
        opts.resetsAt ?? Date.now() + 2 * 60 * 60 * 1000,
        'probe',
        opts.sampledAt ?? Date.now()
      )
  }

  beforeAll(() => {
    workerId = workers.createWorker({
      adapterId: 'claude-code',
      label: 'ClaudeThird',
      enabled: false
    }).id
    // The live row the reserve reads: nothing here spawns a CLI, and nothing needs to.
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               context_tokens, tokens_since_compact, started_at)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'ef5e90dc-0000-4000-8000-000000000001',
        workerId,
        'claude-code',
        'stream',
        dir,
        'live',
        'work',
        401_341,
        1_401_019,
        Date.now()
      )
  })

  it('has no calibration to answer with, which is what made this unreachable', () => {
    // ⛔ The precondition, asserted rather than assumed: if a conversion ever *is* learned this test
    // is measuring a different code path and should say so.
    expect(reserve.remainingTokens(workerId).tokens).toBeNull()
  })

  it('⭐ calls the reserve at risk at the same percentage that stops dispatch', () => {
    seedWindow(92)
    const state = reserve.reserveState(workerId)
    expect(state.verdict).toBe('at_risk')
    expect(state.reason).toContain('92%')
    // Still honest about the rung: no token count was invented to get here.
    expect(state.remainingTokens).toBeNull()
  })

  it('⭐ and sends /compact for a 401k context that nothing else would have touched', () => {
    seedWindow(92)
    const decision = clock.decide(stranded(), { objective: OBJECTIVE, now: NOW })
    expect(decision.move).toBe('compact')
    expect(decision.reason).toContain('reserve at risk')
  })

  it('does not ask twice for a session that has just been compacted', () => {
    // ⛔ The 2026-08-26 repeat with a new trigger. A full window stays full for hours, so a move-5
    // condition that ignored `tokensSinceCompact` would send `/compact` every four minutes until
    // the window reset. A landed compaction zeroes it, and this is what reads that.
    seedWindow(92)
    const decision = clock.decide(stranded({ tokensSinceCompact: 0 }), {
      objective: OBJECTIVE,
      now: NOW
    })
    expect(decision.move).not.toBe('compact')
  })

  it('leaves a comfortable window alone', () => {
    seedWindow(76)
    expect(reserve.reserveState(workerId).verdict).toBe('unknown')
    expect(clock.decide(stranded(), { objective: OBJECTIVE, now: NOW }).move).not.toBe('compact')
  })

  it('refuses a reading old enough that the gate would refuse it too', () => {
    seedWindow(92, { sampledAt: Date.now() - 20 * 60 * 1000 })
    expect(reserve.reserveState(workerId).verdict).toBe('unknown')
  })

  it('refuses a window whose reset has already passed - expired is unknown, never full', () => {
    // ⛔ The t60 mistake, which `stale` cannot catch: a reading taken two minutes before a reset is
    // as fresh as a reading gets and describes a window that no longer exists.
    seedWindow(92, { resetsAt: Date.now() - 60 * 1000 })
    expect(reserve.reserveState(workerId).verdict).toBe('unknown')
  })

  it('obeys the switch here as well: off means off, even at 92%', () => {
    seedWindow(92)
    const decision = clock.decide(stranded(), {
      objective: OBJECTIVE,
      now: NOW,
      settings: { ...settings.DEFAULT_SETTINGS, autoCompact: false }
    })
    expect(decision.move).not.toBe('compact')
  })
})

describe('the probe frequency setting', () => {
  it('defaults to 5 minutes', () => {
    expect(settings.DEFAULT_SETTINGS.probeIntervalMinutes).toBe(5)
    expect(settings.settings().probeIntervalMinutes).toBe(5)
  })

  it('persists changes and notifies listeners', () => {
    const notifications: Array<[string, unknown]> = []
    const unsubscribe = settings.onSettingChange((k, v) => notifications.push([k, v]))

    expect(settings.setSetting('probeIntervalMinutes', 15).probeIntervalMinutes).toBe(15)
    expect(settings.settings().probeIntervalMinutes).toBe(15)
    expect(notifications).toEqual([['probeIntervalMinutes', 15]])

    unsubscribe()
    expect(settings.setSetting('probeIntervalMinutes', 5).probeIntervalMinutes).toBe(5)
    expect(notifications.length).toBe(1)
  })
})

/**
 * ⭐ **Move 5b: a conversation somebody is queued behind.**
 *
 * ⛔ Written against the hole the queue could see and the clock could not. Every other compaction
 * this file tests is argued from `expectedIdleMs` — how long until this session is *likely* to be
 * wanted — and a conversation a ready task has already been refused is not idle in that sense at
 * all. It is wanted now, it is over the share ceiling, and until this move existed the only thing
 * that could clear it was an idle estimate that a busy fleet never produces. The task cold-starts
 * for ~41.5k instead, every time, forever.
 */
describe('a conversation the queue is waiting on', () => {
  const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }

  /** Big, grown a lot since its last compaction, and hours of TTL left. */
  const wanted = (patch: Partial<Session> = {}): Session =>
    session({
      contextTokens: 150_000,
      contextWindow: 200_000,
      tokensSinceCompact: 120_000,
      cacheExpiresAt: NOW + 50 * 60 * 1000,
      ...patch
    })

  it('is left alone when nobody is waiting for it', () => {
    // ⚠️ The control. 50 minutes of TTL is far outside the decision window, so without the queue's
    // pressure this session is not the clock's business at all.
    expect(clock.decide(wanted(), { objective: OBJECTIVE, now: NOW }).move).toBe('none')
  })

  it('⭐ compacts when a queued task would borrow it, TTL or no TTL', () => {
    const decision = clock.decide(wanted(), {
      objective: OBJECTIVE,
      now: NOW,
      borrowWanted: new Set([wanted().id])
    })
    expect(decision.move).toBe('compact')
    expect(decision.reason).toContain('too full to lend')
  })

  it('obeys the switch, like every other compaction', () => {
    const decision = clock.decide(wanted(), {
      objective: OBJECTIVE,
      now: NOW,
      borrowWanted: new Set([wanted().id]),
      settings: { ...settings.DEFAULT_SETTINGS, autoCompact: false }
    })
    expect(decision.move).not.toBe('compact')
  })

  it('does not ask twice while the first ask is still in flight', () => {
    // ⛔ The 2026-08-26 repeat, with a new trigger. A queue stays pressed for minutes and the clock
    // ticks every ten seconds; the outstanding-move check above every branch is what ends it.
    const decision = clock.decide(
      wanted({ clockMove: 'compact', clockMoveAt: NOW - 10_000, clockMoveContext: 120_000 }),
      { objective: OBJECTIVE, now: NOW, borrowWanted: new Set([wanted().id]) }
    )
    expect(decision.move).toBe('none')
  })

  it('stops asking once a compaction has landed and the context has not grown back', () => {
    // ⚠️ `worthCompactingNow` is the other half: a landed compaction zeroes tokensSinceCompact, so a
    // conversation that is still over the ceiling afterwards is asked once, not every four minutes.
    const decision = clock.decide(wanted({ tokensSinceCompact: 0 }), {
      objective: OBJECTIVE,
      now: NOW,
      borrowWanted: new Set([wanted().id])
    })
    expect(decision.move).not.toBe('compact')
  })
})

/**
 * ⛔ **The two hours t92 spent closed, holding a context nothing was allowed to look at.**
 *
 * Measured from this install's own database, 2026-09-01. Run 2 of t92 was preempted at 21:35 on a
 * vendor quota warning and its process exited; run 3 resumed the same conversation at 23:40. In
 * between: **not one `clock_events` row** for session 59eda2c6, and no compaction — because
 * `runCacheClock` iterates live and idle sessions and that one was `closed`. Every move the clock
 * has is a prompt, and a prompt needs a process, so a conversation between runs is not something it
 * can act on at all. Run 3 then resumed into an **84,254**-token context that had never been
 * compacted and read **15.7M** cache tokens over the next twenty minutes.
 *
 * ⚠️ These are that session's real numbers, against the real cost model, so the check is not that
 * some threshold works — it is that *this* conversation would have been compacted before *that* run.
 */
describe('a conversation carried across runs is compacted before the next one speaks', () => {
  /** Session 59eda2c6 as it stood at 23:40:47, the moment the scheduler revived it. */
  const t92 = (patch: Partial<Session> = {}): Session =>
    session({ contextTokens: 84_254, tokensSinceCompact: 345_708, state: 'closed', ...patch })

  it('⭐ compacts the conversation t92 resumed, which nothing did', () => {
    const plan = clock.compactOnResume(t92(), settings.DEFAULT_SETTINGS)
    expect(plan.compact).toBe(true)
    expect(plan.estimatedCost).toBeGreaterThan(0)
    expect(plan.reason).toContain('84254')
  })

  it('leaves a small carried-over context alone: the same two-part test the clock uses', () => {
    // ⚠️ Both halves, exactly as `worthCompactingNow` applies them mid-flight. A resume is a new
    // moment for the policy, never a second policy.
    expect(clock.compactOnResume(t92({ contextTokens: 4_000 }), settings.DEFAULT_SETTINGS).compact)
      .toBe(false)
    expect(clock.compactOnResume(t92({ tokensSinceCompact: 1_000 }), settings.DEFAULT_SETTINGS).compact)
      .toBe(false)
  })

  it('off means off here too, and says so', () => {
    const plan = clock.compactOnResume(t92(), { ...settings.DEFAULT_SETTINGS, autoCompact: false })
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('switched off')
  })

  it('does not ask a provider that cannot compact', () => {
    // ⛔ Antigravity declares `manualCompact: false`. Asking anyway would spend a prompt on a
    // conversation that cannot shrink and then wait four minutes for a boundary that never comes.
    const plan = clock.compactOnResume(t92({ adapterId: 'antigravity-cli' }), settings.DEFAULT_SETTINGS)
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('compact')
  })

  it('the wait for the boundary is bounded by the same window a clock compaction settles in', () => {
    // ⚠️ Whether `/compact` is honoured on the stream transport is still unmeasured (R6), so the
    // prompt must have a way out that does not depend on it arriving.
    expect(clock.RESUME_COMPACT_WAIT_MS).toBe(clock.COMPACT_SETTLE_MS)
  })
})
