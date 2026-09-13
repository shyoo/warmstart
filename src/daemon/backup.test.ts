import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The one copy of the fleet's record that lives outside the file a crash could take with it.
 *
 * ⚠️ What matters here is not that a file gets written — it is that the backup is a *real* SQLite
 * database (readable by a fresh connection, not a half-flushed WAL) and that pruning removes only
 * what is genuinely old, never today's.
 */

let dir: string
let db: typeof import('./db.js')
let paths: typeof import('./paths.js')
let backup: typeof import('./backup.js')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-backup-test-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  paths = await import('./paths.js')
  backup = await import('./backup.js')
  db.openDb(join(dir, 'warmstart.db'))
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks
  }
})

describe('backing up the database', () => {
  it('writes a real, openable SQLite database named for today', async () => {
    const target = await backup.backupToday()
    expect(target).not.toBeNull()
    expect(existsSync(target!)).toBe(true)

    // ⛔ The point of using the online backup API rather than a file copy: what lands on disk has
    // to be a database a fresh connection can open and query, not a torn snapshot of a WAL-mode file.
    const { DatabaseSync } = await import('node:sqlite')
    const opened = new DatabaseSync(target!, { readOnly: true })
    const row = opened.prepare('select count(*) as n from workers').get() as { n: number }
    expect(row.n).toBe(0)
    opened.close()
  })

  it('does nothing the second time the same day', async () => {
    const before = readdirSync(paths.paths.backups).length
    const again = await backup.backupToday()
    expect(again).toBeNull()
    expect(readdirSync(paths.paths.backups).length).toBe(before)
  })

  it('lists backups newest first, with their size', () => {
    const files = backup.backupFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files[0]?.bytes).toBeGreaterThan(0)
    for (let i = 1; i < files.length; i++) {
      expect(files[i - 1]!.modifiedAt).toBeGreaterThanOrEqual(files[i]!.modifiedAt)
    }
  })
})

describe('pruning', () => {
  const backdate = (name: string, days: number): string => {
    const path = join(paths.paths.backups, name)
    writeFileSync(path, 'old\n')
    const when = new Date(Date.now() - days * 86_400_000)
    utimesSync(path, when, when)
    return path
  }

  it('removes a backup older than the retention window and keeps the rest', () => {
    backdate('warmstart-1999-01-01.db', 30)
    backdate('warmstart-1999-01-02.db', 20)
    backdate('warmstart-1999-01-03.db', 2)

    expect(backup.pruneBackups(14)).toBe(2)
    const left = readdirSync(paths.paths.backups)
    expect(left).toContain('warmstart-1999-01-03.db')
    expect(left).not.toContain('warmstart-1999-01-01.db')
    expect(left).not.toContain('warmstart-1999-01-02.db')
  })

  it('never touches today, whatever the window', () => {
    expect(existsSync(paths.paths.backupFor())).toBe(true)
    backup.pruneBackups(0.5)
    expect(existsSync(paths.paths.backupFor())).toBe(true)
  })

  it('ignores a file in the backups directory that is not one of ours', () => {
    writeFileSync(join(paths.paths.backups, 'notes.txt'), 'not a backup')
    expect(backup.backupFiles().some((f) => f.name === 'notes.txt')).toBe(false)
    backup.pruneBackups(0)
    expect(readdirSync(paths.paths.backups)).toContain('notes.txt')
  })
})
