import { useCallback, useEffect, useState } from 'react'
import type { Project, Run, Task, TaskMessage } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { tokens } from '../lib/format'

/**
 * The task table.
 *
 * Tabular and dense on purpose — this is a control surface, not a board. The columns are what an
 * operator actually needs to decide something: who filed it, who is on it, what it is waiting for,
 * and what it has spent.
 *
 * ⛔ Cancel is not delete. Cancel is a row action that winds the work down into a resting state and
 * destroys nothing; delete sits behind the row menu, refuses while anything depends on the task, and
 * never removes the runs.
 */

const STATUS_TONE: Record<string, string> = {
  running: 'state-running',
  ready: 'state-ok',
  completed: 'state-ok',
  failed: 'state-danger',
  awaiting_human: 'state-human',
  blocked: 'state-idle',
  scheduled: 'state-idle',
  draft: 'state-idle',
  paused_user: 'state-warn',
  paused_quota: 'state-warn',
  cancelling: 'state-warn',
  cancelled: 'state-idle'
}

export function Tasks({ projects }: { projects: Project[] }): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ task: Task; messages: TaskMessage[]; runs: Run[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    setTasks(await rpc('task.list', {}))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    void rpc('task.get', { id: selected }).then(setDetail)
  }, [selected, tasks])

  useDaemonEvents((event) => {
    if (event.type === 'task.changed' || event.type === 'run.changed') void refresh()
  })

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    await refresh()
  }

  const remove = async (task: Task) => {
    const blockers = await rpc('task.deleteCheck', { id: task.id })
    if (!blockers.ok) {
      setError(`Cannot delete t${task.seq}:\n${blockers.reasons.map((r) => `• ${r}`).join('\n')}`)
      return
    }
    await act(() => rpc('task.delete', { id: task.id }))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Tasks</h2>
          <p className="panel-sub">
            A task is a thread of work with an assignee — not a prompt. Anyone can file one: you, the
            controller, or an agent mid-run.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'New task'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {adding && (
        <NewTask
          projects={projects}
          onDone={async () => {
            setAdding(false)
            await refresh()
          }}
          onError={setError}
        />
      )}

      {tasks.length === 0 ? (
        <div className="empty-inline">
          <p>No tasks yet.</p>
          <p className="dim">
            File one and the scheduler will route it to a worker that can afford it, in a workspace of
            its own, on a branch named after the task.
          </p>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="tbl-num">#</th>
              <th>Title</th>
              <th>Status</th>
              <th>From</th>
              <th>Dep</th>
              <th className="tbl-num">Spent</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className={selected === task.id ? 'tbl-row--selected' : ''}
                onClick={() => setSelected(task.id === selected ? null : task.id)}
              >
                <td className="num tbl-num">{task.seq}</td>
                <td>
                  <span className="tbl-strong">
                    {task.lineageDepth > 0 && <span className="dim">{'└ '}</span>}
                    {task.title.length > 70 ? `${task.title.slice(0, 70)}…` : task.title}
                  </span>
                  {task.branch && <div className="tbl-path mono">{task.branch}</div>}
                </td>
                <td>
                  <span className={`status ${STATUS_TONE[task.status] ?? ''}`}>{task.status}</span>
                </td>
                <td className="dim">
                  {task.createdBy.kind === 'human'
                    ? 'you'
                    : task.createdBy.kind === 'controller'
                      ? 'ctrl'
                      : 'agent'}
                </td>
                <td className="num dim">{task.dependsOn.length ? `←${task.dependsOn.length}` : '—'}</td>
                <td className="num tbl-num">{tokens(task.budget.spentTokens || null)}</td>
                <td className="tbl-actions" onClick={(e) => e.stopPropagation()}>
                  {CANCELLABLE.has(task.status) && (
                    <button
                      className="btn btn--ghost"
                      title="Stop the work and return this task to a resting state. Destroys nothing."
                      onClick={() => void act(() => rpc('task.cancel', { id: task.id }))}
                    >
                      Cancel
                    </button>
                  )}
                  {(task.status === 'paused_user' || task.status === 'cancelled') && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => void act(() => rpc('task.resume', { id: task.id }))}
                    >
                      Resume
                    </button>
                  )}
                  {task.status === 'draft' && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => void act(() => rpc('task.promote', { id: task.id }))}
                    >
                      Queue
                    </button>
                  )}
                  <button
                    className="btn btn--ghost btn--danger"
                    title="Delete. Runs are kept either way — they are the record of what this cost."
                    onClick={() => void remove(task)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && <TaskDetail detail={detail} />}
    </div>
  )
}

