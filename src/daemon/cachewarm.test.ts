import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Keeping a prompt cache's clock honest while the turn that owns it is still running.
 *
 * ⛔ **The defect this file was written from (t224).** OpenAI's window is a sliding one — *"a cached
 * prefix remains eligible for reuse for 30 minutes after its most recent write or reuse"* — and
 * `openai.codex.2026-08.json` has always declared exactly that (`read_refreshes_ttl: true`,
 * `ttl_measured_from: request_start`, 1800s). What the daemon did with it did not match: the clock
 * was wound **once per turn, from the turn's opening prompt**. `codex exec` takes one prompt, works
 * unattended for as long as the task needs, and emits its single `turn.completed` at the very end —
 * so every request after the first was invisible, and a codex run longer than thirty minutes ended
 * by stamping an expiry that had already passed, at the moment its prefix was hottest. The fleet
 * strip counted down to nothing on a working session, and the routing score's `cacheWarmth` term read 0 for
 * the account holding the warmest prefix in the fleet, sending the follow-up somewhere that had to
 * pay `1.25·C` to rebuild what was sitting warm.
 *
 * Two halves, both covered here: what counts as evidence that a request happened, and what the row
 * is allowed to do with that evidence.
 */

let dir: string
let db: typeof import('./db.js')
let transcript: typeof import('./transcript.js')
let sessions: typeof import('./sessions.js')

const CODEX = 'aaaaaaaa-1111-4000-8000-000000000001'
const CLAUDE = 'aaaaaaaa-1111-4000-8000-000000000002'
const WORKER = 'bbbbbbbb-1111-4000-8000-000000000001'
const CLAUDE_WORKER = 'bbbbbbbb-1111-4000-8000-000000000002'

const TTL = 30 * 60 * 1000

