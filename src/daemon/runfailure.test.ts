import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * What happens to a task when the run under it does not succeed.
 *
 * ⛔ **The case that motivated this file did not fail by exiting.** Measured 2026-08-27: a worker
 * whose organisation had disabled Claude Code subscription access answered with
 * `{"type":"result","is_error":true,"terminal_reason":"api_error"}` carrying *"Your organization has
 * disabled Claude subscription access for Claude Code"* — and then sat there. AGENTS.md has recorded
 * since M1 that a `stream` session which cannot authenticate does not exit; what nobody had noticed
 * is that the record it sends *first* reached the session pane and nothing else. So the run stayed
 * open, the task stayed `running`, the worker's only slot stayed held, and the whole thing looked
 * like an agent thinking very hard.
 *
 * The distinction every case here turns on is **who failed**. A run that produced no metered turn
 * failed at the account; a run that produced turns and then broke failed at the work. Charging the
 * second to the worker benches a healthy fleet one bad prompt at a time; charging the first to the
 * task sends a person to debug a prompt that was never delivered to anything.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')

const ORG_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code. ' +
  'Contact your administrator or use an API key.'

/** A session row, written straight to the store: no CLI is installed in a unit test and none is needed. */
function seedSession(id: string, workerId: string, patch: { lastRequestStartedAt?: number } = {}): Session {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             last_request_started_at, tokens_since_compact)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      workerId,
      'openai-compatible',
      'stream',
      dir,
      'live',
      'work',
      Date.now(),
      patch.lastRequestStartedAt ?? null,
      0
    )
  return {
    id,
    workerId,
    adapterId: 'openai-compatible',
    transport: 'stream',
    projectId: null,
    cwd: dir,
    model: null,
    effort: null,
    state: 'live',
    pid: null,
    purpose: 'work',
    transcriptPath: null,
    contextTokens: null,
    lastRequestStartedAt: patch.lastRequestStartedAt ?? null,
    cacheExpiresAt: null,
    tokensSinceCompact: 0,
    startedAt: Date.now(),
    closedAt: null
  }
}

let seq = 0

/** A task that is running on a fresh session, as the scheduler would have left it. */
function seedRunningTask(options: { metered?: number; lastRequestStartedAt?: number } = {}) {
  seq += 1
  const worker = workers.createWorker({
    // ⚠️ An adapter with no `usageRefresh`, so nothing here can start a terminal. The closing quota
    // reading is a real process and belongs in the app, not in a unit test.
    adapterId: 'openai-compatible',
    label: `w${seq}`,
    enabled: false
  })
  const task = tasks.createTask({ title: `t${seq}`, createdBy: { kind: 'human' } })
  const session = seedSession(`5e551011-0000-4000-8000-00000000000${seq}`, worker.id)
  const run = tasks.startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  if (options.metered) {
    tasks.creditTurn(session.id, {
      input: options.metered,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    })
  }
  tasks.setStatus(task.id, 'running', { assignee: worker.id })
  return {
    worker,
    task,
    run,
    session: { ...session, lastRequestStartedAt: options.lastRequestStartedAt ?? null }
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-runfail-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  db.openDb(join(dir, 'runfail.db'))
})

