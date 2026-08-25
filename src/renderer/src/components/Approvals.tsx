import { useEffect, useState } from 'react'
import type { Approval } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { cacheUrgency, countdown } from '../lib/format'

/**
 * The Approvals bar.
 *
 * ⛔ An approval is **not** a task, so it never becomes a row in the task table and never lands in a
 * queue you have to open. It blocks one live session right now, its answer set is closed, and it dies
 * with the session — so it lives here, above the work, and clears in one keystroke.
 *
 * It is empty almost always. That is the design goal, not a shortfall: most approvals are absorbed by
 * the agent's own mode, and most of the rest are answered by a remembered rule.
 *
 * The countdown is not decoration. A blocked session is idle, and idle burns the prompt cache — past
 * that clock, resuming this session costs a full cold rebuild instead of a cheap read.
 */
export function Approvals({ now }: { now: number }): React.JSX.Element | null {
  const [open, setOpen] = useState<Approval[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = () => void rpc('approval.list').then(setOpen)
  useEffect(refresh, [])
  useDaemonEvents((event) => {
    if (event.type === 'approval.opened' || event.type === 'approval.answered') refresh()
  })

  if (open.length === 0) return null
  const current = open[0]
  if (!current) return null

  const answer = async (decision: 'allow' | 'allow_always' | 'deny') => {
    setBusy(current.id)
    try {
      await rpc('approval.answer', { id: current.id, decision })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  return (
    <div className="approvals">
      <span className="approvals-mark">!</span>
      <span className="approvals-what mono" title={current.summary}>
        {current.summary}
      </span>
      {current.escalatedAt && <span className="tag tag--human">waiting on you</span>}
      <span className={`num approvals-clock approvals-clock--${cacheUrgency(current.deadlineAt, now)}`}>
        {current.deadlineAt ? countdown(current.deadlineAt, now) : '--:--'}
      </span>
      <span className="approvals-actions">
        <button className="btn" disabled={busy === current.id} onClick={() => void answer('allow')}>
          Allow
        </button>
        <button
          className="btn btn--ghost"
          disabled={busy === current.id}
          onClick={() => void answer('allow_always')}
          title="Remember this as a rule, so the next one is answered without asking."
        >
          Always
        </button>
        <button
          className="btn btn--ghost btn--danger"
          disabled={busy === current.id}
          onClick={() => void answer('deny')}
        >
          Deny
        </button>
      </span>
      {open.length > 1 && <span className="num approvals-more">+{open.length - 1} more</span>}
    </div>
  )
}
