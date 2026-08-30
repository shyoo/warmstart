import { useCallback, useEffect, useState } from 'react'
import type { Approval, Question } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { cacheUrgency, countdown } from '../lib/format'
import { QuestionCard } from './Questions'

/**
 * The Attention bar.
 *
 * ⛔ Two different things live here and they are **not** the same shape. An **approval** is a verdict
 * from a closed set — allow, always, deny — and it can be answered without leaving whatever you were
 * doing. A **question** has an answer set the agent wrote, and where its options are few and short
 * they are offered here too; where they are not, this says what is being asked and sends you to the
 * task, because a design decision with three paragraphs of rationale is not a strip.
 *
 * ⚠️ Both were previously invisible in different ways. An approval had this bar; a question had
 * nothing at all — `request_human` could only come back allow/deny, so a question was *rendered* as
 * an approval and its answer set was destroyed on the way in.
 *
 * It is empty almost always. That is the design goal, not a shortfall: most approvals are absorbed by
 * the agent's own mode, and most of the rest are answered by a remembered rule. A question is never
 * absorbed by anything, which is exactly why it is worth interrupting for.
 *
 * The countdown is not decoration. A blocked session is idle, and idle burns the prompt cache — past
 * that clock, resuming this session costs a full cold rebuild instead of a cheap read.
 */
type Item =
  | { kind: 'approval'; at: number; approval: Approval }
  | { kind: 'question'; at: number; question: Question }

/** Short enough to read on one line, few enough to fit beside the clock. Otherwise: open the task. */
function answerableHere(question: Question): boolean {
  return (
    question.kind === 'choice' &&
    question.options.length > 0 &&
    question.options.length <= 3 &&
    question.options.every((o) => o.label.length <= 30)
  )
}

export function Attention({
  now,
  onOpenTask
}: {
  now: number
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element | null {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void rpc('approval.list').then(setApprovals)
    void rpc('question.list').then(setQuestions)
  }, [])

  useEffect(refresh, [refresh])
  useDaemonEvents((event) => {
    if (
      event.type === 'approval.opened' ||
      event.type === 'approval.answered' ||
      event.type === 'question.opened' ||
      event.type === 'question.answered' ||
      event.type === 'question.parked'
    ) {
      refresh()
    }
  })

  // ⛔ Oldest first, across both. Whoever has been waiting longest is the one whose session is
  // closest to going cold, and interleaving by type would let a fresh approval jump a question that
  // has been holding a worker for ten minutes.
  const items: Item[] = [
    ...approvals.map((approval) => ({ kind: 'approval' as const, at: approval.askedAt, approval })),
    ...questions.map((question) => ({ kind: 'question' as const, at: question.askedAt, question }))
  ].sort((a, b) => a.at - b.at)

  const current = items[0]
  if (!current) return null

  const answerApproval = async (decision: 'allow' | 'allow_always' | 'deny'): Promise<void> => {
    if (current.kind !== 'approval') return
    setBusy(current.approval.id)
    try {
      await rpc('approval.answer', { id: current.approval.id, decision })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const deadlineAt =
    current.kind === 'approval' ? current.approval.deadlineAt : current.question.deadlineAt
  const summary =
    current.kind === 'approval'
      ? current.approval.summary
      : (current.question.header ? `${current.question.header} — ` : '') + current.question.question

  return (
    <div className={`approvals${current.kind === 'question' ? ' approvals--question' : ''}`}>
      <span className="approvals-mark">{current.kind === 'question' ? '?' : '!'}</span>
      <span className="approvals-what mono" title={summary}>
        {summary}
      </span>
      {current.kind === 'approval' && current.approval.escalatedAt && (
        <span className="tag tag--human">waiting on you</span>
      )}
      {current.kind === 'question' && current.question.parkedAt && (
        <span className="tag tag--human">parked</span>
      )}
      <span className={`num approvals-clock approvals-clock--${cacheUrgency(deadlineAt, now)}`}>
        {deadlineAt ? countdown(deadlineAt, now) : '--:--'}
      </span>
      <span className="approvals-actions">
        {current.kind === 'approval' ? (
          <>
            <button
              className="btn"
              disabled={busy === current.approval.id}
              onClick={() => void answerApproval('allow')}
            >
              Allow
            </button>
            <button
              className="btn btn--ghost"
              disabled={busy === current.approval.id}
              onClick={() => void answerApproval('allow_always')}
              title="Remember this as a rule, so the next one is answered without asking."
            >
              Always
            </button>
            <button
              className="btn btn--ghost btn--danger"
              disabled={busy === current.approval.id}
              onClick={() => void answerApproval('deny')}
            >
              Deny
            </button>
          </>
        ) : answerableHere(current.question) ? (
          <QuestionCard question={current.question} onAnswered={refresh} compact />
        ) : (
          // ⛔ Never a text box in the strip. An open question deserves the room to answer it in,
          // and the task is where the thread that makes it answerable already is.
          <button
            className="btn btn--primary"
            disabled={!current.question.taskId}
            title={
              current.question.taskId
                ? 'Open the task and answer it there'
                : 'This question belongs to no task — answer it from the session it came from'
            }
            onClick={() => current.question.taskId && onOpenTask?.(current.question.taskId)}
          >
            Answer…
          </button>
        )}
      </span>
      {items.length > 1 && <span className="num approvals-more">+{items.length - 1} more</span>}
    </div>
  )
}
