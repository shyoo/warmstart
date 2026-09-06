import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'

/**
 * Finding the diff of a task, and refusing when there is not one.
 *
 * ⛔ **Real git in a temporary repository.** The whole question here is what survives `git branch -D`
 * after a fast-forward merge, so a test that stubbed git would pass against a version that cannot
 * answer at all. Rungs 1 and 2 exist precisely because rung 3 stops working the moment a task lands.
 *
 * ⛔ **Rung 4 is a refusal, not a fallback.** A review of the wrong commits produces a number that
 * looks exactly like a real one and is indistinguishable from one later, so there is no rung that
 * guesses.
 *
 * ⛔ **Rung 1 is the one that can be exact for a task that landed twice.** A range cannot be: the
 * second landing's base is wherever the trunk had got to, so `base..head` across the pair contains
 * whatever landed in between. The last test in the ladder below is that case, built commit by
 * commit, and it fails against any version that answers it with a range.
 */

let dir: string
let review: typeof import('./review.js')
let store: typeof import('./db.js')
let commitStore: typeof import('./taskcommits.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

function makeRepo(): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'kept.txt'), 'one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return {
    id: `p${seq}`,
    name: `repo${seq}`,
    root,
    vcs: 'git',
    config: {} as Project['config'],
    configPath: null,
    createdAt: 0,
    archivedAt: null
  }
}

