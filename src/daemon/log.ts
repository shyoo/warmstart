import { appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, paths } from './paths.js'

/**
 * The daemon's log.
 *
 * ⛔ **This is the only account of what the fleet did while nobody was watching**, which is the whole
 * premise of running a daemon. Until 2026-08-28 it was write-only in practice: one growing file
 * rotated at 5MB into a single `.1`, and nothing in the app displayed it. Only `warn` and `error`
 * were forwarded to a UI, and no panel rendered even those — so "when did it probe that account?"
 * had no answer short of opening a file nobody knew the path of.
 *
 * Three things make it an account rather than a spool:
 *
 *  1. **A file per day** (`orchestratord-2026-08-28.log`), pruned after `KEEP_DAYS`. Size rotation
 *     answers *is the disk safe*; a date answers *what happened on Tuesday*, which is the question
 *     people actually ask.
 *  2. **A ring buffer**, so a UI attaching at any moment gets the recent past immediately rather
 *     than only what happens next. ⚠️ A window opened after the interesting minute is the normal
 *     case, not the exception.
 *  3. **Every level is broadcast**, not just failures. A fleet that is working correctly and a fleet
 *     that is doing nothing look identical when only errors are reported.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: Level
  message: string
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[(process.env.MULTI_AGENT_CONTROLLER_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

/**
 * How much history a UI gets on connect, and how long the files stay.
 *
 * ⚠️ The buffer is deliberately small and the files deliberately long-lived. Memory in a process
 * that must run for weeks is the scarce resource; disk is not, and a fortnight of a daemon this
 * quiet is a few megabytes.
 */
const BUFFER_LINES = 2000
const KEEP_DAYS = 14

const ring: LogEntry[] = []

type Listener = (entry: LogEntry) => void
const listeners = new Set<Listener>()

/** Everything the daemon logs, pushed to connected UIs so a failure is visible without a file. */
export function onLog(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The recent past, newest last. What a UI shows before its first live line arrives. */
export function recentLog(limit = 500, level: Level = 'debug'): LogEntry[] {
  const min = LEVELS[level]
  const matching = ring.filter((e) => LEVELS[e.level] >= min)
  return matching.slice(Math.max(0, matching.length - limit))
}

/**
 * The files on disk, newest first — the offline half, for a question the buffer is too small for.
 *
 * ⚠️ Reported rather than read. The UI shows the directory and what is in it; opening a 300KB file
 * belongs in an editor, not in a React list, and the ring buffer already covers the live case.
 */
export function logFiles(): Array<{ name: string; path: string; bytes: number; modifiedAt: number }> {
  try {
    return readdirSync(paths.logs)
      .filter((name) => name.startsWith('orchestratord') && name.endsWith('.log'))
      .map((name) => {
        const path = join(paths.logs, name)
        const stat = statSync(path)
        return { name, path, bytes: stat.size, modifiedAt: stat.mtimeMs }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  } catch {
    return []
  }
}

/**
 * Delete log files older than `keepDays`, and return how many went.
 *
 * ⛔ **By mtime, never by parsing the name.** A file the operator renamed, or one written by a build
 * that stamped them differently, must not become immortal — and must not throw here either. Note
 * that `logFiles` has already excluded everything that is not a log, so a stray file in the
 * directory is not a candidate.
 *
 * ⚠️ Deletion is the one thing in this module that can lose evidence, so it is best-effort in the
 * safe direction: a file that cannot be removed is left alone and tried again next start.
 */
export function pruneLogs(keepDays = KEEP_DAYS): number {
  const cutoff = Date.now() - keepDays * 86_400_000
  let removed = 0
  for (const file of logFiles()) {
    if (file.modifiedAt >= cutoff) continue
    try {
      unlinkSync(file.path)
      removed++
    } catch {
      // Someone has it open. It will be pruned on the next start.
    }
  }
  return removed
}

/**
 * ⚠️ Runs once, on the first write of a process, not on a timer. A daemon that lives for weeks would
 * otherwise never prune, and one that lives for a minute should not pay for a directory scan.
 */
let pruned = false
function pruneOnce(): void {
  if (pruned) return
  pruned = true
  pruneLogs()
}

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return
  const ts = Date.now()
  const message = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safe(a)))
    .join(' ')
  const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`

  ring.push({ ts, level, message })
  if (ring.length > BUFFER_LINES) ring.splice(0, ring.length - BUFFER_LINES)

  try {
    ensureDir(paths.logs)
    pruneOnce()
    // ⚠️ The path is resolved per write, so a daemon running at midnight rolls into the new day's
    // file on its own. Nothing schedules it and nothing has to notice the date changed.
    appendFileSync(paths.daemonLog, line)
  } catch {
    // Disk full or permissions. Still emit to stderr below.
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line)
  else if (process.env.MULTI_AGENT_CONTROLLER_LOG_STDOUT) process.stdout.write(line)
  for (const fn of listeners) fn({ ts, level, message })
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
