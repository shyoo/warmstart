import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type {
  Project,
  ProjectCreateRequest,
  ProjectCreateResult,
  ProjectDocDraft,
  ProjectDocName,
  ProjectInspection,
  WorkspaceRootReport,
  WorkspaceRootState
} from '@shared/tasks.js'
import { PROJECT_DOC_NAMES } from '@shared/tasks.js'
import { canonicalPath, samePath, withinPath } from './fspath.js'
import { log } from './log.js'
import {
  addProject,
  defaultWorkspaceRoot,
  detectVcs,
  listProjects,
  policyFor,
  readProjectConfig,
  relativeWorkspaceRoot,
  reloadProject,
  setProjectChecks,
  setProjectPolicy,
  writeStarterConfig
} from './projects.js'
import { isEmptyProjectDir, proposeChecks, proposeDocs, suggestProjectName, detectStack } from './projectstack.js'
import { errorMessage } from '@shared/errors.js'

/**
 * Adding a project, as a setup step rather than a text box.
 *
 * ⛔ **`addProject` is still the only thing that registers one.** This module is the sequence around
 * it — look at the directory, say what is there, then create the directory, the repo, the config,
 * the checks and the orientation docs in one call. Nothing here duplicates the store; everything
 * that writes goes through the existing writers (`setProjectPolicy`, `setProjectChecks`,
 * `writeStarterConfig`), which are the functions that already know the spellings the resolvers read.
 *
 * ⚠️ **The scaffolding never overwrites.** A file that is already there is reported as skipped, and
 * that is the difference between a setup step and something that can eat somebody's README.
 */

// --------------------------------------------------------------------- looking first

/**
 * What is at the workspace root, and whether the project can be created with it.
 *
 * ⛔ Only three states refuse, and each names what it collided with. The rest are things to *say*:
 * a directory that already holds something is usually a pool from a previous install, and an
 * operator told what is in there can decide that for themselves — refusing would make re-adding a
 * project you had before impossible.
 */
