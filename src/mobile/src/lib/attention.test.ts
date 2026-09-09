import { describe, expect, it } from 'vitest'
import type { Approval, Question, Task } from '@shared/tasks'
import { actionsFor, answerableInline, buildAttentionItems, itemSummary } from './attention.js'

const NOW = 1_700_000_000_000

function task(over: Partial<Task>): Task {
  return {
    id: 't1', seq: 7, title: 'sweep the porch', titleSummary: null, status: 'ready',
    updatedAt: NOW - 1000, holdReason: null, quotaPreemptWarning: null, quotaOverrideUntil: null,
    deletedAt: null, projectId: 'p1',
    ...over
  } as Task
}

function approval(over: Partial<Approval> = {}): Approval {
  return { id: 'a1', askedAt: NOW - 3000, summary: 'run npm test?', ...over } as Approval
}

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1', askedAt: NOW - 2000, kind: 'choice', question: 'which broom?',
    header: null, taskId: 't1',
    options: [{ id: 'o1', label: 'straw' }, { id: 'o2', label: 'push' }],
    ...over
  } as Question
}

describe('buildAttentionItems', () => {
  it('merges all four sources newest-first', () => {
    const items = buildAttentionItems(
      [approval()],
      [question()],
      [
        task({ id: 'g1', seq: 1, status: 'paused_quota', updatedAt: NOW - 500 }),
        task({ id: 'h1', seq: 2, status: 'awaiting_human', updatedAt: NOW - 100 })
      ],
      NOW
    )
    expect(items.map((i) => i.kind)).toEqual(['human', 'quota', 'question', 'approval'])
  })

  it('leaves out released gates, settled tasks and deleted rows', () => {
    const items = buildAttentionItems(
      [],
      [],
      [
        task({ id: 'r1', status: 'paused_quota', quotaOverrideUntil: NOW + 60000 }),
        task({ id: 'r2', status: 'completed' }),
        task({ id: 'r3', status: 'awaiting_human', deletedAt: NOW }),
        task({ id: 'r4', status: 'ready', holdReason: 'nothing to do with quota' })
      ],
      NOW
    )
    expect(items).toEqual([])
  })

  it('never lists one task twice: a gated task is not also awaiting', () => {
    const items = buildAttentionItems([], [], [task({ id: 'g1', status: 'paused_quota' })], NOW)
    expect(items.map((i) => i.kind)).toEqual(['quota'])
  })
})

describe('answerableInline', () => {
  it('takes a short choice set and refuses the rest', () => {
    expect(answerableInline(question())).toBe(true)
    expect(answerableInline(question({ kind: 'text', options: [] }))).toBe(false)
    expect(answerableInline(question({ kind: 'multi' }))).toBe(false)
    expect(answerableInline(question({ options: [{ id: 'o1', label: 'x'.repeat(31) }] }))).toBe(false)
    expect(
      answerableInline(question({ options: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }, { id: 'd', label: 'd' }] }))
    ).toBe(false)
  })
})

describe('actionsFor', () => {
  it('answers approvals from the closed set and nothing else', () => {
    const acts = actionsFor({ kind: 'approval', at: 0, approval: approval() })
    expect(acts.map((a) => a.label)).toEqual(['Allow', 'Always', 'Deny'])
  })

  it('puts inline buttons on an answerable question, a door on any other', () => {
    const inline = actionsFor({ kind: 'question', at: 0, question: question() })
    expect(inline).toEqual([
      { type: 'answer', optionIds: ['o1'], label: 'straw' },
      { type: 'answer', optionIds: ['o2'], label: 'push' }
    ])
    const door = actionsFor({ kind: 'question', at: 0, question: question({ kind: 'text', options: [], taskId: null }) })
    expect(door).toEqual([{ type: 'open-task', taskId: null, label: 'Answer…' }])
  })

  it('offers the quota actions and the two human ones', () => {
    expect(actionsFor({ kind: 'quota', at: 0, task: task({}) }).map((a) => a.type)).toEqual([
      'override', 'stop', 'resume', 'open-task'
    ])
    expect(actionsFor({ kind: 'human', at: 0, task: task({}) }).map((a) => a.type)).toEqual([
      'resolve', 'open-task'
    ])
  })
})

describe('itemSummary', () => {
  it('names the task on gated and resting rows', () => {
    expect(itemSummary({ kind: 'quota', at: 0, task: task({}) })).toBe('t7: sweep the porch')
    expect(itemSummary({ kind: 'approval', at: 0, approval: approval() })).toBe('run npm test?')
  })
})
