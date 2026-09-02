import { resolveModelChoice, type Run, type Task } from '@shared/tasks'
import type { ModelOptions, Session, Worker } from '@shared/protocol'
import type { FleetEntry } from './daemon'
import { duration } from './format'

/**
 * How a task is drawn, shared by the list and the thread.
 *
 * ⛔ **One definition, two screens.** These used to be private to `Tasks.tsx`, which was fine while
 * the table and the detail pane were the same file. They are not any more — the thread is its own
 * route now — and a status colour or a worker name that differed between the row you clicked and the
 * page it opened would be the kind of discrepancy an operator spends ten minutes not trusting.
 */

export const STATUS_TONE: Record<string, string> = {
  running: 'state-running',
  assigned: 'state-running',
  ready: 'state-running',
  queued: 'state-running',
  completed: 'state-ok',
  failed: 'state-danger',
  awaiting_human: 'state-human',
  blocked: 'state-idle',
  scheduled: 'state-idle',
  draft: 'state-idle',
  paused_user: 'state-warn',
  paused_quota: 'state-warn',
  cancelling: 'state-warn',
  cancelled: 'state-idle'
}

/**
 * What a status is called where a person can see it.
 *
 * ⛔ Renamed here, not in the domain. `assigned` means something precise to the scheduler and to
 * cancel.ts, and changing it there to suit a table would be the tail wagging the dog. But it is the
 * state a task is in while a workspace is being claimed, a branch checked out and the project's
 * prepare hook run — which is *dispatching*, and is the part of the wait that most needs a name.
 */
export const STATUS_LABEL: Record<string, string> = { assigned: 'dispatching' }

/**
 * The same rename, asked per task, because one status covers two situations a person tells apart.
 *
 * ⛔ Still not a status. `setHoldReason` in tasks.ts argues the case: the task really is `ready` -
 * the scheduler would dispatch it this second if a worker could take it - and inventing a domain
 * status for "ready but nothing free" would put a lie in the DAG to paper over a gap in the UI. So
 * the *word* changes here and the DAG does not.
 *
 * ⚠️ Driven by `holdReason` rather than by counting workers, because the scheduler has already done
 * that arithmetic and written down its answer. A renderer that re-derived "is anything free?" would
 * be a second opinion on a question with an authoritative one, and the two would disagree the first
 * time a gate the UI does not know about (quota, capability, a missing baseline) held a task back.
 * ⭐ Measured 2026-08-29: t22 sat at `ready` for seven minutes with `Antigravity at capacity`
 * written on it, and read as a task waiting on the operator to press something.
 */
export function statusLabel(task: Pick<Task, 'status' | 'holdReason'>): string {
  if (task.status === 'ready' && task.holdReason) return 'queued'
  return STATUS_LABEL[task.status] ?? task.status
}

/**
 * The hold, and how long it has left to run.
 *
 * ⛔ **Because "at 92% of its 5h window" does not say whether that means five minutes or five
 * hours**, and those are different situations with different answers — one is worth waiting out and
 * the other is worth overriding, reassigning or going to bed over. The scheduler has known the reset
 * time all along; since 2026-09-01 it writes it down as `holdUntil` instead of discarding it, and
 * this is where a person finally reads it. Measured on t71: held against a window resetting 2h29m
 * later, shown as a sentence with no clock in it.
 *
 * ⚠️ Nothing is appended where there is no clock — "at capacity" ends when a run ends, which is not
 * a time anybody can name, and inventing a countdown for it would be worse than the silence.
 */
export function holdLine(
  task: Pick<Task, 'holdReason' | 'holdUntil'>,
  now = Date.now()
): string | null {
  if (!task.holdReason) return null
  const left = task.holdUntil ? task.holdUntil - now : 0
  if (left <= 0) return task.holdReason
  return `${task.holdReason} — earliest retry in ${duration(left)}`
}

