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
