import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * What `sessions.state` is allowed to mean.
 *
 * ⛔ **It was recording an exit code under a column name that claimed to be a verdict.** `handleExit`
 * marked a session `failed` whenever its process exited non-zero — and killing a process always
 * does, so winding a task down, reclaiming its worktree, or the cache clock closing a cold
 * conversation each wrote a failure. Beside it, `reconcileOrphans` marked *every* still-open row
 * `failed` at startup, and the daemon restarts for reasons the agent has no part in: a rebuild, a
 * reboot, a `/commit`. Measured 2026-08-31 on the author's install: **81 runs with
 * `outcome: 'completed'` inside sessions marked `failed`**, against 7 whose run had genuinely
 * failed. Three quarters of the history was blaming agents for their own shutdown.
 *
 * The three states now mean three different things, and these tests hold them apart:
 * `closed` = we asked · `abandoned` = nobody was watching · `failed` = it died on its own.
 */

let dir: string
let db: typeof import('./db.js')
let sessions: typeof import('./sessions.js')

const WORKER = 'aaaaaaaa-0000-4000-8000-000000000009'
let dbPath: string

function seedSession(id: string, state: string, pid: number | null = null): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at, pid)
       values (?,?,'claude-code','stream','C:\\ws1',?, 'work', 0, ?, ?)`
    )
    .run(id, WORKER, state, Date.now(), pid)
}

let runSeq = 0
function seedRun(sessionId: string, outcome: string | null): void {
  runSeq += 1
  // ⚠️ `runs.task_id` is a real foreign key, so the task has to exist. The migration reads runs
  // through that join, which is exactly why the constraint is worth honouring here rather than
  // switching it off for the test.
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?,?,?,'completed','{}','{}','{}',?,?)`
    )
    .run(`task-${runSeq}`, runSeq, `task ${runSeq}`, Date.now(), Date.now())
  db.db()
    .prepare(
      `insert into runs (id, task_id, session_id, worker_id, started_at, outcome, quota_unverified,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       values (?,?,?,?,?,?,0,0,0,0,0)`
    )
    .run(`r-${runSeq}`, `task-${runSeq}`, sessionId, WORKER, Date.now(), outcome)
}

