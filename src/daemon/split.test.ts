import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChildDefaults, Principal, TaskConstraints } from '@shared/tasks.js'

/**
 * Plan & Split's safety boundary, driven where it is cheapest: a temp database, no agent, no prompt
 * and no UI.
 *
 * ⛔ The two rules worth the most here are the ones that are **silent** when wrong. A split that
 * half-applies leaves a planner blocked on children that do not exist — nothing releases it, ever —
 * and an edge whose release rule is wrong either wakes a planner too early or never wakes it at all.
 * Neither raises an error at the time.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let split: typeof import('./split.js')

const AGENT: Principal = {
  kind: 'agent',
  workerId: 'w-test',
  sessionId: 's-test',
  runId: 'r-test'
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-split-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  split = await import('./split.js')
  db.openDb(join(dir, 'split.db'))
})

beforeEach(() => {
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** A planner, with the branch a split needs to cut its pieces from. */
function planner(
  overrides: {
    maxChildren?: number
    childDefaults?: ChildDefaults
    constraints?: TaskConstraints
  } = {}
): ReturnType<typeof tasks.createTask> {
  const task = tasks.createTask({
    title: 'Build the thing',
    kind: 'plan',
    ...(overrides.maxChildren ? { mandate: { maxChildren: overrides.maxChildren } } : {}),
    ...(overrides.childDefaults ? { childDefaults: overrides.childDefaults } : {}),
    ...(overrides.constraints ? { constraints: overrides.constraints } : {})
  })
  db.db()
    .prepare('update tasks set branch = ? where id = ?')
    .run('warmstart/t1-build-the-thing', task.id)
  return tasks.requireTask(task.id)
}

const piece = (title: string, dependsOn: number[] = []): { title: string; dependsOn: number[] } => ({
  title,
  dependsOn
})

describe('validateSplit', () => {
  it('refuses a split of one, because it buys a round trip and no parallelism', () => {
    const result = split.validateSplit(planner(), [piece('do everything')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/at least 2/)
  })

  it('refuses a task that is neither a plan nor a debate', () => {
    const work = tasks.createTask({ title: 'ordinary work' })
    const result = split.validateSplit(work, [piece('a'), piece('b')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not a Plan & Split or Debate task/)
  })

  // ⛔ The verdict *Split the work* is the organizer calling `task_split`, so a debate parent has
  // to be accepted here — and by `plannerBranchFor` and `createTask`, or its pieces would be cut
  // from the trunk instead of from the organizer's branch.
  it('accepts a debate organizer, because that is the verdict “Split the work”', () => {
    const filed = tasks.createTask({ title: 'which cache do we use', kind: 'debate' })
    // ⚠️ A branch, for the same reason a planner needs one: the pieces are cut from the parent's
    // branch and merge back into it, which is what `isIntegrationParent` is naming.
    db.db().prepare('update tasks set branch = ? where id = ?').run('warmstart/t9-which-cache', filed.id)
    const result = split.validateSplit(tasks.requireTask(filed.id), [piece('a'), piece('b')])
    expect(result.ok).toBe(true)
  })

  it('refuses an edge that does not point backwards, which is what makes a cycle impossible', () => {
    const result = split.validateSplit(planner(), [piece('a', [1]), piece('b')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not an earlier piece/)
  })

  it('refuses a piece that depends on itself', () => {
    const result = split.validateSplit(planner(), [piece('a'), piece('b', [1])])
    expect(result.ok).toBe(false)
  })

  it('accepts an edge that points at an earlier piece', () => {
    expect(split.validateSplit(planner(), [piece('a'), piece('b', [0])]).ok).toBe(true)
  })

  it('refuses two pieces with the same instruction, which would silently become one', () => {
    const result = split.validateSplit(planner(), [piece('Add the migration'), piece('add  the MIGRATION!')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/same instruction/)
  })

  it('refuses a piece with no instruction', () => {
    const result = split.validateSplit(planner(), [piece('a'), piece('   ')])
    expect(result.ok).toBe(false)
  })

  it('enforces the task’s own fan-out cap, so the number shown is the number allowed', () => {
    const result = split.validateSplit(planner({ maxChildren: 3 }), [
      piece('a'),
      piece('b'),
      piece('c'),
      piece('d')
    ])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/fan-out cap of 3/)
  })

  it('refuses a planner with no branch, which would give every piece the trunk as its base', () => {
    const bare = tasks.createTask({ title: 'no branch yet', kind: 'plan' })
    const result = split.validateSplit(bare, [piece('a'), piece('b')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/no branch/)
  })
})

describe('applySplit', () => {
  it('files every piece and parks the planner on them', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('one'), piece('two'), piece('three')], AGENT)
    expect(result.ok).toBe(true)
    expect(result.ok && result.children).toHaveLength(3)
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
  })

  it('cuts every piece from the plan branch, not the trunk', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('one'), piece('two')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const child of result.children) {
      expect(child.landingTarget).toBe(parent.branch)
    }
  })

  it('divides the budget equally rather than halving it per child', () => {
    const parent = tasks.createTask({ title: 'budgeted plan', kind: 'plan', budgetTokens: 1000 })
    db.db().prepare('update tasks set branch = ? where id = ?').run('b', parent.id)
    const result = split.applySplit(parent.id, [piece('a'), piece('b'), piece('c'), piece('d')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // ⛔ 250 each, not 500 / 250 / 125 / 62 — see `CreateTaskInput.budgetShare`.
    for (const child of result.children) {
      expect(child.budget.grantedTokens).toBe(250)
    }
  })

  it('writes the edges between pieces that the planner asked for', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('first'), piece('second', [0])], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const second = tasks.requireTask(result.children[1]!.id)
    expect(second.dependsOn).toContain(result.children[0]!.id)
    expect(second.status).toBe('blocked')
  })

  it('does not merge two pieces whose titles collide with a live task elsewhere', () => {
    tasks.createTask({ title: 'Add the migration' })
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('Add the migration'), piece('other')], AGENT)
    expect(result.ok).toBe(true)
    // ⛔ Two distinct rows: the near-duplicate merge would have returned the existing task and left
    //    the planner waiting on work belonging to something else entirely.
    expect(result.ok && new Set(result.children.map((c) => c.id)).size).toBe(2)
  })

  it('refuses without writing anything when the plan is invalid', () => {
    const parent = planner()
    const before = tasks.listTasks().length
    const result = split.applySplit(parent.id, [piece('only one')], AGENT)
    expect(result.ok).toBe(false)
    expect(tasks.listTasks()).toHaveLength(before)
    expect(tasks.requireTask(parent.id).status).not.toBe('blocked')
  })

  it('frees fan-out slots after every piece settles, so the resumed planner can file follow-up work', () => {
    const parent = planner({ maxChildren: 2 })
    const result = split.applySplit(parent.id, [piece('one'), piece('two')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(() =>
      tasks.createTask({ title: 'blocked follow-up', parentTaskId: parent.id, createdBy: AGENT })
    ).toThrow(/fan-out cap of 2/)

    for (const child of result.children) tasks.setStatus(child.id, 'completed')

    const followUp = tasks.createTask({
      title: 'review the completed pieces',
      parentTaskId: parent.id,
      createdBy: AGENT
    })
    expect(followUp.status).toBe('ready')
  })
})

