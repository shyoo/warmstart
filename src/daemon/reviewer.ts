import type { QualityReview } from '@shared/review.js'
import type { Worker } from '@shared/protocol.js'
import type { Task } from '@shared/tasks.js'
import { WINDOW_HIGH_WATER } from '@shared/tasks.js'
import { adapter } from './adapters/index.js'
import { accountUnavailability } from './eligibility.js'
import { extractJson } from './controller.js'
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
import { listWorkers } from './workers.js'
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

/** A review is a single read-only pass. Longer than a consult, because it reads a diff. */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000

/** The same settling delay a consult uses: a freshly spawned CLI swallows what arrives too early. */
const PROMPT_DELAY_MS = 2500

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
export const REVIEW_MODELS: Record<string, string> = {
  'claude-code': 'claude-haiku-4-5',
  'antigravity-cli': 'gemini-3.7-flash-medium',
  'openai-compatible': 'gpt-5.4-mini'
}

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
}

/** The 5h window this fleet gates on, or null when nothing fresh enough to trust says. */
function window5h(workerId: string): { percent: number } | null {
  const quota = lastQuota(workerId)
  if (!quota || quota.stale) return null
  return quota.windows.find((w) => w.id === 'session' || w.id === '5h') ?? null
}

/**
 * Pick the agent that will grade this task, or say precisely why none can.
 *
 * The gates, in order: not an author · the shared account list · the same quota water mark work
 * goes through · a declared read-only mode · not already reviewing.
 */
function reviewCandidates(task: Task): { candidates: Worker[]; reason: string } {
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
    const blocked = accountUnavailability(worker)
    if (blocked) {
      rejected.push(blocked)
      continue
    }
    const info = adapter(worker.adapterId).info
    if (!info.capabilities.readOnlyPermissionMode) {
      rejected.push(`${worker.label} has no read-only mode, so it may not read the trunk`)
      continue
    }
    if (!info.capabilities.transports.includes('stream')) {
      rejected.push(`${worker.label} cannot run a non-interactive session`)
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
  const eligible = reviewCandidates(task)
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
    model: REVIEW_MODELS[chosen.adapterId] ?? null
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

  const eligible = reviewCandidates(task)
  if (eligible.candidates.length === 0) return { ok: false, reviewers: [], reason: eligible.reason }
  return {
    ok: true,
    reviewers: eligible.candidates.map((worker) => ({
      workerId: worker.id,
      label: worker.label,
      model: REVIEW_MODELS[worker.adapterId] ?? null
    })),
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

  const model = REVIEW_MODELS[worker.adapterId] ?? undefined
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

    const text = await ask(session.id, prompt)
    closeSession(session.id)
    sessionId = null

    if (text === null) {
      finishRun(run.id, 'failed', 'the reviewer did not answer in time')
      return { ok: true, review: completeReview(review.id, { ok: false, reason: 'the reviewer did not answer in time' }) }
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

/** Send the prompt and wait for the turn to end. Resolves to null on timeout or a dead session. */
function ask(sessionId: string, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let text = ''
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      offStream()
      offEnd()
      clearTimeout(timer)
      resolve(value)
    }
    const offStream = onSessionStream(sessionId, (event) => {
      if (event.kind === 'assistant_text') text += event.text
      if (event.kind === 'result') finish(event.text ?? text ?? null)
    })
    const offEnd = onSessionEnd(sessionId, () => finish(text || null))
    const timer = setTimeout(() => finish(null), REVIEW_TIMEOUT_MS)
    setTimeout(() => {
      try {
        sendPrompt(sessionId, prompt)
      } catch (err) {
        log.warn('could not send a review prompt:', err)
        finish(null)
      }
    }, PROMPT_DELAY_MS)
  })
}

export { requireReview }
