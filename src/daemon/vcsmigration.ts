import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors.js'
import {
  sessionEnded,
  type MigratableVcs,
  type VcsMigrationRecord,
  type VcsMigrationResult
} from '@shared/protocol.js'
import { PROJECT_IDLE_STATUSES, type Project } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { samePath, withinPath } from './fspath.js'
import { git, tryGit } from './git.js'
import { log } from './log.js'
import { policyFor, requireProject } from './projects.js'
import { getResource, openClaims, trunkResourceId, upsertResource, workspacePoolId } from './resources.js'
import { listSessions } from './sessions.js'
import { run } from './spawn.js'
import { getTask } from './tasks.js'
import { gitDriver } from './vcs/git.js'
import {
  assertJjRootLength,
  assertJjVersionSupported,
  jjConflicted,
  jjDriver
} from './vcs/jj.js'
import { launchArgs, spawnEnv, which } from './which.js'
import { trunkBaseRef } from './worktrees.js'

export type { MigratableVcs, VcsMigrationRecord, VcsMigrationResult }

export interface MigrateVcsOptions {
  /** Allow migrating when the trunk checkout itself has uncommitted changes (never stashes or resets them). */
  allowDirtyTrunk?: boolean
  /** Delete `.jj/` on reverse `jj -> git` migration once git refs and worktrees verify clean. Defaults to `false`. */
  removeJjDir?: boolean
  /** @internal Test hook invoked right before verifying converted refs/bookmarks. */
  _beforeVerifyForTest?: (root: string) => Promise<void> | void
}

interface VcsMigrationRow {
  id: string
  project_id: string
  from_vcs: MigratableVcs
  to_vcs: MigratableVcs
  status: 'completed' | 'rolled_back'
  started_at: number
  finished_at: number
  detail_json: string
}

interface JjBookmarkRow {
  name: string
  target: string[]
}

const JJ_MAX_BUFFER = 64 * 1024 * 1024
const LOCAL_BOOKMARK_TEMPLATE = 'if(!remote, json(self) ++ "\\n", "")'

function toRecord(r: VcsMigrationRow): VcsMigrationRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    fromVcs: r.from_vcs,
    toVcs: r.to_vcs,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>
  }
}

/** Return persisted VCS migration history for `projectId`, newest first. */
export function listVcsMigrations(projectId: string): VcsMigrationRecord[] {
  const list = db()
    .prepare('select * from vcs_migrations where project_id = ? order by finished_at desc, id desc')
    .all(projectId)
  return rows<VcsMigrationRow>(list).map(toRecord)
}

async function ensureJjBinarySupported(): Promise<{ binary: string; version: string }> {
  const binary = which('jj')
  if (!binary) {
    throw new Error('jj is not installed or not on PATH')
  }
  const launched = launchArgs(binary, ['--version'])
  let stdout: string
  try {
    const out = await run(launched.command, launched.args, {
      env: spawnEnv(),
      maxBuffer: JJ_MAX_BUFFER,
      windowsHide: true
    })
    stdout = out.stdout
  } catch (err) {
    throw new Error(`Could not determine jj version: ${errorMessage(err)}`, { cause: err })
  }
  const version = assertJjVersionSupported(stdout)
  return { binary, version }
}

async function execJjRaw(
  binary: string,
  cwd: string,
  args: string[],
  opts: { ignoreWorkingCopy?: boolean } = {}
): Promise<string> {
  const fullArgs = [
    ...(opts.ignoreWorkingCopy ? ['--ignore-working-copy'] : []),
    '--no-pager',
    ...args
  ]
  const launched = launchArgs(binary, fullArgs)
  const { stdout } = await run(launched.command, launched.args, {
    cwd,
    env: spawnEnv(),
    maxBuffer: JJ_MAX_BUFFER,
    windowsHide: true
  })
  return stdout.replace(/\s+$/, '')
}

async function snapshotGitBranches(root: string): Promise<Map<string, string>> {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'])
  const branches = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    branches.set(line.slice(0, tab), line.slice(tab + 1).trim())
  }
  return branches
}

async function snapshotJjLocalBookmarks(binary: string, root: string): Promise<Map<string, string[]>> {
  const out = await execJjRaw(
    binary,
    root,
    ['-R', root, 'bookmark', 'list', '-T', LOCAL_BOOKMARK_TEMPLATE],
    { ignoreWorkingCopy: true }
  )
  const bookmarks = new Map<string, string[]>()
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as JjBookmarkRow
    bookmarks.set(row.name, row.target ?? [])
  }
  return bookmarks
}