describe('the edge release rule', () => {
  it('holds the planner while a piece is still running', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    tasks.setStatus(result.children[0]!.id, 'completed')
    tasks.admitDependents(result.children[0]!.id)
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
  })

  it('⛔ releases the planner when the last piece FAILS, not only when it completes', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    tasks.setStatus(result.children[0]!.id, 'completed')
    tasks.admitDependents(result.children[0]!.id)
    tasks.setStatus(result.children[1]!.id, 'failed')
    tasks.admitDependents(result.children[1]!.id)
    // Without `require = 'settled'` this is `blocked` for ever, and nothing in the fleet releases it.
    expect(tasks.requireTask(parent.id).status).toBe('ready')
  })

  it('releases the planner when a piece is cancelled', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const child of result.children) {
      tasks.setStatus(child.id, 'cancelled')
      tasks.admitDependents(child.id)
    }
    expect(tasks.requireTask(parent.id).status).toBe('ready')
  })

  it('⛔ leaves an ordinary `completed` edge meaning exactly what it meant', () => {
    const a = tasks.createTask({ title: 'first' })
    const b = tasks.createTask({ title: 'second' })
    tasks.attachDependency(b.id, a.id)
    tasks.setStatus(a.id, 'failed')
    tasks.admitDependents(a.id)
    // A person who says "do B after A" means A succeeded. Loosening this globally would have
    // silently rewritten every edge already in the fleet.
    expect(tasks.requireTask(b.id).status).toBe('blocked')
  })
})

describe('addSplitDependency', () => {
  it('adds an edge between two of this planner’s own pieces', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first, second] = result.children
    expect(split.addSplitDependency(parent.id, second!.seq, first!.seq).ok).toBe(true)
    expect(tasks.requireTask(second!.id).dependsOn).toContain(first!.id)
  })

  it('⛔ refuses a task that is not one of its own pieces', () => {
    const parent = planner()
    const stranger = tasks.createTask({ title: 'somebody else’s work' })
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const outcome = split.addSplitDependency(parent.id, result.children[0]!.seq, stranger.seq)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toMatch(/not one of this task/)
  })

  it('refuses an edge that would close a cycle', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b', [0])], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [first, second] = result.children
    expect(split.addSplitDependency(parent.id, first!.seq, second!.seq).ok).toBe(false)
  })
})

