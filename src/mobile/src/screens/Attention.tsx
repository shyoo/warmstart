import { useCallback, useEffect, useState } from 'react'
import type { Approval, ProjectActivity, Question, Task } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { actionsFor, buildAttentionItems, itemSummary, type AttentionAction, type AttentionItem } from '../lib/attention.js'
import { activityTone, relTime } from '../lib/format.js'

/**
 * The reason this app exists: everything waiting on a person, newest first, answerable in place.
 * Approvals answer from the closed set; short choice questions answer inline; quota holds offer
 * override/stop/resume. Anything that needs the question in full — a `text` or `multi` question, an
 * option whose detail is the point, a task resting on a person — opens the task and is answered
 * there, beside the thread and beside Stop, Reassign and the rest.
 */
export function AttentionScreen({ refreshKey, projectId, openTask }: { refreshKey: number; projectId: string; openTask: (id: string) => void }): React.JSX.Element {
  const now = useNow()
  const [items, setItems] = useState<AttentionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [activity, setActivity] = useState<ProjectActivity[]>([])

  const refresh = useCallback(() => {
    if (!projectId) { setItems([]); setActivity([]); return }
    void Promise.all([rpc('approval.list', undefined), rpc('question.list', {}), rpc('task.list', { projectId }), rpc('project.activity', { projectId, limit: 200 })])
      .then(([approvals, questions, tasks, timeline]: [Approval[], Question[], Task[], ProjectActivity[]]) => {
        const ids = new Set(tasks.map((task) => task.id))
        setItems(buildAttentionItems(approvals.filter((item) => !!item.taskId && ids.has(item.taskId)), questions.filter((item) => !!item.taskId && ids.has(item.taskId)), tasks, Date.now()))
        setActivity(timeline)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [projectId])

  useEffect(refresh, [refresh, refreshKey])

  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not land. Try again.')
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const act = (item: AttentionItem, action: AttentionAction): Promise<void> => {
    if (action.type !== 'open-task' && !confirm(actionConfirmation(action))) return Promise.resolve()
    switch (action.type) {
      case 'approve':
        if (item.kind !== 'approval') return Promise.resolve()
        return run(`${item.approval.id}:allow`, () =>
          rpc('approval.answer', { id: item.approval.id, decision: action.decision })
        )
      case 'answer':
        if (item.kind !== 'question') return Promise.resolve()
        return run(`${item.question.id}:${action.optionIds.join(',')}`, () =>
          rpc('question.answer', { id: item.question.id, optionIds: action.optionIds })
        )
      case 'override':
        return run(`${action.taskId}:override`, () => rpc('task.overrideQuota', { id: action.taskId }))
      case 'stop':
        return run(`${action.taskId}:stop`, () => rpc('task.cancel', { id: action.taskId }))
      case 'resume':
        return run(`${action.taskId}:resume`, () => rpc('task.resume', { id: action.taskId }))
      case 'open-task':
        if (action.taskId) openTask(action.taskId)
        return Promise.resolve()
    }
  }

  return (
    <div className="m-screen">
      <section className="m-overview-section">
        <h1 className="m-page-title">Attention</h1>
      {error && <p className="m-error">{error}</p>}
      {!error && items.length === 0 && <p className="m-empty">Nothing is waiting on you.</p>}
      {items.map((item) => (
        <AttentionCard key={cardKey(item)} item={item} now={now} busy={busy} onAct={(a) => void act(item, a)} />
      ))}
      </section>
      <section className="m-overview-section">
        <h1 className="m-page-title">Activity</h1>
        <p className="m-hint">The latest {activity.length} durable events in this project.</p>
        {activity.map((entry) => <ActivityRow key={entry.id} entry={entry} now={now} openTask={openTask} />)}
        {!error && activity.length === 0 && <p className="m-empty">No activity yet.</p>}
      </section>
    </div>
  )
}

function actionConfirmation(action: AttentionAction): string {
  switch (action.type) {
    case 'stop': return 'Stop this task? It will be wound down into a resting state.'
    case 'override': return 'Override this quota gate and let the task continue?'
    case 'resume': return 'Resume this task now?'
    case 'approve': return `Confirm: ${action.label.toLowerCase()} this approval?`
    case 'answer': return `Confirm this answer: ${action.label}?`
    case 'open-task': return ''
  }
}

function cardKey(item: AttentionItem): string {
  switch (item.kind) {
    case 'approval':
      return `approval:${item.approval.id}`
    case 'question':
      return `question:${item.question.id}`
    case 'quota':
      return `quota:${item.task.id}`
    case 'human':
      return `human:${item.task.id}`
  }
}

function kindMark(kind: AttentionItem['kind']): string {
  switch (kind) {
    case 'approval':
      return '!'
    case 'question':
      return '?'
    case 'quota':
      return '%'
    case 'human':
      return '◷'
  }
}

function AttentionCard({
  item,
  now,
  busy,
  onAct
}: {
  item: AttentionItem
  now: number
  busy: string | null
  onAct: (action: AttentionAction) => void
}): React.JSX.Element {
  const actions = actionsFor(item)
  return (
    <section className="m-card">
      <div className="m-card-head">
        <span className={`m-mark m-mark--${item.kind}`}>{kindMark(item.kind)}</span>
        <p className="m-card-title">{itemSummary(item)}</p>
      </div>
      <p className="m-meta">
        {item.kind === 'question' && item.question.header ? `${item.question.header} · ` : ''}
        {item.kind === 'question' && item.question.parkedAt ? 'parked · ' : ''}
        waiting {relTime(item.at, now)}
      </p>
      {(item.kind === 'human' || item.kind === 'quota') && <p className="m-detail">{item.task.holdReason ?? `Status: ${item.task.status.replace('_', ' ')}`}</p>}
      <div className="m-actions">
        {actions.map((action) => (
          <ActionButton
            key={action.label}
            action={action}
            only={actions.length === 1}
            disabled={busy !== null || (action.type === 'open-task' && !action.taskId)}
            onPress={() => onAct(action)}
          />
        ))}
      </div>
      {busy && <p className="m-meta">Working…</p>}
    </section>
  )
}

function ActivityRow({ entry, now, openTask }: { entry: ProjectActivity; now: number; openTask: (id: string) => void }): React.JSX.Element {
  // ⚠️ One line, time first: the two-line row with the title, duration and price repeated the
  // task card below it. The title, timing and cost live one tap away on the task page.
  const event = entry.kind === 'filed'
    ? 'filed'
    : entry.kind === 'run_started'
      ? 'run started'
      : entry.kind === 'run_finished'
        ? 'run finished'
        : entry.kind === 'completed'
          ? 'run completed'
          : (entry.status ?? 'changed').replace(/_/g, ' ')
  return <button className={`m-activity m-activity--${activityTone(entry.kind, entry.status)}`} onClick={() => openTask(entry.taskId)}>
    <span className="m-activity-time">{relTime(entry.at, now)}</span>
    <span className="m-activity-body"><strong>t{entry.taskSeq}</strong> <span className="m-activity-event">{event}.</span></span>
  </button>
}

function ActionButton({
  action,
  disabled,
  only,
  onPress
}: {
  action: AttentionAction
  disabled: boolean
  /** This card offers exactly one thing to press. */
  only: boolean
  onPress: () => void
}): React.JSX.Element {
  // ⚠️ `only` carries the resting-task card, where the door *is* the action: nothing else on it
  // can be pressed, so drawing it as a secondary control would leave the card with no primary.
  const primary = only || action.type === 'approve' || action.type === 'answer' || action.type === 'override'
  const danger = (action.type === 'approve' && action.decision === 'deny') || action.type === 'stop'
  return (
    <button
      className={`m-btn${primary ? ' m-btn--primary' : ''}${danger ? ' m-btn--danger' : ''}`}
      disabled={disabled}
      onClick={onPress}
    >
      {action.label}
    </button>
  )
}
