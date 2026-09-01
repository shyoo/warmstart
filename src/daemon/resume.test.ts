import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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

/**
 * ⛔ **`plan()` resolves the command through `which()` before it builds an argv**, so every argv
 * assertion below needs *something* named `claude` and `agy` on PATH — and CI has neither. This file
 * shipped green on a machine with both installed and failed the first CI run it saw, which is the
 * identical mistake `adapters.test.ts` documents at length and solved this way. The stub proves
 * nothing about the CLI and is not meant to: what is under test is **the argv this repository
 * builds**, which is provable on a machine that has never installed anything.
 */
let stubDir: string | null = null
const realPath = process.env.PATH

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'agentyard-resume-cli-'))
  for (const command of ['claude', 'agy']) {
    // Never executed. `which()` wants a regular file, plus the executable bit off Windows and a
    // PATHEXT-matching extension on it, so both names are written.
    for (const name of [command, `${command}.exe`]) {
      const file = join(stubDir, name)
      writeFileSync(file, '')
      chmodSync(file, 0o755)
    }
  }
  process.env.PATH = `${stubDir}${delimiter}${realPath ?? ''}`
})

afterAll(() => {
  if (realPath === undefined) delete process.env.PATH
  else process.env.PATH = realPath
  if (stubDir) rmSync(stubDir, { recursive: true, force: true })
})

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
let tasks: typeof import('./tasks.js')

const WORKER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002'
/**
 * The worktree every seeded conversation sits in.
 *
 * ⚠️ A constant, not a literal repeated per assertion. Written out by hand it is one escaped
 * backslash away from `C:ws1`, which matches nothing - and a cwd that matches nothing makes
 * `resumableSession` return null for the *wrong reason*, so a test asserting `toBeNull()` passes
 * while proving nothing. That happened to four of the tests below before this constant existed.
 */
const WS = 'C:\\ws1'

/**
 * The same directory, spelled the way this install actually recorded it 8 times.
 *
 * ⚠️ A constant for the same reason `WS` is one, and it caught the same trap on the way in: written
 * through a shell heredoc this arrived as `'c:\ws1'`, where `\w` is not an escape, so the literal
 * was `c:ws1` — a drive-*relative* path that resolves against the process cwd and matches nothing.
 * The test then failed for a reason that had nothing to do with what it was testing.
 */
const WS_LOWER = 'c:\\ws1'

