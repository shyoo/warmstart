import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let resolutions: typeof import('./resolutions.js')
let turnend: typeof import('./turnend.js')
let prompt: typeof import('./prompt.js')
let api: typeof import('./api.js')

let claude: Worker
let agy: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-prompt-test-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  resolutions = await import('./resolutions.js')
  turnend = await import('./turnend.js')
  prompt = await import('./prompt.js')
  api = await import('./api.js')
  db.openDb(join(dir, 'prompt.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'claude-1', enabled: true })
  agy = workers.createWorker({ adapterId: 'antigravity-cli', label: 'agy-1', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks
  }
})

/**
 * The prompt *text*, which is what every assertion below is about.
 *
 * ⚠️ `promptFor` returns text and attachments together, because the bytes of an image travel by
 * a route the sentence cannot express. The one test that cares about that half calls the real
 * function; everything else is about words.
 */
const promptText = (...args: Parameters<typeof prompt.promptFor>): string =>
  prompt.promptFor(...args).text

describe('promptFor prompt construction', () => {
  it('builds prompt for an MCP adapter with task_complete instruction', () => {
    const task = tasks.createTask({
      title: 'Fix issue with login',
      prompt: 'Please inspect auth.ts and fix the login redirect.',
      status: 'ready'
    })

    const prompt = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(prompt).toContain('Fix issue with login')
    expect(prompt).toContain('Please inspect auth.ts and fix the login redirect.')
    expect(prompt).toContain('call the MCP tool `task_complete` with a one-line summary')
    expect(prompt).toContain('call `ask_human` rather than guessing')
    expect(prompt).toContain('MCP tool `task_read`')
    expect(prompt).toContain('to read another task in the same project')
    // ⛔ And where the choices go. On t235 an agent lettered them into the question as well, so when
    // the tool call lost its `options` argument the operator got prose and a text box.
    expect(prompt).toContain('as an entry in its `options` argument')
  })

  it('lets a worker read only the task attached to its live session', async () => {
    const task = tasks.createTask({ title: 'Recover t354 context', status: 'ready' })
    tasks.addMessage(task.id, 'human', 'The earlier reference is t354.')
    const sessionId = '00000000-0000-0000-0000-000000000354'
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
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })

    const result = await handlers['agent.taskRead']({ sessionId })

    expect(result?.task.id).toBe(task.id)
    expect(result?.messages.map((message) => message.text)).toContain('The earlier reference is t354.')
    expect(result?.runs.map((entry) => entry.id)).toContain(run.id)
    expect(await handlers['agent.taskRead']({ sessionId: 'not-a-live-session' })).toBeNull()
  })

  it('lets a worker name another task in the same project, and nothing outside it', async () => {
    const projects = await import('./projects.js')
    const rootA = mkdtempSync(join(tmpdir(), 'agentyard-prompt-proj-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'agentyard-prompt-proj-b-'))
    const projA = projects.addProject({ root: rootA })
    const projB = projects.addProject({ root: rootB })
    const own = tasks.createTask({ title: 'Own work', status: 'ready', projectId: projA.id })
    const sibling = tasks.createTask({ title: 'Sibling work', status: 'ready', projectId: projA.id })
    tasks.addMessage(sibling.id, 'human', 'The sibling reference.')
    const elsewhere = tasks.createTask({ title: 'Elsewhere', status: 'ready', projectId: projB.id })
    const sessionId = '00000000-0000-0000-0000-000000000497'
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
         values (?, ?, 'claude-code', 'stream', ?, ?, 'live', 'work', ?)`
      )
      .run(sessionId, claude.id, projA.id, rootA, Date.now())
    tasks.startRun({
      taskId: own.id,
      workerId: claude.id,
      sessionId,
      projectId: projA.id,
      quotaUnverified: true,
      costModelId: null
    })
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })

    // By t-number, bare seq and id alike.
    for (const ref of [`t${sibling.seq}`, String(sibling.seq), sibling.id]) {
      const result = await handlers['agent.taskRead']({ sessionId, task: ref })
      expect(result?.task.id).toBe(sibling.id)
      expect(result?.messages.map((message) => message.text)).toContain('The sibling reference.')
    }
    // The default is still the task on the live session.
    expect((await handlers['agent.taskRead']({ sessionId }))?.task.id).toBe(own.id)
    // Outside the project, and nowhere at all, are both refused rather than read.
    await expect(handlers['agent.taskRead']({ sessionId, task: `t${elsewhere.seq}` })).rejects.toThrow(
      /another project/
    )
    await expect(handlers['agent.taskRead']({ sessionId, task: 't999999' })).rejects.toThrow(
      /no task is recorded/
    )
  })

  it('files an aggregated follow-up into the filing task’s own branch', async () => {
    // ⛔ The t519 shape: five pieces were each told "commit on your branch, do NOT land to main",
    // the agent obeyed, and the finish policy merged the first finisher into main anyway — because
    // prose in the child's prompt is read by an actor that never lands. `aggregate` is the
    // daemon-side target that prose could not supply.
    const parent = tasks.createTask({ title: 'Aggregator conversation', status: 'ready' })
    db.db().prepare('update tasks set branch = ? where id = ?').run('warmstart/t526-aggregator', parent.id)
    const sessionId = '00000000-0000-0000-0000-000000000526'
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
         values (?, ?, 'claude-code', 'stream', null, ?, 'live', 'work', ?)`
      )
      .run(sessionId, claude.id, dir, Date.now())
    tasks.startRun({
      taskId: parent.id,
      workerId: claude.id,
      sessionId,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })

    const aggregated = await handlers['agent.createTask']({ sessionId, title: 'Aggregated piece', aggregate: true })
    expect(aggregated.ok).toBe(true)
    const childId = db.db().prepare('select id from tasks where seq = ?').get(aggregated.seq!) as { id: string }
    expect(tasks.getTask(childId.id)?.landingTarget).toBe('warmstart/t526-aggregator')
    expect(aggregated.landingTarget).toBe('warmstart/t526-aggregator')

    // Without it the child is ordinary work landing wherever the project says.
    const plain = await handlers['agent.createTask']({ sessionId, title: 'Standalone follow-up' })
    expect(plain.ok).toBe(true)
    const plainId = db.db().prepare('select id from tasks where seq = ?').get(plain.seq!) as { id: string }
    expect(tasks.getTask(plainId.id)?.landingTarget).toBeNull()
    expect(plain.landingTarget).toBeUndefined()
  })

  it('refuses to aggregate when the filing task has no branch to aggregate into', async () => {
    const parent = tasks.createTask({ title: 'Branchless parent', status: 'ready' })
    const sessionId = '00000000-0000-0000-0000-000000000527'
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, project_id, cwd, state, purpose, started_at)
         values (?, ?, 'claude-code', 'stream', null, ?, 'live', 'work', ?)`
      )
      .run(sessionId, claude.id, dir, Date.now())
    tasks.startRun({
      taskId: parent.id,
      workerId: claude.id,
      sessionId,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })

    const refused = await handlers['agent.createTask']({ sessionId, title: 'No branch piece', aggregate: true })
    expect(refused.ok).toBe(false)
    expect(refused.reason).toMatch(/no branch to aggregate into/)
  })

  /**
   * ⛔ **A reassign is a cold start**, and the ordinary thread filter keeps only `human`/`controller`
   * messages plus the first `agent` one — so the `system` entry `landTask` writes when a landing
   * fails never reached the agent taking over, even though it is the one fact that explains why
   * there is a second run at all (t446, 2026-09-14). Covers the failures `resolveRetryOnTask`'s
   * classifier does not recognise, where reassigning is the operator's only route back to a retry.
   */
  it('carries an unresolved landing failure into a freshly dispatched (reassigned) prompt', () => {
    const task = tasks.createTask({ title: 'Land this', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(
      task.id,
      'system',
      'Not landed: no commits were produced',
      null,
      [],
      {
        event: 'landing.failed',
        detail: '`t1` carries no commits that `main` does not already have and no work landed.'
      }
    )

    const reassigned = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(reassigned).toContain('Not landed: no commits were produced')
    expect(reassigned).toContain('carries no commits that `main` does not already have')
  })

  /** ⛔ Delivered once, like every other message — a second reassign must not resend it. */
  it('does not repeat a landing failure that a previous run already carried', () => {
    const task = tasks.createTask({ title: 'Land this twice', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'system', 'Not landed: no commits were produced', null, [], {
      event: 'landing.failed',
      detail: 'no commits were produced'
    })
    promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: true })

    const again = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(again).not.toContain('Not landed: no commits were produced')
  })

  it('tells an autonomous agent to run to the end', () => {
    const task = tasks.createTask({ title: 'Autonomous by default', status: 'ready' })
    const prompt = promptText(task, 'claude-code', false, { markDelivered: false })
    // ⛔ The fleet default, and the premise of the tool: unattended progress across quota
    // windows hours long. A default of `checkpointed` would need a person present for every task.
    expect(prompt).toContain('Work to the end without stopping between phases')
    expect(prompt).not.toContain('`checkpoint`')
  })

  it('tells a planner that promised sequential work requires dependency edges', () => {
    const task = tasks.createTask({ title: 'Plan ordered changes', kind: 'plan', status: 'ready' })
    const prompt = promptText(task, 'claude-code', false, { markDelivered: false })

    expect(prompt).toContain('pieces without dependency edges as parallel work')
    expect(prompt).toContain('must run or land sequentially, encode that ordering with `depends_on`')
  })

  it('tells a checkpointed agent to stop at each phase, and still to ask when it must', () => {
    const task = tasks.createTask({ title: 'Steer this one', status: 'ready' })
    tasks.updateTask(task.id, { completionMode: 'checkpointed' })
    const prompt = promptText(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(prompt).toContain('call the MCP tool `checkpoint`')
    expect(prompt).toContain('wait for the answer before starting the next')
    // ⚠️ `ask_human` survives the switch. Stopping for a decision that changes what you build
    // is never the thing being discouraged — in either mode.
    expect(prompt).toContain('call `ask_human` rather than guessing')
  })

  it('tells a one-shot CLI how to land, because it can never be told afterwards', () => {
    // ⛔ Measured on t56, 2026-08-30: `agent-lands` decided `ask-agent` - *tell the still-live
    // agent to commit* - and codex had already exited, because `codex exec` runs one turn and stops.
    // The instruction was composed and could not be sent. For a `streamPrompts: 'once'` adapter the
    // prompt is the only place it can arrive.
    const task = tasks.createTask({ title: 'One-shot landing', status: 'ready' })
    const prompt = promptText(task, 'openai-compatible', false, { markDelivered: false })
    expect(prompt).toContain('You get one turn and no follow-up')
    expect(prompt).toContain('Commit everything you change')
    expect(prompt).toContain('squash them into one coherent commit where safe')
    // ⛔ `DEFAULT_FINISH_INSTRUCTION` is "Run /commit", a Claude Code project skill. Sending
    // that to codex would spend its one turn looking for a command it does not have.
    expect(prompt).not.toContain('/commit')
    // ⛔ And it says what to do about the remote. Silence is not neutral on a one-shot CLI: the
    // agent has to guess, and `commit-and-merge` wants the commit left exactly where it is.
    expect(prompt).toContain('Do not push')
    // ⛔ But it does **not** promise a verification nobody will perform. This task has no project
    // and so no declared checks; saying the tool runs them would talk the agent out of the only
    // checking that would happen at all.
    expect(prompt).not.toContain('outside your sandbox')
  })

  /**
   * ⛔ The t56 shape, and the one the test above does not reach.
   *
   * `landing.finishInstruction` is defined as *what a `custom` finish tells the agent*, but the
   * prompt read it straight off the config with no policy check, so it fired under every policy.
   * A project on `commit-and-merge` therefore sent codex *"Run /commit and follow every one of its
   * six steps. Do not push."* — a Claude Code skill codex has not got, whose sixth step **is** the
   * push the same sentence forbids. The earlier test passes through this bug untouched because its
   * task has no project at all.
   */
  it('ignores a custom finish instruction when the policy is not custom', async () => {
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-prompt-project-'))
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'merges-locally',
        vcs: 'git',
        landing: {
          finish: 'commit-and-merge',
          finishInstruction: 'Run /commit and follow every one of its six steps. Do not push.'
        },
        check: ['npm test']
      })
    )
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Not custom', status: 'ready', projectId: project.id })
    const prompt = promptText(task, 'openai-compatible', false, { markDelivered: false })
    expect(prompt).not.toContain('/commit')
    expect(prompt).toContain('Do not push')

    // ⛔ The other half of t56: codex ran `npm test` under its sandbox, was denied a WMI query one
    // test needed, and read that as a regression it had caused. `runChecks` runs this list in the
    // daemon, outside the sandbox — the agent cannot discover that, so the prompt says it.
    expect(prompt).toContain('the tool runs `npm test` outside your sandbox')
    expect(prompt).toContain('because your environment forbids it is not a reason to stop')

    // ⚠️ The other half of the same gate: under `custom` the field *is* the operator's own words,
    // and it is honoured verbatim — slash command and all. Choosing `custom` is choosing to own it.
    tasks.updateTask(task.id, { finishPolicy: 'custom' })
    const own = promptText(tasks.requireTask(task.id), 'openai-compatible', false, {
      markDelivered: false
    })
    expect(own).toContain('Run /commit and follow every one of its six steps.')
  })

  /**
   * ⛔ t393–t395, 2026-09-12. Every debate seat is `report-only`, and its seat prompt says *do not
   * commit* — then the closing contract appended the same squash-and-rebase clauses as landing work,
   * and on an MCP-less or one-shot adapter told it to *commit what you have*. Anything a seat commits
   * can only become a loose end, so the contract must not ask for one on any adapter.
   */
  it('never tells a report-only task to commit, squash or rebase, on any adapter', () => {
    for (const adapterId of ['claude-code', 'antigravity-cli', 'openai-compatible']) {
      const task = tasks.createTask({ title: 'A seat', status: 'ready', finishPolicy: 'report-only' })
      const prompt = promptText(task, adapterId, false, { markDelivered: false })
      expect(prompt, adapterId).toContain('do not commit, and leave the branch and the working tree')
      expect(prompt, adapterId).not.toContain('squash them')
      expect(prompt, adapterId).not.toContain('commit what you have')
      expect(prompt, adapterId).not.toContain('Commit everything you change')
      expect(prompt, adapterId).not.toContain('rebase onto the latest')
    }
  })

  it('does not say that to a CLI that can be asked again', () => {
    // ⚠️ Narrow on purpose: a `conversation` adapter may still be reachable after its turn,
    // and whether Antigravity's print-mode process outlives one has not been measured.
    const task = tasks.createTask({ title: 'Conversational', status: 'ready' })
    const prompt = promptText(task, 'antigravity-cli', false, { markDelivered: false })
    expect(prompt).not.toContain('You get one turn and no follow-up')
  })

  it('builds prompt for a non-MCP adapter with commit instruction', () => {
    const task = tasks.createTask({
      title: 'Update readme',
      prompt: 'Add install instructions to README.md',
      status: 'ready'
    })

    const prompt = promptText(task, 'antigravity-cli', false, { markDelivered: false })
    expect(prompt).toContain('Update readme')
    expect(prompt).toContain('Add install instructions to README.md')
    expect(prompt).toContain('commit what you have and end with a line beginning `TASK COMPLETE: `')
    // ⛔ An anchored contract, not an invitation to say something. It is what
    // `needsDecisionIn` matches on, so the two have to be checked against each other.
    expect(prompt).toContain('`NEEDS DECISION:`')
    expect(prompt).toContain('`TASK COMPLETE: `')
    expect(turnend.needsDecisionIn('NEEDS DECISION: which one?')?.question).toBe('which one?')
    // ⭐ And the option contract is in the same prompt, because the operator's side of a question is
    // a card with buttons on it. An agent that was not told this writes its choices into the
    // sentence, which arrives answerable only in prose (t63).
    expect(prompt).toContain('— <what choosing it means>')
    expect(prompt).not.toContain('task_complete')
  })

  it('prepends handoff notes from previous sessions', () => {
    const task = tasks.createTask({
      title: 'Refactor database',
      prompt: 'Migrate to v18',
      status: 'ready'
    })
    tasks.setTaskHandoff(task.id, 'Stashed partial work in stash@{0}. Completed table schema.')

    const refreshed = tasks.requireTask(task.id)
    const prompt = promptText(refreshed, 'claude-code', false, { markDelivered: false })
    expect(prompt).toContain('Continuing earlier work. Handoff from the previous session:')
    expect(prompt).toContain('Stashed partial work in stash@{0}. Completed table schema.')
    expect(prompt).toContain('Migrate to v18')
    expect(prompt.indexOf('Continuing earlier work')).toBeLessThan(prompt.indexOf('Migrate to v18'))
  })

  it('prepends branchNotice when workspace moved across branches', () => {
    const task = tasks.createTask({
      title: 'Inspect styles',
      prompt: 'Check app.css for missing colors',
      status: 'ready'
    })

    const notice = '⚠️ This workspace has moved since your last turn: it was on `feat-old` and is now on `feat-new`.'
    const prompt = promptText(task, 'claude-code', false, {
      branchNotice: notice,
      markDelivered: false
    })
    expect(prompt).toContain(notice)
    expect(prompt.indexOf('⚠️ This workspace has moved')).toBeLessThan(prompt.indexOf('Inspect styles'))
  })

  it('does not re-include original brief on resumed conversations', () => {
    const task = tasks.createTask({
      title: 'Original brief',
      prompt: 'Do something long and involved',
      status: 'ready'
    })

    // First dispatch marks initial message delivered
    const msgs = tasks.messagesFor(task.id)
    tasks.markDelivered(msgs.map((m) => m.id))

    // Resumed conversation with no new undelivered notes
    const resumedPrompt = promptText(task, 'claude-code', true, { markDelivered: false })
    expect(resumedPrompt).not.toContain('Do something long and involved')
    expect(resumedPrompt).toContain('call the MCP tool `task_complete`')
  })
})

describe('run prompt persistence and task.get preview', () => {
  it('records prompt on startRun and returns it on runsFor', () => {
    const task = tasks.createTask({
      title: 'Run with recorded prompt',
      prompt: 'Ensure tests pass',
      status: 'ready'
    })

    const expectedPrompt = promptText(task, 'claude-code', false, { markDelivered: true })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: claude.id,
      sessionId: 'session-123',
      projectId: null,
      quotaUnverified: false,
      costModelId: 'anthropic.claude-3-7-sonnet',
      prompt: expectedPrompt
    })

    expect(run.prompt).toBe(expectedPrompt)

    const storedRuns = tasks.runsFor(task.id)
    expect(storedRuns.length).toBe(1)
    expect(storedRuns[0]?.prompt).toBe(expectedPrompt)

    const required = tasks.requireRun(run.id)
    expect(required.prompt).toBe(expectedPrompt)
  })

  it('task.get returns previewPrompt matching target worker adapter', async () => {
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })
    const task = tasks.createTask({
      title: 'Preview test',
      prompt: 'Check task.get preview field',
      status: 'draft',
      constraints: { workerId: agy.id }
    })

    const detail = (await handlers['task.get']({ id: task.id })) as NonNullable<
      Awaited<ReturnType<(typeof handlers)['task.get']>>
    >
    expect(detail).not.toBeNull()
    expect(detail.previewPrompt).toBeDefined()
    expect(detail.previewPrompt).toContain('Check task.get preview field')
    // Because worker is agy (antigravity-cli with mcp: false), it has commit instruction
    expect(detail.previewPrompt).toContain('commit what you have and end with a line beginning `TASK COMPLETE: `')
  })

  it('task.get returns dependencies and dependents with full task details', async () => {
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })
    const dep1 = tasks.createTask({ title: 'Prerequisite 1' })
    tasks.setStatus(dep1.id, 'completed')
    const dep2 = tasks.createTask({ title: 'Prerequisite 2' })
    tasks.setStatus(dep2.id, 'running')
    const main = tasks.createTask({
      title: 'Main task with dependencies',
      dependsOn: [dep1.id, dep2.id]
    })
    const child = tasks.createTask({
      title: 'Downstream task',
      dependsOn: [main.id]
    })

    const detail = (await handlers['task.get']({ id: main.id })) as NonNullable<
      Awaited<ReturnType<(typeof handlers)['task.get']>>
    >
    expect(detail).not.toBeNull()
    expect(detail.dependencies).toBeDefined()
    expect(detail.dependencies?.map((d) => d.title).sort()).toEqual(['Prerequisite 1', 'Prerequisite 2'])
    expect(detail.dependents).toBeDefined()
    expect(detail.dependents?.map((d) => d.id)).toEqual([child.id])
    expect(detail.dependents?.map((d) => d.title)).toEqual(['Downstream task'])
  })

  /**
   * ⛔ **Lineage is not a dependency, and the thread needed both.** A piece of a Plan & Split does not
   * depend on its planner — the planner depends on the piece, so it can be woken when the piece
   * settles — which means `dependencies` and `dependents` between them cannot answer "whose plan is
   * this?" A subtask's page could name the branch it merged into and never name the task it belonged
   * to, which is the first thing anybody opening it wants.
   */
  it('task.get names a subtask’s parent and a planner’s pieces', async () => {
    const handlers = api.buildApi({ version: '1.0.0', port: 1234, startedAt: Date.now() })
    const split = await import('./split.js')
    const plan = tasks.createTask({ title: 'Plan the work', kind: 'plan' })
    db.db()
      .prepare('update tasks set branch = ? where id = ?')
      .run(`warmstart/t${plan.seq}-plan-the-work`, plan.id)

    const filed = split.applySplit(
      plan.id,
      [{ title: 'first piece', dependsOn: [] }, { title: 'second piece', dependsOn: [] }],
      { kind: 'agent', workerId: 'w', sessionId: 's', runId: 'r' }
    )
    expect(filed.ok).toBe(true)
    if (!filed.ok) return

    const plannerPage = (await handlers['task.get']({ id: plan.id })) as NonNullable<
      Awaited<ReturnType<(typeof handlers)['task.get']>>
    >
    expect(plannerPage.children?.map((c) => c.id)).toEqual(filed.children.map((c) => c.id))
    expect(plannerPage.parent).toBeNull()

    const piecePage = (await handlers['task.get']({ id: filed.children[0]!.id })) as NonNullable<
      Awaited<ReturnType<(typeof handlers)['task.get']>>
    >
    expect(piecePage.parent?.id).toBe(plan.id)
    expect(piecePage.parent?.kind).toBe('plan')
    expect(piecePage.children).toEqual([])
  })

  it('instructs agent to run project checks before committing when project defines checks', async () => {
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-checks-prompt-'))
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'checks-project',
        vcs: 'git',
        landing: { finish: 'commit-and-merge' },
        check: ['npm run typecheck', 'npm run lint']
      })
    )
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Add feature', status: 'ready', projectId: project.id })

    // Antigravity (non-MCP) prompt
    const agyPrompt = promptText(task, 'antigravity-cli', false, { markDelivered: false })
    expect(agyPrompt).toContain("run this project's checks (`npm run typecheck`, `npm run lint`) and ensure they pass cleanly")

    // Claude (MCP) prompt
    const claudePrompt = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(claudePrompt).toContain("run this project's checks (`npm run typecheck`, `npm run lint`) and ensure they pass")
  })

  it('resolveChecksOnTask dispatches a new run with failure details', async () => {
    const { execFileSync } = await import('node:child_process')
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-resolve-checks-'))
    execFileSync('git', ['init', root])
    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: 'Fix issue',
      status: 'ready',
      projectId: project.id
    })
    tasks.setStatus(task.id, 'awaiting_human', {
      holdReason: 'landing failed: the project checks failed after rebase'
    })
    tasks.addMessage(
      task.id,
      'system',
      'Landing failed: the project checks failed after rebase.\n\n$ npm run lint\n1 problem (1 error)'
    )

    const res = await resolutions.resolveChecksOnTask(task.id)
    expect(res).toEqual({ ok: true })

    const msgs = tasks.messagesFor(task.id)
    const lastHuman = msgs.filter((m) => m.role === 'human').pop()
    expect(lastHuman?.text).toContain('The landing failed because project verification checks failed')
    expect(lastHuman?.text).toContain('1 problem (1 error)')
    expect(lastHuman?.text).toContain(`warmstart/t${task.seq}-fix-issue`)
    expect(lastHuman?.text).toContain('squash them into one coherent commit where safe')
    expect(lastHuman?.text).toContain('rerun the failing command in full')
  })

  it('can hand a failed landing to another worker without losing the corrective prompt', async () => {
    const { execFileSync } = await import('node:child_process')
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-reassign-resolve-retry-'))
    execFileSync('git', ['init', root])
    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: 'Let another worker land this',
      status: 'ready',
      projectId: project.id,
      constraints: { workerId: claude.id, adapterId: claude.adapterId }
    })
    tasks.setStatus(task.id, 'awaiting_human', {
      holdReason: 'landing failed: the project checks failed after rebase'
    })
    tasks.addMessage(task.id, 'system', 'Landing failed: the project checks failed after rebase.\n\n$ npm test\nFAIL landing repair')

    const result = await api.buildApi({ version: 'test', startedAt: Date.now(), port: 0 })['task.resolveRetry']({
      id: task.id,
      workerId: agy.id,
      model: null,
      modelPolicy: 'inherit',
      effort: null
    })

    expect(result.started).toBe(true)
    expect(tasks.requireTask(task.id).constraints.workerId).toBe(agy.id)
    const correction = tasks.messagesFor(task.id).filter((m) => m.role === 'human').at(-1)?.text
    expect(correction).toContain('The landing failed because project verification checks failed')
    expect(correction).toContain('FAIL landing repair')
    expect(correction).toContain('Commit or amend the fixes')
  })

  it('gives a conflict retry the full rebase, squash, and verification sequence', async () => {
    const { execFileSync } = await import('node:child_process')
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-resolve-conflict-'))
    execFileSync('git', ['init', root])
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Resolve a conflict', status: 'ready', projectId: project.id })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch: `warmstart/t${task.seq}-resolve-a-conflict`,
      holdReason: 'landing failed: conflict'
    })

    await expect(resolutions.resolveConflictOnTask(task.id)).resolves.toEqual({ ok: true })

    const retry = tasks.messagesFor(task.id).filter((m) => m.role === 'human').at(-1)?.text
    expect(retry).toContain('Run `git rebase main`')
    expect(retry).toContain('squash them into one coherent commit')
    expect(retry).toContain('Run the relevant project checks')
    expect(retry).toContain('Confirm there are no conflict markers')
  })

  it('resolveCommitOnTask dispatches a new run asking the agent to commit and clears finish_asked_at', async () => {
    const { execFileSync } = await import('node:child_process')
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-resolve-commit-'))
    execFileSync('git', ['init', root])
    const project = projects.addProject({ root })
    const task = tasks.createTask({
      title: 'Commit my change',
      status: 'ready',
      projectId: project.id
    })
    tasks.markFinishAsked(task.id)
    expect(tasks.requireTask(task.id).finishAskedAt).not.toBeNull()

    tasks.setStatus(task.id, 'awaiting_human', {
      holdReason: '1 file(s) are uncommitted, and this CLI cannot be asked after its turn ends'
    })
    tasks.addMessage(
      task.id,
      'system',
      '1 file(s) are uncommitted. OpenAI Codex runs one turn and exits, so it cannot be asked to finish the job afterwards — this one is over to you.'
    )

    const res = await resolutions.resolveCommitOnTask(task.id)
    expect(res).toEqual({ ok: true })

    const updatedTask = tasks.requireTask(task.id)
    expect(updatedTask.finishAskedAt).toBeNull()

    const msgs = tasks.messagesFor(task.id)
    const lastHuman = msgs.filter((m) => m.role === 'human').pop()
    expect(lastHuman?.text).toContain('The landing could not proceed because changes on')
    expect(lastHuman?.text).toContain('1 file(s) are uncommitted')
    expect(lastHuman?.text).toContain(`warmstart/t${task.seq}-commit-my-change`)
  })

  it('keeps a failed retry-landing result visible after the thread refreshes', async () => {
    // ⛔ `task.land` returns this reason to the renderer, but a thread refresh replaces its local
    // state immediately. The result must therefore also be written to the task; otherwise the
    // Retry landing button simply bounces back with no explanation.
    const task = tasks.createTask({ title: 'Explain a failed retry', status: 'ready' })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch: 'warmstart/t87-retry-landing',
      holdReason: 'landing failed: the trunk was busy'
    })

    await expect(resolutions.relandTask(task.id)).resolves.toEqual({ ok: false, reason: 'not a git project' })
    expect(tasks.requireTask(task.id).holdReason).toBe('Retry landing failed: not a git project')
    expect(tasks.messagesFor(task.id).at(-1)).toMatchObject({
      role: 'system',
      text: 'Retry did not land: not a git project',
      detail: 'Retry landing failed: not a git project'
    })
  })

  it('carries retry-landing check output into the corrective agent prompt', async () => {
    // ⛔ `landTask` preserves this output on its own failure path, but `relandTask` is a separate
    // caller. This uses a real branch and check so the assertion follows the exact Retry landing →
    // Resolve & retry sequence t347 took, rather than recreating the final thread message by hand.
    const { execFileSync } = await import('node:child_process')
    const root = mkdtempSync(join(dir, 'retry-landing-checks-'))
    const branch = 'warmstart/t-retry-landing-checks'
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '--initial-branch=main')
    git('config', 'user.name', 'Warmstart test')
    git('config', 'user.email', 'test@example.invalid')
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'retry-landing-checks',
        vcs: 'git',
        landing: { finish: 'commit-and-verify', target: 'main' },
        check: ["node -e \"console.error('RETRY_LANDING_FAILURE'); process.exit(1)\""]
      })
    )
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
    git('switch', '-c', branch)
    writeFileSync(join(root, 'work.txt'), 'work\n')
    git('add', 'work.txt')
    git('commit', '-m', 'task work')
    git('switch', 'main')

    const projects = await import('./projects.js')
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Retain retry check failure', status: 'ready', projectId: project.id })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch,
      holdReason: 'landing failed: the trunk was busy'
    })

    await expect(resolutions.relandTask(task.id)).resolves.toMatchObject({
      ok: false,
      reason: 'the project checks failed'
    })
    const retryFailure = tasks.messagesFor(task.id).at(-1)
    expect(retryFailure?.detail).toContain('RETRY_LANDING_FAILURE')

    await expect(resolutions.resolveChecksOnTask(task.id)).resolves.toEqual({ ok: true })
    const correction = tasks.messagesFor(task.id).filter((m) => m.role === 'human').at(-1)
    expect(correction?.text).toContain('RETRY_LANDING_FAILURE')
  })

  it('refuses relandTask when the trunk tripwire fired, directing to Mark done or Resolve & retry', async () => {
    const task = tasks.createTask({ title: 'Trunk moved landing', status: 'ready' })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch: 'warmstart/t157-trunk-moved',
      holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
    })

    await expect(resolutions.relandTask(task.id)).resolves.toEqual({
      ok: false,
      reason: 'the branch carries no commits; use Mark done if the work in trunk is finished, or Resolve & retry to rebase'
    })
    expect(tasks.requireTask(task.id).holdReason).toContain('use Mark done if the work in trunk is finished')
  })

  it('resolveRetryOnTask dispatches a run asking the agent to rebase onto the moved trunk when trunk moved and branch is empty', async () => {
    const { execFileSync } = await import('node:child_process')
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-resolve-trunk-moved-'))
    execFileSync('git', ['init', root])
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'Resolve trunk moved', status: 'ready', projectId: project.id })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch: `warmstart/t${task.seq}-resolve-trunk-moved`,
      holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
    })

    await expect(resolutions.resolveRetryOnTask(task.id)).resolves.toEqual({ ok: true })

    const retry = tasks.messagesFor(task.id).filter((m) => m.role === 'human').at(-1)?.text
    expect(retry).toContain(`rebase \`warmstart/t${task.seq}-resolve-trunk-moved\` onto \`main\``)
    expect(retry).toContain('ensure all intended changes are committed')
    expect(retry).toContain('squash them into one coherent commit')
  })

  /**
   * Where a stuck piece of a plan is told to put its work.
   *
   * ⛔ **The most expensive kind of wrong sentence there is.** These two prompts *name a ref*, and an
   * agent does exactly what the ref says: t192 was told to rebase onto `main` and land on `main`, and
   * it did — putting a subtask's work on the trunk while its planner sat waiting for the branch it
   * was supposed to have merged into. Both prompts resolved the base from the *project*, because
   * `landingBaseFor` answers about the project's trunk unless it is handed the task. Nothing failed
   * and nothing was logged; the work simply went somewhere else.
   */
  describe('the ref a recovery prompt names', () => {
    const splitChild = async (
      title: string
    ): Promise<{ seq: number; taskId: string; planBranch: string }> => {
      const { execFileSync } = await import('node:child_process')
      const projects = await import('./projects.js')
      const root = mkdtempSync(join(tmpdir(), 'agentyard-piece-target-'))
      execFileSync('git', ['init', root])
      const project = projects.addProject({ root })
      const planBranch = 'warmstart/t900-the-plan'
      const task = tasks.createTask({
        title,
        status: 'ready',
        projectId: project.id,
        // What `applySplit` writes onto every piece: the planner's branch, not the trunk.
        landingTarget: planBranch
      })
      tasks.setStatus(task.id, 'awaiting_human', {
        branch: `warmstart/t${task.seq}-a-piece`,
        holdReason: 'landing failed'
      })
      return { seq: task.seq, taskId: task.id, planBranch }
    }

    it('⛔ sends a conflicted piece at its plan branch, never at the trunk', async () => {
      const { seq, taskId, planBranch } = await splitChild('A piece with a conflict')
      await expect(resolutions.resolveConflictOnTask(taskId)).resolves.toEqual({ ok: true })

      const asked = tasks.messagesFor(taskId).filter((m) => m.role === 'human').at(-1)?.text ?? ''
      expect(asked).toContain(`git rebase ${planBranch}`)
      expect(asked).toContain(`does not rebase cleanly onto \`${planBranch}\``)
      // ⛔ The trunk is not named anywhere in it. An agent given both refs will pick one.
      expect(asked).not.toContain('`main`')
      expect(asked).not.toContain('rebase main')
      expect(seq).toBeGreaterThan(0)
    })

    it('⛔ sends a trunk-moved piece at its plan branch too', async () => {
      const { taskId, planBranch } = await splitChild('A piece whose target moved')
      tasks.setStatus(taskId, 'awaiting_human', {
        holdReason: 'the trunk moved during this run and this branch is empty — check where the work went'
      })

      await expect(resolutions.resolveRetryOnTask(taskId)).resolves.toEqual({ ok: true })
      const asked = tasks.messagesFor(taskId).filter((m) => m.role === 'human').at(-1)?.text ?? ''
      expect(asked).toContain(planBranch)
      expect(asked).not.toContain('onto `main`')
    })

    it('still names the trunk for an ordinary task, which is what makes the change inert elsewhere', async () => {
      const { execFileSync } = await import('node:child_process')
      const projects = await import('./projects.js')
      const root = mkdtempSync(join(tmpdir(), 'agentyard-ordinary-target-'))
      execFileSync('git', ['init', root])
      const project = projects.addProject({ root })
      const task = tasks.createTask({ title: 'An ordinary task', status: 'ready', projectId: project.id })
      tasks.setStatus(task.id, 'awaiting_human', {
        branch: `warmstart/t${task.seq}-ordinary`,
        holdReason: 'landing failed'
      })

      await expect(resolutions.resolveConflictOnTask(task.id)).resolves.toEqual({ ok: true })
      const asked = tasks.messagesFor(task.id).filter((m) => m.role === 'human').at(-1)?.text ?? ''
      expect(asked).toContain('git rebase main')
    })
  })
})

