import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '../db.js'
import { samePath } from '../fspath.js'
import { git, makeProject, openTestDb } from '../testkit.js'
import { commitsOnlyOn as worktreeCommitsOnlyOn, landedRef as worktreeLandedRef } from '../worktrees.js'
import { driverFor, gitDriver } from './index.js'

let dataDir: string
let repoDir: string

beforeAll(() => {
  dataDir = openTestDb('agentyard-vcs-git-')
  // Resolve Windows 8.3 short paths so `git worktree list --porcelain` matches `samePath`.
  repoDir = realpathSync.native(dataDir)
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('vcs/index driverFor', () => {
  it('returns gitDriver for git and null for unsupported vcs kinds', () => {
    expect(driverFor({ vcs: 'git' })).toBe(gitDriver)
    expect(driverFor({ vcs: 'none' })).toBeNull()
    expect(driverFor({ vcs: 'jj' })).toBeNull()
  })

  it('exposes accurate git capabilities metadata', () => {
    const { verification, ...flags } = gitDriver.capabilities
    expect(flags).toEqual({
      sharedStore: true,
      autoSnapshot: false,
      storedConflicts: false,
      opLog: false,
      gitInterop: 'native'
    })
    expect(typeof verification).toBe('string')
    expect(verification.length).toBeGreaterThan(0)
  })
})

describe('gitDriver branches', () => {
  it('checks existence, creates with and without explicit base, and deletes branches', async () => {
    const project = makeProject({ dir: repoDir, name: 'branches-repo' })
    const headSha = git(project.root, 'rev-parse', 'HEAD')

    expect(await gitDriver.branchExists(project, 'main')).toBe(true)
    expect(await gitDriver.branchExists(project, 'feature/missing')).toBe(false)

    await gitDriver.createBranch(project, 'feature/from-head')
    expect(await gitDriver.branchExists(project, 'feature/from-head')).toBe(true)
    expect(git(project.root, 'rev-parse', 'feature/from-head')).toBe(headSha)

    await gitDriver.createBranch(project, 'feature/from-base', 'main')
    expect(await gitDriver.branchExists(project, 'feature/from-base')).toBe(true)
    expect(git(project.root, 'rev-parse', 'feature/from-base')).toBe(headSha)

    await gitDriver.deleteBranch(project, 'feature/from-head')
    expect(await gitDriver.branchExists(project, 'feature/from-head')).toBe(false)
    await gitDriver.deleteBranch(project, 'feature/from-base')
    expect(await gitDriver.branchExists(project, 'feature/from-base')).toBe(false)
  })
})

describe('gitDriver workspaces, currentBranch, park, rescue, and workspaceState', () => {
  it('creates, lists, parks, inspects state, and removes a worktree workspace', async () => {
    const project = makeProject({ dir: repoDir, name: 'workspace-repo' })
    const wsPath = join(repoDir, 'workspace-repo-ws1')

    await gitDriver.addWorkspace(project, wsPath, 'main')

    const listed = await gitDriver.listWorkspaces(project)
    expect(listed.some((entry) => samePath(entry.path, project.root) && entry.branch === 'main')).toBe(true)
    expect(listed.some((entry) => samePath(entry.path, wsPath) && entry.branch === null)).toBe(true)

    expect(await gitDriver.currentBranch(project.root)).toBe('main')
    expect(await gitDriver.currentBranch(wsPath)).toBeNull()
    expect(await gitDriver.rescue(wsPath)).toBeNull()

    await gitDriver.createBranch(project, 'task/t1', 'main')
    git(wsPath, 'switch', 'task/t1')
    expect(await gitDriver.currentBranch(wsPath)).toBe('task/t1')

    writeFileSync(join(wsPath, 'kept.txt'), 'edited in ws\n')
    writeFileSync(join(wsPath, 'new-file.txt'), 'untracked content\n')

    const stateDirty = await gitDriver.workspaceState(wsPath, 'main')
    expect(samePath(stateDirty.path, wsPath)).toBe(true)
    expect(stateDirty.branch).toBe('task/t1')
    expect(stateDirty.dirtyFiles).toEqual(['kept.txt'])
    expect(stateDirty.untrackedFiles).toEqual(['new-file.txt'])
    expect(stateDirty.unlandedCommits).toBe(0)

    const rescue = await gitDriver.park(project, wsPath)
    expect(rescue).not.toBeNull()
    expect(rescue?.files).toBe(2)

    expect(await gitDriver.currentBranch(wsPath)).toBeNull()

    git(wsPath, 'switch', 'task/t1')
    const rescueInfo = await gitDriver.rescue(wsPath)
    expect(rescueInfo).toEqual({ sha: rescue!.sha, files: 2 })

    const stateParked = await gitDriver.workspaceState(wsPath, 'main')
    expect(stateParked.dirtyFiles).toEqual([])
    expect(stateParked.untrackedFiles).toEqual([])
    expect(stateParked.unlandedCommits).toBe(1)

    await gitDriver.switchBranch(wsPath, 'task/t2', 'main')
    expect(await gitDriver.currentBranch(wsPath)).toBe('task/t2')
    await gitDriver.switchBranch(wsPath, 'task/t1')
    expect(await gitDriver.currentBranch(wsPath)).toBe('task/t1')
    await gitDriver.detachWorkspace(wsPath, 'main')
    expect(await gitDriver.currentBranch(wsPath)).toBeNull()

    await gitDriver.removeWorkspace(project, wsPath, { prune: false })
    await gitDriver.pruneWorkspaces(project)
    const afterRemove = await gitDriver.listWorkspaces(project)
    expect(afterRemove.some((entry) => samePath(entry.path, wsPath))).toBe(false)
  })
})

describe('gitDriver agreement with worktrees.ts and diffs/files', () => {
  it('agrees with worktrees commitsOnlyOn and landedRef without a remote', async () => {
    const project = makeProject({ dir: repoDir, name: 'agreement-local' })

    git(project.root, 'checkout', '-b', 'feature/a')
    writeFileSync(join(project.root, 'a.txt'), 'alpha\n')
    git(project.root, 'add', 'a.txt')
    git(project.root, 'commit', '-m', 'add a')

    git(project.root, 'checkout', 'main')
    git(project.root, 'checkout', '-b', 'feature/b')
    writeFileSync(join(project.root, 'b.txt'), 'beta\n')
    git(project.root, 'add', 'b.txt')
    git(project.root, 'commit', '-m', 'add b')
    git(project.root, 'checkout', 'main')

    expect(await gitDriver.landedRef(project.root, 'main')).toBe(
      await worktreeLandedRef(project.root, 'main')
    )
    expect(await gitDriver.commitsOnlyOn(project.root, 'feature/a', 'main')).toBe(
      await worktreeCommitsOnlyOn(project.root, 'feature/a', 'main')
    )
    expect(
      await gitDriver.commitsOnlyOn(project.root, 'feature/a', 'main', ['feature/b'])
    ).toBe(await worktreeCommitsOnlyOn(project.root, 'feature/a', 'main', ['feature/b']))
  })

  it('agrees with worktrees commitsOnlyOn/landedRef with origin and handles diff/fileAt/push/fetch/refreshTarget', async () => {
    const bareRemote = join(repoDir, 'origin-bare.git')
    mkdirSync(bareRemote, { recursive: true })
    git(bareRemote, 'init', '--bare', '--initial-branch=main')

    const project = makeProject({ dir: repoDir, name: 'remote-repo' })
    git(project.root, 'remote', 'add', 'origin', bareRemote)
    git(project.root, 'push', '-u', 'origin', 'main')

    // Local feature branch ahead of origin/main
    await gitDriver.createBranch(project, 'feature/diff-test', 'main')
    git(project.root, 'checkout', 'feature/diff-test')
    writeFileSync(join(project.root, 'kept.txt'), 'updated line\n')
    git(project.root, 'add', 'kept.txt')
    git(project.root, 'commit', '-m', 'update kept')
    git(project.root, 'checkout', 'main')

    expect(await gitDriver.landedRef(project.root, 'main')).toBe(
      await worktreeLandedRef(project.root, 'main')
    )
    expect(await gitDriver.commitsOnlyOn(project.root, 'feature/diff-test', 'main')).toBe(
      await worktreeCommitsOnlyOn(project.root, 'feature/diff-test', 'main')
    )

    // diff (numstat + patch) and fileAt
    const entries = await gitDriver.diff(project.root, ['main..feature/diff-test'])
    expect(entries).toEqual([{ path: 'kept.txt', added: 1, removed: 1, binary: false }])
    const patch = await gitDriver.diff(project.root, ['main..feature/diff-test'], 'kept.txt')
    expect(patch).toContain('-as committed')
    expect(patch).toContain('+updated line')

    expect(await gitDriver.fileAt(project.root, 'feature/diff-test', 'kept.txt')).toBe(
      'updated line'
    )
    expect(await gitDriver.fileAt(project.root, 'feature/diff-test', 'does-not-exist.txt')).toBeNull()

    // push feature branch, advance origin/main via a peer clone, fetch and refreshTarget
    await gitDriver.push(project.root, 'origin', 'feature/diff-test')
    expect(git(bareRemote, 'rev-parse', 'refs/heads/feature/diff-test')).toBe(
      git(project.root, 'rev-parse', 'feature/diff-test')
    )

    const peer = join(repoDir, 'peer-clone')
    git(repoDir, 'clone', bareRemote, peer)
    git(peer, 'config', 'user.name', 'agentyard test')
    git(peer, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(peer, 'upstream.txt'), 'from upstream\n')
    git(peer, 'add', 'upstream.txt')
    git(peer, 'commit', '-m', 'upstream commit')
    git(peer, 'push', 'origin', 'main')
    const upstreamSha = git(peer, 'rev-parse', 'HEAD')

    await gitDriver.fetch(project.root, 'origin', undefined, { prune: true })
    expect(git(project.root, 'rev-parse', 'origin/main')).toBe(upstreamSha)

    // Advance origin/main once more and verify refreshTarget updates origin/main (and rate-limits the repeat call).
    writeFileSync(join(peer, 'upstream2.txt'), 'second upstream commit\n')
    git(peer, 'add', 'upstream2.txt')
    git(peer, 'commit', '-m', 'second upstream commit')
    git(peer, 'push', 'origin', 'main')
    const upstreamSha2 = git(peer, 'rev-parse', 'HEAD')

    expect(await gitDriver.refreshTarget(project, 'main')).toBe(true)
    expect(git(project.root, 'rev-parse', 'origin/main')).toBe(upstreamSha2)
    expect(await gitDriver.refreshTarget(project, 'main')).toBe(false)
  })
})
