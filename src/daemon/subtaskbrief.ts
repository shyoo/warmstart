import type { SubtaskBriefAlarmState } from '@shared/protocol.js'
import type { Task, TaskStatus } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { delegationOfChild, type DelegationWaker } from './delegation.js'
import { emit } from './events.js'
import { addMessage, childTasksOf, getTask, runsFor, unmetPrerequisites } from './tasks.js'
import { getWorker } from './workers.js'

const SETTLED: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']
const DEFAULT_INTERVAL_MINUTES = 30
const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 1440

interface AlarmRow {
  task_id: string
  enabled: number
  interval_minutes: number
  early_on_settle: number
  last_brief_at: number | null
  next_brief_at: number
  reported_settled_json: string
  created_at: number
  updated_at: number
}

export interface SubtaskBriefCounts {
  total: number
  open: number
  running: number
  waiting: number
  completed: number
  failed: number
  cancelled: number
}

export interface SubtaskBriefResult {
  headline: string
  body: string
  reply: string
  counts: SubtaskBriefCounts
  alarm: SubtaskBriefAlarmState | null
}

function parseReportedSettled(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)))
  } catch {
    return []
  }
}

function toAlarmState(r: AlarmRow): SubtaskBriefAlarmState {
  return {
    taskId: r.task_id,
    enabled: r.enabled === 1,
    intervalMinutes: r.interval_minutes,
    earlyOnSettle: r.early_on_settle === 1,
    lastBriefAt: r.last_brief_at,
    nextBriefAt: r.next_brief_at,
    reportedSettledIds: parseReportedSettled(r.reported_settled_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function clampIntervalMinutes(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(value)))
}

function singleLineSummary(task: Task): string {
  const raw = task.titleSummary ?? task.title.split(/\r?\n/)[0] ?? ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 140)
}

function completionNote(taskId: string): string | null {
  const run = runsFor(taskId).find((r) => r.outcome === 'completed' && r.note)
  return run?.note ? run.note.replace(/\s+/g, ' ').trim().slice(0, 140) : null
}

function formatSubtaskLine(child: Task, now: number): string {
  const titleSummary = singleLineSummary(child)
  const hold = child.holdReason ? child.holdReason.replace(/\s+/g, ' ').trim().slice(0, 100) : null

  if (child.status === 'running' || child.status === 'assigned') {
    const openRun = runsFor(child.id).find((r) => !r.endedAt)
    const startedAt = openRun?.startedAt ?? child.updatedAt
    const mins = Math.max(0, Math.floor((now - startedAt) / 60_000))
    const workerId = openRun?.workerId ?? child.assignee ?? child.ranOn
    const workerLabel = workerId ? (getWorker(workerId)?.label ?? workerId) : null
    const model = openRun?.model ?? child.ranModel
    const who = [workerLabel, model].filter(Boolean).join(' / ')
    const statusText = who ? `${child.status} · ${mins}m · ${who}` : `${child.status} · ${mins}m`
    return `t${child.seq} (${statusText}) — ${titleSummary}`
  }

  if (child.status === 'ready') {
    const statusText = hold ? `ready / waiting: ${hold}` : 'ready / waiting'
    return `t${child.seq} (${statusText}) — ${titleSummary}`
  }

  if (child.status === 'blocked') {
    const deps = unmetPrerequisites(child)
      .map((edge) => getTask(edge.dependsOn)?.seq)
      .filter((seq): seq is number => seq !== undefined)
      .map((seq) => `t${seq}`)
    const statusText = deps.length > 0 ? `blocked on ${deps.join(', ')}` : 'blocked'
    return `t${child.seq} (${statusText}) — ${titleSummary}`
  }

  if (child.status === 'completed') {
    const where = child.branch ? ` on \`${child.branch}\`` : ''
    const note = completionNote(child.id)
    return `t${child.seq} (completed${where}) — ${note ?? titleSummary}`
  }

  if (
    child.status === 'failed' ||
    child.status === 'awaiting_human' ||
    child.status === 'paused_quota'
  ) {
    const statusText = hold ? `${child.status}: ${hold}` : child.status
    return `t${child.seq} (${statusText}) — ${titleSummary}`
  }

  const statusText = hold ? `${child.status}: ${hold}` : child.status
  return `t${child.seq} (${statusText}) — ${titleSummary}`
}

function countsFor(children: readonly Task[]): SubtaskBriefCounts {
  let completed = 0
  let failed = 0
  let cancelled = 0
  let running = 0
  for (const child of children) {
    if (child.status === 'completed') completed += 1
    else if (child.status === 'failed') failed += 1
    else if (child.status === 'cancelled') cancelled += 1
    else if (child.status === 'running' || child.status === 'assigned') running += 1
  }
  const total = children.length
  const open = total - completed - failed - cancelled
  const waiting = open - running
  return { total, open, running, waiting, completed, failed, cancelled }
}