/**
 * An image travels with the message it was pasted onto, and travels exactly when that message does.
 *
 * ⛔ Any other rule is wrong in one of two expensive directions: replay it on every run of a long
 * task and it is paid for each time; drop it on the fresh session a preemption starts and the agent
 * is handed the original prompt with the picture missing from it.
 */
describe('an attachment and the message it belongs to', () => {
  let attachments: typeof import('./attachments.js')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )

  beforeAll(async () => {
    attachments = await import('./attachments.js')
  })

  const withImage = (title: string) => {
    const image = attachments.createAttachment(png, 'image/png', { width: 1, height: 1 })
    const task = tasks.createTask({ title, status: 'ready', attachmentIds: [image.id] })
    return { task, image: attachments.requireAttachment(image.id) }
  }

  it('goes out with the first prompt, and names its absolute path in the text', () => {
    const { task, image } = withImage('Make the header match this')
    const built = prompt.promptFor(task, 'claude-code', false, { markDelivered: false })
    expect(built.attachments.map((a) => a.id)).toEqual([image.id])
    // ⛔ On every adapter, including the one that also gets the bytes. All three read a PNG off
    // disk with their own view tool, and this is what rescues a run whose inline block a vendor
    // update quietly stopped accepting.
    expect(built.text).toContain(image.file)
    expect(built.text).toContain('Attached context:')
  })

  it('names the path to antigravity too, which is the only channel it has', () => {
    const { task, image } = withImage('Match this on agy')
    const built = prompt.promptFor(task, 'antigravity-cli', false, { markDelivered: false })
    expect(built.text).toContain(image.file)
    expect(built.attachments).toHaveLength(1)
  })

  /**
   * ⛔ Into a conversation that already has the picture in its own history. `resumed` is the flag
   * that says so, and it is the same flag that stops the task's prompt being restated — an agent
   * asked to look at an image it is already holding is being charged twice for one screenshot.
   */
  it('does not travel again into the conversation that already has it', () => {
    const { task } = withImage('Only once')
    const first = prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    expect(first.attachments).toHaveLength(1)

    // A later note on the same task carries its own attachments and none of the earlier ones.
    tasks.addMessage(task.id, 'human', 'and one more thing')
    const second = prompt.promptFor(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: true
    })
    expect(second.text).toContain('and one more thing')
    expect(second.attachments).toEqual([])
    expect(second.text).not.toContain('Attached context')
  })

  it('travels again when a preemption re-sends the first prompt', () => {
    const { task, image } = withImage('Preempted with a screenshot')
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    // ⛔ `resumed: false` is what a fresh session after a preemption gets: the task's own prompt is
    // restated because that session has never seen it — and the image has to come with it, or the
    // agent is reading a sentence about a picture it was not given.
    const again = prompt.promptFor(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(again.attachments.map((a) => a.id)).toEqual([image.id])
    expect(again.text).toContain(image.file)
  })

  it('carries an image pasted into a note, on the run that delivers the note', () => {
    const task = tasks.createTask({ title: 'A note with a picture', status: 'ready' })
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    const image = attachments.createAttachment(png, 'image/png')
    tasks.addMessage(task.id, 'human', 'this is what it looks like now', null, [image.id])

    const built = prompt.promptFor(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: true
    })
    expect(built.attachments.map((a) => a.id)).toEqual([image.id])
    expect(built.text).toContain('this is what it looks like now')
  })

  it('says nothing about attachments on a task that has none', () => {
    const task = tasks.createTask({ title: 'No pictures here', status: 'ready' })
    const built = prompt.promptFor(task, 'claude-code', false, { markDelivered: false })
    expect(built.attachments).toEqual([])
    expect(built.text).not.toContain('Attached context')
  })

  /**
   * ⭐ t461. The argv half of an inherited grant is invisible to the agent, so a piece that was
   * never told about the directory does not go and look at it — which is the same outcome as not
   * granting it. ⛔ Cold prompts only, for `coldStartBlock`'s reason.
   */
  it('names a directory the task inherited from its parent, once', () => {
    const folder = join(dir, 'prompt-granted')
    mkdirSync(folder, { recursive: true })
    const grant = attachments.createFolderAttachment(folder)
    const planner = tasks.createTask({ title: 'Plan it', status: 'ready', attachmentIds: [grant.id] })
    const piece = tasks.createTask({
      title: 'Edit the other repository',
      status: 'ready',
      parentTaskId: planner.id
    })

    const cold = prompt.promptFor(piece, 'openai-compatible', false, { markDelivered: true })
    expect(cold.text).toContain(folder)
    expect(cold.text).toContain('Directories outside this workspace you have been granted')

    // ⚠️ And not again into the session that was already told. The grant on the argv does not lapse;
    // the sentence about it is worth exactly one telling, like the orientation block above it.
    const warm = prompt.promptFor(tasks.requireTask(piece.id), 'openai-compatible', true, {
      markDelivered: true
    })
    expect(warm.text).not.toContain('Directories outside this workspace')
  })

  /** ⚠️ The folder is already in the attachment sentence on the task that holds it; once is enough. */
  it('does not repeat a folder the attachment sentence already named', () => {
    const folder = join(dir, 'prompt-granted-own')
    mkdirSync(folder, { recursive: true })
    const grant = attachments.createFolderAttachment(folder)
    const task = tasks.createTask({ title: 'Mine', status: 'ready', attachmentIds: [grant.id] })

    const built = prompt.promptFor(task, 'openai-compatible', false, { markDelivered: false })
    expect(built.text).toContain('Attached context:')
    expect(built.text).not.toContain('Directories outside this workspace')
  })
})

