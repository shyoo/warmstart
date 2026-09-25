import {
  addDependency,
  addMessage,
  admit,
  createTask,
  getTask,
  isIntegrationParent,
  requireTask,
  setStatus
} from './tasks.js'
import { log } from './log.js'
import {
  PLAN_EXECUTE_CHILDREN,
  isPlanExecute,
  planModeOf,
  type ChildDefaults,
  type Principal,
  type QuestionOption,
  type Task,
  type TaskConstraints
} from '@shared/tasks.js'
import { errorMessage } from '@shared/errors.js'

/**
 * Plan & Split: turning one planner's plan into the tasks that carry it out.
 *
 * ⛔ **The whole set is validated before anything is written, and then written together.** A
 * half-applied split is a planner blocked on children that do not exist — a task that can never be
 * released by anything, because the thing it waits for was never filed. So every rule below is
 * checked against the *whole* proposal first, and `applySplit` either files all of it or none.
 *
 * The safety boundary lives here rather than in the MCP tool because it is the expensive thing to get
 * wrong and the cheap thing to test: `split.test.ts` drives it against a temp database with no agent,
 * no prompt and no UI in the way.
 */

/** How many pieces a split may have, before the task's own mandate narrows it further. */
export const MAX_SPLIT_PIECES = 8

/**
 * ⛔ **Two, not one — in `split` mode.** A planner that concludes the work is a single task has not
 * found a split; the honest move there is `ask_human`, or just doing it. A split of one buys a round
 * trip, a second workspace and a second cold context, and delivers no parallelism at all.
 *
 * ⭐ **Plan & Execute is the operator answering that objection in advance** (`planModeOf`). It pays
 * the round trip and the cold context deliberately, because the point is to hand the work to a
 * *different, cheaper* model — and it stops paying the third turn for them, because one piece has no
 * seams to integrate. There the floor and the ceiling are both `PLAN_EXECUTE_CHILDREN`.
 */
export const MIN_SPLIT_PIECES = 2

export interface SplitPiece {
  /** ⛔ This is the child's **prompt**, not a label — `promptFor` sends it verbatim. */
  title: string
  /** A one-line label for the board. Optional; the title's first line stands in. */
  summary?: string
  /** Indices into this same list, and they must point **backwards**. */
  dependsOn: number[]
}

export type SplitResult =
  | { ok: true; children: Task[] }
  | { ok: false; reason: string }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Everything that can be said about a proposed split without writing to the database.
 *
 * ⛔ The backwards-only dependency rule is inherited from `validateDecomposition` deliberately and
 * unchanged: an edge must point at an **earlier** piece, which makes a cycle impossible *by
 * construction* rather than detectable afterwards. Agent-authored DAGs are exactly where cycles come
 * from, and a cycle discovered by the scheduler is a deadlock rather than an error message.
 */
