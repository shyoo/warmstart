import { db, rows } from './db.js'
import { medianFloat } from './stats.js'
import { timingForTasks } from './activetime.js'

/**
 * How long a finished task actually took **on a named agent and model** — the velocity axis's
 * measured half.
 *
 * ⛔ **Active time, never wall-clock.** `activetime.ts` states the whole argument: a task dispatched
 * at 09:00, blocked on a question at 09:04 and answered at 17:00 took four minutes of agent work and
 * eight hours of the operator's day, and only one of those two numbers says anything about the
 * agent. Every duration here comes out of `timingForTasks`, which is the one place that subtraction
 * is done.
 *
 * ⛔ **Two factors, exactly as `estimator.ts` learned to price.** One median duration across the
 * whole fleet is a central tendency of nothing when one agent draws the small tasks and another the
 * large ones; the honest quantity is a *ratio* — this key against the fleet's own centre — shrunk
 * towards 1 by how few samples it rests on. The arithmetic is deliberately the same shape as the
 * cost factors so the two can be read side by side and mean the same thing.
 *
 * ⚠️ **This measures the agent and the task together and cannot separate them.** Nothing in the data
 * says whether `antigravity-cli` is slow or simply gets the long tasks: zero tasks on this install
 * have ever been completed twice on different keys. That is what shrinkage is for, that is why the
 * scoring term built on it is small, and that is why `basis` is published beside every number rather
 * than the factor being shown on its own.
 */

/** How many finished tasks the factors are learned from. Ordered newest first. */
const SAMPLE_LIMIT = 200

/**
 * How fast a key earns the right to its apparent ratio: `ratio^(n/(n+K))`.
 *
 * ⚠️ Lower than the estimator's 5 because a duration is a far less skewed quantity than a token
 * total — a runaway run can be 80× the median spend and is rarely 80× the median duration — so a
 * handful of samples says more here than it does there.
 */
const SHRINK_K = 4

/** Wide enough not to throw away a real difference, tight enough that arithmetic accidents cannot. */
const FACTOR_FLOOR = 0.1
const FACTOR_CEILING = 10

/**
 * A task shorter than this is not evidence about how fast an agent works.
 *
 * ⛔ A task completed in under a minute of active time is nearly always a task that was already done
 * — a resumed conversation answering a follow-up, a no-op landing — and a fleet with a dozen of them
 * would report the agent that happened to catch them as its fastest. Excluded rather than clamped,
 * because a clamp would still count them.
 */
const MIN_ACTIVE_MS = 60_000

export interface PaceKey {
  adapterId: string
  /** Null is the adapter-wide rung: that agent's tasks whose model was never recorded. */
  model: string | null
  samples: number
  /** The median finished task on this key, in active milliseconds. */
  medianActiveMs: number
  /** What the data says before shrinkage — published so the shrinkage is visible, not implied. */
  ratio: number
  /** What is actually applied. Above 1 is slower than the fleet's centre; below 1 is faster. */
  factor: number
}

export interface PaceFactors {
  keys: PaceKey[]
  /** The fleet's centre in the multiplicative sense: the geometric mean of its task durations. */
  neutralActiveMs: number
  /** How many finished tasks carried a usable duration and a credited key. */
  samples: number
}

interface CreditRow {
  task_id: string
  adapter_id: string | null
  model: string | null
  session_id: string | null
}

/**
 * Who a finished task's work is credited to.
 *
 * ⚠️ `sessionId` is carried for readers that need the *effort* the work ran at, which lives on the
 * session rather than on the run. Nothing in this file reads it — pace is keyed on (adapter, model)
 * and always has been — but a second reader deriving the credit rule for itself is how two surfaces
 * end up attributing the same task to two different agents.
 */
export interface Credit {
  adapterId: string
  model: string | null
  /** The session the crediting run belonged to, or null on a run that never had one. */
  sessionId: string | null
}

function keyId(adapterId: string, model: string | null): string {
  return `${adapterId}/${model ?? '?'}`
}

/**
 * The fleet's centre, in the space multipliers live in.
 *
 * ⛔ The geometric mean, not the median, and for the reason `estimator.ts` writes out in full: run
 * counts are wildly uneven, so a pooled median of a two-humped distribution lands inside whichever
 * hump has more tasks and every factor would then be measured against the busiest agent rather than
 * against the fleet.
 */
