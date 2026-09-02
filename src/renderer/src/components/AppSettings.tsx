import { useState } from 'react'
import type { EnterBehavior } from '@shared/ipc'
import { useUiSettings } from '../lib/uisettings'

/**
 * The preferences that belong to this window rather than to the fleet.
 *
 * ⛔ These go through the **main process**, not the daemon. Whether closing the window leaves a
 * scheduler running is a decision main has to be able to act on when the daemon is not answering -
 * which is precisely when it matters - so it cannot live in the database the daemon owns. The switch
 * itself is the same component as the one on the Cost page, because to an operator it is the same
 * kind of thing.
 */
export function AppSettings(): React.JSX.Element {
  const { settings, updateUiSettings } = useUiSettings()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setTray = async (tray: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      // ⛔ The answer comes back from main, never the value that was clicked. A switch that paints
      // itself and persists nothing is the failure this kind of control is used to rule out.
      await updateUiSettings({ tray })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const setEnterBehavior = async (enterBehavior: EnterBehavior): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await updateUiSettings({ enterBehavior })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const tray = settings.tray
  const enterBehavior = settings.enterBehavior

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>This app</h2>
          <p className="panel-sub">
            Preferences for this window on this machine. Everything else on this page describes the
            fleet, which is shared.
          </p>
        </div>
      </header>

      <section className="doc-section">
        <h3>Enter key behavior</h3>
        <div className="picker-row">
          <div className="picker-row-head">
            <p className="switch-state">
              <strong>Send messages with</strong> · {enterBehavior === 'send' ? 'Enter' : '⌘ / Ctrl + Enter'}
              <span className="dim">
                {enterBehavior === 'send'
                  ? ' — Enter sends immediately; Shift+Enter adds a new line.'
                  : ' — Enter adds a new line; ⌘ / Ctrl+Enter sends.'}
              </span>
            </p>
            <select
              className="finish-picker picker-row-control"
              aria-label="Enter key behavior"
              value={enterBehavior}
              disabled={saving}
              onChange={(e) => void setEnterBehavior(e.target.value as EnterBehavior)}
            >
              <option value="send">Enter sends immediately (Shift+Enter for new line)</option>
              <option value="newline">Enter adds a new line (⌘/Ctrl+Enter to send)</option>
            </select>
          </div>
          <p className="note">
            Applies to prompt and message inputs across the app: the thread composer, question answers,
            and the new task composer.
          </p>
        </div>
      </section>

      <section className="doc-section">
        <h3>Keep running in the tray</h3>
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={tray}
            aria-label="Keep running in the tray"
            disabled={saving}
            className={`switch ${tray ? 'switch--on' : ''}`}
            onClick={() => void setTray(!tray)}
          >
            <span className="switch-knob" />
          </button>
          <div>
            <p className="switch-state">
              {tray ? 'On' : 'Off'}
              <span className="dim">
                {tray
                  ? ' — closing the window hides it. The scheduler keeps working, and the tray icon' +
                    ' brings the window back without launching the app again.'
                  : ' — closing the window stops orchestratord too, so nothing is left running.'}
              </span>
            </p>
            {/* ⚠️ Both consequences stated, because each is a surprise in the other direction. Off
                and you can lose an agent mid-run; on and a scheduler outlives the window that was
                the only sign of it. */}
            <p className="note">
              {tray ? (
                <>
                  ⚠️ The fleet outlives the window. <strong>Quit and stop the daemon</strong> in the
                  tray menu is the way to end it — and that <em>does</em> stop any running agent.
                </>
              ) : (
                <>
                  ⚠️ Stopping orchestratord ends every running agent. Work already done is saved;
                  the context each session holds is not. You will be asked first if anything is in
                  flight.
                </>
              )}
            </p>
          </div>
        </div>
        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  )
}
