import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectConfig } from '@shared/tasks.js'

let dir: string
let db: typeof import('./db.js')
let projects: typeof import('./projects.js')
let worktrees: typeof import('./worktrees.js')
let depstore: typeof import('./depstore.js')
let cow: typeof import('./cow.js')
let logMod: typeof import('./log.js')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

let seq = 0

function makeGitProject(config?: Partial<ProjectConfig>): Project {
  seq += 1
  const root = join(dir, `repo${seq}`)
  mkdirSync(join(root, '.warmstart'), { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'agentyard test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(root, '.warmstart', 'project.json'),
    JSON.stringify(
      {
        schema_version: 1,
        name: `repo${seq}`,
        vcs: 'git',
        check: [],
        workspaces: { poolSize: 1 },
        landing: { strategy: 'auto-land', target: 'main' },
        ...config
      },
      null,
      2
    )
  )
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  return projects.addProject({ root })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-disktrack-'))
  process.env.WARMSTART_DATA_DIR = join(dir, 'data')
  db = await import('./db.js')
  projects = await import('./projects.js')
  worktrees = await import('./worktrees.js')
  depstore = await import('./depstore.js')
  cow = await import('./cow.js')
  logMod = await import('./log.js')
  db.openDb(join(dir, 'disktrack.db'))
})

