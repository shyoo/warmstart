import { useState } from 'react'
import type { Task } from '@shared/tasks'
import { errorMessage } from '@shared/errors.js'
import { rpc } from '../../lib/daemon'
import { PillSelect, type PillOption } from '../Pill'

const OPTIONS: PillOption[] = [
  { value: 'on', label: 'Delegate on' },
  { value: 'off', label: 'Delegate off' }
]

/**
 * Whether this thread's agent may hand work to other agents (t704).
 *
 * ⛔ **Authority, applied at once — not a next-run choice like the pills beside it.** It writes the
 * task's `spawn_tasks`, which the daemon checks when the agent calls `task_split`; the agent is told
 * of the change on its next turn. Turning it on is refused, with the reason, when the task was filed
 * by one that cannot delegate.
 *
 * ⚠️ Shown on work tasks and conversations only — a plan or a debate splits through its own contract.
 */
export function delegationPillShown(task: Pick<Task, 'kind'>): boolean {
  return task.kind === 'work' || task.kind === 'conversation'
}

export function DelegatePill({
  task,
  refresh
}: {
  task: Task
  refresh: () => Promise<void>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!delegationPillShown(task)) return null
  const on = task.mandate.allowed.includes('spawn_tasks')
  return (
    <>
      <PillSelect
        className="compose-assign-pill"
        label={on ? 'Delegate on' : 'Delegate off'}
        value={on ? 'on' : 'off'}
        options={OPTIONS}
        ariaLabel="Delegation"
        title={
          on
            ? 'The agent may hand parts of this work to other agents. It asks you first, unless you asked with /delegate. Pieces come back as branches it reviews and merges.'
            : 'The agent does all of this work itself. /delegate switches this back on.'
        }
        muted={!on}
        disabled={busy}
        onChange={(next) => {
          setBusy(true)
          setFailure(null)
          void rpc('task.update', { id: task.id, delegation: next === 'on' })
            .then(() => refresh())
            .catch((err: unknown) => setFailure(errorMessage(err)))
            .finally(() => setBusy(false))
        }}
      />
      {failure && <span className="compose-hint warn">{failure}</span>}
    </>
  )
}
