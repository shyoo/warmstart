import { describe, expect, it } from 'vitest'
import { canJudge, canWork, roleOf } from './protocol.js'
import type { WorkerRole } from './protocol.js'

/**
 * The role algebra behind the two checkboxes in Settings → Workers.
 *
 * ⛔ **The defect this file was written from (t223).** Each checkbox computed its own next role by
 * comparing the current *name*: Judgment unticked was `role === 'both' ? 'worker' : 'controller'`.
 * For a judgment-only account that is `controller → controller`. `worker.update` accepted it, wrote
 * the value it already held, and the panel re-rendered the box ticked — an operator unticking
 * Judgment on a local model saw nothing happen and no error saying why. The role could not express
 * "neither", so the arithmetic quietly clamped instead of saying so.
 */

const ROLES: WorkerRole[] = ['worker', 'controller', 'both', 'none']

describe('what a role permits', () => {
  it('lets `both` do either thing', () => {
    expect(canWork('both')).toBe(true)
    expect(canJudge('both')).toBe(true)
  })

  it('holds `none` out of both, which is the point of it', () => {
    expect(canWork('none')).toBe(false)
    expect(canJudge('none')).toBe(false)
  })

  it('keeps the single-purpose roles single-purpose', () => {
    expect(canWork('worker')).toBe(true)
    expect(canJudge('worker')).toBe(false)
    expect(canWork('controller')).toBe(false)
    expect(canJudge('controller')).toBe(true)
  })
})

describe('the role a pair of checkboxes spells', () => {
  it('names every combination, including neither', () => {
    expect(roleOf(true, true)).toBe('both')
    expect(roleOf(true, false)).toBe('worker')
    expect(roleOf(false, true)).toBe('controller')
    expect(roleOf(false, false)).toBe('none')
  })

  it('round-trips every role through the boxes that display it', () => {
    for (const role of ROLES) {
      expect(roleOf(canWork(role), canJudge(role))).toBe(role)
    }
  })

  it('⛔ moves the role when the only ticked box is unticked — the t223 bug', () => {
    // Judgment off, on an account that only judges. The old code returned 'controller' here.
    expect(roleOf(canWork('controller'), false)).toBe('none')
    // The mirror image: Work off, on an account that only works.
    expect(roleOf(false, canJudge('worker'))).toBe('none')
  })

  it('never returns the role it started on when a box actually changed', () => {
    for (const role of ROLES) {
      const work = canWork(role)
      const judge = canJudge(role)
      expect(roleOf(!work, judge)).not.toBe(role)
      expect(roleOf(work, !judge)).not.toBe(role)
    }
  })
})