/**
 * Statuses where something is happening and the next change arrives on its own.
 *
 * ⚠️ `ready` is in here, and that is the whole point of the list. A freshly filed task sits at
 * `ready` for up to one scheduler tick before anything moves, and rendered as a flat word beside
 * `completed` and `failed` it reads as a resting state — as though the operator were the one being
 * waited on. They are not: it is queued, and the dots say so.
 */
export const IN_FLIGHT = new Set(['ready', 'scheduled', 'assigned', 'running', 'cancelling'])

export const CANCELLABLE = new Set([
  'ready',
  'blocked',
  'scheduled',
  'assigned',
  'running',
  'awaiting_human',
  'paused_quota'
])

export type ProjectWorkState = 'working' | 'needs_attention' | 'paused' | 'idle'

/**
 * Computes the work state for a project based on its tasks:
 * - 'needs_attention': At least one task is awaiting human input or paused by user.
 * - 'working': At least one task is active/in-flight and no tasks need human action.
 * - 'paused': Nothing is moving, but at least one task is held on quota and will resume itself.
 * - 'idle': Nothing is running, held or waiting on anyone.
 *
 * ⛔ `paused_quota` is not idle. The dot is the only thing the sidebar says about a project you are
 * not looking at, and a task parked on an exhausted account rendered as a blank ring read as *this
 * project has nothing going on* — while the work was stopped and the account was the reason. It is
 * not `needs_attention` either: nobody is being waited on, the quota window reopens on its own and
 * the scheduler picks the task back up. So it is its own state, warned in colour and calm in motion.
 */
export function projectWorkState(tasks: Array<Pick<Task, 'status'>>): ProjectWorkState {
  if (tasks.some((t) => t.status === 'awaiting_human' || t.status === 'paused_user')) {
    return 'needs_attention'
  }
  if (tasks.some((t) => IN_FLIGHT.has(t.status))) {
    return 'working'
  }
  if (tasks.some((t) => t.status === 'paused_quota')) {
    return 'paused'
  }
  return 'idle'
}

/** Small indicator dot displayed before the project name in the navigation pane. */
export function ProjectDot({ state }: { state: ProjectWorkState }): React.JSX.Element {
  const title =
    state === 'working'
      ? 'Tasks in progress'
      : state === 'needs_attention'
        ? 'Human action needed'
        : state === 'paused'
          ? 'Paused on quota — resumes when the account’s window reopens'
          : 'Idle'
  return <span className={`project-dot project-dot--${state}`} title={title} aria-label={title} />
}

