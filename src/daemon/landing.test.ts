import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FinishPolicy, LandingResult, Project } from '@shared/tasks.js'
import { messageBody } from './threadline.js'

/**
 * Landing a task that changed nothing.
 *
 * ⛔ Measured on this machine 2026-08-27. A question-only task — *"how long does the quota take to
 * show up?"* — was answered, wrote no file, and was reported as **"Landed as a166a6a onto main"**.
 * Every individual step had succeeded: the workspace was clean, so `canLand` allowed it; the rebase
 * onto `origin/main` was a no-op; the project checks passed; the push moved nothing; and
 * `rev-parse HEAD` returned the commit that was already there. A pipeline of correct steps produced
 * a sentence that was false in the way that matters most — it tells somebody their change reached the
 * trunk.
 *
 * ⚠️ Uses real git, in a temporary repository. The whole defect lived in what `git` was asked, so a
 * test that stubbed it would have passed against the broken version.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let landing: typeof import('./landing.js')
let commits: typeof import('./taskcommits.js')
let resources: typeof import('./resources.js')
let deliveries: typeof import('./deliveries.js')
let events: typeof import('./events.js')
/** `landing.landQueue` and its shipped values, bound after the dynamic import. */
let landingQueue: { waitMs: number; pollMs: number }
let queueDefaults: { waitMs: number; pollMs: number }

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function makeRepo(name: string): string {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      vcs: 'git',
      check: [],
      landing: { strategy: 'auto-land', target: 'main' }
    })
  )
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return root
}

let seq = 0

/** A project, a task, and a branch off main — the state a run leaves behind. */
function seedTask(branch: string): { project: Project; taskId: string; root: string } {
  seq += 1
  const root = makeRepo(`repo${seq}`)
  const project = projects.addProject({ root })
  const task = tasks.createTask({
    title: `landing ${seq}`,
    projectId: project.id,
    createdBy: { kind: 'human' }
  })
  git(root, 'switch', '-c', branch)
  return { project, taskId: task.id, root }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-landing-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  landing = await import('./landing.js')
  commits = await import('./taskcommits.js')
  resources = await import('./resources.js')
  deliveries = await import('./deliveries.js')
  events = await import('./events.js')
  landingQueue = landing.landQueue
  queueDefaults = { ...landingQueue }
  db.openDb(join(dir, 'landing.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows holds git pack files briefly; a leftover temp dir is harmless.
  }
})

/**
 * The levels that never touch a remote.
 *
 * ⛔ The default pushed the trunk until 2026-08-30, and every push to `main` started a ten-job CI
 * matrix — 103 runs in five days on this install, and an exhausted allowance. `commit-and-merge`
 * does everything `commit-and-push` does except the push.
 */
