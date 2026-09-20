import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'
import {
  abortRebase,
  beginConflictResolution,
  landingBaseFor,
  localBaseNote,
  parseMergeTreeConflicts,
  readMergeability
} from './landing.js'

/**
 * Reading a conflict before it becomes a landing failure, against a real repository.
 *
 *'s the point: everything asserted here is a claim about git, so a fake git would prove none of it.
 * The defect being fixed came from believing something about git that was never measured.
 */
const run = promisify(execFile)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await run('git', args, { cwd })).stdout.trim()

let root: string
let repo: string

const project = (): Project =>
  ({ id: 'p1', name: 'p', root: repo, vcs: 'git', config: { schema_version: 1 } }) as Project

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentyard-conflict-'))
  repo = join(root, 'repo')
  await run('git', ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.email', 't@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'untouched.txt'), 'stable\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-qm', 'base'])
}, 60000)

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

async function makeConflict(branch: string): Promise<void> {
  await git(repo, ['checkout', '-q', 'main'])
  await git(repo, ['checkout', '-qb', branch])
  writeFileSync(join(repo, 'a.txt'), 'one\nBRANCH\nthree\n')
  await git(repo, ['commit', '-qam', branch + ' work'])
  await git(repo, ['checkout', '-q', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'one\nTRUNK\nthree\n')
  await git(repo, ['commit', '-qam', 'trunk moved'])
  await git(repo, ['checkout', '-q', branch])
}

describe('parseMergeTreeConflicts', () => {
  it('reads the unmerged-index block of a real capture, not the prose', () => {
    const file = join(import.meta.dirname, '__fixtures__', 'git-merge-tree-conflict.txt')
    expect(parseMergeTreeConflicts(readFileSync(file, 'utf8'))).toEqual(['a.txt', 'b.txt'])
  })

  it('stops at the blank line, so a filename in a sentence is never taken for a path', () => {
    const a = '0'.repeat(40)
    const forged = a + '\n100644 ' + a + ' 1\treal.ts\n\n100644 ' + a + ' 1\tnot-a-path.ts\n'
    expect(parseMergeTreeConflicts(forged)).toEqual(['real.ts'])
  })

  it('counts a path once though git names it at three stages', () => {
    const oid = 'a'.repeat(40)
    const three = ['1', '2', '3'].map((s) => '100644 ' + oid + ' ' + s + '\tsrc/x.ts').join('\n')
    expect(parseMergeTreeConflicts(three)).toEqual(['src/x.ts'])
  })
})

describe('readMergeability against a real repository', () => {
  it('says clean when the branch rebases', async () => {
    await git(repo, ['checkout', '-q', 'main'])
    await git(repo, ['checkout', '-qb', 'clean-branch'])
    writeFileSync(join(repo, 'untouched.txt'), 'stable\nplus a line\n')
    await git(repo, ['commit', '-qam', 'a change that does not collide'])
    const reading = await readMergeability(project(), repo, 'clean-branch')
    expect(reading?.clean).toBe(true)
    expect(reading?.conflictedPaths).toEqual([])
  }, 30000)

  it('names the conflicting path, and changes nothing on disk doing it', async () => {
    await makeConflict('conflict-branch')
    const before = await git(repo, ['status', '--porcelain'])
    const head = await git(repo, ['rev-parse', 'HEAD'])

    const reading = await readMergeability(project(), repo, 'conflict-branch')
    expect(reading?.clean).toBe(false)
    expect(reading?.conflictedPaths).toEqual(['a.txt'])
    expect(reading?.rebaseInProgress).toBe(false)

    expect(await git(repo, ['status', '--porcelain'])).toBe(before)
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head)
  }, 30000)

  it('reports no reading rather than a conflict when the target does not resolve', async () => {
    const orphan = {
      ...project(),
      config: { schema_version: 1, landing: { target: 'no-such-branch' } }
    } as Project
    expect(await readMergeability(orphan, repo, 'conflict-branch')).toBeNull()
  }, 30000)
})

describe('beginConflictResolution', () => {
  it('leaves the rebase stopped at the conflict, with markers in the tree', async () => {
    await git(repo, ['checkout', '-q', 'conflict-branch'])
    const begun = await beginConflictResolution(repo, 'main')
    expect(begun.resolved).toBe(false)
    expect(begun.paths).toEqual(['a.txt'])

    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('<<<<<<<')
    const reading = await readMergeability(project(), repo, 'conflict-branch')
    expect(reading?.rebaseInProgress).toBe(true)
  }, 30000)

  it('and abortRebase puts the branch back exactly where it was', async () => {
    await abortRebase(repo)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).not.toContain('<<<<<<<')
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
    expect(await git(repo, ['log', '-1', '--format=%s'])).toBe('conflict-branch work')
  }, 30000)

  it('is safe to call when no rebase is running', async () => {
    await abortRebase(repo)
    expect(await git(repo, ['status', '--porcelain'])).toBe('')
  }, 30000)

  it('reports resolved when the conflict disappeared before it started', async () => {
    await git(repo, ['checkout', '-q', 'main'])
    await git(repo, ['checkout', '-qb', 'no-conflict-left'])
    writeFileSync(join(repo, 'untouched.txt'), 'stable\nanother line\n')
    await git(repo, ['commit', '-qam', 'no collision'])
    const begun = await beginConflictResolution(repo, 'main')
    expect(begun.resolved).toBe(true)
    expect(begun.paths).toEqual([])
  }, 30000)
})

