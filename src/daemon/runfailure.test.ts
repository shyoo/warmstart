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
let questions: typeof import('./questions.js')

const ORG_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code. ' +
  'Contact your administrator or use an API key.'

/** A session row, written straight to the store: no CLI is installed in a unit test and none is needed. */
function seedSession(
  id: string,
  workerId: string,
  patch: { adapterId?: string; lastRequestStartedAt?: number } = {}
): Session {
  const adapterId = patch.adapterId ?? 'openai-compatible'
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             last_request_started_at, tokens_since_compact)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      workerId,
      adapterId,
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
    adapterId,
    transport: 'stream',
    projectId: null,
    cwd: dir,
    model: null,
    effort: null,
    state: 'live',
    pid: null,
    purpose: 'work',
    transcriptPath: null,
    vendorSessionId: null,
    currentBranch: null,
    contextTokens: null,
    contextWindow: null,
    lastRequestStartedAt: patch.lastRequestStartedAt ?? null,
    cacheExpiresAt: null,
    tokensSinceCompact: 0,
    clockMove: null,
    clockMoveAt: null,
    clockMoveAttempts: 0,
    clockMoveContext: null,
    startedAt: Date.now(),
    closedAt: null
  }
}

let seq = 0

/** A task that is running on a fresh session, as the scheduler would have left it. */
function seedRunningTask(options: { adapterId?: string; metered?: number; lastRequestStartedAt?: number } = {}) {
  seq += 1
  const adapterId = options.adapterId ?? 'openai-compatible'
  const worker = workers.createWorker({
    // ⚠️ An adapter with no `usageRefresh`, so nothing here can start a terminal. The closing quota
    // reading is a real process and belongs in the app, not in a unit test.
    adapterId,
    label: `w${seq}`,
    enabled: false
  })
  const task = tasks.createTask({ title: `t${seq}`, createdBy: { kind: 'human' } })
  const session = seedSession(`5e551011-0000-4000-8000-00000000000${seq}`, worker.id, {
    adapterId,
    lastRequestStartedAt: options.lastRequestStartedAt
  })
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
  questions = await import('./questions.js')
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

/**
 * A session that ended because the agent was waiting for a person.
 *
 * ⛔ Measured 2026-08-30 on claude-code 2.1.251 (R14.c). This is not a new *outcome* — the task still
 * rests at `awaiting_human`, which was always the honest answer — it is a new *reason*. The operator
 * used to be handed "nothing here can tell whether the work was finished" for a case where the agent
 * had said, in a record on the wire, exactly what it wanted.
 */
describe('a session that stopped to ask', () => {
  const ASKED = "let me know which approach you'd like (OAuth, session cookies, or magic-link email)"

  it('quotes what the agent was waiting for instead of reporting an unknown', async () => {
    const { task, session } = seedRunningTask({ metered: 500 })
    scheduler.noteTurnStatus(session.id, {
      category: 'blocked',
      detail: ASKED,
      needsAction: ASKED
    })
    await scheduler.onSessionExit(session, 0)

    const settled = tasks.getTask(task.id)
    expect(settled?.status).toBe('awaiting_human')
    expect(settled?.holdReason).toContain('which approach')
    expect(settled?.holdReason).not.toContain('Nothing here can tell')
  })

  it('⛔ does not file it as a failed run', async () => {
    // The decision, 2026-08-30: a run that stopped for an answer is in progress, not broken. Filing
    // it as `failed` was inferred from nothing but the absence of a completion signal.
    const { run, task, session } = seedRunningTask({ metered: 500 })
    scheduler.noteTurnStatus(session.id, { category: 'blocked', detail: ASKED, needsAction: ASKED })
    await scheduler.onSessionExit(session, 0)

    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('does not count towards the failures that summon triage', async () => {
    // ⚠️ `maybeTriage` asks why a task keeps *failing*. A task that keeps asking good questions is
    // the system working, and three of those in a row must not look like a pattern of failure.
    const { task, session } = seedRunningTask({ metered: 500 })
    scheduler.noteTurnStatus(session.id, { category: 'blocked', detail: ASKED, needsAction: ASKED })
    await scheduler.onSessionExit(session, 0)

    const failed = tasks.runsFor(task.id).filter((r) => r.outcome === 'failed')
    expect(failed).toHaveLength(0)
  })

  it('still files a genuine failure as failed', async () => {
    const { run, session } = seedRunningTask({ metered: 500 })
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'the tool exploded',
      terminalReason: 'error_during_execution'
    })
    expect(tasks.requireRun(run.id).outcome).toBe('failed')
  })

  it('is blocked because a question was open, even with no vendor record to say so', async () => {
    // ⛔ Stronger evidence than `post_turn_summary`: we watched the question be asked. An adapter
    // that emits no such record at all still gets the right outcome here.
    const { run, task, session } = seedRunningTask({ metered: 500 })
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which database should this use?'
    })
    await scheduler.onSessionExit(session, 0)

    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.holdReason).toContain('Which database')
    // Still open, so answering it later is what starts the work again.
    expect(questions.openQuestions()[0]?.answeredAt).toBeNull()
  })

  it('reports the unknown honestly when the agent said nothing', async () => {
    const { task, session } = seedRunningTask({ metered: 500 })
    await scheduler.onSessionExit(session, 0)
    expect(tasks.getTask(task.id)?.holdReason).toContain('Nothing here can tell')
  })

  it('⚠️ forgets a block that a later turn cleared', async () => {
    // A turn that blocked and a later turn that did not must not leave a stale sentence behind to be
    // reported as the reason this session ended.
    const { task, session } = seedRunningTask({ metered: 500 })
    scheduler.noteTurnStatus(session.id, { category: 'blocked', detail: ASKED, needsAction: ASKED })
    scheduler.noteTurnStatus(session.id, { category: 'in_progress', detail: null, needsAction: null })
    await scheduler.onSessionExit(session, 0)
    expect(tasks.getTask(task.id)?.holdReason).toContain('Nothing here can tell')
  })

  it('does not carry one session’s block into the next', async () => {
    const first = seedRunningTask({ metered: 500 })
    scheduler.noteTurnStatus(first.session.id, {
      category: 'blocked',
      detail: ASKED,
      needsAction: ASKED
    })
    await scheduler.onSessionExit(first.session, 0)

    const second = seedRunningTask({ metered: 500 })
    await scheduler.onSessionExit(second.session, 0)
    expect(tasks.getTask(second.task.id)?.holdReason).toContain('Nothing here can tell')
  })
})

