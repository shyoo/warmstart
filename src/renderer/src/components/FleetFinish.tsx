import { useCallback, useEffect, useState } from 'react'
import type { FinishPolicy } from '@shared/tasks'
import { rpc } from '../lib/daemon'

/**
 * The bottom tier: what finishing a task means for every project that has not said otherwise.
 *
 * ⛔ **A default, not a rule.** A project overrides this in its `project.json`, and a task overrides
 * both from its own detail pane — which is why this control says what it is the default *for* rather
 * than describing the policies themselves. `docs/landing.md` is where the policies are explained;
 * repeating them here would be a second copy to keep true.
 */
export function FleetFinish(): React.JSX.Element {
  const [policy, setPolicy] = useState<FinishPolicy | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPolicy((await rpc('settings.get')).finishPolicy)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const choose = async (next: FinishPolicy): Promise<void> => {
    setBusy(true)
    try {
      // ⚠️ The daemon's answer lands in state, never the value that was clicked.
      setPolicy((await rpc('settings.set', { finishPolicy: next })).finishPolicy)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="doc-section">
      <h3>When a task finishes</h3>
      {error && <div className="alert">{error}</div>}
      <div className="switch-row">
        <select
          className="finish-picker"
          aria-label="Fleet finish policy"
          value={policy ?? 'agent-lands'}
          disabled={busy || policy === null}
          onChange={(e) => void choose(e.target.value as FinishPolicy)}
        >
          <option value="await-human">await human</option>
          <option value="agent-lands">agent lands it</option>
          <option value="pull-request">open a pull request</option>
          <option value="custom">the project&rsquo;s own policy</option>
        </select>
        <p className="note">
          The fleet-wide default, used by any project that has not set <code>landing.finish</code> in
          its <code>project.json</code>, and by any task left on <em>inherit</em>. ⛔ Multi Agent
          Controller never writes a commit for an agent and never discards work it declines to land —
          anything it will not land appears under <strong>Loose ends</strong> on Overview.{' '}
          <em>agent lands it</em> additionally requires the project to define check commands and for
          them to pass. See <code>docs/landing.md</code>.
        </p>
      </div>
    </section>
  )
}
