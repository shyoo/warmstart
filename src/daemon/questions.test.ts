import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'

/**
 * The third object.
 *
 * ⛔ The case that motivated this file: an agent asked *"OAuth, session cookies, or magic link?"*, the
 * question travelled all the way to a person through `request_human` — and came back as `The operator
 * agreed.` The old path routed it through an approval, whose answer set is closed at allow/deny, so
 * the only two things it could say were both wrong. Every test here is about the difference between
 * a verdict and an answer.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let questions: typeof import('./questions.js')

let seq = 0

function seedSession(id: string, workerId: string): Session {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, started_at)
       values (?,?,?,?,?,?,?)`
    )
    .run(id, workerId, 'openai-compatible', 'stream', dir, 'live', Date.now())
  const session = db.row<Session>(db.db().prepare('select * from sessions where id = ?').get(id))
  if (!session) throw new Error('session vanished after insert')
  return { ...session, id, workerId }
}

/** A task with a live session and an open run, which is the only state a question can be asked from. */
function seedAsker() {
  seq += 1
  const worker = workers.createWorker({
    adapterId: 'openai-compatible',
    label: `w${seq}`,
    enabled: false
  })
  const task = tasks.createTask({ title: `t${seq}`, createdBy: { kind: 'human' } })
  const session = seedSession(`9e551011-0000-4000-8000-00000000000${seq}`, worker.id)
  const run = tasks.startRun({
    taskId: task.id,
    workerId: worker.id,
    sessionId: session.id,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  tasks.setStatus(task.id, 'running', { assignee: worker.id })
  return { worker, task, run, session }
}

const THREE_WAYS = [
  { id: 'oauth', label: 'OAuth (external provider)', detail: 'No password storage.' },
  { id: 'cookies', label: 'Server-side session cookies' },
  { id: 'magic', label: 'Magic-link email' }
]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-test-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  questions = await import('./questions.js')
})

beforeEach(() => {
  db.closeDb()
  db.openDb(join(dir, `q${++seq}.db`))
})

afterAll(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('a question carries an answer set the asker wrote', () => {
  it('keeps the options and their prose exactly as they were given', async () => {
    const { session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'native_tool',
      kind: 'choice',
      question: 'Which authentication approach?',
      header: 'Auth approach',
      options: THREE_WAYS
    })

    const [open] = questions.openQuestions()
    expect(open?.options.map((o) => o.label)).toEqual([
      'OAuth (external provider)',
      'Server-side session cookies',
      'Magic-link email'
    ])
    // ⛔ The per-option prose is the asker's, and summarising it would be answering for them.
    expect(open?.options[0]?.detail).toBe('No password storage.')
    expect(open?.header).toBe('Auth approach')

    questions.answerQuestion(open!.id, { optionIds: ['cookies'], text: null })
    await expect(pending).resolves.toMatchObject({ status: 'answered' })
  })

  it('hands the agent the chosen label, not an id it never saw', async () => {
    const { session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      options: THREE_WAYS
    })
    const [open] = questions.openQuestions()
    questions.answerQuestion(open!.id, { optionIds: ['cookies'], text: 'and keep it stateless' })

    const resolution = await pending
    expect(resolution.reply).toContain('Server-side session cookies')
    expect(resolution.reply).toContain('and keep it stateless')
    expect(resolution.reply).not.toContain('cookies,') // the id, rather than the label
  })

  it('mints stable option ids when the asker gave none', async () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'native_tool',
      kind: 'choice',
      question: 'Which one?',
      options: [{ id: '', label: 'First' }, { id: '', label: 'Second' }]
    })
    const [open] = questions.openQuestions()
    expect(open?.options.map((o) => o.id)).toEqual(['opt1', 'opt2'])
  })

  it('carries no options for a free-text question', async () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'What should the retry budget be?',
      options: THREE_WAYS
    })
    // A text question with three options is a question whose asker contradicted itself; the kind wins.
    expect(questions.openQuestions()[0]?.options).toEqual([])
  })
})

describe('an unanswered question is not a refusal', () => {
  it('parks rather than denying, and leaves the question open', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which database?'
    })

    expect(questions.parkQuestionsForSession(session.id)).toBe(1)

    // ⛔ Still open. `answeredAt` null is what makes it answerable an hour from now; a timeout that
    // wrote an answer would be the machine inventing a preference nobody expressed.
    const parked = questions.openQuestions()[0]
    expect(parked?.answeredAt).toBeNull()
    expect(parked?.parkedAt).not.toBeNull()
    expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
    expect(tasks.getTask(task.id)?.holdReason).toContain('Which database?')
  })

  it('tells the agent to stop rather than to guess', async () => {
    const { session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which database?'
    })
    questions.parkQuestionsForSession(session.id)

    const resolution = await pending
    expect(resolution.status).toBe('parked')
    expect(resolution.answer).toBeNull()
    expect(resolution.reply).toContain('Do not guess')
  })

  it('answers a parked question into the thread, where the next run will read it', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      options: THREE_WAYS
    })
    questions.parkQuestionsForSession(session.id)

    // ⛔ The session is gone, so there is no tool result to return to. If the answer went nowhere,
    // a park would be a dead end and the task could never move again.
    questions.answerQuestion(questions.openQuestions()[0]!.id, {
      optionIds: ['magic'],
      text: null
    })
    const thread = tasks.messagesFor(task.id)
    expect(thread.some((m) => m.role === 'human' && m.text.includes('Magic-link email'))).toBe(true)
    expect(questions.openQuestions()).toHaveLength(0)
  })
})

