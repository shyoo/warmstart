import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'
import type { Session } from '@shared/protocol.js'

/**
 * Phase 3: who may borrow whose conversation, and who decides.
 *
 * ⛔ **The gates are mechanical on purpose**, and that was a decision rather than a first draft. A
 * topic score is the obvious next idea and it has no ground truth: when it misfires there is nothing
 * to check it against, and being wrong means an agent has silently read work it was not given. So the
 * rule is one anybody can predict from outside — same project, same account, free, clean, room to
 * grow — and `rank` returns a list so a score can join the comparator later without a rewrite.
 *
 * ⚠️ Every default is `off`. A database written before this existed behaves afterwards exactly as it
 * did before, because sharing changes who can see whose work and switching that on for every project
 * in an install by upgrading it would be a change nobody asked for, made everywhere at once.
 */

let dir: string
let db: typeof import('./db.js')
let sharing: typeof import('./sharing.js')
let settingsModule: typeof import('./settings.js')
let adapters: typeof import('./adapters/index.js')

const PROJECT = 'project-1'

const task = (patch: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    seq: 1,
    projectId: PROJECT,
    sessionSharing: 'inherit',
    constraints: {},
    ...patch
  }) as Task

const project = (share?: unknown): Project =>
  ({
    id: PROJECT,
    name: 'repo',
    config: share === undefined ? {} : { session: { share } }
  }) as unknown as Project

const session = (patch: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    workerId: 'w',
    adapterId: 'claude-code',
    projectId: PROJECT,
    cwd: 'C:\\ws1',
    state: 'live',
    model: null,
    effort: null,
    purpose: 'work',
    contextTokens: 1_000,
    contextWindow: 200_000,
    ...patch
  }) as Session

const open = { hasWorkspace: true, leased: false }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-sharing-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  sharing = await import('./sharing.js')
  settingsModule = await import('./settings.js')
  adapters = await import('./adapters/index.js')
  db.openDb(join(dir, 'sharing.db'))
})

beforeEach(() => db.db().exec('delete from settings'))

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what the three tiers resolve to', () => {
  it('is on when nobody has said anything at all', () => {
    // ⛔ The shipped default (2026-09-19): reuse, so a clean install starts warm.
    expect(sharing.resolveSessionSharing(task(), project())).toEqual({
      sharing: 'on',
      source: 'fleet'
    })
  })

  it('takes the fleet setting when the project and task both defer', () => {
    settingsModule.setSetting('sessionSharing', 'on')
    expect(sharing.resolveSessionSharing(task(), project())).toEqual({
      sharing: 'on',
      source: 'fleet'
    })
  })

  it('lets a project override the fleet', () => {
    settingsModule.setSetting('sessionSharing', 'off')
    expect(sharing.resolveSessionSharing(task(), project('on'))).toEqual({
      sharing: 'on',
      source: 'project'
    })
  })

  it('lets a project opt out of a fleet that shares', () => {
    settingsModule.setSetting('sessionSharing', 'on')
    expect(sharing.resolveSessionSharing(task(), project('off'))).toEqual({
      sharing: 'off',
      source: 'project'
    })
  })

  it('lets a task override its project, in both directions', () => {
    expect(sharing.resolveSessionSharing(task({ sessionSharing: 'on' }), project('off'))).toEqual({
      sharing: 'on',
      source: 'task'
    })
    expect(sharing.resolveSessionSharing(task({ sessionSharing: 'off' }), project('on'))).toEqual({
      sharing: 'off',
      source: 'task'
    })
  })

  it('treats inherit as a real value that follows the project, not as a blank', () => {
    // ⚠️ The reason the dropdown offers `inherit` rather than showing an empty box. A task left on
    // it moves when the project moves; one set explicitly to the same value does not.
    const t = task({ sessionSharing: 'inherit' })
    expect(sharing.resolveSessionSharing(t, project('on')).sharing).toBe('on')
    expect(sharing.resolveSessionSharing(t, project('off')).sharing).toBe('off')
  })

  it('ignores a project config that says something meaningless', () => {
    // ⚠️ Hand-edited JSON, committed to somebody's repo. `share: true` or `share: "yes"` is not a
    // value this understands, and guessing which way a nonsense answer leans is how a boundary gets
    // widened by a typo. It falls through to the tier below.
    settingsModule.setSetting('sessionSharing', 'off')
    for (const nonsense of [true, 'yes', 1, null, {}]) {
      expect(sharing.resolveSessionSharing(task(), project(nonsense)).sharing).toBe('off')
    }
  })
})

