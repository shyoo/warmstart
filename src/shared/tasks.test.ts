import { describe, expect, it } from 'vitest'
import {
  FINISH_LABELS,
  FINISH_ORDER,
  FINISH_SHORT,
  SHARING_LABELS,
  SHARING_SHORT
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
