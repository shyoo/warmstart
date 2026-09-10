import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A task nothing will ever start, and what the fleet does about it.
 *
 * ⛔ **The complaint this file is the answer to (2026-09-07, t268).** A task was filed against a
 * worker whose CLI the daemon could not find, and it sat at `ready` with *"Muse Code is not
 * installed"* on its row, tick after tick, for as long as the daemon ran. The operator's question
 * was the right one and had no good answer: *how does that ever unblock itself?* It does not — and
 * on the queue it looked exactly like a task waiting behind a busy account, which does.
 *
 * Two rules come out of it, and both are tested here:
 *
 *  1. **A refusal that time cannot change is handed to a person**, as `awaiting_human` — the resting
 *     state that says *this needs you* and that a reply puts straight back in the queue. Never
 *     `failed`: no run was attempted and nothing was lost.
 *  2. **A refusal that time *can* change is still just a hold.** An account at capacity, out of
 *     quota, disabled for the afternoon or held out by a bad turn is a queue, and a queue must not
 *     escalate however long it lasts.
 *
 * ⚠️ Nothing here spawns a process, and nothing here depends on which CLIs this machine has: no
 * candidate is ever chosen, and the standing refusal used throughout is a **retired** account, whose
 * verdict is the same on a developer's laptop and on CI.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let projects: typeof import('./projects.js')
let scheduler: typeof import('./scheduler.js')
let workers: typeof import('./workers.js')
let eligibility: typeof import('./eligibility.js')

let projectId: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-standing-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  projects = await import('./projects.js')
  scheduler = await import('./scheduler.js')
  workers = await import('./workers.js')
  eligibility = await import('./eligibility.js')
  db.openDb(join(dir, 'standing.db'))

  const root = mkdtempSync(join(tmpdir(), 'agentyard-standing-proj-'))
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  projectId = projects.addProject({ root, name: 'standing-demo' }).id
})

beforeEach(() => {
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from workers')
  db.db().exec('delete from tasks')
  scheduler.forgetStandingHolds()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held handle on Windows is not a test failure.
  }
})

/**
 * Move the whole daemon's clock forward from wherever it is now — the only clock the grace period
 * reads. ⚠️ Relative, not absolute: the ledger is stamped when the tick runs, and a fixture that
 * spent a second setting a project up would otherwise travel a second short of the grace period.
 */
function travel(ms: number): void {
  const at = Date.now() + ms
  vi.spyOn(Date, 'now').mockReturnValue(at)
}

function worker(label: string): string {
  return workers.createWorker({ adapterId: 'claude-code', label, maxConcurrent: 1 }).id
}

function fileOn(workerId: string, title: string): string {
  return tasks.createTask({ title, projectId, constraints: { workerId } }).id
}

describe('which refusals a person has to answer', () => {
  /**
   * ⛔ The split the escalation rests on. `standing` is *waiting cannot help*, and it is deliberately
   * false for the two switches an operator is already holding in their hand.
   */
  it('calls a retired account standing and a disabled or borrowed one not', () => {
    const live = workers.requireWorker(worker('Live'))
    expect(eligibility.accountRefusal(live)?.standing).not.toBe(false)

    const off = workers.requireWorker(worker('Off'))
    workers.updateWorker(off.id, { enabled: false })
    expect(eligibility.accountRefusal(workers.requireWorker(off.id))).toEqual({
      why: 'Off disabled',
      standing: false
    })

    const borrowed = workers.requireWorker(worker('Borrowed'))
    workers.updateWorker(borrowed.id, { humanOccupied: true })
    expect(eligibility.accountRefusal(workers.requireWorker(borrowed.id))?.standing).toBe(false)

    const gone = workers.requireWorker(worker('Gone'))
    workers.retireWorker(gone.id)
    expect(eligibility.accountRefusal(workers.requireWorker(gone.id))).toEqual({
      why: 'Gone is retired',
      standing: true
    })
  })

  /** ⚠️ The sentence is unchanged for every caller that only ever wanted the sentence. */
  it('still answers the old question the old way', () => {
    const off = workers.requireWorker(worker('Off'))
    workers.updateWorker(off.id, { enabled: false })
    expect(eligibility.accountUnavailability(workers.requireWorker(off.id))).toBe('Off disabled')
  })
})

