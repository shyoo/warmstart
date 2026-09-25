import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '@shared/tasks.js'

/**
 * Delegation from any task (t704), driven against a temp database and, for the merge check, a real
 * throwaway repository. No agent, no prompt cache, no UI.
 *
 * ⛔ The rules worth the most here are the silent ones: a `/delegate` that skips the card for more
 * than the one delegation it asked for, a caller woken twice by two pieces settling together, and a
 * landing that retires the branch running pieces were cut from.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let split: typeof import('./split.js')
let delegation: typeof import('./delegation.js')
let projects: typeof import('./projects.js')
let prompt: typeof import('./prompt.js')

const AGENT: Principal = { kind: 'agent', workerId: 'w-test', sessionId: 's-test', runId: 'r-test' }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-delegation-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  split = await import('./split.js')
  delegation = await import('./delegation.js')
  projects = await import('./projects.js')
  prompt = await import('./prompt.js')
  db.openDb(join(dir, 'delegation.db'))
})

beforeEach(() => {
  db.db().exec('delete from delegations')
  db.db().exec('delete from task_deps')
  db.db().exec('delete from task_messages')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

function caller(kind: 'work' | 'conversation', branch = 'warmstart/t1-caller'): ReturnType<typeof tasks.createTask> {
  const task = tasks.createTask({ title: `A ${kind} that delegates`, kind, status: 'ready' })
  db.db().prepare("update tasks set branch = ?, status = 'running' where id = ?").run(branch, task.id)
  return tasks.requireTask(task.id)
}

const piece = (title: string, extra: { modelClass?: 'low' | 'med' | 'high' } = {}) => ({ title, dependsOn: [], ...extra })

describe('who may delegate', () => {
  it('accepts one piece from a work task or a conversation with delegation on', () => {
    expect(split.validateSplit(caller('work'), [piece('do the migration')]).ok).toBe(true)
    expect(split.validateSplit(caller('conversation'), [piece('do the migration')]).ok).toBe(true)
  })

  it('refuses a piece of a plan, whose branch already merges into a plan branch', () => {
    const plan = tasks.createTask({ title: 'Plan', kind: 'plan' })
    db.db().prepare('update tasks set branch = ? where id = ?').run('warmstart/t9-plan', plan.id)
    const [child] = split.applySplit(plan.id, [piece('a'), piece('b')], AGENT).ok
      ? split.childrenOf(plan.id)
      : []
    const result = split.validateSplit(child!, [piece('deeper')])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/cannot delegate further/)
  })

  it('switching delegation off refuses the split, and tells the agent on its next turn', () => {
    const task = caller('conversation')
    delegation.setDelegation(task.id, false)
    const off = tasks.requireTask(task.id)
    expect(off.mandate.allowed).not.toContain('spawn_tasks')
    const result = split.validateSplit(off, [piece('x')])
    expect(result.ok === false && result.reason).toMatch(/delegation is off/)
    const note = tasks.messagesFor(task.id).at(-1)
    expect(note?.event).toBe('delegation.toggled')
    expect(note?.detail).toContain('do not call `task_split`')
  })

  it('⛔ never switches on past a parent that cannot delegate', () => {
    const parent = tasks.createTask({ title: 'Parent' })
    const child = tasks.createTask({ title: 'Child', parentTaskId: parent.id, createdBy: AGENT })
    delegation.setDelegation(child.id, false)
    delegation.setDelegation(parent.id, false)
    expect(() => delegation.setDelegation(child.id, true)).toThrow(/cannot delegate/)
    delegation.setDelegation(parent.id, true)
    expect(delegation.setDelegation(child.id, true).mandate.allowed).toContain('spawn_tasks')
  })
})

describe('filing a delegation', () => {
  it('files pieces that commit and verify on their own branch, cut from the caller’s', () => {
    const task = caller('conversation')
    const result = split.applySplit(task.id, [piece('one', { modelClass: 'low' }), piece('two')], AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const child of result.children) {
      expect(child.finishPolicy).toBe('commit-and-verify')
      expect(child.landingTarget).toBe('warmstart/t1-caller')
      expect(child.parentTaskId).toBe(task.id)
    }
    expect(result.children[0]!.constraints.modelClass).toBe('low')
    expect(result.children[1]!.constraints.modelClass).toBeUndefined()
    expect(delegation.delegationsFor(task.id)).toHaveLength(1)
  })

  it('⛔ leaves a conversation talking — no edges, no block', () => {
    const task = caller('conversation')
    split.applySplit(task.id, [piece('one')], AGENT)
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('running')
    expect(after.dependsOn).toHaveLength(0)
    expect(tasks.messagesFor(task.id).at(-1)?.event).toBe('delegation.filed')
  })

  it('blocks a work task on its pieces, the way a planner waits', () => {
    const task = caller('work')
    const result = split.applySplit(task.id, [piece('one'), piece('two')], AGENT)
    expect(result.ok).toBe(true)
    const after = tasks.requireTask(task.id)
    expect(after.status).toBe('blocked')
    expect(after.holdReason).toMatch(/2 delegated pieces/)
    expect(after.dependsOn).toHaveLength(2)
  })

  it('shows every piece’s whole instruction on the card', () => {
    const task = caller('work')
    const card = split.splitApprovalFor(task, [piece('Line one\nLine two of the instruction')])
    expect(card.header).toBe(`Delegate from t${task.seq}?`)
    expect(card.question).toContain('Line two of the instruction')
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'refuse'])
  })
})

describe('/delegate skips the card for the delegation it asked for, and no other', () => {
  it('is pending after the command and answered by one requested delegation', () => {
    const task = caller('conversation')
    tasks.addMessage(task.id, 'human', 'the migration', null, [], { event: 'command.delegate' })
    expect(delegation.pendingDelegateRequest(task.id)).toBe(true)
    delegation.recordDelegation(task.id, [], true)
    expect(delegation.pendingDelegateRequest(task.id)).toBe(false)
  })

  it('is not pending for an ordinary message, or after one', () => {
    const task = caller('conversation')
    tasks.addMessage(task.id, 'human', 'just chatting')
    expect(delegation.pendingDelegateRequest(task.id)).toBe(false)
    tasks.addMessage(task.id, 'human', 'x', null, [], { event: 'command.delegate' })
    tasks.addMessage(task.id, 'human', 'actually never mind')
    expect(delegation.pendingDelegateRequest(task.id)).toBe(false)
  })
})

describe('reporting back', () => {
  it('⛔ wakes a resting conversation once, when the last piece settles', () => {
    const task = caller('conversation')
    const result = split.applySplit(task.id, [piece('one'), piece('two')], AGENT)
    if (!result.ok) throw new Error(result.reason)
    tasks.setStatus(task.id, 'awaiting_human')
    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    const [a, b] = result.children

    tasks.setStatus(a!.id, 'completed', { branch: 'warmstart/t2-one' })
    delegation.reportDelegationIfSettled(a!.id, wake)
    expect(wake.requeue).not.toHaveBeenCalled()

    tasks.setStatus(b!.id, 'failed', { holdReason: 'the checks failed' })
    delegation.reportDelegationIfSettled(b!.id, wake)
    delegation.reportDelegationIfSettled(a!.id, wake)
    expect(wake.requeue).toHaveBeenCalledTimes(1)

    const report = tasks.messagesFor(task.id).filter((m) => m.event === 'delegation.settled')
    expect(report).toHaveLength(1)
    expect(report[0]!.detail).toContain('`warmstart/t2-one`')
    expect(report[0]!.detail).toContain('the checks failed')
    expect(report[0]!.detail).toContain('git merge')
    expect(report[0]!.detail).toContain('set_aside')
  })

  it('delivers into a conversation that is mid-turn rather than requeuing it', () => {
    const task = caller('conversation')
    const result = split.applySplit(task.id, [piece('one')], AGENT)
    if (!result.ok) throw new Error(result.reason)
    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    tasks.setStatus(result.children[0]!.id, 'completed')
    delegation.reportDelegationIfSettled(result.children[0]!.id, wake)
    expect(wake.deliver).toHaveBeenCalledTimes(1)
    expect(wake.requeue).not.toHaveBeenCalled()
  })

  it('leaves a stopped conversation stopped, with the report waiting as a note', () => {
    const task = caller('conversation')
    const result = split.applySplit(task.id, [piece('one')], AGENT)
    if (!result.ok) throw new Error(result.reason)
    tasks.setStatus(task.id, 'paused_user')
    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    tasks.setStatus(result.children[0]!.id, 'cancelled')
    delegation.reportDelegationIfSettled(result.children[0]!.id, wake)
    expect(wake.deliver).not.toHaveBeenCalled()
    expect(wake.requeue).not.toHaveBeenCalled()
    expect(tasks.messagesFor(task.id).some((m) => m.event === 'delegation.settled')).toBe(true)
  })

  it('does not wake a work task itself — its settled edges admit it', () => {
    const task = caller('work')
    const result = split.applySplit(task.id, [piece('one')], AGENT)
    if (!result.ok) throw new Error(result.reason)
    const wake = { deliver: vi.fn(() => true), requeue: vi.fn() }
    tasks.setStatus(result.children[0]!.id, 'completed')
    delegation.reportDelegationIfSettled(result.children[0]!.id, wake)
    expect(wake.requeue).not.toHaveBeenCalled()
    expect(tasks.requireTask(task.id).status).toBe('ready')
  })
})

describe('the landing guard', () => {
  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'agentyard-delegation-repo-'))
    git(['init', '-q', '-b', 'main'], root)
    git(['config', 'user.email', 't@example.com'], root)
    git(['config', 'user.name', 'Test'], root)
    writeFileSync(join(root, 'a.txt'), 'base\n')
    git(['add', '-A'], root)
    git(['commit', '-qm', 'base'], root)
    git(['switch', '-qc', 'warmstart/t1-caller'], root)
    return root
  }

  it('refuses while a piece is still running, whoever asks', async () => {
    const task = caller('conversation')
    split.applySplit(task.id, [piece('one')], AGENT)
    const reason = await delegation.delegationLandingBlocker(task.id, null, { checkMerged: false })
    expect(reason).toMatch(/still running/)
  })

  it('⛔ refuses the agent’s landing without a completed piece’s work, unless it is set aside', async () => {
    const root = repo()
    const task = caller('conversation')
    const result = split.applySplit(task.id, [piece('one')], AGENT)
    if (!result.ok) throw new Error(result.reason)
    const child = result.children[0]!
    const branch = `warmstart/t${child.seq}-one`
    git(['switch', '-qc', branch], root)
    writeFileSync(join(root, 'b.txt'), 'piece\n')
    git(['add', '-A'], root)
    git(['commit', '-qm', 'piece'], root)
    git(['switch', '-q', 'warmstart/t1-caller'], root)
    tasks.setStatus(child.id, 'completed', { branch })
    delegation.reportDelegationIfSettled(child.id, { deliver: () => true, requeue: () => undefined })

    const person = await delegation.delegationLandingBlocker(task.id, root, { checkMerged: false })
    expect(person).toBeNull()
    const agent = await delegation.delegationLandingBlocker(task.id, root, { checkMerged: true })
    expect(agent).toContain(branch)
    const setAside = await delegation.delegationLandingBlocker(task.id, root, { checkMerged: true, setAside: [child.seq] })
    expect(setAside).toBeNull()

    git(['merge', '-q', '--no-edit', branch], root)
    expect(await delegation.delegationLandingBlocker(task.id, root, { checkMerged: true })).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('what the agent is told', () => {
  it('wraps a /delegate message in the delegation instruction, per capability', () => {
    const withTools = delegation.delegateCommandPrompt('write the migration', true)
    expect(withTools).toContain('write the migration')
    expect(withTools).toContain('`task_split`')
    expect(withTools).toContain('without a further approval card')
    const without = delegation.delegateCommandPrompt('write the migration', false)
    expect(without).not.toContain('task_split')
    expect(without).toContain('self-contained instruction for each piece in your reply')
    // An empty chip means what was just being discussed.
    expect(delegation.delegateCommandPrompt('  ', true)).toContain('just been discussing')
  })

  function gitProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'agentyard-delegation-project-'))
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
    mkdirSync(join(root, '.warmstart'), { recursive: true })
    writeFileSync(join(root, '.warmstart', 'project.json'), JSON.stringify({ schema_version: 1 }))
    return projects.addProject({ root }).id
  }

  it('names delegation in a conversation’s opening contract only while it is on', () => {
    const projectId = gitProject()
    const task = tasks.createTask({ title: 'Talk about the refactor', kind: 'conversation', projectId, status: 'ready' })
    const on = prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(on).toContain('You may delegate')
    expect(on).toContain('The conversation carries on while they run')
    delegation.setDelegation(task.id, false)
    const off = prompt.promptFor(tasks.requireTask(task.id), 'claude-code', false, { markDelivered: false }).text
    expect(off).not.toContain('You may delegate')
    // ⚠️ And the switch itself reaches the agent, as its own sentence.
    expect(off).toContain('switched delegation off')
  })

  it('sends a /delegate message wrapped, with the person’s words unchanged', () => {
    const projectId = gitProject()
    const task = tasks.createTask({ title: 'Chat', kind: 'conversation', projectId, status: 'ready' })
    tasks.addMessage(task.id, 'human', 'port the parser to Rust', null, [], { event: 'command.delegate' })
    const text = prompt.promptFor(task, 'claude-code', false, { markDelivered: false }).text
    expect(text).toContain('The person used /delegate')
    expect(text).toContain('port the parser to Rust')
    // The stored message is what they typed, and nothing else.
    expect(tasks.messagesFor(task.id).at(-1)?.text).toBe('port the parser to Rust')
  })
})
