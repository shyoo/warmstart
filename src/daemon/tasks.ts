import { randomUUID } from 'node:crypto'
import {
  PRIORITY_ORDER,
  ROOT_MANDATE,
  type Budget,
  type Mandate,
  type MandateOperation,
  type Principal,
  type Priority,
  type Run,
  type RunOutcome,
  type RunQuota,
  type Task,
  type TaskConstraints,
  type TaskKind,
  type TaskMessage,
  type TaskStatus
} from '@shared/tasks.js'
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
  kind: string
  status: string
  priority: string
  created_by_json: string
  parent_task_id: string | null
  lineage_depth: number
  assignee: string | null
  assignee_hint: string | null
  mandate_json: string
  budget_json: string
  not_before: number | null
  deadline: number | null
  requires_json: string
  constraints_json: string
  verification: string
  preemptible: number
  est_tokens: number | null
  cancel_json: string | null
  handoff_note: string | null
  hold_reason: string | null
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
      order by r.started_at desc limit 1) as last_run_ended_at
  from tasks t`

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    seq: r.seq,
    projectId: r.project_id,
    title: r.title,
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
    preemptible: r.preemptible === 1,
    estTokens: r.est_tokens,
    cancel: r.cancel_json ? (JSON.parse(r.cancel_json) as Task['cancel']) : null,
    handoffNote: r.handoff_note,
    holdReason: r.hold_reason,
    branch: r.branch,
    firstRunAt: r.first_run_at,
    lastRunEndedAt: r.last_run_ended_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
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
  return rows<TaskRow>(
    db().prepare(`${TASK_SELECT} ${where} order by t.seq`).all(...args)
  ).map(toTask)
}

export function getTask(id: string): Task | null {
  const r = row<TaskRow>(db().prepare(`${TASK_SELECT} where t.id = ?`).get(id))
  return r ? toTask(r) : null
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
  preemptible?: boolean
  estTokens?: number | null
  mandate?: Partial<Mandate>
  budgetTokens?: number
  status?: 'draft' | 'ready'
  kind?: TaskKind
  prompt?: string
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
                          preemptible, est_tokens, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      input.preemptible === false ? 0 : 1,
      input.estTokens ?? null,
      now,
      now
    )

  for (const dep of input.dependsOn ?? []) addDependency(id, dep)
  if (input.prompt?.trim()) {
    addMessage(id, createdBy.kind === 'human' ? 'human' : 'agent', input.prompt.trim())
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
  return found ? toTask(found) : null
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

/** Re-admit everything waiting on this task. Called whenever a task reaches a terminal state. */
export function admitDependents(taskId: string): void {
  for (const id of dependentsOf(taskId)) admit(id)
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
                        handoff_note = coalesce(?, handoff_note), hold_reason = null, updated_at = ?
        where id = ?`
    )
    .run(status, assignee, extra.branch ?? null, extra.handoffNote ?? null, Date.now(), taskId)
  const task = requireTask(taskId)
  emit({ type: 'task.changed', task })
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
export function setHoldReason(taskId: string, reason: string | null): void {
  const current = getTask(taskId)
  if (!current || current.holdReason === reason) return
  db().prepare('update tasks set hold_reason = ? where id = ?').run(reason, taskId)
  const task = getTask(taskId)
  if (task) emit({ type: 'task.changed', task })
}

export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | 'title'
      | 'priority'
      | 'projectId'
      | 'notBefore'
      | 'deadline'
      | 'assigneeHint'
      | 'verification'
      | 'preemptible'
      | 'estTokens'
      | 'constraints'
    >
  >
): Task {
  const current = requireTask(id)
  db()
    .prepare(
      `update tasks set title = ?, priority = ?, project_id = ?, not_before = ?, deadline = ?,
                        assignee_hint = ?, verification = ?, preemptible = ?, est_tokens = ?,
                        constraints_json = ?, updated_at = ?
        where id = ?`
    )
    .run(
      patch.title?.trim() || current.title,
      patch.priority ?? current.priority,
      patch.projectId !== undefined ? patch.projectId : current.projectId,
      patch.notBefore !== undefined ? patch.notBefore : current.notBefore,
      patch.deadline !== undefined ? patch.deadline : current.deadline,
      patch.assigneeHint !== undefined ? patch.assigneeHint : current.assigneeHint,
      patch.verification ?? current.verification,
      (patch.preemptible ?? current.preemptible) ? 1 : 0,
      patch.estTokens !== undefined ? patch.estTokens : current.estTokens,
      JSON.stringify(patch.constraints ?? current.constraints),
      Date.now(),
      id
    )
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

export function addMessage(
  taskId: string,
  role: TaskMessage['role'],
  text: string,
  runId: string | null = null
): void {
  db()
    .prepare('insert into task_messages (task_id, role, text, run_id, ts) values (?,?,?,?,?)')
    .run(taskId, role, text, runId, Date.now())
}

export function messagesFor(taskId: string): TaskMessage[] {
  return rows<{
    id: number
    task_id: string
    role: string
    text: string
    run_id: string | null
    delivered_at: number | null
    ts: number
  }>(db().prepare('select * from task_messages where task_id = ? order by ts, id').all(taskId)).map(
    (r) => ({
      id: r.id,
      taskId: r.task_id,
      role: r.role as TaskMessage['role'],
      text: r.text,
      runId: r.run_id,
      deliveredAt: r.delivered_at,
      ts: r.ts
    })
  )
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
}

function toRun(r: RunRow): Run {
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
    quotaAfter: r.quota_after_json ? (JSON.parse(r.quota_after_json) as RunQuota) : null
  }
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
}): Run {
  const id = randomUUID()
  db()
    .prepare(
      `insert into runs (id, task_id, project_id, session_id, worker_id, started_at,
                         quota_unverified, cost_model_id)
       values (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.taskId,
      input.projectId,
      input.sessionId,
      input.workerId,
      Date.now(),
      input.quotaUnverified ? 1 : 0,
      input.costModelId
    )
  const run = requireRun(id)
  emit({ type: 'run.changed', run })
  return run
}

export function finishRun(id: string, outcome: RunOutcome, note?: string): Run {
  db()
    .prepare('update runs set ended_at = ?, outcome = ?, note = coalesce(?, note) where id = ?')
    .run(Date.now(), outcome, note ?? null, id)
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
  return rows<RunRow>(
    db().prepare('select * from runs where task_id = ? order by started_at desc').all(taskId)
  ).map(toRun)
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
