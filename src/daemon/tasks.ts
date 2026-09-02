import { randomUUID } from 'node:crypto'
import {
  PRIORITY_ORDER,
  ROOT_MANDATE,
  statusesForViews,
  viewForStatus,
  type Budget,
  type Mandate,
  type MandateOperation,
  type Objective,
  type Principal,
  type Priority,
  type Run,
  type RunOutcome,
  type RunQuota,
  type Task,
  type TaskConstraints,
  type TaskKind,
  type TaskMessage,
  type TaskPage,
  type TaskSort,
  type TaskStatus,
  type TaskView
} from '@shared/tasks.js'
import { timingForRuns, timingForTasks, ZERO_TIMING, type ActiveTiming } from './activetime.js'
import { attachmentsFor, bindAttachments } from './attachments.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'

/**
 * Tasks.
 *
 * A task is a **thread of work with an assignee**, not a prompt: it carries a conversation,
 * dependencies, a schedule, resource requirements, an authority and a budget.
 *
 * Any principal can file one - you, the controller, or an agent mid-run - which is the loop that
 * makes this useful and also the thing that could run away. It is bounded **by construction rather
 * than by heuristics**: mandates narrow with every generation, budgets are inherited *shares* so a
 * subtree cannot outspend its root, fan-out is capped, cycles are rejected on the edge that would
 * create them, and near-duplicates are merged at admission.
 */

const NEAR_DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000

interface TaskRow {
  id: string
  seq: number
  project_id: string | null
  title: string
  title_summary: string | null
  kind: string
  status: string
  priority: string
  created_by_json: string
  parent_task_id: string | null
  lineage_depth: number
  assignee: string | null
  assignee_hint: string | null
  last_run_worker_id?: string | null
  mandate_json: string
  budget_json: string
  not_before: number | null
  deadline: number | null
  requires_json: string
  constraints_json: string
  verification: string
  finish_policy: string
  session_sharing: string
  completion_mode: string
  objective_json: string | null
  finish_asked_at: number | null
  conflict_asked_at: number | null
  preemptible: number
  est_tokens: number | null
  cancel_json: string | null
  handoff_note: string | null
  hold_reason: string | null
  hold_until: number | null
  quota_override_until: number | null
  branch: string | null
  deleted_at: number | null
  created_at: number
  updated_at: number
  first_run_at: number | null
  last_run_ended_at: number | null
}

/**
 * Every read of a task, so a task always knows when work on it started and stopped.
 *
 * ⛔ Two correlated subqueries rather than two columns on `tasks`. Duration is a fact about the
 * *runs*, and a copy on the task would be one more thing to keep in step with them - the class of
 * bug migration 5 already had to repair once, on counters that only ever added.
 *
 * ⚠️ `last_run_ended_at` reads the **latest** run's `ended_at`, not `max(ended_at)`. `max` skips
 * nulls, so a task whose newest attempt is still running would inherit the end time of the attempt
 * before it and render as finished while it was working.
 */
const TASK_SELECT = `
  select t.*,
    (select min(started_at) from runs r where r.task_id = t.id) as first_run_at,
    (select r.ended_at from runs r where r.task_id = t.id
      order by r.started_at desc limit 1) as last_run_ended_at,
    (select r.worker_id from runs r where r.task_id = t.id
      order by r.started_at desc limit 1) as last_run_worker_id
  from tasks t`

/**
 * ⛔ **The timing is passed in, never computed here.** Active time needs the task's runs and every
 * question and approval raised during them; deriving it inside a per-row mapper would be the N+1
 * that `first_run_at`'s correlated subquery exists to avoid, on the list that re-renders on every
 * daemon event. `toTasks` batches it into two queries for any number of rows.
 *
 * ⚠️ The default is `ZERO_TIMING` — an honest "not measured" for the one caller that maps a row
 * purely to answer a routing predicate, and which never shows a duration. Anything an operator
 * reads must go through `toTasks`.
 */
