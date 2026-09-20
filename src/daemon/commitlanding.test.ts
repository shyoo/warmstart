import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@shared/tasks.js'
import { isOpenConversation } from '@shared/tasks.js'

/**
 * The **Commit** button's other half: the landing the tool owes once the agent's turn ends.
 *
 * ⛔ **t581, and the state it was reported from is worth writing down.** On 2026-09-20 t578 — a
 * `muse-code` conversation, seventeen turns deep — was pressed **Commit** at 15:31:16 on the rung
 * `commit, verify and merge into main`. The instruction it produced ended *"Then say in your reply
 * that the commit is ready to land, and stop — the person will press **Land**. Do not merge or push
 * to the landing target yourself."* At 15:41:40 the agent replied that the commit was ready: one
 * squashed commit, `829b3dc`, both project checks green. **Nothing landed.** Twelve seconds later
 * the operator pressed Commit again and the identical instruction went into the same session.
 *
 * Three separate faults, each of which alone would have left the work on the branch:
 *
 * 1. `muse-code` declares `mcp: false`, so there is no `land_work` for the agent to call — and
 *    nothing else in the tool ever acted on the rung the operator had chosen. The instruction was
 *    the whole plan, and it named a button rather than a mechanism.
 * 2. The workspace held two untracked backup directories — which the operator had *asked* for and
 *    the agent had rightly kept out of the commit — so `pendingWork.hasDiff` stayed true for ever,
 *    the card drew **Commit** and never **Land**, and `decideFinish` refused every landing over
 *    *"2 file(s) are uncommitted"*.
 * 3. Nothing refused the second press, so the only control the card offered spent a second turn
 *    asking for a commit that already existed.
 *
 * ⛔ **Real git, because every claim here is about what is on a branch.** A stubbed git cannot tell
 * "landed" from "said it landed", which is the exact confusion being fixed.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let worktrees: typeof import('./worktrees.js')
let resolutions: typeof import('./resolutions.js')
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
 * A repository on `main`, a one-slot pool, and a conversation resting in that slot on its branch.
 *
 * ⚠️ The project declares a check that passes everywhere: `decideFinish` refuses to land a project
 * with no `check` commands at all, and that gate is not what these tests are about.
 */
