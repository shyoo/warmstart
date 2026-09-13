import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalPath, samePath } from './fspath.js'
import { proposeChecks } from './projectstack.js'
import { execFileSync } from 'node:child_process'
import type { LandingStrategyId, Project, ProjectConfig, Task, UnattendedAuthority, Vcs } from '@shared/tasks.js'
import type { ProjectPolicyPatch } from '@shared/tasks.js'
import { readFinishPolicy, trunkPolicyConflict } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'
import { errorMessage } from '@shared/errors.js'

/**
 * Projects.
 *
 * A project is **a directory plus policy**. Git is optional: branching, committing and parallel
 * workspaces are per-project *capabilities*, not universal assumptions, so a research or
 * media-generation project is a first-class citizen with no repo fiction.
 *
 * Policy is committed at `<root>/.warmstart/project.json` so a collaborator, a second machine or a
 * fresh clone reproduces the same behaviour - a repo can ship an agentyard config the way it ships an
 * `.editorconfig`. Runtime state stays private in the app-data database. ⛔ Nothing secret ever goes
 * in the committed file: no credentials, no account identifiers, no absolute paths outside the repo.
 */

export const PROJECT_CONFIG_RELATIVE = join('.warmstart', 'project.json')

/**
 * The pre-rename spelling, **read and never written**.
 *
 * ⛔ This file lives in the *user's own repository*, which is the one place the rename could not
 * reach: `paths.ts` migrated the data directory and `repointIsolationRoots` moved the rows, but a
 * config committed by a pre-rename build is somebody else's tracked file and moving it is not ours
 * to do. So the old path is read indefinitely, and only the new one is ever written.
 *
 * ⚠️ A project whose config went unread does not look like a missing file; it looks like the
 * scheduler misbehaving. t338 (2026-09-10) landed three runs against real checks and then stopped at
 * *"this project defines no check commands"*, and `awardtracker` was only recovered by renaming its
 * directory by hand.
 */
const LEGACY_PROJECT_CONFIG_RELATIVE = join('.multi_agent_controller', 'project.json')

/**
 * The committed config file, newest spelling first, or `null` when there is none - which is normal
 * and not an error.
 *
 * ⛔ **The only place that knows there are two spellings.** Reading, editing and writing a starter
 * each have to agree on which file is authoritative, and three copies of that precedence drifted
 * into three answers the first time round.
 */
function projectConfigPath(root: string): string | null {
  for (const relative of [PROJECT_CONFIG_RELATIVE, LEGACY_PROJECT_CONFIG_RELATIVE]) {
    const path = join(root, relative)
    if (existsSync(path)) return path
  }
  return null
}

const DEFAULTS = {
  poolSize: 3,
  landingStrategy: 'auto-land' as const,
  landingTarget: 'main'
}

interface ProjectRow {
  id: string
  name: string
  root: string
  vcs: string
  config_json: string
  config_path: string | null
  created_at: number
  archived_at: number | null
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    root: r.root,
    vcs: r.vcs as Vcs,
    config: JSON.parse(r.config_json) as ProjectConfig,
    configPath: r.config_path,
    createdAt: r.created_at,
    archivedAt: r.archived_at
  }
}

export function listProjects(includeArchived = false): Project[] {
  const sql = includeArchived
    ? 'select * from projects order by created_at'
    : 'select * from projects where archived_at is null order by created_at'
  return rows<ProjectRow>(db().prepare(sql).all()).map(toProject)
}

export function getProject(id: string): Project | null {
  const r = row<ProjectRow>(db().prepare('select * from projects where id = ?').get(id))
  return r ? toProject(r) : null
}

export function requireProject(id: string): Project {
  const p = getProject(id)
  if (!p) throw new Error(`no project '${id}'`)
  return p
}

/**
 * Read `.warmstart/project.json` if it is there, or the pre-rename one.
 * A missing file is normal, not an error.
 */
