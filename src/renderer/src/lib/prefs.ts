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
const FLEET_DENSITY_KEY = 'multi_agent_controller.fleetDensity'

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

/**
 * How much of each worker card the fleet strip draws.
 *
 * ⭐ `narrow` is for a fleet that outgrew the strip. The cards are sized by their content, so six
 * accounts scroll horizontally and the operator can no longer see the whole fleet at once — which is
 * the one thing the strip is for. Condensing drops the naming of each gauge (`Claude 5h`, `work`)
 * and keeps the measurement: bar, value, countdown. What is lost is which window a bar is; what is
 * kept is whether anything is close to running out, which is what a glance is asking.
 *
 * ⚠️ Not a fleet setting. Like the collapsed state above it, this is a property of the person and
 * the display in front of them — a laptop wants narrow where a wide monitor does not — so it stays
 * in `localStorage` rather than syncing one operator's strip onto another's window.
 */
export type FleetDensity = 'wide' | 'narrow'

export function readFleetDensity(): FleetDensity {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'wide'
    // ⛔ Only the one value opts in. Anything else — absent, empty, a density that has since been
    // renamed — reads as `wide`, because the default has to be the mode that shows everything.
    return window.localStorage.getItem(FLEET_DENSITY_KEY) === 'narrow' ? 'narrow' : 'wide'
  } catch {
    return 'wide'
  }
}

export function writeFleetDensity(density: FleetDensity): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(FLEET_DENSITY_KEY, density)
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const PAGE_SIZE_KEY = 'multi_agent_controller.taskPageSize'
export const DEFAULT_PAGE_SIZE = 25
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

/**
 * How many tasks to display per page in the task table.
 *
 * ⛔ Per-display preference stored in `localStorage`, consistent with task view filters and sidebar width.
 */
export function readTaskPageSize(): PageSizeOption {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_PAGE_SIZE
    const raw = window.localStorage.getItem(PAGE_SIZE_KEY)
    if (!raw) return DEFAULT_PAGE_SIZE
    const parsed = Number.parseInt(raw, 10)
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)) {
      return parsed as PageSizeOption
    }
    return DEFAULT_PAGE_SIZE
  } catch {
    return DEFAULT_PAGE_SIZE
  }
}

export function writeTaskPageSize(size: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(PAGE_SIZE_KEY, String(size))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}