function stateOf(id: string): string | undefined {
  return (
    db.db().prepare('select state from sessions where id = ?').get(id) as
      | { state: string }
      | undefined
  )?.state
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-sessionstate-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  sessions = await import('./sessions.js')
  dbPath = join(dir, 'sessionstate.db')
  db.openDb(dbPath)
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?, 'ClaudeMain', 'claude-code', ?, 1, 0, 1, 'worker', ?)`
    )
    .run(WORKER, join(dir, 'w'), Date.now())
})

beforeEach(() => {
  db.db().exec('delete from runs')
  db.db().exec('delete from tasks')
  db.db().exec('delete from sessions')
  runSeq = 0
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

/**
 * ⚠️ Not the default five seconds, and the margin is not decoration. `reconcileOrphans` reaps
 * detached agents on Windows by running `Get-CimInstance Win32_Process` — one synchronous
 * PowerShell start plus a full process enumeration. It is well under a second on an idle machine
 * and nowhere near under five when this file is one of sixty-four running in parallel: measured
 * 2026-09-02, 430ms alone against a timeout at 5s in a full `npm test`. `reapStale` now skips that
 * query under `VITEST` outright, so this is what catches the next thing here that shells out.
 */
describe('a daemon that went away', { timeout: 20_000 }, () => {
  it('calls the sessions it finds still open abandoned, not failed', () => {
    // ⛔ The single biggest source of the wrong word. This runs on **every** start, so on an install
    // that is rebuilt a few times a day it eventually touches almost everything.
    seedSession('s-live', 'live')
    seedSession('s-starting', 'starting')
    sessions.reconcileOrphans()
    expect(stateOf('s-live')).toBe('abandoned')
    expect(stateOf('s-starting')).toBe('abandoned')
  }, 15_000)

  it('stamps them with a closing time, so the row is not left open forever', () => {
    seedSession('s-live', 'live')
    sessions.reconcileOrphans()
    const row = db.db().prepare('select closed_at from sessions where id = ?').get('s-live') as
      | { closed_at: number | null }
      | undefined
    expect(row?.closed_at).toBeTypeOf('number')
  }, 15_000)

  it('leaves rows that already ended exactly as they are', () => {
    // ⚠️ Including `failed`. A session that really did die on its own is not re-labelled by a later
    // restart — the repair belongs in the migration, which reads the runs, not in a sweep that
    // cannot tell the two apart.
    seedSession('s-closed', 'closed')
    seedSession('s-failed', 'failed')
    seedSession('s-abandoned', 'abandoned')
    expect(sessions.reconcileOrphans()).toBe(0)
    expect(stateOf('s-closed')).toBe('closed')
    expect(stateOf('s-failed')).toBe('failed')
    expect(stateOf('s-abandoned')).toBe('abandoned')
  }, 15_000)
})

describe('an ended session is one that is over, in every list', () => {
  it('does not offer an abandoned session as a live one', () => {
    // ⛔ The failure mode of adding a state: a dozen call sites asking `!== 'closed' && !== 'failed'`
    // by hand would each have started counting `abandoned` rows as live agents — and the scheduler
    // would have routed work into a process that is not there. `sessionEnded` is why they cannot.
    seedSession('s-live', 'live')
    seedSession('s-abandoned', 'abandoned')
    expect(sessions.listSessions().map((s) => s.id)).toEqual(['s-live'])
    expect(sessions.sessionsForWorker(WORKER).map((s) => s.id)).toEqual(['s-live'])
  })

  it('includes it when the caller asked for everything', () => {
    seedSession('s-live', 'live')
    seedSession('s-abandoned', 'abandoned')
    expect(sessions.listSessions(true)).toHaveLength(2)
  })
})

describe('clearing Claude Code transcript bookkeeping from existing sessions', () => {
  it('removes a synthetic model and its companion effort from the data the Tasks UI reads', () => {
    seedSession('s-synthetic', 'closed')
    db.db()
      .prepare("update sessions set model = '<synthetic>', effort = 'medium' where id = ?")
      .run('s-synthetic')
    db.db()
      .prepare(
        `insert into turns (session_id, request_id, ts, model, effort)
         values (?, 'synthetic-turn', ?, '<synthetic>', 'medium')`
      )
      .run('s-synthetic', Date.now())

    // Run the shipped migration rather than copying its SQL: existing installations need this half
    // as much as future transcript entries need the parser guard.
    db.db().exec(`pragma user_version = ${db.versionBefore("set model = null,")}`)
    db.closeDb()
    db.openDb(dbPath)

    expect(db.db().prepare('select model, effort from sessions where id = ?').get('s-synthetic')).toEqual({
      model: null,
      effort: null
    })
    expect(db.db().prepare("select model, effort from turns where request_id = 'synthetic-turn'").get()).toEqual({
      model: null,
      effort: null
    })
  })
})

/**
 * The repair migration, run against the shape it was written for.
 *
 * ⚠️ Deliberately not named by number here. It was 25 when it was written and became 27 on the
 * rebase that picked up two migrations landed in parallel — a number in the prose is one more copy
 * to go stale, and the body below finds it by its own text instead.
 *
 * ⚠️ Driven by the SQL the migration actually ships, rather than by a hand-copied `update`. A test
 * that asserted its own SQL would pass whatever the migration really said, which is the one thing
 * worth knowing here.
 */
describe('repairing the sessions that were blamed for their own shutdown', () => {
  // ⛔ Found by its own SQL, not by counting from either end. This rewound to `MIGRATION_COUNT - 1`
  // on the reasoning that hard-coding an index would turn the suite into a test of whichever
  // migration somebody later *inserted* — which is true, and has an exact mirror image: "the last
  // one" turns it into a test of whichever migration somebody later **appends**. Measured
  // 2026-09-01, one migration later: this began re-running a pair of `create index` statements and
  // asserting the repair's outcome, and failed for a reason nothing in this file was about.
  //
  // ⚠️ The other half of the bargain lives in `db.ts`: because this replays every migration after the
  // repair, each of those has to survive being applied twice. `create index if not exists` says so
  // for itself; `title_summary` cannot, so it is a function that checks first.
  function remigrate(): void {
    db.db().exec(`pragma user_version = ${db.versionBefore("set state = 'closed'")}`)
    db.closeDb()
    db.openDb(dbPath)
  }

  it('calls a failed-looking session whose runs all succeeded what it was: closed', () => {
    seedSession('s-ok', 'failed')
    seedRun('s-ok', 'completed')
    seedRun('s-ok', 'completed')
    remigrate()
    expect(stateOf('s-ok')).toBe('closed')
  })

  it('leaves a session whose run genuinely failed alone', () => {
    // ⛔ The repair must not launder a real failure. One failed run is enough to keep the word.
    seedSession('s-bad', 'failed')
    seedRun('s-bad', 'completed')
    seedRun('s-bad', 'failed')
    remigrate()
    expect(stateOf('s-bad')).toBe('failed')
  })

  it('treats the other honest endings as endings, because none of them is a crash', () => {
    for (const [id, outcome] of [
      ['s-preempted', 'preempted'],
      ['s-cancelled', 'cancelled'],
      ['s-blocked', 'blocked'],
      ['s-terminated', 'terminated']
    ]) {
      seedSession(id!, 'failed')
      seedRun(id!, outcome!)
    }
    remigrate()
    for (const id of ['s-preempted', 's-cancelled', 's-blocked', 's-terminated']) {
      expect(stateOf(id)).toBe('closed')
    }
  })

  it('refuses to invent a verdict for a session that served no run', () => {
    // ⛔ Every `consult`, `login` and `probe` row, plus a dispatch that died before its first turn.
    // There is nothing to read an outcome off, and rewriting those would be making one up. On the
    // install this was measured against, all 75 wrong work rows have runs, so nothing is lost.
    seedSession('s-none', 'failed')
    remigrate()
    expect(stateOf('s-none')).toBe('failed')
  })

  it('does not disturb a session that was already recorded correctly', () => {
    seedSession('s-closed', 'closed')
    seedRun('s-closed', 'failed')
    seedSession('s-live', 'live')
    remigrate()
    expect(stateOf('s-closed')).toBe('closed')
    expect(stateOf('s-live')).toBe('live')
  })
})

describe('killProcessTree and process termination', () => {
  it('gracefully handles 0 or nonexistent pid without throwing', () => {
    expect(() => sessions.killProcessTree(0)).not.toThrow()
    expect(() => sessions.killProcessTree(99999999)).not.toThrow()
  })

  it('terminates a running process and its process tree', async () => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'timeout', '/t', '30'], { stdio: 'ignore', windowsHide: true })
        : spawn('sleep', ['30'], { stdio: 'ignore' })
    const pid = child.pid
    expect(pid).toBeDefined()
    if (!pid) return

    sessions.killProcessTree(pid)
    await new Promise((resolve) => setTimeout(resolve, 500))

    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})
