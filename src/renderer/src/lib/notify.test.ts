import { describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '@shared/tasks'
import { notifiableTransition, worthTracking } from './notify'

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    title: 'Make the diff readable',
    titleSummary: null,
    status: 'awaiting_human',
    ...over
  }) as Task

describe('deciding to interrupt somebody', () => {
  /**
   * ⛔ The failure this rule exists to prevent: attaching to a daemon that has been working while
   * the app was closed, and firing one notification per resting task. `before === undefined` is
   * *first sight*, not a transition.
   */
  it('says nothing the first time it sees a task, whatever state it is in', () => {
    expect(notifiableTransition(undefined, task({ status: 'awaiting_human' }))).toBeNull()
    expect(notifiableTransition(undefined, task({ status: 'failed' }))).toBeNull()
    expect(notifiableTransition(undefined, task({ status: 'completed' }))).toBeNull()
  })

  it('says nothing when the status did not change', () => {
    expect(notifiableTransition('awaiting_human', task({ status: 'awaiting_human' }))).toBeNull()
  })

  it('fires on the three transitions that end somebody’s ability to ignore the app', () => {
    expect(notifiableTransition('running', task({ status: 'awaiting_human' }))?.kind).toBe('wants-you')
    expect(notifiableTransition('running', task({ status: 'completed' }))?.kind).toBe('finished')
    expect(notifiableTransition('running', task({ status: 'failed' }))?.kind).toBe('failed')
  })

  it('stays quiet through the churn of ordinary scheduling', () => {
    const quiet: TaskStatus[] = ['ready', 'blocked', 'scheduled', 'assigned', 'running', 'paused_quota', 'cancelling', 'cancelled']
    for (const status of quiet) {
      expect(notifiableTransition('running', task({ status }))).toBeNull()
    }
  })

  it('prefers the one-line summary, and cuts a long one', () => {
    expect(notifiableTransition('running', task({ titleSummary: 'Short label' }))?.body).toBe('Short label')

    const long = notifiableTransition('running', task({ title: 'x'.repeat(400) }))
    expect(long?.body.length).toBeLessThanOrEqual(120)
    expect(long?.body.endsWith('…')).toBe(true)
  })

  it('flattens a multi-line title rather than putting newlines on the desktop', () => {
    const note = notifiableTransition('running', task({ title: 'first line\n\nsecond   line' }))
    expect(note?.body).toBe('first line second line')
  })

  it('carries the task to open when the notification is clicked', () => {
    expect(notifiableTransition('running', task({ id: 'abc' }))?.taskId).toBe('abc')
  })
})

describe('what is worth remembering between events', () => {
  it('drops the states that cannot transition into anything worth saying', () => {
    expect(worthTracking('draft')).toBe(false)
    expect(worthTracking('cancelled')).toBe(false)
    expect(worthTracking('running')).toBe(true)
    expect(worthTracking('awaiting_human')).toBe(true)
  })
})
