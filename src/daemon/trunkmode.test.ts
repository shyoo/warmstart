import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Task } from '@shared/tasks.js'
import { isTrunkBlockedReason, resolveRetryCauses, resolveWorkspaceMode, trunkPolicyConflict } from '@shared/tasks.js'

/**
 * Trunk mode: a task that works in the project's own checkout, on the landing target itself.
 *
 * ⛔ Decided with the operator on t401 (2026-09-12): per-task choice over a project default; one
 * trunk task at a time; worktree landings into a busy trunk *queue* and land by themselves; a trunk
 * task is dispatched onto whatever the checkout holds and told what that is; `pull-request` cannot
 * run in the trunk; a resting trunk task keeps its lease and a settled one gives it back. Each of
 * those is a test below, against real git where git is what decides.
 */

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let tasks: typeof import('./tasks.js')
let worktrees: typeof import('./worktrees.js')
let finish: typeof import('./finish.js')
let landing: typeof import('./landing.js')
let landingbase: typeof import('./landingbase.js')
let resources: typeof import('./resources.js')
let scheduler: typeof import('./scheduler.js')
let resolutions: typeof import('./resolutions.js')

let root: string
let project: Project

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function freshRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agentyard-trunk-repo-'))
  git(repo, 'init', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'first')
  return repo
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-trunk-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  projects = await import('./projects.js')
  tasks = await import('./tasks.js')
  worktrees = await import('./worktrees.js')
  finish = await import('./finish.js')
  landing = await import('./landing.js')
  landingbase = await import('./landingbase.js')
  resources = await import('./resources.js')
  scheduler = await import('./scheduler.js')
  resolutions = await import('./resolutions.js')
  db.openDb(join(dir, 'trunk.db'))
  root = freshRepo()
  project = projects.addProject({ root, name: 'trunky' })
})

beforeEach(() => {
  db.db().exec('delete from resource_claims')
  db.db().exec("update tasks set status = 'completed' where status = 'landing_queued'")
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Windows file locks during cleanup
  }
})

describe('where a task works', () => {
  it('resolves task, then project, then worktree — and never trunk without a repository', () => {
    const git = { vcs: 'git' as const, config: { schema_version: 1 } }
    const trunkProject = { vcs: 'git' as const, config: { schema_version: 1, workspaces: { mode: 'trunk' as const } } }
    expect(resolveWorkspaceMode({ workspaceMode: 'inherit' }, git)).toEqual({ mode: 'worktree', source: 'default' })
    expect(resolveWorkspaceMode({ workspaceMode: 'inherit' }, trunkProject)).toEqual({ mode: 'trunk', source: 'project' })
    expect(resolveWorkspaceMode({ workspaceMode: 'worktree' }, trunkProject)).toEqual({ mode: 'worktree', source: 'task' })
    expect(resolveWorkspaceMode({ workspaceMode: 'trunk' }, git)).toEqual({ mode: 'trunk', source: 'task' })
    expect(resolveWorkspaceMode({ workspaceMode: 'trunk' }, { vcs: 'none', config: { schema_version: 1 } }).mode).toBe('worktree')
  })

  it('refuses a pull request in the trunk and nothing else', () => {
    expect(trunkPolicyConflict('pull-request')).toMatch(/needs a branch/)
    for (const p of ['await-human', 'commit-only', 'commit-and-verify', 'commit-and-merge', 'commit-and-push', 'custom', 'report-only'] as const) {
      expect(trunkPolicyConflict(p)).toBeNull()
    }
  })

  it('fixes the mode once the task has run', () => {
    const task = tasks.createTask({ title: 'pull and resolve', projectId: project.id })
    expect(tasks.setWorkspaceMode(task.id, 'trunk').workspaceMode).toBe('trunk')
    tasks.startRun({ taskId: task.id, workerId: 'w', sessionId: null, projectId: project.id, quotaUnverified: false, costModelId: null })
    expect(() => tasks.setWorkspaceMode(task.id, 'worktree')).toThrow(/already run/)
  })

  it('stores the dispatch-time trunk dirt on the run', () => {
    const task = tasks.createTask({ title: 'dirt', projectId: project.id, workspaceMode: 'trunk' })
    const run = tasks.startRun({
      taskId: task.id, workerId: 'w', sessionId: null, projectId: project.id,
      quotaUnverified: false, costModelId: null, trunkDirtyBefore: ['notes.md']
    })
    expect(tasks.requireRun(run.id).trunkDirtyBefore).toEqual(['notes.md'])
    expect(tasks.requireTask(task.id).workspaceMode).toBe('trunk')
  })

  it('refuses a project default of trunk beside a pull-request finish, in either order', () => {
    projects.setProjectPolicy(project.id, { finish: 'pull-request' })
    expect(() => projects.setProjectPolicy(project.id, { workspaceMode: 'trunk' })).toThrow(/needs a branch/)
    // Both in one save is a way out, not into, the conflict.
    projects.setProjectPolicy(project.id, { workspaceMode: 'trunk', finish: 'commit-and-merge' })
    expect(projects.requireProject(project.id).config.workspaces?.mode).toBe('trunk')
    expect(() => projects.setProjectPolicy(project.id, { finish: 'pull-request' })).toThrow(/needs a branch/)
    projects.setProjectPolicy(project.id, { workspaceMode: 'worktree' })
    // ⚠️ `worktree` is written as no key.
    expect(projects.requireProject(project.id).config.workspaces?.mode).toBeUndefined()
    // The config is a tracked file of the repository; commit it so the trunk reads clean below.
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'project config')
  })
})