describe('which conversations may be offered', () => {
  it('offers an idle one in the same project', () => {
    expect(sharing.whyNotShared(task(), session(), open)).toBeNull()
  })

  it('refuses one belonging to another project', () => {
    // ⛔ Not a tuning question. One client's code in another client's conversation is not something
    // a scheduler gets to decide is acceptable.
    expect(sharing.whyNotShared(task(), session({ projectId: 'other' }), open)).toBe(
      'not-this-project'
    )
  })

  it('refuses one with no project at all', () => {
    // A consult, a chat, the usage probe. None of them is a place to put a task's work.
    expect(sharing.whyNotShared(task(), session({ projectId: null }), open)).toBe('not-this-project')
  })

  it('refuses one that is holding no workspace', () => {
    // Nothing to lend: the borrower would claim its own tree, which is a cold start wearing somebody
    // else's context.
    expect(sharing.whyNotShared(task(), session(), { ...open, hasWorkspace: false })).toBe(
      'no-workspace'
    )
  })

  it('refuses one somebody else has already been given', () => {
    expect(sharing.whyNotShared(task(), session(), { ...open, leased: true })).toBe('busy')
  })

  it('refuses an adapter that cannot resume a conversation at all', () => {
    // ⚠️ `local-llm`, not `openai-compatible`. Codex declared `resumeSession: false` until
    // 2026-09-02 and was the fixture here; it now resumes, and the bridge is the remaining adapter
    // that genuinely cannot — it starts a fresh conversation on every dispatch by design.
    // ⛔ Asserted, not assumed. The stand-in changing under this test is precisely how it became a
    // test of nothing the first time; this line fails the day local-llm learns to resume too.
    expect(adapters.adapter('local-llm').info.capabilities.resumeSession).toBe(false)
    expect(sharing.whyNotShared(task(), session({ adapterId: 'local-llm' }), open)).toBe(
      'cannot-resume'
    )
  })

  it('refuses one whose prompt cache has already lapsed', () => {
    // ⛔ **A borrow buys a warm prefix and nothing else.** The borrower did not have this
    // conversation, so there is no continuity to recover — only a cache somebody else paid for. Once
    // that has lapsed the trade inverts: a full rebuild (1.25x on codex, 2.0x on Anthropic) to load
    // context this task never needed, plus the disclosure of everything said in it.
    //
    // ⚠️ Deliberately not symmetrical with a task resuming its **own** conversation, which
    // `resumableSession` still allows cold. See the comment on this gate in sharing.ts.
    const lapsed = session({ cacheExpiresAt: Date.now() - 60_000 })
    expect(sharing.whyNotShared(task(), lapsed, open)).toBe('cache-lapsed')
  })

  it('lends one whose prompt cache is still warm', () => {
    const warm = session({ cacheExpiresAt: Date.now() + 10 * 60_000 })
    expect(sharing.whyNotShared(task(), warm, open)).toBeNull()
  })

  it('does not read an unknown expiry as a lapsed one', () => {
    // ⚠️ The same rule `isTooFull` follows for context. A session on a provider whose cache this
    // fleet cannot price records `null`, and refusing every such conversation would write off a
    // whole provider over a number nobody published.
    expect(sharing.whyNotShared(task(), session({ cacheExpiresAt: null }), open)).toBeNull()
  })

  /**
   * ⛔ The two halves of reuse, which stopped being the same answer the day `codex exec resume` was
   * wired. Before that codex failed both for one reason and one check covered both; now a live
   * codex process must still be refused — its stdin closed after its only turn — while its *closed*
   * conversations are exactly the warm prefixes the fleet is trying not to rebuild.
   */
  it('refuses a live one-shot conversation but lends its closed ones', () => {
    const codex = session({ adapterId: 'openai-compatible' })
    expect(sharing.whyNotShared(task(), codex, { ...open, continuation: 'live' })).toBe('one-shot')
    expect(sharing.whyNotShared(task(), codex, { ...open, continuation: 'revive' })).toBeNull()
    // Unstated means live: the stricter reading, so a forgetful caller is refused rather than
    // handed a pipe that closed.
    expect(sharing.whyNotShared(task(), codex, open)).toBe('one-shot')
  })

  it('never offers a one-shot conversation as a live one, whichever adapter it is', () => {
    // ⛔ The fleet-wide form of the rule above, so a new one-shot adapter inherits it instead of
    // having to remember it. It lived in `adapters.test.ts` as `resumeSession === false` until
    // codex could resume, at which point a capability could no longer say it.
    const once = adapters.adapters().filter((a) => a.info.capabilities.streamPrompts === 'once')
    expect(once.length).toBeGreaterThan(0)
    for (const ad of once) {
      const refusal = sharing.whyNotShared(task(), session({ adapterId: ad.info.id }), {
        ...open,
        continuation: 'live'
      })
      // `cannot-resume` is the earlier gate and an equally correct refusal; what must never happen
      // is `null`.
      expect(['one-shot', 'cannot-resume'], ad.info.id).toContain(refusal)
    }
  })

  it('refuses one whose context is already past the ceiling', () => {
    // ⛔ A borrowed conversation about to need compaction is a false economy: the borrower pays to
    // read a large prefix and then pays again to compact it, for context mostly about another task.
    const full = session({ contextTokens: 130_000, contextWindow: 200_000 })
    expect(sharing.whyNotShared(task(), full, open)).toBe('context-too-full')
  })

  it('measures the ceiling as a fraction, so a big window is not judged by a small one’s numbers', () => {
    // ⚠️ 130k is too full at 200k and perfectly fine at 1M. One absolute constant would be far too
    // strict on the large windows and useless on the small ones.
    const big = session({ contextTokens: 130_000, contextWindow: 1_000_000 })
    expect(sharing.whyNotShared(task(), big, open)).toBeNull()
  })

  it('treats an unknown window as room, not as full', () => {
    // ⚠️ Unknown is not full. A model with no priced window reports none, and reading that as "too
    // full" would exclude a whole provider from sharing over a number it does not publish — the same
    // trap as treating an unrecorded cache expiry as lapsed.
    expect(sharing.isTooFull(session({ contextWindow: null, contextTokens: 900_000 }))).toBe(false)
    expect(sharing.isTooFull(session({ contextTokens: null }))).toBe(false)
  })
})

