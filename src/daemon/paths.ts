import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'

/**
 * The directory name this app writes under, and the one it used to write under.
 *
 * ⚠️ `agentyard` was the project's name before it had a public one. It survives as the internal
 * name and in `legacyDataDir`, because a rename that silently abandons someone's fleet - their
 * database, and the isolation roots holding their vendor credentials - is data loss dressed up as
 * a cosmetic change. See `adoptLegacyDataDir`.
 */
const APP_DIR = 'multi_agent_controller'
const LEGACY_APP_DIR = 'agentyard'

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

/** Where a pre-rename install kept its state. Read only to migrate off it, never written to. */
export function legacyDataDir(): string {
  return platformDataDir(LEGACY_APP_DIR)
}

let adopted = false

/**
 * Move a pre-rename data directory to the new name, once.
 *
 * ⛔ A rename, not a copy: two directories both holding live credential roots is worse than either
 * one, and the isolation roots inside are what the vendor CLIs authenticate against. The absolute
 * paths recorded in the database still point at the old location afterwards - `repointIsolationRoots`
 * in db.ts fixes those on the next open, which is why this is safe to do before the database exists.
 *
 * ⚠️ Deliberately does nothing if the new directory is already there. A half-migrated install is the
 * one state with no good recovery, so an existing target always wins and the old directory is left
 * untouched for the user to deal with.
 */
function adoptLegacyDataDir(target: string): void {
  if (adopted) return
  adopted = true
  const legacy = legacyDataDir()
  if (legacy === target || existsSync(target) || !existsSync(legacy)) return
  try {
    mkdirSync(join(target, '..'), { recursive: true })
    renameSync(legacy, target)
    const legacyDb = join(target, `${LEGACY_APP_DIR}.db`)
    if (existsSync(legacyDb) && !existsSync(join(target, `${APP_DIR}.db`))) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(legacyDb + suffix)) renameSync(legacyDb + suffix, join(target, `${APP_DIR}.db${suffix}`))
      }
    }
  } catch {
    // Not fatal, and not worth a crash on startup: the app comes up on an empty data directory and
    // the old one is still on disk, intact, for the user to move by hand.
  }
}

/**
 * Where Multi Agent Controller keeps its own state.
 *
 * Computed here rather than taken from Electron's `app.getPath`, because orchestratord runs as a
 * plain Node process (Electron with ELECTRON_RUN_AS_NODE) where the `electron` module is not usable.
 * The main process reads the same function so both agree.
 *
 * `MULTI_AGENT_CONTROLLER_DATA_DIR` overrides everything: it is what tests use, and what lets someone
 * keep the fleet on another volume. Nothing about one machine is baked in.
 */
export function dataDir(): string {
  const override = process.env.MULTI_AGENT_CONTROLLER_DATA_DIR
  if (override && override.trim()) return override

  const dir = platformDataDir(APP_DIR)
  adoptLegacyDataDir(dir)
  return dir
}

export function ensureDir(path: string): string {
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
  get logs() {
    return join(dataDir(), 'logs')
  },
  /** User-supplied cost models, which take precedence over the ones shipped with the app. */
  get costModels() {
    return join(dataDir(), 'costmodels')
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
  get daemonLog() {
    return join(dataDir(), 'logs', 'orchestratord.log')
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
