import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Taking a false landing back off the task it was pinned on (t734).
 *
 * ⛔ **What this sweep answers for.** t731 committed nothing and was reported as landing t729's
 * `ab96d6f5`, which `task_commits` then recorded as t731's; on a copy of the live database the same
 * shape turned up on 19 tasks with 32 completed quality reviews of work those tasks did not write.
 * Every test here uses a real repository, because one of the two proofs is a question for git.
 *
 * ⛔ **And what it must never do**: take a commit off the task that wrote it, touch a person's own
 * rating, or be undone by the next boot's salvage.
 */

let dir: string
let store: typeof import('./db.js')
let commits: typeof import('./taskcommits.js')
let disown: typeof import('./disown.js')
let tasks: typeof import('./tasks.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0
let clock = 1_700_000_000

function commit(root: string, message: string): string {
  clock += 60
  const when = `${clock} +0000`
  writeFileSync(join(root, `${message.replace(/\W+/g, '-')}.txt`), `${message}\n`)
  git(root, 'add', '-A')
  execFileSync('git', ['commit', '-m', message], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
  })
  return git(root, 'rev-parse', 'HEAD')
}

function makeProject(): { id: string; root: string } {
  seq += 1
  const id = `disown-p${seq}`
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

let taskSeq = 1000

/** A completed task, its first run's trunk reading, and the *Landed as* line its landing wrote. */
function landedTask(projectId: string, opts: { trunkBefore?: string; announced?: string } = {}): string {
  taskSeq += 1
  const id = `disown-task-${taskSeq}`
  const now = Date.now()
  store
    .db()
    .prepare(
      `insert into tasks (id, seq, project_id, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?, ?, ?, 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
    )
    .run(id, taskSeq, projectId, now, now)
  if (opts.trunkBefore) {
    store
      .db()
      .prepare(`insert into runs (id, task_id, worker_id, started_at, trunk_sha_before) values (?, ?, 'w', ?, ?)`)
      .run(`${id}-run`, id, now, opts.trunkBefore)
  }
  if (opts.announced) {
    store
      .db()
      .prepare(`insert into task_messages (task_id, role, text, event, ts) values (?, 'system', ?, 'landing.landed', ?)`)
      .run(id, `Landed as \`${opts.announced.slice(0, 8)}\` onto \`main\` — local only, **not pushed**`, now)
  }
  return id
}

/** Recorded one after another, so the earlier claim really is earlier. */
async function record(taskId: string, shas: string[], target = 'main'): Promise<void> {
  commits.recordTaskCommits(taskId, shas.map((sha) => ({ sha })), target)
  await new Promise((r) => setTimeout(r, 5))
}

function grade(taskId: string, composite: number, status = 'complete'): string {
  const id = `review-${taskId}-${composite}-${status}`
  store
    .db()
    .prepare(
      `insert into quality_reviews (id, task_id, run_id, reviewer_worker_id, reviewer_adapter, subject_adapter,
                                    composite, status, rubric_version, created_at, completed_at)
       values (?, ?, 'r', 'w', 'codex', 'claude-code', ?, ?, '1.0', ?, ?)`
    )
    .run(id, taskId, composite, status, Date.now(), Date.now())
  store
    .db()
    .prepare('update tasks set quality_review_score = ?, quality_review_count = 1 where id = ?')
    .run(composite, taskId)
  return id
}

const statusOf = (reviewId: string): string =>
  (store.db().prepare('select status from quality_reviews where id = ?').get(reviewId) as { status: string }).status

const shasOf = (taskId: string): string[] => commits.taskCommits(taskId).map((c) => c.sha)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-disown-'))
  process.env.WARMSTART_DATA_DIR = dir
  store = await import('./db.js')
  store.openDb(join(dir, 'disown.db'))
  commits = await import('./taskcommits.js')
  disown = await import('./disown.js')
  tasks = await import('./tasks.js')
})

afterAll(() => {
  store.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the t731 shape: a landing that moved nothing', () => {
  it('takes the other task’s commit off, revokes the grade, and says so on the thread', async () => {
    const project = makeProject()
    const t729sCommit = commit(project.root, 't729 emotion audit')
    const t729 = landedTask(project.id, { announced: t729sCommit })
    await record(t729, [t729sCommit])
    const t731 = landedTask(project.id, { trunkBefore: t729sCommit, announced: t729sCommit })
    await record(t731, [t729sCommit])
    store.db().prepare('update tasks set landed_base_sha = ?, landed_head_sha = ? where id = ?').run(t729sCommit, t729sCommit, t731)
    const review = grade(t731, 8)
    const t729Review = grade(t729, 7)

    const report = await disown.disownForeignCommits()

    expect(report).toMatchObject({ tasks: 1, commits: 1, reviewsRevoked: 1 })
    expect(shasOf(t731)).toEqual([])
    // ⛔ The task that wrote it keeps it, and its own grade.
    expect(shasOf(t729)).toEqual([t729sCommit])
    expect(statusOf(t729Review)).toBe('complete')
    // Revoked, kept, and out of the score.
    expect(statusOf(review)).toBe('revoked')
    const row = tasks.requireTask(t731)
    expect(row.qualityScore).toBeNull()
    expect(row.qualityReviewCount).toBe(0)
    expect(row.landedBaseSha).toBeNull()
    expect(row.landedHeadSha).toBeNull()
    const line = tasks.messagesFor(t731).find((m) => m.event === 'landing.corrected')
    expect(line?.text).toBe('Correction: this task landed nothing of its own')
    expect(line?.detail).toContain(t729sCommit.slice(0, 8))
    expect(line?.detail).toContain(`landed earlier by t${taskSeq - 1}`)
    expect(line?.detail).toContain('1 quality review(s)')
  })

  it('is not undone by the next boot’s salvage, and a second sweep does nothing', async () => {
    const project = makeProject()
    const theirs = commit(project.root, 'somebody elses landing')
    const owner = landedTask(project.id, { announced: theirs })
    await record(owner, [theirs])
    const emptyTask = landedTask(project.id, { trunkBefore: theirs, announced: theirs })
    await record(emptyTask, [theirs])
    await disown.disownForeignCommits()

    // ⛔ Salvage re-reads the *Landed as* line on every boot. It must not write the row back.
    await commits.salvageLandedCommits()
    expect(shasOf(emptyTask)).toEqual([])
    const again = await disown.disownForeignCommits()
    expect(again).toMatchObject({ tasks: 0, commits: 0, reviewsRevoked: 0 })
    expect(tasks.messagesFor(emptyTask).filter((m) => m.event === 'landing.corrected')).toHaveLength(1)
  })
})