/**
 * Who a piece of a plan is allowed to run on.
 *
 * ⛔ **The regression these exist for is silent and expensive.** An operator named two cheap accounts
 * on the Pieces row; the pieces were filed with no constraint at all, went through the ordinary
 * dispatcher and were handed to the largest model in the fleet. Nothing failed — the split worked,
 * the work got done, and the bill was wrong. So the assertion is on the *stored* constraint of each
 * child, which is the only artefact the scheduler ever reads.
 */
describe('pieceConstraints', () => {
  const AT = 'w-antigravity'
  const CX = 'w-codex'

  it('carries every account the operator named on the Pieces row', () => {
    const parent = planner({
      childDefaults: {
        workerIds: [AT, CX],
        modelsByWorker: { [AT]: 'flash-3.8', [CX]: '5.6-terra' },
        effortsByWorker: { [CX]: 'medium' }
      }
    })
    const constraints = split.pieceConstraints(parent, parent.childDefaults)
    expect(constraints.workerIds).toEqual([AT, CX])
    expect(constraints.modelsByWorker).toEqual({ [AT]: 'flash-3.8', [CX]: '5.6-terra' })
    expect(constraints.effortsByWorker).toEqual({ [CX]: 'medium' })
  })

  it('reads the planner’s own pieceConstraints when childDefaults carries no accounts', () => {
    const parent = planner({
      constraints: { pieceConstraints: { workerIds: [AT, CX], modelsByWorker: { [AT]: 'flash-3.8' } } }
    })
    const constraints = split.pieceConstraints(parent, parent.childDefaults)
    expect(constraints.workerIds).toEqual([AT, CX])
    expect(constraints.modelsByWorker).toEqual({ [AT]: 'flash-3.8' })
  })

  it('prefers childDefaults over pieceConstraints when both name accounts', () => {
    const parent = planner({
      childDefaults: { workerIds: [CX] },
      constraints: { pieceConstraints: { workerIds: [AT] } }
    })
    expect(split.pieceConstraints(parent, parent.childDefaults).workerIds).toEqual([CX])
  })

  it('pins the singular workerId too when exactly one account was named', () => {
    const parent = planner({ childDefaults: { workerIds: [CX] } })
    const constraints = split.pieceConstraints(parent, parent.childDefaults)
    expect(constraints.workerId).toBe(CX)
    expect(constraints.workerIds).toEqual([CX])
  })

  it('leaves the choice open when the operator named nobody', () => {
    const parent = planner()
    expect(split.pieceConstraints(parent, parent.childDefaults)).toEqual({})
  })

  it('drops a fleet-wide model where several accounts were named, because an id belongs to one CLI', () => {
    const parent = planner({ childDefaults: { workerIds: [AT, CX], model: 'opus-5' } })
    const constraints = split.pieceConstraints(parent, parent.childDefaults)
    expect(constraints.model).toBeUndefined()
    expect(constraints.workerIds).toEqual([AT, CX])
  })

  it('keeps a single account’s model and effort', () => {
    const parent = planner({ childDefaults: { workerId: CX, model: '5.6-terra', effort: 'medium' } })
    const constraints = split.pieceConstraints(parent, parent.childDefaults)
    expect(constraints).toMatchObject({ workerId: CX, model: '5.6-terra', effort: 'medium' })
  })

  it('files every piece against the named accounts and never against the fleet', () => {
    const parent = planner({
      childDefaults: {
        workerIds: [AT, CX],
        modelsByWorker: { [AT]: 'flash-3.8', [CX]: '5.6-terra' }
      }
    })
    const result = split.applySplit(parent.id, [piece('one'), piece('two')], AGENT, parent.childDefaults)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const child of result.children) {
      const stored = tasks.requireTask(child.id)
      expect(stored.constraints.workerIds).toEqual([AT, CX])
      expect(stored.constraints.modelsByWorker).toEqual({ [AT]: 'flash-3.8', [CX]: '5.6-terra' })
      // ⛔ Never a pin on an account nobody chose: two named accounts is a list, not a pin.
      expect(stored.constraints.workerId).toBeUndefined()
    }
  })

  it('hints the assignee only when one account was named', () => {
    const one = planner({ childDefaults: { workerIds: [CX] } })
    const many = planner({ childDefaults: { workerIds: [AT, CX] } })
    const first = split.applySplit(one.id, [piece('a'), piece('b')], AGENT, one.childDefaults)
    const second = split.applySplit(many.id, [piece('c'), piece('d')], AGENT, many.childDefaults)
    expect(first.ok && first.children[0]!.assigneeHint).toBe(CX)
    expect(second.ok && second.children[0]!.assigneeHint).toBeNull()
  })
})
