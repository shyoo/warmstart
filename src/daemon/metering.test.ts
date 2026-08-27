import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Billing a turn twice.
 *
 * ⚠️ Measured 2026-08-26 on claude 2.1.223: a 41-turn session's transcript carried **72 usage
 * records with 41 unique request ids**. `turns` has a unique index and absorbed that silently, so
 * the per-turn history was exact while every accumulator beside it ran ~1.8x high — the run row
 * (3,154,302 cache-read tokens against an actual 1,848,902), the task's budget (3.3M of spend that
 * never happened), and `tokens_since_compact`, which the compaction reserve and the cache clock both
 * read to decide when to spend money.
 *
 * ⛔ The test is written against the *return value*, because that is the contract the caller relies
 * on. A duplicate must reach the row and stop there.
 */

let dir: string
let db: typeof import('./db.js')
let transcript: typeof import('./transcript.js')

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKER = 'bbbbbbbb-0000-4000-8000-000000000001'

const turn = (requestId: string) => ({
  sessionId: SESSION,
  requestId,
  ts: 1_787_782_535_925,
  requestStartedAt: 1_787_782_535_000,
  model: 'claude-sonnet-5',
  effort: 'high',
  gitBranch: null,
  inputTokens: 2,
  outputTokens: 133,
  thinkingTokens: 0,
  cacheReadTokens: 30_369,
  cacheWrite1hTokens: 141,
  cacheWrite5mTokens: 0,
  contextTokens: 30_512
})

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-metering-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  transcript = await import('./transcript.js')
  db.openDb(join(dir, 'metering.db'))

  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(WORKER, 'test', 'claude-code', join(dir, 'w'), 0, 0, 1, 'worker', Date.now())
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, started_at,
                             tokens_since_compact, purpose)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(SESSION, WORKER, 'claude-code', 'stream', dir, 'live', Date.now(), 0, 'work')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const tokensSinceCompact = (): number =>
  (
    db.db().prepare('select tokens_since_compact t from sessions where id = ?').get(SESSION) as {
      t: number
    }
  ).t

describe('recordTurn', () => {
  it('reports a turn it has never seen as new', () => {
    expect(transcript.recordTurn(turn('req_first'))).toBe(true)
  })

  it('reports a repeat of the same request id as NOT new', () => {
    transcript.recordTurn(turn('req_repeated'))
    expect(transcript.recordTurn(turn('req_repeated'))).toBe(false)
  })

  it('does not accumulate a repeated turn into the session clock', () => {
    const before = tokensSinceCompact()
    transcript.recordTurn(turn('req_clock'))
    const afterFirst = tokensSinceCompact()
    transcript.recordTurn(turn('req_clock'))
    const afterRepeat = tokensSinceCompact()

    // The first one counts: 2 input + 133 output + 141 cache write.
    expect(afterFirst - before).toBe(276)
    // ⛔ The second one counts for nothing. This is the assertion that was false before 2026-08-26,
    // and it is what made a real session report ~1.8x the tokens it had actually used.
    expect(afterRepeat).toBe(afterFirst)
  })

  it('stores one row per request id however many times it arrives', () => {
    for (let i = 0; i < 5; i++) transcript.recordTurn(turn('req_storm'))
    const { n } = db.db().prepare('select count(*) n from turns where request_id = ?').get('req_storm') as {
      n: number
    }
    expect(n).toBe(1)
  })
})