afterEach(() => {
  cow._resetCowProbeCacheForTest()
  worktrees.clearPoolSizeCache()
  vi.restoreAllMocks()
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('prepareWorkspace + dependencyStore wiring', () => {
  const installScript = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const store = process.env.WARMSTART_DEPENDENCY_STORE;',
    'const pnpmDir = process.env.PNPM_STORE_DIR;',
    'if (!store || !pnpmDir) process.exit(9);',
    'const countPath = path.join(store, "install-count.txt");',
    'const prev = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;',
    'fs.writeFileSync(countPath, String(prev + 1));',
    'fs.writeFileSync(path.join(store, "install-env.json"), JSON.stringify({ store, pnpmDir }));',
    'fs.mkdirSync("node_modules", { recursive: true });',
    'fs.writeFileSync(path.join("node_modules", ".ok"), "1");',
    'console.log("dep-install-" + (prev + 1));'
  ].join(' ')

  const prepareScript = [
    'const fs = require("fs");',
    'console.log(JSON.stringify({ store: process.env.WARMSTART_DEPENDENCY_STORE || null, pnpm: process.env.PNPM_STORE_DIR || null }));',
    'fs.writeFileSync("prepare-saw-deps.txt", fs.existsSync("node_modules/.ok") ? "yes" : "no");'
  ].join(' ')

  it('runs installCommand, injects env into install and prepare, caches on hit, invalidates on lockfile change, and propagates failure', async () => {

    const project = makeGitProject({
      prepare: [`node -e ${JSON.stringify(prepareScript)}`],
      workspaces: {
        poolSize: 1,
        dependencyStore: {
          mode: 'pnpm',
          installCommand: `node -e ${JSON.stringify(installScript)}`
        }
      }
    })

    const ws = await worktrees.claimWorkspace(project, 'run-1')
    expect(ws).not.toBeNull()
    const branch = worktrees.branchNameFor(1, 'disktrack test')

    // 1. First prepare runs install + prepare, and both receive store env vars.
    const first = await worktrees.prepareWorkspace(project, ws!, branch)
    expect(first.ok).toBe(true)
    expect(first.steps.length).toBe(2)
    expect(first.steps[0]?.ok).toBe(true)
    expect(first.steps[0]?.output).toContain('dep-install-1')
    expect(first.steps[1]?.ok).toBe(true)

    const expectedStore = depstore.dependencyStoreDir(project.root)
    const seenByPrepare = JSON.parse(first.steps[1]!.output) as { store: string; pnpm: string }
    expect(seenByPrepare.store).toBe(expectedStore)
    expect(seenByPrepare.pnpm).toBe(join(expectedStore, 'pnpm-store'))
    expect(readFileSync(join(ws!.path, 'prepare-saw-deps.txt'), 'utf8')).toBe('yes')
    rmSync(join(ws!.path, 'prepare-saw-deps.txt'), { force: true })

    // 2. Second prepare skips install (fingerprint + node_modules match) and still injects env into prepare.
    const second = await worktrees.prepareWorkspace(project, ws!, branch)
    expect(second.ok).toBe(true)
    expect(second.steps.length).toBe(1)
    expect(second.steps[0]?.command).toContain('node -e')
    expect(readFileSync(join(expectedStore, 'install-count.txt'), 'utf8')).toBe('1')
    rmSync(join(ws!.path, 'prepare-saw-deps.txt'), { force: true })

    // 3. Modifying lockfile in workspace invalidates stamp and re-runs install.
    writeFileSync(join(ws!.path, 'pnpm-lock.yaml'), 'lockfileVersion: 9.1\n')
    const third = await worktrees.prepareWorkspace(project, ws!, branch)
    expect(third.ok).toBe(true)
    expect(third.steps.length).toBe(2)
    expect(third.steps[0]?.output).toContain('dep-install-2')
    expect(readFileSync(join(expectedStore, 'install-count.txt'), 'utf8')).toBe('2')
    rmSync(join(ws!.path, 'prepare-saw-deps.txt'), { force: true })

    // 4. Failing dependency install propagates error and stops before prepare.
    writeFileSync(join(ws!.path, 'pnpm-lock.yaml'), 'lockfileVersion: 9.2\n')
    projects.setProjectPolicy(project.id, {
      dependencyStore: {
        mode: 'pnpm',
        installCommand: 'node -e "console.error(\'install-boom\'); process.exit(3)"'
      }
    })
    const refreshed = projects.requireProject(project.id)
    const fourth = await worktrees.prepareWorkspace(refreshed, ws!, branch)
    expect(fourth.ok).toBe(false)
    expect(fourth.steps.length).toBe(1)
    expect(fourth.steps[0]?.ok).toBe(false)
    expect(fourth.steps[0]?.output).toContain('install-boom')
    expect(fourth.error).toBeTruthy()
    expect(existsSync(join(ws!.path, 'prepare-saw-deps.txt'))).toBe(false)

    worktrees.releaseWorkspace(ws!.claimId)
  }, 60_000)

  it('never runs dependencyStore or injects store env vars in trunk mode', async () => {
    const trunkProject = makeGitProject({
      prepare: [`node -e ${JSON.stringify(prepareScript)}`],
      workspaces: {
        poolSize: 0,
        mode: 'trunk',
        dependencyStore: {
          mode: 'pnpm',
          installCommand: `node -e ${JSON.stringify(installScript)}`
        }
      }
    })
    const trunkRes = await worktrees.prepareWorkspace(
      trunkProject,
      { index: 0, path: trunkProject.root, claimId: 'trunk-1' },
      null
    )
    expect(trunkRes.ok).toBe(true)
    expect(trunkRes.steps.length).toBe(1)
    const trunkPrepareEnv = JSON.parse(trunkRes.steps[0]!.output) as { store: string | null; pnpm: string | null }
    expect(trunkPrepareEnv).toEqual({ store: null, pnpm: null })
    expect(existsSync(depstore.dependencyStoreDir(trunkProject.root))).toBe(false)
    rmSync(join(trunkProject.root, 'prepare-saw-deps.txt'), { force: true })
  }, 60_000)
})

describe('ensurePool + CoW seeding & measurePoolStorage', () => {
  it('never fails pool slot creation on unsupported CoW, warns explicitly, and reports combined storage with stamps excluded', async () => {
    const project = makeGitProject({
      workspaces: {
        poolSize: 1,
        dependencyStore: { mode: 'pnpm' },
        cow: { enabled: true }
      }
    })
    // Create an untracked node_modules in trunk for CoW seeding to inspect.
    mkdirSync(join(project.root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(project.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const warnSpy = vi.spyOn(logMod.log, 'warn')
    const members = await worktrees.ensurePool(project)
    expect(members.length).toBe(1)
    expect(existsSync(members[0]!)).toBe(true)

    // Measure combined storage before dependency store directory exists.
    const beforeStore = await worktrees.measurePoolStorage(project, true)
    expect(beforeStore.members.length).toBe(1)
    expect(beforeStore.members[0]!.path).toBe(members[0])
    expect(beforeStore.members[0]!.bytes).toBeGreaterThan(0)

    expect(beforeStore.cow.filesystem.length).toBeGreaterThan(0)
    expect(beforeStore.cow.measuredAt).toBeGreaterThan(0)
    expect(beforeStore.cow.reason.length).toBeGreaterThan(0)
    if (!beforeStore.cow.supported) {
      expect(beforeStore.cow.mechanism).toBe('none')
      expect(beforeStore.cow.reason).toContain('this volume cannot clone; slots are full copies')
      // Unsupported volume must warn cleanly during slot creation and never byte-copy silently.
      expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('this volume cannot clone; slots are full copies'))).toBe(true)
      expect(existsSync(join(members[0]!, 'node_modules'))).toBe(false)
    } else {
      // On CoW-capable filesystems (ReFS/APFS/btrfs), ensurePool seeded untracked node_modules.
      expect(existsSync(join(members[0]!, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    }

    expect(beforeStore.dependencyStore).toMatchObject({
      configured: true,
      mode: 'pnpm',
      storeDir: depstore.dependencyStoreDir(project.root),
      bytes: null,
      reason: 'store not populated yet'
    })

    // Populate stamps/ (must be excluded) + pnpm-store/ (must be measured).
    const storeRoot = depstore.dependencyStoreDir(project.root)
    mkdirSync(join(storeRoot, 'stamps'), { recursive: true })
    writeFileSync(join(storeRoot, 'stamps', 'ws1.json'), '{"ignored":"stamp-bytes"}')
    mkdirSync(join(storeRoot, 'pnpm-store'), { recursive: true })
    writeFileSync(join(storeRoot, 'pnpm-store', 'blob.bin'), '1234567890')

    const afterStore = await worktrees.measurePoolStorage(project)
    expect(afterStore.dependencyStore).toMatchObject({
      configured: true,
      mode: 'pnpm',
      storeDir: storeRoot,
      bytes: 10
    })
  }, 60_000)
})
