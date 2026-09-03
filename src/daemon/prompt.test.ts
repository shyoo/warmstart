import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Worker } from '@shared/protocol.js'

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let scheduler: typeof import('./scheduler.js')
let api: typeof import('./api.js')

let claude: Worker
let agy: Worker

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-prompt-test-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  scheduler = await import('./scheduler.js')
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
const promptText = (...args: Parameters<typeof scheduler.promptFor>): string =>
  scheduler.promptFor(...args).text

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
  })

  it('tells an autonomous agent to run to the end', () => {
    const task = tasks.createTask({ title: 'Autonomous by default', status: 'ready' })
    const prompt = promptText(task, 'claude-code', false, { markDelivered: false })
    // ⛔ The fleet default, and the premise of the tool: unattended progress across quota
    // windows hours long. A default of `checkpointed` would need a person present for every task.
    expect(prompt).toContain('Work to the end without stopping between phases')
    expect(prompt).not.toContain('`checkpoint`')
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
    mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
    writeFileSync(
      join(root, '.multi_agent_controller', 'project.json'),
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
    expect(prompt).toContain('commit what you have and end with a one-line summary of what changed')
    // ⛔ An anchored contract, not an invitation to say something. It is what
    // `needsDecisionIn` matches on, so the two have to be checked against each other.
    expect(prompt).toContain('`NEEDS DECISION:`')
    expect(scheduler.needsDecisionIn('NEEDS DECISION: which one?')?.question).toBe('which one?')
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
    expect(detail.previewPrompt).toContain('commit what you have and end with a one-line summary')
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

  it('instructs agent to run project checks before committing when project defines checks', async () => {
    const projects = await import('./projects.js')
    const root = mkdtempSync(join(tmpdir(), 'agentyard-checks-prompt-'))
    mkdirSync(join(root, '.multi_agent_controller'), { recursive: true })
    writeFileSync(
      join(root, '.multi_agent_controller', 'project.json'),
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

    const res = await scheduler.resolveChecksOnTask(task.id)
    expect(res).toEqual({ ok: true })

    const msgs = tasks.messagesFor(task.id)
    const lastHuman = msgs.filter((m) => m.role === 'human').pop()
    expect(lastHuman?.text).toContain('The landing failed because project verification checks failed')
    expect(lastHuman?.text).toContain('1 problem (1 error)')
    expect(lastHuman?.text).toContain(`multi-agent-controller/t${task.seq}-fix-issue`)
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

    const res = await scheduler.resolveCommitOnTask(task.id)
    expect(res).toEqual({ ok: true })

    const updatedTask = tasks.requireTask(task.id)
    expect(updatedTask.finishAskedAt).toBeNull()

    const msgs = tasks.messagesFor(task.id)
    const lastHuman = msgs.filter((m) => m.role === 'human').pop()
    expect(lastHuman?.text).toContain('The landing could not proceed because changes on')
    expect(lastHuman?.text).toContain('1 file(s) are uncommitted')
    expect(lastHuman?.text).toContain(`multi-agent-controller/t${task.seq}-commit-my-change`)
  })

  it('keeps a failed retry-landing result visible after the thread refreshes', async () => {
    // ⛔ `task.land` returns this reason to the renderer, but a thread refresh replaces its local
    // state immediately. The result must therefore also be written to the task; otherwise the
    // Retry landing button simply bounces back with no explanation.
    const task = tasks.createTask({ title: 'Explain a failed retry', status: 'ready' })
    tasks.setStatus(task.id, 'awaiting_human', {
      branch: 'multi-agent-controller/t87-retry-landing',
      holdReason: 'landing failed: the trunk was busy'
    })

    await expect(scheduler.relandTask(task.id)).resolves.toEqual({ ok: false, reason: 'not a git project' })
    expect(tasks.requireTask(task.id).holdReason).toBe('Retry landing failed: not a git project')
    expect(tasks.messagesFor(task.id).at(-1)).toMatchObject({
      role: 'system',
      text: 'Retry landing failed: not a git project'
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
    const built = scheduler.promptFor(task, 'claude-code', false, { markDelivered: false })
    expect(built.attachments.map((a) => a.id)).toEqual([image.id])
    // ⛔ On every adapter, including the one that also gets the bytes. All three read a PNG off
    // disk with their own view tool, and this is what rescues a run whose inline block a vendor
    // update quietly stopped accepting.
    expect(built.text).toContain(image.file)
    expect(built.text).toContain('Attached context:')
  })

  it('names the path to antigravity too, which is the only channel it has', () => {
    const { task, image } = withImage('Match this on agy')
    const built = scheduler.promptFor(task, 'antigravity-cli', false, { markDelivered: false })
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
    const first = scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    expect(first.attachments).toHaveLength(1)

    // A later note on the same task carries its own attachments and none of the earlier ones.
    tasks.addMessage(task.id, 'human', 'and one more thing')
    const second = scheduler.promptFor(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: true
    })
    expect(second.text).toContain('and one more thing')
    expect(second.attachments).toEqual([])
    expect(second.text).not.toContain('Attached context')
  })

  it('travels again when a preemption re-sends the first prompt', () => {
    const { task, image } = withImage('Preempted with a screenshot')
    scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    // ⛔ `resumed: false` is what a fresh session after a preemption gets: the task's own prompt is
    // restated because that session has never seen it — and the image has to come with it, or the
    // agent is reading a sentence about a picture it was not given.
    const again = scheduler.promptFor(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: false
    })
    expect(again.attachments.map((a) => a.id)).toEqual([image.id])
    expect(again.text).toContain(image.file)
  })

  it('carries an image pasted into a note, on the run that delivers the note', () => {
    const task = tasks.createTask({ title: 'A note with a picture', status: 'ready' })
    scheduler.promptFor(task, 'claude-code', false, { markDelivered: true })
    const image = attachments.createAttachment(png, 'image/png')
    tasks.addMessage(task.id, 'human', 'this is what it looks like now', null, [image.id])

    const built = scheduler.promptFor(tasks.requireTask(task.id), 'claude-code', false, {
      markDelivered: true
    })
    expect(built.attachments.map((a) => a.id)).toEqual([image.id])
    expect(built.text).toContain('this is what it looks like now')
  })

  it('says nothing about attachments on a task that has none', () => {
    const task = tasks.createTask({ title: 'No pictures here', status: 'ready' })
    const built = scheduler.promptFor(task, 'claude-code', false, { markDelivered: false })
    expect(built.attachments).toEqual([])
    expect(built.text).not.toContain('Attached context')
  })
})
