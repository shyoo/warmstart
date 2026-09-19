import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'
import { projectTrunkOnly } from '@shared/tasks.js'

/**
 * A project with no worktree pool (t563).
 *
 * `workspaces.poolSize: 0` is trunk-only: `ensurePool` creates nothing and parks whatever is
 * left, `prunePoolWorktrees` removes the idle directories from disk with the operator's
 * confirmation, the gate holds worktree tasks with a reason that names the fix, and explicit
 * worktree pins are refused at the door rather than wedged at dispatch.
 *
 * ⚠️ Real git, in temporary repositories. Removing a worktree is a git operation on real
 * worktree metadata — `git worktree list` is the oracle a stub could never be.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let worktrees: typeof import('./worktrees.js')
let resources: typeof import('./resources.js')
let tasks: typeof import('./tasks.js')
let scoring: typeof import('./scoring.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

function makeProject(poolSize = 1): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name: `repo${seq}`,
      vcs: 'git',
      check: [],
      workspaces: { poolSize },
      landing: { strategy: 'auto-land', target: 'main' }
    })
  )
  writeFileSync(join(root, 'kept.txt'), 'as committed\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return projects.addProject({ root })
}

const worktreeList = (root: string): string => git(root, 'worktree', 'list', '--porcelain')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-trunkonly-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  worktrees = await import('./worktrees.js')
  resources = await import('./resources.js')
  tasks = await import('./tasks.js')
  await import('./scheduler.js')
  scoring = await import('./scoring.js')
  db.openDb(join(dir, 'trunkonly.db'))
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('a pool of zero is trunk-only', () => {
  it('resolves pool size 0 through the policy without clamping it back to one', () => {
    const project = makeProject(3)
    expect(projectTrunkOnly(project)).toBe(false)
    const trunkOnly = projects.setProjectPolicy(project.id, { poolSize: 0 })
    expect(trunkOnly.config.workspaces?.poolSize).toBe(0)
    expect(projects.policyFor(trunkOnly).poolSize).toBe(0)
    expect(projectTrunkOnly(trunkOnly)).toBe(true)
  })

  it('is never trunk-only without a repository: a bare directory is its own pool of one', () => {
    seq += 1
    const root = join(dir, `plain${seq}`)
    mkdirSync(root, { recursive: true })
    const project = projects.addProject({ root })
    expect(project.vcs).toBe('none')
    expect(projects.policyFor(project).poolSize).toBe(1)
    expect(projectTrunkOnly(project)).toBe(false)
  })

  it('creates no worktrees, parks the extras, and records capacity zero', async () => {
    const project = makeProject(2)
    const pooled = await worktrees.ensurePool(project)
    expect(pooled).toHaveLength(2)

    const trunkOnly = projects.setProjectPolicy(project.id, { poolSize: 0 })
    const members = await worktrees.ensurePool(trunkOnly)
    expect(members).toEqual([])
    const state = resources.availability(resources.workspacePoolId(project.id))
    expect(state?.resource.capacity).toBe(0)
    // Parked, not removed: narrowing never deletes, whatever the new size.
    expect(existsSync(join(`${project.root}_workspaces`, 'ws1'))).toBe(true)
    expect(existsSync(pooled[0]!)).toBe(true)
    expect(existsSync(pooled[1]!)).toBe(true)
  })

  it('removes idle worktrees from disk and keeps the one holding a claim', async () => {
    const project = makeProject(2)
    const [first, second] = await worktrees.ensurePool(project)
    const claim = await worktrees.claimWorkspace(project, 'run-1')
    expect(claim?.path).toBe(first)

    const pruned = await worktrees.prunePoolWorktrees(project)
    expect(pruned.removed).toEqual([second])
    expect(existsSync(second!)).toBe(false)
    expect(worktreeList(project.root)).not.toContain('ws2')
    expect(pruned.kept.map((k) => k.path)).toEqual([first])
    expect(existsSync(first!)).toBe(true)

    worktrees.releaseWorkspace(claim!.claimId)
    const again = await worktrees.prunePoolWorktrees(project)
    expect(again.removed).toEqual([first])
    expect(worktreeList(project.root)).not.toContain('ws1')
  })

  it('rescues dirt onto the branch before removing the tree', async () => {
    const project = makeProject(1)
    const [only] = await worktrees.ensurePool(project)
    // A task branch with uncommitted work, as a run would leave it.
    git(project.root, 'branch', 'warmstart/t1-dirty')
    git(only!, 'checkout', 'warmstart/t1-dirty')
    writeFileSync(join(only!, 'uncommitted.txt'), 'half-finished\n')

    const pruned = await worktrees.prunePoolWorktrees(project)
    expect(pruned.removed).toEqual([only])
    expect(existsSync(only!)).toBe(false)
    // The work survived the directory: committed onto the task branch.
    expect(git(project.root, 'log', '--oneline', 'warmstart/t1-dirty')).toContain('wip:')
  })

  it('holds worktree tasks with a reason that names the fix, and lets trunk tasks through', () => {
    const project = projects.setProjectPolicy(makeProject(1).id, { poolSize: 0 })
    const worktreeTask = tasks.createTask({ title: 'needs a tree', projectId: project.id })
    expect(scoring.poolPressure(worktreeTask)).toMatch(/trunk-only/)
    const trunkTask = tasks.createTask({
      title: 'serial work',
      projectId: project.id,
      workspaceMode: 'trunk'
    })
    expect(scoring.poolPressure(trunkTask)).toBeNull()
  })

  it('refuses explicit worktree pins at the door', () => {
    const project = projects.setProjectPolicy(makeProject(1).id, { poolSize: 0 })
    expect(() =>
      tasks.createTask({ title: 'pinned', projectId: project.id, workspaceMode: 'worktree' })
    ).toThrow(/trunk-only/)
    const task = tasks.createTask({ title: 'inheriting', projectId: project.id })
    expect(() => tasks.setWorkspaceMode(task.id, 'worktree')).toThrow(/trunk-only/)
    expect(tasks.setWorkspaceMode(task.id, 'trunk').workspaceMode).toBe('trunk')
  })
})
