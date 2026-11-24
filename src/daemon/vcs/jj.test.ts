import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'
import { closeDb } from '../db.js'
import { samePath } from '../fspath.js'
import { addProject } from '../projects.js'
import { git, makeRepo, openTestDb } from '../testkit.js'
import { launchArgs, spawnEnv, which } from '../which.js'
import { RESCUE_TRAILER } from '../worktrees.js'
import {
  _resetJjDriverCachesForTest,
  assertJjRootLength,
  assertJjVersionSupported,
  compareSemver,
  JJ_MAX_ROOT_LENGTH,
  JJ_MIN_VERSION,
  jjConflicted,
  jjDriver,
  parseJjVersion,
  resolveJjRepoRoot
} from './jj.js'

function probeJjHost(): { available: boolean; reason: string; version: string | null } {
  const binary = which('jj')
  if (!binary) {
    return { available: false, reason: 'jj executable not found on PATH', version: null }
  }
  try {
    const launched = launchArgs(binary, ['--version'])
    const out = execFileSync(launched.command, launched.args, {
      env: spawnEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }).trim()
    const parsed = parseJjVersion(out)
    if (!parsed) {
      return { available: false, reason: `unrecognized jj --version output: ${out}`, version: null }
    }
    if (compareSemver(parsed, JJ_MIN_VERSION) < 0) {
      return {
        available: false,
        reason: `jj ${parsed} is below minimum ${JJ_MIN_VERSION}`,
        version: parsed
      }
    }
    return { available: true, reason: `jj ${parsed} available`, version: parsed }
  } catch (err) {
    return {
      available: false,
      reason: `jj could not be launched: ${err instanceof Error ? err.message : String(err)}`,
      version: null
    }
  }
}

function runJjSync(cwd: string, ...args: string[]): string {
  const binary = which('jj')
  if (!binary) throw new Error('jj binary unavailable')
  const launched = launchArgs(binary, ['--no-pager', ...args])
  return execFileSync(launched.command, launched.args, {
    cwd,
    env: spawnEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim()
}

const jjHost = probeJjHost()

describe('jjDriver pure guards and metadata', () => {
  it('exposes colocated capabilities metadata naming jj 0.46.0', () => {
    const { verification, ...flags } = jjDriver.capabilities
    expect(flags).toEqual({
      sharedStore: true,
      autoSnapshot: true,
      storedConflicts: true,
      opLog: true,
      gitInterop: 'colocated'
    })
    expect(verification).toContain(JJ_MIN_VERSION)
  })

  it('enforces the ~106-character repository root length limit', () => {
    expect(JJ_MAX_ROOT_LENGTH).toBe(106)
    const okRoot = 'C:\\' + 'a'.repeat(JJ_MAX_ROOT_LENGTH - 3)
    expect(okRoot.length).toBe(JJ_MAX_ROOT_LENGTH)
    expect(() => assertJjRootLength(okRoot)).not.toThrow()

    const tooLong = 'C:\\' + 'a'.repeat(JJ_MAX_ROOT_LENGTH - 2)
    expect(tooLong.length).toBe(JJ_MAX_ROOT_LENGTH + 1)
    expect(() => assertJjRootLength(tooLong)).toThrow(/106/)
  })

  it('resolves secondary colocated .jj/repo pointer files to the shared repo root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jjptr-'))
    try {
      const mainRepo = join(dir, 'repo')
      const ws = join(dir, 'repo_workspaces', 'ws1')
      mkdirSync(join(mainRepo, '.jj', 'repo'), { recursive: true })
      mkdirSync(join(ws, '.jj'), { recursive: true })
      writeFileSync(join(ws, '.jj', 'repo'), '../../../repo/.jj/repo\n', 'utf8')

      expect(samePath(resolveJjRepoRoot(mainRepo), mainRepo)).toBe(true)
      expect(samePath(resolveJjRepoRoot(ws), mainRepo)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses and compares jj versions against the pinned 0.46.0 minimum', () => {
    expect(JJ_MIN_VERSION).toBe('0.46.0')
    expect(parseJjVersion('jj 0.46.0-7d382314f9420b4b8d932245b49c99492c812b9f')).toBe('0.46.0')
    expect(parseJjVersion('jj 0.45.2')).toBe('0.45.2')
    expect(parseJjVersion('not a version')).toBeNull()

    expect(compareSemver('0.46.0', '0.46.0')).toBe(0)
    expect(compareSemver('0.46.1', '0.46.0')).toBe(1)
    expect(compareSemver('0.47.0', '0.46.9')).toBe(1)
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1)
    expect(compareSemver('0.45.9', '0.46.0')).toBe(-1)

    expect(assertJjVersionSupported('jj 0.46.0-7d38231')).toBe('0.46.0')
    expect(assertJjVersionSupported('jj 0.47.0')).toBe('0.47.0')
    expect(() => assertJjVersionSupported('jj 0.45.0')).toThrow(/0\.46\.0/)
    expect(() => assertJjVersionSupported('unknown')).toThrow(/Could not determine jj version/)
  })

  function dummyProject(root: string, id = 'p1'): Project {
    return {
      id,
      name: 'jj-fixture',
      root,
      vcs: 'jj',
      config: { schema_version: 1, name: 'jj-fixture', vcs: 'jj' },
      configPath: null,
      createdAt: 0,
      archivedAt: null,
      rootExists: true
    }
  }

  it('throws "jj is not installed" when jj cannot be resolved on PATH', async () => {
    const prevPath = process.env.PATH
    _resetJjDriverCachesForTest()
    process.env.PATH = ''
    try {
      await expect(jjDriver.listWorkspaces(dummyProject('C:\\short'))).rejects.toThrow(
        /jj is not installed/
      )
    } finally {
      process.env.PATH = prevPath
      _resetJjDriverCachesForTest()
    }
  })

  it('refuses oversized project roots before invoking jj', async () => {
    await expect(
      jjDriver.listWorkspaces(dummyProject('C:\\' + 'x'.repeat(120), 'p-long'))
    ).rejects.toThrow(/106/)
  })
})

