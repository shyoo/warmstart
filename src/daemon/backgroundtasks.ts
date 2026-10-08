/**
 * What each live session still has running in the background, and the conversations kept open for it
 * (t987 ← t962).
 *
 * ⛔ **A turn that ended is not a task that is waiting on a person.** t962's agent said *"the
 * evaluation runs are going in the background, I'll pick up the results when they finish"* and ended
 * its turn. The task came to rest at `awaiting_human` — *your turn* — and about a minute later the CLI
 * woke the session with the first job's result and the task read *the agent picked this up again by
 * itself*, with three more jobs still running. Both were true and neither was useful: the person was
 * never the one being waited on. The vendor says so itself: `StreamEvent.background_tasks`, measured
 * 2026-10-07 on claude 2.1.294, is the CLI's own complete list of what is still running, and it is
 * written before the turn's `result`.
 *
 * ⛔ **In memory, for `idlestate.ts`'s reason.** Both facts describe a live process and die with it; a
 * restart returns a running task to a person anyway.
 *
 * ⚠️ Leaf module: `scheduler.ts` and `turnend.ts` both read it and neither may be imported here.
 */

export interface BackgroundTask {
  id: string
  description: string | null
}

const open = new Map<string, { tasks: BackgroundTask[]; emptiedAt: number | null }>()

/** The conversation runs left open for these sessions, by session id → run id. */
const held = new Map<string, string>()

/**
 * How long a held conversation waits, once its last background job is gone, for the CLI to wake it.
 *
 * ⚠️ Not measured against a distribution. The one wake observed (2026-10-07, a 12 s `sleep`) began a
 * new turn within the 8 s the spike allowed after the job ended. Three minutes is the patience
 * `IDLE_TURN_AFTER_MS` already gives a finished turn, and the cost of being wrong is the old
 * behaviour: the task rests at *your turn* a little late.
 */
export const BACKGROUND_WAKE_GRACE_MS = 3 * 60 * 1000

/** Replace what this session has running. Returns whether anything was running before. */
export function noteBackgroundTasks(sessionId: string, tasks: BackgroundTask[], now = Date.now()): boolean {
  const before = (open.get(sessionId)?.tasks.length ?? 0) > 0
  if (tasks.length === 0 && !before) return false
  open.set(sessionId, { tasks, emptiedAt: tasks.length === 0 ? now : null })
  return before
}

export function backgroundTasksOf(sessionId: string): BackgroundTask[] {
  return open.get(sessionId)?.tasks ?? []
}

/** When the last background job ended, if none is running now and one was. */
export function backgroundEmptiedAt(sessionId: string): number | null {
  return open.get(sessionId)?.emptiedAt ?? null
}

export function holdRunOnBackground(sessionId: string, runId: string): void {
  held.set(sessionId, runId)
}

/** The run this session's conversation was kept open for, if it was. */
export function heldRunOf(sessionId: string): string | null {
  return held.get(sessionId) ?? null
}

export function releaseBackgroundHold(sessionId: string): void {
  held.delete(sessionId)
}

/** A session that is gone has neither jobs nor a held run. */
export function forgetBackground(sessionId: string): void {
  open.delete(sessionId)
  held.delete(sessionId)
}

/**
 * Should a conversation whose turn just ended stay with its agent rather than rest at *your turn*?
 *
 * ⛔ Only where nothing else has a claim on the turn's end. Delegated pieces rest the task `blocked`
 * on them; a quota preemption's wrap-up is the *reason* the turn ended; a Commit press owes a landing
 * the moment the turn is over, and an agent asked to finish owes a decision. Each of those wins, and
 * the background jobs are left running for whoever answers next, exactly as before.
 */
export function shouldHoldOnBackground(input: {
  backgroundOpen: number
  status: string
  pendingPieces: number
  quotaPreempted: boolean
  landOwed: boolean
  finishAsked: boolean
}): boolean {
  if (input.backgroundOpen === 0) return false
  if (input.status !== 'running' && input.status !== 'assigned') return false
  return input.pendingPieces === 0 && !input.quotaPreempted && !input.landOwed && !input.finishAsked
}

/**
 * Has a held conversation waited long enough for a wake that is not coming?
 *
 * ⚠️ Both clocks: the list emptying says the job is over, and a session that has started talking again
 * since is being woken, not abandoned — `lastEvidenceAt` is the newest mid-turn record, which the
 * terminal pair and this very list do not write (`NO_REQUEST_EVIDENCE`). While jobs are still running
 * there is nothing to release: the stall watchdog is what bounds that wait.
 */
export function holdReleaseDue(input: {
  backgroundOpen: number
  emptiedAt: number | null
  lastEvidenceAt: number | null
  now: number
}): boolean {
  if (input.backgroundOpen > 0 || input.emptiedAt === null) return false
  return input.now - Math.max(input.emptiedAt, input.lastEvidenceAt ?? 0) >= BACKGROUND_WAKE_GRACE_MS
}

/** The jobs as one sentence for a thread line. */
export function describeBackground(tasks: BackgroundTask[]): string {
  const named = tasks.map((t) => t.description?.trim()).filter((d): d is string => !!d)
  const count = `${tasks.length} background job${tasks.length === 1 ? '' : 's'}`
  if (named.length === 0) return count
  const shown = named.slice(0, 3).map((d) => `“${d.length > 80 ? `${d.slice(0, 79)}…` : d}”`)
  return `${count} (${shown.join(', ')}${named.length > 3 ? `, and ${named.length - 3} more` : ''})`
}