export function validateSplit(
  parent: Task,
  pieces: SplitPiece[]
): { ok: true } | { ok: false; reason: string } {
  // ⛔ **A debate organizer may split too, and that is the verdict *Split the work*.** The topology
  // is identical — pieces are cut from the parent's branch and merge back into it — which is why
  // this asks `isIntegrationParent` rather than naming two kinds here and two more in
  // `plannerBranchFor` and `createTask`. See that function.
  if (!isIntegrationParent(parent)) {
    return {
      ok: false,
      reason: `t${parent.seq} is not a Plan & Split or Debate task, so it cannot file a split`
    }
  }
  // ⛔ **The floor is the plan's mode, not a constant.** A Plan & Execute wants exactly one piece and
  //    a Plan & Split wants at least two, and both refusals have to name the shape the operator
  //    actually filed — "a split needs at least 2 pieces" sent to a planner that was told to file one
  //    is a contradiction it has no way to resolve.
  const mode = planModeOf(parent)
  const count = Array.isArray(pieces) ? pieces.length : 0
  if (mode === 'execute' && count !== PLAN_EXECUTE_CHILDREN) {
    return {
      ok: false,
      reason:
        `t${parent.seq} is a Plan & Execute task, so it files exactly ${PLAN_EXECUTE_CHILDREN} piece; ` +
        `got ${count}. Fold the whole job into one self-contained instruction for one agent. If it ` +
        'genuinely has to be split, say so with `ask_human` rather than filing a plan this task ' +
        'cannot carry — nothing here will come back to integrate the pieces.'
    }
  }
  if (mode === 'split' && count < MIN_SPLIT_PIECES) {
    return {
      ok: false,
      reason:
        `a split needs at least ${MIN_SPLIT_PIECES} pieces; got ${count}. If this work ` +
        'is really one task, do it or ask about it rather than splitting it.'
    }
  }

  // ⛔ **The mandate is the authority, and there is only ever one cap.** `MAX_SPLIT_PIECES` is the
  // ceiling the composer's control offers; the task's own `maxChildren` is what `createTask` will
  // actually enforce. Checking only the first would let a split pass here and fail halfway through
  // creation, which is the half-applied state this whole function exists to prevent.
  const cap = Math.min(parent.mandate.maxChildren, parent.childDefaults?.maxChildren ?? MAX_SPLIT_PIECES)
  if (pieces.length > cap) {
    return { ok: false, reason: `${pieces.length} pieces exceeds this task's fan-out cap of ${cap}` }
  }

  const seen = new Set<string>()
  for (const [i, piece] of pieces.entries()) {
    const title = piece?.title?.trim() ?? ''
    if (!title) return { ok: false, reason: `piece ${i + 1} has no instruction` }

    // ⛔ Checked here, before the operator is shown anything. `createTask` merges an agent-filed
    // near-duplicate into the existing task and returns *that* task, so two pieces with the same
    // title would silently become one and the planner would wait on a child that was never filed.
    // Suppressing the merge (below) handles the fleet; this handles the split's own collisions.
    const key = norm(title)
    if (seen.has(key)) {
      return { ok: false, reason: `pieces ${i + 1} and an earlier one have the same instruction` }
    }
    seen.add(key)

    for (const dep of piece.dependsOn ?? []) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= i) {
        return {
          ok: false,
          reason:
            `piece ${i + 1} depends on ${String(dep)}, which is not an earlier piece. ` +
            'Dependencies point backwards, by position, starting at 0.'
        }
      }
    }
  }

  // ⚠️ Asserted rather than assumed. Children are cut *from* this branch, so it has to exist before
  // any of them is dispatched. It does — phase 1 created it when the planner's workspace was
  // prepared — but a split filed by a planner with no branch would silently give every child the
  // project's trunk as its base and quietly stop being a split at all.
  if (!parent.branch) {
    return {
      ok: false,
      reason: `t${parent.seq} has no branch yet, so its pieces would have nothing to be cut from`
    }
  }
  return { ok: true }
}

/**
 * The constraints every piece of one plan is filed with.
 *
 * ⛔ **The operator's list of accounts, or nothing — never the fleet's own choice.** This is the bug
 * t197 reported and it was as bad as it sounds: the Pieces row named Antigravity and Codex, the
 * composer sent them as `workerIds`, and this function's predecessor read only the singular
 * `workerId` that the row does not set. Every child was therefore filed with an empty `constraints`,
 * went through the ordinary dispatcher, and was handed to the largest and most expensive account in
 * the fleet for work whose whole point was that it was small. A setting that is displayed, stored,
 * validated and then not read is worse than one that was never offered.
 *
 * ⚠️ **Two shapes carry the same answer, and both are read.** The composer writes the pieces' accounts
 * into `childDefaults` *and* into the planner's own `constraints.pieceConstraints`; older plan tasks
 * have only one of the two. `childDefaults` wins where both are present, because it is the field
 * `task_split` is handed directly.
 *
 * ⭐ A single named account is written to `workerId` as well as `workerIds`. The scheduler reads
 * either, but `sharing.ts`, the thread's Worker pill and the estimator all read the singular one, and
 * an operator who picked exactly one account has pinned it.
 */
