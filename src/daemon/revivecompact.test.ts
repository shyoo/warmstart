import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * Compacting a conversation **before** its prompt cache lapses.
 *
 * ⛔ The correction these are written against, measured on t92 (2026-09-01). Run 2 was preempted at
 * 21:35 on a quota warning; the process exited and the task was parked `paused_quota` with
 * `not_before` two hours out. The vendor held the prefix until ~22:35. Nothing looked at the
 * conversation in between — `runCacheClock` iterates live and idle sessions, because every move it
 * owns is a prompt and a prompt needs a process — and run 3 revived it at 23:40 into 84,254 tokens of
 * context that had never been compacted.
 *
 * ⚠️ Compacting it *at* 23:40 is not the same purchase as compacting it at 22:20, and that is the
 * whole point of this file. A compaction reads the entire conversation: while the prefix is warm that
 * read is a cache read (0.1·C); once it has lapsed the same compaction pays to rebuild the prefix
 * first (~1.25·C). The window to buy the cheap one closes an hour after the last turn, and a task
 * parked on a five-hour window does not come back inside it.
 */

let dir: string
let clock: typeof import('./cacheclock.js')
let db: typeof import('./db.js')
let settings: typeof import('./settings.js')
let tasks: typeof import('./tasks.js')
let workers: typeof import('./workers.js')
let sessions: typeof import('./sessions.js')

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-revive-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  clock = await import('./cacheclock.js')
  settings = await import('./settings.js')
  tasks = await import('./tasks.js')
  workers = await import('./workers.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'revive.db'))
  workerId = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeThird' }).id
  otherWorkerId = workers.createWorker({
    adapterId: 'claude-code',
    label: 'ClaudeFourth',
    enabled: false
  }).id
})

