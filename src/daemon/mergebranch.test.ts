import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * `merge-branch`: landing a split child onto its plan branch without checking that branch out.
 *
 * ⛔ **Real git, in a real repository, because the whole strategy lives in what git is asked.** A
 * test that stubbed `update-ref` would pass against a version that moves the branch backwards, or
 * that moves a branch another worktree is sitting on — which are the two ways this corrupts
 * something rather than merely failing a task.
 *
 * ⛔ And every guard is watched going **red** before it is trusted green. A merge strategy that
 * silently does nothing looks exactly like one that worked.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let landing: typeof import('./landing.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

/**
 * A trunk on `main`, a plan branch off it, and a child worktree branched from the plan branch with
 * one commit on it — the state a split child is in when it finishes.
 */
function seedSplit(): {
  project: Project
  planBranch: string
  childBranch: string
  childTaskId: string
  root: string
  ws: string
} {
  seq += 1
  const root = join(dir, `split${seq}`)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
  writeFileSync(
    join(root, '.multi_agent_controller', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name: `split${seq}`,
      vcs: 'git',
      check: [],
      landing: { strategy: 'merge-local', target: 'main' }
    })
  )
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')

  const project = projects.addProject({ root })
  const planBranch = `multi-agent-controller/t${seq}00-the-plan`
  const childBranch = `multi-agent-controller/t${seq}01-a-piece`

  // The plan branch exists and is checked out NOWHERE — the planner parked its workspace on a
  // detached HEAD when phase 1 ended, which is the state children run against.
  git(root, 'branch', planBranch, 'main')

  const child = tasks.createTask({
    title: `piece ${seq}`,
    projectId: project.id,
    createdBy: { kind: 'human' },
    landingTarget: planBranch
  })

  const ws = join(dir, `split${seq}-ws`)
  git(root, 'worktree', 'add', '-b', childBranch, ws, planBranch)
  writeFileSync(join(ws, `piece${seq}.txt`), 'the piece did its work\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '-m', 'the piece did its work')

  return { project, planBranch, childBranch, childTaskId: child.id, root, ws }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-mergebranch-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  landing = await import('./landing.js')
  db.openDb(join(dir, 'mergebranch.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows holds git pack files briefly; a leftover temp dir is harmless.
  }
})

const land = async (project: Project, taskId: string, ws: string, branch: string) =>
  landing.landTask({
    project,
    task: tasks.requireTask(taskId),
    workspacePath: ws,
    branch,
    policy: 'commit-and-merge'
  })

describe('strategyFor', () => {
  it('⛔ picks merge-branch from the resolved target, never from a task kind', () => {
    const { project, childTaskId } = seedSplit()
    const child = tasks.requireTask(childTaskId)
    expect(child.kind).toBe('work')
    expect(landing.strategyFor(project, 'commit-and-merge', child).id).toBe('merge-branch')
  })

  it('leaves an ordinary task on merge-local, because its target is the project’s own', () => {
    const { project } = seedSplit()
    const ordinary = tasks.createTask({ title: 'ordinary', projectId: project.id })
    expect(landing.strategyFor(project, 'commit-and-merge', ordinary).id).toBe('merge-local')
  })

  it('does not overrule a policy that was never going to merge', () => {
    const { project, childTaskId } = seedSplit()
    const child = tasks.requireTask(childTaskId)
    // The operator asked for a branch. Having a private landing target is not a reason to merge.
    expect(landing.strategyFor(project, 'commit-only', child).id).toBe('leave-branch')
  })
})

describe('merge-branch', () => {
  it('fast-forwards the plan branch by ref, with it checked out nowhere', async () => {
    const { project, planBranch, childBranch, childTaskId, root, ws } = seedSplit()
    const before = git(root, 'rev-parse', planBranch)
    const childTip = git(ws, 'rev-parse', 'HEAD')

    const result = await land(project, childTaskId, ws, childBranch)
    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('merge-branch')
    expect(git(root, 'rev-parse', planBranch)).toBe(childTip)
    expect(git(root, 'rev-parse', planBranch)).not.toBe(before)
  })

  it('⛔ leaves the trunk exactly where it was — nothing reaches main until the plan is whole', async () => {
    const { project, childBranch, childTaskId, root, ws } = seedSplit()
    const mainBefore = git(root, 'rev-parse', 'main')
    await land(project, childTaskId, ws, childBranch)
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore)
  })

  it('never checks the target out anywhere, so the operator’s trunk is untouched', async () => {
    const { project, planBranch, childBranch, childTaskId, root, ws } = seedSplit()
    await land(project, childTaskId, ws, childBranch)
    // The trunk is still on `main`; `merge-local` would have required it to be on the plan branch.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    const worktrees = git(root, 'worktree', 'list', '--porcelain')
    expect(worktrees).not.toContain(`branch refs/heads/${planBranch}`)
  })

  it('lands a second piece on top of the first, which is what makes a dependency mean anything', async () => {
    const { project, planBranch, childBranch, childTaskId, root, ws } = seedSplit()
    await land(project, childTaskId, ws, childBranch)
    const afterFirst = git(root, 'rev-parse', planBranch)

    // A sibling cut from the plan branch AFTER the first landed sees the first one's work.
    const secondBranch = `${childBranch}-two`
    const ws2 = join(dir, `split${seq}-ws2`)
    git(root, 'worktree', 'add', '-b', secondBranch, ws2, planBranch)
    expect(git(ws2, 'rev-parse', 'HEAD')).toBe(afterFirst)
    writeFileSync(join(ws2, 'second.txt'), 'the second piece\n')
    git(ws2, 'add', '-A')
    git(ws2, 'commit', '-m', 'the second piece')
    const second = tasks.createTask({
      title: 'second piece',
      projectId: project.id,
      createdBy: { kind: 'human' },
      landingTarget: planBranch
    })

    const result = await land(project, second.id, ws2, secondBranch)
    expect(result.ok).toBe(true)
    // Both pieces are on the plan branch, in order.
    const log = git(root, 'log', '--format=%s', planBranch)
    expect(log).toContain('the second piece')
    expect(log).toContain('the piece did its work')
  })

  it('⛔ refuses when the target IS checked out somewhere, rather than corrupting it', async () => {
    const { project, planBranch, childBranch, childTaskId, root, ws } = seedSplit()
    // Somebody — the operator, or a parked planner that was revived — has the plan branch out.
    const holder = join(dir, `split${seq}-holder`)
    git(root, 'worktree', 'add', holder, planBranch)
    const before = git(root, 'rev-parse', planBranch)

    const result = await land(project, childTaskId, ws, childBranch)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/checked out/)
    // ⛔ The proof that matters: the branch did not move, and the child kept its work.
    expect(git(root, 'rev-parse', planBranch)).toBe(before)
    expect(git(root, 'rev-parse', childBranch)).toBeTruthy()
  })

  it('⭐ absorbs a sibling that landed while this piece ran, by rebasing onto it first', async () => {
    const { project, planBranch, childBranch, childTaskId, root, ws } = seedSplit()
    // The plan branch gains a commit this child never saw — which is exactly what a sibling landing
    // mid-run looks like, and under this design it happens constantly and on purpose. Done in a
    // throwaway worktree so the branch is still checked out nowhere at land time.
    const other = join(dir, `split${seq}-other`)
    git(root, 'worktree', 'add', other, planBranch)
    writeFileSync(join(other, 'divergent.txt'), 'a sibling\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-m', 'a sibling landed first')
    git(other, 'switch', '--detach', 'HEAD')
    const sibling = git(root, 'rev-parse', planBranch)

    const result = await land(project, childTaskId, ws, childBranch)
    // ⛔ **Not a refusal.** The rebase onto the target is what makes the fast-forward legitimate, so
    //    a target that moved is handled rather than declined — the ancestry proof and the
    //    compare-and-swap exist for the narrower race where it moves *after* the rebase.
    expect(result.ok).toBe(true)
    expect(git(root, 'rev-parse', planBranch)).not.toBe(sibling)
    // Both pieces of work survive, and the sibling's commit is still an ancestor.
    const log = git(root, 'log', '--format=%s', planBranch)
    expect(log).toContain('a sibling landed first')
    expect(log).toContain('the piece did its work')
  })
})