/**
 * What reaches the session that is **already holding this task's context**.
 *
 * ⛔ **The whole of this suite is a subtraction, and t286 is why it exists.** Every warm continuation
 * of an ordinary task — a note typed into a running one, a reply that restarts a rested one, a
 * revived conversation on the far side of a wait — arrived with the task's title restated on top and
 * the entire closing contract underneath: the checks, `task_complete`, commit hygiene, `ask_human`,
 * the hand-back. All of it addressed to a session that had been reading it since its first turn. The
 * restated title reads as being asked to do the work a second time; the restated contract is ~200
 * tokens a turn spent re-teaching an agent something it is currently obeying. `conversation` had
 * this subtraction from t260 and `work` did not, and the reason was never conversation-specific.
 *
 * ⛔ **What survives the subtraction is one sentence, and it is not decoration.** `task_complete` is
 * the only signal an agent finished — a clean exit says nothing — so a turn that named it nowhere
 * could end in `awaiting_human` however well the work went. The anchor names it and points at the
 * rest rather than restating it.
 */
describe('a resumed run into the session that already has the framing', () => {
  /** A task whose opening prompt has gone out, with `note` typed underneath it. */
  const continued = (title: string, note: string): Task => {
    const task = tasks.createTask({ title, status: 'ready' })
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', note)
    return tasks.requireTask(task.id)
  }

  it('sends the note and one anchoring sentence, and nothing else', () => {
    const task = continued('Rework the settings page', 'also fix the tab order')
    const prompt = promptText(task, 'claude-code', true, { markDelivered: false })

    expect(prompt).toContain('also fix the tab order')
    // ⛔ The two things the session is already holding.
    expect(prompt).not.toContain('Rework the settings page')
    expect(prompt).not.toContain('Work to the end without stopping between phases')
    expect(prompt).not.toContain('squash them into one coherent commit')
    expect(prompt).not.toContain('pass each choice you are deciding between')
    expect(prompt).not.toContain('call `await_human` with the reason')
    // ⭐ And the one thing it must never be left without.
    expect(prompt).toContain('still apply')
    expect(prompt).toContain('call the MCP tool `task_complete` with a one-line summary')
  })

  /**
   * ⛔ The subtraction has to pay for itself, or it is a behaviour change with no benefit. The
   * contract it removes is the largest fixed block in an ordinary prompt.
   */
  it('is dramatically shorter than the prompt it replaced', () => {
    const task = continued('Measure the saving', 'one more thing')
    const resumedText = promptText(task, 'claude-code', true, { markDelivered: false })
    const coldText = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(resumedText.length).toBeLessThan(coldText.length / 2)
  })

  /**
   * ⛔ Naming a channel the agent has not got is the failure `capabilities.mcp` exists to prevent,
   * and it is just as wrong in one sentence as in twenty. An MCP-less agent's terminal contract is a
   * line of text.
   */
  it('anchors an MCP-less adapter on its line, never on the tool it has not got', () => {
    const task = continued('agy, resumed', 'and the entitlements file?')
    const prompt = promptText(task, 'antigravity-cli', true, { markDelivered: false })

    expect(prompt).toContain('and the entitlements file?')
    expect(prompt).toContain('TASK COMPLETE: ')
    expect(prompt).not.toContain('task_complete')
    expect(prompt).not.toContain('agy, resumed')
    expect(prompt).not.toContain('NEEDS DECISION:')
  })

  /**
   * ⛔ `resumed: false` is what a fresh session after a preemption gets, and what a **borrowed**
   * conversation gets — see the note at the dispatch call site. Neither has any of this in its
   * history, and withholding it there would hand an agent a stray sentence and no idea what it was
   * for. This is the case the subtraction must never reach.
   */
  it('restates everything into a session that has not got it', () => {
    const task = continued('Preempted work', 'and the linter')
    const prompt = promptText(task, 'claude-code', false, { markDelivered: false })

    expect(prompt).toContain('Preempted work')
    expect(prompt).toContain('and the linter')
    expect(prompt).toContain('Work to the end without stopping between phases')
    expect(prompt).toContain('squash them into one coherent commit')
    expect(prompt).not.toContain('still apply')
  })

  /**
   * ⛔ **A compaction is `resumed`'s undo.** Everything above is withheld on the grounds that the
   * session is still holding it, and a compaction replaces what it was holding with a summary
   * somebody else wrote. Nothing guarantees the sentence naming `task_complete` survived that, and a
   * run that has lost it ends in `awaiting_human` however well the work went — so the framing comes
   * back in full, which is the direction it is safe to be wrong in.
   */
  it('says the whole thing again when the conversation has been compacted', () => {
    const task = continued('Compacted work', 'carry on with the second half')
    const prompt = promptText(task, 'claude-code', true, {
      markDelivered: false,
      compacted: true
    })

    expect(prompt).toContain('Compacted work')
    expect(prompt).toContain('carry on with the second half')
    expect(prompt).toContain('Work to the end without stopping between phases')
    expect(prompt).not.toContain('still apply')
  })

  /**
   * ⛔ **A run with nothing outstanding is not a follow-up.** It is the finish ask — the Commit
   * button re-entering the ordinary contract with the rung the operator picked — and the contract is
   * the entire content of that turn. Withholding it would send a prompt that asks for nothing.
   */
  it('keeps the contract on a resumed run that carries no new message', () => {
    const task = tasks.createTask({ title: 'Nothing new to say', status: 'ready' })
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false
    })

    expect(text).toContain('Work to the end without stopping between phases')
    expect(text).toContain('call the MCP tool `task_complete` with a one-line summary')
  })

  /**
   * ⛔ **A conversation somebody has pressed Commit on has had its contract *withdrawn*, not
   * confirmed.** Everything that session holds says *do not commit, a person decides*; the turn it
   * is about to be given says the opposite. `isOpenConversation` is the flag that knows, and the
   * prompt it holds is redundant while the contract it holds is actively wrong.
   */
  it('says the whole contract again once Commit has changed it', () => {
    const task = tasks.createTask({
      title: 'Chat that became a landing',
      kind: 'conversation',
      status: 'ready'
    })
    prompt.promptFor(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', 'ok, land it')
    tasks.updateTask(task.id, { finishPolicy: 'commit-and-merge' })

    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false
    })
    expect(text).toContain('ok, land it')
    expect(text).toContain('Work to the end without stopping between phases')
    expect(text).toContain('squash them into one coherent commit')
    expect(text).not.toContain('still apply')
    expect(text).not.toContain('This is an ongoing conversation')
  })

  /**
   * ⛔ **A plan turn's instruction is content, not framing.** The resolution instruction carries the
   * roll of what every child did — new on every turn and unguessable from the conversation — and the
   * planning instruction is what stops a planner building the first piece itself. Neither is
   * something the session can be assumed to be still following, so the subtraction stops short of
   * both.
   */
  it('leaves a plan task’s own instruction alone on both phases', () => {
    const planning = tasks.createTask({ title: 'Plan the migration', kind: 'plan', status: 'ready' })
    prompt.promptFor(planning, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(planning.id, 'human', 'keep it to four pieces')
    const first = promptText(tasks.requireTask(planning.id), 'claude-code', true, {
      markDelivered: true
    })
    expect(first).toContain('keep it to four pieces')
    expect(first).toContain('You are PLANNING this work, not doing it')
    expect(first).not.toContain('still apply')

    // ⚠️ Both halves of a split edge, because `childrenOf` requires both: a child names its parent
    // *and* the parent waits on it. A row with only `parentTaskId` is not a piece of a plan.
    const child = tasks.createTask({ title: 'Piece one', status: 'ready', parentTaskId: planning.id })
    tasks.addDependency(planning.id, child.id, 'settled')
    tasks.addMessage(planning.id, 'human', 'now wrap it up')
    const second = promptText(tasks.requireTask(planning.id), 'claude-code', true, {
      markDelivered: false
    })
    expect(second).toContain('Every piece of your plan has settled')
    expect(second).not.toContain('still apply')
  })

  /**
   * ⛔ **A Plan & Execute planner is told a different thing, and never told the resolving thing.**
   * The two shapes share a kind, a tool and a dispatch path; what separates them is the child cap,
   * and this is where that has to become words. A planner told it will be woken to review the result
   * would stop expecting to finish — and one that reached the resolution instruction would be asked
   * to review an integration that never happened, on a branch nothing merged into.
   *
   * ⚠️ The second half is not hypothetical: a person replying to the finished task opens a new run
   * on the same thread, and `planPhaseOf` is what decides what that run is told.
   */
  it('tells a Plan & Execute planner to hand over once, and never to resolve', () => {
    const handoff = tasks.createTask({
      title: 'Plan then hand over',
      kind: 'plan',
      status: 'ready',
      mandate: { maxChildren: 1 },
      childDefaults: { maxChildren: 1 }
    })
    const first = promptText(handoff, 'claude-code', false, { markDelivered: true })
    expect(first).toContain('call `task_split` ONCE with exactly ONE piece')
    expect(first).toContain('may be a SMALLER, cheaper model')
    expect(first).toContain('the task is complete and you will not be started again on it')
    expect(first).not.toContain('you will be started again once every piece has settled')

    // ⛔ Even with a child on the thread and a `settled` edge — the exact state that flips a split
    //    into its resolution turn — this shape has no resolution turn to flip into.
    const child = tasks.createTask({ title: 'The whole job', status: 'ready', parentTaskId: handoff.id })
    tasks.addDependency(handoff.id, child.id, 'settled')
    tasks.addMessage(handoff.id, 'human', 'one more thing')
    const second = promptText(tasks.requireTask(handoff.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(second).not.toContain('Every piece of your plan has settled')
    expect(second).toContain('call `task_split` ONCE with exactly ONE piece')
  })

  /**
   * ⛔ A notice is a **new fact about the world**, not framing, so it travels on a resumed turn like
   * any other new thing. The whole reason it exists is that the agent cannot see what changed while
   * it was not running.
   */
  it('still carries a branch notice into the session that has the framing', () => {
    const task = continued('Moved workspace', 'carry on')
    const prompt = promptText(task, 'claude-code', true, {
      markDelivered: false,
      branchNotice: '⚠️ This workspace has moved since your last turn'
    })
    expect(prompt).toContain('This workspace has moved since your last turn')
    expect(prompt).toContain('carry on')
    expect(prompt).not.toContain('Moved workspace')
  })
})

/**
 * When the framing a resumed session is holding has **lapsed**.
 *
 * ⛔ Both compaction paths land in one table — the one this tool buys before prompting a revived
 * conversation and the one the CLI performs on itself when a context fills — so one reading answers
 * for both. The reference point is the start of this task's last run *in this session*, which is the
 * moment the framing was last sent: anything earlier answers `true` forever once a conversation has
 * compacted at all, and anything later misses the compaction that happened during the run being
 * continued.
 */
describe('framingLapsed', () => {
  let compaction: typeof import('./compaction.js')

  beforeAll(async () => {
    compaction = await import('./compaction.js')
  })

  /** A task with one finished run in `sessionId`, started at `startedAt`. */
  const ranIn = (sessionId: string, startedAt: number): string => {
    const task = tasks.createTask({ title: `ran in ${sessionId}`, status: 'ready' })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: claude.id,
      sessionId,
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    db.db().prepare('update runs set started_at = ? where id = ?').run(startedAt, run.id)
    return task.id
  }

  it('is false for a conversation that has never compacted', () => {
    const taskId = ranIn('sess-never-compacted', Date.now() - 60_000)
    expect(prompt.framingLapsed(taskId, 'sess-never-compacted')).toBe(false)
  })

  it('is true when a compaction landed after this task last spoke', () => {
    const started = Date.now() - 60_000
    const taskId = ranIn('sess-compacted-after', started)
    compaction.noteCompactionLanded('sess-compacted-after', {
      preTokens: 300_000,
      durationMs: 1000,
      ts: started + 30_000
    })
    expect(prompt.framingLapsed(taskId, 'sess-compacted-after')).toBe(true)
  })

  /**
   * ⛔ The case that would break the reference point. A conversation that compacted *before* this
   * task's last run got the whole framing on that run and is still holding it — reading this as
   * lapsed would restate the contract on every turn of a conversation that had ever compacted once.
   */
  it('is false when the only compaction predates this task’s last run', () => {
    const started = Date.now() - 60_000
    const taskId = ranIn('sess-compacted-before', started)
    compaction.noteCompactionLanded('sess-compacted-before', {
      preTokens: 300_000,
      durationMs: 1000,
      ts: started - 30_000
    })
    expect(prompt.framingLapsed(taskId, 'sess-compacted-before')).toBe(false)
  })

  /**
   * ⚠️ A task that has never run in this conversation is a **borrowed** one, where `resumed` is
   * already false and nothing is being withheld to undo.
   */
  it('is false for a task that has never run in the conversation', () => {
    const other = tasks.createTask({ title: 'never been here', status: 'ready' })
    compaction.noteCompactionLanded('sess-borrowed', {
      preTokens: 300_000,
      durationMs: 1000,
      ts: Date.now()
    })
    expect(prompt.framingLapsed(other.id, 'sess-borrowed')).toBe(false)
  })
})

/**
 * ⛔ **Completion is a claim about the branch, and the claim was not being checked.** Measured on
 * t363 (2026-09-11): the work was right, `task_complete` arrived, and the divergence from the target
 * was found afterwards by `readMergeability` inside `decideFinish` — by which point the one agent
 * holding the whole context of the change had already gone. The clause does not close the race (the
 * target can move between the check and the landing) and nothing here claims it does; it removes the
 * divergence that had been sitting on disk, unlooked-at, for the length of the run.
 */
describe('the pre-completion rebase check', () => {
  /** A git project with `config` merged into its `project.json`. */
  const gitProject = async (slug: string, config: Record<string, unknown> = {}) => {
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), `agentyard-rebase-${slug}-`))
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({ schema_version: 1, name: slug, vcs: 'git', ...config })
    )
    return projects.addProject({ root })
  }

  it('makes an MCP agent check, rebase, re-check and only then report complete', async () => {
    const project = await gitProject('mcp', {
      landing: { finish: 'commit-and-merge' },
      check: ['npm test']
    })
    const task = tasks.createTask({
      title: 'Touch the same file',
      status: 'ready',
      projectId: project.id
    })
    const text = promptText(task, 'claude-code', false, { markDelivered: false })

    expect(text).toContain(
      'Immediately before you call `task_complete`, check whether this branch has fallen behind or ' +
        'diverged from `main`'
    )
    // ⛔ A task may be sandboxed away from its SSH configuration, and fetch is not required for a
    // local branch check. Landing refreshes its own target outside the agent sandbox.
    expect(text).toContain('as it exists in this checkout')
    expect(text).toContain('Do not fetch or otherwise contact a remote')
    expect(text).toContain('rebase onto the current `main` and resolve every conflict yourself')
    // ⚠️ The load-bearing half: a rebase changes the code the checks ran against, so a green result
    // from before it answers for a tree that no longer exists.
    expect(text).toContain("re-run this project's checks")
    expect(text).toContain('a result from before the rebase does not answer for the code after it')
    expect(text).toContain(
      'Do not call `task_complete` while a conflict is unresolved or a rebase is still in progress'
    )

    // ⛔ And the rest of the contract is untouched — this is an addition, not a rewrite.
    expect(text).toContain('Work to the end without stopping between phases')
    expect(text).toContain("run this project's checks (`npm test`) and ensure they pass")
    expect(text).toContain('call the MCP tool `task_complete` with a one-line summary')
    expect(text).toContain('squash them into one coherent commit where safe')
    expect(text).toContain('Do not rewrite commits already on the landing target, force-push')
    expect(text).toContain('call `ask_human` rather than guessing')
    expect(text).toContain('call `await_human` with the reason')
  })

  /**
   * ⛔ The target is the one the landing will really use, through `landingTargetFor` — a task that
   * lands on a release branch told to rebase onto `main` would be told to do the wrong thing, and a
   * plan piece landing on its parent's branch is exactly that case.
   */
  it('names the task’s own landing target, not the project default', async () => {
    const project = await gitProject('target', {
      landing: { finish: 'commit-and-merge', target: 'trunk' }
    })
    const task = tasks.createTask({ title: 'Land elsewhere', status: 'ready', projectId: project.id })
    expect(promptText(task, 'claude-code', false, { markDelivered: false })).toContain(
      'diverged from `trunk`'
    )

    // ⚠️ Set at creation, which is where a task's own target comes from — a plan piece inherits its
    // parent's branch there (`effectiveLandingTarget`), and that is the case this is standing in for.
    const onRelease = tasks.createTask({
      title: 'Land on the release branch',
      status: 'ready',
      projectId: project.id,
      landingTarget: 'release/2.0'
    })
    const own = promptText(onRelease, 'claude-code', false, { markDelivered: false })
    expect(own).toContain('diverged from `release/2.0`')
    expect(own).toContain('rebase onto the current `release/2.0`')
    expect(own).not.toContain('diverged from `trunk`')
  })

  /**
   * ⚠️ In the completion signal's own vocabulary. An MCP-less agent has no `task_complete`, and
   * naming it would name a channel it has not got — the same failure `promptFor` documents for
   * every other tool.
   */
  it('speaks to an MCP-less agent about its line, not about a tool it has not got', async () => {
    const project = await gitProject('mcpless', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({ title: 'No MCP here', status: 'ready', projectId: project.id })
    const text = promptText(task, 'antigravity-cli', false, { markDelivered: false })

    expect(text).toContain('Immediately before you write the `TASK COMPLETE: ` line')
    expect(text).toContain('Do not write the `TASK COMPLETE: ` line while a conflict is unresolved')
    expect(text).not.toContain('task_complete')
    // ⛔ The rest of that adapter's contract survives.
    expect(text).toContain('`NEEDS DECISION:`')
  })

  /**
   * ⛔ **Who runs the checks is not the same question on a one-turn CLI.** A `streamPrompts: 'once'`
   * adapter is told further down that the tool runs this project's checks outside its sandbox, so
   * naming them here would contradict that in the one turn it has. It is still asked to rebase and
   * still asked to re-validate.
   */
  it('does not tell a one-turn CLI to re-run checks somebody else runs', async () => {
    const project = await gitProject('oneturn', {
      landing: { finish: 'commit-and-merge' },
      check: ['npm test']
    })
    const task = tasks.createTask({ title: 'One turn only', status: 'ready', projectId: project.id })
    const text = promptText(task, 'openai-compatible', false, { markDelivered: false })

    expect(text).toContain('Immediately before you write the `TASK COMPLETE: ` line')
    expect(text).toContain('re-run the validation relevant to what you changed')
    expect(text).not.toContain("re-run this project's checks")
    // ⚠️ And the sentence it would have contradicted is still there.
    expect(text).toContain('the tool runs `npm test` outside your sandbox')
  })

  /** ⭐ A checkpointed agent reports complete the same way, so it gets the same requirement. */
  it('applies in checkpointed mode too', async () => {
    const project = await gitProject('checkpointed', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({ title: 'Steered', status: 'ready', projectId: project.id })
    tasks.updateTask(task.id, { completionMode: 'checkpointed' })
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(text).toContain('call the MCP tool `checkpoint`')
    expect(text).toContain('Immediately before you call `task_complete`, check whether this branch')
  })

  /**
   * ⚠️ A plan's resolution turn is the turn most likely to be behind: every piece landed into this
   * branch while the target carried on moving.
   */
  it('applies to a plan’s resolution turn', async () => {
    const project = await gitProject('plan', { landing: { finish: 'commit-and-merge' } })
    const planning = tasks.createTask({
      title: 'Plan and then resolve',
      kind: 'plan',
      status: 'ready',
      projectId: project.id
    })
    const child = tasks.createTask({
      title: 'Piece one',
      status: 'ready',
      projectId: project.id,
      parentTaskId: planning.id
    })
    tasks.addDependency(planning.id, child.id, 'settled')
    const text = promptText(tasks.requireTask(planning.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(text).toContain('Every piece of your plan has settled')
    expect(text).toContain('Immediately before you call `task_complete`, check whether this branch')
  })

  /**
   * ⛔ Not on the planning turn. That turn files a split and stops — it has written no code, so
   * there is nothing to rebase, and the one sentence that matters there is *do not write code*.
   */
  it('is withheld from a planning turn, which has nothing to rebase', async () => {
    const project = await gitProject('planning', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({
      title: 'Only planning',
      kind: 'plan',
      status: 'ready',
      projectId: project.id
    })
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('You are PLANNING this work, not doing it')
    expect(text).not.toContain('Immediately before you call `task_complete`')
  })

  /**
   * ⛔ A non-git project is a pool of one over its own directory, so there is no branch to be behind
   * and no rebase to ask for — instructing one would be naming an action the agent cannot take.
   */
  it('is withheld from a project with no version control', async () => {
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-rebase-novcs-'))
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'no-vcs',
        vcs: 'none',
        landing: { finish: 'commit-and-merge' }
      })
    )
    const project = projects.addProject({ root })
    const task = tasks.createTask({ title: 'No repository', status: 'ready', projectId: project.id })
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('call the MCP tool `task_complete` with a one-line summary')
    expect(text).not.toContain('has fallen behind or diverged')
  })

  /** ⛔ And from a task with no project at all, which has no target to be measured against. */
  it('is withheld from a task with no project', () => {
    const task = tasks.createTask({ title: 'Projectless', status: 'ready' })
    expect(promptText(task, 'claude-code', false, { markDelivered: false })).not.toContain(
      'has fallen behind or diverged'
    )
  })

  /**
   * ⛔ **An open conversation is not told this, and the omission is the point.** It does not reach
   * for `task_complete` on its own judgement, and its route to the target is `land_work`, which does
   * the rebase and the checks itself. Telling it to rebase before a completion it is not supposed to
   * declare would be inviting the landing nobody asked for.
   */
  it('is withheld from an open conversation, which lands through `land_work`', async () => {
    const project = await gitProject('conversation', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({
      title: 'Talk it through',
      kind: 'conversation',
      status: 'ready',
      projectId: project.id
    })
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('call the MCP tool `land_work`')
    expect(text).not.toContain('has fallen behind or diverged')
  })

  /**
   * ⚠️ A follow-up into the session that already read the clause is **pointed** at it rather than
   * given it again — the same subtraction `resumedAnchor` makes for the checks and the hygiene. What
   * the anchor has to carry is that the requirement still stands, because a follow-up arriving hours
   * later is the turn most likely to be sitting behind its target.
   */
  it('is pointed at, not repeated, on a follow-up into the same session', async () => {
    const project = await gitProject('followup', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({ title: 'Carry on', status: 'ready', projectId: project.id })
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', 'one more thing')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false
    })

    expect(text).toContain('one more thing')
    expect(text).toContain('the state this branch has to be in before you report complete')
    expect(text).toContain('call the MCP tool `task_complete` with a one-line summary')
    // ⛔ Pointed at, not restated: the session read it in full on its first turn.
    expect(text).not.toContain('has fallen behind or diverged')
  })

  /**
   * ⭐ **A compaction undoes the subtraction.** What the agent holds afterwards is a summary somebody
   * else wrote, and nothing guarantees the clause survived it — so the whole contract, this clause
   * included, goes back in.
   */
  it('comes back in full after a compaction', async () => {
    const project = await gitProject('compacted', { landing: { finish: 'commit-and-merge' } })
    const task = tasks.createTask({
      title: 'Compacted mid-task',
      status: 'ready',
      projectId: project.id
    })
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', 'and now this')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false,
      compacted: true
    })
    expect(text).toContain('Immediately before you call `task_complete`, check whether this branch')
  })
})

