import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FinishPolicyChoice, Project, Task } from '@shared/tasks.js'
import type { WorkspaceState } from './worktrees.js'
// ⚠️ A type-only import beside the dynamic one below: `finish` is a runtime binding for a module
// loaded after the data dir is set, and a value cannot be used as a type namespace.
import type { TrunkReading } from './finish.js'

/**
 * What finishing a task means, and who does the committing.
 *
 * ⛔ **The tool never commits on the agent's behalf.** That was the proposal on 2026-08-28 and the
 * survey killed it: no orchestrator in this space auto-commits at task completion. Claude Code's
 * worktree sweep preserves any worktree holding "changed or untracked files, or unpushed commits"
 * and makes you run `git worktree remove --force` to lose it; agent-orchestrator states *"Never
 * force-delete dirty worktrees"* as a load-bearing rule and treats the agent's pull request as the
 * unit of output. Deciding what to stage, what to leave and what to test first is judgement that
 * differs per project and per person — it is what a `/commit` skill encodes — and a daemon applying
 * a name-and-size blocklist at the one moment nobody is watching is a worse copy of it.
 *
 * ⚠️ So every branch below ends in one of: ask the agent, preserve and hand to a person, or land
 * work that is already committed. None of them writes a commit.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let finish: typeof import('./finish.js')
let settings: typeof import('./settings.js')

const clean = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
  path: 'C:/ws1',
  branch: 'multi-agent-controller/t1-a-task',
  dirtyFiles: [],
  untrackedFiles: [],
  unlandedCommits: 1,
  landedRef: 'origin/main',
  targetBehind: 0,
  stashes: 0,
  ...over
})

/** ⚠️ A shape, not a row: `decideFinish` reads only `landing`, so the rest would be noise. */
const projectWith = (landing: Project['config']['landing']): Project =>
  ({ id: 'p1', name: 'p', root: 'C:/p', vcs: 'git', config: { schema_version: 1, landing } }) as Project

let seq = 0
function makeTask(over: { finishPolicy?: FinishPolicyChoice; asked?: boolean; land?: boolean } = {}): Task {
  seq += 1
  const task = tasks.createTask({
    title: `t${seq}`,
    createdBy: { kind: 'human' },
    ...(over.finishPolicy ? { finishPolicy: over.finishPolicy } : {}),
    ...(over.land === false
      ? { mandate: { allowed: ['read', 'write', 'commit'] } }
      : {})
  })
  if (over.asked) {
    db.db().prepare('update tasks set finish_asked_at = ? where id = ?').run(Date.now(), task.id)
  }
  return tasks.requireTask(task.id)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-finish-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  finish = await import('./finish.js')
  settings = await import('./settings.js')
  db.openDb(join(dir, 'finish.db'))
})

beforeEach(() => db.db().exec('delete from settings'))

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('which tier answers', () => {
  it('takes the fleet default when nothing else says anything', () => {
    const resolved = finish.resolveFinishPolicy(makeTask(), null)
    expect(resolved.policy).toBe('agent-lands')
    expect(resolved.source).toBe('fleet')
  })

  it('lets the project override the fleet', () => {
    settings.setSetting('finishPolicy', 'agent-lands')
    const resolved = finish.resolveFinishPolicy(makeTask(), projectWith({ finish: 'await-human' }))
    expect(resolved.policy).toBe('await-human')
    expect(resolved.source).toBe('project')
  })

  it('lets the task override the project', () => {
    const resolved = finish.resolveFinishPolicy(
      makeTask({ finishPolicy: 'await-human' }),
      projectWith({ finish: 'agent-lands' })
    )
    expect(resolved.policy).toBe('await-human')
    expect(resolved.source).toBe('task')
  })

  it('treats inherit as silence, not as a choice', () => {
    // ⛔ The reason `inherit` is a value rather than a null. A task set to inherit follows its
    // project as the project changes; one set explicitly to the same value does not.
    const resolved = finish.resolveFinishPolicy(
      makeTask({ finishPolicy: 'inherit' }),
      projectWith({ finish: 'pull-request' })
    )
    expect(resolved.policy).toBe('pull-request')
    expect(resolved.source).toBe('project')
  })

  it('still reads the old landing.strategy spelling', () => {
    // ⚠️ A project.json written before 2026-08-28 keeps working, unedited.
    expect(finish.resolveFinishPolicy(makeTask(), projectWith({ strategy: 'auto-land' })).policy).toBe(
      'agent-lands'
    )
    expect(
      finish.resolveFinishPolicy(makeTask(), projectWith({ strategy: 'leave-branch' })).policy
    ).toBe('await-human')
  })

  it('prefers the new spelling when a file carries both', () => {
    const both = projectWith({ strategy: 'auto-land', finish: 'await-human' })
    expect(finish.resolveFinishPolicy(makeTask(), both).policy).toBe('await-human')
  })
})

