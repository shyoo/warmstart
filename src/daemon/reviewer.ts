import type { QualityReview } from '@shared/review.js'
import type { Worker } from '@shared/protocol.js'
import type { Project, Task } from '@shared/tasks.js'
import { WINDOW_HIGH_WATER } from '@shared/tasks.js'
import { adapter } from './adapters/index.js'
import { accountUnavailability } from './eligibility.js'
import { extractJson } from './controller.js'
import { db, rows } from './db.js'
import { landingTargetFor, getProject, policyFor } from './projects.js'
import { lastQuota } from './quota.js'
import {
  authorshipOf,
  blind,
  gradedAdaptersOf,
  collectDiff,
  buildReviewPrompt,
  cancelReview as settleCancelledReview,
  completeReview,
  createPendingReview,
  humanFollowUps,
  parseReviewReply,
  pendingReviews,
  refuseReview,
  requireReview,
  resolveRange,
  runHistoryText,
  type RangeResolution
} from './review.js'
import {
  closeAndWait,
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
import { errorMessage } from '@shared/errors.js'

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

/** Live review sessions, keyed by their durable review row so a person can stop one precisely. */
const activeReviews = new Map<string, { sessionId: string; stop: () => void }>()

/**
 * Accounts a caller has picked but not yet spawned on.
 *
 * ⛔ **`sessionsForWorker` is not enough once two reviews are started in the same tick.** The
 * "already reviewing" gate reads a session that does not exist until `spawnSession`, and
 * `requestReview` does two `await`s between choosing an account and spawning on it (the diff and the
 * range walk git). Two batch drivers starting together therefore both read *not reviewing*, both
 * pick the same account, and the second one's spawn lands on an account already holding a review —
 * which is exactly the collision `gradeUngraded` avoided by refusing to run anything in parallel at
 * all. This set closes the window instead: `pickReviewer` chooses and `requestReview` claims with no
 * `await` between them, so on a single-threaded runtime the pair is atomic.
 *
 * ⚠️ Released in a `finally`. A claim that outlives its review would retire an account silently.
 */
const claimedReviewers = new Set<string>()

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
  // ⛔ **An adapter is asked at most once.** A second grade from a judge that has already answered
  // is a turn spent re-reading a diff to reproduce a number that is already stored, and on a batch
  // of fifty that is the difference between measuring the fleet and emptying a quota window. See
  // `gradedAdaptersOf` for why this is by adapter and why only `complete` counts.
  const gradedAdapters = gradedAdaptersOf(task.id)
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
    if (gradedAdapters.has(worker.adapterId)) {
      rejected.push(`${worker.label} has already graded this task`)
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
    // ⚠️ Two spellings of one fact, because a review has two phases: `claimedReviewers` covers the
    // gap between being picked and being spawned on, the session covers everything after.
    if (claimedReviewers.has(worker.id) || sessionsForWorker(worker.id).some((s) => s.purpose === 'review')) {
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

/**
 * Could *anybody* still grade this task, and if not, why not.
 *
 * ⚠️ The durable gates only (`requireAvailable: false`), which is what a table of a hundred rows can
 * afford and what it should say: quota and login change by the minute, and a row that read *no
 * eligible review agent* because an account was briefly at 92% of its window would be telling an
 * operator something permanent about a condition that clears itself. Authorship and "has already
 * graded this" do not clear, and those are the two this column is for.
 */
export function reviewerAvailability(
  task: Task,
  /** ⚠️ `true` additionally asks whether an account could start *this instant*. The batch driver's
   *  question, and the only caller that may treat a `false` as something that will clear. */
  requireAvailable = false
): { eligible: boolean; reason: string; count: number } {
  const { candidates, reason } = reviewCandidates(task, requireAvailable)
  return { eligible: candidates.length > 0, reason, count: candidates.length }
}

/**
 * Does this task have at least one eligible peer capable of reviewing it during a batch?
 * A worker is viable for a batch if it is not an author, not already graded, grading-enabled,
 * enabled, capable, and its quota is not permanently over WINDOW_HIGH_WATER (unless actively reviewing).
 */
export function hasBatchReviewer(task: Task): boolean {
  const { authors } = authorshipOf(task.id)
  const authorAdapters = new Set(authors.map((a) => a.adapterId))
  const gradedAdapters = gradedAdaptersOf(task.id)

  for (const worker of listWorkers()) {
    if (worker.retiredAt || !worker.enabled || worker.gradingEnabled === false) continue
    if (authorAdapters.has(worker.adapterId) || gradedAdapters.has(worker.adapterId)) continue
    const info = adapter(worker.adapterId).info
    if (!info.capabilities.readOnlyPermissionMode || !info.capabilities.transports.includes('stream')) continue
    if (accountUnavailability(worker)) continue
    const win = window5h(worker.id)
    if (win && win.percent >= WINDOW_HIGH_WATER) {
      const isBusy = claimedReviewers.has(worker.id) || sessionsForWorker(worker.id).some((s) => s.purpose === 'review')
      if (!isBusy) continue
    }
    return true
  }
  return false
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
  const range = await resolveRange(
    task,
    project,
    landingTargetFor(task, project),
    policyFor(project).landingTarget
  )
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

  // ⛔ **The reviewer is chosen and claimed before the first `await`, not after it.** Resolving the
  // range walks git, so picking on the far side of it would leave a window in which a second caller
  // — a batch grading two tasks at once — reads the same account as free and picks it too. Nothing
  // above this line yields, so a caller that has started this call has already taken its account by
  // the time the promise is handed back, and the ordering is what makes that true rather than a
  // comment saying it is. ⚠️ The cost is that a task with both no peer and no resolvable range now
  // reports the peer; both sentences are true and `reviewEligibility` reports the range first.
  const choice = pickReviewer(task, workerId)
  if (!choice.worker) return { ok: false, reason: choice.reason }
  const worker = choice.worker
  claimedReviewers.add(worker.id)
  try {
    const range = await resolveRange(
      task,
      project,
      landingTargetFor(task, project),
      policyFor(project).landingTarget
    )
    if (!range.ok) return { ok: false, reason: range.reason }
    return await runReview(taskId, task, project, range, worker)
  } finally {
    claimedReviewers.delete(worker.id)
  }
}

/** The body of one review, on an account that has already been chosen and claimed. */
async function runReview(
  taskId: string,
  task: Task,
  project: Project,
  range: Extract<RangeResolution, { ok: true }>,
  worker: Worker
): Promise<{ ok: true; review: QualityReview } | { ok: false; reason: string }> {
  const { authors, subjectAdapter, subjectModel, mixed } = authorshipOf(taskId)
  if (!subjectAdapter) {
    return { ok: false, reason: 'nothing has run on this task yet, so there is no work to grade' }
  }

  // ⚠️ `range.commits` when the ladder answered from the recorded commits, which is the only thing
  // that keeps a task that landed twice from being graded on the work that landed between them.
  const diff = await collectDiff(range.cwd, range.base, range.head, range.commits)

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

    const controller = new AbortController()
    activeReviews.set(review.id, {
      sessionId: session.id,
      stop: () => {
        controller.abort()
        closeSession(session.id)
      }
    })
    const { text, reason: why } = await ask(session.id, prompt, controller.signal)
    activeReviews.delete(review.id)
    await closeAndWait(session.id)
    sessionId = null

    // `review.cancel` settles the row and run first, then wakes this wait. Never let its normal
    // failure path overwrite that operator decision.
    if (requireReview(review.id).status === 'cancelled') {
      return { ok: true, review: requireReview(review.id) }
    }

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
    const reason = errorMessage(err)
    log.warn(`quality review of t${task.seq} failed: ${reason}`)
    if (reviewId) activeReviews.delete(reviewId)
    if (sessionId) await closeAndWait(sessionId)
    if (runId) finishRun(runId, 'failed', reason)
    // ⛔ `refused` rather than `failed` when nothing was ever asked, so a later sweep can tell a
    // model that could not answer from a machine that could not ask.
    if (reviewId) return { ok: true, review: refuseReview(reviewId, reason) }
    return { ok: false, reason }
  }
}

/**
 * Stop exactly one pending grade. A review owns no task workspace, so this kills only its read-only
 * session and records a cancelled review/run; the task remains in its finished state.
 */
export function cancelReview(idOrTaskId: string): { ok: true; review: QualityReview } | { ok: false; reason: string } {
  let review: QualityReview | null = null
  try {
    review = requireReview(idOrTaskId)
  } catch {
    // Maybe idOrTaskId is a taskId
  }
  if (!review || review.status !== 'pending') {
    const pending = pendingReviews().find((r) => r.taskId === idOrTaskId || r.id === idOrTaskId)
    if (pending) review = pending
  }
  if (!review) return { ok: false, reason: 'no such quality review' }
  if (review.status !== 'pending') return { ok: false, reason: 'this quality review is no longer grading' }
  const active = activeReviews.get(review.id)
  if (active) active.stop()
  const cancelled = settleCancelledReview(review.id)
  finishRun(cancelled.runId, 'cancelled', cancelled.failureReason ?? undefined)
  return { ok: true, review: cancelled }
}

/**
 * Settle every grade the previous process left in flight.
 *
 * ⛔ **A pending review cannot survive a restart, and until 2026-09-04 nothing said so.** The wait
 * that owns a review lives in this process's memory — the stream listeners, the silence clock and
 * the `activeReviews` entry all die with it — so a row still `pending` at startup has nobody left
 * to finish it, and it is not grading: it is a sentence in the UI with no process behind it.
 * Measured on t217: a review opened at 18:16, its session gone by 18:17, and the row still reading
 * *grading…* twenty minutes and one daemon restart later, on a **completed** task that
 * `reconcileTasks` does not look at — that sweep only walks `running`/`assigned`/`cancelling`,
 * which is every task a review is never run on.
 *
 * ⚠️ `failed`, not `cancelled`: a restart is not a person deciding to stop, and `cancelled` is
 * reserved for the one that is. The run is closed the way every other interrupted run is
 * (`terminated`), so the ledger reads the same for both halves of the same event.
 */
export function reconcileReviews(): number {
  const stranded = pendingReviews()
  for (const review of stranded) {
    const why = 'orchestratord restarted while this was grading'
    completeReview(review.id, { ok: false, reason: why })
    finishRun(review.runId, 'terminated', why)
  }
  if (stranded.length) log.warn(`settled ${stranded.length} quality review(s) interrupted by a restart`)
  return stranded.length
}

/** What a waiting review has seen so far. ⛔ Timestamps only — nothing here reads the adapter. */
export interface ReviewProgress {
  /** When the prompt was sent. The settling delay before it is not the reviewer's time. */
  askedAt: number
  /**
   * When output last arrived, or null when nothing has arrived at all.
   *
   * ⚠️ A stamp **at or before `askedAt` counts as nothing**: a session's own startup record is not
   * the model answering a question it had not yet been given. See `reviewStall`.
   */
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
  // ⛔ **Nothing that arrived before the question was asked is an answer to it.** Measured on t217
  // (2026-09-04, 18:50:20→18:55:26): the local bridge emits `{"type":"init"}` the moment it starts,
  // which is 2.5s *before* the prompt goes down the pipe. That one record was counted as the
  // reviewer talking, so the 15-minute window for a slow model to read an 8.3k-token prompt was
  // skipped and the 5-minute silence rule decided the review instead — reproducing the exact
  // 5-minute death this clock was written to end, and reporting it as *"went quiet for 5m05s after
  // 0 characters"*. Both halves are fixed: `ask` ignores `init`, and a stamp older than the
  // question is treated here as no answer at all.
  const spoke = progress.lastOutputAt !== null && progress.lastOutputAt > progress.askedAt
  if (!spoke) {
    if (elapsed < REVIEW_FIRST_OUTPUT_MS) return null
    return `the reviewer produced nothing at all in ${mins(elapsed)}`
  }
  const silent = now - (progress.lastOutputAt ?? progress.askedAt)
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
function ask(sessionId: string, prompt: string, signal: AbortSignal): Promise<{ text: string | null; reason: string }> {
  return new Promise((resolve) => {
    let text = ''
    let done = false
    let send: ReturnType<typeof setTimeout> | null = null
    const progress: ReviewProgress = { askedAt: Date.now(), lastOutputAt: null, chars: 0 }
    const finish = (value: string | null, reason: string) => {
      if (done) return
      done = true
      offStream()
      offEnd()
      clearInterval(watch)
      if (send) clearTimeout(send)
      resolve({ text: value, reason })
    }
    const offStream = onSessionStream(sessionId, (event) => {
      // ⚠️ Any traffic counts as alive, not only the text kept: a reviewer reading a file is
      // working, and holding it to the same silence window as one that has crashed is the bug
      // this whole clock exists to avoid.
      //
      // ⛔ **Except the session's own hello.** `init` says a process started, which is a fact about
      // the machine and not a word from the model — and on the local bridge it arrives before the
      // prompt is even sent (`local-llm-bridge.ts`, `emit({ type: 'init' … })`). Counting it turned
      // the first-output window into a 5-minute one and killed t217 twice.
      if (event.kind !== 'init') progress.lastOutputAt = Date.now()
      if (event.kind === 'assistant_text') {
        text += event.text
        progress.chars += event.text.length
      }
      if (event.kind === 'result') finish(event.text ?? text ?? null, 'the turn ended')
    })
    const offEnd = onSessionEnd(sessionId, () =>
      finish(text || null, 'the reviewer’s session ended before it answered')
    )
    signal.addEventListener('abort', () => finish(null, 'cancelled by a person'), { once: true })
    const watch = setInterval(() => {
      const stall = reviewStall(progress, Date.now())
      if (stall) finish(null, stall)
    }, REVIEW_WATCH_MS)
    send = setTimeout(() => {
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
