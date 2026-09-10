import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { appEnv } from '@shared/env.js'

/**
 * The directory name this app writes under, and every one it used to write under.
 *
 * ⚠️ **Two renames now, so this is a chain and not a pair.** `agentyard` was the project's name
 * before it had a public one; `multi_agent_controller` was the first public one; `warmstart` is the
 * name it launched under. A rename that silently abandons someone's fleet - their database, and the
 * isolation roots holding their vendor credentials - is data loss dressed up as a cosmetic change,
 * and that is as true of the second rename as it was of the first. See `adoptLegacyDataDir`.
 *
 * ⛔ **Ordered newest-first, and that ordering is load-bearing.** An install that predates both
 * renames may have *both* old directories on disk if a previous migration failed part-way; adopting
 * the newer one is the only choice that cannot lose work done after the first rename.
 */
const APP_DIR = 'warmstart'
const LEGACY_APP_DIRS = ['multi_agent_controller', 'agentyard'] as const

function platformDataDir(name: string): string {
  const home = homedir()
  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), name)
    case 'darwin':
      return join(home, 'Library', 'Application Support', name)
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), name)
  }
}

/**
 * Where pre-rename installs kept their state, newest name first. Read only to migrate off, never
 * written to.
 */
export function legacyDataDirs(): string[] {
  return LEGACY_APP_DIRS.map(platformDataDir)
}

let adopted = false

/**
 * Adopt a pre-rename data directory into the current one, once.
 *
 * ⛔ **A move, not a copy**: two directories both holding live credential roots is worse than either
 * one, and the isolation roots inside are what the vendor CLIs authenticate against. The absolute
 * paths recorded in the database still point at the old location afterwards — `repointIsolationRoots`
 * in db.ts fixes those on the next open, which is why this is safe to do before the database exists.
 *
 * ⛔ **What decides is our database, not the directory.** This used to return early on
 * `existsSync(target)`, which is wrong on Windows and wrong in the one case that matters: the data
 * directory (`<appData>/warmstart`) collides **case-insensitively** with Electron's own userData
 * folder (`<appData>/<productName>` → `Warmstart`), which exists from the app's first launch and
 * holds a Chromium profile — Cache, Local Storage, Preferences. Measured on this install 2026-09-10:
 * the target directory was already there with 15 Chromium entries and no database, while 37MB of
 * fleet sat in `<appData>/multi_agent_controller`. The old guard would have skipped the adoption
 * **forever** and started every launch on an empty fleet, which is precisely the data loss this
 * function exists to prevent.
 */
function adoptLegacyDataDir(target: string): void {
  if (adopted) return
  adopted = true
  // Already ours: nothing to do, and nothing may be moved over it.
  if (existsSync(join(target, `${APP_DIR}.db`))) return

  // ⛔ **First name that exists wins, newest first.** Not "every one that exists": merging two old
  // directories would have to decide which copy of a credential root is current, and there is no
  // honest answer to that. The ones not adopted stay on disk, untouched.
  const legacy = legacyDataDirs().find((dir) => dir !== target && existsSync(dir))
  if (!legacy) return

  try {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(legacy)) {
      // ⚠️ The database is named after whichever era wrote it, and that is **not** necessarily the
      // directory holding it: a migration that failed half-way leaves an `agentyard.db` inside a
      // `multi_agent_controller` directory. Rename any era's database — and its `-wal`/`-shm`
      // siblings, which are useless apart from it — onto the current name as it moves.
      const renamed = LEGACY_APP_DIRS.reduce(
        (name, old) => (name.startsWith(`${old}.db`) ? `${APP_DIR}.db${name.slice(`${old}.db`.length)}` : name),
        entry
      )
      const to = join(target, renamed)
      // ⛔ An entry already in the target wins, and the legacy copy is left where it is. Half a move
      // is recoverable by hand; a silent overwrite of something the app is already using is not.
      if (existsSync(to)) continue
      renameSync(join(legacy, entry), to)
    }
    // ⚠️ Only when it is genuinely empty. `rmdirSync` refuses a directory that still has anything
    // in it, which is exactly the guard wanted here: whatever could not be moved — because the
    // target already had it — stays where the user can find it, and an empty husk does not sit
    // around looking like a second copy of the fleet.
    try {
      rmdirSync(legacy)
    } catch {
      // Something is still in there. That is information, not a failure.
    }
  } catch {
    // Not fatal, and not worth a crash on startup: the app comes up on whatever it could adopt and
    // the rest is still on disk, intact, for the user to move by hand.
  }
}

