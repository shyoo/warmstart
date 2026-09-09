import { useCallback, useEffect, useState } from 'react'
import type { Approval, Question, Task } from '@shared/tasks'
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { actionsFor, buildAttentionItems, itemSummary, type AttentionAction, type AttentionItem } from '../lib/attention.js'
import { relTime } from '../lib/format.js'

/**
 * The reason this app exists: everything waiting on a person, newest first, answerable in place.
 * Approvals answer from the closed set; short choice questions answer inline; quota holds offer
 * override/stop/resume; resting tasks offer resolve. Anything needing context opens the thread.
 */
export function AttentionScreen({ refreshKey, openTask }: { refreshKey: number; openTask: (id: string) => void }): React.JSX.Element {
  const now = useNow()
  const [items, setItems] = useState<AttentionItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void Promise.all([rpc('approval.list', undefined), rpc('question.list', {}), rpc('task.list', undefined)])
      .then(([approvals, questions, tasks]: [Approval[], Question[], Task[]]) => {
        setItems(buildAttentionItems(approvals, questions, tasks, Date.now()))
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [])

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
      case 'resolve':
        return run(`${action.taskId}:resolve`, () => rpc('task.resolve', { id: action.taskId }))
      case 'open-task':
        if (action.taskId) openTask(action.taskId)
        return Promise.resolve()
    }
  }

  return (
    <div className="m-screen">
      {error && <p className="m-error">{error}</p>}
      {!error && items.length === 0 && <p className="m-empty">Nothing is waiting on you.</p>}
      {items.map((item) => (
        <AttentionCard key={cardKey(item)} item={item} now={now} busy={busy} onAct={(a) => void act(item, a)} />
      ))}
    </div>
  )
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
      <div className="m-actions">
        {actions.map((action) => (
          <ActionButton
            key={action.label}
            action={action}
            disabled={busy !== null || (action.type === 'open-task' && !action.taskId)}
            onPress={() => onAct(action)}
          />
        ))}
      </div>
      {busy && <p className="m-meta">Working…</p>}
    </section>
  )
}

function ActionButton({
  action,
  disabled,
  onPress
}: {
  action: AttentionAction
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  const primary = action.type === 'approve' || action.type === 'answer' || action.type === 'override' || action.type === 'resolve'
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