export function readProjectConfig(root: string): { config: ProjectConfig; path: string | null } {
  const path = projectConfigPath(root)
  if (!path) return { config: { schema_version: 1 }, path: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectConfig
    return { config: { ...parsed, schema_version: parsed.schema_version ?? 1 }, path }
  } catch (err) {
    // A malformed config must not stop the project loading; it degrades to defaults and says so.
    log.warn(`project config at ${path} did not parse - using defaults:`, err)
    return { config: { schema_version: 1 }, path: null }
  }
}

export function detectVcs(root: string): Vcs {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() === 'true' ? 'git' : 'none'
  } catch {
    return 'none'
  }
}

export function addProject(input: { root: string; name?: string }): Project {
  // ⚠️ Canonical here too, because everything else is derived from it. `resolve` keeps whatever case
  // the caller supplied, and a project added from a shell sitting in `c:\Dev\…` is stored that way
  // forever.
  const root = canonicalPath(input.root)
  if (!existsSync(root)) throw new Error(`directory does not exist: ${root}`)

  const existing = row<ProjectRow>(db().prepare('select * from projects where root = ?').get(root))
  if (existing) return reloadProject(existing.id)

  const { config, path } = readProjectConfig(root)
  const vcs = config.vcs ?? detectVcs(root)
  const name = input.name?.trim() || config.name || basename(root)
  const id = randomUUID()
  const now = Date.now()

  db()
    .prepare(
      `insert into projects (id, name, root, vcs, config_json, config_path, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, name, root, vcs, JSON.stringify(config), path, now)

  log.info(`added project ${name} (${vcs}) at ${root}`)
  const project = requireProject(id)
  emit({ type: 'project.changed', project })
  return project
}

/** Re-read the committed config from disk. Called on demand and before dispatching into a project. */
export function reloadProject(id: string): Project {
  const project = requireProject(id)
  const { config, path } = readProjectConfig(project.root)
  db()
    .prepare('update projects set config_json = ?, config_path = ?, vcs = ? where id = ?')
    .run(JSON.stringify(config), path, config.vcs ?? project.vcs, id)
  const updated = requireProject(id)
  emit({ type: 'project.changed', project: updated })
  return updated
}

/**
 * `reloadProject` for a caller holding only a task's `projectId`, where the project may be gone.
 *
 * ⛔ **The landing decision reads config through this, never through `getProject`.** `config_json`
 * is a cache of a file in the *user's own repo*, and the row is only refreshed on a cold dispatch —
 * a warm session resumes above that line (see `dispatch`), so a task that ran all afternoon on one
 * conversation can reach its finish gate on a config read hours earlier. ⭐ t338, 2026-09-10: the
 * rename moved `.multi_agent_controller/project.json` to `.warmstart/project.json` while a
 * pre-rename daemon was running; its next reload found neither path, cached
 * `{schema_version: 1}`, and the new build never re-read it because every dispatch was warm. Three
 * runs landed against real checks, then the same branch stopped at *"this project defines no check
 * commands"* — a hold with no fault in the work and nothing the agent could do about it.
 */
export function reloadProjectIfPresent(id: string): Project | null {
  return getProject(id) ? reloadProject(id) : null
}

export function archiveProject(id: string): Project {
  db().prepare('update projects set archived_at = ? where id = ?').run(Date.now(), id)
  const project = requireProject(id)
  emit({ type: 'project.changed', project })
  return project
}

/**
 * Write a starter `.warmstart/project.json`. Offered rather than assumed: a project that has not
 * asked for one runs on defaults, and defaults that live in code are easier to change than defaults
 * that have been copied into fifty repositories.
 */
export function writeStarterConfig(id: string): string {
  const project = requireProject(id)
  // ⛔ An existing config is never clobbered, **including a pre-rename one**. A starter written over
  // the top of it would not overwrite the old file, but it would shadow it - `projectConfigPath`
  // prefers the new path - so the project would silently fall back to starter defaults. Returning the
  // old path is also the honest answer to "which file configures this project": that one, until
  // something edits it, at which point `editProjectConfig` promotes it.
  const existing = projectConfigPath(project.root)
  if (existing) return existing

  const dir = join(project.root, '.warmstart')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'project.json')

  const starter: ProjectConfig = {
    schema_version: 1,
    name: project.name,
    vcs: project.vcs,
    objective: 'balanced',
    ...(project.vcs === 'git'
      ? {
          workspaces: { poolSize: DEFAULTS.poolSize },
          // ⚠️ `finish`, not the pre-2026-08-28 `strategy`. A starter file should be written in
          // the spelling the tool actually reasons in; the old one is read for compatibility only.
          landing: { finish: 'inherit' as const, target: DEFAULTS.landingTarget }
        }
      : {}),
    prepare: [],
    // ⛔ Proposed from this project's own `package.json`, and it lands in a file the operator
    // is about to read. An empty list means the verifying policies verify nothing, so the useful
    // default is a suggestion to edit rather than a blank to overlook.
    check: proposeChecks(project.root),
    permission: { allow: [] }
  }
  writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`)
  reloadProject(id)
  return path
}

