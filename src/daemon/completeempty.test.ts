import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * **Complete** on a task the empty commit guard held (t734).
 *
 * ⭐ The operator's decision on t734: keep the guard — an agent that made no commits waits for a
 * person — but let that person accept it in one press, and have that press delete the branch that
 * holds nothing so a later reply starts on a fresh one. ⛔ A branch with work on it is never touched.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let worktrees: typeof import('./worktrees.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

function heldTask(): { taskId: string; root: string; branch: string } {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({ schema_version: 1, name: `p${seq}`, vcs: 'git', check: [], landing: { target: 'main' } })
  )
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  const project = projects.addProject({ root })
  const task = tasks.createTask({ title: `answer ${seq}`, projectId: project.id, createdBy: { kind: 'human' } })
  const branch = `warmstart/t${task.seq}-answer`
  git(root, 'branch', branch)
  tasks.setTaskBranch(task.id, branch, 1)
  tasks.setStatus(task.id, 'awaiting_human', {
    assignee: 'human',
    holdReason: 'the agent made no commits — Complete accepts that, or reply to continue'
  })
  return { taskId: task.id, root, branch }
}

const branchExists = (root: string, branch: string): boolean => {
  try {
    git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-completeempty-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  worktrees = await import('./worktrees.js')
  db.openDb(join(dir, 'completeempty.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('Complete on a task whose agent made no commits', () => {
  it('completes it and deletes the empty branch, and says so', async () => {
    const { taskId, root, branch } = heldTask()
    const done = await scheduler.resolveTask(taskId)
    expect(done.status).toBe('completed')
    expect(branchExists(root, branch)).toBe(false)
    const line = tasks.messagesFor(taskId).find((m) => m.text.startsWith('Deleted the empty branch'))
    expect(line?.text).toBe(`Deleted the empty branch \`${branch}\``)
    expect(line?.detail).toContain('Replying to this task starts a fresh branch')
  })

  it('keeps a branch the agent did commit to', async () => {
    const { taskId, root, branch } = heldTask()
    git(root, 'switch', branch)
    writeFileSync(join(root, 'work.txt'), 'work\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'real work')
    git(root, 'switch', 'main')
    const done = await scheduler.resolveTask(taskId)
    expect(done.status).toBe('completed')
    expect(branchExists(root, branch)).toBe(true)
    expect(tasks.messagesFor(taskId).some((m) => m.text.startsWith('Deleted the empty branch'))).toBe(false)
  })
})

/**
 * ⛔ Complete races the session's own exit for the workspace (t977). Both release the same session;
 * the first to arrive starts the park, and the second used to return at once — so Complete's
 * `retireEmptyBranch` ran against a slot still standing on the branch and kept t976's empty branch.
 */
describe('two callers releasing the same conversation’s workspace', () => {
  it('the second waits for the first park rather than returning while the slot holds the branch', async () => {
    const { taskId, branch } = heldTask()
    const project = projects.getProject(tasks.requireTask(taskId).projectId!)!
    const workspace = await worktrees.claimWorkspace(project, 'session-t977')
    expect(workspace).not.toBeNull()
    git(workspace!.path, 'switch', branch)
    scheduler.workspaces.set('session-t977', { workspace: workspace!, projectId: project.id })

    const first = scheduler.releaseWorkspaceOf('session-t977')
    await scheduler.releaseWorkspaceOf('session-t977')
    expect(git(workspace!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    await first
  })
})
