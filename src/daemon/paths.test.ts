import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The `agentyard` → `multi_agent_controller` data-directory rename.
 *
 * ⛔ This is the only change in the rename that can destroy something a user cannot get back. The
 * data directory holds the fleet database *and the isolation roots the vendor CLIs authenticate
 * against* — a worker's root is where Claude Code keeps that account's credential. Renaming the
 * directory without moving what is in it silently retires every worker; moving it without repointing
 * the absolute `isolation_root` recorded in the database does the same thing more quietly.
 *
 * ⚠️ Driven through the real environment variables the platform branch reads, with modules reset
 * between cases, because `adoptLegacyDataDir` runs at most once per process by design.
 */

const HOME_KEYS = ['APPDATA', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE'] as const
let sandbox: string
const saved = new Map<string, string | undefined>()

function legacyRootIn(base: string): string {
  switch (process.platform) {
    case 'win32':
      return join(base, 'agentyard')
    case 'darwin':
      return join(base, 'Library', 'Application Support', 'agentyard')
    default:
      return join(base, '.local', 'share', 'agentyard')
  }
}

function newRootIn(base: string): string {
  return legacyRootIn(base).replace(/agentyard$/, 'multi_agent_controller')
}

beforeEach(() => {
  vi.resetModules()
  sandbox = mkdtempSync(join(tmpdir(), 'mac-paths-'))
  for (const k of HOME_KEYS) saved.set(k, process.env[k])
  saved.set('MULTI_AGENT_CONTROLLER_DATA_DIR', process.env.MULTI_AGENT_CONTROLLER_DATA_DIR)
  delete process.env.MULTI_AGENT_CONTROLLER_DATA_DIR
  // Every platform branch points at the sandbox, so the test is the same on all three.
  process.env.APPDATA = sandbox
  process.env.XDG_DATA_HOME = join(sandbox, '.local', 'share')
  process.env.HOME = sandbox
  process.env.USERPROFILE = sandbox
})

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(sandbox, { recursive: true, force: true })
})

describe('a data directory written before the rename', () => {
  it('is moved rather than abandoned, with what is inside it', async () => {
    const legacy = legacyRootIn(sandbox)
    mkdirSync(join(legacy, 'workers', 'work-claude'), { recursive: true })
    writeFileSync(join(legacy, 'workers', 'work-claude', '.credentials.json'), '{"pretend":true}')

    const { dataDir } = await import('./paths.js')
    const dir = dataDir()

    expect(dir).toBe(newRootIn(sandbox))
    expect(existsSync(legacy), 'the old directory was left behind as a second copy').toBe(false)
    expect(readFileSync(join(dir, 'workers', 'work-claude', '.credentials.json'), 'utf8')).toBe(
      '{"pretend":true}'
    )
  })

  it('brings its database along under the new name, WAL and all', async () => {
    const legacy = legacyRootIn(sandbox)
    mkdirSync(legacy, { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) {
      writeFileSync(join(legacy, `agentyard.db${suffix}`), `payload${suffix}`)
    }

    const { dataDir, paths } = await import('./paths.js')
    const dir = dataDir()

    expect(paths.db).toBe(join(dir, 'multi_agent_controller.db'))
    for (const suffix of ['', '-wal', '-shm']) {
      expect(readFileSync(join(dir, `multi_agent_controller.db${suffix}`), 'utf8')).toBe(
        `payload${suffix}`
      )
    }
  })

  // ⛔ The half-migrated state is the one with no good recovery, so an existing target always wins.
  it('is left untouched when the new directory already exists', async () => {
    const legacy = legacyRootIn(sandbox)
    const target = newRootIn(sandbox)
    mkdirSync(legacy, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, 'marker'), 'old')
    writeFileSync(join(target, 'marker'), 'new')

    const { dataDir } = await import('./paths.js')
    expect(dataDir()).toBe(target)
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('new')
    expect(readFileSync(join(legacy, 'marker'), 'utf8')).toBe('old')
  })

  // ⚠️ A root the user chose is theirs, wherever it lives. Nothing may be moved or rewritten.
  it('is ignored entirely when the user has named a data directory of their own', async () => {
    const legacy = legacyRootIn(sandbox)
    mkdirSync(legacy, { recursive: true })
    const mine = join(sandbox, 'somewhere-else')
    process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = mine

    const { dataDir } = await import('./paths.js')
    expect(dataDir()).toBe(mine)
    expect(existsSync(legacy)).toBe(true)
  })
})

describe('the worker paths recorded before the rename', () => {
  it('are repointed at the moved directory, so no worker loses its credential root', async () => {
    const legacy = legacyRootIn(sandbox)
    mkdirSync(legacy, { recursive: true })

    // A database written by the old build: worker roots stored absolute, under the old directory.
    const { DatabaseSync } = await import('node:sqlite')
    const seed = new DatabaseSync(join(legacy, 'agentyard.db'))
    seed.exec('create table workers (id text primary key, isolation_root text not null)')
    seed
      .prepare('insert into workers values (?, ?)')
      .run('w1', join(legacy, 'workers', 'work-claude'))
    seed.prepare('insert into workers values (?, ?)').run('w2', join(sandbox, 'chosen-by-hand'))
    seed.close()

    const { dataDir } = await import('./paths.js')
    const dir = dataDir()
    const { repointIsolationRoots } = await import('./db.js')
    const conn = new DatabaseSync(join(dir, 'multi_agent_controller.db'))
    repointIsolationRoots(conn)

    const got = Object.fromEntries(
      (conn.prepare('select id, isolation_root from workers').all() as unknown[]).map((r) => {
        const w = r as { id: string; isolation_root: string }
        return [w.id, w.isolation_root]
      })
    )
    conn.close()

    expect(got.w1).toBe(join(dir, 'workers', 'work-claude'))
    // ⛔ Prefix-matched against the legacy root only. A root outside it was the user's choice.
    expect(got.w2).toBe(join(sandbox, 'chosen-by-hand'))
  })
})
