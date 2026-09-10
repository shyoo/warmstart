import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * **One task's answer to "may this conversation be compacted?", and the fleet switch it overrides.**
 *
 * ⛔ The shape of the thing being tested, because it is the part that is easy to get wrong: this is a
 * **permission**, not a command. Switching a task on does not send `/compact` — it lets the cache
 * clock reach the four moves that can, and every gate downstream of the switch still has to agree
 * that this particular compaction buys something. A test suite that only checked "on ⇒ compacts"
 * would pass against an implementation that compacted a 4,000-token context, which is a strictly
 * worse tool than the one that existed before the setting.
 *
 * ⛔ And it is **not** a capability. `capabilities.manualCompact` is the adapter's declaration that
 * `/compact` exists at all — Codex takes one prompt per session and has none, Antigravity implements
 * none — and no operator setting can talk either of them into having one. The override answers the
 * second question only, and the two are tested apart here for exactly that reason.
 *
 * ⚠️ Five call sites read the switch (moves 4, 5, 5b, `decideRevive`, `compactOnResume`) and each one
 * gets its own check, because "off everywhere or it is a lie" (AGENTS.md) is a property of the set
 * rather than of any member of it. A switch honoured by four of five is the failure mode this file
 * exists to catch, and it is invisible from any single test.
 */

let dir: string
let clock: typeof import('./cacheclock.js')
let db: typeof import('./db.js')
let settings: typeof import('./settings.js')
let tasks: typeof import('./tasks.js')
let workers: typeof import('./workers.js')
let reserve: typeof import('./reserve.js')
let shared: typeof import('@shared/tasks.js')

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const OBJECTIVE = { cost: 0.34, velocity: 0.33, quality: 0.33 }
const SESSION_ID = 'ac000000-0000-4000-8000-000000000001'

let workerId: string
let reserveWorkerId: string

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskcompact-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  clock = await import('./cacheclock.js')
  settings = await import('./settings.js')
  tasks = await import('./tasks.js')
  workers = await import('./workers.js')
  reserve = await import('./reserve.js')
  shared = await import('@shared/tasks.js')
  db.openDb(join(dir, 'taskcompact.db'))
  workerId = workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeSecond' }).id
  reserveWorkerId = workers.createWorker({
    adapterId: 'claude-code',
    label: 'ClaudeThird',
    enabled: false
  }).id
})

afterAll(() => {
  db.closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * ⛔ Cleared between every test rather than accumulated. `expectedIdleMs` reads the **whole task
 * table** to work out when a session is next wanted, so a task left behind by an earlier test
 * silently changes which branch the next one takes — a `paused_quota` row with a `not_before` turns
 * the in-flight placeholder into a confident estimate, and move 4 stops being reachable at all.
 * That is a test that passes for the wrong reason today and fails for an unrelated reason later.
 */
beforeEach(() => {
  db.db().prepare('delete from runs').run()
  db.db().prepare('delete from tasks').run()
  db.db().prepare('delete from quota_samples').run()
  db.db().prepare('delete from sessions').run()
})

/** A session ripe for move 4: big, grown a lot, and deep inside the decision window. */
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
    state: 'live',
    pid: null,
    purpose: 'work',
    transcriptPath: null,
    vendorSessionId: null,
    currentBranch: null,
    contextTokens: 278_275,
    contextWindow: null,
    lastRequestStartedAt: null,
    cacheExpiresAt: NOW + 8 * 60 * 1000,
    tokensSinceCompact: 618_405,
    clockMove: null,
    clockMoveAt: null,
    clockMoveAttempts: 0,
    clockMoveContext: null,
    startedAt: NOW - HOUR,
    closedAt: null,
    ...patch
  }
}

/**
 * The task that owns a conversation, with the compaction choice under test.
 *
 * ⚠️ Left `running` with its run **ended**, which is deliberately the awkward combination: it keeps
 * `expectedIdleMs` on its in-flight placeholder (so move 4 is reachable) while leaving no open run
 * to make `decideRevive` refuse. Both halves matter and neither is incidental.
 */
