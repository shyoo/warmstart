import { describe, expect, it } from 'vitest'
import { ProjectCompletions } from './projectcompletion'
import { projectWorkState } from './taskview'
import type { Task } from '@shared/tasks'

function task(id: string, status: Task['status'], projectId: string | null = 'p1', deletedAt: number | null = null) {
  return { id, status, projectId, deletedAt }
}

describe('project completion notifications', () => {
  it('ignores history, notices completion, and does not relight on metadata refresh after a click', () => {
    const tracker = new ProjectCompletions()
    expect(tracker.observe([task('old', 'completed'), task('new', 'running')], true).size).toBe(0)
    expect(tracker.observe([task('new', 'completed')])).toEqual(new Set(['p1']))
    expect(tracker.acknowledge('p1').size).toBe(0)
    expect(tracker.observe([task('old', 'completed'), task('new', 'completed')]).size).toBe(0)
    tracker.observe([task('new', 'running')])
    expect(tracker.observe([task('new', 'completed')])).toEqual(new Set(['p1']))
  })

  it('keeps other projects unread and notices tasks added after the initial snapshot', () => {
    const tracker = new ProjectCompletions()
    tracker.observe([], true)
    expect(tracker.observe([task('a', 'completed'), task('b', 'completed', 'p2')])).toEqual(new Set(['p1', 'p2']))
    expect(tracker.acknowledge('p1')).toEqual(new Set(['p2']))
    expect(tracker.observe([task('c', 'failed'), task('d', 'cancelled'), task('e', 'completed', null)])).toEqual(new Set(['p2']))
  })

  it('removes deleted/reopened completions and follows a move to another project', () => {
    const tracker = new ProjectCompletions()
    tracker.observe([], true)
    tracker.observe([task('a', 'completed'), task('b', 'completed')])
    expect(tracker.observe([task('a', 'completed', 'p2')])).toEqual(new Set(['p1', 'p2']))
    expect(tracker.observe([task('b', 'completed', 'p1', 10)])).toEqual(new Set(['p2']))
    expect(tracker.observe([task('a', 'running', 'p2')]).size).toBe(0)
  })

  it('preserves a completion arriving during the initial read', () => {
    const tracker = new ProjectCompletions()
    tracker.observe([task('a', 'running')], true)
    tracker.observe([task('a', 'completed')], true)
    expect(tracker.observe([task('a', 'completed'), task('old', 'completed')], true)).toEqual(new Set(['p1']))
  })

  it('shows green only after agent and human work settles; acknowledgement restores the underlying dot', () => {
    expect(projectWorkState([], false, true)).toBe('completed')
    expect(projectWorkState([{ status: 'running' }], false, true)).toBe('working')
    expect(projectWorkState([{ status: 'awaiting_human' }], false, true)).toBe('needs_attention')
    expect(projectWorkState([{ status: 'completed', gradingWorkerId: 'peer' }], false, true)).toBe('completed')
    expect(projectWorkState([{ status: 'paused_user' }], true, true)).toBe('completed')
    expect(projectWorkState([{ status: 'completed' }], false, false)).toBe('idle')
    expect(projectWorkState([{ status: 'paused_user' }], false, false)).toBe('paused')
    expect(projectWorkState([], true, false)).toBe('pending_pr')
  })
})