function centre(values: number[]): number {
  const usable = values.filter((v) => v > 0)
  if (usable.length === 0) return 0
  return Math.exp(usable.reduce((sum, v) => sum + Math.log(v), 0) / usable.length)
}

/**
 * `ratio^(n/(n+K))`, clamped — in log space, so that ×4 and ×¼ are pulled by the same proportion.
 */
export function shrinkPace(ratio: number, samples: number): number {
  if (!(ratio > 0)) return 1
  const pulled = Math.exp(Math.log(ratio) * (samples / (samples + SHRINK_K)))
  return Math.min(FACTOR_CEILING, Math.max(FACTOR_FLOOR, pulled))
}

/**
 * Who a finished task is credited to: the adapter and model of its **last non-failed work run**.
 *
 * ⛔ The same rule `review.ts` uses to decide whose work is being graded, and deliberately so — a
 * fleet that attributes speed one way and quality another cannot put the two numbers in one table.
 *
 * ⛔ **Exported so there is one implementation of it, not three.** `statistics.ts` needs the same
 * attribution to say what a task cost and took per agent; a copy of this query living there would
 * be one rename away from crediting a task to a different agent than the Velocity tab does, and the
 * two pages would disagree about the same fleet with no way to tell which was right.
 */
export function creditedKeys(taskIds: string[]): Map<string, Credit> {
  const out = new Map<string, Credit>()
  if (taskIds.length === 0) return out
  for (let i = 0; i < taskIds.length; i += 400) {
    const chunk = taskIds.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    // ⚠️ `max(started_at)` picked per task by the window the group provides: SQLite's bare-column
    // rule makes `adapter_id` and `model` come from the row that supplied the max, which is exactly
    // the last non-failed work run.
    const found = rows<CreditRow>(
      db()
        .prepare(
          `select task_id, adapter_id, model, session_id, max(started_at) as last_at
             from runs
            where task_id in (${holes})
              and kind = 'work'
              and coalesce(outcome, '') <> 'failed'
              and adapter_id is not null
            group by task_id`
        )
        .all(...chunk)
    )
    for (const r of found) {
      if (r.adapter_id) {
        out.set(r.task_id, { adapterId: r.adapter_id, model: r.model, sessionId: r.session_id })
      }
    }
  }
  return out
}

/**
 * What the fleet has measured about how long its agents take, learned from finished tasks.
 *
 * ⚠️ Recomputed on demand rather than cached: it is two indexed queries and a merge over at most 200
 * tasks, and a stale pace factor is a silent one.
 */
export function paceFactors(now = Date.now()): PaceFactors {
  const finished = rows<{ id: string }>(
    db()
      .prepare(
        // ⛔ Completed only. A cancelled or failed task stopped for a reason that has nothing to do
        // with how fast its agent works, and counting it would make the agent that gets interrupted
        // most look like the agent that finishes fastest.
        // ⚠️ And `stats_excluded = 0`, the same filter `statistics.ts` reads: a task whose active
        // time an operator has judged unmeasurable must not move the router either.
        `select id from tasks
          where status = 'completed' and deleted_at is null and coalesce(stats_excluded, 0) = 0
          order by updated_at desc
          limit ?`
      )
      .all(SAMPLE_LIMIT)
  )
  const ids = finished.map((t) => t.id)
  const timings = timingForTasks(ids, now)
  const credits = creditedKeys(ids)

  const perKey = new Map<string, { adapterId: string; model: string | null; values: number[] }>()
  const all: number[] = []
  for (const id of ids) {
    const active = timings.get(id)?.activeMs ?? 0
    if (active < MIN_ACTIVE_MS) continue
    const credit = credits.get(id)
    if (!credit) continue
    all.push(active)
    const key = keyId(credit.adapterId, credit.model)
    const bucket = perKey.get(key) ?? { adapterId: credit.adapterId, model: credit.model, values: [] }
    bucket.values.push(active)
    perKey.set(key, bucket)
  }

  const neutral = centre(all)
  const keys: PaceKey[] = [...perKey.values()]
    .map((bucket) => {
      // No samples has historically meant the neutral pace, not a measured zero duration.
      const medianActiveMs = medianFloat(bucket.values) ?? 0
      const ratio = neutral > 0 && medianActiveMs > 0 ? medianActiveMs / neutral : 1
      return {
        adapterId: bucket.adapterId,
        model: bucket.model,
        samples: bucket.values.length,
        medianActiveMs,
        ratio,
        factor: shrinkPace(ratio, bucket.values.length)
      }
    })
    .sort((a, b) => a.factor - b.factor)

  return { keys, neutralActiveMs: neutral, samples: all.length }
}

