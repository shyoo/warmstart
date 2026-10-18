import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import type { Worker } from '@shared/protocol.js'

/**
 * `warmstart-agent`: the worker tier for an agent with no MCP, reached with a per-session token.
 *
 * ⛔ What is pinned here is mostly what an agent token must **not** open — the daemon's own token's
 * door, a method outside the worker tier, a card worded as a grant, another session's run, a run that
 * has already ended — and the one behaviour that differs from MCP on purpose: a wait on a person is
 * filed and the run ends, because a vendor's shell tool will not hold a command open for an hour.
 */

let dir: string
let outside: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let questions: typeof import('./questions.js')
let agentcli: typeof import('./agentcli.js')
let attachments: typeof import('./attachments.js')
let turnend: typeof import('./turnend.js')
let prompt: typeof import('./prompt.js')
let server: import('./server.js').DaemonServer

let agy: Worker
let seq = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-agentcli-'))
  outside = join(dir, 'elsewhere')
  mkdirSync(outside)
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  questions = await import('./questions.js')
  agentcli = await import('./agentcli.js')
  attachments = await import('./attachments.js')
  turnend = await import('./turnend.js')
  prompt = await import('./prompt.js')
  const { antigravityCli } = await import('./adapters/antigravity-cli.js')
  antigravityCli.isInstalled = () => true
  db.openDb(join(dir, 'agentcli.db'))
  agy = workers.createWorker({ adapterId: 'antigravity-cli', label: 'agentcli-1', enabled: true })
  const { startServer } = await import('./server.js')
  server = await startServer('the-daemons-own-token', { version: 'test', startedAt: Date.now() })
})