/** Three dots that say the fleet is doing something, for a row whose next event arrives by itself. */
export function Working(): React.JSX.Element {
  return (
    <span className="working" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

/**
 * Which **account** this task is on, or was on.
 *
 * ⛔ Never "you". The column exists so that which account is spending on a task is visible without a
 * click — that is what made a misroute findable at all — and it used to be blanked by the very thing
 * it was there to survive: nine hand-off sites set `assignee` to `human` the moment a task started
 * waiting on a person, so a task ClaudeSecond had run rendered as worked on by *you*, and stayed
 * that way after it was marked done. A person answering a question did not do the work and did not
 * pay for it.
 *
 * ⚠️ `ranOn` first, `assignee` only as the before-anything-ran case: a task assigned a moment ago has
 * an account and no runs yet, which is a real state and reads as one. Who is being waited on is the
 * *status*, and it is said there.
 */
export function assigneeLabel(task: Task, fleet: FleetEntry[]): string {
  const account =
    task.ranOn ?? (task.assignee === 'human' || task.assignee === 'controller' ? null : task.assignee)
  if (!account) return task.assignee === 'controller' ? 'controller' : '—'
  return fleet.find((f) => f.worker.id === account)?.worker.label ?? account.slice(0, 8)
}

/**
 * How long an agent was actually working on this task.
 *
 * ⛔ **Active time, not wall-clock, and the column that shows it is the one headed "Took".** The
 * old answer was `lastRunEnded - firstRun`, which measures how long the task *existed inside*: it
 * counts every minute queued behind a busy pool, parked on a quota window, and — the large one —
 * waiting for a person to answer a question, which `ask_human` will happily do overnight. The two
 * numbers do not differ by a correction factor, they differ without limit, and every per-agent and
 * per-model duration read off the wall-clock was describing the operator rather than the agent.
 *
 * ⚠️ Summed in the daemon (`activetime.ts`) and *finished* here: `activeSince` is the moment the
 * live stretch began, so a running task ticks without the daemon pushing a row every second, and
 * one that is open but blocked on a person has `activeSince: null` and correctly stops moving.
 *
 * A task that has never run has no duration and says so rather than showing zero.
 */
type Timed = Pick<Task, 'firstRunAt' | 'lastRunEndedAt' | 'activeMs' | 'activeSince'>

export function activeTime(task: Timed, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration(task.activeMs + (task.activeSince ? Math.max(0, now - task.activeSince) : 0))
}

/**
 * The span the task existed inside, first dispatch to last stop.
 *
 * ⛔ Kept, but never shown as *how long this took*. It answers a different and much weaker question
 * — "how long has this been going on" — and it is worth showing beside `activeTime` precisely
 * because the gap between them is the time nobody was working: queued, held, or waiting on you.
 */
export function elapsed(task: Timed, now: number): string {
  if (!task.firstRunAt) return '—'
  return duration((task.lastRunEndedAt ?? now) - task.firstRunAt)
}

/**
 * The sentence that explains the difference, for the tooltip on both places the number appears.
 *
 * ⛔ Says *why* the two disagree rather than only that they do. An operator reading "4m" against a
 * task filed eight hours ago will assume the number is broken unless the waiting is named.
 */
export function activeTimeTitle(task: Timed, now: number): string {
  if (!task.firstRunAt) return 'Nothing has run yet, so there is no duration to report.'
  const wall = (task.lastRunEndedAt ?? now) - task.firstRunAt
  const active = task.activeMs + (task.activeSince ? Math.max(0, now - task.activeSince) : 0)
  const idle = Math.max(0, wall - active)
  return (
    `Time an agent was actually working: ${duration(active)}. ` +
    `From first dispatch to last stop is ${duration(wall)}, of which ${duration(idle)} was spent ` +
    'queued, held on a workspace or a quota window, or waiting for you to answer something — ' +
    'none of which anybody worked. Dispatch, routing and the CLI starting up all count as work.'
  )
}

/**
 * The workspace directory this task is running in, or ran in.
 *
 * ⛔ Read from the session rather than from the project. A git project's runs execute in a pooled
 * worktree (`<project>_workspaces/ws<N>`), never in `project.root` — drawing the project root would
 * tell somebody the agent is working in the trunk, which is the one thing it never does.
 *
 * ⚠️ Returns null before anything has run: a task at rest in a pool has not claimed a workspace yet,
 * and presenting a guess would claim a slot the scheduler has not assigned.
 */
export function workspacePathFor(
  runs: Pick<Run, 'sessionId'>[],
  sessions: Pick<Session, 'id' | 'cwd'>[]
): string | null {
  const run = runs[0]
  if (run?.sessionId) {
    const session = sessions.find((s) => s.id === run.sessionId)
    if (session?.cwd) return session.cwd
  }
  return sessions[0]?.cwd ?? null
}

/**
 * What to call this task, wherever a task needs a name in a row, a header or a chip.
 *
 * ⛔ **`titleSummary ?? title`, in one place, because the fallback is the whole feature.** `title` is
 * the prompt — `promptFor()` sends it to the agent verbatim, and the task form files an entire
 * textarea into it — so a board of operator-written tasks is a board of paragraphs. The controller
 * writes a one-line label into `titleSummary` when it has been asked something about the task
 * anyway; most tasks never get one, and those are not broken rows, they are unlabelled ones. Showing
 * the prompt is the right answer for them and always has been.
 *
 * ⚠️ **Never used where the prompt itself is the subject.** The task thread's first entry, the draft
 * editor, and the prompt preview all show `title` in full and must go on doing so: this is a label
 * for a table, and a label that quietly replaced the instruction being edited would lose a word of
 * what the agent was actually asked.
 */
export function taskLabel(task: Pick<Task, 'title' | 'titleSummary'>): string {
  return task.titleSummary ?? task.title
}

/**
 * The same label, cut to fit a table cell.
 *
 * ⚠️ Truncation is the *second* line of defence and is expected to do nothing on a labelled task —
 * `MAX_TITLE_SUMMARY` is 80, so a summary always fits. It still exists because an unlabelled task
 * falls back to a prompt of any length at all, and a table has to hold its shape either way.
 */
export function taskLabelShort(task: Pick<Task, 'title' | 'titleSummary'>, max = 70): string {
  const label = taskLabel(task)
  return label.length > max ? `${label.slice(0, max)}…` : label
}

/**
 * Sorts runs into chronological order (oldest first, newest last) for display in the thread.
 *
 * ⛔ **Old top, new bottom.** The backend stores and returns runs newest-first (`order by started_at desc`)
 * so that `runs[0]` is the latest attempt for session resolution. The UI thread reads top-to-bottom
 * in time order — attempt 1 first, attempt 2 next — matching how a person reads a timeline.
 */
export function chronologicalRuns<T extends Pick<Run, 'startedAt'>>(runs: T[]): T[] {
  return [...runs].sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * What the "←N" dependency badge means, spelled out for a hover.
 *
 * ⚠️ Resolved against `page`, the same page of tasks already loaded for the table — not a fresh
 * fetch. A dependency filed on an earlier page falls back to its bare id rather than blocking the
 * tooltip on a round trip.
 */
export function dependencyTooltip(
  task: Pick<Task, 'dependsOn'>,
  page: Array<Pick<Task, 'id' | 'seq' | 'title' | 'titleSummary' | 'status' | 'holdReason'>>
): string {
  if (task.dependsOn.length === 0) return ''
  const byId = new Map(page.map((t) => [t.id, t]))
  const lines = task.dependsOn.map((id) => {
    const dep = byId.get(id)
    return dep ? `t${dep.seq} · ${taskLabelShort(dep, 40)} (${statusLabel(dep)})` : id
  })
  return `Depends on:\n${lines.join('\n')}`
}

/**
 * A model id, cut to what an operator scanning a column needs: the name and the version, not the
 * vendor prefix or a build date.
 *
 * ⚠️ Not a lookup table. New models land in adapters and quota configs, never in this file, so a
 * table here would silently show raw ids for anything shipped after it was written. Consecutive
 * digit groups collapse into a dotted version (`haiku-4-5-20251001` → `Haiku 4.5`, the date dropped
 * as noise) and everything else is title-cased in place.
 */
export function formatModelName(model: string): string {
  const noPrefix = model.replace(/^(claude|gemini|gpt)-/, '')
  const noDate = noPrefix.replace(/-\d{8}$/, '')
  const parts = noDate.split('-')
  const merged: string[] = []
  for (const part of parts) {
    const prevIsDigits = merged.length > 0 && /^\d/.test(merged[merged.length - 1]!)
    if (/^\d+$/.test(part) && prevIsDigits) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${part}`
    } else {
      merged.push(part)
    }
  }
  return merged
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

/**
 * The model/effort column: what would actually be sent on the next dispatch, resolved the same way
 * the scheduler resolves it (task pin, else worker default, else the CLI's own choice).
 */
export function modelColumnLabel(
  task: Pick<Task, 'constraints' | 'assignee'>,
  fleet: FleetEntry[],
  modelOptions: ModelOptions[]
): string {
  const worker: Worker | undefined =
    fleet.find((e) => e.worker.id === (task.constraints.workerId || task.assignee))?.worker ??
    undefined
  const canSetEffort =
    modelOptions.find((o) => o.adapterId === worker?.adapterId)?.selectableEffort ?? false
  const resolved = resolveModelChoice(task.constraints, worker, canSetEffort)
  if (!resolved.model) return '—'
  const effort = resolved.effort ? ` ${resolved.effort.charAt(0).toUpperCase()}${resolved.effort.slice(1)}` : ''
  return `${formatModelName(resolved.model)}${effort}`
}