describe('landing without a remote', () => {
  /** A trunk on `main` plus a worktree holding a branch with one real commit. */
  function seedLocal(branch: string): { project: Project; taskId: string; root: string; ws: string } {
    seq += 1
    const root = makeRepo(`local${seq}`)
    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: `local ${seq}`,
      projectId: project.id,
      createdBy: { kind: 'human' }
    })
    const ws = join(dir, `local${seq}-ws`)
    git(root, 'worktree', 'add', '-b', branch, ws, 'main')
    writeFileSync(join(ws, 'work.txt'), 'agent work\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-m', 'the agent did the work')
    return { project, taskId: task.id, root, ws }
  }

  const land = async (
    project: Project,
    taskId: string,
    ws: string,
    branch: string,
    policy: FinishPolicy
  ) =>
    landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: ws,
      branch,
      policy
    })

  it('merges into a clean trunk and never reaches for a remote', async () => {
    const branch = 'warmstart/t80-local'
    const { project, taskId, root, ws } = seedLocal(branch)
    const before = git(root, 'rev-parse', 'main')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('merge-local')
    expect(git(root, 'rev-parse', 'main')).not.toBe(before)
    // ⛔ The whole point: the work moved and nothing was pushed.
    expect(result.reason).toContain('Not pushed')
    // The branch is retired once the trunk provably contains it.
    expect(git(root, 'branch', '--list', branch)).toBe('')
  }, 20_000)

  /**
   * ⛔ **What the operator is told, against what actually happened.** The message used to be
   * *"Landed as a166a6a onto main."* and nothing else: four things the landing had just done — it
   * checked, it fast-forwarded, it did not push, it deleted a branch it had proved was empty — were
   * known at the moment they were worth saying and thrown away. These assert the facts reach the
   * result, so the sentence cannot go back to being a claim nobody can check.
   */
  it('carries what it verified, whether it pushed, and what became of the branch', async () => {
    const branch = 'warmstart/t81-told'
    const { project, taskId, root, ws } = seedLocal(branch)
    // ⚠️ Two commands, so `checksPassed` is a count that could be wrong rather than a boolean that
    // could not. Both are read-only git invocations that exit 0 on every platform this runs on.
    const checked = projects.setProjectChecks(project.id, [
      'git --version',
      'git status --porcelain'
    ])
    // ⛔ Committed, not left in the working tree: `setProjectChecks` writes `project.json` into the
    // trunk, and `merge-local` refuses to merge into a trunk with uncommitted files in it — which
    // is the correct behaviour and would make this a test of the fixture instead of the message.
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'declare the project checks')

    const result = await land(checked, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok, result.reason).toBe(true)
    expect(result.checksPassed).toBe(2)
    expect(result.pushed).toBe(false)
    expect(result.branchDeleted).toBe(true)

    const said = tasks.messagesFor(taskId).map(messageBody).join('\n')
    expect(said).toContain('Landed as')
    expect(said).toContain('2 project checks passed')
    expect(said).toContain('not pushed')
    expect(said).toContain('deleted')
  }, 30_000)

  it('runs project checks with spawnEnv augmented PATH even when host PATH is minimal', async () => {
    if (process.platform === 'win32') return
    seq += 1
    const root = makeRepo(`checkpath${seq}`)
    const project = projects.addProject({ root })
    const taskId = tasks.createTask({
      title: `checkpath task ${seq}`,
      projectId: project.id
    }).id
    const branch = `warmstart/t${seq}-checkpath`
    const ws = join(dir, `checkpath${seq}-ws`)
    git(root, 'worktree', 'add', '-b', branch, ws, 'main')
    writeFileSync(join(ws, 'work.txt'), 'content')
    git(ws, 'add', 'work.txt')
    git(ws, 'commit', '-m', 'add work')

    const checked = projects.setProjectChecks(project.id, [
      'node -e "if (!process.env.PATH) process.exit(1)"'
    ])
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'declare check')

    const origPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      const result = await land(checked, taskId, ws, branch, 'commit-and-merge')
      expect(result.ok, result.reason).toBe(true)
      expect(result.checksPassed).toBe(1)
    } finally {
      process.env.PATH = origPath
    }
  }, 30_000)

  it('merges split work into the planner branch and leaves main untouched', async () => {
    seq += 1
    const root = makeRepo(`local${seq}`)
    const project = projects.addProject({ root })
    const plannerTask = tasks.createTask({
      title: `planner ${seq}`,
      projectId: project.id,
      kind: 'plan'
    })
    const plannerBranch = tasks.plannerBranchFor(project, plannerTask)!
    git(root, 'branch', plannerBranch, 'main')
    const mainBefore = git(root, 'rev-parse', 'main')

    const childBranch = `warmstart/t${seq + 100}-child`
    const childTask = tasks.createTask({
      title: `child ${seq}`,
      projectId: project.id,
      parentTaskId: plannerTask.id
    })
    const ws = join(dir, `local${seq}-ws`)
    git(root, 'worktree', 'add', '-b', childBranch, ws, plannerBranch)
    writeFileSync(join(ws, 'piece.txt'), 'piece work\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-m', 'the piece did the work')

    const result = await land(project, childTask.id, ws, childBranch, 'commit-and-merge')

    expect(result.ok, result.reason).toBe(true)
    expect(result.strategy).toBe('merge-branch')
    // Main was NOT moved
    expect(git(root, 'rev-parse', 'main')).toBe(mainBefore)
    // Planner branch WAS moved to include the child commit
    expect(git(root, 'log', '-1', '--oneline', plannerBranch)).toContain('the piece did the work')
    // Child branch was retired
    expect(git(root, 'branch', '--list', childBranch)).toBe('')
  }, 20_000)

  /**
   * ⛔ **This has to happen at the landing or it never can.** `retireBranch` deletes the branch two
   * lines after the merge, and from then on the task's commits are in the trunk's history with
   * nothing identifying which ones they are. There is no backfill — `runs.trunk_sha_before` is read
   * at dispatch, before the rebase, so it is not a parent of what landed.
   */
  it('records the commit range it landed, and both ends still resolve after the branch is gone', async () => {
    const branch = 'warmstart/t86-range'
    const { project, taskId, root, ws } = seedLocal(branch)
    const base = git(root, 'rev-parse', 'main')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')
    expect(result.ok).toBe(true)

    const landed = tasks.requireTask(taskId)
    expect(landed.landedBaseSha).toBe(base)
    expect(landed.landedHeadSha).toBe(result.commit)
    // ⛔ The branch is gone, and the range still answers — which is the only reason to record it.
    expect(git(root, 'branch', '--list', branch)).toBe('')
    expect(git(root, 'rev-parse', `${landed.landedBaseSha}^{commit}`)).toBe(base)
    expect(
      git(root, 'diff', '--name-only', `${landed.landedBaseSha}..${landed.landedHeadSha}`)
    ).toContain('work.txt')
  })

  it('records nothing when the landing did not land, so no range points at unlanded work', async () => {
    const branch = 'warmstart/t87-norange'
    const { project, taskId, ws } = seedLocal(branch)
    // A trunk on another branch: the merge refuses and the work stays put.
    git(join(dir, `local${seq}`), 'switch', '-c', 'operators-own-branch')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')
    expect(result.ok).toBe(false)
    const after = tasks.requireTask(taskId)
    expect(after.landedBaseSha).toBeNull()
    expect(after.landedHeadSha).toBeNull()
  })

  it('⛔ refuses to merge into a trunk somebody is working in, and keeps the branch', async () => {
    const branch = 'warmstart/t81-busy'
    const { project, taskId, root, ws } = seedLocal(branch)
    // The operator, mid-edit. This is the ordinary state of the trunk on a working day.
    writeFileSync(join(root, 'README.md'), '# fixture\nhalf-written local change\n')
    const before = git(root, 'rev-parse', 'main')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('uncommitted file')
    // ⛔ Nothing was stashed, reset or merged. The operator's work is untouched and so is the branch.
    expect(git(root, 'rev-parse', 'main')).toBe(before)
    expect(git(root, 'status', '--porcelain')).toContain('README.md')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
    // And the agent's commit is still on it, which is what makes this recoverable.
    expect(git(ws, 'log', '--oneline', '-1')).toContain('the agent did the work')
  // This creates a real repository and worktree. Windows can spend more than Vitest's default 5s
  // on its filesystem bookkeeping without the safety check or its result being stalled.
  }, 20_000)

  /**
   * ⛔ **t259: a dirty trunk was discovered only after the rebase and the project checks had run.**
   * The landing failed late with a bare count, after spending both. The trunk is now checked in
   * `canLand` — before anything runs — and the reason names the files, split into tracked and
   * untracked, instead of a number. Uses real git: the defect lived in what was asked, and when.
   */
  it('refuses before running anything when the trunk has untracked files, and names them', async () => {
    const branch = 'warmstart/t88-untracked'
    const { project, taskId, root, ws } = seedLocal(branch)
    // The operator, mid-scribble: one modified file and one untracked one.
    writeFileSync(join(root, 'README.md'), '# fixture\nhalf-written local change\n')
    writeFileSync(join(root, 'scratch-note.txt'), 'operator scribble\n')
    const before = git(root, 'rev-parse', 'main')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('scratch-note.txt')
    expect(result.reason).toContain('README.md')
    expect(result.reason).toContain('untracked')
    // ⛔ Nothing was stashed, reset or merged. The operator's work is untouched and so is the branch.
    expect(git(root, 'rev-parse', 'main')).toBe(before)
    expect(git(root, 'status', '--porcelain')).toContain('scratch-note.txt')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
    // And the agent's commit is still on it, which is what makes this recoverable.
    expect(git(ws, 'log', '--oneline', '-1')).toContain('the agent did the work')
  }, 20_000)

  it('fails on the trunk before the project checks, not on the checks', async () => {
    const branch = 'warmstart/t89-checks-skipped'
    const { project, taskId, root, ws } = seedLocal(branch)
    // A check that would fail if it ever ran, plus a trunk that must stop the landing first.
    // ⚠️ `setProjectChecks` writes `project.json` into the trunk uncommitted, which is itself
    // part of the blockage — the assertion is that the failure names the trunk, not the check.
    const checked = projects.setProjectChecks(project.id, ['git nope-this-is-not-a-command'])
    writeFileSync(join(root, 'scratch-note.txt'), 'operator scribble\n')

    const result = await land(checked, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('trunk')
    expect(result.reason).toContain('scratch-note.txt')
    expect(result.reason).not.toContain('checks failed')
  }, 20_000)

  it('re-checks the trunk inside the landing itself, for dirt that arrived after canLand', async () => {
    const branch = 'warmstart/t90-late-dirt'
    const { project, taskId, root, ws } = seedLocal(branch)
    writeFileSync(join(root, 'late-scribble.txt'), 'arrived after the preflight\n')

    // ⚠️ Straight at the strategy, past `canLand`: this is the re-check before the rebase.
    const result = await landing.mergeLocal.land({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: ws,
      branch,
      policy: 'commit-and-merge'
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('late-scribble.txt')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  }, 20_000)

  it('says which branch is in the way when the trunk is on another one', async () => {
    const branch = 'warmstart/t82-elsewhere'
    const { project, taskId, root, ws } = seedLocal(branch)
    git(root, 'switch', '-c', 'operators-own-branch')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('operators-own-branch')
  })

  it('verifies without merging, and says so when there is nothing to verify with', async () => {
    const branch = 'warmstart/t83-verify'
    const { project, taskId, root, ws } = seedLocal(branch)
    const before = git(root, 'rev-parse', 'main')

    const result = await land(project, taskId, ws, branch, 'commit-and-verify')

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('verify-only')
    // ⛔ The fixture declares no `check` commands, and an empty list must never read as a clean
    // verification — that is the first day of every project.
    expect(result.reason).toContain('nothing was verified')
    expect(git(root, 'rev-parse', 'main')).toBe(before)
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('reports a failing check instead of calling the task done', async () => {
    const branch = 'warmstart/t84-red'
    const { project, taskId, ws, root } = seedLocal(branch)
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'red',
        vcs: 'git',
        check: ['git nope-this-is-not-a-command'],
        landing: { target: 'main' }
      })
    )
    const reloaded = projects.reloadProject(project.id) ?? project

    const result = await land(reloaded, taskId, ws, branch, 'commit-and-verify')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('checks failed')
    // ⛔ The commit stays. Destroying committed work is the one thing this tool refuses to do.
    expect(git(ws, 'log', '--oneline', '-1')).toContain('the agent did the work')
  })

  it('hands back a failing check’s output without its colour codes, and names the failure', async () => {
    // ⭐ t344/t347 (2026-09-11): vitest's escape codes reached the thread verbatim — `←[31m←[1m FAIL`
    // in the chat — and the same bytes went to the agent inside the retry instruction. The check
    // here colours its own output and is told not to, exactly as a real runner would be; the strip
    // is for the ones that do not listen.
    const branch = 'warmstart/t86-colour'
    const { project, taskId, ws, root } = seedLocal(branch)
    const red = 'process.stdout.write(\'\\x1b[31m\\x1b[1m FAIL \\x1b[22m\\x1b[39m the-red-test\\n\'); process.exit(1)'
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'colour',
        vcs: 'git',
        check: [`node -e "${red}"`],
        landing: { target: 'main' }
      })
    )
    const reloaded = projects.reloadProject(project.id) ?? project

    const result = await land(reloaded, taskId, ws, branch, 'commit-and-verify')

    expect(result.ok).toBe(false)
    expect(result.checkOutput ?? '').toContain('FAIL')
    expect(result.checkOutput ?? '').toContain('the-red-test')
    expect(result.checkOutput ?? '').not.toContain('')
    // ⛔ And the thread copy — which is what `resolveChecksOnTask` sends the agent — is clean too.
    // ⚠️ Text *and* detail: the line is one sentence and the check output lives behind it, which is
    // exactly what `resolveChecksOnTask` reads through `messageBody`.
    const said = tasks.messagesFor(taskId).map((m) => (m.detail ? `${m.text}\n${m.detail}` : m.text)).join('\n')
    expect(said).toContain('the-red-test')
    expect(said).not.toContain('')
  })

  it('lets the policy choose the strategy, not the project’s legacy field', () => {
    // ⛔ `makeRepo` writes `landing.strategy: 'auto-land'`. Before 2026-08-30 that field decided
    // what ran, so a project resolved to `pull-request` would still have had its trunk pushed.
    const { project } = seedLocal('warmstart/t85-which')
    expect(landing.strategyFor(project, 'commit-and-merge').id).toBe('merge-local')
    expect(landing.strategyFor(project, 'commit-and-verify').id).toBe('verify-only')
    expect(landing.strategyFor(project, 'pull-request').id).toBe('pull-request')
    expect(landing.strategyFor(project, 'commit-and-push').id).toBe('auto-land')
    // ⚠️ `custom` is the one that still falls through to the project's own field: the tool is
    // tidying up behind an instruction the agent was given.
    expect(landing.strategyFor(project, 'custom').id).toBe('auto-land')
  })
})

