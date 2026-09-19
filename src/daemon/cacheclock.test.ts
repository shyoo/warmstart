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
  process.env.WARMSTART_DATA_DIR = dir
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
    // ⚠️ Caught in the window this path is for: revived with 12m of its hour left, so the prefix is
    //    on its way out and the compaction still reads it at 0.1·C rather than rebuilding it.
    const plan = clock.compactOnResume(t92({ cacheExpiresAt: NOW + 12 * 60 * 1000 }), settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(true)
    expect(plan.estimatedCost).toBeGreaterThan(0)
    expect(plan.reason).toContain('84254')
  })

  it('⭐ leaves a warm continuation alone: the prompt refreshes the TTL for free', () => {
    // 28 minutes of TTL left on a 1-hour cache (the t130 case): comfortably warm (> 15m).
    // Compacting would discard a warm prefix readable at 0.1·C, pay ~2.0·C to write a summary,
    // and stall the run for ~2 min. The incoming prompt reads the cache and refreshes it for free.
    const warm = t92({ cacheExpiresAt: NOW + 28 * 60 * 1000 })
    const plan = clock.compactOnResume(warm, settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('prefix is still warm')
    expect(plan.reason).toContain('28m of TTL left')
    expect(plan.reason).toContain('the prompt will refresh it for free')
  })

  it('⭐ compacts when inside the last quarter of the TTL before the prefix lapses', () => {
    // 10 minutes of TTL left (<= 15m, decideBeforeExpiryMs for 1h TTL).
    // The prefix is about to lapse anyway, so compacting before starting is appropriate.
    const expiring = t92({ cacheExpiresAt: NOW + 10 * 60 * 1000 })
    const plan = clock.compactOnResume(expiring, settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(true)
    expect(plan.estimatedCost).toBeGreaterThan(0)
  })

  it('⭐ starts fresh once an oversized prefix has lapsed, rather than reopening it', () => {
    // ⛔ The correction of 2026-09-05, and the inversion of what this used to assert. t92 as it
    //    really stood at 23:40 — closed two hours, prefix gone for one — is **not** compacted here.
    //    Its cheap moment was ~22:20 and `decideRevive` owns it; buying a small context at a cold
    //    rebuild's price, two minutes before the operator's work may start, is not a second chance
    //    at that moment. It is the same purchase at ten times the price.
    const lapsed = t92({ cacheExpiresAt: NOW - 65 * 60 * 1000 })
    const plan = clock.compactOnResume(lapsed, settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('lapsed')
    expect(plan.estimatedCost).toBeNull()
    expect(clock.startFreshOnResume(lapsed, NOW)).toBe(true)
  })

  it('says how long ago the prefix went, because "lapsed" alone does not size the mistake', () => {
    const plan = clock.compactOnResume(t92({ cacheExpiresAt: NOW - 65 * 60 * 1000 }), settings.DEFAULT_SETTINGS, NOW)
    expect(plan.reason).toContain('65m ago')
  })

  it('⛔ an unknown expiry is not a lapse: unknown is a verdict, and it is not this one', () => {
    // A `null` reading means no adapter ever reported a prefix for this session — not that one
    // expired. Reading it as expired would switch this path off for a whole provider silently.
    const unknownExpiry = t92({ cacheExpiresAt: null })
    const plan = clock.compactOnResume(unknownExpiry, settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(true)
    expect(clock.startFreshOnResume(unknownExpiry, NOW)).toBe(false)
  })

  it('leaves a small carried-over context alone: the same two-part test the clock uses', () => {
    // ⚠️ Both halves, exactly as `worthCompactingNow` applies them mid-flight. A resume is a new
    // moment for the policy, never a second policy.
    expect(clock.compactOnResume(t92({ contextTokens: 4_000 }), settings.DEFAULT_SETTINGS).compact)
      .toBe(false)
    expect(clock.compactOnResume(t92({ tokensSinceCompact: 1_000 }), settings.DEFAULT_SETTINGS).compact)
      .toBe(false)
    expect(clock.startFreshOnResume(t92({ contextTokens: 4_000, cacheExpiresAt: NOW - 1 }), NOW)).toBe(false)
    expect(clock.startFreshOnResume(t92({ tokensSinceCompact: 1_000, cacheExpiresAt: NOW - 1 }), NOW)).toBe(false)
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

/**
 * ⛔ **t231: the 2m40s a resumed run spent buying a small context at the worst possible price.**
 *
 * Read out of this install's own database, 2026-09-05. Run 1 of t231 failed at 10:46:17 and its
 * process exited. The conversation then sat closed for **six hours** — its one-hour prefix lapsed
 * around 11:46, unattended, with not one `clock_events` row in the whole gap — and run 2 revived it
 * at 16:44:24. Two seconds later `compactOnResume` asked for a compaction of **306,801** tokens,
 * which landed at 16:47:06 and left **38,235** behind.
 *
 * ⚠️ Every part of that purchase was the expensive version of itself. The compaction had to read a
 * 306k prefix the vendor no longer held, so it paid a full cold rebuild (~1.25·C) — *in order to
 * throw the rebuilt context away*. It then spent 2m40s of the operator's wall clock before the run's
 * own prompt was allowed in. And the agent it handed control back to had no context left, so it
 * re-read the files it had been holding minutes earlier. Declining costs the fleet the same cold
 * rebuild exactly once, on the run's first prompt, and reads it warm for every turn after.
 *
 * ⛔ **This is a policy hole, not a broken condition.** Nothing miscomputed. The warmth gate had two
 * regions where the economics have three, and folded *the cheapest moment a compaction ever has*
 * together with *the dearest* into one branch called "not warm".
 */
describe('t231: a prefix that lapsed hours ago is not a reason to compact', () => {
  /** Session 3984f7e5 as it stood at 16:44:24, the moment run 2 revived it. */
  const t231 = (patch: Partial<Session> = {}): Session =>
    session({
      contextTokens: 306_801,
      tokensSinceCompact: 407_612,
      state: 'closed',
      // Last turn of run 1 was 10:46; a one-hour prefix, five hours gone by 16:44.
      cacheExpiresAt: NOW - 5 * 60 * 60 * 1000,
      ...patch
    })

  it('⭐ declines the compaction that actually ran, which is the whole of the bug', () => {
    const plan = clock.compactOnResume(t231(), settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(false)
  })

  it('⛔ a lapsed large context is not compacted, but it does start the next run fresh', () => {
    // The cold rebuild is still too expensive to spend on a compaction. It is also no longer a
    // saving to attach that large, lapsed history to the next run, so the scheduler starts cold.
    for (const tokens of [306_801, 500_000, 1_000_000]) {
      expect(clock.compactOnResume(t231({ contextTokens: tokens }), settings.DEFAULT_SETTINGS, NOW).compact)
        .toBe(false)
      expect(clock.startFreshOnResume(t231({ contextTokens: tokens }), NOW)).toBe(true)
    }
  })

  it('prices nothing, because a refused purchase has no estimate', () => {
    // ⚠️ `costOfCompact` prices a compaction as a **warm** read (`read_multiplier · contextTokens`)
    //    and has no term for rebuilding a lapsed prefix. On this path it was therefore understating
    //    the true cost by roughly an order of magnitude. Now that a lapsed prefix is never compacted
    //    here, every estimate this function returns is one the warm price is correct for.
    expect(clock.compactOnResume(t231(), settings.DEFAULT_SETTINGS, NOW).estimatedCost).toBeNull()
  })

  it('the refusal names the lapse, so the ledger says which gate said no', () => {
    const plan = clock.compactOnResume(t231(), settings.DEFAULT_SETTINGS, NOW)
    expect(plan.reason).toMatch(/lapsed/)
    expect(plan.reason).toMatch(/300m ago/)
  })

  it('⛔ the boundary is the lapse itself, not a grace period after it', () => {
    // One second past expiry is past expiry. A tolerance here would be a second, softer policy
    // nobody could find, and the cheap window already has its own name: decideBeforeExpiryMs.
    expect(clock.compactOnResume(t231({ cacheExpiresAt: NOW + 1_000 }), settings.DEFAULT_SETTINGS, NOW).compact)
      .toBe(true)
    expect(clock.compactOnResume(t231({ cacheExpiresAt: NOW - 1_000 }), settings.DEFAULT_SETTINGS, NOW).compact)
      .toBe(false)
    // ⚠️ Exactly at expiry there is nothing left to read, so it is a lapse.
    expect(clock.compactOnResume(t231({ cacheExpiresAt: NOW }), settings.DEFAULT_SETTINGS, NOW).compact)
      .toBe(false)
    expect(clock.startFreshOnResume(t231({ cacheExpiresAt: NOW - 1_000 }), NOW)).toBe(true)
    expect(clock.startFreshOnResume(t231({ cacheExpiresAt: NOW }), NOW)).toBe(true)
  })

  it('⭐ leaves the cheap window untouched, which is what this path still exists for', () => {
    // The gate must not have swallowed the middle region on its way to closing the far one.
    for (const minutes of [1, 5, 10, 14]) {
      const plan = clock.compactOnResume(
        t231({ cacheExpiresAt: NOW + minutes * 60 * 1000 }),
        settings.DEFAULT_SETTINGS,
        NOW
      )
      expect(plan.compact, `${minutes}m of TTL left`).toBe(true)
      expect(plan.estimatedCost).toBeGreaterThan(0)
    }
  })

  it('and still declines a comfortably warm one, which is the near end of the same gate', () => {
    const plan = clock.compactOnResume(t231({ cacheExpiresAt: NOW + 40 * 60 * 1000 }), settings.DEFAULT_SETTINGS, NOW)
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('still warm')
  })

  it('⚠️ the three regions are exhaustive: every prefix age gets exactly one verdict', () => {
    // ⛔ The property the bug violated. Sweeping the whole life of a prefix, from an hour of TTL
    //    left to six hours gone, the answer must be compact exactly once — in the last quarter — and
    //    refuse on both sides of it, with no gap and no second window.
    const verdicts: boolean[] = []
    for (let m = 60; m >= -360; m -= 1) {
      verdicts.push(
        clock.compactOnResume(t231({ cacheExpiresAt: NOW + m * 60 * 1000 }), settings.DEFAULT_SETTINGS, NOW).compact
      )
    }
    const first = verdicts.indexOf(true)
    const last = verdicts.lastIndexOf(true)
    expect(first).toBeGreaterThan(0)
    // One contiguous run of `true`, and nothing after it.
    expect(verdicts.slice(first, last + 1).every(Boolean)).toBe(true)
    expect(verdicts.slice(last + 1).some(Boolean)).toBe(false)
    // ⭐ And it really does close: the tail of the sweep — the t231 case — is all refusals.
    expect(verdicts.at(-1)).toBe(false)
  })

  it('does not reach for the switch: this is the economics gate, not the permission gate', () => {
    // ⚠️ A lapsed prefix is refused on its own terms. If the refusal only happened to hold because
    //    compaction was off, the test above would pass for the wrong reason forever.
    expect(settings.DEFAULT_SETTINGS.autoCompact).toBe(true)
  })
})

/**
 * Every window this clock reasons in was written when there was one provider, and one TTL of one
 * hour. OpenAI's is thirty minutes, so each of these numbers had to become a fraction of something
 * rather than a constant.
 *
 * ⛔ The ratios are anchored so that an hour reproduces the old constants **exactly**. That is the
 * property under test: Anthropic must not move by a millisecond, or this is a rewrite of the cost
 * model wearing a bug fix's clothes.
 */
describe('the clock windows scale with the TTL the provider actually grants', () => {
  const HOUR = 60 * 60 * 1000
  const HALF = 30 * 60 * 1000

  it('an hour reproduces the constants this clock was written with', () => {
    expect(clock.decideBeforeExpiryMs(HOUR)).toBe(clock.DECIDE_BEFORE_EXPIRY_MS)
    expect(clock.lastChanceMs(HOUR)).toBe(clock.LAST_CHANCE_MS)
  })

  it('half an hour gets half the windows, not the same ones', () => {
    // ⛔ The failure this prevents: a flat 15-minute decision window against a 30-minute prefix
    // spends *half* the conversation's life in the decision phase, and a flat 7-minute last-chance
    // window then sits about thirty seconds behind it — two windows that were fifteen minutes apart
    // on Anthropic, collapsed onto each other.
    expect(clock.decideBeforeExpiryMs(HALF)).toBe(7.5 * 60 * 1000)
    expect(clock.lastChanceMs(HALF)).toBe(3.5 * 60 * 1000)
    expect(clock.decideBeforeExpiryMs(HALF) - clock.lastChanceMs(HALF)).toBeGreaterThan(3 * 60 * 1000)
  })

  it('a provider that declares no TTL falls back to the constants rather than to zero', () => {
    // ⚠️ Zero would read as "the window has already closed" and silence the clock, which is a
    // different answer from "this provider publishes no TTL".
    expect(clock.decideBeforeExpiryMs(null)).toBe(clock.DECIDE_BEFORE_EXPIRY_MS)
    expect(clock.lastChanceMs(null)).toBe(clock.LAST_CHANCE_MS)
  })

  const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }

  it('the keepalive floor means "the TTL covers it" on every provider, not only on the hour one', async () => {
    const { policy } = await import('./objective.js')
    // ⛔ Hardcoded at 55m, this told a 30-minute provider to do nothing below 55 minutes of expected
    // idleness — a floor *above its entire window*, so no codex session could ever reach the
    // keepalive branch. It would fall through to a compaction its adapter cannot perform.
    expect(policy(OBJECTIVE).keepaliveFloorMs).toBe(55 * 60 * 1000)
    expect(policy(OBJECTIVE, HOUR).keepaliveFloorMs).toBe(55 * 60 * 1000)
    expect(policy(OBJECTIVE, HALF).keepaliveFloorMs).toBe(25 * 60 * 1000)
    expect(policy(OBJECTIVE, HALF).keepaliveFloorMs).toBeLessThan(HALF)
  })
})

/**
 * A session that reads one prompt and exits.
 *
 * ⛔ Every fallback in `decide()` that is not a compaction is `handoff_close`, and `handoff_close` is
 * a prompt. `codex exec` reads stdin to EOF and runs one turn, so `sendPrompt` throws for it by
 * design - the clock would catch that, warn, and try again on the very next tick, forever, and no
 * handoff would ever be written.
 *
 * ⚠️ Unreachable until codex was given a cache clock: with `cache_expires_at` null, `decide()`
 * returned at its first line and no branch below had ever been handed such a session.
 */
describe('a conversation with no channel to speak into', () => {
  const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }

  const oneShot = (patch: Partial<Session> = {}): Session =>
    session({
      adapterId: 'openai-compatible',
      workerId: 'w-oneshot',
      contextTokens: 41_000,
      tokensSinceCompact: 41_000,
      ...patch
    })

  it('declines a handoff it has no way to ask for, rather than throwing every tick', () => {
    const decision = clock.decide(
      oneShot({
        // Past the last-chance window, which is where move 6 reaches for a handoff.
        cacheExpiresAt: NOW + 60_000,
        // ⚠️ Asked for twice and never landed: `tokensSinceCompact` has not fallen below what it
        // was when the clock asked, and the settle window is long past. That is `ignored`.
        clockMove: 'compact',
        clockMoveAt: NOW - 10 * 60 * 1000,
        clockMoveContext: 41_000,
        clockMoveAttempts: 2
      }),
      { objective: OBJECTIVE, now: NOW }
    )
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('one prompt and exits')
  })

  it('still gives a session that can be spoken to the handoff, so the guard is not a blanket', () => {
    const decision = clock.decide(
      session({
        contextTokens: 41_000,
        tokensSinceCompact: 41_000,
        cacheExpiresAt: NOW + 60_000,
        // ⚠️ Asked for twice and never landed: `tokensSinceCompact` has not fallen below what it
        // was when the clock asked, and the settle window is long past. That is `ignored`.
        clockMove: 'compact',
        clockMoveAt: NOW - 10 * 60 * 1000,
        clockMoveContext: 41_000,
        clockMoveAttempts: 2
      }),
      { objective: OBJECTIVE, now: NOW }
    )
    expect(decision.move).toBe('handoff_close')
  })
})

describe('reserve pressure on weekly 7-day windows', () => {
  it('does not mark reserve at risk at 93% on a 7d window, but does at 97%', () => {
    const worker = workers.createWorker({ adapterId: 'claude-code', label: 'Claude7dWorker', enabled: true })
    const workerId = worker.id

    // Create a live session for this worker so poolOf(session) finds the pool
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose,
                               context_tokens, tokens_since_compact, cache_expires_at, started_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('s-7d-test', workerId, 'claude-code', 'stream', null, '/tmp', 'live', 'work', 50000, 50000, NOW + 100000, NOW)

    // Seed 7d quota at 93%
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(workerId, 'weekly', 'Claude 7d', 93, Date.now() + 7 * 86400000, 'probe', Date.now())

    const state93 = reserve.reserveState(workerId)
    expect(state93.verdict).not.toBe('at_risk')

    // Update 7d quota to 97%
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(workerId, 'weekly', 'Claude 7d', 97, Date.now() + 7 * 86400000, 'probe', Date.now() + 1000)

    const state97 = reserve.reserveState(workerId)
    expect(state97.verdict).toBe('at_risk')
    expect(state97.reason).toContain('at or past the 97% mark')
  })
})