function toTask(r: TaskRow, timing: ActiveTiming = ZERO_TIMING): Task {
  return {
    id: r.id,
    seq: r.seq,
    projectId: r.project_id,
    title: r.title,
    // ⚠️ Null on every row written before migration 29, and on every task the controller has never
    // been asked about. The renderer reads that as "show the title", not as missing data.
    titleSummary: r.title_summary ?? null,
    kind: (r.kind as TaskKind) ?? 'work',
    status: r.status as TaskStatus,
    priority: r.priority as Priority,
    createdBy: JSON.parse(r.created_by_json) as Principal,
    parentTaskId: r.parent_task_id,
    lineageDepth: r.lineage_depth,
    assignee: r.assignee,
    assigneeHint: r.assignee_hint,
    mandate: JSON.parse(r.mandate_json) as Mandate,
    budget: JSON.parse(r.budget_json) as Budget,
    dependsOn: dependenciesOf(r.id),
    notBefore: r.not_before,
    deadline: r.deadline,
    requires: JSON.parse(r.requires_json) as Task['requires'],
    constraints: JSON.parse(r.constraints_json) as TaskConstraints,
    verification: r.verification as Task['verification'],
    // ⚠️ Coalesced rather than trusted. A row written before migration 9 has no value, and `inherit`
    // is the honest reading of a task that has never expressed a preference.
    finishPolicy: (r.finish_policy || 'inherit') as Task['finishPolicy'],
    sessionSharing: (r.session_sharing || 'inherit') as Task['sessionSharing'],
    completionMode: (r.completion_mode || 'inherit') as Task['completionMode'],
    objective: r.objective_json ? (JSON.parse(r.objective_json) as Task['objective']) : 'inherit',
    finishAskedAt: r.finish_asked_at,
    conflictAskedAt: r.conflict_asked_at,
    preemptible: r.preemptible === 1,
    estTokens: r.est_tokens,
    cancel: r.cancel_json ? (JSON.parse(r.cancel_json) as Task['cancel']) : null,
    handoffNote: r.handoff_note,
    holdReason: r.hold_reason,
    holdUntil: r.hold_until,
    quotaOverrideUntil: r.quota_override_until,
    branch: r.branch,
    firstRunAt: r.first_run_at,
    lastRunEndedAt: r.last_run_ended_at,
    activeMs: timing.activeMs,
    activeSince: timing.activeSince,
    ranOn: r.last_run_worker_id ?? null,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** Rows to tasks, with active timing resolved for the whole set in two queries rather than 2N. */
function toTasks(list: TaskRow[]): Task[] {
  const timings = timingForTasks(list.map((r) => r.id))
  return list.map((r) => toTask(r, timings.get(r.id) ?? ZERO_TIMING))
}

function dependenciesOf(taskId: string): string[] {
  return rows<{ depends_on: string }>(
    db().prepare('select depends_on from task_deps where task_id = ?').all(taskId)
  ).map((r) => r.depends_on)
}

export function listTasks(opts: { includeDeleted?: boolean; projectId?: string } = {}): Task[] {
  const clauses: string[] = []
  const args: string[] = []
  if (!opts.includeDeleted) clauses.push('deleted_at is null')
  if (opts.projectId) {
    clauses.push('project_id = ?')
    args.push(opts.projectId)
  }
  const where = clauses.length ? `where ${clauses.map((c) => `t.${c}`).join(' and ')}` : ''
  return toTasks(
    rows<TaskRow>(db().prepare(`${TASK_SELECT} ${where} order by t.seq`).all(...args))
  )
}

/**
 * How many rows one page holds, whatever it was asked for.
 *
 * ⛔ A bound, not a preference. This is reachable from anything that can call the RPC, and an
 * unbounded page size is a request to serialise the whole table into a websocket frame — the same
 * trap `conversationLimit` exists for. Exported so the clamp is checkable without filing five
 * hundred tasks to observe it.
 */
export function taskPageSize(asked?: number): number {
  return Math.min(Math.max(asked ?? 50, 1), 200)
}

/**
 * One page of tasks, filtered by bucket.
 *
 * ⛔ Filtered and paged **here**, not in the renderer. The list re-fetches on every `task.changed`
 * the fleet emits — which on a working fleet is several a second — and shipping every task in a
 * project across that boundary each time to throw most of them away is a cost that grows with
 * exactly the thing this feature exists to survive.
 *
 * ⚠️ `views: []` means no filter, not "nothing matches". All is the empty selection; see TASK_VIEWS.
 */
export function pageTasks(
  opts: {
    projectId?: string
    includeDeleted?: boolean
    views?: readonly TaskView[]
    sort?: TaskSort
    /** `true` for ascending. Defaults to descending, which is what every column here wants. */
    asc?: boolean
    limit?: number
    offset?: number
  } = {}
): TaskPage {
  const clauses: string[] = []
  const args: Array<string | number> = []
  if (!opts.includeDeleted) clauses.push('t.deleted_at is null')
  if (opts.projectId) {
    clauses.push('t.project_id = ?')
    args.push(opts.projectId)
  }
  // ⚠️ The scope every count is taken over: the project and the deleted rule, but never the bucket
  // selection. Built before the status clause is added for exactly that reason.
  const scope = clauses.length ? `where ${clauses.join(' and ')}` : ''
  const scopeArgs = [...args]

  const statuses = statusesForViews(opts.views ?? [])
  if (statuses.length > 0) {
    clauses.push(`t.status in (${statuses.map(() => '?').join(',')})`)
    args.push(...statuses)
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : ''

  const total = (
    db().prepare(`select count(*) as n from tasks t ${where}`).get(...args) as { n: number }
  ).n

  // ⛔ `seq` is the tie-break on every sort, never the clock alone. Two tasks filed in the same
  // millisecond - which the plan decomposer does routinely - would otherwise come back in whatever
  // order SQLite felt like, and a pager over an unstable order silently drops and repeats rows
  // between pages.
  const column: Record<TaskSort, string> = {
    seq: 't.seq',
    created: 't.created_at',
    updated: 't.updated_at'
  }
  const dir = opts.asc ? 'asc' : 'desc'
  const order = `order by ${column[opts.sort ?? 'updated']} ${dir}, t.seq ${dir}`
  const limit = taskPageSize(opts.limit)
  // ⚠️ Clamped although SQLite already tolerates a negative OFFSET by ignoring it. That tolerance is
  // not something to build on, and no test can pin it — a test for this passed with the clamp
  // deleted, so it was removed rather than left standing as coverage nobody had.
  const offset = Math.max(opts.offset ?? 0, 0)

  const tasks = toTasks(
    rows<TaskRow>(
      db().prepare(`${TASK_SELECT} ${where} ${order} limit ? offset ?`).all(...args, limit, offset)
    )
  )

  const counts: Record<TaskView, number> = { active: 0, needs_you: 0, blocked: 0, done: 0, failed: 0 }
  const grouped = rows<{ status: TaskStatus; n: number }>(
    db().prepare(`select t.status, count(*) as n from tasks t ${scope} group by t.status`).all(...scopeArgs)
  )
  for (const g of grouped) {
    const view = viewForStatus(g.status)
    // ⚠️ A status in no bucket is dropped rather than being folded into the nearest one. It would be
    // a status somebody added without touching TASK_VIEWS, and quietly attributing its rows to a
    // bucket that does not contain them would make the chips disagree with the table they filter.
    if (view) counts[view] += g.n
  }

  return { tasks, total, counts }
}

export function getTask(id: string): Task | null {
  const r = row<TaskRow>(db().prepare(`${TASK_SELECT} where t.id = ?`).get(id))
  return r ? (toTasks([r])[0] ?? null) : null
}

export function requireTask(id: string): Task {
  const t = getTask(id)
  if (!t) throw new Error(`no task '${id}'`)
  return t
}

function nextSeq(): number {
  const r = db().prepare('select coalesce(max(seq), 0) as n from tasks').get() as { n: number }
  return r.n + 1
}

// ---------------------------------------------------------------------------- mandates

/**
 * Narrow a mandate for a child. ⛔ **Never widens.** A creator cannot grant an operation it does not
 * hold, and depth is spent, not reset - which is what stops a chain of agents from talking itself
 * back up to full authority one hop at a time.
 */
export function narrowMandate(parent: Mandate, requested?: Partial<Mandate>): Mandate {
  const allowed = (requested?.allowed ?? parent.allowed).filter((op) => parent.allowed.includes(op))
  return {
    allowed,
    projectIds: parent.projectIds,
    maxLineageDepth: Math.min(requested?.maxLineageDepth ?? parent.maxLineageDepth, parent.maxLineageDepth),
    maxChildren: Math.min(requested?.maxChildren ?? parent.maxChildren, parent.maxChildren)
  }
}

export function mandateAllows(task: Task, op: MandateOperation): boolean {
  return task.mandate.allowed.includes(op)
}

/**
 * A child's budget is a *share* of what the parent has left, not a fresh grant. However many nodes
 * a subtree grows, it cannot spend more than its root was given.
 */
function shareBudget(parent: Budget, share = 0.5): Budget {
  const remaining = Math.max(0, parent.grantedTokens - parent.spentTokens)
  return { grantedTokens: Math.floor(remaining * share), spentTokens: 0 }
}

// ---------------------------------------------------------------------------- creation

export interface CreateTaskInput {
  title: string
  projectId?: string | null
  createdBy?: Principal
  parentTaskId?: string | null
  priority?: Priority
  assigneeHint?: string | null
  dependsOn?: string[]
  notBefore?: number | null
  deadline?: number | null
  requires?: Task['requires']
  constraints?: TaskConstraints
  verification?: Task['verification']
  finishPolicy?: Task['finishPolicy']
  sessionSharing?: Task['sessionSharing']
  completionMode?: Task['completionMode']
  objective?: Task['objective']
  preemptible?: boolean
  estTokens?: number | null
  mandate?: Partial<Mandate>
  budgetTokens?: number
  status?: 'draft' | 'ready'
  kind?: TaskKind
  prompt?: string
  /** Images already uploaded through `attachment.create`, bound to this task's first message. */
  attachmentIds?: string[]
}

export function createTask(input: CreateTaskInput): Task {
  const title = input.title.trim()
  if (!title) throw new Error('a task needs a title')

  const createdBy: Principal = input.createdBy ?? { kind: 'human' }
  const parent = input.parentTaskId ? requireTask(input.parentTaskId) : null

  let mandate: Mandate
  let budget: Budget
  let lineageDepth = 0

  if (parent) {
    if (!mandateAllows(parent, 'spawn_tasks')) {
      throw new Error(`task ${parent.seq} has no authority to create tasks`)
    }
    lineageDepth = parent.lineageDepth + 1
    if (lineageDepth > parent.mandate.maxLineageDepth) {
      throw new Error(
        `lineage depth ${lineageDepth} exceeds the mandate limit of ${parent.mandate.maxLineageDepth}`
      )
    }
    const siblings = countChildren(parent.id)
    if (siblings >= parent.mandate.maxChildren) {
      throw new Error(`task ${parent.seq} has reached its fan-out cap of ${parent.mandate.maxChildren}`)
    }
    mandate = narrowMandate(parent.mandate, input.mandate)
    budget = shareBudget(parent.budget)
  } else {
    // A human-authored root task holds full authority by default; the controller narrows from there.
    mandate = narrowMandate(ROOT_MANDATE, input.mandate)
    budget = { grantedTokens: input.budgetTokens ?? 0, spentTokens: 0 }
  }

  // Near-duplicate merge at admission. Agents re-file the same idea; two rows for one intent is
  // noise, and noise is what makes a task list stop being read.
  const duplicate = findNearDuplicate(title, input.projectId ?? null)
  if (duplicate && createdBy.kind !== 'human') {
    log.info(`merged near-duplicate task "${title}" into t${duplicate.seq}`)
    addMessage(duplicate.id, 'system', `A duplicate of this task was filed and merged: "${title}".`)
    return duplicate
  }

  const id = randomUUID()
  const seq = nextSeq()
  const now = Date.now()

  db()
    .prepare(
      `insert into tasks (id, seq, project_id, title, kind, status, priority, created_by_json,
                          parent_task_id, lineage_depth, assignee_hint, mandate_json, budget_json,
                          not_before, deadline, requires_json, constraints_json, verification,
                          finish_policy, session_sharing, completion_mode, objective_json, preemptible, est_tokens,
                          created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      seq,
      input.projectId ?? parent?.projectId ?? null,
      title,
      input.kind ?? 'work',
      input.status ?? 'ready',
      input.priority ?? 'P2',
      JSON.stringify(createdBy),
      parent?.id ?? null,
      lineageDepth,
      input.assigneeHint ?? null,
      JSON.stringify(mandate),
      JSON.stringify(budget),
      input.notBefore ?? null,
      input.deadline ?? null,
      JSON.stringify(input.requires ?? []),
      JSON.stringify(input.constraints ?? {}),
      input.verification ?? 'auto',
      // ⚠️ `inherit` by default, which is not the same as picking the fleet value: a task that has
      // never expressed a preference follows its project as the project changes.
      input.finishPolicy ?? 'inherit',
      input.sessionSharing ?? 'inherit',
      input.completionMode ?? 'inherit',
      input.objective && input.objective !== 'inherit' ? JSON.stringify(input.objective) : null,
      input.preemptible === false ? 0 : 1,
      input.estTokens ?? null,
      now,
      now
    )

  for (const dep of input.dependsOn ?? []) addDependency(id, dep)
  const initialText = input.prompt?.trim() || title
  if (initialText) {
    const role: TaskMessage['role'] =
      createdBy.kind === 'human'
        ? 'human'
        : createdBy.kind === 'controller'
          ? 'controller'
          : 'agent'
    addMessage(id, role, initialText, null, input.attachmentIds ?? [])
  }

  const task = admit(id)
  log.info(`created task t${task.seq}: ${task.title}`)
  // ⚠️ Creation emitted nothing until 2026-08-26, so a new task existed for every pane that happened
  // to re-fetch and for no other. The list that filed it refreshed itself and looked correct, which
  // is what hid it: every *other* view - another window, a sidebar counting work with no project -
  // stayed stale until something unrelated changed.
  emit({ type: 'task.changed', task })
  return task
}

function countChildren(parentId: string): number {
  const r = db()
    .prepare('select count(*) as n from tasks where parent_task_id = ? and deleted_at is null')
    .get(parentId) as { n: number }
  return r.n
}

function findNearDuplicate(title: string, projectId: string | null): Task | null {
  const since = Date.now() - NEAR_DUPLICATE_WINDOW_MS
  const candidates = rows<TaskRow>(
    db()
      .prepare(
        `select * from tasks
          where deleted_at is null and created_at > ?
            and status not in ('completed','cancelled','failed')
            and (project_id is ? or ? is null)`
      )
      .all(since, projectId, projectId)
  )
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const target = norm(title)
  const found = candidates.find((c) => norm(c.title) === target)
  return found ? (toTasks([found])[0] ?? null) : null
}

// ---------------------------------------------------------------------------- dependencies

/**
 * Add an edge, rejecting anything that would close a cycle. Checked here rather than at dispatch
 * because a cycle discovered by the scheduler is a deadlock; a cycle discovered at the edge is an
 * error message.
 */
export function addDependency(taskId: string, dependsOn: string): void {
  if (taskId === dependsOn) throw new Error('a task cannot depend on itself')
  requireTask(taskId)
  requireTask(dependsOn)
  if (reaches(dependsOn, taskId)) {
    throw new Error('that dependency would create a cycle')
  }
  db()
    .prepare('insert or ignore into task_deps (task_id, depends_on) values (?, ?)')
    .run(taskId, dependsOn)
}

export function removeDependency(taskId: string, dependsOn: string): void {
  db().prepare('delete from task_deps where task_id = ? and depends_on = ?').run(taskId, dependsOn)
}

/**
 * Add an edge **by hand**, and let admission act on it at once.
 *
 * ⛔ `addDependency` is the edge write and nothing else - it runs inside `createTask`, before the
 * row has a derived status to recompute. A person adding a prerequisite to a task that already
 * exists is asking for two things: the edge, and the consequence. Without the `admit()` here a
 * `ready` task handed a fresh unmet prerequisite would sit in the queue and be dispatched, which is
 * the exact failure `admitDependents` was written to fix at the other end of the same edge.
 *
 * ⚠️ `admit()` refuses every status in `TERMINAL_OR_HELD`, so this does **not** claw back a run
 * already in flight - deliberately. The edge is recorded and takes effect on the next dispatch; the
 * system message says so, because a control that silently did nothing would be worse than one that
 * refused.
 */
export function attachDependency(taskId: string, dependsOn: string): Task {
  const before = requireTask(taskId)
  const dep = requireTask(dependsOn)
  addDependency(taskId, dependsOn)
  const task = admit(taskId)
  addMessage(
    taskId,
    'system',
    task.status === 'blocked' && before.status !== 'blocked'
      ? `Now waits on t${dep.seq}: ${dep.title}. Admitted automatically when it completes.`
      : `Now waits on t${dep.seq}: ${dep.title}.` +
        (TERMINAL_OR_HELD.includes(before.status) && before.status !== 'draft'
          ? ' This task is past admission, so the prerequisite applies to its next dispatch.'
          : '')
  )
  // ⚠️ Emitted even when the status did not move. `setStatus` emits on a transition; an edge added
  // to a running task is a change to the task nothing else would broadcast, and the pane showing it
  // is the one the person is looking at.
  const latest = requireTask(taskId)
  emit({ type: 'task.changed', task: latest })
  log.info(`t${latest.seq} now depends on t${dep.seq}`)
  return latest
}

/** Drop an edge by hand, re-admitting in case it was the last thing holding the task. */
export function detachDependency(taskId: string, dependsOn: string): Task {
  requireTask(taskId)
  const dep = getTask(dependsOn)
  removeDependency(taskId, dependsOn)
  admit(taskId)
  const task = requireTask(taskId)
  addMessage(
    taskId,
    'system',
    dep ? `No longer waits on t${dep.seq}: ${dep.title}.` : 'A prerequisite was removed.'
  )
  emit({ type: 'task.changed', task })
  log.info(`t${task.seq} no longer depends on ${dep ? `t${dep.seq}` : dependsOn}`)
  return task
}

/** Is `to` reachable from `from` by following dependency edges? */
function reaches(from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    if (current === to) return true
    stack.push(...dependenciesOf(current))
  }
  return false
}

export function dependentsOf(taskId: string): string[] {
  return rows<{ task_id: string }>(
    db().prepare('select task_id from task_deps where depends_on = ?').all(taskId)
  ).map((r) => r.task_id)
}

/**
 * How many tasks are actually held up by this one.
 *
 * ⛔ `blocked` only, and deleted rows excluded. A dependent that has already run is released by
 * nothing — counting it would tell an operator that finishing this task frees work which is in fact
 * long finished, on the one screen where that number decides which button they press.
 */
export function blockedDependentsOf(taskId: string): number {
  const r = db()
    .prepare(
      `select count(*) as n from task_deps d join tasks t on t.id = d.task_id
        where d.depends_on = ? and t.status = 'blocked' and t.deleted_at is null`
    )
    .get(taskId) as { n: number }
  return r.n
}

// ---------------------------------------------------------------------------- admission

/** Statuses admission must not touch: they were reached deliberately and are not derived. */
const TERMINAL_OR_HELD: TaskStatus[] = [
  'draft',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota',
  'paused_user',
  'cancelling',
  'cancelled',
  'completed',
  'failed'
]

/**
 * Recompute a task's derived status. `blocked`, `scheduled` and `ready` are *facts about the world*
 * - unmet dependencies, a future start time, neither - and are never set by hand.
 */
export function admit(taskId: string): Task {
  const task = requireTask(taskId)
  if (TERMINAL_OR_HELD.includes(task.status)) return task

  const unmet = task.dependsOn.filter((id) => {
    const dep = getTask(id)
    return !dep || dep.status !== 'completed'
  })

  const next: TaskStatus = unmet.length
    ? 'blocked'
    : task.notBefore && task.notBefore > Date.now()
      ? 'scheduled'
      : 'ready'

  return next === task.status ? task : setStatus(taskId, next)
}

/**
 * Re-admit everything waiting on this task. Called whenever a task reaches a terminal state.
 *
 * ⛔ `admit()`, which recomputes each dependent's status **from the world**. The scheduler carried a
 * private copy of this for months that re-set each dependent to the status it already had — a no-op
 * dressed as an admission — so a completed task never unblocked anything and the DAG never advanced
 * past its first edge. Found 2026-08-27 by a test written for something else entirely. The correct
 * implementation was here, exported, and called by nobody.
 *
 * ⚠️ Nothing else re-admits a `blocked` task: `admitScheduled()` only looks at `scheduled` ones. This
 * is the single path, so a second copy of it is a second chance to get it wrong.
 */
export function admitDependents(taskId: string): void {
  for (const id of dependentsOf(taskId)) admit(id)
}

/**
 * The other half of the clock tick: a quota pause whose reset has arrived.
 *
 * ⛔ **Nothing did this, and three places said it did.** `preempt` parks a task as `paused_quota`
 * carrying `not_before = resetsAt`, and its own comment reads *"it carries `not_before = resets_at`
 * and resumes itself"*. It did not. `admitScheduled` selects `status = 'scheduled'` only; `admit`
 * refuses every status in `TERMINAL_OR_HELD`, which includes this one; and `resumeTask` accepts only
 * `paused_user` and `cancelled`. So `not_before` on a `paused_quota` row was read by **nothing** —
 * the task's thread promised *"Resuming automatically after the reset"*, Settings promised it
 * restarts itself, and the only way out was for a person to type something at it.
 *
 * ⭐ Measured on t60, 2026-08-31: paused 05:09:25Z with `not_before` 06:40:00Z, still `paused_quota`
 * at 06:44:50Z — five minutes past its own resume time, on a worker whose window had reset.
 *
 * ⚠️ It goes to `ready`, not straight to a worker: the dispatch gate re-reads the quota and may
 * still decline, which is the honest outcome and a visible one — a task held at `ready` carries the
 * reason on its row, where `paused_quota` for ever carried nothing.
 *
 * ⚠️ A null `not_before` resumes too, matching `admitScheduled`'s own predicate. A quota pause with
 * no reset time has no other way out at all, and leaving it parked for ever is the worse of the two
 * wrong answers.
 */
export function resumeQuotaPaused(released?: (task: Task) => string | null): number {
  const parked = rows<TaskRow>(
    db().prepare("select * from tasks where status = 'paused_quota'").all()
  )
  const now = Date.now()
  let resumed = 0
  for (const r of parked) {
    const onTime = r.not_before === null || r.not_before <= now
    // ⭐ **A clock is evidence, not the only evidence.** `not_before` is a *prediction* made at the
    // moment of parking, and on the overrun path it can be a pure guess — a rate-limit warning with
    // no reset time attached parks the task five hours out by arithmetic, not by measurement. So a
    // task whose account has since been read and found to be *empty* stayed parked for hours with
    // 0% used and no button; that is the failure this second test exists for. Measured by hand on
    // 2026-08-31: a manual probe read 0% of the window and nothing resumed.
    //
    // ⚠️ The predicate is passed in rather than computed here, because deciding whether a *worker*
    // has room is the scheduler's question and it needs the model, the pool and the gate to answer
    // it. This module owns only the transition.
    const early = onTime ? null : released?.(toTask(r)) ?? null
    if (!onTime && !early) continue

    db().prepare('update tasks set not_before = null where id = ?').run(r.id)
    addMessage(
      r.id,
      'system',
      early
        ? `Back in the queue ahead of its own timer: ${early} The dispatch gate reads the quota ` +
            'again, so a worker still over its limit will hold this rather than run it.'
        : 'The quota window this task was waiting on has reset. Back in the queue — the dispatch ' +
            'gate reads the quota again, so a worker still over its limit will hold it rather than ' +
            'run it.'
    )
    setStatus(r.id, 'ready', { assignee: null })
    resumed += 1
  }
  return resumed
}

/**
 * Every task parked on a quota window, with the account it is waiting on and when it is due back.
 *
 * ⛔ What the quota poller schedules its next look from. A task parked until 06:39 whose account is
 * next read at 06:58 is a task that waited nineteen minutes past its own release for nothing, on a
 * fleet whose entire premise is unattended progress across windows.
 */
export function quotaParkedTasks(): Array<{ task: Task; workerId: string | null; at: number | null }> {
  return listTasks()
    .filter((t) => t.status === 'paused_quota')
    .map((task) => ({ task, workerId: task.ranOn ?? task.assignee ?? null, at: task.notBefore ?? null }))
}

/** The scheduler's clock tick: `scheduled` tasks whose `not_before` has arrived become `ready`. */
export function admitScheduled(): number {
  const due = rows<TaskRow>(
    db()
      .prepare("select * from tasks where status = 'scheduled' and (not_before is null or not_before <= ?)")
      .all(Date.now())
  )
  for (const r of due) admit(r.id)
  return due.length
}

export function setStatus(taskId: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  const current = requireTask(taskId)
  // ⚠️ `'assignee' in extra`, not `?? current`. A task going back into the queue has to *lose* its
  // assignee, and coalesce cannot express that - it read a deliberate `null` as "leave it alone",
  // which left a re-routed task showing the worker that had just failed to run it.
  const assignee = 'assignee' in extra ? (extra.assignee ?? null) : current.assignee
  db()
    .prepare(
      `update tasks set status = ?, assignee = ?, branch = coalesce(?, branch),
                        handoff_note = coalesce(?, handoff_note), hold_reason = ?, hold_until = ?,
                        updated_at = ?
        where id = ?`
    )
    .run(
      status,
      assignee,
      extra.branch ?? null,
      extra.handoffNote ?? null,
      // ⛔ Set here or cleared here, never left over. A reason belongs to the state that produced it,
      // so it moves atomically with the status: a caller that has one passes it, and every caller
      // that does not clears whatever the last state was explaining.
      extra.holdReason ?? null,
      // ⚠️ And its clock with it. `hold_until` says when the sentence in `hold_reason` stops being
      // true; carrying one over a transition would leave a deadline explaining a hold that ended.
      extra.holdUntil ?? null,
      Date.now(),
      taskId
    )
  const task = requireTask(taskId)
  emit({ type: 'task.changed', task })
  // ⛔ The spine of the log. A task's life is a sequence of these transitions and nothing was
  // recording them, so the log could show a dispatch and a failure with no account of the states in
  // between — and after a restart there was no way to reconstruct what a task had been through.
  // ⚠️ Only on a real change: `setStatus` is also how a status is *re-*written with new fields, and
  // logging `running -> running` on every one of those would bury the transitions that matter.
  if (current.status !== status) {
    log.info(
      `t${task.seq} ${current.status} -> ${status}` +
        (task.holdReason ? ` (${task.holdReason})` : '') +
        (assignee && assignee !== current.assignee ? ` on ${assignee.slice(0, 8)}` : '')
    )
  }
  return task
}

/**
 * Say why a task that is eligible to run is not running.
 *
 * ⛔ Not a status. The task really is `ready` - the scheduler would dispatch it this second if a
 * worker could take it - and inventing a status for "ready but nothing free" would put a lie in the
 * DAG to fix a gap in the UI. This is the *reason*, attached to the state that is already true.
 *
 * ⚠️ Writes only on a change, and every `setStatus` clears it. A tick that finds the same three
 * workers still at capacity must not emit a task event every ten seconds for as long as they are.
 */
export function setHoldReason(taskId: string, reason: string | null, until: number | null = null): void {
  const current = getTask(taskId)
  // ⚠️ Both halves compared, because they change independently: a hold whose sentence is unchanged
  // can still have acquired a clock — the second tick after a quota reading arrives says the same
  // words about a window it can now name the reset of.
  if (!current || (current.holdReason === reason && current.holdUntil === until)) return
  db()
    .prepare('update tasks set hold_reason = ?, hold_until = ? where id = ?')
    .run(reason, until, taskId)
  const task = getTask(taskId)
  if (task) emit({ type: 'task.changed', task })
}

/**
 * Record a person's decision to spend into a nearly-full window on this task.
 *
 * ⛔ **Written as a deadline taken from the window it overrules**, so the permission cannot outlive
 * its own reason. `null` withdraws it. See `Task.quotaOverrideUntil` for what it does and — more
 * importantly — the four gates it deliberately does not touch.
 */
export function setQuotaOverride(taskId: string, until: number | null): Task {
  requireTask(taskId)
  db()
    .prepare('update tasks set quota_override_until = ?, updated_at = ? where id = ?')
    .run(until, Date.now(), taskId)
  const task = requireTask(taskId)
  emit({ type: 'task.changed', task })
  return task
}

/** Is a person's quota override on this task still live? ⚠️ One reading of the clock, everywhere. */
export function quotaOverridden(task: Task, now = Date.now()): boolean {
  return task.quotaOverrideUntil !== null && task.quotaOverrideUntil > now
}

export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | 'title'
      | 'titleSummary'
      | 'priority'
      | 'projectId'
      | 'notBefore'
      | 'deadline'
      | 'assigneeHint'
      | 'verification'
      | 'finishPolicy'
      | 'sessionSharing'
      | 'completionMode'
      | 'objective'
      | 'preemptible'
      | 'estTokens'
      | 'constraints'
    >
  > & { prompt?: string }
): Task {
  const current = requireTask(id)
  const nextTitle = patch.title !== undefined ? patch.title.trim() || current.title : current.title
  /**
   * ⛔ **Rewriting the title drops the summary.** A label is a claim about a particular piece of
   * text; once an operator edits that text the old one-line description is a statement about work
   * nobody asked for any more, and a stale label is worse than none because the board still looks
   * authoritative. Cleared rather than re-derived, because re-deriving costs a controller turn and
   * the honest fallback - showing the new title - is already right.
   *
   * ⚠️ An explicit `titleSummary` in the same patch wins: that is the controller writing a label for
   * a title it has just read, which is the one case where the two are in step.
   */
  const nextSummary =
    patch.titleSummary !== undefined
      ? patch.titleSummary?.trim() || null
      : nextTitle === current.title
        ? current.titleSummary
        : null
  db()
    .prepare(
      `update tasks set title = ?, title_summary = ?, priority = ?, project_id = ?,
                        not_before = ?, deadline = ?,
                        assignee_hint = ?, verification = ?, finish_policy = ?,
                        session_sharing = ?, completion_mode = ?, objective_json = ?, preemptible = ?,
                        est_tokens = ?, constraints_json = ?, updated_at = ?
        where id = ?`
    )
    .run(
      nextTitle,
      nextSummary,
      patch.priority ?? current.priority,
      patch.projectId !== undefined ? patch.projectId : current.projectId,
      patch.notBefore !== undefined ? patch.notBefore : current.notBefore,
      patch.deadline !== undefined ? patch.deadline : current.deadline,
      patch.assigneeHint !== undefined ? patch.assigneeHint : current.assigneeHint,
      patch.verification ?? current.verification,
      patch.finishPolicy ?? current.finishPolicy,
      patch.sessionSharing ?? current.sessionSharing,
      patch.completionMode ?? current.completionMode,
      patch.objective !== undefined
        ? patch.objective === 'inherit' || patch.objective === null
          ? null
          : JSON.stringify(patch.objective)
        : current.objective === 'inherit' || !current.objective
          ? null
          : JSON.stringify(current.objective),
      (patch.preemptible ?? current.preemptible) ? 1 : 0,
      patch.estTokens !== undefined ? patch.estTokens : current.estTokens,
      JSON.stringify(patch.constraints ?? current.constraints),
      Date.now(),
      id
    )

  if (patch.prompt !== undefined) {
    const promptText = patch.prompt.trim() || patch.title?.trim() || current.title
    const firstMsg = db()
      .prepare('select id from task_messages where task_id = ? order by ts, id limit 1')
      .get(id) as { id: number } | undefined
    if (firstMsg) {
      db().prepare('update task_messages set text = ? where id = ?').run(promptText, firstMsg.id)
    } else if (promptText) {
      addMessage(id, 'human', promptText)
    }
  }

  const task = admit(id)
  emit({ type: 'task.changed', task })
  return task
}

/** The note a preempted or cancelled run leaves so its successor does not rediscover the branch. */
export function setTaskHandoff(taskId: string, note: string): void {
  db().prepare('update tasks set handoff_note = ?, updated_at = ? where id = ?')
    .run(note, Date.now(), taskId)
  const task = getTask(taskId)
  if (task) emit({ type: 'task.changed', task })
}

/** Leaving `draft` re-enters admission, which is what makes "not like this" a real resting state. */
export function promoteDraft(id: string): Task {
  const task = requireTask(id)
  if (task.status !== 'draft') return task
  setStatus(id, 'ready')
  return admit(id)
}

// ---------------------------------------------------------------------------- thread

/**
 * Put a message on a task's thread.
 *
 * ⛔ `attachmentIds` are bound in the same call that writes the row, never afterwards. An
 * attachment belongs to *a message*: bound later it would be an image sitting in the thread with no
 * position in it, and `promptFor` — which decides what travels by asking which messages are
 * outstanding — would have nothing to hang it on.
 */
export function addMessage(
  taskId: string,
  role: TaskMessage['role'],
  text: string,
  runId: string | null = null,
  attachmentIds: string[] = []
): number {
  const info = db()
    .prepare('insert into task_messages (task_id, role, text, run_id, ts) values (?,?,?,?,?)')
    .run(taskId, role, text, runId, Date.now())
  const id = Number(info.lastInsertRowid)
  if (attachmentIds.length > 0) bindAttachments(attachmentIds, taskId, id)
  return id
}

export function messagesFor(taskId: string): TaskMessage[] {
  const messages = rows<{
    id: number
    task_id: string
    role: string
    text: string
    run_id: string | null
    delivered_at: number | null
    ts: number
  }>(db().prepare('select * from task_messages where task_id = ? order by ts, id').all(taskId))
  // ⚠️ One query for every attachment on the thread, not one per message. This runs on the path
  // that renders a task page, which re-renders on every daemon event.
  const attachments = attachmentsFor(messages.map((r) => r.id))
  return messages.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    role: r.role as TaskMessage['role'],
    text: r.text,
    runId: r.run_id,
    deliveredAt: r.delivered_at,
    ts: r.ts,
    attachments: attachments.get(r.id) ?? []
  }))
}

/**
 * The last message added to a task, by row id. Used to mark a note delivered the moment it lands in
 * a live session rather than guessing at it later by timestamp.
 */
export function lastMessageId(taskId: string): number | null {
  const r = db()
    .prepare('select max(id) as id from task_messages where task_id = ?')
    .get(taskId) as { id: number | null }
  return r.id ?? null
}

export function markDelivered(ids: number[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  const stmt = db().prepare('update task_messages set delivered_at = ? where id = ?')
  for (const id of ids) stmt.run(now, id)
}

// ---------------------------------------------------------------------------- runs

interface RunRow {
  id: string
  task_id: string | null
  project_id: string | null
  session_id: string | null
  worker_id: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  quota_unverified: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_model_id: string | null
  note: string | null
  quota_before_json: string | null
  quota_after_json: string | null
  objective_json?: string | null
  started_warm: number | null
  adapter_id?: string | null
  model?: string | null
  trunk_sha_before?: string | null
  prompt?: string | null
}

/**
 * ⛔ `blockedMs` is passed in for the same reason `toTask` takes its timing: it needs the questions
 * and approvals raised during this run, and a query per row would run once per run of every task in
 * the ledger. `toRuns` batches it; the default is a measured-nothing rather than a guess, and is
 * only reached by the single-row readers the scheduler uses, which never render a duration.
 */
function toRun(r: RunRow, blockedMs = 0): Run {
  return {
    id: r.id,
    taskId: r.task_id ?? '',
    sessionId: r.session_id,
    workerId: r.worker_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome as RunOutcome | null,
    quotaUnverified: r.quota_unverified === 1,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    costModelId: r.cost_model_id,
    note: r.note,
    quotaBefore: r.quota_before_json ? (JSON.parse(r.quota_before_json) as RunQuota) : null,
    quotaAfter: r.quota_after_json ? (JSON.parse(r.quota_after_json) as RunQuota) : null,
    objective: r.objective_json ? (JSON.parse(r.objective_json) as Objective) : null,
    trunkShaBefore: r.trunk_sha_before ?? null,
    // ⛔ Null is not false. Every run that predates the column recorded nothing, and saying `cold`
    // for those would be a measurement nobody took.
    startedWarm: r.started_warm === null ? null : r.started_warm === 1,
    adapterId: r.adapter_id ?? null,
    model: r.model ?? null,
    prompt: r.prompt ?? null,
    blockedMs
  }
}

/** Rows to runs, with the time each spent waiting on a person resolved for the whole set at once. */
function toRuns(list: RunRow[]): Run[] {
  const timings = timingForRuns(
    list.map((r) => ({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at }))
  )
  return list.map((r) => toRun(r, timings.get(r.id)?.blockedMs ?? 0))
}

/**
 * Attach a quota reading to a run.
 *
 * ⛔ Two calls, never one. `before` is written at dispatch and `after` once the run has ended; a run
 * carrying only one of them is a number with nothing to subtract from, which is what the UI used to
 * show. The caller decides *when*, because the two readings are taken for different reasons and at
 * moments only the scheduler knows.
 */
export function setRunQuota(runId: string, which: 'before' | 'after', quota: RunQuota | null): void {
  const column = which === 'before' ? 'quota_before_json' : 'quota_after_json'
  db()
    .prepare(`update runs set ${column} = ? where id = ?`)
    .run(quota ? JSON.stringify(quota) : null, runId)
  const run = row<RunRow>(db().prepare('select * from runs where id = ?').get(runId))
  if (run) emit({ type: 'run.changed', run: toRun(run) })
}

export function startRun(input: {
  taskId: string
  workerId: string
  sessionId: string | null
  projectId: string | null
  quotaUnverified: boolean
  costModelId: string | null
  /**
   * Did this run inherit a conversation, or build one from nothing?
   *
   * ⚠️ Two ways to be warm and they cost the same: continuing in a session that never closed, and
   * resuming one that did. Both skip the cold prefix, which is what this records.
   */
  startedWarm?: boolean | undefined
  /**
   * Where the trunk's landing target stood as this run began.
   *
   * ⚠️ Undefined where no reading could be taken — a projectless task, a non-git project, a target
   * that does not resolve. The finish check reads null as "cannot say" and declines to fire.
   */
  trunkShaBefore?: string | null | undefined
  /** The actual prompt sent to the agent CLI for this run. */
  prompt?: string | null | undefined
  /** The effective optimization objective vector active when this run was dispatched. */
  objective?: Objective | null | undefined
}): Run {
  const id = randomUUID()
  const key = runKey(input.workerId, input.sessionId)
  db()
    .prepare(
      `insert into runs (id, task_id, project_id, session_id, worker_id, started_at,
                         quota_unverified, cost_model_id, started_warm, adapter_id, model,
                         trunk_sha_before, prompt, objective_json)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.taskId,
      input.projectId,
      input.sessionId,
      input.workerId,
      Date.now(),
      input.quotaUnverified ? 1 : 0,
      input.costModelId,
      input.startedWarm === undefined ? null : input.startedWarm ? 1 : 0,
      // ⛔ Stamped here rather than joined later. The session this run is about to use will be closed
      // and eventually rewritten; the record of who spent the tokens has to outlive it, because the
      // estimator's per-agent factor is only as good as the key on the oldest run it can still read.
      key.adapterId,
      key.model,
      input.trunkShaBefore ?? null,
      input.prompt ?? null,
      input.objective ? JSON.stringify(input.objective) : null
    )
  const run = requireRun(id)
  emit({ type: 'run.changed', run })
  return run
}

/**
 * Which agent and model a run is about to be charged to.
 *
 * ⚠️ The model is read from the session and is often still null at dispatch: Antigravity names its
 * own model on the transcript's first usage record, so nothing knows it until a turn has landed.
 * `finishRun` asks again. Null after that is a real answer - a run that never said what it was.
 */
function runKey(workerId: string, sessionId: string | null): {
  adapterId: string | null
  model: string | null
} {
  const session = sessionId
    ? (db().prepare('select adapter_id, model from sessions where id = ?').get(sessionId) as
        | { adapter_id: string; model: string | null }
        | undefined)
    : undefined
  if (session) return { adapterId: session.adapter_id, model: session.model }
  const worker = db().prepare('select adapter_id from workers where id = ?').get(workerId) as
    | { adapter_id: string }
    | undefined
  return { adapterId: worker?.adapter_id ?? null, model: null }
}

export function finishRun(id: string, outcome: RunOutcome, note?: string): Run {
  db()
    .prepare('update runs set ended_at = ?, outcome = ?, note = coalesce(?, note) where id = ?')
    .run(Date.now(), outcome, note ?? null, id)
  // ⛔ Asked a second time, because the first answer was taken before the run had spoken. A session
  // learns its model from the transcript, so on every provider that names its own this is where the
  // key is actually filled in. `coalesce` never overwrites what dispatch already knew.
  db()
    .prepare(
      `update runs
          set adapter_id = coalesce(adapter_id,
                (select s.adapter_id from sessions s where s.id = runs.session_id)),
              model = coalesce(model,
                (select s.model from sessions s where s.id = runs.session_id))
        where id = ?`
    )
    .run(id)
  const run = requireRun(id)
  emit({ type: 'run.changed', run })
  return run
}

export function requireRun(id: string): Run {
  const r = row<RunRow>(db().prepare('select * from runs where id = ?').get(id))
  if (!r) throw new Error(`no run '${id}'`)
  return toRun(r)
}

export function runsFor(taskId: string): Run[] {
  return toRuns(
    rows<RunRow>(
      db().prepare('select * from runs where task_id = ? order by started_at desc').all(taskId)
    )
  )
}

/**
 * The most recent run this conversation served, open or closed.
 *
 * ⛔ Deliberately not `runForSession`, which returns **open** runs only and is the right question
 * when asking whether somebody is talking in a session right now. This asks the other question —
 * *whose work is this conversation about* — and the answer has to survive the run ending, because
 * the interesting things that happen to a conversation between runs (it is compacted, it is revived,
 * it lapses) all happen when there is no open run at all.
 */
export function lastRunForSession(sessionId: string): Run | null {
  const r = row<RunRow>(
    db()
      .prepare('select * from runs where session_id = ? order by started_at desc limit 1')
      .get(sessionId)
  )
  return r ? toRun(r) : null
}

export function runForSession(sessionId: string): Run | null {
  const r = row<RunRow>(
    db()
      .prepare('select * from runs where session_id = ? and ended_at is null order by started_at desc')
      .get(sessionId)
  )
  return r ? toRun(r) : null
}

/**
 * Fold a metered turn into its run and its task's budget. This is the only place spend is recorded,
 * so a run's totals always match the transcript rather than an estimate.
 */
export function creditTurn(
  sessionId: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
): void {
  const run = runForSession(sessionId)
  if (!run) return
  db()
    .prepare(
      `update runs set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
                       cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?
        where id = ?`
    )
    .run(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, run.id)

  if (run.taskId) {
    const task = getTask(run.taskId)
    if (task) {
      const spent =
        task.budget.spentTokens + tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
      db()
        .prepare('update tasks set budget_json = ? where id = ?')
        .run(JSON.stringify({ ...task.budget, spentTokens: spent }), task.id)
    }
  }
}

// ---------------------------------------------------------------------------- ordering

/** Highest priority first, then the nearest deadline, then oldest. Deterministic and cheap. */
export function schedulingOrder(a: Task, b: Task): number {
  const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  if (byPriority !== 0) return byPriority
  const aDue = a.deadline ?? Number.POSITIVE_INFINITY
  const bDue = b.deadline ?? Number.POSITIVE_INFINITY
  if (aDue !== bDue) return aDue - bDue
  return a.seq - b.seq
}

/**
 * Record that the finish instruction has been sent, so it is never sent twice.
 *
 * ⛔ Written *before* the prompt goes out, not after. A send that throws still counts as an ask: the
 * failure path hands the task to a person, and a retry loop that re-asked on every error would be
 * the same runaway the preemption guard exists to prevent.
 */
export function markFinishAsked(taskId: string): void {
  db().prepare('update tasks set finish_asked_at = ?, updated_at = ? where id = ?').run(
    Date.now(),
    Date.now(),
    taskId
  )
}

/**
 * Record that the conflict-resolution instruction has been sent, so it is never sent twice.
 *
 * ⛔ Separate from `markFinishAsked` on purpose — see the migration. Written *before* the prompt
 * goes out, for the same reason: a send that throws still counts as an ask, and the failure path
 * hands the task to a person rather than trying again.
 */
export function markConflictAsked(taskId: string): void {
  db().prepare('update tasks set conflict_asked_at = ?, updated_at = ? where id = ?').run(
    Date.now(),
    Date.now(),
    taskId
  )
}
