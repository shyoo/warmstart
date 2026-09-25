import { TASK_VIEWS, type TaskSort, type TaskView } from '@shared/tasks'
import type { StatisticsWindow } from '@shared/statistics'
import { appKey } from './storagekeys'

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

const VIEWS_KEY = appKey('taskViews')
const TASK_COLUMNS_KEY = appKey('taskColumns')
const TASK_COLUMNS_V2_KEY = appKey('taskColumnsV2')
const TASK_SORT_KEY = appKey('taskSort')
const FLEET_COLLAPSED_KEY = appKey('fleetCollapsed')
const FLEET_DENSITY_KEY = appKey('fleetDensity')

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

/** The optional columns in the task table. Its id is deliberately not a member: it is always shown. */
export const TASK_COLUMNS = [
  'title',
  'kind',
  'from',
  'worker',
  'dep',
  'took',
  'price',
  'quality',
  'created',
  'updated',
  'status',
  'action'
] as const

export type TaskColumn = (typeof TASK_COLUMNS)[number]

/**
 * Which optional task columns are visible.
 *
 * ⛔ The task id is not configurable: it is the compact, stable way to identify a task in every
 * conversation and action menu. A missing, malformed, or old preference instead shows every
 * optional column, so an operator never loses information because a saved browser value aged out.
 */
export function readTaskColumns(): TaskColumn[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [...TASK_COLUMNS]
    const current = window.localStorage.getItem(TASK_COLUMNS_V2_KEY)
    const raw = current ?? window.localStorage.getItem(TASK_COLUMNS_KEY)
    if (!raw) return [...TASK_COLUMNS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...TASK_COLUMNS]
    const known = TASK_COLUMNS.filter((column) => parsed.includes(column))
    // `[]` is a deliberate compact table. A non-empty list with no known name is an obsolete
    // preference, and showing nothing because a column was renamed is not a reasonable migration.
    if (parsed.length > 0 && known.length === 0) return [...TASK_COLUMNS]
    // Existing displays keep their chosen columns and gain the newly added Type column once.
    if (current === null && parsed.length > 0 && !known.includes('kind')) {
      const title = known.indexOf('title')
      known.splice(title < 0 ? 0 : title + 1, 0, 'kind')
    }
    return known
  } catch {
    return [...TASK_COLUMNS]
  }
}

export function writeTaskColumns(columns: TaskColumn[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TASK_COLUMNS_V2_KEY, JSON.stringify(columns))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const TASK_SORTS: readonly TaskSort[] = [
  'seq',
  'title',
  'kind',
  'from',
  'worker',
  'dep',
  'took',
  'price',
  'quality',
  'created',
  'updated',
  'status'
]

export const DEFAULT_TASK_SORT: { sort: TaskSort; asc: boolean } = { sort: 'updated', asc: false }

/**
 * Which column the task table was ordered by, and which way.
 *
 * ⛔ **The bug this exists for (t353):** opening a task unmounts the table, and the order lived only
 * in component state — so `← Tasks` put a table somebody had sorted by price back on *updated*,
 * after every task they opened. It also silently discarded the page offset, which is only restored
 * onto the same sort.
 *
 * ⚠️ Read as a pair or not at all. A column with no direction, or a column that is no longer
 * sortable, falls back to the default rather than half-applying: `price` ascending and `price`
 * descending are different tables, and guessing the direction is guessing which one they wanted.
 */
export function readTaskSort(): { sort: TaskSort; asc: boolean } {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_TASK_SORT }
    const raw = window.localStorage.getItem(TASK_SORT_KEY)
    if (!raw) return { ...DEFAULT_TASK_SORT }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TASK_SORT }
    const { sort, asc } = parsed as { sort?: unknown; asc?: unknown }
    if (typeof asc !== 'boolean' || !TASK_SORTS.includes(sort as TaskSort)) return { ...DEFAULT_TASK_SORT }
    return { sort: sort as TaskSort, asc }
  } catch {
    return { ...DEFAULT_TASK_SORT }
  }
}

export function writeTaskSort(sort: TaskSort, asc: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TASK_SORT_KEY, JSON.stringify({ sort, asc }))
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

const PAGE_SIZE_KEY = appKey('taskPageSize')
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

const DIFF_VIEW_KEY = appKey('diffView')

/**
 * Which layout a patch is drawn in: one column, or the old and new side by side.
 *
 * ⛔ **A person's preference, not a task's.** Whether a two-column diff is readable depends on the
 * width of the window in front of somebody and on how they were taught to read patches — so it is
 * remembered here rather than in settings, where it would push one operator's layout onto another's
 * screen. ⚠️ `unified` is the default because it is what `git` itself prints, and because the
 * pairing the split view does is positional: a moved line can sit opposite an unrelated one, and the
 * layout that cannot mislead that way is the one a fresh install should open in.
 */
export type DiffView = 'unified' | 'split'

