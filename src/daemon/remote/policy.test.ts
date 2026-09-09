import { describe, expect, it } from 'vitest'
import { REMOTE_EVENT_CLASS, REMOTE_FILTERED, REMOTE_METHODS, eventSocketToken, remoteEventTaskId, remoteScopeOf } from './policy.js'

describe('remote policy', () => {
  it('keeps dangerous desktop capabilities denied and human task actions writable', () => {
    expect(REMOTE_METHODS['session.write']).toBe('deny')
    expect(REMOTE_METHODS['daemon.shutdown']).toBe('deny')
    expect(REMOTE_METHODS['task.delete']).toBe('deny')
    expect(REMOTE_METHODS['worker.create']).toBe('deny')
    expect(REMOTE_METHODS['settings.set']).toBe('deny')
    for (const m of ['question.answer', 'task.overrideQuota', 'task.cancel', 'task.setWorker', 'task.create'] as const) expect(REMOTE_METHODS[m]).toBe('write')
  })
  it('reads the event-socket token from the header first, then the query', () => {
    expect(eventSocketToken('Bearer abc', '/remote/events?token=xyz')).toBe('abc')
    expect(eventSocketToken(undefined, '/remote/events?token=xyz')).toBe('xyz')
    expect(eventSocketToken(undefined, '/remote/events')).toBeNull()
    expect(eventSocketToken(undefined, '/remote/events?token=')).toBeNull()
    expect(eventSocketToken(undefined, undefined)).toBeNull()
    expect(eventSocketToken('Basic abc', '/remote/events?token=xyz')).toBe('xyz')
  })
  it('refuses what it cannot scope to one project', () => {
    // A session id names no project, and a page is sliced before the project filter can run.
    expect(REMOTE_METHODS['session.backscroll']).toBe('deny')
    expect(REMOTE_METHODS['task.page']).toBe('deny')
  })

  it('names the project of every method it allows, by the parameter that actually carries it', () => {
    expect(remoteScopeOf('task.get')).toEqual({ by: 'task', param: 'id' })
    // ⛔ `taskId`, not `id` — reading `id` here 404'd every call (t310).
    expect(remoteScopeOf('question.forTask')).toEqual({ by: 'task', param: 'taskId' })
    // ⛔ Optional, so the phone may ask for everything it is allowed and get it filtered.
    expect(remoteScopeOf('task.list')).toEqual({ by: 'project', param: 'projectId', required: false })
    expect(remoteScopeOf('task.create')).toEqual({ by: 'project', param: 'projectId', required: true })
    // Answering reaches the project through the question or approval, never past it.
    expect(remoteScopeOf('question.answer')).toEqual({ by: 'question', param: 'id' })
    expect(remoteScopeOf('approval.answer')).toEqual({ by: 'approval', param: 'id' })
    expect(remoteScopeOf('fleet.list')).toEqual({ by: 'fleet' })
    // The two fleet-wide lists that must still be cut down on the way out.
    expect(Object.keys(REMOTE_FILTERED).sort()).toEqual(['approval.list', 'question.list'])
  })

  it('extracts task event ids', () => {
    expect(remoteEventTaskId({ type: 'run.changed', run: { taskId: 't' } as never })).toBe('t')
    expect(remoteEventTaskId({ type: 'quota.changed', quota: {} as never })).toBeNull()
    expect(REMOTE_EVENT_CLASS['session.data']).toBe('never')
  })
})
