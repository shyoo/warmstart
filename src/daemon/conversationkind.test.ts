import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'
import type { Session, Worker } from '@shared/protocol.js'
import {
  isOpenConversation,
} from '@shared/tasks.js'
import { resolveFinishPolicy, resolveSessionSharing } from '@shared/policy.js'

/**
 * The `conversation` kind: a task with the single-turn contract taken out of it.
 *
 * ⛔ **What is being pinned here is a set of *subtractions*, which is the hardest kind of behaviour
 * to keep.** A conversation is dispatched by the same scheduler, lands by the same landing path and
 * is priced by the same cost model as any other task — the only differences are that it is never
 * told to finish in one turn, never told to commit, never allowed to inherit a landing policy from
 * its project, and never routed off the account it is already talking to. Every one of those is a
 * sentence that is *absent*, and an absence is exactly what a refactor puts back without noticing.
 *
 * ⚠️ The four are deliberately tested against the same task object rather than four fixtures. They
 * are one decision — *a person is in this loop* — and a conversation that kept three of them would
 * be worse than one that kept none, because it would look like it was working.
 */

let dir: string
let db: typeof import('./db.js')
let workers: typeof import('./workers.js')
let tasks: typeof import('./tasks.js')
let resolutions: typeof import('./resolutions.js')
let turnend: typeof import('./turnend.js')
let scoring: typeof import('./scoring.js')
let prompt: typeof import('./prompt.js')
let projects: typeof import('./projects.js')
let worktrees: typeof import('./worktrees.js')

let claude: Worker
let second: Worker
let turn = 0

const project = (finish?: string): Project =>
  ({
    id: 'p1',
    name: 'repo',
    root: 'C:\\repo',
    vcs: 'git',
    config: finish === undefined ? {} : { landing: { finish } }
  }) as unknown as Project

const promptText = (task: Task, adapterId = 'claude-code'): string =>
  prompt.promptFor(task, adapterId, false, { markDelivered: false }).text

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-conversationkind-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  workers = await import('./workers.js')
  tasks = await import('./tasks.js')
  resolutions = await import('./resolutions.js')
  turnend = await import('./turnend.js')
  scoring = await import('./scoring.js')
  prompt = await import('./prompt.js')
  projects = await import('./projects.js')
  worktrees = await import('./worktrees.js')
  const { claudeCode } = await import('./adapters/claude-code.js')
  claudeCode.isInstalled = () => true
  db.openDb(join(dir, 'conversationkind.db'))
  claude = workers.createWorker({ adapterId: 'claude-code', label: 'convo-1', enabled: true })
  second = workers.createWorker({ adapterId: 'claude-code', label: 'convo-2', enabled: true })
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('what a conversation resolves its two forced settings to', () => {
  const convo = (): Task =>
    ({
      id: 'c1',
      seq: 1,
      kind: 'conversation',
      finishPolicy: 'inherit',
      sessionSharing: 'inherit',
      constraints: {}
    }) as Task

  it('answers await-human over a project that says commit-and-merge', () => {
    // ⛔ The case the kind exists for. Without this, filing a chat into an ordinary project would
    // merge the repository every time the agent said something that sounded conclusive.
    expect(resolveFinishPolicy(convo(), project('commit-and-merge'))).toEqual({
      policy: 'await-human',
      source: 'task',
      instruction: null
    })
  })

  it('answers reuse-on, which is the other half of what a conversation is', () => {
    expect(resolveSessionSharing(convo(), project())).toEqual({ sharing: 'on', source: 'task' })
  })

  it('leaves an ordinary task alone', () => {
    const work = { ...convo(), kind: 'work' } as Task
    expect(resolveFinishPolicy(work, project('commit-and-merge')).policy).toBe('commit-and-merge')
    expect(resolveSessionSharing(work, project()).sharing).toBe('off')
  })

  it('stands aside the moment a rung is written, because that write is the Commit button', () => {
    // ⛔ Not a loophole — the mechanism. `isOpenConversation` is false from here on, which is what
    // switches the next turn back to the ordinary "commit and report complete" instruction.
    const asked = { ...convo(), finishPolicy: 'commit-and-merge' } as Task
    expect(isOpenConversation(asked)).toBe(false)
    expect(resolveFinishPolicy(asked, project()).policy).toBe('commit-and-merge')
  })

  it('still lets somebody turn sharing off on one conversation', () => {
    const solo = { ...convo(), sessionSharing: 'off' } as Task
    expect(resolveSessionSharing(solo, project()).sharing).toBe('off')
  })
})