function addUniquePath(list: string[], candidate: string): void {
  if (!list.some((p) => samePath(p, candidate))) list.push(candidate)
}

async function discoverExistingWorkspaces(project: Project, vcs: MigratableVcs): Promise<{
  allDirs: string[]
  poolDirs: string[]
}> {
  const policy = policyFor(project)
  const poolId = workspacePoolId(project.id)
  const driver = vcs === 'jj' ? jjDriver : gitDriver
  const listed = await driver.listWorkspaces(project)

  const allDirs: string[] = [project.root]
  const poolDirs: string[] = []

  const trackPoolPath = (candidate: string): void => {
    if (samePath(candidate, project.root)) return
    addUniquePath(allDirs, candidate)
    addUniquePath(poolDirs, candidate)
  }

  for (const entry of listed) trackPoolPath(entry.path)
  for (const member of getResource(poolId)?.members ?? []) trackPoolPath(member)

  let index = 1
  while (existsSync(join(policy.workspaceRoot, `ws${index}`))) {
    trackPoolPath(join(policy.workspaceRoot, `ws${index}`))
    index++
  }

  return { allDirs, poolDirs }
}

function insertMigrationRow(record: VcsMigrationRecord): void {
  db()
    .prepare(
      `insert into vcs_migrations
         (id, project_id, from_vcs, to_vcs, status, started_at, finished_at, detail_json)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.projectId,
      record.fromVcs,
      record.toVcs,
      record.status,
      record.startedAt,
      record.finishedAt,
      JSON.stringify(record.detail)
    )
}

async function assertPreconditions(
  project: Project,
  to: MigratableVcs,
  opts: MigrateVcsOptions
): Promise<{
  from: MigratableVcs
  jjBinary: string
  jjVersion: string
  poolDirs: string[]
}> {
  if (to !== 'git' && to !== 'jj') {
    throw new Error(`Unsupported target VCS '${String(to)}'; expected 'git' or 'jj'`)
  }
  if (!project.rootExists || !existsSync(project.root)) {
    throw new Error(`Project directory does not exist: ${project.root}`)
  }
  if (project.vcs !== 'git' && project.vcs !== 'jj') {
    throw new Error(`${project.name} uses '${project.vcs}' and cannot migrate VCS`)
  }
  const from: MigratableVcs = project.vcs
  if (from === to) {
    throw new Error(`${project.name} is already configured for '${to}'`)
  }
  if (!existsSync(join(project.root, '.git'))) {
    throw new Error(`${project.name} has no .git directory at ${project.root}`)
  }
  if (from === 'jj' && !existsSync(join(project.root, '.jj'))) {
    throw new Error(`${project.name} has no .jj directory at ${project.root}`)
  }

  assertJjRootLength(project.root)

  const idlePlaceholders = PROJECT_IDLE_STATUSES.map(() => '?').join(', ')
  const activeTaskCount =
    row<{ n: number }>(
      db()
        .prepare(
          `select count(*) as n from tasks
           where project_id = ? and deleted_at is null and status not in (${idlePlaceholders})`
        )
        .get(project.id, ...PROJECT_IDLE_STATUSES)
    )?.n ?? 0
  if (activeTaskCount > 0) {
    throw new Error(
      `${project.name} has ${activeTaskCount} active or held ${activeTaskCount === 1 ? 'task' : 'tasks'}; finish or cancel them before migrating VCS`
    )
  }

  const poolId = workspacePoolId(project.id)
  const poolClaims = openClaims(poolId)
  const trunkClaims = openClaims(trunkResourceId(project.id))
  if (poolClaims.length > 0 || trunkClaims.length > 0) {
    const holders = [...poolClaims, ...trunkClaims].map((c) => {
      const task = getTask(c.holder)
      const label = task ? `t${task.seq}` : c.holder
      return c.member ? `${label} (${c.member})` : label
    })
    throw new Error(
      `${project.name} still has open workspace claims (${holders.join(', ')}); release them before migrating VCS`
    )
  }

  const policy = policyFor(project)
  const recordedMembers = getResource(poolId)?.members ?? []
  const attachedDirs = [project.root, policy.workspaceRoot, ...recordedMembers]
  const liveSession = listSessions().find(
    (s) => !sessionEnded(s.state) && attachedDirs.some((dir) => withinPath(dir, s.cwd))
  )
  if (liveSession) {
    throw new Error(
      `${project.name} has a live session running in ${liveSession.cwd}; close it before migrating VCS`
    )
  }

  const jjInfo = from === 'jj' ? await ensureJjBinarySupported() : null
  const driver = from === 'jj' ? jjDriver : gitDriver
  const { allDirs, poolDirs } = await discoverExistingWorkspaces(project, from)
  for (const dir of allDirs) {
    if (!existsSync(dir)) continue
    const isTrunk = samePath(dir, project.root)
    if (from === 'jj' && (await jjConflicted(dir, '@'))) {
      const label = isTrunk ? 'trunk' : dir
      throw new Error(
        `${project.name} ${label} has working-copy conflicts in '@'; resolve them before migrating VCS`
      )
    }
    if (isTrunk && opts.allowDirtyTrunk) continue
    const wsState = await driver.workspaceState(dir, policy.landingTarget)
    const dirtyCount = wsState.dirtyFiles.length + wsState.untrackedFiles.length
    if (dirtyCount > 0) {
      const label = isTrunk ? 'trunk' : dir
      throw new Error(
        `${project.name} ${label} has ${dirtyCount} uncommitted or untracked ${dirtyCount === 1 ? 'file' : 'files'}; commit or clean them before migrating VCS`
      )
    }
  }

  const resolvedJj = jjInfo ?? (await ensureJjBinarySupported())
  return {
    from,
    jjBinary: resolvedJj.binary,
    jjVersion: resolvedJj.version,
    poolDirs
  }
}

function removePoolDirectoryIfEmpty(root: string): void {
  try {
    rmdirSync(root)
  } catch {
    // Non-empty or absent directory stays untouched.
  }
}

async function rebuildPooledWorkspaces(
  project: Project,
  targetVcs: MigratableVcs,
  hasAnyCommits: boolean,
  warnings: string[]
): Promise<{ members: string[]; rebuiltWorkspaces: number }> {
  // Read branch-pool policy explicitly (both 'git' and 'jj' share workspace pool sizing).
  const policy = policyFor({ ...project, vcs: 'git' })
  const driver = targetVcs === 'jj' ? jjDriver : gitDriver
  const migratedView: Project = { ...project, vcs: targetVcs }

  if (policy.poolSize === 0 || !hasAnyCommits) {
    if (policy.poolSize > 0 && !hasAnyCommits) {
      warnings.push('Skipped workspace creation because repository has no commits yet.')
    }
    removePoolDirectoryIfEmpty(policy.workspaceRoot)
    return { members: [], rebuiltWorkspaces: 0 }
  }

  mkdirSync(policy.workspaceRoot, { recursive: true })
  const base = await trunkBaseRef(migratedView)
  const members: string[] = []
  for (let i = 1; i <= policy.poolSize; i++) {
    const wsPath = join(policy.workspaceRoot, `ws${i}`)
    await driver.addWorkspace(migratedView, wsPath, base)
    members.push(wsPath)
  }
  return { members, rebuiltWorkspaces: members.length }
}

function commitMigrationState(input: {
  project: Project
  to: MigratableVcs
  members: string[]
  record: VcsMigrationRecord
}): Project {
  const policy = policyFor(input.project)
  const poolId = workspacePoolId(input.project.id)
  const conn = db()
  conn.exec('begin immediate')
  try {
    upsertResource({
      id: poolId,
      projectId: input.project.id,
      kind: 'counted',
      label: `${input.project.name} workspaces`,
      capacity: input.members.length,
      members: input.members,
      meta: { vcs: input.to, root: policy.workspaceRoot }
    })
    conn.prepare('update projects set vcs = ? where id = ?').run(input.to, input.project.id)
    insertMigrationRow(input.record)
    conn.exec('commit')
  } catch (err) {
    conn.exec('rollback')
    throw err
  }
  const updated = requireProject(input.project.id)
  emit({ type: 'project.changed', project: updated })
  return updated
}

interface GitDirSnapshot {
  metaFiles: Map<string, Buffer>
  objectFiles: Set<string>
}

function walkGitDir(
  baseDir: string,
  relPrefix: string,
  visitFile: (relPath: string, fullPath: string) => void
): void {
  for (const name of readdirSync(baseDir)) {
    const full = join(baseDir, name)
    const rel = relPrefix ? `${relPrefix}/${name}` : name
    const st = statSync(full)
    if (st.isDirectory()) {
      // Skip large pack/lfs trees; jj git init/import only creates loose objects and refs.
      if (rel === 'objects/pack' || rel === 'objects/info' || rel === 'lfs') continue
      walkGitDir(full, rel, visitFile)
    } else {
      visitFile(rel, full)
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function removeGitSnapshotFile(full: string): void {
  try {
    chmodSync(full, 0o666)
  } catch {
    // Best-effort before unlink on Windows read-only git object files.
  }
  rmSync(full, { force: true })
}

function captureGitDirSnapshot(gitDir: string): GitDirSnapshot {
  const metaFiles = new Map<string, Buffer>()
  const objectFiles = new Set<string>()
  if (!isDirectory(gitDir)) return { metaFiles, objectFiles }
  walkGitDir(gitDir, '', (rel, full) => {
    if (rel.startsWith('objects/')) {
      objectFiles.add(rel)
    } else {
      metaFiles.set(rel, readFileSync(full))
    }
  })
  return { metaFiles, objectFiles }
}

function pruneEmptyGitSubdirs(dir: string, isRoot = true): boolean {
  const entries = readdirSync(dir)
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (pruneEmptyGitSubdirs(full, false)) {
        rmdirSync(full)
      }
    }
  }
  return !isRoot && readdirSync(dir).length === 0
}

function restoreGitDirSnapshot(gitDir: string, snap: GitDirSnapshot): void {
  if (!isDirectory(gitDir)) return
  walkGitDir(gitDir, '', (rel, full) => {
    if (rel.startsWith('objects/')) {
      if (!snap.objectFiles.has(rel)) removeGitSnapshotFile(full)
    } else if (!snap.metaFiles.has(rel)) {
      removeGitSnapshotFile(full)
    }
  })
  for (const [rel, bytes] of snap.metaFiles.entries()) {
    const full = join(gitDir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    const current = existsSync(full) ? readFileSync(full) : null
    if (!current || !current.equals(bytes)) {
      writeFileSync(full, bytes)
    }
  }
  pruneEmptyGitSubdirs(gitDir)
}

async function migrateGitToJj(
  project: Project,
  jjBinary: string,
  jjVersion: string,
  poolDirs: string[],
  startedAt: number,
  opts: MigrateVcsOptions
): Promise<VcsMigrationResult> {
  const policy = policyFor({ ...project, vcs: 'git' })
  const jjDir = join(project.root, '.jj')
  const gitDir = join(project.root, '.git')
  const hadJjDirBefore = existsSync(jjDir)
  const warnings: string[] = []
  const branchSnapshot = await snapshotGitBranches(project.root)
  const branchSnapshotRecord = Object.fromEntries(branchSnapshot)
  const gitSnapshot = captureGitDirSnapshot(gitDir)

  const rollback = (reason: string, extra?: Record<string, unknown>): never => {
    if (!hadJjDirBefore && existsSync(jjDir)) {
      rmSync(jjDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } else if (hadJjDirBefore) {
      warnings.push('Left pre-existing .jj directory untouched on rollback.')
    }
    restoreGitDirSnapshot(gitDir, gitSnapshot)
    const record: VcsMigrationRecord = {
      id: randomUUID(),
      projectId: project.id,
      fromVcs: 'git',
      toVcs: 'jj',
      status: 'rolled_back',
      startedAt,
      finishedAt: Date.now(),
      detail: {
        reason,
        warnings,
        jjVersion,
        branchCount: branchSnapshot.size,
        branchSnapshot: branchSnapshotRecord,
        ...extra
      }
    }
    insertMigrationRow(record)
    throw new Error(`Aborted git -> jj migration for ${project.name} and rolled back cleanly: ${reason}`)
  }

  try {
    if (!hadJjDirBefore) {
      await execJjRaw(jjBinary, project.root, ['git', 'init', '--colocate', project.root], {
        ignoreWorkingCopy: false
      })
    } else {
      await execJjRaw(jjBinary, project.root, ['-R', project.root, 'git', 'import'], {
        ignoreWorkingCopy: true
      })
      warnings.push('Imported current git refs into existing .jj directory.')
    }

    const originTargetExists = Boolean(
      await tryGit(project.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${policy.landingTarget}`])
    )
    const trunkExpr = originTargetExists ? `${policy.landingTarget}@origin` : policy.landingTarget
    await execJjRaw(
      jjBinary,
      project.root,
      ['-R', project.root, 'config', 'set', '--repo', 'revset-aliases."trunk()"', JSON.stringify(trunkExpr)],
      { ignoreWorkingCopy: true }
    )

    if (opts._beforeVerifyForTest) {
      await opts._beforeVerifyForTest(project.root)
    }

    const jjBookmarks = await snapshotJjLocalBookmarks(jjBinary, project.root)
    const mismatches: string[] = []
    for (const [branch, sha] of branchSnapshot.entries()) {
      const target = jjBookmarks.get(branch)
      if (!target || target.length === 0) {
        mismatches.push(`missing bookmark '${branch}' (expected ${sha})`)
      } else if (target.length > 1) {
        mismatches.push(`conflicted bookmark '${branch}' (targets ${target.join(', ')})`)
      } else if (target[0] !== sha) {
        mismatches.push(`bookmark '${branch}' points to ${target[0]} instead of ${sha}`)
      }
    }
    if (mismatches.length > 0) {
      rollback(mismatches.join('; '), { mismatches })
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Aborted git -> jj migration')) throw err
    rollback(errorMessage(err))
  }

  // Bookmarks match git refs 100%; safe to replace git worktrees with jj workspaces.
  for (const wsPath of poolDirs) {
    if (existsSync(wsPath)) {
      await gitDriver.removeWorkspace(project, wsPath, { prune: false })
    }
  }
  await gitDriver.pruneWorkspaces(project)

  const { members, rebuiltWorkspaces } = await rebuildPooledWorkspaces(
    project,
    'jj',
    branchSnapshot.size > 0,
    warnings
  )

  const record: VcsMigrationRecord = {
    id: randomUUID(),
    projectId: project.id,
    fromVcs: 'git',
    toVcs: 'jj',
    status: 'completed',
    startedAt,
    finishedAt: Date.now(),
    detail: {
      jjVersion,
      branchCount: branchSnapshot.size,
      branchSnapshot: branchSnapshotRecord,
      rebuiltWorkspaces,
      keptJjDir: true,
      warnings
    }
  }
  const updated = commitMigrationState({ project, to: 'jj', members, record })
  log.info(`migrated ${project.name} VCS from git to jj (${rebuiltWorkspaces} workspace(s) rebuilt)`)
  return {
    project: updated,
    migration: record,
    warnings,
    rebuiltWorkspaces,
    keptJjDir: true
  }
}

