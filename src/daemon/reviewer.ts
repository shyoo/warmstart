import type { QualityReview } from '@shared/review.js'
import type { Worker } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'
import { WINDOW_HIGH_WATER } from '@shared/tasks.js'
import { adapter } from './adapters/index.js'
import { accountUnavailability } from './eligibility.js'
import { extractJson } from './controller.js'
import { db, rows } from './db.js'
import { landingTargetFor, getProject } from './projects.js'
import { lastQuota } from './quota.js'
import {
  authorshipOf,
  blind,
  collectDiff,
  buildReviewPrompt,
  completeReview,
  createPendingReview,
  humanFollowUps,
  parseReviewReply,
  refuseReview,
  requireReview,
  resolveRange,
  runHistoryText
} from './review.js'
import {
  closeSession,
  onSessionEnd,
  onSessionStream,
  sendPrompt,
  sessionsForWorker,
  spawnSession
} from './sessions.js'
import { finishRun, getTask, messagesFor, startRun } from './tasks.js'
import { defaultGradingModel, listWorkers } from './workers.js'
import { log } from './log.js'

/**
 * Choosing a reviewer, and running the review.
 *
 * ⛔ **A review never grades its own author.** That is the premise of the whole feature — the
 * standard mitigation for a judge's self-preference bias is not to let a model grade itself — so it
 * is a hard constraint here and not a preference that a busy fleet can quietly relax. ⚠️ Excluded by
 * **adapter**, never by worker: one Claude account grading another Claude account is Claude grading
 * Claude.
 *
 * ⛔ **No eligible peer means no review.** The button reports which agents were considered and why
 * each was rejected and writes nothing, so every stored score was produced by a non-author. There is
 * no asterisked variant of that claim.
 *
 * ⛔ **No `if (adapter === …)` anywhere in here**, as AGENTS.md requires: the read-only gate is a
 * capability, the quota gate is a reading, and the author gate is a set difference on ids.
 */

/**
 * A review's clock measures **silence, not elapsed time**.
 *
 * ⛔ **A fixed wall-clock deadline is a claim about how fast inference is, and it was wrong the
 * first time a model ran on the operator's own GPU.** Measured on t217 (2026-09-04): a review by a
 * 27B local model was cut off at exactly 300.2s of a 300s budget with *the reviewer did not answer
 * in time*, having been handed a 33,151-character prompt (~8.3k tokens) and generating at ~3.5
 * tok/s. At that pace reading the prompt alone outlasts the whole budget before the first token of
 * the answer exists — so the deadline fired on a reviewer that was working, not on one that was
 * stuck, and the review was billed as a failure the model never had a chance to avoid.
 *
 * ⛔ Raising the number would only move the cliff to the next machine. What this actually needs to
 * detect is *a reviewer that has stopped talking*, which is adapter-agnostic and cheap to observe:
 * every stream carries assistant text as it is produced (the local bridge flushes a delta every ~60
 * characters, which at 3.5 tok/s is one every ~4s), so a working reviewer says something on a scale
 * of seconds at **any** pace and a dead one says nothing at all. Hence three windows and no
 * per-adapter table — see `reviewStall`.
 */

/**
 * How long to wait for the **first** output. This is prompt-reading time, and it is the window a
 * slow local model actually needs: ~8k tokens of prompt at the prefill rates a partially offloaded
 * 27B reaches on a consumer GPU is minutes, not seconds. ⚠️ Costs a hosted reviewer nothing — a CLI
 * that dies exits, and `onSessionEnd` resolves the wait long before this.
 */
const REVIEW_FIRST_OUTPUT_MS = 15 * 60 * 1000

/** How long a reviewer that *has* been talking may go quiet before it counts as stuck. */
const REVIEW_SILENCE_MS = 5 * 60 * 1000

/** The backstop, for a stream that emits forever without ever ending its turn. */
const REVIEW_CEILING_MS = 45 * 60 * 1000

/** How often the windows above are checked. Cheap: one timestamp comparison. */
const REVIEW_WATCH_MS = 5_000

/** The same settling delay a consult uses: a freshly spawned CLI swallows what arrives too early. */
const PROMPT_DELAY_MS = 2500

/** Kept exported for callers comparing the built-in defaults; persisted worker choice wins. */
export const REVIEW_MODELS: Record<string, string> = {
  'claude-code': defaultGradingModel('claude-code')!,
  'antigravity-cli': defaultGradingModel('antigravity-cli')!,
  'openai-compatible': defaultGradingModel('openai-compatible')!,
  'local-llm': defaultGradingModel('local-llm')!
}

