import { useCallback, useEffect, useState } from 'react'
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { relTime } from '../lib/format.js'

/**
 * The task list, already filtered server-side to remote-enabled projects.
 *
 * ⛔ `task.list`, not `task.page`. Paging is refused over remote access because a page is sliced
 * in SQLite *before* the project filter can run, so a page of tasks the phone may not see arrives
 * empty with a `total` counting rows it was never allowed to know about. Sorting the newest fifty
 * here is honest and this list does not paginate.
 */
const SHOWN = 50

export function TasksScreen({ refreshKey, openTask }: { refreshKey: number; openTask: (id: string) => void }): React.JSX.Element {
  const now = useNow()
  const [tasks, setTasks] = useState<Array<{ id: string; seq: number; title: string; status: string; updatedAt: number }>>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void rpc('task.list', undefined)
      .then((all) => {
        setTasks(
          [...all]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, SHOWN)
            .map((t) => ({ id: t.id, seq: t.seq, title: t.titleSummary ?? t.title, status: t.status, updatedAt: t.updatedAt }))
        )
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [])

  useEffect(refresh, [refresh, refreshKey])

  if (error) return <p className="m-error m-screen">{error}</p>

  return (
    <div className="m-screen">
      {tasks.map((t) => (
        <button className="m-row" key={t.id} onClick={() => openTask(t.id)}>
          <span className="m-row-seq">t{t.seq}</span>
          <span className="m-row-body">
            <span className="m-row-title">{t.title}</span>
            <span className="m-meta">
              {t.status} · {relTime(t.updatedAt, now)}
            </span>
          </span>
        </button>
      ))}
      {tasks.length === 0 && <p className="m-empty">No tasks in remote projects.</p>}
    </div>
  )
}
