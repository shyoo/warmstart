import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'
import { atCapacity, cacheHasLapsed, leastValuableResident } from './scheduler.js'

/**
 * Phase 1 of resident sessions: **the workspace belongs to the conversation, not to the run.**
 *
 * ⛔ It used to belong to the task, and the claim died with the run. The scheduler's own comment
 * said what that cost: a task continued by a reply was *"warm in context and homeless on disk"* — it
 * still held the session that knew everything about the work, and had to ask the pool for a tree and
 * hope it was handed back the same one. Anything else meant an agent resuming a conversation about
 * files that were no longer in front of it.
 *
 * Two properties are worth pinning, and they are the two that can silently invert:
 *   1. **Ownership** — releasing the old holder must not free the tree, and releasing the new one
 *      must. A transfer that half-works leaks a workspace or hands one out twice, and both are
 *      invisible until a pool has drained.
 *   2. **Which conversation is cheapest to lose** — because a pool with nothing free now closes
 *      something, and closing the wrong session throws away the exact context this all exists to
 *      keep.
 */

let dir: string
let db: typeof import('./db.js')
let resources: typeof import('./resources.js')

const POOL = 'ws-pool'
const TASK = 'task-1'
const SESSION = 'session-1'

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-residency-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  resources = await import('./resources.js')
  db.openDb(join(dir, 'residency.db'))
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from resources')
  resources.upsertResource({
    id: POOL,
    projectId: null,
    kind: 'counted',
    label: 'workspaces',
    members: ['ws1', 'ws2'],
    meta: {}
  })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const free = (): number => resources.availability(POOL)?.free ?? -1

describe('handing a workspace from the task that claimed it to the session that lives in it', () => {
  it('keeps the same claim and the same member', () => {
    // ⛔ Not release-and-reclaim. A pool with a free slot for even one scheduler tick is a pool
    // another task can take the slot out of, and it would not necessarily be the same worktree that
    // came back — which is the whole thing this claim is protecting.
    const claim = resources.claim(POOL, TASK, 1, 'ws1')
    expect(claim?.member).toBe('ws1')
    resources.reassignClaim(claim!.id, SESSION)
    const still = resources.availability(POOL)?.claims.find((c) => c.id === claim!.id)
    expect(still?.member).toBe('ws1')
    expect(still?.holder).toBe(SESSION)
    expect(free()).toBe(1)
  })

  it('stops answering to the task, so a run ending does not take the tree away', () => {
    // ⭐ The property phase 1 exists for. `releaseFor` still calls `releaseAllFor(task.id)` on every
    // exit path a run can take; after the transfer that must no longer reach the workspace, or a
    // task resting at awaiting_human loses the tree its warm session is sitting in.
    const claim = resources.claim(POOL, TASK, 1, 'ws1')
    resources.reassignClaim(claim!.id, SESSION)
    expect(resources.releaseAllFor(TASK)).toBe(0)
    expect(free()).toBe(1)
  })

  it('answers to the session, so the tree comes back when the conversation ends', () => {
    // ⚠️ The other half, and the one whose absence leaks every worktree the fleet ever uses.
    const claim = resources.claim(POOL, TASK, 1, 'ws1')
    resources.reassignClaim(claim!.id, SESSION)
    expect(resources.releaseAllFor(SESSION)).toBe(1)
    expect(free()).toBe(2)
  })

  it('leaves a claim taken before there was a session answering to the task', () => {
    // ⛔ Dispatch can fail between claiming a workspace and spawning anything into it — preparation
    // runs the project's install hook and is entitled to fail. That claim never gets transferred,
    // and `releaseAllFor(task.id)` is the only thing that will ever free it.
    resources.claim(POOL, TASK, 1, 'ws1')
    expect(resources.releaseAllFor(TASK)).toBe(1)
    expect(free()).toBe(2)
  })

  it('does nothing to a claim that has already been released', () => {
    const claim = resources.claim(POOL, TASK, 1, 'ws1')
    resources.release(claim!.id)
    resources.reassignClaim(claim!.id, SESSION)
    // ⚠️ Must not resurrect it. A transfer that revived a released claim would hold a workspace
    // nothing is using and nothing will ever release, which is the one failure a pool cannot recover
    // from without a restart.
    expect(free()).toBe(2)
    expect(resources.releaseAllFor(SESSION)).toBe(0)
    // ⛔ And it must not be re-attributed either. `resource_claims` is the record of who held what,
    // and the per-conversation view being built on top of it reads exactly this column: a released
    // claim relabelled with a session that never held it would put one conversation's worktree
    // history under another's name. Availability cannot see this, which is why it is asserted here.
    const row = db
      .db()
      .prepare('select holder from resource_claims where id = ?')
      .get(claim!.id) as { holder: string }
    expect(row.holder).toBe(TASK)
  })

  it('does not invent a claim for an id that never existed', () => {
    resources.reassignClaim('no-such-claim', SESSION)
    expect(free()).toBe(2)
  })
})

