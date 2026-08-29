import { TASK_VIEWS, type TaskView } from '@shared/tasks'

/**
 * Preferences that belong to this screen rather than to the fleet.
 *
 * ⛔ `localStorage`, on the precedent the sidebar width set: which buckets somebody last looked at is
 * a property of the person sitting here, not of the work. Putting it in settings would sync one
 * operator's filter onto another's window, and putting it in the route would lose it on restart.
 *
 * ⚠️ **Every access is guarded.** `localStorage` throws rather than returning null in real
 * configurations — a Chromium profile with site data disabled, and private windows on some
 * platforms — and a preference is never worth a blank screen.
 */

const VIEWS_KEY = 'multi_agent_controller.taskViews'
const FLEET_COLLAPSED_KEY = 'multi_agent_controller.fleetCollapsed'

/**
 * Which buckets were showing last time.
 *
 * ⛔ Values that are no longer buckets are **dropped, not rejected**. A stored `['needs_you',
 * 'triage']` after `triage` was removed must come back as `['needs_you']` — throwing the whole
 * preference away because one entry aged out would silently reset a filter somebody chose, and they
 * would have no way to tell that from the app forgetting.
 *
 * ⚠️ An empty array is a real value: All. Absent and empty are the same here only because All is
 * also the default, and that is a coincidence rather than an assumption to build on.
 */
export function readViews(): TaskView[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(VIEWS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is TaskView => typeof v === 'string' && v in TASK_VIEWS)
  } catch {
    return []
  }
}

export function writeViews(views: TaskView[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

/**
 * Whether the top fleet strip was collapsed last time.
 *
 * ⛔ Per-display preference stored in `localStorage`, consistent with task view filters and sidebar width.
 */
export function readFleetCollapsed(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(FLEET_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeFleetCollapsed(collapsed: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(FLEET_COLLAPSED_KEY, String(collapsed))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}


