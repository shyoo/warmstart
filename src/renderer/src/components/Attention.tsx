import { useCallback, useEffect, useState } from 'react'
import type { Approval, Question, Task } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { cacheUrgency, countdown, duration } from '../lib/format'
import { isQuotaGated } from '../lib/taskview'
import {
  isQuotaAlertDismissed,
  prunedQuotaAlerts,
  readQuotaAlertDismissals,
  withQuotaAlertDismissed,
  writeQuotaAlertDismissals,
  type QuotaAlertDismissals
} from '../lib/quotaalerts'
import { QuestionCard } from './Questions'

/**
 * The Attention bar.
 *
 * ⛔ Three different things live here:
 * 1. An **approval** is a verdict from a closed set — allow, always, deny — answerable without leaving.
 * 2. A **question** has an answer set the agent wrote, answered here if choices are few and short, or on the task.
 * 3. A **quota gate** hold or preemption warning: lets the operator override the gate in one click or view the thread.
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
  | { kind: 'quota'; at: number; task: Task }

/** Short enough to read on one line, few enough to fit beside the clock. Otherwise: open the task. */
function answerableHere(question: Question): boolean {
  const fullQuestion = (question.header ? `${question.header} — ` : '') + question.question
  return (
    question.kind === 'choice' &&
    question.options.length > 0 &&
    question.options.length <= 3 &&
    question.options.every((o) => o.label.length <= 30) &&
    // ⛔ The banner line truncates with an ellipsis (`.approvals-what`), so a long question is
    // never actually readable there. Offering answer buttons beside an unreadable question would
    // let the operator pick blind — this belongs on the task, where the full question is visible.
    fullQuestion.length <= 100
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
  const [gatedTasks, setGatedTasks] = useState<Task[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // ⚠️ Read once, from `localStorage`: a quota park lasts hours and the operator who dismissed it
  // was very likely in a different run of the app. See `quotaalerts.ts`.
  const [dismissed, setDismissed] = useState<QuotaAlertDismissals>(() => readQuotaAlertDismissals())

  const refresh = useCallback(() => {
    void rpc('approval.list').then(setApprovals)
    void rpc('question.list').then(setQuestions)
    void rpc('task.list')
      .then((all) => {
        const gated = all.filter((t) => isQuotaGated(t, Date.now()))
        setGatedTasks(gated)
        // ⛔ Pruned against what is *actually* gated now, so a task released by its window reset
        // gets a fresh interruption the next time it hits one.
        setDismissed((held) => {
          const kept = prunedQuotaAlerts(held, gated)
          if (Object.keys(kept).length !== Object.keys(held).length) writeQuotaAlertDismissals(kept)
          return kept
        })
      })
      .catch(() => setGatedTasks([]))
  }, [])

  const dismissQuota = (task: Task): void => {
    setDismissed((held) => {
      const next = withQuotaAlertDismissed(held, task)
      writeQuotaAlertDismissals(next)
      return next
    })
  }

  useEffect(refresh, [refresh])
  useDaemonEvents((event) => {
    if (
      event.type === 'approval.opened' ||
      event.type === 'approval.answered' ||
      event.type === 'question.opened' ||
      event.type === 'question.answered' ||
      event.type === 'question.parked' ||
      event.type === 'task.changed' ||
      event.type === 'quota.changed'
    ) {
      refresh()
    }
  })

  // ⛔ Oldest first, across all kinds. Whoever has been waiting longest is the one whose session is
  // closest to going cold, and interleaving by type would let a fresh approval jump a question that
  // has been holding a worker for ten minutes.
  const items: Item[] = [
    ...approvals.map((approval) => ({ kind: 'approval' as const, at: approval.askedAt, approval })),
    ...questions.map((question) => ({ kind: 'question' as const, at: question.askedAt, question })),
    // ⛔ Dismissed alerts are dropped here rather than merely skipped for the top slot: they must
    // not be counted by `+N more` either. A task somebody has told this bar to stop raising is not
    // one of the things waiting on them.
    ...gatedTasks
      .filter((task) => !isQuotaAlertDismissed(task, dismissed))
      .map((task) => ({
        kind: 'quota' as const,
        at: task.quotaPreemptWarning ? task.quotaPreemptWarning.preemptAt - 60_000 : task.updatedAt,
        task
      }))
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

  const answerQuota = async (taskId: string): Promise<void> => {
    setBusy(taskId)
    try {
      await rpc('task.overrideQuota', { id: taskId })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const deadlineAt =
    current.kind === 'approval'
      ? current.approval.deadlineAt
      : current.kind === 'question'
        ? current.question.deadlineAt
        : current.task.quotaPreemptWarning
          ? current.task.quotaPreemptWarning.preemptAt
          : current.task.holdUntil ?? current.task.notBefore ?? null
  const summary =
    current.kind === 'approval'
      ? current.approval.summary
      : current.kind === 'question'
        ? (current.question.header ? `${current.question.header} — ` : '') + current.question.question
        : current.task.quotaPreemptWarning
          ? `t${current.task.seq}: Quota preemption in ${duration(Math.max(0, current.task.quotaPreemptWarning.preemptAt - now))} — ${current.task.quotaPreemptWarning.reason}`
          : current.task.status === 'paused_quota'
            ? `t${current.task.seq}: Preempted on quota — ${current.task.holdReason ?? 'needs quota override or reset'}`
            : `t${current.task.seq}: Quota gate — ${current.task.holdReason ?? 'held on quota'}`

  return (
    <div
      className={`approvals${current.kind === 'question' ? ' approvals--question' : current.kind === 'quota' ? ' approvals--quota' : ''}`}
    >
      <span className="approvals-mark">
        {current.kind === 'question' ? '?' : current.kind === 'quota' ? '%' : '!'}
      </span>
      <span
        className="approvals-what mono"
        title={summary}
        style={current.kind === 'quota' && current.task.id ? { cursor: 'pointer' } : undefined}
        onClick={() => {
          if (current.kind === 'quota') onOpenTask?.(current.task.id)
        }}
      >
        {summary}
      </span>
      {current.kind === 'approval' && current.approval.escalatedAt && (
        <span className="tag tag--human">waiting on you</span>
      )}
      {current.kind === 'question' && current.question.parkedAt && (
        <span className="tag tag--human">parked</span>
      )}
      {current.kind === 'quota' && (
        <span className="tag tag--warn">
          {current.task.status === 'paused_quota'
            ? 'paused quota'
            : current.task.status === 'running'
              ? 'preempting'
              : 'quota gate'}
        </span>
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
        ) : current.kind === 'question' ? (
          answerableHere(current.question) ? (
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
          )
        ) : (
          <>
            <button
              className="btn btn--warn"
              disabled={busy === current.task.id}
              title="Override the quota gate and continue immediately."
              onClick={() => void answerQuota(current.task.id)}
            >
              {current.task.status === 'paused_quota'
                ? 'Override & continue'
                : current.task.status === 'running'
                  ? 'Override preemption'
                  : 'Run anyway'}
            </button>
            <button
              className="btn btn--ghost"
              title="Open the task thread to inspect or reassign."
              onClick={() => onOpenTask?.(current.task.id)}
            >
              View…
            </button>
            {/* ⛔ Silences the bar, changes nothing about the task: the gate still holds, the
                Tasks list still shows it, and the fleet still releases it when the window resets.
                A park lasts hours, so this is remembered across restarts — see quotaalerts.ts. */}
            <button
              className="btn btn--ghost"
              title="Stop showing this here. The task stays gated and resumes when its window resets."
              onClick={() => dismissQuota(current.task)}
            >
              Dismiss
            </button>
          </>
        )}
      </span>
      {items.length > 1 && <span className="num approvals-more">+{items.length - 1} more</span>}
    </div>
  )
}
