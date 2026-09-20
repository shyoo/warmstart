import { describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol'
import type { FlowWorkspace, Task, TaskStatus } from '@shared/tasks'
import { ROOT_MANDATE } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import {
  computeWorkspaceRows,
  completionTime,
  bindingLine,
  workspaceLockLine,
  isLockedWorkspace,
  laneFor,
  runningWorkspaceRows,
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
    landingTarget: null,
    branchUnit: 1,
    landAfterTurn: null,
    childDefaults: null,
    debate: null,
    kind: 'work',
    landedBaseSha: null,
    landedHeadSha: null,
    qualityReviewId: null,
    qualityScore: null,
    qualityReviewCount: 0,
    qualityReviewedAt: null,
    qualityReviewer: null,
    qualityManualCount: 0,
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
    workspaceMode: 'inherit',
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
    quotaPreemptWarning: null,
    branch: null,
    firstRunAt: null,
    lastRunEndedAt: null,
    activeMs: 0,
    activeSince: null,
    ranOn: null,
    ranModel: null,
    createdAt: 1000,
    updatedAt: 1000,
    excludedFromStats: false,
    nonGradable: false,
    deletedAt: null,
    ...over
  }
}

function mockWorkspace(over: Partial<FlowWorkspace> = {}): FlowWorkspace {
  return {
    path: 'C:/ws/ws1',
    label: 'ws1',
    kind: 'worktree',
    inPool: true,
    holding: null,
    taskId: null,
    taskSeq: null,
    taskTitle: null,
    taskStatus: null,
    workerId: 'w-1',
    workerLabel: 'CodexFirst',
    adapterId: 'codex',
    sessionId: null,
    branch: null,
    claimedAt: null,
    ...over
  }
}

function mockWorker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w-1',
    credits: null,
    creditsIntent: null,
    label: 'CodexFirst',
    adapterId: 'codex',
    isolationRoot: '',
    enabled: true,
    humanOccupied: false,
    role: 'both',
    maxConcurrent: 1,
    unattendedAuthority: 'full-user',
    defaultModel: null,
    defaultEffort: null,
    identity: null,
    health: null,
    sortOrder: 0,
    retiredAt: null,
    createdAt: 1000,
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

  it('shows a completed task in running while its peer grade is in flight', () => {
    expect(laneFor(mockTask({ status: 'completed', gradingWorkerId: 'reviewer-1' }))).toBe('running')
  })

  it('maps human-waiting tasks to awaiting', () => {
    expect(laneFor(mockTask({ status: 'awaiting_human' }))).toBe('awaiting')
    expect(laneFor(mockTask({ status: 'paused_user' }))).toBe('awaiting')
  })

  it('maps draft to ready, and blocked / paused_quota to queued', () => {
    expect(laneFor(mockTask({ status: 'draft' }))).toBe('ready')
    expect(laneFor(mockTask({ status: 'blocked' }))).toBe('queued')
    expect(laneFor(mockTask({ status: 'paused_quota' }))).toBe('queued')
  })

  it('maps completed, failed, and cancelled tasks to finished', () => {
    const finishedStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled']
    for (const status of finishedStatuses) {
      expect(laneFor(mockTask({ status }))).toBe('finished')
    }
  })
})

describe('workspace bindings in the Running lane', () => {
  it('keeps a completed task out of Running even while its workspace claim remains', () => {
    // ⛔ This is t164's shape: status reached `completed`, while the separate resource-release
    // path had not yet cleared the workspace claim. The ticket must be drawn once, in Finished.
    const rows = [
      { id: 'running', activeTask: mockTask({ id: 't-running', status: 'running' }) },
      { id: 'completed', activeTask: mockTask({ id: 't-completed', status: 'completed' }) },
      { id: 'free', activeTask: null }
    ]

    expect(runningWorkspaceRows(rows).map((row) => row.id)).toEqual(['running', 'free'])
    expect(laneFor(rows[1]!.activeTask!)).toBe('finished')
  })

  it('keeps only actual running states in a binding lane and leaves non-running workspace rows alone', () => {
    const rows = [
      { id: 'run', activeTask: mockTask({ status: 'running' }) },
      { id: 'cancel', activeTask: mockTask({ status: 'cancelling' }) },
      { id: 'ready', activeTask: mockTask({ status: 'ready' }) },
      { id: 'queued', activeTask: mockTask({ status: 'scheduled' }) },
      { id: 'dispatching', activeTask: mockTask({ status: 'assigned' }) },
      { id: 'awaiting', activeTask: mockTask({ status: 'awaiting_human' }) },
      { id: 'paused', activeTask: mockTask({ status: 'paused_user' }) },
      { id: 'quota', activeTask: mockTask({ status: 'paused_quota' }) },
      { id: 'failed', activeTask: mockTask({ status: 'failed' }) },
      { id: 'cancelled', activeTask: mockTask({ status: 'cancelled' }) },
      // Free and inbound rows have no active task; dropping either would hide pool capacity or a
      // dispatch transition from the one column meant to explain them.
      { id: 'free-or-inbound', activeTask: null }
    ]

    expect(runningWorkspaceRows(rows).map((row) => row.id)).toEqual([
      'run',
      'cancel',
      'free-or-inbound'
    ])
  })
})

