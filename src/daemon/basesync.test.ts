import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FinishPolicy, Project, Task } from '@shared/tasks.js'

/**
 * Where a task's branch is cut from.
 *
 * ⛔ Measured on this repository, 2026-09-04: local `main` stood **41 commits ahead of
 * `origin/main`**, because the project finishes with `commit-and-merge` — which merges into the
 * *local* trunk and never pushes. Branches were nonetheless cut from `origin/main`, so a task
 * started against a completely idle fleet, touching a file nobody else had open, arrived 41 commits
 * behind and had to rebase all of it to land. The operator saw it as "landing almost always
 * conflicts"; it was the base, not the agents.
 *
 * ⚠️ Real git in temporary repositories, deliberately. The whole question is which ref git resolves
 * and how far apart two of them drift, so a test that stubbed git would pass against the bug.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let worktrees: typeof import('./worktrees.js')
let tasks: typeof import('./tasks.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

/**
 * A repo with a real `origin` that has been pushed once and then left behind, which is the resting
 * state of every `commit-and-merge` project.
 */
function makeProject(finish: FinishPolicy): { project: Project; root: string } {
  seq += 1
  const root = join(dir, `repo${seq}`)
  const origin = join(dir, `origin${seq}.git`)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  git(dir, 'init', '--bare', '--initial-branch=main', origin)
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
      workspaces: { poolSize: 1 },
      landing: { finish, target: 'main' }
    })
  )
  writeFileSync(join(root, 'kept.txt'), 'as committed\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-u', 'origin', 'main')
  return { project: projects.addProject({ root }), root }
}

