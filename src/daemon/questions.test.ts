import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@shared/protocol.js'
import {
  isMultiSelectQuestion,
  cleanQuestionText,
  extractEmbeddedParameters,
  parseOptionList
} from '@shared/tasks.js'
import { normaliseAsk } from '@shared/policy.js'

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
  process.env.WARMSTART_DATA_DIR = dir
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

  it('carries no options for a question that was asked without any', async () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'What should the retry budget be?'
    })
    // ⛔ A `choice` with nothing to choose from is a text question. The kind claims; the options are
    // the evidence, and the card can only render what is there.
    expect(questions.openQuestions()[0]?.options).toEqual([])
    expect(questions.openQuestions()[0]?.kind).toBe('text')
  })

  /**
   * ⛔ **The options win, and the kind loses.** This used to go the other way — an asker that said
   * `text` and sent three options had its options dropped as a contradiction. t235 is what that
   * costs: `kind` is derived by whichever caller assembled the tool call and is the first thing a
   * mangled call gets wrong, while options are three labels the asker demonstrably wrote. Showing
   * them takes nothing away, because the card carries a text box either way.
   */
  it('shows the options even when the asker called it a text question', async () => {
    const { session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'What should the retry budget be?',
      options: THREE_WAYS
    })
    expect(questions.openQuestions()[0]?.kind).toBe('choice')
    expect(questions.openQuestions()[0]?.options).toEqual(THREE_WAYS)
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

  it('binds a folder answered with to the answer message, granting it to the next run', async () => {
    // ⛔ The t521 shape: an MCP-less agent asked for a directory with NEEDS DECISION, and the only
    // place the operator could answer had nowhere to attach it. The answer's folders must land on
    // the thread message (which binds them to the task) and read as granted, or the resumed run's
    // argv still refuses the write and the question cost a person for nothing.
    const { task, session } = seedAsker()
    const attachments = await import('./attachments.js')
    const site = mkdtempSync(join(tmpdir(), 'agentyard-grant-'))
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Where should this second repository live?'
    })
    questions.parkQuestionsForSession(session.id)
    const folder = attachments.createFolderAttachment(site)

    questions.answerQuestion(questions.openQuestions()[0]!.id, {
      optionIds: [],
      text: 'Use this one.',
      attachmentIds: [folder.id]
    })

    const answer = tasks.messagesFor(task.id).filter((m) => m.role === 'human').pop()
    expect(answer?.attachments.map((a) => a.file)).toContain(site)
    expect(answer?.text).toContain(site)
    expect(attachments.grantedDirsFor(task.id)).toContain(site)
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

  it('detects multi-select questions and extracts embedded parameters (t191 case)', () => {
    const rawQuestion =
      'Which direct-money sources should the adapter pipeline actually read in this round? Pick everything that should be built now.\n' +
      '</question>\n' +
      '<parameter name="header">Money sources</parameter>'
    const embedded = extractEmbeddedParameters(rawQuestion)
    expect(embedded.header).toBe('Money sources')
    expect(embedded.question).toContain('Which direct-money sources')
    expect(embedded.question).not.toContain('</question>')
    expect(embedded.question).not.toContain('Money sources')

    const isMulti = isMultiSelectQuestion(embedded.question, THREE_WAYS, embedded.header)
    expect(isMulti).toBe(true)

    const cleaned = cleanQuestionText(embedded.question)
    expect(cleaned).toContain('Which direct-money sources')
  })

  it('detects multi-select markers across headers, bracket tags, and options', () => {
    expect(isMultiSelectQuestion('Select components', [], 'multi')).toBe(true)
    expect(isMultiSelectQuestion('Select components', [], 'Checkboxes')).toBe(true)
    expect(isMultiSelectQuestion('[multi] Which tools should we enable?')).toBe(true)
    expect(isMultiSelectQuestion('Which packages to install? (select all that apply)')).toBe(true)
    expect(isMultiSelectQuestion('Which options?', ['Option A (select all that apply)'])).toBe(true)
    expect(isMultiSelectQuestion('Which single option do you want?')).toBe(false)
  })

  /**
   * ⛔ The t235 case, verbatim from `questions.options_json = null` on 2026-09-06: the agent offered
   * three choices, claude-code serialised `options` into the question string instead of sending it,
   * and the operator got a text box and typed the letter `B`.
   */
  it('recovers options the CLI serialised into the question text (t235 case)', () => {
    const rawQuestion =
      'How should a batch of quality reviews run once I press Batch?\n\n' +
      'A) Background queue, one review at a time\n' +
      'B) Background queue, parallel across distinct eligible accounts (Recommended)\n' +
      'C) Background queue, with a concurrency cap I choose\n' +
      '<parameter name="options">["A - background, strictly sequential", ' +
      '"B - background, one in flight per account (Recommended)", ' +
      '"C - background, fixed concurrency cap"]'
    const embedded = extractEmbeddedParameters(rawQuestion)
    expect(embedded.options?.map((o) => o.label)).toEqual([
      'A - background, strictly sequential',
      'B - background, one in flight per account (Recommended)',
      'C - background, fixed concurrency cap'
    ])
    // ⛔ And the XML never reaches the operator, whichever way the options were read.
    expect(embedded.question).not.toContain('<parameter')
    expect(embedded.question).toContain('How should a batch of quality reviews run')
  })

  it('keeps the prose when the whole call was serialised, tags and all', () => {
    const embedded = extractEmbeddedParameters(
      '<parameter name="question">Which scope?</parameter>\n' +
        '<parameter name="header">Reviewer exclusion scope</parameter>\n' +
        '<parameter name="options">["A - all paths", "B - batch only"]</parameter>'
    )
    expect(embedded.question).toBe('Which scope?')
    expect(embedded.header).toBe('Reviewer exclusion scope')
    expect(embedded.options?.map((o) => o.label)).toEqual(['A - all paths', 'B - batch only'])
  })

  /** ⚠️ `$&` and `$1` are `String.replace` syntax, and an agent writing about a regex will use them. */
  it('keeps a question that reads like a replacement pattern intact', () => {
    const embedded = extractEmbeddedParameters(
      '<parameter name="question">Should the rule capture `$1` or splice `$&` into the line?</parameter>'
    )
    expect(embedded.question).toBe('Should the rule capture `$1` or splice `$&` into the line?')
  })

  it('reads an options array that was cut off, rather than dropping every choice in it', () => {
    const embedded = extractEmbeddedParameters(
      'Pick one.\n<parameter name="options">["Keep both buttons", "Remove the old one", "Someth'
    )
    expect(embedded.options?.map((o) => o.label)).toEqual(['Keep both buttons', 'Remove the old one'])
  })

  it('carries per-option prose through under either name the vendors use', () => {
    const embedded = extractEmbeddedParameters(
      'Which one?<parameter name="options">[{"label":"OAuth","description":"No password storage"},' +
        '{"label":"Cookies","detail":"Server-side"}]</parameter>'
    )
    expect(embedded.options).toEqual([
      { id: 'opt1', label: 'OAuth', detail: 'No password storage' },
      { id: 'opt2', label: 'Cookies', detail: 'Server-side' }
    ])
  })

  it('⛔ invents no options for a question that genuinely has none', () => {
    const embedded = extractEmbeddedParameters(
      'Which of A) this, B) that or C) the other should I build?'
    )
    expect(embedded.options).toBeUndefined()
    expect(normaliseAsk({ question: 'A) this B) that', kind: 'text' }).kind).toBe('text')
  })

  it('decides the kind from what the question has, not from what the asker claimed', () => {
    const recovered = normaliseAsk({
      question: 'Pick one.<parameter name="options">["Yes", "No"]',
      kind: 'text'
    })
    expect(recovered.kind).toBe('choice')
    expect(recovered.options.map((o) => o.label)).toEqual(['Yes', 'No'])

    // ⚠️ And the other way: a `choice` with nothing to choose from is a text question.
    expect(normaliseAsk({ question: 'What should I call it?', kind: 'choice' }).kind).toBe('text')
    // ⚠️ Options the asker actually sent are never replaced by recovered ones.
    const supplied = normaliseAsk({
      question: 'Pick one.<parameter name="options">["Yes", "No"]',
      kind: 'choice',
      options: THREE_WAYS
    })
    expect(supplied.options).toEqual(THREE_WAYS)
  })

  /**
   * ⚠️ The neighbouring failure, and the reason the tool's schema accepts a bare string: a model
   * that sends its list as JSON *text* is offering choices, and rejecting the call teaches it to put
   * them in the question instead.
   */
  it('reads an options list a model sent as a string where an array was asked for', () => {
    expect(parseOptionList('["Keep both", "Remove the old one"]').map((o) => o.label)).toEqual([
      'Keep both',
      'Remove the old one'
    ])
    expect(parseOptionList('- Keep both\n- Remove the old one').map((o) => o.label)).toEqual([
      'Keep both',
      'Remove the old one'
    ])
  })

  it('cleans bracketed multi markers from question text', () => {
    expect(cleanQuestionText('[multi] Which tools to install?')).toBe('Which tools to install?')
    expect(cleanQuestionText('[checkbox] Which tools to install?')).toBe('Which tools to install?')
    expect(cleanQuestionText('Which tools to install? (multi-select)')).toBe('Which tools to install?')
  })

  /**
   * ⛔ The repair belongs to the *question*, not to whichever tool asked. Every asker — the MCP
   * tools, a bridge, the prompt contract — goes through `insertQuestion`, so a mangled call is
   * repaired once for all of them and the row that is stored is the one the card renders.
   */
  it('stores a mangled choice question as a choice, with its options and no XML (t235)', async () => {
    const { task, session } = seedAsker()
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question:
        'How should a batch of quality reviews run?</parameter>\n' +
        '<parameter name="options">["A - strictly sequential", "B - one per account", "C - fixed cap"]',
      header: 'Batch execution model'
    })

    const [open] = questions.openQuestions()
    expect(open?.kind).toBe('choice')
    expect(open?.options.map((o) => o.label)).toEqual([
      'A - strictly sequential',
      'B - one per account',
      'C - fixed cap'
    ])
    expect(open?.question).not.toContain('parameter')
    expect(open?.header).toBe('Batch execution model')

    // ⚠️ The thread and the operator's hold reason read the repaired question too — the raw XML was
    // on the task row as well, which is where an operator scanning the board actually sees it.
    const asked = tasks.messagesFor(task.id).find((m) => m.role === 'agent')
    expect(asked?.text).toContain('A - strictly sequential')
    expect(asked?.text).not.toContain('<parameter')
    expect(tasks.getTask(task.id)?.holdReason ?? '').not.toContain('<parameter')
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

/**
 * What the task says while a person is being waited on.
 *
 * ⛔ **It said `running`, which is true of the process and useless to the operator.** A question is
 * the one moment the work cannot proceed without a person, and the status is where anybody looks to
 * find that out — so a task quietly waiting on a human was indistinguishable from one hard at work.
 *
 * ⭐ Measured on t59, 2026-08-30: five questions, the first open from 03:08:16 to 03:15:06. Seven
 * minutes reading `running`, and the operator only noticed because they happened to look at the
 * session's own terminal.
 */
describe('the status while a question is open', () => {
  it('says a person is being waited on, and says why', async () => {
    const { task, session } = seedAsker()
    expect(tasks.requireTask(task.id).status).toBe('running')

    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which authentication approach?',
      options: THREE_WAYS
    })

    const waiting = tasks.requireTask(task.id)
    expect(waiting.status).toBe('awaiting_human')
    expect(waiting.assignee).toBe('human')
    // ⚠️ The question itself, not a generic "needs attention". The hold reason is what the task
    //    list shows, and it is the difference between knowing to go and look and not.
    expect(waiting.holdReason).toContain('Which authentication approach?')

    const [open] = questions.openQuestions()
    questions.answerQuestion(open!.id, { optionIds: ['cookies'], text: null })
    await expect(pending).resolves.toMatchObject({ status: 'answered' })

    // ⛔ And back, because the agent took the answer as its tool result and is working again. The
    //    run was never ended and the workspace never released — this is a label on a live run.
    const resumed = tasks.requireTask(task.id)
    expect(resumed.status).toBe('running')
    expect(resumed.holdReason).toBeNull()
  })

  it('leaves a task alone that a person moved while the question was open', async () => {
    // ⛔ An operator who pressed *Stop here* has made a deliberate decision, and an answer arriving
    //    afterwards must not overrule it by putting the task back to `running`.
    const { task, session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'What should the retry budget be?'
    })
    tasks.setStatus(task.id, 'paused_user', { assignee: 'human' })

    const [open] = questions.openQuestions()
    questions.answerQuestion(open!.id, { optionIds: [], text: 'three' })
    await expect(pending).resolves.toMatchObject({ status: 'answered' })
    expect(tasks.requireTask(task.id).status).toBe('paused_user')
  })

  it('does not touch a task that was never running', async () => {
    // ⚠️ A question asked from a session with no run behind it — a bare terminal — has no task to
    //    label, and one already resting must not be dragged back into a state it left.
    const { task, session } = seedAsker()
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'something else' })
    void questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Anything?'
    })
    expect(tasks.requireTask(task.id).holdReason).toBe('something else')
  })
})

