import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CowCapability, CowCloneConfig } from '@shared/tasks.js'
import { canonicalPath, samePath, withinPath } from './fspath.js'
import { tryGit } from './git.js'
import { run } from './spawn.js'
import { spawnEnv, which } from './which.js'

export type { CowCapability, CowCloneConfig, CowMechanism } from '@shared/tasks.js'

export interface CowSeedResult {
  capability: CowCapability
  cloned: string[]
  skipped: Array<{ path: string; reason: string }>
  errors: Array<{ path: string; error: string }>
}

export type CowProbeRunner = (
  file: string,
  args: string[],
  opts?: { cwd?: string }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const CANT_CLONE_PREFIX = 'this volume cannot clone; slots are full copies'
const COW_PROBE_TTL_MS = 5 * 60_000
const DEFAULT_SEED_PATHS = ['node_modules']

interface CachedProbe {
  expiresAt: number
  capability: CowCapability
}

const probeCache = new Map<string, CachedProbe>()

/** Clear cached CoW capability probes (for unit tests). */
export function _resetCowProbeCacheForTest(): void {
  probeCache.clear()
}

/**
 * Default process runner built on `spawn.run` (`windowsHide: true`) and `which` + `spawnEnv`.
 * Never throws on a non-zero exit code so callers can inspect `exitCode` directly (e.g. robocopy
 * 0–7 success codes or unsupported `cp -c` / `cp --reflink=always` probes).
 */
export const defaultCowProbeRunner: CowProbeRunner = async (file, args, opts) => {
  const resolved = which(file) ?? file
  try {
    const { stdout, stderr } = await run(resolved, args, {
      cwd: opts?.cwd,
      env: spawnEnv(),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    const exitCode = typeof e.code === 'number' ? e.code : 1
    return {
      exitCode,
      stdout: e.stdout ?? '',
      stderr: e.stderr || e.message || ''
    }
  }
}

function normalizeSeedPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed) {
    throw new Error('copy-on-write seedPath cannot be empty')
  }
  if (trimmed === '.' || trimmed.startsWith(':') || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`unsafe copy-on-write seedPath: ${raw}`)
  }
  const clean = trimmed.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!clean) {
    throw new Error(`unsafe copy-on-write seedPath: ${raw}`)
  }
  const parts = clean.split('/')
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (!part || part === '.' || part === '..' || lower === '.git' || lower === '.jj') {
      throw new Error(`unsafe copy-on-write seedPath: ${raw}`)
    }
  }
  return parts.join('/')
}

/**
 * Validate and canonicalize `workspaces.cow` configuration.
 *
 * Returns `null` when absent. Rejects unsafe `seedPaths` (absolute, `..`, `.`, `.git`, `.jj`).
 */
export function normalizeCowCloneConfig(raw: unknown): CowCloneConfig | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('copy-on-write config must be an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.enabled !== 'boolean') {
    throw new Error('copy-on-write config enabled must be a boolean')
  }

  let seedPaths: string[] | undefined
  if (obj.seedPaths !== undefined) {
    if (!Array.isArray(obj.seedPaths)) {
      throw new Error('copy-on-write seedPaths must be an array of relative directory paths')
    }
    const deduped: string[] = []
    for (const item of obj.seedPaths) {
      if (typeof item !== 'string') {
        throw new Error('copy-on-write seedPaths entries must be strings')
      }
      const clean = normalizeSeedPath(item)
      if (!deduped.includes(clean)) deduped.push(clean)
    }
    if (deduped.length > 0) seedPaths = deduped
  }

  const out: CowCloneConfig = { enabled: obj.enabled }
  if (seedPaths) out.seedPaths = seedPaths
  return out
}

/** Forgiving reader for `workspaces.cow`: returns `null` when absent or malformed. */
export function readCowCloneConfig(raw: unknown): CowCloneConfig | null {
  try {
    return normalizeCowCloneConfig(raw)
  } catch {
    return null
  }
}

