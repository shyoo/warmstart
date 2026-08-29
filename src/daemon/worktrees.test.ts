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

/**
 * Lending a resident conversation's worktree to another task.
 *
 * ⛔ Phase 2 of resident sessions. A session now keeps its worktree for as long as it lives, so the
 * next task to borrow the conversation needs the tree moved to *its* branch and put back afterwards.
 * The move is the dangerous half: the agent's context is full of file contents read from the branch
 * being left, and nothing about that context says they are stale.
 *
 * ⚠️ Real git again, for the same reason the tests above use it: every interesting case here is
 * something git does or refuses to do with a working tree, and a stub would agree with whatever the
 * implementation happened to believe.
 */
describe('moving a borrowed worktree to another branch', () => {
  it('switches a clean tree and reports where it came from', async () => {
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    const first = worktrees.branchNameFor(1, 'first task')
    await worktrees.prepareWorkspace(project, ws!, first)

    const second = worktrees.branchNameFor(2, 'second task')
    const moved = await worktrees.switchResidentBranch(project, ws!.path, second)

    expect(moved.error).toBeUndefined()
    expect(moved.ok).toBe(true)
    // ⛔ `from` is what the restore will be asked for later. Getting it wrong sends the borrowed
    // conversation back to the wrong branch, and the failure lands on a task that did nothing wrong.
    expect(moved.from).toBe(first)
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(second)
    worktrees.releaseWorkspace(ws!.claimId)
  })

  it('goes back, because a restore is the same move in the other direction', async () => {
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    const mine = worktrees.branchNameFor(1, 'first task')
    await worktrees.prepareWorkspace(project, ws!, mine)
    writeFileSync(join(ws!.path, 'mine.txt'), 'work committed on my branch\n')
    git(ws!.path, 'add', '-A')
    git(ws!.path, 'commit', '-m', 'my work')

    const borrower = worktrees.branchNameFor(2, 'second task')
    await worktrees.switchResidentBranch(project, ws!.path, borrower)
    const back = await worktrees.switchResidentBranch(project, ws!.path, mine)

    expect(back.ok).toBe(true)
    expect(back.from).toBe(borrower)
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(mine)
    // ⭐ The whole promise made to the task that was parked: its branch is untouched.
    expect(text(join(ws!.path, 'mine.txt'))).toBe('work committed on my branch\n')
    worktrees.releaseWorkspace(ws!.claimId)
  })

  it('refuses a tree holding uncommitted work, and names the files', async () => {
    // ⛔ The rule, not a safety margin. Stashing to make room would take work that is currently
    // *visible* as a loose end and hide it in a stash the next reader has to know to look for -
    // which is the t5 failure with extra steps. A dirty tree keeps its task.
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    const mine = worktrees.branchNameFor(1, 'first task')
    await worktrees.prepareWorkspace(project, ws!, mine)
    writeFileSync(join(ws!.path, 'kept.txt'), 'half-finished, not committed\n')

    const moved = await worktrees.switchResidentBranch(
      project,
      ws!.path,
      worktrees.branchNameFor(2, 'second task')
    )

    expect(moved.ok).toBe(false)
    expect(moved.error).toContain('kept.txt')
    // ⛔ And it really did not move. A refusal that had already switched would be worse than no
    // refusal at all.
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(mine)
    expect(text(join(ws!.path, 'kept.txt'))).toBe('half-finished, not committed\n')
    worktrees.releaseWorkspace(ws!.claimId)
  })

  it('reports a modified file by its whole name, not missing its first letter', async () => {
    // ⛔ A real bug this suite found on the way past, and it had nothing to do with switching.
    // `--porcelain` writes a two-column status field, so a file modified but not staged begins the
    // line with a space (` M kept.txt`) — and `git()` trims its output, so `slice(3)` ate the first
    // character of every modified file's name. `kept.txt` was reported as `ept.txt`, everywhere
    // `workspaceState` is read: the loose-ends list, the refusal to land, and this refusal.
    //
    // ⚠️ Untracked files start with `??` and were never affected, which is exactly why it survived —
    // the loose-ends scan that found the t5 stash had no modified file in it to get wrong.
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    await worktrees.prepareWorkspace(project, ws!, worktrees.branchNameFor(1, 'first task'))
    writeFileSync(join(ws!.path, 'kept.txt'), 'edited, not staged\n')

    const state = await worktrees.workspaceState(ws!.path, 'main')
    expect(state.dirtyFiles).toEqual(['kept.txt'])
    expect(state.untrackedFiles).toEqual([])
    worktrees.releaseWorkspace(ws!.claimId)
  })

  it('refuses for a file git has never seen, not only for an edited one', async () => {
    // ⚠️ The half that `git status` reports differently and that `git add -u` would have dropped.
    // A new file is the most likely thing an agent leaves behind and the easiest to lose.
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    await worktrees.prepareWorkspace(project, ws!, worktrees.branchNameFor(1, 'first task'))
    writeFileSync(join(ws!.path, 'brand-new.txt'), 'never added\n')

    const moved = await worktrees.switchResidentBranch(
      project,
      ws!.path,
      worktrees.branchNameFor(2, 'second task')
    )
    expect(moved.ok).toBe(false)
    expect(moved.error).toContain('brand-new.txt')
    worktrees.releaseWorkspace(ws!.claimId)
  })

  it('does nothing at all when the tree is already on that branch', async () => {
    // ⚠️ Including when it is dirty. This is the common case - a task continuing its own work -
    // and refusing it because the agent has uncommitted edits would break every continuation.
    const project = makeProject()
    const ws = await worktrees.claimWorkspace(project, 'session-1')
    const mine = worktrees.branchNameFor(1, 'first task')
    await worktrees.prepareWorkspace(project, ws!, mine)
    writeFileSync(join(ws!.path, 'kept.txt'), 'still working on it\n')

    const moved = await worktrees.switchResidentBranch(project, ws!.path, mine)
    expect(moved.ok).toBe(true)
    expect(moved.from).toBe(mine)
    expect(text(join(ws!.path, 'kept.txt'))).toBe('still working on it\n')
    worktrees.releaseWorkspace(ws!.claimId)
  })
})

