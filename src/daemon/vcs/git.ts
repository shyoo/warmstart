import type { Project } from '@shared/tasks.js'
import { git, tryGit } from '../git.js'
import { numstatEntries, patchFor, type DiffFileEntry } from '../review.js'
import {
  cleanStaleGitLocks,
  commitsOnlyOn,
  ensureWorktreePointer,
  landedRef,
  parkWorkspace,
  refreshTargetRef,
  rescueAtTip,
  trunkBaseRef,
  workspaceState
} from '../worktrees.js'
import type { VcsDriver, VcsWorkspaceEntry } from './driver.js'

function parseWorktreeList(listing: string): VcsWorkspaceEntry[] {
  const entries: VcsWorkspaceEntry[] = []
  let currentPath: string | null = null
  let currentBranch: string | null = null

  const flush = (): void => {
    if (currentPath !== null) {
      entries.push({ path: currentPath, branch: currentBranch })
    }
    currentPath = null
    currentBranch = null
  }

  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      currentPath = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      currentBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
  }
  flush()
  return entries
}

async function gitDiff(cwd: string, specs: string[]): Promise<DiffFileEntry[]>
async function gitDiff(cwd: string, specs: string[], path: string): Promise<string>
async function gitDiff(cwd: string, specs: string[], path?: string): Promise<DiffFileEntry[] | string> {
  if (path !== undefined) return patchFor(cwd, specs, path)
  return numstatEntries(cwd, specs)
}

/** Git implementation of `VcsDriver`, delegating cleanly to `worktrees.ts`, `review.ts`, and `git.ts`. */
export const gitDriver: VcsDriver = {
  capabilities: {
    sharedStore: true,
    autoSnapshot: false,
    storedConflicts: false,
    opLog: false,
    gitInterop: 'native',
    verification:
      'src/daemon/vcs/git.test.ts, src/daemon/worktrees.test.ts, src/daemon/landing.test.ts, ' +
      'src/daemon/taskdiff.test.ts, src/daemon/reviewdiff.test.ts, src/daemon/git.test.ts'
  },

  async addWorkspace(project: Project, path: string, base: string): Promise<void> {
    await git(project.root, ['worktree', 'add', '--detach', path, base])
    await ensureWorktreePointer(project, path)
    cleanStaleGitLocks(path)
  },

  async removeWorkspace(project: Project, path: string, opts?: { prune?: boolean }): Promise<void> {
    await git(project.root, ['worktree', 'remove', '--force', path])
    if (opts?.prune !== false) await git(project.root, ['worktree', 'prune'])
  },

  async pruneWorkspaces(project: Project): Promise<void> {
    await git(project.root, ['worktree', 'prune'])
  },

  async listWorkspaces(project: Project): Promise<VcsWorkspaceEntry[]> {
    const listing = await git(project.root, ['worktree', 'list', '--porcelain'])
    return parseWorktreeList(listing)
  },

  async currentBranch(path: string): Promise<string | null> {
    const out = await tryGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const trimmed = out?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
  },

  async switchBranch(path: string, branch: string, createFromBase?: string): Promise<void> {
    if (createFromBase !== undefined) {
      await git(path, ['switch', '-c', branch, createFromBase])
    } else {
      await git(path, ['switch', branch])
    }
  },

  async detachWorkspace(path: string, target: string): Promise<void> {
    await git(path, ['switch', '--detach', target])
  },

  async branchExists(project: Project, branch: string): Promise<boolean> {
    try {
      await git(project.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  },

  async createBranch(project: Project, branch: string, base?: string): Promise<void> {
    const targetBase = base ?? (await trunkBaseRef(project))
    await git(project.root, ['branch', branch, targetBase])
  },

  async deleteBranch(project: Project, branch: string): Promise<void> {
    await git(project.root, ['branch', '-D', branch])
  },

  commitsOnlyOn,
  landedRef,
  refreshTarget: refreshTargetRef,
  park: parkWorkspace,
  rescue: rescueAtTip,
  workspaceState,
  diff: gitDiff,

  async fileAt(cwd: string, rev: string, path: string): Promise<string | null> {
    return tryGit(cwd, ['show', `${rev}:${path.replace(/\\/g, '/')}`])
  },

  async push(cwd: string, remote: string, refspec: string, forceWithLease = false): Promise<void> {
    const args = forceWithLease ? ['push', '--force-with-lease', remote, refspec] : ['push', remote, refspec]
    await git(cwd, args)
  },

  async fetch(cwd: string, remote: string, refspec?: string, opts?: { prune?: boolean }): Promise<void> {
    const args = ['fetch', remote]
    if (refspec) args.push(refspec)
    if (opts?.prune) args.push('--prune')
    await git(cwd, args)
  }
}
