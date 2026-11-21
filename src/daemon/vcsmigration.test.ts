import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DaemonEvent } from '@shared/protocol.js'
import { loadAdapters } from './adapters/index.js'
import { closeDb, db, MIGRATION_COUNT, openDb, versionBefore } from './db.js'
import { setEventSink } from './events.js'
import { addProject, reloadProject } from './projects.js'
import { claim, getResource, release, trunkResourceId, upsertResource, workspacePoolId } from './resources.js'
import { git, makeProject, makeTask, openTestDb, seedSession, seedWorker } from './testkit.js'
import { gitDriver } from './vcs/git.js'
import {
  _resetJjDriverCachesForTest,
  compareSemver,
  JJ_MAX_ROOT_LENGTH,
  JJ_MIN_VERSION,
  jjDriver,
  parseJjVersion
} from './vcs/jj.js'
import { listVcsMigrations, migrateProjectVcs } from './vcsmigration.js'
import { launchArgs, spawnEnv, which } from './which.js'
import { ensurePool } from './worktrees.js'

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

function snapshotTreeBytes(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const entries = readdirSync(dir).sort()
  for (const name of entries) {
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const st = statSync(full)
    if (st.isDirectory()) {
      for (const [childRel, bytes] of snapshotTreeBytes(full, rel)) {
        out.set(childRel, bytes)
      }
    } else {
      out.set(rel, readFileSync(full))
    }
  }
  return out
}

function cleanupDir(dir: string | undefined): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Best-effort cleanup on Windows handles.
  }
}

const jjHost = probeJjHost()

describe('VCS migration schema & preconditions', () => {
  let dbDir: string
  let dbPath: string
  let workDir: string

  beforeAll(() => {
    dbDir = openTestDb('vcsmig-pre-')
    dbPath = join(dbDir, 'test.db')
    loadAdapters()
    workDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vm-')))
  })

  afterAll(() => {
    setEventSink(() => {})
    closeDb()
    cleanupDir(dbDir)
    cleanupDir(workDir)
  })

  it('applies Migration 96 idempotently on replay', () => {
    const version = (db().prepare('pragma user_version').get() as { user_version: number }).user_version
    expect(version).toBe(MIGRATION_COUNT)

    const before96 = versionBefore('create table if not exists vcs_migrations')
    db().exec(`pragma user_version = ${before96}`)
    closeDb()
    openDb(dbPath)
    closeDb()
    openDb(dbPath)

    const replayedVersion = (db().prepare('pragma user_version').get() as { user_version: number }).user_version
    expect(replayedVersion).toBe(MIGRATION_COUNT)

    const table = db()
      .prepare("select name from sqlite_master where type = 'table' and name = 'vcs_migrations'")
      .get() as { name: string } | undefined
    const index = db()
      .prepare("select name from sqlite_master where type = 'index' and name = 'vcs_migrations_project'")
      .get() as { name: string } | undefined
    expect(table?.name).toBe('vcs_migrations')
    expect(index?.name).toBe('vcs_migrations_project')
  })

  it('refuses non-VCS projects, same-VCS target, and oversized roots', async () => {
    const nonGitRoot = join(workDir, 'non-vcs')
    mkdirSync(nonGitRoot, { recursive: true })
    writeFileSync(join(nonGitRoot, 'note.txt'), 'plain folder\n')
    const nonGit = addProject({ root: nonGitRoot })

    await expect(migrateProjectVcs(nonGit.id, 'jj')).rejects.toThrow(/cannot migrate VCS/)

    const pGit = makeProject({ dir: workDir, name: 'same-vcs', config: { vcs: 'git' } })
    await expect(migrateProjectVcs(pGit.id, 'git')).rejects.toThrow(/already configured/)

    const longParent = join(workDir, 'x'.repeat(Math.max(10, JJ_MAX_ROOT_LENGTH - workDir.length + 4)))
    mkdirSync(longParent, { recursive: true })
    const pLong = makeProject({ dir: longParent, name: 'longroot', config: { vcs: 'git' } })
    await expect(migrateProjectVcs(pLong.id, 'jj')).rejects.toThrow(/106/)
  })

  it('refuses migration when active tasks, resource claims, live sessions, or dirty files exist', async () => {
    const project = makeProject({
      dir: workDir,
      name: 'precheck',
      config: { vcs: 'git', workspaces: { poolSize: 1 } }
    })
    const pool = await ensurePool(project)
    expect(pool.length).toBe(1)
    const ws1 = pool[0]!

    // Active task
    const task = makeTask({ projectId: project.id, title: 'Active task' })
    db().prepare("update tasks set status = 'running' where id = ?").run(task.id)
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/active or held/i)
    db().prepare("update tasks set status = 'completed' where id = ?").run(task.id)

    // Open pool claim (holder listed in refusal)
    const poolClaim = claim(workspacePoolId(project.id), 'holder-1')
    expect(poolClaim).not.toBeNull()
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/open workspace claims.*holder-1/i)
    release(poolClaim!.id)

    // Open trunk claim (task holder resolved to t<seq>)
    upsertResource({
      id: trunkResourceId(project.id),
      projectId: project.id,
      kind: 'exclusive',
      label: `${project.name} trunk`
    })
    const trunkClaim = claim(trunkResourceId(project.id), task.id)
    expect(trunkClaim).not.toBeNull()
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(
      new RegExp(`open workspace claims.*t${task.seq}`, 'i')
    )
    release(trunkClaim!.id)

    // Live session attached to workspace
    const worker = seedWorker({ adapterId: 'claude-code', label: 'worker-mig' })
    const session = seedSession({ workerId: worker.id, adapterId: 'claude-code', cwd: ws1, state: 'live' })
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/live session/i)
    db().prepare("update sessions set state = 'closed' where id = ?").run(session.id)

    // Dirty trunk
    writeFileSync(join(project.root, 'dirty.txt'), 'uncommitted\n')
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/uncommitted or untracked/i)
    rmSync(join(project.root, 'dirty.txt'))

    // Dirty pool workspace
    writeFileSync(join(ws1, 'ws-dirty.txt'), 'uncommitted\n')
    await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/uncommitted or untracked/i)
    rmSync(join(ws1, 'ws-dirty.txt'))

    // Missing jj on PATH (keep git dir on PATH so git cleanliness checks run first and reach the jj gate)
    const prevPath = process.env.PATH
    const gitBin = which('git')
    _resetJjDriverCachesForTest()
    process.env.PATH = gitBin ? dirname(gitBin) : ''
    try {
      await expect(migrateProjectVcs(project.id, 'jj')).rejects.toThrow(/jj is not installed/i)
    } finally {
      process.env.PATH = prevPath
      _resetJjDriverCachesForTest()
    }
  })
})

