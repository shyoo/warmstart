import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Project, ProjectConfig, Vcs } from '@shared/tasks.js'
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
  const root = resolve(input.root)
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
          landing: { strategy: DEFAULTS.landingStrategy, target: DEFAULTS.landingTarget }
        }
      : {}),
    prepare: [],
    check: [],
    permission: { allow: [] }
  }
  writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`)
  reloadProject(id)
  return path
}

// ------------------------------------------------------------------ resolved policy

export interface ProjectPolicy {
  poolSize: number
  workspaceRoot: string
  prepare: string[]
  check: string[]
  landingStrategy: 'auto-land' | 'leave-branch' | 'pull-request'
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
    workspaceRoot: c.workspaces?.root
      ? resolve(project.root, c.workspaces.root)
      : `${project.root}_workspaces`,
    prepare: c.prepare ?? [],
    check: c.check ?? [],
    landingStrategy: c.landing?.strategy ?? DEFAULTS.landingStrategy,
    landingTarget: c.landing?.target ?? DEFAULTS.landingTarget,
    allowRules: c.permission?.allow ?? [],
    denyRules: c.permission?.deny ?? [],
    env: c.env ?? {}
  }
}
