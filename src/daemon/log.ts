import { appendFileSync, statSync, renameSync, existsSync } from 'node:fs'
import { ensureDir, paths } from './paths.js'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[(process.env.AGENTYARD_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info
const MAX_BYTES = 5 * 1024 * 1024

type Listener = (level: Level, message: string, ts: number) => void
const listeners = new Set<Listener>()

/** The daemon pushes warn/error to connected UIs so a failure is visible without opening a file. */
export function onLog(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function rotate(): void {
  try {
    if (existsSync(paths.daemonLog) && statSync(paths.daemonLog).size > MAX_BYTES) {
      renameSync(paths.daemonLog, `${paths.daemonLog}.1`)
    }
  } catch {
    // Rotation is best-effort. Never let logging break the fleet.
  }
}

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return
  const ts = Date.now()
  const message = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safe(a)))
    .join(' ')
  const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`
  try {
    ensureDir(paths.logs)
    rotate()
    appendFileSync(paths.daemonLog, line)
  } catch {
    // Disk full or permissions. Still emit to stderr below.
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line)
  else if (process.env.AGENTYARD_LOG_STDOUT) process.stdout.write(line)
  for (const fn of listeners) fn(level, message, ts)
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a)
}
