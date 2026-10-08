import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * The turn that ended and said nothing, and the run nobody closed.
 *
 * ⛔ **The same defect twice, reported twice.** t249 (2026-09-06): *"t249 is completed, but the agent
 * runtime clock is still running, because the last #3 run still shows running."* t254, filed to fix
 * it, then did the identical thing to itself: *"t254 seems like completed by looking at the TUI, but
 * the tool shows that the task is still running. In other words, it looks stuck, even though it is
 * completed."*
 *
 * ⭐ **Measured, from this install's own database.** Session `d2c31abc`, adapter `claude-code`,
 * transport `stream`. Last request started 21:08:10; the agent wrote its closing summary — *"The fix
 * is minimal, focused, and solves the exact issue described"* — at 21:08:16 and stopped, without
 * calling `task_complete`. The run's `ended_at` was still null and the task was still `running`
 * **forty-five minutes later**, when the orchestratord was restarted for unrelated reasons and the
 * restart's reconciliation finally closed it. Nothing else was ever going to.
 *
 * ⛔ **Why nothing was: an ordinary run stays open until `task_complete` arrives.** That is the whole
 * of its contract and it is deliberate — `onStreamResult` will not read a paragraph of prose as a
 * completion, because completing a task on the strength of generated text is the inference this
 * project refuses to make. But a `streamPrompts` CLI does not exit when its turn ends either, so
 * `onSessionExit` — the one place that turns "no completion reported" into a resting state — never
 * ran. The turn was over, the process was idle, the clock kept counting, the workspace stayed held
 * and the worker's slot stayed reserved.
 *
 * ⛔ **What closes it, and what it must never become.** The `result` record is written down
 * (`noteIdleTurn`); `runWatchdogs` acts on it only once nothing has happened for
 * `IDLE_TURN_AFTER_MS`, and what it does is `parkForHuman` — the `await_human` verdict the agent
 * should have reached for itself. It claims nothing about the work: no landing, no commit, no
 * checks, no branch moved. The task comes to rest at `awaiting_human` carrying the agent's own last
 * words, its session warm for a reply. A test in here asserts that it is not a quieter
 * `task_complete`, because the day it becomes one is the day this file stops being a safety net.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let turnend: typeof import('./turnend.js')
let compaction: typeof import('./compaction.js')
let stall: typeof import('./stall.js')
let sessions: typeof import('./sessions.js')

let seq = 0