const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota'
])

function TaskDetail({
  detail
}: {
  detail: { task: Task; messages: TaskMessage[]; runs: Run[] }
}): React.JSX.Element {
  const { task, messages, runs } = detail
  return (
    <section className="detail">
      <h3>
        t{task.seq} · {task.title}
      </h3>
      <div className="detail-meta num">
        <span>{task.status}</span>
        <span>priority {task.priority}</span>
        {task.branch && <span className="mono">{task.branch}</span>}
        <span>
          mandate: {task.mandate.allowed.join(', ')} · depth {task.lineageDepth}/
          {task.mandate.maxLineageDepth}
        </span>
      </div>

      <div className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`}>
            <span className="msg-role">{m.role}</span>
            <span className="msg-text">{m.text}</span>
          </div>
        ))}
      </div>

      {runs.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Run</th>
              <th>Outcome</th>
              <th className="tbl-num">In</th>
              <th className="tbl-num">Out</th>
              <th className="tbl-num">Cache read</th>
              <th className="tbl-num">Cache write</th>
              <th>Quota</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td className="mono">{run.id.slice(0, 8)}</td>
                <td className="dim">{run.outcome ?? 'running'}</td>
                <td className="num tbl-num">{tokens(run.inputTokens)}</td>
                <td className="num tbl-num">{tokens(run.outputTokens)}</td>
                <td className="num tbl-num">{tokens(run.cacheReadTokens)}</td>
                <td className="num tbl-num">{tokens(run.cacheWriteTokens)}</td>
                <td>
                  {run.quotaUnverified ? (
                    <span className="warn" title="Dispatched without a trustworthy quota reading.">
                      unverified
                    </span>
                  ) : (
                    <span className="dim">checked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function NewTask({
  projects,
  onDone,
  onError
}: {
  projects: Project[]
  onDone: () => void | Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2')
  const [verification, setVerification] = useState<'auto' | 'required'>('auto')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await rpc('task.create', {
        title: title.trim(),
        projectId: projectId || null,
        priority,
        verification
      })
      setTitle('')
      await onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form">
      <div className="form-row">
        <label>What</label>
        <input
          className="form-wide"
          value={title}
          placeholder="Describe the work as you would to a colleague"
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className="form-hint">
          This is the prompt the agent receives, prefixed by any handoff from an earlier run.
        </span>
      </div>
      <div className="form-row">
        <label>Project</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">none — runs without a workspace</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="form-hint">
          A git project gets a pooled worktree and a branch named after the task. Agents never work in
          the trunk.
        </span>
      </div>
      <div className="form-row">
        <label>Policy</label>
        <div>
          <select value={priority} onChange={(e) => setPriority(e.target.value as 'P2')}>
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={verification === 'required'}
              onChange={(e) => setVerification(e.target.checked ? 'required' : 'auto')}
            />
            I want to check this before it lands
          </label>
        </div>
        <span className="form-hint">
          Requiring verification stops auto-landing: the branch is kept and the task waits for you.
        </span>
      </div>
      <div className="form-actions">
        <button className="btn btn--primary" disabled={saving || !title.trim()} onClick={() => void submit()}>
          {saving ? 'Filing…' : 'File task'}
        </button>
      </div>
    </div>
  )
}
