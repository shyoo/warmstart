import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/tasks.js'
import { RUBRIC_DIMENSIONS, type DimensionScore, type RubricDimension } from '@shared/review.js'
import { forceInstalled } from './testkit.js'

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
let undoInstalled: (() => void) | undefined

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
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  db.openDb(join(dir, 'reviewer.db'))
  reviewer = await import('./reviewer.js')
  // ⛔ `pickReviewer` asks `reviewCandidates(task, true)`, and `requireAvailable` reaches
  // `eligibility.ts`'s *"…is not installed"* gate before any of the rules these tests exist to pin.
  // Without this every candidate is rejected on a machine with no vendor CLI and the suite asserts
  // nothing about authorship, adapter exclusion or model choice. Measured 2026-09-09.
  undoInstalled = await forceInstalled('claude-code', 'openai-compatible', 'antigravity-cli', 'local-llm')
  db.db()
    .prepare(
      `insert into tasks (id, seq, title, status, created_by_json, mandate_json, budget_json,
                          created_at, updated_at)
       values (?, 1, 'a task', 'completed', '{}', '{}', '{}', ?, ?)`
    )
    .run(TASK, Date.now(), Date.now())
})

afterAll(() => {
  undoInstalled?.()
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
  db.db().prepare('delete from manual_reviews').run()
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

  it('offers the cheap level of the chosen provider, so a grade costs a fraction of the work', () => {
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

  it('allows a local-llm worker to be picked or selected as reviewer, leaving the model to its server', () => {
    const LOCAL = 'aaaaaaaa-0000-4000-8000-000000000005'
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(LOCAL, 'LocalLlm', 'local-llm')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    // ⛔ Null, not a name (t486). A local worker's model is whatever its endpoint serves; the bridge
    // names it on `init` and `noteReviewerModel` writes it onto the grade afterwards. The name that
    // used to sit here was written to every local grade regardless of which gguf answered.
    const choice = reviewer.pickReviewer(task(), LOCAL)
    expect(choice.worker?.id).toBe(LOCAL)
    expect(choice.model).toBeNull()
    expect(reviewer.REVIEW_MODELS['local-llm']).toBeNull()

    const autoChoice = reviewer.pickReviewer(task())
    expect(autoChoice.worker?.id).toBe(LOCAL)
    expect(autoChoice.model).toBeNull()
  })

  it('a local-llm worker with a chosen served model reviews on that model', () => {
    const LOCAL = 'aaaaaaaa-0000-4000-8000-000000000005'
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(LOCAL, 'LocalLlm', 'local-llm')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    db.db().prepare('update workers set grading_model = ? where id = ?').run('local-llm:Qwen3.8-27B-UD-Q4_K_XL.gguf', LOCAL)

    expect(reviewer.pickReviewer(task(), LOCAL).model).toBe('local-llm:Qwen3.8-27B-UD-Q4_K_XL.gguf')
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

/**
 * ⛔ **A reviewer blamed for a workspace its CLI refused to open.** Measured 2026-09-14 (t436):
 * three reviews on Muse Code 1.1.1 died at ~4.5s and reported only *the reviewer's session ended
 * before it answered*. The process had written the cause on stderr, where the stream parser dropped
 * it as ordinary chatter, so the operator was handed a failure with no address on it.
 */
describe('a reviewer whose process died', () => {
  it('names the exit code and quotes the CLI', () => {
    const said = reviewer.sessionDiedReason(
      1,
      'runtime host failed to start: failed to read skill file at /repo/.codex/skills: Not a directory (os error 20)'
    )
    expect(said).toContain('ended before it answered')
    expect(said).toContain('(exit 1)')
    expect(said).toContain('.codex/skills')
  })

  it('says no more than it knows when the CLI said nothing', () => {
    expect(reviewer.sessionDiedReason(null, null)).toBe(
      'the reviewer’s session ended before it answered'
    )
    // ⚠️ A clean exit with no answer is still a failure, but "exit 0" adds nothing to it.
    expect(reviewer.sessionDiedReason(0, null)).not.toContain('exit')
  })
})

describe('stopping a grade', () => {
  it('cancels a stranded pending review and its run without changing the task', async () => {
    const reviewStore = await import('./review.js')
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, quota_unverified, kind)
         values ('review-run', ?, ?, ?, 1, 'quality_review')`
      )
      .run(TASK, CODEX, Date.now())
    const pending = reviewStore.createPendingReview({
      taskId: TASK,
      runId: 'review-run',
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

    const stopped = reviewer.cancelReview(pending.id)

    expect(stopped.ok).toBe(true)
    expect(reviewStore.requireReview(pending.id).status).toBe('cancelled')
    expect(db.db().prepare('select outcome from runs where id = ?').get('review-run')).toMatchObject({
      outcome: 'cancelled'
    })
    expect(db.db().prepare('select status from tasks where id = ?').get(TASK)).toMatchObject({
      status: 'completed'
    })
  })

  it('cancels a pending review by taskId as well as reviewId', async () => {
    const reviewStore = await import('./review.js')
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, quota_unverified, kind)
         values ('review-run-task', ?, ?, ?, 1, 'quality_review')`
      )
      .run(TASK, CODEX, Date.now())
    const pending = reviewStore.createPendingReview({
      taskId: TASK,
      runId: 'review-run-task',
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

    const stopped = reviewer.cancelReview(TASK)

    expect(stopped.ok).toBe(true)
    expect(reviewStore.requireReview(pending.id).status).toBe('cancelled')
    expect(db.db().prepare('select outcome from runs where id = ?').get('review-run-task')).toMatchObject({
      outcome: 'cancelled'
    })
  })
})

describe('a grade left in flight by a restart', () => {
  it('is settled at startup, because nothing in this process is still waiting for it', async () => {
    const reviewStore = await import('./review.js')
    db.db()
      .prepare(
        `insert into runs (id, task_id, worker_id, started_at, quota_unverified, kind)
         values ('stranded-run', ?, ?, ?, 1, 'quality_review')`
      )
      .run(TASK, CODEX, Date.now())
    const pending = reviewStore.createPendingReview({
      taskId: TASK,
      runId: 'stranded-run',
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

    // ⛔ The t217 shape: the review sits on a *completed* task, which `reconcileTasks` never walks,
    // so before this sweep existed the row said "grading…" with no process behind the word.
    expect(reviewer.reconcileReviews()).toBe(1)

    const settled = reviewStore.requireReview(pending.id)
    expect(settled.status).toBe('failed')
    expect(settled.failureReason).toContain('restarted')
    // ⚠️ `failed`, not `cancelled`: a restart is not a person deciding to stop one.
    expect(settled.status).not.toBe('cancelled')
    expect(db.db().prepare('select outcome from runs where id = ?').get('stranded-run')).toMatchObject({
      outcome: 'terminated'
    })
    // The task it was grading is untouched, and a second sweep finds nothing left to settle.
    expect(db.db().prepare('select status from tasks where id = ?').get(TASK)).toMatchObject({
      status: 'completed'
    })
    expect(reviewer.reconcileReviews()).toBe(0)
  })
})

describe('the session’s own startup record', () => {
  const t0 = 1_700_000_000_000
  const min = (n: number): number => t0 + n * 60_000

  it('does not count as the reviewer talking, so the first-output window survives it', () => {
    // ⛔ The t217 regression, measured 2026-09-04 (18:50:20→18:55:26): the local bridge emits
    // `{"type":"init"}` on spawn, 2.5s before the prompt is sent. Counted as output, it skipped the
    // 15-minute window straight into the 5-minute silence rule — the exact death this clock exists
    // to prevent, reported as "went quiet for 5m05s after 0 characters".
    const progress = { askedAt: t0, lastOutputAt: t0 - 2_500, chars: 0 }
    expect(reviewer.reviewStall(progress, min(6))).toBeNull()
    expect(reviewer.reviewStall(progress, min(14))).toBeNull()
  })

  it('still gives up on a reviewer that never says anything of its own', () => {
    const progress = { askedAt: t0, lastOutputAt: t0 - 2_500, chars: 0 }
    expect(reviewer.reviewStall(progress, min(16))).toContain('nothing at all')
  })

  it('starts the silence clock at the first real output, not at the startup record', () => {
    // Spoke at 14m (inside the first-output window), then went quiet: 5m of silence from *then*.
    const spoke = { askedAt: t0, lastOutputAt: min(14), chars: 120 }
    expect(reviewer.reviewStall(spoke, min(18))).toBeNull()
    expect(reviewer.reviewStall(spoke, min(19))).toContain('quiet')
  })
})

/**
 * A turn that ended in an error is not a reply, and for months it was read as one.
 *
 * ⛔ **Measured on this install.** codex's `result` record carries `isError` and, as its text, the
 * vendor's refusal — sometimes a JSON envelope, sometimes a plain sentence. `ask` ignored the flag
 * and handed the text to `extractJson`, which parsed the envelope perfectly well; it simply has no
 * `rubric_version` in it. So **2** reviews on 2026-09-09 were filed as *"the reply omitted required
 * `rubric_version`"* when the truth was that the account may not use that model, and **31** on
 * 2026-09-06 as *"the reply contained no JSON object"* when the truth was a usage limit with a reset
 * time in it. Both blamed the reviewer's formatting for something only the operator could fix, and
 * both are facts about the *fleet* that were being stored as facts about a model's JSON.
 */
describe('a reviewer whose turn ended in an error', () => {
  it('reports the vendor’s sentence out of its JSON envelope, not the envelope', () => {
    const said = reviewer.resultError(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The ' +
        "'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.\"}}",
      'turn.failed'
    )
    expect(said).toContain('turn.failed')
    expect(said).toContain("The 'gpt-5.4-mini' model is not supported")
    // ⛔ The operator must never be shown the wrapper instead of the sentence inside it.
    expect(said).not.toContain('invalid_request_error')
    expect(said).not.toContain('rubric')
  })

  it('passes a plain-text refusal through whole, reset time and all', () => {
    const limit =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
      'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, ' +
      '2026 8:36 PM.'
    expect(reviewer.resultError(limit, 'turn.failed')).toContain('try again at Sep 8th')
  })

  it('reports an unrecognised JSON shape whole rather than truncating it to nothing', () => {
    const odd = '{"type":"error","status":500}'
    expect(reviewer.resultError(odd, null)).toContain(odd)
  })

  it('says so plainly when the error carried no words at all', () => {
    expect(reviewer.resultError(null, 'turn.failed')).toContain('said nothing about it')
    expect(reviewer.resultError('   ', null)).toContain('said nothing about it')
  })
})

/**
 * The operator's own rating.
 *
 * ⛔ **One per task, editable, and it counts.** There is one operator, so a second rating of the
 * same work is a changed mind, not a second opinion — a mean of two of them would count one person
 * twice. And it feeds the task's headline score the way it already fed the Analytics aggregate:
 * before t359 a task rated only by hand showed `—` in the Quality column.
 */
describe("the operator's own rating", () => {
  const peerScores = (score: number): Record<RubricDimension, DimensionScore> =>
    Object.fromEntries(
      RUBRIC_DIMENSIONS.map((dimension) => [dimension, { score, rationale: 'measured in the committed diff' }])
    ) as Record<RubricDimension, DimensionScore>

  async function peerReview(score: number): Promise<void> {
    const review = await import('./review.js')
    const pending = review.createPendingReview({
      taskId: TASK,
      runId: `review-run-${score}`,
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
    review.completeReview(pending.id, { ok: true, scores: peerScores(score), summary: 's', notable: [] })
  }

  it('counts in the task headline, alone and averaged with peer grades', async () => {
    const review = await import('./review.js')
    const tasks = await import('./tasks.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const created = review.createManualReview(TASK, 4, 'Missed half the brief.')
    expect(created.ok).toBe(true)
    let task = tasks.getTask(TASK)!
    expect(task.qualityScore).toBe(4)
    expect(task.qualityReviewCount).toBe(1)
    expect(task.qualityManualCount).toBe(1)
    expect(task.qualityReviewer).toBeNull()
    expect(task.qualityReviewedAt).not.toBeNull()

    await peerReview(8)
    task = tasks.getTask(TASK)!
    expect(task.qualityScore).toBe(6)
    expect(task.qualityReviewCount).toBe(2)
    expect(task.qualityManualCount).toBe(1)
    expect(task.qualityReviewer).toBe('openai-compatible')
  })

  it('caps at one per task and edits in place', async () => {
    const review = await import('./review.js')
    const tasks = await import('./tasks.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')

    const first = review.createManualReview(TASK, 4, 'Missed half the brief.')
    if (!first.ok) throw new Error(first.reason)
    const second = review.createManualReview(TASK, 9, 'Changed my mind.')
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('a second rating was accepted')
    expect(second.reason).toContain('already has your review')

    const edited = review.updateManualReview(first.review.id, 9, '  Changed my mind.  ')
    if (!edited.ok) throw new Error(edited.reason)
    expect(edited.review.id).toBe(first.review.id)
    expect(edited.review.score).toBe(9)
    expect(edited.review.explanation).toBe('Changed my mind.')
    expect(review.manualReviewsForTask(TASK)).toHaveLength(1)
    expect(tasks.getTask(TASK)?.qualityScore).toBe(9)

    expect(review.updateManualReview(first.review.id, 11, 'x').ok).toBe(false)
    expect(review.updateManualReview(first.review.id, 5, '   ').ok).toBe(false)
    expect(review.updateManualReview('nope', 5, 'x').ok).toBe(false)
    expect(tasks.getTask(TASK)?.qualityScore).toBe(9)
  })

  it('deleting it recomputes the headline from what remains', async () => {
    const review = await import('./review.js')
    const tasks = await import('./tasks.js')
    worker(CLAUDE_A, 'ClaudeFirst', 'claude-code')
    worker(CODEX, 'CodexFirst', 'openai-compatible')
    workRun(CLAUDE_A, 'claude-code', 'claude-opus-5')
    await peerReview(8)
    const created = review.createManualReview(TASK, 2, 'Broke the build.')
    if (!created.ok) throw new Error(created.reason)
    expect(tasks.getTask(TASK)?.qualityScore).toBe(5)

    expect(review.deleteManualReview(created.review.id)).toEqual({ ok: true })
    let task = tasks.getTask(TASK)!
    expect(task.qualityScore).toBe(8)
    expect(task.qualityReviewCount).toBe(1)
    expect(task.qualityManualCount).toBe(0)
    expect(task.qualityReviewer).toBe('openai-compatible')

    // And with nothing left at all the headline is an honest null, never a zero.
    const again = review.createManualReview(TASK, 2, 'Broke the build.')
    if (!again.ok) throw new Error(again.reason)
    for (const peer of review.reviewsForTask(TASK)) review.deleteReview(peer.id)
    expect(tasks.getTask(TASK)?.qualityScore).toBe(2)
    review.deleteManualReview(again.review.id)
    task = tasks.getTask(TASK)!
    expect(task.qualityScore).toBeNull()
    expect(task.qualityReviewCount).toBe(0)
    expect(task.qualityReviewedAt).toBeNull()
    // ⚠️ Deleting the newest peer review used to leave the reviewer's name on the task.
    expect(task.qualityReviewer).toBeNull()
    expect(task.qualityReviewId).toBeNull()
  })

  it('migration 65 folds a rating stored before it into the headline', async () => {
    const tasks = await import('./tasks.js')
    // A row written the way the pre-t359 build wrote it: the rating stored, the task untouched.
    db.db()
      .prepare(
        `insert into manual_reviews
           (id, task_id, subject_adapter, subject_model, mixed_authorship, score, explanation, created_at)
         values ('old-rating', ?, 'claude-code', 'claude-opus-5', 0, 7, 'Fine.', 5)`
      )
      .run(TASK)
    expect(tasks.getTask(TASK)?.qualityScore).toBeNull()

    db.db().exec(`pragma user_version = ${db.versionBefore('where exists (select 1 from manual_reviews m')}`)
    db.closeDb()
    db.openDb(join(dir, 'reviewer.db'))

    const task = tasks.getTask(TASK)!
    expect(task.qualityScore).toBe(7)
    expect(task.qualityReviewCount).toBe(1)
    expect(task.qualityReviewedAt).toBe(5)
  })
})
