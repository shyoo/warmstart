/** The change a task is about to land, read for a person rather than for a grader. */
import type { TaskDiffFile, TaskDiffFileEntry, TaskDiffSummary } from '@shared/tasks.js'
import { getProject, landingTargetFor, policyFor } from './projects.js'
import { diffSpecs, isGeneratedPath, numstatEntries, patchFor, resolveRange } from './review.js'
import { pendingWorkFor } from './resolutions.js'
import { getTask } from './tasks.js'

/**
 * The diff a person reads before pressing Land.
 *
 * ⛔ **This is the same change the grader sees, from the same functions.** `resolveRange` picks the
 * commits and `numstatEntries`/`patchFor` read them, so the quality score and the panel are about
 * one change. The alternative — a second `git diff` written for the UI — is how a reviewer ends up
 * approving a file set the score was never about, and neither number would be wrong on its face.
 *
 * ⛔ **Read-only, and it never writes a commit or moves a ref.** Landing is `landing.ts`'s job and
 * is measured against `origin/<target>`; nothing here is part of that decision beyond showing a
 * person what it would move.
 *
 * ⚠️ It runs git, so like `task.pendingWork` it is asked when a person opens the panel and never on
 * a timer. The file list is one `--numstat` per spec; each patch is a second call, paid only when
 * somebody expands that file.
 */

/**
 * ⚠️ A cap on the *list*, not on the change. 3,000 changed files is already past the point where a
 * person reads them one by one, and the honest failure is a stated truncation rather than a renderer
 * asked to lay out fifty thousand rows.
 */
export const MAX_DIFF_FILES = 3_000

/**
 * ~200k characters of one file's patch.
 *
 * ⚠️ Larger than the grader's whole-diff budget (`DIFF_BUDGET_CHARS`, 120k) and that is deliberate:
 * the grader is spending tokens on every file at once, and this is one file a person asked for. Cut
 * at a line boundary so the last thing on screen is a whole line of somebody's code.
 */
export const MAX_PATCH_CHARS = 200_000

const NO_SUMMARY = {
  ok: false,
  base: null,
  head: null,
  from: null,
  separateCommits: 0,
  files: [],
  insertions: 0,
  deletions: 0,
  filesTruncated: false,
  uncommittedFiles: 0,
  unlandedCommits: 0,
  workspaceReadable: false
} satisfies Omit<TaskDiffSummary, 'reason'>

/**
 * Resolve the task, its project and the commits to show — the part both methods need.
 *
 * ⚠️ Returns the *reason* rather than throwing, because every failure here is a sentence the panel
 * prints. "This task has no git project" and "its branch has been retired" are different answers and
 * the second one is not an error.
 */
async function locate(taskId: string): Promise<
  | { ok: true; cwd: string; specs: string[]; base: string; head: string; from: 'commits' | 'landed' | 'branch'; separateCommits: number }
  | { ok: false; reason: string }
> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project) return { ok: false, reason: 'this task has no project, so there is no diff to show' }
  if (project.vcs !== 'git') {
    return { ok: false, reason: 'this project is not a git repository, so there is no diff to show' }
  }

  const target = landingTargetFor(task, project)
  const range = await resolveRange(task, project, target, policyFor(project).landingTarget)
  if (!range.ok) return { ok: false, reason: range.reason }

  const specs = await diffSpecs(range.cwd, range.base, range.head, range.commits)
  return {
    ok: true,
    cwd: range.cwd,
    specs,
    base: range.base,
    head: range.head,
    from: range.from,
    // One spec is a range; more than one means per-commit patches, which only happens when the
    // recorded commits are not what `base..head` contains. Said out loud rather than smoothed over.
    separateCommits: specs.length > 1 ? specs.length : 0
  }
}

