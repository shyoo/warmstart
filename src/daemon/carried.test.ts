import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import { branchVerdicts, carriesClause } from './carried.js'
import { commitsOnlyOn, type TaskBranch } from './worktrees.js'

/**
 * Which finished branches the loose-ends panel lists (t1041).
 *
 * ⛔ The shape is muturn's, measured 2026-10-10: conversation t1007 filed pieces, merged each finished
 * one into its own branch with a merge commit, and was still open — so four of five *not landed* rows
 * were wholly inside its branch and the fifth was a piece it had not merged yet. Real git, because
 * every verdict is a claim about reachability.
 */

let root: string

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function commit(file: string): void {
  writeFileSync(join(root, file), `${file}\n`)
  git('add', '-A')
  git('commit', '-m', file)
}

const PARENT = 'warmstart/t10.3-conversation'
const T11 = 'warmstart/t11-first-piece'
const T12 = 'warmstart/t12-second-piece'
const T13 = 'warmstart/t13-third-piece'
const T20 = 'warmstart/t20-chain-start'
const T21 = 'warmstart/t21-chain-end'
const T22 = 'warmstart/t22-unrelated'
const T30 = 'warmstart/t30-squashed'
const T40 = 'warmstart/t40-twin'
const T41 = 'warmstart/t41-twin'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentyard-carried-'))
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'agentyard test')
  git('config', 'user.email', 'test@example.invalid')
  commit('base.txt')

  git('switch', '-c', PARENT)
  git('switch', '-c', T11, 'main')
  commit('a.txt')
  git('switch', '-c', T12)
  commit('b.txt')
  git('switch', '-c', T13)
  commit('c.txt')
  // t30 reaches the parent as a squash: no SHA of its own survives there. ⚠️ First, so the squash
  // commit's tree is t30's tip tree — the t948 proof. A squash onto a parent that had already moved
  // on matches no tree and no single patch, and still reads as t30's own row (conservative).
  git('switch', '-c', T30, 'main')
  commit('w1.txt')
  commit('w2.txt')
  git('switch', PARENT)
  git('merge', '--squash', T30)
  git('commit', '-m', 'take t30, squashed')
  git('merge', '--no-ff', '-m', 'take t11', T11)
  git('merge', '--no-ff', '-m', 'take t12', T12)

  git('switch', '-c', T20, 'main')
  commit('x.txt')
  git('switch', '-c', T21)
  commit('y.txt')
  git('switch', '-c', T22, 'main')
  commit('z.txt')
  git('switch', '-c', T40, 'main')
  commit('twin.txt')
  git('branch', T41)
  git('switch', 'main')
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

async function branch(name: string): Promise<TaskBranch> {
  return {
    branch: name,
    taskSeq: Number.parseInt(/\/t(\d+)/.exec(name)?.[1] ?? '', 10),
    ahead: await commitsOnlyOn(root, name, 'main'),
    contentLanded: false,
    heldBy: null,
    head: git('rev-parse', name)
  }
}

const task = (seq: number, status: Task['status'], parent: number | null = null): Task =>
  ({ id: `id-${seq}`, seq, status, deletedAt: null, parentTaskId: parent === null ? null : `id-${parent}` }) as Task

async function verdicts(tasks: Task[], names: string[]) {
  const branches = await Promise.all(names.map(branch))
  return branchVerdicts(root, 'main', branches, new Map(tasks.map((t) => [t.seq, t])))
}

describe('a finished piece of a task that is still open', () => {
  it('is hidden while its parent is open, whether or not the parent has merged it yet', async () => {
    const found = await verdicts(
      [task(10, 'blocked'), task(11, 'completed', 10), task(12, 'completed', 10), task(13, 'completed', 10)],
      [PARENT, T11, T12, T13]
    )
    expect(found.get(T11)).toEqual({ kind: 'parent-open', parentSeq: 10 })
    expect(found.get(T13)).toEqual({ kind: 'parent-open', parentSeq: 10 })
    // The open parent's own branch is not a loose end at all.
    expect(found.get(PARENT)).toBeUndefined()
  })

  it('reads as not landed again once the parent closes without having merged it', async () => {
    const found = await verdicts(
      [task(10, 'completed'), task(11, 'completed', 10), task(12, 'completed', 10), task(13, 'completed', 10)],
      [PARENT, T11, T12, T13]
    )
    // ⭐ One row per distinct body of work: t13 holds t11 and t12, and so does the parent.
    expect(found.get(T11)).toMatchObject({ kind: 'folded' })
    expect(found.get(T12)).toMatchObject({ kind: 'folded' })
    const t13 = found.get(T13)
    expect(t13?.kind === 'own' && t13.count).toBe(3)
    expect(t13?.kind === 'own' && carriesClause(t13.carries)).toBe(' — also carries t11, t12')
    expect(found.get(PARENT)?.kind).toBe('own')
  })
})

describe('a finished branch another open branch carries', () => {
  it('is hidden when an open branch holds every commit, by SHA or by squash', async () => {
    // No parent link — the open task merely took the work in.
    const found = await verdicts(
      [task(10, 'running'), task(11, 'completed'), task(12, 'completed'), task(13, 'completed'), task(30, 'completed')],
      [PARENT, T11, T12, T13, T30]
    )
    expect(found.get(T11)).toEqual({ kind: 'carried' })
    expect(found.get(T12)).toEqual({ kind: 'carried' })
    expect(found.get(T30)).toEqual({ kind: 'carried' })
    // ⛔ Only what no open branch holds is counted: t13's one commit, not three.
    expect(found.get(T13)).toEqual({ kind: 'own', count: 1, carries: [] })
  })
})

describe('a chain of finished branches', () => {
  it('folds each link into the outermost one, and leaves an unrelated branch alone', async () => {
    const found = await verdicts([task(20, 'completed'), task(21, 'failed'), task(22, 'cancelled')], [T20, T21, T22])
    expect(found.get(T20)).toEqual({ kind: 'folded', into: [T21] })
    expect(found.get(T21)).toMatchObject({ kind: 'own', count: 2 })
    expect(found.get(T22)).toEqual({ kind: 'own', count: 1, carries: [] })
  })

  it('folds two branches holding the same commits one way only, so one row always remains', async () => {
    const found = await verdicts([task(40, 'completed'), task(41, 'completed')], [T40, T41])
    expect(found.get(T40)).toEqual({ kind: 'folded', into: [T41] })
    expect(found.get(T41)).toMatchObject({ kind: 'own', count: 1 })
  })
})
