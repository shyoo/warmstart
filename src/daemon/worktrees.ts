import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Project } from '@shared/tasks.js'
import { policyFor } from './projects.js'
import { claim, openClaims, release, upsertResource, workspacePoolId } from './resources.js'
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
 * The ref new task branches start from.
 *
 * ⭐ **The same ref work is measured as landed against**, which is why this delegates to
 * `landedRef` rather than repeating its two lines. They were separate copies of one rule until
 * 2026-08-29, and this is exactly the shape of the bug that day produced: two definitions of "where
 * is the trunk really", each defensible, quietly disagreeing. Branch off what a task's work will be
 * judged against, or a resumed task starts behind the work that already landed.
 *
 * ⚠️ `HEAD` only when neither ref resolves — a repository whose first commit is not on the target
 * branch yet. A repo with no remote is normal and must not be a failure.
 */
export async function baseRef(project: Project): Promise<string> {
  const ref = await landedRef(project.root, policyFor(project).landingTarget)
  return (await gitOk(project.root, ['rev-parse', '--verify', ref])) ? ref : 'HEAD'
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

/**
 * The workspace a resting task deliberately kept for its next turn.
 *
 * An `awaiting_human` task can outlive the process that was working in its tree. Its claim moves
 * back from that session to the task, rather than going back into the pool for another task to take
 * while the operator decides. The next dispatch must find that same claim and hand it to its new
 * session; claiming a second member would both exceed the pool and lose the branch the task owns.
 */
export function workspaceHeldBy(project: Project, holder: string): Workspace | null {
  const held = openClaims(workspacePoolId(project.id)).find((claim) => claim.holder === holder)
  if (!held?.member) return null
  const index = Number.parseInt(held.member.replace(/^.*ws/, ''), 10)
  return { claimId: held.id, path: held.member, index: Number.isFinite(index) ? index : 1 }
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
/**
 * On Windows, sandboxed agent runs (e.g. Codex with `--sandbox workspace-write`) apply NTFS ACLs
 * and temporary sandbox user permissions. An interrupted run or sandbox cleanup glitch can leave
 * explicit `(DENY)` ACLs on the workspace or its `.git/worktrees/<slot>` metadata directory, which
 * subsequently causes git locks (`index.lock`, `HEAD.lock`) to fail with Permission Denied.
 * Resetting ACLs on preparation ensures clean inherited permissions.
 */
export function cleanWorkspaceAcls(workspacePath: string): void {
  if (process.platform !== 'win32') return
  try {
    if (existsSync(workspacePath)) {
      execFileSync('icacls', [workspacePath, '/reset', '/t', '/c'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      })
    }
    const dotGit = join(workspacePath, '.git')
    if (existsSync(dotGit) && !statSync(dotGit).isDirectory()) {
      const pointer = readFileSync(dotGit, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/m.exec(pointer)
      if (match?.[1]) {
        const gitDir = resolve(workspacePath, match[1].trim())
        if (existsSync(gitDir)) {
          execFileSync('icacls', [gitDir, '/reset', '/t', '/c'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000
          })
        }
      }
    }
  } catch {
    // Best-effort ACL hygiene
  }
}

export async function prepareWorkspace(
  project: Project,
  workspace: Workspace,
  branch: string | null
): Promise<PrepareResult> {
  cleanWorkspaceAcls(workspace.path)
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
  let dirty: string
  try {
    dirty = await git(path, ['status', '--porcelain'])
  } catch {
    return null
  }
  if (!dirty) return null

  const files = dirty.split(/\r?\n/).filter(Boolean).length
  const label = `multi-agent-controller: ${files} file(s) left in ${path} before ${destination}`

  const branch = await headBranch(path)
  if (branch) {
    try {
      await git(path, ['add', '-A'])
      await git(path, [
        'commit',
        '--no-verify',
        '-m',
        `wip: ${files} file(s) an interrupted run left behind\n\n` +
          'Multi Agent Controller committed this so the work would travel with the branch rather ' +
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
  try {
    const base = await baseRef(project)
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
 * Every `multi-agent-controller/t<n>-…` branch in the repository, and what is on it.
 *
 * ⚠️ Never throws, for the same reason `workspaceState` does not: this is read on a timer and to
 * render a panel, and a repository git cannot answer for must come back empty rather than take the
 * panel down with it.
 */
export async function taskBranches(project: Project, target: string): Promise<TaskBranch[]> {
  if (project.vcs !== 'git') return []
  let names: string[]
  try {
    names = (
      await git(project.root, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/multi-agent-controller/'
      ])
    )
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
  if (names.length === 0) return []

  const base = await landedRef(project.root, target).catch(() => target)
  const holders = await branchHolders(project.root)
  const found: TaskBranch[] = []
  for (const branch of names) {
    // ⚠️ `null` ahead-count is not zero. A branch git cannot measure is left alone by everything
    // downstream rather than being reported as safe to delete, so the failure is a `-1` nothing acts on.
    let ahead: number
    try {
      ahead = Number.parseInt(await git(project.root, ['rev-list', '--count', `${base}..${branch}`]), 10)
    } catch {
      ahead = -1
    }
    found.push({
      branch,
      taskSeq: seqFromBranch(branch),
      ahead: Number.isFinite(ahead) ? ahead : -1,
      heldBy: holders.get(branch) ?? null
    })
  }
  return found
}

/** The task a branch was named after, or `null` when the name no longer parses to one. */
function seqFromBranch(branch: string): number | null {
  const match = /\/t(\d+)-/.exec(branch)
  return match?.[1] ? Number.parseInt(match[1], 10) : null
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
 * ⚠️ Refuses a branch a worktree still holds. `git branch -D` would refuse too; refusing here means
 * the reason reaches the operator instead of a git error message.
 */
export async function retireStrandedBranch(
  project: Project,
  branch: string,
  target: string
): Promise<{ deleted: boolean; reason?: string }> {
  const state = (await taskBranches(project, target)).find((b) => b.branch === branch)
  if (!state) return { deleted: false, reason: `there is no branch called \`${branch}\`` }
  if (state.heldBy) {
    return { deleted: false, reason: `\`${branch}\` is checked out in ${state.heldBy}` }
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
    return { deleted: false, reason: err instanceof Error ? err.message : String(err) }
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