export function workspaceRootReport(
  projectRoot: string,
  chosen: string | undefined,
  /** ⚠️ Excluded from the "taken by" scan, so re-inspecting a project against its own pool is quiet. */
  exceptProjectId?: string
): WorkspaceRootReport {
  const base = canonicalPath(projectRoot)
  const trimmed = chosen?.trim()
  const path = trimmed ? canonicalPath(resolve(base, trimmed)) : defaultWorkspaceRoot(base)

  let relativeSpelling: string | null = null
  let state: WorkspaceRootState | null = null
  let note: string | null = null
  let takenBy: string | null = null

  try {
    relativeSpelling = relativeWorkspaceRoot(base, trimmed ?? '')
  } catch (err) {
    // ⛔ The writer's own refusals, surfaced as a report rather than as a thrown error, because this
    // runs on every keystroke in the form. `relativeWorkspaceRoot` throws for exactly two cases.
    const message = errorMessage(err)
    state = /same drive/.test(message) ? 'other-drive' : 'inside-project'
    note = message
  }

  if (state === null) {
    if (withinPath(base, path)) {
      state = 'inside-project'
      note = samePath(base, path)
        ? 'The workspace directory cannot be the project directory itself.'
        : 'This is inside the project, so every worktree would be a subdirectory of the repository.'
    } else {
      const owner = listProjects(true).find(
        (p) => p.id !== exceptProjectId && samePath(policyFor(p).workspaceRoot, path)
      )
      if (owner) {
        state = 'taken'
        takenBy = owner.name
        note = `${owner.name} already keeps its workspaces here. Two pools in one directory is two projects' worktrees side by side.`
      } else if (!existsSync(path)) {
        state = 'free'
        note = null
      } else if (!isDirectory(path)) {
        state = 'occupied'
        note = 'A file already exists at this path.'
      } else {
        const entries = safeEntries(path)
        if (entries.length === 0) {
          state = 'empty'
          note = null
        } else {
          state = 'occupied'
          note = `This directory already holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${entries.slice(0, 3).join(', ')}${entries.length > 3 ? ', …' : ''}). An existing pool looks like this; anything else will sit beside the worktrees.`
        }
      }
    }
  }

  return {
    path,
    state,
    takenBy,
    usable: state !== 'taken' && state !== 'inside-project' && state !== 'other-drive',
    note,
    relative: relativeSpelling
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeEntries(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Everything the add form needs to open on, read off the disk.
 *
 * ⛔ Reads only. A directory that does not exist is a normal answer — the form offers to create it —
 * and so is one that is already a project, which the form refuses rather than silently reconfiguring.
 */
export function inspectProjectDirectory(input: {
  root: string
  workspaceRoot?: string
}): ProjectInspection {
  const root = canonicalPath(input.root)
  const exists = existsSync(root)
  const directory = exists && isDirectory(root)

  const registered = listProjects(true).find((p) => samePath(p.root, root))
  const { config, path } = directory ? readProjectConfig(root) : { config: null, path: null }

  const docs = Object.fromEntries(
    PROJECT_DOC_NAMES.map((name) => [name, directory && existsSync(join(root, name))])
  ) as Record<ProjectDocName, boolean>

  return {
    root,
    exists,
    isDirectory: directory,
    empty: directory && isEmptyProjectDir(root),
    vcs: directory ? detectVcs(root) : 'none',
    alreadyAdded: registered ? { id: registered.id, name: registered.name } : null,
    suggestedName: directory ? suggestProjectName(root) : basename(root) || root,
    hasConfig: path !== null,
    // ⚠️ Only when it came from a file. `readProjectConfig` answers a bare `{schema_version: 1}` for
    // a project that has none, and handing that to a form as "what the repo says" would present a
    // default as a decision somebody made.
    config: path !== null ? config : null,
    docs,
    stack: directory ? detectStack(root) : [],
    proposedChecks: directory ? proposeChecks(root) : [],
    workspace: workspaceRootReport(root, input.workspaceRoot, registered?.id)
  }
}

/** The starter text for whichever of the three orientation docs this directory is missing. */
export function proposeProjectDocs(input: {
  root: string
  name?: string
  checks?: string[]
  landingTarget?: string
}): ProjectDocDraft[] {
  const root = canonicalPath(input.root)
  const missing = PROJECT_DOC_NAMES.filter((name) => !existsSync(join(root, name)))
  return proposeDocs({
    root,
    name: input.name?.trim() || suggestProjectName(root),
    checks: input.checks ?? proposeChecks(root),
    landingTarget: input.landingTarget?.trim() || 'main',
    missing
  })
}

// --------------------------------------------------------------------- then creating

/**
 * Create a project from what the add wizard decided.
 *
 * ⛔ **One call, because the sequence is the thing that can go wrong.** Registering a project, then
 * writing its policy, then its checks, then its docs is four writes; a renderer driving them as four
 * RPCs has three places to stop halfway and leave a project that is registered and unconfigured,
 * which is exactly the state the wizard exists to avoid.
 *
 * ⚠️ **The two halves fail differently, on purpose.** Anything that would make the project *wrong* —
 * a missing directory nobody asked to create, a root that is already a project, an unusable
 * workspace directory — throws before anything is written. Anything that is merely *incomplete* —
 * `git init` failing, a doc file that turned out to already exist — lands in `warnings`, because
 * having to add the project again from scratch over a scaffold file is a worse outcome than a
 * project that exists and is missing one README.
 */
export async function createProject(request: ProjectCreateRequest): Promise<ProjectCreateResult> {
  const warnings: string[] = []
  const root = canonicalPath(request.root)

  if (!existsSync(root)) {
    if (!request.createDirectory) {
      throw new Error(`directory does not exist: ${root}`)
    }
    mkdirSync(root, { recursive: true })
    log.info(`created ${root} for a new project`)
  } else if (!isDirectory(root)) {
    throw new Error(`not a directory: ${root}`)
  }

  const already = listProjects(true).find((p) => samePath(p.root, root))
  if (already) {
    // ⛔ Refused rather than reconfigured. `addProject` answers an existing root by reloading it,
    // which is right for *adding* and wrong here: this call carries a policy, a check list and a
    // set of files, and applying them to a project somebody set up months ago is not what pressing
    // Create on a form called "Add project" means.
    throw new Error(`${root} is already the project "${already.name}"`)
  }

  const landingTarget = request.policy?.landingTarget?.trim() || 'main'

  if (request.gitInit && detectVcs(root) !== 'git') {
    try {
      // ⚠️ `-b <target>` so the repository's first branch is the one this project is about to call
      // its landing target. A repo initialised on `master` under a policy that lands on `main` is a
      // landing that fails on its first task with a message about a ref that does not exist.
      execFileSync('git', ['init', '-b', landingTarget], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      log.info(`git init -b ${landingTarget} in ${root}`)
    } catch (err) {
      warnings.push(
        `could not initialise a git repository: ${errorMessage(err)}`
      )
    }
  }

  // ⛔ Validated before the project exists. An unusable workspace root is a project that can never
  // claim a workspace, and the form has already been told so — this is the check that makes the
  // refusal true of the RPC and not only of the renderer.
  if (request.workspaceRoot?.trim()) {
    const report = workspaceRootReport(root, request.workspaceRoot)
    if (!report.usable) {
      throw new Error(report.note ?? `the workspace directory cannot be used: ${report.path}`)
    }
  }

  const project = addProject({ root, name: request.name })

  let configPath: string | null = null
  try {
    // ⚠️ The starter first, so a brand-new project.json carries the whole skeleton — objective,
    // prepare, permission — rather than only the handful of keys the form happened to set. It
    // returns early when the repo already committed one, so an existing config is never clobbered.
    configPath = writeStarterConfig(project.id)
    if (request.checks !== undefined) setProjectChecks(project.id, request.checks)
    const policy = { ...request.policy }
    if (request.workspaceRoot !== undefined) policy.workspaceRoot = request.workspaceRoot
    if (Object.keys(policy).length > 0) await setProjectPolicyAndPool(project.id, policy)
  } catch (err) {
    // ⛔ Reported, not fatal. The project is registered; a policy that did not write is something an
    // operator can fix on the settings tab, and throwing here would leave a registered project
    // behind an error that says the creation failed.
    warnings.push(`could not write the project policy: ${errorMessage(err)}`)
  }

  const docsWritten = writeProjectDocs(project, request.docs ?? [], warnings)

  return { project: reloadProject(project.id), configPath, docsWritten, warnings }
}

/**
 * ⚠️ The pool follows the policy here for the same reason it does in `project.setPolicy`: `poolSize`
 * is a number in a file until `ensurePool` turns it into worktrees and a Resource capacity. A
 * project created with a pool of 5 whose Resources panel says 3 is the stale-capacity bug that hold
 * loop was cut for. Imported lazily because `worktrees.ts` reaches back into the scheduler's world.
 */
async function setProjectPolicyAndPool(
  id: string,
  policy: NonNullable<ProjectCreateRequest['policy']>
): Promise<Project> {
  const project = setProjectPolicy(id, policy)
  if (policy.poolSize !== undefined && project.vcs === 'git') {
    try {
      const { ensurePool } = await import('./worktrees.js')
      const members = await ensurePool(project)
      log.info(`${project.name}: workspace pool is now ${members.length} member(s)`)
    } catch (err) {
      // ⚠️ Best-effort, exactly as it is on the settings tab: the operator's choice is written
      // either way, and the next `claimWorkspace` tries again.
      log.error(`could not create the workspace pool for ${project.name}:`, err)
    }
  }
  return project
}

/**
 * Write the orientation docs the operator approved.
 *
 * ⛔ **Never overwrites, and never invents.** A name that is not one of the three is refused, and a
 * file that already exists is skipped with a warning — the form only offers the missing ones, so
 * arriving here means the file appeared between inspecting and creating, and that file is somebody's
 * work.
 */
export function writeProjectDocs(
  project: Project,
  docs: ProjectDocDraft[],
  warnings: string[]
): ProjectDocName[] {
  const written: ProjectDocName[] = []
  for (const doc of docs) {
    if (!PROJECT_DOC_NAMES.includes(doc.name)) {
      warnings.push(`refused to write ${doc.name}: not one of ${PROJECT_DOC_NAMES.join(', ')}`)
      continue
    }
    if (!doc.content.trim()) continue
    const path = join(project.root, doc.name)
    if (existsSync(path)) {
      warnings.push(`${doc.name} already exists and was left alone`)
      continue
    }
    try {
      writeFileSync(path, doc.content.endsWith('\n') ? doc.content : `${doc.content}\n`)
      written.push(doc.name)
    } catch (err) {
      warnings.push(
        `could not write ${doc.name}: ${errorMessage(err)}`
      )
    }
  }
  if (written.length > 0) log.info(`${project.name}: wrote ${written.join(', ')}`)
  return written
}
