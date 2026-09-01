import { db, rows } from './db.js'

/**
 * How long an agent was actually working on something.
 *
 * ⛔ **Not wall-clock, and that is the whole point.** The task ledger used to answer "how long did
 * this take" with `lastRunEnded - firstRun`, which is the span a task *existed inside* rather than
 * the time anything was spent on it. Those two numbers diverge without limit: a task dispatched at
 * 09:00, blocked on a question at 09:04 and answered at 17:00 reports eight hours, of which the
 * agent worked four minutes. Every per-task, per-agent and per-model duration derived from that
 * number is describing the operator's lunch break.
 *
 * Active time is the union of the intervals in which a run was open **and nothing was waiting on a
 * person**. Concretely it excludes:
 *
 *  - everything between runs — `queued`, `ready`, `awaiting_human`, `paused_quota`, a hold on a busy
 *    workspace pool. A task is not being worked on while it waits for a slot;
 *  - time *inside* a run spent blocked on an open question or an escalated approval. ⚠️ This is the
 *    half that a naive `sum(ended_at - started_at)` misses, and it is not small: `ask_human` holds
 *    the calling tool open until somebody answers or the prompt cache expires, so a single question
 *    can be most of a run's wall-clock.
 *
 * It deliberately *includes* dispatch, routing, spawn, workspace preparation and the CLI's own
 * start-up, because `startRun` is written at dispatch — all of that is time the fleet spent on this
 * task and is exactly what a cost model wants to see.
 *
 * ⚠️ What it cannot see is time the agent spent blocked on something that never became a row: a
 * vendor-side rate limit inside a turn, a `run_command` waiting on a network, a controller consult.
 * Those read as active, which is the honest answer — the fleet *was* holding the session open.
 */

/** A run's span. `endedAt` null means the attempt is still open. */
export interface RunSpan {
  id: string
  startedAt: number
  endedAt: number | null
}

/** A stretch in which a person was being waited on. `to` null means nobody has answered yet. */
export interface WaitInterval {
  from: number
  to: number | null
}

/**
 * The same thing after clamping: both ends known.
 *
 * ⛔ A separate type rather than a `WaitInterval` with a promise attached. `to: number | null` on
 * the way in is a real state — nobody has answered — and carrying that nullability through the
 * arithmetic means every subtraction needs an assertion, which is how a null reaches a `-` and
 * silently becomes `NaN`.
 */
export interface Stretch {
  from: number
  to: number
}

export interface ActiveTiming {
  /**
   * Active time that is settled and will not change.
   *
   * ⛔ Not the whole answer while something is running. The reader adds the live stretch — see
   * `activeSince` — rather than this being recomputed and pushed every second.
   */
  activeMs: number
  /**
   * When the currently-ticking stretch of active time began, or null if nothing is ticking.
   *
   * The displayed total is `activeMs + (activeSince ? now - activeSince : 0)`. Null covers three
   * states that all mean *the number has stopped moving*: no run is open, the task is finished, or
   * a run is open but blocked on a person right now.
   *
   * ⛔ Not `firstRunAt` and not the open run's `startedAt`: it is the run's start pushed forward by
   * every blocked stretch already served, so a task that has been waiting on two questions ticks
   * from where it left off rather than re-counting them.
   */
  activeSince: number | null
  /** How long, in total, a person was being waited on inside a run. Settled stretches only. */
  blockedMs: number
}

export const ZERO_TIMING: ActiveTiming = { activeMs: 0, activeSince: null, blockedMs: 0 }

/**
 * Overlapping waits, merged, clamped to a window, and summed.
 *
 * ⛔ Merged rather than added up. Two rows covering the same seconds are one blocked second, and a
 * sum would subtract it twice — which can drive active time negative, and a negative duration in a
 * cost model is worse than a wrong one because it is silently discarded downstream rather than
 * noticed.
 *
 * ⚠️ In practice a session has one outstanding tool call at a time, so overlap should not occur.
 * "Should not" is why this merges anyway: `AskUserQuestion` was until recently routed through both
 * the approval path and the question path, and the shape of that bug is exactly a double count.
 */