function owner(
  autoCompact: 'inherit' | 'on' | 'off',
  opts: { sessionId?: string; status?: string; notBefore?: number | null; open?: boolean } = {}
): ReturnType<typeof tasks.createTask> {
  const task = tasks.createTask({
    title: 'a long conversation somebody has an opinion about',
    createdBy: { kind: 'human' },
    autoCompact,
    ...(opts.notBefore === undefined ? {} : { notBefore: opts.notBefore })
  })
  const run = tasks.startRun({
    taskId: task.id,
    workerId,
    sessionId: opts.sessionId ?? SESSION_ID,
    projectId: null,
    quotaUnverified: false,
    costModelId: 'anthropic.subscription.2026-08'
  })
  if (!opts.open) tasks.finishRun(run.id, 'preempted', 'the window closed under it')
  tasks.setStatus(task.id, (opts.status ?? 'running') as never)
  return task
}

/** ⚠️ A function, not a const: `settings` is a dynamic import and does not exist until `beforeAll`. */
const fleetOff = (): typeof settings.DEFAULT_SETTINGS => ({
  ...settings.DEFAULT_SETTINGS,
  autoCompact: false
})
const ctx = (over: Record<string, unknown> = {}): Parameters<typeof clock.decide>[1] => ({
  objective: OBJECTIVE,
  now: NOW,
  ...over
})

// ---------------------------------------------------------------------------- the resolver

/**
 * ⛔ The pure half, tested apart from the clock. Every branch below it is only as good as this, and
 * this is the one piece a renderer, a daemon and a future project tier all share.
 */
describe('task, then fleet - and `inherit` is a real value', () => {
  it('a task that has never expressed a preference follows the fleet', () => {
    expect(shared.resolveAutoCompact({ autoCompact: 'inherit' }, true)).toEqual({
      autoCompact: 'on',
      source: 'fleet'
    })
    expect(shared.resolveAutoCompact({ autoCompact: 'inherit' }, false)).toEqual({
      autoCompact: 'off',
      source: 'fleet'
    })
  })

  it('⭐ a task can be told to compact on a fleet that is switched off', () => {
    expect(shared.resolveAutoCompact({ autoCompact: 'on' }, false)).toEqual({
      autoCompact: 'on',
      source: 'task'
    })
  })

  it('and told not to on a fleet that is switched on', () => {
    expect(shared.resolveAutoCompact({ autoCompact: 'off' }, true)).toEqual({
      autoCompact: 'off',
      source: 'task'
    })
  })

  it('answers for no task at all, which is what a conversation nobody owns gets', () => {
    expect(shared.resolveAutoCompact(null, true).autoCompact).toBe('on')
    expect(shared.resolveAutoCompact(undefined, false).autoCompact).toBe('off')
  })

  it('⛔ `inherit` and the fleet value are not the same choice, which is the point of offering both', () => {
    // A task on `inherit` moves when the fleet moves; one pinned to the same value does not. An
    // operator who pins a long task and then changes the fleet is relying on exactly this.
    const inheriting = { autoCompact: 'inherit' as const }
    const pinned = { autoCompact: 'on' as const }
    expect(shared.resolveAutoCompact(inheriting, true).autoCompact).toBe('on')
    expect(shared.resolveAutoCompact(inheriting, false).autoCompact).toBe('off')
    expect(shared.resolveAutoCompact(pinned, true).autoCompact).toBe('on')
    expect(shared.resolveAutoCompact(pinned, false).autoCompact).toBe('on')
  })

  it('the source travels with the answer, so a refusal can name the control that said no', () => {
    expect(shared.resolveAutoCompact({ autoCompact: 'off' }, false).source).toBe('task')
    expect(shared.resolveAutoCompact({ autoCompact: 'inherit' }, false).source).toBe('fleet')
  })
})

// ---------------------------------------------------------------------------- persistence

