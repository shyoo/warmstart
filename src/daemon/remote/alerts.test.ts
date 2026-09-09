import { describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'
import { AlertGate, alertFor } from './alerts.js'

const task = (over: Partial<Task>): Task =>
  ({
    id: 'T1',
    seq: 41,
    title: 'Rename the thing',
    titleSummary: null,
    status: 'running',
    deletedAt: null,
    quotaOverrideUntil: null,
    quotaPreemptWarning: null,
    ...over
  }) as Task

const changed = (over: Partial<Task>): DaemonEvent => ({ type: 'task.changed', task: task(over) })

describe('alerts', () => {
  it('wakes someone only for the four things a person has to answer', () => {
    expect(alertFor(changed({ status: 'awaiting_human' }))?.title).toBe('Waiting on you')
    expect(alertFor(changed({ status: 'paused_quota' }))?.title).toBe('Held by the quota gate')
    expect(alertFor(changed({ status: 'running', quotaPreemptWarning: { preemptAt: 1 } as never }))?.title).toBe('About to be preempted')
    expect(
      alertFor({ type: 'question.opened', question: { id: 'q1', taskId: 'T1', header: 'Scope', question: 'Which one?' } } as DaemonEvent)?.title
    ).toBe('A question needs you')
    expect(alertFor({ type: 'approval.opened', approval: { id: 'a1', taskId: 'T1', summary: 'git push' } } as DaemonEvent)?.title).toBe(
      'Approval needed'
    )
  })

  it('stays quiet about progress, deleted work and gates a person has already answered', () => {
    expect(alertFor(changed({ status: 'running' }))).toBeNull()
    expect(alertFor(changed({ status: 'completed' }))).toBeNull()
    expect(alertFor(changed({ status: 'awaiting_human', deletedAt: 1 }))).toBeNull()
    // ⛔ An override in force is a person having already said "keep going".
    expect(alertFor(changed({ status: 'paused_quota', quotaOverrideUntil: Date.now() + 60_000 }))).toBeNull()
    expect(alertFor({ type: 'log', line: 'anything' } as unknown as DaemonEvent)).toBeNull()
  })

  it('names the task to open, and keeps the body to one line', () => {
    const alert = alertFor(changed({ status: 'awaiting_human', title: 'x'.repeat(300) }))
    expect(alert?.taskId).toBe('T1')
    // 't41: ' plus a title clipped to 60, ellipsis included.
    expect(alert?.body.length).toBeLessThanOrEqual(65)
    expect(alert?.body.endsWith('…')).toBe(true)
    expect(alert?.body.startsWith('t41: ')).toBe(true)
  })

  it('says the same thing once per window, then lets it through again', () => {
    const gate = new AlertGate(1000)
    expect(gate.admit('quota:T1', 0)).toBe(true)
    expect(gate.admit('quota:T1', 500)).toBe(false)
    expect(gate.admit('quota:T1', 1000)).toBe(true)
    // A different task is a different alert, however close together they arrive.
    expect(gate.admit('quota:T2', 1000)).toBe(true)
  })
})