/** A branch with one commit on it, left in place. */
function branchWithWork(project: Project, branch: string): { base: string; head: string } {
  const root = project.root
  const base = git(root, 'rev-parse', 'HEAD')
  git(root, 'switch', '-c', branch)
  writeFileSync(join(root, 'feature.ts'), 'export const answer = 42\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'add the feature')
  const head = git(root, 'rev-parse', 'HEAD')
  git(root, 'switch', 'main')
  return { base, head }
}

const task = (over: Partial<Task>): Pick<Task, 'landedBaseSha' | 'landedHeadSha' | 'branch'> => ({
  landedBaseSha: null,
  landedHeadSha: null,
  branch: null,
  ...over
})

/**
 * A task row with commits recorded against it, which is what rung 1 reads.
 *
 * ⚠️ A real row rather than a stub object: `task_commits.task_id` is a foreign key with
 * `on delete cascade`, and `pragma foreign_keys` is on, so a stub would be rejected by the schema
 * this feature actually ships. The columns set here are exactly the not-null ones.
 */
let taskSeq = 0
function taskWithCommits(
  shas: string[],
  over: Partial<Task> = {}
): Pick<Task, 'landedBaseSha' | 'landedHeadSha' | 'branch'> & { id: string } {
  taskSeq += 1
  const id = `task-${taskSeq}`
  const now = Date.now()
  store
    .db()
    .prepare(
      `insert into tasks
         (id, seq, title, status, created_by_json, mandate_json, budget_json, created_at, updated_at)
       values (?, ?, 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
    )
    .run(id, taskSeq, now, now)
  commitStore.recordTaskCommits(
    id,
    shas.map((sha) => ({ sha })),
    'main'
  )
  return { id, ...task(over) }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-reviewdiff-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  store = await import('./db.js')
  store.openDb(join(dir, 'reviewdiff.db'))
  review = await import('./review.js')
  commitStore = await import('./taskcommits.js')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the resolution ladder', () => {
  it('rung 1: recorded commits answer after the branch is gone, and outrank the range', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')
    git(project.root, 'merge', '--ff-only', 'feature')
    git(project.root, 'branch', '-D', 'feature')

    // ⛔ A range that would review the wrong thing is recorded alongside the commits, and the
    // commits win. That ordering is the whole reason rung 1 sits above rung 2: t192 has a base 39
    // commits behind its head, written by a second landing overwriting the first landing's base.
    const subject = taskWithCommits([head], {
      landedBaseSha: 'f'.repeat(40),
      landedHeadSha: 'e'.repeat(40),
      branch: 'feature'
    })
    const range = await review.resolveRange(subject, project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('commits')
    expect(range.commits).toEqual([head])
    expect(range.base).toBe(base)
    expect(range.head).toBe(head)
  })

  it('rung 1: two landings with someone else’s work between them grade only their own commits', async () => {
    const project = makeRepo()
    const root = project.root
    // The task's first landing.
    writeFileSync(join(root, 'mine-one.ts'), 'export const one = 1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'my first landing')
    const first = git(root, 'rev-parse', 'HEAD')
    // Another task lands between the two, which is the case a range cannot describe.
    writeFileSync(join(root, 'theirs.ts'), 'export const theirs = true\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'somebody else entirely')
    // And the fix this task was asked for on the same thread.
    writeFileSync(join(root, 'mine-two.ts'), 'export const two = 2\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'my second landing')
    const second = git(root, 'rev-parse', 'HEAD')

    const subject = taskWithCommits([first, second])
    const range = await review.resolveRange(subject, project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('commits')
    expect(range.commits).toEqual([first, second])

    const diff = await review.collectDiff(range.cwd, range.base, range.head, range.commits)
    // ⛔ Two files, not three. `base..head` here spans all three commits; the recorded list does not,
    // and grading `theirs.ts` as this task's work is the failure the whole ladder exists to refuse.
    expect(diff.files).toBe(2)
    expect(diff.text).toContain('mine-one.ts')
    expect(diff.text).toContain('mine-two.ts')
    expect(diff.text).not.toContain('theirs.ts')
    expect(diff.text).toContain('landed 2 separate commits')
  })

  it('rung 1 falls through when a recorded commit no longer reaches the trunk', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')
    git(project.root, 'merge', '--ff-only', 'feature')
    git(project.root, 'branch', '-D', 'feature')

    // ⚠️ One reachable commit and one that never existed. Half a task's commits is not half a
    // review — it is a whole review of part of the work, arriving with no sign that it is partial.
    const subject = taskWithCommits([head, 'a'.repeat(40)], {
      landedBaseSha: base,
      landedHeadSha: head
    })
    const range = await review.resolveRange(subject, project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('landed')
  })

  it('rung 2: a recorded range still answers after the branch has been deleted', () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')
    // Exactly what landing does: fast-forward, then destroy the branch.
    git(project.root, 'merge', '--ff-only', 'feature')
    git(project.root, 'branch', '-D', 'feature')

    return review
      .resolveRange(task({ landedBaseSha: base, landedHeadSha: head, branch: 'feature' }), project, 'main')
      .then((range) => {
        expect(range.ok).toBe(true)
        if (!range.ok) return
        expect(range.from).toBe('landed')
        expect(range.base).toBe(base)
        expect(range.head).toBe(head)
      })
  })

  it('rung 3: an unlanded task is reviewed from its branch against the landing target', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')
    const range = await review.resolveRange(task({ branch: 'feature' }), project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('branch')
    expect(range.base).toBe(base)
    expect(range.head).toBe(head)
  })

  it('rung 3 measures from the merge base, so a trunk that moved on is not counted as the task’s', async () => {
    const project = makeRepo()
    const { base } = branchWithWork(project, 'feature')
    // Somebody else lands on main after this branch was cut.
    writeFileSync(join(project.root, 'unrelated.ts'), 'export const x = 1\n')
    git(project.root, 'add', '-A')
    git(project.root, 'commit', '-m', 'somebody else')

    const range = await review.resolveRange(task({ branch: 'feature' }), project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    // ⛔ The merge base, not main's tip. Diffing from the tip would report the unrelated commit as a
    // deletion by this task, and dimension 5 would score it as a sweeping unrequested rewrite.
    expect(range.base).toBe(base)
    const diff = await review.collectDiff(range.cwd, range.base, range.head)
    expect(diff.files).toBe(1)
  })

  it('rung 2: a split child remains reviewable after its planner branch lands and is retired', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'planner')
    git(project.root, 'merge', '--ff-only', 'planner')
    git(project.root, 'branch', '-D', 'planner')

    const range = await review.resolveRange(
      task({ landedBaseSha: base, landedHeadSha: head, branch: 'child' }),
      project,
      'planner',
      'main'
    )
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('landed')
    expect(range.base).toBe(base)
    expect(range.head).toBe(head)
  })

  it('rung 4: a landed task with nothing recorded and no branch is refused, never guessed', async () => {
    const project = makeRepo()
    branchWithWork(project, 'feature')
    git(project.root, 'merge', '--ff-only', 'feature')
    git(project.root, 'branch', '-D', 'feature')

    const range = await review.resolveRange(task({ branch: 'feature' }), project, 'main')
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toContain('landed nothing that can still be identified')
  })

  it('rung 4: a recorded range that no longer resolves says so, rather than falling back', async () => {
    const project = makeRepo()
    const range = await review.resolveRange(
      task({ landedBaseSha: 'f'.repeat(40), landedHeadSha: 'e'.repeat(40) }),
      project,
      'main'
    )
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toContain('no longer resolves')
  })

  it('refuses recorded commits that exist but were never landed on the configured trunk', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')

    const range = await review.resolveRange(
      task({ landedBaseSha: base, landedHeadSha: head }),
      project,
      'main'
    )
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toContain('no longer resolves in the trunk')
  })
})

describe('assembling the diff', () => {
  it('counts every changed file and reports the insertions and deletions', async () => {
    const project = makeRepo()
    const base = git(project.root, 'rev-parse', 'HEAD')
    writeFileSync(join(project.root, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(join(project.root, 'kept.txt'), 'one\ntwo\n')
    git(project.root, 'add', '-A')
    git(project.root, 'commit', '-m', 'two files')
    const head = git(project.root, 'rev-parse', 'HEAD')

    const diff = await review.collectDiff(project.root, base, head)
    expect(diff.files).toBe(2)
    expect(diff.insertions).toBe(3)
    expect(diff.truncated).toBe(false)
    expect(diff.text).toContain('a.ts')
    expect(diff.text).toContain('export const a = 1')
  })

  it('lists a lockfile with its line counts and never inlines it', async () => {
    const project = makeRepo()
    const base = git(project.root, 'rev-parse', 'HEAD')
    writeFileSync(
      join(project.root, 'package-lock.json'),
      `{"lockfileVersion":3,"packages":{${'"x":1,'.repeat(200)}"y":2}}\n`
    )
    writeFileSync(join(project.root, 'real.ts'), 'export const real = true\n')
    git(project.root, 'add', '-A')
    git(project.root, 'commit', '-m', 'lock plus code')
    const head = git(project.root, 'rev-parse', 'HEAD')

    const diff = await review.collectDiff(project.root, base, head)
    expect(diff.files).toBe(2)
    // ⚠️ Named with its size — a judge should know the lockfile moved — but not spent tokens on.
    expect(diff.text).toContain('package-lock.json | +1/-0 (generated or binary, not shown)')
    expect(diff.text).toContain('export const real = true')
    expect(diff.truncated).toBe(true)
  })

  it('reports an empty range as no files rather than failing', async () => {
    const project = makeRepo()
    const head = git(project.root, 'rev-parse', 'HEAD')
    const diff = await review.collectDiff(project.root, head, head)
    expect(diff.files).toBe(0)
    expect(diff.insertions).toBe(0)
    expect(diff.truncated).toBe(false)
  })
})
