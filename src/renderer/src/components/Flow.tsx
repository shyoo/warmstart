import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FlowWorkspace, Task, TaskStatus } from '@shared/tasks'
import { rpc, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { duration } from '../lib/format'
import { assigneeLabel } from '../lib/taskview'
import { AgentIcon } from './AgentIcon'
import { errorMessage } from '@shared/errors.js'

export type FlowLane = 'ready' | 'queued' | 'dispatching' | 'running' | 'awaiting' | 'finished'

export const LANES: Array<{ id: FlowLane; label: string; statuses: readonly TaskStatus[] }> = [
  { id: 'ready', label: 'ready', statuses: ['ready', 'draft'] },
  { id: 'queued', label: 'queued', statuses: ['scheduled', 'blocked', 'paused_quota', 'landing_queued'] },
  { id: 'dispatching', label: 'dispatching', statuses: ['assigned'] },
  { id: 'running', label: 'running', statuses: ['running', 'cancelling'] },
  { id: 'awaiting', label: 'awaiting', statuses: ['awaiting_human', 'paused_user'] },
  { id: 'finished', label: 'finished', statuses: ['completed', 'failed', 'cancelled'] }
]

export const MAX_LANE_CARDS = 100
export const MAX_COMPLETED_CARDS = 5

export function completionTime(task: Task): number {
  return task.lastRunEndedAt ?? task.updatedAt ?? task.createdAt
}

/**
 * Filter the tasks shown as tickets in a lane.
 *
 * ⛔ In a long-lived project, completed tasks accumulate without bound while the live work on the
 * left sits in single digits. Showing every completed ticket fills the rightmost lane with dozens of
 * buttons that obscure recent progress. The finished lane therefore shows only the last 5 completed
 * tasks, preserving any failed or cancelled tasks that still warrant attention.
 */
export function visibleTasksForLane(laneId: FlowLane, laneTasks: Task[]): Task[] {
  if (laneId === 'finished') {
    const completed = laneTasks.filter((t) => t.status === 'completed')
    if (completed.length <= MAX_COMPLETED_CARDS) {
      return laneTasks.slice(0, MAX_LANE_CARDS)
    }
    const recent = [...completed]
      .sort((a, b) => {
        const diff = completionTime(a) - completionTime(b)
        return diff !== 0 ? diff : a.seq - b.seq
      })
      .slice(-MAX_COMPLETED_CARDS)
    const recentIds = new Set(recent.map((t) => t.id))
    return laneTasks.filter((t) => t.status !== 'completed' || recentIds.has(t.id)).slice(0, MAX_LANE_CARDS)
  }
  return laneTasks.slice(0, MAX_LANE_CARDS)
}

export function laneFor(task: Task): FlowLane {
  if (task.gradingWorkerId) return 'running'
  // Ready with a daemon-supplied hold reason is eligible work that cannot currently move. It is
  // shown beside scheduled work in queued, not as a second invented domain status.
  if (task.status === 'ready' && task.holdReason) return 'queued'
  return LANES.find((lane) => lane.statuses.includes(task.status))?.id ?? 'queued'
}

/**
 * The Running lane is a binding view, not a second copy of every workspace claim.
 *
 * A claim can outlive a run while `releaseFor` is unwinding it, or while a task deliberately keeps
 * its tree awaiting a human. In either case the task's lifecycle lane is authoritative: a completed
 * ticket must be in Finished, never green inside Running just because its workspace row is late.
 */
export function runningWorkspaceRows<
  T extends { activeTask: Pick<Task, 'status' | 'holdReason'> | null }
>(rows: T[]): T[] {
  return rows.filter((row) => row.activeTask === null || laneFor(row.activeTask as Task) === 'running')
}

function activeMs(task: Task, now: number): number {
  return task.activeSince ? task.activeMs + now - task.activeSince : task.activeMs
}

function taskTime(task: Task, now: number): string {
  if (task.gradingWorkerId) return 'grading'
  const live = activeMs(task, now)
  if (live > 0) return task.activeSince ? `working ${duration(live)}` : `worked ${duration(live)}`
  return task.status === 'ready' ? 'ready to route' : task.status
}

/**
 * What a workspace row says about itself, in the words the operator's question is asked in:
 * *who is handling this, and where*.
 */
export function bindingLine(ws: FlowWorkspace): string {
  const where = `${ws.label}${ws.workerLabel ? ` / ${ws.workerLabel}` : ''}`
  if (!ws.taskSeq) return `${where} — free`
  const how =
    ws.holding === 'landing'
      ? 'landing in'
      : ws.holding === 'releasing'
        ? 'releasing'
        : ws.holding === 'task'
          ? 'holding'
          : 'working in'
  return `t${ws.taskSeq} ${how} ${where}`
}

/** The visible qualification on a waiting ticket that retains a workspace claim. */
export function workspaceLockLine(ws: FlowWorkspace): string {
  return `locks ${ws.label}${ws.workerLabel ? ` / ${ws.workerLabel}` : ''}`
}

export interface BoundWorkspaceRow {
  ws: FlowWorkspace
  activeTask: Task | null
  inboundTask: Task | null
  inboundWorker: { label: string; adapterId: string | null } | null
}

/**
 * Bindings for each workspace in the pool:
 * - An active workspace shows its ticket and worker: `t65 -> ws1 / ClaudeFirst`
 * - An available workspace paired with an inbound task shows: `ws4 / CodexFirst <- t68`
 * - An idle workspace shows: `ws4 / CodexFirst free`
 *
 * ⛔ A task can only occupy ONE workspace, and only while running (or live landing).
 * A completed/awaiting or duplicate task must not show as running in any workspace row.
 */
export function computeWorkspaceRows(
  workspaces: FlowWorkspace[],
  byId: Map<string, Task>,
  inboundTasks: Task[],
  fleet: FleetEntry[]
): BoundWorkspaceRow[] {
  const unassignedInbound = [...inboundTasks]
  const boundTaskIds = new Set<string>()
  // ⛔ An inbound ticket is only ever drawn heading for the kind of tree it will get: a worktree
  // task pointed at `main` would be the one picture this board must never draw. `inherit` follows
  // the project, whose default the trunk row carries.
  const projectDefault = workspaces.find((w) => w.kind === 'trunk')?.defaultMode ?? 'worktree'
  const modeOf = (task: Task): 'worktree' | 'trunk' =>
    task.workspaceMode === 'trunk' || task.workspaceMode === 'worktree' ? task.workspaceMode : projectDefault

  return workspaces.map((ws) => {
    if (ws.taskId) {
      const candidate = byId.get(ws.taskId) ?? null
      const isRunning = candidate
        ? laneFor(candidate) === 'running'
        : ws.taskStatus === 'running' || ws.taskStatus === 'cancelling'
      if (isRunning && !boundTaskIds.has(ws.taskId)) {
        boundTaskIds.add(ws.taskId)
        return {
          ws,
          activeTask: candidate,
          inboundTask: null,
          inboundWorker: null
        }
      }
    }

    // ⭐ **A held trunk is drawn held**, unlike a held pool member. A resting trunk task keeps the
    // lease (its files are in the checkout) and every worktree landing waits on it, so "free" would
    // be the one wrong word; the ticket itself stays in its own lane.
    if (ws.kind === 'trunk' && ws.taskSeq && ws.holding) {
      return { ws, activeTask: null, inboundTask: null, inboundWorker: null }
    }

    // Workspace is free/available for inbound tasks.
    // Clear any stale holding/task metadata on this workspace row so it renders as free or inbound.
    const freeWs: FlowWorkspace = (ws.taskId || ws.holding)
      ? { ...ws, taskId: null, taskSeq: null, taskTitle: null, taskStatus: null, holding: null }
      : ws

    // Try to match an inbound task!
    const kind = freeWs.kind ?? 'worktree'
    let matchIdx = -1
    if (freeWs.workerId) {
      matchIdx = unassignedInbound.findIndex((t) => t.assignee === freeWs.workerId && modeOf(t) === kind)
    }
    if (matchIdx === -1) {
      matchIdx = unassignedInbound.findIndex((t) => modeOf(t) === kind)
    }
    if (matchIdx !== -1) {
      const inboundTask = unassignedInbound.splice(matchIdx, 1)[0]!
      const w = fleet.find((f) => f.worker.id === inboundTask.assignee)?.worker
      return {
        ws: freeWs,
        activeTask: null,
        inboundTask,
        inboundWorker: w ? { label: w.label, adapterId: w.adapterId } : null
      }
    }
    return {
      ws: freeWs,
      activeTask: null,
      inboundTask: null,
      inboundWorker: null
    }
  })
}

/** A compact, live map of how this project's work is moving through the scheduler. */
export function Flow({ projectId, fleet, onOpenTask }: {
  projectId: string
  fleet: FleetEntry[]
  onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [workspaces, setWorkspaces] = useState<FlowWorkspace[]>([])
  const [error, setError] = useState<string | null>(null)
  /** The ticket under the pointer or keyboard focus, whose detail the strip below the board shows. */
  const [peek, setPeek] = useState<string | null>(null)
  const now = useNow(1000)
  const refresh = useCallback(async () => {
    try {
      // ⛔ Both together. A board drawn from tasks alone is the version that could not say which
      // workspace a running ticket was in — the whole point of this view.
      const [list, bound] = await Promise.all([
        rpc('task.list', { projectId }),
        rpc('project.flow', { projectId })
      ])
      setTasks(list)
      setWorkspaces(bound)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])
  useDaemonEvents((event) => {
    // ⚠️ `resource.changed` and `session.changed` are in here because a claim moving between a task
    // and its session changes the binding without changing any task row. `reassignClaim` is silent
    // by design, so the board leans on the events that bracket a dispatch.
    if (
      (event.type === 'task.changed' && event.task.projectId === projectId) ||
      event.type === 'run.changed' ||
      event.type === 'resource.changed' ||
      event.type === 'session.changed'
    ) {
      void refresh()
    }
  })

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  /** Which tree each ticket is in, so a lane can mark a ticket that holds one. */
  const homeOf = useMemo(() => {
    const map = new Map<string, FlowWorkspace>()
    for (const ws of workspaces) {
      if (!ws.taskId) continue
      // ⛔ Only running or legitimately holding (awaiting_human) tasks hold a workspace home.
      // Completed, failed, cancelled tasks never hold a workspace.
      const t = byId.get(ws.taskId)
      if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) continue
      if (ws.taskStatus === 'completed' || ws.taskStatus === 'failed' || ws.taskStatus === 'cancelled') continue
      // If two workspaces have the same taskId, only the first/authoritative one is home.
      if (!map.has(ws.taskId)) map.set(ws.taskId, ws)
    }
    return map
  }, [workspaces, byId])

  /**
   * Running work that no workspace claim accounts for.
   *
   * ⛔ Drawn rather than dropped. A ticket the scheduler says is running must appear in the running
   * lane even when the binding cannot be resolved — a projectless pool that has never been built,
   * or the moment between a claim being released and a run being closed. Silently showing four of
   * five running tasks would be the same class of bug this view was rewritten to fix.
   */
  const unbound = useMemo(
    () => tasks.filter((task) => laneFor(task) === 'running' && !task.gradingWorkerId && !homeOf.has(task.id)),
    [tasks, homeOf]
  )
  const grading = useMemo(() => tasks.filter((task) => Boolean(task.gradingWorkerId)), [tasks])

  /**
   * Tickets on their way in: dispatched/assigned to an account, waiting to claim a workspace.
   */
  const inboundTasks = useMemo(
    () => tasks.filter((task) => task.status === 'assigned' && !homeOf.has(task.id)),
    [tasks, homeOf]
  )

  /**
   * Bindings for each workspace in the pool:
   * - An active workspace shows its ticket and worker: `t65 -> ws1 / ClaudeFirst`
   * - An available workspace paired with an inbound task shows: `ws4 / CodexFirst <- t68`
   * - An idle workspace shows: `ws4 / CodexFirst free`
   */
  const workspaceRows = useMemo<BoundWorkspaceRow[]>(
    () => computeWorkspaceRows(workspaces, byId, inboundTasks, fleet),
    [workspaces, byId, inboundTasks, fleet]
  )

  // ⛔ A workspace claim is evidence of a resource hold, not evidence that its task is running.
  // Keep free and inbound rows so the pool remains legible, but leave terminal/awaiting tickets to
  // the one lifecycle lane that owns their status. Awaiting tickets name their retained workspace
  // in that lane instead of being copied into Running.
  const runningRows = useMemo(() => runningWorkspaceRows(workspaceRows), [workspaceRows])

  /** Any remaining inbound tasks that did not fit in any free workspace (when pool is full). */
  const overflowInbound = useMemo(() => {
    const pairedTaskIds = new Set(
      workspaceRows.map((r) => r.inboundTask?.id).filter(Boolean)
    )
    return inboundTasks.filter((t) => !pairedTaskIds.has(t.id))
  }, [workspaceRows, inboundTasks])

  /** Map of which workspace an inbound task was paired with, for hover/peek info. */
  const inboundTargetMap = useMemo(() => {
    const map = new Map<string, FlowWorkspace>()
    for (const row of workspaceRows) {
      if (row.inboundTask) map.set(row.inboundTask.id, row.ws)
    }
    return map
  }, [workspaceRows])

  const peeked = peek ? byId.get(peek) : null
  const peekedHome = peek ? (homeOf.get(peek) ?? inboundTargetMap.get(peek)) : null

  const hover = (taskId: string | null): {
    onMouseEnter: () => void
    onMouseLeave: () => void
    onFocus: () => void
    onBlur: () => void
  } => ({
    onMouseEnter: () => setPeek(taskId),
    onMouseLeave: () => setPeek((current) => (current === taskId ? null : current)),
    onFocus: () => setPeek(taskId),
    onBlur: () => setPeek((current) => (current === taskId ? null : current))
  })

  const ticket = (task: Task, extra?: string): React.JSX.Element => (
    <button
      className={`flow-ticket flow-ticket--${task.status}${homeOf.has(task.id) ? ' flow-ticket--bound' : ''}`}
      key={`${task.id}:${task.status}`}
      onClick={() => onOpenTask(task.id)}
      title={`t${task.seq} — ${task.titleSummary ?? task.title}\n${taskTime(task, now)}${extra ? `\n${extra}` : ''}`}
      aria-label={`Open t${task.seq}: ${task.titleSummary ?? task.title}. ${taskTime(task, now)}${extra ? `. ${extra}` : ''}`}
      {...hover(task.id)}
    >t{task.seq}</button>
  )

  const renderWorkspaceRow = (row: BoundWorkspaceRow): React.JSX.Element => {
    const { ws, activeTask, inboundTask, inboundWorker } = row
    const heldFor = ws.claimedAt ? duration(now - ws.claimedAt) : null

    // Case 1: Active running / landing / releasing task: t65 -> ws1 / ClaudeFirst
    if (activeTask || ((ws.holding === 'landing' || ws.holding === 'releasing' || ws.holding === 'session') && (ws.taskStatus === 'running' || ws.taskStatus === 'cancelling'))) {
      return (
        <div
          className={`flow-bind flow-bind--active${ws.inPool ? '' : ' flow-bind--stale'}`}
          key={ws.path}
          title={`${bindingLine(ws)}${ws.branch ? `\n${ws.branch}` : ''}${heldFor ? `\nclaimed ${heldFor} ago` : ''}${ws.inPool ? '' : '\nno longer in pool; claim stands until run ends'}`}
        >
          <span className="flow-bind-ticket">
            {activeTask ? ticket(activeTask, bindingLine(ws)) : ws.taskSeq ? <span className="flow-ticket flow-ticket--other">t{ws.taskSeq}</span> : null}
          </span>
          <span className="flow-bind-arrow flow-bind-arrow--active" aria-hidden="true">→</span>
          <span className="flow-bind-dest">
            <span className={`flow-ws-badge mono${ws.kind === 'trunk' ? ' flow-ws-badge--trunk' : ''}`}>{ws.label}</span>
            {ws.workerLabel ? (
              <>
                <span className="flow-bind-slash">/</span>
                <span className="flow-worker-pill">
                  <AgentIcon adapterId={ws.adapterId} size={14} />
                  <span className="flow-worker-name">{ws.workerLabel}</span>
                </span>
              </>
            ) : null}
          </span>
          <span className="flow-bind-meta">
            {activeTask && ws.holding === 'session' ? (
              <>
                <span className="flow-tag flow-tag--locked">locked</span>
                <span className="flow-bind-time" title="Working duration">
                  <span className="flow-pulse-dot" aria-hidden="true" />
                  {duration(activeMs(activeTask, now))}
                </span>
              </>
            ) : ws.holding === 'task' ? (
              <span className="flow-tag flow-tag--held">held</span>
            ) : ws.holding === 'landing' ? (
              <span className="flow-tag flow-tag--landing">landing</span>
            ) : ws.holding === 'releasing' ? (
              <span className="flow-tag flow-tag--releasing">releasing</span>
            ) : null}
          </span>
        </div>
      )
    }

    // Case 1b: a trunk lease held by a task that is resting, not running: main held by t402
    if (ws.kind === 'trunk' && ws.taskSeq && ws.holding) {
      const held = ws.taskId ? byId.get(ws.taskId) : null
      return (
        <div
          className="flow-bind flow-bind--active"
          key={ws.path}
          title={`${ws.label} is held by t${ws.taskSeq}${heldFor ? ` for ${heldFor}` : ''} — worktree landings into it wait until it is released`}
        >
          <span className="flow-bind-ticket">
            {held ? ticket(held, `holding ${ws.label}`) : <span className="flow-ticket flow-ticket--other">t{ws.taskSeq}</span>}
          </span>
          <span className="flow-bind-arrow flow-bind-arrow--active" aria-hidden="true">→</span>
          <span className="flow-bind-dest">
            <span className="flow-ws-badge mono flow-ws-badge--trunk">{ws.label}</span>
          </span>
          <span className="flow-bind-meta">
            <span className="flow-tag flow-tag--held">held</span>
          </span>
        </div>
      )
    }

    // Case 2: Inbound task heading into this workspace: ws4 / CodexFirst <- t68
    if (inboundTask) {
      const workerLabel = inboundWorker?.label ?? ws.workerLabel ?? assigneeLabel(inboundTask, fleet)
      const adapterId = inboundWorker?.adapterId ?? ws.adapterId
      return (
        <div
          className="flow-bind flow-bind--inbound"
          key={ws.path}
          title={`${ws.label} / ${workerLabel} ← t${inboundTask.seq} (inbound dispatch)`}
        >
          <span className="flow-bind-dest">
            <span className={`flow-ws-badge mono${ws.kind === 'trunk' ? ' flow-ws-badge--trunk' : ''}`}>{ws.label}</span>
            <span className="flow-bind-slash">/</span>
            <span className="flow-worker-pill">
              <AgentIcon adapterId={adapterId} size={14} />
              <span className="flow-worker-name">{workerLabel}</span>
            </span>
          </span>
          <span className="flow-bind-arrow flow-bind-arrow--inbound" aria-hidden="true">←</span>
          <span className="flow-bind-ticket">
            {ticket(inboundTask, `inbound to ${ws.label} / ${workerLabel}`)}
          </span>
          <span className="flow-bind-meta">
            <span className="flow-tag flow-tag--inbound">dispatching</span>
          </span>
        </div>
      )
    }

    // Case 3: Free / idle workspace: ws4 / CodexFirst free
    return (
      <div
        className={`flow-bind flow-bind--free${ws.inPool ? '' : ' flow-bind--stale'}`}
        key={ws.path}
        title={
          ws.kind === 'trunk'
            ? `${ws.label} — the project's own checkout (${ws.path}). No trunk task is working in it.`
            : `${ws.label}${ws.workerLabel ? ` / ${ws.workerLabel}` : ''} — free${ws.branch ? `\nlast branch: ${ws.branch}` : ''}`
        }
      >
        <span className="flow-bind-dest">
          <span className={`flow-ws-badge flow-ws-badge--free mono${ws.kind === 'trunk' ? ' flow-ws-badge--trunk' : ''}`}>{ws.label}</span>
          {ws.workerLabel ? (
            <>
              <span className="flow-bind-slash">/</span>
              <span className="flow-worker-pill dim">
                <AgentIcon adapterId={ws.adapterId} size={14} />
                <span className="flow-worker-name">{ws.workerLabel}</span>
              </span>
            </>
          ) : null}
        </span>
        <span className="flow-bind-meta">
          <span className="flow-tag flow-tag--free">free</span>
        </span>
      </div>
    )
  }

  return (
    <section className="flow panel panel--wide">
      <header className="panel-head">
        <div>
          <h2>Flow</h2>
          <p className="panel-sub">Visual pipeline for project tasks: queued on the left, active in worker workspaces in the middle, and completed on the right.</p>
        </div>
        <span className="tag">{tasks.length} tasks</span>
      </header>
      {error ? <div className="alert">{error}</div> : (
        <>
          <div className="flow-board" aria-label="Task flow">
            {LANES.map((lane) => {
              const laneTasks = tasks.filter((task) => laneFor(task) === lane.id)
              const isRunningLane = lane.id === 'running'
              const visibleTasks = visibleTasksForLane(lane.id, laneTasks)
              const hiddenCount = laneTasks.length - visibleTasks.length
              return (
                <div className={`flow-lane flow-lane--${lane.id}`} key={lane.id}>
                  {isRunningLane ? (
                    // ⭐ The binding column. One card per workspace in the pool, visualizing
                    // ticket ↔ workspace ↔ worker bindings directly.
                    <div className="flow-binds">
                      {runningRows.length > 0 ? (
                        runningRows.map(renderWorkspaceRow)
                      ) : (
                        <span className="dim flow-binds-empty">No active workspaces. Workspaces are allocated automatically on task dispatch.</span>
                      )}
                      {unbound.length > 0 ? (
                        <div className="flow-bind flow-bind--unbound" title="Running with no workspace claim the daemon can resolve.">
                          <span className="flow-bind-ticket">{unbound.map((task) => ticket(task, 'no workspace claim'))}</span>
                          <span className="flow-bind-arrow flow-bind-arrow--active" aria-hidden="true">→</span>
                          <span className="flow-bind-dest dim">workspace unknown</span>
                        </div>
                      ) : null}
                      {grading.map((task) => {
                        const reviewer = fleet.find((entry) => entry.worker.id === task.gradingWorkerId)?.worker
                        return (
                          <div className="flow-bind flow-bind--grading" key={`grading:${task.id}`} title={`t${task.seq} is being graded${reviewer ? ` by ${reviewer.label}` : ''}`}>
                            <span className="flow-bind-ticket">{ticket(task, 'grading')}</span>
                            <span className="flow-bind-arrow flow-bind-arrow--active" aria-hidden="true">→</span>
                            <span className="flow-bind-dest">
                              <span className="flow-worker-pill">
                                <AgentIcon adapterId={reviewer?.adapterId ?? null} size={14} />
                                <span className="flow-worker-name">{reviewer?.label ?? 'reviewer'}</span>
                              </span>
                            </span>
                            <span className="flow-bind-meta"><span className="flow-tag flow-tag--grading">grading</span></span>
                          </div>
                        )
                      })}
                      {overflowInbound.length > 0 ? (
                        <div className="flow-bind flow-bind--inbound" title="Dispatched to an account, waiting for a free workspace in the pool.">
                          <span className="flow-bind-dest dim">waiting for workspace</span>
                          <span className="flow-bind-arrow flow-bind-arrow--inbound" aria-hidden="true">←</span>
                          <span className="flow-bind-ticket">
                            {overflowInbound.map((task) => ticket(task, `inbound to ${assigneeLabel(task, fleet)}`))}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flow-cards">
                      {visibleTasks.map((task) => {
                        const lockedWorkspace = lane.id === 'awaiting' ? homeOf.get(task.id) : null
                        return lockedWorkspace ? (
                          <div className="flow-wait-lock" key={task.id}>
                            {ticket(task, workspaceLockLine(lockedWorkspace))}
                            <span className="flow-wait-lock-line">
                              <span>locks</span>
                              <span className={`flow-ws-badge mono${lockedWorkspace.kind === 'trunk' ? ' flow-ws-badge--trunk' : ''}`}>{lockedWorkspace.label}</span>
                            </span>
                          </div>
                        ) : ticket(task)
                      })}
                      {hiddenCount > 0 && <span className="flow-more">+{hiddenCount} more</span>}
                    </div>
                  )}
                  <div className="flow-lane-label">
                    <span>{lane.label}</span>
                    <b>{isRunningLane ? grading.length + unbound.length + runningRows.filter((row) => row.activeTask !== null).length : laneTasks.length}</b>
                  </div>
                </div>
              )
            })}
          </div>
          {/*
            ⚠️ A strip rather than a floating card. It sits in normal flow, so it cannot be clipped
            by the board's own scroll container and it reads the same under a keyboard as under a
            pointer — a `title` alone says nothing to anybody tabbing through the tickets.
          */}
          <div className="flow-peek" aria-live="polite">
            {peeked ? (
              <>
                <span className="flow-peek-seq mono">t{peeked.seq}</span>
                <span className="flow-peek-title">{peeked.titleSummary ?? peeked.title}</span>
                <span className={`flow-peek-state flow-ticket--${peeked.gradingWorkerId ? 'grading' : peeked.status}`}>{peeked.gradingWorkerId ? 'grading' : peeked.status.replace(/_/g, ' ')}</span>
                <span className="flow-peek-time">{taskTime(peeked, now)}</span>
                <span className="flow-peek-where dim">
                  {peekedHome
                    ? `${peekedHome.label}${peekedHome.workerLabel ? ` / ${peekedHome.workerLabel}` : ''}`
                    : assigneeLabel(peeked, fleet)}
                </span>
              </>
            ) : (
              <span className="dim">Hover or focus a ticket to inspect details, agent assignment, and active duration.</span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
