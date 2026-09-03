import { describe, expect, it } from 'vitest'
import type { Task, TaskStatus } from '@shared/tasks'
import { ROOT_MANDATE } from '@shared/tasks'
import {
  completionTime,
  laneFor,
  visibleTasksForLane,
  MAX_COMPLETED_CARDS,
  MAX_LANE_CARDS
} from './Flow'

function mockTask(over: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    seq: 1,
    projectId: 'p-1',
    title: 'test prompt',
    titleSummary: null,
    kind: 'work',
    status: 'ready',
    priority: 'P1',
    createdBy: { kind: 'human' },
    parentTaskId: null,
    lineageDepth: 0,
    assignee: null,
    assigneeHint: null,
    mandate: ROOT_MANDATE,
    budget: { grantedTokens: 0, spentTokens: 0 },
    dependsOn: [],
    notBefore: null,
    deadline: null,
    requires: [],
    constraints: {},
    verification: 'auto',
    finishPolicy: 'inherit',
    sessionSharing: 'inherit',
    completionMode: 'inherit',
    objective: 'inherit',
    autoCompact: 'inherit',
    finishAskedAt: null,
    conflictAskedAt: null,
    resolveRetryAskedAt: null,
    preemptible: true,
    estTokens: null,
    cancel: null,
    handoffNote: null,
    holdReason: null,
    holdUntil: null,
    quotaOverrideUntil: null,
    branch: null,
    firstRunAt: null,
    lastRunEndedAt: null,
    activeMs: 0,
    activeSince: null,
    ranOn: null,
    ranModel: null,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...over
  }
}

describe('Flow lane mapping', () => {
  it('maps ready task without hold to ready', () => {
    expect(laneFor(mockTask({ status: 'ready', holdReason: null }))).toBe('ready')
  })

  it('maps ready task with hold reason to queued', () => {
    expect(laneFor(mockTask({ status: 'ready', holdReason: 'at capacity' }))).toBe('queued')
  })

  it('maps scheduled task to queued', () => {
    expect(laneFor(mockTask({ status: 'scheduled' }))).toBe('queued')
  })

  it('maps assigned task to dispatching', () => {
    expect(laneFor(mockTask({ status: 'assigned' }))).toBe('dispatching')
  })

  it('maps running and cancelling tasks to running', () => {
    expect(laneFor(mockTask({ status: 'running' }))).toBe('running')
    expect(laneFor(mockTask({ status: 'cancelling' }))).toBe('running')
  })

  it('maps human-waiting tasks to awaiting', () => {
    expect(laneFor(mockTask({ status: 'awaiting_human' }))).toBe('awaiting')
    expect(laneFor(mockTask({ status: 'paused_user' }))).toBe('awaiting')
  })

  it('maps blocked and draft tasks to held', () => {
    expect(laneFor(mockTask({ status: 'draft' }))).toBe('held')
    expect(laneFor(mockTask({ status: 'blocked' }))).toBe('held')
    expect(laneFor(mockTask({ status: 'paused_quota' }))).toBe('held')
  })

  it('maps completed, failed, and cancelled tasks to finished', () => {
    const finishedStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled']
    for (const status of finishedStatuses) {
      expect(laneFor(mockTask({ status }))).toBe('finished')
    }
  })
})