describe('the choice survives the database', () => {
  it('a task filed without an opinion is `inherit`, not the fleet value frozen in', () => {
    const t = tasks.createTask({ title: 'no opinion', createdBy: { kind: 'human' } })
    expect(t.autoCompact).toBe('inherit')
    expect(tasks.getTask(t.id)?.autoCompact).toBe('inherit')
  })

  it('round-trips every value through create and through update', () => {
    const t = tasks.createTask({
      title: 'an opinion',
      createdBy: { kind: 'human' },
      autoCompact: 'on'
    })
    expect(tasks.getTask(t.id)?.autoCompact).toBe('on')
    expect(tasks.updateTask(t.id, { autoCompact: 'off' }).autoCompact).toBe('off')
    expect(tasks.getTask(t.id)?.autoCompact).toBe('off')
    expect(tasks.updateTask(t.id, { autoCompact: 'inherit' }).autoCompact).toBe('inherit')
  })

  it('an unrelated update leaves it alone', () => {
    // ⚠️ The column is written on every `updateTask`, so a patch that does not mention it must
    // carry the current value forward rather than resetting to the default.
    const t = tasks.createTask({
      title: 'an opinion',
      createdBy: { kind: 'human' },
      autoCompact: 'off'
    })
    expect(tasks.updateTask(t.id, { priority: 'P1' }).autoCompact).toBe('off')
  })

  it('⛔ a row written before the migration reads as `inherit`, never as a preference', () => {
    // A pre-migration row gets the column default; a row that somehow holds an empty string is the
    // same situation, and coalescing it to `inherit` is the only honest reading of a task that
    // never expressed anything.
    const t = tasks.createTask({ title: 'an old row', createdBy: { kind: 'human' } })
    db.db().prepare("update tasks set auto_compact = '' where id = ?").run(t.id)
    expect(tasks.getTask(t.id)?.autoCompact).toBe('inherit')
  })
})

// ---------------------------------------------------------------------------- whose opinion

/**
 * ⛔ A conversation can be held by more than one task over its life — that is what session sharing
 * is for — so "which task decides?" is a real question with a wrong answer available. The union of
 * everyone who ever spoke in it would let a stranger's setting govern this task's spending.
 */
