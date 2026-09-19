import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { git } from './git.js'
import { log } from './log.js'
import {
  addProject,
  defaultWorkspaceRoot,
  detectVcs,
  listProjects,
  policyFor,
  PROJECT_CONFIG_RELATIVE,
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
  let configFreshlyWritten = false
  try {
    // ⚠️ The starter first, so a brand-new project.json carries the whole skeleton — objective,
    // prepare, permission — rather than only the handful of keys the form happened to set. It
    // returns early when the repo already committed one, so an existing config is never clobbered.
    const configFile = join(root, PROJECT_CONFIG_RELATIVE)
    const configExistedBefore = existsSync(configFile)
    configPath = writeStarterConfig(project.id)
    configFreshlyWritten = !configExistedBefore && configPath === configFile
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

  // ⛔ **A file this wizard just wrote is never left to dirty the trunk.** `.warmstart/project.json`
  // is documented as a *committed* file (data-model.md, glossary.md) so every clone and every landing
  // check sees the same policy — but nothing wrote it to git, so it sat untracked until a landing
  // discovered a dirty trunk and refused to merge, with no indication the block was Warmstart's own
  // doing. Only the files this call actually wrote are staged; anything the operator already had is
  // never touched. ⚠️ Since t554 the operator chooses the config's git fate in the wizard: `commit`
  // stages it beside the starter docs, `ignore` leaves it untracked behind a committed `.gitignore`
  // entry instead. Either way the trunk handed back is clean.
  if (project.vcs === 'git') {
    if (request.scaffoldingGit === 'ignore') {
      await ignoreScaffolding(project, docsWritten, warnings)
    } else {
      const scaffolding = [...(configFreshlyWritten ? [PROJECT_CONFIG_RELATIVE] : []), ...docsWritten]
      await commitScaffolding(project, scaffolding, warnings)
    }
  } else if (request.scaffoldingGit === 'ignore') {
    // ⚠️ No repository, so nothing to commit — but the entry is still written: the config sits
    // untracked, which is already what `ignore` asked for, and a later `git init` picks the rule
    // up. Silent on purpose; warning here would hold the wizard open over a choice that holds.
    ensureIgnoreEntry(project.root)
  }

  return { project: reloadProject(project.id), configPath, docsWritten, warnings }
}

/**
 * Commit the scaffolding files this call just wrote, so the trunk it hands back is clean.
 *
 * ⛔ **Only what is actually dirty.** `git status --porcelain` is checked before staging, because a
 * path this function is about to commit could in principle already match what `HEAD` has (an
 * operator re-running create against a project whose scaffolding was committed by hand); staging and
 * committing nothing is quietly correct, not an error.
 */
async function commitScaffolding(project: Project, paths: string[], warnings: string[]): Promise<void> {
  await commitIfDirty(
    project,
    paths,
    'Add Warmstart project scaffolding\n\n' +
      `Warmstart wrote ${paths.join(', ')} for this project and committed them immediately, ` +
      'so the trunk starts clean rather than blocking the first landing on a file nobody knew to commit.',
    warnings,
    (paths) => `could not commit the project scaffolding (${paths.join(', ')}): `
  )
}

async function commitIfDirty(
  project: Project,
  paths: string[],
  message: string,
  warnings: string[],
  blame: (paths: string[]) => string
): Promise<void> {
  if (paths.length === 0) return
  try {
    const dirty = await git(project.root, ['status', '--porcelain', '--', ...paths])
    if (!dirty.trim()) return
    await git(project.root, ['add', '--', ...paths])
    await git(project.root, ['commit', '--no-verify', '-m', message])
    log.info(`${project.name}: committed ${paths.join(', ')}`)
  } catch (err) {
    warnings.push(`${blame(paths)}${errorMessage(err)}`)
  }
}

/** `.warmstart/project.json` in gitignore spelling — forward slashes, the way git writes them. */
const CONFIG_IGNORE_ENTRY = '.warmstart/project.json'

/**
 * Append the config to the root `.gitignore` when it is not already covered there.
 *
 * ⛔ Exact entry or an enclosing directory pattern only. Matching looser — `*.json`, say —
 * would claim coverage the ignore file may not mean, and skipping the entry over that claim
 * re-dirties the trunk. Negations (`!…`) simply do not count as coverage, so a negated entry gets
 * a redundant-but-harmless duplicate rather than a missing rule.
 *
 * @returns whether the file was written.
 */
export function ensureIgnoreEntry(root: string): boolean {
  const ignoreFile = join(root, '.gitignore')
  const existing = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : ''
  let covered = false
  let negated = false
  for (const line of existing.split('\n')) {
    const raw = line.trim()
    const entry = (raw.startsWith('!') ? raw.slice(1) : raw).replace(/^\/+/, '')
    const hits = entry === CONFIG_IGNORE_ENTRY || entry === '.warmstart/' || entry === '.warmstart'
    if (!hits) continue
    if (raw.startsWith('!')) negated = true
    else covered = true
  }
  // ⚠️ Last match wins in gitignore, so a negation anywhere after a rule re-includes the file —
  // and a negation anywhere at all means somebody is hand-editing this rule, so appending the
  // plain entry keeps the file ignored without touching their lines.
  if (covered && !negated) return false
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  writeFileSync(ignoreFile, `${existing}${prefix}${CONFIG_IGNORE_ENTRY}\n`)
  return true
}

/**
 * The `ignore` half of the wizard's git-fate choice: the config stays untracked behind a committed
 * `.gitignore` entry, and the starter docs commit beside that entry, so the trunk handed back is
 * clean without the config ever being staged.
 *
 * ⛔ **An already-tracked config is a warning, not a silent no-op.** `.gitignore` does not untrack,
 * so without the sentence the operator reads a clean trunk and a policy that still lands on every
 * clone — the entry did nothing and said nothing.
 */
async function ignoreScaffolding(project: Project, docsWritten: string[], warnings: string[]): Promise<void> {
  try {
    ensureIgnoreEntry(project.root)
    try {
      await git(project.root, ['ls-files', '--error-unmatch', '--', PROJECT_CONFIG_RELATIVE])
      warnings.push(
        '.warmstart/project.json is already tracked, so the new .gitignore entry does not untrack it — ' +
          'run `git rm --cached .warmstart/project.json` in the project to stop tracking it.'
      )
    } catch {
      // Untracked: the entry does its job and there is nothing to say.
    }
    await commitIfDirty(
      project,
      ['.gitignore', ...docsWritten],
      'Ignore Warmstart project config\n\n' +
        'Warmstart was asked to leave .warmstart/project.json untracked, so it recorded that in ' +
        '.gitignore and committed the rule with the starter docs — the trunk starts clean and the ' +
        'config stays local to this checkout.',
      warnings,
      (paths) => `could not commit the .gitignore rule (${paths.join(', ')}): `
    )
  } catch (err) {
    warnings.push(`could not record .warmstart/project.json in .gitignore: ${errorMessage(err)}`)
  }
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
