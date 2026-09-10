import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 41 survives being replayed, which is the one thing here that cannot be undone in the
 * field.
 *
 * ⛔ **Pinned by text through `versionBefore`, never by number.** Two branches added a migration 27
 * in parallel once and `MIGRATION_COUNT - 1` quietly began asserting somebody else's work; a literal
 * here would become a test of whichever migration lands next.
 */

let dir: string
let db: typeof import('./db.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-splitmigration-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const columns = (table: string): string[] =>
  (db.db().prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('the edge-release and plan-target migration', () => {
  it('adds its columns, and replaying it is a no-op rather than an error', () => {
    const file = join(dir, 'replay.db')
    db.openDb(file)
    expect(columns('task_deps')).toContain('require')
    expect(columns('tasks')).toContain('landing_target')
    expect(columns('tasks')).toContain('child_defaults_json')

    // Rewind to just before this migration and reopen, which replays it against a database that
    // already has its columns — the shape a `hasColumn` guard exists for.
    const before = db.versionBefore('task_deps add column require')
    db.db().exec(`pragma user_version = ${before}`)
    db.closeDb()
    expect(() => db.openDb(file)).not.toThrow()
    expect(columns('task_deps')).toContain('require')
    expect(columns('tasks')).toContain('landing_target')
  })

  it("⛔ defaults every existing edge to `completed`, so no edge in the fleet changes meaning", () => {
    const rows = db
      .db()
      .prepare("select sql from sqlite_master where type = 'table' and name = 'task_deps'")
      .all() as { sql: string }[]
    // A fresh database builds the table from the base schema plus the alter; either way the default
    // has to be `completed`. Assert it from the column metadata rather than the DDL text.
    const info = db.db().prepare('pragma table_info(task_deps)').all() as {
      name: string
      dflt_value: string | null
    }[]
    const require = info.find((c) => c.name === 'require')
    expect(require).toBeDefined()
    expect(String(require?.dflt_value ?? '')).toContain('completed')
    expect(rows.length).toBe(1)
  })
})
