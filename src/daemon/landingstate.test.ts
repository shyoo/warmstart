import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'
import { emit, setEventSink } from './events.js'
import { beginLanding, endLanding, isTaskLanding } from './landingstate.js'

/**
 * ⛔ t353: Flow said a task was landing while the Tasks table and the thread said `running`. Only
 * the two emits inside `landTask` set the flag, so any other `task.changed` during the landing — a
 * status write, a message — went out without it and put the old word back. The flag is now set in
 * the one sink every emit goes through, which is what these pin.
 */
describe('a task that is landing says so in every event', () => {
  const heard: DaemonEvent[] = []
  const task = (id: string): Task => ({ id, status: 'running' }) as Task
  const landing = () =>
    heard.map((e) => (e.type === 'task.changed' ? [e.task.id, e.task.landing] : null))

  afterEach(() => {
    setEventSink(() => {})
    endLanding('t-land')
    heard.length = 0
  })

  it('sets the flag on an emit that did not carry it, and only for that task', () => {
    setEventSink((e) => heard.push(e))
    emit({ type: 'task.changed', task: task('t-land') })
    beginLanding('t-land')
    emit({ type: 'task.changed', task: task('t-land') })
    emit({ type: 'task.changed', task: task('t-other') })
    endLanding('t-land')
    emit({ type: 'task.changed', task: task('t-land') })

    expect(landing()).toEqual([
      ['t-land', false],
      ['t-land', true],
      ['t-other', false],
      ['t-land', false]
    ])
    expect(isTaskLanding('t-land')).toBe(false)
  })

  it('clears a stale flag a caller copied from an earlier read', () => {
    setEventSink((e) => heard.push(e))
    emit({ type: 'task.changed', task: { ...task('t-land'), landing: true } })
    expect(landing()).toEqual([['t-land', false]])
  })

  it('leaves every other event as it was sent', () => {
    setEventSink((e) => heard.push(e))
    const event = { type: 'task.activity', taskId: 't-land', text: 'x' } as DaemonEvent
    emit(event)
    expect(heard[0]).toBe(event)
  })
})
