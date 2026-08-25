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
 *  - ⛔ **The branch is named after the task, never the workspace** - `agentyard/t12-fix-dialog`, not
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

export async function claimWorkspace(project: Project, holder: string): Promise<Workspace | null> {
  await ensurePool(project)
  const taken = claim(workspacePoolId(project.id), holder)
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

/** `agentyard/t<seq>-<slug>` - the task's name, never the workspace's. */
export function branchNameFor(seq: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `agentyard/t${seq}${slug ? `-${slug}` : ''}`
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
  env.AGENTYARD_WORKSPACE_INDEX = String(workspace.index)
  env.AGENTYARD_WORKSPACE_PATH = workspace.path

  const portBase = Number(projectEnv.portBase)
  const perWorkspace = Number(projectEnv.portsPerWorkspace)
  if (Number.isFinite(portBase) && Number.isFinite(perWorkspace)) {
    env.AGENTYARD_PORT = String(portBase + (workspace.index - 1) * perWorkspace)
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
          await git(path, ['switch', '--detach', base])
          log.info(`parked ${path}, which still held ${branch}`)
        } catch (err) {
          log.warn(`could not park ${path} off ${branch}:`, err)
        }
      }
    }
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
    await git(path, ['switch', '--detach', await baseRef(project)])
  } catch (err) {
    log.warn(`could not park workspace ${path}:`, err)
  }
}

export { git as gitIn }
