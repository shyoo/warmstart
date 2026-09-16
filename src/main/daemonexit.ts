import { readFileSync } from 'node:fs'
import { paths } from '../daemon/paths.js'

/**
 * Why orchestratord died before it answered, in its own words.
 *
 * The daemon is spawned detached with `stdio: 'ignore'` so that it outlives the window, which
 * means the window never sees its stderr. But `main().catch` in `daemon/index.ts` writes one
 * `ERROR orchestratord failed to start: <reason>` line to the day's log before exiting, and that
 * line is the whole diagnosis. Measured 2026-09-15 on the first packaged install of 0.1.0-rc.1:
 * the daemon refused a newer database schema and exited in under a second, five times, with an
 * actionable one-liner each time — and the window said *Starting orchestratord…* for two minutes,
 * then *did not answer within 20s*. Reading the line back is what turns that into a five-second
 * diagnosis.
 */
const FAILED_TO_START = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ERROR orchestratord failed to start: (.*)$/

/**
 * The last start-failure reason logged at or after `since`, or null when the log holds none.
 *
 * ⚠️ The stack trace follows on continuation lines; only the first line is the reason, and
 * `Error: ` is stripped because the operator is reading a sentence, not a constructor.
 */
export function startupFailureIn(logText: string, since: number): string | null {
  let found: string | null = null
  for (const line of logText.split(/\r?\n/)) {
    const match = FAILED_TO_START.exec(line)
    if (!match) continue
    if (Date.parse(match[1]!) < since) continue
    found = match[2]!.replace(/^Error:\s*/, '').trim()
  }
  return found
}

/**
 * Read today's log (and yesterday's, for a spawn that straddled midnight) for a reason logged
 * since `since`. Never throws: a missing log is the same answer as a log with nothing in it.
 */
export function readStartupFailure(since: number, now: number = Date.now()): string | null {
  const files = [paths.daemonLogFor(now)]
  const yesterday = paths.daemonLogFor(now - 24 * 60 * 60 * 1000)
  if (yesterday !== files[0]) files.unshift(yesterday)
  let found: string | null = null
  for (const file of files) {
    try {
      found = startupFailureIn(readFileSync(file, 'utf8'), since) ?? found
    } catch {
      // No such file, or unreadable: nothing to report from it.
    }
  }
  return found
}