// ---------------------------------------------------------------------------- who gets evicted

const session = (patch: Partial<Session>): Session =>
  ({
    id: 's',
    workerId: 'w',
    adapterId: 'claude-code',
    transport: 'stream',
    projectId: null,
    cwd: 'C:\\ws1',
    model: null,
    effort: null,
    state: 'live',
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

describe('which conversation costs least to lose', () => {
  const NOW = 1_000_000

  it('takes the one whose cache has already lapsed', () => {
    // ⛔ Its context is no cheaper to reach than a cold start, so closing it destroys nothing that
    // had value. Everything else in the pool still has something worth keeping.
    const lapsed = session({ id: 'lapsed', cacheExpiresAt: NOW - 1, lastRequestStartedAt: NOW - 10 })
    const warm = session({ id: 'warm', cacheExpiresAt: NOW + 60_000, lastRequestStartedAt: 0 })
    expect(leastValuableResident([warm, lapsed], NOW)?.id).toBe('lapsed')
  })

  it('prefers a lapsed cache even when a warm session has been idle far longer', () => {
    // ⛔ The ordering that must not inflip. Idleness is the tie-break; it is not the criterion.
    // A warm session idle for an hour still holds a prefix worth 2.0·C to rebuild; a lapsed one
    // idle for a second holds nothing.
    const lapsed = session({ id: 'lapsed', cacheExpiresAt: NOW - 1, lastRequestStartedAt: NOW })
    const warm = session({ id: 'warm', cacheExpiresAt: NOW + 1, lastRequestStartedAt: NOW - 3_600_000 })
    expect(leastValuableResident([warm, lapsed], NOW)?.id).toBe('lapsed')
  })

  it('breaks a tie on the longest idle, measured from the last request', () => {
    // ⚠️ Not from `startedAt`. A conversation opened an hour ago that spoke a second ago is the
    // busiest thing in the pool, and ranking by start time would evict it first — reliably picking
    // the wrong session, every time, on a fleet where sessions are long-lived by design.
    const busy = session({ id: 'busy', startedAt: 0, lastRequestStartedAt: NOW - 1_000 })
    const idle = session({ id: 'idle', startedAt: NOW - 5_000, lastRequestStartedAt: NOW - 90_000 })
    expect(leastValuableResident([busy, idle], NOW)?.id).toBe('idle')
  })

  it('falls back to the start time only for a session that has never made a request', () => {
    const never = session({ id: 'never', startedAt: NOW - 500_000, lastRequestStartedAt: null })
    const spoke = session({ id: 'spoke', startedAt: 0, lastRequestStartedAt: NOW - 1_000 })
    expect(leastValuableResident([never, spoke], NOW)?.id).toBe('never')
  })

  it('says nothing rather than picking one when there is nothing to pick', () => {
    // The caller reads null as "the pool really is busy" and lets the dispatch fail with that
    // reason, rather than evicting something it should not have.
    expect(leastValuableResident([], NOW)).toBeNull()
  })

  it('treats a session with no recorded expiry as still warm', () => {
    // ⚠️ Unknown is not lapsed. An adapter whose cache cannot be priced records no expiry at all,
    // and reading that as "already gone" would make every one of its sessions first in line to be
    // destroyed — punishing a provider for a number it does not publish.
    expect(cacheHasLapsed(session({ cacheExpiresAt: null }), NOW)).toBe(false)
  })
})

describe('whether an account has a slot for this task', () => {
  const work = (id: string): Session => session({ id, purpose: 'work' })

  it('refuses when every slot holds a session it will not reuse', () => {
    expect(atCapacity([work('a')], 1, null)).toBe(true)
    expect(atCapacity([work('a'), work('b')], 2, null)).toBe(true)
  })

  it('allows when there is a slot free', () => {
    expect(atCapacity([], 1, null)).toBe(false)
    expect(atCapacity([work('a')], 2, null)).toBe(false)
  })

  it('does not count the session this task is going to reuse', () => {
    // ⭐ The bug this exists for, and it was never about sharing. A task resting at
    // `awaiting_human` keeps its session warm for the reply; on a one-slot worker - the default -
    // that idle session filled the only slot, so the reply itself was held at "at capacity"
    // indefinitely. Reusing a session starts no process, so it cannot consume a concurrency slot.
    // Measured on a real fleet 2026-08-28: t12 sat at `ready` for five minutes behind t11's own
    // parked conversation.
    const warm = work('warm')
    expect(atCapacity([warm], 1, warm)).toBe(false)
  })

  it('still refuses when another session is busy beside the one being reused', () => {
    // ⛔ The exemption is for exactly one session, not a licence to ignore the cap. Two live agents
    // on an account that permits one is the failure `maxConcurrent` exists to prevent.
    const warm = work('warm')
    expect(atCapacity([warm, work('other')], 1, warm)).toBe(true)
    expect(atCapacity([warm, work('other')], 2, warm)).toBe(false)
  })

  it('ignores sessions that are not work', () => {
    // ⚠️ A consult, a chat or a usage probe is short, holds no workspace and is bounded separately.
    // Counting them would make a fleet undispatchable because somebody asked it a question.
    expect(atCapacity([session({ id: 'c', purpose: 'consult' })], 1, null)).toBe(false)
    expect(atCapacity([session({ id: 'p', purpose: 'probe' })], 1, null)).toBe(false)
  })

  it('does not credit a reuse that is not in the list at all', () => {
    // A session on a *different* worker. Subtracting it here would raise this account's real
    // concurrency by one, quietly, which is the opposite of what the cap is for.
    expect(atCapacity([work('a')], 1, work('elsewhere'))).toBe(true)
  })
})

// ---------------------------------------------------------------- getting the same tree back

/**
 * Which pool member a task is handed.
 *
 * ⭐ A warm session's whole value is that the worktree in front of it is the one its context
 * describes. `preferMember` is how that is asked for, and a miss here **does not refuse** - the pool
 * hands out whatever is free instead, so the failure is an agent resuming a conversation about files
 * that are no longer there. Nothing downstream can detect that.
 */
const TREES = 'tree-pool'
const WS1 = 'C:\\Dev\\trees\\ws1'
const WS2 = 'C:\\Dev\\trees\\ws2'

describe('handing a task the worktree its conversation already knows', () => {
  beforeEach(() => {
    resources.upsertResource({
      id: TREES,
      projectId: null,
      kind: 'counted',
      label: 'trees',
      members: [WS1, WS2],
      meta: {}
    })
  })

  it('gives back the member that was asked for', () => {
    expect(resources.claim(TREES, 'task-a', 1, WS2)?.member).toBe(WS2)
  })

  it('gives it back when the caller spells the drive differently', () => {
    // ⭐ The bug, measured on this install 2026-08-28: `sessions.cwd` held one worktree as both
    // `c:\Dev\...` and `C:\Dev\...`, while the pool holds one spelling. `free.includes()` missed,
    // and the task was quietly given the *other* tree.
    if (process.platform !== 'win32') return
    const asked = WS2.replace(/^C:/, 'c:')
    const claim = resources.claim(TREES, 'task-a', 1, asked)
    expect(claim?.member).toBe(WS2)
  })

  it('claims the pool spelling, never the caller’s', () => {
    // ⚠️ `resource_claims.member` is joined back against `resources.members` by later reads. A claim
    // recorded under the caller's spelling would be a member the pool does not believe it has.
    if (process.platform !== 'win32') return
    const claim = resources.claim(TREES, 'task-a', 1, WS1.replace(/^C:/, 'c:'))
    expect(claim?.member).toBe(WS1)
    expect(resources.availability(TREES)?.resource.members).toContain(claim?.member)
  })

  it('takes whatever is free rather than refusing when the asked-for tree is taken', () => {
    // ⛔ Deliberate, and the reason the miss above was invisible: any workspace beats not running.
    resources.claim(TREES, 'holder', 1, WS1)
    expect(resources.claim(TREES, 'task-a', 1, WS1)?.member).toBe(WS2)
  })

  it('does not treat two different trees as one', () => {
    // The inverse failure, and the worse one: two tasks in a single worktree.
    resources.claim(TREES, 'holder', 1, WS1)
    expect(resources.availability(TREES)?.claims.map((c) => c.member)).toEqual([WS1])
  })
})
