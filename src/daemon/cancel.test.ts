/**
 * `cancelTask` reaches exactly the canonical children — and destroys nothing.
 *
 * ⛔ Cancel is not delete: after a cancel the task row, its thread and its runs are all still
 * there; only the status moved. And what a cancel *reaches* is `split.ts`'s `childrenOf`, which
 * requires both halves of a split edge (the child in `parent.dependsOn` **and**
 * `parentTaskId` on the child). A follow-up filed with only `parentTaskId` is not a piece of a
 * split, and cancelling the parent leaves it alone.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applySplit } from './split.js'
import { cancelTask, deleteBlockers, resumeTask } from './cancel.js'
import { makeTask, openTestDb, seedRun } from './testkit.js'
import { closeDb, db } from './db.js'
import { messagesFor, requireTask } from './tasks.js'

let dir: string

beforeAll(async () => {
  dir = openTestDb('cancel-', 'cancel.db')
  mkdirSync(join(dir, 'adapters'), { recursive: true })
})

afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

/** A planner with a branch, the way a dispatched planner holds one. */
function branchedPlanner(): string {
  const parent = makeTask({ title: 'planner', kind: 'plan' })
  db().prepare('update tasks set branch = ? where id = ?').run('warmstart/t9-probe', parent.id)
  return parent.id
}

describe('cancel reaches the canonical children', () => {
  it('cancels both halves of a real split with the same resting state', async () => {
    const parentId = branchedPlanner()
    const split = applySplit(
      parentId,
      [{ title: 'piece one', dependsOn: [] }, { title: 'piece two', dependsOn: [] }],
      { kind: 'human' }
    )
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const [first, second] = split.children

    await cancelTask(parentId, { restingState: 'cancelled', requestedBy: 'human' })

    expect(requireTask(parentId).status).toBe('cancelled')
    expect(requireTask(first!.id).status).toBe('cancelled')
    expect(requireTask(second!.id).status).toBe('cancelled')
  })

  it('leaves a follow-up filed with only parentTaskId alone', async () => {
    const parentId = branchedPlanner()
    const split = applySplit(parentId, [{ title: 'piece one', dependsOn: [] }, { title: 'piece two', dependsOn: [] }], { kind: 'human' })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    // ⛔ One-sided on purpose: the child names its parent, but the parent names no such piece.
    // This is what `agent.createTask` files — a follow-up, not a split piece.
    const followUp = makeTask({ title: 'follow-up', parentTaskId: parentId })

    await cancelTask(parentId, { restingState: 'cancelled', requestedBy: 'human' })

    const [first] = split.children
    expect(requireTask(first!.id).status).toBe('cancelled')
    expect(requireTask(followUp.id).status).toBe('ready')
  })

  it('deleteBlockers names pieces, not follow-ups', () => {
    const parentId = branchedPlanner()
    const split = applySplit(parentId, [{ title: 'piece one', dependsOn: [] }, { title: 'piece two', dependsOn: [] }], { kind: 'human' })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const followUp = makeTask({ title: 'follow-up', parentTaskId: parentId })

    const blockers = deleteBlockers(parentId)
    expect(blockers.ok).toBe(false)
    // The pieces block deletion; the follow-up is not named.
    expect(blockers.reasons.some((r) => r.includes('piece one'))).toBe(true)
    expect(blockers.reasons.some((r) => r.includes('follow-up'))).toBe(false)
    void followUp
  })
})

describe('cancel is not delete', () => {
  it('keeps the task row, its thread and its runs', async () => {
    const task = makeTask({ title: 'doomed work' })
    seedRun({ id: 'run-doomed', workerId: 'w-doomed', taskId: task.id, endedAt: Date.now() })
    const messagesBefore = messagesFor(task.id).length

    await cancelTask(task.id, { restingState: 'cancelled', requestedBy: 'human' })

    expect(requireTask(task.id).status).toBe('cancelled')
    expect(messagesFor(task.id).length).toBeGreaterThan(messagesBefore)
    const run = db().prepare('select id from runs where id = ?').get('run-doomed') as
      | { id: string }
      | undefined
    expect(run?.id).toBe('run-doomed')
  })
})

describe('resumeTask (failed and paused tasks)', () => {
  it('resumes a failed task back to ready, clearing assignee and holdReason', () => {
    const task = makeTask({ title: 'failed task' })
    db().prepare("update tasks set status = 'failed', assignee = 'w-failed', hold_reason = 'out of capacity' where id = ?").run(task.id)
    const resumed = resumeTask(task.id)
    expect(resumed.status).toBe('ready')
    expect(resumed.assignee).toBeNull()
    expect(resumed.holdReason).toBeNull()
    expect(messagesFor(task.id).some((m) => m.text === 'Retried')).toBe(true)
  })

  it('resumes paused_user task back to ready', () => {
    const task = makeTask({ title: 'paused task' })
    db().prepare("update tasks set status = 'paused_user' where id = ?").run(task.id)
    const resumed = resumeTask(task.id)
    expect(resumed.status).toBe('ready')
    expect(messagesFor(task.id).some((m) => m.text === 'Resumed')).toBe(true)
  })
})
