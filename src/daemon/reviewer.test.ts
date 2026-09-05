import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import { RUBRIC_DIMENSIONS, type DimensionScore, type RubricDimension } from '@shared/review.js'

/**
 * Who is allowed to grade whom.
 *
 * ⛔ **A review never grades its own author**, and the exclusion is by **adapter**, not by worker:
 * one Claude account grading another Claude account is Claude grading Claude, and the whole reason
 * this feature exists — the standard mitigation for a judge's self-preference bias — evaporates.
 *
 * ⛔ **No eligible peer means no review**, and the refusal names every candidate considered and why
 * each was rejected. Every stored score was produced by a non-author; there is no asterisked variant
 * of that claim, and no path here that settles for a self-graded one.
 */

let dir: string
let db: typeof import('./db.js')
let reviewer: typeof import('./reviewer.js')

const CLAUDE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const CLAUDE_B = 'aaaaaaaa-0000-4000-8000-000000000002'
const CODEX = 'aaaaaaaa-0000-4000-8000-000000000003'
const AGY = 'aaaaaaaa-0000-4000-8000-000000000004'
const TASK = 'bbbbbbbb-0000-4000-8000-000000000001'

let seq = 0

function worker(id: string, label: string, adapterId: string): void {
  db.db()
    .prepare(
      `insert or replace into workers (id, label, adapter_id, isolation_root, enabled,
                                       human_occupied, max_concurrent, role, created_at)
       values (?,?,?,?,1,0,1,'worker',?)`
    )
    .run(id, label, adapterId, join(dir, label), Date.now())
}

function disable(id: string): void {
  db.db().prepare('update workers set enabled = 0 where id = ?').run(id)
}

function markSignedOut(id: string): void {
  db.db().prepare('update workers set identity_json = ? where id = ?').run('{"loggedIn":false}', id)
}

function workRun(workerId: string, adapterId: string, model: string, outcome = 'completed'): void {
  seq += 1
  db.db()
    .prepare(
      `insert into runs (id, task_id, session_id, worker_id, started_at, ended_at, outcome,
                         quota_unverified, adapter_id, model, input_tokens, output_tokens,
                         cache_read_tokens, cache_write_tokens, kind)
       values (?,?,null,?,?,?,?,0,?,?,0,0,0,0,'work')`
    )
    .run(`run-${seq}`, TASK, workerId, seq * 1000, seq * 1000 + 10, outcome, adapterId, model)
}

const task = (): Task => ({ id: TASK }) as Task

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-reviewer-'))
  process.env.MULTI_AGENT_CONTROLLER_DATA_DIR = dir
  db = await import('./db.js')
  db.openDb(join(dir, 'reviewer.db'))
  reviewer = await import('./reviewer.js')
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?, 1, 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
    )
    .run(TASK, Date.now(), Date.now())
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

beforeEach(() => {
  db.db().prepare('delete from runs').run()
  db.db().prepare('delete from workers').run()
  db.db().prepare('delete from quality_reviews').run()
})

