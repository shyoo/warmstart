import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'
import type { WorkspaceState } from './worktrees.js'
import type { TrunkReading } from './finish.js'

/**
 * The landing target resolver, and the one reader of it whose **meaning** changes under Plan &
 * Split rather than merely being rewired.
 *
 * ⛔ Both failures here are silent. A resolver that misses a call site puts two reference points in
 * one finish path and lets the quiet one win — t22, 2026-08-29, which reported success. And a
 * tripwire that fires on a sibling refuses a correct verdict and names the agent in the log for
 * doing exactly what this design tells it to do.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let finish: typeof import('./finish.js')
let projects: typeof import('./projects.js')

const clean = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
  path: 'C:/ws1',
  branch: 'warmstart/t9-a-piece',
  dirtyFiles: [],
  untrackedFiles: [],
  // ⛔ Zero: the tripwire only considers a branch that carries nothing.
  unlandedCommits: 0,
  landedRef: 'main',
  targetBehind: 0,
  stashes: 0,
  ...over
})

const projectWith = (target: string): Project =>
  ({
    id: 'p1',
    name: 'p',
    root: 'C:/p',
    vcs: 'git',
    config: { schema_version: 1, landing: { target, strategy: 'merge-local' } }
  }) as Project

const trunk: TrunkReading = {
  before: 'aaaaaaaa11111111111111111111111111111111',
  after: 'bbbbbbbb22222222222222222222222222222222',
  commits: ['cccccccc a sibling landed', 'dddddddd another sibling']
}

const SIBLINGS = [
  'cccccccc00000000000000000000000000000000',
  'dddddddd00000000000000000000000000000000'
]

let seq = 0
function makeTask(over: Partial<Task> = {}): Task {
  seq += 1
  const task = tasks.createTask({
    title: `piece ${seq}`,
    createdBy: { kind: 'human' },
    ...(over.landingTarget ? { landingTarget: over.landingTarget } : {})
  })
  return { ...tasks.requireTask(task.id), ...over }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-landingtarget-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  finish = await import('./finish.js')
  projects = await import('./projects.js')
  db.openDb(join(dir, 'landingtarget.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('landingTargetFor', () => {
  it('⛔ returns the project’s answer for every task with no target of its own', () => {
    // This is what makes the resolver provably inert: every row that existed before it is null.
    expect(projects.landingTargetFor(makeTask(), projectWith('main'))).toBe('main')
    expect(projects.landingTargetFor(null, projectWith('trunk'))).toBe('trunk')
    expect(projects.landingTargetFor(undefined, projectWith('main'))).toBe('main')
  })

  it('returns the task’s own target when it has one', () => {
    const child = makeTask({ landingTarget: 'warmstart/t1-the-plan' })
    expect(projects.landingTargetFor(child, projectWith('main'))).toBe(
      'warmstart/t1-the-plan'
    )
  })

  it('⚠️ treats a blank target as no target, not as a branch named nothing', () => {
    expect(projects.landingTargetFor({ landingTarget: '   ' }, projectWith('main'))).toBe('main')
  })
})

describe('the trunk tripwire under a split', () => {
  const decide = (task: Task, siblingLanded?: string[]): ReturnType<typeof finish.decideFinish> =>
    finish.decideFinish({
      task,
      project: projectWith('main'),
      state: clean(),
      hasChecks: false,
      trunk,
      ...(siblingLanded ? { siblingLanded } : {})
    })

  it('⛔ still fires on an unexplained movement — the t17 hole stays closed', () => {
    expect(decide(makeTask()).kind).toBe('trunk-moved')
  })

  it('leaves an ordinary task’s rule exactly as it was, with no siblings in play', () => {
    expect(decide(makeTask(), []).kind).toBe('trunk-moved')
  })

  it('⛔ does NOT fire when every commit is attributable to a sibling', () => {
    const child = makeTask({
      parentTaskId: 't-plan',
      landingTarget: 'warmstart/t1-the-plan'
    })
    // A sibling landing onto the shared plan branch is this design working, not an agent in the trunk.
    expect(decide(child, SIBLINGS).kind).not.toBe('trunk-moved')
  })

  it('⛔ still fires when only SOME of the movement is a sibling’s', () => {
    const child = makeTask({
      parentTaskId: 't-plan',
      landingTarget: 'warmstart/t1-the-plan'
    })
    const decision = finish.decideFinish({
      task: child,
      project: projectWith('main'),
      state: clean(),
      hasChecks: false,
      trunk: { ...trunk, commits: [...trunk.commits, 'eeeeeeee nobody claims this'] },
      siblingLanded: SIBLINGS
    })
    expect(decision.kind).toBe('trunk-moved')
    // And it names only what is unaccounted for, so the operator reads the real evidence.
    expect(decision.kind === 'trunk-moved' && decision.commits).toEqual([
      'eeeeeeee nobody claims this'
    ])
  })
})
