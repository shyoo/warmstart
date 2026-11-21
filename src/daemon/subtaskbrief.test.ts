import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '@shared/tasks.js'

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let split: typeof import('./split.js')
let delegation: typeof import('./delegation.js')
let projects: typeof import('./projects.js')
let prompt: typeof import('./prompt.js')
let brief: typeof import('./subtaskbrief.js')

const AGENT: Principal = { kind: 'agent', workerId: 'w-test', sessionId: 's-test', runId: 'r-test' }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-subtaskbrief-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  split = await import('./split.js')
  delegation = await import('./delegation.js')
  projects = await import('./projects.js')
  prompt = await import('./prompt.js')
  brief = await import('./subtaskbrief.js')
  db.openDb(join(dir, 'subtaskbrief.db'))
})

beforeEach(() => {
  db.db().exec('delete from delegation_brief_alarms')
  db.db().exec('delete from delegations')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from task_messages')
  db.db().exec('delete from runs')
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

function caller(kind: 'work' | 'conversation', status: 'running' | 'awaiting_human' | 'paused_user' = 'running') {
  const task = tasks.createTask({ title: `Parent ${kind}`, kind, status: 'ready' })
  db.db()
    .prepare("update tasks set branch = ?, status = ? where id = ?")
    .run('warmstart/t1-parent', status, task.id)
  return tasks.requireTask(task.id)
}

describe('subtask brief formatting and counts', () => {
  it('formats concise one-line-per-subtask progress across statuses and supports includeClosed: false', () => {
    const parent = caller('conversation')
    const now = 10_000_000

    const tRunning = tasks.createTask({ title: 'Running task', parentTaskId: parent.id, createdBy: AGENT })
    db.db().prepare("update tasks set status = 'running', updated_at = ? where id = ?").run(now - 4 * 60_000, tRunning.id)

    const tReady = tasks.createTask({ title: 'Waiting task', parentTaskId: parent.id, createdBy: AGENT })

    const tBlocked = tasks.createTask({
      title: 'Blocked task',
      parentTaskId: parent.id,
      createdBy: AGENT,
      dependsOn: [tRunning.id]
    })

    const tCompleted = tasks.createTask({ title: 'Completed task', parentTaskId: parent.id, createdBy: AGENT })
    tasks.setStatus(tCompleted.id, 'completed', { branch: 'warmstart/t5-completed' })

    const tFailed = tasks.createTask({ title: 'Failed task', parentTaskId: parent.id, createdBy: AGENT })
    tasks.setStatus(tFailed.id, 'failed', { holdReason: 'tests exited 1' })

    const tHuman = tasks.createTask({ title: 'Question task', parentTaskId: parent.id, createdBy: AGENT })
    tasks.setStatus(tHuman.id, 'awaiting_human', { holdReason: 'needs choice' })

    const tCancelled = tasks.createTask({ title: 'Cancelled task', parentTaskId: parent.id, createdBy: AGENT })
    tasks.setStatus(tCancelled.id, 'cancelled')

    const full = brief.buildSubtaskBrief(parent.id, { now })
    expect(full.counts).toEqual({
      total: 7,
      open: 4,
      running: 1,
      waiting: 3,
      completed: 1,
      failed: 1,
      cancelled: 1
    })
    expect(full.headline).toContain('4 open (1 running, 3 waiting)')
    expect(full.headline).toContain('1 completed')
    expect(full.headline).toContain('1 failed')
    expect(full.headline).toContain('1 cancelled')
    expect(full.reply).toContain(`t${tRunning.seq} (running · 4m) — Running task`)
    expect(full.reply).toContain(`t${tReady.seq} (ready / waiting) — Waiting task`)
    expect(full.reply).toContain(`t${tBlocked.seq} (blocked on t${tRunning.seq}) — Blocked task`)
    expect(full.reply).toContain(`t${tCompleted.seq} (completed on \`warmstart/t${tCompleted.seq - 0}-completed\`) — Completed task`)
    expect(full.reply).toContain(`t${tFailed.seq} (failed: tests exited 1) — Failed task`)
    expect(full.reply).toContain(`t${tHuman.seq} (awaiting_human: needs choice) — Question task`)
    expect(full.reply).toContain(`t${tCancelled.seq} (cancelled) — Cancelled task`)
    expect(full.reply).toContain('Alarm: OFF')

    const openOnly = brief.buildSubtaskBrief(parent.id, { includeClosed: false, now })
    expect(openOnly.counts).toEqual(full.counts)
    expect(openOnly.reply).toContain(`t${tRunning.seq}`)
    expect(openOnly.reply).not.toContain(`t${tCompleted.seq} (`)
    expect(openOnly.reply).not.toContain(`t${tFailed.seq} (`)
    expect(openOnly.reply).not.toContain(`t${tCancelled.seq} (`)
  })
})

describe('subtask brief alarms', () => {
  it('arms, clamps interval to 5..1440, seeds settled children, and disables cleanly', () => {
    const parent = caller('conversation')
    const alreadyDone = tasks.createTask({ title: 'Already done', parentTaskId: parent.id, createdBy: AGENT })
    tasks.setStatus(alreadyDone.id, 'completed')
    const stillOpen = tasks.createTask({ title: 'Still running', parentTaskId: parent.id, createdBy: AGENT })

    const t0 = 1_000_000
    const low = brief.setSubtaskBriefAlarm(parent.id, { intervalMinutes: 1, now: t0 })
    expect(low.enabled).toBe(true)
    expect(low.intervalMinutes).toBe(5)
    expect(low.earlyOnSettle).toBe(true)
    expect(low.nextBriefAt).toBe(t0 + 5 * 60_000)
    expect(low.reportedSettledIds).toEqual([alreadyDone.id])

    // Historical settled child does not trigger a spurious early brief
    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    expect(brief.onSubtaskSettledForBrief(alreadyDone.id, wake, t0 + 1000)).toBe(false)
    expect(wake.deliver).not.toHaveBeenCalled()

    const high = brief.setSubtaskBriefAlarm(parent.id, { intervalMinutes: 5000, earlyOnSettle: false, now: t0 })
    expect(high.intervalMinutes).toBe(1440)
    expect(high.earlyOnSettle).toBe(false)

    const disabled = brief.setSubtaskBriefAlarm(parent.id, { enabled: false, now: t0 })
    expect(disabled.enabled).toBe(false)
    expect(stillOpen.id).toBeTruthy()
  })

  it('fires periodic alarms once when due and advances next_brief_at with zero double-fire', () => {
    const parent = caller('conversation', 'running')
    tasks.createTask({ title: 'Piece A', parentTaskId: parent.id, createdBy: AGENT })
    const t0 = 2_000_000
    brief.setSubtaskBriefAlarm(parent.id, { enabled: true, intervalMinutes: 30, now: t0 })

    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    expect(brief.checkSubtaskBriefAlarms(wake, t0 + 29 * 60_000)).toBe(0)
    expect(wake.deliver).not.toHaveBeenCalled()

    const dueAt = t0 + 30 * 60_000
    expect(brief.checkSubtaskBriefAlarms(wake, dueAt)).toBe(1)
    expect(wake.deliver).toHaveBeenCalledTimes(1)

    // Second tick at the same timestamp does not double-fire
    expect(brief.checkSubtaskBriefAlarms(wake, dueAt)).toBe(0)
    expect(wake.deliver).toHaveBeenCalledTimes(1)

    const alarm = brief.getSubtaskBriefAlarm(parent.id)!
    expect(alarm.lastBriefAt).toBe(dueAt)
    expect(alarm.nextBriefAt).toBe(dueAt + 30 * 60_000)
    const msg = tasks.messagesFor(parent.id).at(-1)
    expect(msg?.event).toBe('delegation.brief')
  })

  it('fires early brief when 1 of 2 delegated subtasks completes and defers final wake to delegation.settled', () => {
    const parent = caller('conversation', 'awaiting_human')
    const res = split.applySplit(
      parent.id,
      [
        { title: 'Piece one', dependsOn: [] },
        { title: 'Piece two', dependsOn: [] }
      ],
      AGENT
    )
    if (!res.ok) throw new Error(res.reason)
    const [p1, p2] = res.children

    const t0 = 3_000_000
    brief.setSubtaskBriefAlarm(parent.id, { enabled: true, intervalMinutes: 30, earlyOnSettle: true, now: t0 })

    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    tasks.setStatus(p1!.id, 'completed', { branch: 'warmstart/t2-piece-one' })
    const earlyFired = brief.onSubtaskSettledForBrief(p1!.id, wake, t0 + 5_000)
    expect(earlyFired).toBe(true)
    expect(wake.requeue).toHaveBeenCalledTimes(1)
    expect(wake.requeue).toHaveBeenCalledWith(parent.id)
    const earlyMsg = tasks.messagesFor(parent.id).at(-1)
    expect(earlyMsg?.event).toBe('delegation.brief')
    expect(earlyMsg?.text).toContain(`Early subtask brief (t${p1!.seq} completed)`)

    // When the LAST delegated piece settles, alarm auto-disables and defers to reportDelegationIfSettled (no double wake)
    wake.requeue.mockClear()
    tasks.setStatus(p2!.id, 'completed', { branch: 'warmstart/t3-piece-two' })
    const briefAfterLast = brief.onSubtaskSettledForBrief(p2!.id, wake, t0 + 10_000)
    expect(briefAfterLast).toBe(false)
    expect(wake.requeue).not.toHaveBeenCalled()
    expect(brief.getSubtaskBriefAlarm(parent.id)?.enabled).toBe(false)

    // And reportDelegationIfSettled delivers the single delegation.settled wake
    delegation.reportDelegationIfSettled(p2!.id, wake)
    expect(wake.requeue).toHaveBeenCalledTimes(1)
    expect(tasks.messagesFor(parent.id).at(-1)?.event).toBe('delegation.settled')
  })

  it('never wakes a paused_user parent on periodic or early brief', () => {
    const parent = caller('conversation', 'paused_user')
    const c1 = tasks.createTask({ title: 'Child 1', parentTaskId: parent.id, createdBy: AGENT })
    tasks.createTask({ title: 'Child 2', parentTaskId: parent.id, createdBy: AGENT })

    const t0 = 4_000_000
    brief.setSubtaskBriefAlarm(parent.id, { enabled: true, intervalMinutes: 10, earlyOnSettle: true, now: t0 })

    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    expect(brief.checkSubtaskBriefAlarms(wake, t0 + 10 * 60_000)).toBe(0)
    expect(wake.deliver).not.toHaveBeenCalled()
    expect(wake.requeue).not.toHaveBeenCalled()
    // Clock advanced so next tick does not hot-loop
    expect(brief.getSubtaskBriefAlarm(parent.id)?.nextBriefAt).toBe(t0 + 20 * 60_000)

    tasks.setStatus(c1.id, 'completed')
    expect(brief.onSubtaskSettledForBrief(c1.id, wake, t0 + 11 * 60_000)).toBe(false)
    expect(wake.deliver).not.toHaveBeenCalled()
    expect(wake.requeue).not.toHaveBeenCalled()
    expect(tasks.messagesFor(parent.id).some((m) => m.event === 'delegation.brief')).toBe(false)
  })

  it('delivers delegation.brief messages cleanly via promptFor', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentyard-brief-proj-'))
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(join(root, '.warmstart', 'project.json'), JSON.stringify({ schema_version: 1 }))
    const projectId = projects.addProject({ root }).id

    const parent = tasks.createTask({ title: 'Orchestrate pieces', kind: 'conversation', projectId, status: 'ready' })
    tasks.addMessage(parent.id, 'system', 'Early subtask brief (t2 completed): 1 open, 1 completed', null, [], {
      event: 'delegation.brief',
      detail: 't2 (completed on `warmstart/t2-a`) — Done A\nt3 (running · 2m) — Work B'
    })
    const built = prompt.promptFor(parent, 'claude-code', false, { markDelivered: false })
    expect(built.text).toContain('Early subtask brief (t2 completed)')
    expect(built.text).toContain('t3 (running · 2m) — Work B')
    expect(built.text).toContain('subtask_brief')

    rmSync(root, { recursive: true, force: true })
  })
})
