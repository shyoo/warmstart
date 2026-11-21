import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultInstallCommand,
  defaultLockfiles,
  dependencyStoreDir,
  dependencyStoreEnv,
  ensureWorkspaceDependencies,
  measureDependencyStore,
  normalizeDependencyStoreConfig,
  readDependencyStoreConfig,
  type DependencyStoreConfig
} from './depstore.js'

let sandbox: string
let savedDataDir: string | undefined

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'agentyard-depstore-'))
  savedDataDir = process.env.WARMSTART_DATA_DIR
  process.env.WARMSTART_DATA_DIR = join(sandbox, 'data')
})

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.WARMSTART_DATA_DIR
  else process.env.WARMSTART_DATA_DIR = savedDataDir
  rmSync(sandbox, { recursive: true, force: true })
})

describe('normalizeDependencyStoreConfig & readDependencyStoreConfig', () => {
  it('returns null for absent configs and normalizes valid pnpm, npm-cache, and hook configs', () => {
    expect(normalizeDependencyStoreConfig(null)).toBeNull()
    expect(normalizeDependencyStoreConfig(undefined)).toBeNull()

    expect(
      normalizeDependencyStoreConfig({
        mode: 'pnpm',
        installCommand: '   ',
        lockfiles: ['.\\pnpm-lock.yaml', 'packages\\web\\pnpm-lock.yaml', 'packages/web/pnpm-lock.yaml']
      })
    ).toEqual({
      mode: 'pnpm',
      lockfiles: ['pnpm-lock.yaml', 'packages/web/pnpm-lock.yaml']
    })

    expect(normalizeDependencyStoreConfig({ mode: 'npm-cache', lockfiles: [] })).toEqual({
      mode: 'npm-cache'
    })

    expect(
      normalizeDependencyStoreConfig({
        mode: 'hook',
        installCommand: '  node scripts/setup-deps.mjs  ',
        lockfiles: ['package.json']
      })
    ).toEqual({
      mode: 'hook',
      installCommand: 'node scripts/setup-deps.mjs',
      lockfiles: ['package.json']
    })
  })

  it('rejects invalid modes and missing hook installCommand', () => {
    expect(() => normalizeDependencyStoreConfig('pnpm')).toThrow(/object/i)
    expect(() => normalizeDependencyStoreConfig({ mode: 'yarn' })).toThrow(/invalid dependency store mode/i)
    expect(() => normalizeDependencyStoreConfig({ mode: 'hook' })).toThrow(/installCommand/i)
    expect(() => normalizeDependencyStoreConfig({ mode: 'hook', installCommand: '   ' })).toThrow(
      /installCommand/i
    )
  })

  it('rejects unsafe lockfile paths (absolute, parent traversal, dot, empty, or VCS metadata)', () => {
    for (const bad of [
      '',
      '   ',
      '.',
      './',
      '..',
      '../pnpm-lock.yaml',
      'packages/../../pnpm-lock.yaml',
      '/etc/passwd',
      'C:\\repo\\pnpm-lock.yaml',
      ':/abs',
      '.git',
      '.git/config',
      'sub/.git/hooks',
      '.jj',
      '.jj/working_copy',
      'nested/.JJ/state'
    ]) {
      expect(() =>
        normalizeDependencyStoreConfig({ mode: 'pnpm', lockfiles: [bad] })
      ).toThrow(/lockfile/i)
    }
  })

  it('readDependencyStoreConfig returns null on malformed input instead of throwing', () => {
    expect(readDependencyStoreConfig(null)).toBeNull()
    expect(readDependencyStoreConfig({ mode: 'bogus' })).toBeNull()
    expect(readDependencyStoreConfig({ mode: 'hook' })).toBeNull()
    expect(readDependencyStoreConfig({ mode: 'pnpm', lockfiles: ['../escape'] })).toBeNull()
    expect(readDependencyStoreConfig({ mode: 'npm-cache' })).toEqual({ mode: 'npm-cache' })
  })
})

