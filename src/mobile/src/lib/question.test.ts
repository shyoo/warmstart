import { describe, expect, it } from 'vitest'
import type { Question, Task } from '@shared/tasks'
import { answerIsEmpty, decisionsFor, openQuestions, startsMulti } from './question.js'

const NOW = 1_700_000_000_000

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1', askedAt: NOW - 2000, kind: 'choice', question: 'which broom?', header: null,
    taskId: 't1', answeredAt: null, parkedAt: null,
    options: [{ id: 'o1', label: 'straw' }, { id: 'o2', label: 'push' }],
    ...over
  } as Question
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', seq: 7, title: 'sweep the porch', titleSummary: null, status: 'awaiting_human',
    updatedAt: NOW - 1000, holdReason: null, holdUntil: null, quotaPreemptWarning: null,
    quotaOverrideUntil: null, deletedAt: null, projectId: 'p1', branch: 'warmstart/t7-sweep',
    constraints: {},
    ...over
  } as Task
}

describe('openQuestions', () => {
  it('keeps only the unanswered ones, parked included', () => {
    const rows = [question(), question({ id: 'q2', answeredAt: NOW }), question({ id: 'q3', parkedAt: NOW })]
    expect(openQuestions(rows).map((q) => q.id)).toEqual(['q1', 'q3'])
  })
})

describe('startsMulti', () => {
  it('trusts the declared kind first', () => {
    expect(startsMulti(question({ kind: 'multi' }))).toBe(true)
    expect(startsMulti(question())).toBe(false)
  })

  it('recovers a multi-select the asker only said in prose', () => {
    expect(startsMulti(question({ question: 'Which of these apply? Select all that apply.' }))).toBe(true)
  })
})

describe('answerIsEmpty', () => {
  it('refuses nothing chosen and nothing typed, and nothing else', () => {
    expect(answerIsEmpty([], '')).toBe(true)
    expect(answerIsEmpty([], '   ')).toBe(true)
    expect(answerIsEmpty(['o1'], '')).toBe(false)
    expect(answerIsEmpty([], 'none of these')).toBe(false)
  })
})

describe('decisionsFor', () => {
  it('offers a resting task the whole set, Mark done and Stop included', () => {
    expect(decisionsFor(task(), NOW)).toEqual(['reassign', 'resolve', 'stop'])
  })

  it('adds Resume to a user-paused task and never offers to stop it again', () => {
    expect(decisionsFor(task({ status: 'paused_user' }), NOW)).toEqual(['resume', 'reassign', 'resolve'])
  })

  it('leads a quota-gated task with the override', () => {
    expect(decisionsFor(task({ status: 'paused_quota' }), NOW)[0]).toBe('override')
  })

  it('does not offer to mark a running task done', () => {
    expect(decisionsFor(task({ status: 'running' }), NOW)).toEqual(['reassign', 'stop'])
  })

  it('offers the retry a landing failure asks for', () => {
    const conflicted = task({ holdReason: 'landing failed: the branch conflicts with main' })
    expect(decisionsFor(conflicted, NOW)).toContain('retry')
  })

  it('says nothing about a settled or deleted task', () => {
    expect(decisionsFor(task({ status: 'completed' }), NOW)).toEqual([])
    expect(decisionsFor(task({ status: 'cancelled' }), NOW)).toEqual([])
    expect(decisionsFor(task({ deletedAt: NOW }), NOW)).toEqual([])
  })

  it('leaves a queued landing to the tick that ends it', () => {
    expect(decisionsFor(task({ status: 'landing_queued' }), NOW)).toEqual(['stop'])
  })
})
