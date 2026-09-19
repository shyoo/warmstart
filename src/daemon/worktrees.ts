import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FinishPolicy, Project, ResourceClaim, Task, WorkspaceMode } from '@shared/tasks.js'
import { resolveFinishPolicy } from '@shared/policy.js'
import { landingBaseFor } from './landingbase.js'
import { landingTargetFor, policyFor } from './projects.js'
import { settings } from './settings.js'
import {
  availability,
  claim,
  getResource,
  openClaims,
  release,
  trunkResourceId,
  upsertResource,
  workspacePoolId
} from './resources.js'
import { samePath } from './fspath.js'
import { listSessions } from './sessions.js'
import { sessionEnded } from '@shared/protocol.js'
import { log } from './log.js'
import { git, tryGit } from './git.js'
import { errorMessage } from '@shared/errors.js'
import { run } from './spawn.js'
import { sweepAcls } from './acl.js'
import { appEnvName } from '@shared/env.js'
import { spawnEnv } from './which.js'

/**
 * Workspaces: pooled git worktrees.
 *
 * ```
 * <project>/                TRUNK. Stays on the landing target. Integration and landing only.
 * <project>_workspaces/
 *   ws1/ ws2/ ws3/          permanent worktrees, created once and reused, one .git object store
 * ```
 *
 * Three properties carry the design:
 *
 *  - **Git enforces the isolation.** Two worktrees cannot check out the same branch. That is a hard
 *    guarantee from git, not a claim file. The claim coordinates *scheduling*; git prevents
 *    *collision*.
 *  - ⛔ **The branch is named after the task, never the workspace** - `warmstart/t12-fix-dialog`, not
 *    `agent/ws2-…`. Which workspace a task happened to land in is an implementation detail that must
 *    never reach history, and re-running the task later in a different workspace yields the same name.
 *  - ⛔ **A worktree task never works in the trunk.** The branch is created *inside* the claimed
 *    worktree. A task whose workspace mode is `trunk` is the one exception, and it gets the trunk
 *    through its own single-member resource (`claimTrunk`), never through the pool — so nothing
 *    that parks, stashes or switches a pool member can ever reach the operator's checkout.
 *
 * A non-git project is a pool of one over its own directory, so nothing downstream needs a special
 * case for "no repo".
 */

export interface Workspace {
  claimId: string
  path: string
  index: number
  /** ⚠️ Absent means `worktree`, which is every workspace that existed before trunk mode. */
  kind?: WorkspaceMode
}


async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

/**
 * The ref new task branches start from.
 *
 * ⭐ **The same ref the landing will rebase onto**, which is why this delegates to `landingBaseFor`
 * rather than deciding for itself. Branch off anything else and the rebase at the end has to replay
 * the difference, and every task pays for history it never touched.
 *
 * ⭐ Measured on this repository, 2026-09-04: local `main` was **41 commits ahead of
 * `origin/main`**. This project finishes with `commit-and-merge`, which merges into the *local*
 * trunk and never pushes, so `origin/main` had not moved in days. This function preferred
 * `origin/main` anyway — it delegated to `landedRef`, whose question is the different one of *where
 * work has to reach to count as shipped*. So a task started against an idle fleet, touching a file
 * nobody else had open, was cut 41 commits back and then asked to rebase onto local `main` to land.
 * That is the "it almost certainly hits a rebase issue when it tries to land" the operator reported,
 * and it was not the agents' doing. Two definitions of "where is the trunk", and the stale one won.
 *
 * ⚠️ `HEAD` only when neither ref resolves — a repository whose first commit is not on the target
 * branch yet. A repo with no remote is normal and must not be a failure.
 */
export async function trunkBaseRef(
  project: Project,
  policy?: FinishPolicy,
  task?: Pick<Task, 'landingTarget'> | null
): Promise<string> {
  // ⛔ Before the first `gitOk`: every one of them answers *no* to a trunk whose config names a work
  // tree git cannot enter, and this function would then answer `HEAD` as though that were a fact.
  repairTrunkConfig(project)
  const target = landingTargetFor(task, project)
  const remote = await gitOk(project.root, ['rev-parse', '--verify', `refs/remotes/origin/${target}`])
  const wanted = landingBaseFor(project, policy, remote, task)
  if (await gitOk(project.root, ['rev-parse', '--verify', wanted])) return wanted
  if (await gitOk(project.root, ['rev-parse', '--verify', target])) return target
  return 'HEAD'
}

/**
 * Where this task's branch begins: the ref its landing strategy will rebase onto. Split work carries
 * the planner branch in `task.landingTarget`; ordinary work resolves to the project's trunk.
 */
export async function baseRef(project: Project, task?: Task | null): Promise<string> {
  const { policy } = resolveFinishPolicy(task ?? null, project, settings().finishPolicy)
  return trunkBaseRef(project, policy, task)
}

/**
 * Remove stale index.lock or HEAD.lock if left behind by a dead process.
 * On Windows, if an active process still holds a lock, unlinkSync will throw EBUSY/EPERM,
 * which is caught safely.
 */
export function cleanStaleGitLocks(workspacePath: string): void {
  try {
    const pointer = worktreePointer(workspacePath)
    const adminDir = pointer?.resolved ?? (existsSync(join(workspacePath, '.git')) && statSync(join(workspacePath, '.git')).isDirectory() ? join(workspacePath, '.git') : null)
    if (!adminDir || !existsSync(adminDir)) return
    for (const name of ['index.lock', 'HEAD.lock']) {
      const lock = join(adminDir, name)
      if (existsSync(lock)) {
        try {
          unlinkSync(lock)
          log.warn(`removed stale git lock ${lock}`)
        } catch (err) {
          log.warn(`could not remove lock file ${lock} (a process may be using it):`, err)
        }
      }
    }
  } catch (err) {
    log.warn(`lock sweep on ${workspacePath} failed:`, err)
  }
}

const inFlightEnsurePool = new Map<string, Promise<string[]>>()

/**
 * Create the pool if it is not there, and register it as a counted Resource whose members are the
 * worktree paths. Idempotent - called before every claim, cheap when nothing has to happen.
 *
 * ⛔ Serialized per project: if a worktree is being created in the background, a concurrent dispatch
 * must wait for creation to complete rather than seeing a half-checked-out tree and failing on index.lock.
 */
export async function ensurePool(project: Project): Promise<string[]> {
  while (inFlightEnsurePool.has(project.id)) {
    try {
      await inFlightEnsurePool.get(project.id)
    } catch {
      // Previous failure shouldn't permanently block subsequent attempts
    }
  }
  const promise = doEnsurePool(project)
  inFlightEnsurePool.set(project.id, promise)
  try {
    return await promise
  } finally {
    if (inFlightEnsurePool.get(project.id) === promise) {
      inFlightEnsurePool.delete(project.id)
    }
  }
}

async function doEnsurePool(project: Project): Promise<string[]> {
  const policy = policyFor(project)
  const poolId = workspacePoolId(project.id)

  if (project.vcs !== 'git') {
    upsertResource({
      id: poolId,
      projectId: project.id,
      kind: 'counted',
      label: `${project.name} workspace`,
      members: [project.root],
      meta: { vcs: 'none' }
    })
    return [project.root]
  }

  // ⚠️ No directory for a pool of zero: trunk-only keeps nothing on disk, and creating an
  // empty workspace root on the first dispatch would leave a directory nothing will ever fill.
  if (policy.poolSize > 0) mkdirSync(policy.workspaceRoot, { recursive: true })
  // ⚠️ `trunkBaseRef`, not `baseRef`: a pool member at rest belongs to no task, so there is no
  // parent branch to inherit and the trunk is the only sensible place to sit.
  const base = await trunkBaseRef(project)
  const members: string[] = []

  for (let i = 1; i <= policy.poolSize; i++) {
    const path = join(policy.workspaceRoot, `ws${i}`)
    members.push(path)
    if (existsSync(join(path, '.git'))) {
      cleanStaleGitLocks(path)
      continue
    }
    try {
      // --detach: a pool member holds no branch at rest, so any task branch is free to be claimed.
      await git(project.root, ['worktree', 'add', '--detach', path, base])
      await ensureWorktreePointer(project, path)
      cleanStaleGitLocks(path)
      log.info(`created worktree ${path} from ${base}`)
    } catch (err) {
      log.error(`could not create worktree ${path}:`, err)
      members.pop()
    }
  }

  // Gracefully retire any extra workspaces outside the configured poolSize:
  // If an extra workspace is idle (not held by any active claim), park it off its branch
  // so it does not hold onto branches, locks or uncommitted work.
  // If an extra workspace IS occupied, leave it alone until its task completes.
  const activeClaims = openClaims(poolId)
  let extraIndex = policy.poolSize + 1
  while (existsSync(join(policy.workspaceRoot, `ws${extraIndex}`))) {
    const extraPath = join(policy.workspaceRoot, `ws${extraIndex}`)
    const isOccupied = activeClaims.some((c) => c.member && samePath(c.member, extraPath))
    if (!isOccupied && existsSync(join(extraPath, '.git'))) {
      cleanStaleGitLocks(extraPath)
      try {
        const state = await workspaceState(extraPath, base)
        if (state.branch && state.branch !== base) {
          log.info(`gracefully parked retired workspace ${extraPath}, which held ${state.branch}`)
          await parkWorkspace(project, extraPath)
        }
      } catch (err) {
        log.warn(`could not park retired workspace ${extraPath}:`, err)
      }
    }
    extraIndex++
  }

  upsertResource({
    id: poolId,
    projectId: project.id,
    kind: 'counted',
    label: `${project.name} workspaces`,
    // ⛔ Stated, not derived: the derived default is `max(1, members)`, which would report a
    // trunk-only pool as capacity one — a pool the operator just removed, resurrected in the
    // Resources panel and in every gate that reads capacity instead of the policy.
    capacity: members.length,
    members,
    meta: { vcs: 'git', root: policy.workspaceRoot }
  })
  return members
}