/**
 * Which commits a landing says are **this task's**.
 *
 * ⭐ **t369, 2026-09-11.** The operator opened a finished conversation and found 23 commits under
 * *commits in this task*, of which the task had written one. They were all real and the push really
 * did put them on the remote — they were the twenty-two earlier landings sitting unpushed on the
 * operator's local `main`, which the branch had been rebased on top of. `task_commits` is read as
 * *"where did this task's work go"* and fed to the quality reviewer as the diff to grade, so a
 * generous range is not a cosmetic problem.
 *
 * ⚠️ A real remote, because the whole shape is *the local trunk is ahead of `origin`* and there is
 * no way to build that without one.
 */
describe('attributing a landing to the task that made it', () => {
  it('records the branch’s own commits, not the backlog the local trunk was carrying', async () => {
    seq += 1
    const root = makeRepo(`attrib${seq}`)
    const remote = join(dir, `attrib-remote${seq}.git`)
    git(dir, 'init', '--bare', '--initial-branch=main', remote)
    git(root, 'remote', 'add', 'origin', remote)
    git(root, 'push', '-u', 'origin', 'main')
    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: `attribution ${seq}`,
      projectId: project.id,
      createdBy: { kind: 'human' }
    })

    // ⛔ Two earlier tasks' commits, landed onto the *local* trunk and never pushed. This is the
    //    ordinary state of this repository between pushes, not a contrivance.
    for (const name of ['earlier-a', 'earlier-b']) {
      writeFileSync(join(root, `${name}.txt`), `${name}\n`)
      git(root, 'add', '-A')
      git(root, 'commit', '-m', `somebody else's work: ${name}`)
    }
    const backlog = git(root, 'rev-parse', 'main')
    expect(git(root, 'rev-list', '--count', 'origin/main..main')).toBe('2')

    const branch = `warmstart/t${seq}-attribution`
    const ws = join(dir, `attrib${seq}-ws`)
    git(root, 'worktree', 'add', '-b', branch, ws, 'main')
    writeFileSync(join(ws, 'mine.txt'), 'the one commit this task wrote\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-m', 'the work this task did')
    const mine = git(ws, 'rev-parse', 'HEAD')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(task.id),
      workspacePath: ws,
      branch,
      policy: 'commit-and-push'
    })

    expect(result.ok, result.reason).toBe(true)
    expect(result.pushed).toBe(true)
    // ⛔ The push carried all three — that is what landing against `origin/main` means, and it is
    //    correct. The *attribution* is the one commit the branch added.
    expect(git(root, 'rev-list', '--count', `${backlog}..origin/main`)).toBe('1')
    const recorded = commits.taskCommits(task.id)
    expect(recorded.map((c) => c.sha)).toEqual([mine])
    expect(recorded.map((c) => c.subject)).toEqual(['the work this task did'])
  }, 30_000)
})

describe('a task that produced no commits', () => {
  it('does not claim to have landed the commit that was already there', async () => {
    const { project, taskId, root } = seedTask('warmstart/t1-question')
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t1-question'
    })
    expect(result.ok).toBe(false)
    expect(result.commit).toBeUndefined()
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
  })

  it('says no work landed and asks human how to proceed', async () => {
    const { project, taskId, root } = seedTask('warmstart/t2-question')
    await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t2-question'
    })
    const said = tasks.messagesFor(taskId).map(messageBody).join('\n')
    expect(said).toContain('Not landed')
    expect(said).toContain('no work landed')
    // ⛔ And never the sentence that started this. "Landed as <sha>" is what somebody skims.
    expect(said).not.toContain('Landed as')
  })

  it('says it on one line, and keeps the explanation behind the line rather than dropping it', async () => {
    // ⛔ A system message is a one-liner with its basis in `detail`. The line is what a person skims;
    //    the detail is what they open, and what the resolve buttons read back (`messageBody`). A
    //    shortening that dropped the explanation would leave the thread saying *what* without *why*.
    const { project, taskId, root } = seedTask('warmstart/t4-question')
    await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t4-question'
    })
    const line = tasks.messagesFor(taskId).find((m) => m.role === 'system' && m.text.startsWith('Not landed'))
    expect(line?.text).toBe('Not landed: no commits were produced')
    expect(line?.event).toBe('landing.failed')
    expect(line?.detail).toContain('carries no commits that')
    expect(line?.detail).toContain('Check if the agent answered as a question instead of making changes')
    expect(line?.detail).toContain('The branch has been kept')
  })

  it('guards against empty commits by going to awaiting_human so a person can review or close', async () => {
    // ⚠️ Empty commit guard: a task with 0 commits and no landed work enters awaiting_human
    // so a human can ask further questions or mark it completed.
    const { project, taskId, root } = seedTask('warmstart/t3-question')
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t3-question'
    })
    expect(result.ok).toBe(false)
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
    expect(tasks.getTask(taskId)?.holdReason).toBe('no commits were produced on this branch')
  })

  it('still defers to a task that asked to be checked', async () => {
    // ⛔ "Nothing landed" is an outcome its author wanted to see before it was called done. Skipping
    // the review because the diff turned out empty decides that for them.
    const { project, taskId, root } = seedTask('warmstart/t4-verify')
    tasks.updateTask(taskId, { verification: 'required' })
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t4-verify'
    })
    expect(result.nothingToLand).toBeUndefined()
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
  })
})

