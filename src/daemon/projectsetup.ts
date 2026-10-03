import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ForkHomeResult,
  Project,
  ProjectCloneReadiness,
  ProjectCloneRequest,
  ProjectCloneResult,
  ProjectCreateRequest,
  ProjectCreateResult,
  ProjectDocDraft,
  ProjectDocName,
  ProjectInspection,
  WorkspaceRootReport,
  WorkspaceRootState
} from '@shared/tasks.js'
import { PROJECT_DOC_NAMES, projectFinishChoice } from '@shared/tasks.js'
import { canonicalPath, samePath, withinPath } from './fspath.js'
import { git, remoteUrl, tryGit } from './git.js'
import { launchArgs, spawnEnv, which } from './which.js'
import * as spawn from './spawn.js'
import { cloneSourceFor, gitHubSlug, parseGitHubRepo } from '@shared/github.js'
import { log } from './log.js'
import {
  addProject,
  defaultWorkspaceRoot,
  managedWorkspaceRoot,
  detectVcs,
  listProjects,
  policyFor,
  PROJECT_CONFIG_RELATIVE,
  readProjectConfig,
  relativeWorkspaceRoot,
  reloadProject,
  requireProject,
  setProjectChecks,
  setProjectPolicy,
  writeStarterConfig
} from './projects.js'
import { isEmptyProjectDir, proposeChecks, proposeDocs, suggestProjectName, detectStack } from './projectstack.js'
import { errorMessage } from '@shared/errors.js'
import { contributingGuide } from './orientation.js'

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
  exceptProjectId?: string,
  location: 'managed' | 'custom' = 'custom'
): WorkspaceRootReport {
  const base = canonicalPath(projectRoot)
  const trimmed = chosen?.trim()
  const path = location === 'managed'
    ? managedWorkspaceRoot(base)
    : trimmed ? canonicalPath(resolve(base, trimmed)) : defaultWorkspaceRoot(base)

  let relativeSpelling: string | null = null
  let state: WorkspaceRootState | null = null
  let note: string | null = null
  let takenBy: string | null = null

  try {
    relativeSpelling = location === 'managed' ? null : relativeWorkspaceRoot(base, trimmed ?? '')
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
  workspaceLocation?: 'managed' | 'custom'
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
    contributing: directory ? contributingGuide(root) : null,
    stack: directory ? detectStack(root) : [],
    proposedChecks: directory ? proposeChecks(root) : [],
    workspace: workspaceRootReport(root, input.workspaceRoot, registered?.id,
      input.workspaceLocation ?? (path === null || config?.workspaces?.location === 'managed' ? 'managed' : 'custom'))
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
  const hasConfig = readProjectConfig(root).path !== null
  const workspaceLocation = request.workspaceLocation ??
    (request.workspaceRoot?.trim() ? 'custom' : hasConfig ? undefined : 'managed')
  if (workspaceLocation === 'custom' && !request.workspaceRoot?.trim() && !hasConfig) {
    throw new Error('a custom workspace directory is required')
  }
  if (workspaceLocation === 'managed' || request.workspaceRoot?.trim()) {
    const report = workspaceRootReport(root, request.workspaceRoot, undefined, workspaceLocation ?? 'custom')
    if (!report.usable) {
      throw new Error(report.note ?? `the workspace directory cannot be used: ${report.path}`)
    }
  }

  const project = addProject({ root, name: request.name })

  // ⛔ **Excluded before anything is written**, so there is no moment at which the config is an
  // untracked file in somebody else's repository. `local` is for a checkout of a repo the operator
  // does not own (t897): nothing is committed and no tracked file — not even `.gitignore` — changes.
  const local = request.scaffoldingGit === 'local'
  if (local && project.vcs === 'git') await excludeLocally(project, warnings)

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
    if (workspaceLocation !== 'managed' && request.workspaceRoot !== undefined) {
      policy.workspaceRoot = request.workspaceRoot
    }
    if (workspaceLocation !== undefined) policy.workspaceLocation = workspaceLocation
    if (Object.keys(policy).length > 0) await setProjectPolicyAndPool(project.id, policy)
  } catch (err) {
    // ⛔ Reported, not fatal. The project is registered; a policy that did not write is something an
    // operator can fix on the settings tab, and throwing here would leave a registered project
    // behind an error that says the creation failed.
    warnings.push(`could not write the project policy: ${errorMessage(err)}`)
  }

  // ⚠️ No starter docs in a checkout-only project. A doc written here would be an untracked file in
  // the root that no pooled worktree has, and the cold prompt would name it to agents that cannot
  // open it. A project's own docs are what it committed; the operator's own words go in the seed.
  if (local && (request.docs ?? []).some((d) => d.content.trim())) {
    warnings.push('starter docs are not written into a project kept to this checkout — put your own instructions in Project settings › Cold start instead')
  }
  const docsWritten = local ? [] : writeProjectDocs(project, request.docs ?? [], warnings)

  // ⛔ **A file this wizard just wrote is never left to dirty the trunk.** `.warmstart/project.json`
  // is documented as a *committed* file (data-model.md, glossary.md) so every clone and every landing
  // check sees the same policy — but nothing wrote it to git, so it sat untracked until a landing
  // discovered a dirty trunk and refused to merge, with no indication the block was Warmstart's own
  // doing. Only the files this call actually wrote are staged; anything the operator already had is
  // never touched. ⚠️ Since t554 the operator chooses the config's git fate in the wizard: `commit`
  // stages it beside the starter docs, `ignore` leaves it untracked behind a committed `.gitignore`
  // entry instead. Either way the trunk handed back is clean.
  if (local) {
    // Nothing to commit, by definition — `excludeLocally` already made the config invisible to git.
  } else if (project.vcs === 'git') {
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

/** `.warmstart/` in exclude spelling: the whole directory, since all of it is this machine's. */
const LOCAL_EXCLUDE_ENTRY = '.warmstart/'

/**
 * Keep `.warmstart/` out of git for this checkout only, via the repository's `info/exclude`.
 *
 * ⛔ **`info/exclude`, never `.gitignore`.** The exclude file lives inside the git directory, is
 * never committed or pushed, and is honoured by `git status` — so the trunk stays clean, nothing
 * lands in a pull request, and the upstream repository is not asked to know Warmstart exists.
 * ⚠️ Located with `rev-parse --git-path`, not by joining `.git/info`, because `.git` is a file in a
 * linked worktree or a submodule and the exclude file is wherever git says it is.
 *
 * @returns whether the file was written.
 */
export async function excludeLocally(project: Project, warnings: string[]): Promise<boolean> {
  try {
    const relative = await git(project.root, ['rev-parse', '--git-path', 'info/exclude'])
    const file = resolve(project.root, relative)
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const covered = existing
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\/+/, ''))
      .some((entry) => entry === LOCAL_EXCLUDE_ENTRY || entry === '.warmstart')
    let wrote = false
    if (!covered) {
      mkdirSync(dirname(file), { recursive: true })
      const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
      writeFileSync(file, `${existing}${prefix}# Warmstart's project config, kept to this checkout\n${LOCAL_EXCLUDE_ENTRY}\n`)
      log.info(`${project.name}: excluded ${LOCAL_EXCLUDE_ENTRY} in ${file}`)
      wrote = true
    }
    // ⚠️ Exclusion does not untrack, the same as `.gitignore` — say so rather than let a config the
    // repository already ships be edited into a dirty trunk without a word.
    if (await tryGit(project.root, ['ls-files', '--', '.warmstart'])) {
      warnings.push(
        'this repository already tracks files under .warmstart/, so excluding it does not hide them — ' +
          'a change Warmstart makes to them will show in git status.'
      )
    }
    return wrote
  } catch (err) {
    warnings.push(`could not keep .warmstart/ out of git for this checkout: ${errorMessage(err)}`)
    return false
  }
}

