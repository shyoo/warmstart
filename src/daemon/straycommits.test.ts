import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'

/**
 * A run that committed in a repository its task's landing never looks at.
 *
 * ⛔ **t491, 2026-09-16.** Filed on `sunghwanyoo-site` about a commit in `warmstart-site`; the agent
 * committed the rephrase there, the trunk finish measured `sunghwanyoo-site`, found nothing, and
 * completed the task with *"no commits reached `main`"*. Nothing was pushed. Every case below runs
 * against real git, because git's reflog is what decides.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let workers: typeof import('./workers.js')
let worktrees: typeof import('./worktrees.js')
let activity: typeof import('./activity.js')
let scheduler: typeof import('./scheduler.js')
let stray: typeof import('./straycommits.js')

let seq = 0

function git(cwd: string, ...args: string[]): string {
  return gitAt(undefined, cwd, ...args)
}

/**
 * git with the committer clock set, when `at` is given.
 *
 * ⚠️ A reflog entry is stamped with the committer's time, so this is what puts a fixture's own setup
 * commits *before* a run rather than in the same second as it. `@<seconds> +0000`, not
 * `toISOString()`: git ignores a date with milliseconds in it and stamps the current time instead.
 */
function gitAt(at: Date | undefined, cwd: string, ...args: string[]): string {
  const stamp = at ? `@${Math.floor(at.getTime() / 1000)} +0000` : null
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: stamp ? { ...process.env, GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_DATE: stamp } : process.env
  }).trim()
}

/** A repository whose first commit is an hour old, so it never reads as the run's own. */
function freshRepo(name: string): string {
  const repo = mkdtempSync(join(dir, `${name}-`))
  const anHourAgo = new Date(Date.now() - 3_600_000)
  gitAt(anHourAgo, repo, 'init', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  gitAt(anHourAgo, repo, 'add', '.')
  gitAt(anHourAgo, repo, 'commit', '-m', 'first')
  return repo
}

function commit(repo: string, message: string): string {
  writeFileSync(join(repo, 'a.txt'), `${message}\n`)
  git(repo, 'commit', '-am', message)
  return git(repo, 'rev-parse', 'HEAD')
}

/** Reflog times are whole seconds; a run that starts a second back is unambiguously before. */
const aSecondAgo = (): number => Date.now() - 1000

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-stray-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  workers = await import('./workers.js')
  worktrees = await import('./worktrees.js')
  activity = await import('./activity.js')
  scheduler = await import('./scheduler.js')
  stray = await import('./straycommits.js')
  db.openDb(join(dir, 'stray.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows file locks during cleanup
  }
})

describe('where to look', () => {
  it('takes every absolute path a tool line names, and no URL or relative path', () => {
    const found = stray.candidatePaths([
      '[run: git -C C:\\Dev\\warmstart-site show 26adc0e]',
      '[view_file: C:/Dev/warmstart-site/src/content/blog/post.md]',
      '[run: git -C /home/me/site commit -am "x"]',
      '[fetch: https://www.vals.ai/benchmarks/terminal-bench-2-1]',
      '[view_file: src/daemon/finish.ts]'
    ])
    expect(found).toEqual([
      'C:\\Dev\\warmstart-site',
      'C:/Dev/warmstart-site/src/content/blog/post.md',
      '/home/me/site'
    ])
  })
})

