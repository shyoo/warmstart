import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'

/**
 * The diff a person reads before pressing Land.
 *
 * ⛔ **Real git in a temporary repository.** Every claim here is about what `git diff` actually
 * prints — how it quotes a non-ASCII path, what `--numstat -z` does to a rename, whether a pathspec
 * with a bracket in it matches the file of that name — and a stubbed git would agree with whatever
 * the code believed. Two of the tests below fail against the plain `split('\t')` and the bare
 * pathspec this replaced.
 *
 * ⛔ **The cache trap that is not one.** `resolveRange`'s rung 3 returns the branch answer *without*
 * writing `rangeCache`, so a branch that advances between two reads is re-resolved each time. That
 * was worth checking rather than assuming — the cache key holds the branch name and not its head
 * sha, so had rung 3 cached, a moving branch would have served a stale head forever. The test pins
 * the behaviour rather than the reasoning.
 */

let dir: string
let taskdiff: typeof import('./taskdiff.js')
let kit: typeof import('./testkit.js')
let tasks: typeof import('./tasks.js')
let review: typeof import('./review.js')

let seq = 0

/** A project whose branch `feature` carries one commit that has not landed. */
function projectWithBranch(files: Record<string, string>): { project: Project; task: Task } {
  seq += 1
  const project = kit.makeProject({ dir, name: `repo${seq}` })
  const branch = `warmstart/t${seq}-work`
  kit.git(project.root, 'switch', '-c', branch)
  for (const [name, content] of Object.entries(files)) {
    const at = join(project.root, name)
    mkdirSync(join(at, '..'), { recursive: true })
    writeFileSync(at, content)
  }
  kit.git(project.root, 'add', '-A')
  kit.git(project.root, 'commit', '-m', 'the work')
  kit.git(project.root, 'switch', 'main')
  const task = kit.makeTask({ projectId: project.id })
  // `setTaskBranch`, not `updateTask`: the branch and its unit are one fact and only this writes both.
  tasks.setTaskBranch(task.id, branch, seq)
  return { project, task: tasks.requireTask(task.id) }
}

beforeAll(async () => {
  // ⛔ The data directory is set before the first import, the way `reviewdiff.test.ts` does it: a
  // module that reads `paths` while being evaluated would otherwise capture the real one.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-taskdiff-'))
  process.env.WARMSTART_DATA_DIR = dir
  const store = await import('./db.js')
  store.openDb(join(dir, 'taskdiff.db'))
  kit = await import('./testkit.js')
  taskdiff = await import('./taskdiff.js')
  tasks = await import('./tasks.js')
  review = await import('./review.js')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the summary', () => {
  it('lists an unlanded branch’s files, with the totals over every entry', async () => {
    const { task } = projectWithBranch({ 'feature.ts': 'export const answer = 42\n' })

    const summary = await taskdiff.diffSummaryFor(task.id)

    expect(summary.ok).toBe(true)
    expect(summary.from).toBe('branch')
    expect(summary.files.map((f) => f.path)).toEqual(['feature.ts'])
    expect(summary.insertions).toBe(1)
    expect(summary.deletions).toBe(0)
    expect(summary.filesTruncated).toBe(false)
    expect(summary.separateCommits).toBe(0)
  })

  it('re-reads a branch that advanced between two calls', async () => {
    const { project, task } = projectWithBranch({ 'first.ts': 'export const a = 1\n' })

    const before = await taskdiff.diffSummaryFor(task.id)
    expect(before.files.map((f) => f.path)).toEqual(['first.ts'])

    kit.git(project.root, 'switch', task.branch as string)
    writeFileSync(join(project.root, 'second.ts'), 'export const b = 2\n')
    kit.git(project.root, 'add', '-A')
    kit.git(project.root, 'commit', '-m', 'more work')
    kit.git(project.root, 'switch', 'main')

    // ⛔ The whole point: had rung 3 cached, this would still say one file.
    const after = await taskdiff.diffSummaryFor(task.id)
    expect(after.files.map((f) => f.path).sort()).toEqual(['first.ts', 'second.ts'])
    expect(after.head).not.toBe(before.head)
  })

  it('refuses, with a reason, when nothing identifies the change', async () => {
    seq += 1
    const project = kit.makeProject({ dir, name: `repo${seq}` })
    const task = kit.makeTask({ projectId: project.id })

    const summary = await taskdiff.diffSummaryFor(task.id)

    expect(summary.ok).toBe(false)
    expect(summary.reason.length).toBeGreaterThan(0)
    expect(summary.files).toEqual([])
  })

  it('reports an unreadable workspace as unknown, not as zero uncommitted files', async () => {
    const { task } = projectWithBranch({ 'feature.ts': 'export const answer = 42\n' })

    const summary = await taskdiff.diffSummaryFor(task.id)

    // No pooled worktree holds this branch, so the tree genuinely cannot be read. ⛔ That must not
    // render as "nothing uncommitted here", which is the sentence that loses somebody's files.
    expect(summary.workspaceReadable).toBe(false)
    expect(summary.uncommittedFiles).toBe(0)
  })
})