/**
 * ⛔ **t507 ← t505, 2026-09-17.** An operator filed a Plan & Split task and the agent just landed
 * code, having never called `task_split` — nothing kept the task off an MCP-less adapter, and
 * `promptFor`'s MCP-less branch (the `else` a few hundred lines up from here) has no planning or
 * arbitration instruction to give one: it falls straight through to the ordinary "do the work and
 * say `TASK COMPLETE`" contract. `createTask` now writes `needs: ['mcp']` into a plan or debate
 * task's own constraints, so the capability gate `scoreCandidate` already enforces per worker
 * refuses an MCP-less candidate before it is ever dispatched, rather than dispatching it into a
 * prompt with no instruction to carry out the kind of task it was filed as.
 */
describe('a plan or debate task requires an MCP adapter', () => {
  // ⚠️ The installed gate stands before the capability gate in `accountRefusal`, so on a host
  // without Antigravity (CI run 35403689962) the refusal read "is not installed" and never reached
  // "lacks mcp". Stubbed for these tests, as every scheduler suite here does for `claude-code`.
  let origInstalled: (() => boolean) | undefined
  beforeAll(async () => {
    const { antigravityCli } = await import('./adapters/antigravity-cli.js')
    origInstalled = antigravityCli.isInstalled
    antigravityCli.isInstalled = () => true
  })
  afterAll(async () => {
    if (!origInstalled) return
    const { antigravityCli } = await import('./adapters/antigravity-cli.js')
    antigravityCli.isInstalled = origInstalled
  })

  it('refuses an MCP-less adapter pinned to a plan task', async () => {
    const scoring = await import('./scoring.js')
    const task = tasks.createTask({
      title: 'Split this work',
      kind: 'plan',
      status: 'ready',
      constraints: { workerId: agy.id, adapterId: 'antigravity-cli' }
    })
    expect(task.constraints.needs).toContain('mcp')
    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('lacks mcp')
  })

  it('refuses an MCP-less adapter pinned to a debate organizer', async () => {
    const scoring = await import('./scoring.js')
    const task = tasks.createTask({
      title: 'Debate this',
      kind: 'debate',
      status: 'ready',
      constraints: { workerId: agy.id, adapterId: 'antigravity-cli' },
      mandate: { maxChildren: 2 },
      debate: { seats: [], rounds: 1, exchange: 'full', round: 1, verdict: null }
    })
    expect(task.constraints.needs).toContain('mcp')
    const choice = scoring.chooseTarget(task)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('lacks mcp')
  })

  it('leaves an ordinary work task unaffected', () => {
    const task = tasks.createTask({ title: 'Just work', status: 'ready' })
    expect(task.constraints.needs ?? []).not.toContain('mcp')
  })
})

