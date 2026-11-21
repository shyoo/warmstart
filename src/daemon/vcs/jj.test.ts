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
  })
})