describe('computeWorkspaceRows', () => {
  it('never draws a worktree task heading into the trunk, nor a trunk task into a worktree (t401)', () => {
    const trunkRow = mockWorkspace({ path: 'C:/proj', label: 'main', kind: 'trunk', defaultMode: 'worktree', workerId: null, workerLabel: null })
    const ws1 = mockWorkspace({ workerId: null, workerLabel: null })
    const worktreeTask = mockTask({ id: 't-1', seq: 1, status: 'assigned', workspaceMode: 'inherit' })
    const trunkTask = mockTask({ id: 't-2', seq: 2, status: 'assigned', workspaceMode: 'trunk' })

    const rows = computeWorkspaceRows([trunkRow, ws1], new Map(), [worktreeTask, trunkTask], [])
    expect(rows[0]!.inboundTask?.id).toBe('t-2')
    expect(rows[1]!.inboundTask?.id).toBe('t-1')

    // ⚠️ `inherit` follows the project default the trunk row carries.
    const trunkDefault = { ...trunkRow, defaultMode: 'trunk' as const }
    const again = computeWorkspaceRows([trunkDefault, ws1], new Map(), [worktreeTask], [])
    expect(again[0]!.inboundTask?.id).toBe('t-1')
    expect(again[1]!.inboundTask).toBeNull()
  })

  it('keeps a trunk held by a resting task drawn as held, not free', () => {
    const resting = mockTask({ id: 't-9', seq: 9, status: 'awaiting_human' })
    const trunkRow = mockWorkspace({ path: 'C:/proj', label: 'main', kind: 'trunk', taskId: 't-9', taskSeq: 9, holding: 'task' })
    const rows = computeWorkspaceRows([trunkRow], new Map([['t-9', resting]]), [], [])
    expect(rows[0]!.ws.holding).toBe('task')
    expect(rows[0]!.ws.taskSeq).toBe(9)
    expect(rows[0]!.activeTask).toBeNull()
  })

  it('draws a pool member locked by a waiting ticket as locked, not free', () => {
    // ⛔ The awaiting lane already says the ticket `locks ws2`. Before this, ws2's own row in the
    // running column said `free` — the same fact, two answers, and the wrong one on the board an
    // operator reads to find a tree that can take work.
    const waiting = mockTask({ id: 't-9', seq: 9, status: 'awaiting_human' })
    const ws2 = mockWorkspace({ path: 'C:/ws/ws2', label: 'ws2', taskId: 't-9', taskSeq: 9, taskStatus: 'awaiting_human', holding: 'task' })
    const byId = new Map([['t-9', waiting]])

    expect(isLockedWorkspace(ws2, byId)).toBe(true)
    const rows = computeWorkspaceRows([ws2], byId, [], [])
    expect(rows[0]!.activeTask).toBeNull()
    expect(rows[0]!.ws.holding).toBe('task')
    expect(rows[0]!.ws.taskSeq).toBe(9)
    // ⛔ And it stays on the board: `runningWorkspaceRows` keeps every row with no active task.
    expect(runningWorkspaceRows(rows)).toHaveLength(1)
  })

  it('reads the claim’s own status when the waiting ticket is not in the page', () => {
    const ws2 = mockWorkspace({ label: 'ws2', taskId: 't-9', taskSeq: 9, taskStatus: 'paused_user', holding: 'task' })
    expect(isLockedWorkspace(ws2, new Map())).toBe(true)
  })

  it('does not call a workspace locked when its ticket is running, free or finished', () => {
    const byId = new Map([
      ['t-run', mockTask({ id: 't-run', status: 'running' })],
      ['t-done', mockTask({ id: 't-done', status: 'completed' })]
    ])
    expect(isLockedWorkspace(mockWorkspace({ taskId: 't-run', holding: 'session', taskStatus: 'running' }), byId)).toBe(false)
    expect(isLockedWorkspace(mockWorkspace({ taskId: 't-done', holding: 'session', taskStatus: 'completed' }), byId)).toBe(false)
    expect(isLockedWorkspace(mockWorkspace(), byId)).toBe(false)
    // A status with no claim behind it is not a lock — the tree was already released.
    expect(isLockedWorkspace(mockWorkspace({ taskId: 't-9', taskStatus: 'awaiting_human', holding: null }), byId)).toBe(false)
  })

  it('never offers a locked workspace to an inbound dispatch', () => {
    const waiting = mockTask({ id: 't-9', seq: 9, status: 'awaiting_human' })
    const inbound = mockTask({ id: 't-10', seq: 10, status: 'assigned', assignee: 'w-1' })
    const byId = new Map([['t-9', waiting]])
    const ws1 = mockWorkspace({ label: 'ws1', taskId: 't-9', taskSeq: 9, taskStatus: 'awaiting_human', holding: 'task', workerId: 'w-1' })

    const rows = computeWorkspaceRows([ws1], byId, [inbound], [])
    expect(rows[0]!.inboundTask).toBeNull()
  })

  it('prevents a single task from occupying multiple workspaces (Bug 1)', () => {
    // When t168 was dispatched, ws1 and ws2 both had claims for t168.
    // computeWorkspaceRows must bind t168 to only ONE workspace row, leaving the other free.
    const t168 = mockTask({ id: 't-168', seq: 168, status: 'running' })
    const byId = new Map([['t-168', t168]])
    const workspaces = [
      mockWorkspace({ path: 'C:/ws/ws1', label: 'ws1', taskId: 't-168', taskSeq: 168, holding: 'session' }),
      mockWorkspace({ path: 'C:/ws/ws2', label: 'ws2', taskId: 't-168', taskSeq: 168, holding: 'session' })
    ]

    const rows = computeWorkspaceRows(workspaces, byId, [], [])
    expect(rows).toHaveLength(2)

    // First row binds t168 as activeTask
    expect(rows[0]!.activeTask?.id).toBe('t-168')
    expect(rows[0]!.ws.label).toBe('ws1')

    // Second row cannot bind t168; it is demoted to free/idle
    expect(rows[1]!.activeTask).toBeNull()
    expect(rows[1]!.ws.label).toBe('ws2')
    expect(rows[1]!.ws.taskId).toBeNull()
    expect(rows[1]!.ws.holding).toBeNull()
  })

  it('treats workspace with completed or non-running task as free instead of active running (Bug 2)', () => {
    // When t167 completed, Flow UI must not show it as running in ws4.
    // The workspace slot must remain in the pool and be displayed as free.
    const t167 = mockTask({ id: 't-167', seq: 167, status: 'completed' })
    const byId = new Map([['t-167', t167]])
    const workspaces = [
      mockWorkspace({
        path: 'C:/ws/ws4',
        label: 'ws4',
        taskId: 't-167',
        taskSeq: 167,
        taskStatus: 'completed',
        holding: 'session'
      })
    ]

    const rows = computeWorkspaceRows(workspaces, byId, [], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.activeTask).toBeNull()
    expect(rows[0]!.ws.label).toBe('ws4')
    expect(rows[0]!.ws.taskId).toBeNull()
    expect(rows[0]!.ws.holding).toBeNull()

    // And runningWorkspaceRows does NOT drop ws4 from the board
    const running = runningWorkspaceRows(rows)
    expect(running).toHaveLength(1)
    expect(running[0]!.ws.label).toBe('ws4')
  })

  it('matches free workspace from completed task with inbound task', () => {
    const t167 = mockTask({ id: 't-167', seq: 167, status: 'completed' })
    const inbound = mockTask({ id: 't-169', seq: 169, status: 'assigned', assignee: 'w-1' })
    const byId = new Map([['t-167', t167]])
    const workspaces = [
      mockWorkspace({ path: 'C:/ws/ws4', label: 'ws4', taskId: 't-167', taskSeq: 167, workerId: 'w-1' })
    ]
    const fleet: FleetEntry[] = [
      {
        worker: mockWorker({ id: 'w-1', label: 'CodexFirst', adapterId: 'codex' }),
        sessions: [],
        quota: null
      }
    ]

    const rows = computeWorkspaceRows(workspaces, byId, [inbound], fleet)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.activeTask).toBeNull()
    expect(rows[0]!.inboundTask?.id).toBe('t-169')
    expect(rows[0]!.inboundWorker?.label).toBe('CodexFirst')
  })

  it('binds running task in workspace that is releasing or landing, preventing workspace unknown', () => {
    // When t204 finishes its turn and is landing or releasing its workspace,
    // computeWorkspaceRows must bind t204 as activeTask rather than demoting the row to free.
    const t204 = mockTask({ id: 't-204', seq: 204, status: 'running' })
    const byId = new Map([['t-204', t204]])
    const workspacesReleasing = [
      mockWorkspace({
        path: 'C:/ws/ws3',
        label: 'ws3',
        taskId: 't-204',
        taskSeq: 204,
        taskStatus: 'running',
        holding: 'releasing',
        workerLabel: 'CodexFirst'
      })
    ]

    const releasingRows = computeWorkspaceRows(workspacesReleasing, byId, [], [])
    expect(releasingRows).toHaveLength(1)
    expect(releasingRows[0]!.activeTask?.id).toBe('t-204')
    expect(releasingRows[0]!.ws.label).toBe('ws3')
    expect(releasingRows[0]!.ws.holding).toBe('releasing')

    // Same for landing
    const workspacesLanding = [
      mockWorkspace({
        path: 'C:/ws/ws3',
        label: 'ws3',
        taskId: 't-204',
        taskSeq: 204,
        taskStatus: 'running',
        holding: 'landing',
        workerLabel: 'CodexFirst'
      })
    ]
    const landingRows = computeWorkspaceRows(workspacesLanding, byId, [], [])
    expect(landingRows).toHaveLength(1)
    expect(landingRows[0]!.activeTask?.id).toBe('t-204')
    expect(landingRows[0]!.ws.label).toBe('ws3')
    expect(landingRows[0]!.ws.holding).toBe('landing')
  })
})

