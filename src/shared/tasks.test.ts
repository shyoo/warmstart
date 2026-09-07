import { describe, expect, it } from 'vitest'
import {
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  SHARING_LABELS,
  SHARING_SHORT,
  policyLands,
  policyVerifies
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
