import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { mergeWaits, timingFor, type RunSpan, type WaitInterval } from './activetime.js'

/**
 * How long an agent actually worked.
 *
 * ⛔ **The number this replaces was not slightly wrong, it was measuring something else.** "Took"
 * was `lastRunEnded - firstRun`: the span the task existed inside, which counts queueing, quota
 * parks, and every minute a question sat waiting for a person. A task whose agent worked four
 * minutes and whose question was answered the next morning reported fifteen hours, and that number
 * was the input to every per-agent and per-model duration anybody looked at.
 *
 * These pin the two halves separately, because they fail differently: the gaps *between* runs fall
 * out of summing runs at all, while the waits *inside* a run need the question and approval rows and
 * are the half a naive `sum(ended_at - started_at)` silently keeps.
 */

const T = 1_700_000_000_000
const MIN = 60_000

function span(id: string, startMin: number, endMin: number | null): RunSpan {
  return { id, startedAt: T + startMin * MIN, endedAt: endMin === null ? null : T + endMin * MIN }
}

function wait(fromMin: number, toMin: number | null): WaitInterval {
  return { from: T + fromMin * MIN, to: toMin === null ? null : T + toMin * MIN }
}

const at = (min: number): number => T + min * MIN

describe('active time against wall-clock', () => {
  it('counts a single closed run whole when nobody was waited on', () => {
    const t = timingFor([span('r1', 0, 7)], new Map(), at(600))
    expect(t.activeMs).toBe(7 * MIN)
    expect(t.blockedMs).toBe(0)
    // ⛔ Nothing is ticking: the run is closed, so the number must not move again.
    expect(t.activeSince).toBeNull()
  })

  it('drops the gap between two runs, which is the queueing this exists to exclude', () => {
    // Dispatched at 0, ran 5m, then sat `awaiting_human` for four hours, then ran 3m more.
    const t = timingFor([span('r1', 0, 5), span('r2', 245, 248)], new Map(), at(600))
    expect(t.activeMs).toBe(8 * MIN)
    // ⚠️ The wall-clock answer, for contrast, is 248 minutes. Two orders of magnitude apart.
    expect(at(248) - at(0)).toBe(248 * MIN)
  })

  it('drops a wait that happened inside a run, which summing run spans would keep', () => {
    // The agent worked 2m, asked a question, was answered 90m later, worked 3m more.
    const waits = new Map([['r1', [wait(2, 92)]]])
    const t = timingFor([span('r1', 0, 95)], waits, at(600))
    expect(t.activeMs).toBe(5 * MIN)
    expect(t.blockedMs).toBe(90 * MIN)
  })

  it('never reports a negative duration when waits overlap', () => {
    // ⛔ The `AskUserQuestion` shape: the same stretch arriving as both an approval and a question.
    // Added rather than merged, this subtracts 180m from a 100m run and reports -80m — which a cost
    // model discards silently rather than flagging.
    const waits = new Map([['r1', [wait(10, 100), wait(10, 100)]]])
    const t = timingFor([span('r1', 0, 100)], waits, at(600))
    expect(t.activeMs).toBe(10 * MIN)
    expect(t.blockedMs).toBe(90 * MIN)
  })

  it('clamps a wait that outlives its run rather than backdating it', () => {
    // A parked question answered long after the run ended. Only the part inside the run counts.
    const waits = new Map([['r1', [wait(8, 500)]]])
    const t = timingFor([span('r1', 0, 10)], waits, at(600))
    expect(t.activeMs).toBe(8 * MIN)
    expect(t.blockedMs).toBe(2 * MIN)
  })
})

describe('a task that is still running', () => {
  it('hands back a tick point rather than a total', () => {
    const t = timingFor([span('r1', 0, null)], new Map(), at(10))
    // ⛔ `activeSince`, not `activeMs`: the renderer adds `now - activeSince` and the number moves
    // without the daemon pushing a row every second.
    expect(t.activeMs).toBe(0)
    expect(t.activeSince).toBe(at(0))
  })

  it('pushes the tick point past waits already served', () => {
    const waits = new Map([['r1', [wait(2, 32)]]])
    const t = timingFor([span('r1', 0, null)], waits, at(40))
    // Worked 2m, waited 30m, working again since. The clock resumes from start + 30m, so at t=40
    // the total reads 10m — which is the 2m before the question plus the 8m since the answer.
    expect(t.activeSince).toBe(at(30))
    expect(t.activeMs + (at(40) - (t.activeSince as number))).toBe(10 * MIN)
  })

  it('freezes while a person is being waited on right now', () => {
    // ⛔ The failure that motivates the whole split. A run open and blocked on an unanswered
    // question is not being worked on, and a "took" that keeps climbing overnight is the exact
    // reading this replaces.
    const waits = new Map([['r1', [wait(4, null)]]])
    const t = timingFor([span('r1', 0, null)], waits, at(600))
    expect(t.activeSince).toBeNull()
    expect(t.activeMs).toBe(4 * MIN)
  })

  it('freezes at the second question having counted the work between them', () => {
    const waits = new Map([['r1', [wait(2, 12), wait(15, null)]]])
    const t = timingFor([span('r1', 0, null)], waits, at(600))
    // 2m before the first question, 3m between the answer and the second question.
    expect(t.activeMs).toBe(5 * MIN)
    expect(t.activeSince).toBeNull()
  })
})

describe('a task nothing has run', () => {
  it('reports zero rather than inventing a span from when it was filed', () => {
    const t = timingFor([], new Map(), at(600))
    expect(t).toEqual({ activeMs: 0, activeSince: null, blockedMs: 0 })
  })
})

