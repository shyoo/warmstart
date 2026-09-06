import { randomUUID } from 'node:crypto'
import type { BatchEntry, GradeBatch } from '@shared/quality.js'
import { batchCandidates } from './quality.js'
import { requestReview, reviewerAvailability } from './reviewer.js'
import { getTask } from './tasks.js'
import { log } from './log.js'

/**
 * Grading many tasks at once, in the background.
 *
 * ⛔ **The RPC starts a batch; it does not run one.** `gradeUngraded` graded five tasks inside the
 * call and answered when the last one finished, which is a shape that works only because five was a
 * hard cap: at the ~4 minutes a review actually takes on this fleet, ALL over fifty tasks is a
 * request that would sit open for hours and be lost the moment the window reloaded. So the call
 * returns as soon as the queue exists, and the page reads progress back.
 *
 * ⛔ **Nothing here grades anything a person did not ask for.** There is no tick, no sweep and no
 * scheduler entry: the only way into this file is somebody pressing Batch. A background grader that
 * started itself would spend real turns on real accounts while nobody was watching, and this feature
 * is an instrument, not a service.
 *
 * ⚠️ **One review in flight per account, and the fleet decides how many that is.** The cap is not a
 * number written here — it is `reviewCandidates`, which refuses an account that is already reviewing
 * or already claimed, so a two-account fleet runs two and a one-account fleet runs one. Writing a
 * concurrency number instead would be this file guessing at a fact `reviewer.ts` already knows.
 */

/** ⛔ One at a time. A second batch would double-queue the same tasks and race for the same peers. */
let current: GradeBatch | null = null
let cancelled = false

/** The derived counters, computed on read so the entries stay the single source of truth. */
function tally(batch: GradeBatch): GradeBatch {
  return {
    ...batch,
    entries: batch.entries.map((e) => ({ ...e })),
    graded: batch.entries.filter((e) => e.state === 'graded').length,
    skipped: batch.entries.filter((e) => e.state === 'skipped').length,
    grading: batch.entries.filter((e) => e.state === 'grading').length,
    queued: batch.entries.filter((e) => e.state === 'queued').length
  }
}

/** The batch on screen, or null when none has been asked for since this process started. */
export function currentBatch(): GradeBatch | null {
  return current ? tally(current) : null
}

export function batchRunning(): boolean {
  return current !== null && current.state === 'running'
}

/**
 * Start a batch.
 *
 * `count` is how many tasks will be **attempted**, or null for every one that matches. `threshold`
 * is a strict `quality_review_count < threshold`, so 1 means "has no grade at all".
 */
export async function startBatch(
  count: number | null,
  threshold: number
): Promise<{ ok: true; batch: GradeBatch } | { ok: false; reason: string }> {
  if (batchRunning()) {
    return { ok: false, reason: 'a batch is already running — wait for it or stop it first' }
  }
  const candidates = await batchCandidates(threshold, count)
  if (candidates.length === 0) {
    return { ok: false, reason: 'no finished task matches that filter, so there is nothing to grade' }
  }
  cancelled = false
  const batch: GradeBatch = {
    id: randomUUID(),
    startedAt: Date.now(),
    finishedAt: null,
    state: 'running',
    requested: count,
    threshold,
    entries: candidates.map((c) => ({
      taskId: c.taskId,
      seq: c.seq,
      title: c.title,
      state: 'queued' as const,
      composite: null,
      reviewer: null,
      reviewerModel: null,
      reason: ''
    })),
    graded: 0,
    skipped: 0,
    grading: 0,
    queued: candidates.length
  }
  current = batch
  log.info(`quality review batch: ${batch.entries.length} task(s) queued (fewer than ${threshold} grades)`)
  // ⚠️ Deliberately not awaited. The caller is an RPC and the driver outlives it; a rejection here
  // would otherwise be an unhandled one, so the driver catches everything itself.
  void drive(batch)
  return { ok: true, batch: tally(batch) }
}

/**
 * Stop a batch.
 *
 * ⛔ **Stops the queue, never a review that is already grading.** A review in flight is a real turn
 * on a real account that has already been spent; abandoning it would leave a `pending` row with
 * nobody to settle it, which is the exact fault `reconcileReviews` exists to clean up after. One
 * in-flight grade is stopped by name, through `review.cancel`, on the task itself.
 */
export function cancelBatch(): { ok: true; batch: GradeBatch } | { ok: false; reason: string } {
  if (!current || current.state !== 'running') return { ok: false, reason: 'no batch is running' }
  cancelled = true
  for (const entry of current.entries) {
    if (entry.state === 'queued') {
      entry.state = 'skipped'
      entry.reason = 'the batch was stopped before this task was reached'
    }
  }
  return { ok: true, batch: tally(current) }
}