describe('work the agent left uncommitted', () => {
  it('asks the agent to commit it, and does not commit it itself', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ finish: 'agent-lands' }),
      state: clean({ dirtyFiles: ['src/a.ts'], untrackedFiles: ['src/b.ts'] }),
      hasChecks: true
    })
    expect(decision.kind).toBe('ask-agent')
    expect(decision.kind === 'ask-agent' && decision.instruction).toMatch(/commit them/i)
  })

  it('counts an untracked file as work', () => {
    // ⛔ The question that killed `git add -u`: a brand-new source file is untracked, and staging
    // only tracked edits would have dropped most of what an agent typically produces.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: null,
      state: clean({ untrackedFiles: ['src/components/Logs.tsx'] }),
      hasChecks: true
    })
    expect(decision.kind).toBe('ask-agent')
  })

  it('asks exactly once, then hands it to a person with the work intact', () => {
    // ⛔ The preemption loop of 2026-08-28 in a different costume. Between the instruction and the
    // agent's next completion nothing about the task changes, so the same decision is reached
    // again — and each repeat is a billed turn telling an agent to do what it just did.
    const decision = finish.decideFinish({
      task: makeTask({ asked: true }),
      project: null,
      state: clean({ dirtyFiles: ['src/a.ts'] }),
      hasChecks: true
    })
    expect(decision.kind).toBe('await-human')
    expect(decision.kind === 'await-human' && decision.reason).toMatch(/nothing has been discarded/i)
  })
})

describe('landing work that is committed', () => {
  it('lands when the policy says so and the project has checks', () => {
    expect(
      finish.decideFinish({
        task: makeTask(),
        project: projectWith({ finish: 'agent-lands' }),
        state: clean(),
        hasChecks: true
      }).kind
    ).toBe('land')
  })

  it('refuses to land a project that defines no checks', () => {
    // ⛔ Unattended landing of code nothing verified is a guess dressed as a policy.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ finish: 'agent-lands' }),
      state: clean(),
      hasChecks: false
    })
    expect(decision.kind).toBe('await-human')
    expect(decision.kind === 'await-human' && decision.reason).toMatch(/no check commands/i)
  })

  it('refuses when the task has no authority to land, whatever the policy says', () => {
    // ⛔ Preference never widens authority. `mandate` is inherited down a lineage precisely so an
    // agent-spawned subtask cannot grant itself more than its parent had, and a dropdown is a
    // preference. If this ever passes, an agent can escalate by editing its own task.
    const decision = finish.decideFinish({
      task: makeTask({ finishPolicy: 'agent-lands', land: false }),
      project: null,
      state: clean(),
      hasChecks: true
    })
    expect(decision.kind).toBe('await-human')
    expect(decision.kind === 'await-human' && decision.reason).toMatch(/no authority/i)
  })

  it('stops for a person when the policy is await-human', () => {
    expect(
      finish.decideFinish({
        task: makeTask({ finishPolicy: 'await-human' }),
        project: null,
        state: clean(),
        hasChecks: true
      }).kind
    ).toBe('await-human')
  })

  it('says nothing was produced rather than claiming a landing', () => {
    // ⚠️ Measured 2026-08-27: a question-only task was reported as "Landed as a166a6a onto main"
    // when every step had succeeded and no commit existed.
    expect(
      finish.decideFinish({
        task: makeTask(),
        project: null,
        state: clean({ unlandedCommits: 0 }),
        hasChecks: true
      }).kind
    ).toBe('nothing-to-land')
  })
})

describe('a project with its own finish policy', () => {
  it('sends the project its own words, not the daemon’s', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ finish: 'custom', finishInstruction: 'Run /commit and push.' }),
      state: clean(),
      hasChecks: true
    })
    expect(decision.kind).toBe('ask-agent')
    expect(decision.kind === 'ask-agent' && decision.instruction).toBe('Run /commit and push.')
  })

  it('falls back to a default instruction that names a slash command', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ finish: 'custom' }),
      state: clean(),
      hasChecks: true
    })
    expect(decision.kind === 'ask-agent' && decision.instruction).toMatch(/\/commit/)
  })

  it('does not land afterwards, because the policy owns that step', () => {
    // ⛔ A `/commit` skill ends by pushing. Landing on top of it would be a second push of work the
    // policy already placed, and the tool has no way to know the policy did not mean to stop short.
    const decision = finish.decideFinish({
      task: makeTask({ asked: true }),
      project: projectWith({ finish: 'custom' }),
      state: clean(),
      hasChecks: true
    })
    expect(decision.kind).toBe('done')
    expect(decision.kind === 'done' && decision.reason).toMatch(/did not land them/i)
  })

  it('still refuses to finish with work left loose', () => {
    const decision = finish.decideFinish({
      task: makeTask({ asked: true }),
      project: projectWith({ finish: 'custom' }),
      state: clean({ dirtyFiles: ['a.ts'] }),
      hasChecks: true
    })
    expect(decision.kind).toBe('await-human')
  })
})

