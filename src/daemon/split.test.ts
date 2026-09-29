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
let workers: typeof import('./workers.js')

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
  workers = await import('./workers.js')
  db.openDb(join(dir, 'split.db'))
})

beforeEach(() => {
  db.db().exec('delete from task_deps')
  db.db().exec('delete from tasks')
  db.db().exec('delete from workers')
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

/**
 * A Plan & Execute planner: the same task with its child cap at one.
 *
 * ⛔ **The cap is the whole of the difference**, on both fields the daemon reads — the mandate
 * `createTask` enforces and the `childDefaults` `task_split` is handed. `planModeOf` derives the
 * shape from them, so a fixture that set only one would be testing a task this composer cannot file.
 */
function handoffPlanner(
  overrides: { childDefaults?: ChildDefaults; constraints?: TaskConstraints } = {}
): ReturnType<typeof tasks.createTask> {
  return planner({
    maxChildren: 1,
    ...overrides,
    childDefaults: { ...(overrides.childDefaults ?? {}), maxChildren: 1 }
  })
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

  // ⛔ The same call, the same tool, the opposite answer — and that is the point of deriving the
  //    floor from the plan's own cap rather than from a constant. A Plan & Execute planner told
  //    "a split needs at least 2 pieces" has been handed a contradiction it cannot resolve: its own
  //    instruction says to file exactly one.
  it('accepts exactly one piece from a Plan & Execute, and refuses two', () => {
    const parent = handoffPlanner()
    expect(split.validateSplit(parent, [piece('do the whole job')]).ok).toBe(true)
    const two = split.validateSplit(parent, [piece('a'), piece('b')])
    expect(two.ok).toBe(false)
    expect(two.ok === false && two.reason).toMatch(/exactly 1 piece/)
    // ⚠️ And says what to do instead, because "refused" with no direction gets re-filed unchanged.
    expect(two.ok === false && two.reason).toMatch(/ask_human/)
  })

  it('refuses a Plan & Execute that files nothing at all', () => {
    const result = split.validateSplit(handoffPlanner(), [])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/exactly 1 piece/)
  })

  // ⭐ t704: an ordinary task may split — that is delegation — but only while it holds
  //    `spawn_tasks`, and the refusal says how to get it back. `delegation.test.ts` has the rest.
  it('refuses a task that is neither a plan nor a debate once its delegation is off', () => {
    const work = tasks.createTask({ title: 'ordinary work' })
    expect(split.validateSplit(work, [piece('a'), piece('b')]).ok).toBe(true)
    const off = tasks.createTask({ title: 'other work', mandate: { allowed: ['read', 'write', 'commit'] } })
    const result = split.validateSplit(off, [piece('a'), piece('b')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/delegation is off/)
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

  it('carries an Auto model class and policy the operator chose for the pieces', () => {
    // ⛔ t732: the Executor row had no Auto Model answer, so pieces could only be pinned or left
    // to full-Auto routing. The class has to reach the child's constraints, which is the only
    // artefact the scheduler reads when it narrows Auto rows.
    const parent = planner({ childDefaults: { modelPolicy: 'inherit' } })
    expect(split.pieceConstraints(parent, parent.childDefaults)).toMatchObject({
      modelPolicy: 'inherit'
    })
    const classed = planner({ childDefaults: { modelClass: 'low' } })
    expect(split.pieceConstraints(classed, classed.childDefaults)).toMatchObject({
      modelClass: 'low'
    })
  })

  it('reads the class from the planner’s own pieceConstraints when childDefaults is silent', () => {
    const parent = planner({
      constraints: { pieceConstraints: { modelClass: 'med' } }
    })
    expect(split.pieceConstraints(parent, parent.childDefaults)).toMatchObject({
      modelClass: 'med'
    })
  })

  it('lets the operator’s class beat the agent’s hint, and the hint stand otherwise', () => {
    const pinned = planner({ childDefaults: { modelClass: 'high' } })
    const over = split.applySplit(
      pinned.id,
      [{ ...piece('a'), modelClass: 'low' as const }, { ...piece('b'), modelClass: 'low' as const }],
      AGENT,
      pinned.childDefaults
    )
    expect(over.ok).toBe(true)
    if (!over.ok) return
    for (const child of over.children) {
      expect(tasks.requireTask(child.id).constraints.modelClass).toBe('high')
    }

    const open = planner()
    const hinted = split.applySplit(
      open.id,
      [{ ...piece('a'), modelClass: 'low' as const }, { ...piece('b'), modelClass: 'low' as const }],
      AGENT,
      open.childDefaults
    )
    expect(hinted.ok).toBe(true)
    if (!hinted.ok) return
    for (const child of hinted.children) {
      expect(tasks.requireTask(child.id).constraints.modelClass).toBe('low')
    }
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

  /**
   * ⛔ **The three things a handoff must not do**, and all three are silent when wrong.
   *
   * A `settled` edge back onto the planner parks it at `blocked` waiting for a resolution turn that
   * is never dispatched — nothing in `admit` has a way out of that. A `landingTarget` of the plan
   * branch merges the executor's work into a branch no third turn will ever carry to the trunk, so
   * the work is done, verified and goes nowhere. And a `blocked` status would race the completion
   * the caller performs through the ordinary finish path.
   */
  it('hands one executor the work, and neither waits for it nor keeps it off the trunk', () => {
    const parent = handoffPlanner({ childDefaults: { workerIds: [CX] } })
    const result = split.applySplit(parent.id, [piece('do the whole job')], AGENT, parent.childDefaults)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.children).toHaveLength(1)

    const executor = tasks.requireTask(result.children[0]!.id)
    // ⛔ The project's own target, which is what `null` resolves to — never the plan branch.
    expect(executor.landingTarget).toBeNull()
    expect(executor.status).toBe('ready')
    expect(executor.parentTaskId).toBe(parent.id)
    expect(executor.constraints.workerIds).toEqual([CX])

    const after = tasks.requireTask(parent.id)
    expect(after.dependsOn).toEqual([])
    // ⚠️ Left exactly as it was: the caller completes it through `completeTask`, and a status
    //    written here would be a second answer racing that one.
    expect(after.status).toBe(parent.status)
  })

  // ⛔ Beside the test above, because the contrast is the claim: the same function, the same
  //    arguments, and a split *does* take the edge and the plan branch.
  it('still parks a Plan & Split on its pieces and lands them onto its own branch', () => {
    const parent = planner()
    const result = split.applySplit(parent.id, [piece('a'), piece('b')], AGENT, parent.childDefaults)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(tasks.requireTask(result.children[0]!.id).landingTarget).toBe('warmstart/t1-build-the-thing')
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
    expect(tasks.requireTask(parent.id).dependsOn).toHaveLength(2)
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

describe('splitApprovalFor', () => {
  const instruction = [
    'Rework the retry loop in src/daemon/scheduler.ts.',
    '',
    'Change `backoffFor` to cap at 30s, leave everything else alone.',
    'Done means the existing retry tests pass unchanged.'
  ].join('\n')

  it('hands the operator the whole executor instruction, not just its first line', () => {
    const parent = handoffPlanner()
    const approval = split.splitApprovalFor(parent, [piece(instruction)])
    // ⛔ t693: the card approved a one-line label while this text became the executor's
    // prompt verbatim. The approval has to carry the same bytes the executor will receive.
    expect(approval.question).toContain(instruction)
    expect(approval.header).toMatch(/Hand t\d+ to an executor/)
  })

  it('leaves a Plan & Split approval as one-line labels', () => {
    const parent = planner()
    const approval = split.splitApprovalFor(parent, [piece('first piece'), piece('second piece')])
    expect(approval.question).toContain('1. first piece')
    expect(approval.question).toContain('2. second piece')
    expect(approval.header).toMatch(/Split t\d+ into 2/)
  })

  it('does not leak one split piece\u2019s full body into another piece\u2019s approval', () => {
    const parent = planner()
    const approval = split.splitApprovalFor(parent, [piece('alpha\nsecond line'), piece('beta')])
    expect(approval.question).not.toContain('second line')
  })
})

describe('delegation target routing (worker, adapter, model, effort) (t843)', () => {
  it('resolves adapters by id, command, label, and alias', () => {
    expect(split.resolveAdapterReference('openai-compatible')).toBe('openai-compatible')
    expect(split.resolveAdapterReference('codex')).toBe('openai-compatible')
    expect(split.resolveAdapterReference('OpenAI Codex')).toBe('openai-compatible')
    expect(split.resolveAdapterReference('claude')).toBe('claude-code')
    expect(split.resolveAdapterReference('claude-code')).toBe('claude-code')
    expect(split.resolveAdapterReference('anthropic')).toBe('claude-code')
    expect(split.resolveAdapterReference('agy')).toBe('antigravity-cli')
    expect(split.resolveAdapterReference('antigravity')).toBe('antigravity-cli')
    expect(split.resolveAdapterReference('muse')).toBe('muse-code')
    expect(split.resolveAdapterReference('unknown-adapter')).toBeNull()
  })

  it('resolves workers by id, label, case-insensitively, and normalized', () => {
    const w = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexFirst', enabled: true })
    expect(split.resolveWorkerReference(w.id)?.id).toBe(w.id)
    expect(split.resolveWorkerReference('CodexFirst')?.id).toBe(w.id)
    expect(split.resolveWorkerReference('codexfirst')?.id).toBe(w.id)
    expect(split.resolveWorkerReference('codex first')?.id).toBe(w.id)
    expect(split.resolveWorkerReference('NonExistent')).toBeNull()
  })

  it('validates target worker and adapter constraints', () => {
    const parent = planner()
    const active = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexActive', enabled: true })
    const disabled = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexDisabled', enabled: false })
    const retired = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexRetired', enabled: true })
    workers.retireWorker(retired.id)

    // Unknown worker
    const unknownWorker = split.validateSplit(parent, [
      { ...piece('p1'), worker: 'Ghost' },
      piece('p2')
    ])
    expect(unknownWorker.ok).toBe(false)
    expect(unknownWorker.ok === false && unknownWorker.reason).toMatch(/unknown worker 'Ghost'/)

    // Disabled worker
    const dis = split.validateSplit(parent, [
      { ...piece('p1'), worker: disabled.id },
      piece('p2')
    ])
    expect(dis.ok).toBe(false)
    expect(dis.ok === false && dis.reason).toMatch(/cannot do work/)

    // Retired worker
    const ret = split.validateSplit(parent, [
      { ...piece('p1'), worker: retired.id },
      piece('p2')
    ])
    expect(ret.ok).toBe(false)
    expect(ret.ok === false && ret.reason).toMatch(/retired worker/)

    // Unknown adapter
    const unknownAdapter = split.validateSplit(parent, [
      { ...piece('p1'), adapter: 'nonexistent-adapter' },
      piece('p2')
    ])
    expect(unknownAdapter.ok).toBe(false)
    expect(unknownAdapter.ok === false && unknownAdapter.reason).toMatch(/unknown adapter 'nonexistent-adapter'/)

    // Conflicting worker and adapter
    const conflict = split.validateSplit(parent, [
      { ...piece('p1'), worker: active.id, adapter: 'claude-code' },
      piece('p2')
    ])
    expect(conflict.ok).toBe(false)
    expect(conflict.ok === false && conflict.reason).toMatch(/conflicts with specified adapter/)

    // Invalid modelClass
    const badClass = split.validateSplit(parent, [
      { ...piece('p1'), modelClass: 'ultra' as unknown as 'high' },
      piece('p2')
    ])
    expect(badClass.ok).toBe(false)
    expect(badClass.ok === false && badClass.reason).toMatch(/invalid model class/)

    // Valid configuration
    const valid = split.validateSplit(parent, [
      { ...piece('p1'), worker: 'CodexActive', adapter: 'codex', modelClass: 'high' },
      piece('p2')
    ])
    expect(valid.ok).toBe(true)
  })

  it('formats target labels on approval cards', () => {
    const parent = planner()
    const w = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexFirst', enabled: true })
    const approval = split.splitApprovalFor(parent, [
      { ...piece('first piece'), worker: w.id, modelClass: 'high' },
      { ...piece('second piece'), adapter: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
      { ...piece('third piece'), worker: 'CodexFirst', model: 'AutoModel (med)' }
    ])
    expect(approval.question).toContain('1. first piece _(worker: CodexFirst, class: high)_')
    expect(approval.question).toContain('2. second piece _(adapter: claude-code, model: claude-sonnet-5-5, effort: high)_')
    expect(approval.question).toContain('3. third piece _(worker: CodexFirst, class: med)_')
  })

  it('applies worker, adapter, model, and effort to child task constraints and assigneeHint', () => {
    const parent = planner()
    const codex = workers.createWorker({ adapterId: 'openai-compatible', label: 'CodexFirst', enabled: true })
    workers.createWorker({ adapterId: 'claude-code', label: 'ClaudeFirst', enabled: true })

    const result = split.applySplit(
      parent.id,
      [
        { ...piece('task for codex'), worker: 'CodexFirst', modelClass: 'high' },
        { ...piece('task for claude'), adapter: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
        { ...piece('task auto model parse'), worker: codex.id, model: 'AutoModel (low)' }
      ],
      AGENT
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [c1, c2, c3] = result.children

    // Child 1: pinned to CodexFirst worker, class high
    const t1 = tasks.requireTask(c1!.id)
    expect(t1.assigneeHint).toBe(codex.id)
    expect(t1.constraints.workerId).toBe(codex.id)
    expect(t1.constraints.workerIds).toEqual([codex.id])
    expect(t1.constraints.adapterId).toBe('openai-compatible')
    expect(t1.constraints.modelClass).toBe('high')
    expect(t1.constraints.modelPolicy).toBe('auto')

    // Child 2: pinned to claude adapter, model claude-sonnet-5-5, effort high
    const t2 = tasks.requireTask(c2!.id)
    expect(t2.assigneeHint).toBeNull()
    expect(t2.constraints.adapterId).toBe('claude-code')
    expect(t2.constraints.model).toBe('claude-sonnet-5-5')
    expect(t2.constraints.effort).toBe('high')
    expect(t2.constraints.modelClass).toBeUndefined()

    // Child 3: AutoModel parsed from model string to class low
    const t3 = tasks.requireTask(c3!.id)
    expect(t3.assigneeHint).toBe(codex.id)
    expect(t3.constraints.workerId).toBe(codex.id)
    expect(t3.constraints.adapterId).toBe('openai-compatible')
    expect(t3.constraints.modelClass).toBe('low')
    expect(t3.constraints.modelPolicy).toBe('auto')
    expect(t3.constraints.model).toBeUndefined()
  })
})