describe('a result that is not an error', () => {
  it('on an MCP-enabled adapter is left for task_complete to signal', async () => {
    const { run, task, session } = seedRunningTask({ adapterId: 'claude-code' })
    await scheduler.onStreamResult(session, {
      isError: false,
      text: 'here is the answer',
      terminalReason: null
    })
    // ⛔ For MCP adapters, `task_complete` is the signal that a task succeeded — a bare stream
    // `result` record without `task_complete` leaves the run open.
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('on an adapter without MCP completes the task', async () => {
    const { run, task, session } = seedRunningTask({ adapterId: 'antigravity-cli' })
    await scheduler.onStreamResult(session, {
      isError: false,
      text: 'here is the completed answer',
      terminalReason: null
    })
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('completed')
    expect(tasks.messagesFor(task.id).some((m) => m.text === 'here is the completed answer')).toBe(true)
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

  it('leaves the account that did the work in the record', () => {
    // ⛔ The complaint, exactly as it arrived: "after I clicked Mark done it shows worker as *you*,
    // but the main worker was ClaudeSecond — I was only temporarily assigned to make a close call."
    // `resolveTask` used to write `assignee: 'human'` on the way to `completed`, so answering a
    // question overwrote which account had spent the tokens. The Worker column exists so a routing
    // mistake is visible without a click; this blanked it at the one moment somebody was looking.
    const { task, worker } = seedRunningTask()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    scheduler.resolveTask(task.id)
    const done = tasks.getTask(task.id)
    expect(done?.status).toBe('completed')
    expect(done?.ranOn).toBe(worker.id)
    // ⚠️ And the assignee goes back to that account too, so a hand-resolved task and an
    // agent-completed one agree about who did it. Who *answered* is in the thread, where it belongs
    // — a sentence with a reason, not a field that displaces an account.
    expect(done?.assignee).toBe(worker.id)
  })

  it('knows which account ran it even before anyone answers', () => {
    // `ranOn` is derived from the runs, so it is right in every state rather than only after one
    // particular transition remembers to preserve it.
    const { task, worker } = seedRunningTask()
    expect(tasks.getTask(task.id)?.ranOn).toBe(worker.id)
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human' })
    expect(tasks.getTask(task.id)?.ranOn).toBe(worker.id)
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

/**
 * What separates the two buttons the operator is offered.
 *
 * ⛔ They were indistinguishable on screen, and the tooltips were why: *"records that you are
 * satisfied"* and *"stops here and rests the task"* both mean **it stops**. The real difference is
 * in the DAG — `admit()` releases a dependent only when its dependency reaches `completed` — so one
 * of them starts the rest of the plan and the other leaves it waiting forever. A choice that reads
 * as a matter of taste and is not is worse than no choice at all.
 */
describe('finishing a task versus parking it', () => {
  it('releases what was waiting only when the task is completed', () => {
    const { task } = seedRunningTask()
    const child = tasks.createTask({
      title: 'downstream of the decision',
      createdBy: { kind: 'human' },
      dependsOn: [task.id]
    })
    expect(tasks.getTask(child.id)?.status).toBe('blocked')

    // "Stop here": the resting state a human cancel produces. Nothing downstream may move.
    tasks.setStatus(task.id, 'paused_user')
    tasks.admitDependents(task.id)
    expect(tasks.getTask(child.id)?.status).toBe('blocked')

    // "Mark done".
    tasks.setStatus(task.id, 'completed')
    tasks.admitDependents(task.id)
    expect(tasks.getTask(child.id)?.status).toBe('ready')
  })

  it('does not release a dependent that has already run', () => {
    // ⚠️ Which is why the count beside the button is of `blocked` dependents only. Telling somebody
    // that pressing this starts three tasks when two of them ran yesterday is a worse lie than
    // saying nothing, because it is checkable.
    const { task } = seedRunningTask()
    const child = tasks.createTask({
      title: 'already done downstream',
      createdBy: { kind: 'human' },
      dependsOn: [task.id]
    })
    tasks.setStatus(child.id, 'completed')
    tasks.setStatus(task.id, 'completed')
    tasks.admitDependents(task.id)
    expect(tasks.getTask(child.id)?.status).toBe('completed')
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