/**
 * A question nobody could have been waiting for.
 *
 * ⛔ An adapter with no MCP has no `ask_human`, so **every** question it asks is parked on arrival:
 * the turn that asked is already over by the time its text can be read. That makes this path the
 * only path such an agent has, and both halves of it were missing — the row that the card renders
 * from, and a run for the answer to arrive in.
 */
describe('a question filed with its asker already gone', () => {
  it('is a question like any other, options and all', () => {
    const { task, session } = seedAsker()
    const filed = questions.fileParkedQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'choice',
      question: 'How should the quota be refreshed?',
      options: [
        { id: 'jit', label: 'Just in time', detail: 'Cheapest; the consult may read a stale number.' },
        { id: 'gate', label: 'Gate the consult' }
      ]
    })

    // ⭐ It is on the thread, it is in `openQuestions`, and it carries the asker's own prose — which
    //    is everything the operator's card is built out of.
    expect(questions.openQuestions().map((q) => q.id)).toContain(filed.id)
    expect(questions.questionsForTask(task.id)).toHaveLength(1)
    expect(filed.options[0]?.detail).toContain('stale number')
    expect(filed.parkedAt).not.toBeNull()
    expect(filed.answeredAt).toBeNull()
    expect(tasks.messagesFor(task.id).some((m) => m.text.includes('Just in time'))).toBe(true)
  })

  it('⭐ starts the work again when it is answered', async () => {
    // ⛔ A live question resolves into the tool call the agent is holding, and the work carries on. A
    //    parked answer lands only on the thread, and nothing was scheduled to read it — so the
    //    operator answered and watched nothing happen. Measured as the whole of t63's experience.
    const api = await import('./api.js')
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const { task, session } = seedAsker()
    const filed = questions.fileParkedQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which store?'
    })
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'Which store?' })

    await handlers['question.answer']({ id: filed.id, optionIds: [], text: 'Postgres' })

    // ⛔ `ready`, so the next tick dispatches it — the same task, the same thread, a new run. The
    //    answer is left **undelivered** on purpose: it has reached nobody, and `buildPrompt` carrying
    //    it is the entire mechanism by which answering a parked question restarts the work.
    expect(tasks.requireTask(task.id).status).toBe('ready')
    const answer = tasks.messagesFor(task.id).find((m) => m.text.includes('Postgres'))
    expect(answer?.role).toBe('human')
    expect(answer?.deliveredAt ?? null).toBeNull()
  })

  it('releases the timed-out task lease before requeueing its answer', async () => {
    // A question that outlives its cache wait keeps the original run's lease until the answer
    // requeues it. Without this release, that same task is refused as a different task when it
    // tries to resume the conversation it already owns.
    const api = await import('./api.js')
    const resources = await import('./resources.js')
    const { sessionLeaseId } = await import('./residency.js')
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const { task, session } = seedAsker()
    const pending = questions.askQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which store?'
    })
    const lease = sessionLeaseId(session.id)
    resources.upsertResource({ id: lease, kind: 'exclusive', label: 'conversation', meta: {} })
    expect(resources.claim(lease, task.id)).not.toBeNull()

    questions.parkQuestionsForSession(session.id)
    await pending
    const [parked] = questions.openQuestions()
    await handlers['question.answer']({ id: parked!.id, optionIds: [], text: 'Postgres' })

    expect(tasks.requireTask(task.id).status).toBe('ready')
    expect(resources.availability(lease)?.free).toBe(1)
  })

  it('does not overrule an operator who had already stopped the task', async () => {
    // ⚠️ Answering is not a request to restart something a person deliberately paused.
    const api = await import('./api.js')
    const handlers = api.buildApi({ version: '1.0.0', startedAt: Date.now(), port: 8080 })
    const { task, session } = seedAsker()
    const filed = questions.fileParkedQuestion({
      sessionId: session.id,
      origin: 'ask_human',
      kind: 'text',
      question: 'Which store?'
    })
    tasks.setStatus(task.id, 'paused_user', { assignee: 'human' })

    await handlers['question.answer']({ id: filed.id, optionIds: [], text: 'Postgres' })
    expect(tasks.requireTask(task.id).status).toBe('paused_user')
  })

  it('applies a debate verdict when answering a parked debate question', async () => {
    seq += 1
    const worker = workers.createWorker({
      adapterId: 'openai-compatible',
      label: `w${seq}`,
      enabled: false
    })
    const task = tasks.createTask({
      title: `t${seq}`,
      kind: 'debate',
      debate: { seats: [{ workerId: worker.id }], rounds: 1, exchange: 'full', round: 1, verdict: null },
      createdBy: { kind: 'human' }
    })
    const session = seedSession(`9e551011-0000-4000-8000-00000000000${seq}`, worker.id)
    tasks.startRun({
      taskId: task.id,
      workerId: worker.id,
      sessionId: session.id,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    const filed = questions.fileParkedQuestion({
      sessionId: session.id,
      origin: 'debate',
      kind: 'choice',
      header: `t${task.seq}: debate answer`,
      question: 'What now?',
      options: [
        { id: 'execute', label: 'Execute' },
        { id: 'complete', label: 'Complete' },
        { id: 'discuss', label: 'Discuss' }
      ]
    })
    tasks.setStatus(task.id, 'awaiting_human', { assignee: 'human', holdReason: 'awaiting debate verdict' })

    questions.answerQuestion(filed.id, { optionIds: ['complete'], text: 'Looks solid' })
    const updated = tasks.requireTask(task.id)
    expect(updated.debate?.verdict).toBe('complete')
    expect(updated.status).toBe('completed')
    expect(updated.finishPolicy).toBe('report-only')
  })
})
