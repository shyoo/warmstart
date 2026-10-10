import { useEffect, useState } from 'react'
import type { PowerAction, PowerActionState } from '@shared/ipc'
import { useNow } from '../lib/daemon'

const LABEL: Record<PowerAction, string> = {
  shutdown: 'Shut down', sleep: 'Sleep', hibernate: 'Hibernate'
}

/** This computer's one-time, cancellable action. Main owns the timer even when the window is hidden. */
export function PowerActionControl({ remote }: { remote: boolean }): React.JSX.Element {
  const [state, setState] = useState<PowerActionState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  useEffect(() => {
    void window.agentyard.getPowerAction().then(setState)
    return window.agentyard.onPowerAction(setState)
  }, [])

  async function arm(action: PowerAction): Promise<void> {
    setBusy(true)
    setError(null)
    setOpen(false)
    try { setState(await window.agentyard.armPowerAction(action)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  async function cancel(): Promise<void> {
    setBusy(true)
    try { setState(await window.agentyard.cancelPowerAction()); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const action = state?.action
  const seconds = state?.dueAt == null ? null : Math.max(0, Math.ceil((state.dueAt - now) / 1000))
  return <div className="titlebar-power">
    {action ? <>
      <span className="titlebar-power-status" role="status" title="This computer will act after all running and queued tasks settle">
        {LABEL[action]} {seconds === null ? 'after tasks' : `in ${seconds}s`}
      </span>
      <button className="titlebar-power-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
    </> : <>
      <button className="titlebar-power-toggle" aria-expanded={open} aria-haspopup="menu"
        title={remote ? 'Power actions are available on this computer only' : 'Choose what this computer does after running and queued tasks settle'}
        disabled={remote || busy || !state?.available.length} onClick={() => setOpen((value) => !value)}>
        When done ▾
      </button>
      {open && <div className="titlebar-power-menu" role="menu">
        {state?.available.map((choice) => <button key={choice} role="menuitem" onClick={() => void arm(choice)}>
          {LABEL[choice]} after tasks
        </button>)}
      </div>}
    </>}
    {(error || state?.error) && <span className="titlebar-power-error" role="alert" title={error ?? state?.error ?? ''}>{error ?? state?.error}</span>}
  </div>
}
