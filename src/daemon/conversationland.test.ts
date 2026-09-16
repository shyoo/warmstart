import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'
import { isOpenConversation } from '@shared/tasks.js'

/**
 * Landing a conversation's work **without ending the conversation** — twice over.
 *
 * ⛔ **Real git, in a real repository, because the claim is about what is on a branch.** The thing
 * being pinned is that a conversation can land, keep talking, and land again — which is exactly the
 * shape a stubbed git cannot tell apart from landing once and doing nothing the second time. Both
 * landings have to leave a *distinct* commit on `main`, and the branch has to be a different name
 * each time, or the second landing is landing the first one's work again.
 *
 * ⛔ And the conversation has to be **unchanged** on the far side of it: `isOpenConversation` still
 * true, the finish policy still `inherit`, the status where it was. That is the whole point of the
 * feature and it is an absence, which is the kind of behaviour a refactor removes without noticing.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let worktrees: typeof import('./worktrees.js')
let conversationland: typeof import('./conversationland.js')
let finish: typeof import('./finish.js')
let taskcommits: typeof import('./taskcommits.js')
let api: typeof import('./api/agent.js')
let workers: typeof import('./workers.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let seq = 0

interface Fixture {
  project: Project
  taskId: string
  workspace: string
  root: string
}

/**
 * A repository on `main`, a one-slot pool, and a conversation sitting in that slot on its own
 * branch — the state a conversation is in between turns.
 *
 * ⚠️ The project declares a check that passes everywhere. `decideFinish` refuses to land a project
 * with no `check` commands, which is condition 4 of the bar and is not what these tests are about.
 */
async function seedConversation(title = 'talk it through'): Promise<Fixture> {
  seq += 1
  const root = join(dir, `convo${seq}`)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name: `convo${seq}`,
      vcs: 'git',
      workspaces: { poolSize: 1 },
      check: ['node --version'],
      landing: { target: 'main', finish: 'commit-and-merge' }
    })
  )
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')

  const project = projects.addProject({ root })
  const [member] = await worktrees.ensurePool(project)
  const workspace = member as string

  const task = tasks.createTask({
    title,
    kind: 'conversation',
    status: 'ready',
    projectId: project.id
  })
  const branch = worktrees.branchNameFor(task.seq, task.title)
  git(workspace, 'switch', '-c', branch)
  tasks.setStatus(task.id, 'awaiting_human', { branch })
  return { project, taskId: task.id, workspace, root }
}

/** Commit one file on whatever branch the conversation's workspace is currently on. */
function commitInWorkspace(workspace: string, name: string): void {
  writeFileSync(join(workspace, name), `${name}\n`)
  git(workspace, 'add', '-A')
  git(workspace, 'commit', '-m', `the agent wrote ${name}`)
}

beforeAll(async () => {
  // ⚠️ `realpath`, for the reason `mergebranch.test.ts` gives: git prints the long form of a
  // Windows path and the workspace pool stores what it was handed.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentyard-convoland-')))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  worktrees = await import('./worktrees.js')
  conversationland = await import('./conversationland.js')
  finish = await import('./finish.js')
  taskcommits = await import('./taskcommits.js')
  api = await import('./api/agent.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'convoland.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows holds git pack files briefly; a leftover temp dir is harmless.
  }
})