/**
 * Where Warmstart keeps its own state.
 *
 * Computed here rather than taken from Electron's `app.getPath`, because orchestratord runs as a
 * plain Node process (Electron with ELECTRON_RUN_AS_NODE) where the `electron` module is not usable.
 * The main process reads the same function so both agree.
 *
 * `WARMSTART_DATA_DIR` overrides everything: it is what tests use, and what lets someone
 * keep the fleet on another volume. Nothing about one machine is baked in.
 */
export function dataDir(): string {
  const override = appEnv('DATA_DIR')
  if (override && override.trim()) return override

  const dir = platformDataDir(APP_DIR)
  adoptLegacyDataDir(dir)
  return dir
}

export function ensureDir(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  mkdirSync(path, { recursive: true })
  return path
}

export const paths = {
  get root() {
    return dataDir()
  },
  /** Per-worker credential roots. One directory per account; the vendor CLI owns the contents. */
  get workers() {
    return join(dataDir(), 'workers')
  },
  /**
   * Where a session that belongs to no project runs.
   *
   * ⛔ Not the user's home, and not the worker's credential root. A CLI asks whether it may trust
   * the folder it was opened in, per account, and until somebody answers it **eats every keystroke
   * sent to that session** - which is what silently broke the usage probe on 2026-08-27: `/usage`
   * was typed into a trust dialog and the Enter after it accepted the folder. Home is the worst
   * possible answer to that question and a credential root is the second worst. This directory is
   * empty, stable, and answered once per account.
   */
  get scratch() {
    return join(dataDir(), 'scratch')
  },
  get logs() {
    return join(dataDir(), 'logs')
  },
  /** User-supplied cost models, which take precedence over the ones shipped with the app. */
  get costModels() {
    return join(dataDir(), 'costmodels')
  },
  /** User-supplied benchmark priors, which take precedence over the ones shipped with the app. */
  get benchmarks() {
    return join(dataDir(), 'benchmarks')
  },
  get db() {
    return join(dataDir(), `${APP_DIR}.db`)
  },
  /** Port + token, written 0600. The UI reads this to find a daemon it did not start. */
  get endpoint() {
    return join(dataDir(), 'orchestratord.json')
  },
  get lock() {
    return join(dataDir(), 'orchestratord.lock')
  },
  /**
   * Today's log file.
   *
   * ⚠️ Dated, not a single growing file. One `orchestratord.log` rotated at 5MB answered "what is
   * the daemon doing now" and nothing else: the moment it rolled, the only copy of last week was
   * `orchestratord.log.1`, and the moment it rolled twice that was gone too. A day per file is what
   * makes "what happened on Tuesday" a question with an answer, and it is the unit a person
   * actually asks in. `logs.ts` prunes them.
   */
  daemonLogFor(when: Date | number = Date.now()) {
    const d = typeof when === 'number' ? new Date(when) : when
    // ⛔ Local date, not ISO/UTC. A file called 2026-08-28 must hold what the operator did on the
    // 28th as their clock told it, or an evening's work lands in tomorrow's file.
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return join(dataDir(), 'logs', `orchestratord-${stamp}.log`)
  },
  get daemonLog() {
    return this.daemonLogFor()
  }
}

/** A filesystem-safe directory name for a worker label, with a uniqueness suffix left to the caller. */
export function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'worker'
}
