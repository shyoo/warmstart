import { describe, expect, it } from 'vitest'
import { DEFAULT_FLEET_FINISH, FINISH_ORDER, policyLands, type FinishPolicy } from '@shared/tasks'
import {
  COMMIT_FALLBACK,
  COMMIT_LEVELS,
  commitLevelsForMode,
  defaultLevel,
  effectiveWorkspaceMode,
  LAND_FALLBACK,
  LAND_LEVELS,
  landLevelsForMode,
  levelOrigin,
  settleControls,
  TRUNK_LAND_FALLBACK
} from './finishlevel'

/**
 * Which level the thread's Commit and Land buttons start on.
 *
 * ⭐ **t283, reported against t281.** The Commit control was a picker with no value: its menu opened
 * on the first entry in `FINISH_ORDER` that it offered, which is `commit-only`. So on a project
 * configured for commit·verify·merge — the shipped default — the answer the card put in front of the
 * operator was the one level that commits and then leaves the work sitting on the branch, and nothing
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

describe('which levels each button offers', () => {
  it('offers every level under Commit except the three that are not commits', () => {
    // ⛔ Derived from the ladder rather than listed: three dropdowns each kept their own copy once,
    // and all three still offered a level a week after it was renamed.
    expect(COMMIT_LEVELS).toEqual(
      FINISH_ORDER.filter((p) => p !== 'await-human' && p !== 'custom' && p !== 'report-only')
    )
    expect(COMMIT_LEVELS).not.toContain('await-human')
    expect(COMMIT_LEVELS).not.toContain('custom')
    // ⛔ The level that says nothing was ever going to be committed is the one option under a button
    // called Commit that is guaranteed to do nothing.
    expect(COMMIT_LEVELS).not.toContain('report-only')
  })

  it('offers only levels the tool itself acts on under Land', () => {
    expect(LAND_LEVELS.every(policyLands)).toBe(true)
    expect(LAND_LEVELS).not.toContain('commit-only')
    expect(LAND_LEVELS).not.toContain('commit-and-verify')
  })

  it('keeps each fallback inside its own list', () => {
    // ⚠️ A default the menu cannot show is a button whose ✓ is nowhere.
    expect(COMMIT_LEVELS).toContain(COMMIT_FALLBACK)
    expect(LAND_LEVELS).toContain(LAND_FALLBACK)
  })
})

describe('the level a button starts on', () => {
  it('follows the project’s default rather than the bottom of the ladder', () => {
    // ⭐ The reported bug, in one line: this used to answer `commit-only` on every project.
    expect(defaultLevel('inherit', 'commit-and-merge', COMMIT_LEVELS, COMMIT_FALLBACK)).toBe(
      'commit-and-merge'
    )
  })

  it('follows the fleet default when the project says nothing', () => {
    // ⚠️ The daemon has already collapsed project → fleet into one answer; what arrives here is a
    // policy with the tier it came from beside it.
    expect(defaultLevel('inherit', DEFAULT_FLEET_FINISH, COMMIT_LEVELS, COMMIT_FALLBACK)).toBe(
      DEFAULT_FLEET_FINISH
    )
  })

  it('prefers a level the task already carries over the project’s', () => {
    // ⛔ The last press of this button wrote that level. A control that forgets its own last answer
    // is worse than one that never had a default.
    expect(defaultLevel('commit-and-push', 'commit-and-merge', COMMIT_LEVELS, COMMIT_FALLBACK)).toBe(
      'commit-and-push'
    )
  })

  it('does not merge a trunk on behalf of a project that asked for a person', () => {
    // ⛔ `await-human` is not on the Commit menu, and the substitute must be the quietest level —
    // falling back to the fleet default would take a project that deliberately asked for review and
    // merge its trunk on one press.
    expect(defaultLevel('inherit', 'await-human', COMMIT_LEVELS, COMMIT_FALLBACK)).toBe('commit-only')
    expect(defaultLevel('inherit', 'custom', COMMIT_LEVELS, COMMIT_FALLBACK)).toBe('commit-only')
  })

  it('falls back to a landing level under Land, because a Land that does not land is nothing', () => {
    expect(defaultLevel('inherit', 'commit-only', LAND_LEVELS, LAND_FALLBACK)).toBe(LAND_FALLBACK)
    expect(defaultLevel('commit-and-verify', 'commit-only', LAND_LEVELS, LAND_FALLBACK)).toBe(
      LAND_FALLBACK
    )
  })

  it('keeps a landing level the task carries', () => {
    expect(defaultLevel('pull-request', 'commit-and-merge', LAND_LEVELS, LAND_FALLBACK)).toBe(
      'pull-request'
    )
  })

  it('answers something offerable when nothing above it said anything at all', () => {
    expect(defaultLevel('inherit', null, COMMIT_LEVELS, COMMIT_FALLBACK)).toBe(COMMIT_FALLBACK)
    expect(defaultLevel('inherit', undefined, LAND_LEVELS, LAND_FALLBACK)).toBe(LAND_FALLBACK)
  })
})

describe('which levels a trunk task is offered', () => {
  it('leaves the worktree menus exactly as they were', () => {
    expect(commitLevelsForMode('worktree')).toEqual(COMMIT_LEVELS)
    expect(landLevelsForMode('worktree')).toEqual(LAND_LEVELS)
  })

  it('drops the merge level the trunk cannot perform and the PR level it cannot open', () => {
    // ⛔ The t583 shape: the work is already on the landing target, so Commit·Verify·Merge
    // promises a merge that cannot happen and pull-request needs a branch the task does not have.
    expect(commitLevelsForMode('trunk')).toEqual(['commit-only', 'commit-and-verify', 'commit-and-push'])
    expect(landLevelsForMode('trunk')).toEqual(['commit-and-push'])
  })

  it('falls back to a level the trunk menu actually offers', () => {
    // ⛔ The fleet default merges, which no trunk menu lists — a fallback that is not on its own
    // menu is a button whose ✓ is nowhere.
    expect(TRUNK_LAND_FALLBACK).toBe('commit-and-push')
    expect(landLevelsForMode('trunk')).toContain(TRUNK_LAND_FALLBACK)
    expect(commitLevelsForMode('trunk')).toContain(COMMIT_FALLBACK)
  })

  it('answers to the task pin first and the project behind it', () => {
    expect(effectiveWorkspaceMode('trunk', 'worktree')).toBe('trunk')
    expect(effectiveWorkspaceMode('worktree', 'trunk')).toBe('worktree')
    expect(effectiveWorkspaceMode('inherit', 'trunk')).toBe('trunk')
    expect(effectiveWorkspaceMode('inherit', 'worktree')).toBe('worktree')
  })

  it('reads unknown as the worktree every menu was written for', () => {
    expect(effectiveWorkspaceMode('inherit', undefined)).toBe('worktree')
    expect(effectiveWorkspaceMode(undefined, undefined)).toBe('worktree')
  })
})

describe('where that level came from, said out loud', () => {
  it('names the project when the project is what chose it', () => {
    expect(levelOrigin('inherit', inherited('commit-and-merge'), 'commit-and-merge')).toContain(
      'project'
    )
  })

  it('names the fleet when the project said nothing', () => {
    expect(levelOrigin('inherit', inherited('commit-and-merge', 'fleet'), 'commit-and-merge')).toBe(
      'the fleet default'
    )
  })

  it('names the task once a press has written a level onto it', () => {
    expect(
      levelOrigin('commit-and-push', inherited('commit-and-merge'), 'commit-and-push')
    ).toContain('task')
  })

  it('says a substitute is a substitute', () => {
    // ⚠️ Silence here would present the fallback as though it were the project's own answer, which
    // is the shape of the bug this whole file exists for.
    expect(levelOrigin('inherit', inherited('await-human'), 'commit-only')).toContain('not one this button can do')
  })
})

/**
 * Which buttons the *your call* card draws — and the one it used to leave out.
 *
 * ⛔ **t581, from t578 on 2026-09-20.** A `muse-code` conversation was pressed **Commit** on the
 * level *commit, verify and merge into main*. Its agent committed, squashed, ran both project checks
 * and replied *"the commit is ready to land"* — and the card went on showing **Commit** as its only
 * control, because two untracked backup directories the operator had asked for kept `hasDiff` true
 * and `land` was gated on `!hasDiff`. The operator pressed Commit again; the identical instruction
 * went into the same session twelve seconds later. `pendingWork` for that workspace read
 * `dirtyFiles: 0, untrackedFiles: 2, unlandedCommits: 1`.
 */
