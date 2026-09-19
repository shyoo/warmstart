import { sessionEnded } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppInfo, AppUpdateState, DaemonUiStatus } from '@shared/ipc'
import type {
  DaemonEvent,
  QuotaSnapshot,
  RpcMethod,
  RpcParams,
  RpcResult,
  Session,
  Worker
} from '@shared/protocol'
import { errorMessage } from '@shared/errors.js'
import { currentTargetId } from './target'

/**
 * The renderer's view of the fleet.
 *
 * Everything arrives through the preload bridge; there is no port, no token and no socket here.
 * State is kept deliberately small and derived from daemon events, so a UI reload never disagrees
 * with the daemon about what is running.
 */

export function rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
  // ⛔ Names the computer this window believes it is showing; see `lib/target.ts`.
  return window.agentyard.rpc(method, params, currentTargetId())
}

export interface FleetEntry {
  worker: Worker
  quota: (QuotaSnapshot & { ageMs?: number; stale?: boolean }) | null
  sessions: Session[]
  /**
   * Why the daemon would not hand this account a turn right now, or `null` if it would.
   *
   * ⛔ Computed by the daemon from `eligibility.ts` and never re-derived here — see the note on
   * `fleet.list` in protocol.ts. ⚠️ Optional on the type because a renderer bundle can outlive the
   * daemon build it is talking to during development; `undefined` means *not answered*, which is
   * why the fleet counts treat it as neither ready nor unavailable rather than assuming ready.
   */
  unavailable?: string | null
  /** Whether every slot `maxConcurrent` allows is already busy. Daemon-computed; see `unavailable`. */
  atCapacity?: boolean
  /** Slots held by a task with no live process. Daemon-computed; optional for the same reason. */
  reservedSlots?: number
}

/**
 * How the fleet is doing, in the three numbers the sidebar and status bar show:
 * running / active / total workers.
 *
 * ⚠️ `running` counts **workers, not sessions**, so it is comparable to `total`: a worker with
 * `maxConcurrent: 3` running three tasks is one busy account. Only `work` sessions count — a login
 * terminal or a 30-second quota probe is not the fleet doing work.
 *
 * ⚠️ `active` counts enabled workers (`worker.enabled === true`).
 *
 * ⚠️ `total` counts all configured workers in the fleet (`fleet.length`).
 */
export function fleetCounts(fleet: FleetEntry[]): {
  running: number
  active: number
  total: number
} {
  let running = 0
  let active = 0
  for (const entry of fleet) {
    if (
      entry.sessions?.some(
        (s) => s.purpose === 'work' && !sessionEnded(s.state)
      )
    ) {
      running++
    }
    if (entry.worker?.enabled) active++
  }
  return { running, active, total: fleet.length }
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.agentyard.getAppInfo().then(setInfo)
  }, [])
  return info
}

export function useUpdateStatus(): AppUpdateState | null {
  const [status, setStatus] = useState<AppUpdateState | null>(null)
  useEffect(() => {
    void window.agentyard.getUpdateStatus().then(setStatus)
    return window.agentyard.onUpdateStatus(setStatus)
  }, [])
  return status
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
      setError(errorMessage(err))
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
 * One `task.activity` event folded into a watcher's per-task tails. Pure so the L1 suite can pin
 * the framing without spawning a pane.
 *
 * ⛔ **`append` replaces the last row, it never pushes.** The daemon sends the whole open line with
 * each fragment, so a streamed sentence (`landing`, ` corners`, ` pass. The`, …) occupies one row
 * that grows — pushing each fragment would render the sentence one word per line, which is the
 * defect this exists to prevent. A watcher that missed a fragment still lands on the right text,
 * because what arrives is the line, not the delta.
 */
export function applyActivityEvent(
  prev: Record<string, ActivityLine[]>,
  event: { taskId: string; text: string; ts: number; reset?: true; append?: true }
): Record<string, ActivityLine[]> {
  // A new attempt starts with an empty pane. See clearActivity.
  if (event.reset) return { ...prev, [event.taskId]: [] }
  const cur = prev[event.taskId] ?? []
  if (event.append && cur.length > 0) {
    return { ...prev, [event.taskId]: [...cur.slice(0, -1), { text: event.text, ts: event.ts }] }
  }
  // ⚠️ Bounded here as well as in the daemon. This is agent output arriving as fast as a model
  // can produce it, and an unbounded array in a React state is a memory leak with a pretty UI.
  const tail = [...cur, { text: event.text, ts: event.ts }].slice(-40)
  return { ...prev, [event.taskId]: tail }
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
    setActivity((prev) => applyActivityEvent(prev, event))
  })

  return { activity, seed }
}