describe('what counts as a stray commit', () => {
  it('finds a commit made during the run in a repository outside the project, and holds for it', async () => {
    const project = freshRepo('project')
    const elsewhere = freshRepo('elsewhere')
    const since = aSecondAgo()
    const sha = commit(elsewhere, 'rephrase the post')

    const strays = await stray.strayCommits({
      lines: [`[run: git -C ${elsewhere} commit -am "rephrase the post"]`],
      since,
      projectRoot: project,
      exclude: []
    })

    expect(strays).toHaveLength(1)
    expect(strays[0]?.commits).toEqual([{ sha, subject: 'rephrase the post', pushed: false }])
    const reason = stray.strayHoldReason(strays)
    expect(reason).toContain(sha.slice(0, 7))
    expect(reason).toContain('does not push another repository')
  })

  it('ignores a repository the run only read, and a commit made before the run began', async () => {
    const project = freshRepo('project')
    const elsewhere = freshRepo('elsewhere')
    commit(elsewhere, 'older than the run')
    const strays = await stray.strayCommits({
      lines: [`[view_file: ${join(elsewhere, 'a.txt')}]`],
      since: Date.now() + 2000,
      projectRoot: project,
      exclude: []
    })
    expect(strays).toEqual([])
  })

  /** ⛔ A pool member another task commits in shares the project's git directory; it is not a stray. */
  it('never reports the project, or a worktree of it, however the path is spelled', async () => {
    const project = freshRepo('project')
    const pool = join(dir, `pool-${++seq}`)
    git(project, 'worktree', 'add', '-b', 'side', pool)
    const since = aSecondAgo()
    commit(project, 'on the trunk')
    commit(pool, 'in a pool member')
    const strays = await stray.strayCommits({
      lines: [`[run: git -C ${project} log]`, `[run: git -C ${pool} log]`],
      since,
      projectRoot: project,
      exclude: []
    })
    expect(strays).toEqual([])
  })

  it('never reports a directory granted to the task', async () => {
    const project = freshRepo('project')
    const granted = freshRepo('granted')
    const since = aSecondAgo()
    commit(granted, 'allowed here')
    const strays = await stray.strayCommits({
      lines: [`[run: git -C ${granted} commit]`],
      since,
      projectRoot: project,
      exclude: [granted]
    })
    expect(strays).toEqual([])
  })

  it('names a stray the agent also pushed, but does not hold for it', async () => {
    const project = freshRepo('project')
    const elsewhere = freshRepo('elsewhere')
    const remote = mkdtempSync(join(dir, 'remote-'))
    git(remote, 'init', '--bare', '-b', 'main')
    git(elsewhere, 'remote', 'add', 'origin', remote)
    const since = aSecondAgo()
    commit(elsewhere, 'pushed already')
    git(elsewhere, 'push', 'origin', 'main')

    const strays = await stray.strayCommits({
      lines: [`[run: git -C ${elsewhere} push]`],
      since,
      projectRoot: project,
      exclude: []
    })
    expect(strays[0]?.commits[0]?.pushed).toBe(true)
    expect(stray.strayHoldReason(strays)).toBeNull()
    expect(stray.strayNote(strays)).toContain('(pushed)')
  })
})

describe('a trunk task that committed somewhere else', () => {
  /** A trunk task on its own project, mid-run, holding the trunk lease — t491's shape. */
  function runningTrunkTask(project: Project) {
    seq += 1
    const worker = workers.createWorker({ adapterId: 'openai-compatible', label: `stray-${seq}`, enabled: false })
    const task = tasks.createTask({
      title: `t${seq}`,
      createdBy: { kind: 'human' },
      projectId: project.id,
      finishPolicy: 'commit-and-push',
      workspaceMode: 'trunk'
    })
    const sessionId = `5e551011-0000-4000-8000-${String(seq).padStart(12, '0')}`
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at, tokens_since_compact)
         values (?, ?, 'openai-compatible', 'stream', ?, 'live', 'work', ?, 0)`
      )
      .run(sessionId, worker.id, project.root, Date.now())
    const run = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId,
      projectId: project.id,
      quotaUnverified: true,
      costModelId: null,
      trunkShaBefore: git(project.root, 'rev-parse', 'HEAD')
    })
    db.db().prepare('update runs set started_at = ? where id = ?').run(aSecondAgo(), run.id)
    const workspace = worktrees.claimTrunk(project, task.id)
    if (!workspace) throw new Error('the trunk lease was not free')
    scheduler.workspaces.set(sessionId, { workspace, projectId: project.id })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })
    return { task, run, sessionId }
  }

  it('holds for a person instead of finishing as "no commits reached main"', async () => {
    const project = projects.addProject({ root: freshRepo('site-a'), name: `site-a-${++seq}` })
    const elsewhere = freshRepo('site-b')
    const { task, run, sessionId } = runningTrunkTask(project)

    activity.noteActivity(task.id, `[run: git -C ${elsewhere} commit -am "Rephrase the post"]`, run.id)
    const sha = commit(elsewhere, 'Rephrase the post')

    await scheduler.completeTask(sessionId, 'Rephrased the post in plain English.')

    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('awaiting_human')
    expect(after.holdReason).toContain(sha.slice(0, 7))
    const said = tasks.messagesFor(task.id).filter((m) => m.role === 'system').map((m) => m.text)
    expect(said.some((text) => text.startsWith('Not finished: this run committed outside its project'))).toBe(true)
    expect(said.some((text) => text.includes('no commits reached'))).toBe(false)
  })

  it('still finishes a trunk task whose run touched no other repository', async () => {
    const project = projects.addProject({ root: freshRepo('site-c'), name: `site-c-${++seq}` })
    const { task, run, sessionId } = runningTrunkTask(project)
    activity.noteActivity(task.id, `[view_file: ${join(project.root, 'a.txt')}]`, run.id)

    await scheduler.completeTask(sessionId, 'Answered the question.')

    expect(tasks.requireTask(task.id).status).toBe('completed')
  })
})
