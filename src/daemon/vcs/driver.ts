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

/** Result returned by `rebaseBranch`. */
export type VcsRebaseResult =
  | { ok: true }
  | { ok: false; conflicted: boolean; reason: string; conflictedPaths?: string[] }

/**
 * Operations over a project's repositories, workspaces, branches, and diffs.
 */
export interface VcsDriver {
  readonly capabilities: VcsCapabilities

  /** Create a detached pooled workspace at `path` checked out to `base`. */
  addWorkspace(project: Project, path: string, base: string): Promise<void>
  /** Remove the workspace at `path`, pruning stale workspace metadata unless `opts.prune === false`. */
  removeWorkspace(project: Project, path: string, opts?: { prune?: boolean }): Promise<void>
  /** Prune stale workspace metadata for `project`. */
  pruneWorkspaces(project: Project): Promise<void>
  /** List registered workspaces for `project` along with any checked-out branch name. */
  listWorkspaces(project: Project): Promise<VcsWorkspaceEntry[]>
  /** Report whether `path` on disk holds an initialized workspace for this driver. */
  isWorkspace(path: string): boolean
  /** Return the checked-out branch name at `path`, or `null` when detached. */
  currentBranch(path: string): Promise<string | null>
  /** Return the branch/bookmark name the trunk at `root` sits on, preferring `expectedTarget` when shared. */
  trunkBranch(root: string, expectedTarget?: string): Promise<string | null>
  /** Return a human-readable refusal if the trunk at `root` cannot accept a fast-forward onto `target`, else `null`. */
  trunkNotReady(root: string, target: string): Promise<string | null>
  /** Switch `path` to `branch`, or create it from `createFromBase` and check it out. */
  switchBranch(path: string, branch: string, createFromBase?: string): Promise<void>
  /** Detach the workspace at `path` onto `target` so its previous branch is free. */
  detachWorkspace(path: string, target: string): Promise<void>
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
  /** Preserve uncommitted edits at `path` in-place without detaching the workspace. */
  rescueDirty(path: string, destination: string): Promise<Rescue | null>
  /** Advance an empty, clean task branch to `base` before work resumes on it. */
  catchUpEmptyBranch(path: string, branch: string, base: string): Promise<void>
  /** Return rescued-tip metadata when tip at `path` carries a daemon rescue trailer, else `null`. */
  rescue(path: string): Promise<{ sha: string; files: number } | null>
  /** Measure branch, dirty/untracked files, unlanded commits, landed ref, target lag, and stashes at `path`. */
  workspaceState(path: string, target: string): Promise<WorkspaceState>
  /** Report whether `workspacePath` has uncommitted work that should block landing or branch switch. */
  hasUncommittedChanges(workspacePath: string, opts?: { ignoreUntracked?: boolean }): Promise<boolean>
  /** Report whether revision `rev` carries stored conflicts. */
  hasConflicts(cwd: string, rev: string): Promise<boolean>
  /** List conflicted file paths at `cwd` (and optional revision `rev`). */
  conflictedPaths(cwd: string, rev?: string): Promise<string[]>
  /** Rebase `branch` onto `base` cleanly, aborting or reverting on conflict unless `opts.keepOnConflict` is true. */
  rebaseBranch(
    workspacePath: string,
    branch: string,
    base: string,
    opts?: { keepOnConflict?: boolean }
  ): Promise<VcsRebaseResult>
  /** Undo an unresolved conflict rebase left open by `rebaseBranch(..., { keepOnConflict: true })`. */
  abortRebase(workspacePath: string): Promise<void>
  /** Fast-forward the project trunk at `target` to `commit` (never rewriting history). */
  fastForwardTrunk(project: Project, target: string, branch: string, commit: string): Promise<void>
  /** Fast-forward target ref `target` in `project` to `commit` with compare-and-swap against `expectedBaseSha`. */
  fastForwardBranch(
    project: Project,
    workspacePath: string,
    target: string,
    commit: string,
    expectedBaseSha: string | null
  ): Promise<void>
  /** Push `branch`'s `commit` onto `remote` branch `target`. */
  pushToTarget(cwd: string, remote: string, branch: string, target: string): Promise<void>
  /** Detach if needed and remove branch/bookmark `branch` once its work is accounted for. */
  retireBranch(cwd: string, project: Project, branch: string): Promise<boolean>
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