describe('what a conversation is told at the end of its turn', () => {
  const conversation = (): Task =>
    tasks.requireTask(
      tasks.createTask({ title: 'Talk this through with me', kind: 'conversation', status: 'ready' })
        .id
    )

  it('is told it gets another turn, and is not told to run to the end', () => {
    const prompt = promptText(conversation())
    expect(prompt).toContain('This is an ongoing conversation, not a one-shot task')
    expect(prompt).toContain('you will get another turn')
    expect(prompt).not.toContain('Work to the end without stopping between phases')
  })

  it('may commit on its own branch, and may never merge or push to the target', () => {
    // ⛔ The line moved, and where it moved to is the point. A commit on the agent's own branch is
    // free and is how work survives a preemption; what is forbidden is the half that touches
    // somebody else's ref. The old wording forbade both together and left a conversation that had
    // been asked to commit with nothing it was allowed to do.
    const prompt = promptText(conversation())
    expect(prompt).toContain('You may commit on your own branch whenever it helps')
    expect(prompt).toContain('never merge or push to the landing target yourself')
    expect(prompt).not.toContain('squash them into one coherent commit')
  })

  it('is told how to land when it is asked to, and that landing does not end the task', () => {
    // ⛔ Both halves, and the second is what stops `land_work` reading as a quieter
    // `task_complete`. An agent that lands and then stops has left somebody mid-sentence.
    const prompt = promptText(conversation())
    expect(prompt).toContain('When the person asks you to land the work')
    expect(prompt).toContain('`land_work`')
    expect(prompt).toContain('Landing does not end this task')
  })

  it('is told not to reach for task_complete on its own judgement, but is told the tool exists', () => {
    // ⚠️ Both halves. An agent that is never told the tool exists hunts for a way to finish and
    // burns the turn; one that is told to call it when it feels done closes the conversation.
    const prompt = promptText(conversation())
    expect(prompt).toContain('Do not call `task_complete` on your own judgement')
    expect(prompt).toContain('call `ask_human` rather than guessing')
  })

  it('never gets the one-turn landing instruction a print-mode CLI is given', () => {
    // ⛔ `streamPrompts: 'once'`. That block says "you get one turn and no follow-up, so finish the
    // job in it" and commit — the precise instruction this kind exists to withhold.
    const prompt = promptText(conversation(), 'openai-compatible')
    expect(prompt).not.toContain('You get one turn and no follow-up')
    expect(prompt).toContain('This is an ongoing conversation')
  })

  it('gets the MCP-less wording of the same contract on an adapter with no tools', () => {
    const prompt = promptText(conversation(), 'antigravity-cli')
    expect(prompt).toContain('This is an ongoing conversation')
    expect(prompt).toContain('Do not end a reply with a line beginning `TASK COMPLETE: `')
    expect(prompt).toContain('NEEDS DECISION:')
  })

  it('⛔ never names `land_work` to an adapter that has no MCP, and names the person instead', () => {
    // ⛔ Decided from `capabilities.mcp`, never from the adapter's name. Naming a tool an agent has
    // not got is not a harmless extra sentence: it reads as an instruction it cannot follow, and the
    // agent spends the turn hunting for the tool rather than saying the work is ready.
    const prompt = promptText(conversation(), 'antigravity-cli')
    expect(prompt).not.toContain('land_work')
    expect(prompt).toContain('the person lands it from this thread')
    // ⚠️ And the commit half is the same on both: commit freely, never touch the target.
    expect(prompt).toContain('never merge or push to the landing target yourself')
  })

  it('goes back to the ordinary instruction once a real rung is written', () => {
    // ⚠️ **No button writes one any more** — Commit asks and Land lands, and both leave the task an
    // open conversation. The only thing that reaches this is an operator setting the task's own
    // finish dropdown, which is them saying to finish it like a work task. The mechanism is pinned
    // here because that is what `isOpenConversation` is for.
    const task = conversation()
    tasks.updateTask(task.id, { finishPolicy: 'commit-and-merge' })
    const prompt = promptText(tasks.requireTask(task.id))
    expect(prompt).toContain('call the MCP tool `task_complete` with a one-line summary')
    expect(prompt).toContain('squash them into one coherent commit')
    expect(prompt).not.toContain('This is an ongoing conversation')
  })

  it('leaves an ordinary task’s instruction exactly as it was', () => {
    const work = tasks.createTask({ title: 'Ordinary work', status: 'ready' })
    const prompt = promptText(work)
    expect(prompt).toContain('Work to the end without stopping between phases')
    expect(prompt).not.toContain('This is an ongoing conversation')
  })
})

