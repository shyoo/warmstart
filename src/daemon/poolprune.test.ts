import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDb } from './db.js'
import { samePath } from './fspath.js'
import { claim, releaseAllFor, workspacePoolId } from './resources.js'
import { git, makeProject, openTestDb } from './testkit.js'
import {
  awaitPoolPrunes,
  claimTrunk,
  claimWorkspace,
  clearPoolSizeCache,
  ensurePool,
  measurePoolSizes,
  releaseWorkspace
} from './worktrees.js'

let dataDir: string
let repoDir: string

beforeAll(() => {
  dataDir = openTestDb('agentyard-poolprune-')
  repoDir = realpathSync.native(dataDir)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearPoolSizeCache()
})

afterAll(() => {
  closeDb()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // Ignore transient Windows handles on temp cleanup.
  }
})

function setupRepo(
  name: string,
  opts: { poolSize?: number; pruneOnRelease?: string[] } = {}
) {
  const project = makeProject({
    dir: repoDir,
    name,
    config: {
      workspaces: {
        poolSize: opts.poolSize ?? 1,
        ...(opts.pruneOnRelease ? { pruneOnRelease: opts.pruneOnRelease } : {})
      }
    },
    files: {
      'kept.txt': 'committed root file\n',
      '.gitignore': 'release/\nout/\nnode_modules/\n',
      'untracked-ignored-not-used': 'keep'
    }
  })
  // Put a tracked file inside `out/` even though `.gitignore` ignores `out/`.
  mkdirSync(join(project.root, 'out'), { recursive: true })
  writeFileSync(join(project.root, 'out', 'tracked.txt'), 'tracked build input\n')
  git(project.root, 'add', '-f', 'out/tracked.txt')
  git(project.root, 'commit', '-m', 'add tracked file inside out')
  return project
}

describe('workspaces.pruneOnRelease', () => {
  it('removes ignored declared dirs on release, spares tracked/undeclared/unignored dirs, and never prunes trunk', async () => {
    const project = setupRepo('prune-main', {
      poolSize: 1,
      pruneOnRelease: ['release', 'out', 'not-ignored']
    })

    // Seed dirs in the trunk too — trunk must NEVER be pruned.
    mkdirSync(join(project.root, 'release'), { recursive: true })
    writeFileSync(join(project.root, 'release', 'trunk-artifact.bin'), 'trunk output\n')

    const ws = await claimWorkspace(project, 'session-1')
    expect(ws).not.toBeNull()

    // Populate the pooled slot with four directory classes:
    // 1) declared + ignored + untracked (`release/`) -> PRUNED
    // 2) declared + ignored + contains tracked file (`out/`) -> KEPT
    // 3) undeclared + ignored (`node_modules/`) -> KEPT
    // 4) declared + NOT git-ignored (`not-ignored/`) -> KEPT
    mkdirSync(join(ws!.path, 'release', 'nested'), { recursive: true })
    writeFileSync(join(ws!.path, 'release', 'app.exe'), 'binary-ish')
    writeFileSync(join(ws!.path, 'release', 'nested', 'chunk.js'), 'chunk')
    writeFileSync(join(ws!.path, 'out', 'ignored-sibling.js'), 'output')
    mkdirSync(join(ws!.path, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(ws!.path, 'node_modules', 'pkg', 'index.js'), 'dep')
    mkdirSync(join(ws!.path, 'not-ignored'), { recursive: true })
    writeFileSync(join(ws!.path, 'not-ignored', 'notes.txt'), 'user file')

    releaseWorkspace(ws!.claimId)
    await awaitPoolPrunes()

    expect(existsSync(join(ws!.path, 'release'))).toBe(false)
    expect(existsSync(join(ws!.path, 'out', 'tracked.txt'))).toBe(true)
    expect(existsSync(join(ws!.path, 'out', 'ignored-sibling.js'))).toBe(true)
    expect(existsSync(join(ws!.path, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(ws!.path, 'not-ignored', 'notes.txt'))).toBe(true)

    // Claiming & releasing the trunk must never prune trunk directories.
    const trunk = claimTrunk(project, 'trunk-task')
    expect(trunk).not.toBeNull()
    releaseWorkspace(trunk!.claimId)
    releaseAllFor('trunk-task')
    await awaitPoolPrunes()
    expect(existsSync(join(project.root, 'release', 'trunk-artifact.bin'))).toBe(true)
  })

  it('prunes via releaseAllFor as well and skips if another claim takes the slot first', async () => {
    const project = setupRepo('prune-claim-guard', {
      poolSize: 1,
      pruneOnRelease: ['release']
    })

    const first = await claimWorkspace(project, 'task-holder-1')
    expect(first).not.toBeNull()
    mkdirSync(join(first!.path, 'release'), { recursive: true })
    writeFileSync(join(first!.path, 'release', 'build.bin'), '12345')

    // Releasing via `releaseAllFor` schedules async prune; claiming the slot synchronously before
    // the async prune executes must prevent deletion while the new claim holds the slot.
    releaseAllFor('task-holder-1')
    const second = claim(workspacePoolId(project.id), 'task-holder-2', 1, first!.path)
    expect(second?.member).toBeTruthy()
    expect(samePath(second!.member!, first!.path)).toBe(true)
    await awaitPoolPrunes()
    expect(existsSync(join(first!.path, 'release', 'build.bin'))).toBe(true)

    // Once finally released with no successor holding the slot, `release/` is removed.
    releaseAllFor('task-holder-2')
    await awaitPoolPrunes()
    expect(existsSync(join(first!.path, 'release'))).toBe(false)
  })
})

describe('measurePoolSizes', () => {
  it('walks bytes with fs per pool slot and caches measurements for 10 minutes per project', async () => {
    const t0 = Date.UTC(2026, 10, 15, 10, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const project = setupRepo('pool-sizes', { poolSize: 2 })
    const members = await ensurePool(project)
    expect(members).toHaveLength(2)

    const ws1File = join(members[0]!, 'payload.bin')
    const ws2File = join(members[1]!, 'payload2.bin')
    writeFileSync(ws1File, 'x'.repeat(1200))
    writeFileSync(ws2File, 'y'.repeat(2400))

    const initial = await measurePoolSizes(project)
    expect(initial).toHaveLength(2)
    expect(samePath(initial[0]!.path, members[0]!)).toBe(true)
    expect(samePath(initial[1]!.path, members[1]!)).toBe(true)
    expect(initial[0]!.measuredAt).toBe(t0)
    expect(initial[0]!.bytes).toBeGreaterThanOrEqual(1200)
    expect(initial[1]!.bytes).toBeGreaterThanOrEqual(2400)

    // Add more bytes on disk; reading within 10 minutes returns the cached reading unchanged.
    writeFileSync(join(members[0]!, 'extra.bin'), 'z'.repeat(4096))
    vi.setSystemTime(t0 + 9 * 60_000)
    const cached = await measurePoolSizes(project)
    expect(cached).toEqual(initial)

    // Past 10 minutes, measurement runs again and observes the added bytes.
    const tLater = t0 + 10 * 60_000 + 1
    vi.setSystemTime(tLater)
    const refreshed = await measurePoolSizes(project)
    expect(refreshed[0]!.measuredAt).toBe(tLater)
    expect(refreshed[0]!.bytes).toBeGreaterThanOrEqual(initial[0]!.bytes + 4096)
  })

  it('returns empty list for trunk-only projects', async () => {
    const project = setupRepo('trunk-only-sizes', { poolSize: 0 })
    expect(await measurePoolSizes(project)).toEqual([])
  })
})