describe('which of them is offered first', () => {
  it('puts the emptiest conversation at the front', () => {
    // It has the most room for the borrower's own work before anything needs compacting.
    const ranked = sharing.rank([
      session({ id: 'full', contextTokens: 90_000 }),
      session({ id: 'empty', contextTokens: 2_000 }),
      session({ id: 'middling', contextTokens: 40_000 })
    ])
    expect(ranked.map((s) => s.id)).toEqual(['empty', 'middling', 'full'])
  })

  it('returns a list rather than a winner, which is where a topic score goes later', () => {
    // ⚠️ Deliberate. The caller still has to take the lease and the lease can fail between ranking
    // and claiming, so a single answer would be a lie about how certain this is.
    expect(sharing.rank([session({ id: 'a' }), session({ id: 'b' })])).toHaveLength(2)
  })

  it('does not mutate what it was given', () => {
    const input = [session({ id: 'b', contextTokens: 10 }), session({ id: 'a', contextTokens: 1 })]
    sharing.rank(input)
    expect(input.map((s) => s.id)).toEqual(['b', 'a'])
  })
})

/**
 * ⭐ **Reuse across tasks is only a saving where it is also the same answer.**
 *
 * A prompt sent into a live conversation is served by the process already running it. The model and
 * the reasoning effort were fixed when that process was spawned, and `dispatchIntoWarmSession` sends
 * a prompt — it cannot respawn. So the account, the model and the effort have to match *before* a
 * conversation is offered, or the fleet quietly answers a question with a model nobody ordered and
 * files the run under the model that was asked for.
 */