// --------------------------------------------------------------------- cloning

/**
 * What `gh repo fork` names the fork when it adds it — t897's layout, and the moment before
 * `swapToForkHome` makes it `origin`.
 */
export const FORK_REMOTE = 'fork'

/** What the repository a fork was made from is called once the fork is home (t903). */
export const UPSTREAM_REMOTE = 'upstream'

/**
 * Why this machine cannot fork from here, or null when it can.
 *
 * ⛔ Asked of `gh` itself, never assumed: a clean profile has no `gh`, and one that has it may not be
 * signed in. Both are sentences the wizard shows beside a disabled checkbox.
 */
export async function forkBlocked(): Promise<string | null> {
  const gh = which('gh')
  if (!gh) {
    return 'The GitHub CLI (gh) is not installed. Install it and run `gh auth login` to fork from here.'
  }
  try {
    const call = launchArgs(gh, ['auth', 'status', '--hostname', 'github.com'])
    await spawn.run(call.command, call.args, { env: spawnEnv(), timeout: 15_000 })
    return null
  } catch {
    return 'The GitHub CLI (gh) is not signed in to github.com. Run `gh auth login`, then try again.'
  }
}

/** The directory most projects already live in — where a clone most likely belongs. */
export function suggestedCloneParent(): string | null {
  const counts: Array<{ parent: string; count: number }> = []
  for (const project of listProjects(true)) {
    const parent = dirname(project.root)
    if (samePath(parent, project.root)) continue
    const seen = counts.find((c) => samePath(c.parent, parent))
    if (seen) seen.count += 1
    else counts.push({ parent, count: 1 })
  }
  let best: { parent: string; count: number } | null = null
  for (const entry of counts) if (!best || entry.count > best.count) best = entry
  return best?.parent ?? null
}

