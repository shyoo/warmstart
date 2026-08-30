import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FinishPolicy, Project } from '@shared/tasks.js'

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
let resources: typeof import('./resources.js')
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
  mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
  writeFileSync(
    join(root, '.multi_agent_controller', 'project.json'),
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
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  landing = await import('./landing.js')
  resources = await import('./resources.js')
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
 * The rungs that never touch a remote.
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
    const branch = 'multi-agent-controller/t80-local'
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
  })

  it('⛔ refuses to merge into a trunk somebody is working in, and keeps the branch', async () => {
    const branch = 'multi-agent-controller/t81-busy'
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
  })

  it('says which branch is in the way when the trunk is on another one', async () => {
    const branch = 'multi-agent-controller/t82-elsewhere'
    const { project, taskId, root, ws } = seedLocal(branch)
    git(root, 'switch', '-c', 'operators-own-branch')

    const result = await land(project, taskId, ws, branch, 'commit-and-merge')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('operators-own-branch')
  })

  it('verifies without merging, and says so when there is nothing to verify with', async () => {
    const branch = 'multi-agent-controller/t83-verify'
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
    const branch = 'multi-agent-controller/t84-red'
    const { project, taskId, ws, root } = seedLocal(branch)
    writeFileSync(
      join(root, '.multi_agent_controller', 'project.json'),
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

  it('lets the policy choose the strategy, not the project’s legacy field', () => {
    // ⛔ `makeRepo` writes `landing.strategy: 'auto-land'`. Before 2026-08-30 that field decided
    // what ran, so a project resolved to `pull-request` would still have had its trunk pushed.
    const { project } = seedLocal('multi-agent-controller/t85-which')
    expect(landing.strategyFor(project, 'commit-and-merge').id).toBe('merge-local')
    expect(landing.strategyFor(project, 'commit-and-verify').id).toBe('verify-only')
    expect(landing.strategyFor(project, 'pull-request').id).toBe('pull-request')
    expect(landing.strategyFor(project, 'commit-and-push').id).toBe('auto-land')
    // ⚠️ `custom` is the one that still falls through to the project's own field: the tool is
    // tidying up behind an instruction the agent was given.
    expect(landing.strategyFor(project, 'custom').id).toBe('auto-land')
  })
})

describe('a task that produced no commits', () => {
  it('does not claim to have landed the commit that was already there', async () => {
    const { project, taskId, root } = seedTask('multi-agent-controller/t1-question')
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t1-question'
    })
    expect(result.nothingToLand).toBe(true)
    expect(result.commit).toBeUndefined()
  })

  it('says the trunk was not touched, in those words', async () => {
    const { project, taskId, root } = seedTask('multi-agent-controller/t2-question')
    await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t2-question'
    })
    const said = tasks.messagesFor(taskId).map((m) => m.text).join('\n')
    expect(said).toContain('Nothing to land')
    expect(said).toContain('trunk was not touched')
    // ⛔ And never the sentence that started this. "Landed as <sha>" is what somebody skims.
    expect(said).not.toContain('Landed as')
  })

  it('is a success, so a question that was answered is finished', async () => {
    // ⚠️ Not `awaiting_human`. Falling through to `leave-branch` would have parked every
    // question-only task on a person's desk to be closed by hand.
    const { project, taskId, root } = seedTask('multi-agent-controller/t3-question')
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t3-question'
    })
    expect(result.ok).toBe(true)
    expect(tasks.getTask(taskId)?.status).not.toBe('awaiting_human')
  })

  it('still defers to a task that asked to be checked', async () => {
    // ⛔ "Nothing landed" is an outcome its author wanted to see before it was called done. Skipping
    // the review because the diff turned out empty decides that for them.
    const { project, taskId, root } = seedTask('multi-agent-controller/t4-verify')
    tasks.updateTask(taskId, { verification: 'required' })
    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t4-verify'
    })
    expect(result.nothingToLand).toBeUndefined()
    expect(tasks.getTask(taskId)?.status).toBe('awaiting_human')
  })
})

describe('a task that did commit something', () => {
  it('is not waved through as nothing to land', async () => {
    const { project, taskId, root } = seedTask('multi-agent-controller/t5-real')
    writeFileSync(join(root, 'new.txt'), 'a real change\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'a real change')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t5-real'
    })
    // ⛔ The check is `rev-list --count main..branch`, so one commit is enough to reach the real
    // strategy. Whether that strategy then succeeds is landing's own business and is covered
    // end-to-end by the opt-in L4 run against a real remote.
    expect(result.nothingToLand).toBeUndefined()
    expect(tasks.messagesFor(taskId).map((m) => m.text).join('\n')).not.toContain('Nothing to land')
  })

  it('leaves uncommitted work to the refusal that says where it is', async () => {
    // ⚠️ A dirty workspace with no commits is *not* "nothing to land" — it is work that exists and
    // is about to be destroyed by the next dispatch into a pooled worktree. Collapsing the two
    // would replace an urgent warning with a shrug.
    const { project, taskId, root } = seedTask('multi-agent-controller/t6-dirty')
    writeFileSync(join(root, 'unsaved.txt'), 'not committed\n')

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch: 'multi-agent-controller/t6-dirty'
    })
    expect(result.nothingToLand).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(tasks.messagesFor(taskId).map((m) => m.text).join('\n')).toContain('uncommitted')
  })
})