describe('bindingLine description helper', () => {
  it('formats releasing, landing, holding, working in and free states correctly', () => {
    const base = { path: 'C:/ws/ws3', label: 'ws3', kind: 'worktree' as const, workerLabel: 'CodexFirst', workerId: 'w-1', inPool: true, adapterId: 'codex', sessionId: null, branch: null, claimedAt: null }
    expect(bindingLine({ ...base, taskId: 't-1', taskSeq: 204, taskTitle: null, taskStatus: 'running', holding: 'releasing' }))
      .toBe('t204 releasing ws3 / CodexFirst')
    expect(bindingLine({ ...base, taskId: 't-1', taskSeq: 204, taskTitle: null, taskStatus: 'running', holding: 'landing' }))
      .toBe('t204 landing in ws3 / CodexFirst')
    expect(bindingLine({ ...base, taskId: 't-1', taskSeq: 204, taskTitle: null, taskStatus: 'awaiting_human', holding: 'task' }))
      .toBe('t204 holding ws3 / CodexFirst')
    expect(bindingLine({ ...base, taskId: 't-1', taskSeq: 204, taskTitle: null, taskStatus: 'running', holding: 'session' }))
      .toBe('t204 working in ws3 / CodexFirst')
    expect(bindingLine({ ...base, taskId: null, taskSeq: null, taskTitle: null, taskStatus: null, holding: null }))
      .toBe('ws3 / CodexFirst — free')
  })

  it('names the retained workspace on an awaiting-human ticket', () => {
    const ws = mockWorkspace({ label: 'ws3', workerLabel: 'CodexFirst', taskId: 't-204', taskSeq: 204, taskStatus: 'awaiting_human', holding: 'task' })
    expect(workspaceLockLine(ws)).toBe('locks ws3 / CodexFirst')
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
