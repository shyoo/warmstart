/**
 * The Diff pane's state: what it is showing, who may open it, and when it closes by itself.
 *
 * ⛔ **One request, owned by the shell.** The pane is a column of `App.tsx`'s grid, to the right of
 * the work, and what it shows is one `DiffPaneRequest` held there — beside `addingTask` and the
 * other things exactly one of which may be open. `TaskThread` is mounted from four routes, so the
 * request reaches it through a context rather than four prop chains.
 *
 * ⛔ **It follows the route.** A request names a task; the moment the route stops naming that task
 * the pane closes, so a diff is never read beside a thread it does not belong to. Opening a second
 * commit of the same task *replaces* the request. Neither is a history entry — the pane is a view
 * of where you are, not a place you go. Decisions: `transient_docs/diff_pane_2026-09-13.md`.
 *
 * ⚠️ Pure functions here, the component in `components/DiffPane.tsx`, so the two rules above are
 * pinned by `diffpane.test.ts` without a DOM.
 */
import { createContext, useContext } from 'react'
import type { TaskDiffFileEntry } from '@shared/tasks'

export type DiffSource =
  | { kind: 'branch' }
  /** `subject` is for the pane's head only; the sha is what names the change. */
  | { kind: 'commit'; sha: string; subject?: string | null }

export interface DiffPaneRequest {
  taskId: string
  source: DiffSource
  /** A file to expand and scroll to, when the pane was opened from one row of the inline list. */
  focusPath?: string
}

export interface DiffPaneApi {
  request: DiffPaneRequest | null
  open: (request: DiffPaneRequest) => void
  close: () => void
}

/** The default does nothing, so a component rendered outside the shell (a test) can still mount. */
export const DiffPaneContext = createContext<DiffPaneApi>({
  request: null,
  open: () => undefined,
  close: () => undefined
})

export function useDiffPane(): DiffPaneApi {
  return useContext(DiffPaneContext)
}

/** Do two sources name the same change? */
export function sameSource(a: DiffSource, b: DiffSource): boolean {
  return a.kind === 'branch' ? b.kind === 'branch' : b.kind === 'commit' && a.sha === b.sha
}

/**
 * Should the pane stay open now that the route names `routeTaskId`?
 *
 * ⚠️ `null` is a route with no task on it — Overview, Settings — and closes the pane too: there is
 * nothing on the screen for the diff to be *of*.
 */
export function paneFollows(request: DiffPaneRequest | null, routeTaskId: string | null): boolean {
  return request !== null && routeTaskId === request.taskId
}

/**
 * ⚠️ Each expanded file is one `git diff` call the moment the pane opens, and a forty-file change
 * fired all at once is forty calls to draw text nobody has scrolled to. So: from the top, until
 * either bound is reached. Both are ceilings on a click, not on what can be read — a collapsed
 * file opens on its own click.
 */
export const EXPAND_MAX_FILES = 12
export const EXPAND_MAX_LINES = 1_500

/**
 * Which files the pane opens expanded.
 *
 * ⛔ A binary or generated file is never expanded — there is no patch to read — and it does not
 * spend the budget either. The focused file is always expanded, wherever it sits in the list,
 * because it is the one somebody pressed.
 */
export function initialExpansion(
  files: ReadonlyArray<Pick<TaskDiffFileEntry, 'path' | 'added' | 'removed' | 'binary' | 'generated'>>,
  focusPath: string | undefined
): Set<string> {
  const open = new Set<string>()
  let lines = 0
  let expanded = 0
  // ⚠️ Contiguous from the top: once a file does not fit, nothing below it is opened either, so
  // the reader sees an unbroken run of open files and then collapsed ones — not a scatter.
  let spent = false
  for (const f of files) {
    if (f.binary || f.generated) continue
    if (f.path === focusPath) {
      open.add(f.path)
      continue
    }
    const size = f.added + f.removed
    if (spent || expanded >= EXPAND_MAX_FILES || lines + size > EXPAND_MAX_LINES) {
      spent = true
      continue
    }
    open.add(f.path)
    expanded += 1
    lines += size
  }
  return open
}