function gradingModel(worker: Worker): string | null {
  return worker.gradingModel ?? defaultGradingModel(worker.adapterId)
}

/**
 * The cheap rung of each provider's pool, by adapter.
 *
 * ⚠️ **A guess, and an important one.** Whether a small model can hold a seven-dimension rubric and
 * produce calibrated, non-clustered scores is unmeasured. It is one field on every review record
 * (`reviewerModel`), so the experiment is available: review the same five tasks on the small and the
 * large model of one provider and compare the spread. If the small model clusters everything at 7–8
 * it is not a judge and this table moves up a rung.
 *
 * ⚠️ A missing entry is a real answer — the adapter's own default model is used.
 */
export interface ReviewerChoice {
  worker: Worker | null
  /** ⛔ Never a bare "unavailable": names every candidate considered and why each was rejected. */
  reason: string
  /** What the button says it would use, before anybody presses it. */
  model?: string | null
}

export interface ReviewCandidate {
  workerId: string
  label: string
  model: string | null
  /**
   * How long a review has actually taken on this account, in milliseconds — the median of its own
   * completed review runs, or null when it has never finished one.
   *
   * ⛔ **Measured, never modelled.** The honest answer to "how long will this take" on an endpoint
   * whose speed is a property of somebody's GPU is *what it took here last time*, and until there
   * is a last time the answer is that nobody knows. A number derived from a token count and an
   * assumed rate would look like knowledge and be a guess about a machine this app cannot see.
   */
  typicalMs: number | null
}

/**
 * The median completed review on one account.
 *
 * ⚠️ Completed only. A review that timed out measures this fleet's patience rather than the
 * reviewer's pace, and folding those in would drag the figure towards whatever the deadline was.
 */
export function typicalReviewMs(workerId: string): number | null {
  const durations = rows<{ ms: number }>(
    db()
      .prepare(
        `select ended_at - started_at as ms from runs
          where worker_id = ? and kind = 'quality_review' and outcome = 'completed'
            and ended_at is not null and ended_at > started_at
          order by started_at desc limit 20`
      )
      .all(workerId)
  ).map((r) => r.ms)
  if (durations.length === 0) return null
  durations.sort((a, b) => a - b)
  return durations[Math.floor((durations.length - 1) / 2)] ?? null
}

/** The 5h window this fleet gates on, or null when nothing fresh enough to trust says. */
function window5h(workerId: string): { percent: number } | null {
  const quota = lastQuota(workerId)
  if (!quota || quota.stale) return null
  return quota.windows.find((w) => w.id === 'session' || w.id === '5h') ?? null
}

/**
 * Find the peers that can grade this task. The picker asks for configured/routable peers; the
 * request path additionally asks whether each account is available at this instant.
 *
 * The gates, in order: not an author · grading enabled · worker enabled · a declared read-only
 * stream mode · then, when availability is required, the shared account list · the same quota water
 * mark work goes through · not already reviewing.
 */