/**
 * Write a project's check commands into its `project.json`.
 *
 * ⛔ The first write path this app has ever had into that file, so it is deliberately narrow: it
 * reads what is there, replaces exactly one key, and writes it back. Everything else in the file -
 * including comments a person added to their own copy - is whatever `JSON.parse`/`stringify` makes
 * of it, which is why this refuses rather than guessing when the file cannot be parsed.
 *
 * ⚠️ The file is committed to the repository it configures. Changing it here changes it for everyone
 * who pulls, which is correct - the check list is a property of the project, not of this install.
 */
export function setProjectChecks(id: string, checks: string[]): Project {
  return editProjectConfig(id, (config, project) => {
    // ⚠️ Trimmed and emptied of blanks, because a stray empty string in this array is a shell command
    // that runs nothing and fails, which would block every landing on the project.
    config.check = checks.map((c) => c.trim()).filter(Boolean)
    log.info(`project ${project.name}: ${config.check.length} check command(s) written`)
  })
}

/**
 * Read `project.json`, let a caller change part of it, write it back, reload.
 *
 * ⛔ **Narrow on purpose.** It reads what is there, hands the parsed object to one mutator, and
 * writes it back — everything the mutator did not touch survives, and a file that does not parse
 * makes this throw rather than overwrite work somebody hand-edited.
 *
 * ⚠️ The file is committed to the repository it configures, so a change here is a change for
 * everyone who pulls. That is correct: these are properties of the project, not of this install.
 */
function editProjectConfig(
  id: string,
  mutate: (config: ProjectConfig, project: Project) => void
): Project {
  const project = requireProject(id)
  const dir = join(project.root, '.warmstart')
  const path = join(dir, 'project.json')

  // ⛔ Seeded from whichever file `readProjectConfig` would have read, which may be the pre-rename
  // one, and then written to the new path - read old, write new, never write old. Starting from a
  // bare `{schema_version: 1}` because the *new* path is absent would drop every key a pre-rename
  // config had, and the read would have just reported those keys to the UI: the operator would watch
  // the tool forget a setting it was displaying a moment earlier. The old file is left where it is,
  // because it is tracked in a repository that is not ours.
  const source = projectConfigPath(project.root)

  let config: ProjectConfig
  if (source) {
    try {
      config = JSON.parse(readFileSync(source, 'utf8')) as ProjectConfig
    } catch (err) {
      throw new Error(
        `${source} is not valid JSON, so this will not overwrite it: ` +
          (errorMessage(err)),
        { cause: err }
      )
    }
    if (source !== path) {
      log.info(`project ${project.name}: promoting ${source} to ${path}; the old file is now ignored`)
    }
  } else {
    config = { schema_version: 1, name: project.name, vcs: project.vcs }
  }
  mkdirSync(dir, { recursive: true })

  mutate(config, project)
  writeFileSync(path, `${JSON.stringify(config, null, 2)}
`)
  return reloadProject(id) ?? project
}

