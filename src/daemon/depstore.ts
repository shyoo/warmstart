import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { DependencyStoreConfig, DependencyStoreMode, DependencyStoreStatus } from '@shared/tasks.js'
import { canonicalPath, samePath, withinPath } from './fspath.js'
import { dataDir } from './paths.js'
import { run } from './spawn.js'

export type { DependencyStoreConfig, DependencyStoreMode, DependencyStoreStatus } from '@shared/tasks.js'

export interface DependencyInstallResult {
  ok: boolean
  ran: boolean
  command: string | null
  output: string
  error?: string
}

const VALID_MODES = new Set<string>(['pnpm', 'npm-cache', 'hook'])

function normalizeLockfilePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed) {
    throw new Error('dependency store lockfile path cannot be empty')
  }
  if (trimmed === '.' || trimmed.startsWith(':') || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`unsafe dependency store lockfile path: ${raw}`)
  }
  const stripped = trimmed.replace(/^(\.\/)+/, '')
  if (!stripped || stripped.endsWith('/')) {
    throw new Error(`unsafe dependency store lockfile path: ${raw}`)
  }
  const parts = stripped.split('/')
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (!part || part === '.' || part === '..' || lower === '.git' || lower === '.jj') {
      throw new Error(`unsafe dependency store lockfile path: ${raw}`)
    }
  }
  return parts.join('/')
}

/**
 * Validate and canonicalize a project's `workspaces.dependencyStore` declaration.
 *
 * Returns `null` when absent. Throws a clear `Error` on invalid mode, missing hook
 * `installCommand`, or lockfile paths that escape the workspace or touch VCS metadata.
 */
export function normalizeDependencyStoreConfig(raw: unknown): DependencyStoreConfig | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dependency store config must be an object')
  }
  const obj = raw as Record<string, unknown>

  if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode)) {
    throw new Error(
      `invalid dependency store mode: ${String(obj.mode)} (expected 'pnpm', 'npm-cache', or 'hook')`
    )
  }
  const mode = obj.mode as DependencyStoreMode

  let installCommand = ''
  if (obj.installCommand !== undefined) {
    if (typeof obj.installCommand !== 'string') {
      throw new Error('dependency store installCommand must be a string')
    }
    installCommand = obj.installCommand.trim()
  }
  if (mode === 'hook' && !installCommand) {
    throw new Error("dependency store mode 'hook' requires a non-empty installCommand")
  }

  let lockfiles: string[] | undefined
  if (obj.lockfiles !== undefined) {
    if (!Array.isArray(obj.lockfiles)) {
      throw new Error('dependency store lockfiles must be an array of relative paths')
    }
    const deduped: string[] = []
    for (const item of obj.lockfiles) {
      if (typeof item !== 'string') {
        throw new Error('dependency store lockfile entries must be strings')
      }
      const clean = normalizeLockfilePath(item)
      if (!deduped.includes(clean)) deduped.push(clean)
    }
    if (deduped.length > 0) lockfiles = deduped
  }

  const out: DependencyStoreConfig = { mode }
  if (installCommand) out.installCommand = installCommand
  if (lockfiles) out.lockfiles = lockfiles
  return out
}

/** Forgiving reader for persisted `project.json` configs: returns `null` if absent or malformed. */
export function readDependencyStoreConfig(raw: unknown): DependencyStoreConfig | null {
  try {
    return normalizeDependencyStoreConfig(raw)
  } catch {
    return null
  }
}

/**
 * Deterministic machine-local dependency store root for a project.
 *
 * Uses `canonicalPath(projectRoot)` (case-folded on win32, matching `managedWorkspaceRoot`)
 * so `project.json` never records an absolute local disk path.
 */
export function dependencyStoreDir(projectRoot: string): string {
  const canonical = canonicalPath(projectRoot)
  const digest = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 12)
  const label = basename(canonical).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'project'
  return join(dataDir(), 'dep-stores', `${label}-${digest}`)
}

