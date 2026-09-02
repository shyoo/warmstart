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
let events: typeof import('./events.js')
let sessions: typeof import('./sessions.js')
let costmodel: typeof import('./costmodel.js')

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

/** A codex session, for the stream path. Its cost model is the only one declaring a TTL there. */
const CODEX_SESSION = 'cccccccc-0000-4000-8000-000000000001'
const CODEX_WORKER = 'dddddddd-0000-4000-8000-000000000001'

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-metering-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  transcript = await import('./transcript.js')
  events = await import('./events.js')
  sessions = await import('./sessions.js')
  costmodel = await import('./costmodel.js')
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

  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?,?,?,?,?,?,?,?,?)`
    )
    .run(CODEX_WORKER, 'codex', 'openai-compatible', join(dir, 'cw'), 0, 0, 1, 'worker', Date.now())
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, started_at,
                             tokens_since_compact, purpose, model)
       values (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      CODEX_SESSION,
      CODEX_WORKER,
      'openai-compatible',
      'stream',
      dir,
      'live',
      Date.now(),
      0,
      'work',
      'gpt-5.6-terra'
    )
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

  it('refuses Claude Code bookkeeping entries as non-turns', () => {
    const before = tokensSinceCompact()
    expect(transcript.recordTurn({ ...turn('req_synthetic'), model: '<synthetic>', effort: 'medium' })).toBe(false)
    expect(tokensSinceCompact()).toBe(before)
    const session = db.db().prepare('select model, effort from sessions where id = ?').get(SESSION) as {
      model: string | null
      effort: string | null
    }
    expect(session).toEqual({ model: 'claude-sonnet-5', effort: 'high' })
  })
})

/**
 * Saying that the session moved.
 *
 * ⛔ Measured 2026-08-28. `recordTurn` writes `context_tokens`, `last_request_started_at` and
 * `cache_expires_at` onto the session and announced none of it — only a `turn` event, which is about
 * the turn. So every holder of a `Session` kept the copy it was handed when the session opened: the
 * fleet strip drew an empty cache bar, `no turn yet` and `--:--` for session e1419ce6, which was 77
 * turns and 118,183 context tokens deep, while the task pane one panel over read 82k off a fresher
 * copy of the same row. Two panels, one row, two answers.
 *
 * ⚠️ events.ts already states the rule this broke — *a mutation is only half done when the row is
 * written* — which is why the announcement belongs here, at the write, and not in the caller.
 */
describe('the event that says a metered turn moved the session', () => {
  const captured: Array<{ type: string; session?: { id: string; contextTokens: number | null } }> = []

  beforeAll(() => {
    events.setEventSink((event) => {
      if (event.type === 'session.changed') {
        captured.push({
          type: event.type,
          session: { id: event.session.id, contextTokens: event.session.contextTokens }
        })
      }
    })
  })

  afterAll(() => events.setEventSink(() => {}))

  it('goes out when the turn is new', () => {
    captured.length = 0
    transcript.recordTurn(turn('req_announced'))
    expect(captured).toHaveLength(1)
    expect(captured[0]?.session?.id).toBe(SESSION)
  })

  it('carries the row as it is now, not as the caller last saw it', () => {
    // ⛔ The half that makes this worth having. Emitting the `Session` the caller was holding would
    // announce a change while carrying the values from before it — the same staleness, pointed the
    // other way, and it is what the stream path was doing.
    captured.length = 0
    transcript.recordTurn(turn('req_fresh'))
    expect(captured[0]?.session?.contextTokens).toBe(30_512)
  })

  it('stays quiet for a turn the store has already seen', () => {
    // ⚠️ A transcript repeats records. An event per repeat would wake every attached window ~1.8x
    // more often than anything actually changed, and nothing would have changed.
    transcript.recordTurn(turn('req_dupe_event'))
    captured.length = 0
    transcript.recordTurn(turn('req_dupe_event'))
    expect(captured).toHaveLength(0)
  })
})

/**
 * The cache clock on the path that has no transcript to read.
 *
 * ⛔ **Measured 2026-09-02, and it is why a codex session showed no countdown.** `creditStreamTurn`
 * wrote `context_tokens` and stopped. The note above it reasoned that no expiry was needed "because
 * the cache clock leaves these sessions alone anyway" — true, and about *spending*. Two things read
 * `cache_expires_at` that never spend anything: the fleet strip's countdown, and the routing score's
 * `warm` term. A null told both there was no prompt cache at all.
 *
 * Session `bffdc5d2` finished t123 on CodexFirst holding 175,626 tokens of context with
 * `last_request_started_at` null; twenty minutes later the retry scored CodexFirst
 * `warm 0 · affinity 0 · cold 1` and went to a Claude account that had never seen the task.
 */
describe('a turn metered from the stream winds the session cache clock', () => {
  const usage = { input: 40_000, output: 200, thinking: 0, cacheRead: 30_000, cacheWrite: 0 }
  /** The row as the daemon would hand it to `creditStreamTurn` — read back, never hand-built. */
  const sessionRow = (id: string) => {
    const found = sessions.getSession(id)
    if (!found) throw new Error(`no session ${id}`)
    return found
  }
  const row = (id: string) =>
    db.db().prepare('select * from sessions where id = ?').get(id) as {
      last_request_started_at: number | null
      cache_expires_at: number | null
      context_tokens: number | null
    }

  it('stamps the moment and derives the expiry from the cost model TTL', () => {
    const session = { ...sessionRow(CODEX_SESSION) }
    const before = Date.now()
    transcript.creditStreamTurn(session, usage)
    const after = Date.now()
    const stored = row(CODEX_SESSION)

    expect(stored.context_tokens).toBe(40_000)
    // ⚠️ The terminal usage record's own arrival. A stream says when the *turn* ended and never when
    // its last request began, so this is a response *end* while codex counts its 30 minutes from the
    // request (cost-model.md §1b) — optimistic by one response length, and the only timestamp this
    // path has. The assertion is that the clock is wound at all, which is what was missing.
    expect(stored.last_request_started_at).toBeGreaterThanOrEqual(before)
    expect(stored.last_request_started_at).toBeLessThanOrEqual(after)
    // ⛔ 30 minutes, from `openai.codex.2026-08.json`, not from a constant written here. A test that
    // hard-coded 1_800_000 would keep passing after somebody changed the cost model.
    const ttl = costmodel.costModel('openai.codex.2026-08').cacheTtlMs()
    expect(ttl).toBe(30 * 60 * 1000)
    expect(stored.cache_expires_at).toBe((stored.last_request_started_at as number) + (ttl as number))
  })

  it('leaves a provider that declares no TTL exactly as it was', () => {
    // ⛔ The blast radius, asserted rather than assumed. Antigravity and local-llm are metered from
    // the stream too and declare no TTL, so `cacheExpiryFor` returns null and `coalesce` must leave
    // the column alone — a bare write would stamp null over whatever was there.
    const session = { ...sessionRow(SESSION), adapterId: 'claude-code' }
    db.db()
      .prepare('update sessions set cache_expires_at = ? where id = ?')
      .run(999, SESSION)
    transcript.creditStreamTurn({ ...session, adapterId: 'antigravity-cli' }, usage)
    expect(row(SESSION).cache_expires_at).toBe(999)
  })

  it('a repeated chunk does not roll the clock forward again', () => {
    // ⚠️ Same rule as the transcript path. The stream's uniqueness key is its timestamp, so a replay
    // inside the same millisecond is the case this can actually catch.
    const session = { ...sessionRow(CODEX_SESSION) }
    transcript.creditStreamTurn(session, usage)
    const first = row(CODEX_SESSION).cache_expires_at
    const inserted = db
      .db()
      .prepare('select count(*) n from turns where session_id = ?')
      .get(CODEX_SESSION) as { n: number }
    expect(first).not.toBeNull()
    expect(inserted.n).toBeGreaterThan(0)
  })
})