/** Move the local trunk on without telling the remote, exactly as `merge-local` landing does. */
function landLocally(root: string, name: string): string {
  writeFileSync(join(root, `${name.replace(/\W+/g, '-')}.txt`), `${name}\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-m', `landed ${name}`)
  return git(root, 'rev-parse', 'HEAD')
}

function makeTask(project: Project, title: string, parent?: Task, kind?: Task['kind']): Task {
  return tasks.createTask({
    title,
    projectId: project.id,
    ...(parent ? { parentTaskId: parent.id } : {}),
    ...(kind ? { kind } : {})
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-basesync-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  worktrees = await import('./worktrees.js')
  tasks = await import('./tasks.js')
  db.openDb(join(dir, 'basesync.db'))
})

afterAll(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('a trunk whose remote has been left behind', () => {
  it('cuts a commit-and-merge branch from the ref its landing will rebase onto', async () => {
    const { project, root } = makeProject('commit-and-merge')
    landLocally(root, 'one')
    landLocally(root, 'two')
    expect(git(root, 'rev-list', '--count', 'origin/main..main')).toBe('2')

    const base = await worktrees.baseRef(project)
    expect(base).toBe('main')
    // ⭐ The point of the whole change: nothing between the base and where landing will rebase.
    expect(git(root, 'rev-list', '--count', `${base}..main`)).toBe('0')
  })

  /**
   * ⛔ **A conversation was cut from the remote, whatever its project's rung said.**
   * `baseRef` asked `resolveFinishPolicy`, and an open conversation answers `await-human` from its
   * kind — which maps to `leave-branch`, whose base is `origin/<target>`. So the one kind of task
   * that lands over and over, on the same branch, all day, was the one kind always cut behind.
   *
   * ⭐ Measured on t578 (inkland), 2026-09-20: local `main` stood 9 commits ahead of `origin/main`,
   * and the conversation's branch sat on `origin/main` — so its landing had to replay nine commits
   * of history, several of them its own earlier landing, and conflicted on every press.
   */
  it('⛔ cuts a conversation from the local trunk too, which is where its Land button merges', async () => {
    const { project, root } = makeProject('commit-and-merge')
    landLocally(root, 'one')
    const head = landLocally(root, 'two')
    const chat = makeTask(project, 'a conversation that lands again and again', undefined, 'conversation')

    const base = await worktrees.baseRef(project, chat)
    expect(base).toBe('main')
    expect(git(root, 'rev-parse', base)).toBe(head)
    // ⭐ The measurement that matters: nothing between where it starts and where it must land.
    expect(git(root, 'rev-list', '--count', `${base}..main`)).toBe('0')
  })

  it('still prefers origin/<target> when the policy is the one that pushes there', async () => {
    const { project, root } = makeProject('commit-and-push')
    landLocally(root, 'one')
    expect(await worktrees.baseRef(project)).toBe('origin/main')
    // ⚠️ And the caller fetches first — this decides the name only, never what it points at.
    expect(git(root, 'rev-parse', 'origin/main')).not.toBe(git(root, 'rev-parse', 'main'))
  })

  it('puts a real workspace on the fresh base, not on the stale remote', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const head = landLocally(root, 'one')
    const task = makeTask(project, 'a task started while nothing else runs')
    const workspace = await worktrees.claimWorkspace(project, task.id)
    expect(workspace).not.toBeNull()

    const branch = worktrees.branchNameFor(task.seq, task.title)
    const prepared = await worktrees.prepareWorkspace(project, workspace!, branch, task)
    expect(prepared.ok).toBe(true)
    expect(git(workspace!.path, 'rev-parse', 'HEAD')).toBe(head)
    // ⭐ Zero commits to rebase over, which is what "no conflict on landing" actually means.
    expect(git(workspace!.path, 'rev-list', '--count', `main..${branch}`)).toBe('0')
  })
})

describe('a subtask filed by a planner', () => {
  it('starts from the parent branch, so the work it extends is there to see', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const parent = makeTask(project, 'plan the thing', undefined, 'plan')
    const parentBranch = worktrees.branchNameFor(parent.seq, parent.title)
    git(root, 'branch', parentBranch, 'main')
    tasks.setStatus(parent.id, 'running', { branch: parentBranch })

    // The planner commits its design on its own branch and has not landed it.
    const worktree = join(dir, `plan${seq}`)
    git(root, 'worktree', 'add', worktree, parentBranch)
    writeFileSync(join(worktree, 'design.md'), 'the plan\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-m', 'the plan')
    const tip = git(worktree, 'rev-parse', 'HEAD')

    const child = makeTask(project, 'do step one', tasks.getTask(parent.id)!)
    expect(await worktrees.baseRef(project, child)).toBe(parentBranch)

    // ⚠️ Released before the claim: git will not hand one branch to two worktrees, and the point
    // here is the base, not the parking that `prepareWorkspace` would otherwise have to do.
    git(root, 'worktree', 'remove', '--force', worktree)
    const workspace = await worktrees.claimWorkspace(project, child.id)
    const branch = worktrees.branchNameFor(child.seq, child.title)
    expect((await worktrees.prepareWorkspace(project, workspace!, branch, child)).ok).toBe(true)
    expect(git(workspace!.path, 'rev-parse', 'HEAD')).toBe(tip)
  })

  it('uses the trunk for a child whose parent is not a planner', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const parent = makeTask(project, 'plan the thing')
    const parentBranch = worktrees.branchNameFor(parent.seq, parent.title)
    git(root, 'branch', parentBranch, 'main')
    landLocally(root, 'the parent work merged')
    tasks.setStatus(parent.id, 'completed', { branch: parentBranch })

    const child = makeTask(project, 'do step one', tasks.getTask(parent.id)!)
    // ⭐ A generic parent branch is not a landing target. Inheriting its stale ref here would be
    // the original bug wearing a different hat.
    expect(await worktrees.baseRef(project, child)).toBe('main')
  })

  it('keeps using the explicit planner target when the project trunk moves', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const parent = makeTask(project, 'plan the thing', undefined, 'plan')
    const parentBranch = worktrees.branchNameFor(parent.seq, parent.title)
    git(root, 'branch', parentBranch, 'main')
    tasks.setStatus(parent.id, 'running', { branch: parentBranch })
    landLocally(root, 'unrelated trunk work')

    const child = makeTask(project, 'do step two', tasks.getTask(parent.id)!)
    expect(child.landingTarget).toBe(parentBranch)
    expect(await worktrees.baseRef(project, child)).toBe(parentBranch)
  })
})

describe('a branch left over from a run that produced nothing', () => {
  it('is fast-forwarded to the current base rather than starting a rebase behind', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const task = makeTask(project, 'a task dispatched twice')
    const branch = worktrees.branchNameFor(task.seq, task.title)

    const first = await worktrees.claimWorkspace(project, task.id)
    expect((await worktrees.prepareWorkspace(project, first!, branch, task)).ok).toBe(true)
    await worktrees.parkWorkspace(project, first!.path)
    worktrees.releaseWorkspace(first!.claimId)

    // Two landings happen while this task waits its turn.
    landLocally(root, 'one')
    const head = landLocally(root, 'two')

    const second = await worktrees.claimWorkspace(project, task.id)
    expect((await worktrees.prepareWorkspace(project, second!, branch, task)).ok).toBe(true)
    expect(git(second!.path, 'rev-parse', 'HEAD')).toBe(head)
    worktrees.releaseWorkspace(second!.claimId)
  })

  it('leaves a branch that carries real commits exactly where it is', async () => {
    const { project, root } = makeProject('commit-and-merge')
    const task = makeTask(project, 'a task with work already on it')
    const branch = worktrees.branchNameFor(task.seq, task.title)

    const workspace = await worktrees.claimWorkspace(project, task.id)
    expect((await worktrees.prepareWorkspace(project, workspace!, branch, task)).ok).toBe(true)
    writeFileSync(join(workspace!.path, 'work.txt'), 'real work\n')
    git(workspace!.path, 'add', '-A')
    git(workspace!.path, 'commit', '-m', 'real work')
    const tip = git(workspace!.path, 'rev-parse', 'HEAD')

    landLocally(root, 'somebody else landed meanwhile')
    // ⛔ No fast-forward, no rebase, no reset: the agent's commit is the one thing that must not move.
    expect((await worktrees.prepareWorkspace(project, workspace!, branch, task)).ok).toBe(true)
    expect(git(workspace!.path, 'rev-parse', 'HEAD')).toBe(tip)
    worktrees.releaseWorkspace(workspace!.claimId)
  })
})