describe('surfacing work that is going nowhere', () => {
  const state = (over: Partial<WorkspaceState>): WorkspaceState => ({
    path: 'C:/ws1',
    branch: 'multi-agent-controller/t5-refine-the-workers-table',
    dirtyFiles: [],
    untrackedFiles: [],
    unlandedCommits: 0,
    landedRef: 'origin/main',
    targetBehind: 0,
    stashes: 0,
    ...over
  })
  const project = { id: 'p1', name: 'demo' }

  it('finds a branch that finished and never landed', () => {
    // ⛔ The failure that motivated all of this. Nothing is dirty, nothing looks wrong, and the
    // work is simply never mentioned again — t5's `ea05929` sat like this for a day.
    const [end] = finish.looseEndsIn(project, state({ unlandedCommits: 1 }))
    expect(end?.kind).toBe('unlanded')
    expect(end?.taskSeq).toBe(5)
  })

  it('recovers the task number from the branch name alone', () => {
    // ⚠️ The workspace has usually been released and reused by the time anybody looks, so the
    // branch is the only thread back to the task that made it.
    expect(finish.taskSeqFromBranch('multi-agent-controller/t12-fix-the-dialog')).toBe(12)
    expect(finish.taskSeqFromBranch('some-branch-a-human-made')).toBeNull()
    expect(finish.taskSeqFromBranch(null)).toBeNull()
  })

  it('counts untracked files as work, not as noise', () => {
    const [end] = finish.looseEndsIn(project, state({ untrackedFiles: ['src/New.tsx'] }))
    expect(end?.kind).toBe('uncommitted')
    expect(end?.count).toBe(1)
  })

  it('reports a stash, which is the part nothing else could see', () => {
    // ⛔ `rescueDirt` stashes to free a slot, which is correct and was invisible. Preserving work
    // silently is indistinguishable from losing it.
    const [end] = finish.looseEndsIn(project, state({ stashes: 2 }))
    expect(end?.kind).toBe('stash')
    expect(end?.summary).toMatch(/git stash list/)
  })

  it('gives a stash an id per repository, not per workspace', () => {
    // ⚠️ Stashes live in the shared object store, so all three pool members report the same list.
    // Keying by path would show one afternoon's work three times and dismiss it one third at a time.
    const a = finish.looseEndsIn(project, state({ path: 'C:/ws1', stashes: 1 }))[0]
    const b = finish.looseEndsIn(project, state({ path: 'C:/ws2', stashes: 1 }))[0]
    expect(a?.id).toBe(b?.id)
  })

  it('says nothing about a workspace that is clean and landed', () => {
    expect(finish.looseEndsIn(project, state({}))).toEqual([])
  })

  it('reports every kind at once when a workspace holds all three', () => {
    const ends = finish.looseEndsIn(
      project,
      state({ dirtyFiles: ['a.ts'], unlandedCommits: 2, stashes: 1 })
    )
    expect(ends.map((e) => e.kind).sort()).toEqual(['stash', 'uncommitted', 'unlanded'])
  })

  it('keeps a dismissal, because that is the only part git cannot tell us', () => {
    finish.dismissLooseEnd('unlanded:some-branch')
    const kept = db
      .db()
      .prepare('select id from loose_end_dismissals where id = ?')
      .get('unlanded:some-branch')
    expect(kept).toBeTruthy()
    // ⚠️ Idempotent: the button can be pressed twice before the list refreshes.
    expect(() => finish.dismissLooseEnd('unlanded:some-branch')).not.toThrow()
  })
})

// ---------------------------------------------------------------- the trunk tripwire

/**
 * Insurance against the failure that reported success three times.
 *
 * ⛔ On 2026-08-28 t17 ran with `--dangerously-skip-permissions`, edited and committed in the
 * **trunk**, and left its branch empty. `nothing-to-land` was the literally correct answer and the
 * completely wrong verdict: the commits reached `main` without passing a check, a rebase or the
 * landing policy, because all three sit downstream of a branch that never received anything.
 *
 * ⚠️ The rule needs **both** halves, and the second is what keeps it usable. An operator committing
 * to their own trunk while agents work is constant and blameless; an empty branch is the ordinary
 * shape of a task that only had to answer a question. Firing on either alone would make this noise
 * that gets switched off, which is the normal fate of a tripwire.
 */
const moved = (over: Partial<TrunkReading> = {}): TrunkReading => ({
  before: 'aaaaaaaa1111',
  after: 'bbbbbbbb2222',
  commits: ['bbbbbbb a commit nobody on this task wrote'],
  ...over
})