describe('a conversation that lands twice', () => {
  it('puts two commits on the target, on two numbered branches, and is still a conversation', async () => {
    const { project, taskId, workspace, root } = await seedConversation('land me twice')
    const first = tasks.requireTask(taskId)
    expect(first.branchUnit).toBe(1)
    expect(first.branch).toBe(`warmstart/t${first.seq}-land-me-twice`)

    commitInWorkspace(workspace, 'one.txt')
    const landed1 = await conversationland.landConversationWork(taskId)
    expect(landed1.reason ?? '').toBe('')
    expect(landed1.ok).toBe(true)
    expect(landed1.target).toBe('main')
    expect(landed1.nextBranch).toBe(`warmstart/t${first.seq}.2-land-me-twice`)

    // ⛔ The branch actually moved under the agent: the workspace it is still sitting in is on the
    // new name. Recording it on the task without switching the tree would make every later `git`
    // call in that workspace commit to a branch the task no longer claims.
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(landed1.nextBranch)

    // ⭐ And the conversation is untouched: this is the whole feature.
    const between = tasks.requireTask(taskId)
    expect(isOpenConversation(between)).toBe(true)
    expect(between.finishPolicy).toBe('inherit')
    expect(between.status).toBe('awaiting_human')
    expect(between.branch).toBe(landed1.nextBranch)
    expect(between.branchUnit).toBe(2)

    // The second stretch of work, cut from the target the first landing moved.
    commitInWorkspace(workspace, 'two.txt')
    const landed2 = await conversationland.landConversationWork(taskId)
    expect(landed2.reason ?? '').toBe('')
    expect(landed2.ok).toBe(true)
    expect(landed2.nextBranch).toBe(`warmstart/t${first.seq}.3-land-me-twice`)
    expect(landed2.landedSha).not.toBe(landed1.landedSha)

    // ⛔ Two distinct commits on `main`, not one landed twice.
    const subjects = git(root, 'log', '--format=%s', 'main').split(/\r?\n/)
    expect(subjects).toContain('the agent wrote one.txt')
    expect(subjects).toContain('the agent wrote two.txt')

    // ⛔ Both are recorded against this task. `task_commits` is `insert or ignore` keyed on
    // (task, sha), so a task that lands twice *adds* a row rather than replacing one.
    expect(taskcommits.taskCommitShas(taskId)).toHaveLength(2)

    const after = tasks.requireTask(taskId)
    expect(isOpenConversation(after)).toBe(true)
    expect(after.status).toBe('awaiting_human')
    expect(after.branchUnit).toBe(3)
    expect(landingTargetSha(project)).toBe(landed2.landedSha)
  })

  it('writes one thread line per landing, in the shape the salvage parser reads', async () => {
    // ⛔ `salvageLandedCommits` matches system messages with `text like 'Landed as %'`, so the
    // headline shape is load-bearing and everything else goes in `detail`. A landing that
    // announced itself twice would be recovered twice.
    const { taskId, workspace } = await seedConversation('say it once')
    commitInWorkspace(workspace, 'said.txt')
    const landed = await conversationland.landConversationWork(taskId)
    expect(landed.ok).toBe(true)

    const headlines = tasks
      .messagesFor(taskId)
      .filter((m) => m.role === 'system' && m.text.startsWith('Landed as '))
    expect(headlines).toHaveLength(1)
    expect(headlines[0]?.text).toContain(`onto \`main\``)
    expect(headlines[0]?.text).not.toContain('continues on')
    expect(headlines[0]?.detail).toContain('continues on')
    // ⚠️ The clauses `landedMessage` composes are kept, off the line.
    expect(headlines[0]?.detail).toContain('Verified first: 1 project check passed')
  })
})

describe('a conversation whose tree was parked between turns', () => {
  it('⛔ lands from a borrowed workspace and gives it back, rather than answering "not holding a workspace"', async () => {
    // t481, 2026-09-16: a codex conversation's process exited at the end of its turn, the pool
    // member was parked onto `origin/main`, and Land answered "no workspace has the branch checked
    // out" about a branch carrying one clean commit.
    const { project, taskId, workspace, root } = await seedConversation('parked between turns')
    commitInWorkspace(workspace, 'parked.txt')
    await worktrees.parkWorkspace(project, workspace)
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')

    const landed = await conversationland.landConversationWork(taskId)
    expect(landed.reason ?? '').toBe('')
    expect(landed.ok).toBe(true)
    expect(git(root, 'log', '--format=%s', 'main')).toContain('the agent wrote parked.txt')

    // The borrowed slot goes back parked and unclaimed, and the next branch exists for the next turn.
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(worktrees.workspaceHeldBy(project, `land:${taskId}`)).toBeNull()
    const after = tasks.requireTask(taskId)
    expect(after.branch).toBe(landed.nextBranch)
    expect(await worktrees.branchExists(project, after.branch as string)).toBe(true)
    expect(isOpenConversation(after)).toBe(true)
  })
})

