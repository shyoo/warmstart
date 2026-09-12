import { describe, expect, it } from 'vitest'
import { DEFAULT_FLEET_FINISH, FINISH_ORDER, policyLands, type FinishPolicy } from '@shared/tasks'
import {
  COMMIT_FALLBACK,
  COMMIT_RUNGS,
  defaultRung,
  LAND_FALLBACK,
  LAND_RUNGS,
  rungOrigin
} from './finishrung'

/**
 * Which rung the thread's Commit and Land buttons start on.
 *
 * ⭐ **t283, reported against t281.** The Commit control was a picker with no value: its menu opened
 * on the first entry in `FINISH_ORDER` that it offered, which is `commit-only`. So on a project
 * configured for commit·verify·merge — the shipped default — the answer the card put in front of the
 * operator was the one rung that commits and then leaves the work sitting on the branch, and nothing
 * on screen said that was the button's own choice rather than the project's.
 *
 * ⛔ **The tier order is the point, and it is not `resolveFinishPolicy`'s.** That function answers
 * `await-human` for an open conversation above every other tier, which is right for *what happens
 * when this task finishes on its own* and useless for a button whose entire purpose is to overrule
 * it. Here the kind is stepped around and the remaining tiers are read in the usual order — task,
 * project, fleet — with a fallback for the case where the tier below asks for something the button
 * cannot do.
 */

const inherited = (policy: FinishPolicy, source = 'project'): { policy: FinishPolicy; source: string } => ({
  policy,
  source
})

describe('which rungs each button offers', () => {
  it('offers every rung under Commit except the three that are not commits', () => {
    // ⛔ Derived from the ladder rather than listed: three dropdowns each kept their own copy once,
    // and all three still offered a rung a week after it was renamed.
    expect(COMMIT_RUNGS).toEqual(
      FINISH_ORDER.filter((p) => p !== 'await-human' && p !== 'custom' && p !== 'report-only')
    )
    expect(COMMIT_RUNGS).not.toContain('await-human')
    expect(COMMIT_RUNGS).not.toContain('custom')
    // ⛔ The rung that says nothing was ever going to be committed is the one option under a button
    // called Commit that is guaranteed to do nothing.
    expect(COMMIT_RUNGS).not.toContain('report-only')
  })

  it('offers only rungs the tool itself acts on under Land', () => {
    expect(LAND_RUNGS.every(policyLands)).toBe(true)
    expect(LAND_RUNGS).not.toContain('commit-only')
    expect(LAND_RUNGS).not.toContain('commit-and-verify')
  })

  it('keeps each fallback inside its own list', () => {
    // ⚠️ A default the menu cannot show is a button whose ✓ is nowhere.
    expect(COMMIT_RUNGS).toContain(COMMIT_FALLBACK)
    expect(LAND_RUNGS).toContain(LAND_FALLBACK)
  })
})

describe('the rung a button starts on', () => {
  it('follows the project’s default rather than the bottom of the ladder', () => {
    // ⭐ The reported bug, in one line: this used to answer `commit-only` on every project.
    expect(defaultRung('inherit', 'commit-and-merge', COMMIT_RUNGS, COMMIT_FALLBACK)).toBe(
      'commit-and-merge'
    )
  })

  it('follows the fleet default when the project says nothing', () => {
    // ⚠️ The daemon has already collapsed project → fleet into one answer; what arrives here is a
    // policy with the tier it came from beside it.
    expect(defaultRung('inherit', DEFAULT_FLEET_FINISH, COMMIT_RUNGS, COMMIT_FALLBACK)).toBe(
      DEFAULT_FLEET_FINISH
    )
  })

  it('prefers a rung the task already carries over the project’s', () => {
    // ⛔ The last press of this button wrote that rung. A control that forgets its own last answer
    // is worse than one that never had a default.
    expect(defaultRung('commit-and-push', 'commit-and-merge', COMMIT_RUNGS, COMMIT_FALLBACK)).toBe(
      'commit-and-push'
    )
  })

  it('does not merge a trunk on behalf of a project that asked for a person', () => {
    // ⛔ `await-human` is not on the Commit menu, and the substitute must be the quietest rung —
    // falling back to the fleet default would take a project that deliberately asked for review and
    // merge its trunk on one press.
    expect(defaultRung('inherit', 'await-human', COMMIT_RUNGS, COMMIT_FALLBACK)).toBe('commit-only')
    expect(defaultRung('inherit', 'custom', COMMIT_RUNGS, COMMIT_FALLBACK)).toBe('commit-only')
  })

  it('falls back to a landing rung under Land, because a Land that does not land is nothing', () => {
    expect(defaultRung('inherit', 'commit-only', LAND_RUNGS, LAND_FALLBACK)).toBe(LAND_FALLBACK)
    expect(defaultRung('commit-and-verify', 'commit-only', LAND_RUNGS, LAND_FALLBACK)).toBe(
      LAND_FALLBACK
    )
  })

  it('keeps a landing rung the task carries', () => {
    expect(defaultRung('pull-request', 'commit-and-merge', LAND_RUNGS, LAND_FALLBACK)).toBe(
      'pull-request'
    )
  })

  it('answers something offerable when nothing above it said anything at all', () => {
    expect(defaultRung('inherit', null, COMMIT_RUNGS, COMMIT_FALLBACK)).toBe(COMMIT_FALLBACK)
    expect(defaultRung('inherit', undefined, LAND_RUNGS, LAND_FALLBACK)).toBe(LAND_FALLBACK)
  })
})

describe('where that rung came from, said out loud', () => {
  it('names the project when the project is what chose it', () => {
    expect(rungOrigin('inherit', inherited('commit-and-merge'), 'commit-and-merge')).toContain(
      'project'
    )
  })

  it('names the fleet when the project said nothing', () => {
    expect(rungOrigin('inherit', inherited('commit-and-merge', 'fleet'), 'commit-and-merge')).toBe(
      'the fleet default'
    )
  })

  it('names the task once a press has written a rung onto it', () => {
    expect(
      rungOrigin('commit-and-push', inherited('commit-and-merge'), 'commit-and-push')
    ).toContain('task')
  })

  it('says a substitute is a substitute', () => {
    // ⚠️ Silence here would present the fallback as though it were the project's own answer, which
    // is the shape of the bug this whole file exists for.
    expect(rungOrigin('inherit', inherited('await-human'), 'commit-only')).toContain('not one this button can do')
  })
})