describe('same account, same model, same effort', () => {
  const pinned = (constraints: Partial<Task['constraints']>): Task => task({ constraints })

  it('refuses a conversation on an account the task was pinned away from', () => {
    expect(sharing.whyNotShared(pinned({ workerId: 'w2' }), session({ workerId: 'w1' }), open)).toBe(
      'not-this-account'
    )
  })

  it('offers it when the pin names the account the conversation is on', () => {
    expect(
      sharing.whyNotShared(pinned({ workerId: 'w1' }), session({ workerId: 'w1' }), open)
    ).toBeNull()
  })

  it('refuses a conversation running a different adapter than the task was pinned to', () => {
    expect(
      sharing.whyNotShared(pinned({ adapterId: 'antigravity-cli' }), session(), open)
    ).toBe('not-this-account')
  })

  it('refuses a conversation running a different model', () => {
    // ⛔ The whole point. Opus work does not get quietly served by a Sonnet conversation because
    // that one happened to be warm.
    expect(
      sharing.whyNotShared(task(), session({ model: 'claude-sonnet-5' }), {
        ...open,
        intent: { model: 'claude-opus-5', effort: null }
      })
    ).toBe('wrong-model')
  })

  it('offers one running the same model', () => {
    expect(
      sharing.whyNotShared(task(), session({ model: 'claude-opus-5' }), {
        ...open,
        intent: { model: 'claude-opus-5', effort: null }
      })
    ).toBeNull()
  })

  it('refuses a conversation running a different effort', () => {
    expect(
      sharing.whyNotShared(task(), session({ model: 'claude-opus-5', effort: 'low' }), {
        ...open,
        intent: { model: 'claude-opus-5', effort: 'high' }
      })
    ).toBe('wrong-effort')
  })

  it('treats an unknown model or effort as no evidence, not as a mismatch', () => {
    // ⚠️ The same rule `isTooFull` follows. A session whose CLI chose its own model records null,
    // and reading that as "different" would refuse a real saving over a fact nobody wrote down.
    expect(
      sharing.whyNotShared(task(), session({ model: null, effort: null }), {
        ...open,
        intent: { model: 'claude-opus-5', effort: 'high' }
      })
    ).toBeNull()
    expect(
      sharing.whyNotShared(task(), session({ model: 'claude-opus-5', effort: 'high' }), {
        ...open,
        intent: { model: null, effort: null }
      })
    ).toBeNull()
  })

  it('asks nothing about the model when the caller resolved no intent at all', () => {
    // Every existing caller that has no worker in hand keeps its old answer rather than getting a
    // stricter one by accident.
    expect(sharing.mismatch(undefined, session({ model: 'claude-sonnet-5' }))).toBeNull()
  })
})

/**
 * ⭐ **Too full to lend is a blockage, not a verdict.**
 *
 * Above the ceiling a conversation is refused; above the compact floor, being *wanted* becomes a
 * reason to shrink it. The gap between the two is deliberate — see `SHARE_COMPACT_FLOOR`.
 */
describe('when being wanted is worth a compaction', () => {
  it('wants one past 70% of its window', () => {
    expect(
      sharing.wantsCompactionToShare(session({ contextTokens: 150_000, contextWindow: 200_000 }))
    ).toBe(true)
  })

  it('leaves the 60-70% band alone: refused, but not worth compacting for', () => {
    const middling = session({ contextTokens: 130_000, contextWindow: 200_000 })
    expect(sharing.whyNotShared(task(), middling, open)).toBe('context-too-full')
    expect(sharing.wantsCompactionToShare(middling)).toBe(false)
  })

  it('measures the floor as a fraction, like the ceiling', () => {
    expect(
      sharing.wantsCompactionToShare(session({ contextTokens: 150_000, contextWindow: 1_000_000 }))
    ).toBe(false)
  })

  it('asks for nothing when the window is unknown', () => {
    // ⚠️ Compacting on a guessed denominator would spend real tokens on arithmetic nobody did.
    expect(
      sharing.wantsCompactionToShare(session({ contextTokens: 900_000, contextWindow: null }))
    ).toBe(false)
  })
})