describe('Flow visible tasks per lane', () => {
  it('shows all tasks for non-finished lanes up to MAX_LANE_CARDS', () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      mockTask({ id: `t-${i}`, seq: i + 1, status: 'ready' })
    )
    expect(visibleTasksForLane('ready', tasks)).toHaveLength(12)
  })

  it('caps non-finished lanes at MAX_LANE_CARDS', () => {
    const tasks = Array.from({ length: 105 }, (_, i) =>
      mockTask({ id: `t-${i}`, seq: i + 1, status: 'ready' })
    )
    expect(visibleTasksForLane('ready', tasks)).toHaveLength(MAX_LANE_CARDS)
  })

  it('shows all completed tasks when count is within MAX_COMPLETED_CARDS (<= 5)', () => {
    const tasks = [
      mockTask({ id: 't-1', seq: 1, status: 'completed', lastRunEndedAt: 100 }),
      mockTask({ id: 't-2', seq: 2, status: 'completed', lastRunEndedAt: 200 }),
      mockTask({ id: 't-3', seq: 3, status: 'completed', lastRunEndedAt: 300 })
    ]
    const visible = visibleTasksForLane('finished', tasks)
    expect(visible.map((t) => t.seq)).toEqual([1, 2, 3])
  })

  it('limits completed tasks to the last 5 completed ones', () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      mockTask({
        id: `t-${i + 1}`,
        seq: i + 1,
        status: 'completed',
        createdAt: 1000 + i * 10,
        lastRunEndedAt: 2000 + i * 10
      })
    )
    const visible = visibleTasksForLane('finished', tasks)
    expect(visible).toHaveLength(MAX_COMPLETED_CARDS)
    expect(visible.map((t) => t.seq)).toEqual([8, 9, 10, 11, 12])
  })

  it('selects the last 5 completed based on completion time', () => {
    // t-1 completed recently (ended at 5000), despite having the lowest seq
    const tasks = [
      mockTask({ id: 't-1', seq: 1, status: 'completed', lastRunEndedAt: 5000 }),
      mockTask({ id: 't-2', seq: 2, status: 'completed', lastRunEndedAt: 1000 }),
      mockTask({ id: 't-3', seq: 3, status: 'completed', lastRunEndedAt: 1100 }),
      mockTask({ id: 't-4', seq: 4, status: 'completed', lastRunEndedAt: 1200 }),
      mockTask({ id: 't-5', seq: 5, status: 'completed', lastRunEndedAt: 1300 }),
      mockTask({ id: 't-6', seq: 6, status: 'completed', lastRunEndedAt: 1400 }),
      mockTask({ id: 't-7', seq: 7, status: 'completed', lastRunEndedAt: 1500 })
    ]
    const visible = visibleTasksForLane('finished', tasks)
    expect(visible).toHaveLength(5)
    // Most recent completions: t-4 (1200), t-5 (1300), t-6 (1400), t-7 (1500), t-1 (5000)
    expect(visible.map((t) => t.seq)).toEqual([1, 4, 5, 6, 7])
  })

  it('preserves failed and cancelled tasks in the finished lane alongside the 5 completed tasks', () => {
    const completed = Array.from({ length: 8 }, (_, i) =>
      mockTask({
        id: `c-${i + 1}`,
        seq: i + 1,
        status: 'completed',
        lastRunEndedAt: 1000 + i * 10
      })
    )
    const failed = mockTask({ id: 'f-1', seq: 20, status: 'failed' })
    const cancelled = mockTask({ id: 'x-1', seq: 21, status: 'cancelled' })
    const all = [...completed, failed, cancelled]

    const visible = visibleTasksForLane('finished', all)
    // 5 completed + 1 failed + 1 cancelled = 7
    expect(visible).toHaveLength(7)
    expect(visible.map((t) => t.seq)).toEqual([4, 5, 6, 7, 8, 20, 21])
  })
})

describe('completionTime helper', () => {
  it('prefers lastRunEndedAt over updatedAt and createdAt', () => {
    expect(
      completionTime(mockTask({ lastRunEndedAt: 300, updatedAt: 200, createdAt: 100 }))
    ).toBe(300)
  })

  it('falls back to updatedAt when lastRunEndedAt is null', () => {
    expect(
      completionTime(mockTask({ lastRunEndedAt: null, updatedAt: 200, createdAt: 100 }))
    ).toBe(200)
  })

  it('falls back to createdAt when both lastRunEndedAt and updatedAt are null', () => {
    expect(
      completionTime(
        mockTask({
          lastRunEndedAt: null,
          updatedAt: undefined as unknown as number,
          createdAt: 100
        })
      )
    ).toBe(100)
  })
})