describe('which settle-it controls the card draws', () => {
  const read = (over: Partial<{ supported: boolean; hasDiff: boolean; unlandedCommits: number }> = {}) => ({
    supported: true,
    hasDiff: false,
    unlandedCommits: 0,
    ...over
  })

  it('⭐ draws Land over commits even with something uncommitted beside them', () => {
    // ⛔ t578's exact reading. Before this, `land` was false here and the thread had no way out.
    const controls = settleControls(true, read({ hasDiff: true, unlandedCommits: 1 }))
    expect(controls.land).toBe(true)
    // ⚠️ And Commit stays: there *is* something uncommitted, and both statements are true at once.
    expect(controls.commit).toBe(true)
    expect(controls.uncommitted).toBe(true)
  })

  it('draws Land alone once the tree is clean', () => {
    expect(settleControls(true, read({ unlandedCommits: 3 }))).toEqual({
      commit: false,
      land: true,
      cannotLook: false,
      uncommitted: false
    })
  })

  it('draws Commit alone when there is something to commit and nothing to land', () => {
    expect(settleControls(true, read({ hasDiff: true }))).toEqual({
      commit: true,
      land: false,
      cannotLook: false,
      uncommitted: true
    })
  })

  it('draws neither over a branch with nothing on it and nothing in the tree', () => {
    expect(settleControls(true, read())).toEqual({
      commit: false,
      land: false,
      cannotLook: false,
      uncommitted: false
    })
  })

  it('⛔ shows Commit with the reason when the tree could not be read at all', () => {
    // ⛔ t280: *I could not look* is not *there is nothing there*, and hiding every control on that
    // answer left a thread telling an operator to press a button the card had decided not to draw.
    const controls = settleControls(true, read({ supported: false, unlandedCommits: 4 }))
    expect(controls.cannotLook).toBe(true)
    expect(controls.commit).toBe(true)
    // ⚠️ And Land is not drawn off an unreadable tree: `unlandedCommits` is a neutral zero there,
    // never a measurement, so a button promising to move four commits would be promising a number
    // nobody took.
    expect(controls.land).toBe(false)
  })

  it('⛔ draws nothing at all before the read comes back', () => {
    expect(settleControls(true, null)).toEqual({
      commit: false,
      land: false,
      cannotLook: false,
      uncommitted: false
    })
  })

  it('⛔ offers an ordinary task Land but never Commit', () => {
    // ⚠️ A work task's uncommitted files are the finish path's business — it asks that task's own
    // agent. Committed work with nowhere to go is the same state on either kind, so Land is shared.
    const controls = settleControls(false, read({ hasDiff: true, unlandedCommits: 2 }))
    expect(controls.commit).toBe(false)
    expect(controls.uncommitted).toBe(false)
    expect(controls.land).toBe(true)
  })
})
