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

  // ⚠️ A ref, not the state, for the event handler to read. Deciding patch-or-refetch inside a
  // `setFleet` updater would put a network call in a function React is free to run twice.
  const fleetRef = useRef<FleetEntry[]>(fleet)
  useEffect(() => {
    fleetRef.current = fleet
  }, [fleet])

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
    } else if (event.type === 'session.changed') {
      // ⚠️ Patched in place, because this now arrives once per metered turn. A session already on a
      // card is replaced where it stands; only a session this list has never seen — a new one, or
      // one that just closed and must drop off — is worth a round-trip.
      const known = fleetRef.current.some((e) => e.sessions.some((s) => s.id === event.session.id))
      if (!known || event.session.state !== 'live') void refresh()
      else
        setFleet((prev) =>
          prev.map((e) => ({
            ...e,
            sessions: e.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          }))
        )
    } else if (event.type === 'session.exit') {
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

export interface ActivityLine {
  text: string
  ts: number
}

/**
 * What agents are saying right now, per task.
 *
 * ⛔ **Appended from the event stream, never re-fetched.** The daemon holds a tail of its own and
 * `task.get` returns it, but a pane that rebuilt from each fetch would flicker back to whatever the
 * daemon happened to hold at that instant — and a task's data is re-fetched on every `task.changed`
 * the fleet emits, which is often. `seed` fills the pane once when a task is opened mid-run so it
 * does not start blank; events take over from there.
 *
 * ⚠️ Two screens need this now — the table draws the latest line on a running row, the thread draws
 * the whole tail — so it is a hook rather than state in whichever component happened to own both.
 * Each caller keeps its own copy; they are fed by the same broadcast and cannot disagree.
 */
export function useActivity(): {
  activity: Record<string, ActivityLine[]>
  seed: (taskId: string, lines: ActivityLine[]) => void
} {
  const [activity, setActivity] = useState<Record<string, ActivityLine[]>>({})

  const seed = useCallback((taskId: string, lines: ActivityLine[]) => {
    if (lines.length === 0) return
    // ⚠️ Only into an empty pane. Seeding over a tail this hook has been building would replay lines
    // already on screen and reorder them against the ones still arriving.
    setActivity((prev) => (prev[taskId]?.length ? prev : { ...prev, [taskId]: lines }))
  }, [])

  useDaemonEvents((event) => {
    if (event.type !== 'task.activity') return
    // A new attempt starts with an empty pane. See clearActivity.
    if (event.reset) {
      setActivity((prev) => ({ ...prev, [event.taskId]: [] }))
      return
    }
    setActivity((prev) => {
      // ⚠️ Bounded here as well as in the daemon. This is agent output arriving as fast as a model
      // can produce it, and an unbounded array in a React state is a memory leak with a pretty UI.
      const tail = [...(prev[event.taskId] ?? []), { text: event.text, ts: event.ts }].slice(-40)
      return { ...prev, [event.taskId]: tail }
    })
  })

  return { activity, seed }
}