/** Package-manager store/cache environment variables injected for workspace dependency setup. */
export function dependencyStoreEnv(
  projectRoot: string,
  config: DependencyStoreConfig
): Record<string, string> {
  const storeRoot = dependencyStoreDir(projectRoot)
  const env: Record<string, string> = {
    WARMSTART_DEPENDENCY_STORE: storeRoot
  }
  if (config.mode === 'pnpm') {
    const pnpmStore = join(storeRoot, 'pnpm-store')
    env.PNPM_STORE_DIR = pnpmStore
    env.npm_config_store_dir = pnpmStore
  } else if (config.mode === 'npm-cache') {
    env.npm_config_cache = join(storeRoot, 'npm-cache')
  }
  return env
}

/** Resolved install command for `config`, honoring an explicit override first. */
export function defaultInstallCommand(config: DependencyStoreConfig): string {
  const custom = config.installCommand?.trim()
  if (custom) return custom
  switch (config.mode) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile --prefer-offline'
    case 'npm-cache':
      return 'npm ci --prefer-offline'
    case 'hook':
      return ''
  }
}

/** Lockfiles tracked for fingerprint invalidation, or mode defaults when omitted. */
export function defaultLockfiles(config: DependencyStoreConfig): string[] {
  if (config.lockfiles !== undefined) return [...config.lockfiles]
  switch (config.mode) {
    case 'pnpm':
      return ['pnpm-lock.yaml']
    case 'npm-cache':
      return ['package-lock.json']
    case 'hook':
      return []
  }
}

function workspaceStampPath(storeRoot: string, workspacePath: string): string {
  const canonical = canonicalPath(workspacePath)
  const digest = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 16)
  return join(storeRoot, 'stamps', `${digest}.json`)
}

