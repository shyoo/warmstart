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

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-clock-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  clock = await import('./cacheclock.js')
  settings = await import('./settings.js')
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