export async function cloneReadiness(): Promise<ProjectCloneReadiness> {
  return { git: which('git') !== null, forkBlocked: await forkBlocked(), suggestedParent: suggestedCloneParent() }
}

/**
 * Clone a repository to become a project, and fork it on GitHub when asked.
 *
 * ⛔ **Refuses before cloning, warns after.** Everything that would make the clone wrong — a
 * destination with something in it, a root that is already a project, a fork asked of a source that
 * is not on GitHub or of a machine that cannot fork — throws before a byte is fetched. Once the clone
 * exists, a fork that did not happen is a warning: the operator has a working checkout and can add
 * the remote later, which beats a clone the wizard pretends did not happen.
 *
 * ⛔ **A fork is made home: `origin` is the fork, `upstream` the repository cloned** (t903, the
 * operator's decision of 2026-10-03, reversing t897). t897 kept origin as the upstream so that
 * landing measured against it — and that is exactly what made t902 open a pull request on somebody
 * else's repository: every policy that reaches a remote reached *theirs*. With the fork as origin,
 * every finish policy means what it means on a repository the operator owns, and the upstream is
 * reached only by **Propose upstream…**, on a click.
 */
export async function cloneProject(request: ProjectCloneRequest): Promise<ProjectCloneResult> {
  const source = request.source.trim()
  if (!source) throw new Error('name a repository to clone')
  const root = canonicalPath(request.root)

  if (existsSync(root)) {
    if (!isDirectory(root)) throw new Error(`not a directory: ${root}`)
    if (safeEntries(root).length > 0) {
      throw new Error(`${root} is not empty. Clone into a new or empty directory.`)
    }
  }
  const registered = listProjects(true).find((p) => samePath(p.root, root))
  if (registered) throw new Error(`${root} is already the project "${registered.name}"`)

  const upstream = parseGitHubRepo(source)
  if (request.fork) {
    if (!upstream) throw new Error('only a repository on github.com can be forked from here')
    const blocked = await forkBlocked()
    if (blocked) throw new Error(blocked)
  }

  const parent = dirname(root)
  mkdirSync(parent, { recursive: true })
  await git(parent, ['clone', '--', cloneSourceFor(source), root])
  log.info(`cloned ${source} into ${root}`)

  const warnings: string[] = []
  const head = await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const defaultBranch = head?.replace(/^origin\//, '') || (await tryGit(root, ['branch', '--show-current'])) || null

  let upstreamRemote: string | null = null
  let fork: string | null = null
  if (request.fork) {
    try {
      const gh = which('gh')
      if (!gh) throw new Error('gh vanished between the check and the call')
      // ⚠️ Run inside the clone with no repository argument, so gh forks what origin points at and
      // adds the fork under a name of ours. ⛔ Not `--remote-name origin`, although that is the
      // layout this ends in: gh's own rename has not been measured here, and `swapToForkHome` is
      // the same two renames `makeForkHome` does to an existing checkout.
      const call = launchArgs(gh, ['repo', 'fork', '--remote', '--remote-name', FORK_REMOTE])
      await spawn.run(call.command, call.args, {
        cwd: root,
        env: spawnEnv(),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 180_000
      })
      const url = await remoteUrl(root, FORK_REMOTE)
      const parsed = url ? parseGitHubRepo(url) : null
      if (!parsed) throw new Error(`gh reported success but added no \`${FORK_REMOTE}\` remote on github.com`)
      fork = gitHubSlug(parsed)
      log.info(`forked ${source} as ${fork} (remote ${FORK_REMOTE})`)
    } catch (err) {
      warnings.push(
        `cloned, but the fork did not happen: ${errorMessage(err)}. origin is still ${source}, which ` +
          'Warmstart will not push to or open a pull request on by itself.'
      )
    }
    if (fork) {
      try {
        // ⚠️ A fork GitHub has only just created can answer a fetch with nothing for a few
        // seconds; `swapToForkHome` retries, then says so as a warning rather than failing.
        warnings.push(...(await swapToForkHome(root, FORK_REMOTE, defaultBranch, 5)).warnings)
        upstreamRemote = UPSTREAM_REMOTE
      } catch (err) {
        warnings.push(
          `forked as ${fork}, but could not make the fork home: ${errorMessage(err)}. Use Make my fork ` +
            'home in Project settings once this is fixed.'
        )
      }
    }
  }

  return {
    root,
    defaultBranch,
    upstreamRemote,
    upstream: upstream ? gitHubSlug(upstream) : null,
    fork,
    warnings
  }
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Make the fork `origin` and the repository it was forked from `upstream`, in a checkout that has
 * them the other way round (t903).
 *
 * ⛔ **Renames, and nothing else that could lose anything.** `git remote rename` moves the
 * remote-tracking refs and re-points every `branch.<name>.remote` with them; no local branch, commit
 * or worktree is touched. Then each local branch that tracked the upstream is pointed at the fork's
 * branch of the same name when the fork has one, and said when it has not — a branch left tracking
 * `upstream` is how a bare `git push` would send work to the wrong repository.
 *
 * ⚠️ Refuses before renaming anything when either side is not on github.com or `upstream` already
 * exists, so a refusal leaves the checkout exactly as it was.
 */
export async function swapToForkHome(
  root: string,
  forkRemote: string,
  trunk: string | null,
  fetchAttempts = 1
): Promise<{ fork: string; upstream: string; warnings: string[] }> {
  const forkUrl = await remoteUrl(root, forkRemote)
  const originUrl = await remoteUrl(root, 'origin')
  if (!forkUrl) throw new Error(`this checkout has no \`${forkRemote}\` remote`)
  if (!originUrl) throw new Error('this checkout has no origin remote')
  const fork = parseGitHubRepo(forkUrl)
  const upstream = parseGitHubRepo(originUrl)
  if (!fork || !upstream) {
    throw new Error(`both remotes must be on github.com (origin: ${originUrl}; ${forkRemote}: ${forkUrl})`)
  }
  if ((await remoteUrl(root, UPSTREAM_REMOTE)) !== null) {
    throw new Error(`this checkout already has an \`${UPSTREAM_REMOTE}\` remote; rename or remove it first`)
  }

  await git(root, ['remote', 'rename', 'origin', UPSTREAM_REMOTE])
  await git(root, ['remote', 'rename', forkRemote, 'origin'])
  log.info(`${root}: origin is now the fork ${gitHubSlug(fork)}; ${UPSTREAM_REMOTE} is ${gitHubSlug(upstream)}`)

  const warnings: string[] = []
  let fetched = false
  for (let attempt = 1; attempt <= fetchAttempts && !fetched; attempt += 1) {
    try {
      await git(root, ['fetch', 'origin', '--prune'])
      fetched = true
    } catch (err) {
      if (attempt === fetchAttempts) {
        warnings.push(`could not fetch your fork yet (${errorMessage(err)}); the next landing fetches it again.`)
      } else {
        await pause(2000)
      }
    }
  }
  if (trunk && (await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]))) {
    await tryGit(root, ['remote', 'set-head', 'origin', trunk])
  }

  const tracking =
    (await tryGit(root, [
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:remotename)%09%(upstream:remoteref)',
      'refs/heads'
    ])) ?? ''
  for (const line of tracking.split('\n')) {
    const [branch, remote, ref] = line.trim().split('\t')
    if (!branch || remote !== UPSTREAM_REMOTE || !ref) continue
    const name = ref.replace(/^refs\/heads\//, '')
    if (await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])) {
      await git(root, ['branch', `--set-upstream-to=origin/${name}`, branch])
    } else {
      warnings.push(`\`${branch}\` still tracks \`${UPSTREAM_REMOTE}/${name}\`: your fork has no \`${name}\` yet.`)
    }
  }
  return { fork: gitHubSlug(fork), upstream: gitHubSlug(upstream), warnings }
}

/**
 * **Make my fork home** — convert a t897-layout project, whose origin is the upstream and whose
 * fork is `landing.pushRemote`, into the t903 layout. See `swapToForkHome`.
 *
 * ⚠️ `pull-request` becomes `commit-and-push`, because under the new layout a pull request would be
 * opened on the operator's own fork. Any other finish policy is the operator's and stays.
 */
export async function makeForkHome(projectId: string): Promise<ForkHomeResult> {
  const project = requireProject(projectId)
  if (project.vcs !== 'git') throw new Error('only a git project has remotes')
  const policy = policyFor(project)
  if (policy.upstreamRemote) throw new Error(`the fork is already home: the upstream is \`${policy.upstreamRemote}\``)
  const forkRemote = policy.pushRemote ?? FORK_REMOTE
  const swapped = await swapToForkHome(project.root, forkRemote, policy.landingTarget)
  const updated = setProjectPolicy(projectId, {
    pushRemote: null,
    upstreamRemote: UPSTREAM_REMOTE,
    ...(projectFinishChoice(project) === 'pull-request' ? { finish: 'commit-and-push' as const } : {})
  })
  return { project: updated, ...swapped }
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