function reviewCandidates(task: Task, requireAvailable: boolean): { candidates: Worker[]; reason: string } {
  const { authors } = authorshipOf(task.id)
  const authorAdapters = new Set(authors.map((a) => a.adapterId))
  const rejected: string[] = []
  /** ⚠️ Counted apart from the rest: "everybody here wrote it" is a different sentence. */
  let rejectedAsAuthor = 0
  const candidates: Worker[] = []

  for (const worker of listWorkers()) {
    if (worker.retiredAt) continue
    if (authorAdapters.has(worker.adapterId)) {
      rejected.push(`${worker.label} did this work`)
      rejectedAsAuthor += 1
      continue
    }
    if (worker.gradingEnabled === false) {
      rejected.push(`${worker.label} is not enabled for grading`)
      continue
    }
    const info = adapter(worker.adapterId).info
    if (!worker.enabled) {
      rejected.push(`${worker.label} disabled`)
      continue
    }
    if (!info.capabilities.readOnlyPermissionMode) {
      rejected.push(`${worker.label} has no read-only mode, so it may not read the trunk`)
      continue
    }
    if (!info.capabilities.transports.includes('stream')) {
      rejected.push(`${worker.label} cannot run a non-interactive session`)
      continue
    }
    // The menu answers which commissioned peers are routable reviewers, not which of them could
    // start this instant. Login, health, quota and an in-flight review are transient facts: hiding a
    // configured reviewer whenever one changes made Antigravity and Local LLM vanish from t211's
    // menu. The request path repeats the query with `requireAvailable`, immediately before spawn.
    if (!requireAvailable) {
      candidates.push(worker)
      continue
    }
    const blocked = accountUnavailability(worker)
    if (blocked) {
      rejected.push(blocked)
      continue
    }
    const win = window5h(worker.id)
    if (win && win.percent >= WINDOW_HIGH_WATER) {
      // ⛔ The same gate work goes through. A review is cheap but not free, and spending the last
      // 8% of a window on a grade rather than on work is the wrong trade.
      rejected.push(`${worker.label} is at ${Math.round(win.percent)}% of its 5h window`)
      continue
    }
    if (sessionsForWorker(worker.id).some((s) => s.purpose === 'review')) {
      rejected.push(`${worker.label} is already reviewing`)
      continue
    }
    candidates.push(worker)
  }

  if (candidates.length === 0) {
    // ⛔ Every candidate, with its own reason. ⚠️ And when the *only* reason is that everybody here
    // wrote the code, say the consequence out loud — that is a fact about the fleet an operator can
    // act on (commission a second agent), not a passing condition that will clear on its own.
    const everyoneWroteIt = rejected.length > 0 && rejectedAsAuthor === rejected.length
    const nobodyAtAll = rejected.length === 0
    return {
      candidates: [],
      reason:
        everyoneWroteIt || nobodyAtAll
          ? [
              ...rejected,
              'no other agent is commissioned on this machine, so there is no peer to review this work'
            ].join(' · ')
          : rejected.join(' · ')
    }
  }

  return { candidates, reason: '' }
}

/** Routable peers shown in the reviewer picker; transient availability is checked on request. */
export function reviewCandidateOptions(task: Task): ReviewCandidate[] {
  return reviewCandidates(task, false).candidates.map((worker) => ({
    workerId: worker.id,
    label: worker.label,
    model: gradingModel(worker),
    typicalMs: typicalReviewMs(worker.id)
  }))
}

/**
 * Choose an eligible reviewer. A named worker is a hard request and is revalidated here; Auto
 * chooses uniformly from the eligible accounts. Every choice still uses that adapter's small
 * review model rather than inheriting the worker's work model.
 */
export function pickReviewer(
  task: Task,
  workerId?: string | null,
  random: () => number = Math.random
): ReviewerChoice {
  const eligible = reviewCandidates(task, true)
  if (eligible.candidates.length === 0) return { worker: null, reason: eligible.reason }

  const chosen = workerId
    ? eligible.candidates.find((worker) => worker.id === workerId)
    : eligible.candidates[Math.min(eligible.candidates.length - 1, Math.floor(random() * eligible.candidates.length))]

  if (!chosen) {
    const requested = listWorkers().find((worker) => worker.id === workerId)
    return {
      worker: null,
      reason: requested
        ? `${requested.label} is not eligible to review this task`
        : 'the selected reviewer no longer exists'
    }
  }
  return {
    worker: chosen,
    reason: '',
    model: gradingModel(chosen)
  }
}

/**
 * Whether the button can be offered at all, and what it would do.
 *
 * ⚠️ Two independent questions — is there a peer, and is there a diff — and both are answered
 * before anybody presses anything, because "unavailable" discovered after a click is a worse
 * experience and, for the diff, an irreversible fact about the task rather than a passing condition.
 */
export async function reviewEligibility(taskId: string): Promise<{
  ok: boolean
  reviewers: ReviewCandidate[]
  reason: string
}> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reviewers: [], reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project) {
    return { ok: false, reviewers: [], reason: 'this task has no project to read' }
  }
  // ⛔ **The task's own target.** A split child lands onto its plan branch and never onto `main`, so
  // measured against `main` the ladder's first rung fails (its head is not an ancestor of the trunk)
  // and the second resolves `merge-base(main, child)` — which is where the *plan branch* diverged,
  // putting the planner's commits and every earlier sibling's work inside the range this child is
  // graded on. `resolveRange` refuses to review the wrong commits by name; this is the reference
  // point that keeps it able to tell.
  const range = await resolveRange(task, project, landingTargetFor(task, project))
  if (!range.ok) return { ok: false, reviewers: [], reason: range.reason }

  const reviewers = reviewCandidateOptions(task)
  if (reviewers.length === 0) {
    const eligible = reviewCandidates(task, false)
    return { ok: false, reviewers: [], reason: eligible.reason }
  }
  return {
    ok: true,
    reviewers,
    reason: ''
  }
}

