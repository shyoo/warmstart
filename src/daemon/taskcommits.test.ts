import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Reading a task's landed commits back out of its own thread.
 *
 * ⛔ **The salvage is the only reason 148 already-landed tasks are gradable at all**, and the thing
 * it must never do is attribute somebody else's commit. Every test here is built against a real
 * repository whose `main` contains commits belonging to no task, interleaved with the ones that do.
 *
 * ⛔ **Idempotent and additive.** Running it twice must write nothing the second time, and it must
 * never overwrite what a landing recorded at the time — the landing saw the branch, the salvage is
 * reading a sentence a year later.
 */

let dir: string
let store: typeof import('./db.js')
let commits: typeof import('./taskcommits.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

/** A project row backed by a real repository, because the salvage reads git for every project. */
function makeProject(): { id: string; root: string } {
  seq += 1
  const id = `p${seq}`
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  commit(root, 'initial')
  store
    .db()
    .prepare(
      `insert into projects (id, name, root, vcs, config_json, config_path, created_at)
       values (?, ?, ?, 'git', '{}', null, ?)`
    )
    .run(id, `repo${seq}`, root, Date.now())
  return { id, root }
}

/**
 * One commit on the current branch, returning its full sha.
 *
 * ⚠️ Every commit gets its own author second. Git's author date has one-second resolution, and
 * `task_commits` reads back in author-date order — commits made in the same second in a test would
 * be ordered by sha, which is not the order they happened in.
 */
let clock = 1_700_000_000
function commit(root: string, message: string): string {
  clock += 60
  const when = `${clock} +0000`
  writeFileSync(join(root, `${message.replace(/\W+/g, '-')}.ts`), `export const x = '${message}'\n`)
  git(root, 'add', '-A')
  execFileSync('git', ['commit', '-m', message], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
  })
  return git(root, 'rev-parse', 'HEAD')
}

let taskSeq = 0