async function computeFingerprint(
  workspacePath: string,
  mode: DependencyStoreMode,
  command: string,
  lockfiles: readonly string[]
): Promise<string> {
  const files: Array<{ path: string; exists: boolean; sha256: string | null }> = []
  for (const rel of lockfiles) {
    const cleanRel = normalizeLockfilePath(rel)
    const full = resolve(workspacePath, cleanRel)
    if (!withinPath(workspacePath, full)) {
      throw new Error(`unsafe dependency store lockfile path: ${rel}`)
    }
    if (existsSync(full)) {
      try {
        const bytes = await readFile(full)
        files.push({
          path: cleanRel,
          exists: true,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
        continue
      } catch {
        // An unreadable lockfile cannot match a valid saved fingerprint.
      }
    }
    files.push({ path: cleanRel, exists: false, sha256: null })
  }
  return createHash('sha256')
    .update(JSON.stringify({ mode, command, files }))
    .digest('hex')
}

async function readStampFingerprint(stampPath: string): Promise<string | null> {
  if (!existsSync(stampPath)) return null
  try {
    const parsed = JSON.parse(await readFile(stampPath, 'utf8')) as { fingerprint?: unknown }
    return typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null
  } catch {
    return null
  }
}

function ensureStoreDirs(storeRoot: string, mode: DependencyStoreMode): void {
  mkdirSync(storeRoot, { recursive: true })
  mkdirSync(join(storeRoot, 'stamps'), { recursive: true })
  if (mode === 'pnpm') {
    mkdirSync(join(storeRoot, 'pnpm-store'), { recursive: true })
  } else if (mode === 'npm-cache') {
    mkdirSync(join(storeRoot, 'npm-cache'), { recursive: true })
  }
}

/**
 * Ensure a pooled workspace has its dependencies populated from the machine-local shared store.
 *
 * ⛔ **Never runs on the trunk, and never symlinks or junctions `node_modules`.** Each workspace
 * keeps its own isolated `node_modules` directory populated through pnpm's content-addressable
 * hardlink store, npm's shared cache, or a declared project hook; stamp JSON files live outside
 * the workspace under `storeRoot/stamps/` so the VCS working tree stays clean.
 */
export async function ensureWorkspaceDependencies(
  projectRoot: string,
  workspacePath: string,
  config: DependencyStoreConfig,
  baseEnv: Record<string, string>
): Promise<DependencyInstallResult> {
  if (samePath(projectRoot, workspacePath)) {
    return { ok: true, ran: false, command: null, output: '' }
  }

  const command = defaultInstallCommand(config)
  if (!command) {
    return {
      ok: false,
      ran: false,
      command: null,
      output: '',
      error: `no install command configured for ${config.mode} dependency store`
    }
  }

  const lockfiles = defaultLockfiles(config)
  const storeRoot = dependencyStoreDir(projectRoot)
  const stampPath = workspaceStampPath(storeRoot, workspacePath)
  const fingerprint = await computeFingerprint(workspacePath, config.mode, command, lockfiles)

  const canCheckStamp =
    config.mode === 'hook'
      ? lockfiles.length > 0
      : existsSync(join(workspacePath, 'node_modules'))

  if (canCheckStamp) {
    const saved = await readStampFingerprint(stampPath)
    if (saved === fingerprint) {
      return { ok: true, ran: false, command, output: '' }
    }
  }

  ensureStoreDirs(storeRoot, config.mode)

  const env = { ...baseEnv, ...dependencyStoreEnv(projectRoot, config) }
  try {
    const { stdout, stderr } = await run(command, {
      cwd: workspacePath,
      shell: true,
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000
    } as never)
    const output = `${stdout}${stderr}`.slice(-2000)
    await writeFile(
      stampPath,
      JSON.stringify({
        fingerprint,
        workspacePath: canonicalPath(workspacePath),
        mode: config.mode,
        command,
        lockfiles,
        updatedAt: Date.now()
      }),
      'utf8'
    )
    return { ok: true, ran: true, command, output }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.slice(-2000)
    return {
      ok: false,
      ran: true,
      command,
      output,
      error: e.message ?? `dependency install command failed: ${command}`
    }
  }
}

async function storeDirectoryBytes(storeRoot: string): Promise<number> {
  let total = 0
  const stack: string[] = [storeRoot]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      // Exclude per-workspace stamp metadata files (`storeRoot/stamps/`) so reported store bytes
      // reflect cached package artifacts rather than Warmstart bookkeeping.
      if (current === storeRoot && entry.name === 'stamps') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await lstat(full)).size
        } catch {
          // Ignore transient files deleted or locked mid-walk.
        }
      }
    }
  }
  return total
}

/**
 * Report configuration status and on-disk footprint for a project's shared dependency store.
 *
 * Returns `bytes: null` whenever unconfigured or not yet populated on disk, never an unmeasured 0.
 */
export async function measureDependencyStore(
  projectRoot: string,
  config: DependencyStoreConfig | null
): Promise<DependencyStoreStatus> {
  const measuredAt = Date.now()
  if (!config) {
    return {
      configured: false,
      mode: null,
      storeDir: null,
      bytes: null,
      measuredAt,
      reason: 'not configured'
    }
  }

  const storeDir = dependencyStoreDir(projectRoot)
  try {
    const st = await lstat(storeDir)
    if (!st.isDirectory()) {
      return {
        configured: true,
        mode: config.mode,
        storeDir,
        bytes: null,
        measuredAt: Date.now(),
        reason: 'store not populated yet'
      }
    }
  } catch {
    return {
      configured: true,
      mode: config.mode,
      storeDir,
      bytes: null,
      measuredAt: Date.now(),
      reason: 'store not populated yet'
    }
  }

  const bytes = await storeDirectoryBytes(storeDir)
  return {
    configured: true,
    mode: config.mode,
    storeDir,
    bytes,
    measuredAt: Date.now(),
    reason: `measured ${config.mode} store under ${storeDir}`
  }
}