describe('a hold that nothing but a person will clear', () => {
  it('is still only a hold on the first tick', async () => {
    // ⛔ Not zero, and the reason is measured: a bridged adapter's `isInstalled()` answers *false*
    // until its first background probe returns, so a daemon that has just started must not hand its
    // operator every task pinned to that account within ten seconds of a restart.
    const gone = worker('Gone')
    const task = fileOn(gone, 'pinned to an account that no longer exists')
    workers.retireWorker(gone)

    await scheduler.tick()

    const held = tasks.requireTask(task)
    expect(held.status).toBe('ready')
    expect(held.holdReason).toBeTruthy()
  })

  it('is handed to a person once the same reason has outlived the grace period', async () => {
    const gone = worker('Gone')
    const task = fileOn(gone, 'pinned to an account that no longer exists')
    workers.retireWorker(gone)
    await scheduler.tick()
    expect(tasks.requireTask(task).status).toBe('ready')

    travel(scheduler.STANDING_HOLD_GRACE_MS + 1000)
    await scheduler.tick()

    const over = tasks.requireTask(task)
    // ⛔ `awaiting_human`, never `failed`: nothing was attempted, nothing was lost, and the task is
    // one act away from runnable.
    expect(over.status).toBe('awaiting_human')
    expect(over.assignee).toBe('human')
    expect(over.holdReason).toBeTruthy()
    expect(
      tasks.messagesFor(task).some((m) => /Nothing in this fleet can start this task/.test(m.text))
    ).toBe(true)
  })

  it('says what to do about it, and a reply really does re-queue it', async () => {
    const gone = worker('Gone')
    const task = fileOn(gone, 'pinned to an account that no longer exists')
    workers.retireWorker(gone)
    await scheduler.tick()
    travel(scheduler.STANDING_HOLD_GRACE_MS + 1000)
    await scheduler.tick()

    const said = tasks
      .messagesFor(task)
      .map((m) => m.text)
      .join('\n')
    expect(said).toMatch(/re-file this task without the pin/)

    expect(scheduler.continueTask(task)).toBe('requeued')
    expect(tasks.requireTask(task).status).toBe('ready')
  })
})

describe('a hold that the next ten minutes might clear', () => {
  it('never escalates a disabled account, however long it stays disabled', async () => {
    const off = worker('Off')
    workers.updateWorker(off, { enabled: false })
    const task = fileOn(off, 'waiting for a switch a person is already holding')

    await scheduler.tick()
    travel(scheduler.STANDING_HOLD_GRACE_MS * 3)
    await scheduler.tick()

    const still = tasks.requireTask(task)
    expect(still.status).toBe('ready')
    expect(still.holdReason).toMatch(/disabled/)
  })

  it('starts the clock when the standing reason does, not when the task was filed', async () => {
    const w = worker('Off')
    workers.updateWorker(w, { enabled: false })
    const task = fileOn(w, 'a transient hold that turned into a standing one')
    await scheduler.tick()

    // Nine minutes of a *transient* hold, and then the account is retired out from under it. The
    // grace period starts there — an age accrued against a different problem is not evidence.
    travel(scheduler.STANDING_HOLD_GRACE_MS - 60_000)
    await scheduler.tick()
    workers.retireWorker(w)
    await scheduler.tick()
    expect(tasks.requireTask(task).status).toBe('ready')

    travel(scheduler.STANDING_HOLD_GRACE_MS * 2)
    await scheduler.tick()
    expect(tasks.requireTask(task).status).toBe('awaiting_human')
  })
})
