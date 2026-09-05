import { randomUUID } from 'node:crypto'
import type { Objective } from '@shared/tasks.js'
import type {
  RoutingBasis,
  RoutingCandidate,
  RoutingDecision,
  RoutingDecisionPage
} from '@shared/routing.js'
import { db, row, rows } from './db.js'

/**
 * The ledger of routing decisions.
 *
 * ⛔ **Written at dispatch and nowhere else.** `chooseTarget` runs on every tick for every eligible
 * task, most of which are then held for a resource, a quota window or a controller answer; recording
 * there would fill this table with hypotheticals at a rate of one per task per tick. A row here means
 * *this task was actually handed to this account*, which is the only event worth keeping and the only
 * one an operator can check against what the fleet then did.
 *
 * ⚠️ A row is written before the spawn can fail. That is deliberate: the routing decision was made,
 * and a dispatch that then loses a race for a worktree does not un-make it. What the row does not
 * claim is that a run started — it holds no run id, and the task's own timeline is where that lives.
 *
 * ⛔ **Never pruned by count and never rewritten.** Three months of decisions is what makes "has this
 * agent been getting all the work since March?" answerable, and the table is one small JSON blob per
 * dispatch.
 */

interface DecisionRow {
  id: string
  task_id: string | null
  task_seq: number | null
  task_title: string
  project_id: string | null
  chosen_worker_id: string | null
  chosen_label: string | null
  objective_json: string
  weights_json: string
  formulas_json: string
  candidates_json: string
  epsilon: number
  basis: string
  warm: number
  decided_at: number
}

function toDecision(r: DecisionRow): RoutingDecision {
  return {
    id: r.id,
    taskId: r.task_id,
    taskSeq: r.task_seq,
    taskTitle: r.task_title,
    projectId: r.project_id,
    chosenWorkerId: r.chosen_worker_id,
    chosenLabel: r.chosen_label,
    objective: JSON.parse(r.objective_json) as Objective,
    weights: JSON.parse(r.weights_json) as Record<string, number>,
    weightFormulas: JSON.parse(r.formulas_json) as Record<string, string>,
    epsilon: r.epsilon,
    basis: r.basis as RoutingBasis,
    warm: r.warm === 1,
    candidates: JSON.parse(r.candidates_json) as RoutingCandidate[],
    decidedAt: r.decided_at
  }
}

export interface RecordDecisionInput {
  taskId: string | null
  taskSeq: number | null
  taskTitle: string
  projectId: string | null
  chosenWorkerId: string | null
  chosenLabel: string | null
  objective: Objective
  weights: Record<string, number>
  weightFormulas: Record<string, string>
  epsilon: number
  basis: RoutingBasis
  warm: boolean
  candidates: RoutingCandidate[]
}

/**
 * ⚠️ The title is stored rather than joined, because a decision outlives its task: `task_id` is
 * deliberately unconstrained so that deleting a task leaves the record of where its work went.
 */
export function recordRoutingDecision(input: RecordDecisionInput): RoutingDecision {
  const id = randomUUID()
  db()
    .prepare(
      `insert into routing_decisions
         (id, task_id, task_seq, task_title, project_id, chosen_worker_id, chosen_label,
          objective_json, weights_json, formulas_json, candidates_json, epsilon, basis, warm,
          decided_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.taskId,
      input.taskSeq,
      // ⚠️ Trimmed here rather than in the UI. A task's `title` *is* its prompt on this fleet — the
      // form files a whole textarea into it — so an untrimmed column would make this table mostly
      // paragraphs of somebody else's instructions.
      input.taskTitle.slice(0, 400),
      input.projectId,
      input.chosenWorkerId,
      input.chosenLabel,
      JSON.stringify(input.objective),
      JSON.stringify(input.weights),
      JSON.stringify(input.weightFormulas),
      JSON.stringify(input.candidates),
      input.epsilon,
      input.basis,
      input.warm ? 1 : 0,
      Date.now()
    )
  return requireRoutingDecision(id)
}

export function requireRoutingDecision(id: string): RoutingDecision {
  const r = row<DecisionRow>(db().prepare('select * from routing_decisions where id = ?').get(id))
  if (!r) throw new Error(`no routing decision '${id}'`)
  return toDecision(r)
}

/**
 * A page of decisions, newest first, with the total so a pager knows where it ends.
 *
 * ⚠️ `total` is a second query rather than a length: the page is bounded and the count is not, and a
 * pager that infers "there is no more" from a short page is wrong exactly once, at the boundary.
 */
/**
 * How many dispatches actually chose each (worker, model) pair, and how many of those were
 * exploration rather than the arithmetic's own winner.
 *
 * ⛔ **`candidates_json` is the only place a decision's model lives.** There is no `chosen_model`
 * column — the pair is read off whichever entry in the stored ranked field carries `chosen: true`,
 * the same way every other reader of this table treats it as the one arithmetic that produced the
 * ordering, never a fact re-derived from a live worker's current defaults.
 *
 * ⚠️ A full-table scan, and deliberately not paginated: this answers one aggregate question over the
 * whole ledger for an analytics page a person opens, not a per-tick read on the scheduler's own path.
 */
export function dispatchCountsByPair(): Map<string, { dispatches: number; explorations: number }> {
  const found = rows<{ candidates_json: string; basis: string }>(
    db().prepare('select candidates_json, basis from routing_decisions').all()
  )
  const counts = new Map<string, { dispatches: number; explorations: number }>()
  for (const r of found) {
    let candidates: RoutingCandidate[]
    try {
      candidates = JSON.parse(r.candidates_json) as RoutingCandidate[]
    } catch {
      continue
    }
    const chosen = candidates.find((c) => c.chosen)
    if (!chosen?.workerId || !chosen.model) continue
    const key = `${chosen.workerId}:${chosen.model}`
    const entry = counts.get(key) ?? { dispatches: 0, explorations: 0 }
    entry.dispatches += 1
    if (r.basis === 'explore') entry.explorations += 1
    counts.set(key, entry)
  }
  return counts
}

export function routingDecisions(limit = 5, offset = 0): RoutingDecisionPage {
  const bounded = Math.max(1, Math.min(50, Math.floor(limit)))
  const from = Math.max(0, Math.floor(offset))
  const found = rows<DecisionRow>(
    db()
      .prepare('select * from routing_decisions order by decided_at desc limit ? offset ?')
      .all(bounded, from)
  )
  const total =
    (db().prepare('select count(*) as n from routing_decisions').get() as { n: number } | undefined)
      ?.n ?? 0
  return { decisions: found.map(toDecision), total, limit: bounded, offset: from }
}