describe('a task that did commit something', () => {
  it('is not waved through as nothing to land', async () => {
    const { project, taskId, root } = seedTask('warmstart/t5-real')
    writeFileSync(join(root, 'new.txt'), 'a real change\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'a real change')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t5-real'
    })
    // ⛔ The check is `rev-list --count main..branch`, so one commit is enough to reach the real
    // strategy. Whether that strategy then succeeds is landing's own business and is covered
    // end-to-end by the opt-in L4 run against a real remote.
    expect(result.nothingToLand).toBeUndefined()
    expect(tasks.messagesFor(taskId).map(messageBody).join('\n')).not.toContain('Nothing to land')
  })

  it('leaves uncommitted work to the refusal that says where it is', async () => {
    // ⚠️ A dirty workspace with no commits is *not* "nothing to land" — it is work that exists and
    // is about to be destroyed by the next dispatch into a pooled worktree. Collapsing the two
    // would replace an urgent warning with a shrug.
    const { project, taskId, root } = seedTask('warmstart/t6-dirty')
    writeFileSync(join(root, 'unsaved.txt'), 'not committed\n')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t6-dirty'
    })
    expect(result.nothingToLand).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(tasks.messagesFor(taskId).map(messageBody).join('\n')).toContain('uncommitted')
  })

  it('⛔ refuses a tip that is only the rescue of an interrupted run', async () => {
    // ⛔ t91/t92, 2026-09-01. A preempted run's uncommitted work is now committed onto its branch so
    // the next run inherits it — which leaves a **clean** workspace holding a commit nobody compiled.
    // `isClean` waves that through, `rev-list --count` counts it as a commit to land, and every step
    // after it succeeds. Landing has to know the difference between work and a rescue of work.
    const { project, taskId, root } = seedTask('warmstart/t7-rescued')
    writeFileSync(join(root, 'half-done.txt'), 'as far as it got\n')
    git(root, 'add', '-A')
    git(
      root,
      'commit',
      '-m',
      'wip: 1 file(s) an interrupted run left behind\n\nMulti-Agent-Controller-Rescue: 1'
    )

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t7-rescued'
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('rescued')
    expect(git(root, 'rev-parse', 'main')).not.toBe(git(root, 'rev-parse', 'HEAD'))
  })

  it('lands once the run has finished something on top of the rescue', async () => {
    // ⚠️ The mirror case, and the reason the check reads only the tip: a rescue somebody built on is
    // ordinary history, and the project checks are what judge the result.
    const { project, taskId, root } = seedTask('warmstart/t8-rescued-then-finished')
    writeFileSync(join(root, 'half-done.txt'), 'as far as it got\n')
    git(root, 'add', '-A')
    git(
      root,
      'commit',
      '-m',
      'wip: 1 file(s) an interrupted run left behind\n\nMulti-Agent-Controller-Rescue: 1'
    )
    writeFileSync(join(root, 'half-done.txt'), 'and then it was finished\n')
    git(root, 'commit', '-am', 'finish it')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'warmstart/t8-rescued-then-finished'
    })
    expect(result.reason ?? '').not.toContain('rescued')
  })
})

/**
 * The branch a finish leaves behind.
 *
 * ⛔ Measured 2026-08-29. t22's agent pushed its own commit to `origin/main` — which is what this
 * repo's `/commit` skill tells a worktree to do, and therefore the *normal* outcome here rather than
 * an edge case. The finish correctly reported that there was nothing left to land, and then left
 * `warmstart/t22-…` sitting in the pool: a branch whose every commit was already on the
 * target, kept alive by nothing but the absence of a line of code. The success path had deleted its
 * branch since the beginning; only the paths that land *nothing* forgot to.
 *
 * ⚠️ Real git throughout. The whole question is what `git branch -D` does in a repository with
 * worktrees, so a stubbed git would prove nothing.
 */

/** A task whose agent pushed its own work, the way `/commit` tells it to. The t22 shape. */
function seedPushedTask(branch: string): { project: Project; taskId: string; root: string } {
  const seeded = seedTask(branch)
  const remote = join(dir, `pushed-remote${seq}.git`)
  git(dir, 'init', '--bare', '--initial-branch=main', remote)
  git(seeded.root, 'remote', 'add', 'origin', remote)
  git(seeded.root, 'push', '-u', 'origin', 'main')
  writeFileSync(join(seeded.root, 'shipped.txt'), 'the agent pushed this itself\n')
  git(seeded.root, 'add', '-A')
  git(seeded.root, 'commit', '-m', 'work the agent landed on its own')
  // ⛔ A push, and no local ref move. That asymmetry is the whole point: `origin/main` now carries
  // the work and the operator's `main` does not.
  git(seeded.root, 'push', 'origin', 'HEAD:main')
  return seeded
}