describe('picking a reviewer', () => {
  it('never picks the agent that did the work', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(reviewer.pickReviewer(task()).worker?.adapterId).toBe('openai-compatible')
  })

  it('excludes by adapter, not by account: a second Claude is still Claude', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CLAUDE_B, 'ClaudeSecond', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const choice = reviewer.pickReviewer(task())
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('did this work')
  })

  it('excludes every adapter that contributed, not only the last one', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    worker(AGY, 'AgyFirst', 'antigravity-cli')
    // Antigravity started it; Claude finished it. Neither may grade it.
    workRun(AGY, 'antigravity-cli', 'gemini-3.7-flash-medium')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(reviewer.pickReviewer(task()).worker?.adapterId).toBe('openai-compatible')
  })

  it('names every rejection when nothing is left, rather than saying "unavailable"', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    disable(CODEX)

    const choice = reviewer.pickReviewer(task())
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('ClaudeFirst did this work')
    expect(choice.reason).toContain('CodexFirst')
  })

  it('says so plainly when this machine has only one agent commissioned', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(reviewer.pickReviewer(task()).reason).toContain('no peer to review this work')
  })

  it('offers the cheap rung of the chosen provider, so a grade costs a fraction of the work', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(reviewer.pickReviewer(task()).model).toBe(reviewer.REVIEW_MODELS['openai-compatible'])
  })

  it('lets Auto choose any eligible worker randomly', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    worker(AGY, 'AgyFirst', 'antigravity-cli')
    workRun(AGY, 'antigravity-cli', 'gemini-3.7-flash-medium')

    expect(reviewer.pickReviewer(task(), null, () => 0).worker?.id).toBe(CLAUDE_A)
    expect(reviewer.pickReviewer(task(), null, () => 0.999).worker?.id).toBe(CODEX)
  })

  it('honours a manually selected eligible worker and still uses its small model', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    worker(AGY, 'AgyFirst', 'antigravity-cli')
    workRun(AGY, 'antigravity-cli', 'gemini-3.7-flash-medium')

    const choice = reviewer.pickReviewer(task(), CODEX)
    expect(choice.worker?.id).toBe(CODEX)
    expect(choice.model).toBe(reviewer.REVIEW_MODELS['openai-compatible'])
  })

  it('allows a local-llm worker to be picked or selected as reviewer with its grading model', () => {
    const LOCAL = 'aaaaaaaa-0000-4000-8000-000000000005'
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(LOCAL, 'LocalLlm', 'local-llm')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const choice = reviewer.pickReviewer(task(), LOCAL)
    expect(choice.worker?.id).toBe(LOCAL)
    expect(choice.model).toBe('qwen3-coder-30b-a3b')
    expect(reviewer.REVIEW_MODELS['local-llm']).toBe('qwen3-coder-30b-a3b')

    const autoChoice = reviewer.pickReviewer(task())
    expect(autoChoice.worker?.id).toBe(LOCAL)
    expect(autoChoice.model).toBe('qwen3-coder-30b-a3b')
  })

  it('lists routable peers even when transient state prevents an immediate review', () => {
    const LOCAL = 'aaaaaaaa-0000-4000-8000-000000000005'
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    worker(AGY, 'Antigravity', 'antigravity-cli')
    worker(LOCAL, 'LocalLlm', 'local-llm')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    markSignedOut(LOCAL)

    expect(reviewer.reviewCandidateOptions(task()).map((candidate) => candidate.workerId)).toEqual([
      CODEX,
      AGY,
      LOCAL
    ])
    // Request-time selection still protects the machine from spawning an unavailable endpoint.
    expect(reviewer.pickReviewer(task(), LOCAL).worker).toBeNull()
  })

  it('refuses a manual selection from an adapter that participated in the work', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const choice = reviewer.pickReviewer(task(), CLAUDE_A)
    expect(choice.worker).toBeNull()
    expect(choice.reason).toContain('not eligible')
  })

  it('ignores a failed run when working out who did the work', () => {
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    // Codex tried and failed; Claude did the work. Codex is not an author and may grade it.
    workRun(CODEX, 'openai-compatible', 'gpt-5.6-terra', 'failed')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(reviewer.pickReviewer(task()).worker?.adapterId).toBe('openai-compatible')
  })
})

describe('the task headline', () => {
  it('averages every completed scored review and keeps the review count', async () => {
    const review = await import('./review.js')
    const tasks = await import('./tasks.js')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    const scores = (score: number): Record<RubricDimension, DimensionScore> =>
      Object.fromEntries(
        RUBRIC_DIMENSIONS.map((dimension) => [
          dimension,
          { score, rationale: 'measured in the committed diff' }
        ])
      ) as Record<RubricDimension, DimensionScore>
    const first = review.createPendingReview({
      taskId: TASK,
      runId: 'review-run-1',
      reviewerWorkerId: CODEX,
      reviewerAdapter: 'openai-compatible',
      reviewerModel: 'gpt-5.4-mini',
      subjectAdapter: 'claude-code',
      subjectModel: 'claude-opus-5',
      authorship: [],
      mixed: false,
      diff: null,
      blindingLeak: false
    })
    review.completeReview(first.id, {
      ok: true,
      scores: scores(6),
      summary: 'first',
      notable: []
    })
    const second = review.createPendingReview({
      taskId: TASK,
      runId: 'review-run-2',
      reviewerWorkerId: CODEX,
      reviewerAdapter: 'openai-compatible',
      reviewerModel: 'gpt-5.4-mini',
      subjectAdapter: 'claude-code',
      subjectModel: 'claude-opus-5',
      authorship: [],
      mixed: false,
      diff: null,
      blindingLeak: false
    })
    review.completeReview(second.id, {
      ok: true,
      scores: scores(10),
      summary: 'second',
      notable: []
    })

    expect(tasks.getTask(TASK)?.qualityScore).toBe(8)
    expect(tasks.getTask(TASK)?.qualityReviewCount).toBe(2)
  })
})

