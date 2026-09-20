import { useCallback, useEffect, useState } from 'react'
import type { ModelOptions, RpcResult } from '@shared/protocol'
type FleetList = RpcResult<'fleet.list'>
import type { FinishPolicy, PendingWork, Question, Run, Task, TaskMessage, WorkspaceMode } from '@shared/tasks'
import type { Session } from '@shared/protocol'
import { sessionEnded } from '@shared/protocol'
import { tokens } from '@renderer/lib/format.js'
import { RemoteError, rpc } from '../api.js'
import { Decide } from '../components/Decide.js'
import { QuestionCard } from '../components/QuestionCard.js'
import { useNow } from '../hooks.js'
import { duration, price, relTime, statusTone } from '../lib/format.js'
import { commitLevelFor, openQuestions } from '../lib/question.js'

/**
 * One task as a reading view: current state, every open question in full, what a person can do
 * about it, legible history, a reply box, and the priority control. Not a port of the desktop
 * thread — no transcript, no terminal, no diff.
 *
 * ⛔ **This is where a question is answered.** The Attention list can take a short closed choice
 * where it stands and sends everything else here, so the question, its options, the asker's own
 * prose about each one and the free-text box all have to be on this page. Before that they were
 * nowhere on the phone at all: a task resting on an unanswered question offered one button,
 * *Resolve*, which marks it done and throws the question away.
 */
export function TaskDetailScreen({ id, refreshKey }: { id: string; refreshKey: number }): React.JSX.Element {
  const now = useNow()
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [pending, setPending] = useState<PendingWork | null>(null)
  const [inheritedFinish, setInheritedFinish] = useState<{ policy: FinishPolicy } | null>(null)
  const [inheritedMode, setInheritedMode] = useState<WorkspaceMode | undefined>(undefined)
  const [questions, setQuestions] = useState<Question[]>([])
  const [fleet, setFleet] = useState<FleetList | null>(null)
  const [models, setModels] = useState<ModelOptions[]>([])
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void Promise.all([
      rpc('task.get', { id }),
      rpc('fleet.list', undefined),
      rpc('model.options', undefined),
      rpc('question.forTask', { taskId: id }),
      rpc('task.pendingWork', { id }).catch(() => null)
    ])
      .then(([got, f, m, asked, pendingWork]) => {
        if (!got) {
          setError('That task is gone.')
          return
        }
        setTask(got.task)
        setMessages(got.messages)
        setRuns(got.runs)
        setSessions(got.sessions)
        // ⚠️ A tree that cannot be read is not a tree with nothing in it: a failed read keeps
        // whatever the last successful one said rather than flipping Commit off and on.
        if (pendingWork) setPending(pendingWork)
        setInheritedFinish(got.inheritedFinish ?? null)
        setInheritedMode(got.inheritedWorkspaceMode)
        setFleet(f)
        setModels(m)
        setQuestions(asked)
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

  // ⚠️ A settled task keeps its rows; answering into one would reach nobody. The desktop's rule.
  const open =
    task.status === 'completed' || task.status === 'cancelled' ? [] : openQuestions(questions)
  const workerLabels = Object.fromEntries((fleet ?? []).map((entry) => [entry.worker.id, entry.worker.label]))
  const liveSession = sessions.find((s) => s.state === 'live' && !sessionEnded(s.state)) ?? null
  const curWorkerId = liveSession?.workerId ?? task.ranOn ?? null
  const nextWorkerId = task.constraints.workerId ?? (task.assignee && task.assignee !== 'human' ? task.assignee : null)
  const workerLabel = (id: string | null): string | null =>
    id ? (workerLabels[id] ?? id) : null
  const curWorker = workerLabel(curWorkerId)
  const nextWorker = workerLabel(nextWorkerId)
  const curModel = liveSession?.model ?? task.ranModel ?? runs[0]?.model ?? null
  const nextModel =
    task.constraints.model ?? (task.constraints.modelPolicy === 'auto' ? 'Automatic' : 'Worker default')
  const spentTokens = runs.reduce(
    (sum, run) => sum + run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens,
    0
  )
  return (
    <div className="m-screen">
      <section className="m-card">
        <h2 className="m-task-title">
          <span className="m-task-seq">t{task.seq}</span>
          <span className="m-task-sep" aria-hidden="true">|</span> {task.titleSummary ?? task.title}
        </h2>
        <p className="m-task-sub">
          <span className={`m-status m-status--${statusTone(task.landing ? 'landing' : task.status)}`}>
            {task.landing ? 'landing' : task.status.replace(/_/g, ' ')}
          </span>
          {task.branch && <span className="m-branch">{task.branch}</span>}
        </p>
        {task.holdReason && <p className="m-warn">{task.holdReason}</p>}
      </section>

      <section className="m-card">
        <dl className="m-details">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`m-status m-status--${statusTone(task.landing ? 'landing' : task.status)}`}>
                {task.landing ? 'landing' : task.status.replace(/_/g, ' ')}
              </span>
            </dd>
          </div>
          <div>
            <dt>Worker</dt>
            <dd>{curWorker ? (nextWorker && nextWorker !== curWorker ? `${curWorker} → ${nextWorker}` : curWorker) : (nextWorker ?? 'Automatic')}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{curModel ? (curModel !== nextModel ? `${curModel} → ${nextModel}` : curModel) : nextModel}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>{price(task.budget.spentUsd, task.budget.spentUsdEstimated, task.budget.spentUsdPartial)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{runs.length > 0 ? tokens(spentTokens) : '—'}</dd>
          </div>
          <div>
            <dt>Took</dt>
            <dd>{duration(task.activeMs, task.activeSince, now)}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              <select
                className="m-input m-input--inline"
                value={task.priority}
                disabled={busy}
                aria-label="Priority"
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
            </dd>
          </div>
        </dl>
      </section>

      {open.map((question) => (
        <QuestionCard key={question.id} question={question} onAnswered={refresh} />
      ))}

      <Decide
        task={task}
        fleet={fleet ?? []}
        modelOptions={models}
        now={now}
        pending={pending}
        commitLevel={commitLevelFor(task, inheritedFinish, inheritedMode)}
        onChanged={refresh}
      />

      <section className="m-history">
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
        {open.length > 0 && (
          // ⛔ A reply is not an answer. An open question is held by the tool call that asked it,
          // and prose on the thread does not release it — the card above is what does.
          <p className="m-meta">
            A reply goes on the thread. The question above is still waiting on its own answer.
          </p>
        )}
      </section>
    </div>
  )
}