export function readDiffView(): DiffView {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'unified'
    // ⛔ Only the one value opts in, the same rule `readFleetDensity` follows: anything else —
    // absent, empty, a layout since renamed — reads as the default rather than as a blank panel.
    return window.localStorage.getItem(DIFF_VIEW_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

export function writeDiffView(view: DiffView): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIFF_VIEW_KEY, view)
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const QUALITY_GRADABLE_ONLY_KEY = appKey('qualityGradableOnly')

/**
 * Whether the Quality Review page filters out tasks that cannot be graded.
 *
 * ⛔ Per-display preference stored in `localStorage`, consistent with task view filters and sidebar width.
 */
export function readQualityGradableOnly(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(QUALITY_GRADABLE_ONLY_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeQualityGradableOnly(gradableOnly: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(QUALITY_GRADABLE_ONLY_KEY, String(gradableOnly))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}




const STATISTICS_WINDOW_KEY = appKey('statisticsWindow')

/**
 * How far back Analytics › Statistics reads: the last 200 finished tasks, or every one.
 *
 * ⛔ Only the one value opts in. Anything else — absent, empty, a window that has since been
 * renamed — reads as `recent`, because the default has to be the bounded read. Per-display, in
 * `localStorage`, on the precedent every other preference here sets.
 */
export function readStatisticsWindow(): StatisticsWindow {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'recent'
    return window.localStorage.getItem(STATISTICS_WINDOW_KEY) === 'all' ? 'all' : 'recent'
  } catch {
    return 'recent'
  }
}

export function writeStatisticsWindow(value: StatisticsWindow): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(STATISTICS_WINDOW_KEY, value)
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const STATISTICS_EXCLUDE_API_MIXED_KEY = appKey('statisticsExcludeApiMixed')

/**
 * Whether the trade-off scatters' "Exclude API rate & mixed" filter was on last time.
 *
 * ⛔ Reported 2026-09-13: the checkbox reset to off on every navigation and app restart because it
 * lived only in the plot's own component state (`ThreeAxisPlot` at the time; now `TradeoffPlots`).
 * Per-display preference stored in `localStorage`, consistent with every other checkbox on this page.
 */
export function readStatisticsExcludeApiMixed(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(STATISTICS_EXCLUDE_API_MIXED_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeStatisticsExcludeApiMixed(value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(STATISTICS_EXCLUDE_API_MIXED_KEY, String(value))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const STATISTICS_INCLUDE_CONVERSATIONS_KEY = appKey('statisticsIncludeConversations')

/**
 * Whether Analytics › Statistics folds conversation-kind tasks into every tab.
 *
 * ⛔ Opt-out, never opt-in: anything but an explicit `'false'` reads `true`, so a stale or
 * mistyped preference cannot silently narrow the page — the same rule the daemon applies to the
 * RPC param. Per-display, in `localStorage`, on the precedent every other preference here sets.
 */
export function readStatisticsIncludeConversations(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true
    return window.localStorage.getItem(STATISTICS_INCLUDE_CONVERSATIONS_KEY) !== 'false'
  } catch {
    return true
  }
}

export function writeStatisticsIncludeConversations(value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(STATISTICS_INCLUDE_CONVERSATIONS_KEY, String(value))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

const TASK_PAGE_KEY = appKey('taskPage')

/** What the task list was showing, precise enough that restoring an offset onto it is honest. */
export interface TaskListScope {
  /** The project whose list this is, or absent for the fleet-wide one. */
  projectId?: string
  views: TaskView[]
  sort: string
  asc: boolean
  pageSize: number
  search: string
}

/**
 * One string standing for *which list this offset belongs to*.
 *
 * ⛔ Restoring page 4 is only ever right for the **same** list. The table already resets to the
 * first page whenever the filter, sort, page size or search changes, because page 4 of a filter
 * with one page draws an empty table under a chip reading `Done 3`. A remembered offset has to
 * obey the same rule, so it is stored against everything that decides what is being listed and is
 * ignored the moment any of it differs.
 *
 * ⚠️ Views are sorted before they are written. Selecting two buckets in the other order is the same
 * list, and a signature that said otherwise would throw the offset away for no reason anyone
 * sitting here could see.
 */
export function taskListSignature(scope: TaskListScope): string {
  return JSON.stringify([
    scope.projectId ?? '',
    [...scope.views].sort(),
    scope.sort,
    scope.asc,
    scope.pageSize,
    scope.search.trim()
  ])
}

/**
 * Which page of `signature`'s list was last being read, or 0 for any list this has not seen.
 *
 * ⛔ **Not component state, because the list does not survive the trip.** Opening a task replaces
 * the table with the thread, which unmounts it; `← Tasks` mounts a fresh one that has never heard
 * of page 4. An operator working through the back of a long list had to re-navigate there after
 * every single task they opened.
 *
 * ⚠️ `localStorage` rather than the route, on the precedent every other per-display preference here
 * sets — and it is guarded in both directions, because it throws rather than returning null in real
 * configurations.
 */
export function readTaskPage(signature: string): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 0
    const raw = window.localStorage.getItem(TASK_PAGE_KEY)
    if (!raw) return 0
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return 0
    const held = parsed as { signature?: unknown; page?: unknown }
    if (held.signature !== signature) return 0
    if (typeof held.page !== 'number' || !Number.isInteger(held.page) || held.page < 0) return 0
    return held.page
  } catch {
    return 0
  }
}

/**
 * ⚠️ One slot, not one per list. Only the list you last left can be the one you are coming back to,
 * and a map keyed by signature would grow an entry for every search anybody ever typed.
 */
export function writeTaskPage(signature: string, page: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TASK_PAGE_KEY, JSON.stringify({ signature, page }))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}