/**
 * What a follow-up into a conversation that is still live is sent.
 *
 * ⛔ **Nothing but what the person typed.** Measured on t260: every turn after the first arrived
 * with the opening prompt restated on top and the whole conversation contract underneath — both
 * addressed to a session that had read them already and never stopped since. The restated prompt
 * reads as being asked to do that work a second time; the restated contract is paid for on every
 * turn to teach an agent something it is currently obeying.
 *
 * ⚠️ The subtraction is `resumed`-only, and the two tests below that pin the *un*-subtracted
 * cases are the point: a fresh session after a preemption has none of this in its history, and a
 * conversation somebody has pressed Commit on is not a conversation any more.
 *
 * ⚠️ **An ordinary task is subtracted too now** (t286) — the reason was never conversation-specific
 * — but not to nothing: it keeps one sentence naming `task_complete`, because that tool is the only
 * signal a run finished. `prompt.test.ts` owns that case in full; the test here pins the one thing
 * this file is about, which is that the *conversation* contract is not what an ordinary task gets.
 */
describe('what a follow-up into a live conversation is sent', () => {
  /** A conversation whose opening prompt has already gone out, with `text` typed underneath it. */
  const followUp = (title: string, text: string): Task => {
    const task = tasks.requireTask(
      tasks.createTask({ title, kind: 'conversation', status: 'ready' }).id
    )
    prompt.promptFor(task, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(task.id, 'human', text)
    return tasks.requireTask(task.id)
  }

  it('is the message and nothing else — no restated prompt, no contract', () => {
    const task = followUp('Set up notarization on CI', 'What about the provisioning profile?')
    const text = prompt.promptFor(task, 'claude-code', true, { markDelivered: false }).text
    expect(text).toBe('What about the provisioning profile?')
  })

  it('is the message and nothing else on an adapter with no tools either', () => {
    const task = followUp('Notarization, agy', 'And the entitlements file?')
    const text = prompt.promptFor(task, 'antigravity-cli', true, { markDelivered: false }).text
    expect(text).toBe('And the entitlements file?')
  })

  it('still restates everything into the fresh session a preemption starts', () => {
    // ⛔ `resumed: false`. That session has never seen the opening prompt or the contract, so
    // withholding them there would hand it a stray sentence and no idea what it was for.
    const task = followUp('Preempted chat', 'and the notarytool password?')
    const text = prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(text).toContain('Preempted chat')
    expect(text).toContain('and the notarytool password?')
    expect(text).toContain('This is an ongoing conversation')
  })

  it('subtracts an ordinary task’s framing too, but never into the conversation contract', () => {
    const work = tasks.createTask({ title: 'Ordinary work, resumed', status: 'ready' })
    prompt.promptFor(work, 'claude-code', false, { markDelivered: true })
    tasks.addMessage(work.id, 'human', 'also check the linter')
    const text = prompt.promptFor(tasks.requireTask(work.id), 'claude-code', true, {
      markDelivered: false
    }).text
    expect(text).toContain('also check the linter')
    expect(text).not.toContain('Ordinary work, resumed')
    expect(text).not.toContain('Work to the end without stopping between phases')
    // ⛔ The one thing this file is about: a `work` task is never handed the contract that tells an
    // agent a person decides when to commit. What it gets instead is pinned in `prompt.test.ts`.
    expect(text).not.toContain('This is an ongoing conversation')
    expect(text).toContain('call the MCP tool `task_complete`')
  })

  it('says the whole thing again once Commit has written a rung', () => {
    // ⛔ The rung takes the task out of `isOpenConversation`, and the turn it is asking for is an
    // ordinary landing turn — which needs the landing instruction whether the session is warm or not.
    const task = followUp('Chat, then commit', 'ok, land it')
    tasks.updateTask(task.id, { finishPolicy: 'commit-and-merge' })
    const text = prompt.promptFor(tasks.requireTask(task.id), 'claude-code', true, {
      markDelivered: false
    }).text
    expect(text).toContain('ok, land it')
    expect(text).toContain('call the MCP tool `task_complete` with a one-line summary')
  })
})

describe('which account a conversation comes back to', () => {
  /** A live session on `worker`, and a finished run of `taskId` in it. */
  const talkedTo = (taskId: string, worker: Worker): string => {
    const sessionId = `sess-${taskId}-${worker.id}`.slice(0, 40)
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               tokens_since_compact, started_at)
         values (?,?,?,'stream','C:\\ws1','live','work',0,?)`
      )
      .run(sessionId, worker.id, worker.adapterId, Date.now())
    const run = tasks.startRun({
      taskId,
      workerId: worker.id,
      sessionId,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.finishRun(run.id, 'completed', 'the turn ended; the conversation is still open')
    return sessionId
  }

  it('comes back to the account it was already talking to, and says why', () => {
    // ⚠️ One task and one assertion set, because two would need two live sessions on the same
    // one-slot account — and the second of those is at capacity for reasons that have nothing to do
    // with what is being tested here.
    const task = tasks.createTask({ title: 'Sticky chat', kind: 'conversation', status: 'ready' })
    talkedTo(task.id, second)
    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(second.id)
    expect(choice.routedBy).toBe('sticky')
    // ⛔ And the field it declined to use is still written down. A decision that skipped the
    // arithmetic must not also hide it, or the routing ledger would have a hole exactly where the
    // question "why did this not go to the cheaper account" gets asked.
    expect((choice.scored ?? []).find((c) => c.chosen)?.workerId).toBe(second.id)
  })

  it('follows a person who reassigns it, because a pin empties the candidate list of everyone else', () => {
    // ⛔ One of the two escapes, and it is the candidate loop rather than a special case here.
    const task = tasks.createTask({ title: 'Reassigned chat', kind: 'conversation', status: 'ready' })
    talkedTo(task.id, second)
    tasks.updateTask(task.id, { constraints: { workerId: claude.id } })
    const choice = scoring.chooseTarget(tasks.requireTask(task.id))
    expect(choice.worker?.id).toBe(claude.id)
    expect(choice.routedBy).toBe('pinned')
  })

  it('does not stick an ordinary task to its last account', () => {
    const task = tasks.createTask({ title: 'Ordinary, and re-routable', status: 'ready' })
    talkedTo(task.id, second)
    expect(scoring.chooseTarget(tasks.requireTask(task.id)).routedBy).not.toBe('sticky')
  })
})

describe('what ends a conversation turn', () => {
  /** A conversation that is `running`, in a live session, on `claude`. */
  const talking = (adapterId = 'claude-code'): { task: Task; session: Session; runId: string } => {
    turn += 1
    const sessionId = `7a1c0000-0000-4000-8000-00000000000${turn}`
    db.db()
      .prepare(
        `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                               tokens_since_compact, started_at)
         values (?,?,?,'stream',?,'live','work',0,?)`
      )
      .run(sessionId, claude.id, adapterId, dir, Date.now())
    const task = tasks.createTask({
      title: `Turn ${turn}`,
      kind: 'conversation',
      status: 'ready'
    })
    const run = tasks.startRun({
      taskId: task.id,
      workerId: claude.id,
      sessionId,
      projectId: null,
      quotaUnverified: true,
      costModelId: null
    })
    tasks.setStatus(task.id, 'running', { assignee: claude.id })
    return {
      task,
      runId: run.id,
      session: {
        id: sessionId,
        workerId: claude.id,
        adapterId,
        transport: 'stream',
        projectId: null,
        cwd: dir,
        state: 'live',
        purpose: 'work',
        model: null,
        effort: null,
        startedAt: Date.now(),
        lastRequestStartedAt: null
      } as unknown as Session
    }
  }

  it('closes the run and hands the task back, because nothing else would', async () => {
    // ⛔ The gap this fills. An ordinary run stays open until `task_complete`, and a conversation is
    // told never to send one — so without this the run stays open and the task stays `running`
    // forever, with the operator watching a finished reply and no buttons under it.
    const { task, runId, session } = talking()
    await turnend.onStreamResult(session, { isError: false, text: 'Here is what I found.', terminalReason: null })

    const after = tasks.requireRun(runId)
    expect(after.endedAt).not.toBeNull()
    expect(after.outcome).toBe('completed')
    expect(tasks.requireTask(task.id).status).toBe('awaiting_human')
    expect(tasks.requireTask(task.id).holdReason).toBe('your turn')

    // The agent's final answer must be recorded as an agent message with runId — and nothing after
    // it: the "reply to carry on" notice that used to follow every answer said what the buttons
    // under it already say.
    const msgs = tasks.messagesFor(task.id)
    const agentMsg = msgs.find((m) => m.role === 'agent' && m.runId === runId)
    expect(agentMsg).toBeDefined()
    expect(agentMsg?.text).toBe('Here is what I found.')
    expect(msgs.slice(msgs.indexOf(agentMsg!) + 1).filter((m) => m.role === 'system')).toHaveLength(0)
  })

  it('persists intermediate streaming activity on the run', async () => {
    const { task, runId, session } = talking()
    const activity = await import('./activity.js')
    // ⚠️ Newline-terminated: two settled rows, not one streaming line. Fragments without one
    // share a single open row (streamed prose reassembled), which is what the peephole is for.
    activity.noteActivity(task.id, '[Tool: run_command git status]\n', runId)
    activity.noteActivity(task.id, 'Reading configuration files...\n', runId)

    await turnend.onStreamResult(session, { isError: false, text: 'Done checking.', terminalReason: null })

    const after = tasks.requireRun(runId)
    expect(after.activity).toBeDefined()
    expect(after.activity?.length).toBe(2)
    expect(after.activity?.[0]?.text).toBe('[Tool: run_command git status]')
    expect(after.activity?.[1]?.text).toBe('Reading configuration files...')
  })

  it('keeps the session alive, which is what makes the next reply warm', async () => {
    const { session } = talking()
    await turnend.onStreamResult(session, { isError: false, text: 'Done for now.', terminalReason: null })
    const row = db.db().prepare('select state from sessions where id = ?').get(session.id) as {
      state: string
    }
    expect(row.state).toBe('live')
  })

  it('leaves an ordinary task’s run open, exactly as it was', async () => {
    // ⛔ The blast radius. Every task in the fleet goes through this function on every clean turn,
    // and closing their runs here would end every run at its first reply.
    const { task, runId, session } = talking()
    // ⚠️ Written in SQL because `kind` is set at filing and there is no updater for it — nothing in
    // the app turns one kind of task into another, and this fixture is not asking for one.
    db.db().prepare("update tasks set kind = 'work' where id = ?").run(task.id)
    await turnend.onStreamResult(session, { isError: false, text: 'Still going.', terminalReason: null })
    expect(tasks.requireRun(runId).endedAt).toBeNull()
    expect(tasks.requireTask(task.id).status).toBe('running')
  })

  it('does not end the turn once Commit has asked for a landing', async () => {
    // ⛔ A conversation being asked to commit is under the ordinary contract again: it has been told
    // to call `task_complete`, and ending its turn underneath it would close the run it needs.
    const { task, runId, session } = talking()
    tasks.updateTask(task.id, { finishPolicy: 'commit-and-merge' })
    await turnend.onStreamResult(session, { isError: false, text: 'Committing now.', terminalReason: null })
    expect(tasks.requireRun(runId).endedAt).toBeNull()
  })
})

describe('what the Commit button does', () => {
  it('refuses without a git project, and says so rather than pretending', async () => {
    const task = tasks.createTask({ title: 'Nowhere to commit', kind: 'conversation', status: 'ready' })
    await expect(resolutions.commitConversation(task.id, 'commit-only')).resolves.toEqual({
      ok: false,
      reason: 'not a git project'
    })
  })

  // ⛔ The seam between the Commit ▼ and `land_work`: the menu offers `commit-and-verify`, and the
  // tool's schema accepts only the three rungs that land. Naming the tool with that rung was an
  // instruction the agent could not follow.
  it('names `land_work` only for a rung that lands, and only to an agent that has the tool', () => {
    const base = { branch: 'warmstart/t9.2-chat', checks: ['npm test'] }
    const verify = resolutions.commitConversationInstruction({ ...base, policy: 'commit-and-verify', canLand: true })
    expect(verify).not.toContain('land_work')
    expect(verify).toContain('`npm test`')
    expect(verify).toContain('nothing is to be merged or pushed')
    const only = resolutions.commitConversationInstruction({ ...base, checks: [], policy: 'commit-only', canLand: true })
    expect(only).not.toContain('land_work')
    const merge = resolutions.commitConversationInstruction({ ...base, policy: 'commit-and-merge', canLand: true })
    expect(merge).toContain('`land_work` with `rung: "commit-and-merge"`')
    expect(merge).toContain('warmstart/t9.2-chat')
    const noTool = resolutions.commitConversationInstruction({ ...base, policy: 'commit-and-merge', canLand: false })
    expect(noTool).not.toContain('land_work')
    expect(noTool).toContain('**Land**')
    // ⛔ Every variant keeps the conversation open.
    for (const said of [verify, only, merge, noTool]) expect(said).toContain('do not call `task_complete`')
  })

  it('reports no workspace rather than an empty diff when it has nowhere to look', async () => {
    // ⚠️ The distinction the card is built on: *I could not look* is not *there is nothing there*.
    const task = tasks.createTask({ title: 'No workspace', kind: 'conversation', status: 'ready' })
    const answer = await resolutions.pendingWorkFor(task.id)
    expect(answer.supported).toBe(false)
    expect(answer.hasDiff).toBe(false)
    expect(answer.reason).toContain('no git project')
  })
})

/**
 * The workspace a conversation left behind, and the button that was not drawn over it.
 *
 * ⛔ **t280, read off the live database.** The conversation came to rest with its session `closed`,
 * so its workspace claim had been released — while ws2 still stood on
 * `warmstart/t280-…` holding eight uncommitted files. `pendingWorkFor` looked only at the
 * claims, answered *"this task is not holding a workspace"*, and the card hid every settle-it control
 * on that answer. The hold reason on the same screen read *"use Finish, Stop or Commit below"*, and
 * there was no Commit below.
 *
 * ⚠️ Real git in a temporary repository, for the reason `worktrees.test.ts` gives: the whole
 * question is what a worktree has checked out, and a stubbed git would pass against the bug.
 */
describe('a conversation whose workspace went back to the pool', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  let repoSeq = 0

  /** A one-slot pool with the task's branch checked out in it, and nothing claiming it. */
  const abandonedOn = async (
    name: string,
    fill: (workspace: string) => void
  ): Promise<{ taskId: string; branch: string; workspace: string }> => {
    repoSeq += 1
    const root = join(dir, `convo-repo${repoSeq}`)
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    git(root, 'init', '--initial-branch=main')
    git(root, 'config', 'user.name', 'agentyard test')
    git(root, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(
      join(root, '.warmstart', 'project.json'),
      JSON.stringify({
        schema_version: 1,
        name: `convo-repo${repoSeq}`,
        vcs: 'git',
        check: [],
        workspaces: { poolSize: 1 },
        landing: { strategy: 'auto-land', target: 'main' }
      })
    )
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'initial')

    const project = projects.addProject({ root })
    const [member] = await worktrees.ensurePool(project)
    const workspace = member as string
    const task = tasks.createTask({
      title: name,
      kind: 'conversation',
      status: 'ready',
      projectId: project.id
    })
    const branch = `warmstart/t${task.seq}-${name}`
    // ⛔ The branch is on the worktree and on the task row, and **nothing holds a claim** — which
    // is exactly the state a conversation rests in once its session has ended.
    git(workspace, 'switch', '-c', branch)
    fill(workspace)
    tasks.setStatus(task.id, 'awaiting_human', { branch })
    return { taskId: task.id, branch, workspace }
  }

  it('finds the uncommitted work in the workspace that still has its branch', async () => {
    const { taskId, branch } = await abandonedOn('left-behind', (workspace) => {
      writeFileSync(join(workspace, 'edited.txt'), 'not committed\n')
    })

    const answer = await resolutions.pendingWorkFor(taskId)
    expect(answer.supported).toBe(true)
    expect(answer.hasDiff).toBe(true)
    expect(answer.branch).toBe(branch)
    expect(answer.untrackedFiles).toBe(1)
    // ⚠️ Said out loud, because the card's wording depends on it: the files are real and the
    // tree they are sitting in belongs to nobody.
    expect(answer.unclaimed).toBe(true)
  })

  it('reports a committed branch as clean work with somewhere to go', async () => {
    // ⛔ The state that draws the Land button: nothing to ask an agent for, and commits that have
    // not reached the trunk. Before this, the card offered nothing at all here.
    const { taskId } = await abandonedOn('committed-not-landed', (workspace) => {
      writeFileSync(join(workspace, 'done.txt'), 'committed\n')
      git(workspace, 'add', '-A')
      git(workspace, 'commit', '-m', 'the work')
    })

    const answer = await resolutions.pendingWorkFor(taskId)
    expect(answer.supported).toBe(true)
    expect(answer.hasDiff).toBe(false)
    expect(answer.unlandedCommits).toBe(1)
  })

  it('still says it could not look when no workspace has the branch', async () => {
    const { taskId, workspace } = await abandonedOn('parked-off', () => {})
    git(workspace, 'switch', '--detach', 'main')

    const answer = await resolutions.pendingWorkFor(taskId)
    expect(answer.supported).toBe(false)
    expect(answer.reason).toContain('no workspace has')
    // ⚠️ And the branch is still named, so the card can say which one it went looking for.
    expect(answer.branch).toContain('parked-off')
  })
})

/** Landing a conversation from the thread — the half of settling it that costs no turn. */
describe('what the Land button does', () => {
  it('refuses a rung that would land nothing, rather than appearing to land it', async () => {
    // ⛔ `commit-only` and `commit-and-verify` leave the branch where it is. Accepting one here
    // would write a finish policy, land nothing, and report success for a branch that never moved.
    const task = tasks.createTask({ title: 'Nothing to land', kind: 'conversation', status: 'ready' })
    const answer = await resolutions.landConversation(task.id, 'commit-only')
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('does not land')
    // ⚠️ And the policy is untouched: a refusal must not leave the task half-converted out of
    // its conversation contract.
    expect(tasks.requireTask(task.id).finishPolicy).toBe('inherit')
  })

  it('will not land a turn that is still running', async () => {
    const task = tasks.createTask({ title: 'Mid-turn', kind: 'conversation', status: 'ready' })
    tasks.setStatus(task.id, 'running')
    const answer = await resolutions.landConversation(task.id, 'commit-and-merge')
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('already running')
  })
})
