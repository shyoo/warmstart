import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Phase 4: which conversation served which tasks.
 *
 * ⛔ **The page exists for one number that is invisible everywhere else** — how many tasks have been
 * in one conversation. A task's own pane says which conversation it is in; nothing said who *else*
 * had been in it. Once a session outlives the task that opened it, that number is the difference
 * between the cost saving working and two agents having read work nobody meant to show them, and
 * from the task list those look identical.
 *
 * ⚠️ Derived from `runs`, never stored, so what these tests really pin is the join: a conversation
 * that under-reports who was in it is worse than no page at all, because it would be read as proof.
 */

let dir: string
let db: typeof import('./db.js')
let conversations: typeof import('./conversations.js')

const WORKER = 'aaaaaaaa-0000-4000-8000-000000000001'

function session(id: string, patch: { vendor?: string; state?: string; project?: string } = {}): void {
  db.db()
    .prepare(
      `insert into sessions (id, worker_id, adapter_id, transport, cwd, state, purpose,
                             tokens_since_compact, started_at, vendor_session_id, project_id)
       values (?,?,'claude-code','stream','C:\\ws1',?, 'work', 0, ?, ?, ?)`
    )
    .run(id, WORKER, patch.state ?? 'live', Date.now(), patch.vendor ?? null, patch.project ?? null)
}

