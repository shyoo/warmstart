import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { judge, measure } from '../../scripts/check-release-base.mjs'

/**
 * The gate `/release` runs first, reproduced with real git.
 *
 * ⛔ Measured 2026-09-15: `v0.1.0-rc.1` was tagged on `origin/main` while the trunk's `main` was
 * 25 unpushed commits ahead, two of them migrations. The operator's daily app, built from that
 * trunk, had taken the live database to schema v73; the release understood v71 and its daemon
 * refused the database on the first install. Nothing in the pipeline had looked at the trunk.
 *
 * The shape below is this repository's: a bare origin, a trunk clone with `main` checked out, and
 * a pooled worktree the release is prepared from. The refs are shared, so the worktree can see
 * what the trunk has not pushed — the whole point.
 */

const git = (cwd: string, ...argv: string[]): string =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let root: string
let trunk: string
let worktree: string

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), name)
  git(cwd, 'add', name)
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', name)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'releasebase-'))
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  trunk = join(root, 'trunk')
  git(root, 'clone', '-q', origin, trunk)
  git(trunk, 'checkout', '-q', '-b', 'main')
  commit(trunk, 'first')
  git(trunk, 'push', '-q', '-u', 'origin', 'main')
  worktree = join(root, 'ws1')
  git(trunk, 'worktree', 'add', '-q', worktree, '-b', 'warmstart/t1-release')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the release base gate', () => {
  it('passes when the trunk has nothing origin lacks and the worktree contains origin', () => {
    const facts = measure(worktree)
    expect(facts).toMatchObject({ trunkBranch: 'main', trunkAhead: 0, trunkBehind: 0, headBehind: 0, trunkDirty: [] })
    expect(judge(facts)).toEqual([])
  })

  it('refuses when the trunk is ahead of origin — the rc.1 trap', () => {
    commit(trunk, 'migration-72')
    commit(trunk, 'migration-73')
    const facts = measure(worktree)
    expect(facts.trunkAhead).toBe(2)
    const problems = judge(facts)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('2 commit(s) ahead of origin/main')
    expect(problems[0]).toContain('migrated the operator')
  })

  it('refuses a worktree that origin has moved past', () => {
    commit(trunk, 'later')
    git(trunk, 'push', '-q', 'origin', 'main')
    const facts = measure(worktree)
    expect(facts.trunkAhead).toBe(0)
    expect(facts.headBehind).toBe(1)
    expect(judge(facts)[0]).toContain('1 commit(s) behind origin/main')
  })

  it('refuses uncommitted tracked changes in the trunk, and names them', () => {
    writeFileSync(join(trunk, 'first'), 'edited but not committed')
    const facts = measure(worktree)
    expect(facts.trunkDirty).toEqual(['first'])
    expect(judge(facts)[0]).toContain('uncommitted change(s) (first)')
  })

  it('reports a trunk merely behind origin as a note, not a problem', () => {
    commit(worktree, 'from-the-worktree')
    git(worktree, 'push', '-q', 'origin', 'HEAD:main')
    const facts = measure(worktree)
    expect(facts.trunkBehind).toBe(1)
    expect(facts.headBehind).toBe(0)
    expect(judge(facts)).toEqual([])
  })
})
