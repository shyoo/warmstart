import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import type { Worker } from '@shared/protocol.js'

/**
 * An agent asking for a directory, and an operator whose answer can actually give it one.
 *
 * ⛔ **The hole was never that the agent could not ask.** Measured on t469, 2026-09-15: codex asked
 * *"Grant write access to `C:\Dev\warmstart-site\.git` so the completed changes can be committed"*,
 * the card reached the operator, and they answered *"Continue."* — and nothing changed, because no
 * sentence a person types into a thread widens a sandbox. The run was abandoned and the work redone
 * on another worker. A question whose only useful answer is out of the answerer's reach costs a
 * person's attention and returns nothing.
 *
 * ⛔ **And granting one cannot reach the process that asked**, which is why the *success* path here
 * ends the run. A sandbox fixes what it may write before the first token; the grant is a fact about
 * the next process. What is pinned below is mostly the asymmetry: a grant is terminal and requeues,
 * and every other outcome — refused, wrong path, already granted — leaves the turn open, because
 * none of them is a reason to throw a turn away.
 */

let dir: string
let outside: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let questions: typeof import('./questions.js')
let attachments: typeof import('./attachments.js')
let dirgrants: typeof import('./dirgrants.js')

let claude: Worker
let seq = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-dirgrants-'))
  outside = join(dir, 'a-second-repo')
  mkdirSync(outside, { recursive: true })
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  questions = await import('./questions.js')
  attachments = await import('./attachments.js')
  dirgrants = await import('./dirgrants.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'dirgrants.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'dirgrants-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** A task with a live session and an open run — the state an agent is in when a write is refused. */
function working(): { task: Task; runId: string; sessionId: string } {
  const sessionId = `44444444-5555-6666-7777-${String(++seq).padStart(12, '0')}`
  const task = tasks.createTask({ title: `needs a folder ${seq}`, status: 'ready' })
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
       values (?, ?, 'claude-code', 'stream', null, ?, 'live', 'work', ?)`
    )
    .run(sessionId, claude.id, join(dir, 'workspace'), Date.now())
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

/**
 * Answer the one open question on this task, the way the operator's card does.
 *
 * ⚠️ Polls for the row rather than assuming it is there: `requestDirectory` does not resolve until
 * somebody answers, so the call and the answer genuinely overlap in time.
 */
async function answerWith(taskId: string, optionId: string, text?: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const open = questions.questionsForTask(taskId).find((q) => !q.answeredAt && !q.parkedAt)
    if (open) {
      questions.answerQuestion(open.id, { optionIds: [optionId], text: text ?? null })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('no question was ever raised')
}

describe('an agent asking the operator for a directory', () => {
  it('records the grant as a folder on the task, which is what makes it outlive this run', async () => {
    const { task, runId, sessionId } = working()
    const asked = dirgrants.requestDirectory({
      sessionId,
      path: outside,
      reason: 'the change has to be committed in the second repository',
      state: 'Everything in the workspace is done; only the second repo is left.'
    })
    await answerWith(task.id, 'grant')
    const answer = await asked

    expect(answer.ok).toBe(true)
    // ⭐ The same `folder` attachment the composer writes, so `grantedDirsFor` re-grants it on every
    //    later run and down every lineage — the t462 rule, reached from the agent's side.
    expect(attachments.grantedDirsFor(task.id)).toEqual([outside])
    const piece = tasks.createTask({ title: 'a piece of it', parentTaskId: task.id, status: 'ready' })
    expect(attachments.grantedDirsFor(piece.id)).toEqual([outside])
    // ⛔ The run is over. A sandbox cannot be widened once its process has started, so an approval
    //    that returned into this turn would be an approval the agent could not use.
    const after = tasks.requireRun(runId)
    expect(after.endedAt).not.toBeNull()
    expect(after.outcome).toBe('blocked')
    expect(answer.reply).toContain('STOP HERE')
  })

  it('requeues the task itself, so the operator does not have to start it a second time', async () => {
    const { task, sessionId } = working()
    const asked = dirgrants.requestDirectory({ sessionId, path: outside, reason: 'to commit there' })
    await answerWith(task.id, 'grant')
    expect((await asked).ok).toBe(true)
    // ⛔ `ready`, not `awaiting_human`. The person answered; asking them to press resume as well
    //    would be asking the same question twice.
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })

  it('carries the state note as the handoff, because the next run is a resume and is not re-briefed', async () => {
    const { task, sessionId } = working()
    const asked = dirgrants.requestDirectory({
      sessionId,
      path: outside,
      reason: 'to commit there',
      state: 'Site copy is rewritten and builds; only the commit is left.'
    })
    await answerWith(task.id, 'grant')
    await asked
    expect(tasks.requireTask(task.id).handoffNote).toContain('only the commit is left')
    // ⚠️ And an undelivered instruction naming what changed, which the handoff deliberately is not:
    //    a resumed prompt does not restate the task, so arriving without being told the grant
    //    landed is arriving without knowing why it was restarted.
    const outstanding = tasks
      .messagesFor(task.id)
      .filter((m) => m.role === 'human' && m.deliveredAt === null)
    expect(outstanding.some((m) => m.text.includes(outside))).toBe(true)
  })

  /**
   * ⛔ **Every refusal below leaves the turn open**, and that is the whole asymmetry of this tool.
   * Ending a run because a path was mistyped would throw away work over a typo.
   */
  it('lets the work carry on when the operator says no, and passes their reason through', async () => {
    const { task, runId, sessionId } = working()
    const asked = dirgrants.requestDirectory({ sessionId, path: outside, reason: 'to commit there' })
    await answerWith(task.id, 'refuse', 'Not that one — it is somebody else’s checkout.')
    const answer = await asked

    expect(answer.ok).toBe(false)
    expect(answer.reply).toContain('somebody else')
    expect(attachments.grantedDirsFor(task.id)).toEqual([])
    expect(tasks.requireRun(runId).endedAt).toBeNull()
  })

  it('refuses a path that is not a directory here, before a person is interrupted', async () => {
    const { task, sessionId } = working()
    const answer = await dirgrants.requestDirectory({
      sessionId,
      path: join(dir, 'no-such-folder'),
      reason: 'to commit there'
    })
    expect(answer.ok).toBe(false)
    expect(answer.reply).toMatch(/not a directory/i)
    // ⛔ Nobody was asked. A grant naming nothing is a flag codex refuses to start with, so a path
    //    that is wrong now is a failed dispatch later — and it is the agent's to fix, not a
    //    person's to adjudicate.
    expect(questions.questionsForTask(task.id)).toEqual([])
  })

  it('refuses a relative path rather than guessing what it is relative to', async () => {
    const { task, sessionId } = working()
    const answer = await dirgrants.requestDirectory({
      sessionId,
      path: 'a-second-repo',
      reason: 'to commit there'
    })
    expect(answer.ok).toBe(false)
    expect(answer.reply).toMatch(/absolute/i)
    expect(questions.questionsForTask(task.id)).toEqual([])
  })

  /**
   * ⛔ **The loop guard, and it is the invariant rather than a nicety** (AGENTS.md: a decision
   * re-evaluated before its action lands is a loop). The resumed run arrives holding a conversation
   * in which it asked for this directory; if asking again could raise a second card, an agent that
   * misread one error would spend the operator's attention over and over. The evidence that the ask
   * landed is the grant itself, and it is read before anything else happens.
   */
  it('refuses a directory this task already has, without asking anyone again', async () => {
    const { task, sessionId } = working()
    const first = dirgrants.requestDirectory({ sessionId, path: outside, reason: 'to commit there' })
    await answerWith(task.id, 'grant')
    await first

    const { sessionId: second, task: secondTask } = working()
    // The second turn is on its own task, so give that task the same grant and ask again from it.
    const folder = attachments.createFolderAttachment(outside)
    tasks.addMessage(secondTask.id, 'system', 'granted earlier', null, [folder.id])
    const raisedBefore = questions.questionsForTask(secondTask.id).length
    const answer = await dirgrants.requestDirectory({
      sessionId: second,
      path: outside,
      reason: 'to commit there'
    })
    expect(answer.ok).toBe(false)
    expect(answer.reply).toMatch(/already granted/i)
    expect(questions.questionsForTask(secondTask.id).length).toBe(raisedBefore)
  })

  it('refuses a directory inside the workspace, which was writable all along', async () => {
    const { task, sessionId } = working()
    const inside = join(dir, 'workspace', 'src')
    mkdirSync(inside, { recursive: true })
    const answer = await dirgrants.requestDirectory({
      sessionId,
      path: inside,
      reason: 'to write a file there'
    })
    expect(answer.ok).toBe(false)
    expect(answer.reply).toMatch(/already writable/i)
    expect(questions.questionsForTask(task.id)).toEqual([])
  })

  /**
   * ⚠️ The card is what the operator actually decides on, so what it says is behaviour. A grant
   * restarts the run and a restart is billed; a person clicking *yes* to a permission must not be
   * surprised by a charge.
   */
  it('tells the operator on the button that granting starts a new, billed run', async () => {
    const { task, sessionId } = working()
    const asked = dirgrants.requestDirectory({
      sessionId,
      path: outside,
      reason: 'to commit there'
    })
    let raised: ReturnType<typeof questions.questionsForTask>[number] | undefined
    for (let attempt = 0; attempt < 200 && !raised; attempt++) {
      raised = questions.questionsForTask(task.id).find((q) => !q.answeredAt && !q.parkedAt)
      if (!raised) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(raised?.origin).toBe('request_directory')
    expect(raised?.question).toContain(outside)
    expect(raised?.question).toContain('to commit there')
    const grant = raised?.options.find((o) => o.id === 'grant')
    expect(grant?.detail).toMatch(/costs tokens/i)
    await answerWith(task.id, 'refuse')
    await asked
  })
})
