import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * A pool member that did not arrive clean.
 *
 * ⛔ Measured 2026-08-27. Task t4 never started: `git switch -c multi-agent-controller/t4-… origin/main`
 * failed with *"Your local changes to the following files would be overwritten by checkout"*, naming
 * three files the task had never touched. The scheduler had done everything right — the branch was
 * named after the task, it was created inside a claimed worktree, the trunk was never switched. What
 * nobody had noticed is that **`switch --detach` carries uncommitted changes with it**, so parking a
 * workspace frees its *branch* and leaves its *edits*. ws1 had been sitting on an earlier task's
 * uncommitted work for a day, and every task that happened to claim ws1 was going to die on it.
 *
 * ⚠️ Real git, in a temporary repository. The whole defect is in what git does with a dirty tree, so
 * a test that stubbed git would have passed against the broken version.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let worktrees: typeof import('./worktrees.js')

/** ⚠️ core.autocrlf rewrites what git checks out on Windows; the bytes are not the point here. */
const text = (path: string): string => readFileSync(path, 'utf8').split('\r\n').join('\n')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

/** A one-slot pool, so the test claims the same workspace it dirtied. */
function makeProject(): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(root, '.multi_agent_controller', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name: `repo${seq}`,
      vcs: 'git',
      check: [],
      workspaces: { poolSize: 1 },
      landing: { strategy: 'auto-land', target: 'main' }
    })
  )
  writeFileSync(join(root, 'kept.txt'), 'as committed\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return projects.addProject({ root })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-worktrees-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  worktrees = await import('./worktrees.js')
  db.openDb(join(dir, 'worktrees.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('claiming a workspace somebody left dirty', () => {
  it('still puts the task on its own branch', async () => {
    const project = makeProject()
    const first = await worktrees.claimWorkspace(project, 'run-1')
    expect(first).not.toBeNull()

    // Exactly the state ws1 was in: a tracked file edited, and never committed.
    writeFileSync(join(first!.path, 'kept.txt'), 'what the last run was in the middle of\n')
    worktrees.releaseWorkspace(first!.claimId)

    // ⛔ And the base has moved since. This half is what makes the test reproduce: git only refuses
    // a switch that would *overwrite* the dirty file, so a workspace whose base still matches its
    // working tree switches happily with the dirt in tow. ws1 was a day behind origin/main and had
    // edited three of the files that had changed in between — that is the whole failure.
    writeFileSync(join(project.root, 'kept.txt'), 'and the trunk moved on since\n')
    git(project.root, 'commit', '-am', 'the base moves under a parked workspace')

    const second = await worktrees.claimWorkspace(project, 'run-2')
    const branch = worktrees.branchNameFor(4, 'refine the workers table')
    const result = await worktrees.prepareWorkspace(project, second!, branch)

    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(git(second!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
    worktrees.releaseWorkspace(second!.claimId)
  })

  it('keeps the work it moved out of the way, rather than resetting over it', async () => {
    // ⛔ The point of the whole fix. A dirty slot usually means the last run *failed*, which is
    // exactly when its half-finished edits are worth the most — so they are recoverable, by name.
    const project = makeProject()
    const first = await worktrees.claimWorkspace(project, 'run-1')
    writeFileSync(join(first!.path, 'kept.txt'), 'the only copy of this sentence\n')
    writeFileSync(join(first!.path, 'brand-new.txt'), 'and an untracked file too\n')
    worktrees.releaseWorkspace(first!.claimId)

    const second = await worktrees.claimWorkspace(project, 'run-2')
    await worktrees.prepareWorkspace(project, second!, worktrees.branchNameFor(9, 'later task'))

    const stashes = git(second!.path, 'stash', 'list')
    expect(stashes).toMatch(/multi-agent-controller: 2 file\(s\)/)

    // The branch starts from the committed content, not from what was rescued...
    expect(text(join(second!.path, 'kept.txt'))).toBe('as committed\n')
    // ...and both files come back, the untracked one included.
    git(second!.path, 'stash', 'pop')
    expect(text(join(second!.path, 'kept.txt'))).toBe('the only copy of this sentence\n')
    expect(text(join(second!.path, 'brand-new.txt'))).toBe('and an untracked file too\n')
    worktrees.releaseWorkspace(second!.claimId)
  })

  it('stashes nothing when there was nothing to stash', async () => {
    // ⚠️ Otherwise every claim would leave a stash behind, and `git stash list` — the one place a
    // person goes to find rescued work — would fill with empty entries until it was useless.
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'run-1')
    await worktrees.prepareWorkspace(project, ws!, worktrees.branchNameFor(1, 'a clean start'))
    expect(git(ws!.path, 'stash', 'list')).toBe('')
    worktrees.releaseWorkspace(ws!.claimId)
  })
})
