import { useCallback, useEffect, useMemo, useState } from 'react'
import { sessionEnded } from '@shared/protocol'
import type { Task, TaskStatus } from '@shared/tasks'
import { rpc, useDaemonEvents, useNow, type FleetEntry } from '../lib/daemon'
import { duration } from '../lib/format'

type FlowLane = 'ready' | 'queued' | 'dispatching' | 'running' | 'awaiting' | 'held' | 'finished'

const LANES: Array<{ id: FlowLane; label: string; statuses: readonly TaskStatus[] }> = [
  { id: 'ready', label: 'ready', statuses: ['ready'] },
  { id: 'queued', label: 'queued', statuses: ['scheduled'] },
  { id: 'dispatching', label: 'dispatching', statuses: ['assigned'] },
  { id: 'running', label: 'running', statuses: ['running', 'cancelling'] },
  { id: 'awaiting', label: 'awaiting', statuses: ['awaiting_human', 'paused_user'] },
  { id: 'held', label: 'held', statuses: ['draft', 'blocked', 'paused_quota'] },
  { id: 'finished', label: 'finished', statuses: ['completed', 'failed', 'cancelled'] }
]

function laneFor(task: Task): FlowLane {
  // Ready with a daemon-supplied hold reason is eligible work that cannot currently move. It is
  // shown beside scheduled work, not as a second invented domain status.
  if (task.status === 'ready' && task.holdReason) return 'queued'
  return LANES.find((lane) => lane.statuses.includes(task.status))?.id ?? 'held'
}

function taskTime(task: Task, now: number): string {
  const live = task.activeSince ? task.activeMs + now - task.activeSince : task.activeMs
  if (live > 0) return task.activeSince ? `working ${duration(live)}` : `worked ${duration(live)}`
  return task.status === 'ready' ? 'ready to route' : task.status
}

function workspaceName(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? cwd
}

/** A compact, live map of how this project's work is moving through the scheduler. */
export function Flow({ projectId, fleet, onOpenTask }: {
  projectId: string
  fleet: FleetEntry[]
  onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<string | null>(null)
  const now = useNow(1000)
  const refresh = useCallback(async () => {
    try {
      setTasks(await rpc('task.list', { projectId }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])
  useDaemonEvents((event) => {
    if ((event.type === 'task.changed' && event.task.projectId === projectId) || event.type === 'run.changed') {
      void refresh()
    }
  })

  const workers = useMemo(() => {
    const activeWorkerIds = new Set(tasks.filter((t) => laneFor(t) === 'running').map((t) => t.ranOn).filter(Boolean))
    return fleet.flatMap(({ worker, sessions }) => sessions
      .filter((session) => session.purpose === 'work' && !sessionEnded(session.state))
      .filter((session) => session.projectId === projectId)
      .map((session) => ({ worker: worker.label, workspace: workspaceName(session.cwd), active: activeWorkerIds.has(worker.id) })))
  }, [fleet, projectId, tasks])

  return (
    <section className="flow panel">
      <header className="panel-head">
        <div>
          <h2>Flow</h2>
          <p className="panel-sub">The live shape of this project: work enters from the left, runs through a worker workspace, and comes to rest on the right.</p>
        </div>
        <span className="tag">{tasks.length} tasks</span>
      </header>
      {error ? <div className="alert">{error}</div> : (
        <>
          <div className="flow-board" aria-label="Task flow">
            {LANES.map((lane) => {
              const laneTasks = tasks.filter((task) => laneFor(task) === lane.id)
              return <div className={`flow-lane flow-lane--${lane.id}`} key={lane.id}>
                <div className="flow-cards">
                  {laneTasks.slice(0, 100).map((task) => <button
                    className={`flow-ticket flow-ticket--${task.status}`}
                    key={`${task.id}:${task.status}`}
                    onClick={() => onOpenTask(task.id)}
                    title={`t${task.seq} — ${task.titleSummary ?? task.title}\n${taskTime(task, now)}`}
                    aria-label={`Open t${task.seq}: ${task.titleSummary ?? task.title}. ${taskTime(task, now)}`}
                  >t{task.seq}</button>)}
                  {laneTasks.length > 100 && <span className="flow-more">+{laneTasks.length - 100} more</span>}
                </div>
                <div className="flow-lane-label"><span>{lane.label}</span><b>{laneTasks.length}</b></div>
              </div>
            })}
          </div>
          <div className="flow-workers" aria-label="Live worker workspaces">
            <span className="flow-workers-label">live workspaces</span>
            {workers.length ? workers.map((row, index) => <span className={`flow-worker${row.active ? ' flow-worker--active' : ''}`} key={`${row.worker}:${row.workspace}:${index}`}>
              <span className="mono">{row.workspace}</span><span>{row.worker}</span>
            </span>) : <span className="dim">No project workspace is running right now.</span>}
          </div>
        </>
      )}
    </section>
  )
}