describe('defaultInstallCommand, defaultLockfiles, and dependencyStoreEnv', () => {
  it('resolves mode defaults and honors overrides', () => {
    expect(defaultInstallCommand({ mode: 'pnpm' })).toBe('pnpm install --frozen-lockfile --prefer-offline')
    expect(defaultInstallCommand({ mode: 'npm-cache' })).toBe('npm ci --prefer-offline')
    expect(defaultInstallCommand({ mode: 'hook' })).toBe('')
    expect(defaultInstallCommand({ mode: 'pnpm', installCommand: '  pnpm i  ' })).toBe('pnpm i')

    expect(defaultLockfiles({ mode: 'pnpm' })).toEqual(['pnpm-lock.yaml'])
    expect(defaultLockfiles({ mode: 'npm-cache' })).toEqual(['package-lock.json'])
    expect(defaultLockfiles({ mode: 'hook' })).toEqual([])
    expect(defaultLockfiles({ mode: 'pnpm', lockfiles: ['a/pnpm-lock.yaml'] })).toEqual([
      'a/pnpm-lock.yaml'
    ])
  })

  it('injects store environment variables for pnpm, npm-cache, and hook', () => {
    const projectRoot = join(sandbox, 'repo')
    const storeRoot = dependencyStoreDir(projectRoot)

    expect(dependencyStoreEnv(projectRoot, { mode: 'pnpm' })).toEqual({
      WARMSTART_DEPENDENCY_STORE: storeRoot,
      PNPM_STORE_DIR: join(storeRoot, 'pnpm-store'),
      npm_config_store_dir: join(storeRoot, 'pnpm-store')
    })

    expect(dependencyStoreEnv(projectRoot, { mode: 'npm-cache' })).toEqual({
      WARMSTART_DEPENDENCY_STORE: storeRoot,
      npm_config_cache: join(storeRoot, 'npm-cache')
    })

    expect(dependencyStoreEnv(projectRoot, { mode: 'hook', installCommand: 'echo ok' })).toEqual({
      WARMSTART_DEPENDENCY_STORE: storeRoot
    })
  })
})

describe('ensureWorkspaceDependencies', () => {
  it('never executes on trunk even with a real command', async () => {
    const projectRoot = join(sandbox, 'repo')
    mkdirSync(projectRoot, { recursive: true })
    const marker = join(projectRoot, 'should-not-exist.txt')
    const config: DependencyStoreConfig = {
      mode: 'pnpm',
      installCommand: `node -e "require('fs').writeFileSync('should-not-exist.txt', 'bad')"`
    }

    const res = await ensureWorkspaceDependencies(projectRoot, projectRoot, config, { ...process.env } as Record<string, string>)
    expect(res).toEqual({ ok: true, ran: false, command: null, output: '' })
    expect(existsSync(marker)).toBe(false)
  })

  it('populates workspace dependencies cleanly, skips on cache hit, and invalidates on lockfile/node_modules changes', async () => {
    const projectRoot = join(sandbox, 'repo')
    const workspace = join(sandbox, 'ws1')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    // Command records invocation count inside pnpm-store (external) and populates node_modules in workspace.
    const installScript = [
      'const fs = require("fs");',
      'const path = require("path");',
      'const countFile = path.join(process.env.PNPM_STORE_DIR, "run-count.txt");',
      'const prev = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;',
      'fs.writeFileSync(countFile, String(prev + 1));',
      'fs.mkdirSync("node_modules", { recursive: true });',
      'fs.writeFileSync(path.join("node_modules", ".ok"), "1");',
      'console.log("installed run", prev + 1);'
    ].join(' ')

    const config: DependencyStoreConfig = {
      mode: 'pnpm',
      installCommand: `node -e ${JSON.stringify(installScript)}`
    }
    const baseEnv = { ...process.env } as Record<string, string>

    const first = await ensureWorkspaceDependencies(projectRoot, workspace, config, baseEnv)
    expect(first.ok).toBe(true)
    expect(first.ran).toBe(true)
    expect(first.output).toContain('installed run 1')
    expect(existsSync(join(workspace, 'node_modules', '.ok'))).toBe(true)
    // Zero untracked stamp files inside workspace.
    expect(readdirSync(workspace).sort()).toEqual(['node_modules', 'pnpm-lock.yaml'])

    // Second run skips when node_modules and lockfile are unchanged.
    const second = await ensureWorkspaceDependencies(projectRoot, workspace, config, baseEnv)
    expect(second).toEqual({ ok: true, ran: false, command: config.installCommand, output: '' })

    // Modifying lockfile invalidates fingerprint and re-runs.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.1\n')
    const third = await ensureWorkspaceDependencies(projectRoot, workspace, config, baseEnv)
    expect(third.ok).toBe(true)
    expect(third.ran).toBe(true)
    expect(third.output).toContain('installed run 2')

    // Deleting node_modules invalidates even with matching lockfile stamp.
    rmSync(join(workspace, 'node_modules'), { recursive: true, force: true })
    const fourth = await ensureWorkspaceDependencies(projectRoot, workspace, config, baseEnv)
    expect(fourth.ok).toBe(true)
    expect(fourth.ran).toBe(true)
    expect(fourth.output).toContain('installed run 3')

    // Failing command returns ok: false without overwriting stamp with new lockfile hash.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: broken\n')
    const failConfig: DependencyStoreConfig = {
      mode: 'pnpm',
      installCommand: 'node -e "console.error(\'boom\'); process.exit(2)"'
    }
    const failed = await ensureWorkspaceDependencies(projectRoot, workspace, failConfig, baseEnv)
    expect(failed.ok).toBe(false)
    expect(failed.ran).toBe(true)
    expect(failed.error).toBeTruthy()
    expect(failed.output).toContain('boom')

    // Retrying failing command runs again rather than hitting a stamp.
    const retryFailed = await ensureWorkspaceDependencies(projectRoot, workspace, failConfig, baseEnv)
    expect(retryFailed.ok).toBe(false)
    expect(retryFailed.ran).toBe(true)
  })

  it('always runs hook mode when lockfiles is empty and caches hook mode when lockfiles are declared', async () => {
    const projectRoot = join(sandbox, 'repo-hook')
    const workspace = join(sandbox, 'ws-hook')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'deps.txt'), 'v1\n')

    const hookScript = [
      'const fs = require("fs");',
      'const path = require("path");',
      'const file = path.join(process.env.WARMSTART_DEPENDENCY_STORE, "hook-runs.txt");',
      'const prev = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;',
      'fs.writeFileSync(file, String(prev + 1));',
      'console.log("hook", prev + 1);'
    ].join(' ')
    const command = `node -e ${JSON.stringify(hookScript)}`
    const baseEnv = { ...process.env } as Record<string, string>

    // Without lockfiles, hook always runs.
    const noLockConfig: DependencyStoreConfig = { mode: 'hook', installCommand: command }
    const h1 = await ensureWorkspaceDependencies(projectRoot, workspace, noLockConfig, baseEnv)
    const h2 = await ensureWorkspaceDependencies(projectRoot, workspace, noLockConfig, baseEnv)
    expect(h1.ran).toBe(true)
    expect(h2.ran).toBe(true)

    // With lockfiles declared, hook runs once and caches until lockfile changes.
    const lockConfig: DependencyStoreConfig = {
      mode: 'hook',
      installCommand: command,
      lockfiles: ['deps.txt']
    }
    const l1 = await ensureWorkspaceDependencies(projectRoot, workspace, lockConfig, baseEnv)
    const l2 = await ensureWorkspaceDependencies(projectRoot, workspace, lockConfig, baseEnv)
    expect(l1.ran).toBe(true)
    expect(l2.ran).toBe(false)

    writeFileSync(join(workspace, 'deps.txt'), 'v2\n')
    const l3 = await ensureWorkspaceDependencies(projectRoot, workspace, lockConfig, baseEnv)
    expect(l3.ran).toBe(true)
  })
})