describe.skipIf(!jjHost.available)(`VCS colocated migration integration (${jjHost.reason})`, () => {
  let dbDir: string
  let shortDir: string

  beforeAll(() => {
    dbDir = openTestDb('vcsmig-int-')
    shortDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vm-')))
    if (shortDir.length > 88) {
      throw new Error(`Temp directory too long for jj 0.46 106-char limit fixture: ${shortDir}`)
    }
  })

  afterAll(() => {
    setEventSink(() => {})
    closeDb()
    cleanupDir(dbDir)
    cleanupDir(shortDir)
  })

  it('aborts and rolls back git -> jj on bookmark mismatch leaving .git byte-identical', async () => {
    const project = makeProject({
      dir: shortDir,
      name: 'rb',
      config: { vcs: 'git', workspaces: { poolSize: 1 } }
    })
    git(project.root, 'checkout', '-b', 'feature/rb')
    writeFileSync(join(project.root, 'rb.txt'), 'branch commit\n')
    git(project.root, 'add', 'rb.txt')
    git(project.root, 'commit', '-m', 'branch commit')
    git(project.root, 'checkout', 'main')

    const pool = await ensurePool(project)
    expect(pool.length).toBe(1)

    const gitBefore = snapshotTreeBytes(join(project.root, '.git'))

    let verifyHookRan = false
    await expect(
      migrateProjectVcs(project.id, 'jj', {
        _beforeVerifyForTest: (root) => {
          verifyHookRan = true
          runJjSync(root, '--ignore-working-copy', '-R', root, 'bookmark', 'delete', 'feature/rb')
        }
      })
    ).rejects.toThrow(/rolled back cleanly/i)
    expect(verifyHookRan).toBe(true)

    expect(existsSync(join(project.root, '.jj'))).toBe(false)
    expect(existsSync(join(pool[0]!, '.git'))).toBe(true)

    const gitAfter = snapshotTreeBytes(join(project.root, '.git'))
    expect([...gitAfter.keys()]).toEqual([...gitBefore.keys()])
    for (const [rel, bytesBefore] of gitBefore.entries()) {
      expect(gitAfter.get(rel)?.equals(bytesBefore)).toBe(true)
    }

    const reloaded = reloadProject(project.id)
    expect(reloaded.vcs).toBe('git')

    const history = listVcsMigrations(project.id)
    expect(history[0]?.status).toBe('rolled_back')
    expect(history[0]?.fromVcs).toBe('git')
    expect(history[0]?.toVcs).toBe('jj')
    expect(history[0]?.detail?.jjVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/))
    expect((history[0]?.detail?.branchSnapshot as Record<string, string>)['feature/rb']).toBe(
      git(project.root, 'rev-parse', 'refs/heads/feature/rb')
    )
  }, 60_000)

  it('migrates git -> jj, preserves jj across reloadProject, and migrates back jj -> git (keep .jj & remove .jj)', async () => {
    const events: DaemonEvent[] = []
    setEventSink((ev) => events.push(ev))

    // Configure local bare origin with main so trunk() configures cleanly against main@origin.
    const originDir = join(shortDir, 'orig.git')
    mkdirSync(originDir, { recursive: true })
    git(originDir, 'init', '--bare', '--initial-branch=main')

    const project = makeProject({
      dir: shortDir,
      name: 'rt',
      config: { vcs: 'git', workspaces: { poolSize: 2 } }
    })
    git(project.root, 'remote', 'add', 'origin', originDir)
    git(project.root, 'push', '-u', 'origin', 'main')
    git(project.root, 'checkout', '-b', 'feature/one')
    writeFileSync(join(project.root, 'feat.txt'), 'feat\n')
    git(project.root, 'add', 'feat.txt')
    git(project.root, 'commit', '-m', 'feature commit')
    git(project.root, 'checkout', 'main')

    const expectedMainSha = git(project.root, 'rev-parse', 'refs/heads/main')
    const expectedFeatSha = git(project.root, 'rev-parse', 'refs/heads/feature/one')

    const gitPool = await ensurePool(project)
    expect(gitPool.length).toBe(2)

    // 1. Forward migration: git -> jj
    events.length = 0
    const forward = await migrateProjectVcs(project.id, 'jj')
    expect(forward.project.vcs).toBe('jj')
    expect(forward.rebuiltWorkspaces).toBe(2)
    expect(forward.keptJjDir).toBe(true)
    expect(forward.migration.status).toBe('completed')
    expect(forward.migration.detail.jjVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/))
    expect((forward.migration.detail.branchSnapshot as Record<string, string>)['main']).toBe(expectedMainSha)
    expect((forward.migration.detail.branchSnapshot as Record<string, string>)['feature/one']).toBe(expectedFeatSha)
    expect(existsSync(join(project.root, '.jj'))).toBe(true)
    expect(existsSync(join(project.root, '.git'))).toBe(true)
    expect(events.some((e) => e.type === 'project.changed' && e.project.vcs === 'jj')).toBe(true)

    // Verify trunk() alias and jj bookmarks
    const trunkAlias = runJjSync(
      project.root,
      '--ignore-working-copy',
      '-R',
      project.root,
      'config',
      'get',
      'revset-aliases."trunk()"'
    )
    expect(trunkAlias).toBe('main@origin')

    const jjMainSha = runJjSync(
      project.root,
      '--ignore-working-copy',
      '-R',
      project.root,
      'log',
      '-r',
      'bookmarks(exact:"main")',
      '--no-graph',
      '-T',
      'commit_id'
    )
    const jjFeatSha = runJjSync(
      project.root,
      '--ignore-working-copy',
      '-R',
      project.root,
      'log',
      '-r',
      'bookmarks(exact:"feature/one")',
      '--no-graph',
      '-T',
      'commit_id'
    )
    expect(jjMainSha).toBe(expectedMainSha)
    expect(jjFeatSha).toBe(expectedFeatSha)

    // Verify jj workspaces and resource pool updated
    const jjWorkspaces = await jjDriver.listWorkspaces(forward.project)
    expect(jjWorkspaces.some((w) => w.path.endsWith('ws1'))).toBe(true)
    expect(jjWorkspaces.some((w) => w.path.endsWith('ws2'))).toBe(true)
    const jjResource = getResource(workspacePoolId(project.id))
    expect(jjResource?.meta?.vcs).toBe('jj')
    expect(jjResource?.members.length).toBe(2)

    // reloadProject must keep 'jj' when project.json still has vcs: 'git'
    const afterReload = reloadProject(project.id)
    expect(afterReload.vcs).toBe('jj')

    // Create a new jj commit & bookmark before reverse migration
    runJjSync(project.root, '-R', project.root, 'new', 'main', '-m', 'jj-only commit')
    writeFileSync(join(project.root, 'jj-added.txt'), 'from jj\n')
    runJjSync(project.root, '-R', project.root, 'bookmark', 'create', 'feature/jj-created', '-r', '@')
    const jjCreatedSha = runJjSync(
      project.root,
      '--ignore-working-copy',
      '-R',
      project.root,
      'log',
      '-r',
      '@',
      '--no-graph',
      '-T',
      'commit_id'
    )
    // Detach trunk working copy onto main so trunk is clean before reverse migration
    runJjSync(project.root, '-R', project.root, 'new', 'main')

    // 2. Reverse migration: jj -> git (default keeps .jj/)
    events.length = 0
    const reverseKeep = await migrateProjectVcs(project.id, 'git')
    expect(reverseKeep.project.vcs).toBe('git')
    expect(reverseKeep.keptJjDir).toBe(true)
    expect(reverseKeep.rebuiltWorkspaces).toBe(2)
    expect(reverseKeep.migration.detail.jjVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/))
    expect((reverseKeep.migration.detail.bookmarkSnapshot as Record<string, string>)['feature/jj-created']).toBe(
      jjCreatedSha
    )
    expect(existsSync(join(project.root, '.jj'))).toBe(true)
    expect(events.some((e) => e.type === 'project.changed' && e.project.vcs === 'git')).toBe(true)

    expect(git(project.root, 'rev-parse', 'refs/heads/feature/jj-created')).toBe(jjCreatedSha)
    expect(await gitDriver.currentBranch(project.root)).toBe('main')
    const gitResource = getResource(workspacePoolId(project.id))
    expect(gitResource?.meta?.vcs).toBe('git')
    expect(gitResource?.members.length).toBe(2)
    expect(existsSync(join(gitResource!.members[0]!, '.git'))).toBe(true)
    expect(existsSync(join(gitResource!.members[0]!, '.jj'))).toBe(false)

    // 3. Round-trip back to jj, then reverse again with removeJjDir: true
    const backToJj = await migrateProjectVcs(project.id, 'jj')
    expect(backToJj.project.vcs).toBe('jj')
    const reversePurge = await migrateProjectVcs(project.id, 'git', { removeJjDir: true })
    expect(reversePurge.project.vcs).toBe('git')
    expect(reversePurge.keptJjDir).toBe(false)
    expect(existsSync(join(project.root, '.jj'))).toBe(false)
    expect(await gitDriver.currentBranch(project.root)).toBe('main')

    const history = listVcsMigrations(project.id)
    expect(history.length).toBe(4)

    // reloadProject respects explicit vcs: 'none' switch
    writeFileSync(
      join(project.root, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, name: 'rt', vcs: 'none' }, null, 2)
    )
    expect(reloadProject(project.id).vcs).toBe('none')
  }, 90_000)

  it('permits dirty trunk only when allowDirtyTrunk=true and preserves uncommitted edits untouched', async () => {
    const dirtyProj = makeProject({
      dir: shortDir,
      name: 'dirty-ok',
      config: { vcs: 'git', workspaces: { poolSize: 1 } }
    })
    await ensurePool(dirtyProj)
    const dirtyFile = join(dirtyProj.root, 'untracked-note.txt')
    writeFileSync(dirtyFile, 'keep me untouched\n')

    await expect(migrateProjectVcs(dirtyProj.id, 'jj')).rejects.toThrow(/uncommitted or untracked/i)

    const migrated = await migrateProjectVcs(dirtyProj.id, 'jj', { allowDirtyTrunk: true })
    expect(migrated.project.vcs).toBe('jj')
    expect(readFileSync(dirtyFile, 'utf8')).toBe('keep me untouched\n')
    expect(existsSync(join(dirtyProj.root, '.jj'))).toBe(true)

    // Reverse migration when trunk HEAD is detached and dirty leaves HEAD detached with a warning rather than touching dirty edits.
    git(dirtyProj.root, 'checkout', '--detach', 'HEAD')
    const reversed = await migrateProjectVcs(dirtyProj.id, 'git', { allowDirtyTrunk: true })
    expect(reversed.project.vcs).toBe('git')
    expect(await gitDriver.currentBranch(dirtyProj.root)).toBeNull()
    expect(readFileSync(dirtyFile, 'utf8')).toBe('keep me untouched\n')
    expect(reversed.warnings.some((w) => /uncommitted changes/i.test(w))).toBe(true)
  }, 60_000)
})