describe('a refusal moves nothing', () => {
  it('refuses a dirty tree, leaves the branch, the target and the task exactly as they were', async () => {
    const { taskId, workspace, root } = await seedConversation('half finished')
    commitInWorkspace(workspace, 'committed.txt')
    writeFileSync(join(workspace, 'loose.txt'), 'not committed\n')

    const before = tasks.requireTask(taskId)
    const trunkBefore = git(root, 'rev-parse', 'main')

    const refused = await conversationland.landConversationWork(taskId)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toMatch(/uncommitted/i)
    expect(refused.landedSha).toBeUndefined()

    // ⛔ Nothing moved: not the trunk, not the branch, not the counter, not the task.
    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(before.branch)
    const after = tasks.requireTask(taskId)
    expect(after.branch).toBe(before.branch)
    expect(after.branchUnit).toBe(1)
    expect(after.status).toBe('awaiting_human')
    expect(isOpenConversation(after)).toBe(true)
    expect(taskcommits.taskCommitShas(taskId)).toEqual([])
  })

  it('refuses a branch with nothing on it rather than reporting a landing', async () => {
    const { taskId, root } = await seedConversation('nothing to say')
    const trunkBefore = git(root, 'rev-parse', 'main')
    const refused = await conversationland.landConversationWork(taskId)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toMatch(/no commits/i)
    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
    expect(tasks.requireTask(taskId).branchUnit).toBe(1)
  })

  it('⛔ a refusal inside the landing itself neither parks the task nor writes to the thread', async () => {
    // ⛔ **The `quiet` half, and it is what the rest of the refusals cannot reach.** A dirty tree is
    // turned away by `decideFinish` before `landTask` runs at all; a **rescue tip** is refused by
    // `canLand` *inside* it, on the path that ordinarily rests the task at `awaiting_human` and
    // posts *"Not landed automatically: …"*. For a conversation both would be wrong: the person is
    // still typing and the run may still be blocked on the tool call that asked for this.
    const { taskId, workspace, root } = await seedConversation('rescued not finished')
    commitInWorkspace(workspace, 'real.txt')
    writeFileSync(join(workspace, 'interrupted.txt'), 'left loose by a preemption\n')
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-m', `wip: rescued\n\n${worktrees.RESCUE_TRAILER}: 1`)

    const messagesBefore = tasks.messagesFor(taskId).length
    const trunkBefore = git(root, 'rev-parse', 'main')

    const refused = await conversationland.landConversationWork(taskId)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toMatch(/rescue/i)

    const after = tasks.requireTask(taskId)
    expect(after.status).toBe('awaiting_human')
    // ⚠️ `awaiting_human` is where this fixture already was, so the hold reason is the tell: a
    // landing that rested the task would have written one.
    expect(after.holdReason).toBeNull()
    expect(isOpenConversation(after)).toBe(true)
    expect(tasks.messagesFor(taskId)).toHaveLength(messagesBefore)
    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
  })

  it('⛔ refuses a rung that lands nothing by falling back, never by landing under it', async () => {
    // ⚠️ `commit-only` is not a landing rung. Rather than refuse an explicit ask outright, the
    // fallback is the fleet's own landing rung — what is never allowed is treating `commit-only`
    // as though it merged.
    const { taskId, workspace, root } = await seedConversation('rung fallback')
    commitInWorkspace(workspace, 'rung.txt')
    const landed = await conversationland.landConversationWork(taskId, { rung: 'commit-only' })
    expect(landed.ok).toBe(true)
    expect(git(root, 'log', '--format=%s', 'main')).toContain('the agent wrote rung.txt')
  })
})

describe('the agent.land RPC', () => {
  it('refuses a work task, because landing a work task is what finishing it does', async () => {
    const { project, workspace } = await seedConversation('not this one')
    const work = tasks.createTask({ title: 'ordinary work', projectId: project.id })
    const branch = worktrees.branchNameFor(work.seq, work.title)
    git(workspace, 'switch', '-c', branch)
    tasks.setStatus(work.id, 'awaiting_human', { branch })
    commitInWorkspace(workspace, 'work.txt')

    // ⛔ Through the RPC the tool actually calls, resolved session → open run → task, because that
    // resolution is the part that stops an agent naming a branch it was never given.
    const worker = workers.createWorker({ adapterId: 'claude-code', label: `w${work.seq}`, enabled: true })
    tasks.startRun({
      taskId: work.id,
      workerId: worker.id,
      sessionId: `s-${work.seq}`,
      projectId: project.id,
      quotaUnverified: false,
      costModelId: null
    })

    const refused = await api.apiAgent({} as never)['agent.land']({ sessionId: `s-${work.seq}` })
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('not a conversation')
    expect(refused.reason).toContain('task_complete')

    // ⚠️ And nothing moved: the run is still open and the branch still carries its commit.
    expect(tasks.runForSession(`s-${work.seq}`)?.endedAt ?? null).toBeNull()
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  })

  it('refuses a session that is not working on a task, rather than guessing which one', async () => {
    const agent = api.apiAgent({} as never)
    await expect(agent['agent.land']({ sessionId: 'no-such-session' })).resolves.toEqual({
      ok: false,
      reason: 'this session is not working on a task'
    })
  })
})