export interface PruneResult {
  removed: string[]
  kept: Array<{ path: string; reason: string }>
}

/**
 * Remove pooled worktree directories from disk — the second half of switching a project to
 * trunk-only. `ensurePool` parks extras but never deletes (deleting a worktree can destroy
 * work), so this is the operator-confirmed step that actually frees the disk.
 *
 * ⛔ **Never removes a tree something is standing in.** An open resource claim or a live session
 * with its cwd inside keeps the directory, whatever the operator confirmed — the confirmation
 * was about idle pool members, not about work in flight.
 *
 * ⛔ **Dirt is rescued before removal, never with it.** `parkWorkspace` commits what it can and
 * stashes the rest onto refs that live in the shared object store, so the branch and the stash
 * survive the directory going away and Loose ends still surfaces them. A tree that cannot be
 * made safe is kept, with the reason, rather than removed with work in it.
 */
export async function prunePoolWorktrees(project: Project): Promise<PruneResult> {
  const removed: string[] = []
  const kept: Array<{ path: string; reason: string }> = []
  if (project.vcs !== 'git') throw new Error(`${project.name} has no worktree pool to remove`)
  const policy = policyFor(project)
  const poolId = workspacePoolId(project.id)
  const base = await trunkBaseRef(project)
  const liveDirs = new Set(
    listSessions()
      .filter((s) => !sessionEnded(s.state))
      .map((s) => s.cwd)
  )
  const claimedDirs = new Set(
    openClaims(poolId)
      .map((c) => c.member)
      .filter((m): m is string => !!m)
  )
  const under = (dir: string, root: string): boolean =>
    samePath(dir, root) || dir.toLowerCase().startsWith(root.toLowerCase() + '/')

  let index = 1
  while (existsSync(join(policy.workspaceRoot, `ws${index}`))) {
    const path = join(policy.workspaceRoot, `ws${index}`)
    index++
    if (!existsSync(join(path, '.git'))) {
      // Not a worktree — something else the operator put here. Never ours to remove.
      kept.push({ path, reason: 'not a git worktree' })
      continue
    }
    const holder = openClaims(poolId).find((c) => c.member && samePath(c.member, path))
    if (holder) {
      kept.push({ path, reason: `held by ${holder.holder}` })
      continue
    }
    if ([...liveDirs, ...claimedDirs].some((dir) => under(dir, path))) {
      kept.push({ path, reason: 'a live session is working here' })
      continue
    }
    try {
      const parked = await parkWorkspace(project, path)
      if (parked === null) {
        const state = await workspaceState(path, base)
        const dirty = state.dirtyFiles.length + state.untrackedFiles.length
        if (dirty > 0) {
          kept.push({ path, reason: `holds ${dirty} uncommitted file(s) that could not be made safe` })
          continue
        }
      }
      await git(project.root, ['worktree', 'remove', '--force', path])
    } catch (err) {
      kept.push({ path, reason: `could not remove it: ${errorMessage(err)}` })
      continue
    }
    removed.push(path)
  }

  try {
    await git(project.root, ['worktree', 'prune'])
  } catch (err) {
    log.warn(`could not prune worktree metadata for ${project.name}:`, err)
  }
  // Best-effort: an empty root dir is clutter. `rmSync` without `recursive` refuses a
  // non-empty one, so something somebody else put there is never touched.
  try {
    rmSync(policy.workspaceRoot, { recursive: false })
  } catch {
    // Still in use, or never existed. Either way there is nothing to do.
  }
  if (removed.length > 0) {
    const members = (getResource(poolId)?.members ?? []).filter(
      (m) => !removed.some((r) => samePath(r, m))
    )
    upsertResource({
      id: poolId,
      projectId: project.id,
      kind: 'counted',
      label: `${project.name} workspaces`,
      capacity: members.length,
      members,
      meta: { vcs: 'git', root: policy.workspaceRoot }
    })
  }
  return { removed, kept }
}

export async function claimWorkspace(
  project: Project,
  holder: string,
  /** The worktree this task's live session is already sitting in, when it has one. */
  preferPath?: string
): Promise<Workspace | null> {
  await ensurePool(project)
  const taken = claim(workspacePoolId(project.id), holder, 1, preferPath)
  if (!taken?.member) {
    if (taken) release(taken.id)
    return null
  }
  const index = Number.parseInt(taken.member.replace(/^.*ws/, ''), 10)
  return { claimId: taken.id, path: taken.member, index: Number.isFinite(index) ? index : 1 }
}

/**
 * The workspace a resting task deliberately kept for its next turn.
 *
 * An `awaiting_human` task can outlive the process that was working in its tree. Its claim moves
 * back from that session to the task, rather than going back into the pool for another task to take
 * while the operator decides. The next dispatch must find that same claim and hand it to its new
 * session; claiming a second member would both exceed the pool and lose the branch the task owns.
 */
export function workspaceHeldBy(project: Project, holder: string): Workspace | null {
  const trunk = openClaims(trunkResourceId(project.id)).find((claim) => claim.holder === holder)
  if (trunk) return { claimId: trunk.id, path: trunk.member ?? project.root, index: 0, kind: 'trunk' }
  const held = openClaims(workspacePoolId(project.id)).find((claim) => claim.holder === holder)
  if (!held?.member) return null
  const index = Number.parseInt(held.member.replace(/^.*ws/, ''), 10)
  return { claimId: held.id, path: held.member, index: Number.isFinite(index) ? index : 1 }
}

// ---------------------------------------------------------------------------- the trunk lease

/**
 * Declare the project's checkout as a resource of one. Idempotent, and cheap: a row upsert.
 *
 * ⚠️ Declared for every git project, whatever its mode, because the *landing* side asks it too: a
 * worktree landing into the trunk must wait while a trunk task holds it (`trunkHolder`).
 */
export function ensureTrunk(project: Project): void {
  upsertResource({
    id: trunkResourceId(project.id),
    projectId: project.id,
    kind: 'counted',
    label: `${project.name} trunk`,
    capacity: 1,
    members: [project.root],
    meta: { vcs: project.vcs }
  })
}

/**
 * Take the trunk for a trunk-mode task, or null when somebody already has it.
 *
 * ⛔ **One holder, ever.** Two agents editing one working tree cannot be isolated by anything short
 * of git, and git cannot help inside a single checkout — so the second trunk task holds, visibly,
 * exactly as a task waiting for a pool member does.
 */
export function claimTrunk(project: Project, holder: string): Workspace | null {
  ensureTrunk(project)
  const taken = claim(trunkResourceId(project.id), holder, 1)
  if (!taken) return null
  return { claimId: taken.id, path: taken.member ?? project.root, index: 0, kind: 'trunk' }
}

/** Whoever holds the trunk right now, if anybody. ⚠️ A read; never declares the resource. */
export function trunkHolder(project: Project): ResourceClaim | null {
  return openClaims(trunkResourceId(project.id))[0] ?? null
}

/** What the trunk checkout is in the middle of, if anything. */
export type TrunkOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface TrunkSurvey {
  /** The branch checked out, or null on a detached HEAD or an unreadable repository. */
  branch: string | null
  dirtyFiles: string[]
  untrackedFiles: string[]
  operation: TrunkOperation | null
  /** Conflicted paths, when an operation stopped on them. */
  conflicted: string[]
}

/**
 * What a trunk task is about to walk into.
 *
 * ⛔ **Measured and said, never tidied.** A trunk task is dispatched onto whatever the checkout holds
 * (decided 2026-09-12: pulling main and resolving the conflict *is* the job that motivated the mode),
 * so the prompt names every one of these, and the finish subtracts the files that were already here.
 * ⚠️ Never throws: an unreadable reading is an empty one, and the agent is still told the branch.
 */
export async function surveyTrunk(project: Project): Promise<TrunkSurvey> {
  const survey: TrunkSurvey = { branch: null, dirtyFiles: [], untrackedFiles: [], operation: null, conflicted: [] }
  if (project.vcs !== 'git') return survey
  const state = await workspaceState(project.root, policyFor(project).landingTarget)
  survey.branch = state.branch
  survey.dirtyFiles = state.dirtyFiles
  survey.untrackedFiles = state.untrackedFiles
  const marker = async (name: string): Promise<boolean> => {
    try {
      const path = await git(project.root, ['rev-parse', '--git-path', name])
      return existsSync(resolve(project.root, path))
    } catch {
      return false
    }
  }
  if ((await marker('rebase-merge')) || (await marker('rebase-apply'))) survey.operation = 'rebase'
  else if (await marker('MERGE_HEAD')) survey.operation = 'merge'
  else if (await marker('CHERRY_PICK_HEAD')) survey.operation = 'cherry-pick'
  else if (await marker('REVERT_HEAD')) survey.operation = 'revert'
  if (survey.operation) {
    try {
      survey.conflicted = (await git(project.root, ['diff', '--name-only', '--diff-filter=U']))
        .split(/\r?\n/)
        .filter(Boolean)
    } catch {
      // No conflicted paths to name.
    }
  }
  return survey
}