describe('retiring the branch of a finish that landed nothing', () => {
  it('deletes it, because every commit on it is already in the base', async () => {
    const branch = 'warmstart/t30-retire'
    const { root } = seedTask(branch)
    const retired = await landing.finishWithoutLanding(root, branch, 'main')

    expect(retired.deleted).toBe(true)
    expect(() => git(root, 'rev-parse', '--verify', branch)).toThrow()
  })

  it('leaves the working tree on the same commit, so nothing moves under a live agent', async () => {
    // ⚠️ Detached at HEAD, not at the base. Detaching at the base would also free the name — and
    //    would silently change the files an agent may still be looking at.
    // ⚠️ The pushed shape on purpose: here the branch tip and the *local* `main` are different
    //    commits, so detaching at the base instead of at HEAD is a mutation this can actually see.
    //    With a branch level with `main` the two are indistinguishable and the test proves nothing.
    const branch = 'warmstart/t31-detach'
    const { root } = seedPushedTask(branch)
    const before = git(root, 'rev-parse', 'HEAD')
    expect(git(root, 'rev-parse', 'main')).not.toBe(before)

    await landing.finishWithoutLanding(root, branch, 'main')

    expect(git(root, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  })

  it('says what became of the branch, and names what a resumed task would start from', async () => {
    const branch = 'warmstart/t32-note'
    const { root } = seedTask(branch)
    const retired = await landing.finishWithoutLanding(root, branch, 'origin/main')

    expect(retired.note).toContain('deleted')
    expect(retired.note).toContain(branch)
    // ⭐ And the base, because "we deleted your branch" without saying what replaces it reads as loss.
    expect(retired.note).toContain('origin/main')
  })

  it('deletes a branch the workspace is not standing on', async () => {
    // A workspace parked between tasks is detached; the branch is still there and still dead.
    const branch = 'warmstart/t33-parked'
    const { root } = seedTask(branch)
    git(root, 'switch', '--detach', 'main')

    expect((await landing.finishWithoutLanding(root, branch, 'main')).deleted).toBe(true)
    expect(() => git(root, 'rev-parse', '--verify', branch)).toThrow()
  })

  it('leaves a branch another worktree still holds, and does not call that a failure', async () => {
    // ⛔ Untidy is not the same as broken. Git refuses to delete a branch checked out elsewhere, and
    //    a finish that reported failure over it would turn a successful task into a person's problem.
    const branch = 'warmstart/t34-held'
    const { root } = seedTask(branch)
    git(root, 'switch', '--detach', 'main')
    git(root, 'worktree', 'add', join(dir, 'holder-t34'), branch)

    const retired = await landing.finishWithoutLanding(root, branch, 'main')

    expect(retired.deleted).toBe(false)
    expect(retired.note).toBe('')
    expect(git(root, 'rev-parse', '--verify', branch)).toBeTruthy()
  })

  it('reports false for a branch that is not there, rather than throwing', async () => {
    const { root } = seedTask('warmstart/t35-gone')
    expect((await landing.finishWithoutLanding(root, 'no-such-branch', 'main')).deleted).toBe(false)
  })
})

describe('landTask on a branch with nothing left to land', () => {
  it('keeps the branch and asks human when no commits exist', async () => {
    const branch = 'warmstart/t36-question'
    const { project, taskId, root } = seedTask(branch)

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.ok).toBe(false)
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
    expect(git(root, 'branch', '--list', branch)).toContain(branch)
  })

  it('does the same when the agent landed the work itself, which is the t22 shape', async () => {
    const branch = 'warmstart/t37-agent-pushed'
    const { project, taskId, root } = seedPushedTask(branch)

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.nothingToLand).toBe(true)
    expect(result.branchDeleted).toBe(true)
    const said = tasks.messagesFor(taskId).map(messageBody).join('\n')
    // ⛔ Names the ref it compared, tells the operator their trunk is behind, and says the branch is
    //    gone. Each on its own leaves a reasonable person with the wrong picture.
    expect(said).toContain('origin/main')
    expect(said).toContain('git pull')
    expect(said).toContain('deleted')
  })

  it('keeps the branch of a task that asked to be verified', async () => {
    // ⛔ The early return does not fire, so nothing is retired. A person is about to look at this.
    const branch = 'warmstart/t38-verify'
    const { project, taskId, root } = seedTask(branch)
    tasks.updateTask(taskId, { verification: 'required' })

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.branchDeleted).toBeUndefined()
    expect(git(root, 'rev-parse', '--verify', branch)).toBeTruthy()
  })

  it('deletes the branch only after the work has actually landed', async () => {
    const branch = 'warmstart/t39-real'
    const { project, taskId, root } = seedTask(branch)
    writeFileSync(join(root, 'new.txt'), 'a real change\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'a real change')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    // ⭐ The branch is gone here too - but because the work **landed**, which is what the success
    //    path has always done. The distinction the early return must not blur is *why*: this commit
    //    is on `main`, and a branch retired without that being true would be work thrown away.
    expect(result.nothingToLand).toBeUndefined()
    expect(result.commit).toBeTruthy()
    expect(git(root, 'rev-list', '--count', `main..${result.commit}`)).toBe('0')
  })

  it('keeps the branch when the workspace is dirty', async () => {
    // ⛔ The loudest case. Uncommitted work with no commits is *not* nothing to land, and deleting
    //    the branch under it would remove the only handle on where that work belongs.
    const branch = 'warmstart/t40-dirty'
    const { project, taskId, root } = seedTask(branch)
    writeFileSync(join(root, 'unsaved.txt'), 'not committed\n')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.branchDeleted).toBeUndefined()
    expect(git(root, 'rev-parse', '--verify', branch)).toBeTruthy()
  })
})

/**
 * Two tasks finishing at the same moment.
 *
 * ⛔ **Measured 2026-08-29.** t26 and t27 were run in parallel and finished within the same second.
 * One landed. The other was told *"Landing failed: another task is landing right now. 1 commit(s)
 * are on `warmstart/t27-…`, which is intact"* and was parked on a person's desk. The
 * lock behaved exactly as designed — landing **is** serialised per project, because two rebases onto
 * a moving target race — and the caller turned a two-second queue into a hand-off.
 *
 * ⭐ The fix is to wait for the turn rather than to report the queue as a failure, and to record the
 * ordering as a dependency edge so that "t27 landed after t26" survives the run.
 *
 * ⚠️ Real git and real concurrency. The winner is whoever `claim()` admits first, so these assert on
 * *whichever* task lost rather than pinning one — a test that assumed an order would pass against a
 * scheduler that had none.
 */

interface Race {
  project: Project
  aTask: string
  bTask: string
  aPath: string
  bPath: string
  root: string
}

/** One project, two worktrees, each holding a branch with a real commit. The t26/t27 shape. */
function seedRace(a: string, b: string): Race {
  seq += 1
  const root = makeRepo(`race${seq}`)
  const project = projects.addProject({ root })
  // ⚠️ The trunk is detached on purpose. `auto-land` on a project with no remote fast-forwards the
  // target by fetching into it, and git refuses to fetch into a branch that is checked out.
  git(root, 'switch', '--detach', 'main')

  const make = (branch: string, dirName: string): { taskId: string; path: string } => {
    const path = join(dir, dirName)
    git(root, 'worktree', 'add', '-b', branch, path, 'main')
    writeFileSync(join(path, `${dirName}.txt`), `work from ${branch}\n`)
    git(path, 'add', '-A')
    git(path, 'commit', '-m', `real work on ${branch}`)
    const task = tasks.createTask({
      title: `race ${branch}`,
      projectId: project.id,
      createdBy: { kind: 'human' }
    })
    return { taskId: task.id, path }
  }

  const one = make(a, `race${seq}-a`)
  const two = make(b, `race${seq}-b`)
  return { project, aTask: one.taskId, bTask: two.taskId, aPath: one.path, bPath: two.path, root }
}

/** Hold the project's landing lock under some other name, the way a task mid-landing does. */
function holdTheLock(project: Project, holder: string): { release: () => void } {
  resources.upsertResource({
    id: resources.landResourceId(project.id),
    projectId: project.id,
    kind: 'exclusive',
    label: `${project.name} landing`,
    capacity: 1
  })
  const held = resources.claim(resources.landResourceId(project.id), holder)
  if (!held) throw new Error('the fixture could not take the landing lock')
  return { release: () => resources.release(held.id) }
}

const said = (taskId: string): string => tasks.messagesFor(taskId).map(messageBody).join('\n')

/**
 * Block until the task has actually queued, rather than for a number of milliseconds.
 *
 * ⛔ A fixture that released the lock after a fixed delay was racing the *preamble* — `landTask`
 * spends a few hundred milliseconds on `git status` and `rev-list` before it ever asks for the lock,
 * so a 60ms hold was released before the contention it was supposed to create. Three of these tests
 * passed against a build with no queue in it at all. Waiting for the message the queue itself posts
 * is the only signal that does not depend on how fast git is today.
 */
