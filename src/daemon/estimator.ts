import type { Task } from '@shared/tasks.js'
import { db, rows } from './db.js'

/**
 * What a task is likely to cost, learned from what tasks actually cost.
 *
 * ⛔ This is why runs are never deleted with their task. They are the only record of real spend, and
 * an estimator with no history is the thing that makes a scheduler confidently wrong.
 *
 * Deliberately median rather than mean: one runaway run should not move the estimate for everything
 * after it, and agent work has a long right tail.
 *
 * ⚠️ Confidence is reported, always. An estimate from two samples and an estimate from fifty are
 * different objects, and a gate that treats them the same is a gate that will open when it should
 * not - so `low` confidence widens every margin that consumes it.
 */

export type Confidence = 'none' | 'low' | 'medium' | 'high'

export interface Estimate {
  tokens: number
  confidence: Confidence
  samples: number
  basis: string
}

/**
 * The fallback when nothing has been measured. Chosen from the one thing we do know: the M2
 * end-to-end run - a trivially small task - metered ~490k input-token-equivalents, almost all of it
 * cache reads on a 35k prefix. So this is not "a small number"; it is a deliberately *pessimistic*
 * one, because an under-estimate is what breaks a quota gate.
 */
const COLD_FALLBACK_TOKENS = 250_000

interface RunRow {
  total: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0)
}

function confidenceFor(samples: number): Confidence {
  if (samples === 0) return 'none'
  if (samples < 3) return 'low'
  if (samples < 10) return 'medium'
  return 'high'
}

function completedRunTotals(where: string, args: unknown[]): number[] {
  return rows<RunRow>(
    db()
      .prepare(
        `select (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total
           from runs
          where outcome = 'completed' and ${where}
          order by started_at desc
          limit 40`
      )
      .all(...(args as string[]))
  )
    .map((r) => r.total)
    .filter((t) => t > 0)
}

export function estimateTask(task: Task): Estimate {
  // An explicit estimate from a person or the controller outranks history: they know something about
  // this particular task that the average does not.
  if (task.estTokens && task.estTokens > 0) {
    return {
      tokens: task.estTokens,
      confidence: 'medium',
      samples: 0,
      basis: 'stated on the task'
    }
  }

  if (task.projectId) {
    const withinProject = completedRunTotals('project_id = ?', [task.projectId])
    if (withinProject.length > 0) {
      return {
        tokens: median(withinProject),
        confidence: confidenceFor(withinProject.length),
        samples: withinProject.length,
        basis: `median of ${withinProject.length} completed run(s) in this project`
      }
    }
  }

  const anywhere = completedRunTotals('1 = 1', [])
  if (anywhere.length > 0) {
    return {
      tokens: median(anywhere),
      confidence: anywhere.length < 5 ? 'low' : 'medium',
      samples: anywhere.length,
      basis: `median of ${anywhere.length} completed run(s) across all projects`
    }
  }

  return {
    tokens: COLD_FALLBACK_TOKENS,
    confidence: 'none',
    samples: 0,
    basis: 'nothing measured yet - deliberately pessimistic'
  }
}

/**
 * How far past its estimate a run has gone. The runaway watchdog's input.
 *
 * Returns null when there is nothing to compare against: an unmeasured task cannot be a runaway, and
 * pretending otherwise would kill work for the crime of being first.
 */
export function overrunFactor(runId: string): number | null {
  const run = db()
    .prepare(
      `select r.task_id as task_id,
              (r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) as total
         from runs r where r.id = ?`
    )
    .get(runId) as { task_id: string | null; total: number } | undefined
  if (!run?.task_id || run.total <= 0) return null

  const task = db().prepare('select * from tasks where id = ?').get(run.task_id) as
    | { est_tokens: number | null; project_id: string | null }
    | undefined
  if (!task) return null

  const estimate = estimateTask({
    estTokens: task.est_tokens,
    projectId: task.project_id
  } as Task)
  if (estimate.confidence === 'none') return null
  return run.total / Math.max(1, estimate.tokens)
}
