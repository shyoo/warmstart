import type { Task, TaskStatus } from '@shared/tasks'
import { appKey } from './storagekeys'

/**
 * The conversations a project lists under itself in the sidebar (t479, 2026-09-16).
 *
 * ⛔ **Unfinished, not running.** A conversation ends every turn back at `awaiting_human` — that is
 * what the kind *is* — so "the ones that are running" would drop a conversation the moment the agent
 * stopped to wait for a reply, which is exactly when the person wants to switch to it. What takes a
 * conversation off this list is the person finishing it, cancelling it or deleting it; a paused,
 * queued or quota-held one is still a conversation they are in the middle of. (Operator's decision,
 * t479.) A draft is not a conversation yet: nothing has been said on it.
 *
 * ⚠️ Newest activity first, so the one you were just talking to is at the top — the same order the
 * Tasks board defaults to (`DEFAULT_TASK_SORT`).
 */
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'cancelled', 'draft'])

type ConversationRow = Pick<Task, 'kind' | 'status' | 'projectId' | 'deletedAt' | 'updatedAt'>

type ProjectRoute = { kind: string; id?: string; tab?: string; taskId?: string }

/**
 * A listed conversation owns the sidebar selection while its thread is open. Other project tabs,
 * and threads not listed beneath this project, leave the project row selected as the scope cue.
 */
export function projectSidebarActive(
  route: ProjectRoute,
  projectId: string,
  conversations: ReadonlyArray<Pick<Task, 'id'>>
): boolean {
  if (route.kind !== 'project' || route.id !== projectId) return false
  return route.tab !== 'thread' || !route.taskId || !conversations.some((conversation) => conversation.id === route.taskId)
}

export function openConversations<T extends ConversationRow>(
  tasks: ReadonlyArray<T>,
  projectId: string
): T[] {
  return tasks
    .filter(
      (t) =>
        t.projectId === projectId &&
        t.kind === 'conversation' &&
        t.deletedAt === null &&
        !FINISHED.has(t.status)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Which projects have their conversation list folded away.
 *
 * ⚠️ A property of the person and the screen, like the fleet strip's collapsed state, so it lives in
 * `localStorage` and never syncs to another machine. Stored as the set of *collapsed* project ids:
 * the default is open, so a project seen for the first time shows what it has.
 */
const COLLAPSED_KEY = appKey('sidebarConversationsCollapsed')

export function readCollapsedConversations(): Set<string> {
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

export function writeCollapsedConversations(collapsed: ReadonlySet<string>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // A preference that cannot be saved is not an error worth showing anybody.
  }
}