/**
 * The base the check asks about must be the base the landing uses.
 *
 * ⛔ **They were two separate copies of one rule, and they disagreed on the default policy.**
 * `merge-local` rebases onto the *local* target and says so in its own comment; `readMergeability`
 * always preferred `origin/<target>` when a remote existed. On `commit-and-merge` — the fleet
 * default — the pre-flight check therefore answered about a **different ref** than the one used.
 *
 * ⭐ Measured on t59, 2026-08-30, against a trunk two commits ahead of its remote:
 * `merge-tree origin/main HEAD` said clean, `merge-tree main HEAD` said conflict. `decideFinish`
 * was told clean, chose `land`, and `git rebase main` failed inside `landTask` — so
 * `resolve-conflict`, the one verdict that hands a conflict back to a live agent, was passed two
 * branches earlier and the task dead-ended at `awaiting_human`.
 */
describe('the base a landing will actually use', () => {
  let ahead: string
  let remote: string

  beforeAll(async () => {
    // A repo whose local `main` is ahead of `origin/main`, which is the whole scenario: work landed
    // locally under `commit-and-merge` and was deliberately not pushed.
    const dir = mkdtempSync(join(tmpdir(), 'agentyard-base-'))
    remote = join(dir, 'origin.git')
    ahead = join(dir, 'work')
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote])
    await run('git', ['clone', '-q', remote, ahead])
    await git(ahead, ['config', 'user.email', 't@example.com'])
    await git(ahead, ['config', 'user.name', 'Test'])
    writeFileSync(join(ahead, 'm.txt'), 'base\n')
    await git(ahead, ['add', '-A'])
    await git(ahead, ['commit', '-qm', 'base'])
    await git(ahead, ['push', '-q', 'origin', 'main'])

    // The task branch, off the pushed base.
    await git(ahead, ['checkout', '-q', '-b', 'topic'])
    writeFileSync(join(ahead, 'm.txt'), 'topic\n')
    await git(ahead, ['add', '-A'])
    await git(ahead, ['commit', '-qm', 'topic'])

    // And a commit on local main only — never pushed — that touches the same line.
    await git(ahead, ['checkout', '-q', 'main'])
    writeFileSync(join(ahead, 'm.txt'), 'landed-locally\n')
    await git(ahead, ['add', '-A'])
    await git(ahead, ['commit', '-qm', 'landed while topic ran'])
    await git(ahead, ['checkout', '-q', 'topic'])
  })

  const proj = (): Project =>
    ({ id: 'p2', name: 'p', root: ahead, vcs: 'git', config: { schema_version: 1 } }) as Project

  it('names the local target for the policy that merges locally, remote or not', () => {
    // ⛔ `commit-and-merge` never touches the remote by design, so its base cannot be `origin/main`
    //    however many remotes exist.
    expect(landingBaseFor(proj(), 'commit-and-merge', true)).toBe('main')
    expect(landingBaseFor(proj(), 'commit-and-merge', false)).toBe('main')
    expect(landingBaseFor(proj(), 'report-only', true)).toBe('main')
  })

  it('leaves the levels that never rebase on the remote reading', () => {
    // ⚠️ `commit-and-verify` maps to `verify-only`, which runs the checks against the branch exactly
    //    as committed and rebases nothing — so its base is advisory and the remote is the more
    //    useful thing to have been told about. Asserted so that a future change to `FOR_POLICY`
    //    has to come back here and decide deliberately rather than silently.
    expect(landingBaseFor(proj(), 'commit-and-verify', true)).toBe('origin/main')
    expect(landingBaseFor(proj(), 'commit-only', true)).toBe('origin/main')
  })

  it('names the remote for a policy that pushes there', () => {
    expect(landingBaseFor(proj(), 'commit-and-push', true)).toBe('origin/main')
    // No remote is not a conflict, it is just the local ref.
    expect(landingBaseFor(proj(), 'commit-and-push', false)).toBe('main')
  })

  it('reports the conflict that the default policy is actually going to hit', async () => {
    // ⭐ The regression, end to end. The same branch, the same repository, two answers — and the
    //    old code returned the wrong one for the policy this fleet runs on.
    const merging = await readMergeability(proj(), ahead, 'topic', 'commit-and-merge')
    expect(merging?.base).toBe('main')
    expect(merging?.clean, 'topic conflicts with the commit on local main').toBe(false)

    // ⚠️ And the other policy still gets its own honest answer: against the *pushed* main this
    //    branch really does apply cleanly, so `commit-and-push` is not told about a conflict it
    //    would not meet.
    const pushing = await readMergeability(proj(), ahead, 'topic', 'commit-and-push')
    expect(pushing?.base).toBe('origin/main')
    expect(pushing?.clean).toBe(true)
  })

  /**
   * The sentence that stops an agent reaching past the ref it was given.
   *
   * ⛔ **Naming `main` is not the same as ruling out `origin/main`.** t578's agent was told the
   * landing failed on `origin/main` (a separate defect, fixed in `landingLevelFor`), rebased there,
   * and reported the rebase clean — twice. Every agent has been trained on `git rebase origin/main`,
   * and under `commit-and-merge` that ref is the one guaranteed to be stale. So the instruction
   * carries the measured gap: two refs, a count, and which one the landing uses.
   */
  describe('localBaseNote', () => {
    it('⛔ names the gap when the local base is ahead of its remote namesake', async () => {
      const note = await localBaseNote(ahead, 'main')
      expect(note).toContain('**not** onto `origin/main`')
      expect(note).toContain('1 commit ahead of `origin/main`')
      // ⚠️ Singular, because there is one commit. A count is evidence, and evidence reads wrong
      //    when the grammar contradicts it.
      expect(note).not.toContain('1 commits')
    })

    it('says nothing about a base that is already the remote', async () => {
      expect(await localBaseNote(ahead, 'origin/main')).toBe('')
    })

    it('says nothing in a repository with no remote at all, which is ordinary', async () => {
      expect(await localBaseNote(repo, 'main')).toBe('')
    })
  })
})