async function waitUntilQueued(taskId: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !said(taskId).includes('Waiting to land')) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('two tasks landing at once', () => {
  afterEach(() => Object.assign(landingQueue, queueDefaults))

  it('lands both of them, which is the whole report', async () => {
    // ⭐ The regression, end to end. Before this, one of these two came back `ok: false`.
    const race = seedRace('warmstart/t26-first', 'warmstart/t27-second')
    landingQueue.pollMs = 20

    const [a, b] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'warmstart/t26-first'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'warmstart/t27-second'
      })
    ])

    expect(a.ok, a.reason).toBe(true)
    expect(b.ok, b.reason).toBe(true)
    // ⛔ And both are actually on the trunk. Two "successes" that landed one commit between them
    //    would be the same defect wearing a better message.
    expect(a.commit).not.toBe(b.commit)
    for (const commit of [a.commit, b.commit]) {
      expect(git(race.root, 'rev-list', '--count', `main..${commit}`)).toBe('0')
    }
    // ⚠️ Exactly one of them queued, and the test does not care which.
    expect([a.contendedWith, b.contendedWith].filter(Boolean)).toHaveLength(1)
  })

  it('hands neither of them to a person', async () => {
    const race = seedRace('warmstart/t41-a', 'warmstart/t41-b')
    landingQueue.pollMs = 20

    await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'warmstart/t41-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'warmstart/t41-b'
      })
    ])

    for (const id of [race.aTask, race.bTask]) {
      expect(tasks.getTask(id)?.status, id).not.toBe('awaiting_human')
    }
  })

  it('records the ordering as a dependency on whoever was landing', async () => {
    // ⭐ The operator's own ask: the second task should *depend on* the first rather than fail beside
    //    it. The edge outlives the run, so "t27 landed after t26" is answerable afterwards.
    const race = seedRace('warmstart/t42-a', 'warmstart/t42-b')
    landingQueue.pollMs = 20

    const [a] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'warmstart/t42-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'warmstart/t42-b'
      })
    ])

    const loser = a.contendedWith ? race.aTask : race.bTask
    const winner = a.contendedWith ? race.bTask : race.aTask
    expect(tasks.requireTask(loser).dependsOn).toContain(winner)
    // ⛔ One direction only. An edge both ways is a cycle, and the winner waited for nothing.
    expect(tasks.requireTask(winner).dependsOn).not.toContain(loser)
  })

  it('does not put the waiting task into `blocked`', async () => {
    // ⛔ The tempting design, and the wrong one. `blocked` is the status of work waiting to be
    //    *dispatched*: `admitDependents` walks a blocked task to `ready` the moment its blocker
    //    completes, and a finished task made ready is a task the scheduler hands to an agent again —
    //    a second run over work that is already committed. The edge is a record; the status would be
    //    an instruction.
    const race = seedRace('warmstart/t43-a', 'warmstart/t43-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t43-a'
    })
    await waitUntilQueued(race.aTask)
    expect(tasks.getTask(race.aTask)?.status).not.toBe('blocked')

    lock.release()
    expect((await pending).ok).toBe(true)
  })

  it('waits for a lock that is busy now and free in a moment, then lands', async () => {
    const race = seedRace('warmstart/t44-a', 'warmstart/t44-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t44-a'
    })
    await waitUntilQueued(race.aTask)
    lock.release()
    const result = await pending

    expect(result.ok, result.reason).toBe(true)
    expect(git(race.root, 'rev-list', '--count', `main..${result.commit}`)).toBe('0')
    expect(said(race.aTask)).toContain('Waiting to land')
    expect(said(race.aTask)).toContain('Landed as')
  })

  it('releases the lock afterwards, so the queue drains rather than stopping', async () => {
    // ⛔ One leaked exclusive claim stalls a project forever, and the symptom is silence.
    const race = seedRace('warmstart/t45-a', 'warmstart/t45-b')
    landingQueue.pollMs = 10
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t45-a'
    })
    await waitUntilQueued(race.aTask)
    lock.release()

    // ⛔ And it landed. A lock nobody ever took is also free, so the count alone proves nothing.
    expect((await pending).ok).toBe(true)
    expect(resources.availability(resources.landResourceId(race.project.id))?.free).toBe(1)
  })

  it('gives up on a lock that never frees, and says the branch is fine', async () => {
    // ⚠️ Bounded. An unbounded wait inside a completion is a deadlock with a patient face — the task
    //    would hold its workspace and its session for as long as the daemon lived.
    const race = seedRace('warmstart/t46-a', 'warmstart/t46-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 120
    holdTheLock(race.project, 'a-task-that-never-finishes')

    const result = await landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t46-a'
    })

    expect(result.ok).toBe(false)
    expect(tasks.getTask(race.aTask)?.status).toBe('awaiting_human')
    // ⭐ The message the operator acts on. A queue that ran out is a retry, not an investigation, and
    //    the branch is intact either way.
    expect(said(race.aTask)).toContain('Nothing is wrong with the branch')
    expect(git(race.aPath, 'rev-parse', '--verify', 'warmstart/t46-a')).toBeTruthy()
  })

  // ⚠️ Ten seconds of headroom against a thirty-second budget, so that a build which ignored the
  //    cancel fails on the clock instead of on vitest's default five.
  it('stops waiting when the task is cancelled underneath it', async () => {
    const race = seedRace('warmstart/t47-a', 'warmstart/t47-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 30_000
    holdTheLock(race.project, 'a-task-that-never-finishes')

    const started = Date.now()
    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t47-a'
    })
    setTimeout(() => tasks.setStatus(race.aTask, 'cancelling'), 50)
    const result = await pending

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cancelled')
    // ⛔ It stopped because of the cancel, not because it out-waited a thirty-second budget.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  it('lands anyway when the holder is not a task this fleet has', async () => {
    // ⚠️ The *wait* is what serialises the two; the edge only records that it happened. A holder with
    //    no task row — a hand-taken claim, a row since deleted — costs the record and nothing else.
    const race = seedRace('warmstart/t48-a', 'warmstart/t48-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'not-a-task-id')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t48-a'
    })
    await waitUntilQueued(race.aTask)
    lock.release()
    const result = await pending

    expect(result.ok, result.reason).toBe(true)
    expect(tasks.requireTask(race.aTask).dependsOn).toHaveLength(0)
  })

  it('refuses to close a cycle, and lands both regardless', async () => {
    const race = seedRace('warmstart/t49-a', 'warmstart/t49-b')
    landingQueue.pollMs = 20
    // Whichever of these ends up queueing, the edge it wants may already run the other way.
    tasks.addDependency(race.aTask, race.bTask)

    const [a, b] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'warmstart/t49-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'warmstart/t49-b'
      })
    ])

    expect(a.ok, a.reason).toBe(true)
    expect(b.ok, b.reason).toBe(true)
    expect(tasks.requireTask(race.bTask).dependsOn).not.toContain(race.aTask)
  })

  it('adds nothing and says nothing when there is no queue', async () => {
    // ⛔ The guard, and it must keep passing when the queue is deleted. A landing that never
    //    contended must not acquire a dependency it did not need, and must not claim it waited.
    const race = seedRace('warmstart/t50-a', 'warmstart/t50-b')

    const result = await landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'warmstart/t50-a'
    })

    expect(result.ok, result.reason).toBe(true)
    expect(result.contendedWith).toBeUndefined()
    expect(tasks.requireTask(race.aTask).dependsOn).toHaveLength(0)
    expect(said(race.aTask)).not.toContain('Waiting to land')
  })
})

/**
 * The sentence itself, without a repository behind it.
 *
 * ⛔ **Each clause is written only when the fact behind it is known**, and that is the property
 * worth pinning: a strategy that does not verify must say nothing about verification rather than
 * leave the reader to assume it happened, and a count of zero checks is the *opposite* of verified
 * rather than a smaller amount of it.
 */