beforeAll(async () => {
  // ⛔ A temp data directory, never the real one. This opens a database and writes to it.
  dir = mkdtempSync(join(tmpdir(), 'agentyard-cachewarm-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  transcript = await import('./transcript.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'cachewarm.db'))

  const worker = db.db().prepare(
    `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                          max_concurrent, role, created_at)
     values (?,?,?,?,?,?,?,?,?)`
  )
  worker.run(WORKER, 'codex', 'openai-compatible', join(dir, 'w'), 0, 0, 1, 'worker', Date.now())
  worker.run(CLAUDE_WORKER, 'claude', 'claude-code', join(dir, 'c'), 0, 0, 1, 'worker', Date.now())

  const session = db.db().prepare(
    `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, started_at,
                           tokens_since_compact, purpose, model)
     values (?,?,?,?,?,?,?,?,?,?)`
  )
  session.run(CODEX, WORKER, 'openai-compatible', 'stream', dir, 'live', Date.now(), 0, 'work', 'gpt-5.6-terra')
  session.run(CLAUDE, CLAUDE_WORKER, 'claude-code', 'stream', dir, 'live', Date.now(), 0, 'work', 'claude-sonnet-5')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const clock = (id: string) =>
  db.db()
    .prepare('select last_request_started_at s, cache_expires_at e from sessions where id = ?')
    .get(id) as { s: number | null; e: number | null }

const setClock = (id: string, startedAt: number) =>
  db.db()
    .prepare('update sessions set last_request_started_at = ?, cache_expires_at = ? where id = ?')
    .run(startedAt, startedAt + TTL, id)

describe('what proves a model request was under way', () => {
  it('counts the records that only exist because a model answered', () => {
    // Codex's mid-turn records decode to these: prose, an item completing, a rate-limit reading
    // riding the turn. Each one is a response, and a response had a request behind it that read the
    // cached prefix — which, where reads refresh the TTL, renewed it for free.
    expect(sessions.isRequestEvidence('assistant_text')).toBe(true)
    expect(sessions.isRequestEvidence('other')).toBe(true)
    expect(sessions.isRequestEvidence('rate_limit')).toBe(true)
    expect(sessions.isRequestEvidence('turn_status')).toBe(true)
  })

  it('⛔ refuses `init`, which is printed before any request', () => {
    // `thread.started` is evidence of a process, not of a cache.
    expect(sessions.isRequestEvidence('init')).toBe(false)
  })

  it('⛔ refuses the terminal pair, so the anchor stays a request rather than a response', () => {
    // A TTL runs from the request that reused the prefix, not from the response that ended it
    // (`ttl_measured_from: request_start`). Crediting these would count the whole final response as
    // window that had already been spent — the same trap cost-model.md §1 records for Anthropic.
    expect(sessions.isRequestEvidence('usage')).toBe(false)
    expect(sessions.isRequestEvidence('result')).toBe(false)
  })
})

describe('which request start a finished turn is anchored to', () => {
  const prompt = 1_000_000
  const lastRecord = prompt + 90 * 60 * 1000 // a 90-minute turn, three times the TTL

  it('⛔ takes the newest evidence over the prompt that opened the turn — the t224 bug', () => {
    // The old code used the prompt alone, so this turn stamped an expiry 60 minutes in the past.
    expect(transcript.newestRequestStart(prompt, lastRecord, 0)).toBe(lastRecord)
  })

  it('falls back to the prompt when the turn produced no mid-turn record at all', () => {
    // A short turn that answered in one shot: the prompt really is the only request there was.
    expect(transcript.newestRequestStart(prompt, null, 0)).toBe(prompt)
  })

  it('⛔ never winds backwards onto a record left by the previous prompt', () => {
    // A reused session carries the last turn's stamp. `Math.max`, not a preference for evidence.
    expect(transcript.newestRequestStart(prompt, prompt - 60_000, 0)).toBe(prompt)
  })

  it('uses the fallback only when the session is no longer live', () => {
    expect(transcript.newestRequestStart(null, null, 4_242)).toBe(4_242)
  })
})

describe('winding the clock while the turn is still running', () => {
  it('pushes an existing expiry forward from an observed request', () => {
    const opened = Date.now() - 25 * 60 * 1000
    setClock(CODEX, opened)
    const seenNow = Date.now()

    transcript.touchCacheClock(sessions.getSession(CODEX)!, seenNow)

    const { s, e } = clock(CODEX)
    expect(s).toBe(seenNow)
    // ⛔ The whole point: five minutes from lapsing, the session gets a fresh thirty.
    expect(e).toBe(seenNow + TTL)
  })

  it('⚠️ ignores an observation that would move the clock by less than the throttle', () => {
    const at = Date.now()
    setClock(CODEX, at)
    transcript.touchCacheClock(sessions.getSession(CODEX)!, at + 5_000)
    // A chatty stream writes many records a second, and a five-second correction to a thirty-minute
    // window is not worth a row write and a session event to every attached window.
    expect(clock(CODEX).e).toBe(at + TTL)
  })

  it('⛔ never winds the clock backwards', () => {
    const at = Date.now()
    setClock(CODEX, at)
    transcript.touchCacheClock(sessions.getSession(CODEX)!, at - 10 * 60 * 1000)
    expect(clock(CODEX).e).toBe(at + TTL)
  })

  it('⛔ never writes a first clock for a session no completed turn has measured', () => {
    db.db()
      .prepare('update sessions set last_request_started_at = null, cache_expires_at = null where id = ?')
      .run(CODEX)
    transcript.touchCacheClock(sessions.getSession(CODEX)!, Date.now())
    // Inventing an expiry here would tell routing that an unproven prefix is warm. The turn's own
    // usage record is what establishes the clock; this only ever pushes one that already exists.
    expect(clock(CODEX)).toEqual({ s: null, e: null })
  })

  it('⛔ leaves a transcript-metered adapter alone, so the two paths never fight for the column', () => {
    // Anthropic declares `read_refreshes_ttl` too, but claude-code is metered from its transcript,
    // which carries a real `requestStartedAt` per turn and writes one every few seconds of a run.
    const opened = Date.now() - 50 * 60 * 1000
    setClock(CLAUDE, opened)
    transcript.touchCacheClock(sessions.getSession(CLAUDE)!, Date.now())
    expect(clock(CLAUDE).e).toBe(opened + TTL)
  })
})