/**
 * The driver.
 *
 * Each pass walks the queue and starts everything that can start right now, then waits for the first
 * review to finish before walking it again — so an account that frees up is used by the next task in
 * line rather than at the end of a fixed round.
 *
 * ⛔ **A task that cannot start is not the same as a task that cannot be graded**, and the two are
 * answered by different questions. The durable gates (`requireAvailable: false`) settle *no peer can
 * ever grade this* and skip the row for good. The transient ones settle *not this instant* — an
 * account at its quota water mark, or one busy on another row of this very batch — and those wait.
 * Collapsing them would have every batch on a single-account fleet report every task after the first
 * as ungradeable.
 */
async function drive(batch: GradeBatch): Promise<void> {
  const inflight = new Set<Promise<void>>()
  try {
    for (;;) {
      if (cancelled) break
      for (const entry of batch.entries) {
        if (entry.state !== 'queued') continue
        const task = getTask(entry.taskId)
        if (!task) {
          entry.state = 'skipped'
          entry.reason = 'this task is no longer readable'
          continue
        }
        const durable = reviewerAvailability(task)
        if (!durable.eligible) {
          entry.state = 'skipped'
          entry.reason = durable.reason
          continue
        }
        const now = reviewerAvailability(task, true)
        if (!now.eligible) {
          // ⚠️ Kept on the row while it waits, so *waiting for Claude Code, already reviewing* is
          // visible rather than looking like a queue that has stopped for no reason.
          entry.reason = now.reason
          continue
        }
        entry.state = 'grading'
        entry.reason = ''
        // ⛔ Not awaited here. `requestReview` claims its account before its first `await`, so by
        // the time this returns the account is taken and the next entry in this same pass will see
        // it as busy — which is what lets one pass start one review per free account safely.
        const running = grade(entry).finally(() => inflight.delete(running))
        inflight.add(running)
      }
      if (inflight.size === 0) {
        const remainingQueued = batch.entries.filter((e) => e.state === 'queued')
        if (remainingQueued.length === 0) break
        // If there are still queued entries, wait briefly (500ms) for any just-exited sessions
        // to settle and re-check if any peer became available before giving up.
        await new Promise((resolve) => setTimeout(resolve, 500))
        let anyCanStart = false
        for (const entry of remainingQueued) {
          const task = getTask(entry.taskId)
          if (!task) continue
          const now = reviewerAvailability(task, true)
          if (now.eligible) {
            anyCanStart = true
            break
          }
        }
        if (!anyCanStart) break
        continue
      }
      await Promise.race(inflight)
    }
    await Promise.allSettled([...inflight])
  } catch (err) {
    log.warn('quality review batch failed:', err)
  } finally {
    for (const entry of batch.entries) {
      if (entry.state === 'queued' || entry.state === 'grading') {
        entry.state = 'skipped'
        // ⚠️ The transient reason the last pass recorded, not a fresh generic one: "Claude Code is
        // at 94% of its 5h window" is a fleet fact somebody can act on, and *skipped* is not.
        entry.reason = entry.reason || 'no account was free to grade this before the batch ended'
      }
    }
    batch.state = cancelled ? 'cancelled' : 'done'
    batch.finishedAt = Date.now()
    const done = tally(batch)
    log.info(`quality review batch ${batch.state}: ${done.graded} graded, ${done.skipped} skipped`)
  }
}

/** One task, start to finish. ⛔ Never throws: a driver that died would strand the whole queue. */
async function grade(entry: BatchEntry): Promise<void> {
  try {
    // ⛔ `requestReview` must be the first async operation here. It chooses and claims an account
    // synchronously before resolving the git range. The former preflight awaited the same range
    // first, so one queue pass marked every row `grading` before any account was claimed; all but
    // the fleet-width first wave then lost the race and were skipped as "already reviewing".
    // `requestReview` still resolves the range before it spawns, so an unreviewable task costs no
    // process or turn.
    const outcome = await requestReview(entry.taskId)
    if (!outcome.ok) {
      entry.state = 'skipped'
      entry.reason = outcome.reason
      return
    }
    const review = outcome.review
    // ⛔ `status`, not the presence of the row. A review that was asked for and came back
    // unparseable is stored, is a real fact about that model, and is not a grade.
    const scored = review.status === 'complete' && review.composite !== null
    entry.state = scored ? 'graded' : 'skipped'
    entry.composite = review.composite
    entry.reviewer = review.reviewerAdapter
    entry.reviewerModel = review.reviewerModel
    entry.reason = scored
      ? (review.summary ?? '')
      : (review.failureReason ?? `the review ended ${review.status}`)
    log.info(
      `batch graded t${entry.seq}: ${review.composite ?? 'no score'} (${review.status}) by ${review.reviewerAdapter}/${review.reviewerModel ?? 'unrecorded model'}`
    )
  } catch (err) {
    entry.state = 'skipped'
    entry.reason = err instanceof Error ? err.message : String(err)
  }
}
