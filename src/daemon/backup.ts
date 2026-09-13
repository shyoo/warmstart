import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { backup as sqliteBackup } from 'node:sqlite'
import { basename, join } from 'node:path'
import { db } from './db.js'
import { ensureDir, paths } from './paths.js'
import { log } from './log.js'

/**
 * Database backups.
 *
 * ⛔ **The fleet's whole record — task history, transcripts, cost evidence — lives in one SQLite
 * file, and until this there was no copy of it anywhere.** One lost or corrupted disk was one lost
 * fleet. This mirrors `logs.ts`: a dated file per day, pruned after a fortnight, written without
 * anyone having to remember to.
 *
 * ⚠️ **`node:sqlite`'s own `backup()`, never a raw file copy.** The database runs in WAL mode
 * (`db.ts`), and copying `warmstart.db` with `fs.copyFile` while it is open can miss pages still
 * sitting in the `-wal` sidecar. The online backup API reads through SQLite's own pager instead,
 * which is what makes it safe to run against a live, possibly-busy database.
 */

const RETENTION_DAYS = 14

/** The backup files on disk, newest first. */
export function backupFiles(): Array<{ name: string; path: string; bytes: number; modifiedAt: number }> {
  try {
    return readdirSync(paths.backups)
      .filter((name) => /^warmstart-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .map((name) => {
        const path = join(paths.backups, name)
        const stat = statSync(path)
        return { name, path, bytes: stat.size, modifiedAt: stat.mtimeMs }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  } catch {
    return []
  }
}

/**
 * Delete backups older than `keepDays`, and return how many went.
 *
 * ⛔ **By mtime, never by parsing the name**, for the same reason as `pruneLogs`: a file this
 * function did not name itself must not become immortal, and a bad name must not throw here either.
 */
export function pruneBackups(keepDays = RETENTION_DAYS): number {
  const cutoff = Date.now() - keepDays * 86_400_000
  let removed = 0
  for (const file of backupFiles()) {
    if (file.modifiedAt >= cutoff) continue
    try {
      unlinkSync(file.path)
      removed++
    } catch {
      // Someone has it open. Tried again next time.
    }
  }
  return removed
}

/**
 * Back up the database, once for the day.
 *
 * ⚠️ **Idempotent by construction, not by a flag.** The target filename is today's date, so calling
 * this once at startup and again on every hourly sweep costs nothing beyond an `existsSync` check
 * until the date actually rolls over — the same shape as `pruneOnce` in `logs.ts`.
 */
export async function backupToday(): Promise<string | null> {
  const target = paths.backupFor()
  if (existsSync(target)) return null
  try {
    ensureDir(paths.backups)
    await sqliteBackup(db(), target)
    log.info(`database backed up to ${basename(target)}`)
    const removed = pruneBackups()
    if (removed) log.info(`pruned ${removed} backup(s) older than ${RETENTION_DAYS} days`)
    return target
  } catch (err) {
    log.error(`database backup failed: ${String(err)}`)
    return null
  }
}
