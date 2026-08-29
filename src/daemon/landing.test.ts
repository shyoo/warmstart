import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

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