describe('which task speaks for a conversation', () => {
  it('a conversation no task has ever run in falls back to the fleet', () => {
    expect(clock.mayCompact(session(), true)).toEqual({ allowed: true, source: 'fleet' })
    expect(clock.mayCompact(session(), false)).toEqual({ allowed: false, source: 'fleet' })
  })

  it('the task that ran in it decides, and says so', () => {
    owner('off')
    expect(clock.mayCompact(session(), true)).toEqual({ allowed: false, source: 'task' })
  })

  it('⭐ the most recent run wins when a conversation has been shared', () => {
    // First `off`, then a second task borrows the same conversation and says `on`. The live
    // opinion is the one being acted on right now.
    owner('off')
    owner('on')
    expect(clock.mayCompact(session(), false)).toEqual({ allowed: true, source: 'task' })
  })

  it('a task on `inherit` hands the question straight back to the fleet', () => {
    owner('inherit')
    expect(clock.mayCompact(session(), true).source).toBe('fleet')
    expect(clock.mayCompact(session(), false).allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------- move 4

describe('move 4: the idle conversation past the break-even', () => {
  it('the control: with nothing overriding it, the fleet switch still decides both ways', () => {
    owner('inherit')
    expect(clock.decide(session(), ctx()).move).toBe('compact')
    expect(clock.decide(session(), ctx({ settings: fleetOff() })).move).toBe('none')
  })

  it('⭐ compacts a task switched on, on a fleet that is switched off', () => {
    owner('on')
    const decision = clock.decide(session(), ctx({ settings: fleetOff() }))
    expect(decision.move).toBe('compact')
    expect(decision.estimatedCost).toBeGreaterThan(0)
  })

  it('⭐ leaves a task switched off alone, on a fleet that is switched on', () => {
    owner('off')
    expect(clock.decide(session(), ctx()).move).toBe('none')
  })

  it('and names the task, not Settings > Global, when it was the task that refused', () => {
    // ⛔ "Automatic compaction is switched off" would send somebody to a fleet switch that is on.
    // A refusal that misdirects is worse than a refusal that says nothing.
    owner('off')
    expect(clock.decide(session(), ctx()).reason).toContain('this task is set never to compact')
    owner('inherit')
    expect(clock.decide(session(), ctx({ settings: fleetOff() })).reason).toContain(
      'automatic compaction is switched off'
    )
  })

  it('⛔ is a permission and not an instruction: a small context is still left alone', () => {
    // The whole two-part `worthCompactingNow` test survives the override. Switching a task on must
    // not buy a compaction that buys nothing.
    owner('on')
    const small = session({ contextTokens: 4_000, tokensSinceCompact: 1_000 })
    expect(clock.decide(small, ctx({ settings: fleetOff() })).move).not.toBe('compact')
  })

  it('⛔ and one compacted a moment ago is left alone, however emphatically it was switched on', () => {
    owner('on')
    const justCompacted = session({ tokensSinceCompact: 0 })
    expect(clock.decide(justCompacted, ctx({ settings: fleetOff() })).move).not.toBe('compact')
  })

  it('⛔ cannot conjure a capability an adapter does not have', () => {
    // Antigravity declares `manualCompact: false`. An override is a preference; this is not.
    owner('on')
    const decision = clock.decide(session({ adapterId: 'antigravity-cli' }), ctx({ settings: fleetOff() }))
    expect(decision.move).not.toBe('compact')
  })

  it('⛔ does not get to re-ask while the first ask is still in flight', () => {
    // The 2026-08-26 repeat: thirteen `/compact`s in two minutes. The outstanding-move check sits
    // above every branch, and an override must not have been threaded in above it.
    owner('on')
    const asked = session({
      clockMove: 'compact',
      clockMoveAt: NOW - 10_000,
      clockMoveContext: 618_405
    })
    expect(clock.decide(asked, ctx({ settings: fleetOff() })).move).toBe('none')
  })

  it('still respects the TTL window: an override does not make a compaction urgent', () => {
    // 50 minutes of TTL is nowhere near the decision window, and move 4 has no business firing.
    owner('on')
    const early = session({ cacheExpiresAt: NOW + 50 * 60 * 1000 })
    expect(clock.decide(early, ctx({ settings: fleetOff() })).move).toBe('none')
  })
})

// ---------------------------------------------------------------------------- move 5b

describe('move 5b: a conversation the queue is waiting on', () => {
  const wanted = (patch: Partial<Session> = {}): Session =>
    session({
      contextTokens: 150_000,
      contextWindow: 200_000,
      tokensSinceCompact: 120_000,
      // ⚠️ Far outside the TTL window on purpose: this move must fire on the queue alone.
      cacheExpiresAt: NOW + 50 * 60 * 1000,
      ...patch
    })

  it('⭐ compacts for a borrower when the task says so and the fleet does not', () => {
    owner('on')
    const decision = clock.decide(
      wanted(),
      ctx({ settings: fleetOff(), borrowWanted: new Set([SESSION_ID]) })
    )
    expect(decision.move).toBe('compact')
    expect(decision.reason).toContain('too full to lend')
  })

  it('and refuses one for a task that said not to, however much the queue wants it', () => {
    owner('off')
    const decision = clock.decide(wanted(), ctx({ borrowWanted: new Set([SESSION_ID]) }))
    expect(decision.move).not.toBe('compact')
  })
})

// ---------------------------------------------------------------------------- move 5

/**
 * ⛔ The reserve breach — the one compaction that does not wait for the TTL clock, because a context
 * stranded behind a spent window is work lost rather than tokens wasted. The operator's answer to
 * "should a task be able to opt out of this?" was yes: a control that quietly does not apply here
 * would be a control that does not do what it says.
 */
describe('move 5: the reserve is at risk', () => {
  const stranded = (patch: Partial<Session> = {}): Session =>
    session({
      workerId: reserveWorkerId,
      contextTokens: 401_341,
      tokensSinceCompact: 1_401_019,
      // Nowhere near expiry: this has to fire on the reserve alone.
      cacheExpiresAt: NOW + 55 * 60 * 1000,
      ...patch
    })

  /** The live row `requiredReserve` counts, and the 92% reading `windowPressure` reads. */
  function breach(): void {
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               context_tokens, tokens_since_compact, started_at)
         values (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'ef5e90dc-0000-4000-8000-000000000001',
        reserveWorkerId,
        'claude-code',
        'stream',
        dir,
        'live',
        'work',
        401_341,
        1_401_019,
        Date.now()
      )
    db.db()
      .prepare(
        `insert into quota_samples (worker_id, window_id, label, percent, resets_at, source, sampled_at)
         values (?,?,?,?,?,?,?)`
      )
      .run(reserveWorkerId, '5h', '5h', 92, Date.now() + 2 * HOUR, 'probe', Date.now())
  }

  it('the precondition, asserted rather than assumed', () => {
    breach()
    expect(reserve.reserveState(reserveWorkerId).verdict).toBe('at_risk')
  })

  it('⭐ compacts a breached reserve for a task switched on, on a fleet switched off', () => {
    breach()
    owner('on')
    const decision = clock.decide(stranded(), ctx({ settings: fleetOff() }))
    expect(decision.move).toBe('compact')
    expect(decision.reason).toContain('reserve at risk')
  })

  it('⭐ a task switched off gets a handoff instead - the move that is always available', () => {
    // ⛔ Not silence. Told-not-to-compact and cannot-compact land in the same place, and the work
    // still has to come out before the context is stranded.
    breach()
    owner('off')
    const decision = clock.decide(stranded(), ctx())
    expect(decision.move).toBe('handoff_close')
    expect(decision.reason).toContain('this task is set never to compact')
  })
})

// ---------------------------------------------------------------------------- move 7

describe('move 7: waking a closed conversation to compact it', () => {
  const closed = (patch: Partial<Session> = {}): Session =>
    session({
      state: 'closed',
      contextTokens: 84_254,
      tokensSinceCompact: 345_708,
      lastRequestStartedAt: NOW - 45 * 60 * 1000,
      cacheExpiresAt: NOW + 10 * 60 * 1000,
      closedAt: NOW - 45 * 60 * 1000,
      ...patch
    })

  it('⭐ revives and compacts for a task switched on, on a fleet switched off', () => {
    owner('on', { status: 'paused_quota', notBefore: NOW + 2 * HOUR })
    const decision = clock.decideRevive(closed(), ctx({ settings: fleetOff() }))
    expect(decision.move).toBe('revive_compact')
  })

  it('⭐ and refuses to spend a whole process on a task that said not to', () => {
    owner('off', { status: 'paused_quota', notBefore: NOW + 2 * HOUR })
    const decision = clock.decideRevive(closed(), ctx())
    expect(decision.move).toBe('none')
    expect(decision.reason).toContain('this task is set never to compact')
  })

  it('the control: on `inherit` the fleet switch still decides', () => {
    owner('inherit', { status: 'paused_quota', notBefore: NOW + 2 * HOUR })
    expect(clock.decideRevive(closed(), ctx()).move).toBe('revive_compact')
    expect(clock.decideRevive(closed(), ctx({ settings: fleetOff() })).move).toBe('none')
  })
})

// ---------------------------------------------------------------------------- resume

describe('compacting at the moment a run resumes into a conversation', () => {
  // ⚠️ Pinned inside the last quarter of the TTL, which is the window this path still acts in. These
  //    checks are about the permission switch, and a fixture whose prefix had lapsed would refuse for
  //    an unrelated reason and stop testing the switch at all.
  const carried = (patch: Partial<Session> = {}): Session =>
    session({
      state: 'closed',
      contextTokens: 84_254,
      tokensSinceCompact: 345_708,
      cacheExpiresAt: Date.now() + 8 * 60 * 1000,
      ...patch
    })

  it('⭐ compacts for a task switched on, on a fleet switched off', () => {
    owner('on')
    const plan = clock.compactOnResume(carried(), fleetOff())
    expect(plan.compact).toBe(true)
    expect(plan.estimatedCost).toBeGreaterThan(0)
  })

  it('⭐ a task switched off does not acquire a compaction merely by being resumed', () => {
    // ⛔ This is the last-resort path, so it is the one most likely to be forgotten — and forgetting
    // it would mean a task set to `never` still gets compacted, just later and more expensively.
    owner('off')
    const plan = clock.compactOnResume(carried(), settings.DEFAULT_SETTINGS)
    expect(plan.compact).toBe(false)
    expect(plan.reason).toContain('this task is set never to compact')
  })

  it('and the two-part size test survives the override here too', () => {
    owner('on')
    expect(clock.compactOnResume(carried({ contextTokens: 4_000 }), fleetOff()).compact).toBe(false)
    expect(clock.compactOnResume(carried({ tokensSinceCompact: 1_000 }), fleetOff()).compact).toBe(false)
  })

  it('⛔ and an adapter with no `/compact` is still not asked for one', () => {
    owner('on')
    const plan = clock.compactOnResume(carried({ adapterId: 'antigravity-cli' }), fleetOff())
    expect(plan.compact).toBe(false)
  })
})