describe('what a landing tells the operator it did', () => {
  const base = {
    strategy: 'merge-local' as const,
    ok: true as const,
    commit: '98f200abcdef1234',
    branch: 'warmstart/t239-thing'
  }

  it('keeps the headline shape the salvage parser reads back off the thread', () => {
    // ⛔ `taskcommits.ts` recovers the commits of every task that landed before `task_commits`
    //    existed by matching this opening. Reword it and 200 tasks quietly stop being reviewable.
    const said = landing.landedMessage(base, 'main', null)
    expect(said.headline).toBe('Landed as `98f200ab` onto `main`')
    // ⚠️ And a landing that *did* push says so on the line, without disturbing that opening.
    expect(landing.landedMessage({ ...base, pushed: true }, 'main', null).headline).toBe(
      'Landed as `98f200ab` onto `main` and pushed to `origin/main`'
    )
    expect(landing.landedMessage({ ...base, pushed: false }, 'main', null).headline).toContain(
      '**not pushed**'
    )
    // ⛔ And the detail never repeats it: one thread row must not carry two headlines for
    //    `salvageLandedCommits` to count twice.
    expect(said.detail).not.toContain('Landed as')
  })
  const detailOf = (...args: Parameters<typeof landing.landedMessage>): string =>
    landing.landedMessage(...args).detail


  it('says what it verified, how far the work went, and what became of the branch', () => {
    const said = detailOf(
      { ...base, checksPassed: 4, pushed: false, branchDeleted: true },
      'main',
      null
    )
    expect(said).toContain('4 project checks passed')
    // ⛔ The push itself is on the headline now; what the detail adds is the consequence.
    expect(said).toContain('ahead of the remote')
    expect(said).not.toContain('**not pushed**')
    expect(said).toContain('`warmstart/t239-thing` held nothing `main` does not now have')
  })

  it('calls a project with no check commands unverified, which is not a smaller kind of verified', () => {
    const said = detailOf({ ...base, checksPassed: 0 }, 'main', null)
    expect(said).toContain('Nothing was verified')
    expect(said).not.toContain('passed')
  })

  it('says nothing at all about verification for a strategy that does not verify', () => {
    // ⚠️ `open-pr` deliberately runs no checks locally — a pull request exists so that CI and a
    //    person do that — so the honest report is silence, not a claim in either direction.
    const said = detailOf(base, 'main', null)
    expect(said).not.toContain('verified')
    expect(said).not.toContain('Verified')
  })

  it('says a branch was kept rather than pretending it was tidied', () => {
    const said = detailOf({ ...base, branchDeleted: false }, 'main', null)
    expect(said).toContain('was kept')
  })

  it('names the remote on the headline when the work was pushed, and only then', () => {
    // ⭐ On the *line*, not behind the ⓘ: an operator who asked for commit·verify·merge·push could
    //    not tell from *"Landed as `x` onto `main`"* whether the push had happened (t369).
    const pushed = landing.landedMessage({ ...base, pushed: true }, 'main', null)
    expect(pushed.headline).toContain('`origin/main`')
    expect(pushed.detail).not.toContain('origin/')
    // ⚠️ A strategy that cannot say either way says neither, in both places.
    const silent = landing.landedMessage(base, 'main', null)
    expect(silent.headline).not.toContain('origin/')
    expect(silent.detail).not.toContain('origin/')
    expect(silent.headline).not.toContain('pushed')
  })

  it('counts the commits only when there is more than one to count', () => {
    // ⚠️ "1 commit, tipped by that one" is the headline again in more words.
    expect(detailOf({ ...base, commitsLanded: 3 }, 'main', null)).toContain('3 commits')
    expect(detailOf({ ...base, commitsLanded: 1 }, 'main', null)).not.toContain('commits,')
  })

  it('still says it queued, which is the only evidence the land queue ran', () => {
    expect(detailOf(base, 'main', { seq: 26 })).toContain('queued behind t26')
  })

  it('formats pull-request headline with URL and pushed detail', () => {
    const prResult: LandingResult = {
      strategy: 'pull-request',
      ok: true,
      commit: '822178fc94768bd9',
      branch: 'warmstart/t372-issue-132',
      pushed: true,
      prUrl: 'https://github.com/shyoo/awardtracker/pull/138'
    }
    const msg = landing.landedMessage(prResult, 'main', null)
    expect(msg.headline).toBe(
      'Pull request opened for `822178fc` into `main`: https://github.com/shyoo/awardtracker/pull/138'
    )
    expect(msg.detail).toContain('Pushed to `origin/warmstart/t372-issue-132`.')
  })

  it('formats pull-request headline cleanly without URL when URL is not reported', () => {
    const prResult: LandingResult = {
      strategy: 'pull-request',
      ok: true,
      commit: '822178fc94768bd9',
      branch: 'warmstart/t372-issue-132',
      pushed: true
    }
    const msg = landing.landedMessage(prResult, 'main', null)
    expect(msg.headline).toBe('Pull request opened for `822178fc` into `main`')
    expect(msg.detail).toContain('Pushed to `origin/warmstart/t372-issue-132`.')
  })
})

