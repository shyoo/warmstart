import { describe, expect, it } from 'vitest'
import {
  DEBATE_VERDICTS,
  DEBATE_VERDICT_DETAILS,
  DEBATE_VERDICT_LABELS,
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  MAX_DEBATE_SEATS,
  MIN_DEBATE_SEATS,
  ROOT_MANDATE,
  SHARING_LABELS,
  SHARING_SHORT,
  adapterSpread,
  policyLands,
  policyVerifies,
  readDebateState
} from './tasks.js'

/**
 * ⛔ A short label is a *second* copy of the same closed set, and this project has already been
 * bitten once by exactly that: three dropdowns each carried their own list of finish policies and
 * all three still offered `agent-lands` months after it was renamed. Drift here is silent — the
 * button reads one policy, the menu another, and both look fine.
 *
 * So the short forms are allowed to exist only while something checks they cover the ladder exactly:
 * nothing missing (a policy with no pill label renders `undefined`), and nothing extra (a key that
 * outlived its policy is the rename bug back again).
 */
describe('the pill-sized names for the two policies a task carries', () => {
  it('names every rung of the finish ladder and no rung that is gone', () => {
    expect(Object.keys(FINISH_SHORT).sort()).toEqual([...FINISH_ORDER].sort())
    expect(Object.keys(FINISH_SHORT).sort()).toEqual(Object.keys(FINISH_LABELS).sort())
  })

  it('gives each rung something short enough to sit beside five other controls', () => {
    for (const policy of FINISH_ORDER) {
      const short = FINISH_SHORT[policy]
      expect(short.trim()).not.toBe('')
      // ⚠️ The number is the point, not the exact bound: the whole row of pills has to fit on one
      // line under the prompt, and `commit, verify, merge and push` is what made the old select
      // wrap. Anything longer than this belongs in the menu, where the long label already lives.
      expect(short.length).toBeLessThanOrEqual(FINISH_LABELS[policy].length + 4)
      expect(short.length).toBeLessThanOrEqual(26)
    }
  })

  it('names both answers to whether a conversation may be reused', () => {
    expect(Object.keys(SHARING_SHORT).sort()).toEqual(Object.keys(SHARING_LABELS).sort())
    expect(SHARING_SHORT.on).toBe('Reuse')
    expect(SHARING_SHORT.off).toBe('Fresh')
  })
})

/**
 * Which rungs the tool itself acts on, which is what the thread's Land button may offer.
 *
 * ⛔ The list is derived from this predicate rather than written out beside the button, for the
 * reason above: a hand-written second copy of the ladder is how three dropdowns went on offering
 * `agent-lands` after it was renamed.
 */
describe('the rungs where the tool does the last part', () => {
  it('names the three that move a branch, and none of the ones that leave it alone', () => {
    expect(FINISH_ORDER.filter(policyLands)).toEqual([
      'commit-and-merge',
      'commit-and-push',
      'pull-request'
    ])
  })

  it('never offers landing under a rung that only commits', () => {
    // ⛔ The refusal `landConversation` enforces: pressing Land on `commit-only` would write a
    // policy, move nothing, and look like it had worked.
    expect(policyLands('commit-only')).toBe(false)
    expect(policyLands('commit-and-verify')).toBe(false)
    expect(policyLands('await-human')).toBe(false)
    // ⚠️ `custom` lands nothing *of the tool's own*: its last step is the project's instruction to
    // the agent, and a second landing on top of it is exactly what `decideFinish` refuses to add.
    expect(policyLands('custom')).toBe(false)
  })

  it('is a different question from whether the checks run', () => {
    // ⚠️ They overlap on the two merge rungs and disagree at both ends, which is why there are two
    // predicates: `commit-and-verify` verifies and lands nothing; `pull-request` lands and does not.
    expect(policyVerifies('commit-and-verify')).toBe(true)
    expect(policyLands('commit-and-verify')).toBe(false)
    expect(policyLands('pull-request')).toBe(true)
    expect(policyVerifies('pull-request')).toBe(false)
  })
})