export function mergeWaits(waits: WaitInterval[], from: number, to: number): Stretch[] {
  const clamped = waits
    .map((w) => ({ from: Math.max(w.from, from), to: Math.min(w.to ?? to, to) }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from)

  const merged: Stretch[] = []
  for (const w of clamped) {
    const last = merged[merged.length - 1]
    if (last && w.from <= last.to) {
      last.to = Math.max(last.to, w.to)
    } else {
      merged.push({ from: w.from, to: w.to })
    }
  }
  return merged
}

/**
 * The active time of a set of runs, given what was waiting on a person during them.
 *
 * ⛔ Pure, and takes `now` rather than reading the clock, because the interesting cases are all
 * about an open run and a test that cannot pin the present cannot pin those.
 */
export function timingFor(
  runs: RunSpan[],
  waitsByRun: Map<string, WaitInterval[]>,
  now: number
): ActiveTiming {
  let activeMs = 0
  let blockedMs = 0
  let activeSince: number | null = null

  // ⚠️ Oldest first, so the open run — if there is one — is the last thing considered and the one
  // that owns `activeSince`. A task holds one run at a time; ordering makes that assumption visible
  // instead of load-bearing.
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const end = run.endedAt ?? now
    if (end <= run.startedAt) continue

    const raw = waitsByRun.get(run.id) ?? []
    const merged = mergeWaits(raw, run.startedAt, end)
    const served = merged.reduce((sum, w) => sum + (w.to - w.from), 0)
    blockedMs += served

    if (run.endedAt !== null) {
      activeMs += end - run.startedAt - served
      continue
    }

    // An open run. Is a person being waited on *right now*? Only an unanswered wait that had already
    // started can be — and if one has, the last merged stretch is by construction the one running up
    // to `now`, which is what makes this readable without re-deriving the clamping.
    const blockedNow = raw.some((w) => w.to === null && w.from <= now)
    const current = merged[merged.length - 1]
    if (blockedNow && current) {
      // ⛔ Frozen, not ticking. Everything up to the moment the question was asked is settled and the
      // total must stop moving — a "took" that keeps climbing while the agent sits waiting for an
      // answer is the exact reading this whole file exists to stop reporting.
      const priorBlocked = served - (current.to - current.from)
      activeMs += Math.max(0, current.from - run.startedAt - priorBlocked)
      continue
    }
    // Where the clock resumes from: the run's start, pushed past every stretch already served.
    const since = run.startedAt + served
    if (activeSince === null) {
      activeSince = since
    } else {
      // ⚠️ Two open runs on one task is not a state the scheduler produces. If it ever does, the
      // total is still right at `now` — it simply ticks once rather than twice.
      activeMs += Math.max(0, now - since)
    }
  }

  return { activeMs, activeSince, blockedMs }
}

// ---------------------------------------------------------------------------- from the database

interface WaitRow {
  run_id: string
  from_ts: number
  to_ts: number | null
}

/**
 * Every stretch, on these runs, in which a person was being waited on.
 *
 * ⛔ Two sources, because there are two ways an agent stops for a human and they are different
 * objects: a **question** (`ask_human`, `checkpoint`, the CLI's own `AskUserQuestion`) and an
 * **escalated approval** (a tool the project's rules would not settle). An approval the policy
 * answered has `answered_at = asked_at` and contributes nothing, which is why it needs no filter —
 * a rule that decided in the same millisecond blocked nobody.
 *
 * ⚠️ A parked question ends its stretch at `parked_at`, not at `answered_at`. Parking is what
 * happens when the session holding the question stops being worth keeping warm: from that moment
 * nothing is waiting, and an answer that arrives the next morning must not backdate eight hours of
 * "blocked" onto a run that had already ended.
 */
export function waitsForRuns(runIds: string[]): Map<string, WaitInterval[]> {
  const byRun = new Map<string, WaitInterval[]>()
  if (runIds.length === 0) return byRun

  // ⚠️ Chunked. SQLite caps bound parameters (999 on older builds), and a fleet's task list is
  // unbounded — this is the query that would start failing on the day the list got long.
  for (let i = 0; i < runIds.length; i += 400) {
    const chunk = runIds.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    const found = rows<WaitRow>(
      db()
        .prepare(
          `select run_id, asked_at as from_ts,
                  case
                    when answered_at is not null and parked_at is not null
                      then min(answered_at, parked_at)
                    else coalesce(answered_at, parked_at)
                  end as to_ts
             from questions
            where run_id in (${holes})
            union all
           select run_id, asked_at as from_ts, answered_at as to_ts
             from approvals
            where run_id in (${holes})`
        )
        .all(...chunk, ...chunk)
    )
    for (const r of found) {
      if (!r.run_id) continue
      const list = byRun.get(r.run_id) ?? []
      list.push({ from: r.from_ts, to: r.to_ts })
      byRun.set(r.run_id, list)
    }
  }
  return byRun
}

/**
 * Active timing for a set of tasks, in two queries regardless of how many there are.
 *
 * ⛔ Batched on purpose. `Task.firstRunAt` is a correlated subquery per row precisely so that a
 * table of tasks does not load every run of every task; doing this one per row would reintroduce
 * exactly that, N+1 times over, on the list that renders on every daemon event.
 */
export function timingForTasks(taskIds: string[], now = Date.now()): Map<string, ActiveTiming> {
  const out = new Map<string, ActiveTiming>()
  if (taskIds.length === 0) return out

  const spans = new Map<string, RunSpan[]>()
  const allRunIds: string[] = []
  for (let i = 0; i < taskIds.length; i += 400) {
    const chunk = taskIds.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    const found = rows<{ id: string; task_id: string; started_at: number; ended_at: number | null }>(
      db()
        .prepare(
          `select id, task_id, started_at, ended_at from runs where task_id in (${holes})`
        )
        .all(...chunk)
    )
    for (const r of found) {
      const list = spans.get(r.task_id) ?? []
      list.push({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at })
      spans.set(r.task_id, list)
      allRunIds.push(r.id)
    }
  }

  const waits = waitsForRuns(allRunIds)
  for (const id of taskIds) {
    out.set(id, timingFor(spans.get(id) ?? [], waits, now))
  }
  return out
}

/** The same answer for one run, which is what a run row in the task thread shows. */
export function timingForRuns(runs: RunSpan[], now = Date.now()): Map<string, ActiveTiming> {
  const waits = waitsForRuns(runs.map((r) => r.id))
  const out = new Map<string, ActiveTiming>()
  for (const run of runs) out.set(run.id, timingFor([run], waits, now))
  return out
}