function formatAlarmFooter(alarm: SubtaskBriefAlarmState | null, now: number): string {
  if (!alarm) {
    return 'Alarm: OFF (call `subtask_brief_alarm` to enable periodic or early-completion briefs).'
  }
  if (!alarm.enabled) {
    return `Alarm: OFF (interval ${alarm.intervalMinutes}m, early on settle: ${alarm.earlyOnSettle ? 'on' : 'off'})`
  }
  const minsRemaining = Math.max(0, Math.ceil((alarm.nextBriefAt - now) / 60_000))
  return (
    `Alarm: ON (every ${alarm.intervalMinutes}m, early on settle: ${alarm.earlyOnSettle ? 'on' : 'off'}, ` +
    `next in ${minsRemaining}m)`
  )
}

function wakeParent(parent: Task, messageId: number, text: string, wake: DelegationWaker): void {
  if (parent.status === 'paused_user' || SETTLED.includes(parent.status)) return
  if (parent.status === 'running' || parent.status === 'assigned') {
    wake.deliver(parent.id, messageId, text)
  } else if (parent.status === 'awaiting_human') {
    wake.requeue(parent.id)
  }
}

export function getSubtaskBriefAlarm(taskId: string): SubtaskBriefAlarmState | null {
  const found = row<AlarmRow>(
    db().prepare('select * from delegation_brief_alarms where task_id = ?').get(taskId)
  )
  return found ? toAlarmState(found) : null
}

/**
 * Format a concise one-line-per-subtask progress brief for `taskId`, including counts and alarm state.
 */
export function buildSubtaskBrief(
  taskId: string,
  opts: { includeClosed?: boolean; now?: number } = {}
): SubtaskBriefResult {
  const now = opts.now ?? Date.now()
  const includeClosed = opts.includeClosed ?? true
  const children = childTasksOf(taskId)
  const counts = countsFor(children)
  const alarm = getSubtaskBriefAlarm(taskId)

  const headlineParts = [`${counts.open} open (${counts.running} running, ${counts.waiting} waiting)`]
  if (counts.completed > 0 || counts.total > 0) headlineParts.push(`${counts.completed} completed`)
  if (counts.failed > 0) headlineParts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) headlineParts.push(`${counts.cancelled} cancelled`)

  const headline =
    counts.total === 0
      ? 'Subtask brief: no subtasks filed yet'
      : `Subtask brief: ${headlineParts.join(', ')}`

  const visible = includeClosed ? children : children.filter((c) => !SETTLED.includes(c.status))
  const lines =
    visible.length > 0
      ? visible.map((child) => formatSubtaskLine(child, now))
      : [counts.total === 0 ? 'No subtasks.' : 'No open subtasks (pass include_closed: true to see settled subtasks).']

  const body = [...lines, '', formatAlarmFooter(alarm, now)].join('\n')
  const reply = `${headline}\n${body}`
  return { headline, body, reply, counts, alarm }
}

/**
 * Enable, update, or disable the subtask brief alarm for `taskId`.
 *
 * Seeds `reported_settled_json` with already-settled children at arming time so historical
 * completions never fire spurious early briefs.
 */
export function setSubtaskBriefAlarm(
  taskId: string,
  opts: { enabled?: boolean; intervalMinutes?: number; earlyOnSettle?: boolean; now?: number } = {}
): SubtaskBriefAlarmState {
  const now = opts.now ?? Date.now()
  const existing = getSubtaskBriefAlarm(taskId)
  const enabled = opts.enabled ?? true
  const intervalMinutes =
    opts.intervalMinutes !== undefined
      ? clampIntervalMinutes(opts.intervalMinutes)
      : (existing?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES)
  const earlyOnSettle = opts.earlyOnSettle ?? existing?.earlyOnSettle ?? true
  const settledNow = childTasksOf(taskId)
    .filter((c) => SETTLED.includes(c.status))
    .map((c) => c.id)
  const reportedSettled = Array.from(new Set([...(existing?.reportedSettledIds ?? []), ...settledNow]))
  const nextBriefAt = now + intervalMinutes * 60_000
  const lastBriefAt = existing?.lastBriefAt ?? null
  const createdAt = existing?.createdAt ?? now

  db()
    .prepare(
      `insert into delegation_brief_alarms
         (task_id, enabled, interval_minutes, early_on_settle, last_brief_at, next_brief_at,
          reported_settled_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(task_id) do update set
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         early_on_settle = excluded.early_on_settle,
         next_brief_at = excluded.next_brief_at,
         reported_settled_json = excluded.reported_settled_json,
         updated_at = excluded.updated_at`
    )
    .run(
      taskId,
      enabled ? 1 : 0,
      intervalMinutes,
      earlyOnSettle ? 1 : 0,
      lastBriefAt,
      nextBriefAt,
      JSON.stringify(reportedSettled),
      createdAt,
      now
    )

  return getSubtaskBriefAlarm(taskId)!
}