/**
 * The branch a finish leaves behind.
 *
 * ⛔ Measured 2026-08-29. t22's agent pushed its own commit to `origin/main` — which is what this
 * repo's `/commit` skill tells a worktree to do, and therefore the *normal* outcome here rather than
 * an edge case. The finish correctly reported that there was nothing left to land, and then left
 * `multi-agent-controller/t22-…` sitting in the pool: a branch whose every commit was already on the
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
    const branch = 'multi-agent-controller/t30-retire'
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
    const branch = 'multi-agent-controller/t31-detach'
    const { root } = seedPushedTask(branch)
    const before = git(root, 'rev-parse', 'HEAD')
    expect(git(root, 'rev-parse', 'main')).not.toBe(before)

    await landing.finishWithoutLanding(root, branch, 'main')

    expect(git(root, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  })

  it('says what became of the branch, and names what a resumed task would start from', async () => {
    const branch = 'multi-agent-controller/t32-note'
    const { root } = seedTask(branch)
    const retired = await landing.finishWithoutLanding(root, branch, 'origin/main')

    expect(retired.note).toContain('deleted')
    expect(retired.note).toContain(branch)
    // ⭐ And the base, because "we deleted your branch" without saying what replaces it reads as loss.
    expect(retired.note).toContain('origin/main')
  })

  it('deletes a branch the workspace is not standing on', async () => {
    // A workspace parked between tasks is detached; the branch is still there and still dead.
    const branch = 'multi-agent-controller/t33-parked'
    const { root } = seedTask(branch)
    git(root, 'switch', '--detach', 'main')

    expect((await landing.finishWithoutLanding(root, branch, 'main')).deleted).toBe(true)
    expect(() => git(root, 'rev-parse', '--verify', branch)).toThrow()
  })

  it('leaves a branch another worktree still holds, and does not call that a failure', async () => {
    // ⛔ Untidy is not the same as broken. Git refuses to delete a branch checked out elsewhere, and
    //    a finish that reported failure over it would turn a successful task into a person's problem.
    const branch = 'multi-agent-controller/t34-held'
    const { root } = seedTask(branch)
    git(root, 'switch', '--detach', 'main')
    git(root, 'worktree', 'add', join(dir, 'holder-t34'), branch)

    const retired = await landing.finishWithoutLanding(root, branch, 'main')

    expect(retired.deleted).toBe(false)
    expect(retired.note).toBe('')
    expect(git(root, 'rev-parse', '--verify', branch)).toBeTruthy()
  })

  it('reports false for a branch that is not there, rather than throwing', async () => {
    const { root } = seedTask('multi-agent-controller/t35-gone')
    expect((await landing.finishWithoutLanding(root, 'no-such-branch', 'main')).deleted).toBe(false)
  })
})

describe('landTask on a branch with nothing left to land', () => {
  it('retires the branch on its way out', async () => {
    const branch = 'multi-agent-controller/t36-question'
    const { project, taskId, root } = seedTask(branch)

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.nothingToLand).toBe(true)
    expect(result.branchDeleted).toBe(true)
    expect(() => git(root, 'rev-parse', '--verify', branch)).toThrow()
  })

  it('does the same when the agent landed the work itself, which is the t22 shape', async () => {
    const branch = 'multi-agent-controller/t37-agent-pushed'
    const { project, taskId, root } = seedPushedTask(branch)

    const result = await landing.landTask({
      project,
      task: tasks.requireTask(taskId),
      workspacePath: root,
      branch
    })

    expect(result.nothingToLand).toBe(true)
    expect(result.branchDeleted).toBe(true)
    const said = tasks.messagesFor(taskId).map((m) => m.text).join('\n')
    // ⛔ Names the ref it compared, tells the operator their trunk is behind, and says the branch is
    //    gone. Each on its own leaves a reasonable person with the wrong picture.
    expect(said).toContain('origin/main')
    expect(said).toContain('git pull')
    expect(said).toContain('deleted')
  })

  it('keeps the branch of a task that asked to be verified', async () => {
    // ⛔ The early return does not fire, so nothing is retired. A person is about to look at this.
    const branch = 'multi-agent-controller/t38-verify'
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
    const branch = 'multi-agent-controller/t39-real'
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
    const branch = 'multi-agent-controller/t40-dirty'
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
 * are on `multi-agent-controller/t27-…`, which is intact"* and was parked on a person's desk. The
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

const said = (taskId: string): string => tasks.messagesFor(taskId).map((m) => m.text).join('\n')

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
    const race = seedRace('multi-agent-controller/t26-first', 'multi-agent-controller/t27-second')
    landingQueue.pollMs = 20

    const [a, b] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'multi-agent-controller/t26-first'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'multi-agent-controller/t27-second'
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
    const race = seedRace('multi-agent-controller/t41-a', 'multi-agent-controller/t41-b')
    landingQueue.pollMs = 20

    await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'multi-agent-controller/t41-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'multi-agent-controller/t41-b'
      })
    ])

    for (const id of [race.aTask, race.bTask]) {
      expect(tasks.getTask(id)?.status, id).not.toBe('awaiting_human')
    }
  })

  it('records the ordering as a dependency on whoever was landing', async () => {
    // ⭐ The operator's own ask: the second task should *depend on* the first rather than fail beside
    //    it. The edge outlives the run, so "t27 landed after t26" is answerable afterwards.
    const race = seedRace('multi-agent-controller/t42-a', 'multi-agent-controller/t42-b')
    landingQueue.pollMs = 20

    const [a] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'multi-agent-controller/t42-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'multi-agent-controller/t42-b'
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
    const race = seedRace('multi-agent-controller/t43-a', 'multi-agent-controller/t43-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t43-a'
    })
    await waitUntilQueued(race.aTask)
    expect(tasks.getTask(race.aTask)?.status).not.toBe('blocked')

    lock.release()
    expect((await pending).ok).toBe(true)
  })

  it('waits for a lock that is busy now and free in a moment, then lands', async () => {
    const race = seedRace('multi-agent-controller/t44-a', 'multi-agent-controller/t44-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t44-a'
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
    const race = seedRace('multi-agent-controller/t45-a', 'multi-agent-controller/t45-b')
    landingQueue.pollMs = 10
    const lock = holdTheLock(race.project, 'a-task-that-is-landing')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t45-a'
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
    const race = seedRace('multi-agent-controller/t46-a', 'multi-agent-controller/t46-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 120
    holdTheLock(race.project, 'a-task-that-never-finishes')

    const result = await landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t46-a'
    })

    expect(result.ok).toBe(false)
    expect(tasks.getTask(race.aTask)?.status).toBe('awaiting_human')
    // ⭐ The message the operator acts on. A queue that ran out is a retry, not an investigation, and
    //    the branch is intact either way.
    expect(said(race.aTask)).toContain('Nothing is wrong with the branch')
    expect(git(race.aPath, 'rev-parse', '--verify', 'multi-agent-controller/t46-a')).toBeTruthy()
  })

  // ⚠️ Ten seconds of headroom against a thirty-second budget, so that a build which ignored the
  //    cancel fails on the clock instead of on vitest's default five.
  it('stops waiting when the task is cancelled underneath it', async () => {
    const race = seedRace('multi-agent-controller/t47-a', 'multi-agent-controller/t47-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 30_000
    holdTheLock(race.project, 'a-task-that-never-finishes')

    const started = Date.now()
    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t47-a'
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
    const race = seedRace('multi-agent-controller/t48-a', 'multi-agent-controller/t48-b')
    landingQueue.pollMs = 10
    landingQueue.waitMs = 10_000
    const lock = holdTheLock(race.project, 'not-a-task-id')

    const pending = landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t48-a'
    })
    await waitUntilQueued(race.aTask)
    lock.release()
    const result = await pending

    expect(result.ok, result.reason).toBe(true)
    expect(tasks.requireTask(race.aTask).dependsOn).toHaveLength(0)
  })

  it('refuses to close a cycle, and lands both regardless', async () => {
    const race = seedRace('multi-agent-controller/t49-a', 'multi-agent-controller/t49-b')
    landingQueue.pollMs = 20
    // Whichever of these ends up queueing, the edge it wants may already run the other way.
    tasks.addDependency(race.aTask, race.bTask)

    const [a, b] = await Promise.all([
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.aTask),
        workspacePath: race.aPath,
        branch: 'multi-agent-controller/t49-a'
      }),
      landing.landTask({
        project: race.project,
        task: tasks.requireTask(race.bTask),
        workspacePath: race.bPath,
        branch: 'multi-agent-controller/t49-b'
      })
    ])

    expect(a.ok, a.reason).toBe(true)
    expect(b.ok, b.reason).toBe(true)
    expect(tasks.requireTask(race.bTask).dependsOn).not.toContain(race.aTask)
  })

  it('adds nothing and says nothing when there is no queue', async () => {
    // ⛔ The guard, and it must keep passing when the queue is deleted. A landing that never
    //    contended must not acquire a dependency it did not need, and must not claim it waited.
    const race = seedRace('multi-agent-controller/t50-a', 'multi-agent-controller/t50-b')

    const result = await landing.landTask({
      project: race.project,
      task: tasks.requireTask(race.aTask),
      workspacePath: race.aPath,
      branch: 'multi-agent-controller/t50-a'
    })

    expect(result.ok, result.reason).toBe(true)
    expect(result.contendedWith).toBeUndefined()
    expect(tasks.requireTask(race.aTask).dependsOn).toHaveLength(0)
    expect(said(race.aTask)).not.toContain('Waiting to land')
  })
})