/**
 * Debate's shared constants, and the one that has to agree with something else.
 *
 * ⛔ **One cap, not two.** The composer offers 2–5 seats and `createTask` enforces
 * `ROOT_MANDATE.maxChildren`. A split of six was once refused with a message about a fan-out cap
 * nobody had set, and the fix was to make the number on the control the number that is enforced —
 * which only stays true while something checks the two are the same.
 */
describe('the debate roster’s bounds', () => {
  it('caps seats at the mandate’s own fan-out limit', () => {
    expect(MAX_DEBATE_SEATS).toBe(ROOT_MANDATE.maxChildren)
    // ⚠️ Two, because a debate of one is an ordinary task and cheaper — it buys a round trip and a
    // cold context and delivers no second opinion.
    expect(MIN_DEBATE_SEATS).toBe(2)
  })

  it('names and explains all five verdicts, with nothing missing and nothing extra', () => {
    expect(Object.keys(DEBATE_VERDICT_LABELS).sort()).toEqual([...DEBATE_VERDICTS].sort())
    expect(Object.keys(DEBATE_VERDICT_DETAILS).sort()).toEqual([...DEBATE_VERDICTS].sort())
    for (const verdict of DEBATE_VERDICTS) {
      expect(DEBATE_VERDICT_LABELS[verdict].trim()).not.toBe('')
      expect(DEBATE_VERDICT_DETAILS[verdict].trim()).not.toBe('')
    }
  })
})

/**
 * ⛔ **Counted on the adapter, not the model name.** Published work finds cross-*family* pairs are
 * what carry debate's gain; two Claude models are one family however different their ids look.
 */
describe('how many model families a roster spans', () => {
  it('counts adapters, so two models of one CLI are one family', () => {
    expect(adapterSpread(['claude-code', 'claude-code'])).toBe(1)
    expect(adapterSpread(['claude-code', 'openai-compatible'])).toBe(2)
  })

  // ⚠️ An account this fleet has forgotten contributes nothing rather than a phantom family.
  it('counts nothing for an account with no adapter', () => {
    expect(adapterSpread([null, undefined, 'claude-code'])).toBe(1)
    expect(adapterSpread([])).toBe(0)
  })
})

/**
 * ⚠️ **A malformed blob reads as *no debate*, never a throw** — the rule `parseChildDefaults`
 * already keeps. This column is read on every task load, and a task that cannot be listed because
 * its settings did not parse is a worse failure than a debate that has to be re-filed.
 */
describe('reading a debate blob written by any version of this tool', () => {
  it('reads a whole one back', () => {
    const state = readDebateState({
      seats: [{ workerId: 'w-a', model: 'opus', effort: 'high' }, { workerId: 'w-b' }],
      rounds: 3,
      exchange: 'digest',
      round: 2,
      verdict: 'execute'
    })
    expect(state?.seats).toEqual([
      { workerId: 'w-a', model: 'opus', effort: 'high' },
      { workerId: 'w-b', model: null, effort: null }
    ])
    expect(state?.rounds).toBe(3)
    expect(state?.exchange).toBe('digest')
    expect(state?.round).toBe(2)
    expect(state?.verdict).toBe('execute')
  })

  it('is null for anything with no usable seat in it', () => {
    expect(readDebateState(null)).toBeNull()
    expect(readDebateState('a string')).toBeNull()
    expect(readDebateState([])).toBeNull()
    expect(readDebateState({ seats: [] })).toBeNull()
    expect(readDebateState({ seats: [{ workerId: '' }, { nope: 1 }] })).toBeNull()
  })

  // ⚠️ Clamped rather than rejected: a stored value from a build with different bounds is repaired
  // to the nearest legal one, which is what the rest of the config readers here do.
  it('clamps the rounds and falls back to the verbatim exchange', () => {
    const state = readDebateState({ seats: [{ workerId: 'w-a' }], rounds: 40, exchange: 'nope' })
    expect(state?.rounds).toBe(5)
    expect(state?.exchange).toBe('full')
    expect(state?.round).toBe(1)
    // ⛔ An unrecognised verdict is *no verdict*, never a guessed one: a verdict decides what the
    // organizer does next, and inventing one would act on a choice nobody made.
    expect(readDebateState({ seats: [{ workerId: 'w-a' }], verdict: 'land' })?.verdict).toBeNull()
  })
})
