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
  it('offers a resting task answers, never a Stop button', () => {
    expect(decisionsFor(task(), NOW)).toEqual(['reassign', 'resolve'])
  })

  it('adds Resume to a user-paused task', () => {
    expect(decisionsFor(task({ status: 'paused_user' }), NOW)).toEqual(['resume', 'reassign', 'resolve'])
  })

  it('leads a quota-gated task with the override', () => {
    expect(decisionsFor(task({ status: 'paused_quota' }), NOW)[0]).toBe('override')
  })

  it('does not offer to mark a running task done', () => {
    expect(decisionsFor(task({ status: 'running' }), NOW)).toEqual(['reassign'])
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
    expect(decisionsFor(task({ status: 'landing_queued' }), NOW)).toEqual([])
  })

  it('offers a queued landing nothing at all, whatever its hold reason says (t614)', () => {
    // ⛔ This exact sentence used to classify as `uncommitted`, so a task queued behind the
    // operator's own dirty trunk drew *Resolve & retry* on the phone — a billed agent run sent to
    // commit changes on a branch that had none. A queued landing is the tick's to end or hand over.
    const trunkBlocked = task({
      status: 'landing_queued',
      holdReason:
        'the trunk is not ready to receive this: the trunk has 16 uncommitted file(s) in it ' +
        '(6 modified/tracked, 10 untracked): AGENTS.md, DESIGN.md, HANDOFF.md, HISTORY.md, ' +
        'research/trials.jsonl, +11 more. Commit, stash, or clear them in the trunk checkout ' +
        '(C:\\Dev\\autotrade) so the merge can run. It will land by itself once the trunk is free.'
    })
    expect(decisionsFor(trunkBlocked, NOW)).toEqual([])
  })

  it('offers Retry landing once that same hold has been handed to a person (t614)', () => {
    // ⭐ The hand-over `retryQueuedLandings` performs after the grace period. Its wording is the
    // daemon's; what matters here is that the one press that can land the branch is now drawn.
    const handed = task({
      status: 'awaiting_human',
      holdReason:
        'the trunk is not ready to receive this: the trunk has 16 uncommitted file(s) in it ' +
        '(6 modified/tracked, 10 untracked): AGENTS.md, +15 more. Commit, stash, or clear them in ' +
        'the trunk checkout (C:\\Dev\\autotrade) so the merge can run. Nothing in the fleet can ' +
        'clear this — the branch is intact, so press Retry landing once the trunk checkout is sorted.'
    })
    const out = decisionsFor(handed, NOW)
    expect(out).toContain('reland')
    expect(out).not.toContain('retry')
  })

  it('offers Commit to a conversation holding uncommitted work, and nothing else', () => {
    const dirty = { supported: true, reason: '', branch: 'warmstart/t7-sweep', unclaimed: false, dirtyFiles: 1, untrackedFiles: 0, unlandedCommits: 0, hasDiff: true }
    expect(decisionsFor(task({ kind: 'conversation' }), NOW, dirty)).toContain('commit')
    expect(decisionsFor(task({ kind: 'conversation' }), NOW, null)).not.toContain('commit')
    const clean = { ...dirty, dirtyFiles: 0, hasDiff: false }
    expect(decisionsFor(task({ kind: 'conversation' }), NOW, clean)).not.toContain('commit')
    expect(decisionsFor(task({ kind: 'work' }), NOW, dirty)).not.toContain('commit')
    expect(decisionsFor(task({ kind: 'conversation', status: 'completed' }), NOW, dirty)).not.toContain('commit')
  })
})
