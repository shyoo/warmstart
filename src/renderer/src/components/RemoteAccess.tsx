import { useEffect, useMemo, useState } from 'react'
import type { RemoteStatus } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { addressLabel, countdown, tailscaleStep } from '../lib/remoteaccess'
import { qrMatrix, qrPath } from '../lib/qr'
import { errorMessage } from '@shared/errors.js'
import { SettingButtonSelect } from './SettingButtonSelect'
import { SettingRow, SettingSwitch } from './SettingRow'

/**
 * Remote access: the two switches, the address to open on a phone, and the pairing code.
 *
 * ⛔ The pairing URL is the daemon's, unchanged. It arrives from `remote.pairingCode` already
 * complete — scheme, host, port, `#/pair?code=…` — and building a second one here is how it ended
 * up doubled (t310). This screen displays it and encodes it; it does not compose it.
 */
export function RemoteAccess(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pair, setPair] = useState<{ code: string; expiresAt: number; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = async (): Promise<void> => setStatus(await rpc('remote.status'))
  const recheck = async (): Promise<void> => setStatus(await rpc('remote.recheck'))
  useEffect(() => {
    void refresh().catch((err: unknown) => setError(errorMessage(err)))
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // The code dies on its own; stop showing a QR that no longer pairs anything.
  useEffect(() => {
    if (pair && pair.expiresAt <= now) setPair(null)
  }, [pair, now])

  if (!status) {
    return (
      <div className="panel">
        <p className="dim">{error ?? 'Reading remote access…'}</p>
      </div>
    )
  }

  const change = (call: () => Promise<RemoteStatus>): void => {
    void call().then(setStatus).catch((err: unknown) => setError(errorMessage(err)))
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Remote access</h2>
          <p className="panel-sub">
            A phone reaches a project only when remote access is on here <em>and</em> enabled for that project.
            Paired phones never get the credential the desktop uses.
          </p>
        </div>
      </header>

      <div className="setting-list">
        <SettingRow
          title="Allow paired phones"
          description={
            status.enabled
              ? 'On. Only paired devices reach it, and only the projects enabled below.'
              : 'Off. No remote listener is running and no phone can connect.'
          }
          control={
            <SettingSwitch
              label="Allow paired phones"
              on={status.enabled}
              busy={false}
              onToggle={() => change(() => rpc('remote.setEnabled', { enabled: !status.enabled }))}
            />
          }
        />
        <SettingRow
          title="Connection"
          description={
            status.listening
              ? status.secure
                ? 'Listening over HTTPS. Installable, and able to notify this phone.'
                : 'Listening without encryption — a trusted LAN only, and it cannot notify.'
              : status.enabled
                ? 'Not listening yet. See Tailscale setup below.'
                : 'Not listening.'
          }
          control={
            <SettingButtonSelect
              value={status.bind}
              ariaLabel="Remote connection"
              options={[
                { value: 'tailscale', label: 'Tailscale only' },
                { value: 'lan', label: 'LAN only' },
                { value: 'both', label: 'Both' }
              ]}
              onChange={(bind) => change(() => rpc('remote.setBind', { bind: bind as RemoteStatus['bind'] }))}
            />
          }
        >
          <label className="dim">
            Port{' '}
            <input
              className="text-input"
              defaultValue={status.port}
              onBlur={(e) => change(() => rpc('remote.setBind', { bind: status.bind, port: Number(e.target.value) }))}
            />
          </label>
        </SettingRow>
      </div>

      {error && <p className="warn">{error}</p>}

      {status.enabled && (
        <>
          <h3>Addresses</h3>
          {status.urls.length ? (
            status.urls.map((url) => (
              <div className="remote-block" key={url}>
                <code>{url}</code>
                <p className="dim">{addressLabel(url)}</p>
              </div>
            ))
          ) : (
            <p className="warn">No address is available yet.</p>
          )}

          <h3>Tailscale setup</h3>
          <p>
            {tailscaleStep(status)}{' '}
            {!status.tailscale?.installed && (
              <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                Get Tailscale
              </a>
            )}
          </p>
          <button className="btn btn--primary" onClick={() => void recheck()}>
            Re-check Tailscale
          </button>

          <h3>Pair a phone</h3>
          {/* ⚠️ A code is only useful with an address to carry it: the QR encodes a URL, and with no
              listener there is nothing for it to point at. */}
          <button
            className="btn btn--primary"
            disabled={status.urls.length === 0}
            onClick={() => {
              setPair(null)
              void rpc('remote.pairingCode')
                .then(setPair)
                .catch((err: unknown) => setError(errorMessage(err)))
            }}
          >
            Generate pairing code
          </button>
          {pair && <Pairing pair={pair} now={now} />}

          <h3>Projects</h3>
          {status.projects.map((project) => (
            <SettingRow
              key={project.id}
              title={project.name}
              description={
                project.enabled
                  ? 'Reachable by paired phones while remote access is on.'
                  : 'Not reachable from a phone.'
              }
              control={
                <SettingSwitch
                  label={`Allow remote access to ${project.name}`}
                  on={project.enabled}
                  busy={false}
                  onToggle={() => change(() => rpc('remote.setProject', { projectId: project.id, enabled: !project.enabled }))}
                />
              }
            />
          ))}

          <h3>Paired devices</h3>
          {status.devices.length ? (
            status.devices.map((device) => (
              <div className="setting-row" key={device.id}>
                <div>
                  <p className="setting-row-title">{device.label}</p>
                  <p className="setting-row-desc">
                    Paired {new Date(device.createdAt).toLocaleString()} · last seen{' '}
                    {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never'}
                    {device.revokedAt ? ' · revoked' : ''}
                  </p>
                </div>
                <button
                  className="btn btn--danger"
                  disabled={!!device.revokedAt}
                  onClick={() => void rpc('remote.revokeDevice', { id: device.id }).then(() => refresh())}
                >
                  Revoke
                </button>
              </div>
            ))
          ) : (
            <p className="dim">No phones paired.</p>
          )}
        </>
      )}
    </div>
  )
}

/** The code, the seconds it has left, and the URL as something a camera can read. */
function Pairing({ pair, now }: { pair: { code: string; expiresAt: number; url: string }; now: number }): React.JSX.Element {
  return (
    <div className="remote-block">
      <p className="mono remote-code">
        {pair.code} · {countdown(pair.expiresAt, now)}
      </p>
      <QrCode text={pair.url} />
      <p className="dim">
        Scan it, or open <code>{pair.url}</code> on the phone.
      </p>
    </div>
  )
}

function QrCode({ text }: { text: string }): React.JSX.Element | null {
  // ⚠️ Recomputed only when the URL changes: the countdown above re-renders every second.
  const drawn = useMemo(() => {
    try {
      return qrPath(qrMatrix(text))
    } catch {
      return null
    }
  }, [text])
  if (!drawn) return null
  return (
    <svg
      className="remote-qr"
      viewBox={`0 0 ${drawn.extent} ${drawn.extent}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      {/* ⛔ White, not a theme token: a scanner needs the quiet zone light whatever the app theme is. */}
      <rect width={drawn.extent} height={drawn.extent} fill="#ffffff" />
      <path d={drawn.path} fill="#000000" />
    </svg>
  )
}
