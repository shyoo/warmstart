import { useCallback, useEffect, useState } from 'react'
import type { ModelOptions, RpcResult } from '@shared/protocol'
type FleetList = RpcResult<'fleet.list'>
import type { Task, TaskMessage } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { relTime } from '../lib/format.js'

/**
 * One task as a reading view: current state, legible history, a reply box, and the worker /
 * model / priority controls. Not a port of the desktop thread — no transcript, no terminal.
 */
export function TaskDetailScreen({ id, refreshKey }: { id: string; refreshKey: number }): React.JSX.Element {
  const now = useNow()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [fleet, setFleet] = useState<FleetList | null>(null)
  const [models, setModels] = useState<ModelOptions[]>([])
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void Promise.all([
      rpc('task.get', { id }),
      rpc('fleet.list', undefined),
      rpc('model.options', undefined)
    ])
      .then(([got, f, m]) => {
        if (!got) {
          setError('That task is gone.')
          return
        }
        setTask(got.task)
        setMessages(got.messages)
        setFleet(f)
        setModels(m)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [id])

  useEffect(refresh, [refresh, refreshKey])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      setReply('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not land. Try again.')
    } finally {
      setBusy(false)
      refresh()
    }
  }

  if (error) return <p className="m-error m-screen">{error}</p>
  if (!task) return <p className="m-empty m-screen">Reading the thread…</p>

  const workerId = task.constraints.workerId ?? task.assignee ?? ''
  return (
    <div className="m-screen">
      <section className="m-card">
        <p className="m-meta">
          t{task.seq} · {task.status}
          {task.branch ? ` · ${task.branch}` : ''}
        </p>
        <h2 className="m-card-title m-card-title--large">{task.titleSummary ?? task.title}</h2>
        {task.holdReason && <p className="m-warn">{task.holdReason}</p>}
        {task.status === 'awaiting_human' && (
          <div className="m-actions">
            <button className="m-btn m-btn--primary" disabled={busy} onClick={() => void act(() => rpc('task.resolve', { id: task.id }))}>
              Resolve
            </button>
          </div>
        )}
      </section>

      <section className="m-card">
        <label className="m-field">
          <span>Worker</span>
          <select
            className="m-input"
            value={workerId}
            disabled={busy}
            onChange={(e) => void act(() => rpc('task.setWorker', { id: task.id, workerId: e.target.value || null }))}
          >
            <option value="">Automatic</option>
            {(fleet ?? []).map((w) => (
              <option key={w.worker.id} value={w.worker.id}>
                {w.worker.label}
              </option>
            ))}
          </select>
        </label>
        <label className="m-field">
          <span>Model</span>
          <select
            className="m-input"
            value={task.constraints.model ?? ''}
            disabled={busy}
            onChange={(e) =>
              void act(() => rpc('task.setModel', { id: task.id, model: e.target.value || null, effort: null }))
            }
          >
            <option value="">Automatic</option>
            {models.flatMap((o) =>
              o.models.map((m) => (
                <option key={`${o.adapterId}:${m.id}`} value={m.id}>
                  {o.adapterId} · {m.id}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="m-field">
          <span>Priority</span>
          <select
            className="m-input"
            value={task.priority}
            disabled={busy}
            onChange={(e) =>
              void act(() => rpc('task.setPriority', { id: task.id, priority: e.target.value as Task['priority'] }))
            }
          >
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="m-card">
        <h3 className="m-section-title">History</h3>
        {messages.map((m) => (
          <div className={`m-message m-message--${m.role}`} key={m.id}>
            <div className="m-message-bubble"><p className="m-message-text">{m.text}</p></div>
            <p className="m-meta">{relTime(m.ts, now)} {m.detail && <details className="m-detail"><summary>ⓘ</summary><span>{m.detail}</span></details>}</p>
          </div>
        ))}
        {messages.length === 0 && <p className="m-empty">No messages yet.</p>}
      </section>

      <section className="m-card">
        <label className="m-field">
          <span>Reply</span>
          <textarea
            className="m-input m-textarea"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write back to the thread…"
            rows={3}
          />
        </label>
        <button
          className="m-btn m-btn--primary"
          disabled={busy || reply.trim().length === 0}
          onClick={() => void act(() => rpc('task.message', { id: task.id, text: reply.trim() }))}>
          Send reply
        </button>
      </section>
    </div>
  )
}