/** A work session on `worker`, in `cwd`, with `turns` recorded turns against it. */
function seed(opts: {
  id: string
  worker?: string
  cwd?: string
  adapter?: string
  turns?: number
  vendor?: string | null
  state?: string
}): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at, vendor_session_id)
       values (?,?,?,?,?,?,'work',0,?,?)`
    )
    .run(
      opts.id,
      opts.worker ?? WORKER,
      opts.adapter ?? 'claude-code',
      'stream',
      opts.cwd ?? WS,
      opts.state ?? 'closed',
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
  tasks = await import('./tasks.js')
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
  db.db().exec('delete from runs')
  db.db().exec('delete from sessions')
  db.db().exec('delete from tasks')
  // `runs.task_id` is a foreign key, so a run needs a task to hang off. Two of them, because the
  // interception cases below are about one conversation and *two* tasks.
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values ('t1', 1, 'probe', 'running', '{}', '{}', '{}', ?, ?),
              ('t2', 2, 'other', 'ready',   '{}', '{}', '{}', ?, ?)`
    )
    .run(Date.now(), Date.now(), Date.now(), Date.now())
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
    expect(sessions.resumableSession([load('s-new')], WORKER, WS)?.id).toBe('s-new')
  })

  it('refuses one belonging to another account', () => {
    // A conversation lives inside one isolation root and one quota bucket. The other account
    // cannot see it, and would start cold while reporting that it resumed.
    seed({ id: 's-other', worker: OTHER })
    expect(sessions.resumableSession([load('s-other')], WORKER, WS)).toBeNull()
  })

  it('refuses one recorded in a different worktree', () => {
    // ⛔ Claude Code files transcripts under an encoding of the cwd. `--resume` from ws2 for a
    // conversation held in ws1 finds nothing — and finds it quietly.
    seed({ id: 's-ws2', cwd: 'C:\\ws2' })
    expect(sessions.resumableSession([load('s-ws2')], WORKER, WS)).toBeNull()
  })

  it('takes one recorded under a different spelling of the same directory', () => {
    // ⭐ Measured against this install on 2026-08-28: `sessions.cwd` held one pooled worktree as both
    // `c:\Dev\…\ws1` (8 Claude rows) and `C:\Dev\…\ws1` (2), because `policyFor` derives an
    // unconfigured workspace root by concatenating onto `project.root` while a configured one comes
    // back from `resolve` in the config's own case. The compare here was `!==`, so the directory was
    // not itself.
    //
    // ⛔ The failure is silent and costs a full cold start — 41,542 cache-creation tokens — while the
    // run records `warm=false` as though nothing had been available to resume.
    if (process.platform !== 'win32') return
    seed({ id: 's-lower', cwd: WS_LOWER })
    expect(sessions.resumableSession([load('s-lower')], WORKER, WS)?.id).toBe('s-lower')
  })

  it('refuses one that never recorded a turn', () => {
    // ⛔ `claude --resume` on an unknown id fails the process outright. Every session in this
    // install that exited before saying anything has zero turns; every real one has at least one.
    seed({ id: 's-empty', turns: 0 })
    expect(sessions.resumableSession([load('s-empty')], WORKER, WS)).toBeNull()
  })

  it('skips a candidate and keeps looking rather than giving up on the first miss', () => {
    seed({ id: 's-empty', turns: 0 })
    seed({ id: 's-good' })
    const found = sessions.resumableSession([load('s-empty'), load('s-good')], WORKER, WS)
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

describe('what a run records about the conversation it got', () => {
  it('marks a resumed run warm and a fresh one new', () => {
    // ⛔ The field exists because the UI used to *infer* this from the clock, and the inference was
    // backwards: `spawnSession` inserts its row before `startRun` inserts the run's, so a brand-new
    // session is always older than its own first run. Measured against this install 2026-08-28, that
    // rendered "reused, context kept" on 19 of 20 runs, every one of them a cold start.
    seed({ id: 's-warm' })
    const warm = tasks.startRun({
      taskId: 't1',
      workerId: WORKER,
      sessionId: 's-warm',
      projectId: null,
      quotaUnverified: false,
      costModelId: null,
      startedWarm: true
    })
    const cold = tasks.startRun({
      taskId: 't1',
      workerId: WORKER,
      sessionId: 's-warm',
      projectId: null,
      quotaUnverified: false,
      costModelId: null,
      startedWarm: false
    })
    expect(warm.startedWarm).toBe(true)
    expect(cold.startedWarm).toBe(false)
  })

  it('says null, not false, when nothing recorded an answer', () => {
    // ⛔ Every run predating the column. Rendering those as `new` would put a measurement nobody
    // took beside ones that were taken, which is the failure this whole field exists to end.
    seed({ id: 's-old' })
    const run = tasks.startRun({
      taskId: 't1',
      workerId: WORKER,
      sessionId: 's-old',
      projectId: null,
      quotaUnverified: false,
      costModelId: null
    })
    expect(run.startedWarm).toBeNull()
  })
})


/**
 * ⛔ **Never take a conversation somebody is still talking in.**
 *
 * The gates above ask whether a conversation is *worth* going back to. These ask whether it is
 * *free*, which is a different question and the one with teeth: two processes against one
 * conversation means two agents writing the same worktree, turns billed to whichever run happened
 * to be open, and a `task_complete` that could settle the wrong task.
 *
 * ⚠️ Today `resumableSession` is only ever handed the task's own sessions, so the blast radius is
 * small. It is written down now because phase 2 of resident sessions hands it *other tasks'*
 * conversations, and a gate added in the same change as the feature that needs it is a gate nobody
 * can check independently.
 */
describe('a conversation that is still in use', () => {
  /** A run against `sessionId`, still open unless `ended`. */
  function openRun(sessionId: string, opts: { ended?: boolean; task?: string } = {}): void {
    db.db()
      .prepare(
        `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at,
                           quota_unverified)
         values (?,?,?,?,?,?,0)`
      )
      .run(
        `run-${sessionId}-${opts.task ?? 't1'}`,
        opts.task ?? 't1',
        sessionId,
        WORKER,
        Date.now(),
        opts.ended === true ? Date.now() : null
      )
  }

  it('is refused while a run against it is still open', () => {
    seed({ id: 's-busy' })
    openRun('s-busy')
    expect(sessions.resumableSession([load('s-busy')], WORKER, WS)).toBeNull()
  })

  it('is refused even though the session row says it closed', () => {
    // ⛔ The case the state check alone cannot catch, and why there are two checks rather than one.
    // A row marked closed while its run is still open is a task mid-turn; handing that conversation
    // out puts one agent's turn into another task's ledger.
    seed({ id: 's-shut', state: 'closed' })
    openRun('s-shut')
    expect(sessions.resumableSession([load('s-shut')], WORKER, WS)).toBeNull()
  })

  it('is refused while the session is still live, run or no run', () => {
    // A live session is `warmSessionFor`'s business: work goes into it as a continuation, without
    // starting a second process. Resuming one would start that second process.
    seed({ id: 's-live', state: 'live' })
    expect(sessions.resumableSession([load('s-live')], WORKER, WS)).toBeNull()
  })

  it('is refused while it is still starting, the narrowest window and the easiest to lose', () => {
    seed({ id: 's-starting', state: 'starting' })
    expect(sessions.resumableSession([load('s-starting')], WORKER, WS)).toBeNull()
  })

  it('is refused for a run opened by a different task, not only by this one', () => {
    // ⛔ The interception case named directly: t2 asking for the conversation t1 is running in.
    seed({ id: 's-t1' })
    openRun('s-t1', { task: 't1' })
    expect(sessions.resumableSession([load('s-t1')], WORKER, WS)).toBeNull()
  })

  it('comes back once the run has ended', () => {
    // ⚠️ The other half, and the one a too-strict guard breaks. A conversation that never becomes
    // available again is a cold start after its first task, which is the bug all of this exists to
    // fix - so the release matters exactly as much as the hold.
    seed({ id: 's-done' })
    openRun('s-done', { ended: true })
    expect(sessions.resumableSession([load('s-done')], WORKER, WS)?.id).toBe('s-done')
  })

  it('passes over a busy conversation and takes a free one beside it', () => {
    // The gate must skip, not abort. A busy session first in the list would otherwise be the only
    // thing between a task and a perfectly good conversation behind it.
    seed({ id: 's-busy' })
    openRun('s-busy')
    seed({ id: 's-free' })
    expect(sessions.resumableSession([load('s-busy'), load('s-free')], WORKER, WS)?.id).toBe(
      's-free'
    )
  })

  it('never hands one conversation to two tasks at once', () => {
    // The property stated as a property, rather than as a sequence of gate checks: whatever the
    // list holds, nothing with an open run is ever returned.
    seed({ id: 's-a' })
    seed({ id: 's-b' })
    openRun('s-a', { task: 't1' })
    expect(sessions.resumableSession([load('s-a'), load('s-b')], WORKER, WS)?.id).toBe('s-b')
    openRun('s-b', { task: 't2' })
    expect(sessions.resumableSession([load('s-a'), load('s-b')], WORKER, WS)).toBeNull()
  })

  it('answers on its own terms too, so the guard is checkable without the gate around it', () => {
    seed({ id: 's-x' })
    expect(sessions.hasOpenRun('s-x')).toBe(false)
    openRun('s-x')
    expect(sessions.hasOpenRun('s-x')).toBe(true)
  })
})

/**
 * ⭐ **The conversations of *other* tasks, which is where reuse across tasks actually lives.**
 *
 * ⛔ Within one task, resuming was already the rule: `pastSessionsFor` hands over the ids and the
 * CLI reopens them. Across tasks it was unreachable, and not because it was refused — because
 * nothing ever looked. Completing a task closes its session, so on a fleet that finishes what it
 * starts nearly every warm prefix in a project sits in a conversation belonging to a task that is
 * done, and every new task rebuilt the project's instructions, skills and layout from nothing:
 * measured 2026-08-28 at **41,542 cache-creation tokens** in an *empty* directory.
 *
 * ⚠️ This is the candidate list only. Whether a particular one may be lent is `sharing.ts`'s
 * question and is asked separately, on top of these — same project, same account, same model, same
 * effort, room to grow — which is why this query is deliberately no more than "finished, in this
 * project, on this account, with something in it".
 */
describe('finished conversations this project could lend', () => {
  /** Adds project and context_tokens to a seeded session, which `seed` does not carry. */
  function place(id: string, projectId: string | null, contextTokens: number): void {
    db.db()
      .prepare('update sessions set project_id = ?, context_tokens = ? where id = ?')
      .run(projectId, contextTokens, id)
  }

  it('offers a finished conversation from the same project and account', () => {
    seed({ id: 's-done' })
    place('s-done', 'p1', 50_000)
    expect(sessions.finishedConversationsIn('p1', WORKER).map((s) => s.id)).toEqual(['s-done'])
  })

  it('never crosses a project', () => {
    // ⛔ The one gate that is not a tuning question: one client's code in another client's
    // conversation is not something a scheduler gets to decide is acceptable.
    seed({ id: 's-elsewhere' })
    place('s-elsewhere', 'p2', 50_000)
    expect(sessions.finishedConversationsIn('p1', WORKER)).toEqual([])
  })

  it('never crosses an account', () => {
    // A conversation lives inside one worker's isolation root; the other account cannot open it.
    seed({ id: 's-theirs', worker: OTHER })
    place('s-theirs', 'p1', 50_000)
    expect(sessions.finishedConversationsIn('p1', WORKER)).toEqual([])
  })

  it('leaves live conversations to warmSessionFor', () => {
    // ⛔ Reviving one would put a second process on a conversation somebody is still talking in:
    // two agents in one worktree, turns billed to whichever run was open, and a `task_complete`
    // that could settle the wrong task.
    seed({ id: 's-live', state: 'live' })
    place('s-live', 'p1', 50_000)
    expect(sessions.finishedConversationsIn('p1', WORKER)).toEqual([])
  })

  it('ignores one that never accumulated any context', () => {
    // Nothing to lend. The expensive half of this question — was a turn ever recorded — is asked by
    // `resumableSession`, because `--resume` onto an id the CLI never wrote fails the process.
    seed({ id: 's-empty' })
    place('s-empty', 'p1', 0)
    expect(sessions.finishedConversationsIn('p1', WORKER)).toEqual([])
  })

  it('offers the most recently finished first, and stops at the limit', () => {
    // ⚠️ Asked on the dispatch path. A project a fleet has worked in for months has thousands of
    // finished conversations and only the newest few have a prefix worth anything.
    for (const id of ['s-a', 's-b', 's-c']) {
      seed({ id })
      place(id, 'p1', 10_000)
    }
    db.db().prepare("update sessions set closed_at = ? where id = 's-a'").run(3)
    db.db().prepare("update sessions set closed_at = ? where id = 's-b'").run(2)
    db.db().prepare("update sessions set closed_at = ? where id = 's-c'").run(1)
    expect(sessions.finishedConversationsIn('p1', WORKER).map((s) => s.id)).toEqual([
      's-a',
      's-b',
      's-c'
    ])
    expect(sessions.finishedConversationsIn('p1', WORKER, 2).map((s) => s.id)).toEqual(['s-a', 's-b'])
  })
})