export function releaseWorkspace(claimId: string): void {
  release(claimId)
}

/**
 * The pool member that still has this branch checked out, claimed or not.
 *
 * ⛔ **Because a branch outlives the claim on the tree it sits in.** A conversation's workspace goes
 * back to the pool when its session ends, and the worktree keeps the branch — and every uncommitted
 * file on it. Anything that asks "where is this task's work" by looking only at the claims gets
 * *nowhere* as an answer while the files are sitting in ws2, which is how t280's thread told an
 * operator to press a Commit button it had already decided not to draw.
 *
 * ⛔ **Reads the pool as declared, and never `ensurePool`.** This is asked to render a card, and a
 * read that creates worktrees is not a read. A project whose pool has never been built has no
 * members and gets `null`, which is the truthful answer at that moment.
 *
 * ⚠️ Returns the whole `WorkspaceState`, not a path: every caller wants what is *in* the tree, and
 * handing back a path would make them read it a second time to find out.
 */
export async function workspaceOnBranch(
  project: Project,
  branch: string,
  target: string
): Promise<WorkspaceState | null> {
  if (project.vcs !== 'git') return null
  for (const path of availability(workspacePoolId(project.id))?.resource.members ?? []) {
    const state = await workspaceState(path, target)
    if (state.branch === branch) return state
  }
  return null
}

/**
 * `warmstart/t<seq>-<slug>` - the task's name, never the workspace's.
 *
 * ⛔ **`unit` is the landing counter, and 1 writes the name this has always written.** A branch that
 * lands is retired, so a task that lands twice needs a second name — `warmstart/t343.2-<slug>`, then
 * `.3` — cut from the target its previous landing moved. Every caller passes the task's own
 * `branchUnit`, which is 1 for every task that has not landed and gone on working.
 *
 * ⚠️ The dot is inside the `t<seq>` token on purpose: `taskSeqFromBranch` and `seqFromBranch` both
 * read the seq back out of a branch name, and a suffix that looked like part of the slug would make
 * a numbered branch unattributable to the task that owns it.
 */
export function branchNameFor(seq: number, title: string, unit = 1): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `warmstart/t${seq}${unit > 1 ? `.${unit}` : ''}${slug ? `-${slug}` : ''}`
}

export interface SwitchResult {
  ok: boolean
  /** What the tree was on before, so a borrower knows what to put back. */
  from: string | null
  error?: string
}

/**
 * Move an already-prepared worktree to another task's branch, for a conversation being borrowed.
 *
 * ⛔ **Refuses a tree that holds uncommitted work, and this is the rule, not a safety margin.** The
 * alternative is stashing to make room — which takes work that is currently *visible* as a loose end
 * and hides it inside a stash the next reader has to know to look for. That is the t5 failure with
 * extra steps: a clean commit on a good branch that nothing ever mentioned again. A clean tree is
 * lent out; a dirty one keeps its task, and the borrower starts cold instead.
 *
 * ⚠️ Deliberately lighter than `prepareWorkspace`. No fetch and no `prepare` hooks: this tree is
 * already set up — the install has run, the dependencies are there — and re-running a project's
 * `npm install` to change branches would make borrowing cost more than the cold start it replaces.
 *
 * ⚠️ Also deliberately without `rescueDirt`. `prepareWorkspace` stashes on the way *in* because a
 * pool member does not arrive clean and the previous holder is gone. Here the previous holder is a
 * live conversation that is coming back, and rescuing its dirt out from under it is precisely what
 * the refusal above exists to prevent.
 */
/**
 * Where the trunk's landing target stands right now.
 *
 * ⛔ Read in the **trunk**, not in a worktree. The whole point is to notice work appearing somewhere
 * no agent was given, and a pooled worktree cannot see its own absence.
 *
 * ⚠️ Returns null rather than throwing, and null means *no reading* — a project with no git, a
 * target branch that does not exist yet, a repository mid-rebase. Every caller must treat null as
 * "cannot say" and never as "nothing changed", which is the direction this fails safe in.
 */
export async function trunkTargetSha(project: Project, target: string): Promise<string | null> {
  if (project.vcs !== 'git') return null
  try {
    const sha = await git(project.root, ['rev-parse', '--verify', `refs/heads/${target}`])
    return sha.trim() || null
  } catch {
    return null
  }
}

/**
 * Does this branch exist in the repository at all?
 *
 * ⛔ **A measurement, and the one that tells *"I could not look"* apart from *"there is nothing
 * there"*.** `pendingWorkFor` answers *"could not read this task's workspace"* whenever no pool
 * member has the branch checked out — which is right while the branch still exists somewhere else,
 * and flatly wrong the moment it does not. A branch that is not in `refs/heads` holds no
 * uncommitted files and no unlanded commits, because it holds nothing: there is no tree to read and
 * no reading to fail. Reported as zero work, not as a failed look.
 *
 * ⚠️ Read in the trunk, which is where refs live: a worktree shares them, so either would answer,
 * and the trunk is the one that always exists.
 */