async function seedConversation(title: string, adapterId?: string): Promise<Fixture> {
  seq += 1
  const root = join(dir, `chat${seq}`)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify({
      schema_version: 1,
      name: `chat${seq}`,
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

  // ⛔ Pinned to a real worker where the test is about MCP, because `agentCanLand` reads the
  // adapter's declared `capabilities.mcp` off the account — never off a name, per AGENTS.md.
  const workerId = adapterId
    ? workers.createWorker({ adapterId, label: `w${seq}`, enabled: true }).id
    : null
  const task = tasks.createTask({
    title,
    kind: 'conversation',
    status: 'ready',
    projectId: project.id,
    ...(workerId ? { constraints: { workerId, modelPolicy: 'inherit' } } : {})
  })
  const branch = worktrees.branchNameFor(task.seq, task.title)
  git(workspace, 'switch', '-c', branch)
  tasks.setStatus(task.id, 'awaiting_human', { branch })
  return { project, taskId: task.id, workspace, root }
}

/** What the agent does when it is asked to commit. */
function agentCommits(workspace: string, name: string): void {
  writeFileSync(join(workspace, name), `${name}\n`)
  git(workspace, 'add', '-A')
  git(workspace, 'commit', '-m', `the agent wrote ${name}`)
}

/** What the operator asked for and the agent deliberately left out of the commit. */
function backupsTheOperatorAskedFor(workspace: string): void {
  mkdirSync(join(workspace, '1080p_backup_2026-09-20'), { recursive: true })
  writeFileSync(join(workspace, '1080p_backup_2026-09-20', 'shot.bin'), 'binary\n')
  writeFileSync(join(workspace, 'sitting.log'), 'render log\n')
}

const humanMessages = (taskId: string): string[] =>
  tasks.messagesFor(taskId).filter((m) => m.role === 'human').map((m) => m.text)

beforeAll(async () => {
  // ⚠️ `realpath`, for the reason `mergebranch.test.ts` gives: git prints the long form of a
  // Windows path and the workspace pool stores what it was handed.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentyard-commitland-')))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  worktrees = await import('./worktrees.js')
  resolutions = await import('./resolutions.js')
  workers = await import('./workers.js')
  db.openDb(join(dir, 'commitland.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows holds git pack files briefly; a leftover temp dir is harmless.
  }
})

describe('t578: Commit on an adapter with no land_work', () => {
  it('⭐ records the rung, and lands it itself when the turn ends', async () => {
    const { taskId, workspace, root } = await seedConversation('re-render the shots', 'muse-code')
    agentCommits(workspace, 'draft.txt')
    writeFileSync(join(workspace, 'prompts.txt'), 'still being written\n')
    const trunkBefore = git(root, 'rev-parse', 'main')

    const pressed = await resolutions.commitConversation(taskId, 'commit-and-merge')
    expect(pressed).toEqual({ ok: true })

    // ⛔ The instruction is the MCP-less one — muse-code declares `mcp: false` — and it no longer
    // sends the agent to describe a button to the operator.
    const asked = humanMessages(taskId).at(-1) ?? ''
    expect(asked).not.toContain('land_work')
    expect(asked).toContain('Warmstart lands it from there')
    // ⭐ And the promise is on the row *before* the turn, so a daemon restart cannot lose it.
    expect(tasks.requireTask(taskId).landAfterTurn).toBe('commit-and-merge')

    // The turn: the agent commits what it was asked for and stops, exactly as instructed.
    agentCommits(workspace, 'prompts.txt')

    await resolutions.landAfterCommitTurn(taskId)

    // ⭐ The thing that did not happen on t578.
    expect(git(root, 'rev-parse', 'main')).not.toBe(trunkBefore)
    expect(git(root, 'log', '--format=%s', 'main')).toContain('the agent wrote prompts.txt')
    const landed = tasks.messagesFor(taskId).filter((m) => m.text.startsWith('Landed as '))
    expect(landed).toHaveLength(1)

    // ⛔ The promise is spent, the conversation is untouched, and it is on the next branch.
    const after = tasks.requireTask(taskId)
    expect(after.landAfterTurn).toBeNull()
    expect(isOpenConversation(after)).toBe(true)
    expect(after.branchUnit).toBe(2)
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(after.branch)
  })

  it('⭐ lands over the untracked backups the operator asked for, and leaves them there', async () => {
    // ⛔ The exact shape of t578's workspace: one squashed commit and two untracked entries the
    // agent was right not to commit. Before t581 this state could not land at all.
    const { taskId, workspace, root } = await seedConversation('keep the old takes', 'muse-code')
    agentCommits(workspace, 'shots.txt')
    backupsTheOperatorAskedFor(workspace)
    tasks.setLandAfterTurn(taskId, 'commit-and-merge')

    await resolutions.landAfterCommitTurn(taskId)

    expect(git(root, 'log', '--format=%s', 'main')).toContain('the agent wrote shots.txt')
    expect(git(workspace, 'status', '--porcelain').split(/\r?\n/).sort()).toEqual([
      '?? 1080p_backup_2026-09-20/',
      '?? sitting.log'
    ])
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()
  })

  it('⛔ says why, once, when the landing it promised is refused — and does not promise again', async () => {
    const { taskId, workspace, root } = await seedConversation('half an edit', 'muse-code')
    agentCommits(workspace, 'edited.txt')
    // A *tracked* modification: a rebase will not run over it, so this landing must refuse.
    writeFileSync(join(workspace, 'edited.txt'), 'changed again\n')
    tasks.setLandAfterTurn(taskId, 'commit-and-merge')
    const trunkBefore = git(root, 'rev-parse', 'main')

    await resolutions.landAfterCommitTurn(taskId)

    const failed = tasks.messagesFor(taskId).filter((m) => m.event === 'landing.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.text).toMatch(/^Not landed: /)
    expect(failed[0]?.text).toMatch(/uncommitted/i)
    expect(failed[0]?.detail).toContain('nothing has been discarded')
    // ⛔ Nothing moved and nothing is owed: a failed landing is said once, not retried on the far
    // side of whatever the operator says next.
    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()
    expect(tasks.requireTask(taskId).branchUnit).toBe(1)
  })

  it('⛔ stands down in silence when the agent already landed it itself', async () => {
    // ⚠️ The MCP shape: `land_work` ran during the turn, so the branch is empty by the time the
    // promise is read. Posting *"no commits to land"* here would be a refusal about work that is
    // already exactly where it was going.
    const { taskId, workspace } = await seedConversation('already landed', 'claude-code')
    agentCommits(workspace, 'done.txt')
    await resolutions.landConversation(taskId, 'commit-and-merge')
    const before = tasks.messagesFor(taskId).length

    tasks.setLandAfterTurn(taskId, 'commit-and-merge')
    await resolutions.landAfterCommitTurn(taskId)

    expect(tasks.messagesFor(taskId)).toHaveLength(before)
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()
  })

  it('⛔ does nothing at all for a task nobody pressed Commit on', async () => {
    const { taskId, workspace, root } = await seedConversation('just talking', 'muse-code')
    agentCommits(workspace, 'unasked.txt')
    const trunkBefore = git(root, 'rev-parse', 'main')
    const before = tasks.messagesFor(taskId).length

    await resolutions.landAfterCommitTurn(taskId)

    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
    expect(tasks.messagesFor(taskId)).toHaveLength(before)
  })

  it('⛔ `commit-only` promises no landing, because that rung means stop at the commit', async () => {
    const { taskId, workspace, root } = await seedConversation('commit and stop', 'muse-code')
    writeFileSync(join(workspace, 'wip.txt'), 'uncommitted\n')

    await resolutions.commitConversation(taskId, 'commit-only')
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()

    agentCommits(workspace, 'wip.txt')
    const trunkBefore = git(root, 'rev-parse', 'main')
    await resolutions.landAfterCommitTurn(taskId)
    expect(git(root, 'rev-parse', 'main')).toBe(trunkBefore)
  })
})

describe('t578: the second press', () => {
  it('⛔ refuses to spend a turn asking for a commit that already exists, and names Land', async () => {
    const { taskId, workspace } = await seedConversation('already committed', 'muse-code')
    agentCommits(workspace, 'ready.txt')
    const before = humanMessages(taskId).length

    const refused = await resolutions.commitConversation(taskId, 'commit-and-merge')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('nothing is uncommitted')
    expect(refused.reason).toContain('**Land**')
    // ⛔ The whole point: no instruction was written, so no turn was dispatched.
    expect(humanMessages(taskId)).toHaveLength(before)
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()
  })

  it('⚠️ still asks when the workspace cannot be read, because that is not "nothing there"', async () => {
    // ⛔ The distinction the card is built on, and the guard above must not erase it: an unreadable
    // workspace is not an empty one, and committing checks the branch out again.
    const { taskId, project, workspace } = await seedConversation('nowhere to look', 'muse-code')
    agentCommits(workspace, 'somewhere.txt')
    // The tree an adapter whose turn ends its process leaves behind (t481): parked off the branch,
    // which the branch itself survives. `pendingWorkFor` can no longer see what is uncommitted.
    await worktrees.parkWorkspace(project, workspace)
    const answer = await resolutions.pendingWorkFor(taskId)
    expect(answer.supported).toBe(false)
    expect(answer.unlandedCommits).toBe(0)

    const asked = await resolutions.commitConversation(taskId, 'commit-and-merge')
    expect(asked).toEqual({ ok: true })
    expect(humanMessages(taskId).at(-1)).toContain("commit this conversation's work")
  })

  it('⛔ refuses while the turn it already asked for is still running', async () => {
    const { taskId, workspace } = await seedConversation('mid turn', 'muse-code')
    writeFileSync(join(workspace, 'busy.txt'), 'being written\n')
    tasks.setStatus(taskId, 'running')

    const refused = await resolutions.commitConversation(taskId, 'commit-and-merge')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('already running')
  })
})

describe('a promise the turn never kept', () => {
  it('⛔ is forgotten, so it cannot land on the far side of an unrelated reply', async () => {
    const { taskId } = await seedConversation('interrupted', 'muse-code')
    tasks.setLandAfterTurn(taskId, 'commit-and-merge')
    expect(tasks.requireTask(taskId).landAfterTurn).toBe('commit-and-merge')

    resolutions.forgetLandAfterTurn(taskId)
    expect(tasks.requireTask(taskId).landAfterTurn).toBeNull()

    // ⚠️ And forgetting nothing writes nothing: this is called on every unfinished run in the fleet.
    const before = tasks.requireTask(taskId).updatedAt
    resolutions.forgetLandAfterTurn(taskId)
    expect(tasks.requireTask(taskId).updatedAt).toBe(before)
  })
})

/**
 * Migration 78, replayed against a database that already has rows in it.
 *
 * ⚠️ Driven by rewinding `user_version` and reopening, which runs the SQL that actually ships
 * rather than a copy of it — and re-runs every migration after it, so this doubles as the
 * replay-safety check the migration contract requires.
 */
describe('migration 78', () => {
  it('adds the column, leaves every existing task owing no landing, and replays safely', async () => {
    const { taskId } = await seedConversation('before the column', 'muse-code')
    tasks.setLandAfterTurn(taskId, 'commit-and-merge')

    const dbPath = join(dir, 'commitland.db')
    db.db().exec(`pragma user_version = ${db.versionBefore('land_after_turn')}`)
    db.closeDb()
    db.openDb(dbPath)

    // ⛔ Replay is a no-op on a column that exists: the value a press recorded is still there.
    expect(tasks.requireTask(taskId).landAfterTurn).toBe('commit-and-merge')
    // ⚠️ And a task written before anyone pressed Commit owes nothing.
    const fresh = tasks.createTask({ title: 'filed after the migration' })
    expect(tasks.requireTask(fresh.id).landAfterTurn).toBeNull()
  })
})