describe('paths git does not hand back plainly', () => {
  it('reads a non-ASCII path verbatim rather than C-quoted', async () => {
    // ⛔ Fails against `--numstat` without `-z`: git returns `"caf\303\251.txt"`, quotes and all,
    // and the panel then lists a name whose patch comes back empty.
    const { task } = projectWithBranch({ 'café.txt': 'une ligne\n' })

    const summary = await taskdiff.diffSummaryFor(task.id)
    expect(summary.files.map((f) => f.path)).toEqual(['café.txt'])

    const file = await taskdiff.diffFileFor(task.id, 'café.txt')
    expect(file.ok).toBe(true)
    expect(file.patch).toContain('une ligne')
  })

  it('reads a path containing glob characters as a literal name', async () => {
    // ⚠️ A bare pathspec also finds this file, because git matches literally as well as by glob —
    // measured 2026-09-12. `:(literal)` is here for the *over*-match: a name like `*.tsx` returns
    // every `.tsx` file's patch under the heading of the one file somebody opened.
    const { task } = projectWithBranch({ 'src/[id].tsx': 'export default null\n' })

    const summary = await taskdiff.diffSummaryFor(task.id)
    expect(summary.files.map((f) => f.path)).toEqual(['src/[id].tsx'])

    const file = await taskdiff.diffFileFor(task.id, 'src/[id].tsx')
    expect(file.ok).toBe(true)
    expect(file.patch).toContain('export default null')
  })

  it('keeps the new name of a renamed file', async () => {
    const { project, task } = projectWithBranch({ 'before.ts': 'export const kept = 1\n'.repeat(20) })
    kit.git(project.root, 'switch', task.branch as string)
    kit.git(project.root, 'mv', 'before.ts', 'after.ts')
    kit.git(project.root, 'commit', '-m', 'rename it')
    kit.git(project.root, 'switch', 'main')

    const summary = await taskdiff.diffSummaryFor(task.id)

    // The rename record is the one with a different shape under `-z`; the new name is what exists.
    expect(summary.files.map((f) => f.path)).toContain('after.ts')
    expect(summary.files.map((f) => f.path)).not.toContain('')
  })
})

describe('what is counted but never shown', () => {
  it('marks a binary file and refuses to inline it', async () => {
    const { project, task } = projectWithBranch({ 'keep.txt': 'text\n' })
    kit.git(project.root, 'switch', task.branch as string)
    writeFileSync(join(project.root, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7]))
    kit.git(project.root, 'add', '-A')
    kit.git(project.root, 'commit', '-m', 'add a binary')
    kit.git(project.root, 'switch', 'main')

    const summary = await taskdiff.diffSummaryFor(task.id)
    const entry = summary.files.find((f) => f.path === 'logo.bin')
    expect(entry?.binary).toBe(true)

    const file = await taskdiff.diffFileFor(task.id, 'logo.bin')
    expect(file.ok).toBe(false)
    expect(file.reason).toContain('binary')
  })

  it('marks a lockfile generated and refuses to inline it', async () => {
    const { task } = projectWithBranch({ 'package-lock.json': '{"lockfileVersion":3}\n' })

    const summary = await taskdiff.diffSummaryFor(task.id)
    expect(summary.files.find((f) => f.path === 'package-lock.json')?.generated).toBe(true)

    const file = await taskdiff.diffFileFor(task.id, 'package-lock.json')
    expect(file.ok).toBe(false)
    expect(file.reason).toContain('generated')
  })

  it('refuses a path that is not part of the change', async () => {
    const { task } = projectWithBranch({ 'feature.ts': 'export const answer = 42\n' })

    // ⛔ The renderer names the path, so the method must not read whatever it is handed.
    const file = await taskdiff.diffFileFor(task.id, '../../../etc/passwd')

    expect(file.ok).toBe(false)
    expect(file.patch).toBe('')
  })
})

describe('the truncation boundary', () => {
  it('cuts an oversized patch at a line boundary and reports the full size', async () => {
    const line = 'export const padding = "'.padEnd(120, 'x') + '"\n'
    const huge = line.repeat(Math.ceil((taskdiff.MAX_PATCH_CHARS * 1.5) / line.length))
    const { task } = projectWithBranch({ 'huge.ts': huge })

    const file = await taskdiff.diffFileFor(task.id, 'huge.ts')

    expect(file.ok).toBe(true)
    expect(file.truncated).toBe(true)
    expect(file.patch.length).toBeLessThanOrEqual(taskdiff.MAX_PATCH_CHARS)
    // ⛔ The size reported is the whole patch, so the panel can say "showing X of Y" honestly.
    expect(file.bytes).toBeGreaterThan(taskdiff.MAX_PATCH_CHARS)
    // Cut at a line boundary: the last character kept is the end of a whole line of somebody's code.
    expect(file.patch.endsWith('"')).toBe(true)
  })

  it('does not truncate a patch that fits', async () => {
    const { task } = projectWithBranch({ 'small.ts': 'export const answer = 42\n' })

    const file = await taskdiff.diffFileFor(task.id, 'small.ts')

    expect(file.truncated).toBe(false)
    expect(file.bytes).toBe(file.patch.length)
  })
})

