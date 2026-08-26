import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppInfo, DaemonUiStatus } from '@shared/ipc'
import type {
  DaemonEvent,
  QuotaSnapshot,
  RpcMethod,
  RpcParams,
  RpcResult,
  Session,
  Worker
} from '@shared/protocol'

/**
 * The renderer's view of the fleet.
 *
 * Everything arrives through the preload bridge; there is no port, no token and no socket here.
 * State is kept deliberately small and derived from daemon events, so a UI reload never disagrees
 * with the daemon about what is running.
 */

export function rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  return window.agentyard.rpc(method, params)
}

export interface FleetEntry {
  worker: Worker
  quota: (QuotaSnapshot & { ageMs?: number; stale?: boolean }) | null
  sessions: Session[]
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.agentyard.getAppInfo().then(setInfo)
  }, [])
  return info
}

export function useDaemonStatus(): DaemonUiStatus {
  const [status, setStatus] = useState<DaemonUiStatus>({ state: 'starting' })
  useEffect(() => {
    void window.agentyard.daemonStatus().then(setStatus)
    return window.agentyard.onDaemonStatus(setStatus)
  }, [])
  return status
}

/** Subscribe to daemon pushes. The handler is kept in a ref so callers need not memoise it. */
export function useDaemonEvents(handler: (event: DaemonEvent) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => window.agentyard.onDaemonEvent((event) => ref.current(event)), [])
}

export function useFleet(connected: boolean): {
  fleet: FleetEntry[]
  error: string | null
  refresh: () => Promise<void>
} {
  const [fleet, setFleet] = useState<FleetEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!connected) return
    try {
      setFleet(await rpc('fleet.list'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [connected])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useDaemonEvents((event) => {
    // Quota and session changes are frequent; a targeted patch avoids a round-trip per event.
    if (event.type === 'quota.changed') {
      setFleet((prev) =>
        prev.map((e) => (e.worker.id === event.quota.workerId ? { ...e, quota: event.quota } : e))
      )
    } else if (event.type === 'session.changed' || event.type === 'session.exit') {
      void refresh()
    } else if (event.type === 'worker.changed') {
      void refresh()
    }
  })

  return { fleet, error, refresh }
}

/** A ticking clock for countdowns, shared by every component that needs one. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