/**
 * Per-project policy, set from the app rather than by hand-editing JSON.
 *
 * ⛔ **Every field here is one a project may already override in `project.json`** — this writes the
 * same keys the resolvers already read, in the same spellings, so a project configured from the UI
 * and one configured by an editor are the same file. Nothing new is invented at this tier.
 *
 * ⛔ `inherit` is written as the literal string, never as a deleted key. The two are the same to
 * every resolver, but only one of them survives a fleet default changing later with the operator's
 * decision still legible — *this project deliberately follows the fleet* is worth keeping.
 *
 * ⚠️ Validated here rather than trusted from the renderer, because the daemon's RPC surface is not
 * only reachable from it, and a bad `finish` string would resolve to `inherit` silently forever.
 */

export function setProjectPolicy(id: string, patch: ProjectPolicyPatch): Project {
  return editProjectConfig(id, (config, project) => {
    if (patch.finish !== undefined) {
      const finish = readFinishPolicy(patch.finish)
      if (!finish) throw new Error(`not a finish policy: ${String(patch.finish)}`)
      config.landing = { ...config.landing, finish }
      // ⛔ The pre-2026-08-28 key is dropped the moment the new one is set from here. Leaving both
      // would be harmless to `projectFinishChoice`, which prefers `finish` — but a person reading
      // their own committed file would see two answers to one question.
      delete config.landing.strategy
    }
    if (patch.landingTarget !== undefined) {
      const target = patch.landingTarget.trim()
      if (!target) throw new Error('landing target cannot be empty')
      config.landing = { ...config.landing, target }
    }
    if (patch.finishInstruction !== undefined) {
      const instruction = patch.finishInstruction?.trim()
      config.landing = { ...config.landing }
      // ⚠️ Empty means *use the default instruction*, which is an absent key rather than an empty
      // string — `finishInstructionFor` falls back on falsy, and an empty string in the file reads
      // as "this project tells the agent nothing", which is not a thing anybody means.
      if (instruction) config.landing.finishInstruction = instruction
      else delete config.landing.finishInstruction
    }
    if (patch.sessionShare !== undefined) {
      if (!['on', 'off', 'inherit'].includes(patch.sessionShare)) {
        throw new Error(`not a sharing choice: ${String(patch.sessionShare)}`)
      }
      config.session = { ...config.session, share: patch.sessionShare }
    }
    if (patch.completion !== undefined) {
      if (!['autonomous', 'checkpointed', 'inherit'].includes(patch.completion)) {
        throw new Error(`not a completion mode: ${String(patch.completion)}`)
      }
      config.session = { ...config.session, completion: patch.completion }
    }
    if (patch.workspaceMode !== undefined) {
      if (!['worktree', 'trunk'].includes(patch.workspaceMode)) {
        throw new Error(`not a workspace mode: ${String(patch.workspaceMode)}`)
      }
      // ⚠️ `worktree` is written as no key, like the other derived defaults: an absent key already
      // means it, and a file that never mentioned the mode should not gain a line by being saved.
      config.workspaces = { ...config.workspaces, mode: patch.workspaceMode }
      if (patch.workspaceMode === 'worktree') delete config.workspaces.mode
    }
    // ⛔ Checked after both halves of the patch are applied, so turning trunk mode on and the pull
    // request rung off in one save is allowed, and either one alone into the conflict is not.
    if (config.workspaces?.mode === 'trunk' && project.vcs === 'git') {
      const finish = config.landing?.finish ? readFinishPolicy(config.landing.finish) : null
      const conflict = finish && finish !== 'inherit' ? trunkPolicyConflict(finish) : null
      if (conflict) throw new Error(`this project defaults to the trunk: ${conflict}`)
    }
    if (patch.poolSize !== undefined) {
      const size = Math.trunc(patch.poolSize)
      if (!Number.isFinite(size) || size < 1 || size > 32) {
        throw new Error(`workspace pool size must be between 1 and 32, not ${String(patch.poolSize)}`)
      }
      config.workspaces = { ...config.workspaces, poolSize: size }
    }
    if (patch.workspaceRoot !== undefined) {
      const rel = relativeWorkspaceRoot(project.root, patch.workspaceRoot)
      config.workspaces = { ...config.workspaces, root: rel ?? undefined }
      // ⛔ The derived default is written as *no key*, not as a stored copy of itself. A clone in a
      // directory with a different name then derives its own sibling, which is the whole reason
      // `policyFor` derives it rather than storing it.
      if (rel === null) delete config.workspaces.root
    }
    if (patch.prepare !== undefined) {
      config.prepare = patch.prepare.map((c) => c.trim()).filter(Boolean)
    }
    if (patch.unattendedAuthority !== undefined) {
      if (!['full-user', 'sandboxed-only'].includes(patch.unattendedAuthority)) {
        throw new Error(`not an unattended authority: ${String(patch.unattendedAuthority)}`)
      }
      // ⛔ Written either way, including `full-user`. This is the one setting where the *absence* of
      // a key and the permissive value mean the same thing to the resolver but very different
      // things to a reader: an absent key is a project nobody was ever asked about, and a written
      // `full-user` is somebody's decision. Both run the same; only one of them is informed.
      config.permission = { ...config.permission, unattended: patch.unattendedAuthority }
    }
    if (patch.promptOrientation !== undefined) {
      if (!['auto', 'off'].includes(patch.promptOrientation)) {
        throw new Error(`not an orientation choice: ${String(patch.promptOrientation)}`)
      }
      config.prompt = { ...config.prompt, orientation: patch.promptOrientation }
    }
    if (patch.promptSeed !== undefined) {
      const seed = patch.promptSeed?.trim()
      config.prompt = { ...config.prompt }
      // ⚠️ Empty means *this project has no seed*, which is an absent key rather than an empty
      // string — the same rule `finishInstruction` follows. An empty string in a committed file
      // reads as a decision somebody made, and `projectSeedPrompt` would ignore it anyway.
      if (seed) config.prompt.seed = seed
      else delete config.prompt.seed
      // ⚠️ And a `prompt` object left holding nothing is deleted with it, so clearing the seed on a
      // project that never touched `orientation` leaves the file as it was rather than gaining an
      // empty stanza nobody wrote.
      if (Object.keys(config.prompt).length === 0) delete config.prompt
    }
    log.info(`project ${project.name}: policy updated (${Object.keys(patch).join(', ')})`)
  })
}

