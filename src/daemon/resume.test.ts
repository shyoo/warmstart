import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claudeCode } from './adapters/claude-code.js'
import { antigravityCli } from './adapters/antigravity-cli.js'
import type { SpawnRequest } from './adapters/types.js'

/**
 * Continuing a task in the conversation it was already having.
 *
 * ⛔ **Measured on this install 2026-08-28, and this is the failure these tests hold shut:** across
 * the nine (task, adapter) pairs that had ever run, the number of distinct sessions equalled the
 * number of runs in *every one* — t8 alone opened four Antigravity conversations for four turns of
 * one task. `warmSessionFor` had never matched once, because `completeTask` closes the session a
 * second after the turn ends, and every reply after that spawned a process that had never heard of
 * the task. Both CLIs can resume by id and neither was ever asked to.
 *
 * Two halves, tested separately because they fail separately: the adapter has to *say* the resume
 * flag, and the daemon has to know which conversation to name.
 */

const REQ: SpawnRequest = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  isolationRoot: 'C:\\iso',
  cwd: 'C:\\ws1',
  transport: 'stream'
}

describe('the resume flag each CLI actually takes', () => {
  it('sends Claude Code --resume, and drops --session-id when it does', () => {
    const { args } = claudeCode.plan({ ...REQ, resumeFrom: REQ.sessionId })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe(REQ.sessionId)
    // ⛔ The two flags name the same thing and asking for both is asking for two ids at once.
    expect(args).not.toContain('--session-id')
  })

  it('still mints an id when there is nothing to resume', () => {
    const { args } = claudeCode.plan(REQ)
    expect(args).toContain('--session-id')
    expect(args).not.toContain('--resume')
  })

  it('sends Antigravity --conversation with the vendor id, never --continue', () => {
    const { args } = antigravityCli.plan({ ...REQ, resumeFrom: 'agy-conv-9' })
    expect(args).toContain('--conversation')
    expect(args[args.indexOf('--conversation') + 1]).toBe('agy-conv-9')
    // ⛔ `--continue` resumes whichever conversation on this machine spoke last, which on a fleet
    // running several worktrees — or a machine whose operator uses `agy` by hand — is a coin toss.
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('-c')
  })

  it('leaves Antigravity alone when there is nothing to resume', () => {
    expect(antigravityCli.plan(REQ).args).not.toContain('--conversation')
  })

  it('reads the conversation id off the init record', () => {
    const decoded = antigravityCli.decodeStream?.({
      event: 'init',
      conversation_id: 'agy-conv-9',
      init: { permission_mode: 'default' }
    })
    expect(decoded).toMatchObject({ kind: 'init', sessionId: 'agy-conv-9' })
  })

  it('only claims resumeSession where plan honours it', () => {
    // ⛔ The scheduler drops a cold start on the strength of this flag. An adapter that claims it
    // and ignores `resumeFrom` would silently lose the context and report a warm continuation.
    for (const ad of [claudeCode, antigravityCli]) {
      expect(ad.info.capabilities.resumeSession).toBe(true)
      expect(ad.plan({ ...REQ, resumeFrom: 'zzz' }).args.join(' ')).toContain('zzz')
    }
  })
})

// ---------------------------------------------------------------------------- picking one

let dir: string
let db: typeof import('./db.js')
let sessions: typeof import('./sessions.js')

const WORKER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002'