/**
 * The reset a build that used to write rungs onto conversations left behind.
 *
 * ⛔ **A deliberate decision, not a tidy-up.** Before this change the Commit and Land buttons wrote
 * the chosen rung onto `finish_policy`, which is precisely what took the task out of
 * `isOpenConversation`. Landing writes no rung now, so a row still carrying one is a record of a
 * mechanism that no longer exists — and left alone it would hold a conversation the operator is
 * still talking in under the one-shot **work** contract, told to commit and report complete on every
 * turn. So the migration puts every `conversation` back on `inherit`.
 *
 * ⚠️ Run by rewinding `user_version` and reopening, which is the shipped SQL rather than a copy of
 * it — and which re-runs every migration after it, so this doubles as the replay-safety check.
 */
describe('migration 64, on a conversation an old build left carrying a rung', () => {
  it('puts it back on inherit, so the thread is an open conversation again', async () => {
    const { taskId } = await seedConversation('committed by the old build')
    db.db().prepare("update tasks set finish_policy = 'commit-and-merge' where id = ?").run(taskId)
    expect(isOpenConversation(tasks.requireTask(taskId))).toBe(false)

    const dbPath = join(dir, 'convoland.db')
    db.db().exec(`pragma user_version = ${db.versionBefore("where kind = 'conversation'")}`)
    db.closeDb()
    db.openDb(dbPath)

    const after = tasks.requireTask(taskId)
    expect(after.finishPolicy).toBe('inherit')
    expect(isOpenConversation(after)).toBe(true)
    // ⚠️ And it is scoped: nothing else has ever had its rung written by a button.
    const work = tasks.createTask({ title: 'ordinary, set by hand' })
    tasks.updateTask(work.id, { finishPolicy: 'commit-and-push' })
    db.db().exec(`pragma user_version = ${db.versionBefore("where kind = 'conversation'")}`)
    db.closeDb()
    db.openDb(dbPath)
    expect(tasks.requireTask(work.id).finishPolicy).toBe('commit-and-push')
  })
})

/**
 * The trunk tripwire, and the movement a conversation's own landing explains.
 *
 * ⛔ **The same shape as the sibling subtraction, one relationship over.** *Empty branch + target
 * moved* is the signature of an agent that worked in the trunk. A conversation that lands and then
 * answers a question produces exactly that pairing — and it moved the target itself, on purpose,
 * minutes earlier. Without the subtraction every conversation would be handed to a person for
 * review the first time it said something after landing.
 */
describe('the tripwire and a task’s own landings', () => {
  const state = {
    path: 'C:\\ws',
    branch: 'warmstart/t9.2-a-chat',
    dirtyFiles: [],
    untrackedFiles: [],
    unlandedCommits: 0,
    targetBehind: 0,
    landedRef: 'main'
  } as never

  const trunk = {
    before: 'aaaaaaaa',
    after: 'bbbbbbbb',
    commits: ['bbbbbbbb landed by this very conversation']
  }

  const task = { seq: 9, finishAskedAt: null, mandate: { allowed: ['land'] }, finishPolicy: 'inherit' } as never

  it('fires when the movement is explained by nobody', () => {
    expect(
      finish.decideFinish({ task, project: null, state, hasChecks: true, trunk }).kind
    ).toBe('trunk-moved')
  })

  it('⭐ stands down when this task’s own recorded landing accounts for it', () => {
    const decision = finish.decideFinish({
      task,
      project: null,
      state,
      hasChecks: true,
      trunk,
      ownLanded: ['bbbbbbbbcccc']
    })
    expect(decision.kind).not.toBe('trunk-moved')
  })

  it('⛔ still fires on the commits its own landings do not account for', () => {
    const decision = finish.decideFinish({
      task,
      project: null,
      state,
      hasChecks: true,
      trunk: { ...trunk, commits: [...trunk.commits, 'dddddddd somebody worked in the trunk'] },
      ownLanded: ['bbbbbbbbcccc']
    })
    expect(decision.kind).toBe('trunk-moved')
    // ⚠️ And the report names only the unexplained one, so a person is not asked about a commit
    // the tool put there.
    expect(decision.kind === 'trunk-moved' && decision.commits).toEqual([
      'dddddddd somebody worked in the trunk'
    ])
  })
})

/** Where the project's landing target stands, read in the trunk. */
function landingTargetSha(project: Project): string {
  return git(project.root, 'rev-parse', 'main')
}