// ------------------------------------------------------------- reading the trunk itself

/**
 * The two readings the trunk tripwire compares.
 *
 * ⛔ Taken in the **trunk**, which is the whole point: the failure being watched for is work landing
 * somewhere no agent was given, and a pooled worktree cannot observe its own absence.
 *
 * ⚠️ Every failure here must be `null` rather than a throw or a guess. A finish path that raised
 * because a branch did not resolve would turn a diagnostic into an outage, and one that returned a
 * stale or invented sha would fire the tripwire on innocent runs until somebody switched it off.
 */
describe('reading where the trunk stands', () => {
  it('returns the target branch head', async () => {
    const project = makeProject()
    const sha = await worktrees.trunkTargetSha(project, 'main')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('says nothing for a branch that does not exist', async () => {
    // ⚠️ A project whose landing target has not been created yet is a real state, and it is not
    // evidence of anything. Null, so the comparison declines.
    const project = makeProject()
    expect(await worktrees.trunkTargetSha(project, 'no-such-branch')).toBeNull()
  })

  it('says nothing for a project that is not under git', async () => {
    const project = { ...makeProject(), vcs: 'none' } as Project
    expect(await worktrees.trunkTargetSha(project, 'main')).toBeNull()
  })

  it('moves when the trunk gains a commit, which is the signal itself', async () => {
    const project = makeProject()
    const before = await worktrees.trunkTargetSha(project, 'main')
    writeFileSync(join(project.root, 'straight-to-trunk.txt'), 'as t17 did\n')
    git(project.root, 'add', '-A')
    git(project.root, 'commit', '-m', 'a commit no branch ever saw')
    const after = await worktrees.trunkTargetSha(project, 'main')
    expect(after).not.toBe(before)

    // ⭐ And the operator is told *what* appeared, because "the trunk moved" is not actionable on
    // its own — the first question anybody asks is which commits.
    const commits = await worktrees.trunkCommitsSince(project, before!, after!)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toContain('a commit no branch ever saw')
  })

  it('reads the branch, not a tag that happens to share its name', async () => {
    // ⭐ `git rev-parse main` is ambiguous when a tag `main` also exists, and git resolves the tag.
    // A tag does not move, so the tripwire would compare the branch's old position against a
    // constant and never fire again — silently, on the one project unlucky enough to name a tag
    // after its trunk. `--verify refs/heads/<target>` is what makes the read unambiguous.
    const project = makeProject()
    const first = await worktrees.trunkTargetSha(project, 'main')
    git(project.root, 'tag', 'main')
    writeFileSync(join(project.root, 'after-the-tag.txt'), 'moved on\n')
    git(project.root, 'add', '-A')
    git(project.root, 'commit', '-m', 'the branch moved past the tag')

    const now = await worktrees.trunkTargetSha(project, 'main')
    expect(now).not.toBe(first)
    expect(now).toBe(git(project.root, 'rev-parse', 'refs/heads/main'))
  })

  it('lists nothing between a commit and itself', async () => {
    const project = makeProject()
    const sha = await worktrees.trunkTargetSha(project, 'main')
    expect(await worktrees.trunkCommitsSince(project, sha!, sha!)).toEqual([])
  })

  it('answers with an empty list rather than throwing on a range git cannot resolve', async () => {
    // ⛔ This runs inside the finish path. A bad range must not take a completing task down with it.
    const project = makeProject()
    expect(await worktrees.trunkCommitsSince(project, 'deadbeef', 'cafebabe')).toEqual([])
  })
})
