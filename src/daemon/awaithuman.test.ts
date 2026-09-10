import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import type { Worker } from '@shared/protocol.js'

/**
 * The second terminal contract: *I have stopped, and the rest is yours.*
 *
 * ⛔ **An ordinary run stays open until `task_complete` arrives — that is the whole of its
 * contract.** So every other way a turn can end leaves the run open, the task reading `running`, the
 * workspace held and the worker slot reserved, for as long as the daemon lives. `endConversationTurn`
 * closes that gap for a conversation. Nothing closed it for a task, and an agent that had genuinely
 * gone as far as it could had nothing it could call.
 *
 * ⭐ Measured on t226, 2026-09-05. The agent landed its work by hand, the trunk tripwire in
 * `finish.ts` refused to close the task — correctly — and the operator answered *"go with option C:
 * I will close it out myself."* The agent obeyed and stopped. `task_complete` would have asserted a
 * success the tripwire had just refused, `handoff` records a note and ends nothing, and `ask_human`
 * asks a question it no longer had. The session sat live and idle and the board showed the task
 * running for the rest of the evening.
 *
 * ⚠️ What is pinned here is mostly what this must **not** do. It is one small step from being a
 * quieter `task_complete`, and an agent that can end its run by asserting nothing is an agent that
 * can stop whenever the work gets hard — so the run outcome, the resting status and the refusal to
 * land are all held down deliberately.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')
let prompt: typeof import('./prompt.js')

let claude: Worker
let seq = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-awaithuman-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  prompt = await import('./prompt.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'awaithuman.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'awaithuman-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/**
 * A task with a live session and an open run against it — the state every agent is in when it
 * decides it has gone as far as it can.
 */
function working(): { task: Task; runId: string; sessionId: string } {
  const sessionId = `55555555-6666-7777-8888-${String(++seq).padStart(12, '0')}`
  const task = tasks.createTask({ title: `hand back ${seq}`, status: 'ready' })
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
       values (?, ?, 'claude-code', 'stream', null, ?, 'live', 'work', ?)`
    )
    .run(sessionId, claude.id, dir, Date.now())
  const run = tasks.startRun({
    taskId: task.id,
    workerId: claude.id,
    sessionId,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  tasks.setStatus(task.id, 'running', { assignee: claude.id })
  return { task, runId: run.id, sessionId }
}

describe('an agent handing its task back to a person', () => {
  it('closes the run and rests the task on the reason the agent gave', async () => {
    const { task, runId, sessionId } = working()
    const answer = await scheduler.parkForHuman(
      sessionId,
      'you said you would close this one out yourself'
    )

    expect(answer.ok).toBe(true)
    const after = tasks.requireRun(runId)
    expect(after.endedAt).not.toBeNull()
    // ⛔ `blocked`, not `completed` and not `failed`. The run did work and metered turns and is one
    //    reply away from continuing; `completed` would feed the estimator a job that stopped half
    //    way through as though it measured the whole one.
    expect(after.outcome).toBe('blocked')
    const rested = tasks.requireTask(task.id)
    expect(rested.status).toBe('awaiting_human')
    expect(rested.assignee).toBe('human')
    expect(rested.holdReason).toContain('close this one out yourself')
  })

  it('tells the agent to stop, because a tool that returns quietly gets called and then ignored', async () => {
    const { sessionId } = working()
    const answer = await scheduler.parkForHuman(sessionId, 'over to you')
    expect(answer.reply).toContain('STOP HERE')
    expect(answer.reply).toMatch(/waiting for a person/i)
  })

  it('puts the reason in the thread, where the person who has to act will read it', async () => {
    const { task, runId, sessionId } = working()
    await scheduler.parkForHuman(sessionId, 'the rewind needs your approval')
    const said = tasks.messagesFor(task.id).filter((m) => m.role === 'agent' && m.runId === runId)
    expect(said.some((m) => m.text.includes('the rewind needs your approval'))).toBe(true)
  })

  it('records the state note as the handoff, so a successor does not re-read the branch', async () => {
    const { task, sessionId } = working()
    await scheduler.parkForHuman(sessionId, 'over to you', 'Verified on ws1; nothing is committed.')
    expect(tasks.requireTask(task.id).handoffNote).toContain('Verified on ws1')
  })

  it('never reports the work as finished, whatever the agent said', async () => {
    // ⛔ The line between this and `task_complete`. Nothing here may claim a success: no landing
    //    runs, no checks run, and the task must not reach `completed` by this path.
    const { task, sessionId } = working()
    await scheduler.parkForHuman(sessionId, 'I have done everything I can; please close it')
    expect(tasks.requireTask(task.id).status).not.toBe('completed')
  })

  it('keeps the session live, which is what makes the reply warm', async () => {
    const { sessionId } = working()
    await scheduler.parkForHuman(sessionId, 'over to you')
    expect(sessions.getSession(sessionId)?.state).toBe('live')
  })

  it('refuses on a session with no open run rather than parking someone else’s task', async () => {
    const { runId, sessionId } = working()
    tasks.finishRun(runId, 'completed', 'already done')
    const answer = await scheduler.parkForHuman(sessionId, 'over to you')
    expect(answer.ok).toBe(false)
    expect(answer.reply).toContain('no open run')
  })

  it('leaves an empty reason readable rather than resting the task on a blank sentence', async () => {
    const { task, sessionId } = working()
    await scheduler.parkForHuman(sessionId, '   ')
    expect(tasks.requireTask(task.id).holdReason).toBeTruthy()
  })
})

describe('the agent is told the tool exists', () => {
  /**
   * ⛔ A tool nobody is told about is the state that produced t226 in the first place: the agent had
   * `handoff` and used it, and still had no way to end the run. Naming it in the closing instruction
   * is the whole of the fix on the prompt side.
   *
   * ⚠️ Named *beside* `task_complete`, never on its own. An exit offered as an alternative to
   * finishing is an exit an agent takes.
   */
  it('names await_human in the same breath as task_complete', () => {
    const task = tasks.createTask({ title: 'prompt shape', status: 'ready' })
    const text = prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(text).toContain('`task_complete`')
    expect(text).toContain('`await_human`')
    expect(text).toContain('leaves the task reading as still running')
  })
})

describe('the MCP bundle', () => {
  // ⚠️ Read from source rather than imported: importing it would start a server on stdio.
  const src = (): string =>
    readFileSync(join(import.meta.dirname, '..', 'mcp', 'index.ts'), 'utf8')

  it('registers await_human in the worker tier, alongside the other terminal contract', () => {
    const text = src()
    const worker = text.slice(text.indexOf("if (TIER === 'worker')"), text.indexOf('} // end worker tier'))
    expect(worker).toContain("'await_human'")
    expect(worker).toContain("'task_complete'")
  })

  it('does not hand it to the controller tier, which owns no run to end', () => {
    const text = src()
    const controller = text.slice(text.indexOf("if (TIER === 'controller')"))
    expect(controller).not.toContain("'await_human'")
  })

  it('says in its description that it is not a way to finish early', () => {
    // ⛔ These strings are the only documentation an agent ever reads. If the description stops
    //    drawing the line against `task_complete`, the tool becomes a quieter one.
    const text = src()
    const at = text.indexOf("'await_human'")
    const tool = text.slice(at, at + 2000)
    expect(tool).toContain('NOT a way to finish early')
    expect(tool).toContain('`task_complete`')
    expect(tool).toContain('`ask_human`')
  })
})
