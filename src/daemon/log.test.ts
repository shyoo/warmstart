import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The record of the hours nobody was watching.
 *
 * ⛔ A daemon whose whole premise is unattended progress has exactly one account of what it did, and
 * until 2026-08-28 that account was unreadable in practice: a single file rotated at 5MB into one
 * `.1`, no screen in the app displaying it, and only `warn`/`error` forwarded to a UI that rendered
 * neither. So "when did it probe that account?" had no answer.
 *
 * ⚠️ What these tests hold is the part that is easy to quietly break later: that the buffer stays
 * bounded, that a file is not lost the moment the date changes, and that pruning removes old files
 * without ever removing today's.
 */

let dir: string
let logmod: typeof import('./log.js')
let paths: typeof import('./paths.js')

/** Only this test's lines. ⚠️ The ring is process-wide; anything else importing a module logs too. */
const MARK = 'logtest-marker'
const mine = (limit = 500): string[] =>
  logmod
    .recentLog(limit, 'debug')
    .filter((e) => e.message.includes(MARK))
    .map((e) => e.message)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-log-'))
  process.env.WARMSTART_DATA_DIR = dir
  // ⛔ Below the default, so the debug-level assertions below test the filter rather than the
  // threshold. The two are different gates and only one of them is this module's job.
  process.env.WARMSTART_LOG_LEVEL = 'debug'
  logmod = await import('./log.js')
  paths = await import('./paths.js')
})

afterAll(() => {
  delete process.env.WARMSTART_LOG_LEVEL
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the file a line lands in', () => {
  it('is named for the day, so yesterday is still a file', () => {
    logmod.log.info(`${MARK} first`)
    const today = readdirSync(paths.paths.logs)
    expect(today.some((n) => /^orchestratord-\d{4}-\d{2}-\d{2}\.log$/.test(n))).toBe(true)
  })

  it('is resolved per write, so a daemon running at midnight rolls on its own', () => {
    // ⛔ The trap this replaces: a path captured once at startup means a process that has been up
    // for a week writes every line into the day it happened to start. Nothing schedules a roll.
    const monday = new Date(2026, 7, 24, 23, 59)
    const tuesday = new Date(2026, 7, 25, 0, 1)
    expect(paths.paths.daemonLogFor(monday)).toMatch(/orchestratord-2026-08-24\.log$/)
    expect(paths.paths.daemonLogFor(tuesday)).toMatch(/orchestratord-2026-08-25\.log$/)
  })

  it('uses the local date, not UTC', () => {
    // ⚠️ An evening's work has to land in the file named for the evening the operator remembers.
    // 22:00 local is already tomorrow in UTC for a good part of the world, this machine included.
    const evening = new Date(2026, 7, 24, 22, 0)
    expect(paths.paths.daemonLogFor(evening)).toMatch(/orchestratord-2026-08-24\.log$/)
  })
})

describe('the buffer a panel reads on connect', () => {
  it('holds what was logged before anything was listening', () => {
    // ⛔ The reason it exists. A window is almost always opened *after* the interesting minute, and
    // a live event stream alone shows such a window nothing at all.
    logmod.log.info(`${MARK} before-any-listener`)
    expect(mine()).toContain(`${MARK} before-any-listener`)
  })

  it('filters by level without re-reading anything', () => {
    logmod.log.debug(`${MARK} chatter`)
    logmod.log.error(`${MARK} the failure`)
    const errorsOnly = logmod
      .recentLog(500, 'error')
      .filter((e) => e.message.includes(MARK))
      .map((e) => e.message)
    expect(errorsOnly).toContain(`${MARK} the failure`)
    expect(errorsOnly).not.toContain(`${MARK} chatter`)
  })

  it('returns the newest lines when asked for fewer than it holds', () => {
    for (let i = 0; i < 5; i++) logmod.log.info(`${MARK} seq-${i}`)
    const last = logmod.recentLog(2, 'debug').map((e) => e.message)
    expect(last).toHaveLength(2)
    expect(last[1]).toBe(`${MARK} seq-4`)
  })

  it('stays bounded however much is logged', () => {
    // ⚠️ This process is meant to run for weeks. An unbounded array here is a memory leak that only
    // shows up on the machines that matter most - the ones left running.
    for (let i = 0; i < 2500; i++) logmod.log.info(`${MARK} flood-${i}`)
    expect(logmod.recentLog(10_000, 'debug').length).toBeLessThanOrEqual(2000)
  })
})

describe('the files on disk', () => {
  it('are listed newest first, with their size', () => {
    logmod.log.info(`${MARK} on-disk`)
    const files = logmod.logFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files[0]?.bytes).toBeGreaterThan(0)
    for (let i = 1; i < files.length; i++) {
      expect(files[i - 1]!.modifiedAt).toBeGreaterThanOrEqual(files[i]!.modifiedAt)
    }
  })

  it('ignores whatever else is in the directory', () => {
    // The data directory is a real folder on somebody's machine. A stray file must not become a
    // row in a list of logs, and must not be a candidate for pruning either.
    writeFileSync(join(paths.paths.logs, 'notes.txt'), 'not a log')
    expect(logmod.logFiles().some((f) => f.name === 'notes.txt')).toBe(false)
  })
})

describe('pruning', () => {
  /** ⚠️ `utimes` rather than waiting a fortnight. The rule is about mtime, so mtime is what is set. */
  const backdate = (name: string, days: number): string => {
    const path = join(paths.paths.logs, name)
    writeFileSync(path, 'old\n')
    const when = new Date(Date.now() - days * 86_400_000)
    utimesSync(path, when, when)
    return path
  }

  it('removes a file older than the window and keeps the rest', () => {
    backdate('orchestratord-1999-01-01.log', 30)
    backdate('orchestratord-1999-01-02.log', 20)
    const recent = backdate('orchestratord-1999-01-03.log', 2)

    expect(logmod.pruneLogs(14)).toBe(2)
    const left = readdirSync(paths.paths.logs)
    expect(left).toContain(basename(recent))
    expect(left).not.toContain('orchestratord-1999-01-01.log')
  })

  it('never touches today, whatever the window', () => {
    // ⛔ The file being written to right now is the one an operator is most likely to want, and a
    // pruner that could take it would turn a disk-space guard into data loss.
    logmod.log.info(`${MARK} keep-me`)
    logmod.pruneLogs(0.5)
    expect(readdirSync(paths.paths.logs)).toContain(basename(paths.paths.daemonLog))
  })

  it('leaves files that are not logs alone', () => {
    writeFileSync(join(paths.paths.logs, 'keep.txt'), 'mine')
    utimesSync(join(paths.paths.logs, 'keep.txt'), new Date(0), new Date(0))
    logmod.pruneLogs(1)
    expect(readdirSync(paths.paths.logs)).toContain('keep.txt')
  })
})