describe.skipIf(!jjHost.available)(`jjDriver colocated integration (${jjHost.reason})`, () => {
  let dbDir: string
  let shortDir: string

  beforeAll(() => {
    dbDir = openTestDb('jd-')
    shortDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'jj-')))
    if (shortDir.length > 88) {
      throw new Error(`Temp directory too long for jj 0.46 106-char limit test fixture: ${shortDir}`)
    }
  })

  afterAll(() => {
    closeDb()
    try {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Best-effort cleanup on Windows handles.
    }
    try {
      rmSync(shortDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Best-effort cleanup on Windows handles.
    }
  })

  function initColocatedProject(name: string): ReturnType<typeof addProject> {
    const root = makeRepo({
      dir: shortDir,
      name,
      projectJson: { vcs: 'jj', check: [] }
    })
    runJjSync(root, 'git', 'init', '--colocate', root)
    runJjSync(root, 'config', 'set', '--repo', 'user.name', 'agentyard test')
    runJjSync(root, 'config', 'set', '--repo', 'user.email', 'test@example.invalid')
    return addProject({ root })
  }

  it('exercises workspaces, bookmarks, park/rescue, state, conflicts, push, and fetch', async () => {
    const bareRemote = join(shortDir, 'b.git')
    mkdirSync(bareRemote, { recursive: true })
    git(bareRemote, 'init', '--bare', '--initial-branch=main')

    const project = initColocatedProject('r1')
    git(project.root, 'remote', 'add', 'origin', bareRemote)
    git(project.root, 'push', '-u', 'origin', 'main')

    // Workspaces: add + list
    const wsPath = join(shortDir, 'w1')
    await jjDriver.addWorkspace(project, wsPath, 'main')
    const listed = await jjDriver.listWorkspaces(project)
    expect(listed.some((w) => samePath(w.path, project.root))).toBe(true)
    expect(listed.some((w) => samePath(w.path, wsPath) && w.branch === null)).toBe(true)

    // Bookmarks: createBranch / branchExists / currentBranch / deleteBranch
    expect(await jjDriver.branchExists(project, 'main')).toBe(true)
    expect(await jjDriver.branchExists(project, 'warmstart/t1')).toBe(false)

    await jjDriver.createBranch(project, 'warmstart/t1', 'main')
    expect(await jjDriver.branchExists(project, 'warmstart/t1')).toBe(true)

    // Create a change on top of warmstart/t1 in ws1 and attach the bookmark to it.
    runJjSync(wsPath, 'new', 'warmstart/t1')
    writeFileSync(join(wsPath, 'kept.txt'), 'edited in jj ws\n')
    writeFileSync(join(wsPath, 'new-file.txt'), 'brand new file\n')
    runJjSync(wsPath, 'bookmark', 'set', 'warmstart/t1', '-r', '@')

    // currentBranch reads the bookmark on @ (the working-copy change).
    expect(await jjDriver.currentBranch(wsPath)).toBe('warmstart/t1')
    const stateDirty = await jjDriver.workspaceState(wsPath, 'main')
    expect(samePath(stateDirty.path, wsPath)).toBe(true)
    expect(stateDirty.branch).toBe('warmstart/t1')
    expect(stateDirty.dirtyFiles).toEqual(['kept.txt'])
    expect(stateDirty.untrackedFiles).toEqual(['new-file.txt'])
    expect(stateDirty.landedRef).toBe('origin/main')

    // Conflicted check is false before any conflict.
    expect(await jjConflicted(wsPath, 'warmstart/t1')).toBe(false)

    // park refuses project root, preserves dirty files on ws1 with RESCUE_TRAILER, and moves @ to main.
    expect(await jjDriver.park(project, project.root)).toBeNull()
    const rescued = await jjDriver.park(project, wsPath)
    expect(rescued).not.toBeNull()
    expect(rescued?.kind).toBe('commit')
    expect(rescued?.files).toBe(2)
    expect(rescued?.branch).toBe('warmstart/t1')
    expect(await jjDriver.rescue(wsPath)).toBeNull()

    // Parking a clean workspace detaches to a new change on base and returns null.
    expect(await jjDriver.park(project, wsPath)).toBeNull()

    // Rescue is found on both @ (jj edit) and @- (jj new on top of rescued commit).
    runJjSync(wsPath, 'edit', rescued!.sha)
    const rescueOnAt = await jjDriver.rescue(wsPath)
    expect(rescueOnAt).toEqual({ sha: rescued!.sha, files: 2 })
    expect(git(wsPath, 'log', '-1', '--format=%B', rescued!.sha)).toContain(
      `${RESCUE_TRAILER}: 2`
    )

    runJjSync(wsPath, 'new', rescued!.sha)
    // On a child of the bookmarked change, the workspace is not on the branch (jj's `@` is what is
    // checked out), but the rescue on `@-` is still found.
    expect(await jjDriver.currentBranch(wsPath)).toBeNull()
    expect(await jjDriver.rescue(wsPath)).toEqual({ sha: rescued!.sha, files: 2 })

    // Plain bookmark push reaches origin without --allow-new, and git-delegated reads match.
    await jjDriver.push(project.root, 'origin', 'warmstart/t1')
    expect(git(bareRemote, 'rev-parse', 'refs/heads/warmstart/t1')).toBe(rescued!.sha)
    expect(await jjDriver.landedRef(project.root, 'main')).toBe('origin/main')
    expect(await jjDriver.commitsOnlyOn(project.root, 'warmstart/t1', 'main')).toBe(1)
    expect(await jjDriver.fileAt(project.root, 'warmstart/t1', 'kept.txt')).toBe('edited in jj ws')
    expect(await jjDriver.diff(project.root, ['main..warmstart/t1'])).toEqual([
      { path: 'kept.txt', added: 1, removed: 1, binary: false },
      { path: 'new-file.txt', added: 1, removed: 0, binary: false }
    ])
    expect(await jjDriver.diff(project.root, ['main..warmstart/t1'], 'kept.txt')).toContain(
      '+edited in jj ws'
    )

    // RefreshTarget / fetch updates remote tracking cleanly and throttles repeat refreshes.
    const peer = join(shortDir, 'p')
    git(shortDir, 'clone', bareRemote, peer)
    git(peer, 'config', 'user.name', 'agentyard test')
    git(peer, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(peer, 'upstream.txt'), 'from peer\n')
    git(peer, 'add', 'upstream.txt')
    git(peer, 'commit', '-m', 'peer update')
    git(peer, 'push', 'origin', 'main')
    const upstreamSha = git(peer, 'rev-parse', 'HEAD')

    expect(await jjDriver.refreshTarget(project, 'main')).toBe(true)
    expect(git(project.root, 'rev-parse', 'origin/main')).toBe(upstreamSha)
    expect(await jjDriver.refreshTarget(project, 'main')).toBe(false)

    // deleteBranch removes the temporary bookmark.
    await jjDriver.createBranch(project, 'warmstart/temp', 'main')
    expect(await jjDriver.branchExists(project, 'warmstart/temp')).toBe(true)
    await jjDriver.deleteBranch(project, 'warmstart/temp')
    expect(await jjDriver.branchExists(project, 'warmstart/temp')).toBe(false)

    // Stored conflict detection via jjConflicted.
    const baseSha = git(project.root, 'rev-parse', 'main')
    runJjSync(wsPath, 'new', baseSha)
    writeFileSync(join(wsPath, 'kept.txt'), 'side A\n')
    runJjSync(wsPath, 'describe', '-m', 'side A')
    const sideASha = runJjSync(wsPath, 'log', '-r', '@', '--no-graph', '-T', 'commit_id')
    runJjSync(wsPath, 'new', baseSha)
    writeFileSync(join(wsPath, 'kept.txt'), 'side B\n')
    runJjSync(wsPath, 'describe', '-m', 'side B')
    runJjSync(wsPath, 'rebase', '-s', '@', '-d', sideASha)
    expect(await jjConflicted(wsPath, '@')).toBe(true)

    // switchBranch / detachWorkspace, the primitives the pool calls (t1403): a new change on top of
    // the bookmark, read back through @-; creating cuts the bookmark at the base first.
    await jjDriver.switchBranch(wsPath, 'warmstart/t2', 'main')
    expect(await jjDriver.branchExists(project, 'warmstart/t2')).toBe(true)
    expect(await jjDriver.currentBranch(wsPath)).toBe('warmstart/t2')
    await jjDriver.switchBranch(wsPath, 'warmstart/t1')
    expect(await jjDriver.currentBranch(wsPath)).toBe('warmstart/t1')
    await jjDriver.detachWorkspace(wsPath, 'main')
    expect(await jjDriver.currentBranch(wsPath)).toBeNull()

    // pruneWorkspaces forgets a workspace whose directory was deleted out from under it.
    const gone = join(shortDir, 'w2')
    await jjDriver.addWorkspace(project, gone, 'main')
    rmSync(gone, { recursive: true, force: true })
    await jjDriver.pruneWorkspaces(project)
    expect((await jjDriver.listWorkspaces(project)).some((w) => samePath(w.path, gone))).toBe(false)

    // removeWorkspace refuses trunk and forgets + deletes secondary workspace directory.
    await expect(jjDriver.removeWorkspace(project, project.root)).rejects.toThrow(/root workspace/)
    await jjDriver.removeWorkspace(project, wsPath)
    expect(existsSync(wsPath)).toBe(false)
    const afterRemove = await jjDriver.listWorkspaces(project)
    expect(afterRemove.some((w) => samePath(w.path, wsPath))).toBe(false)
  }, 90_000)

  it('supports empty-branch catching up, trunk checks, dirty rescue, reversible rebase, and fast-forward', async () => {
    const bareRemote = join(shortDir, 'b2.git')
    mkdirSync(bareRemote, { recursive: true })
    git(bareRemote, 'init', '--bare', '--initial-branch=main')

    const project = initColocatedProject('r2')
    git(project.root, 'remote', 'add', 'origin', bareRemote)
    git(project.root, 'push', '-u', 'origin', 'main')

    // Put trunk @ on a clean empty undescribed child of main (how jj leaves a trunk working copy).
    runJjSync(project.root, 'new', 'main')
    expect(await jjDriver.currentBranch(project.root)).toBeNull()
    expect(await jjDriver.trunkBranch(project.root, 'main')).toBe('main')
    expect(await jjDriver.trunkNotReady(project.root, 'main')).toBeNull()

    // Dirty undescribed trunk @ blocks trunkNotReady; switching trunk @ to another bookmark blocks too.
    writeFileSync(join(project.root, 'scratch.txt'), 'uncommitted trunk edit\n')
    const dirtyReason = await jjDriver.trunkNotReady(project.root, 'main')
    expect(dirtyReason).toContain('uncommitted file(s)')
    expect(dirtyReason).toContain('scratch.txt')
    rmSync(join(project.root, 'scratch.txt'))
    // Re-snapshot clean trunk before next check.
    runJjSync(project.root, 'status')
    expect(await jjDriver.trunkNotReady(project.root, 'main')).toBeNull()

    // Secondary workspace with an untouched empty task bookmark reads 0 unlanded commits.
    const wsPath = join(shortDir, 'w2-land')
    await jjDriver.addWorkspace(project, wsPath, 'main')
    await jjDriver.switchBranch(wsPath, 'warmstart/t-empty', 'main')
    expect(await jjDriver.commitsOnlyOn(wsPath, 'warmstart/t-empty', 'main')).toBe(0)
    expect(await jjDriver.hasUncommittedChanges(wsPath)).toBe(false)

    // Advance main and verify catchUpEmptyBranch moves the empty task bookmark forward.
    writeFileSync(join(project.root, 'main-move.txt'), 'main v1\n')
    runJjSync(project.root, 'describe', '-m', 'advance main')
    runJjSync(project.root, 'bookmark', 'set', 'main', '-r', '@')
    runJjSync(project.root, 'new', 'main')
    const movedMainSha = git(project.root, 'rev-parse', 'main')

    await jjDriver.catchUpEmptyBranch(wsPath, 'warmstart/t-empty', 'main')
    expect(git(wsPath, 'rev-parse', 'warmstart/t-empty^')).toBe(movedMainSha)
    expect(existsSync(join(wsPath, 'main-move.txt'))).toBe(true)
    expect(await jjDriver.commitsOnlyOn(wsPath, 'warmstart/t-empty', 'main')).toBe(0)

    // Write work on wsPath without describing it: hasUncommittedChanges is true and rescueDirty
    // stamps a RESCUE_TRAILER in-place; once described by the agent, hasUncommittedChanges is false.
    writeFileSync(join(wsPath, 'work.txt'), 'uncommitted task work\n')
    expect(await jjDriver.hasUncommittedChanges(wsPath)).toBe(true)
    const rescuedInPlace = await jjDriver.rescueDirty(wsPath, 'warmstart/t-empty')
    expect(rescuedInPlace).not.toBeNull()
    expect(rescuedInPlace?.files).toBe(1)
    expect(await jjDriver.rescue(wsPath)).toEqual({ sha: rescuedInPlace!.sha, files: 1 })
    expect(await jjDriver.hasUncommittedChanges(wsPath)).toBe(false)

    // Amend into a real agent commit without rescue trailer on warmstart/t-work.
    await jjDriver.switchBranch(wsPath, 'warmstart/t-work', 'main')
    writeFileSync(join(wsPath, 'feature.txt'), 'clean task work\n')
    runJjSync(wsPath, 'describe', '-m', 'feat: add feature.txt')
    expect(await jjDriver.rescue(wsPath)).toBeNull()
    expect(await jjDriver.hasUncommittedChanges(wsPath)).toBe(false)
    expect(await jjDriver.commitsOnlyOn(wsPath, 'warmstart/t-work', 'main')).toBe(1)

    // Advance main non-conflictingly, rebase warmstart/t-work, then fastForwardTrunk.
    writeFileSync(join(project.root, 'other.txt'), 'other main file\n')
    runJjSync(project.root, 'describe', '-m', 'main unrelated')
    runJjSync(project.root, 'bookmark', 'set', 'main', '-r', '@')
    runJjSync(project.root, 'new', 'main')

    const cleanRebase = await jjDriver.rebaseBranch(wsPath, 'warmstart/t-work', 'main')
    expect(cleanRebase).toEqual({ ok: true })
    const featureSha = git(wsPath, 'rev-parse', 'warmstart/t-work')
    await jjDriver.fastForwardTrunk(project, 'main', 'warmstart/t-work', featureSha)
    expect(git(project.root, 'rev-parse', 'main')).toBe(featureSha)
    expect(existsSync(join(project.root, 'feature.txt'))).toBe(true)
    expect(await jjDriver.trunkNotReady(project.root, 'main')).toBeNull()

    // pushToTarget pushes a bookmark to origin/main and retireBranch removes it cleanly.
    await jjDriver.switchBranch(wsPath, 'warmstart/t-push', 'main')
    writeFileSync(join(wsPath, 'pushed.txt'), 'to remote main\n')
    runJjSync(wsPath, 'describe', '-m', 'feat: push to main')
    expect((await jjDriver.rebaseBranch(wsPath, 'warmstart/t-push', 'main')).ok).toBe(true)
    const pushedSha = git(wsPath, 'rev-parse', 'warmstart/t-push')
    await jjDriver.pushToTarget(wsPath, 'origin', 'warmstart/t-push', 'main')
    expect(git(bareRemote, 'rev-parse', 'refs/heads/main')).toBe(pushedSha)
    expect(await jjDriver.retireBranch(wsPath, project, 'warmstart/t-push')).toBe(true)
    expect(await jjDriver.branchExists(project, 'warmstart/t-push')).toBe(false)

    // Planner-branch fastForwardBranch + compare-and-swap check.
    await jjDriver.createBranch(project, 'warmstart/plan', 'main')
    const planOldSha = git(project.root, 'rev-parse', 'warmstart/plan')
    await jjDriver.switchBranch(wsPath, 'warmstart/child', 'warmstart/plan')
    writeFileSync(join(wsPath, 'child.txt'), 'child piece\n')
    runJjSync(wsPath, 'describe', '-m', 'feat: child')
    const childSha = git(wsPath, 'rev-parse', 'warmstart/child')
    await expect(
      jjDriver.fastForwardBranch(project, wsPath, 'warmstart/plan', childSha, '0'.repeat(40))
    ).rejects.toThrow(/moved/)
    await jjDriver.fastForwardBranch(project, wsPath, 'warmstart/plan', childSha, planOldSha)
    expect(git(project.root, 'rev-parse', 'warmstart/plan')).toBe(childSha)

    // Rebase conflict reverts via jj op revert and conflictedPaths reports stored conflict paths.
    await jjDriver.switchBranch(wsPath, 'warmstart/conflict', 'main')
    writeFileSync(join(wsPath, 'feature.txt'), 'branch side\n')
    runJjSync(wsPath, 'describe', '-m', 'branch edit feature')
    writeFileSync(join(project.root, 'feature.txt'), 'trunk side\n')
    runJjSync(project.root, 'describe', '-m', 'trunk edit feature')
    runJjSync(project.root, 'bookmark', 'set', 'main', '-r', '@')
    runJjSync(project.root, 'new', 'main')

    const conflictedRebase = await jjDriver.rebaseBranch(wsPath, 'warmstart/conflict', 'main')
    expect(conflictedRebase.ok).toBe(false)
    expect(await jjDriver.hasConflicts(wsPath, 'warmstart/conflict')).toBe(false)

    // Re-describe before forcing a stored conflict so jj produces a distinct commit SHA even within the same second.
    runJjSync(wsPath, 'describe', '-r', 'warmstart/conflict', '-m', 'branch edit feature (stored conflict)')
    runJjSync(wsPath, 'rebase', '-b', 'warmstart/conflict', '-d', 'main')
    expect(await jjDriver.hasConflicts(wsPath, 'warmstart/conflict')).toBe(true)
    expect(await jjDriver.conflictedPaths(wsPath, 'warmstart/conflict')).toEqual(['feature.txt'])
  }, 90_000)

  it('switches cleanly when an existing bookmark points to an immutable or shared commit (t1444)', async () => {
    const bareRemote = join(shortDir, 'b-imm.git')
    mkdirSync(bareRemote, { recursive: true })
    git(bareRemote, 'init', '--bare', '--initial-branch=main')

    const project = initColocatedProject('r-imm')
    git(project.root, 'remote', 'add', 'origin', bareRemote)
    git(project.root, 'push', '-u', 'origin', 'main')
    runJjSync(project.root, 'new', 'main')

    const wsPath = join(shortDir, 'w-imm')
    await jjDriver.addWorkspace(project, wsPath, 'main')

    // 1. Bookmark pointing directly at immutable main@origin (exact t1444 failure mode):
    //    switchBranch creates a fresh mutable `@` on top and moves only the task bookmark onto `@`.
    const mainSha = git(project.root, 'rev-parse', 'main')
    await jjDriver.createBranch(project, 'warmstart/t1444-repro', 'main')
    await jjDriver.switchBranch(wsPath, 'warmstart/t1444-repro')
    expect(await jjDriver.currentBranch(wsPath)).toBe('warmstart/t1444-repro')
    expect(git(project.root, 'rev-parse', 'main')).toBe(mainSha)
    expect(git(wsPath, 'rev-parse', 'warmstart/t1444-repro^')).toBe(mainSha)
    expect(await jjDriver.commitsOnlyOn(wsPath, 'warmstart/t1444-repro', 'main')).toBe(0)

    // Subsequent catchUpEmptyBranch advances the fresh `@` cleanly when main moves forward.
    writeFileSync(join(project.root, 'upstream.txt'), 'moved\n')
    runJjSync(project.root, 'describe', '-m', 'advance main')
    runJjSync(project.root, 'bookmark', 'set', 'main', '-r', '@')
    runJjSync(project.root, 'new', 'main')
    const movedMainSha = git(project.root, 'rev-parse', 'main')
    await jjDriver.catchUpEmptyBranch(wsPath, 'warmstart/t1444-repro', 'main')
    expect(git(wsPath, 'rev-parse', 'warmstart/t1444-repro^')).toBe(movedMainSha)
    expect(existsSync(join(wsPath, 'upstream.txt'))).toBe(true)

    // 2. Bookmark pushed directly via `git push -u` becomes an untracked remote bookmark (immutable):
    //    switchBranch on resume creates a mutable follow-up `@` rather than failing `jj edit`.
    await jjDriver.switchBranch(wsPath, 'warmstart/t-remote-imm', 'main')
    writeFileSync(join(wsPath, 'pushed.txt'), 'v1\n')
    runJjSync(wsPath, 'describe', '-m', 'feat: pushed commit')
    runJjSync(wsPath, 'status')
    git(wsPath, 'push', '-u', 'origin', 'warmstart/t-remote-imm')
    const pushedSha = git(wsPath, 'rev-parse', 'warmstart/t-remote-imm')

    await jjDriver.park(project, wsPath)
    await jjDriver.switchBranch(wsPath, 'warmstart/t-remote-imm')
    expect(await jjDriver.currentBranch(wsPath)).toBe('warmstart/t-remote-imm')
    expect(git(wsPath, 'rev-parse', 'warmstart/t-remote-imm^')).toBe(pushedSha)
    writeFileSync(join(wsPath, 'followup.txt'), 'v2\n')
    runJjSync(wsPath, 'describe', '-m', 'feat: follow-up after push')
    expect(await jjDriver.commitsOnlyOn(wsPath, 'warmstart/t-remote-imm', 'main')).toBe(2)

    // 3. Repo with NO remote: `main` is mutable, so a bookmark created on `main` shares its commit
    //    with `main`. switchBranch still cuts a fresh `@` so edits never mutate `main` and
    //    currentBranch does not return `'main'`.
    const noRemoteProject = initColocatedProject('r-noremote')
    runJjSync(noRemoteProject.root, 'new', 'main')
    const nrMainSha = git(noRemoteProject.root, 'rev-parse', 'main')
    const nrWs = join(shortDir, 'w-nr')
    await jjDriver.addWorkspace(noRemoteProject, nrWs, 'main')
    await jjDriver.createBranch(noRemoteProject, 'warmstart/t-shared', 'main')

    await jjDriver.switchBranch(nrWs, 'warmstart/t-shared')
    expect(await jjDriver.currentBranch(nrWs)).toBe('warmstart/t-shared')
    expect(git(noRemoteProject.root, 'rev-parse', 'main')).toBe(nrMainSha)
    expect(git(nrWs, 'rev-parse', 'warmstart/t-shared^')).toBe(nrMainSha)
  }, 90_000)
})
