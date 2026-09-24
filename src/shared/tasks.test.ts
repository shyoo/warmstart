import { describe, expect, it } from 'vitest'
import type { Task } from './tasks.js'
import {
  DEBATE_VERDICTS,
  DEBATE_VERDICT_DETAILS,
  DEBATE_VERDICT_LABELS,
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  conversationLandingResultText,
  MAX_DEBATE_SEATS,
  MIN_DEBATE_SEATS,
  ROOT_MANDATE,
  SHARING_LABELS,
  SHARING_SHORT,
  PLAN_EXECUTE_CHILDREN,
  adapterSpread,
  isPlanExecute,
  planChildCap,
  planModeOf,
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
  it('names every level of the finish ladder and no level that is gone', () => {
    expect(Object.keys(FINISH_SHORT).sort()).toEqual([...FINISH_ORDER].sort())
    expect(Object.keys(FINISH_SHORT).sort()).toEqual(Object.keys(FINISH_LABELS).sort())
  })

  it('gives each level something short enough to sit beside five other controls', () => {
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
 * What an agent is told after landing mid-conversation (t677).
 *
 * ⛔ Previous **then** next, each exactly once. A receipt naming only the new branch reads as a
 * restatement of the one the agent committed on — which is the report that started this — and one
 * naming the same branch twice sends it committing where it just landed.
 */
describe('the conversation-landing receipt', () => {
  const text = conversationLandingResultText(
    '08827248',
    'warmstart/t667.2-ebook-undrm',
    'main',
    'warmstart/t667.3-ebook-undrm'
  )

  it('states previous then next, in that order', () => {
    expect(text).toBe(
      'Landed 08827248 from `warmstart/t667.2-ebook-undrm` onto main. ' +
        'This conversation continues on warmstart/t667.3-ebook-undrm — commit any further work there. ' +
        'The task is not finished; carry on.'
    )
  })

  it('names each branch exactly once, and never the same one twice', () => {
    const names = [...text.matchAll(/warmstart\/t[\w.%-]+/g)].map((m) => m[0])
    expect(names).toEqual(['warmstart/t667.2-ebook-undrm', 'warmstart/t667.3-ebook-undrm'])
  })
})

/**
 * Which levels the tool itself acts on, which is what the thread's Land button may offer.
 *
 * ⛔ The list is derived from this predicate rather than written out beside the button, for the
 * reason above: a hand-written second copy of the ladder is how three dropdowns went on offering
 * `agent-lands` after it was renamed.
 */
describe('the levels where the tool does the last part', () => {
  it('names the three that move a branch, and none of the ones that leave it alone', () => {
    expect(FINISH_ORDER.filter(policyLands)).toEqual([
      'commit-and-merge',
      'commit-and-push',
      'pull-request'
    ])
  })

  it('never offers landing under a level that only commits', () => {
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
    // ⚠️ They overlap on the two merge levels and disagree at both ends, which is why there are two
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
      { workerId: 'w-a', model: 'opus', effort: 'high', lens: null },
      { workerId: 'w-b', model: null, effort: null, lens: null }
    ])
    expect(state?.rounds).toBe(3)
    expect(state?.exchange).toBe('digest')
    expect(state?.round).toBe(2)
    expect(state?.verdict).toBe('execute')
  })

  // ⚠️ A lens is an evidence base the prompt reads; dropped here it would be silently ignored.
  it('keeps a seat’s lens, trimmed, and reads a blank one as none', () => {
    const state = readDebateState({
      seats: [{ workerId: 'w-a', lens: '  the admission path ' }, { workerId: 'w-b', lens: '   ' }, { workerId: 'w-c', lens: 7 }]
    })
    expect(state?.seats.map((s) => s.lens)).toEqual(['the admission path', null, null])
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

/**
 * Which of the two plan shapes a task is — the one fact Plan & Execute rests on entirely.
 *
 * ⛔ **Derived, and it has to stay derived.** A `plan_mode` column would be a second copy of what
 * `mandate.maxChildren` already carries, and `mandate` is what `createTask` enforces — so the first
 * time somebody wrote one and not the other, the prompt would promise a review turn the mandate
 * refuses to allow. These pin the derivation rather than the storage, which is the point.
 */
describe('planModeOf', () => {
  const plan = (
    mandate?: number,
    child?: number
  ): Pick<Task, 'kind' | 'mandate' | 'childDefaults'> => ({
    kind: 'plan',
    mandate: { ...ROOT_MANDATE, ...(mandate === undefined ? {} : { maxChildren: mandate }) },
    childDefaults: child === undefined ? null : { maxChildren: child }
  })

  it('reads a cap of one as Plan & Execute and anything above it as Plan & Split', () => {
    expect(planModeOf(plan(PLAN_EXECUTE_CHILDREN, PLAN_EXECUTE_CHILDREN))).toBe('execute')
    expect(planModeOf(plan(5, 5))).toBe('split')
    expect(isPlanExecute(plan(1, 1))).toBe(true)
  })

  /**
   * ⚠️ **Every plan filed before this existed reads as `split`, and that is the compatibility
   * claim.** The composer's fan-out pill has never offered below `MIN_PIECES` (2), and a plan task
   * with no `childDefaults` at all falls back to `ROOT_MANDATE.maxChildren`.
   */
  it('reads every plan task that predates the feature as a split', () => {
    expect(planModeOf(plan())).toBe('split')
    expect(planModeOf(plan(8))).toBe('split')
    expect(planChildCap(plan())).toBe(ROOT_MANDATE.maxChildren)
  })

  /**
   * ⛔ **The mandate is the authority and `childDefaults` may only narrow it**, so the cap is the
   * minimum of the two — the same resolution `validateSplit` performs. Taking either one alone
   * would let a shape pass here and be refused halfway through filing.
   */
  it('takes the narrower of the mandate and the child defaults', () => {
    expect(planChildCap(plan(5, 1))).toBe(1)
    expect(planChildCap(plan(1, 5))).toBe(1)
    expect(planModeOf(plan(5, 1))).toBe('execute')
    expect(planModeOf(plan(1, 5))).toBe('execute')
  })

  /**
   * ⚠️ Nothing but a plan task has a plan mode, and the honest answer for everything else is the
   * one that changes no behaviour anywhere — a debate organizer files two or more seats, a `work`
   * task files nothing at all, and neither should start reading as a handoff because of its cap.
   */
  it('answers split for anything that is not a plan task', () => {
    expect(planModeOf({ ...plan(1, 1), kind: 'debate' })).toBe('split')
    expect(planModeOf({ ...plan(1, 1), kind: 'work' })).toBe('split')
    expect(planModeOf(null)).toBe('split')
  })
})
