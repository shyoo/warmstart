import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import type { DaemonEndpoint } from '@shared/protocol.js'
import { ensureDir, paths } from './paths.js'
import { log } from './log.js'

/**
 * One orchestratord per data directory.
 *
 * The fleet is a set of real processes and quota budgets; two daemons scheduling against the same
 * database would double-spend both. The lock is a file holding a pid, and it is taken over when the
 * pid is gone - a daemon that crashed must not lock its own successor out forever.
 */
export function acquireLock(): boolean {
  ensureDir(paths.root)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch {
      const holder = readHolder()
      if (holder !== null && isAlive(holder)) {
        log.warn(`orchestratord already running as pid ${holder}`)
        return false
      }
      log.warn(`removing stale lock from pid ${holder ?? 'unknown'}`)
      try {
        unlinkSync(paths.lock)
      } catch {
        return false
      }
    }
  }
  return false
}

export function releaseLock(): void {
  try {
    if (existsSync(paths.lock) && readHolder() === process.pid) unlinkSync(paths.lock)
  } catch {
    // Nothing useful to do while shutting down.
  }
}

function readHolder(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(paths.lock, 'utf8').trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Publish where to reach this daemon.
 *
 * Mode 0600 because the token is an authorisation to spawn processes. Windows ignores the mode bit,
 * so the file's protection there comes from the user profile directory's ACL - which is why the data
 * directory lives under APPDATA and not somewhere world-readable.
 */
export function publishEndpoint(endpoint: DaemonEndpoint): void {
  ensureDir(paths.root)
  writeFileSync(paths.endpoint, JSON.stringify(endpoint, null, 2), { mode: 0o600 })
}

export function readEndpoint(): DaemonEndpoint | null {
  try {
    return JSON.parse(readFileSync(paths.endpoint, 'utf8')) as DaemonEndpoint
  } catch {
    return null
  }
}

export function clearEndpoint(): void {
  try {
    if (existsSync(paths.endpoint)) unlinkSync(paths.endpoint)
  } catch {
    // Best effort.
  }
}