describe('merging waits', () => {
  it('joins overlapping stretches into one', () => {
    const merged = mergeWaits([wait(0, 10), wait(5, 20)], at(0), at(60))
    expect(merged).toEqual([{ from: at(0), to: at(20) }])
  })

  it('leaves a real gap alone', () => {
    const merged = mergeWaits([wait(0, 10), wait(20, 30)], at(0), at(60))
    expect(merged).toHaveLength(2)
  })

  it('treats an unanswered wait as running to the end of the window', () => {
    expect(mergeWaits([wait(10, null)], at(0), at(25))).toEqual([{ from: at(10), to: at(25) }])
  })

  it('discards a stretch entirely outside the window', () => {
    expect(mergeWaits([wait(80, 90)], at(0), at(60))).toEqual([])
  })
})

// ---------------------------------------------------------------------------- against the database

let dir: string
let db: typeof import('./db.js')
let activetime: typeof import('./activetime.js')

const WORKER = 'aaaaaaaa-0000-4000-8000-000000000001'

function task(id: string, seq: number): void {
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?,?,'a task','completed','{}','{}','{}',?,?)`
    )
    .run(id, seq, T, T)
}

function run(id: string, taskId: string, startMin: number, endMin: number | null): void {
  db.db()
    .prepare(
      `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, quota_unverified,
                         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       values (?,?,'s',?,?,?,0,0,0,0,0)`
    )
    .run(id, taskId, WORKER, at(startMin), endMin === null ? null : at(endMin))
}

function question(id: string, runId: string, askedMin: number, patch: { answered?: number; parked?: number } = {}): void {
  db.db()
    .prepare(
      `insert into questions (id, session_id, run_id, task_id, origin, kind, question, asked_at,
                              answered_at, parked_at)
       values (?, 's', ?, null, 'ask_human', 'open', 'well?', ?, ?, ?)`
    )
    .run(
      id,
      runId,
      at(askedMin),
      patch.answered === undefined ? null : at(patch.answered),
      patch.parked === undefined ? null : at(patch.parked)
    )
}

function approval(id: string, runId: string, askedMin: number, answeredMin: number | null): void {
  db.db()
    .prepare(
      `insert into approvals (id, session_id, run_id, origin, tool, summary, policy_result,
                              asked_at, escalate_after_ms, answered_at)
       values (?, 's', ?, 'permission_prompt', 'Bash', 'rm', 'escalate', ?, 0, ?)`
    )
    .run(id, runId, at(askedMin), answeredMin === null ? null : at(answeredMin))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-activetime-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  activetime = await import('./activetime.js')
  db.openDb(join(dir, 'activetime.db'))
  db.db()
    .prepare(
      `insert into workers (id, label, adapter_id, isolation_root, enabled, human_occupied,
                            max_concurrent, role, created_at)
       values (?, 'ClaudeMain', 'claude-code', ?, 1, 0, 1, 'worker', ?)`
    )
    .run(WORKER, join(dir, 'w'), T)
})

beforeEach(() => {
  db.db().exec('delete from questions')
  db.db().exec('delete from approvals')
  db.db().exec('delete from runs')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A file the daemon still holds on Windows is not a test failure.
  }
})

describe('reading the waits back out of the database', () => {
  it('counts a question and an escalated approval alike', () => {
    task('t1', 1)
    run('r1', 't1', 0, 100)
    question('q1', 'r1', 10, { answered: 30 })
    approval('a1', 'r1', 50, 60)

    const t = activetime.timingForTasks(['t1'], at(600)).get('t1')
    expect(t?.blockedMs).toBe(30 * MIN)
    expect(t?.activeMs).toBe(70 * MIN)
  })

  it('ends a parked question at the parking, not at the answer', () => {
    // ⛔ Parking is what happens when the session holding the question stops being worth keeping
    // warm. From then on nothing is waiting, and an answer given the next morning must not backdate
    // hours of "blocked" onto a run that had already stopped.
    task('t1', 1)
    run('r1', 't1', 0, 20)
    question('q1', 'r1', 5, { parked: 15, answered: 500 })

    expect(activetime.timingForTasks(['t1'], at(600)).get('t1')?.blockedMs).toBe(10 * MIN)
  })

  it('costs nothing for an approval the project rules settled', () => {
    // A policy decision is written with `answered_at = asked_at`, so it needs no special case —
    // but if that ever changes, every task with a busy allowlist starts losing time here.
    task('t1', 1)
    run('r1', 't1', 0, 10)
    approval('a1', 'r1', 5, 5)

    expect(activetime.timingForTasks(['t1'], at(600)).get('t1')?.activeMs).toBe(10 * MIN)
  })

  it('keeps two tasks apart when both are asked for at once', () => {
    task('t1', 1)
    task('t2', 2)
    run('r1', 't1', 0, 10)
    run('r2', 't2', 0, 40)
    question('q1', 'r2', 5, { answered: 25 })

    const found = activetime.timingForTasks(['t1', 't2'], at(600))
    expect(found.get('t1')?.activeMs).toBe(10 * MIN)
    expect(found.get('t2')?.activeMs).toBe(20 * MIN)
  })

  it('answers for a task with no runs at all', () => {
    task('t1', 1)
    expect(activetime.timingForTasks(['t1'], at(600)).get('t1')).toEqual({
      activeMs: 0,
      activeSince: null,
      blockedMs: 0
    })
  })
})
