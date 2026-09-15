import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'

/**
 * A resting conversation whose agent starts speaking again without being asked.
 *
 * ⭐ **t369, reported 2026-09-11.** The operator asked what the next step was; the agent answered
 * *"I'll report back when CI completes"*, its turn ended, and the task rested at `awaiting_human`.
 * CI finished minutes later, the CLI's own background-task machinery handed the result back to the
 * agent, and it worked for several more minutes — visible in the session pane and **nowhere else**.
 * `runForSession` finds only open runs, so every assistant message after the turn ended was dropped:
 * no peephole, no thread message, no metering, and a task reading *your turn* with its agent
 * mid-sentence.
 *
 * ⛔ **What is pinned here is mostly the refusals.** Opening a run off agent output is one step from
 * opening one off *any* output, and the three cases that must not — a keepalive the daemon sent, a
 * conversation somebody finished, a trailing word from the turn that just ended — are each a way
 * this would bill or resurrect work that does not exist.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let sessions: typeof import('./sessions.js')
let scheduler: typeof import('./scheduler.js')

let claude: Worker
let seq = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-resumeidle-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  sessions = await import('./sessions.js')
  scheduler = await import('./scheduler.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'resumeidle.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'resume-1', enabled: true })
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
 * A conversation that has had one turn, and is resting between turns.
 *
 * ⚠️ The run is **ended**, which is the whole shape: `endConversationTurn` closes a conversation's
 * run and leaves the session live. The `endedAt` is pushed back past `RESUME_QUIET_MS` so the quiet
 * period is not what any of these tests is measuring.
 */
function resting(status: Task['status'] = 'awaiting_human'): { task: Task; session: Session } {
  seq += 1
  const sessionId = `11111111-2222-3333-4444-${String(seq).padStart(12, '0')}`
  const task = tasks.createTask({ title: `resumed ${seq}`, kind: 'conversation', status: 'ready' })
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
    quotaUnverified: false,
    costModelId: null
  })
  tasks.finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')
  db.db()
    .prepare('update runs set ended_at = ? where id = ?')
    .run(Date.now() - scheduler.RESUME_QUIET_MS - 1000, run.id)
  tasks.setStatus(task.id, status, { assignee: 'human', holdReason: 'your turn' })
  const session = sessions.getSession(sessionId) as Session
  return { task: tasks.requireTask(task.id), session }
}

describe('an agent that wakes itself up', () => {
  it('opens a run, so the turn is visible, billable and closable like any other', () => {
    const { task, session } = resting()
    const run = scheduler.resumeIdleConversation(session)

    expect(run).not.toBeNull()
    expect(run?.taskId).toBe(task.id)
    expect(run?.endedAt).toBeNull()
    // ⛔ Warm by construction: the session never closed and nobody rebuilt its prefix.
    expect(run?.startedWarm).toBe(true)
    // ⛔ No prompt, and the null is the record — nothing was sent into this session. A string here
    //    would put words nobody wrote behind the thread's prompt chip.
    expect(run?.prompt).toBeNull()
    // ⚠️ And the task is working again, which is what puts the live output back on the thread.
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('running')
    expect(after.assignee).toBe(claude.id)
  })

  it('marks the boundary in the thread, because the task said “your turn” a moment ago', () => {
    const { task, session } = resting()
    scheduler.resumeIdleConversation(session)
    const said = tasks.messagesFor(task.id).filter((m) => m.event === 'conversation.resumed')
    expect(said).toHaveLength(1)
    expect(said[0]?.detail).toContain('Nobody prompted this turn')
  })

  it('does it once: the second message of the same turn joins the run the first opened', () => {
    const { task, session } = resting()
    const first = scheduler.resumeIdleConversation(session)
    const second = scheduler.resumeIdleConversation(session)
    expect(first).not.toBeNull()
    // ⛔ There is an open run now, so there is nothing to resume — `onStream` finds it directly.
    expect(second).toBeNull()
    expect(tasks.runsFor(task.id)).toHaveLength(2)
  })

  it('refuses a reply to a prompt the daemon sent, which is our turn and not the task’s', () => {
    // ⛔ The cache clock speaks into idle sessions — a keepalive, a `/compact`, a wrap-up nudge —
    //    and the reply to every one of those would otherwise bill a run of the task's own and flip
    //    it to `running` each time the clock ticked.
    const { task, session } = resting()
    sessions.markHousekeepingPrompt(session.id)
    expect(scheduler.resumeIdleConversation(session)).toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')

    // ⚠️ And the mark does not outlive its turn: once it is cleared the next genuine resume lands.
    sessions.clearHousekeepingPrompt(session.id)
    expect(scheduler.resumeIdleConversation(session)).not.toBeNull()
  })

  it('refuses a conversation that is not resting on a person', () => {
    // A `completed` or `cancelled` thread saying one more thing is not new work on it.
    for (const status of ['completed', 'cancelled', 'running'] as const) {
      const { session } = resting(status)
      expect(scheduler.resumeIdleConversation(session)).toBeNull()
    }
  })

  it('resumes an ordinary work task resting at awaiting_human', () => {
    // ⭐ An ordinary work task parked at awaiting_human (e.g. by idle turn watchdog)
    // whose agent starts speaking or using tools unprompted resumes its session cleanly.
    const { task, session } = resting()
    db.db().prepare("update tasks set kind = 'work' where id = ?").run(task.id)
    const run = scheduler.resumeIdleConversation(session)
    expect(run).not.toBeNull()
    expect(run?.taskId).toBe(task.id)
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('running')
    expect(after.assignee).toBe(claude.id)
  })

  it('refuses the tail of the turn that has just ended unless ignoreQuiet is set', () => {
    // ⚠️ `onStreamResult` closes the run on the vendor's `result`, and a trailing `assistant_text`
    //    milliseconds later belongs to that turn. Opening a run for it would leave an empty one
    //    sitting open until a watchdog noticed.
    const { task, session } = resting()
    const run = tasks.runsFor(task.id)[0] as { id: string }
    db.db().prepare('update runs set ended_at = ? where id = ?').run(Date.now(), run.id)
    expect(scheduler.resumeIdleConversation(session)).toBeNull()
    expect(scheduler.resumeIdleConversation(session, { ignoreQuiet: true })).not.toBeNull()
  })

  it('refuses a session that has ended, which cannot be saying anything', () => {
    const { session } = resting()
    db.db().prepare("update sessions set state = 'closed' where id = ?").run(session.id)
    const closed = sessions.getSession(session.id) as Session
    expect(scheduler.resumeIdleConversation(closed)).toBeNull()
  })

  it('allows completeTask on a session resting at awaiting_human', async () => {
    const { task, session } = resting()
    db.db().prepare("update tasks set kind = 'work' where id = ?").run(task.id)
    await scheduler.completeTask(session.id, 'all done')
    const finished = tasks.requireTask(task.id)
    expect(finished.status).toBe('completed')
  })
})