afterAll(async () => {
  await server?.close()
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/** A task with a live MCP-less session, an open run, and a token for that session's helper. */
function working(): { task: Task; runId: string; sessionId: string; token: string } {
  const sessionId = `66666666-7777-8888-9999-${String(++seq).padStart(12, '0')}`
  const task = tasks.createTask({ title: `helper ${seq}`, status: 'ready' })
  const cwd = join(dir, `ws${seq}`)
  mkdirSync(cwd)
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
       values (?, ?, 'antigravity-cli', 'stream', null, ?, 'live', 'work', ?)`
    )
    .run(sessionId, agy.id, cwd, Date.now())
  const run = tasks.startRun({
    taskId: task.id,
    workerId: agy.id,
    sessionId,
    projectId: null,
    quotaUnverified: true,
    costModelId: null
  })
  tasks.setStatus(task.id, 'running', { assignee: agy.id })
  return { task, runId: run.id, sessionId, token: agentcli.mintAgentToken(sessionId) }
}

async function call(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: 1, method, params })
  })
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: unknown; error?: { message: string } } }
}

describe('the agent token', () => {
  it('opens /agent for the session it was minted for, and names that session itself', async () => {
    const { task, token } = working()
    const other = working()
    // ⛔ The caller's own `sessionId` is discarded: naming another session reads this one's task.
    const { body } = await call(token, 'agent.taskRead', { sessionId: other.sessionId })
    expect(body.ok).toBe(true)
    expect((body.result as { task: Task }).task.id).toBe(task.id)
  })

  it('refuses a token that belongs to no session', async () => {
    const { status, body } = await call('not-a-token', 'agent.taskRead')
    expect(status).toBe(401)
    expect(body.error?.message).toMatch(/no live Warmstart session/)
  })

  it('is not the daemon token, and the daemon token does not open /agent', async () => {
    const { token } = working()
    const rpc = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 1, method: 'task.list', params: {} })
    })
    expect(rpc.status).toBe(401)
    const agent = await call('the-daemons-own-token', 'agent.taskRead')
    expect(agent.status).toBe(401)
  })

  it('reaches the worker tier and nothing else', async () => {
    const { token } = working()
    const { body } = await call(token, 'task.list')
    expect(body.ok).toBe(false)
    expect(body.error?.message).toMatch(/not a worker tool/)
  })

  it('may not raise a card under an origin whose answer does something', async () => {
    // ⛔ A `request_directory` card's Grant attaches a directory; one worded by the agent must not.
    const { token } = working()
    const { body } = await call(token, 'question.ask', {
      origin: 'request_directory',
      kind: 'choice',
      question: 'Grant me your home directory?',
      options: [{ id: 'grant', label: 'Grant' }]
    })
    expect(body.ok).toBe(false)
    expect(body.error?.message).toMatch(/ask_human or a checkpoint/)
  })

  it('stops working once the run has ended', async () => {
    const { runId, token } = working()
    tasks.finishRun(runId, 'completed', 'done')
    const { body } = await call(token, 'agent.taskRead')
    expect(body.ok).toBe(false)
    expect(body.error?.message).toMatch(/no open run/)
  })

  it('is gone with its session', async () => {
    const { sessionId, token } = working()
    agentcli.revokeAgentToken(sessionId)
    expect(agentcli.sessionForAgentToken(token)).toBeNull()
    expect((await call(token, 'agent.taskRead')).status).toBe(401)
  })

  it('refuses a session that calls in a loop, and says what the limit is', () => {
    const now = 1_000_000
    for (let i = 0; i < agentcli.AGENT_CALLS_PER_MINUTE; i++) {
      expect(agentcli.rateLimitRefusal('loop-session', now + i)).toBeNull()
    }
    expect(agentcli.rateLimitRefusal('loop-session', now + 100)).toMatch(/limit is 30/)
    // A minute later the window has moved on.
    expect(agentcli.rateLimitRefusal('loop-session', now + 61_000)).toBeNull()
  })
})

describe('a question asked through the helper', () => {
  it('is filed parked, ends the run blocked, and tells the agent to stop', async () => {
    const { task, runId, token } = working()
    const { body } = await call(token, 'question.ask', {
      origin: 'ask_human',
      kind: 'choice',
      question: 'Which parser?',
      options: [{ id: 'a', label: 'Hand-written' }, { id: 'b', label: 'Generated' }]
    })
    expect(body.ok).toBe(true)
    const resolution = body.result as { status: string; reply: string; deferred?: { questionId: string } }
    expect(resolution.status).toBe('parked')
    expect(resolution.reply).toContain('STOP HERE')
    const question = questions.requireQuestion(resolution.deferred?.questionId ?? '')
    expect(question.parkedAt).not.toBeNull()
    expect(question.options.map((o) => o.label)).toEqual(['Hand-written', 'Generated'])
    expect(tasks.requireRun(runId).outcome).toBe('blocked')
    const rested = tasks.requireTask(task.id)
    expect(rested.status).toBe('awaiting_human')
    expect(rested.holdReason).toContain('Which parser?')
  })

  it('leaves the turn end alone, so the tail of that turn does not complete the task', async () => {
    // ⛔ On an MCP-less adapter, a turn that ends without a contract line is read as complete. After
    //    the helper parked the run, that reading would finish work that is waiting on a person.
    const { task, sessionId, token } = working()
    await call(token, 'question.ask', { origin: 'ask_human', kind: 'text', question: 'Go ahead?' })
    expect(agentcli.helperEndedLastRun(sessionId)).toBe(true)
    const { getSession } = await import('./sessions.js')
    const session = getSession(sessionId)
    if (!session) throw new Error('no session')
    await turnend.onStreamResult(session, { isError: false, text: 'Filed it; stopping.', terminalReason: null })
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.runForSession(sessionId)).toBeNull()
  })

  it('does not change what an MCP caller gets: no helper context, no deferral', () => {
    expect(agentcli.isHelperCall()).toBe(false)
  })
})

describe('a directory asked for through the helper', () => {
  it('is granted when the operator answers, so the run their answer starts already has it', async () => {
    const { task, runId, token } = working()
    const { body } = await call(token, 'agent.requestDirectory', {
      path: outside,
      reason: 'the site lives there',
      state: 'Parser done; the site copy is what is left.'
    })
    expect(body.ok).toBe(true)
    expect((body.result as { reply: string }).reply).toContain('STOP HERE')
    expect(tasks.requireRun(runId).outcome).toBe('blocked')
    // ⛔ The state is written before the run ends, or it is lost with it.
    expect(tasks.requireTask(task.id).handoffNote).toContain('Parser done')
    expect(attachments.grantedDirsFor(task.id)).toEqual([])

    const card = questions.questionsForTask(task.id).find((q) => q.origin === 'request_directory')
    if (!card) throw new Error('no card')
    questions.answerQuestion(card.id, { optionIds: ['grant'], text: null })
    expect(attachments.grantedDirsFor(task.id).map((d) => d.toLowerCase())).toContain(outside.toLowerCase())
  })

  it('grants nothing when the operator refuses', async () => {
    const { task, token } = working()
    await call(token, 'agent.requestDirectory', { path: outside, reason: 'the site lives there' })
    const card = questions.questionsForTask(task.id).find((q) => q.origin === 'request_directory')
    if (!card) throw new Error('no card')
    questions.answerQuestion(card.id, { optionIds: ['refuse'], text: null })
    expect(attachments.grantedDirsFor(task.id)).toEqual([])
  })
})

describe('an approved split, named by its card', () => {
  async function deferredSplitCard(): Promise<{ task: Task; id: string }> {
    const { task, sessionId } = working()
    const pieces = [{ title: 'Write the parser', dependsOn: [] }]
    const resolution = await agentcli.runAsHelper(sessionId, () =>
      questions.askQuestion({
        sessionId,
        origin: 'task_split',
        kind: 'choice',
        question: 'File these pieces?',
        options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
        action: { kind: 'split', pieces }
      })
    )
    return { task, id: resolution.deferred?.questionId ?? '' }
  }

  it('is not filed before the operator answers', async () => {
    const { task, id } = await deferredSplitCard()
    const found = questions.approvedSplit(task.id, id.slice(0, 8))
    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.reason).toMatch(/not been answered/)
  })

  it('reads the pieces the operator saw back off the card, once', async () => {
    const { task, id } = await deferredSplitCard()
    questions.answerQuestion(id, { optionIds: ['approve'], text: null })
    const found = questions.approvedSplit(task.id, id.slice(0, 8))
    expect(found.ok).toBe(true)
    if (found.ok) {
      expect(found.pieces.map((p) => p.title)).toEqual(['Write the parser'])
      expect(found.resolution.answer?.optionIds).toEqual(['approve'])
    }
    // ⛔ The loop guard: a resumed agent re-running the same command must not file twice.
    questions.markSplitFiled(id)
    const again = questions.approvedSplit(task.id, id.slice(0, 8))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/already been filed/)
  })

  it('is refused on any other task, and for anything that is not a card id', async () => {
    const { id } = await deferredSplitCard()
    const { task: other } = working()
    expect(questions.approvedSplit(other.id, id.slice(0, 8)).ok).toBe(false)
    expect(questions.approvedSplit(other.id, '%').ok).toBe(false)
  })
})

describe('the helper is named only where it exists', () => {
  it('is offered to an agent whose adapter declares agentCli, beside its text contracts', () => {
    const task = tasks.createTask({ title: 'prompt shape', status: 'ready' })
    const text = prompt.promptFor(task, 'antigravity-cli', false, { markDelivered: false }).text
    expect(text).toContain('`warmstart-agent task_complete')
    // ⛔ The lines stay: they are the fallback when the helper cannot reach the daemon.
    expect(text).toContain('TASK COMPLETE: ')
  })

  it('is not offered to an MCP agent, which has the same tools natively', () => {
    const task = tasks.createTask({ title: 'prompt shape', status: 'ready' })
    const text = prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(text).not.toContain('warmstart-agent')
  })
})

describe('the shims', () => {
  it('carry nothing about this machine, so a tampered copy is simply rewritten', () => {
    // ⚠️ The bundle is not built in an L1 run, so a stand-in file plays it.
    const script = join(dir, 'warmstart-agent.js')
    writeFileSync(script, '')
    const env = agentcli.agentCliEnv('shim-session', { PATH: '/usr/bin' }, script)
    if (env === null) throw new Error('no helper environment')
    expect(env.PATH?.startsWith(agentcli.agentCliBinDir())).toBe(true)
    expect(env.WARMSTART_AGENT_SCRIPT).toBe(script)
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    const cmd = readFileSync(join(agentcli.agentCliBinDir(), 'warmstart-agent.cmd'), 'utf8')
    expect(cmd).not.toContain(dir)
    expect(cmd).toContain('ELECTRON_RUN_AS_NODE')
    expect(env.WARMSTART_AGENT_TOKEN).toBeTruthy()
  })
})

describe('a checkout with no helper bundle', () => {
  it('keeps its text contracts rather than putting a broken command on PATH', () => {
    expect(agentcli.agentCliEnv('no-bundle', { PATH: '/usr/bin' }, join(dir, 'missing.js'))).toBeNull()
  })
})