afterAll(() => {
  db.closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const SESSION_ID = '59eda2c6-0000-4000-8000-000000000001'

let workerId: string
let otherWorkerId: string

/**
 * Session 59eda2c6 as it stood at 22:20 — closed for 45 minutes, prefix lapsing in 15, holding the
 * context run 3 would go on to resume into.
 */
function session(patch: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    workerId,
    adapterId: 'claude-code',
    transport: 'stream',
    projectId: null,
    cwd: dir,
    model: 'claude-opus-5',
    effort: null,
    state: 'closed',
    pid: null,
    purpose: 'work',
    transcriptPath: null,
    vendorSessionId: null,
    currentBranch: null,
    contextTokens: 84_254,
    contextWindow: null,
    lastRequestStartedAt: NOW - 45 * 60 * 1000,
    cacheExpiresAt: NOW + 15 * 60 * 1000,
    tokensSinceCompact: 345_708,
    clockMove: null,
    clockMoveAt: null,
    clockMoveAttempts: 0,
    clockMoveContext: null,
    startedAt: NOW - 3 * HOUR,
    closedAt: NOW - 45 * 60 * 1000,
    ...patch
  }
}

/** The task that owns the conversation: preempted, parked on the window, back in two hours. */
function parkTask(
  opts: { status?: string; notBefore?: number | null; open?: boolean; sessionId?: string } = {}
): void {
  const task = tasks.createTask({
    title: 'the task that was preempted',
    createdBy: { kind: 'human' },
    ...(opts.notBefore === undefined ? { notBefore: NOW + 2 * HOUR } : { notBefore: opts.notBefore })
  })
  const run = tasks.startRun({
    taskId: task.id,
    workerId,
    sessionId: opts.sessionId ?? SESSION_ID,
    projectId: null,
    quotaUnverified: false,
    costModelId: 'anthropic.subscription.2026-08'
  })
  // ⚠️ Ended, because that is the state the whole move is about: a conversation between two runs.
  if (!opts.open) tasks.finishRun(run.id, 'preempted', 'the window closed under it')
  tasks.setStatus(task.id, (opts.status ?? 'paused_quota') as never)
}

const ctx = (over: Partial<Parameters<typeof clock.decideRevive>[1]> = {}) => ({
  objective: { cost: 0.34, velocity: 0.33, quality: 0.33 },
  now: NOW,
  settings: settings.DEFAULT_SETTINGS,
  ...over
})

beforeEach(() => {
  db.db().prepare('delete from runs').run()
  db.db().prepare('delete from tasks').run()
  db.db().prepare('delete from sessions').run()
})

describe('⭐ the two hours t92 spent with nobody allowed to look at it', () => {
  it('wakes the conversation up and compacts it while the prefix is still warm', () => {
    parkTask()
    const decision = clock.decideRevive(session(), ctx())

    expect(decision.move).toBe('revive_compact')
    expect(decision.estimatedCost).toBeGreaterThan(0)
    // The reason has to carry the arithmetic a person would check it against.
    expect(decision.reason).toContain('84254')
    expect(decision.reason).toContain('still warm')
  })

  it('prices it with the cost model, not with a guess', async () => {
    // ⚠️ The same `costOfCompact` every other compaction in this file is priced with. A second
    // pricing living here would be a second answer waiting to disagree with the first.
    const { costModel } = await import('./costmodel.js')
    parkTask()
    const decision = clock.decideRevive(session(), ctx())
    expect(decision.estimatedCost).toBe(
      Math.round(costModel('anthropic.subscription.2026-08').costOfCompact(session()) ?? -1)
    )
  })

  it('says how long the task has been away and how long the prefix has left', () => {
    parkTask()
    expect(clock.decideRevive(session(), ctx()).reason).toMatch(/comes back in 120m/)
    expect(clock.decideRevive(session(), ctx()).reason).toMatch(/lapses in 15m/)
  })
})

describe('the window it will act in', () => {
  beforeEach(() => parkTask())

  it('does nothing an hour out - there is no decision to take yet', () => {
    const decision = clock.decideRevive(session({ cacheExpiresAt: NOW + 45 * 60 * 1000 }), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('nothing to decide yet')
  })

  it('acts at the top of the 15-minute window, which is T+45m of a one-hour TTL', () => {
    expect(clock.REVIVE_COMPACT_BEFORE_MS).toBe(15 * 60 * 1000)
    const decision = clock.decideRevive(
      session({ cacheExpiresAt: NOW + clock.REVIVE_COMPACT_BEFORE_MS }),
      ctx()
    )
    expect(decision.move).toBe('revive_compact')
  })

  it('⛔ stops with 3 minutes left: a spawn plus a compaction does not fit', () => {
    // ⚠️ Measured compactions: 110s · 115s · 139s · 161s, and a process start in front of them. A
    // compaction that lands after the prefix has lapsed bought nothing at all.
    const decision = clock.decideRevive(session({ cacheExpiresAt: NOW + 3 * 60 * 1000 }), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('left for the resume to compact')
  })

  it('and once the prefix has lapsed it is the resume path’s problem, not this one’s', () => {
    const decision = clock.decideRevive(session({ cacheExpiresAt: NOW - 60_000 }), ctx())
    expect(decision.move).toBe('none')
  })

  it('the floor leaves room for the slowest compaction measured, plus the spawn', () => {
    expect(clock.REVIVE_COMPACT_FLOOR_MS).toBeGreaterThan(161_000 + 30_000)
  })
})

describe('who it is worth waking a process for', () => {
  it('⛔ a task parked on a clock, which is the only proof the conversation has a future', () => {
    parkTask({ status: 'paused_quota' })
    expect(clock.decideRevive(session(), ctx()).move).toBe('revive_compact')
  })

  it('a scheduled task counts too - it is the same wait with a different name', () => {
    parkTask({ status: 'scheduled' })
    expect(clock.decideRevive(session(), ctx()).move).toBe('revive_compact')
  })

  it('⛔ but never a ready task: the scheduler may dispatch it on the next tick', () => {
    // ⚠️ And the dispatch path compacts what it revives, so racing it with a process of our own could
    // put the task's own prompt into a conversation mid-compaction.
    parkTask({ status: 'ready' })
    const decision = clock.decideRevive(session(), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('not parked on a clock')
  })

  it('nor a task that has finished with it', () => {
    parkTask({ status: 'completed' })
    expect(clock.decideRevive(session(), ctx()).move).toBe('none')
  })

  it('nor one that is coming back inside the compaction window', () => {
    // ⛔ Two minutes is not enough room. `admit()` would make it dispatchable while the /compact is
    // still in flight, which is the collision this whole gate exists to prevent.
    parkTask({ notBefore: NOW + 2 * 60 * 1000 })
    const decision = clock.decideRevive(session(), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('too soon')
  })

  it('nor a conversation no task ever ran in', () => {
    const decision = clock.decideRevive(session(), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('no task is waiting')
  })

  it('⛔ nor one a run is still open against, whatever the row says about the process', () => {
    parkTask({ open: true })
    const decision = clock.decideRevive(session(), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('a run is still open')
  })
})

describe('what makes a compaction worth a process at all', () => {
  beforeEach(() => parkTask())

  it('leaves a small context alone', () => {
    expect(clock.decideRevive(session({ contextTokens: 4_000 }), ctx()).move).toBe('none')
  })

  it('leaves a context that has not grown since its last compaction alone', () => {
    // ⚠️ Both halves of `worthCompactingNow`, exactly as the live move applies them. A conversation
    // compacted an hour ago is large *and* already summarised.
    expect(clock.decideRevive(session({ tokensSinceCompact: 1_000 }), ctx()).move).toBe('none')
  })

  it('⛔ off means off here too, and says so', () => {
    const decision = clock.decideRevive(
      session(),
      ctx({ settings: { ...settings.DEFAULT_SETTINGS, autoCompact: false } })
    )
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('switched off')
  })

  it('does not ask a provider that cannot compact', () => {
    const decision = clock.decideRevive(session({ adapterId: 'antigravity-cli' }), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('compact')
  })

  it('does not ask an account that may not open a session', () => {
    db.db().prepare('delete from runs').run()
    db.db().prepare('delete from tasks').run()
    parkTask()
    const decision = clock.decideRevive(session({ workerId: otherWorkerId }), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('disabled')
  })
})

describe('it asks once, not once every ten seconds', () => {
  beforeEach(() => parkTask())

  it('⛔ waits for a revive it has already started', () => {
    // The 2026-08-26 repeat, with a process attached to it: twenty-four spawns in four minutes.
    const decision = clock.decideRevive(
      session({
        clockMove: 'revive_compact',
        clockMoveAt: NOW - 30_000,
        clockMoveContext: 345_708
      }),
      ctx()
    )
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('has not landed yet')
  })

  it('gives up after two attempts rather than insisting', () => {
    const decision = clock.decideRevive(
      session({
        clockMove: 'revive_compact',
        clockMoveAt: NOW - 10 * 60 * 1000,
        clockMoveAttempts: clock.MAX_MOVE_ATTEMPTS,
        clockMoveContext: 345_708
      }),
      ctx()
    )
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('never landed')
  })

  it('and asks again once the conversation has grown enough to be worth asking about', () => {
    // ⛔ `moveOutcome` reads a revive the way it reads a compaction: landed when `tokensSinceCompact`
    // has fallen below what it was when we asked. A turn happening is not evidence — a revived
    // session produces one just by opening.
    const landed = session({
      clockMove: 'revive_compact',
      clockMoveAt: NOW - 30_000,
      clockMoveContext: 345_708,
      tokensSinceCompact: 0
    })
    expect(clock.moveOutcome(landed, NOW)).toBe('landed')

    const still = session({
      clockMove: 'revive_compact',
      clockMoveAt: NOW - 30_000,
      clockMoveContext: 345_708
    })
    expect(clock.moveOutcome(still, NOW)).toBe('in_flight')
    // ⚠️ The compaction settle window, not the keepalive one: this move takes minutes, not seconds.
    expect(clock.moveOutcome(still, NOW + clock.COMPACT_SETTLE_MS + 1)).toBe('ignored')
  })
})

/**
 * The set the clock could not see.
 *
 * ⛔ `listSessions()` returns live and idle rows only, which is correct for every move that is a
 * prompt — and is exactly why a conversation between two runs was never considered. This is the
 * second pass, and what it may and may not pick up.
 */
describe('finding the conversations with no process and a prefix still to lose', () => {
  const insert = (id: string, patch: Record<string, unknown> = {}): void => {
    const row = {
      state: 'closed',
      purpose: 'work',
      context_tokens: 84_254,
      cache_expires_at: NOW + 15 * 60 * 1000,
      ...patch
    }
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               context_tokens, tokens_since_compact, cache_expires_at, started_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        workerId,
        'claude-code',
        'stream',
        dir,
        row.state,
        row.purpose,
        row.context_tokens,
        345_708,
        row.cache_expires_at,
        NOW - 3 * HOUR
      )
  }
  const found = (): string[] =>
    sessions.warmClosedConversations(NOW).map((s) => s.id.slice(0, 8))

  it('finds a closed conversation whose prefix has not lapsed', () => {
    insert('aaaaaaaa-0000-4000-8000-000000000001')
    expect(found()).toEqual(['aaaaaaaa'])
  })

  it('and a failed one, which is a conversation that ended badly, not one that ended empty', () => {
    insert('bbbbbbbb-0000-4000-8000-000000000001', { state: 'failed' })
    expect(found()).toEqual(['bbbbbbbb'])
  })

  it('⛔ never a live one: that is the first pass’s business, and two processes is the bug', () => {
    insert('cccccccc-0000-4000-8000-000000000001', { state: 'live' })
    expect(found()).toEqual([])
  })

  it('⛔ never one whose prefix has already lapsed - there is nothing left to save', () => {
    insert('dddddddd-0000-4000-8000-000000000001', { cache_expires_at: NOW - 1 })
    expect(found()).toEqual([])
  })

  it('never one that never had a prefix', () => {
    insert('eeeeeeee-0000-4000-8000-000000000001', { cache_expires_at: null })
    insert('ffffffff-0000-4000-8000-000000000001', { context_tokens: 0 })
    expect(found()).toEqual([])
  })

  it('never a consult or a probe: they hold nothing worth a process', () => {
    insert('a1a1a1a1-0000-4000-8000-000000000001', { purpose: 'consult' })
    insert('a2a2a2a2-0000-4000-8000-000000000001', { purpose: 'probe' })
    expect(found()).toEqual([])
  })

  it('returns them in the order they are about to lapse', () => {
    insert('b1b1b1b1-0000-4000-8000-000000000001', { cache_expires_at: NOW + 14 * 60 * 1000 })
    insert('b2b2b2b2-0000-4000-8000-000000000001', { cache_expires_at: NOW + 2 * 60 * 1000 })
    expect(found()).toEqual(['b2b2b2b2', 'b1b1b1b1'])
  })
})

/**
 * ⚠️ The two compactions are one policy at two moments, and only one of them can fire.
 *
 * A landed compaction zeroes `tokensSinceCompact`, which is the growth half of `worthCompactingNow` —
 * so a conversation this move has already shrunk is not compacted again when the task returns, and one
 * it never reached still is.
 */
describe('and the resume path, which is what is left when this cannot act', () => {
  beforeEach(() => parkTask())

  it('⛔ does not compact again at resume what was compacted before the prefix lapsed', () => {
    const compacted = session({ tokensSinceCompact: 0, contextTokens: 12_243 })
    expect(clock.compactOnResume(compacted, settings.DEFAULT_SETTINGS).compact).toBe(false)
  })

  it('⭐ still compacts at resume what nothing reached in time', () => {
    // The t92 case as it actually happened: nobody looked at it, the prefix lapsed, and the run
    // resumed into the whole thing. Late is more expensive than early. It is not more expensive than
    // reading 84k on every turn of a twenty-minute run.
    expect(clock.compactOnResume(session(), settings.DEFAULT_SETTINGS).compact).toBe(true)
  })
})