/**
 * Notify an armed parent task when one of its subtasks settles.
 *
 * - If all subtasks have settled (`open === 0`), auto-disables the alarm. For `delegation` rows,
 *   defers to `reportDelegationIfSettled` so the caller is never double-woken.
 * - If open subtasks remain and `earlyOnSettle` is enabled, atomically updates
 *   `reported_settled_json`, `last_brief_at`, and `next_brief_at` before posting and waking.
 */
export function onSubtaskSettledForBrief(
  childId: string,
  wake: DelegationWaker,
  now = Date.now()
): boolean {
  const child = getTask(childId)
  if (!child?.parentTaskId) return false
  const alarm = getSubtaskBriefAlarm(child.parentTaskId)
  if (!alarm || !alarm.enabled) return false

  const children = childTasksOf(child.parentTaskId)
  const settledIds = children.filter((c) => SETTLED.includes(c.status)).map((c) => c.id)
  const open = children.length - settledIds.length
  const nextReported = Array.from(new Set([...alarm.reportedSettledIds, ...settledIds]))

  if (open === 0) {
    const claimed = db()
      .prepare(
        `update delegation_brief_alarms
            set enabled = 0, reported_settled_json = ?, updated_at = ?
          where task_id = ? and enabled = 1`
      )
      .run(JSON.stringify(nextReported), now, alarm.taskId)
    if (Number(claimed.changes) === 0) return false
    if (delegationOfChild(childId)) return false

    const parent = getTask(alarm.taskId)
    if (!parent || parent.status === 'paused_user' || SETTLED.includes(parent.status)) return false
    const brief = buildSubtaskBrief(parent.id, { now })
    const headline = `Final subtask brief (t${child.seq} ${child.status}): ${brief.counts.completed} completed`
    const msgId = addMessage(parent.id, 'system', headline, null, [], {
      event: 'delegation.brief',
      detail: brief.body
    })
    emit({ type: 'task.changed', task: parent })
    if (parent.kind === 'conversation') {
      wakeParent(parent, msgId, `${headline}\n${brief.body}`, wake)
    }
    return true
  }

  if (!alarm.earlyOnSettle || alarm.reportedSettledIds.includes(childId)) return false

  const nextBriefAt = now + alarm.intervalMinutes * 60_000
  const claimed = db()
    .prepare(
      `update delegation_brief_alarms
          set reported_settled_json = ?, last_brief_at = ?, next_brief_at = ?, updated_at = ?
        where task_id = ? and enabled = 1 and updated_at = ?`
    )
    .run(JSON.stringify(nextReported), now, nextBriefAt, now, alarm.taskId, alarm.updatedAt)
  if (Number(claimed.changes) === 0) return false

  const parent = getTask(alarm.taskId)
  if (!parent || parent.status === 'paused_user' || SETTLED.includes(parent.status)) return false

  const brief = buildSubtaskBrief(parent.id, { now })
  const headline = `Early subtask brief (t${child.seq} ${child.status}): ${brief.counts.open} open, ${brief.counts.completed} completed`
  const msgId = addMessage(parent.id, 'system', headline, null, [], {
    event: 'delegation.brief',
    detail: brief.body
  })
  emit({ type: 'task.changed', task: parent })
  if (parent.kind === 'conversation') {
    wakeParent(parent, msgId, `${headline}\n${brief.body}`, wake)
  }
  return true
}

/**
 * Periodic alarm sweep called on `tick()`. Zero LLM calls unless an alarm is due for an active
 * parent with open subtasks; compare-and-sets `next_brief_at` before posting or waking.
 */
export function checkSubtaskBriefAlarms(wake: DelegationWaker, now = Date.now()): number {
  const due = rows<AlarmRow>(
    db()
      .prepare('select * from delegation_brief_alarms where enabled = 1 and next_brief_at <= ?')
      .all(now)
  )
  let fired = 0
  for (const r of due) {
    const parent = getTask(r.task_id)
    const children = parent ? childTasksOf(parent.id) : []
    const open = children.filter((c) => !SETTLED.includes(c.status)).length

    if (!parent || SETTLED.includes(parent.status) || open === 0) {
      db()
        .prepare('update delegation_brief_alarms set enabled = 0, updated_at = ? where task_id = ? and enabled = 1')
        .run(now, r.task_id)
      continue
    }

    const nextBriefAt = now + r.interval_minutes * 60_000
    const claimed = db()
      .prepare(
        `update delegation_brief_alarms
            set last_brief_at = ?, next_brief_at = ?, updated_at = ?
          where task_id = ? and enabled = 1 and next_brief_at <= ?`
      )
      .run(now, nextBriefAt, now, r.task_id, now)
    if (Number(claimed.changes) === 0) continue

    if (parent.status === 'paused_user') continue

    const brief = buildSubtaskBrief(parent.id, { now })
    const msgId = addMessage(parent.id, 'system', brief.headline, null, [], {
      event: 'delegation.brief',
      detail: brief.body
    })
    emit({ type: 'task.changed', task: parent })
    wakeParent(parent, msgId, brief.reply, wake)
    fired += 1
  }
  return fired
}
