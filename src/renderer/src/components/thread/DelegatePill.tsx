import { useState } from 'react'
import type { Task } from '@shared/tasks'
import { errorMessage } from '@shared/errors.js'
import { rpc } from '../../lib/daemon'

/**
 * Whether this thread's agent may hand work to other agents (t704).
 *
 * ⛔ **Authority, applied at once — not a next-run choice like the pills beside it.** It writes the
 * task's `spawn_tasks`, which the daemon checks when the agent calls `task_split`; the agent is told
 * of the change on its next turn. Turning it on is refused, with the reason, when the task was filed
 * by one that cannot delegate.
 *
 * ⚠️ Shown on work tasks and conversations only — a plan or a debate splits through its own contract.
 *
 * ⚠️ A single toggle, not a menu (t706): there is nothing to choose beyond on and off, so one
 * click flips it.
 */
export function delegationPillShown(task: Pick<Task, 'kind'>): boolean {
  return task.kind === 'work' || task.kind === 'conversation'
}

export function DelegatePill({
  task,
  refresh,
  hasMcp = null
}: {
  task: Task
  refresh: () => Promise<void>
  /**
   * The next-dispatch worker's adapter MCP capability, or null while unknown (t706).
   * Shown only when delegation is on and the worker is known to lack MCP tools — a
   * delegation the agent cannot file by tool.
   */
  hasMcp?: boolean | null
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!delegationPillShown(task)) return null
  const on = task.mandate.allowed.includes('spawn_tasks')
  return (
    <>
      <div className="pill-wrap compose-assign-pill">
        <button
          type="button"
          className={`pill${on ? '' : ' pill--muted'}`}
          aria-pressed={on}
          aria-label="Delegation"
          title={
            on
              ? 'The agent may hand parts of this work to other agents. It asks you first, unless you asked with /delegate. Pieces come back as branches it reviews and merges. Click to switch off.'
              : 'The agent does all of this work itself. /delegate switches this back on. Click to switch on.'
          }
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setFailure(null)
            void rpc('task.update', { id: task.id, delegation: !on })
              .then(() => refresh())
              .catch((err: unknown) => setFailure(errorMessage(err)))
              .finally(() => setBusy(false))
          }}
        >
          {on ? 'Delegate on' : 'Delegate off'}
        </button>
      </div>
      {failure && <span className="compose-hint warn">{failure}</span>}
      {on && hasMcp === false && (
        <span className="compose-hint warn">
          This worker has no MCP tools: the agent cannot file splits by tool. Send /delegate and
          it writes each piece out for you to file.
        </span>
      )}
    </>
  )
}