async function migrateJjToGit(
  project: Project,
  jjBinary: string,
  jjVersion: string,
  poolDirs: string[],
  startedAt: number,
  opts: MigrateVcsOptions
): Promise<VcsMigrationResult> {
  const policy = policyFor(project)
  const jjDir = join(project.root, '.jj')
  const warnings: string[] = []
  const removeJjDir = opts.removeJjDir === true

  const bookmarkSnapshot = await snapshotJjLocalBookmarks(jjBinary, project.root)
  for (const [name, targets] of bookmarkSnapshot.entries()) {
    if (targets.length === 0) {
      throw new Error(`Cannot migrate ${project.name} from jj to git: bookmark '${name}' has no target commit`)
    }
    if (targets.length > 1) {
      throw new Error(
        `Cannot migrate ${project.name} from jj to git: bookmark '${name}' is conflicted (${targets.join(', ')})`
      )
    }
  }
  const bookmarkSnapshotRecord = Object.fromEntries(
    [...bookmarkSnapshot.entries()].map(([k, v]) => [k, v[0] ?? ''])
  )

  try {
    await execJjRaw(jjBinary, project.root, ['-R', project.root, 'git', 'export'], {
      ignoreWorkingCopy: true
    })

    if (opts._beforeVerifyForTest) {
      await opts._beforeVerifyForTest(project.root)
    }

    const gitBranches = await snapshotGitBranches(project.root)
    const mismatches: string[] = []
    for (const [name, targets] of bookmarkSnapshot.entries()) {
      const expected = targets[0]
      const actual = gitBranches.get(name)
      if (!actual) {
        mismatches.push(`missing git branch '${name}' (expected ${expected})`)
      } else if (actual !== expected) {
        mismatches.push(`git branch '${name}' points to ${actual} instead of ${expected}`)
      }
    }
    if (mismatches.length > 0) {
      const reason = mismatches.join('; ')
      insertMigrationRow({
        id: randomUUID(),
        projectId: project.id,
        fromVcs: 'jj',
        toVcs: 'git',
        status: 'rolled_back',
        startedAt,
        finishedAt: Date.now(),
        detail: {
          reason,
          mismatches,
          jjVersion,
          bookmarkCount: bookmarkSnapshot.size,
          bookmarkSnapshot: bookmarkSnapshotRecord
        }
      })
      throw new Error(`Aborted jj -> git migration for ${project.name} and rolled back cleanly: ${reason}`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Aborted jj -> git migration')) throw err
    const reason = errorMessage(err)
    insertMigrationRow({
      id: randomUUID(),
      projectId: project.id,
      fromVcs: 'jj',
      toVcs: 'git',
      status: 'rolled_back',
      startedAt,
      finishedAt: Date.now(),
      detail: {
        reason,
        jjVersion,
        bookmarkCount: bookmarkSnapshot.size,
        bookmarkSnapshot: bookmarkSnapshotRecord
      }
    })
    throw new Error(`Aborted jj -> git migration for ${project.name} and rolled back cleanly: ${reason}`, {
      cause: err
    })
  }

  // Git refs match jj bookmarks 100%; retire jj workspaces cleanly.
  for (const wsPath of poolDirs) {
    await jjDriver.removeWorkspace(project, wsPath, { prune: false })
  }
  await jjDriver.pruneWorkspaces(project)

  // Re-attach trunk HEAD to target only when detached, clean, and pointing at the exact same commit.
  const targetSha = await tryGit(project.root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${policy.landingTarget}`
  ])
  const headBranch = await gitDriver.currentBranch(project.root)
  if (headBranch === policy.landingTarget) {
    // Already attached to target.
  } else if (headBranch !== null) {
    warnings.push(`Left trunk HEAD on '${headBranch}' instead of switching to '${policy.landingTarget}'.`)
  } else if (!targetSha) {
    if (bookmarkSnapshot.size > 0) {
      warnings.push(`Trunk HEAD remained detached because local branch '${policy.landingTarget}' does not exist.`)
    }
  } else {
    const headSha = await tryGit(project.root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const dirtyTrunk = await gitDriver.hasUncommittedChanges(project.root)
    if (dirtyTrunk) {
      warnings.push(
        `Left trunk HEAD detached because the trunk has uncommitted changes (switch to '${policy.landingTarget}' manually).`
      )
    } else if (!headSha || headSha.toLowerCase() !== targetSha.toLowerCase()) {
      warnings.push(
        `Left trunk HEAD detached because HEAD (${headSha?.slice(0, 8) ?? 'missing'}) differs from '${policy.landingTarget}' (${targetSha.slice(0, 8)}).`
      )
    } else {
      await git(project.root, ['switch', policy.landingTarget])
    }
  }

  const gitBranches = await snapshotGitBranches(project.root)
  const { members, rebuiltWorkspaces } = await rebuildPooledWorkspaces(
    project,
    'git',
    gitBranches.size > 0,
    warnings
  )

  const record: VcsMigrationRecord = {
    id: randomUUID(),
    projectId: project.id,
    fromVcs: 'jj',
    toVcs: 'git',
    status: 'completed',
    startedAt,
    finishedAt: Date.now(),
    detail: {
      jjVersion,
      bookmarkCount: bookmarkSnapshot.size,
      bookmarkSnapshot: bookmarkSnapshotRecord,
      rebuiltWorkspaces,
      keptJjDir: !removeJjDir,
      warnings
    }
  }
  const updated = commitMigrationState({ project, to: 'git', members, record })

  if (removeJjDir && existsSync(jjDir)) {
    try {
      rmSync(jjDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (err) {
      warnings.push(`Could not remove .jj directory: ${errorMessage(err)}`)
    }
  }
  const keptJjDir = existsSync(jjDir)
  log.info(
    `migrated ${project.name} VCS from jj to git (${rebuiltWorkspaces} workspace(s) rebuilt, keptJjDir=${keptJjDir})`
  )
  return {
    project: updated,
    migration: record,
    warnings,
    rebuiltWorkspaces,
    keptJjDir
  }
}

/**
 * Migrate a local Warmstart project between colocated `git` and `jj`.
 * Checks safety preconditions before touching disk, verifies ref/bookmark parity before replacing
 * workspaces, and updates SQLite state atomically.
 */
export async function migrateProjectVcs(
  projectId: string,
  to: MigratableVcs,
  opts: MigrateVcsOptions = {}
): Promise<VcsMigrationResult> {
  const startedAt = Date.now()
  const project = requireProject(projectId)
  const { from, jjBinary, jjVersion, poolDirs } = await assertPreconditions(project, to, opts)

  if (from === 'git' && to === 'jj') {
    return migrateGitToJj(project, jjBinary, jjVersion, poolDirs, startedAt, opts)
  }
  return migrateJjToGit(project, jjBinary, jjVersion, poolDirs, startedAt, opts)
}