describe('the trunk lease', () => {
  it('has one holder, and is a separate resource from the pool', () => {
    const a = worktrees.claimTrunk(project, 'task-a')
    expect(a).toMatchObject({ kind: 'trunk', index: 0 })
    expect(worktrees.claimTrunk(project, 'task-b')).toBeNull()
    expect(worktrees.workspaceHeldBy(project, 'task-a')?.kind).toBe('trunk')
    expect(resources.openClaims(resources.workspacePoolId(project.id))).toEqual([])
    expect(landing.trunkOccupiedBy(project, 'task-b')).toMatch(/working in the trunk/)
    expect(landing.trunkOccupiedBy(project, 'task-a')).toBeNull()
  })

  it('is given back once its task has settled, and kept while it only rests', () => {
    const resting = tasks.createTask({ title: 'resting', projectId: project.id, workspaceMode: 'trunk' })
    tasks.setStatus(resting.id, 'awaiting_human')
    expect(worktrees.claimTrunk(project, resting.id)).not.toBeNull()
    expect(scheduler.sweepTrunkLeases()).toBe(0)
    tasks.setStatus(resting.id, 'cancelled')
    expect(scheduler.sweepTrunkLeases()).toBe(1)
    expect(worktrees.trunkHolder(project)).toBeNull()
  })

  it('never parks the operator checkout, whoever asks', async () => {
    git(root, 'switch', '-c', 'side')
    git(root, 'switch', 'main')
    writeFileSync(join(root, 'mine.txt'), 'operator edit\n')
    expect(await worktrees.parkWorkspace(project, root)).toBeNull()
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(root, 'status', '--porcelain')).toContain('mine.txt')
    rmSync(join(root, 'mine.txt'))
    git(root, 'branch', '-D', 'side')
  })
})

