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

/**
 * Saying something to a task that has stopped.
 *
 * ⛔ **The message was already being delivered; what was missing was a run.** Measured 2026-08-27:
 * *"Please commit to the main branch"* was typed at a completed task, `deliverToLiveSession` pushed
 * it straight into the still-warm session and returned true — and from the operator's side nothing
 * whatsoever happened. No run, so nothing metered, no status moved, no activity appeared, and no
 * landing was attempted when the agent finished. The UI meanwhile said "Nothing is running, so this
 * waits… it is prepended to the next run's prompt", which is true of the code and false of the
 * world: a finished task has no next run.
 *
 * ⚠️ A **continuation, not a new task**. Same thread, same budget, same branch — a new `run`, which
 * is exactly what a run is for. Routing follows by construction rather than by instruction:
 * `warmSessionFor` already scores the session holding this task's context highest, so the same
 * worker, workspace and session win because they are cheapest, not because anything hard-codes them.
 */
describe('continuing a task that has stopped', () => {
  const settle = (status: 'completed' | 'awaiting_human' | 'failed' | 'paused_user' | 'cancelled') => {
    const seeded = seedRunningTask()
    tasks.setStatus(seeded.task.id, status)
    return seeded
  }

  it('starts another run rather than waiting for one that will never come', () => {
    const { task } = settle('completed')
    expect(scheduler.continueTask(task.id)).toBe('requeued')
    expect(tasks.getTask(task.id)?.status).toBe('ready')
  })

  it('wakes a task from every state work can still be added to', () => {
    for (const status of ['completed', 'awaiting_human', 'failed', 'paused_user', 'cancelled'] as const) {
      const { task } = settle(status)
      expect(scheduler.continueTask(task.id), status).toBe('requeued')
      expect(tasks.getTask(task.id)?.status, status).toBe('ready')
    }
  })

  it('leaves a running task alone, because its run is already open', () => {
    // ⛔ Re-queueing here would open a second run against a session that is mid-turn.
    const { task } = seedRunningTask()
    expect(scheduler.continueTask(task.id)).toBe('delivered')
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('will not promote a draft somebody is still writing', () => {
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'draft')
    expect(scheduler.continueTask(task.id)).toBe('queued')
    expect(tasks.getTask(task.id)?.status).toBe('draft')
  })

  it('drops a resume time a person has just overtaken', () => {
    // ⚠️ A task parked by preemption carries `not_before = <window reset>`. Somebody asking for
    // something now must not be told to come back in four hours.
    const { task } = settle('paused_quota' as 'paused_user')
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(Date.now() + 4 * 60 * 60 * 1000, task.id)
    scheduler.continueTask(task.id)
    expect(tasks.getTask(task.id)?.notBefore).toBeNull()
  })

  it('says so in the thread, so the record shows why it ran again', () => {
    const { task } = settle('completed')
    scheduler.continueTask(task.id)
    const said = tasks.messagesFor(task.id).map((m) => m.text).join('\n')
    expect(said).toContain('same thread, a new run')
  })

  it('clears the assignee so the scheduler chooses again', () => {
    // ⚠️ It will almost always choose the same worker — that is what `warmSessionFor` is for — but it
    // must *choose*: the account that ran this last may since have been benched or run out of window.
    const { task } = settle('completed')
    scheduler.continueTask(task.id)
    expect(tasks.getTask(task.id)?.assignee).toBeNull()
  })

  it('is a no-op on a task that does not exist', () => {
    expect(scheduler.continueTask('nope')).toBe('ignored')
  })
})

/**
 * The decision `awaiting_human` is asking for.
 *
 * ⛔ It is the one status explicitly about the operator, and it was the only one they could not act
 * on. Every other resting state has a button — Resume, Queue, Cancel, Delete — while the state
 * meaning *a decision is wanted from you* offered nowhere to record the decision. Measured
 * 2026-08-27: t3's work was done and committed by hand, landing declined it, and the task sat in
 * `awaiting_human` next to a run marked `completed`. The only exits were to cancel work that had
 * succeeded or to delete the record of it.
 */
describe('answering a task that is waiting on a person', () => {
  it('records the answer as a judgement, not as a verification', () => {
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    scheduler.resolveTask(task.id)
    expect(tasks.getTask(task.id)?.status).toBe('completed')
    // ⚠️ `task_complete` stays the only signal that an *agent* finished. This is the separate and
    // equally legitimate signal that a person is satisfied, and it says so in the thread.
    const said = tasks.messagesFor(task.id).map((m) => m.text).join('\n')
    expect(said).toContain('Marked done by you')
    expect(said).toContain('Nothing here verified the work')
  })

  it('keeps a note when one is given, because "why" outlives the click', () => {
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    scheduler.resolveTask(task.id, 'committed by hand, landing was right to refuse')
    expect(tasks.messagesFor(task.id).map((m) => m.text).join('\n')).toContain('landing was right')
  })

  it('unblocks whatever was waiting on it', () => {
    // ⛔ Exactly as an agent completion does. Without this, every blocked child of a hand-resolved
    // task waits on a parent that will never move again.
    const { task } = seedRunningTask()
    const child = tasks.createTask({
      title: 'downstream',
      createdBy: { kind: 'human' },
      dependsOn: [task.id]
    })
    expect(tasks.getTask(child.id)?.status).toBe('blocked')

    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    scheduler.resolveTask(task.id)
    expect(tasks.getTask(child.id)?.status).toBe('ready')
  })

  it('is idempotent, so a double click is not a second decision', () => {
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    scheduler.resolveTask(task.id)
    const before = tasks.messagesFor(task.id).length
    scheduler.resolveTask(task.id)
    expect(tasks.messagesFor(task.id).length).toBe(before)
  })
})

describe('why a task is waiting', () => {
  it('is written onto the task, not only into the thread', () => {
    // ⛔ An `awaiting_human` task with no stated reason says a decision is wanted without saying what
    // about — and sits beside a run marked `completed`, which reads as a contradiction until
    // somebody opens the thread and finds the sentence.
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: 'the work is done but did not land: the workspace has uncommitted changes'
    })
    expect(tasks.getTask(task.id)?.holdReason).toContain('did not land')
  })

  it('moves with the status and never outlives it', () => {
    // ⚠️ A reason belongs to the state that produced it. One left behind by the next transition is
    // read as current, which is worse than having none.
    const { task } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'needs you' })
    tasks.setStatus(task.id, 'running', { assignee: 'w' })
    expect(tasks.getTask(task.id)?.holdReason).toBeNull()
  })
})