/**
 * A key's pace, with the adapter-wide rung as its fallback.
 *
 * ⚠️ Exact key first, then the adapter's other models pooled. A model nobody has finished a task on
 * inherits what its account has been measured to do rather than being called average, which is the
 * same ladder `estimator.ts` climbs.
 */
export function paceFor(
  factors: PaceFactors,
  adapterId: string,
  model: string | null
): { factor: number; samples: number; medianActiveMs: number | null; basis: string } {
  const exact = factors.keys.find((k) => k.adapterId === adapterId && k.model === (model ?? null))
  if (exact) {
    return {
      factor: exact.factor,
      samples: exact.samples,
      medianActiveMs: exact.medianActiveMs,
      basis:
        `${minutes(exact.medianActiveMs)} median active time over ${exact.samples} finished ` +
        `task(s) on ${adapterId}${model ? `/${model}` : ''}, against a fleet median of ` +
        `${minutes(factors.neutralActiveMs)} (×${exact.ratio.toFixed(2)}, shrunk to ` +
        `×${exact.factor.toFixed(2)})`
    }
  }

  const sameAdapter = factors.keys.filter((k) => k.adapterId === adapterId)
  if (sameAdapter.length > 0) {
    const samples = sameAdapter.reduce((n, k) => n + k.samples, 0)
    // No model samples falls back to the neutral factor below, rather than reporting a zero pace.
    const pooled = medianFloat(sameAdapter.map((k) => k.medianActiveMs)) ?? 0
    const ratio = factors.neutralActiveMs > 0 ? pooled / factors.neutralActiveMs : 1
    return {
      factor: shrinkPace(ratio, samples),
      samples,
      medianActiveMs: pooled,
      basis:
        `no finished task on ${adapterId}/${model ?? '?'} yet, so this account's other models are ` +
        `pooled: ${minutes(pooled)} median over ${samples} task(s)`
    }
  }

  return {
    factor: 1,
    samples: 0,
    medianActiveMs: null,
    basis: `nothing has finished on ${adapterId} yet — unmeasured scores 0, never a guess`
  }
}

/**
 * The factor as a routing value: how much faster or slower than the fleet's centre, on a scale where
 * ±1 is a factor of four.
 *
 * ⛔ **Signed, and it is the only term in the score that is.** Every other value is 0..1 because
 * every other term measures a quantity with a floor — there is no such thing as less-than-no prompt
 * cache. Pace has a real middle: the fleet's own centre. A penalty-only reading would score the
 * fastest agent on the fleet exactly the same as the median one, which is the discrimination this
 * term exists to add. So the value is positive for an agent measured *faster* than the centre,
 * negative for one measured slower, and exactly 0 when nothing has been measured — which is the
 * same "unknown is never a guess" rule `quotaRisk` follows.
 *
 * ⚠️ Saturates at a factor of four in either direction. Beyond that the difference stops being
 * information about the agent and starts being information about which tasks it drew.
 */
export function paceValue(factor: number): number {
  if (!(factor > 0)) return 0
  const scaled = -Math.log(factor) / Math.log(4)
  const clamped = Math.max(-1, Math.min(1, scaled))
  // ⚠️ `-Math.log(1)` is negative zero, which renders as "−0.00" beside every unmeasured account —
  // a minus sign in front of a number that means *nothing was measured*. Normalised here rather than
  // at each of the places that format it.
  return clamped === 0 ? 0 : clamped
}

function minutes(ms: number): string {
  if (!(ms > 0)) return 'n/a'
  const m = ms / 60_000
  return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m.toFixed(0)}m`
}