describe('the grader and the panel read one change', () => {
  it('agrees with collectDiff on the file set', async () => {
    const { project, task } = projectWithBranch({
      'a.ts': 'export const a = 1\n',
      'b.ts': 'export const b = 2\n',
      'package-lock.json': '{"lockfileVersion":3}\n'
    })

    const summary = await taskdiff.diffSummaryFor(task.id)
    const graded = await review.collectDiff(
      project.root,
      summary.base as string,
      summary.head as string
    )

    expect(graded.files).toBe(summary.files.length)
    expect(graded.insertions).toBe(summary.insertions)
    expect(graded.deletions).toBe(summary.deletions)
  })
})

/**
 * One recorded commit, read on its own.
 *
 * ⛔ **The row in the ledger is the only durable answer to "where did this work go", and until now it
 * was a sha and nothing else.** A commit's own diff is `<sha>^!` — this commit against its parent —
 * and the point of reading it that way rather than as part of a range is a task that landed twice:
 * `base..head` across the pair would show whatever else landed in between as if this task had done
 * it. ⚠️ Real git again, because `^!` and the double membership gate are both git's behaviour rather
 * than ours.
 */
describe('one recorded commit', () => {
  /** A project whose task has landed one commit onto `main`, with the row recorded for it. */
  async function landedOne(files: Record<string, string>): Promise<{ project: Project; task: Task; sha: string }> {
    const { project, task } = projectWithBranch(files)
    kit.git(project.root, 'merge', '--no-ff', '-m', 'land it', task.branch as string)
    const sha = kit.git(project.root, 'rev-parse', `${task.branch as string}`).trim()
    const commits = await import('./taskcommits.js')
    commits.recordTaskCommits(task.id, [{ sha, subject: 'the work', authoredAt: Date.now() }], 'main')
    return { project, task, sha }
  }

  it('counts only that commit’s own lines', async () => {
    const { task, sha } = await landedOne({ 'one.ts': 'export const one = 1\n' })
    const summary = await taskdiff.commitDiffFor(task.id, sha)
    expect(summary.ok).toBe(true)
    expect(summary.from).toBe('commit')
    expect(summary.files.map((f) => f.path)).toEqual(['one.ts'])
    expect(summary.insertions).toBe(1)
    expect(summary.deletions).toBe(0)
  })

  it('reads one file’s patch out of it', async () => {
    const { task, sha } = await landedOne({ 'two.ts': 'export const two = 2\n' })
    const file = await taskdiff.commitFileFor(task.id, sha, 'two.ts')
    expect(file.ok).toBe(true)
    expect(file.patch).toContain('+export const two = 2')
  })

  /**
   * ⛔ **The gate that keeps the renderer inside its own task.** A panel holding a sha may ask for
   * that sha and no other: any commit in the repository would otherwise be readable through a task
   * that never touched it.
   */
  it('refuses a commit this task never recorded', async () => {
    const { project, task } = await landedOne({ 'three.ts': 'export const three = 3\n' })
    const other = kit.git(project.root, 'rev-parse', 'main~1').trim()
    const summary = await taskdiff.commitDiffFor(task.id, other)
    expect(summary.ok).toBe(false)
    expect(summary.reason).toMatch(/not one this task landed/)
    const file = await taskdiff.commitFileFor(task.id, other, 'three.ts')
    expect(file.ok).toBe(false)
  })

  /** ⚠️ And an abbreviation is not the sha it abbreviates: the record holds forty characters. */
  it('refuses an abbreviated sha rather than resolving it', async () => {
    const { task, sha } = await landedOne({ 'four.ts': 'export const four = 4\n' })
    const summary = await taskdiff.commitDiffFor(task.id, sha.slice(0, 8))
    expect(summary.ok).toBe(false)
  })

  /** ⛔ The second half of the double gate: the path has to be one this commit changed. */
  it('refuses a file that is not part of the commit', async () => {
    const { task, sha } = await landedOne({ 'five.ts': 'export const five = 5\n' })
    const file = await taskdiff.commitFileFor(task.id, sha, 'elsewhere.ts')
    expect(file.ok).toBe(false)
    expect(file.reason).toMatch(/not part of this commit/)
  })

  /**
   * ⚠️ A landed commit is history and the workspace that made it is long released, so *uncommitted
   * files* is not a question with an answer here. It reads as unknown rather than as zero, which
   * would be a claim nobody measured.
   */
  it('claims nothing about a workspace it never looked at', async () => {
    const { task, sha } = await landedOne({ 'six.ts': 'export const six = 6\n' })
    const summary = await taskdiff.commitDiffFor(task.id, sha)
    expect(summary.workspaceReadable).toBe(false)
    expect(summary.uncommittedFiles).toBe(0)
  })
})