/**
 * ⛔ **t562 ← t557, 2026-09-19.** An operator switched a live conversation's worker twice — once to
 * Antigravity, then to Codex — and the prompt the incoming codex run received was the *opening*
 * prompt verbatim and nothing else. The two revision instructions it was being asked to act on and
 * the draft it was being asked to revise were both recorded in the thread; neither travelled,
 * because `outstanding` carries the first message plus whatever is undelivered, and everything in
 * between had been delivered to a session that no longer existed. `openai-compatible` declares
 * `mcp: false`, so `task_read` was not offered either and there was no route back to any of it.
 *
 * ⚠️ Every assertion here is about a **cold** prompt. The subtraction a resumed session gets is the
 * point of `outstanding` and is covered above; what these prove is that it stops at the session
 * boundary rather than at the task's first message.
 */
describe('a cold successor is given the conversation it is joining', () => {
  /** The thread t557 actually had when its worker was switched, in miniature. */
  const switchedMidConversation = (title: string) => {
    const task = tasks.createTask({
      title,
      prompt: 'Draft the launch posts and store them in internal_docs/.',
      kind: 'conversation',
      status: 'ready'
    })
    // First dispatch: the opening prompt is delivered to the agent, which then answers.
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'agent', 'Drafted seven posts leading with the reviewer-bias finding.')
    tasks.addMessage(task.id, 'human', 'Too many posts — lead with what the tool does instead.')
    // Second dispatch, same session: the note is delivered there and answered there.
    promptText(tasks.requireTask(task.id), 'claude-code', true, { markDelivered: true })
    tasks.addMessage(task.id, 'agent', 'Revised to five posts, product first.')
    return tasks.requireTask(task.id)
  }

  it('carries the middle of the conversation into a reassigned cold prompt', () => {
    const task = switchedMidConversation('Expand the reach')
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    // The opening prompt still travels, as it always did.
    expect(text).toContain('Draft the launch posts and store them in internal_docs/.')
    // ⛔ And so does everything t557 lost.
    expect(text).toContain('Too many posts — lead with what the tool does instead.')
    expect(text).toContain('Drafted seven posts leading with the reviewer-bias finding.')
    expect(text).toContain('Revised to five posts, product first.')
  })

  it('marks the earlier turns as context rather than as instructions', () => {
    const task = switchedMidConversation('Context not instructions')
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('You are picking up a conversation that is already under way')
    expect(text).toContain('they are context, not instructions to carry out again')
    expect(text).toContain('[earlier turn — the person]')
    // ⚠️ Never "you": the reader did not write these replies and must not defend them.
    expect(text).toContain('[earlier turn — the agent that was working on this]')
    expect(text).not.toContain('[earlier turn — you]')
  })

  it('keeps the recap in thread order, with a new note still last', () => {
    const task = switchedMidConversation('Order holds')
    tasks.addMessage(task.id, 'human', 'Also add a LinkedIn variant.')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    const at = (needle: string) => text.indexOf(needle)
    expect(at('Draft the launch posts')).toBeGreaterThan(-1)
    expect(at('Drafted seven posts')).toBeGreaterThan(at('Draft the launch posts'))
    expect(at('Too many posts')).toBeGreaterThan(at('Drafted seven posts'))
    expect(at('Revised to five posts')).toBeGreaterThan(at('Too many posts'))
    // ⛔ The thing actually being asked now is the newest thing in the prompt.
    expect(at('Also add a LinkedIn variant.')).toBeGreaterThan(at('Revised to five posts'))
  })

  /**
   * ⛔ The half t557 had no answer for at all. `openai-compatible` has no MCP, so this block is the
   * whole record that agent will ever see, and it must not be sent after a tool it has not got.
   */
  it('gives an MCP-less adapter the recap and no tool it does not have', () => {
    const task = switchedMidConversation('Codex picks it up')
    const text = promptText(task, 'openai-compatible', false, { markDelivered: false })
    expect(text).toContain('Too many posts — lead with what the tool does instead.')
    expect(text).toContain('Revised to five posts, product first.')
    expect(text).toContain('re-read any file one of them refers to')
    expect(text).not.toContain('`task_read`')
  })

  it('points an MCP adapter at task_read for the unabridged thread', () => {
    const task = switchedMidConversation('Claude picks it up')
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('Call the MCP tool `task_read` for the complete thread and every prior run')
  })

  /**
   * ⛔ The subtraction that pays for all of this. A resumed session holds these turns in its own
   * transcript; replaying them is the double charge `outstanding` exists to prevent.
   */
  it('sends no recap into the session that already holds the conversation', () => {
    const task = switchedMidConversation('Same session carries on')
    tasks.addMessage(task.id, 'human', 'One more tweak.')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, { markDelivered: false })
    expect(text).toContain('One more tweak.')
    expect(text).not.toContain('[earlier turn')
    expect(text).not.toContain('Drafted seven posts')
  })

  /**
   * ⚠️ A compaction makes `holdsPrompt` false, which is what restores the task's own instruction —
   * but the session still holds a summary somebody has already paid for, so the recap stays out.
   */
  it('sends no recap into a compacted resume, which holds a paid-for summary', () => {
    const task = switchedMidConversation('Compacted carries on')
    tasks.addMessage(task.id, 'human', 'Carry on after the compaction.')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false,
      compacted: true
    })
    expect(text).toContain('Carry on after the compaction.')
    expect(text).not.toContain('[earlier turn')
  })

  it('costs a task with no prior conversation nothing', () => {
    const task = tasks.createTask({ title: 'Brand new', prompt: 'Do the thing.', status: 'ready' })
    const text = promptText(task, 'claude-code', false, { markDelivered: false })
    expect(text).toContain('Do the thing.')
    expect(text).not.toContain('[earlier turn')
    expect(text).not.toContain('picking up a conversation')
  })

  /**
   * ⛔ A recap is not consumed by being sent. `markDelivered` governs what is carried *in full*;
   * these turns were delivered long ago and are recapped for every cold successor, because a second
   * reassignment needs the history exactly as much as the first did — t557 had two.
   */
  it('recaps the same turns again for a second reassignment', () => {
    const task = switchedMidConversation('Switched twice')
    promptText(task, 'claude-code', false, { markDelivered: true })
    const again = promptText(tasks.requireTask(task.id), 'openai-compatible', false, {
      markDelivered: false
    })
    expect(again).toContain('Too many posts — lead with what the tool does instead.')
    expect(again).toContain('Revised to five posts, product first.')
  })

  /** ⛔ Bounded, and the bound announces itself — the t529 failure was a silent `slice(0, 400)`. */
  it('abridges an oversized agent turn and says that it did', () => {
    const task = tasks.createTask({
      title: 'Long reply',
      prompt: 'Write the whole thing.',
      status: 'ready'
    })
    promptText(task, 'claude-code', false, { markDelivered: true })
    const head = 'HEAD-OF-THE-REPLY'
    const tail = 'TAIL-OF-THE-REPLY'
    tasks.addMessage(task.id, 'agent', [head, 'filler line\n'.repeat(1200), tail].join('\n'))
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(text).toContain(head)
    expect(text).not.toContain(tail)
    expect(text).toContain('[earlier turn — the agent that was working on this, abridged]')
  })

  it('leaves a turn inside its budget unmarked and whole', () => {
    const task = tasks.createTask({ title: 'Short reply', prompt: 'Go.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'agent', 'Done, and here is the whole of it.')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(text).toContain('Done, and here is the whole of it.')
    expect(text).toContain('[earlier turn — the agent that was working on this]')
    expect(text).not.toContain(', abridged]')
  })

  /**
   * ⛔ The turns that fall off the end are the earliest ones, and the header says how many. A
   * successor most needs the last thing asked and the last thing done.
   */
  it('drops the oldest turns past the total budget and counts them', () => {
    const task = tasks.createTask({ title: 'Very long thread', prompt: 'Start.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    for (let i = 0; i < 12; i++) {
      tasks.addMessage(task.id, 'agent', `TURN-${i} ${'x'.repeat(1900)}`)
    }
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(text).toContain('TURN-11 ')
    expect(text).not.toContain('TURN-0 ')
    expect(text).toMatch(/\d+ earlier turns before those are not shown/)
  })

  /** ⚠️ Singular where there is one, because a prompt that says *1 turns* reads as a bug. */
  it('agrees the omitted count with the turns it kept', () => {
    const task = tasks.createTask({ title: 'Boundary', prompt: 'Start.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    for (let i = 0; i < 7; i++) tasks.addMessage(task.id, 'agent', `T${i} ${'x'.repeat(1990)}`)
    const { turns, omitted } = prompt.recapTurns(task.id, new Set<number>())
    expect(turns.length).toBeGreaterThan(0)
    expect(omitted).toBeGreaterThan(0)
    // 7 agent turns plus the opening prompt, none of which is being carried in full here.
    expect(turns.length + omitted).toBe(8)
  })

  /**
   * ⛔ **A message carried in full is never also recapped.** The opening prompt is in `outstanding`
   * on every cold prompt, and a duplicate of it would be paid for twice and read as two asks.
   */
  it('never repeats a message it is already carrying in full', () => {
    const task = switchedMidConversation('No duplicates')
    tasks.addMessage(task.id, 'human', 'The newest ask.')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    const occurrences = (needle: string) => text.split(needle).length - 1
    expect(occurrences('Draft the launch posts and store them in internal_docs/.')).toBe(1)
    expect(occurrences('The newest ask.')).toBe(1)
    expect(occurrences('Too many posts — lead with what the tool does instead.')).toBe(1)
  })

  /**
   * ⛔ `system` rows stay out of the recap. The two that matter — `landing.failed`, `finish.held` —
   * already travel through `outstanding` and are delivery-tracked there (t446); recapping them too
   * would resend a landing failure the previous run had already been told about and fixed.
   */
  it('leaves system timeline entries to the outcome filter that owns them', () => {
    const task = tasks.createTask({ title: 'Timeline stays out', prompt: 'Land it.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'system', 'Worker switched to CodexFirst', null, [], {
      event: 'worker.switched'
    })
    tasks.addMessage(task.id, 'system', 'Not landed: no commits were produced', null, [], {
      event: 'landing.failed',
      detail: 'no commits were produced'
    })
    promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: true })
    const again = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(again).not.toContain('Worker switched to CodexFirst')
    expect(again).not.toContain('Not landed: no commits were produced')
  })

  /** ⚠️ A controller's own note to the agent is part of what was said, and is labelled as its own. */
  it('labels a controller turn as Warmstart', () => {
    const task = tasks.createTask({ title: 'Controller spoke', prompt: 'Go.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'controller', 'Rebased onto main for you.')
    tasks.markDelivered(tasks.messagesFor(task.id).map((m) => m.id))
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(text).toContain('[earlier turn — Warmstart]')
    expect(text).toContain('Rebased onto main for you.')
  })

  /** ⚠️ An empty or whitespace-only row is not a turn and must not earn a label of its own. */
  it('skips an empty turn', () => {
    const task = tasks.createTask({ title: 'Empty row', prompt: 'Go.', status: 'ready' })
    promptText(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'agent', '   ')
    const text = promptText(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false })
    expect(text).not.toContain('[earlier turn')
  })
})