/**
 * The workspace facts, which are about a different thing from the commits.
 *
 * ⚠️ `pendingWorkFor` answers `supported: false` when it could not look, and that is carried through
 * as `workspaceReadable: false` rather than as two zeroes. A zero that means "I did not look" reads
 * exactly like a zero that means "there is nothing there", and one of them loses files.
 */
async function pendingFacts(
  taskId: string
): Promise<Pick<TaskDiffSummary, 'uncommittedFiles' | 'unlandedCommits' | 'workspaceReadable'>> {
  try {
    const pending = await pendingWorkFor(taskId)
    if (!pending.supported) {
      return { uncommittedFiles: 0, unlandedCommits: 0, workspaceReadable: false }
    }
    return {
      uncommittedFiles: pending.dirtyFiles + pending.untrackedFiles,
      unlandedCommits: pending.unlandedCommits,
      workspaceReadable: true
    }
  } catch {
    return { uncommittedFiles: 0, unlandedCommits: 0, workspaceReadable: false }
  }
}

/** The changed-file list for a task, with the workspace facts beside it. */
export async function diffSummaryFor(taskId: string): Promise<TaskDiffSummary> {
  const pending = await pendingFacts(taskId)
  const at = await locate(taskId)
  if (!at.ok) return { ...NO_SUMMARY, ...pending, reason: at.reason }

  const entries = await numstatEntries(at.cwd, at.specs)
  // Biggest change first, the same order the grader reads them in: a truncated list should hold the
  // files where the work happened, not the first ones in the tree.
  const ordered = [...entries].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const files: TaskDiffFileEntry[] = ordered.slice(0, MAX_DIFF_FILES).map((e) => ({
    path: e.path,
    added: e.added,
    removed: e.removed,
    binary: e.binary,
    generated: isGeneratedPath(e.path)
  }))

  return {
    ok: true,
    reason: '',
    base: at.base,
    head: at.head,
    from: at.from,
    separateCommits: at.separateCommits,
    files,
    // ⛔ Totalled over every entry, not over the truncated list. The header says what the change is;
    // saying "+12/-3" over a list that dropped 40,000 files would be a wrong number, not a short one.
    insertions: entries.reduce((n, e) => n + e.added, 0),
    deletions: entries.reduce((n, e) => n + e.removed, 0),
    filesTruncated: ordered.length > MAX_DIFF_FILES,
    ...pending
  }
}

/** One file's patch, capped and cut at a line boundary. */
export async function diffFileFor(taskId: string, path: string): Promise<TaskDiffFile> {
  const none = { ok: false, path, patch: '', truncated: false, bytes: 0 }
  const at = await locate(taskId)
  if (!at.ok) return { ...none, reason: at.reason }

  // ⛔ Asked of the same entry list the summary drew, so a path the panel cannot have shown cannot
  // be read through this method either. It takes a path from the renderer, and the renderer is the
  // one process here that does not get to name a file on disk.
  const entries = await numstatEntries(at.cwd, at.specs)
  const entry = entries.find((e) => e.path === path)
  if (!entry) return { ...none, reason: 'that file is not part of this task’s change' }
  if (entry.binary) return { ...none, reason: 'this file is binary, so there is nothing to show' }
  if (isGeneratedPath(path)) {
    return { ...none, reason: 'this file is generated, so it is counted but not shown' }
  }

  const full = await patchFor(at.cwd, at.specs, path)
  const bytes = full.length
  if (bytes <= MAX_PATCH_CHARS) {
    return { ok: true, reason: '', path, patch: full, truncated: false, bytes }
  }
  // Cut back to the last complete line inside the cap, so nothing renders half a line of code. A
  // patch with no newline at all inside the cap is cut at the cap; there is no line to keep.
  const cut = full.slice(0, MAX_PATCH_CHARS)
  const lastBreak = cut.lastIndexOf('\n')
  return {
    ok: true,
    reason: '',
    path,
    patch: lastBreak > 0 ? cut.slice(0, lastBreak) : cut,
    truncated: true,
    bytes
  }
}
