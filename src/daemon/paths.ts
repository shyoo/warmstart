import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Where agentyard keeps its own state.
 *
 * Computed here rather than taken from Electron's `app.getPath`, because orchestratord runs as a
 * plain Node process (Electron with ELECTRON_RUN_AS_NODE) where the `electron` module is not usable.
 * The main process reads the same function so both agree.
 *
 * `AGENTYARD_DATA_DIR` overrides everything: it is what tests use, and what lets someone keep the
 * fleet on another volume. Nothing about one machine is baked in.
 */
export function dataDir(): string {
  const override = process.env.AGENTYARD_DATA_DIR
  if (override && override.trim()) return override

  const home = homedir()
  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'agentyard')
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'agentyard')
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'agentyard')
  }
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
    return join(dataDir(), 'agentyard.db')
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