/**
 * Run one review, start to finish.
 *
 * The order is `startRun` → pending row → prompt → parse → settle → `finishRun`, and the run is
 * real so that `creditTurn` meters its tokens by the one path that meters runs and the thread
 * numbers it `#N Quality Review` by the one timeline that numbers them.
 */
export async function requestReview(taskId: string, workerId?: string | null): Promise<
  { ok: true; review: QualityReview } | { ok: false; reason: string }
> {
  const task = getTask(taskId)
  if (!task) return { ok: false, reason: 'no such task' }
  const project = task.projectId ? getProject(task.projectId) : null
  if (!project) return { ok: false, reason: 'this task has no project to read' }

  const range = await resolveRange(task, project, landingTargetFor(task, project))
  if (!range.ok) return { ok: false, reason: range.reason }

  const choice = pickReviewer(task, workerId)
  if (!choice.worker) return { ok: false, reason: choice.reason }
  const worker = choice.worker

  const { authors, subjectAdapter, subjectModel, mixed } = authorshipOf(taskId)
  if (!subjectAdapter) {
    return { ok: false, reason: 'nothing has run on this task yet, so there is no work to grade' }
  }

  const diff = await collectDiff(range.cwd, range.base, range.head)

  // ⛔ Everything the reviewer reads goes through `blind`, and the vocabulary is built from what is
  // actually commissioned rather than from a list of vendor names written here.
  const vocabulary = {
    names: [
      ...listWorkers().map((w) => w.label),
      ...authors.map((a) => a.adapterId),
      ...authors.map((a) => a.model ?? ''),
      ...listWorkers().map((w) => adapter(w.adapterId).info.label)
    ].filter((n) => n.length > 0)
  }
  const blindedDiff = blind(diff.text, vocabulary)
  const blindedHistory = blind(runHistoryText(taskId), vocabulary)
  const followUps = humanFollowUps(messagesFor(taskId)).map((t) => blind(t, vocabulary).text)
  const leaked = blindedDiff.leaked || blindedHistory.leaked

  const model = gradingModel(worker) ?? undefined
  const readOnly = adapter(worker.adapterId).info.capabilities.readOnlyPermissionMode ?? undefined

  let sessionId: string | null = null
  let runId: string | null = null
  let reviewId: string | null = null
  try {
    const session = spawnSession({
      workerId: worker.id,
      purpose: 'review',
      transport: 'stream',
      // ⛔ The project trunk, read-only. Not a pooled worktree: that would make reviews compete with
      // real work for a scarce resource, and could not review a landed task at all once its branch
      // is gone. The read-only mode above is what makes standing here acceptable.
      cwd: project.root,
      ...(model ? { model } : {}),
      ...(readOnly ? { permissionMode: readOnly } : {})
    })
    sessionId = session.id

    const prompt = buildReviewPrompt({
      task,
      followUps,
      history: blindedHistory.text,
      diff: { ...diff, text: blindedDiff.text },
      trunkSha: range.trunkSha
    })

    const run = startRun({
      taskId,
      workerId: worker.id,
      sessionId: session.id,
      projectId: project.id,
      quotaUnverified: true,
      costModelId: null,
      kind: 'quality_review',
      prompt
    })
    runId = run.id

    const review = createPendingReview({
      taskId,
      runId: run.id,
      reviewerWorkerId: worker.id,
      reviewerAdapter: worker.adapterId,
      reviewerModel: model ?? null,
      subjectAdapter,
      subjectModel,
      authorship: authors,
      mixed,
      diff,
      blindingLeak: leaked
    })
    reviewId = review.id

    const { text, reason: why } = await ask(session.id, prompt)
    closeSession(session.id)
    sessionId = null

    if (text === null) {
      // ⚠️ The sentence `ask` produced, not a generic one: on a slow endpoint the difference between
      // "produced nothing at all in 15m00s" and "went quiet after 412 characters" is the difference
      // between a model that needs a smaller prompt and one that fell over.
      finishRun(run.id, 'failed', why)
      return { ok: true, review: completeReview(review.id, { ok: false, reason: why }) }
    }
    const json = extractJson(text)
    if (!json) {
      finishRun(run.id, 'failed', 'the reply contained no JSON object')
      return {
        ok: true,
        review: completeReview(review.id, { ok: false, reason: 'the reply contained no JSON object' })
      }
    }
    const parsed = parseReviewReply(json)
    finishRun(run.id, parsed.ok ? 'completed' : 'failed', parsed.ok ? undefined : parsed.reason)
    return { ok: true, review: completeReview(review.id, parsed) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`quality review of t${task.seq} failed: ${reason}`)
    if (sessionId) closeSession(sessionId)
    if (runId) finishRun(runId, 'failed', reason)
    // ⛔ `refused` rather than `failed` when nothing was ever asked, so a later sweep can tell a
    // model that could not answer from a machine that could not ask.
    if (reviewId) return { ok: true, review: refuseReview(reviewId, reason) }
    return { ok: false, reason }
  }
}

