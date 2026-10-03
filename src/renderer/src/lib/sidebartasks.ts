import type { Project, Task, TaskStatus } from '@shared/tasks'
import { appKey } from './storagekeys'

/**
 * The tasks a project lists under itself in the sidebar (t479 for conversations, 2026-09-16;
 * widened to every kind at t901, 2026-10-03).
 *
 * ⛔ **Unfinished, not running.** A conversation ends every turn back at `awaiting_human` — that is
 * what the kind *is* — so "the ones that are running" would drop a conversation the moment the agent
 * stopped to wait for a reply, which is exactly when the person wants to switch to it. What takes a
 * task off this list is the person finishing it, cancelling it or deleting it; a paused, queued,
 * blocked, failed or quota-held one is still work they are in the middle of. (Operator's decision,
 * t479; every kind, t901.) A draft is not work yet: nothing has been dispatched on it.
 *
 * ⚠️ Newest activity first, so the one you were just in is at the top — the same order the Tasks
 * board defaults to (`DEFAULT_TASK_SORT`). Plan pieces are listed flat, like any other task.
 *
 * ⚠️ **Capped** (operator's decision, t901): a busy project would otherwise push its whole queue
 * into the sidebar. What does not fit is counted, and the count opens the Tasks board.
 */
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'cancelled', 'draft'])

export const SIDEBAR_TASK_CAP = 8

type SidebarRow = Pick<Task, 'status' | 'projectId' | 'deletedAt' | 'updatedAt'>

type ProjectRoute = { kind: string; id?: string; tab?: string; taskId?: string }

/**
 * A listed task owns the sidebar selection while its thread is open. Other project tabs, and
 * threads not listed beneath this project (including any past the cap), leave the project row
 * selected as the scope cue.
 */
export function projectSidebarActive(
  route: ProjectRoute,
  projectId: string,
  listed: ReadonlyArray<Pick<Task, 'id'>>
): boolean {
  if (route.kind !== 'project' || route.id !== projectId) return false
  return route.tab !== 'thread' || !route.taskId || !listed.some((task) => task.id === route.taskId)
}

export function openTasks<T extends SidebarRow>(
  tasks: ReadonlyArray<T>,
  projectId: string,
  cap = SIDEBAR_TASK_CAP
): { shown: T[]; hidden: number } {
  const open = tasks
    .filter((t) => t.projectId === projectId && t.deletedAt === null && !FINISHED.has(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { shown: open.slice(0, cap), hidden: Math.max(0, open.length - cap) }
}

/**
 * Which projects have their task list folded away.
 *
 * ⚠️ A property of the person and the screen, like the fleet strip's collapsed state, so it lives in
 * `localStorage` and never syncs to another machine. Stored as the set of *collapsed* project ids:
 * the default is open, so a project seen for the first time shows what it has. ⛔ The key keeps
 * its t479 name: renaming it would unfold every project somebody had folded.
 */
const COLLAPSED_KEY = appKey('sidebarConversationsCollapsed')

export function readCollapsedProjects(): Set<string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return new Set()
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeCollapsedProjects(collapsed: ReadonlySet<string>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}

/**
 * Which projects the sidebar lists (t901). Active is the default, and the choice is per machine, like
 * the fold. ⚠️ Only the sidebar honours it: every other picker reads `project.list`, which never
 * returns an archived project, because no new work may be filed into one.
 */
export type ProjectFilter = 'active' | 'archived' | 'all'

export const PROJECT_FILTERS: ReadonlyArray<{ id: ProjectFilter; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' }
]

const FILTER_KEY = appKey('sidebarProjectFilter')

export function readProjectFilter(): ProjectFilter {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'active'
    const raw = window.localStorage.getItem(FILTER_KEY)
    return raw === 'archived' || raw === 'all' ? raw : 'active'
  } catch {
    return 'active'
  }
}

export function writeProjectFilter(filter: ProjectFilter): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(FILTER_KEY, filter)
  } catch {
    // As above.
  }
}

/** Active projects in their order, then archived ones in theirs. */
export function sidebarProjects<P extends Pick<Project, 'id' | 'archivedAt'>>(
  active: ReadonlyArray<P>,
  archived: ReadonlyArray<P>,
  filter: ProjectFilter
): P[] {
  if (filter === 'active') return [...active]
  if (filter === 'archived') return [...archived]
  return [...active, ...archived]
}