export async function branchExists(project: Project, branch: string): Promise<boolean> {
  if (project.vcs !== 'git') return false
  try {
    await git(project.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * The commits the trunk's target gained between two readings, newest first.
 *
 * ⚠️ Subjects only, and capped. This goes into a message a person reads; forty commit lines in a
 * task thread is a wall nobody finishes.
 */
export async function trunkCommitsSince(
  project: Project,
  from: string,
  to: string
): Promise<string[]> {
  try {
    const out = await git(project.root, ['log', '--oneline', '--no-decorate', `${from}..${to}`])
    return out.split(/\r?\n/).filter(Boolean).slice(0, 10)
  } catch {
    return []
  }
}

export async function switchResidentBranch(
  project: Project,
  path: string,
  branch: string,
  /** ⛔ The task the branch belongs to, so a subtask still borrows onto its parent's base. */
  task?: Task | null
): Promise<SwitchResult> {
  const state = await workspaceState(path, landingTargetFor(task, project))
  if (state.branch === branch) return { ok: true, from: branch }

  const loose = [...state.dirtyFiles, ...state.untrackedFiles]
  if (loose.length > 0) {
    return {
      ok: false,
      from: state.branch,
      // ⚠️ Names the files. "Could not switch" sends somebody to look; this tells them where.
      error:
        `${path} holds ${loose.length} uncommitted file(s) on ${state.branch ?? 'a detached head'}` +
        ` — ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', …' : ''}`
    }
  }

  try {
    // ⛔ The task's base, not the project's. A split child whose branch does not exist yet is cut
    // here, and cutting it from `main` would give it a workspace that cannot see its siblings' work —
    // the same defect `baseRef`'s own comment describes, one call site over.
    const base = await baseRef(project, task)
    // Git refuses to check one branch out into two worktrees, correctly. A leftover holder is parked.
    cleanStaleGitLocks(path)
    await parkOtherHolders(project, branch, path)
    if (await gitOk(path, ['rev-parse', '--verify', branch])) {
      await git(path, ['switch', branch])
      await catchUpEmptyBranch(path, branch, base)
    } else {
      await git(path, ['switch', '-c', branch, base])
    }
    return { ok: true, from: state.branch }
  } catch (err) {
    return { ok: false, from: state.branch, error: errorMessage(err) }
  }
}

export interface PrepareResult {
  ok: boolean
  branch: string | null
  steps: Array<{ command: string; ok: boolean; output: string }>
  error?: string
}

/**
 * Put a claimed workspace into the state a task expects: fetched, on its own branch cut from the
 * base ref, with the project's `prepare` steps run.
 *
 * The prepare hook exists for a specific trap. A fresh worktree has no `node_modules`, no `.env`, no
 * seeded database. The obvious fix - copying `node_modules` from the trunk - bites later, because a
 * package installed inside a workspace vanishes on the next sync. So preparation is *declared* by the
 * project and re-run on claim, rather than patched.
 */
/**
 * Move a branch that carries **nothing of its own** up to the current base.
 *
 * ⛔ **`--ff-only`, and only at zero commits ahead.** Both halves are the safety. A branch with no
 * commits the base does not already have is a *name* and nothing else — that is the same licence
 * `retireBranch` deletes on — so fast-forwarding it discards, by construction, nothing. Git refuses
 * the fast-forward if that reading is somehow wrong, which makes the guarantee git's rather than
 * this function's.
 *
 * ⭐ The case this exists for is the second dispatch of a task whose first run produced no commits:
 * the branch already exists, so the `switch -c … base` above is skipped, and the branch keeps
 * pointing at wherever the trunk stood the *first* time — which on a busy fleet is many landings
 * ago. The task then rebases that whole gap at the end, for work it never did.
 *
 * ⚠️ Best-effort, silently. A branch that will not fast-forward is a branch with real work on it,
 * which is the normal case and not a problem to report.
 */
async function catchUpEmptyBranch(path: string, branch: string, base: string): Promise<void> {
  try {
    const ahead = Number(await git(path, ['rev-list', '--count', `${base}..${branch}`]))
    if (ahead !== 0) return
    if (await git(path, ['status', '--porcelain'])) return
    await git(path, ['merge', '--ff-only', base])
    log.info(`fast-forwarded empty branch ${branch} to ${base}`)
  } catch {
    // The branch has work, or the base does not resolve. Either way, leave it exactly as it is.
  }
}

/**
 * Leave the workspace, its git metadata and the shared refs writable to the next sandboxed run.
 *
 * ⛔ The mechanism, the measurement and the 7.2 s are in `acl.ts`. What is decided here is *where*:
 * the workspace tree (recursive), the `.git/worktrees/<slot>` directory it points at (recursive —
 * `index`, `HEAD` and `ORIG_HEAD` are rewritten by every commit), and the common `.git`'s `refs`
 * and `logs` trees plus its top-level files. ⭐ Measured 2026-09-13: `refs/heads/warmstart/t400-…`
 * in the trunk's `.git` was owned by `CodexSandboxOffline`, because a commit replaces a ref by
 * renaming a lock file over it, and the ref a sandboxed run wrote is one the next run cannot
 * replace. The object store is never walked: objects are immutable, and it is the one directory
 * large enough to make the sweep cost minutes rather than seconds.
 */
export async function cleanWorkspaceAcls(workspacePath: string): Promise<void> {
  if (process.platform !== 'win32') return
  const roots: { path: string; recursive: boolean }[] = []
  try {
    if (existsSync(workspacePath)) roots.push({ path: workspacePath, recursive: true })
    const pointer = worktreePointer(workspacePath)
    if (pointer && existsSync(pointer.resolved)) {
      roots.push({ path: pointer.resolved, recursive: true })
      const commonFile = join(pointer.resolved, 'commondir')
      if (existsSync(commonFile)) {
        const common = resolve(pointer.resolved, readFileSync(commonFile, 'utf8').trim())
        roots.push({ path: common, recursive: false })
        roots.push({ path: join(common, 'refs'), recursive: true })
        roots.push({ path: join(common, 'logs'), recursive: true })
      }
    }
    await sweepAcls(roots)
  } catch (err) {
    // Best-effort ACL hygiene: a workspace this cannot read is one the switch below will explain.
    log.warn(`ACL sweep of ${workspacePath} was skipped:`, err)
  }
}

/**
 * Rewrite a file's content without recreating it.
 *
 * ⛔ Git for Windows marks a worktree's `.git` file **hidden** (`core.hideDotFiles`), and Node's
 * `writeFileSync` opens with `CREATE_ALWAYS`, which Windows refuses on a hidden file with `EPERM`.
 * Opening for update and truncating keeps the attributes and works.
 */
function overwriteInPlace(file: string, content: string): void {
  const fd = openSync(file, 'r+')
  try {
    ftruncateSync(fd, 0)
    writeSync(fd, content, 0, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** The `gitdir:` pointer file a linked worktree carries, and where it points on this host. */
export function worktreePointer(
  workspacePath: string
): { file: string; target: string; resolved: string } | null {
  try {
    const file = join(workspacePath, '.git')
    if (!existsSync(file) || statSync(file).isDirectory()) return null
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))
    if (!match?.[1]) return null
    const target = match[1].trim()
    return { file, target, resolved: resolve(workspacePath, target) }
  } catch {
    return null
  }
}

/**
 * Make sure a pool member's `.git` pointer can be followed from here — and from the other side of a
 * WSL boundary.
 *
 * ⛔ **Measured on t410 (2026-09-13).** A Muse Code run, bridged through WSL, found that its own
 * `edit_file` tool refuses every edit in a Windows-made worktree — *"cannot resolve workspace
 * gitdir pointer: No such file or directory"* — because the tool reads `<worktree>/.git` itself and
 * `gitdir: C:/Dev/…` is not a path a Linux process can open; the `GIT_DIR` the daemon exports helps
 * `git` and nothing else. The agent's fix was `printf 'gitdir: /mnt/c/…' > .git`, which is the same
 * file broken the other way: Windows git then answered *not a git repository* for ws3, so the slot
 * could not be parked when it was released, the branch stayed registered to it, and the next
 * dispatch of the task died on *`'<branch>' is already used by worktree at ws3`*.
 *
 * ⭐ Three things, all measured against git 2.54 (Windows) and 2.53 (WSL):
 *  1. `git worktree repair <path>` rewrites a pointer whose target does not resolve — it said
 *     *".git file broken"* and put the Windows spelling back — so a slot an agent has broken is
 *     mended before anything tries to switch it, rather than being lost until a person notices.
 *  2. A **relative** pointer (`gitdir: ../../warmstart/.git/worktrees/ws3`) resolves on both sides
 *     with no environment at all, and `repair` leaves it alone. Every pool member is rewritten to
 *     that form, so a bridged tool that reads the file finds a directory that exists. ⚠️ Whether
 *     Muse's `edit_file` accepts it is *inferred* from its error (an `os error 2` on the resolved
 *     path) and not yet measured against a live run. Only ever relative when the two share a drive;
 *     `relative()` answers an absolute path otherwise and that is kept as it is.
 *  3. ⛔ **The pointer is one of two files, and on Windows both are rewritten.** The admin directory
 *     carries a back-pointer, `.git/worktrees/ws3/gitdir`, which `worktree add` writes as
 *     `C:/Dev/…/ws3/.git`. WSL git cannot open that spelling either, so its `git worktree list`
 *     called every pool member **prunable** (measured 2026-09-14) — and a `git worktree prune`, or
 *     the one `git gc` runs on entries older than `gc.worktreePruneExpire`, would delete the admin
 *     directories of the whole pool from that side. `git worktree repair --relative-paths <path>`
 *     (git ≥ 2.48) rewrites both files relatively, after which the WSL listing is clean and a commit
 *     made there is visible here. ⚠️ Git records that choice in the trunk's config —
 *     `extensions.relativeWorktrees = true` and `repositoryformatversion = 1` — which a git older
 *     than 2.48 refuses to open. That is why this is **win32 only**: it is the platform with two gits
 *     reading one pool, and the one where both are known to be new enough. Elsewhere the pointer
 *     alone is rewritten by hand, as before, and the config is not touched. A git without the flag
 *     falls back to the hand rewrite.
 */
export async function ensureWorktreePointer(project: Project, workspacePath: string): Promise<void> {
  if (project.vcs !== 'git' || samePath(workspacePath, project.root)) return
  let pointer = worktreePointer(workspacePath)
  if (!pointer) return
  if (!existsSync(pointer.resolved)) {
    const broken = pointer.target
    try {
      await git(project.root, ['worktree', 'repair', workspacePath])
    } catch (err) {
      log.warn(`could not repair the .git pointer of ${workspacePath} (it reads ${broken}):`, err)
      return
    }
    pointer = worktreePointer(workspacePath)
    if (!pointer || !existsSync(pointer.resolved)) {
      log.warn(`the .git pointer of ${workspacePath} still does not resolve after repair (it read ${broken})`)
      return
    }
    log.warn(`repaired the .git pointer of ${workspacePath}, which read ${broken}`)
  }
  const back = worktreeBackPointer(pointer.resolved)
  const bothSides = process.platform === 'win32'
  if (!isAbsolute(pointer.target) && !(bothSides && back !== null && isAbsolute(back))) return
  let rel: string
  try {
    const realWorkspace = realpathSync(workspacePath)
    const realResolved = realpathSync(pointer.resolved)
    rel = relative(realWorkspace, realResolved)
  } catch {
    rel = relative(workspacePath, pointer.resolved)
  }
  if (isAbsolute(rel)) return
  if (bothSides) {
    try {
      await git(project.root, ['worktree', 'repair', '--relative-paths', workspacePath])
      const after = worktreePointer(workspacePath)
      if (after && !isAbsolute(after.target) && existsSync(after.resolved)) return
    } catch (err) {
      log.warn(`git could not rewrite the pointers of ${workspacePath} relatively (git 2.48 has --relative-paths); writing .git by hand:`, err)
    }
  }
  if (!isAbsolute(pointer.target)) return
  try {
    overwriteInPlace(pointer.file, `gitdir: ${rel.split(sep).join('/')}\n`)
  } catch (err) {
    log.warn(`could not rewrite the .git pointer of ${workspacePath} as a relative path:`, err)
  }
}

/** The back-pointer a linked worktree's admin directory carries: `<gitdir>/gitdir`, naming `<worktree>/.git`. */
export function worktreeBackPointer(gitDir: string): string | null {
  try {
    return readFileSync(join(gitDir, 'gitdir'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * Take a `core.worktree` that names somewhere other than the trunk out of the trunk's `.git/config`,
 * and say what it named. Null when there was nothing to remove.
 *
 * ⛔ **Measured on t446 and t447 (2026-09-14): both landed nothing, with *"the trunk could not be
 * read: … fatal: Invalid path '/mnt': No such file or directory"*.** The trunk's config had grown
 * `[core] worktree = /mnt/c/Dev/warmstart_workspaces/ws3`. Nobody typed it: a Muse Code run in ws3,
 * bridged through WSL with `GIT_DIR`/`GIT_WORK_TREE` exported into its whole environment, ran
 * `npm test`, and each `git init` the suite's fixtures ran in a temporary directory re-initialised
 * *this* repository instead — `git init` under a foreign `GIT_DIR` writes `core.worktree = $GIT_WORK_TREE`
 * into the **common** config, which for a linked worktree is the trunk's. From then on every Windows
 * git in the trunk refused to start, so no task could land and the operator's own shell could not
 * run `git status`. Reproduced in a scratch repository with one `git init`; the leak itself is closed
 * in `gitEnvFor`, and this is the net for the next thing that writes it.
 *
 * ⚠️ Read and written as text, not through `git config`: git will not answer *anything* about a
 * repository whose `core.worktree` it cannot enter — `git config --unset` fails with the same
 * *Invalid path* — so the file is the only way in. Only the one key is touched; a `[user]` section the
 * same leak wrote is the operator's to judge. A `core.worktree` that resolves to the trunk itself is
 * legitimate and kept, and a trunk that is itself a linked worktree (`.git` is a file) is left alone,
 * because its common config belongs to somebody else's checkout.
 */
export function repairTrunkConfig(project: Pick<Project, 'root' | 'vcs'>): string | null {
  if (project.vcs !== 'git') return null
  const gitDir = join(project.root, '.git')
  const file = join(gitDir, 'config')
  let text: string
  try {
    if (!statSync(gitDir).isDirectory()) return null
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let section = ''
  let removed: string | null = null
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) section = (header[1] ?? '').trim().toLowerCase()
    const entry = header || section !== 'core' ? null : /^\s*worktree\s*=\s*(.*?)\s*$/i.exec(line)
    if (entry) {
      const raw = entry[1] ?? ''
      const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw
      // A POSIX spelling on Windows can only have come from the other side of a WSL boundary.
      const foreign =
        (process.platform === 'win32' && value.startsWith('/')) ||
        !samePath(isAbsolute(value) ? value : resolve(gitDir, value), project.root)
      if (foreign) {
        removed = value
        continue
      }
    }
    kept.push(line)
  }
  if (removed === null) return null
  try {
    overwriteInPlace(file, kept.join('\n'))
    log.warn(
      `removed core.worktree = ${removed} from ${file}: it named somewhere other than the trunk, so every git ` +
        `in ${project.root} was refusing to start; a git run under a leaked GIT_DIR writes that`
    )
  } catch (err) {
    log.warn(`could not remove core.worktree = ${removed} from ${file}:`, err)
    return null
  }
  return removed
}

export async function ensurePlannerBranch(project: Project, branchName: string): Promise<void> {
  if (project.vcs !== 'git') return
  if (!(await gitOk(project.root, ['rev-parse', '--verify', `refs/heads/${branchName}`]))) {
    const base = await baseRef(project)
    await git(project.root, ['branch', branchName, base])
    log.info(`created planner branch ${branchName} from ${base}`)
  }
}

export async function prepareWorkspace(
  project: Project,
  workspace: Workspace,
  branch: string | null,
  /** ⛔ The task, so the base can be its parent's branch when it is a subtask. See `baseRef`. */
  task?: Task | null
): Promise<PrepareResult> {
  // ⛔ The trunk's config first, then the pointer: a trunk whose config names a work tree git cannot
  // enter is not a repository to anything below, and a slot whose `.git` an agent has rewritten is
  // not one either, the ACL sweep included.
  repairTrunkConfig(project)
  cleanStaleGitLocks(workspace.path)
  await ensureWorktreePointer(project, workspace.path)
  await cleanWorkspaceAcls(workspace.path)
  const policy = policyFor(project)
  const steps: PrepareResult['steps'] = []

  if (project.vcs === 'git' && branch) {
    try {
      // A repo with no remote has nothing to fetch; that is fine, not an error.
      if (await gitOk(project.root, ['remote', 'get-url', 'origin'])) {
        await git(workspace.path, ['fetch', 'origin', '--prune'])
      }
      const target = landingTargetFor(task, project)
      if (target && target !== policy.landingTarget) {
        await ensurePlannerBranch(project, target)
      }
      const base = await baseRef(project, task)
      // A task that ran before left its branch checked out in whichever workspace it used. Git will
      // refuse to hand the same branch to a second worktree - correctly - so the stale holder is
      // parked first. This is a retry, not a conflict: the scheduler never runs one task twice at
      // once, so any other worktree still sitting on this branch is a leftover.
      await parkOtherHolders(project, branch, workspace.path)
      // ⛔ Before the switch, not after. A pool member does not arrive clean: `switch --detach`
      // *carries* uncommitted changes with it, so a task that ended without committing leaves its
      // edits sitting in the slot, and the next task to claim that slot dies on `switch -c` with
      // git's "local changes would be overwritten" — an error about files it has never heard of.
      await rescueDirt(workspace.path, branch)
      if (await gitOk(workspace.path, ['rev-parse', '--verify', branch])) {
        await git(workspace.path, ['switch', branch])
        await catchUpEmptyBranch(workspace.path, branch, base)
      } else {
        // ⛔ Created inside the claimed worktree. The trunk is never switched.
        await git(workspace.path, ['switch', '-c', branch, base])
      }
    } catch (err) {
      return {
        ok: false,
        branch: null,
        steps,
        error: errorMessage(err)
      }
    }
  }

  for (const command of policy.prepare) {
    try {
      const { stdout, stderr } = await run(command, {
        cwd: workspace.path,
        shell: true,
        env: workspaceEnv(workspace, policy.env),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 15 * 60 * 1000
      } as never)
      steps.push({ command, ok: true, output: `${stdout}${stderr}`.slice(-2000) })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      steps.push({
        command,
        ok: false,
        output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.slice(-2000)
      })
      return { ok: false, branch, steps, error: `prepare step failed: ${command}` }
    }
  }

  return { ok: true, branch, steps }
}

/**
 * Per-workspace environment, so nothing has to be hand-edited per checkout and no two workspaces can
 * bind the same port. Derived values come from the project's own declarations.
 */
export function workspaceEnv(
  workspace: Workspace,
  projectEnv: Record<string, string | number>
): Record<string, string> {
  const env: Record<string, string> = spawnEnv()
  env[appEnvName('WORKSPACE_INDEX')] = String(workspace.index)
  env[appEnvName('WORKSPACE_PATH')] = workspace.path

  const portBase = Number(projectEnv.portBase)
  const perWorkspace = Number(projectEnv.portsPerWorkspace)
  if (Number.isFinite(portBase) && Number.isFinite(perWorkspace)) {
    env[appEnvName('PORT')] = String(portBase + (workspace.index - 1) * perWorkspace)
  }
  for (const [k, v] of Object.entries(projectEnv)) {
    if (k !== 'portBase' && k !== 'portsPerWorkspace') env[k] = String(v)
  }
  return env
}

/**
 * Detach any *other* worktree that is still sitting on this branch.
 *
 * ⛔ Only pool members are touched, and only when they hold the branch we are about to claim. The
 * trunk is never switched.
 */
export async function parkOtherHolders(
  project: Project,
  branch: string,
  keepPath: string
): Promise<void> {
  let listing: string
  try {
    listing = await git(project.root, ['worktree', 'list', '--porcelain'])
  } catch {
    return
  }

  let path: string | null = null
  for (const line of listing.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && path) {
      const held = line.slice('branch '.length).trim()
      const samePath = normalise(path) === normalise(keepPath) || normalise(path) === normalise(project.root)
      if (held === `refs/heads/${branch}` && !samePath) {
        try {
          // ⚠️ The trunk, not the caller's base. The caller may be cutting a subtask from its
          // parent's branch, and parking a stranger's worktree onto that would be nonsense.
          const base = await trunkBaseRef(project)
          cleanStaleGitLocks(path)
          await ensureWorktreePointer(project, path)
          await rescueDirt(path, base)
          await git(path, ['switch', '--detach', base])
          log.info(`parked ${path}, which still held ${branch}`)
        } catch (err) {
          log.warn(`could not park ${path} off ${branch}:`, err)
        }
      }
    }
  }
}

/**
 * Detach any **pooled** worktree still sitting on this branch, and say whether one is left.
 *
 * ⛔ **Narrower than `parkOtherHolders`, and the narrowness is the whole point.** A branch checked out
 * somewhere is normally a reason to refuse to move it — a worktree that holds a branch is somebody
 * working, and git refuses for good reasons. But a *pool member* is this tool's own, it is claimed by
 * the scheduler or by nothing, and a slot left on a branch after its run ended is litter rather than
 * a person. Only those are parked; the operator's trunk and any worktree they made by hand are left
 * exactly where they are, and the caller's refusal still stands for them.
 *
 * ⭐ **This is what breaks the Plan & Split deadlock.** Phase 1 parks the planner's slot off the plan
 * branch — but "parks" is best-effort, and a slot that failed to park (busy, dirty, or the daemon
 * restarted mid-flight) refuses every child's landing onto that branch for ever. The children then
 * rest at `awaiting_human`, which is not a settled status, so the planner stays `blocked` on them and
 * no part of the plan can move again without a person with a git prompt.
 *
 * ⚠️ Returns the members it could not free, so a caller can distinguish "nothing held it" from "it is
 * held by something I am not allowed to move".
 */
export async function parkPooledHolders(
  project: Project,
  branch: string,
  keepPath: string
): Promise<string[]> {
  if (project.vcs !== 'git') return []
  const members = availability(workspacePoolId(project.id))?.resource.members ?? []
  if (members.length === 0) return []
  const pooled = new Set(members.map(normalise))
  const stuck: string[] = []

  let listing: string
  try {
    listing = await git(project.root, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }

  let path: string | null = null
  for (const line of listing.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && path) {
      const held = line.slice('branch '.length).trim()
      if (held !== `refs/heads/${branch}`) continue
      if (normalise(path) === normalise(keepPath)) continue
      if (!pooled.has(normalise(path))) continue
      try {
        // ⚠️ Detached **at the branch's own tip**, so nothing the slot was holding is left behind and
        // no work is moved: `rescueDirt` commits whatever it finds onto the branch first.
        await ensureWorktreePointer(project, path)
        await rescueDirt(path, branch)
        await git(path, ['switch', '--detach', branch])
        log.info(`parked pooled workspace ${path}, which still held ${branch}`)
      } catch (err) {
        stuck.push(path)
        log.warn(`could not park ${path} off ${branch}:`, err)
      }
    }
  }
  return stuck
}

/**
 * What `rescueDirt` did with the work it found, so a caller can say so.
 *
 * ⚠️ `kind` is the whole point. A **commit** is on the task's branch, so the next run of that task
 * inherits it wherever it is dispatched; a **stash** is a local ref in one repository's object store
 * that nothing but a person reads. See `rescueDirt`.
 */
export interface Rescue {
  kind: 'commit' | 'stash'
  /** The commit, or the stash entry. Either way, the object that holds the work. */
  sha: string
  files: number
  /** The branch it was committed to, or `null` when HEAD was detached and it had to be stashed. */
  branch: string | null
}

/**
 * The trailer that marks a commit **this tool** wrote on an agent's behalf.
 *
 * ⛔ Load-bearing, not decorative: `landing.ts` refuses to land a branch whose tip still carries it,
 * because such a tip is unfinished work nobody compiled, let alone reviewed.
 */
export const RESCUE_TRAILER = 'Multi-Agent-Controller-Rescue'

/**
 * The rescue sitting at a branch tip, if that is what the tip is.
 *
 * ⛔ **One definition of "this is a rescue, not a result", read by everyone who needs it.** Landing
 * refuses such a tip and the dispatcher warns the agent about it; two independent readings of the
 * same trailer would eventually disagree, and the direction they would disagree in is a half-written
 * afternoon on the trunk.
 *
 * ⚠️ Only the tip. A rescue the next run built on top of is ordinary history.
 */
export async function rescueAtTip(path: string): Promise<{ sha: string; files: number } | null> {
  try {
    const body = await git(path, ['log', '-1', '--format=%B', 'HEAD'])
    const found = new RegExp(`^${RESCUE_TRAILER}: ([0-9]+)$`, 'm').exec(body)
    if (!found) return null
    return { sha: await git(path, ['rev-parse', 'HEAD']), files: Number(found[1]) }
  } catch {
    return null
  }
}

/** The branch HEAD is on, or `null` when it is detached. */
async function headBranch(path: string): Promise<string | null> {
  try {
    return (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null
  } catch {
    return null
  }
}

/**
 * Clear the two index bits that tell git to stop looking at the working tree, and return the paths
 * that carried them.
 *
 * ⛔ Measured on t353 and t355, 2026-09-11. Codex's Windows sandbox refused to write `prefs.ts`, so
 * the agent staged its edits straight into the index (`hash-object -w`, `update-index --cacheinfo`),
 * committed, and then ran `update-index --assume-unchanged` on all eleven files so that `git status`
 * would stop reporting the working tree — which still held the *old* content — as modified. It
 * worked: the commit was real and `status --porcelain` came back empty. So `rescueDirt` found nothing
 * to rescue, and the next `switch` in that slot died on *"Your local changes to the following files
 * would be overwritten"* naming every one of them — once parking ws1 for t353's retry, once claiming
 * it for t355. `status` honours the bit; `switch` compares the real stat and refuses.
 *
 * ⚠️ Both bits. `skip-worktree` is what sparse checkout sets and what people reach for when
 * `assume-unchanged` "does not stick"; git refreshes them differently and `switch` fails on either.
 */
async function unhideIndexEntries(path: string): Promise<string[]> {
  let listing: string
  try {
    listing = await git(path, ['ls-files', '-v'])
  } catch {
    return []
  }
  // One tag letter, a space, the path. Uppercase is ordinary; lowercase is assume-unchanged; `S`
  // (lowercase `s` when both) is skip-worktree.
  const hidden = listing
    .split(/\r?\n/)
    .map((line) => /^([a-zS]) (.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[2] as string)
  if (hidden.length === 0) return []
  try {
    await git(path, ['update-index', '--no-assume-unchanged', '--no-skip-worktree', '--', ...hidden])
    const named = hidden.slice(0, 5).join(', ') + (hidden.length > 5 ? ', …' : '')
    log.warn(`${hidden.length} file(s) in ${path} were hidden from git status — ${named}`)
  } catch (err) {
    log.warn(`could not clear assume-unchanged on ${hidden.length} file(s) in ${path}:`, err)
    return []
  }
  return hidden
}

/**
 * Get uncommitted work out of the way of a branch switch — **onto the branch when there is one.**
 *
 * ⛔ **Committed if possible, stashed if not, discarded never.** `reset --hard` would be one line and
 * would silently destroy the only copy of whatever the last run left behind — and the reason a slot is
 * dirty is very often that the last run *failed*, which is exactly when its half-finished edits are
 * worth the most.
 *
 * ⛔ **A stash is not a handoff, and that is the bug this exists for.** Measured on t91 and t92
 * (2026-09-01). Both were preempted mid-run with the whole of their work uncommitted; `parkWorkspace`
 * stashed it, exactly as designed, and both branches were left at the base commit with no commits of
 * their own. The resumed run then checked out that branch, saw nothing, and rebuilt everything from
 * scratch — t92 spent 13.3M tokens re-deriving work that was sitting in `stash@{0}` the whole time,
 * and t91 shipped a narrower fix than the one it had already written. A stash is a **local ref**: it
 * belongs to a repository, not to a branch, so it does not travel to the workspace the next run
 * claims, it is not in `promptFor`, and nothing in the app ever mentions it. The branch is the only
 * thing every later run of a task is guaranteed to see, so the work goes there.
 *
 * ⚠️ **`--no-verify`, deliberately.** This is a rescue, not a contribution. A pre-commit hook that
 * reformats or refuses would turn "your work is safe on the branch" back into "your work is gone",
 * and the hooks still run when the agent commits properly on top and again at landing, where
 * `runChecks` is the gate that actually decides.
 *
 * ⚠️ **The stash is still there for a detached HEAD**, which is what a parked pool member is, and
 * for the case where the commit itself fails — a repository with no `user.email` configured, most
 * likely. `--include-untracked`, not `--all`: a new file an agent wrote counts, and `node_modules`
 * and `out/` are ignored rather than untracked, so they stay where a prepare step put them.
 *
 * ⚠️ Best-effort throughout. A slot that can be neither committed nor stashed is left alone and the
 * switch below fails loudly, as it did before this existed — silently deleting somebody's work to
 * keep the scheduler moving is the one outcome worse than a task that will not start.
 */
async function rescueDirt(path: string, destination: string): Promise<Rescue | null> {
  // ⛔ First, so the status below tells the truth. A file behind `assume-unchanged` is invisible to
  // `status` and fatal to `switch`; see `unhideIndexEntries`.
  const hidden = await unhideIndexEntries(path)
  let dirty: string
  try {
    dirty = await git(path, ['status', '--porcelain'])
  } catch {
    return null
  }
  if (!dirty) return null

  const files = dirty.split(/\r?\n/).filter(Boolean).length
  const label =
    `warmstart: ${files} file(s) left in ${path} before ${destination}` +
    (hidden.length > 0 ? `, ${hidden.length} of them hidden behind assume-unchanged` : '')

  const branch = await headBranch(path)
  // ⛔ Stashed, never committed, when any of it was hidden. The one measured case is the working
  // tree *lagging* a commit made straight into the index: committing that as `wip:` would put a
  // revert of the agent's own work at the tip of its branch, and the next run would land it. Whoever
  // sets the bit is saying the working-tree copy is not the truth, so it goes where nothing lands
  // from — and stays recoverable by name, like every other stash this writes.
  if (branch && hidden.length === 0) {
    try {
      await git(path, ['add', '-A'])
      await git(path, [
        'commit',
        '--no-verify',
        '-m',
        `wip: ${files} file(s) an interrupted run left behind\n\n` +
          'Warmstart committed this so the work would travel with the branch rather ' +
          'than sit in a stash the next run cannot see. Nothing here has been compiled, checked ' +
          'or reviewed. Amend it or build on it; it must not land as it stands.\n\n' +
          `${RESCUE_TRAILER}: ${files}`
      ])
      const sha = await git(path, ['rev-parse', 'HEAD'])
      log.warn(`${label} — committed to ${branch} as ${sha.slice(0, 8)}`)
      return { kind: 'commit', sha, files, branch }
    } catch (err) {
      // ⚠️ Falls through to the stash rather than giving up. `git add -A` may have staged some of it
      // by now, which `stash push` handles perfectly well.
      log.warn(`could not commit the work left in ${path}, stashing it instead:`, err)
    }
  }

  try {
    await git(path, ['stash', 'push', '--include-untracked', '-m', label])
    const sha = await git(path, ['rev-parse', 'refs/stash'])
    log.warn(`${label} — recover with: git stash list`)
    return { kind: 'stash', sha, files, branch: null }
  } catch (err) {
    log.error(`could not stash the uncommitted work in ${path}:`, err)
    return null
  }
}

function normalise(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * Park a workspace: detach it from the task branch so the branch is free for anyone - including a
 * later run of the same task in a different workspace. Best-effort by design; a workspace that
 * cannot be parked is still released, and the next claim re-prepares it.
 */
export async function parkWorkspace(project: Project, path: string): Promise<Rescue | null> {
  if (project.vcs !== 'git') return null
  // ⛔ **Never the trunk.** Parking aborts a rebase, stashes and detaches — three things that must
  // never happen to the operator's checkout, and a trunk task's claim reaches the same release paths
  // a pool member's does. Checked here, at the one function that does the damage, rather than
  // trusted to every caller.
  if (samePath(path, project.root)) return null
  try {
    // ⛔ Before anything asks git about this directory. t410 left ws3's pointer unreadable to
    // Windows git, so the park failed, the slot was released holding its branch, and the task's next
    // dispatch could not take the branch anywhere. See `ensureWorktreePointer`. The trunk's config
    // the same way: a park reads the trunk for its base, and t446 left it unreadable.
    repairTrunkConfig(project)
    await ensureWorktreePointer(project, path)
    const base = await trunkBaseRef(project)
    // ⛔ Blind, and deliberately first. `git switch` **refuses** while a rebase is in progress, so a
    // workspace abandoned mid-rebase can never be parked and the slot is lost until somebody notices
    // by hand. `beginConflictResolution` leaves exactly that state on purpose and every caller is
    // required to undo it — this is the net for the time one of them does not, which is a daemon
    // crash between starting the rebase and sending the prompt.
    // ⚠️ Aborting discards no work: the branch goes back to where the rebase started.
    await gitOk(path, ['rebase', '--abort'])
    const rescued = await rescueDirt(path, base)
    await git(path, ['switch', '--detach', base])
    return rescued
  } catch (err) {
    log.warn(`could not park workspace ${path}:`, err)
    return null
  }
}

export { git as gitIn }

// ---------------------------------------------------------------------------- what is in there

/**
 * Everything a workspace is holding that removing it would destroy.
 *
 * ⛔ **One predicate, asked once, used by everything.** Before 2026-08-28 four code paths each asked
 * a different half of this question: `canLand` asked *is it clean*, `whereTheWorkIs` asked *clean or
 * committed*, `rescueDirt` asked *is there anything to stash*, and the dispatcher asked nothing at
 * all. So a branch carrying real commits with a clean tree - t5's `ea05929` - was invisible to every
 * one of them, and sat unnoticed for a day.
 *
 * ⭐ The three-part definition is the one every serious tool converges on: **changed files, untracked
 * files, and commits that are not on the target.** Claude Code's worktree sweep uses exactly this to
 * decide whether removing a worktree would lose work, and refuses when any part is non-empty.
 *
 * ⚠️ Stashes count too, and they are the part unique to this app: `rescueDirt` takes them
 * automatically, so a slot can look pristine while holding somebody's afternoon in the object store.
 * Preserving work silently is only half a fix - invisible preservation is indistinguishable from
 * loss, which is the whole reason this function exists.
 */
export interface WorkspaceState {
  path: string
  /** `null` when the workspace is parked (detached) and holds no branch. */
  branch: string | null
  /** Tracked files with uncommitted modifications. */
  dirtyFiles: string[]
  /** Files git has never seen. ⚠️ Excludes ignored ones, so `node_modules` is not "work". */
  untrackedFiles: string[]
  /** Commits on this branch that `landedRef` does not have. */
  unlandedCommits: number
  /**
   * The ref `unlandedCommits` was measured against: `origin/<target>` when there is a remote, the
   * local `<target>` when there is not. ⚠️ Carried so that a message can name the ref it compared
   * instead of naming a different one — see the note on `landedRef()`.
   */
  landedRef: string
  /**
   * How far the trunk's local `<target>` is behind `origin/<target>`. ⭐ Not a property of this
   * workspace at all, and here anyway: it is the number that explains why finished work is missing
   * from the operator's checkout, and it is free to read while we are already asking git.
   */
  targetBehind: number
  /** Stashes taken in this repository. ⚠️ Shared across the pool - the object store is one. */
  stashes: number
  /**
   * Task branches named by Git in those stashes.  A stash is repository-wide, but the task it
   * preserves is not: this lets the loose-ends scan omit work for a task that is still live.
   */
  stashBranches?: string[]
}

/**
 * Where work has to have reached to count as landed.
 *
 * ⛔ **`origin/<target>` whenever there is one.** Landing pushes (`landing.ts`) and never moves the
 * local ref, and an agent may push to `origin/<target>` itself — this repo's own `/commit` skill
 * tells it to, and a project's skills are its own business — so the operator's trunk is routinely
 * behind by the time a run finishes. Measuring against the local ref counts work that has already
 * shipped as unlanded.
 *
 * ⚠️ That is not hypothetical. On 2026-08-29 t22's agent pushed `adb7268` to `origin/main` itself;
 * `decideFinish` read the local `main`, counted two unlanded commits and decided `land`, and
 * `landTask` compared against `origin/main` 109ms later, found nothing, and reported "carries no
 * commits that `main` does not already have" — naming a ref it had not looked at. Two reference
 * points in one finish path, and the silent one won. There is one here now, and everything that
 * asks "is this landed?" asks this.
 */
export async function landedRef(path: string, target: string): Promise<string> {
  return (await gitOk(path, ['rev-parse', '--verify', `origin/${target}`]))
    ? `origin/${target}`
    : target
}

/**
 * How many commits on `branch` exist nowhere else — on neither the local `target` nor `origin/<target>`.
 *
 * ⛔ **A different question from `landedRef`, and the loose-ends scan asks this one.** `landedRef`
 * answers *has this work shipped*; a leftover branch asks *what would deleting it lose*. The two part
 * company whenever the local trunk is ahead of its remote, which `commit-and-merge` makes routine and
 * which every report-only branch inherits, because such a branch is cut from the *local* target
 * (`landingbase.ts`). ⭐ Measured 2026-09-12: debate seats t393, t394 and t395 each sat exactly on
 * local `main` at `4619e6f` — no commit of their own — while local `main` was 15 commits ahead of
 * `origin/main`, so all three were listed under Loose ends as carrying 15 unlanded commits.
 *
 * ⚠️ Throws when neither ref resolves, so a caller's "could not measure" stays distinct from zero.
 */
export async function commitsOnlyOn(cwd: string, branch: string, target: string): Promise<number> {
  const refs: string[] = []
  for (const ref of [target, `origin/${target}`]) {
    if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) refs.push(ref)
  }
  if (refs.length === 0) throw new Error(`neither \`${target}\` nor \`origin/${target}\` resolves`)
  const count = Number.parseInt(await git(cwd, ['rev-list', '--count', branch, '--not', ...refs]), 10)
  if (!Number.isFinite(count)) throw new Error(`git could not count the commits on \`${branch}\``)
  return count
}

/**
 * A task branch this repository still has a name for.
 *
 * ⛔ **Repository-wide, which is the whole point.** Everything else in the loose-ends scan reads a
 * *pool member* and reports the branch that member happens to have checked out. A branch nobody has
 * checked out is therefore invisible to all of it — and that is the normal resting state of a branch
 * whose task has finished, because the finish detaches the workspace. So the one leftover the tool
 * creates on every task was the one leftover it could not see.
 *
 * ⚠️ Measured 2026-09-01: `t23` and `t79` had been sitting in this repo since 2026-08-29 and
 * 2026-08-31, both carrying **zero** commits of their own, neither visible anywhere in the app.
 */
export interface TaskBranch {
  branch: string
  taskSeq: number | null
  /**
   * Commits on it that the landed ref does not have. ⭐ Zero means the name is all that is left, and
   * deleting it loses nothing — that is the same licence `retireBranch` runs on.
   */
  ahead: number
  /** The worktree holding it, if any. ⚠️ This is why `git branch -D` refuses, so it is read, not guessed. */
  heldBy: string | null
  /**
   * The commit the name points at, lower-case. ⭐ What a merged pull request is compared against: a
   * squash leaves every commit "ahead", and only an unchanged head proves the name holds nothing new.
   */
  head: string
}

/** Which worktree, if any, has each branch checked out. */
async function branchHolders(root: string): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  let listing: string
  try {
    listing = await git(root, ['worktree', 'list', '--porcelain'])
  } catch {
    return held
  }
  let path: string | null = null
  for (const line of listing.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && path) {
      held.set(line.slice('branch refs/heads/'.length).trim(), path)
    }
  }
  return held
}

/**
 * Every `warmstart/t<n>-…` branch in the repository, and what is on it.
 *
 * ⚠️ Never throws, for the same reason `workspaceState` does not: this is read on a timer and to
 * render a panel, and a repository git cannot answer for must come back empty rather than take the
 * panel down with it.
 */
export async function taskBranches(project: Project, target: string): Promise<TaskBranch[]> {
  if (project.vcs !== 'git') return []
  let names: Array<{ branch: string; head: string }>
  try {
    names = (
      await git(project.root, [
        'for-each-ref',
        '--format=%(objectname) %(refname:short)',
        'refs/heads/warmstart/'
      ])
    )
      .split(/\r?\n/)
      .map((line) => /^([0-9a-f]+) (.+)$/i.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ head: (m[1] as string).toLowerCase(), branch: m[2] as string }))
  } catch {
    return []
  }
  if (names.length === 0) return []

  const holders = await branchHolders(project.root)
  const found: TaskBranch[] = []
  for (const { branch, head } of names) {
    // ⚠️ `null` ahead-count is not zero. A branch git cannot measure is left alone by everything
    // downstream rather than being reported as safe to delete, so the failure is a `-1` nothing acts on.
    // ⛔ Against the local target *and* its remote — see `commitsOnlyOn` for the three seats that
    // were listed as carrying the trunk's own unpushed history.
    let ahead: number
    try {
      ahead = await commitsOnlyOn(project.root, branch, target)
    } catch {
      ahead = -1
    }
    found.push({
      branch,
      taskSeq: seqFromBranch(branch),
      ahead: Number.isFinite(ahead) ? ahead : -1,
      heldBy: holders.get(branch) ?? null,
      head
    })
  }
  return found
}

/**
 * The task a branch was named after, or `null` when the name no longer parses to one.
 *
 * ⚠️ The `.2` of a re-landed conversation's branch is skipped rather than read: the *task* is still
 * t343 however many times it has landed, and a numbered branch that parsed to nothing would drop
 * every stretch of a landing conversation's work out of the loose-ends scan.
 */
function seqFromBranch(branch: string): number | null {
  const match = /\/t(\d+)(?:\.\d+)?-/.exec(branch)
  return match?.[1] ? Number.parseInt(match[1], 10) : null
}

/**
 * Whether a worktree holding a branch is nothing but an idle pool member — unclaimed and clean,
 * exactly what `parkWorkspace` would detach anyway. Shared with `deliveries.ts`'s merged-PR
 * retirement, which asks the identical question about a worktree standing on a delivered branch.
 */
export async function idlePoolHolder(
  project: Project,
  heldBy: string
): Promise<{ poolMember: boolean; claimed: boolean; dirty: boolean }> {
  // ⚠️ Through the real path: `git worktree list` reports the long form, and a root configured through
  // an 8.3 short name (`C:\Users\SUNGHW~1\…`, which is what `os.tmpdir()` returns) never compares equal.
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  const poolMember = samePath(real(dirname(heldBy)), real(policyFor(project).workspaceRoot))
  const claimed = openClaims(workspacePoolId(project.id)).some(
    (claim) => typeof claim.member === 'string' && samePath(real(claim.member), real(heldBy))
  )
  const dirty = poolMember && !claimed ? Boolean(await tryGit(heldBy, ['status', '--porcelain'])) : false
  return { poolMember, claimed, dirty }
}

function heldBranchReason(
  branch: string,
  heldBy: string,
  holder: { poolMember: boolean; claimed: boolean; dirty: boolean }
): string {
  if (!holder.poolMember) {
    return (
      `cannot remove \`${branch}\` because it is active in ${heldBy}. ` +
      'Switch that checkout to another branch, then try again'
    )
  }
  if (holder.claimed) {
    return (
      `cannot remove \`${branch}\` because a task or session is still using ${heldBy}. ` +
      'Stop or finish that work, then try again'
    )
  }
  return (
    `cannot remove \`${branch}\` because ${heldBy} has uncommitted files. ` +
    'Commit or move those files, then try again'
  )
}

/**
 * Delete a task branch that carries nothing.
 *
 * ⛔ **Re-derives its own licence rather than trusting the caller.** `retireBranch` documents that
 * the caller owes the proof, and its callers have just produced one in the same breath. This one is
 * reached from an operator's click on a panel that was scanned some minutes ago, and a branch that
 * has gained a commit since — an agent pushed to it, a resumed task committed — must not be deleted
 * because a stale row said it was empty.
 *
 * ⚠️ Refuses a branch a worktree still holds, unless that worktree is an idle, unclaimed, clean pool
 * member — the same licence the merged-PR sweep already steps off on (`idlePoolHolder`). Anything
 * else (the operator's own trunk, a claimed slot, an uncommitted one) is left alone and reported.
 */
export async function retireStrandedBranch(
  project: Project,
  branch: string,
  target: string
): Promise<{ deleted: boolean; reason?: string }> {
  const state = (await taskBranches(project, target)).find((b) => b.branch === branch)
  if (!state) return { deleted: false, reason: `there is no branch called \`${branch}\`` }
  if (state.heldBy) {
    const holder = await idlePoolHolder(project, state.heldBy)
    if (holder.poolMember && !holder.claimed && !holder.dirty) {
      await git(state.heldBy, ['switch', '--detach', state.head])
    } else {
      return { deleted: false, reason: heldBranchReason(branch, state.heldBy, holder) }
    }
  }
  if (state.ahead !== 0) {
    return {
      deleted: false,
      reason:
        state.ahead < 0
          ? `git could not measure what is on \`${branch}\``
          : `\`${branch}\` carries ${state.ahead} commit(s) the trunk does not have`
    }
  }
  try {
    await git(project.root, ['branch', '-D', branch])
    log.info(`retired ${branch}: every commit on it was already landed`)
    return { deleted: true }
  } catch (err) {
    return { deleted: false, reason: errorMessage(err) }
  }
}

/**
 * Delete a task branch that carries real commits, because the operator decided it is not needed.
 *
 * ⛔ **Unlike `retireStrandedBranch`, this does not require `ahead === 0`.** That function proves the
 * branch is disposable; this one is reached only from an explicit operator click that already knows
 * the branch carries work and wants it gone anyway — the destructive counterpart to **Land it** on
 * the same row, never something the daemon reaches for on its own.
 *
 * ⚠️ Still refuses a branch a worktree holds — an idle pool member excepted, the same licence
 * `retireStrandedBranch` runs on — for the same reason: a checked-out branch is somebody working,
 * and `git branch -D` cannot touch it without switching a checkout that is not this tool's to switch.
 */
export async function deleteUnlandedBranch(
  project: Project,
  branch: string,
  target: string
): Promise<{ deleted: boolean; reason?: string }> {
  const state = (await taskBranches(project, target)).find((b) => b.branch === branch)
  if (!state) return { deleted: false, reason: `there is no branch called \`${branch}\`` }
  if (state.heldBy) {
    const holder = await idlePoolHolder(project, state.heldBy)
    if (holder.poolMember && !holder.claimed && !holder.dirty) {
      await git(state.heldBy, ['switch', '--detach', state.head])
    } else {
      return { deleted: false, reason: heldBranchReason(branch, state.heldBy, holder) }
    }
  }
  try {
    await git(project.root, ['branch', '-D', branch])
    log.info(`deleted ${branch} at the operator's request, discarding ${state.ahead} commit(s)`)
    return { deleted: true }
  } catch (err) {
    return { deleted: false, reason: errorMessage(err) }
  }
}

/** Is there anything here worth a person's attention? */
export function holdsWork(state: WorkspaceState): boolean {
  return (
    state.dirtyFiles.length > 0 ||
    state.untrackedFiles.length > 0 ||
    state.unlandedCommits > 0 ||
    state.stashes > 0
  )
}

/**
 * ⚠️ Never throws. This is read on a timer, on startup, and to render a list; a workspace whose git
 * metadata is broken has to come back as *empty and reported*, not as an exception that takes a
 * panel down. `holdsWork` on an unreadable workspace is false, and the loose-ends list shows the
 * slot with whatever it could read.
 */
export async function workspaceState(path: string, target: string): Promise<WorkspaceState> {
  const state: WorkspaceState = {
    path,
    branch: null,
    dirtyFiles: [],
    untrackedFiles: [],
    unlandedCommits: 0,
    landedRef: target,
    targetBehind: 0,
    stashes: 0,
    stashBranches: []
  }
  if (!existsSync(path)) return state

  try {
    const head = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    state.branch = head === 'HEAD' ? null : head
  } catch {
    return state
  }

  try {
    // ⚠️ `--porcelain` is the stable format; the two-character status field is what separates a
    // tracked modification (` M`, `M `, `MM`) from a file git has never seen (`??`).
    //
    // ⛔ **Parsed by field, not by `slice(3)`.** The status field is two columns wide and a file
    // modified but not staged fills only the second (` M kept.txt`) — so the line begins with a
    // space, and `git()` here **trims its output**. Every such line arrived one character short and
    // every modified file was reported with its first letter missing: `ept.txt`. Untracked files
    // start with `??` and were unaffected, which is why the loose-ends list looked correct — the
    // scan that found the t5 stash never had a modified file in it to get wrong.
    for (const line of (await git(path, ['status', '--porcelain'])).split(/\r?\n/)) {
      const entry = /^(\S{1,2})\s+(.+)$/.exec(line.trim())
      if (!entry) continue
      const [, status, file] = entry as unknown as [string, string, string]
      if (status === '??') state.untrackedFiles.push(file)
      else state.dirtyFiles.push(file)
    }
  } catch {
    // Leave both empty; the caller reports what it has.
  }

  // ⛔ Resolved before the count and kept, so the number and the ref it came from travel together.
  try {
    state.landedRef = await landedRef(path, target)
  } catch {
    // Leave it as the local target; a repo git cannot answer for gets the conservative reading.
  }

  if (state.branch) {
    try {
      // ⛔ Against the landing target, not against `--remotes`. A branch whose commits are already on
      // main is finished, however many commits it carries, and counting them as unlanded work would
      // put every completed task on the loose-ends list forever.
      const commits = await git(path, ['rev-list', '--count', `${state.landedRef}..${state.branch}`])
      state.unlandedCommits = Number.parseInt(commits, 10) || 0
    } catch {
      // A target that does not resolve - a fresh repo with no main yet - is not an error here.
    }
  }

  if (state.landedRef !== target) {
    try {
      const behind = await git(path, ['rev-list', '--count', `${target}..${state.landedRef}`])
      state.targetBehind = Number.parseInt(behind, 10) || 0
    } catch {
      // No local target yet. Nothing to be behind.
    }
  }

  try {
    const stashes = (await git(path, ['stash', 'list', '--format=%gs']))
      .split(/\r?\n/)
      .filter(Boolean)
    state.stashes = stashes.length
    state.stashBranches = stashes.flatMap((subject) => {
      const match = /^(?:On|WIP on) (.+?):/.exec(subject)
      return match?.[1] ? [match[1]] : []
    })
  } catch {
    // No stash ref yet.
  }

  return state
}
