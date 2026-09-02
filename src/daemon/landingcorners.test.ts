import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * Landing, in the states the rest of the fleet actually leaves behind.
 *
 * ⛔ **The pipeline is a sequence of correct steps, and that is exactly how it produces false
 * sentences.** Every defect pinned here was reached with each individual check passing: a clean
 * workspace, so `canLand` allowed it; a branch level with the trunk, so "nothing to land" was true
 * of the commits; a rebase that was a no-op; a push that moved nothing. What none of them asked was
 * whether the *repository* agreed — and the repository is where preemption, cancellation and a
 * rescued workspace leave their evidence.
 *
 * The states are named by what produces them:
 *
 *  - **preemption** — a run stopped mid-turn. Its work is either committed onto the branch by
 *    `rescueDirt` (so the tip is a rescue) or, when HEAD was detached, in a stash taken off the
 *    branch. Both present as a clean tree on a branch with no commits.
 *  - **cancellation** — a task stopped before any finish ran, leaving a branch sitting at the base.
 *  - **an agent that landed its own work** — the branch is contained in `origin/<target>` while the
 *    local trunk is behind; this repo's own `/commit` skill makes that the normal outcome.
 *  - **a resume elsewhere** — the branch is the carrier, so landing must not care which slot drives
 *    it, and a branch another worktree still holds must not be deleted out from under it.
 *
 * ⚠️ **Landing is agent-agnostic, so there is no "Codex case" and no "Claude case" here.** `landTask`
 * never learns which CLI produced the branch; what differs between adapters is only the repository
 * state they leave, and each such state is a case below on its own terms. Measured 2026-09-01: t91
 * was lost by a `claude-code` run and recovered by an `openai-compatible` one, t92 was lost and
 * recovered by `claude-code` — the same defect either way.
 *
 * ⚠️ Real git in a temporary repository, like its siblings. Every case here is something git does
 * with a branch, a stash or a worktree, and a stub would agree with whatever the code believed.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let landing: typeof import('./landing.js')
let worktrees: typeof import('./worktrees.js')
let finish: typeof import('./finish.js')
let cancel: typeof import('./cancel.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

/** A project with a task and its branch checked out — the state a dispatch leaves. */
function seed(branch: string): { project: Project; taskId: string; root: string } {
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
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  const project = projects.addProject({ root })
  const task = tasks.createTask({
    title: `corner ${seq}`,
    projectId: project.id,
    createdBy: { kind: 'human' }
  })
  git(root, 'switch', '-c', branch)
  return { project, taskId: task.id, root }
}

/** Exactly what `rescueDirt` writes when it commits an interrupted run's work onto the branch. */
function rescueCommit(root: string, files: number): void {
  git(root, 'add', '-A')
  git(
    root,
    'commit',
    '--no-verify',
    '-m',
    `wip: ${files} file(s) an interrupted run left behind\n\nMulti-Agent-Controller-Rescue: ${files}`
  )
}

const land = async (project: Project, taskId: string, root: string, branch: string) =>
  landing.landTask({ project, task: tasks.requireTask(taskId), workspacePath: root, branch })

const said = (taskId: string): string =>
  tasks
    .messagesFor(taskId)
    .map((m) => m.text)
    .join('\n')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-corners-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  landing = await import('./landing.js')
  worktrees = await import('./worktrees.js')
  finish = await import('./finish.js')
  cancel = await import('./cancel.js')
  db.openDb(join(dir, 'corners.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows holds git pack files briefly; a leftover temp dir is not a failure.
  }
})

/**
 * A run that was stopped, not finished.
 *
 * ⛔ Both shapes present as *a clean workspace on a branch with no commits*, which is byte-for-byte
 * what a question-only task leaves behind. The difference is only ever visible somewhere the verdict
 * was not looking.
 */
