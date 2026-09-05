import { emit } from './events.js'

/**
 * The peephole: what the agent working on a task is saying, while it says it.
 *
 * ⛔ **Not the task thread, and not the transcript.** The thread is the record a person reads
 * afterwards to find out what was decided, and writing every fragment of a running agent's prose
 * into it would bury that under a play-by-play. The transcript is the machine's exact copy and stays
 * the machine's. This is the third thing, and it is the one that was missing: a bounded tail, held in
 * memory, for the question "what is it doing *right now*".
 *
 * ⚠️ Held in memory on purpose, not out of laziness. Its correct lifetime is the run: a daemon
 * restart already returns every running task to `awaiting_human` (`reconcileTasks`), so a tail that survived
 * the restart would be describing work that no longer exists.
 *
 * ⛔ The text is **agent output** and therefore untrusted. It is carried as text, rendered as text,
 * and never interpreted - nothing here or downstream may read state out of it. AGENTS.md: the TUI is
 * for humans, the transcript is for the machine, and this is a window onto the first.
 */

/** Enough to see what is going on, few enough that a long run cannot grow without bound. */
const KEEP = 40

/** One fragment is trimmed to this. An agent can emit a whole file in a single block. */
const MAX_LINE = 400

const tails = new Map<string, Array<{ text: string; ts: number }>>()
const runTails = new Map<string, Array<{ text: string; ts: number }>>()
const RUN_KEEP = 200

export function noteActivity(taskId: string, text: string, runId?: string): void {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return
  const entry = {
    text: trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE)}…` : trimmed,
    ts: Date.now()
  }
  const tail = tails.get(taskId) ?? []
  tail.push(entry)
  while (tail.length > KEEP) tail.shift()
  tails.set(taskId, tail)
  emit({ type: 'task.activity', taskId, text: entry.text, ts: entry.ts })

  if (runId) {
    const runTail = runTails.get(runId) ?? []
    runTail.push(entry)
    while (runTail.length > RUN_KEEP) runTail.shift()
    runTails.set(runId, runTail)
  }
}

export function activityFor(taskId: string): Array<{ text: string; ts: number }> {
  return tails.get(taskId) ?? []
}

export function runActivityFor(runId: string): Array<{ text: string; ts: number }> {
  return runTails.get(runId) ?? []
}

/**
 * Take accumulated intermediate activity for a run and release the memory.
 * Called when a run is finished and about to be persisted into SQLite.
 */
export function consumeRunActivity(runId: string): Array<{ text: string; ts: number }> {
  const got = runTails.get(runId) ?? []
  runTails.delete(runId)
  return got
}

export function clearRunActivity(runId: string): void {
  runTails.delete(runId)
}

/**
 * Forget a task's tail.
 *
 * ⚠️ Called when a *new* attempt starts, never when one ends. What the last run said is exactly what
 * somebody wants to read in the seconds after it fails, and clearing on completion would blank the
 * pane at the moment it became interesting.
 */
export function clearActivity(taskId: string): void {
  tails.delete(taskId)
  // ⛔ Announced, not merely done. Whoever is watching this task holds their own copy of the tail —
  // they have to, because the list refreshes on every task event and a pane that rebuilt itself from
  // each fetch would flicker. So clearing it here and saying nothing left the **previous run's last
  // words** sitting under a task that had just been dispatched somewhere else, which reads as the new
  // run having failed the way the old one did.
  emit({ type: 'task.activity', taskId, text: '', ts: Date.now(), reset: true })
}