// ------------------------------------------------------------------ the workspace root

/**
 * Where a project's pooled worktrees go when nothing says otherwise.
 *
 * ⛔ **One derivation, and both the resolver and the wizard read it.** `policyFor` had this inline
 * and the add form needs the same answer *before* a project exists, so a second copy in the
 * renderer would be a second definition of where the worktrees are — the kind of split that put the
 * same directory into `sessions.cwd` under two spellings once already.
 */
export function defaultWorkspaceRoot(root: string): string {
  return canonicalPath(`${canonicalPath(root)}_workspaces`)
}

/**
 * The chosen workspace root as it would be written into the committed file: relative, forward
 * slashed, or `null` for *this is the default, write no key*.
 *
 * ⛔ **Never absolute.** `project.json` is pulled by every clone and every machine; an absolute path
 * in it is a fact about one disk. On win32 a location on another drive has no relative spelling at
 * all, and this refuses rather than falling back to the absolute one.
 */
export function relativeWorkspaceRoot(projectRoot: string, chosen: string): string | null {
  const trimmed = chosen.trim()
  if (!trimmed) return null

  const base = canonicalPath(projectRoot)
  const absolute = canonicalPath(resolve(base, trimmed))
  if (samePath(absolute, defaultWorkspaceRoot(base))) return null
  if (samePath(absolute, base)) {
    throw new Error('the workspace directory cannot be the project directory itself')
  }

  const rel = relative(base, absolute)
  if (!rel || isAbsolute(rel)) {
    throw new Error(
      `the workspace directory must be on the same drive as the project, so it can be recorded ` +
        `relatively in project.json: ${absolute}`
    )
  }
  return rel.split(sep).join('/')
}

