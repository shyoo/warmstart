import { useCallback, useEffect, useState } from 'react'
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import type { Task } from '@shared/tasks'
import { duration, price, relTime, shortTitle, statusTone } from '../lib/format.js'

/**
 * The task list, already filtered server-side to remote-enabled projects.
 *
 * ⛔ `task.list`, not `task.page`. Server paging is refused over remote access because a page is sliced
 * in SQLite *before* the project filter can run, so a page of tasks the phone may not see arrives
 * empty with a `total` counting rows it was never allowed to know about. The filtered result is
 * paged locally, so its totals and boundaries describe only tasks this phone may see.
 */
export const TASKS_PER_PAGE = 10

export function TasksScreen({ refreshKey, projectId, openTask, newTask }: { refreshKey: number; projectId: string; openTask: (id: string) => void; newTask: () => void }): React.JSX.Element {
  const now = useNow()
  const [tasks, setTasks] = useState<Task[]>([])
  const [workerLabels, setWorkerLabels] = useState<Record<string, string>>({})
  const [page, setPage] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!projectId) { setTasks([]); return }
    void Promise.all([rpc('task.list', { projectId }), rpc('fleet.list', undefined)])
      .then(([all, fleet]) => {
        setTasks(
          [...all]
            .sort((a, b) => b.updatedAt - a.updatedAt)
        )
        setWorkerLabels(Object.fromEntries(fleet.map((entry) => [entry.worker.id, entry.worker.label])))
        setPage((current) => Math.min(current, Math.max(0, Math.ceil(all.length / TASKS_PER_PAGE) - 1)))
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [projectId])

  useEffect(refresh, [refresh, refreshKey])

  if (error) return <p className="m-error m-screen">{error}</p>

  const pageCount = Math.max(1, Math.ceil(tasks.length / TASKS_PER_PAGE))
  const shown = tasks.slice(page * TASKS_PER_PAGE, (page + 1) * TASKS_PER_PAGE)
  return (
    <div className="m-screen">
      <div className="m-screen-head">
        <div><p className="m-eyebrow">Selected project</p><h1 className="m-page-title">Task activity</h1></div>
        <button className="m-add" aria-label="New task" onClick={newTask}>+</button>
      </div>
      {shown.map((t) => (
        <article className="m-task" key={t.id}>
          <div className="m-task-top"><span className="m-row-seq">t{t.seq}</span><span className={`m-status m-status--${statusTone(t.landing ? 'landing' : t.status)}`}>{t.landing ? 'landing' : t.status.replace('_', ' ')}</span></div>
          <h2 className="m-row-title">{shortTitle(t.titleSummary, t.title)}</h2>
          <div className="m-task-facts">
            <span><small>Worker</small>{workerLabels[t.ranOn ?? t.constraints.workerId ?? t.assignee ?? ''] ?? t.ranOn ?? t.constraints.workerId ?? t.assignee ?? 'Automatic'}</span>
            <span><small>Model</small>{t.ranModel ?? t.constraints.model ?? 'Automatic'}</span>
            <span><small>Took</small>{duration(t.activeMs, t.activeSince, now)}</span>
            <span><small>Price</small>{price(t.budget.spentUsd, t.budget.spentUsdEstimated, t.budget.spentUsdPartial)}</span>
          </div>
          <div className="m-task-foot"><span>Updated {relTime(t.updatedAt, now)}</span><button className="m-open" onClick={() => openTask(t.id)}>Open <span aria-hidden="true">→</span></button></div>
        </article>
      ))}
      {tasks.length === 0 && <p className="m-empty">No tasks in this project.</p>}
      {tasks.length > 0 && <nav className="m-pager" aria-label="Task pages">
        <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</button>
        <span>{page + 1} / {pageCount} · {tasks.length} tasks</span>
        <button disabled={page + 1 >= pageCount} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next</button>
      </nav>}
    </div>
  )
}