export function pieceConstraints(
  parent: Task,
  defaults: ChildDefaults | null | undefined
): TaskConstraints {
  const fallback: TaskConstraints = parent.constraints?.pieceConstraints ?? {}
  const ids = (defaults?.workerIds?.length
    ? defaults.workerIds
    : fallback.workerIds?.length
      ? fallback.workerIds
      : defaults?.workerId
        ? [defaults.workerId]
        : fallback.workerId
          ? [fallback.workerId]
          : []
  ).filter((id): id is string => !!id)

  const models = defaults?.modelsByWorker ?? fallback.modelsByWorker
  const efforts = defaults?.effortsByWorker ?? fallback.effortsByWorker
  // ⚠️ A fleet-wide model only where no account was named. A model id belongs to one CLI, so sending
  // one alongside a list of accounts from different CLIs would hand at least one of them an id it
  // cannot start on — which is why the per-account maps exist at all.
  const model = ids.length > 1 ? null : (defaults?.model ?? fallback.model ?? null)
  const effort = ids.length > 1 ? null : (defaults?.effort ?? fallback.effort ?? null)

  return {
    ...(ids.length === 1 ? { workerId: ids[0]! } : {}),
    ...(ids.length > 0 ? { workerIds: ids } : {}),
    ...(models && Object.keys(models).length > 0 ? { modelsByWorker: models } : {}),
    ...(efforts && Object.keys(efforts).length > 0 ? { effortsByWorker: efforts } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

/**
 * What the operator is asked before a split is filed.
 *
 * ⛔ **Validated, then approved, then written — in that order.** The operator is never shown a
 * plan that cannot be filed, and nothing is written until they answer, so a refusal costs a
 * message rather than a cleanup. `agent.split` prechecks with `validateSplit` before calling
 * this, and files with `applySplit` after the answer.
 *
 * ⛔ **A Plan & Execute approval carries the whole executor instruction, not its label.** The
 * piece's title is the executor's prompt verbatim, and this approval is the one and only time
 * a person sees it before it runs — there is no review turn behind it. t693: the card used to
 * show only the first line, so the operator approved a label while these bytes ran. A Plan &
 * Split approval stays one-line labels: the planner's resolution turn still reviews every
 * piece before anything reaches the trunk.
 */
export interface SplitApproval {
  header: string
  question: string
  options: QuestionOption[]
}

export function splitApprovalFor(parent: Task, pieces: SplitPiece[]): SplitApproval {
  const listed = pieces
    .map((piece, i) => {
      const label = piece.summary?.trim() || piece.title.trim().split(/\r?\n/)[0] || `piece ${i + 1}`
      const waits = piece.dependsOn?.length
        ? ` (after ${piece.dependsOn.map((d) => `#${d + 1}`).join(', ')})`
        : ''
      return `${i + 1}. ${label}${waits}`
    })
    .join('\n')

  // ⛔ **The gate is the same gate; only the sentence about what happens next changes.** A Plan &
  //    Execute approval is the one and only time a person sees the instruction before the
  //    executor runs against it — there is no review turn behind it — and telling them it will be
  //    reviewed would be describing a turn this shape does not have.
  const handoff = isPlanExecute(parent)
  if (handoff) {
    const instruction = pieces.map((piece) => piece.title.trim()).join('\n')
    return {
      header: `Hand t${parent.seq} to an executor?`,
      question:
        `t${parent.seq} has finished planning and wants to hand the whole job to one executor:\n\n${listed}\n\n` +
        'Approving files it and starts it as soon as an account is free. It lands on the ' +
        'project’s own target when it is done — this plan does not come back to review it, which ' +
        'is what makes this two turns instead of three, so this is your look at the ' +
        'instruction. Refusing sends your note back to the planner so it can revise.\n\n' +
        'The full instruction the executor will receive:\n\n' +
        instruction,
      options: [
        { id: 'approve', label: 'Hand it over', detail: 'It starts as soon as an account is free' },
        { id: 'refuse', label: 'Not like this', detail: 'Add a note and the planner revises the plan' }
      ]
    }
  }

  return {
    header: `Split t${parent.seq} into ${pieces.length}?`,
    question:
      `t${parent.seq} wants to split into ${pieces.length} pieces and delegate them:\n\n${listed}\n\n` +
      'Approving files all of them at once and starts them; they branch off this plan’s branch ' +
      'and merge back into it, and nothing reaches the trunk until the whole plan is reviewed. ' +
      'Refusing sends your note back to the planner so it can revise.',
    options: [
      { id: 'approve', label: `File all ${pieces.length}`, detail: 'They start as soon as an account is free' },
      { id: 'refuse', label: 'Not like this', detail: 'Add a note and the planner revises the plan' }
    ]
  }
}

/**
 * File the whole plan, or none of it.
 *
 * ⛔ **The parent's edges are `settled`, not `completed`.** A planner has to be woken by the children
 * that *failed* as well as the ones that worked — reviewing what came back, including what did not,
 * is the entire job of the resolution turn. A `completed` edge onto a failed child would hold the
 * planner at `blocked` for ever with no way out but a person.
 *
 * ⚠️ The parent is left `blocked` by this function and its run is ended by the caller. That ordering
 * matters: `endUnfinishedRun` only touches a task still `running` or `assigned`, so the `blocked`
 * written here survives the planner's process exiting.
 *
 * ⛔ **Plan & Execute writes neither of those two things**, and that is the whole of its difference
 * here: no `settled` edge back onto the planner and no `blocked`. There is nothing for the planner to
 * come back to — one piece has no seams — so it is *finished* at the handoff, and the caller completes
 * it through the ordinary completion path rather than ending its run at a wait. The executor is filed
 * with no `landingTarget` of its own, which resolves to the **project's**: see `integratesChildren`.
 */
export function applySplit(
  parentTaskId: string,
  pieces: SplitPiece[],
  createdBy: Principal,
  defaults?: ChildDefaults | null
): SplitResult {
  const parent = requireTask(parentTaskId)
  const check = validateSplit(parent, pieces)
  if (!check.ok) return check

  const inherit = defaults ?? parent.childDefaults ?? {}
  // ⛔ Resolved once, before the loop, so every piece of one plan is filed with the identical set of
  // accounts. Recomputing per child would be a second place for the answer to differ.
  const constraints = pieceConstraints(parent, inherit)
  const handoff = isPlanExecute(parent)
  const created: Task[] = []

  try {
    for (const piece of pieces) {
      const child = createTask({
        title: piece.title.trim(),
        projectId: parent.projectId,
        parentTaskId: parent.id,
        createdBy,
        kind: 'work',
        status: 'ready',
        priority: inherit.priority ?? parent.priority,
        // ⚠️ The hint is only meaningful for one account. With a list it is left unset and the
        // `workerIds` gate below is what does the narrowing.
        assigneeHint: constraints.workerId ?? null,
        finishPolicy: inherit.finishPolicy ?? 'inherit',
        sessionSharing: inherit.sessionSharing ?? 'inherit',
        // ⛔ **The plan branch, so a later piece can see an earlier one's work.** This is what makes
        // `dependsOn` between two pieces mean anything: without it child 2 is cut from `main` and a
        // dependency would order the runs and deliver nothing.
        // ⛔ **Except in Plan & Execute, where it is the project's own target.** `null` here is not
        // "unset" — it is the answer `landingTargetFor` resolves to the project's, and it is the one
        // thing that keeps this executor from merging into a plan branch nothing will ever land.
        landingTarget: handoff ? null : parent.branch,
        // ⛔ Equal shares, never `shareBudget`'s halving — see `CreateTaskInput.budgetShare`.
        budgetShare: 1 / pieces.length,
        mergeDuplicates: false,
        // ⚠️ These are **pins**, not the `assigneeHint` above, and the composer's Pieces row says so:
        // an operator who names accounts for the pieces has chosen them, and the scheduler skipping
        // every other worker is precisely the behaviour they asked for.
        constraints
      })
      created.push(child)
    }

    // Edges among the pieces, written after every child exists so an index always resolves.
    for (const [i, piece] of pieces.entries()) {
      for (const dep of piece.dependsOn ?? []) {
        const from = created[i]
        const to = created[dep]
        if (from && to) addDependency(from.id, to.id)
      }
    }

    // ⛔ **And then admitted, which `addDependency` deliberately does not do.** It is the raw edge
    //    write — it runs inside `createTask`, before a row has a derived status to recompute — so a
    //    piece created `ready` and *then* given a prerequisite stays `ready` and is dispatched by the
    //    very next tick, in parallel with the piece it was supposed to wait for. The ordering the
    //    planner asked for would have been silently discarded; `attachDependency` exists for exactly
    //    this reason at the other end of the same edge.
    for (const child of created) admit(child.id)

    // The parent waits on every piece, however each one ends.
    // ⛔ Not in Plan & Execute. An edge there would park the planner at `blocked` waiting for a turn
    //    that is never dispatched, which is the one state `admit` has no way out of.
    if (!handoff) for (const child of created) addDependency(parent.id, child.id, 'settled')
  } catch (err) {
    // ⛔ Unwind rather than leave a partial split. A planner blocked on half a plan is worse than a
    // planner told its plan was refused, because only one of those two states has a way out.
    for (const child of created) {
      try {
        setStatus(child.id, 'cancelled', { holdReason: 'the split it belonged to could not be filed' })
      } catch {
        // Best effort: the message below is what the operator acts on.
      }
    }
    const reason = errorMessage(err)
    log.warn(`t${parent.seq} split could not be filed: ${reason}`)
    return { ok: false, reason }
  }

  const listed = created.map((c) => `t${c.seq}`).join(', ')
  if (handoff) {
    // ⚠️ The status is deliberately left alone. The caller completes the planner through the ordinary
    // completion path — the finish policy, the run's end and the workspace release all belong to it —
    // and a `blocked` or `completed` written here would be a second answer racing that one.
    addMessage(parent.id, 'system', `Handed to ${listed}`, null, [], {
      detail:
        `${listed} carries the whole of this plan and lands it on the project's own target. This ` +
        'task is finished at the handoff: there is one piece, so there are no seams between pieces ' +
        'for a review turn to look at.'
    })
    log.info(`t${parent.seq} handed its plan to ${listed}`)
    return { ok: true, children: created }
  }

  addMessage(
    parent.id,
    'system',
    `Split into ${created.length} pieces`,
    null,
    [],
    { detail: `${listed}. This task waits for all pieces to settle — completed, failed or cancelled — then reviews the result as a whole.` }
  )
  setStatus(parent.id, 'blocked', {
    holdReason: `waiting on ${created.length} pieces of its own plan (${listed})`
  })
  // ⚠️ Re-derive rather than trust the write above: a piece that somehow settled between being
  // created and being depended on would otherwise leave the planner blocked on nothing.
  admit(parent.id)
  log.info(`t${parent.seq} split into ${created.length} pieces: ${listed}`)
  return { ok: true, children: created }
}

/**
 * Add one edge between two pieces of **this planner's own split**.
 *
 * ⛔ Scoped to the planner's children on purpose. An agent that can add an arbitrary edge anywhere in
 * the fleet can hold up work it has never seen and was never given authority over; the blast radius
 * of a mistake here should be the plan the agent is holding, and nothing else.
 */
export function addSplitDependency(
  parentTaskId: string,
  fromSeq: number,
  toSeq: number
): { ok: true } | { ok: false; reason: string } {
  const parent = requireTask(parentTaskId)
  const own = (seq: number): Task | null => {
    const found = childrenOf(parent.id).find((c) => c.seq === seq)
    return found ?? null
  }
  const from = own(fromSeq)
  const to = own(toSeq)
  if (!from) return { ok: false, reason: `t${fromSeq} is not one of this task's own pieces` }
  if (!to) return { ok: false, reason: `t${toSeq} is not one of this task's own pieces` }
  try {
    addDependency(from.id, to.id)
  } catch (err) {
    return { ok: false, reason: errorMessage(err) }
  }
  admit(from.id)
  return { ok: true }
}

/** The pieces of one planner's split, in the order they were filed. */
export function childrenOf(parentTaskId: string): Task[] {
  const parent = getTask(parentTaskId)
  if (!parent) return []
  return parent.dependsOn
    .map((id) => getTask(id))
    .filter((t): t is Task => !!t && t.parentTaskId === parentTaskId)
    .sort((a, b) => a.seq - b.seq)
}