describe('a task whose run was preempted', () => {
  it('does not call a stashed afternoon "nothing to land"', async () => {
    // ⛔ t91/t92, 2026-09-01. `rescueDirt` stashes when HEAD is detached; the branch is then level
    // with the trunk and the tree is clean, and the finish said "the trunk was not touched — work
    // that answers a question rather than changing a file is finished here". It was not finished.
    const branch = 'multi-agent-controller/t91-preempted'
    const { project, taskId, root } = seed(branch)
    writeFileSync(join(root, 'afternoon.txt'), 'the only copy\n')
    git(root, 'stash', 'push', '--include-untracked', '-m', 'rescued')

    const result = await land(project, taskId, root, branch)
    expect(result.ok).toBe(false)
    expect(result.nothingToLand).toBeUndefined()
    expect(result.reason).toContain('stash')
    expect(tasks.requireTask(taskId).status).toBe('awaiting_human')
    expect(said(taskId)).toContain('git stash apply')
  })

  it('keeps the branch when the work is in a stash, so the name still leads back to it', async () => {
    const branch = 'multi-agent-controller/t93-keep-the-branch'
    const { project, taskId, root } = seed(branch)
    writeFileSync(join(root, 'work.txt'), 'unfinished\n')
    git(root, 'stash', 'push', '--include-untracked', '-m', 'rescued')

    await land(project, taskId, root, branch)
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('is not blocked by a stash somebody else left in the same repository', async () => {
    // ⛔ Stashes are repository-wide — every pool member reports the same list — so counting them
    // globally would let one unrelated leftover hold every future task in the project at
    // `awaiting_human`. Git's own `On <branch>:` prefix ties an entry to the run that made it.
    const branch = 'multi-agent-controller/t94-innocent'
    const { project, taskId, root } = seed(branch)
    git(root, 'switch', '-c', 'multi-agent-controller/t95-somebody-else')
    writeFileSync(join(root, 'theirs.txt'), 'not mine\n')
    git(root, 'stash', 'push', '--include-untracked', '-m', 'theirs')
    git(root, 'switch', branch)

    const result = await land(project, taskId, root, branch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no work landed')
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
    // ⛔ And the reason is the empty-commit guard, NOT because of the other branch's stash
    expect(tasks.getTask(taskId)?.holdReason).toBe('no commits were produced on this branch')
  })

  it('refuses a tip that is only the rescue, however many times it was preempted', async () => {
    // ⚠️ Preemption can happen twice in one window. Two stacked rescues are still nothing finished,
    // and the tip check must not be fooled by there being real *history* below it.
    const branch = 'multi-agent-controller/t96-twice'
    const { project, taskId, root } = seed(branch)
    writeFileSync(join(root, 'first.txt'), 'attempt one\n')
    rescueCommit(root, 1)
    writeFileSync(join(root, 'second.txt'), 'attempt two\n')
    rescueCommit(root, 2)

    const result = await land(project, taskId, root, branch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('rescued')
  })

  it('lands once the resumed run finishes something on top', async () => {
    const branch = 'multi-agent-controller/t97-resumed'
    const { project, taskId, root } = seed(branch)
    writeFileSync(join(root, 'half.txt'), 'as far as it got\n')
    rescueCommit(root, 1)
    writeFileSync(join(root, 'half.txt'), 'and then finished\n')
    git(root, 'commit', '-am', 'finish it')

    const result = await land(project, taskId, root, branch)
    expect(result.reason ?? '').not.toContain('rescued')
  })

  it('still refuses a workspace that is simply dirty, which is a different failure', async () => {
    // ⚠️ Uncommitted work in the tree is not a stash and not a rescue: the slot is still being held
    // and the message has to say where the files are, not offer `git stash apply`.
    const branch = 'multi-agent-controller/t98-dirty'
    const { project, taskId, root } = seed(branch)
    writeFileSync(join(root, 'live.txt'), 'still being edited\n')

    const result = await land(project, taskId, root, branch)
    expect(result.ok).toBe(false)
    expect(said(taskId)).toContain('uncommitted')
    expect(said(taskId)).not.toContain('git stash apply')
  })

  it('leaves a task that asked to be verified alone, stash or no stash', async () => {
    // ⛔ `verification: required` skips the whole shortcut. "Nothing landed" is still an outcome its
    // author wanted to see, and so is "it was stashed" — neither gets decided for them here.
    const branch = 'multi-agent-controller/t99-verify'
    const { project, taskId, root } = seed(branch)
    tasks.updateTask(taskId, { verification: 'required' })
    writeFileSync(join(root, 'work.txt'), 'unfinished\n')
    git(root, 'stash', 'push', '--include-untracked', '-m', 'rescued')

    const result = await land(project, taskId, root, branch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('human verification')
  })
})

/**
 * The branch left behind, which nothing in the app could see.
 *
 * ⛔ Measured 2026-09-01: `t23` (finished 2026-08-29) and `t79` (cancelled 2026-08-31) were both
 * still in this repository, both carrying **zero** commits of their own. `retireBranch` swallows
 * every failure and returns `false`, nothing retried, and the loose-ends scan reads *workspaces* — so
 * a branch at rest, which is what every finished task leaves, was invisible to all of it.
 */
describe('task branches the repository still has a name for', () => {
  it('reports a branch whose every commit is already in the trunk', async () => {
    const branch = 'multi-agent-controller/t23-stranded'
    const { project, root } = seed(branch)
    git(root, 'switch', 'main')

    const found = (await worktrees.taskBranches(project, 'main')).find((b) => b.branch === branch)
    expect(found).toMatchObject({ ahead: 0, heldBy: null, taskSeq: 23 })
  })

  it('counts what a branch is carrying, so real work is never mistaken for a leftover', async () => {
    const branch = 'multi-agent-controller/t24-has-work'
    const { project, root } = seed(branch)
    writeFileSync(join(root, 'real.txt'), 'a real change\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'a real change')
    git(root, 'switch', 'main')

    const found = (await worktrees.taskBranches(project, 'main')).find((b) => b.branch === branch)
    expect(found?.ahead).toBe(1)
  })

  it('names the worktree holding a branch, which is why deleting it would fail', async () => {
    // ⚠️ The trunk is itself a worktree, and it is standing on this branch right now.
    const branch = 'multi-agent-controller/t25-held'
    const { project } = seed(branch)

    const found = (await worktrees.taskBranches(project, 'main')).find((b) => b.branch === branch)
    expect(found?.heldBy).not.toBeNull()
  })

  it('retires a branch that carries nothing', async () => {
    const branch = 'multi-agent-controller/t26-retire-me'
    const { project, root } = seed(branch)
    git(root, 'switch', 'main')

    expect(await worktrees.retireStrandedBranch(project, branch, 'main')).toEqual({ deleted: true })
    expect(git(root, 'branch', '--list', branch)).toBe('')
  })

  it('⛔ refuses a branch that gained a commit since the panel was scanned', async () => {
    // ⛔ The whole reason `retireStrandedBranch` re-derives its own licence. The operator's click
    // arrives minutes after the scan; between the two an agent can push to that branch or a resumed
    // run can commit on it, and deleting it on the strength of a stale row destroys that commit.
    const branch = 'multi-agent-controller/t27-moved-under-us'
    const { project, root } = seed(branch)
    git(root, 'switch', 'main')
    const before = (await worktrees.taskBranches(project, 'main')).find((b) => b.branch === branch)
    expect(before?.ahead).toBe(0)

    git(root, 'switch', branch)
    writeFileSync(join(root, 'late.txt'), 'arrived after the scan\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'a late commit')
    git(root, 'switch', 'main')

    const verdict = await worktrees.retireStrandedBranch(project, branch, 'main')
    expect(verdict.deleted).toBe(false)
    expect(verdict.reason).toContain('1 commit')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('refuses a branch a worktree is standing on, and says which one', async () => {
    const branch = 'multi-agent-controller/t28-checked-out'
    const { project, root } = seed(branch)

    const verdict = await worktrees.retireStrandedBranch(project, branch, 'main')
    expect(verdict.deleted).toBe(false)
    expect(verdict.reason).toContain('checked out in')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('says so plainly when asked about a branch that is not there', async () => {
    const { project } = seed('multi-agent-controller/t29-present')
    const verdict = await worktrees.retireStrandedBranch(
      project,
      'multi-agent-controller/t30-never-existed',
      'main'
    )
    expect(verdict.deleted).toBe(false)
    expect(verdict.reason).toContain('no branch')
  })

  it('reports a branch whose name no longer parses to a task, rather than hiding it', async () => {
    // ⚠️ `taskSeq: null` is not a reason to hide it. A branch nobody can trace back to a task is
    // *more* interesting than one that can be traced, not less.
    const branch = 'multi-agent-controller/hand-made-branch'
    const { project, root } = seed(branch)
    git(root, 'switch', 'main')

    const found = (await worktrees.taskBranches(project, 'main')).find((b) => b.branch === branch)
    expect(found).toMatchObject({ taskSeq: null, ahead: 0 })
  })

  // ⚠️ A minute, and it needs it. `scanLooseEnds` is deliberately whole-fleet: it builds the pool of
  // **every** project it can see and stats every member, so in this file it walks all of the
  // repositories seeded above. Under the default 5s it passed alone and timed out in the full run,
  // which is the worst shape a test can have — so the budget is stated rather than discovered.
  it(
    'surfaces it in the loose-ends scan, which is where an operator would ever see it',
    async () => {
      const branch = 'multi-agent-controller/t31-in-the-panel'
      const { project, root } = seed(branch)
      git(root, 'switch', 'main')

      const ends = (await finish.scanLooseEnds()).filter((e) => e.projectId === project.id)
      const stranded = ends.find((e) => e.branch === branch)
      expect(stranded?.kind).toBe('stranded')
      expect(stranded?.taskSeq).toBe(31)
      expect(stranded?.summary).toContain('only the name is left')
    },
    60_000
  )
})

/**
 * Cancelling is not finishing, and until 2026-09-01 that meant it tidied nothing at all.
 *
 * ⛔ Branch retirement lives only on the **finish** path — `landTask`, and `decideFinish`'s
 * nothing-to-land verdict. A cancel goes nowhere near either, so the branch created at dispatch was
 * orphaned by design. t79 was cancelled on 2026-08-31 after asking two questions and writing nothing;
 * its branch was still sitting at the base commit a day later, invisible to everything.
 *
 * ⚠️ The rule at the top of `cancel.ts` still holds: cancel destroys nothing. What is given back here
 * is a *name* on a branch carrying no commit the trunk does not already have.
 */
describe('the branch a cancelled task leaves', () => {
  const cancelWith = async (taskId: string, branch: string, resting: 'cancelled' | 'paused_user') => {
    tasks.setStatus(taskId, 'ready', { branch })
    await cancel.cancelTask(taskId, { restingState: resting, requestedBy: 'human' })
  }

  it('gives back the name when the task is cancelled outright and wrote nothing', async () => {
    const branch = 'multi-agent-controller/t79-asked-and-stopped'
    const { taskId, root } = seed(branch)
    git(root, 'switch', 'main')

    await cancelWith(taskId, branch, 'cancelled')
    expect(git(root, 'branch', '--list', branch)).toBe('')
  })

  it('⛔ keeps a branch that has a commit on it, however the task ended', async () => {
    // ⛔ The promise at the top of `cancel.ts`. A cancelled task's work is still its work, and the
    // operator cancelled the run, not the commit.
    const branch = 'multi-agent-controller/t80-wrote-something'
    const { taskId, root } = seed(branch)
    writeFileSync(join(root, 'done.txt'), 'it got this far\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'partial work')
    git(root, 'switch', 'main')

    await cancelWith(taskId, branch, 'cancelled')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('keeps the branch of a task paused by a person, which is expected to resume into it', async () => {
    // ⛔ `paused_user` means *not like this, for now*. `resumeTask` documents keeping the branch, and
    // an empty one is the normal state of a task paused before its agent committed anything.
    const branch = 'multi-agent-controller/t81-paused-not-cancelled'
    const { taskId, root } = seed(branch)
    git(root, 'switch', 'main')

    await cancelWith(taskId, branch, 'paused_user')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('leaves a branch a worktree is still standing on, and says so rather than failing', async () => {
    // ⚠️ The common shape for a task cancelled *while running*: the workspace is parked when the
    // session exits, which has not happened yet. The cancel must not fail over it — the branch shows
    // up as a `stranded` loose end instead.
    const branch = 'multi-agent-controller/t82-still-checked-out'
    const { taskId, root } = seed(branch)

    await cancelWith(taskId, branch, 'cancelled')
    expect(tasks.requireTask(taskId).status).toBe('cancelled')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })
})
