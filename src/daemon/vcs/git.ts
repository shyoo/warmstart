import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors.js'
import type { Project } from '@shared/tasks.js'
import { git, tryGit } from '../git.js'
import { log } from '../log.js'
import { numstatEntries, patchFor, type DiffFileEntry } from '../review.js'
import {
  cleanStaleGitLocks,
  ensureWorktreePointer,
  gitCatchUpEmptyBranch,
  gitCommitsOnlyOn,
  gitLandedRef,
  gitParkWorkspace,
  gitRefreshTargetRef,
  gitRescueAtTip,
  gitRescueDirty,
  gitWorkspaceState,
  repairTrunkConfig,
  trunkBaseRef
} from '../worktrees.js'
import type { VcsDriver, VcsRebaseResult, VcsWorkspaceEntry } from './driver.js'

function porcelainNames(out: string): string[] {
  const names: string[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^\S{1,2}\s+(.+)$/)
    const name = (m?.[1] ?? trimmed).trim()
    if (name) names.push(name)
  }
  return names
}

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

  isWorkspace(path: string): boolean {
    return existsSync(join(path, '.git'))
  },

  async currentBranch(path: string): Promise<string | null> {
    const out = await tryGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const trimmed = out?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
  },

  async trunkBranch(root: string, _expectedTarget?: string): Promise<string | null> {
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return head === 'HEAD' ? null : head
  },

  async trunkNotReady(root: string, target: string): Promise<string | null> {
    // ⛔ t446 and t447 both stopped here with *fatal: Invalid path '/mnt'*: a `core.worktree` a bridged
    // agent's test run had written into the trunk's config. See `repairTrunkConfig`.
    repairTrunkConfig({ root, vcs: 'git' })
    try {
      const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (head !== target) {
        return head === 'HEAD'
          ? `the trunk is on a detached HEAD rather than \`${target}\` — switch the trunk checkout back to \`${target}\` to let the merge run`
          : `the trunk has \`${head}\` checked out rather than \`${target}\` — switch the trunk checkout back to \`${target}\` to let the merge run`
      }
      const dirty = await git(root, ['status', '--porcelain'])
      const lines = dirty.split(/\r?\n/).filter((l) => l.trim() !== '')
      if (lines.length > 0) {
        const untracked = lines.filter((l) => l.trim().startsWith('??')).length
        const tracked = lines.length - untracked
        const names = porcelainNames(dirty).slice(0, 5).join(', ')
        const more = lines.length > 5 ? `, +${lines.length - 5} more` : ''
        return (
          `the trunk has ${lines.length} uncommitted file(s) in it ` +
          `(${tracked} modified/tracked, ${untracked} untracked): ${names}${more}. ` +
          `Commit, stash, or clear them in the trunk checkout (${root}) so the merge can run`
        )
      }
      return null
    } catch (err) {
      return `the trunk could not be read: ${errorMessage(err)}`
    }
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

  commitsOnlyOn: (cwd, branch, target, also, resolvedTargetRefs) =>
    gitCommitsOnlyOn(cwd, branch, target, also, resolvedTargetRefs),
  landedRef: (path, target) => gitLandedRef(path, target),
  refreshTarget: (project, target) => gitRefreshTargetRef(project, target),
  park: (project, path) => gitParkWorkspace(project, path),
  rescueDirty: (path, destination) => gitRescueDirty(path, destination),
  catchUpEmptyBranch: (path, branch, base) => gitCatchUpEmptyBranch(path, branch, base),
  rescue: (path) => gitRescueAtTip(path),
  workspaceState: (path, target) => gitWorkspaceState(path, target),

  async hasUncommittedChanges(workspacePath: string, opts?: { ignoreUntracked?: boolean }): Promise<boolean> {
    const status = await git(workspacePath, ['status', '--porcelain'])
    if (status.length === 0) return false
    if (!opts?.ignoreUntracked) return true
    return status
      .split(/\r?\n/)
      .some((line) => line.trim().length > 0 && !line.startsWith('??'))
  },

  async hasConflicts(_cwd: string, _rev: string): Promise<boolean> {
    return false
  },

  async conflictedPaths(cwd: string, _rev?: string): Promise<string[]> {
    try {
      const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
      return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
    } catch {
      return []
    }
  },

  async rebaseBranch(
    workspacePath: string,
    _branch: string,
    base: string,
    opts?: { keepOnConflict?: boolean }
  ): Promise<VcsRebaseResult> {
    try {
      await git(workspacePath, ['rebase', base])
      return { ok: true }
    } catch (err) {
      const paths = await gitDriver.conflictedPaths(workspacePath)
      if (!opts?.keepOnConflict) {
        await git(workspacePath, ['rebase', '--abort']).catch(() => undefined)
      }
      return {
        ok: false,
        conflicted: paths.length > 0,
        reason: `rebase onto ${base} conflicted: ${errorMessage(err)}`,
        ...(paths.length > 0 ? { conflictedPaths: paths } : {})
      }
    }
  },

  async abortRebase(workspacePath: string): Promise<void> {
    await git(workspacePath, ['rebase', '--abort']).catch(() => undefined)
  },

  async fastForwardTrunk(project: Project, _target: string, branch: string, _commit: string): Promise<void> {
    await git(project.root, ['merge', '--ff-only', branch])
  },

  async fastForwardBranch(
    _project: Project,
    workspacePath: string,
    target: string,
    commit: string,
    expectedBaseSha: string | null
  ): Promise<void> {
    await git(workspacePath, [
      'update-ref',
      `refs/heads/${target}`,
      commit,
      ...(expectedBaseSha ? [expectedBaseSha] : [])
    ])
  },

  async pushToTarget(cwd: string, remote: string, _branch: string, target: string): Promise<void> {
    await git(cwd, ['push', remote, `HEAD:${target}`])
  },

  async retireBranch(cwd: string, _project: Project, branch: string): Promise<boolean> {
    try {
      if ((await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) === branch) {
        await git(cwd, ['switch', '--detach', await git(cwd, ['rev-parse', 'HEAD'])])
      }
      await git(cwd, ['branch', '-D', branch])
      return true
    } catch (err) {
      // ⚠️ Still untidy rather than a failure, but said: t976's refusal left no trace at all (t977).
      log.info(`kept ${branch}: ${errorMessage(err)}`)
      return false
    }
  },

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