beforeEach(() => {
  db.db().exec('delete from runs; delete from sessions; delete from task_messages; delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('an error the CLI reports without exiting', () => {
  it('ends the run instead of leaving it open forever', async () => {
    const { run, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    const after = tasks.requireRun(run.id)
    expect(after.endedAt).not.toBeNull()
    expect(after.outcome).toBe('failed')
  })

  it('closes the session, because an api_error does not close itself', async () => {
    const { session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    const row = db
      .db()
      .prepare('select state from sessions where id = ?')
      .get(session.id) as { state: string }
    // ⛔ The worker's only work slot is held by a live session. Leaving this one alive would take the
    // account out of the fleet until somebody noticed and killed it by hand.
    expect(row.state).toMatch(/closed|failed/)
  })

  it('never marks the task failed for it', async () => {
    // ⛔ The task is not the thing that failed. Marking it `failed` — or handing it to a person as
    // `awaiting_human` — sends somebody to read a prompt that was never delivered to anything.
    const { task, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    const settled = tasks.getTask(task.id)
    expect(settled?.status).not.toBe('failed')
    expect(settled?.status).not.toBe('awaiting_human')
  })

  it('leaves a session with no run of its own alone', async () => {
    // ⚠️ A consult or a chat session hitting an error is not a task failing, and there is no run to
    // end. Reaching for `runForSession` and finding nothing is the normal path, not an edge case.
    const { worker } = seedRunningTask()
    const stray = seedSession('5e55f00d-0000-4000-8000-00000000000f', worker.id)
    await expect(
      scheduler.onStreamResult(stray, { isError: true, text: 'nope', terminalReason: 'api_error' })
    ).resolves.toBeUndefined()
  })
})

describe('a run that produced nothing at all', () => {
  it('benches the worker and re-queues the task', async () => {
    const { worker, task, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    expect(workers.requireWorker(worker.id).health?.state).toBe('suspect')
    const settled = tasks.getTask(task.id)
    // ⛔ `ready`, not `failed` and not `awaiting_human`. Nothing about the work was attempted, and
    // the worker gate added a moment ago means the next tick cannot pick the same dead account.
    expect(settled?.status).toBe('ready')
    expect(settled?.assignee).toBeNull()
  })

  it('keeps the vendor’s own words, where the vendor said anything', async () => {
    // ⚠️ The reason has to be actionable. "produced no output" is true and sends nobody anywhere;
    // "your organization has disabled…" tells the operator exactly what to go and fix.
    const { worker, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    expect(workers.requireWorker(worker.id).health?.reason).toContain('disabled Claude subscription')
  })

  it('says so on the task, so the thread is not a mystery', async () => {
    const { task, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: true,
      text: ORG_DISABLED,
      terminalReason: 'api_error'
    })
    const said = tasks.messagesFor(task.id).map((m) => m.text).join('\n')
    expect(said).toContain('held out of dispatch')
    expect(said).toContain('back in the queue')
  })
})

describe('a run that did work and then failed', () => {
  it('is the task’s problem, not the account’s', async () => {
    const { worker, task, session } = seedRunningTask({ metered: 4_200 })
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'Tool use failed: the file could not be written',
      terminalReason: 'error_during_execution'
    })
    // ⛔ The account demonstrably works — it produced metered turns. Benching it here would take a
    // healthy worker out of the fleet because somebody wrote a bad prompt.
    expect(workers.requireWorker(worker.id).health).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('puts the reason where a person will read it', async () => {
    const { task, session } = seedRunningTask({ metered: 4_200 })
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'Tool use failed: the file could not be written',
      terminalReason: 'error_during_execution'
    })
    expect(tasks.messagesFor(task.id).map((m) => m.text).join('\n')).toContain(
      'the file could not be written'
    )
  })

  it('spares a long run that metered nothing, because the transcript lags', async () => {
    // ⚠️ A run can outlive its own metering: the transcript's final turn is routinely flushed after
    // the process is gone. Length alone is what separates "never started" from "we have not read it
    // yet", which is why the dead-on-arrival test is a conjunction.
    const { worker, task, session } = seedRunningTask()
    db.db()
      .prepare('update runs set started_at = ? where task_id = ?')
      .run(Date.now() - scheduler.DEAD_ON_ARRIVAL_MS - 60_000, task.id)
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'something went wrong late in the run',
      terminalReason: 'error_during_execution'
    })
    expect(workers.requireWorker(worker.id).health).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })
})

describe('a result that is not an error', () => {
  it('is left entirely alone', async () => {
    const { run, task, session } = seedRunningTask()
    await scheduler.onStreamResult(session, {
      isError: false,
      text: 'here is the answer',
      terminalReason: null
    })
    // ⛔ `task_complete` is the only signal that a task succeeded — a terminal `result` record is
    // not one. Treating a clean result as completion would mark work done that nobody did.
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })
})