describe('what a trunk task walks into', () => {
  it('names uncommitted files, a merge in progress and its conflicts', async () => {
    const repo = freshRepo()
    const p = projects.addProject({ root: repo, name: 'merging' })
    git(repo, 'switch', '-c', 'other')
    writeFileSync(join(repo, 'a.txt'), 'theirs\n')
    git(repo, 'commit', '-am', 'theirs')
    git(repo, 'switch', 'main')
    writeFileSync(join(repo, 'a.txt'), 'ours\n')
    git(repo, 'commit', '-am', 'ours')
    try {
      git(repo, 'merge', 'other')
    } catch {
      // The conflict is the point.
    }
    writeFileSync(join(repo, 'scratch.md'), 'operator\n')

    const survey = await worktrees.surveyTrunk(p)
    expect(survey.branch).toBe('main')
    expect(survey.operation).toBe('merge')
    expect(survey.conflicted).toEqual(['a.txt'])
    expect(survey.untrackedFiles).toContain('scratch.md')

    const notice = scheduler.trunkArrivalNotice(survey, 'main')
    expect(notice).toMatch(/directly in this project's trunk checkout/)
    expect(notice).toMatch(/merge is in progress here, with conflicts in a\.txt/)
    expect(notice).toMatch(/already uncommitted when you arrived and are not yours: .*scratch\.md/)
  })
})

describe('what a worktree task is told about where it is', () => {
  it('names both directories and the branch that connects them', () => {
    const notice = scheduler.worktreeArrivalNotice(
      'C:\\Dev\\warmstart_workspaces\\ws1',
      'C:\\Dev\\warmstart',
      'warmstart/t446-x',
      'main'
    )
    expect(notice).toContain('C:\\Dev\\warmstart_workspaces\\ws1')
    expect(notice).toContain('not its main checkout, which lives at `C:\\Dev\\warmstart`')
    expect(notice).toContain('warmstart/t446-x` lands')
    expect(notice).toContain('onto `main`')
  })

  it('still says where the target lives for a task with no branch of its own', () => {
    const notice = scheduler.worktreeArrivalNotice('C:\\ws1', 'C:\\repo', null, 'main')
    expect(notice).toContain('Your work lands onto `main`')
  })
})

describe('landing a trunk task', () => {
  it('verifies in place for every level that would move work, and keeps the others', () => {
    const t = { landingTarget: null, workspaceMode: 'trunk' as const }
    expect(landingbase.landingStrategyIdFor(project, 'commit-and-merge', t)).toBe('trunk')
    expect(landingbase.landingStrategyIdFor(project, 'commit-and-push', t)).toBe('trunk')
    expect(landingbase.landingStrategyIdFor(project, 'commit-and-verify', t)).toBe('trunk')
    expect(landingbase.landingStrategyIdFor(project, 'commit-only', t)).toBe('leave-branch')
    expect(landingbase.landingStrategyIdFor(project, 'commit-and-merge', { landingTarget: null, workspaceMode: 'worktree' })).toBe('merge-local')
    expect(landingbase.landingBaseFor(project, 'commit-and-push', true, t)).toBe('main')
  })
})

describe('a busy trunk queues a worktree landing', () => {
  it('reports a trunk task as occupying the trunk before git status is asked', async () => {
    const holder = tasks.createTask({ title: 'in the trunk', projectId: project.id, workspaceMode: 'trunk' })
    worktrees.claimTrunk(project, holder.id)
    const branchTask = tasks.createTask({ title: 'worktree work', projectId: project.id })
    const verdict = await landing.mergeLocal.canLand({
      project,
      task: branchTask,
      workspacePath: root,
      branch: 'warmstart/t1-x',
      policy: 'commit-and-merge'
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.trunkBusy).toBe(true)
    expect(verdict.reason).toMatch(new RegExp(`t${holder.seq} is working in the trunk`))
  })

  it('queues rather than resting at a person when the checkout is dirty', async () => {
    writeFileSync(join(root, 'wip.txt'), 'operator\n')
    try {
      expect(await landing.trunkNotReady(root, 'main')).toMatch(/uncommitted file/)
    } finally {
      rmSync(join(root, 'wip.txt'))
    }
    expect(await landing.trunkNotReady(root, 'main')).toBeNull()
  })

  it('resolves taskOfSession when trunk claim holder is a session ID', async () => {
    const holder = tasks.createTask({ title: 'session holder trunk task', projectId: project.id, workspaceMode: 'trunk' })
    const claim = worktrees.claimTrunk(project, holder.id)
    expect(claim).not.toBeNull()
    const sessionId = 'session-' + holder.id
    tasks.startRun({ taskId: holder.id, projectId: project.id, sessionId, workerId: 'w1', quotaUnverified: false, costModelId: 'claude-3-5-sonnet' })
    resources.reassignClaim(claim!.claimId, sessionId)

    const branchTask = tasks.createTask({ title: 'worktree branch task', projectId: project.id })
    const verdict = await landing.mergeLocal.canLand({
      project,
      task: branchTask,
      workspacePath: root,
      branch: 'warmstart/t1-y',
      policy: 'commit-and-merge'
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.trunkBusy).toBe(true)
    expect(verdict.reason).toMatch(new RegExp(`t${holder.seq} is working in the trunk`))
  })

  it('does not self-block when checking trunk occupancy for the holder task itself', async () => {
    const holder = tasks.createTask({ title: 'self trunk task', projectId: project.id, workspaceMode: 'trunk' })
    const claim = worktrees.claimTrunk(project, holder.id)
    expect(claim).not.toBeNull()
    const sessionId = 'session-' + holder.id
    tasks.startRun({ taskId: holder.id, projectId: project.id, sessionId, workerId: 'w1', quotaUnverified: false, costModelId: 'claude-3-5-sonnet' })
    resources.reassignClaim(claim!.claimId, sessionId)

    expect(landing.trunkOccupiedBy(project, holder.id)).toBeNull()
  })

  it('cleans up stale lease and reports trunk free when holder task has settled', async () => {
    const holder = tasks.createTask({ title: 'settling trunk task', projectId: project.id, workspaceMode: 'trunk' })
    const claim = worktrees.claimTrunk(project, holder.id)
    expect(claim).not.toBeNull()
    const sessionId = 'session-' + holder.id
    const run = tasks.startRun({ taskId: holder.id, projectId: project.id, sessionId, workerId: 'w1', quotaUnverified: false, costModelId: 'claude-3-5-sonnet' })
    resources.reassignClaim(claim!.claimId, sessionId)

    tasks.finishRun(run.id, 'completed')
    tasks.setStatus(holder.id, 'completed')

    expect(landing.trunkOccupiedBy(project, 'other-task-id')).toBeNull()
    expect(worktrees.trunkHolder(project)).toBeNull()
  })

  it('retries queued landings once the trunk is free', async () => {
    const queuedTask = tasks.createTask({
      title: 'queued work',
      projectId: project.id
    })
    tasks.setTaskBranch(queuedTask.id, 'warmstart/t-queued', 1)
    tasks.setStatus(queuedTask.id, 'landing_queued')

    const started = await resolutions.retryQueuedLandings()
    expect(started).toBe(1)
  })

  /**
   * A queued landing blocked by the operator's own checkout, which nothing in the fleet can clear.
   *
   * ⭐ **t614 (autotrade, 2026-09-22) is the measurement.** It reported complete at 19:42:19Z with
   * one real commit on its branch; `mergeLocal`'s preflight found 16 uncommitted files in
   * `C:\Dev\autotrade`, dated 2026-08-12 — five weeks before the project was registered, so the
   * operator's own — and it went to `landing_queued` with `assignee: null`. Two hours later the
   * daemon log had no further line about it: the tick rewrote the identical hold reason for ever,
   * and nothing anywhere asked the one person who could clear it. A held status with no ender.
   */
  describe('a queued landing waiting on the operator\'s own checkout (t614)', () => {
    /** The sentence `trunkNotReady` really writes, so these tests cannot drift from it. */
    async function dirtyTrunkReason(): Promise<string> {
      return (await landing.trunkNotReady(root, 'main')) ?? ''
    }

    function queued(title: string): Task {
      const task = tasks.createTask({ title, projectId: project.id })
      tasks.setTaskBranch(task.id, `warmstart/t${task.seq}-queued`, 1)
      tasks.setStatus(task.id, 'landing_queued')
      return tasks.getTask(task.id)!
    }

    beforeEach(() => {
      resolutions.forgetTrunkHolds()
    })

    it("does not read the operator's dirty trunk as the agent leaving work uncommitted", async () => {
      // ⛔ The defect that made t614 worse than stuck: the shared classifier turned this exact
      // sentence into `uncommitted`, which offers a billed agent run to commit nothing and hides
      // the Retry landing button. Asserted against the live string, not a paraphrase of it.
      writeFileSync(join(root, 'wip.txt'), 'operator\n')
      try {
        const reason = await dirtyTrunkReason()
        expect(reason).toMatch(/uncommitted file\(s\) in it/)
        expect(isTrunkBlockedReason(reason)).toBe(true)
        expect(resolveRetryCauses({ holdReason: reason })).toEqual([])
      } finally {
        rmSync(join(root, 'wip.txt'))
      }
    })

    it('waits out the grace period, then hands the landing to the person who can clear it', async () => {
      writeFileSync(join(root, 'wip.txt'), 'operator\n')
      const task = queued('blocked on a dirty trunk')
      try {
        const t0 = 1_000_000

        // First sighting: still a queue, and the reason says so.
        expect(await resolutions.retryQueuedLandings(t0)).toBe(0)
        expect(tasks.getTask(task.id)?.status).toBe('landing_queued')
        expect(tasks.getTask(task.id)?.holdReason).toMatch(/it will land by itself once the trunk is free/i)

        // Still inside the grace period: nobody is bothered yet.
        expect(await resolutions.retryQueuedLandings(t0 + scheduler.STANDING_HOLD_GRACE_MS - 1)).toBe(0)
        expect(tasks.getTask(task.id)?.status).toBe('landing_queued')

        // Past it: handed over, and the promise it can no longer keep is withdrawn.
        expect(await resolutions.retryQueuedLandings(t0 + scheduler.STANDING_HOLD_GRACE_MS + 1)).toBe(0)
        const handed = tasks.getTask(task.id)!
        expect(handed.status).toBe('awaiting_human')
        expect(handed.assignee).toBe('human')
        expect(handed.holdReason).toMatch(/Nothing in the fleet can clear this/)
        expect(handed.holdReason).not.toMatch(/land by itself/i)
        // ⛔ And the reason it rests on must still not read as the agent's own loose ends.
        expect(resolveRetryCauses(handed)).toEqual([])
        expect(isTrunkBlockedReason(handed.holdReason)).toBe(true)

        const said = tasks.messagesFor(task.id).map((m) => m.text).join('\n')
        expect(said).toMatch(/Waiting on the trunk checkout/)
        expect(tasks.messagesFor(task.id).some((m) => (m.detail ?? '').includes(root))).toBe(true)
      } finally {
        rmSync(join(root, 'wip.txt'))
      }
    })

    it('never hands over while the block is a trunk lease, which ends by itself', async () => {
      const holder = tasks.createTask({ title: 'in the trunk', projectId: project.id, workspaceMode: 'trunk' })
      worktrees.claimTrunk(project, holder.id)
      const task = queued('behind a trunk task')
      try {
        const t0 = 2_000_000
        for (const at of [t0, t0 + scheduler.STANDING_HOLD_GRACE_MS * 2, t0 + scheduler.STANDING_HOLD_GRACE_MS * 10]) {
          expect(await resolutions.retryQueuedLandings(at)).toBe(0)
          expect(tasks.getTask(task.id)?.status).toBe('landing_queued')
        }
        expect(tasks.getTask(task.id)?.holdReason).toMatch(new RegExp(`t${holder.seq} is working in the trunk`))
      } finally {
        tasks.setStatus(holder.id, 'completed')
        db.db().exec('delete from resource_claims')
      }
    })

    it('restarts the clock when the kind of blockage changes, not when the file list does', async () => {
      const task = queued('one file, then two')
      writeFileSync(join(root, 'wip.txt'), 'operator\n')
      try {
        const t0 = 3_000_000
        expect(await resolutions.retryQueuedLandings(t0)).toBe(0)
        // ⛔ The ledger keys on *what kind* of thing is in the way. Keyed on the sentence, an
        // operator typing in their own checkout would reset the clock on every save and never be
        // asked anything — the file count and the five names it prints both change.
        writeFileSync(join(root, 'wip2.txt'), 'more\n')
        expect(await resolutions.retryQueuedLandings(t0 + scheduler.STANDING_HOLD_GRACE_MS + 1)).toBe(0)
        expect(tasks.getTask(task.id)?.status).toBe('awaiting_human')
      } finally {
        rmSync(join(root, 'wip.txt'), { force: true })
        rmSync(join(root, 'wip2.txt'), { force: true })
      }
    })

    it('forgets the hold and lands as usual the moment the trunk is clean', async () => {
      writeFileSync(join(root, 'wip.txt'), 'operator\n')
      const task = queued('cleaned up in time')
      try {
        const t0 = 4_000_000
        expect(await resolutions.retryQueuedLandings(t0)).toBe(0)
        rmSync(join(root, 'wip.txt'))
        expect(await resolutions.retryQueuedLandings(t0 + scheduler.STANDING_HOLD_GRACE_MS + 1)).toBe(1)
        expect(tasks.getTask(task.id)?.status).toBe('landing_queued')
      } finally {
        rmSync(join(root, 'wip.txt'), { force: true })
      }
    })
  })

  it('moves task to awaiting_human if trunk cannot be read', async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'agentyard-broken-'))
    const brokenProject = projects.addProject({ root: brokenDir, name: 'broken' })
    rmSync(brokenDir, { recursive: true, force: true })

    const queuedTask = tasks.createTask({
      title: 'queued on broken',
      projectId: brokenProject.id
    })
    tasks.setTaskBranch(queuedTask.id, 'warmstart/t-broken', 1)
    tasks.setStatus(queuedTask.id, 'landing_queued')

    const started = await resolutions.retryQueuedLandings()
    expect(started).toBe(0)
    const reloaded = tasks.getTask(queuedTask.id)
    expect(reloaded?.status).toBe('awaiting_human')
    expect(reloaded?.holdReason).toMatch(/the trunk could not be read/)
  })
})