/** A work session on `worker`, in `cwd`, with `turns` recorded turns against it. */
function seed(opts: {
  id: string
  worker?: string
  cwd?: string
  adapter?: string
  turns?: number
  vendor?: string | null
}): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at, vendor_session_id)
       values (?,?,?,?,?,'closed','work',0,?,?)`
    )
    .run(
      opts.id,
      opts.worker ?? WORKER,
      opts.adapter ?? 'claude-code',
      'stream',
      opts.cwd ?? 'C:\\ws1',
      Date.now(),
      opts.vendor ?? null
    )
  for (let i = 0; i < (opts.turns ?? 1); i++) {
    db.db()
      .prepare(
        `insert into turns (session_id, request_id, ts, input_tokens, output_tokens,
                            thinking_tokens, cache_read_tokens, cache_write_1h_tokens,
                            cache_write_5m_tokens)
         values (?,?,?,0,0,0,0,0,0)`
      )
      .run(opts.id, `req-${opts.id}-${i}`, Date.now())
  }
}

function load(id: string): import('@shared/protocol.js').Session {
  const s = sessions.getSession(id)
  if (!s) throw new Error(`no session ${id}`)
  return s
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-resume-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  sessions = await import('./sessions.js')
  db.openDb(join(dir, 'resume.db'))
  for (const id of [WORKER, OTHER]) {
    db.db()
      .prepare(
        `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                              max_concurrent, role, created_at)
         values (?,?,?,?,1,0,1,'worker',?)`
      )
      .run(id, id.slice(-1), 'claude-code', join(dir, id), Date.now())
  }
})

beforeEach(() => {
  db.db().exec('delete from turns')
  db.db().exec('delete from sessions')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('which conversation is worth going back to', () => {
  it('takes the one on the same account in the same tree', () => {
    seed({ id: 's-new' })
    expect(sessions.resumableSession([load('s-new')], WORKER, 'C:\\ws1')?.id).toBe('s-new')
  })

  it('refuses one belonging to another account', () => {
    // A conversation lives inside one isolation root and one quota bucket. The other account
    // cannot see it, and would start cold while reporting that it resumed.
    seed({ id: 's-other', worker: OTHER })
    expect(sessions.resumableSession([load('s-other')], WORKER, 'C:\\ws1')).toBeNull()
  })

  it('refuses one recorded in a different worktree', () => {
    // ⛔ Claude Code files transcripts under an encoding of the cwd. `--resume` from ws2 for a
    // conversation held in ws1 finds nothing — and finds it quietly.
    seed({ id: 's-ws2', cwd: 'C:\\ws2' })
    expect(sessions.resumableSession([load('s-ws2')], WORKER, 'C:\\ws1')).toBeNull()
  })

  it('refuses one that never recorded a turn', () => {
    // ⛔ `claude --resume` on an unknown id fails the process outright. Every session in this
    // install that exited before saying anything has zero turns; every real one has at least one.
    seed({ id: 's-empty', turns: 0 })
    expect(sessions.resumableSession([load('s-empty')], WORKER, 'C:\\ws1')).toBeNull()
  })

  it('skips a candidate and keeps looking rather than giving up on the first miss', () => {
    seed({ id: 's-empty', turns: 0 })
    seed({ id: 's-good' })
    const found = sessions.resumableSession([load('s-empty'), load('s-good')], WORKER, 'C:\\ws1')
    expect(found?.id).toBe('s-good')
  })
})

describe("the vendor's name for a conversation", () => {
  it('is written down when the session first says it', () => {
    seed({ id: 's1', adapter: 'antigravity-cli' })
    sessions.noteVendorSession('s1', 'agy-conv-9')
    expect(load('s1').vendorSessionId).toBe('agy-conv-9')
  })

  it('is never erased by a later record that omits it', () => {
    // ⛔ Antigravity reports the id on `init` and nothing else. A blank arriving afterwards would
    // otherwise wipe the only handle that can resume the conversation.
    seed({ id: 's1', adapter: 'antigravity-cli' })
    sessions.noteVendorSession('s1', 'agy-conv-9')
    sessions.noteVendorSession('s1', null)
    expect(load('s1').vendorSessionId).toBe('agy-conv-9')
  })

  it('is never replaced by a different one', () => {
    // ⚠️ The first id is the one the conversation was opened under and the one `--conversation`
    // has to be given. A later record naming something else - a sub-agent, a fork, a record from
    // another turn - must not become the handle this session is resumed by.
    seed({ id: 's1', adapter: 'antigravity-cli' })
    sessions.noteVendorSession('s1', 'agy-conv-9')
    sessions.noteVendorSession('s1', 'agy-conv-later')
    expect(load('s1').vendorSessionId).toBe('agy-conv-9')
  })
})