// ------------------------------------------------------------------ resolved policy

export interface ProjectPolicy {
  poolSize: number
  workspaceRoot: string
  prepare: string[]
  check: string[]
  /**
   * ⚠️ The pre-2026-08-28 project field, and only a **fallback**. The resolved finish policy
   * chooses the strategy now (`strategyFor`); this is consulted only for `custom`, where the tool is
   * tidying up behind an instruction the agent was given.
   */
  landingStrategy: LandingStrategyId
  landingTarget: string
  allowRules: string[]
  denyRules: string[]
  /**
   * How much authority unattended work may have here. ⛔ An absent key resolves to `full-user`,
   * which is what this project did before the setting existed — see `ProjectConfig.permission`.
   */
  unattendedAuthority: UnattendedAuthority
  env: Record<string, string | number>
}

/**
 * The committed config with defaults filled in. Everything downstream reads this, never the raw
 * JSON, so an absent key and a default value are the same thing to a caller.
 */
/**
 * The ref this task's work lands onto: its own if it has one, otherwise the project's.
 *
 * ⛔ **One resolver, and every reader goes through it.** `landingTarget` had 24 production readers
 * when this was written, and the failure mode of missing one is documented in this repository by
 * name: two reference points in one finish path, and the silent one won — t22, 2026-08-29, where
 * `decideFinish` read the local `main` and `landTask` read `origin/main` 109ms later and the task
 * reported success. A split whose children are *cut from* the plan branch by one path and *measured
 * against* `main` by another reproduces that exactly.
 *
 * ⭐ Provably inert for everything that is not a split: `Task.landingTarget` is null on every row
 * that existed before it, so this returns the project's answer unchanged.
 *
 * ⚠️ Takes a partial task rather than a `Task`, because three of its callers hold nothing else —
 * `baseRef` is asked for a base before the task row is loaded, and widening them all to fetch one
 * would put a query in the dispatch path for a field that is null.
 */
export function landingTargetFor(
  task: Pick<Task, 'landingTarget'> | null | undefined,
  project: Project
): string {
  const own = task?.landingTarget?.trim()
  return own && own.length > 0 ? own : policyFor(project).landingTarget
}

export function policyFor(project: Project): ProjectPolicy {
  const c = project.config
  return {
    // A non-git project is a pool of one over its own directory - no special case anywhere else.
    poolSize: project.vcs === 'git' ? Math.max(1, c.workspaces?.poolSize ?? DEFAULTS.poolSize) : 1,
    // ⛔ Canonical, and note the two branches did not agree before it. `resolve` returns an absolute
    // config value in *its* case, while the fallback concatenates onto `project.root` in whatever
    // case that was stored — so adding a `workspaces.root` to a project.json silently changed the
    // spelling of every worktree path, and this install ended up with the same directory recorded
    // both ways in `sessions.cwd`.
    workspaceRoot: c.workspaces?.root
      ? canonicalPath(resolve(project.root, c.workspaces.root))
      : defaultWorkspaceRoot(project.root),
    prepare: c.prepare ?? [],
    check: c.check ?? [],
    landingStrategy: c.landing?.strategy ?? DEFAULTS.landingStrategy,
    landingTarget: c.landing?.target ?? DEFAULTS.landingTarget,
    allowRules: c.permission?.allow ?? [],
    denyRules: c.permission?.deny ?? [],
    unattendedAuthority: c.permission?.unattended ?? 'full-user',
    env: c.env ?? {}
  }
}