describe('the trunk finish ladder', () => {
  const base = (over: Partial<Parameters<typeof finish.decideTrunkFinish>[0]> = {}) => ({
    task: { ...tasks.createTask({ title: 'ladder', projectId: project.id, workspaceMode: 'trunk' }), finishAskedAt: null } as Task,
    project,
    policy: 'commit-and-merge' as const,
    instruction: null,
    target: 'main',
    survey: { branch: 'main', dirtyFiles: [], untrackedFiles: [], operation: null, conflicted: [] },
    dirtyBefore: [],
    commitsThisRun: 1,
    hasChecks: true,
    ...over
  })

  it('asks once to finish an operation left in progress, then hands it to a person', () => {
    const input = base({ survey: { branch: 'main', dirtyFiles: ['a.txt'], untrackedFiles: [], operation: 'merge', conflicted: ['a.txt'] } })
    expect(finish.decideTrunkFinish(input).kind).toBe('ask-agent')
    expect(finish.decideTrunkFinish({ ...input, task: { ...input.task, finishAskedAt: 1 } }).kind).toBe('await-human')
  })

  it('does not count the operator files as the agent loose ends', () => {
    const input = base({
      survey: { branch: 'main', dirtyFiles: ['notes.md'], untrackedFiles: ['new.ts'], operation: null, conflicted: [] },
      dirtyBefore: ['notes.md']
    })
    const decision = finish.decideTrunkFinish(input)
    expect(decision.kind).toBe('ask-agent')
    expect(decision.kind === 'ask-agent' && decision.instruction).toMatch(/new\.ts/)
    expect(decision.kind === 'ask-agent' && decision.instruction).not.toMatch(/notes\.md/)
    expect(finish.decideTrunkFinish({ ...input, survey: { ...input.survey, untrackedFiles: [] } }).kind).toBe('land')
  })

  it('has no tripwire: nothing committed is simply done', () => {
    expect(finish.decideTrunkFinish(base({ commitsThisRun: 0 })).kind).toBe('done')
  })

  it('refuses a trunk left off its target', () => {
    const d = finish.decideTrunkFinish(base({ survey: { branch: 'feature', dirtyFiles: [], untrackedFiles: [], operation: null, conflicted: [] } }))
    expect(d.kind).toBe('await-human')
  })

  it('maps the levels: wait, stop, verify, and push only with checks', () => {
    expect(finish.decideTrunkFinish(base({ policy: 'await-human' })).kind).toBe('await-human')
    expect(finish.decideTrunkFinish(base({ policy: 'commit-only' })).kind).toBe('done')
    expect(finish.decideTrunkFinish(base({ policy: 'commit-and-verify' })).kind).toBe('land')
    expect(finish.decideTrunkFinish(base({ policy: 'commit-and-push' })).kind).toBe('land')
    expect(finish.decideTrunkFinish(base({ policy: 'commit-and-push', hasChecks: false })).kind).toBe('await-human')
    expect(finish.decideTrunkFinish(base({ policy: 'pull-request' })).kind).toBe('await-human')
    // ⚠️ Unknown commit count is not "nothing": it still verifies.
    expect(finish.decideTrunkFinish(base({ commitsThisRun: null })).kind).toBe('land')
  })

  it('never asks a report-only task to take commits back off the trunk', () => {
    expect(finish.decideTrunkFinish(base({ policy: 'report-only', commitsThisRun: 0 })).kind).toBe('done')
    expect(finish.decideTrunkFinish(base({ policy: 'report-only', commitsThisRun: 2 })).kind).toBe('await-human')
  })
})
