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
 * answer at all. Rung 1 exists precisely because rung 2 stops working the moment a task lands.
 *
 * ⛔ **Rung 3 is a refusal, not a fallback.** A review of the wrong commits produces a number that
 * looks exactly like a real one and is indistinguishable from one later, so there is no rung that
 * guesses. Every task that landed before the range was recorded gets this answer, permanently.
 */

let dir: string
let review: typeof import('./review.js')

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-reviewdiff-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  const db = await import('./db.js')
  db.openDb(join(dir, 'reviewdiff.db'))
  review = await import('./review.js')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the resolution ladder', () => {
  it('rung 1: a recorded range still answers after the branch has been deleted', () => {
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

  it('rung 2: an unlanded task is reviewed from its branch against the landing target', async () => {
    const project = makeRepo()
    const { base, head } = branchWithWork(project, 'feature')
    const range = await review.resolveRange(task({ branch: 'feature' }), project, 'main')
    expect(range.ok).toBe(true)
    if (!range.ok) return
    expect(range.from).toBe('branch')
    expect(range.base).toBe(base)
    expect(range.head).toBe(head)
  })

  it('rung 2 measures from the merge base, so a trunk that moved on is not counted as the task’s', async () => {
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

  it('rung 1: a split child remains reviewable after its planner branch lands and is retired', async () => {
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

  it('rung 3: a landed task with no recorded range and no branch is refused, never guessed', async () => {
    const project = makeRepo()
    branchWithWork(project, 'feature')
    git(project.root, 'merge', '--ff-only', 'feature')
    git(project.root, 'branch', '-D', 'feature')

    const range = await review.resolveRange(task({ branch: 'feature' }), project, 'main')
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toContain('landed before its commit range was recorded')
  })

  it('rung 3: a recorded range that no longer resolves says so, rather than falling back', async () => {
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