/** A session row written straight to the store: no CLI is installed in a unit test and none is needed. */
function seedSession(workerId: string, adapterId: string, lastRequestStartedAt: number | null): Session {
  seq += 1
  const id = `1d1e7011-0000-4000-8000-${String(seq).padStart(12, '0')}`
  const startedAt = Date.now()
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose, started_at,
                             last_request_started_at, tokens_since_compact)
       values (?,?,?,?,?,?,?,?,?,0)`
    )
    .run(id, workerId, adapterId, 'stream', dir, 'live', 'work', startedAt, lastRequestStartedAt)
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
    lastRequestStartedAt,
    cacheExpiresAt: null,
    tokensSinceCompact: 0,
    clockMove: null,
    clockMoveAt: null,
    clockMoveAttempts: 0,
    clockMoveContext: null,
    startedAt,
    closedAt: null
  }
}

/**
 * A task running on an MCP-capable adapter, exactly as t254 was.
 *
 * ⚠️ `enabled: false`, and `claude-code` because the whole defect is specific to an adapter that
 * *can* call `task_complete` — an MCP-less one has the `TASK COMPLETE:` / `NEEDS DECISION:` contract
 * instead and every branch of it already ends the run.
 */
function seedRunningTask(
  options: { adapterId?: string; kind?: 'work' | 'conversation'; metered?: number } = {}
) {
  seq += 1
  const adapterId = options.adapterId ?? 'claude-code'
  const worker = workers.createWorker({ adapterId, label: `w${seq}`, enabled: false })
  const task = tasks.createTask({
    title: `t${seq}`,
    createdBy: { kind: 'human' },
    ...(options.kind ? { kind: options.kind } : {})
  })
  const session = seedSession(worker.id, adapterId, Date.now())
  const run = tasks.startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  if (options.metered) {
    tasks.creditTurn(session.id, { input: options.metered, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
  tasks.setStatus(task.id, 'running', { assignee: worker.id })
  return { worker, task, run, session }
}

/** The turn ending as the stream reports it: a clean result, and nothing terminal in it. */
async function endTurn(session: Session, text: string | null = 'The fix is minimal and focused.') {
  await turnend.onStreamResult(session, { isError: false, text, terminalReason: null })
}

const holdReasonOf = (taskId: string): string => tasks.getTask(taskId)?.holdReason ?? ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-idleturn-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
  turnend = await import('./turnend.js')
  compaction = await import('./compaction.js')
  stall = await import('./stall.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'idleturn.db'))
})

beforeEach(() => {
  db.db().exec(
    'delete from runs; delete from sessions; delete from task_messages; delete from tasks;' +
      ' delete from compactions; delete from settings; delete from questions'
  )
  vi.useFakeTimers({ shouldAdvanceTime: false })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the turn that ended without reporting', () => {
  it('⛔ still leaves the run open on the spot, because prose is not a completion signal', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session, 'All checks pass. The fix is minimal, focused and solves the issue.')

    // ⛔ The contract this defect must not be fixed by breaking. `task_complete` remains the only
    // thing that may say the work succeeded; the result record only proves the turn is over.
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('is written down, with what the agent last said', async () => {
    const { run, session } = seedRunningTask()
    await endTurn(session, 'All checks pass.')

    const note = turnend.idleTurnFor(session.id)
    expect(note?.runId).toBe(run.id)
    expect(note?.at).toBe(Date.now())
    expect(note?.said).toBe('All checks pass.')
  })

  it('records a turn that said nothing at all as having said nothing', async () => {
    const { session } = seedRunningTask()
    await endTurn(session, '   ')
    expect(turnend.idleTurnFor(session.id)?.said).toBeNull()
  })

  it('⭐ hands the task to a person once nothing has happened for the grace period', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session, 'All checks pass. The fix is minimal, focused.')

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 10_000)
    await scheduler.tick()

    // ⛔ `blocked`, never `failed` and never `completed`. The run did work and metered turns and is
    // one answer away from carrying on: `failed` would say the opposite of what happened, and
    // `completed` would feed the estimator a job that stopped half way as a whole one.
    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.assignee).toBe('human')
    expect(holdReasonOf(task.id)).toContain('task_complete')
    // ⛔ Not in the status line (t958 ← t946): the agent's last message is unbounded and the thread
    // carries it in full, so repeating it in `holdReason` filled the ledger's *wants* row.
    expect(holdReasonOf(task.id)).not.toContain('The fix is minimal, focused.')
    expect(holdReasonOf(task.id).length).toBeLessThanOrEqual(280)
    const handoff = tasks.messagesFor(task.id).find((m) => m.text.startsWith('Over to you:'))
    expect(handoff?.text).toContain('The fix is minimal, focused.')
  })

  it('keeps a wall of a final message out of the status line (t946)', async () => {
    const { task, session } = seedRunningTask()
    const wall = `Decision card posted. ${'Nobody has answered it yet, so I stopped. '.repeat(70)}`
    await endTurn(session, wall)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(holdReasonOf(task.id).length).toBeLessThanOrEqual(280)
    expect(holdReasonOf(task.id)).toContain('landed, committed or discarded')
  })

  it('says plainly that nothing was landed, committed or discarded', async () => {
    // ⛔ The sentence an operator reads before deciding. A park that did not say this would read as
    // an admission that something was done to the branch, and the whole point is that nothing was.
    const { task, session } = seedRunningTask()
    await endTurn(session)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(holdReasonOf(task.id)).toContain('landed, committed or discarded')
    const said = tasks.messagesFor(task.id).map((m) => m.text)
    expect(said.some((t) => t.startsWith('Over to you:'))).toBe(true)
  })

  it('keeps the agent’s complete final message in the hand-off', async () => {
    // This is the only durable thread record for an MCP agent that ends its turn without a terminal
    // signal. An excerpt here made the remainder impossible to recover from the Thread UI (t521).
    const { task, session } = seedRunningTask()
    const ending = `First paragraph.\n\n${'The Cloudflare setup is ready. '.repeat(20)}Final instruction.`
    expect(ending.length).toBeGreaterThan(400)
    await endTurn(session, ending)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    const handoff = tasks.messagesFor(task.id).find((message) => message.text.startsWith('Over to you:'))
    expect(handoff?.text).toContain(ending)
    expect(handoff?.text).toContain('Final instruction.')
  })

  it('⭐ quotes the CLI’s own needs_action sentence where the turn carried one', async () => {
    // ⛔ The same preference `onSessionExit` makes. A `status_category: "blocked"` record arrives
    // *before* the result and says what the agent stopped for; the result cannot carry it. Reading
    // it here is the difference between "over to you" and a sentence the operator can answer.
    const { task, session } = seedRunningTask()
    turnend.noteTurnStatus(session.id, {
      category: 'blocked',
      detail: null,
      needsAction: 'Which database should the migration target?'
    })
    await endTurn(session, 'I got as far as the migration.')
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(holdReasonOf(task.id)).toContain('Which database should the migration target?')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('⛔ is not a quieter task_complete: the task never reaches completed', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session, 'TASK COMPLETE: everything is done and landed.')
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    // ⚠️ Even the literal words. `TASK COMPLETE:` is the contract given to adapters that *cannot*
    // call the tool; an adapter that can was told to call it, and quoting the sentence back at us is
    // not calling it. Reading it here would let any agent complete a task by writing a line.
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.status).not.toBe('completed')
  })

  it('keeps the session warm, so a reply carries on the same conversation', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    const row = db.db().prepare('select state from sessions where id = ?').get(session.id) as {
      state: string
    }
    expect(row.state).toBe('live')
  })

  it('leaves it alone until the grace period is up', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session)

    // ⚠️ Ticks all the way through the grace period. An agent that ended a turn ten seconds ago is
    // one the daemon may still be about to prompt — a wrap-up, a `/compact`, an operator's reply.
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS - 30_000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  /**
   * A tree like t946's: the agent, plus the MCP servers every session carries. `cpu` is the whole
   * tree's total, which is what `sampleProcessTree` reports.
   */
  const tree = (cpu: number, extraChildren = 1) => ({
    at: Date.now(),
    cpuSeconds: cpu,
    processes: [
      { pid: 54321, ppid: 1, name: 'claude', command: 'claude', cpuSeconds: 2 },
      ...Array.from({ length: extraChildren }, (_, i) => ({
        pid: 54322 + i, ppid: 54321, name: 'node', command: 'node mcp.js', cpuSeconds: cpu - 2
      }))
    ]
  })

  /** A running task whose session has a pid, so the watchdog has a tree to read. */
  function seedWithTree() {
    const seeded = seedRunningTask()
    db.db().prepare('update sessions set pid = 54321 where id = ?').run(seeded.session.id)
    return { ...seeded, session: sessions.getSession(seeded.session.id) as Session }
  }

  it('⭐ hands over at the end of the grace window when the tree has not worked since the turn ended (t946)', async () => {
    // The measured case, three times over: children present (the MCP servers), CPU flat. The first
    // check used to defer for lack of a baseline and only the second handed over — six minutes of
    // *running* after *Turn finished*.
    const { run, task, session } = seedWithTree()
    const spy = vi.spyOn(stall, 'sampleProcessTree').mockResolvedValue(tree(112.3))

    await endTurn(session, 'Everything is committed.')
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(spy).toHaveBeenCalledWith(54321)
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.requireRun(run.id).outcome).toBe('blocked')
    spy.mockRestore()
  })

  it('defers while a background job is really working under the session, then hands over once it stops', async () => {
    const { run, task, session } = seedWithTree()
    const spy = vi.spyOn(stall, 'sampleProcessTree').mockResolvedValue(tree(15))

    await endTurn(session, 'Still waiting for the test:all run to complete.')
    // The job burns CPU after the turn ended.
    spy.mockResolvedValue(tree(40))
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')

    // A whole window later it has done nothing more.
    spy.mockResolvedValue(tree(40.2))
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    spy.mockRestore()
  })

  it('without a reading from the turn end, takes one and looks again rather than guessing', async () => {
    const { task, session } = seedWithTree()
    const spy = vi.spyOn(stall, 'sampleProcessTree').mockResolvedValue(null) // the sampler failed at turn end

    await endTurn(session)
    spy.mockResolvedValue(tree(30))
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    spy.mockRestore()
  })

  it('a baseline taken for an earlier turn is not reused by the next one', async () => {
    const { task, session } = seedWithTree()
    const spy = vi.spyOn(stall, 'sampleProcessTree').mockResolvedValue(tree(500))
    await endTurn(session)
    expect(turnend.idleTurnFor(session.id)?.lastCpuSeconds).toBe(500)

    turnend.forgetIdleTurn(session.id)
    spy.mockResolvedValue(tree(520))
    await endTurn(session)
    expect(turnend.idleTurnFor(session.id)?.lastCpuSeconds).toBe(520)
    expect(tasks.getTask(task.id)?.status).toBe('running')
    spy.mockRestore()
  })

  it('acts once, however many ticks follow', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)

    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()

    const overs = tasks
      .messagesFor(task.id)
      .filter((m) => m.text.startsWith('Over to you:'))
    expect(overs).toHaveLength(1)
  })
})

describe('a turn that ended with jobs running in the background (t987 ← t962)', () => {
  const job = [{ id: 'bj57m2xio', description: 'Evaluation run' }]

  it('⭐ a work run is not handed to a person while the CLI lists a job, and the pane does not say the turn ended', async () => {
    // The flat tree is the t946 shape that hands over at 3 minutes; the only difference is the list.
    const { run, task, session } = seedRunningTask()
    turnend.noteBackgroundChange(session, job)

    await endTurn(session, 'The evaluation runs are going in the background.')
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
      await scheduler.tick()
    }

    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    const idlestate = await import('./idlestate.js')
    expect(idlestate.withTransient(tasks.requireTask(task.id)).idleSince).toBeUndefined()
  })

  it('and gets a fresh grace window when the last job ends, then is handed over as before', async () => {
    const { task, session } = seedRunningTask()
    turnend.noteBackgroundChange(session, job)
    await endTurn(session)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS * 3)
    await scheduler.tick()

    turnend.noteBackgroundChange(session, [])
    // The pane is told now, and the wake gets its grace: a tick straight after hands nothing over.
    const idlestate = await import('./idlestate.js')
    expect(idlestate.withTransient(tasks.requireTask(task.id)).idleSince).toEqual(expect.any(Number))
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('⭐ a conversation stays running while it lists a job, and rests at your turn if no wake follows the last one', async () => {
    const { run, task, session } = seedRunningTask({ kind: 'conversation' })
    turnend.noteBackgroundChange(session, job)

    await endTurn(session, 'The evaluation runs are going in the background.')
    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(tasks.requireRun(run.id).endedAt).toBeNull()

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS * 2)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')

    turnend.noteBackgroundChange(session, [])
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
  })

  it('a session that exits takes its jobs and its hold with it', async () => {
    const { session } = seedRunningTask({ kind: 'conversation' })
    turnend.noteBackgroundChange(session, job)
    await endTurn(session)
    const background = await import('./backgroundtasks.js')
    expect(background.heldRunOf(session.id)).not.toBeNull()

    await turnend.onSessionExit(session, 0)
    expect(background.heldRunOf(session.id)).toBeNull()
    expect(background.backgroundTasksOf(session.id)).toEqual([])
  })
})

describe('what stands the check down', () => {
  it('a request started after the turn ended — the daemon prompted it again', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session)

    // The wrap-up, the reply, the next turn: whatever it was, this session is not idle.
    await vi.advanceTimersByTimeAsync(60_000)
    db.db()
      .prepare('update sessions set last_request_started_at = ? where id = ?')
      .run(Date.now(), session.id)

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('a compaction that landed after the turn ended', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session)

    await vi.advanceTimersByTimeAsync(60_000)
    compaction.noteCompactionAsked({
      sessionId: session.id,
      taskId: task.id,
      reason: 'the cache clock compacted an idle conversation',
      preTokens: 120_000
    })
    compaction.noteCompactionLanded(session.id, { preTokens: 120_000, durationMs: 30_000 })

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('a compaction still in flight, which is the one silence that means obedience', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session)
    compaction.noteCompactionAsked({
      sessionId: session.id,
      taskId: task.id,
      reason: 'compaction reserve at risk',
      preTokens: 120_000
    })

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('a completion that landed in the meantime', async () => {
    const { run, task, session } = seedRunningTask()
    await endTurn(session)
    // `task_complete` arriving is the ordinary case, and it wins outright: the run is closed and the
    // task is settled before the watchdog ever looks.
    tasks.finishRun(run.id, 'completed', 'reported by the agent')
    tasks.setStatus(task.id, 'completed')

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(run.id).outcome).toBe('completed')
    expect(tasks.getTask(task.id)?.status).toBe('completed')
  })

  it('a note left over from a run that has already been replaced', async () => {
    // ⛔ A person replied and `continueTask` opened a second run on the same session. The note
    // describes the *first* one, and a note that outlived what it described would park a run that
    // is, at this moment, working.
    const { run, task, session, worker } = seedRunningTask()
    await endTurn(session)
    tasks.finishRun(run.id, 'blocked', 'the operator replied')
    const second = tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: worker.id })

    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.requireRun(second.id).endedAt).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })

  it('a session that exited, which onSessionExit already decided', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    expect(turnend.idleTurnFor(session.id)).not.toBeNull()

    await turnend.onSessionExit(session, 0)

    // ⛔ The note is dropped with the process. `onSessionExit` has already wound the run up and
    // written its own reason; a second verdict from the watchdog would overwrite it with a worse one.
    expect(turnend.idleTurnFor(session.id)).toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('an open conversation, whose turn ending is endConversationTurn’s to handle', async () => {
    const { run, task, session } = seedRunningTask({ kind: 'conversation' })
    await endTurn(session, 'Here is what I found.')

    // ⚠️ No note at all: a conversation is *told* to end its turn without completing, and that path
    // closes the run itself. Noting it would double up on a run that is already resting.
    expect(turnend.idleTurnFor(session.id)).toBeNull()
    expect(tasks.requireRun(run.id).outcome).toBe('completed')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
  })

  it('⛔ a conversation whose process exits after its turn keeps its workspace for the reply (t481)', async () => {
    // Codex exits once per turn, after `endConversationTurn` has already closed the run. The exit
    // used to find no open run, read the task as nobody's, and park and release the tree.
    const { task, session } = seedRunningTask({ kind: 'conversation' })
    const resources = await import('./resources.js')
    const poolId = resources.workspacePoolId(`p-${session.id}`)
    resources.upsertResource({ id: poolId, kind: 'counted', label: 'pool', members: [dir] })
    resources.claim(poolId, session.id, 1)
    await endTurn(session, 'Here is what I found.')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')

    await turnend.onSessionExit(session, 0)

    expect(resources.openClaims(poolId).map((c) => c.holder)).toEqual([task.id])
  })

  it('a turn that ended in an error, which the failure path owns', async () => {
    const { run, session } = seedRunningTask({ metered: 500 })
    await turnend.onStreamResult(session, {
      isError: true,
      text: 'api_error: something broke',
      terminalReason: 'api_error'
    })

    expect(turnend.idleTurnFor(session.id)).toBeNull()
    expect(tasks.requireRun(run.id).outcome).toBe('failed')
  })
})

/**
 * The arithmetic, on its own, because both clocks matter and only one of them is obvious.
 */
describe('idleTurnOverdue', () => {
  const NOTE = 1_000_000

  it('is false until the grace period has passed', () => {
    expect(turnend.idleTurnOverdue(NOTE, NOTE, NOTE + turnend.IDLE_TURN_AFTER_MS)).toBe(false)
    expect(turnend.idleTurnOverdue(NOTE, NOTE, NOTE + turnend.IDLE_TURN_AFTER_MS + 1)).toBe(true)
  })

  it('⛔ is false whenever anything happened after the turn ended', () => {
    // The second clock. `quietSince` folds the last request, the run's own start and the last
    // compaction into one number; any of them landing after the note means the session moved on.
    const late = NOTE + 1
    expect(turnend.idleTurnOverdue(NOTE, late, NOTE + 10 * 60_000)).toBe(false)
    expect(turnend.idleTurnOverdue(NOTE, NOTE, NOTE + 10 * 60_000)).toBe(true)
  })

  it('counts a request that started before the turn ended as part of that turn', () => {
    // ⚠️ The ordinary case, and it must not read as activity: the request that *produced* this
    // result necessarily started before it.
    expect(turnend.idleTurnOverdue(NOTE, NOTE - 6_000, NOTE + 10 * 60_000)).toBe(true)
  })
})

/**
 * ⭐ The t254 replay, end to end and at the measured timings.
 */
describe('t254, replayed', () => {
  it('does not still read as running forty-five minutes later', async () => {
    const { run, task, session } = seedRunningTask({ metered: 113_289 })

    // 21:08:10 the last request; 21:08:16 the closing summary and then silence.
    await vi.advanceTimersByTimeAsync(6_000)
    await endTurn(
      session,
      'The fix is minimal, focused, and solves the exact issue described without introducing ' +
        'any side effects or breaking changes.'
    )

    // The forty-five minutes that used to change nothing, one ten-second tick at a time.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(11 * 60_000)
      await scheduler.tick()
    }

    const settled = tasks.requireRun(run.id)
    expect(settled.endedAt).not.toBeNull()
    expect(settled.outcome).toBe('blocked')
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    // ⛔ And the clock it was the whole complaint about. `endedAt` is what every runtime reading is
    // taken from, so a run still open is a task still billing time it is not spending.
    expect(settled.endedAt! - settled.startedAt).toBeLessThan(45 * 60_000)
  })

  it('gives the worker its slot back, so the next task is not held behind a finished one', async () => {
    // ⛔ The other half of what a stuck run costs, and the one t256 was filed for: an open run holds
    // a `maxConcurrent` slot. Two defects, one cause — a run nothing closes.
    const { worker, run, task, session } = seedRunningTask()
    await endTurn(session)
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    const open = db
      .db()
      .prepare('select count(*) as n from runs where worker_id = ? and ended_at is null')
      .get(worker.id) as { n: number }
    expect(open.n).toBe(0)
    expect(tasks.requireRun(run.id).workerId).toBe(worker.id)
  })
})

/**
 * t708, 2026-09-26: the answer that went into a tool call nobody was holding.
 *
 * ⛔ Measured from this install's own log and transcript. `ask_human` asked at 22:02:12; Claude Code
 * 2.1.283 aborted the call at 22:32:12 (*"sent no response or progress for 1800s"*); the agent ended
 * its turn at 22:32:41; the daemon's waiter, good until the cache deadline at 23:01, took the
 * operator's answer at 22:33:32 — marked it delivered, and set the task `running` with no run. The UI
 * read *"waiting for the agent's first words"* for the next hour.
 */
describe('a question its turn ended on (t708)', () => {
  const ask = async (sessionId: string) => {
    const questions = await import('./questions.js')
    const pending = questions.askQuestion({
      sessionId,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which way now?',
      options: [
        { id: 'inline', label: 'Run worker inline in clone' },
        { id: 'neutralize', label: 'Neutralize the CRL gate' }
      ]
    })
    const [open] = questions.openQuestions()
    return { questions, pending, question: open! }
  }
  const answerByHand = async (id: string) => {
    const api = await import('./api.js')
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    return await handlers['question.answer']({ id, optionIds: ['neutralize'] })
  }
  const lastHuman = (taskId: string) => tasks.messagesFor(taskId).filter((m) => m.role === 'human').pop()

  it('⭐ a conversation: the late answer starts a new run carrying it, instead of vanishing', async () => {
    const { task, run, session } = seedRunningTask({ kind: 'conversation' })
    const { questions, pending, question } = await ask(session.id)
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')

    await endTurn(session, 'The operator did not respond within the wait window, so I will stop.')

    await expect(pending).resolves.toMatchObject({ status: 'parked' })
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(questions.requireQuestion(question.id).parkedAt).not.toBeNull()
    // ⚠️ Still resting on the question, not overwritten with "your turn".
    expect(holdReasonOf(task.id)).toContain('Which way now?')

    await answerByHand(question.id)

    // ⛔ `ready`, and the answer undelivered: the next run's prompt is what carries it.
    expect(tasks.getTask(task.id)?.status).toBe('ready')
    expect(lastHuman(task.id)?.text).toContain('Neutralize the CRL gate')
    expect(lastHuman(task.id)?.deliveredAt ?? null).toBeNull()
  })

  it('a work run: its run is still open, and the answer still restarts the work', async () => {
    const { task, run, session } = seedRunningTask()
    const { pending, question } = await ask(session.id)
    await endTurn(session, 'Stopping until the operator answers.')
    await expect(pending).resolves.toMatchObject({ status: 'parked' })

    await answerByHand(question.id)

    expect(tasks.getTask(task.id)?.status).toBe('ready')
    expect(tasks.requireRun(run.id).endedAt).not.toBeNull()
    expect(lastHuman(task.id)?.deliveredAt ?? null).toBeNull()
  })

  it('⛔ an answer reaching a waiter whose run has ended is a parked answer, not a live one', async () => {
    // The guard on its own, with the turn-end park never having run: any path that ends the run
    // without passing through `onStreamResult` must not hand an answer to a dead tool call.
    const { task, run, session } = seedRunningTask({ kind: 'conversation' })
    const { pending, question } = await ask(session.id)
    tasks.finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')

    const answered = await answerByHand(question.id)

    await expect(pending).resolves.toMatchObject({ status: 'void' })
    expect(answered.parkedAt).not.toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('ready')
    expect(lastHuman(task.id)?.deliveredAt ?? null).toBeNull()
  })

  it('leaves alone a status a person set while the question was open', async () => {
    const { task, session } = seedRunningTask()
    const { questions, question } = await ask(session.id)
    tasks.setStatus(task.id, 'paused_user', { assignee: null, holdReason: 'stopped by hand' })

    await endTurn(session)

    expect(questions.requireQuestion(question.id).parkedAt).not.toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('paused_user')
  })

  it('still answers live while the turn is going', async () => {
    const { task, session } = seedRunningTask()
    const { pending, question } = await ask(session.id)

    await answerByHand(question.id)

    await expect(pending).resolves.toMatchObject({ status: 'answered' })
    expect(tasks.getTask(task.id)?.status).toBe('running')
    expect(lastHuman(task.id)?.deliveredAt).not.toBeNull()
  })
})

describe('a task that reads running with no run open', () => {
  it('⛔ is handed to a person once the grace passes, and only once', async () => {
    const { task, run } = seedRunningTask({ kind: 'conversation' })
    tasks.finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')
    // What the live-answer path used to write over a turn that had already ended.
    tasks.setStatus(task.id, 'running', { assignee: 'agent', holdReason: null })

    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')

    await vi.advanceTimersByTimeAsync(scheduler.RUNLESS_AFTER_MS + 10_000)
    await scheduler.tick()
    await scheduler.tick()

    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.assignee).toBe('human')
    expect(holdReasonOf(task.id)).toContain('no run was open')
    const said = tasks.messagesFor(task.id).filter((m) => m.text === 'Nothing was running this — over to you')
    expect(said).toHaveLength(1)
  })

  it('does not touch a running task whose run is open', async () => {
    const { task } = seedRunningTask()
    await vi.advanceTimersByTimeAsync(scheduler.RUNLESS_AFTER_MS + 10_000)
    await scheduler.tick()
    expect(tasks.getTask(task.id)?.status).toBe('running')
  })
})

describe('the pane is told the turn ended (t950 ← t946)', () => {
  let idlestate: typeof import('./idlestate.js')
  let events: typeof import('./events.js')
  const sent: import('@shared/protocol.js').DaemonEvent[] = []

  beforeAll(async () => {
    idlestate = await import('./idlestate.js')
    events = await import('./events.js')
  })
  beforeEach(() => {
    sent.length = 0
    events.setEventSink((e) => sent.push(e))
  })
  afterEach(() => {
    events.setEventSink(() => {})
  })

  const lastTask = (taskId: string) =>
    [...sent].reverse().find((e) => e.type === 'task.changed' && e.task.id === taskId)

  it('⭐ a running task whose turn ended reads idleSince, on the event and on a read', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)

    const event = lastTask(task.id)
    expect(event?.type === 'task.changed' && event.task.idleSince).toEqual(expect.any(Number))
    expect(tasks.getTask(task.id)?.status).toBe('running') // the status is not changed: the run is open
    expect(idlestate.withTransient(tasks.requireTask(task.id)).idleSince).toEqual(expect.any(Number))
  })

  it('a task that has not ended a turn carries no flag', () => {
    const { task } = seedRunningTask()
    expect(idlestate.withTransient(tasks.requireTask(task.id)).idleSince).toBeUndefined()
  })

  it('⛔ a prompt written into the session clears it, and says so', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    sent.length = 0

    idlestate.clearIdleForSession(session.id) // what sendPrompt and a mid-turn stream record call
    const event = lastTask(task.id)
    expect(event?.type === 'task.changed' && event.task.idleSince).toBeUndefined()
    expect(idlestate.idleSinceOf(task.id)).toBeNull()
  })

  it('any status but running wins over a stale mark', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    tasks.setStatus(task.id, 'awaiting_human')
    expect(idlestate.withTransient(tasks.requireTask(task.id)).idleSince).toBeUndefined()
  })

  it('the hand-over clears it without a frame of working in between', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    sent.length = 0
    await vi.advanceTimersByTimeAsync(turnend.IDLE_TURN_AFTER_MS + 1000)
    await scheduler.tick()

    const changes = sent.filter((e) => e.type === 'task.changed' && e.task.id === task.id)
    expect(changes.length).toBeGreaterThan(0)
    // Every broadcast after the hand-over started is already awaiting_human: none says running again.
    expect(changes.every((e) => e.type === 'task.changed' && e.task.status !== 'running')).toBe(true)
    expect(idlestate.idleSinceOf(task.id)).toBeNull()
  })

  it('⛔ both things that start a turn clear it: a prompt written in, and a mid-turn stream record', () => {
    // L1 has no live PTY, so the two call sites are pinned at source level (see useAction.test.ts).
    const source = readFileSync(fileURLToPath(new URL('./sessions.ts', import.meta.url)), 'utf8')
    const clears = source.split('clearIdleForSession(id)').length - 1
    expect(clears).toBe(2)
    const evidence = source.indexOf('if (isRequestEvidence(event.kind)) {')
    expect(source.indexOf('clearIdleForSession(id)', evidence)).toBeLessThan(source.indexOf('renderForHuman(event, entry.asked)', evidence))
    const prompted = source.indexOf('entry.promptedAt = Date.now()')
    expect(source.slice(prompted, prompted + 120)).toContain('clearIdleForSession(id)')
  })

  it('a session that exits does not leave the mark behind', async () => {
    const { task, session } = seedRunningTask()
    await endTurn(session)
    await turnend.onSessionExit(session, 0)
    expect(idlestate.idleSinceOf(task.id)).toBeNull()
  })
})