describe('who is being graded', () => {
  it('credits the adapter of the last non-failed work run', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CODEX, 'openai-compatible', 'gpt-5.6-terra')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const authorship = review.authorshipOf(TASK)
    expect(authorship.subjectAdapter).toBe('claude-code')
    expect(authorship.subjectModel).toBe('claude-opus-5')
    // ⚠️ And the flag that says this score is not clean evidence about that agent.
    expect(authorship.mixed).toBe(true)
    expect(authorship.authors).toHaveLength(2)
  })

  it('is not mixed when one agent did every run', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    expect(review.authorshipOf(TASK).mixed).toBe(false)
  })

  it('does not count a quality review as authorship of the work it graded', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    seq += 1
    db.db()
      .prepare(
        `insert into runs (id, task_id, session_id, worker_id, started_at, outcome, quota_unverified,
                           adapter_id, model, input_tokens, output_tokens, cache_read_tokens,
                           cache_write_tokens, kind)
         values (?,?,null,?,?, 'completed',0,'openai-compatible','gpt-5.4-mini',0,0,0,0,'quality_review')`
      )
      .run(`run-${seq}`, TASK, CODEX, seq * 1000)

    // ⛔ Otherwise the reviewer becomes an author and can never review this task again — and worse,
    // the next reviewer sees a mixed-authorship task that was never mixed.
    const authorship = review.authorshipOf(TASK)
    expect(authorship.mixed).toBe(false)
    expect(authorship.subjectAdapter).toBe('claude-code')
  })
})

describe('the run history the judge is shown', () => {
  it('says a preempted run was the scheduler’s doing, not the agent’s', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5', 'preempted')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const history = review.runHistoryText(TASK)
    // ⚠️ Without this sentence the judge reads a two-run task as one failure and scores
    // self-sufficiency down for something the agent did not do.
    expect(history).toContain('Not a failure of the work')
    expect(history).toContain('2 run(s)')
  })

  it('names no agent, no model and no account', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const history = review.runHistoryText(TASK)
    expect(history).not.toContain('claude')
    expect(history).not.toContain('ClaudeFirst')
  })

  it('marks where a different agent took over, without saying which', async () => {
    const review = await import('./review.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CODEX, 'openai-compatible', 'gpt-5.6-terra')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const history = review.runHistoryText(TASK)
    expect(history).toContain('a different agent took over here')
    expect(history).not.toContain('openai-compatible')
  })
})

describe('how long a reviewer is given to answer', () => {
  const t0 = 1_700_000_000_000
  const min = (n: number): number => t0 + n * 60_000

  it('waits through a slow model reading the prompt, where a wall clock cut it off', () => {
    // ⛔ The t217 case, measured 2026-09-04: a 27B model on the operator's own GPU at ~3.5 tok/s was
    // handed a 33k-character prompt and killed at 300.2s having said nothing yet. Silence for six
    // minutes is a model still reading, not a model that died.
    expect(reviewer.reviewStall({ askedAt: t0, lastOutputAt: null, chars: 0 }, min(6))).toBeNull()
  })

  it('gives up when nothing at all has arrived, and says how long it waited', () => {
    const stall = reviewer.reviewStall({ askedAt: t0, lastOutputAt: null, chars: 0 }, min(16))
    expect(stall).toContain('nothing at all')
    expect(stall).toContain('16m00s')
  })

  it('keeps waiting on a reviewer that is still talking, however slowly', () => {
    // ⚠️ Twenty minutes in and streaming: at 3.5 tok/s that is a normal answer, not a hang.
    const progress = { askedAt: t0, lastOutputAt: min(19), chars: 1200 }
    expect(reviewer.reviewStall(progress, min(20))).toBeNull()
  })

  it('stops a reviewer that has gone quiet, and reports what it had written', () => {
    const stall = reviewer.reviewStall({ askedAt: t0, lastOutputAt: min(8), chars: 412 }, min(14))
    expect(stall).toContain('quiet')
    expect(stall).toContain('412 characters')
  })

  it('has a ceiling, so a stream that never ends is not waited on forever', () => {
    const progress = { askedAt: t0, lastOutputAt: min(46), chars: 90_000 }
    expect(reviewer.reviewStall(progress, min(46))).toContain('as long as a review gets')
  })
})