describe('measureDependencyStore', () => {
  it('returns unconfigured or null bytes when unpopulated, and sums store bytes excluding stamps/', async () => {
    const projectRoot = join(sandbox, 'repo-measure')
    mkdirSync(projectRoot, { recursive: true })

    const unconfigured = await measureDependencyStore(projectRoot, null)
    expect(unconfigured).toMatchObject({
      configured: false,
      mode: null,
      storeDir: null,
      bytes: null,
      reason: 'not configured'
    })

    const cfg: DependencyStoreConfig = { mode: 'npm-cache' }
    const unpopulated = await measureDependencyStore(projectRoot, cfg)
    const expectedDir = dependencyStoreDir(projectRoot)
    expect(unpopulated).toMatchObject({
      configured: true,
      mode: 'npm-cache',
      storeDir: expectedDir,
      bytes: null,
      reason: 'store not populated yet'
    })

    // Populate stamps/ (must be excluded) and npm-cache/ (must be counted).
    mkdirSync(join(expectedDir, 'stamps'), { recursive: true })
    writeFileSync(join(expectedDir, 'stamps', 'abc.json'), '1234567890')

    const onlyStamps = await measureDependencyStore(projectRoot, cfg)
    expect(onlyStamps.bytes).toBe(0)

    mkdirSync(join(expectedDir, 'npm-cache'), { recursive: true })
    writeFileSync(join(expectedDir, 'npm-cache', 'pkg.tgz'), 'abcd1234')

    const populated = await measureDependencyStore(projectRoot, cfg)
    expect(populated).toMatchObject({
      configured: true,
      mode: 'npm-cache',
      storeDir: expectedDir,
      bytes: 8,
      reason: `measured npm-cache store under ${expectedDir}`
    })
  })
})
