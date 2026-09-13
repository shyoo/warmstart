import { useState } from 'react'
import type { EnterBehavior, ThemePreference, UiSettings } from '@shared/ipc'
import { useUiSettings } from '../lib/uisettings'
import { SettingRow, SettingSwitch } from './SettingRow'
import { SettingButtonSelect } from './SettingButtonSelect'
import { errorMessage } from '@shared/errors.js'
import { RemoteAccess } from './RemoteAccess'
import { RemoteMachines } from './RemoteMachines'
import { useTarget } from '../lib/target'

/**
 * The preferences that belong to this window rather than to the fleet.
 *
 * ⛔ These go through the **main process**, not the daemon. Whether closing the window leaves a
 * scheduler running is a decision main has to be able to act on when the daemon is not answering -
 * which is precisely when it matters - so it cannot live in the database the daemon owns.
 *
 * ⚠️ Same `SettingRow` as the fleet panel above it, because to an operator these are the same kind
 * of thing; only the scope differs, and the panel header is where that is said.
 */
export function AppSettings(): React.JSX.Element {
  const { settings, updateUiSettings } = useUiSettings()
  const { active } = useTarget()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ⛔ The answer comes back from main, never the value that was clicked. A switch that paints
  // itself and persists nothing is the failure this kind of control is used to rule out.
  const save = async (patch: Partial<UiSettings>): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await updateUiSettings(patch)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const tray = settings.tray
  const notifications = settings.notifications
  const enterBehavior = settings.enterBehavior
  const theme = settings.theme

  return (
    <>
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>This app</h2>
          <p className="panel-sub">Preferences for this window on this machine.</p>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="setting-list">
        <SettingRow
          title="Appearance"
          description={theme === 'system' ? 'Follows this system’s light or dark appearance, including changes while Warmstart is open.' : theme === 'light' ? 'Uses the light appearance in this window.' : 'Uses the dark appearance in this window.'}
          control={<SettingButtonSelect value={theme} aria-label="Appearance" disabled={saving} onChange={(value) => void save({ theme: value as ThemePreference })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />}
        />
        <SettingRow
          title="Enter key behavior"
          description={
            enterBehavior === 'send'
              ? 'Enter sends; Shift+Enter adds a new line. Applies to every prompt and message input.'
              : 'Enter adds a new line; ⌘ / Ctrl+Enter sends. Applies to every prompt and message input.'
          }
          control={
            <select
              className="finish-picker setting-row-control-select"
              aria-label="Enter key behavior"
              value={enterBehavior}
              disabled={saving}
              onChange={(e) => void save({ enterBehavior: e.target.value as EnterBehavior })}
            >
              <option value="send">Enter sends</option>
              <option value="newline">⌘ / Ctrl+Enter sends</option>
            </select>
          }
        />

        {/* ⚠️ Both consequences are stated, because each is a surprise in the other direction: off
            and a close can end an agent mid-run; on and a scheduler outlives the only window that
            showed it. */}
        <SettingRow
          title="Keep running in the tray"
          description={
            tray ? (
              <>
                Closing the window hides it — the scheduler keeps working and the tray icon brings
                the window back. <strong>Quit and stop the daemon</strong> in the tray menu is what
                ends it, and that does stop any running agent.
              </>
            ) : (
              <>
                Closing the window stops orchestratord too, which ends every running agent. Work
                already committed is safe; the context each session holds is not. You are asked first
                if anything is in flight.
              </>
            )
          }
          control={
            <SettingSwitch
              label="Keep running in the tray"
              on={tray}
              busy={saving}
              onToggle={() => void save({ tray: !tray })}
            />
          }
        />

        {/* ⚠️ Stated in terms of the promise it keeps. "File a task and walk away" is only true if
            something comes and gets you, and with the tray on the window is usually not in front
            of anybody. */}
        <SettingRow
          title="Notify me when a task needs me"
          description={
            notifications ? (
              <>
                An OS notification when a task <strong>wants your decision</strong>, finishes, or
                fails. Clicking it opens that task. Nothing else raises one — a task moving through
                the scheduler is not news.
              </>
            ) : (
              <>
                No notifications. A task waiting on your decision will sit there until you look at
                the Attention bar, which you only see when this window is in front of you.
              </>
            )
          }
          control={
            <SettingSwitch
              label="Notify me when a task needs me"
              on={notifications}
              busy={saving}
              onToggle={() => void save({ notifications: !notifications })}
            />
          }
        />
      </div>
    </div>
    <RemoteMachines />
    {/* ⚠️ Remote access is the *shown* computer's listener, read over rpc — so while a remote is on
        screen this panel administers that computer, and says so. */}
    <RemoteAccess machineLabel={active.kind === 'remote' ? active.label : null} />
    </>
  )
}
