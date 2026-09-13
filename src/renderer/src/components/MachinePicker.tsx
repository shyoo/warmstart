import { useState } from 'react'
import { errorMessage } from '@shared/errors.js'
import { targetOptionLabel, useTarget } from '../lib/target'

const MANAGE = '__manage'

/**
 * Which computer's fleet the window shows: this one, or a paired remote Warmstart.
 *
 * ⚠️ Shown even with nothing paired. It is where somebody looks for the feature, and the one option
 * below *This computer* is how they find out it exists.
 */
export function MachinePicker({ onManage }: { onManage: () => void }): React.JSX.Element {
  const { state, active } = useTarget()
  const [error, setError] = useState<string | null>(null)

  const choose = (id: string): void => {
    if (id === MANAGE) {
      onManage()
      return
    }
    setError(null)
    // ⚠️ Root re-mounts the shell when main pushes the new selection; nothing is drawn from here.
    void window.agentyard.selectTarget(id).catch((err: unknown) => setError(errorMessage(err)))
  }

  return (
    <div className="machine-picker">
      <select
        className="machine-picker-select"
        aria-label="Computer"
        value={state.active}
        onChange={(e) => choose(e.target.value)}
      >
        {state.targets.map((target) => (
          <option key={target.id} value={target.id}>
            {targetOptionLabel(target, target.id === state.active)}
          </option>
        ))}
        <option value={MANAGE}>{state.targets.length > 1 ? 'Manage computers…' : 'Connect to another computer…'}</option>
      </select>
      {active.kind === 'remote' && active.url && <p className="machine-picker-note mono">{new URL(active.url).host}</p>}
      {active.kind === 'remote' && active.state === 'connected' && active.message && (
        <p className="machine-picker-note machine-picker-note--warn" role="status">{active.message}</p>
      )}
      {error && <p className="machine-picker-note machine-picker-note--warn">{error}</p>}
    </div>
  )
}