function nearestExistingDir(targetPath: string): string {
  let current = canonicalPath(targetPath)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    if (existsSync(current) && !statSync(current).isDirectory()) {
      const parent = dirname(current)
      if (parent !== current) return parent
    }
  } catch {
    // Keep current path and let probe surface any read failure honestly.
  }
  return current
}

function cachePathKey(p: string): string {
  const c = canonicalPath(p)
  return process.platform === 'win32' ? c.toLowerCase() : c
}

function unsupported(
  filesystem: string,
  detail: string,
  probedPath: string,
  measuredAt: number
): CowCapability {
  return {
    supported: false,
    filesystem: filesystem || 'unknown',
    mechanism: 'none',
    reason: detail ? `${CANT_CLONE_PREFIX} (${detail})` : CANT_CLONE_PREFIX,
    measuredAt,
    probedPath
  }
}

const WIN32_PROBE_CS = [
  'using System;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class WarmstartVolProbe {',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool GetVolumePathNameW(string lpszFileName, StringBuilder lpszVolumePathName, uint cchBufferLength);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool GetVolumeInformationW(',
  '    string lpRootPathName,',
  '    StringBuilder lpVolumeNameBuffer,',
  '    uint nVolumeNameSize,',
  '    out uint lpVolumeSerialNumber,',
  '    out uint lpMaximumComponentLength,',
  '    out uint lpFileSystemFlags,',
  '    StringBuilder lpFileSystemNameBuffer,',
  '    uint nFileSystemNameSize',
  '  );',
  '  public static string Inspect(string p) {',
  '    var r = new StringBuilder(1024);',
  '    string root = GetVolumePathNameW(p, r, (uint)r.Capacity) ? r.ToString() : Path.GetPathRoot(p);',
  '    if (string.IsNullOrEmpty(root)) return "||0|0";',
  '    if (!root.EndsWith("\\\\")) root += "\\\\";',
  '    var vn = new StringBuilder(261);',
  '    var fn = new StringBuilder(261);',
  '    uint s, mc, fl = 0;',
  '    if (!GetVolumeInformationW(root, vn, 261, out s, out mc, out fl, fn, 261)) {',
  '      string d = ""; try { d = new DriveInfo(root).DriveFormat; } catch {}',
  '      return root + "|" + d + "|0|0";',
  '    }',
  '    return root + "|" + fn.ToString() + "|" + fl + "|" + (((fl & 0x08000000u) != 0) ? "1" : "0");',
  '  }',
  '}'
].join('\n')

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

interface Win32VolumeInfo {
  targetRoot?: string
  targetFs?: string
  targetFlags?: number
  targetBlockClone?: boolean
  sourceRoot?: string
  sourceFs?: string
  sourceBlockClone?: boolean
}

async function probeWin32(
  probedPath: string,
  probedSource: string | undefined,
  runner: CowProbeRunner,
  measuredAt: number
): Promise<CowCapability> {
  // Never call `fsutil` (Access Denied for unprivileged users) or `COPYFILE_FICLONE_FORCE` (`ENOSYS`).
  // Unprivileged Win32 GetVolumePathNameW + GetVolumeInformationW gives exact filesystem +
  // FILE_SUPPORTS_BLOCK_REFCOUNTING (0x08000000) without elevation.
  const lines = [
    `Add-Type -TypeDefinition @'\n${WIN32_PROBE_CS}\n'@`,
    `$t = [WarmstartVolProbe]::Inspect(${psSingleQuote(probedPath)}).Split('|')`,
    `$obj = @{ targetRoot = $t[0]; targetFs = $t[1]; targetFlags = [uint32]$t[2]; targetBlockClone = ($t[3] -eq '1') }`
  ]
  if (probedSource) {
    lines.push(`$s = [WarmstartVolProbe]::Inspect(${psSingleQuote(probedSource)}).Split('|')`)
    lines.push(`$obj.sourceRoot = $s[0]; $obj.sourceFs = $s[1]; $obj.sourceBlockClone = ($s[3] -eq '1')`)
  }
  lines.push('$obj | ConvertTo-Json -Compress')

  const res = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')])
  if (res.exitCode !== 0) {
    return unsupported('unknown', `volume probe failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`, probedPath, measuredAt)
  }

  let parsed: Win32VolumeInfo
  try {
    parsed = JSON.parse(res.stdout.trim()) as Win32VolumeInfo
  } catch {
    return unsupported('unknown', 'volume probe returned invalid JSON', probedPath, measuredAt)
  }

  const targetRoot = parsed.targetRoot ?? ''
  const targetFs = parsed.targetFs || 'unknown'
  if (probedSource !== undefined) {
    const sourceRoot = parsed.sourceRoot ?? ''
    if (!targetRoot || !sourceRoot || targetRoot.toLowerCase() !== sourceRoot.toLowerCase()) {
      return unsupported(
        targetFs,
        `source and pool are on different volumes: ${sourceRoot || 'unknown'} vs ${targetRoot || 'unknown'}`,
        probedPath,
        measuredAt
      )
    }
  }

  if (targetFs.toUpperCase() === 'REFS' && parsed.targetBlockClone === true) {
    return {
      supported: true,
      filesystem: 'ReFS',
      mechanism: 'refs-block-clone',
      reason: `ReFS block cloning supported on ${targetRoot || probedPath}`,
      measuredAt,
      probedPath
    }
  }

  return unsupported(targetFs, `${targetFs} on ${targetRoot || probedPath}`, probedPath, measuredAt)
}

function sameDeviceOrReason(probedPath: string, probedSource?: string): string | null {
  if (!probedSource) return null
  try {
    const srcDev = statSync(probedSource).dev
    const dstDev = statSync(probedPath).dev
    if (srcDev !== dstDev) {
      return 'source and pool are on different volumes'
    }
  } catch {
    return null
  }
  return null
}

function tempProbePair(dir: string): { src: string; dst: string } {
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`
  const src = join(dir, `.warmstart-cow-probe-${token}-src`)
  const dst = join(dir, `.warmstart-cow-probe-${token}-dst`)
  writeFileSync(src, 'warmstart-cow-probe\n', 'utf8')
  return { src, dst }
}

async function probeDarwin(
  probedPath: string,
  probedSource: string | undefined,
  runner: CowProbeRunner,
  measuredAt: number
): Promise<CowCapability> {
  const crossDev = sameDeviceOrReason(probedPath, probedSource)
  if (crossDev) return unsupported('unknown', crossDev, probedPath, measuredAt)

  let pair: { src: string; dst: string } | null = null
  try {
    pair = tempProbePair(probedPath)
    const res = await runner('cp', ['-c', pair.src, pair.dst])
    if (res.exitCode === 0) {
      return {
        supported: true,
        filesystem: 'APFS',
        mechanism: 'apfs-clonefile',
        reason: 'APFS clonefile verified via cp -c',
        measuredAt,
        probedPath
      }
    }
    return unsupported(
      'unknown',
      res.stderr.trim() || `cp -c exited with code ${res.exitCode}`,
      probedPath,
      measuredAt
    )
  } catch (err) {
    return unsupported('unknown', (err as Error).message, probedPath, measuredAt)
  } finally {
    if (pair) {
      rmSync(pair.src, { force: true })
      rmSync(pair.dst, { force: true })
    }
  }
}

async function probePosixReflink(
  probedPath: string,
  probedSource: string | undefined,
  runner: CowProbeRunner,
  measuredAt: number
): Promise<CowCapability> {
  const crossDev = sameDeviceOrReason(probedPath, probedSource)
  const statRes = await runner('stat', ['-f', '-c', '%T', probedPath])
  const filesystem = statRes.exitCode === 0 && statRes.stdout.trim() ? statRes.stdout.trim() : 'unknown'
  if (crossDev) return unsupported(filesystem, crossDev, probedPath, measuredAt)

  let pair: { src: string; dst: string } | null = null
  try {
    pair = tempProbePair(probedPath)
    const res = await runner('cp', ['--reflink=always', pair.src, pair.dst])
    if (res.exitCode === 0) {
      return {
        supported: true,
        filesystem,
        mechanism: 'reflink',
        reason: `reflink (FICLONE) verified via cp --reflink=always (${filesystem})`,
        measuredAt,
        probedPath
      }
    }
    return unsupported(filesystem, filesystem, probedPath, measuredAt)
  } catch (err) {
    return unsupported(filesystem, (err as Error).message, probedPath, measuredAt)
  } finally {
    if (pair) {
      rmSync(pair.src, { force: true })
      rmSync(pair.dst, { force: true })
    }
  }
}

/**
 * Probe whether copy-on-write cloning is supported for `targetDir` (and across from `sourceDir` if given).
 *
 * ⛔ **Never assumes support, and never falls back silently to byte copying.** Unsupported volumes
 * return `supported: false, mechanism: 'none'` with `"this volume cannot clone; slots are full copies"`
 * in `reason`.
 */
export async function probeCowSupport(
  targetDir: string,
  sourceDir?: string,
  opts?: { force?: boolean; platform?: NodeJS.Platform; runner?: CowProbeRunner }
): Promise<CowCapability> {
  const platform = opts?.platform ?? process.platform
  const useCache = !opts?.runner && !opts?.platform
  const cacheKey = `${platform}:${cachePathKey(targetDir)}:${sourceDir ? cachePathKey(sourceDir) : ''}`

  if (useCache && !opts?.force) {
    const cached = probeCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.capability
    }
  }

  const probedPath = nearestExistingDir(targetDir)
  const probedSource = sourceDir ? nearestExistingDir(sourceDir) : undefined
  const runner = opts?.runner ?? defaultCowProbeRunner
  const measuredAt = Date.now()

  let capability: CowCapability
  if (platform === 'win32') {
    capability = await probeWin32(probedPath, probedSource, runner, measuredAt)
  } else if (platform === 'darwin') {
    capability = await probeDarwin(probedPath, probedSource, runner, measuredAt)
  } else {
    capability = await probePosixReflink(probedPath, probedSource, runner, measuredAt)
  }

  if (useCache) {
    probeCache.set(cacheKey, {
      expiresAt: Date.now() + COW_PROBE_TTL_MS,
      capability
    })
  }
  return capability
}

/**
 * Clone a directory using a verified copy-on-write mechanism.
 *
 * ⛔ Throws immediately if `capability` is unsupported — never falls back to a full byte copy.
 */
export async function cloneDirectoryCow(
  srcDir: string,
  dstDir: string,
  capability: CowCapability,
  opts?: { runner?: CowProbeRunner }
): Promise<void> {
  if (!capability.supported || capability.mechanism === 'none') {
    throw new Error(`cannot CoW-clone directory: ${capability.reason}`)
  }
  if (!existsSync(srcDir)) {
    throw new Error(`source directory does not exist: ${srcDir}`)
  }
  if (existsSync(dstDir)) {
    throw new Error(`destination directory already exists: ${dstDir}`)
  }
  if (samePath(srcDir, dstDir)) {
    throw new Error(`source and destination directories cannot be the same: ${srcDir}`)
  }

  const runner = opts?.runner ?? defaultCowProbeRunner
  try {
    let res: { exitCode: number; stdout: string; stderr: string }
    switch (capability.mechanism) {
      case 'apfs-clonefile':
        res = await runner('cp', ['-cR', srcDir, dstDir])
        if (res.exitCode !== 0) {
          throw new Error(`cp -cR failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`)
        }
        break
      case 'reflink':
        res = await runner('cp', ['-a', '--reflink=always', srcDir, dstDir])
        if (res.exitCode !== 0) {
          throw new Error(
            `cp -a --reflink=always failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`
          )
        }
        break
      case 'refs-block-clone':
        res = await runner('robocopy', [
          srcDir,
          dstDir,
          '/E',
          '/SL',
          '/NFL',
          '/NDL',
          '/NJH',
          '/NJS',
          '/NC',
          '/NS',
          '/NP'
        ])
        // Robocopy uses bitmask exit codes 0..7 for success/partial-match and >= 8 for failures.
        if (res.exitCode < 0 || res.exitCode >= 8) {
          throw new Error(
            `robocopy failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`
          )
        }
        break
    }
  } catch (err) {
    await rm(dstDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function isRealDirectory(dirPath: string): boolean {
  try {
    const st = lstatSync(dirPath)
    return !st.isSymbolicLink() && st.isDirectory()
  } catch {
    return false
  }
}

/**
 * Seed untracked heavy directories (default `node_modules`) from `projectRoot` into a newly
 * created pool `workspacePath` using copy-on-write cloning.
 *
 * Skips silently on trunk, when disabled, when CoW is unsupported, or when any target directory is
 * missing, already present in the slot, or contains git-tracked files.
 */
export async function seedWorkspaceCow(
  projectRoot: string,
  workspacePath: string,
  config: CowCloneConfig,
  opts?: {
    capability?: CowCapability
    runner?: CowProbeRunner
    gitLsFiles?: (root: string, rel: string) => Promise<boolean>
  }
): Promise<CowSeedResult> {
  const seedPaths =
    config.seedPaths !== undefined
      ? Array.from(new Set(config.seedPaths.map(normalizeSeedPath)))
      : [...DEFAULT_SEED_PATHS]

  if (!config.enabled) {
    const capability =
      opts?.capability ??
      unsupported('unknown', 'copy-on-write cloning is disabled', canonicalPath(workspacePath), Date.now())
    return {
      capability,
      cloned: [],
      skipped: seedPaths.map((path) => ({ path, reason: 'copy-on-write cloning disabled' })),
      errors: []
    }
  }

  if (samePath(projectRoot, workspacePath)) {
    const capability =
      opts?.capability ??
      unsupported('unknown', 'never clone into trunk', canonicalPath(workspacePath), Date.now())
    return {
      capability,
      cloned: [],
      skipped: seedPaths.map((path) => ({ path, reason: 'never clone into trunk' })),
      errors: []
    }
  }

  const capability =
    opts?.capability ?? (await probeCowSupport(workspacePath, projectRoot, { runner: opts?.runner }))

  if (!capability.supported) {
    return {
      capability,
      cloned: [],
      skipped: seedPaths.map((path) => ({ path, reason: capability.reason })),
      errors: []
    }
  }

  const cloned: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  const errors: Array<{ path: string; error: string }> = []

  for (const rel of seedPaths) {
    const src = resolve(projectRoot, rel)
    const dst = resolve(workspacePath, rel)
    if (!withinPath(projectRoot, src) || !withinPath(workspacePath, dst) || samePath(src, projectRoot)) {
      skipped.push({ path: rel, reason: 'unsafe seed path' })
      continue
    }

    if (!existsSync(src)) {
      skipped.push({ path: rel, reason: 'missing in trunk' })
      continue
    }

    if (!isRealDirectory(src)) {
      skipped.push({ path: rel, reason: 'not a directory in trunk' })
      continue
    }

    if (existsSync(dst)) {
      skipped.push({ path: rel, reason: 'already exists in workspace' })
      continue
    }

    const tracked = opts?.gitLsFiles
      ? await opts.gitLsFiles(projectRoot, rel)
      : ((await tryGit(projectRoot, ['ls-files', '--', rel])) ?? '').trim().length > 0

    if (tracked) {
      skipped.push({ path: rel, reason: 'contains tracked files' })
      continue
    }

    try {
      mkdirSync(dirname(dst), { recursive: true })
      await cloneDirectoryCow(src, dst, capability, { runner: opts?.runner })
      cloned.push(rel)
    } catch (err) {
      errors.push({ path: rel, error: (err as Error).message })
    }
  }

  return { capability, cloned, skipped, errors }
}
