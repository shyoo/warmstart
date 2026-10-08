import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_WAKE_GRACE_MS,
  backgroundEmptiedAt,
  backgroundTasksOf,
  describeBackground,
  forgetBackground,
  heldRunOf,
  holdReleaseDue,
  holdRunOnBackground,
  noteBackgroundTasks,
  shouldHoldOnBackground
} from './backgroundtasks.js'

const clear = {
  backgroundOpen: 2,
  status: 'running',
  pendingPieces: 0,
  quotaPreempted: false,
  landOwed: false,
  finishAsked: false
}

describe('shouldHoldOnBackground', () => {
  it('holds a running turn with jobs open', () => {
    expect(shouldHoldOnBackground(clear)).toBe(true)
  })
  it('does not hold with no jobs', () => {
    expect(shouldHoldOnBackground({ ...clear, backgroundOpen: 0 })).toBe(false)
  })
  it.each([
    ['pieces to wait on', { pendingPieces: 1 }],
    ['a quota wrap-up', { quotaPreempted: true }],
    ['a landing owed', { landOwed: true }],
    ['a finish asked', { finishAsked: true }],
    ['a task already resting', { status: 'awaiting_human' }]
  ])('yields to %s', (_name, patch) => {
    expect(shouldHoldOnBackground({ ...clear, ...patch })).toBe(false)
  })
})

describe('the list a session reports', () => {
  it('replaces rather than adds, and remembers when it emptied', () => {
    noteBackgroundTasks('s1', [{ id: 'a', description: null }, { id: 'b', description: null }], 100)
    expect(backgroundTasksOf('s1')).toHaveLength(2)
    expect(backgroundEmptiedAt('s1')).toBeNull()
    expect(noteBackgroundTasks('s1', [{ id: 'b', description: null }], 200)).toBe(true)
    expect(backgroundTasksOf('s1')).toHaveLength(1)
    expect(noteBackgroundTasks('s1', [], 300)).toBe(true)
    expect(backgroundEmptiedAt('s1')).toBe(300)
    // An empty list on a session that never had jobs is nothing, not an emptying.
    expect(noteBackgroundTasks('s2', [], 400)).toBe(false)
    expect(backgroundEmptiedAt('s2')).toBeNull()
  })
  it('is forgotten with the session', () => {
    noteBackgroundTasks('s3', [{ id: 'a', description: null }])
    holdRunOnBackground('s3', 'r1')
    forgetBackground('s3')
    expect(backgroundTasksOf('s3')).toEqual([])
    expect(heldRunOf('s3')).toBeNull()
  })
})

describe('holdReleaseDue', () => {
  const base = { backgroundOpen: 0, emptiedAt: 1_000, lastEvidenceAt: null, now: 1_000 + BACKGROUND_WAKE_GRACE_MS }
  it('is due once the grace has passed with nothing running and nothing said', () => {
    expect(holdReleaseDue(base)).toBe(true)
  })
  it('is not due inside the grace', () => {
    expect(holdReleaseDue({ ...base, now: base.now - 1 })).toBe(false)
  })
  it('is never due while a job is running — the stall watchdog bounds that wait', () => {
    expect(holdReleaseDue({ ...base, backgroundOpen: 1, now: base.now * 100 })).toBe(false)
  })
  it('is not due for a list that never emptied', () => {
    expect(holdReleaseDue({ ...base, emptiedAt: null })).toBe(false)
  })
  it('counts from the newest word when the session has started talking again', () => {
    expect(holdReleaseDue({ ...base, lastEvidenceAt: base.now - 1000 })).toBe(false)
  })
})

describe('describeBackground', () => {
  it('names the jobs, bounded', () => {
    expect(describeBackground([{ id: 'a', description: 'Run A' }])).toBe('1 background job (“Run A”)')
    expect(describeBackground([{ id: 'a', description: null }, { id: 'b', description: null }])).toBe(
      '2 background jobs'
    )
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, description: `job ${id}` }))
    expect(describeBackground(many)).toContain('and 2 more')
  })
})