describe('a run whose branch is empty while the trunk moved', () => {
  it('is handed to a person rather than reported as finished', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main', finish: 'agent-lands' }),
      state: clean({ unlandedCommits: 0 }),
      hasChecks: true,
      trunk: moved()
    })
    expect(decision.kind).toBe('trunk-moved')
  })

  it('names what appeared, because the operator has to go and look at it', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0 }),
      hasChecks: false,
      trunk: moved({ commits: ['1111111 one', '2222222 two'] })
    })
    expect(decision.kind === 'trunk-moved' && decision.commits).toEqual(['1111111 one', '2222222 two'])
  })

  it('stays quiet when the trunk moved but the branch has work', () => {
    // ⭐ The false positive that would matter most. An operator commits to the trunk all day while
    // agents run; a task that produced real commits on its own branch is not evidence of anything.
    const decision = finish.decideFinish({
      task: makeTask({ finishPolicy: 'await-human' }),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 2 }),
      hasChecks: false,
      trunk: moved()
    })
    expect(decision.kind).toBe('await-human')
  })

  it('stays quiet when the branch is empty and the trunk did not move', () => {
    // The ordinary honest outcome: a question was answered and nothing needed committing.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0 }),
      hasChecks: false,
      trunk: null
    })
    expect(decision.kind).toBe('nothing-to-land')
  })

  it('declines on a run that took no reading, rather than assuming it is innocent', () => {
    // ⚠️ Absent is not the same as unmoved. A run dispatched before this column existed, or on a
    // project with no git, has nothing to compare — and a tripwire that treats "cannot say" as
    // "nothing happened" is one that quietly stops covering the oldest runs in the database.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0 }),
      hasChecks: false
    })
    expect(decision.kind).toBe('nothing-to-land')
  })

  it('does not fire on two readings that are the same', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0 }),
      hasChecks: false,
      trunk: moved({ after: 'aaaaaaaa1111' })
    })
    expect(decision.kind).toBe('nothing-to-land')
  })

  it('takes precedence over uncommitted work being asked about first', () => {
    // ⛔ Ordering. Loose files are step 1 and this is step 3, so a tree with both goes to the agent
    // first — correctly: the agent may yet commit them to the branch, which changes the answer.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0, dirtyFiles: ['a.ts'] }),
      hasChecks: false,
      trunk: moved()
    })
    expect(decision.kind).toBe('ask-agent')
  })
})

// ------------------------------------------------- reporting work that landed without us

/**
 * ⛔ The failure was not that t22 went unlanded — it landed. The failure was that the operator was
 * told `main` carried its work when `main` was two commits short of it, so a true verdict arrived
 * wearing a false explanation and read as "the change is gone". 2026-08-29.
 *
 * ⚠️ The agent pushing to `origin/<target>` itself is **supported**, not a bug to design out: a
 * project's finish skill is its own business, and this repo's own tells it to. So the reporting has
 * to handle it rather than the scheduler having to prevent it.
 */
describe('a branch whose work reached the remote without passing through here', () => {
  it('names the ref it actually compared, not the local one', () => {
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0, landedRef: 'origin/main', targetBehind: 2 }),
      hasChecks: false
    })
    expect(decision.kind).toBe('nothing-to-land')
    expect('reason' in decision && decision.reason).toContain('origin/main')
  })

  it('says the trunk is behind and what to run about it', () => {
    // ⭐ The one sentence that turns "my work vanished" into "run git pull".
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0, landedRef: 'origin/main', targetBehind: 2 }),
      hasChecks: false
    })
    const reason = 'reason' in decision ? decision.reason : ''
    expect(reason).toContain('2 commit(s) behind')
    expect(reason).toContain('git pull')
  })

  it('stays quiet about pulling when the trunk is level', () => {
    // ⚠️ The ordinary empty-branch case, which is most of them. A task that only answered a question
    // must not tell somebody to go and pull work that does not exist.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0, landedRef: 'origin/main', targetBehind: 0 }),
      hasChecks: false
    })
    const reason = 'reason' in decision ? decision.reason : ''
    expect(reason).not.toContain('git pull')
  })

  it('still defers to the trunk tripwire, which is the case that must not be explained away', () => {
    // ⛔ Ordering. An empty branch beside a trunk that moved is t17, and "your trunk is behind, run
    //    git pull" is exactly the reassuring sentence that would bury it.
    const decision = finish.decideFinish({
      task: makeTask(),
      project: projectWith({ target: 'main' }),
      state: clean({ unlandedCommits: 0, landedRef: 'origin/main', targetBehind: 2 }),
      hasChecks: false,
      trunk: { before: 'aaaaaaaa1111', after: 'bbbbbbbb2222', commits: ['bbbbbbb not ours'] }
    })
    expect(decision.kind).toBe('trunk-moved')
  })
})
