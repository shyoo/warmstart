import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/tasks.js'
import { policyFor } from './projects.js'
import { claim, release, upsertResource, workspacePoolId } from './resources.js'
import { log } from './log.js'

const run = promisify(execFile)

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
 *  - ⛔ **The branch is named after the task, never the workspace** - `multi-agent-controller/t12-fix-dialog`, not
 *    `agent/ws2-…`. Which workspace a task happened to land in is an implementation detail that must
 *    never reach history, and re-running the task later in a different workspace yields the same name.
 *  - ⛔ **Agents never work in the trunk.** The branch is created *inside* the claimed worktree.
 *
 * A non-git project is a pool of one over its own directory, so nothing downstream needs a special
 * case for "no repo".
 */

export interface Workspace {
  claimId: string
  path: string
  index: number
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
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
 * The ref new task branches start from: `origin/<target>` when there is a remote, the local branch
 * when there is not. A repo with no remote is a normal thing to work in and must not be a failure.
 */
export async function baseRef(project: Project): Promise<string> {
  const target = policyFor(project).landingTarget
  if (await gitOk(project.root, ['rev-parse', '--verify', `origin/${target}`])) {
    return `origin/${target}`
  }
  if (await gitOk(project.root, ['rev-parse', '--verify', target])) return target
  return 'HEAD'
}

/**
 * Create the pool if it is not there, and register it as a counted Resource whose members are the
 * worktree paths. Idempotent - called before every claim, cheap when nothing has to happen.
 */
export async function ensurePool(project: Project): Promise<string[]> {
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

  mkdirSync(policy.workspaceRoot, { recursive: true })
  const base = await baseRef(project)
  const members: string[] = []

  for (let i = 1; i <= policy.poolSize; i++) {
    const path = join(policy.workspaceRoot, `ws${i}`)
    members.push(path)
    if (existsSync(join(path, '.git'))) continue
    try {
      // --detach: a pool member holds no branch at rest, so any task branch is free to be claimed.
      await git(project.root, ['worktree', 'add', '--detach', path, base])
      log.info(`created worktree ${path} from ${base}`)
    } catch (err) {
      log.error(`could not create worktree ${path}:`, err)
      members.pop()
    }
  }

  upsertResource({
    id: poolId,
    projectId: project.id,
    kind: 'counted',
    label: `${project.name} workspaces`,
    members,
    meta: { vcs: 'git', root: policy.workspaceRoot }
  })
  return members
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

export function releaseWorkspace(claimId: string): void {
  release(claimId)
}

/** `multi-agent-controller/t<seq>-<slug>` - the task's name, never the workspace's. */
export function branchNameFor(seq: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `multi-agent-controller/t${seq}${slug ? `-${slug}` : ''}`
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
export async function switchResidentBranch(
  project: Project,
  path: string,
  branch: string
): Promise<SwitchResult> {
  const policy = policyFor(project)
  const state = await workspaceState(path, policy.landingTarget)
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
    const base = await baseRef(project)
    // Git refuses to check one branch out into two worktrees, correctly. A leftover holder is parked.
    await parkOtherHolders(project, branch, path, base)
    if (await gitOk(path, ['rev-parse', '--verify', branch])) {
      await git(path, ['switch', branch])
    } else {
      await git(path, ['switch', '-c', branch, base])
    }
    return { ok: true, from: state.branch }
  } catch (err) {
    return { ok: false, from: state.branch, error: err instanceof Error ? err.message : String(err) }
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
export async function prepareWorkspace(
  project: Project,
  workspace: Workspace,
  branch: string | null
): Promise<PrepareResult> {
  const policy = policyFor(project)
  const steps: PrepareResult['steps'] = []

  if (project.vcs === 'git' && branch) {
    try {
      // A repo with no remote has nothing to fetch; that is fine, not an error.
      if (await gitOk(project.root, ['remote', 'get-url', 'origin'])) {
        await git(workspace.path, ['fetch', 'origin', '--prune'])
      }
      const base = await baseRef(project)
      // A task that ran before left its branch checked out in whichever workspace it used. Git will
      // refuse to hand the same branch to a second worktree - correctly - so the stale holder is
      // parked first. This is a retry, not a conflict: the scheduler never runs one task twice at
      // once, so any other worktree still sitting on this branch is a leftover.
      await parkOtherHolders(project, branch, workspace.path, base)
      // ⛔ Before the switch, not after. A pool member does not arrive clean: `switch --detach`
      // *carries* uncommitted changes with it, so a task that ended without committing leaves its
      // edits sitting in the slot, and the next task to claim that slot dies on `switch -c` with
      // git's "local changes would be overwritten" — an error about files it has never heard of.
      await rescueDirt(workspace.path, branch)
      if (await gitOk(workspace.path, ['rev-parse', '--verify', branch])) {
        await git(workspace.path, ['switch', branch])
      } else {
        // ⛔ Created inside the claimed worktree. The trunk is never switched.
        await git(workspace.path, ['switch', '-c', branch, base])
      }
    } catch (err) {
      return {
        ok: false,
        branch: null,
        steps,
        error: err instanceof Error ? err.message : String(err)
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
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.MULTI_AGENT_CONTROLLER_WORKSPACE_INDEX = String(workspace.index)
  env.MULTI_AGENT_CONTROLLER_WORKSPACE_PATH = workspace.path

  const portBase = Number(projectEnv.portBase)
  const perWorkspace = Number(projectEnv.portsPerWorkspace)
  if (Number.isFinite(portBase) && Number.isFinite(perWorkspace)) {
    env.MULTI_AGENT_CONTROLLER_PORT = String(portBase + (workspace.index - 1) * perWorkspace)
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
async function parkOtherHolders(
  project: Project,
  branch: string,
  keepPath: string,
  base: string
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
 * Get uncommitted work out of the way of a branch switch.
 *
 * ⛔ **Stashed, never discarded.** `reset --hard` would be one line and would silently destroy the
 * only copy of whatever the last run left behind — and the reason a slot is dirty is very often that
 * the last run *failed*, which is exactly when its half-finished edits are worth the most. A stash
 * lives in the shared object store, so `git stash list` from the trunk shows it and `git stash show
 * -p` reads it back.
 *
 * ⚠️ `--include-untracked`, not `--all`: a new file an agent wrote counts, and `node_modules` and
 * `out/` are ignored rather than untracked, so they stay where a prepare step put them.
 *
 * ⚠️ Best-effort. A slot that cannot be stashed is left alone and the switch below fails loudly, as
 * it did before this existed — silently deleting somebody's work to keep the scheduler moving is the
 * one outcome worse than a task that will not start.
 */
async function rescueDirt(path: string, destination: string): Promise<void> {
  let dirty: string
  try {
    dirty = await git(path, ['status', '--porcelain'])
  } catch {
    return
  }
  if (!dirty) return

  const files = dirty.split(/\r?\n/).filter(Boolean).length
  const label = `multi-agent-controller: ${files} file(s) left in ${path} before ${destination}`
  try {
    await git(path, ['stash', 'push', '--include-untracked', '-m', label])
    log.warn(`${label} — recover with: git stash list`)
  } catch (err) {
    log.error(`could not stash the uncommitted work in ${path}:`, err)
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
export async function parkWorkspace(project: Project, path: string): Promise<void> {
  if (project.vcs !== 'git') return
  try {
    const base = await baseRef(project)
    await rescueDirt(path, base)
    await git(path, ['switch', '--detach', base])
  } catch (err) {
    log.warn(`could not park workspace ${path}:`, err)
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
  /** Commits on this branch that the landing target does not have. */
  unlandedCommits: number
  /** Stashes taken in this repository. ⚠️ Shared across the pool - the object store is one. */
  stashes: number
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
    stashes: 0
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

  if (state.branch) {
    try {
      // ⛔ Against the landing target, not against `--remotes`. A branch whose commits are already on
      // main is finished, however many commits it carries, and counting them as unlanded work would
      // put every completed task on the loose-ends list forever.
      const commits = await git(path, ['rev-list', '--count', `${target}..${state.branch}`])
      state.unlandedCommits = Number.parseInt(commits, 10) || 0
    } catch {
      // A target that does not resolve - a fresh repo with no main yet - is not an error here.
    }
  }

  try {
    state.stashes = (await git(path, ['stash', 'list'])).split(/\r?\n/).filter(Boolean).length
  } catch {
    // No stash ref yet.
  }

  return state
}