describe('the second proof: already on the target before the task started', () => {
  it('takes off a commit that was an ancestor of the trunk at the first run, and keeps the task’s own', async () => {
    // t221's shape: nobody else recorded `edfa27e`, but it was the trunk when t221's run began.
    const project = makeProject()
    const before = commit(project.root, 'unclaimed hand commit')
    const mine = commit(project.root, 'the work this task did')
    const task = landedTask(project.id, { trunkBefore: before })
    await record(task, [before, mine])
    const review = grade(task, 8.8)

    const report = await disown.disownForeignCommits({ ancestry: true })

    expect(report.tasks).toBe(1)
    expect(shasOf(task)).toEqual([mine])
    expect(statusOf(review)).toBe('revoked')
    const line = tasks.messagesFor(task).find((m) => m.event === 'landing.corrected')
    expect(line?.text).toBe("Correction: 1 of 2 commits recorded for this task were another task's")
    expect(line?.detail).toContain('before this task')
    expect(line?.detail).toContain('Its own 1 commit(s) remain and can be reviewed again')
    // The range is re-derived from what is left: exactly the task's one commit.
    const row = tasks.requireTask(task)
    expect(row.landedHeadSha).toBe(mine)
    expect(row.landedBaseSha).toBe(before)
  })

  it('runs once per database unless asked, since it costs a git call per row', async () => {
    const project = makeProject()
    const before = commit(project.root, 'already there')
    const task = landedTask(project.id, { trunkBefore: before })
    await record(task, [before])
    // The previous test swept ancestry and marked it done, so a plain boot leaves this alone…
    expect((await disown.disownForeignCommits()).tasks).toBe(0)
    expect(shasOf(task)).toEqual([before])
    // …and an explicit pass finds it.
    expect((await disown.disownForeignCommits({ ancestry: true })).tasks).toBe(1)
    expect(shasOf(task)).toEqual([])
  })
})

describe('what the sweep must leave alone', () => {
  it('a task whose commits are all its own', async () => {
    const project = makeProject()
    const before = commit(project.root, 'the trunk at dispatch')
    const mine = commit(project.root, 'honest work')
    const task = landedTask(project.id, { trunkBefore: before })
    await record(task, [mine])
    const review = grade(task, 9)
    expect((await disown.disownForeignCommits({ ancestry: true })).tasks).toBe(0)
    expect(shasOf(task)).toEqual([mine])
    expect(statusOf(review)).toBe('complete')
  })

  it('a planner carrying its pieces’ commits onto the trunk', async () => {
    // ⛔ A split child lands onto the plan branch; the planner later lands that branch onto `main`.
    // Same sha, different target — the planner's claim is not a second owner of the same landing.
    const project = makeProject()
    const piece = commit(project.root, 'a piece of the plan')
    const child = landedTask(project.id)
    await record(child, [piece], 'warmstart/t9-plan')
    const planner = landedTask(project.id)
    await record(planner, [piece], 'main')
    expect((await disown.disownForeignCommits()).tasks).toBe(0)
    expect(shasOf(planner)).toEqual([piece])
  })

  it('a person’s own rating, and a grade that never produced a number', async () => {
    const project = makeProject()
    const theirs = commit(project.root, 'the owner’s work')
    const owner = landedTask(project.id)
    await record(owner, [theirs])
    const task = landedTask(project.id)
    await record(task, [theirs])
    const failed = grade(task, 0, 'failed')
    store
      .db()
      .prepare(
        `insert into manual_reviews (id, task_id, subject_adapter, score, explanation, created_at)
         values ('manual-1', ?, 'claude-code', 6, 'looked fine', ?)`
      )
      .run(task, Date.now())
    await disown.disownForeignCommits()
    expect(statusOf(failed)).toBe('failed')
    const manual = store.db().prepare('select score from manual_reviews where id = ?').get('manual-1') as { score: number }
    expect(manual.score).toBe(6)
  })
})

describe('recording commits a task has been shown not to own', () => {
  it('writes nothing for a disowned pair, and still writes the task’s other commits', async () => {
    const project = makeProject()
    const foreign = commit(project.root, 'not mine')
    const mine = commit(project.root, 'mine')
    const task = landedTask(project.id)
    store
      .db()
      .prepare(`insert into disowned_commits (task_id, sha, reason, disowned_at) values (?, ?, 'test', ?)`)
      .run(task, foreign, Date.now())
    const written = commits.recordTaskCommits(task, [{ sha: foreign }, { sha: mine }], 'main')
    expect(written).toBe(1)
    expect(shasOf(task)).toEqual([mine])
  })
})