describe('pull-request landing strategy', () => {
  let undoGh: () => void
  beforeAll(async () => {
    const { stubCliPath } = await import('./testkit.js')
    undoGh = stubCliPath('gh')
  })
  afterAll(() => {
    undoGh()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function isGhCall(cmd: unknown, args: unknown): boolean {
    if (cmd === 'git') return false
    if (typeof cmd === 'string' && /gh(\.exe)?$/i.test(cmd)) return true
    if (Array.isArray(args) && args.includes('pr')) return true
    return false
  }

  function seedRepoWithRemote(branch: string) {
    seq += 1
    const root = makeRepo(`pr-root${seq}`)
    const remote = join(dir, `pr-remote${seq}.git`)
    git(dir, 'init', '--bare', remote)
    git(root, 'remote', 'add', 'origin', remote)
    git(root, 'push', '-u', 'origin', 'main')

    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: `pr task ${seq}`,
      projectId: project.id,
      createdBy: { kind: 'human' }
    })
    const ws = join(dir, `pr-ws${seq}`)
    git(root, 'worktree', 'add', '-b', branch, ws, 'main')
    writeFileSync(join(ws, 'file.txt'), 'pr work\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-m', 'work on pr')
    return { project, task, root, ws, branch }
  }

  it('opens a pull request when gh pr create succeeds', async () => {
    const branch = 'warmstart/t372-open-pr'
    const { project, task, ws } = seedRepoWithRemote(branch)
    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        return {
          stdout: 'https://github.com/shyoo/awardtracker/pull/138\n',
          stderr: ''
        }
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const result = await landing.pullRequest.land({
      project,
      task,
      workspacePath: ws,
      branch,
      policy: 'pull-request'
    })

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('pull-request')
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBe('https://github.com/shyoo/awardtracker/pull/138')
    expect(result.branch).toBe(branch)
    expect(deliveries.deliveriesForTask(task.id)).toMatchObject([
      { url: result.prUrl, branch, headSha: result.commit, state: 'open' }
    ])
  })

  it('detects existing pull request on gh pr create failure and succeeds with prUrl', async () => {
    const branch = 'warmstart/t372-existing-pr'
    const { project, task, ws } = seedRepoWithRemote(branch)
    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    const existingError = new Error(
      'Command failed: gh.EXE pr create ... a pull request for branch "warmstart/t372-existing-pr" into branch "main" already exists:\nhttps://github.com/shyoo/awardtracker/pull/138\n'
    )
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        throw existingError
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const result = await landing.pullRequest.land({
      project,
      task,
      workspacePath: ws,
      branch,
      policy: 'pull-request'
    })

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('pull-request')
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBe('https://github.com/shyoo/awardtracker/pull/138')
    expect(result.branch).toBe(branch)
  })

  it('falls back to gh pr view when error says already exists without embedded URL', async () => {
    const branch = 'warmstart/t372-view-fallback'
    const { project, task, ws } = seedRepoWithRemote(branch)
    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    let ghCalls = 0
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        ghCalls++
        if (ghCalls === 1) {
          throw new Error('a pull request for branch already exists')
        }
        return { stdout: 'https://github.com/shyoo/awardtracker/pull/139\n', stderr: '' }
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const result = await landing.pullRequest.land({
      project,
      task,
      workspacePath: ws,
      branch,
      policy: 'pull-request'
    })

    expect(result.ok).toBe(true)
    expect(result.strategy).toBe('pull-request')
    expect(result.prUrl).toBe('https://github.com/shyoo/awardtracker/pull/139')
  })

  it('returns ok: false when gh pr create fails with an unrelated error', async () => {
    const branch = 'warmstart/t372-err'
    const { project, task, ws } = seedRepoWithRemote(branch)
    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        throw new Error('network connection timed out')
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const result = await landing.pullRequest.land({
      project,
      task,
      workspacePath: ws,
      branch,
      policy: 'pull-request'
    })

    expect(result.ok).toBe(false)
    expect(result.strategy).toBe('pull-request')
    expect(result.reason).toContain('network connection timed out')
    expect(result.reason).toContain('may already be pushed')
  })

  it('force-with-lease retries a rejected push when a later run rewrote history already on the open PR', async () => {
    // ⛔ Regression for the cascade in t509: the closing contract every run gets only forbids
    // rewriting commits already on the *landing target*, not commits already pushed as this task's
    // own open pull request - so a later run legitimately squashes what it finds there. A plain
    // `git push` cannot land that, and used to be reported as an ordinary failure ("may already be
    // pushed") that repeated on every retry with nothing to act on.
    const branch = 'warmstart/t509-rewrite'
    const { project, task, ws } = seedRepoWithRemote(branch)
    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    const ghSucceeds = vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) return { stdout: 'https://github.com/shyoo/awardtracker/pull/509\n', stderr: '' }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const first = await landing.pullRequest.land({ project, task, workspacePath: ws, branch, policy: 'pull-request' })
    expect(first.ok).toBe(true)
    ghSucceeds.mockRestore()

    // A later run adds a second commit, then squashes the pair - legitimate under the closing
    // contract because neither commit is on the landing target yet, only on this task's own branch.
    writeFileSync(join(ws, 'file2.txt'), 'more pr work\n')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-m', 'more work on pr')
    git(ws, 'reset', '--soft', 'HEAD~2')
    git(ws, 'commit', '-m', 'squashed pr work')
    const rewrittenHead = git(ws, 'rev-parse', 'HEAD')

    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        throw new Error(
          `Command failed: gh.EXE pr create ... a pull request for branch "${branch}" into branch ` +
            '"main" already exists:\nhttps://github.com/shyoo/awardtracker/pull/509\n'
        )
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const second = await landing.pullRequest.land({ project, task, workspacePath: ws, branch, policy: 'pull-request' })

    expect(second.ok).toBe(true)
    expect(second.commit).toBe(rewrittenHead)
    expect(second.prUrl).toBe('https://github.com/shyoo/awardtracker/pull/509')
    // Proves the remote branch actually carries the rewritten history, not just that the call
    // returned `ok` - a plain push silently doing nothing would still hit the "already exists" path.
    expect(git(ws, 'rev-parse', `origin/${branch}`)).toBe(rewrittenHead)
    expect(deliveries.deliveriesForTask(task.id).at(-1)).toMatchObject({ headSha: rewrittenHead, state: 'open' })
  })

  it('reconciles a squash merge and retires only the unchanged, unheld branch', async () => {
    const branch = 'warmstart/t375-squash-merged'
    const { task, root, ws } = seedRepoWithRemote(branch)
    const headSha = git(ws, 'rev-parse', 'HEAD')
    const url = 'https://github.com/shyoo/awardtracker/pull/375'
    tasks.setTaskBranch(task.id, branch, 1)
    tasks.addMessage(
      task.id,
      'system',
      `Pull request opened for \`${headSha.slice(0, 8)}\` into \`main\`: ${url}`
    )

    git(root, 'worktree', 'remove', ws)
    git(root, 'merge', '--squash', branch)
    git(root, 'commit', '-m', 'squash merged task')
    const mergeSha = git(root, 'rev-parse', 'HEAD')
    git(root, 'push', 'origin', 'main')

    const spawn = await import('./spawn.js')
    const realRun = spawn.run
    vi.spyOn(spawn, 'run').mockImplementation((async (cmd: unknown, ...rest: unknown[]) => {
      if (isGhCall(cmd, rest[0])) {
        return {
          stdout: JSON.stringify({
            state: 'MERGED',
            baseRefName: 'main',
            headRefName: branch,
            headRefOid: headSha,
            mergedAt: new Date().toISOString(),
            mergeCommit: { oid: mergeSha }
          }),
          stderr: ''
        }
      }
      return (realRun as (...args: unknown[]) => unknown)(cmd, ...rest)
    }) as never)

    const heard: import('@shared/protocol.js').DaemonEvent[] = []
    events.setEventSink((e) => heard.push(e))
    try {
      await deliveries.reconcilePullRequestDeliveries()

      expect(git(root, 'branch', '--list', branch)).toBe('')
      const [delivery] = deliveries.deliveriesForTask(task.id)
      expect(delivery).toMatchObject({ state: 'merged', mergeSha, headSha })
      expect(typeof delivery?.reconciledAt).toBe('number')
      expect(commits.taskCommits(task.id)).toMatchObject([
        { sha: mergeSha, target: 'main', source: 'pull-request' }
      ])
      expect(heard.some((e) => e.type === 'project.changed' && e.project.id === task.projectId)).toBe(true)
      expect(heard.some((e) => e.type === 'task.changed' && e.task.id === task.id)).toBe(true)
    } finally {
      events.setEventSink(() => {})
    }
  })
})

/**
 * The trunk read that stopped t446 and t447 (2026-09-14): *"the trunk could not be read: … fatal:
 * Invalid path '/mnt': No such file or directory"*. A bridged agent's test run had written
 * `core.worktree = /mnt/c/…/ws3` into the trunk's config — see `repairTrunkConfig` in worktrees.ts —
 * and both tasks went to `awaiting_human` with their work intact on the branch and nothing landed.
 * The landing now repairs the config before it asks, so the same trunk answers *ready*.
 */
describe('a trunk that cannot be read because its config names a work tree git cannot enter', () => {
  it('is repaired before the landing asks, rather than sent to a person', async () => {
    seq += 1
    const root = makeRepo(`poisoned${seq}`)
    const config = join(root, '.git', 'config')
    writeFileSync(config, readFileSync(config, 'utf8').replace('[core]', '[core]\n\tworktree = /mnt/c/somewhere/ws3'))
    expect(() => git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toThrow()
    expect(await landing.trunkNotReady(root, 'main')).toBeNull()
    expect(readFileSync(config, 'utf8')).not.toMatch(/worktree = /)
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })
})
