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