/** A task row with the thread message a successful landing writes, and nothing else. */
function landedTask(projectId: string, announcements: Array<{ sha: string; target?: string }>) {
  taskSeq += 1
  const id = `task-${taskSeq}`
  const now = Date.now()
  store
    .db()
    .prepare(
      `insert into tasks
         (id, seq, project_id, title, status, created_by_json, mandate_json, budget_json,
          created_at, updated_at)
       values (?, ?, ?, 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
    )
    .run(id, taskSeq, projectId, now, now)
  const insert = store
    .db()
    .prepare(`insert into task_messages (task_id, role, text, ts) values (?, 'system', ?, ?)`)
  announcements.forEach((a, i) => {
    // ⚠️ The abbreviated spelling the landing actually writes, not the full sha: resolving those
    // seven characters back to a commit is the part of the salvage that can be wrong.
    insert.run(id, `Landed as ${a.sha.slice(0, 8)} onto ${a.target ?? 'main'}.`, now + i)
  })
  return id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskcommits-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  store = await import('./db.js')
  store.openDb(join(dir, 'taskcommits.db'))
  commits = await import('./taskcommits.js')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('salvaging landed commits from the thread', () => {
  it('attributes each landing to the task that announced it, and nothing in between', async () => {
    const project = makeProject()
    const first = commit(project.root, 'the first landing')
    // ⛔ A commit no task claims, sitting directly behind the second landing. Any salvage that
    // walked back from a tip until it hit another task's work would attribute this one.
    commit(project.root, 'somebody elses hand commit')
    const second = commit(project.root, 'the second landing')
    const other = commit(project.root, 'a different tasks landing')

    const twice = landedTask(project.id, [{ sha: first }, { sha: second }])
    const once = landedTask(project.id, [{ sha: other }])

    const report = await commits.salvageLandedCommits()
    expect(report.tasks).toBe(2)
    expect(report.commits).toBe(3)
    expect(report.unresolved).toBe(0)

    expect(commits.taskCommitShas(twice)).toEqual([first, second])
    expect(commits.taskCommitShas(once)).toEqual([other])
    expect(commits.taskCommits(once)[0]?.source).toBe('salvage')
    expect(commits.taskCommits(once)[0]?.target).toBe('main')
  })

  it('fills a range for a single landing and refuses to invent one for two', async () => {
    const project = makeProject()
    const first = commit(project.root, 'landing one')
    commit(project.root, 'unrelated work')
    const second = commit(project.root, 'landing two')
    const parent = git(project.root, 'rev-parse', `${second}^`)
    const only = commit(project.root, 'a single landing')
    const onlyParent = git(project.root, 'rev-parse', `${only}^`)

    const twice = landedTask(project.id, [{ sha: first }, { sha: second }])
    const once = landedTask(project.id, [{ sha: only }])

    await commits.salvageLandedCommits()

    const read = (id: string) =>
      store.db().prepare('select landed_base_sha, landed_head_sha from tasks where id = ?').get(id)

    // ⛔ `parent` is the tip of somebody else's work, so `parent..second` would be an honest-looking
    // range that grades a commit this task never wrote. It must stay null; the rows say it instead.
    expect(read(twice)).toEqual({ landed_base_sha: null, landed_head_sha: second })
    expect(parent).not.toBe(first)
    expect(read(once)).toEqual({ landed_base_sha: onlyParent, landed_head_sha: only })
  })

  it('writes nothing on a second run, and never overwrites what a landing recorded', async () => {
    const project = makeProject()
    const landed = commit(project.root, 'recorded by the landing itself')
    const task = landedTask(project.id, [{ sha: landed }])
    commits.recordTaskCommits(task, [{ sha: landed, subject: 'as the landing saw it' }], 'main')

    const first = await commits.salvageLandedCommits()
    expect(first.commits).toBe(0)
    const second = await commits.salvageLandedCommits()
    expect(second.commits).toBe(0)
    expect(second.tasks).toBe(0)

    const row = commits.taskCommits(task)[0]
    expect(row?.source).toBe('landing')
    expect(row?.subject).toBe('as the landing saw it')
  })

  it('leaves a sha that no longer resolves unattributed rather than guessing', async () => {
    const project = makeProject()
    const gone = landedTask(project.id, [{ sha: 'd'.repeat(40) }])

    const report = await commits.salvageLandedCommits()
    expect(report.unresolved).toBe(1)
    expect(commits.taskCommitShas(gone)).toEqual([])
  })

  it('records the target the message named, not the project trunk', async () => {
    const project = makeProject()
    git(project.root, 'switch', '-c', 'plan/parent')
    const onPlan = commit(project.root, 'a split child landing on its planner')
    git(project.root, 'switch', 'main')
    // The planner lands, so the child's commit reaches main without ever having been on it.
    git(project.root, 'merge', '--ff-only', 'plan/parent')
    git(project.root, 'branch', '-D', 'plan/parent')

    const child = landedTask(project.id, [{ sha: onPlan, target: 'plan/parent' }])
    await commits.salvageLandedCommits()

    expect(commits.taskCommits(child)[0]?.target).toBe('plan/parent')
  })
})

describe('reading commits back', () => {
  it('ignores anything that is not a full sha, so an abbreviation never becomes a row', () => {
    const project = makeProject()
    const task = landedTask(project.id, [])
    expect(commits.recordTaskCommits(task, [{ sha: 'abc1234' }], 'main')).toBe(0)
    expect(commits.taskCommitShas(task)).toEqual([])
  })

  it('reads many tasks in one statement, keyed by task', () => {
    const project = makeProject()
    const a = landedTask(project.id, [])
    const b = landedTask(project.id, [])
    commits.recordTaskCommits(a, [{ sha: 'a'.repeat(40) }], 'main')
    commits.recordTaskCommits(b, [{ sha: 'b'.repeat(40) }], 'main')

    const map = commits.commitsForTasks([a, b, 'no-such-task'])
    expect(map.get(a)?.map((c) => c.sha)).toEqual(['a'.repeat(40)])
    expect(map.get(b)?.map((c) => c.sha)).toEqual(['b'.repeat(40)])
    expect(map.has('no-such-task')).toBe(false)
  })
})