describe('the thread is the permanent record', () => {
  it('writes the question and its alternatives as it is asked', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      header: 'Auth approach',
      options: THREE_WAYS
    })

    const asked = tasks.messagesFor(task.id).find((m) => m.role === 'agent')
    expect(asked?.text).toContain('Auth approach')
    // A decision recorded without the alternatives it was chosen over is half a record.
    expect(asked?.text).toContain('Magic-link email')
    expect(asked?.text).toContain('No password storage.')
  })

  it('records an answer given live, and does not queue it for redelivery', async () => {
    const { task, session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      options: THREE_WAYS
    })
    questions.answerQuestion(questions.openQuestions()[0]!.id, {
      optionIds: ['cookies'],
      text: null
    })
    await pending

    // The task's own title is the first human message on every thread, so take the newest.
    const answer = tasks.messagesFor(task.id).filter((m) => m.role === 'human').pop()
    expect(answer?.text).toContain('Server-side session cookies')
    // ⛔ The agent already took this as its tool result. Left outstanding it would arrive a second
    // time in the next run's prompt, and the agent would be asked to act on a decision twice.
    expect(answer?.deliveredAt).not.toBeNull()
  })

  it('leaves a parked answer outstanding, because nobody has read it yet', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      options: THREE_WAYS
    })
    questions.parkQuestionsForSession(session.id)
    questions.answerQuestion(questions.openQuestions()[0]!.id, { optionIds: ['magic'], text: null })

    const answer = tasks.messagesFor(task.id).filter((m) => m.role === 'human').pop()
    // ⭐ Undelivered is the mechanism: `buildPrompt` carries outstanding human messages, which is how
    // answering a parked question starts the work again.
    expect(answer?.deliveredAt).toBeNull()
  })

  it('does not say the same thing twice when it parks', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which database?'
    })
    questions.parkQuestionsForSession(session.id)

    const said = tasks.messagesFor(task.id)
    expect(said.filter((m) => m.text.includes('Which database?'))).toHaveLength(1)
  })
})

describe('the clock a question waits against', () => {
  it('never waits zero, however stale the session', () => {
    // A cache expiry already in the past would park instantly — a question nobody could answer,
    // dressed up as one that was asked.
    const now = Date.now()
    expect(questions.waitMsFor(now - 60_000, now)).toBe(questions.MIN_WAIT_MS)
    expect(questions.waitMsFor(null, now)).toBe(questions.MIN_WAIT_MS)
  })

  it('never waits past the longest a prompt cache lives', () => {
    const now = Date.now()
    expect(questions.waitMsFor(now + 5 * 60 * 60 * 1000, now)).toBe(questions.MAX_WAIT_MS)
  })

  it('otherwise waits exactly as long as the session stays warm', () => {
    const now = Date.now()
    expect(questions.waitMsFor(now + 12 * 60 * 1000, now)).toBe(12 * 60 * 1000)
  })
})

describe('answering', () => {
  it('is recorded once and does not change under a second answer', () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which?',
      options: THREE_WAYS
    })
    const id = questions.openQuestions()[0]!.id
    questions.answerQuestion(id, { optionIds: ['oauth'], text: null })
    questions.answerQuestion(id, { optionIds: ['magic'], text: null })
    expect(questions.requireQuestion(id).answer?.optionIds).toEqual(['oauth'])
  })

  it('reports every choice of a multi-select', () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'native_tool',
      kind: 'multi',
      question: 'Which of these?',
      options: THREE_WAYS
    })
    const id = questions.openQuestions()[0]!.id
    questions.answerQuestion(id, { optionIds: ['oauth', 'magic'], text: null })
    const reply = questions.renderAnswer(questions.requireQuestion(id))
    expect(reply).toContain('OAuth (external provider)')
    expect(reply).toContain('Magic-link email')
  })

  it('finds the questions asked against one task', () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'First?'
    })
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Second?'
    })
    expect(questions.questionsForTask(task.id).map((q) => q.question)).toEqual(['Second?', 'First?'])
  })
})
