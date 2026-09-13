import { useState } from 'react'
import { errorMessage } from '@shared/errors.js'
import { useTarget } from '../lib/target'

/**
 * The remote Warmstarts this computer has paired with.
 *
 * ⛔ **Main's list, not the fleet's.** It is read and written through the preload bridge, whichever
 * computer the window is showing, and a remote's credential never reaches this component — pairing
 * sends an address and a one-time code, and gets back only the list.
 */
export function RemoteMachines(): React.JSX.Element {
  const { state } = useTarget()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const remotes = state.targets.filter((t) => t.kind === 'remote')

  const pair = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const next = await window.agentyard.pairRemote({ address, code: code || undefined, label: label || undefined })
      const added = next.targets.filter((t) => t.kind === 'remote').at(-1)
      setDone(added ? `Paired with ${added.label}. Pick it from the list above Overview.` : 'Paired.')
      setAddress('')
      setCode('')
      setLabel('')
    } catch (err) {
      // ⚠️ IPC wraps a rejection in "Error invoking remote method…"; the sentence after it is ours.
      setError(errorMessage(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const forget = (id: string): void => {
    setError(null)
    void window.agentyard.forgetRemote(id).catch((err: unknown) => setError(errorMessage(err)))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Remote Warmstarts</h2>
          <p className="panel-sub">
            Other computers this one can drive, over Tailscale and HTTPS only. Each keeps running on its
            own; this window shows whichever one you pick above Overview.
          </p>
        </div>
      </header>

      {remotes.length ? (
        <div className="setting-list">
          {remotes.map((remote) => (
            <div className="setting-row" key={remote.id}>
              <div>
                <p className="setting-row-title">{remote.label}</p>
                <p className="setting-row-desc">
                  <code>{remote.url}</code>
                  {remote.pairedAt ? ` · paired ${new Date(remote.pairedAt).toLocaleString()}` : ''}
                  {remote.id === state.active ? ` · ${remote.state}` : ''}
                  {remote.remoteAppVersion ? ` · Warmstart ${remote.remoteAppVersion}` : ''}
                </p>
                {remote.id === state.active && remote.message && <p className="setting-row-desc warn">{remote.message}</p>}
              </div>
              <button
                className="btn btn--danger"
                title="Remove it from this computer, and ask that computer to revoke this one's access if it can be reached."
                onClick={() => forget(remote.id)}
              >
                Forget
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim">No remote computers paired.</p>
      )}

      <h3>Pair with another computer</h3>
      <p className="dim">
        On the other computer, open Settings → Global → Remote access, turn on <strong>Allow paired
        desktops</strong>, and press <strong>Generate desktop pairing code</strong>. Paste the link it shows
        here. The code works once and lasts two minutes.
      </p>
      {!state.canStoreCredentials && (
        <p className="warn">
          This computer has no OS keychain Warmstart can use, so it cannot keep a remote&apos;s credential
          encrypted — and will not keep it in plain text. Pairing is unavailable here.
        </p>
      )}
      <div className="remote-pair-form">
        <label className="dim">
          Pairing link or address
          <input
            className="text-input mono"
            value={address}
            placeholder="https://host.tailnet.ts.net:8787/#/desktop-pair?code=…"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <label className="dim">
          Code, if it is not in the link
          <input className="text-input mono" value={code} maxLength={8} spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label className="dim">
          Name (optional)
          <input className="text-input" value={label} placeholder="Defaults to the host name" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <button className="btn btn--primary" disabled={busy || !address.trim() || !state.canStoreCredentials} onClick={() => void pair()}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {done && <p className="dim">{done}</p>}
    </div>
  )
}