function task(id: string, seq: number, title: string): void {
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?,?,?,'completed','{}','{}','{}',?,?)`
    )
    .run(id, seq, title, Date.now(), Date.now())
}

let runSeq = 0
function run(sessionId: string, taskId: string, patch: { warm?: boolean | null; tokens?: number } = {}): void {
  runSeq += 1
  db.db()
    .prepare(
      `insert into runs (id, task_id, session_id, worker_id, started_at, quota_unverified,
                         started_warm, input_tokens, output_tokens, cache_read_tokens,
                         cache_write_tokens)
       values (?,?,?,?,?,0,?,?,0,0,0)`
    )
    .run(
      `run-${runSeq}`,
      taskId,
      sessionId,
      WORKER,
      Date.now() + runSeq,
      patch.warm === undefined || patch.warm === null ? null : patch.warm ? 1 : 0,
      patch.tokens ?? 0
    )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-conversations-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  conversations = await import('./conversations.js')
  db.openDb(join(dir, 'conversations.db'))
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

describe('what a conversation was used for', () => {
  it('reports the one task it served', () => {
    session('s1')
    task('t1', 1, 'first task')
    run('s1', 't1')
    const [c] = conversations.listConversations()
    expect(c?.taskCount).toBe(1)
    expect(c?.tasks[0]).toMatchObject({ seq: 1, title: 'first task', runs: 1 })
  })

  it('collapses several runs of one task into one row', () => {
    // ⚠️ A task retried three times is still *one* task in this conversation. Counting runs here
    // would make an ordinary continuation look exactly like a shared conversation, which is the one
    // distinction this page exists to draw.
    session('s1')
    task('t1', 1, 'retried task')
    run('s1', 't1')
    run('s1', 't1')
    run('s1', 't1')
    const [c] = conversations.listConversations()
    expect(c?.taskCount).toBe(1)
    expect(c?.tasks[0]?.runs).toBe(3)
  })

  it('counts two different tasks as a shared conversation', () => {
    // ⭐ The number the page is for.
    session('s1')
    task('t1', 1, 'first')
    task('t2', 2, 'second')
    run('s1', 't1')
    run('s1', 't2')
    const [c] = conversations.listConversations()
    expect(c?.taskCount).toBe(2)
    expect(c?.tasks.map((t) => t.seq)).toEqual([1, 2])
  })

  it('keeps each conversation’s tasks to itself', () => {
    // ⛔ The failure that would make this page actively misleading: a join that leaked rows across
    // sessions would report sharing that never happened, and it would be believed.
    session('s1')
    session('s2')
    task('t1', 1, 'first')
    task('t2', 2, 'second')
    run('s1', 't1')
    run('s2', 't2')
    const found = conversations.listConversations()
    expect(found.map((c) => c.taskCount)).toEqual([1, 1])
    expect(found.flatMap((c) => c.tasks.map((t) => t.seq)).sort()).toEqual([1, 2])
  })

  it('shows one task in both conversations it actually ran in', () => {
    // ⛔ The case that exposes a bad join, and it is the *ordinary* case rather than an exotic one:
    // a task whose session died and was resumed, or preempted and picked up later, has runs against
    // two conversations. Grouping those by task alone collapses them into one row — so one of the
    // two conversations silently loses the only task it ever served, and reads as unused.
    //
    // ⚠️ This is deliberately not the same assertion as the one below it. That one proves rows are
    // not invented across sessions; this proves they are not *lost*, and only this one fails when
    // the session is dropped from the grouping.
    session('s1')
    session('s2')
    task('t1', 1, 'resumed across two conversations')
    run('s1', 't1')
    run('s2', 't1')
    const found = conversations.listConversations()
    expect(found).toHaveLength(2)
    for (const c of found) {
      expect(c.taskCount).toBe(1)
      expect(c.tasks[0]?.seq).toBe(1)
    }
  })

  it('lists a conversation that was opened and never used, rather than hiding it', () => {
    // ⚠️ A dispatch that failed before its first turn. Dropping it would make a failure invisible on
    // the page most likely to be open when somebody is asking why nothing ran.
    session('s1')
    const [c] = conversations.listConversations()
    expect(c?.taskCount).toBe(0)
    expect(c?.tasks).toEqual([])
  })

  it('names the conversation the way its CLI does', () => {
    // ⛔ The vendor's id where there is one — this is the string somebody types after
    // `--conversation`, and ours would not be recognised by anything.
    session('s1', { vendor: 'agy-conv-9' })
    session('s2')
    const found = conversations.listConversations()
    expect(found.find((c) => c.sessionId === 's1')?.conversationId).toBe('agy-conv-9')
    expect(found.find((c) => c.sessionId === 's2')?.conversationId).toBe('s2')
  })

  it('resolves the account to its label rather than a uuid', () => {
    session('s1')
    expect(conversations.listConversations()[0]?.workerLabel).toBe('ClaudeMain')
  })

  it('says nothing about warmth for a run that recorded nothing', () => {
    // ⛔ Null stays null. Rendering a pre-column run as a cold start would put a measurement nobody
    // took beside ones that were taken.
    session('s1')
    task('t1', 1, 'old task')
    run('s1', 't1', { warm: null })
    expect(conversations.listConversations()[0]?.tasks[0]?.startedWarm).toBeNull()
  })

  it('reports warmth when it was recorded', () => {
    session('s1')
    task('t1', 1, 'warm task')
    run('s1', 't1', { warm: true })
    expect(conversations.listConversations()[0]?.tasks[0]?.startedWarm).toBe(true)
  })

  it('sums what a task spent across its runs in this conversation', () => {
    session('s1')
    task('t1', 1, 'spendy')
    run('s1', 't1', { tokens: 100 })
    run('s1', 't1', { tokens: 250 })
    expect(conversations.listConversations()[0]?.tasks[0]?.tokens).toBe(350)
  })

  it('filters to one project when asked', () => {
    session('s1', { project: 'p1' })
    session('s2', { project: 'p2' })
    expect(conversations.listConversations({ projectId: 'p1' }).map((c) => c.sessionId)).toEqual([
      's1'
    ])
  })

  it('returns no more than it was asked for', () => {
    for (let i = 0; i < 12; i++) session(`s${i}`)
    expect(conversations.listConversations({ limit: 5 })).toHaveLength(5)
    expect(conversations.listConversations()).toHaveLength(12)
  })

  it('clamps the ask itself, which is a bound rather than a paging feature', () => {
    // ⚠️ Asserted on the clamp rather than on a result, because the two are indistinguishable until
    // an install has more than five hundred conversations — and by then it is too late to find out.
    // A page that can be asked for every session ever opened can be asked to serialise a database.
    expect(conversations.conversationLimit(undefined)).toBe(50)
    expect(conversations.conversationLimit(5)).toBe(5)
    expect(conversations.conversationLimit(100_000)).toBe(500)
    // ⛔ And zero or negative must not mean "no limit" once it reaches SQL.
    expect(conversations.conversationLimit(0)).toBe(1)
    expect(conversations.conversationLimit(-9)).toBe(1)
  })
})
