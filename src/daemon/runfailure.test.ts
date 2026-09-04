import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session, Worker } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'

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
let sessions: typeof import('./sessions.js')
let questions: typeof import('./questions.js')
let approvals: typeof import('./approvals.js')
let transcript: typeof import('./transcript.js')
let compaction: typeof import('./compaction.js')

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

function seedRunningTask(
  options: {
    adapterId?: string
    metered?: number
    lastRequestStartedAt?: number
    startedWarm?: boolean
    contextTokens?: number
  } = {}
) {
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
  if (options.contextTokens !== undefined) {
    db.db().prepare('update sessions set context_tokens = ? where id = ?').run(options.contextTokens, session.id)
    session.contextTokens = options.contextTokens
  }
  const run = tasks.startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: null,
    quotaUnverified: true,
    costModelId: null,
    startedWarm: options.startedWarm
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
  sessions = await import('./sessions.js')
  questions = await import('./questions.js')
  approvals = await import('./approvals.js')
  transcript = await import('./transcript.js')
  compaction = await import('./compaction.js')
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

describe('a cache-clock compaction that interrupts an open run', () => {
  it('closes the session at the boundary instead of holding the run open', async () => {
    const { task, run, session } = seedRunningTask({ adapterId: 'claude-code', metered: 1000 })
    compaction.noteCompactionAsked({
      sessionId: session.id,
      taskId: task.id,
      reason: 'compaction reserve at risk',
      preTokens: 120_000
    })

    expect(
      transcript.recordCompaction(session.id, {
        preTokens: 120_000,
        durationMs: 105_000,
        trigger: 'manual'
      })
    ).toBe(true)
    const closed = db
      .db()
      .prepare('select state from sessions where id = ?')
      .get(session.id) as { state: string }
    expect(closed.state).toBe('closed')

    // A real process exit invokes this callback. Drive it explicitly because the fixture has no
    // CLI process, then assert the clock's interruption is a hold and not blamed on the work.
    await scheduler.onSessionExit({ ...session, state: 'closed', closedAt: Date.now() }, 0)
    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.requireTask(task.id).holdReason).toContain('cache clock compacted')
  })

  it('does not close a compaction initiated by the agent', () => {
    const { session } = seedRunningTask({ adapterId: 'claude-code', metered: 1000 })
    transcript.recordCompaction(session.id, {
      preTokens: 120_000,
      durationMs: 105_000,
      trigger: 'manual'
    })
    const stillLive = db
      .db()
      .prepare('select state from sessions where id = ?')
      .get(session.id) as { state: string }
    expect(stillLive.state).toBe('live')
  })

  it('lets the resume waiter continue the run after its pre-prompt compaction', () => {
    const { task, session } = seedRunningTask({ adapterId: 'claude-code', metered: 1000 })
    compaction.noteCompactionAsked({
      sessionId: session.id,
      taskId: task.id,
      reason: 'compacting the resumed conversation before prompting',
      preTokens: 120_000
    })
    let resumed = false
    compaction.onCompactionLanded(session.id, () => {
      resumed = true
    })

    transcript.recordCompaction(session.id, {
      preTokens: 120_000,
      durationMs: 105_000,
      trigger: 'manual'
    })
    expect(resumed).toBe(true)
    const stillLive = db
      .db()
      .prepare('select state from sessions where id = ?')
      .get(session.id) as { state: string }
    expect(stillLive.state).toBe('live')
  })
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

  it('spares the worker and clears the session prefix when a warm run fails on arrival', async () => {
    const { worker, task, session } = seedRunningTask({ startedWarm: true, contextTokens: 10_000 })
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'unexpected status 404 Not Found',
      terminalReason: 'turn.failed'
    })
    // ⛔ Worker must not be held out - the conversation failed to resume, not the account.
    expect(workers.requireWorker(worker.id).health).toBeNull()
    // Session context prefix cleared so it is not resumed again
    const s = sessions.getSession(session.id)
    expect(s?.contextTokens).toBe(0)
    // Task stays ready for a cold restart
    expect(tasks.getTask(task.id)?.status).toBe('ready')
    const said = tasks.messagesFor(task.id).map((m) => m.text).join('\n')
    expect(said).toContain('The conversation prefix has been cleared')
    expect(said).toContain('restart cold')
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
/**
 * ⛔ Measured on t56, 2026-08-30. Codex reported complete at 20:35:45.653; its process exited
 * 668ms later while `completeTask` was still reading the workspace; `onSessionExit` found the run
 * still open - `completeTask` closes it on its last line, after three git reads - and marked it
 * `failed` with *"nothing here can tell whether the work was finished"*, for a run that had just said
 * it was. Every adapter has this race. A one-shot CLI loses it every time.
 */
describe('a completion that is still landing when the process exits', () => {
  it('leaves the run completed when the exit follows it', async () => {
    // ⚠️ **This does not reproduce the interleaving, and would pass without the fix.** The
    // window only opens once `completeTask` awaits, which it does only for a task with a git project
    // and a held workspace - and `workspaces` is a private map with no seam a unit test can reach.
    // So this pins the observable invariant (a reported completion survives the exit that follows it)
    // and nothing more. The interleaving itself is covered by no automated test; see HANDOFF.
    const { run, task, session } = seedRunningTask({ metered: 500 })

    const landing = scheduler.completeTask(session.id, 'did the thing')
    await scheduler.onSessionExit(session, 0)
    await landing

    expect(tasks.requireRun(run.id).outcome).toBe('completed')
    expect(tasks.getTask(task.id)?.status).toBe('completed')
    expect(tasks.getTask(task.id)?.holdReason ?? '').not.toContain('Nothing here can tell')
  })

  it('still ends the run when no completion is in flight', async () => {
    // ⚠️ The guard must be narrow. A session that simply dies is the case `onSessionExit`
    // exists for, and swallowing that would leave runs open and workspaces held forever.
    const { run, session } = seedRunningTask({ metered: 500 })
    await scheduler.onSessionExit(session, 0)
    expect(tasks.requireRun(run.id).outcome).toBe('failed')
  })
})

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

/**
 * ⛔ An approval that nobody answers has to become visible as work, and until 2026-08-30 it
 * could not: `DEFAULT_ESCALATE_AFTER_MS` (30m) was longer than `WAIT_TIMEOUT_MS` (10m), so the waiter
 * always denied first and wrote `answered_at` - the column `escalateStale` filters on. The path was
 * unreachable from the day it was written and had no test. This is that test.
 */
describe('an approval nobody answers', () => {
  it('becomes work a person can see, rather than sitting invisible until it denies', async () => {
    const { task, session } = seedRunningTask({ metered: 500 })
    const pending = approvals.requestApproval({
      sessionId: session.id,
      origin: 'tool_gate',
      tool: 'Bash',
      target: 'git push --force',
      summary: 'Bash: git push --force'
    })

    expect(approvals.escalateStale(Date.now())).toBe(0)
    const past = Date.now() + approvals.DEFAULT_ESCALATE_AFTER_MS + 1000
    expect(approvals.escalateStale(past)).toBe(1)
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.holdReason).toContain('git push --force')

    // ⚠️ Escalating does not answer it. It is still open, still blocking that session, and
    // still answerable from the bar - which is the whole point of escalating before the wait ends.
    expect(approvals.openApprovals()).toHaveLength(1)
    expect(approvals.escalateStale(past + 1000)).toBe(0)

    approvals.answerApproval(approvals.openApprovals()[0]!.id, 'deny')
    await expect(pending).resolves.toBe('deny')
  })

  it('escalates before it gives up, or escalation is unreachable', () => {
    // ⛔ The ordering *is* the fix. Stated as an assertion so a later edit to either constant
    // cannot quietly restore the bug.
    expect(approvals.DEFAULT_ESCALATE_AFTER_MS).toBeLessThan(10 * 60 * 1000)
  })

  it('does not escalate one that has been answered', () => {
    const { task, session } = seedRunningTask({ metered: 500 })
    const pending = approvals.requestApproval({
      sessionId: session.id,
      origin: 'tool_gate',
      tool: 'Bash',
      target: 'npm test',
      summary: 'Bash: npm test'
    })
    approvals.answerApproval(approvals.openApprovals()[0]!.id, 'allow')
    expect(approvals.escalateStale(Date.now() + 60 * 60 * 1000)).toBe(0)
    expect(tasks.getTask(task.id)?.status).toBe('running')
    return pending
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

  it('⛔ does not complete an MCP-less run that ended by asking', async () => {
    // An adapter with no `ask_human` was given a prompt contract instead: end with `NEEDS DECISION:`
    // and stop. Completing such a run would file an unanswered question as finished work.
    // ⚠️ `openai-compatible`, not Antigravity: only one Antigravity account exists per machine and
    // the test below needs it. Both declare `mcp: false`, which is the property under test.
    const { run, task, session } = seedRunningTask({ metered: 500 })
    await scheduler.onStreamResult(session, {
      isError: false,
      text: 'I looked at both options.\nNEEDS DECISION: OAuth or session cookies?',
      terminalReason: null
    })
    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.holdReason).toContain('OAuth or session cookies?')
  })

  it('⭐ files the question as a real question, so the operator can answer it', async () => {
    // ⛔ The t63 defect, 2026-08-30. Antigravity asked which of three designs to build; the sentence
    //    was quoted into `hold_reason` and thrown away. The card, the options and the box the answer
    //    is typed into are all written against a `Question` row — and no row was ever written, so an
    //    adapter without MCP could ask a question that was structurally unanswerable.
    const { task, session } = seedRunningTask({ metered: 500 })
    await scheduler.onStreamResult(session, {
      isError: false,
      text:
        'I compared the three.\nNEEDS DECISION: how should the quota be refreshed?\n' +
        '- Leave it just-in-time — cheapest, and the routing consult may read a stale number\n' +
        '- Gate the consult — refresh the candidates first, one extra probe per decision\n' +
        '- Refresh everything up front',
      terminalReason: null
    })

    const [filed] = questions.questionsForTask(task.id)
    expect(filed, 'the question the agent asked was filed').toBeDefined()
    expect(filed?.question).toBe('how should the quota be refreshed?')
    expect(filed?.kind).toBe('choice')
    expect(filed?.options.map((o) => o.label)).toEqual([
      'Leave it just-in-time',
      'Gate the consult',
      'Refresh everything up front'
    ])
    expect(filed?.options[0]?.detail).toContain('stale number')
    // ⚠️ Born parked, and that is the truth: the turn is over, so there is no waiter and no tool
    //    result to return into. `openQuestions` still carries it, which is what puts it on the card.
    expect(filed?.parkedAt).not.toBeNull()
    expect(filed?.answeredAt).toBeNull()
    expect(questions.openQuestions().some((q) => q.id === filed?.id)).toBe(true)
  })

  it('files a multi-select question when marked with [multi] or multi phrases', async () => {
    const { task, session } = seedRunningTask({ metered: 500 })
    await scheduler.onStreamResult(session, {
      isError: false,
      text:
        'I surveyed the pipeline options.\nNEEDS DECISION: [multi] Which direct-money sources should the pipeline read?\n' +
        '- Stripe — direct credit card billing\n' +
        '- PayPal — legacy web payments\n' +
        '- In-app purchases — mobile stores',
      terminalReason: null
    })

    const [filed] = questions.questionsForTask(task.id)
    expect(filed, 'the question was filed').toBeDefined()
    expect(filed?.question).toBe('Which direct-money sources should the pipeline read?')
    expect(filed?.kind).toBe('multi')
    expect(filed?.options).toHaveLength(3)
    expect(filed?.options[0]?.label).toBe('Stripe')
    expect(filed?.options[0]?.detail).toBe('direct credit card billing')
  })

  it('detects [multi] and select-all tags in needsDecisionIn', () => {
    const tagged = scheduler.needsDecisionIn(
      'NEEDS DECISION: [multi] which components should be active?\n- Component A\n- Component B'
    )
    expect(tagged?.kind).toBe('multi')
    expect(tagged?.question).toBe('which components should be active?')
    expect(tagged?.options).toHaveLength(2)

    const phrase = scheduler.needsDecisionIn(
      'NEEDS DECISION: Select all packages to deploy\n- pkg-a\n- pkg-b'
    )
    expect(phrase?.kind).toBe('multi')
    expect(phrase?.question).toBe('Select all packages to deploy')
  })

  it('reads the options only from the contract, never out of the sentence', () => {
    // ⛔ What antigravity actually wrote on t63. There is deliberately no attempt to recover choices
    //    from prose — a question with no parsed options is still answerable in the text box.
    const inline = scheduler.needsDecisionIn(
      'NEEDS DECISION: keep it as is (Option A), gate it (Option B), or refresh everything (Option C)?'
    )
    expect(inline?.options).toEqual([])
    expect(inline?.question).toContain('Option C')

    // The list ends at the first line that is not a bullet, so a closing sentence is not an option.
    const listed = scheduler.needsDecisionIn(
      'NEEDS DECISION: which store?\n1. Postgres — we already run one\n2. SQLite\n\nI lean Postgres.'
    )
    expect(listed?.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite'])
    expect(listed?.options[1]?.detail).toBeUndefined()
  })

  it('matches the contract it gave, and not prose that resembles it', () => {
    // ⚠️ The anchor is the point. A looser match would fire on an agent *describing* a
    // decision it had already made, and park a task that was finished.
    expect(scheduler.needsDecisionIn('NEEDS DECISION: which database?')?.question).toBe(
      'which database?'
    )
    expect(scheduler.needsDecisionIn('  - NEEDS DECISION:   trimmed  ')?.question).toBe('trimmed')
    expect(scheduler.needsDecisionIn('I decided this needs decision: none really')).toBeNull()
    expect(scheduler.needsDecisionIn('there was no decision to make')).toBeNull()
    expect(scheduler.needsDecisionIn(null)).toBeNull()
  })

  it('accepts only the explicit completion contract', () => {
    expect(scheduler.taskCompletionIn('TASK COMPLETE: fixed quota parsing')).toBe('fixed quota parsing')
    expect(scheduler.taskCompletionIn('I think the task is complete.')).toBeNull()
    expect(scheduler.taskCompletionIn('TASK COMPLETE:   ')).toBeNull()
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

  it('honours an MCP-less completion contract even when Antigravity reports ERROR afterwards', async () => {
    // t163 emitted its finished answer and then an ERROR terminal record. The marker is a contract
    // from the prompt, unlike the surrounding prose, so it is sufficient evidence to finish.
    const { run, task, session } = seedRunningTask({ metered: 500 })
    await scheduler.onStreamResult(session, {
      isError: true,
      text: 'All checks passed.\nTASK COMPLETE: fixed the session context gauge',
      terminalReason: 'ERROR'
    })
    expect(tasks.requireRun(run.id).outcome).toBe('completed')
    expect(tasks.getTask(task.id)?.status).toBe('completed')
    expect(tasks.messagesFor(task.id).some((m) => m.text === 'fixed the session context gauge')).toBe(true)
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

  it('carries the model off the same run it names the account from', () => {
    // ⛔ Both come from *one* run - the latest - so the Worker column can stack them in one cell.
    // Read from two independent `order by` clauses they could disagree, and a model shown under an
    // account that never ran it is the exact misroute the column exists to make visible.
    // ⚠️ A run's model is snapshotted from its session at dispatch, and is legitimately null where
    // the session has not learned one yet; the UI falls back to what the next dispatch would ask
    // for and says which it is showing.
    const { task, worker } = seedRunningTask()
    db.db().prepare('update runs set model = ? where task_id = ?').run('claude-sonnet-5', task.id)
    expect(tasks.getTask(task.id)?.ranModel).toBe('claude-sonnet-5')
    expect(tasks.getTask(task.id)?.ranOn).toBe(worker.id)

    // A second, newer run wins - the same rule `ranOn` follows.
    const later = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: null,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    db.db().prepare('update runs set model = ? where id = ?').run('claude-opus-5', later.id)
    expect(tasks.getTask(task.id)?.ranModel).toBe('claude-opus-5')
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

describe('reconcileTasks', () => {
  it('moves running and assigned tasks to awaiting_human and terminates open runs', () => {
    const running = seedRunningTask()
    const assignedTask = tasks.createTask({ title: 'assigned', createdBy: { kind: 'human' } })
    tasks.setStatus(assignedTask.id, 'assigned', { assignee: running.worker.id })

    const recovered = scheduler.reconcileTasks()
    expect(recovered).toBe(2)

    const runningUpdated = tasks.getTask(running.task.id)
    expect(runningUpdated?.status).toBe('awaiting_human')
    expect(runningUpdated?.assignee).toBe('human')
    expect(runningUpdated?.holdReason).toContain('orchestratord restarted while this was running')

    const runs = tasks.runsFor(running.task.id)
    expect(runs[0]?.outcome).toBe('terminated')
    expect(runs[0]?.note).toBe('orchestratord restarted')

    const assignedUpdated = tasks.getTask(assignedTask.id)
    expect(assignedUpdated?.status).toBe('awaiting_human')
    expect(assignedUpdated?.assignee).toBe('human')
  })

  it('moves cancelling tasks to paused_user', () => {
    const task = tasks.createTask({ title: 'cancelling', createdBy: { kind: 'human' } })
    tasks.setStatus(task.id, 'cancelling')

    const recovered = scheduler.reconcileTasks()
    expect(recovered).toBe(1)

    const updated = tasks.getTask(task.id)
    expect(updated?.status).toBe('paused_user')
  })
})

describe('completeTask with one-shot stream adapter', () => {
  it('finishes open run when one-shot CLI finishes', async () => {
    const running = seedRunningTask({ adapterId: 'openai-compatible', metered: 1 })
    await scheduler.completeTask(running.session.id, 'done')
    const runs = tasks.runsFor(running.task.id)
    expect(runs[0]?.outcome).toBe('completed')
    expect(runs[0]?.endedAt).not.toBeNull()
  })
})

/**
 * A run the vendor refused for want of quota, arriving as prose at the end of a turn.
 *
 * ⛔ **t108, 2026-09-02.** ClaudeSecond answered `api_error: You've hit your session limit · resets
 * 4am (America/Los_Angeles)`. Nothing had failed at the work and nothing was wrong with the account
 * — the five-hour window was simply spent. It took the ordinary failure path to `awaiting_human`,
 * which is a hold that ends only when a person types something, and one did: seven hours later, at
 * 14:17Z, on a window that had reopened at 11:00Z. The two paths that already knew about this event
 * (the mid-run watchdog and a `rejected` rate-limit record) park the task on a clock that gives it
 * back by itself; this one did not recognise the same event in a different costume.
 */
describe('a turn refused because the account is out of window', () => {
  const SESSION_LIMIT = "You've hit your session limit · resets 4am (America/Los_Angeles)"

  /** Claude Code is the adapter that knows this sentence, so the case has to run on one. */
  const refuse = async (text = SESSION_LIMIT, options: { metered?: number } = {}) => {
    const seeded = seedRunningTask({ adapterId: 'claude-code', ...options })
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text,
      terminalReason: 'api_error'
    })
    return seeded
  }

  it('⭐ parks the task on a clock instead of handing it to a person', async () => {
    const { task } = await refuse()
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('paused_quota')
    // ⛔ The whole point: `paused_quota` is the one hold `resumeQuotaPaused` ends on its own, and it
    //    can only do that with a time to end on.
    expect(after.notBefore).toBeGreaterThan(Date.now())
    expect(after.assignee).toBeNull()
  })

  it('comes back by itself once that time has passed', async () => {
    const { task } = await refuse()
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(Date.now() - 1000, task.id)
    expect(tasks.resumeQuotaPaused()).toBe(1)
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('parks against the vendor’s own reset time where there is one', async () => {
    const seeded = seedRunningTask({ adapterId: 'claude-code' })
    const resetsAt = Date.now() + 47 * 60 * 1000
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(seeded.worker.id, seeded.session.id, 'five_hour', 'rejected', resetsAt, Date.now())
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text: SESSION_LIMIT,
      terminalReason: 'api_error'
    })
    expect(tasks.requireTask(seeded.task.id).notBefore).toBe(resetsAt)
  })

  it('does not charge the run to the work', async () => {
    // ⚠️ `preempted`, the same outcome the watchdog writes. Left as `failed` it counts towards
    //    `maybeTriage`, which would summon a controller to explain why a task keeps failing when
    //    what it keeps doing is running out of window.
    const { run } = await refuse()
    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
  })

  it('says so on the thread, with the time it expects to be back', async () => {
    const { task } = await refuse()
    const said = tasks.messagesFor(task.id).map((m) => m.text)
    expect(said.some((t) => /quota window, not a fault in the work/.test(t))).toBe(true)
    expect(said.some((t) => /parked until it resets/.test(t))).toBe(true)
  })

  it('⛔ still fails an ordinary error the same way it always did', async () => {
    // The account is fine and the work is not: this one belongs to a person.
    const { task, run } = await refuse('Tool use failed: the file could not be written', {
      metered: 900
    })
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.requireRun(run.id).outcome).toBe('failed')
  })

  it('⛔ does not mistake another vendor’s refusal wording for its own', async () => {
    // ⚠️ `outOfQuota` checks measured wording per adapter: Claude Code's session limit phrasing is
    //    not recognized as a Codex quota error on openai-compatible.
    const seeded = seedRunningTask({ metered: 900 })
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text: SESSION_LIMIT,
      terminalReason: 'api_error'
    })
    expect(tasks.requireTask(seeded.task.id).status).toBe('awaiting_human')
  })
})

/**
 * ⛔ **t168, 2026-09-03.** Codex answered `The agent reported a failure (error): You've hit your usage
 * limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit
 * https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:03 PM.`
 * openai-compatible previously lacked `outOfQuota`, so the refusal fell through to `awaiting_human`
 * rather than parking at `paused_quota` with `notBefore` and resuming automatically.
 */
describe('a Codex turn refused because the account is out of quota', () => {
  const CODEX_USAGE_LIMIT =
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:03 PM."

  const refuse = async (text = CODEX_USAGE_LIMIT, options: { metered?: number } = {}) => {
    const seeded = seedRunningTask({ adapterId: 'openai-compatible', ...options })
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text,
      terminalReason: 'error'
    })
    return seeded
  }

  it('⭐ parks the task at paused_quota instead of handing it to a person', async () => {
    const { task } = await refuse()
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('paused_quota')
    expect(after.notBefore).toBeGreaterThan(Date.now())
    expect(after.assignee).toBeNull()
  })

  it('comes back by itself once that time has passed', async () => {
    const { task } = await refuse()
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(Date.now() - 1000, task.id)
    expect(tasks.resumeQuotaPaused()).toBe(1)
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('parks against the rate_limits reset time when one was recorded', async () => {
    const seeded = seedRunningTask({ adapterId: 'openai-compatible' })
    const resetsAt = Date.now() + 45 * 60 * 1000
    db.db()
      .prepare(
        `insert into rate_limit_samples (worker_id, session_id, window_id, status, resets_at, sampled_at)
         values (?,?,?,?,?,?)`
      )
      .run(seeded.worker.id, seeded.session.id, '5h', 'rejected', resetsAt, Date.now())
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text: CODEX_USAGE_LIMIT,
      terminalReason: 'error'
    })
    expect(tasks.requireTask(seeded.task.id).notBefore).toBe(resetsAt)
  })

  it('does not charge the run as failed', async () => {
    const { run } = await refuse()
    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
  })

  it('says so on the thread, with the time it expects to be back', async () => {
    const { task } = await refuse()
    const said = tasks.messagesFor(task.id).map((m) => m.text)
    expect(said.some((t) => /quota window, not a fault in the work/.test(t))).toBe(true)
    expect(said.some((t) => /parked until it resets/.test(t))).toBe(true)
  })

  it('auto-resumes when quota recovers early via quotaReleaseFor', async () => {
    const { task, worker } = await refuse()
    expect(tasks.requireTask(task.id).status).toBe('paused_quota')
    const released = tasks.resumeQuotaPaused((t) => {
      if (t.id === task.id) {
        return `${worker.label}'s 5h window has reset.`
      }
      return null
    })
    expect(released).toBe(1)
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })
})

/**
 * ⛔ **t153, 2026-09-03.** Claude answered `api_error: API Error: 529 Overloaded. This is a server-side
 * issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.`
 * A temporary server-side 529 error is not a fault in the prompt or code, nor is it an account
 * authentication failure. Quarantining the worker would take healthy accounts out of commission,
 * and moving the task to `awaiting_human` halts work that could proceed automatically once the
 * provider recovers.
 */
describe('a turn failed because the remote provider is overloaded (529)', () => {
  const OVERLOAD_MSG =
    'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'

  const refuse = async (
    text = OVERLOAD_MSG,
    options: { adapterId?: string; metered?: number; existingTask?: Task; worker?: Worker } = {}
  ) => {
    const seeded = options.existingTask
      ? (() => {
          seq += 1
          const adapterId = options.adapterId ?? 'claude-code'
          const worker: Worker = options.worker ?? workers.createWorker({ adapterId, label: `w${seq}`, enabled: false })
          const session = seedSession(`5e551011-0000-4000-8000-00000000000${seq}`, worker.id, { adapterId })
          const run = tasks.startRun({
            taskId: options.existingTask.id,
            workerId: worker.id,
            sessionId: session.id,
            projectId: null,
            quotaUnverified: true,
            costModelId: null
          })
          tasks.setStatus(options.existingTask.id, 'running', { assignee: worker.id })
          return { worker, task: options.existingTask, run, session }
        })()
      : seedRunningTask({ adapterId: options.adapterId ?? 'claude-code', metered: options.metered })

    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text,
      terminalReason: 'api_error'
    })
    return seeded
  }

  it('⭐ schedules the task for automatic retry instead of handing it to a person', async () => {
    const { task } = await refuse()
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('scheduled')
    expect(after.notBefore).toBeGreaterThan(Date.now())
    expect(after.assignee).toBeNull()
    expect(after.holdReason).toMatch(/Provider overloaded \(attempt 1\/3\)/)
  })

  it('comes back by itself once that timeout has passed', async () => {
    const { task } = await refuse()
    db.db()
      .prepare('update tasks set not_before = ? where id = ?')
      .run(Date.now() - 1000, task.id)
    expect(tasks.admitScheduled()).toBe(1)
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('does not quarantine the worker on DOA when the failure is provider overload', async () => {
    // A run that metered 0 tokens would normally be deadOnArrival and strike the worker.
    // Overload is the provider's server-side outage, not a broken credential.
    const { worker } = await refuse(OVERLOAD_MSG, { metered: 0 })
    const health = workers.requireWorker(worker.id).health
    expect(health?.state).toBeUndefined()
  })

  it('does not charge the run to the work (outcome is preempted)', async () => {
    const { run } = await refuse()
    expect(tasks.requireRun(run.id).outcome).toBe('preempted')
  })

  it('says so on the thread, with the retry delay and expected time', async () => {
    const { task } = await refuse()
    const said = tasks.messagesFor(task.id).map((m) => m.text)
    expect(said.some((t) => /temporary server-side issue from the provider/.test(t))).toBe(true)
    expect(said.some((t) => /attempting again automatically/.test(t))).toBe(true)
  })

  it('applies exponential backoff across consecutive overload attempts', async () => {
    const first = await refuse()
    const task = tasks.requireTask(first.task.id)
    expect(task.holdReason).toMatch(/attempt 1\/3/)

    // Advance time and simulate second attempt
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 1000, task.id)
    tasks.admitScheduled()

    await refuse(OVERLOAD_MSG, { existingTask: task, worker: first.worker })
    const taskSecond = tasks.requireTask(task.id)
    expect(taskSecond.status).toBe('scheduled')
    expect(taskSecond.holdReason).toMatch(/attempt 2\/3/)
    // Delay for attempt 2 is OVERLOAD_RETRY_MS * 2 (120s)
    expect(taskSecond.notBefore! - Date.now()).toBeGreaterThan(65_000)

    // Advance time and simulate third attempt
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 1000, task.id)
    tasks.admitScheduled()

    await refuse(OVERLOAD_MSG, { existingTask: task, worker: first.worker })
    const taskThird = tasks.requireTask(task.id)
    expect(taskThird.status).toBe('scheduled')
    expect(taskThird.holdReason).toMatch(/attempt 3\/3/)
    // Delay for attempt 3 is OVERLOAD_RETRY_MS * 4 (240s)
    expect(taskThird.notBefore! - Date.now()).toBeGreaterThan(180_000)
  })

  it('falls back to awaiting_human when MAX_OVERLOAD_ATTEMPTS is exceeded', async () => {
    const first = await refuse()
    const task = tasks.requireTask(first.task.id)

    // Attempt 2
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 1000, task.id)
    tasks.admitScheduled()
    await refuse(OVERLOAD_MSG, { existingTask: task, worker: first.worker })

    // Attempt 3
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 1000, task.id)
    tasks.admitScheduled()
    await refuse(OVERLOAD_MSG, { existingTask: task, worker: first.worker })

    // Attempt 4 (exceeds MAX_OVERLOAD_ATTEMPTS = 3)
    db.db().prepare('update tasks set not_before = ? where id = ?').run(Date.now() - 1000, task.id)
    tasks.admitScheduled()
    await refuse(OVERLOAD_MSG, { existingTask: task, worker: first.worker })

    const finalTask = tasks.requireTask(task.id)
    expect(finalTask.status).toBe('awaiting_human')
    expect(finalTask.holdReason).toMatch(/remains overloaded after 3 attempts/)
    expect(finalTask.holdReason).toMatch(/status\.claude\.com/)
  })

  it('⛔ does not read overload into an adapter that does not implement it', async () => {
    const seeded = seedRunningTask({ adapterId: 'local-llm', metered: 900 })
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text: OVERLOAD_MSG,
      terminalReason: 'api_error'
    })
    expect(tasks.requireTask(seeded.task.id).status).toBe('awaiting_human')
  })

  it('recognizes overload on openai-compatible and schedules retry', async () => {
    const seeded = seedRunningTask({ adapterId: 'openai-compatible', metered: 0 })
    await scheduler.onStreamResult(seeded.session, {
      isError: true,
      text: 'unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses',
      terminalReason: 'turn.failed'
    })
    expect(tasks.requireTask(seeded.task.id).status).toBe('scheduled')
    expect(workers.requireWorker(seeded.worker.id).health).toBeNull()
  })
})
