import { useCallback, useEffect, useState } from 'react'
import type { RpcResult } from '@shared/protocol'
type FleetList = RpcResult<'fleet.list'>
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { quotaAge, quotaTone, relTime } from '../lib/format.js'

/**
 * The fleet, one card per worker: its quota snapshot with the reading's age, what is running,
 * and — read straight off the response, never re-derived here — why an account is unavailable.
 */
export function QuotaScreen({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const now = useNow()
  const [fleet, setFleet] = useState<FleetList | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void rpc('fleet.list', undefined)
      .then((f: FleetList) => {
        setFleet(f)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!(err instanceof RemoteError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Could not load.')
        }
      })
  }, [])

  useEffect(refresh, [refresh, refreshKey])

  if (error) return <p className="m-error m-screen">{error}</p>
  if (!fleet) return <p className="m-empty m-screen">Reading the fleet…</p>

  return (
    <div className="m-screen">
      {fleet.filter((w) => w.worker.enabled).map((w) => (
        <section className="m-card" key={w.worker.id}>
          <div className="m-card-head">
            <p className="m-card-title">{w.worker.label}</p>
            <span className={`m-health${w.unavailable ? ' m-health--warn' : ''}`}>{w.unavailable ? 'Unavailable' : w.atCapacity ? 'At capacity' : 'Ready'}</span>
          </div>
          <p className="m-meta">
            {w.worker.adapterId} · {w.sessions.length} running
          </p>
          <div className="m-quota-stack">
            {(w.quota?.windows ?? []).map((win) => (
              <div className="m-quota-window" key={win.id}>
                <div className="m-quota-label"><span>{win.label}</span><strong>{Math.round(win.percent)}%</strong></div>
                <div className="m-quota-track" role="progressbar" aria-label={`${win.label} quota used`} aria-valuenow={Math.round(win.percent)} aria-valuemin={0} aria-valuemax={100}>
                  <span className={`m-quota-fill m-quota-fill--${quotaTone(win.percent)}`} style={{ width: `${Math.max(0, Math.min(100, win.percent))}%` }} />
                </div>
                <p className="m-meta">{win.resetsAt === null ? 'Reset not reported' : `Resets ${relTime(win.resetsAt, now)}`}</p>
              </div>
            ))}
            {(w.quota?.windows.length ?? 0) === 0 && <p className="m-empty">No quota windows reported.</p>}
          </div>
          <p className="m-meta m-reading-age">{quotaAge(w.quota?.sampledAt ?? null, now)}</p>
          {w.unavailable && <p className="m-warn">{w.unavailable}</p>}
          {w.atCapacity && <p className="m-meta">At capacity — finishing what it holds.</p>}
        </section>
      ))}
      {fleet.filter((w) => w.worker.enabled).length === 0 && <p className="m-empty">No enabled workers.</p>}
    </div>
  )
}
