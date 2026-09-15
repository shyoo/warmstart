import { useCallback, useEffect, useState } from 'react'
import type { ModelOptions, RpcResult } from '@shared/protocol'
type FleetList = RpcResult<'fleet.list'>
import type { Question, Task, TaskMessage } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'
import { Decide } from '../components/Decide.js'
import { QuestionCard } from '../components/QuestionCard.js'
import { useNow } from '../hooks.js'
import { relTime } from '../lib/format.js'
import { openQuestions } from '../lib/question.js'

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
      rpc('question.forTask', { taskId: id })
    ])
      .then(([got, f, m, asked]) => {
        if (!got) {
          setError('That task is gone.')
          return
        }
        setTask(got.task)
        setMessages(got.messages)
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
  return (
    <div className="m-screen">
      <section className="m-card">
        <p className="m-meta">
          t{task.seq} · {task.landing ? 'landing' : task.status}
          {task.branch ? ` · ${task.branch}` : ''}
        </p>
        <h2 className="m-card-title m-card-title--large">{task.titleSummary ?? task.title}</h2>
        {task.holdReason && <p className="m-warn">{task.holdReason}</p>}
      </section>

      {open.map((question) => (
        <QuestionCard key={question.id} question={question} onAnswered={refresh} />
      ))}

      <Decide task={task} fleet={fleet ?? []} modelOptions={models} now={now} onChanged={refresh} />

      <section className="m-card">
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
