import { useCallback, useEffect, useState } from 'react'
import type { RpcResult } from '@shared/protocol'
type FleetList = RpcResult<'fleet.list'>
import { RemoteError, rpc } from '../api.js'
import { useNow } from '../hooks.js'
import { quotaAge, quotaLine, relTime } from '../lib/format.js'

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
      {fleet.map((w) => (
        <section className="m-card" key={w.worker.id}>
          <div className="m-card-head">
            <p className="m-card-title">{w.worker.label}</p>
          </div>
          <p className="m-meta">
            {w.worker.adapterId} · {w.sessions.length} running
          </p>
          <p className="m-quota">{quotaLine(w.quota?.windows ?? [])}</p>
          <p className="m-meta">{quotaAge(w.quota?.sampledAt ?? null, now)}</p>
          {w.quota?.windows
            .filter((win) => win.resetsAt !== null)
            .map((win) => (
              <p className="m-meta" key={win.id}>
                {win.label} resets {relTime(win.resetsAt as number, now)}
              </p>
            ))}
          {w.unavailable && <p className="m-warn">{w.unavailable}</p>}
          {w.atCapacity && <p className="m-meta">At capacity — finishing what it holds.</p>}
          {!w.worker.enabled && <p className="m-meta">Closed to work.</p>}
        </section>
      ))}
      {fleet.length === 0 && <p className="m-empty">No accounts.</p>}
    </div>
  )
}
