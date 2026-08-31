import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { canonicalPath } from './fspath.js'
import { execFileSync } from 'node:child_process'
import type { LandingStrategyId, Project, ProjectConfig, Vcs } from '@shared/tasks.js'
import type { ProjectPolicyPatch } from '@shared/tasks.js'
import { readFinishPolicy } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'

/**
 * Projects.
 *
 * A project is **a directory plus policy**. Git is optional: branching, committing and parallel
 * workspaces are per-project *capabilities*, not universal assumptions, so a research or
 * media-generation project is a first-class citizen with no repo fiction.
 *
 * Policy is committed at `<root>/.multi_agent_controller/project.json` so a collaborator, a second machine or a
 * fresh clone reproduces the same behaviour - a repo can ship an agentyard config the way it ships an
 * `.editorconfig`. Runtime state stays private in the app-data database. ⛔ Nothing secret ever goes
 * in the committed file: no credentials, no account identifiers, no absolute paths outside the repo.
 */

export const PROJECT_CONFIG_RELATIVE = join('.multi_agent_controller', 'project.json')

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

/** Read `.multi_agent_controller/project.json` if it is there. A missing file is normal, not an error. */
export function readProjectConfig(root: string): { config: ProjectConfig; path: string | null } {
  const path = join(root, PROJECT_CONFIG_RELATIVE)
  if (!existsSync(path)) return { config: { schema_version: 1 }, path: null }
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

export function archiveProject(id: string): Project {
  db().prepare('update projects set archived_at = ? where id = ?').run(Date.now(), id)
  const project = requireProject(id)
  emit({ type: 'project.changed', project })
  return project
}

/**
 * Write a starter `.multi_agent_controller/project.json`. Offered rather than assumed: a project that has not
 * asked for one runs on defaults, and defaults that live in code are easier to change than defaults
 * that have been copied into fifty repositories.
 */
export function writeStarterConfig(id: string): string {
  const project = requireProject(id)
  const dir = join(project.root, '.multi_agent_controller')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'project.json')
  if (existsSync(path)) return path

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
 * Check commands worth proposing for a project, read from its `package.json`.
 *
 * ⛔ **Proposed, never written.** The check list is what `commit-and-verify` and `commit-and-merge`
 * are trusting when they say work is verified, so it is not something to infer behind somebody's
 * back. This returns a suggestion for a person to accept, edit or ignore.
 *
 * ⚠️ Order matters and is not alphabetical: the cheap, fast checks come first so a red one stops the
 * run before the slow ones start. That is the same order `runChecks` executes in.
 */
const CHECK_ORDER = ['typecheck', 'lint', 'test', 'build']

export function proposeChecks(root: string): string[] {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> }
    const scripts = parsed.scripts ?? {}
    return CHECK_ORDER.filter((name) => typeof scripts[name] === 'string').map(
      (name) => `npm run ${name}`
    )
  } catch {
    // ⚠️ No package.json, or one this cannot read, is not an error. It means there is nothing to
    // propose, and the operator writes the list themselves.
    return []
  }
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
  const dir = join(project.root, '.multi_agent_controller')
  const path = join(dir, 'project.json')

  let config: ProjectConfig
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf8')) as ProjectConfig
    } catch (err) {
      throw new Error(
        `${path} is not valid JSON, so this will not overwrite it: ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err }
      )
    }
  } else {
    mkdirSync(dir, { recursive: true })
    config = { schema_version: 1, name: project.name, vcs: project.vcs }
  }

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
    if (patch.poolSize !== undefined) {
      const size = Math.trunc(patch.poolSize)
      if (!Number.isFinite(size) || size < 1 || size > 32) {
        throw new Error(`workspace pool size must be between 1 and 32, not ${String(patch.poolSize)}`)
      }
      config.workspaces = { ...config.workspaces, poolSize: size }
    }
    if (patch.prepare !== undefined) {
      config.prepare = patch.prepare.map((c) => c.trim()).filter(Boolean)
    }
    log.info(`project ${project.name}: policy updated (${Object.keys(patch).join(', ')})`)
  })
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
  env: Record<string, string | number>
}

/**
 * The committed config with defaults filled in. Everything downstream reads this, never the raw
 * JSON, so an absent key and a default value are the same thing to a caller.
 */
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
    workspaceRoot: canonicalPath(
      c.workspaces?.root ? resolve(project.root, c.workspaces.root) : `${project.root}_workspaces`
    ),
    prepare: c.prepare ?? [],
    check: c.check ?? [],
    landingStrategy: c.landing?.strategy ?? DEFAULTS.landingStrategy,
    landingTarget: c.landing?.target ?? DEFAULTS.landingTarget,
    allowRules: c.permission?.allow ?? [],
    denyRules: c.permission?.deny ?? [],
    env: c.env ?? {}
  }
}
