import type { Project } from '@shared/tasks.js'
import type { DiffFileEntry } from '../review.js'
import type { Rescue, WorkspaceState } from '../worktrees.js'

/**
 * Capabilities declared by a version-control backend (mirrors `AdapterInfo.capabilities` so
 * callers ask what a backend supports rather than branching on `project.vcs` name).
 */
export interface VcsCapabilities {
  sharedStore: boolean
  autoSnapshot: boolean
  storedConflicts: boolean
  opLog: boolean
  gitInterop: 'native' | 'colocated' | 'none'
  verification: string
}

/** Workspace path and optional checked-out branch reported by `listWorkspaces`. */
export interface VcsWorkspaceEntry {
  path: string
  branch: string | null
}

/**
 * Operations over a project's repositories, workspaces, branches, and diffs.
 *
 * Phase 1 extraction seam (`src/daemon/vcs/`): implemented by `gitDriver` without changing any
 * existing caller or behavior.
 */
export interface VcsDriver {
  readonly capabilities: VcsCapabilities

  /** Create a detached pooled workspace at `path` checked out to `base`. */
  addWorkspace(project: Project, path: string, base: string): Promise<void>
  /** Remove the workspace at `path` and prune stale workspace metadata. */
  removeWorkspace(project: Project, path: string): Promise<void>
  /** List registered workspaces for `project` along with any checked-out branch name. */
  listWorkspaces(project: Project): Promise<VcsWorkspaceEntry[]>
  /** Return the checked-out branch name at `path`, or `null` when detached. */
  currentBranch(path: string): Promise<string | null>
  /** Report whether `branch` exists in `project`. */
  branchExists(project: Project, branch: string): Promise<boolean>
  /** Create `branch` at `base` (or the resolved trunk base ref) without switching trunk HEAD. */
  createBranch(project: Project, branch: string, base?: string): Promise<void>
  /** Delete `branch` from `project`. */
  deleteBranch(project: Project, branch: string): Promise<void>
  /** Count commits reachable from `branch` that are not on `target`, `origin/<target>`, or `also`. */
  commitsOnlyOn(
    cwd: string,
    branch: string,
    target: string,
    also?: readonly string[],
    resolvedTargetRefs?: readonly string[]
  ): Promise<number>
  /** Return the ref that defines landed state for `target` (`origin/<target>` when present, else `target`). */
  landedRef(path: string, target: string): Promise<string>
  /** Refresh remote tracking state for `target` cleanly without moving any checkout. */
  refreshTarget(project: Project, target: string): Promise<boolean>
  /** Preserve uncommitted edits on `path` (never trunk) and detach it from its task branch. */
  park(project: Project, path: string): Promise<Rescue | null>
  /** Return rescued-tip metadata when HEAD at `path` carries a daemon rescue trailer, else `null`. */
  rescue(path: string): Promise<{ sha: string; files: number } | null>
  /** Measure branch, dirty/untracked files, unlanded commits, landed ref, target lag, and stashes at `path`. */
  workspaceState(path: string, target: string): Promise<WorkspaceState>
  /** Return changed-file numstat entries for `specs`, or a single file's patch when `path` is given. */
  diff(cwd: string, specs: string[]): Promise<DiffFileEntry[]>
  diff(cwd: string, specs: string[], path: string): Promise<string>
  /** Read raw file content at revision `rev` and repo-relative `path`, or `null` when absent. */
  fileAt(cwd: string, rev: string, path: string): Promise<string | null>
  /** Push `refspec` to `remote`, optionally using `--force-with-lease`. */
  push(cwd: string, remote: string, refspec: string, forceWithLease?: boolean): Promise<void>
  /** Fetch from `remote` with an optional `refspec` and `--prune` flag. */
  fetch(cwd: string, remote: string, refspec?: string, opts?: { prune?: boolean }): Promise<void>
}