/**
 * The DAG's only moving part.
 *
 * ⛔ Found 2026-08-27 by a test written for something else. The scheduler carried a private copy of
 * `admitDependents` that re-set each dependent to the status it already had — a no-op dressed as an
 * admission — so **a completed task never unblocked anything and the DAG never advanced past its
 * first edge**. Nothing else re-admits a `blocked` task; `admitScheduled()` looks only at `scheduled`
 * ones. The correct implementation was in `tasks.ts`, exported, and called by nobody.
 *
 * ⚠️ These assert the *edge*, on every path that can close a task, because one working path and one
 * broken one is exactly the state this was in.
 */
describe('a dependency edge, once its parent is done', () => {
  const chain = () => {
    const parent = tasks.createTask({ title: 'parent', createdBy: { kind: 'human' } })
    const child = tasks.createTask({
      title: 'child',
      createdBy: { kind: 'human' },
      dependsOn: [parent.id]
    })
    expect(tasks.getTask(child.id)?.status).toBe('blocked')
    return { parent, child }
  }

  it('releases when the parent completes', () => {
    const { parent, child } = chain()
    tasks.setStatus(parent.id, 'completed')
    tasks.admitDependents(parent.id)
    expect(tasks.getTask(child.id)?.status).toBe('ready')
  })

  it('stays shut when the parent stopped without succeeding', () => {
    // ⚠️ `admit` asks for `completed` specifically, and that is the point: a failed or cancelled
    // parent has not produced whatever the child was waiting for.
    for (const ending of ['failed', 'cancelled', 'awaiting_human'] as const) {
      const { parent, child } = chain()
      tasks.setStatus(parent.id, ending)
      tasks.admitDependents(parent.id)
      expect(tasks.getTask(child.id)?.status, ending).toBe('blocked')
    }
  })

  it('waits for every parent, not just the one that finished', () => {
    const first = tasks.createTask({ title: 'first', createdBy: { kind: 'human' } })
    const second = tasks.createTask({ title: 'second', createdBy: { kind: 'human' } })
    const child = tasks.createTask({
      title: 'both',
      createdBy: { kind: 'human' },
      dependsOn: [first.id, second.id]
    })
    tasks.setStatus(first.id, 'completed')
    tasks.admitDependents(first.id)
    expect(tasks.getTask(child.id)?.status).toBe('blocked')

    tasks.setStatus(second.id, 'completed')
    tasks.admitDependents(second.id)
    expect(tasks.getTask(child.id)?.status).toBe('ready')
  })

  it('respects a start time the child is still waiting for', () => {
    const parent = tasks.createTask({ title: 'p', createdBy: { kind: 'human' } })
    const child = tasks.createTask({
      title: 'later',
      createdBy: { kind: 'human' },
      dependsOn: [parent.id],
      notBefore: Date.now() + 60 * 60 * 1000
    })
    tasks.setStatus(parent.id, 'completed')
    tasks.admitDependents(parent.id)
    // ⛔ `scheduled`, not `ready`. Unblocking is not the same as being due.
    expect(tasks.getTask(child.id)?.status).toBe('scheduled')
  })
})