/** What a waiting review has seen so far. ⛔ Timestamps only — nothing here reads the adapter. */
export interface ReviewProgress {
  /** When the prompt was sent. The settling delay before it is not the reviewer's time. */
  askedAt: number
  /** When output last arrived, or null when nothing has arrived at all. */
  lastOutputAt: number | null
  /** How much has arrived, in characters. The only pace evidence a stream gives away for free. */
  chars: number
}

function mins(ms: number): string {
  const total = Math.round(ms / 1000)
  return total < 90 ? `${total}s` : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

/**
 * Has this reviewer stopped? The sentence to record, or null to keep waiting.
 *
 * ⛔ **Every reason it can return names the numbers it decided on**, because a review that failed on
 * a clock is the one case where the operator has to be able to tell "the model is slower than this
 * fleet expects" from "the model died" — and on a local endpoint the first is a setting they can
 * change. The pace it reports is characters, not tokens: the stream is text, and inventing a token
 * count from it would be a number with no measurement behind it.
 */
export function reviewStall(progress: ReviewProgress, now: number): string | null {
  const elapsed = now - progress.askedAt
  if (progress.lastOutputAt === null) {
    if (elapsed < REVIEW_FIRST_OUTPUT_MS) return null
    return `the reviewer produced nothing at all in ${mins(elapsed)}`
  }
  const silent = now - progress.lastOutputAt
  if (silent >= REVIEW_SILENCE_MS) {
    return (
      `the reviewer went quiet for ${mins(silent)} after ${progress.chars} characters ` +
      `in ${mins(elapsed)}`
    )
  }
  if (elapsed >= REVIEW_CEILING_MS) {
    return `the reviewer was still writing after ${mins(elapsed)}, which is as long as a review gets`
  }
  return null
}

/**
 * Send the prompt and wait for the turn to end.
 *
 * Resolves with the reply, or with `text: null` and the sentence saying why there is none.
 */
function ask(sessionId: string, prompt: string): Promise<{ text: string | null; reason: string }> {
  return new Promise((resolve) => {
    let text = ''
    let done = false
    const progress: ReviewProgress = { askedAt: Date.now(), lastOutputAt: null, chars: 0 }
    const finish = (value: string | null, reason: string) => {
      if (done) return
      done = true
      offStream()
      offEnd()
      clearInterval(watch)
      resolve({ text: value, reason })
    }
    const offStream = onSessionStream(sessionId, (event) => {
      // ⚠️ Any traffic counts as alive, not only the text kept: a reviewer reading a file is
      // working, and holding it to the same silence window as one that has crashed is the bug
      // this whole clock exists to avoid.
      progress.lastOutputAt = Date.now()
      if (event.kind === 'assistant_text') {
        text += event.text
        progress.chars += event.text.length
      }
      if (event.kind === 'result') finish(event.text ?? text ?? null, 'the turn ended')
    })
    const offEnd = onSessionEnd(sessionId, () =>
      finish(text || null, 'the reviewer’s session ended before it answered')
    )
    const watch = setInterval(() => {
      const stall = reviewStall(progress, Date.now())
      if (stall) finish(null, stall)
    }, REVIEW_WATCH_MS)
    setTimeout(() => {
      // ⛔ The clock starts here, not at spawn: the settling delay and whatever the CLI spends
      // starting up are not the reviewer failing to answer a question it had not been asked.
      progress.askedAt = Date.now()
      try {
        sendPrompt(sessionId, prompt)
      } catch (err) {
        log.warn('could not send a review prompt:', err)
        finish(null, err instanceof Error ? err.message : 'the review prompt could not be sent')
      }
    }, PROMPT_DELAY_MS)
  })
}

export { requireReview }
