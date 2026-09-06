import { resolveModelChoice, type Compaction, type Run, type Task } from '@shared/tasks'
import type { ModelOptions, Session } from '@shared/protocol'
import type { QualityReview } from '@shared/review'
import type { FleetEntry } from './daemon'
import { duration } from './format'
import { modelLabel } from './modelname'

/**
 * How a task is drawn, shared by the list and the thread.
 *
 * ⛔ **One definition, two screens.** These used to be private to `Tasks.tsx`, which was fine while
 * the table and the detail pane were the same file. They are not any more — the thread is its own
 * route now — and a status colour or a worker name that differed between the row you clicked and the
 * page it opened would be the kind of discrepancy an operator spends ten minutes not trusting.
 */

export const STATUS_TONE: Record<string, string> = {
  grading: 'state-running',
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
export function statusLabel(task: Pick<Task, 'status' | 'holdReason' | 'gradingWorkerId'>): string {
  if (task.gradingWorkerId) return 'grading'
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
  task: Pick<Task, 'status' | 'holdReason' | 'holdUntil'>,
  now = Date.now()
): string | null {
  // A completed task is no longer waiting on anything. `holdReason` is retained as history, so a
  // landing failure resolved separately can still be present after completion; drawing it here
  // turns that old event into the task's apparent current state. Failed and cancelled tasks keep
  // their reasons because those can explain how they ended.
  if (task.status === 'completed') return null
  if (!task.holdReason) return null
  const left = task.holdUntil ? task.holdUntil - now : 0
  if (left <= 0) return task.holdReason
  return `${task.holdReason} — earliest retry in ${duration(left)}`
}

/** Statuses where an agent is actively executing work. */
export const WORKING_STATUSES = new Set(['running'])

export function isWorking(task: Pick<Task, 'status' | 'gradingWorkerId'>): boolean {
  return task.status === 'running' || Boolean(task.gradingWorkerId)
}

/**
 * Statuses where something is happening and the next change arrives on its own.
 * Used for project work state tracking.
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

/**
 * Statuses where a Stop button belongs beside the composer, next to Send.
 *
 * ⛔ **A strict subset of `CANCELLABLE`, and it has to stay one.** A Stop offered on a status the
 * daemon will not cancel is not a button, it is a lie: `cancelTask` returns the task untouched for
 * anything outside its own set, so the press would refresh the pane and change nothing, and the
 * operator would press it again. The subset test in `taskview.test.ts` is what keeps the two
 * honest if either list moves.
 *
 * ⚠️ The two statuses left out are the two where nothing is being done to the task. `awaiting_human`
 * is waiting on *you*, and it already renders `Decide` directly above the composer with a "Stop
 * here" in it — a second Stop an inch below the first, wired to the same call, reads as a different
 * and more final action than the one above it. `paused_quota` is already stopped; the work is not
 * happening and there is nothing there to interrupt. Both remain cancellable from the row menu on
 * the list, which is where "park this differently" belongs.
 *
 * ⭐ `blocked` is in, and it is the least obvious one. A blocked task is not idle — it is admitted
 * the moment its prerequisites land, with no further say from anybody — so the only moment to take
 * it off that track is before the prerequisites finish, which is exactly while it reads `blocked`.
 */
export const STOPPABLE = new Set(['ready', 'blocked', 'scheduled', 'assigned', 'running'])

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

/** Three dots that indicate an agent is actively working on a task. */
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
 * Which **model** that account used, or would use, under the account's own name.
 *
 * ⛔ **One column, two facts, in that order.** The account and the model are not independent — a
 * model id belongs to one CLI, so `Sonnet 5 Med` under *Antigravity* would be a routing bug and
 * under *ClaudeSecond* is a Tuesday. Read as two separate columns an operator has to join by eye,
 * that pairing is exactly what goes unnoticed; stacked, the wrong one is obvious.
 *
 * ⚠️ **What ran beats what would run.** A task that has run reports its last run's model, so the
 * cell keeps saying what actually spent the tokens after somebody changes the account default. A
 * task that has not run yet has no such fact, and reports what the next dispatch would ask for -
 * resolved by `resolveModelChoice`, the same function the scheduler calls, so this cannot promise
 * an inheritance the dispatch would not perform.
 *
 * ⚠️ Effort comes from the resolution either way: a run records the model it was given and not the
 * level, and on the adapters where the level matters it is part of the model id anyway.
 *
 * Returns null where there is nothing true to say - no account, or an account that has never been
 * told a model and never run one. ⛔ The cell then shows the worker alone rather than a placeholder:
 * "the CLI picks" is the honest reading, and it is already what the detail pane says at length.
 */
export type Routed = Pick<Task, 'ranOn' | 'ranModel' | 'assignee' | 'constraints'>

export function modelLine(
  task: Routed,
  fleet: FleetEntry[],
  modelOptions: ModelOptions[]
): { label: string; id: string; ran: boolean } | null {
  const account = task.ranOn ?? task.constraints.workerId ?? task.assignee
  const entry = fleet.find((f) => f.worker.id === account) ?? null
  const options = modelOptions.find((o) => o.adapterId === entry?.worker.adapterId) ?? null
  const resolved = resolveModelChoice(
    task.constraints,
    entry?.worker,
    options?.selectableEffort ?? false,
    entry?.quota
  )
  const id = task.ranModel ?? resolved.model
  if (!id) return null
  const label = modelLabel(id, resolved.effort)
  if (!label) return null
  return { label, id, ran: task.ranModel !== null }
}

/**
 * The same "what ran beats what would run" rule, for the thread's `model` row.
 *
 * ⛔ **The headline is a measurement wherever one exists.** This pane used to lead with the
 * *resolution* — what a dispatch starting now would ask for — under a tooltip that said "asked for
 * at launch". Those are not the same sentence, and on an account with more than one model pool they
 * are routinely not the same model: the dispatch resolves the pool against a live quota reading and
 * takes the emptier one, so the ledger announced `Gemini 3.7 Flash Med` over a run whose every turn
 * was answered by 3.8. Nothing was wrong with the run; the row was reporting a prediction as a fact.
 *
 * ⚠️ **The prediction is still shown, as the second line, and only when it differs.** It is the
 * answer to a real question — *what would the next turn use?* — which is exactly what an operator
 * who has just re-pinned the model wants confirmed. Wording it as `next run asks for …` is the whole
 * fix: two lines that say what they are cannot contradict each other.
 *
 * ⚠️ Nothing observed at all until a turn has been metered, and then the resolution is the only
 * thing there is to show. An empty session has no observation, and inventing "probably the default"
 * is the guess the rest of this file refuses to make.
 */
export function modelFacts(input: {
  /** The live session's own reading, which is the only source that also knows the effort. */
  observed: { model: string | null; effort: string | null } | null
  /** What the last run recorded, for a task whose session has since closed. */
  ran: string | null
  requested: {
    model: string | null
    effort: string | null
    source: string
    /**
     * The router will choose the model, so there is nothing to name yet.
     *
     * ⛔ **Distinct from `model: null`, which means "the CLI picks".** Both are unknown here, but
     * they are unknown for opposite reasons and resolve at different moments — the CLI's default is
     * whatever that vendor ships, while an allowlisted worker's model is decided by `chooseTarget`
     * on the tick that dispatches. Collapsing the two would print "CLI default" for a fleet that has
     * explicitly listed the models it wants scored.
     */
    undecided?: boolean
  }
}): {
  headline: { text: string; title: string }
  note: { text: string; title: string; tone: 'warn' | 'dim' } | null
} {
  const { observed, ran, requested } = input
  const model = observed?.model ?? ran ?? null
  const effort = observed?.effort ?? null
  // ⚠️ The CLI's own default is a real answer and reads as one. "—" would look like a broken field.
  const asked = requested.undecided
    ? 'chosen at dispatch'
    : (modelLabel(requested.model, requested.effort) ?? 'CLI default')
  const askedTitle = `${requested.undecided ? 'not yet decided' : (requested.model ?? 'no model chosen')} — what the next run asks for, ${requested.source}`

  const seen = modelLabel(model, effort)
  if (!seen) return { headline: { text: asked, title: askedTitle }, note: null }

  const differs =
    !requested.undecided &&
    ((requested.model !== null && model !== null && requested.model !== model) ||
      (requested.effort !== null && effort !== null && requested.effort !== effort))
  return {
    headline: {
      text: seen,
      // ⛔ The id stays in reach on every line. This field is the one an operator reads when a run
      // went somewhere unexpected, and a name written for reading may not be the string that was
      // sent.
      title: `${model ?? ''} — what the transcript says actually answered each turn`
    },
    note: differs
      ? { text: `next run asks for ${asked}`, title: askedTitle, tone: 'warn' }
      : { text: 'confirmed by the transcript', title: 'confirmed by the transcript, turn by turn', tone: 'dim' }
  }
}

/**
 * What kind of thing this task is, in the words the composer used to file it.
 *
 * ⛔ **A fact the thread was missing entirely.** A Plan & Split task's page looked exactly like an
 * ordinary task's — same header, same ledger — while behaving completely differently: it files
 * subtasks, waits for them, lands onto its own branch and is run twice. Somebody opening it had no
 * way to tell which of the two they were looking at, and the settings that only apply to one of them
 * were drawn for both.
 */
export function kindLabel(task: Pick<Task, 'kind'>): string {
  if (task.kind === 'plan') return 'Plan & Split'
  if (task.kind === 'conversation') return 'Conversation'
  return 'Task'
}

/**
 * The settings every piece of this plan is filed with, as short lines for the ledger.
 *
 * ⛔ **Read from where the daemon reads them.** These are the same two fields `pieceConstraints`
 * resolves — `childDefaults` first, the planner's own `constraints.pieceConstraints` behind it — so
 * the pane cannot claim an account the split will not use. Two readers of one setting, each with its
 * own idea of precedence, is the failure this project has already paid for once.
 *
 * ⚠️ Accounts are named by their **labels**, resolved through the fleet, with the model each one was
 * given beside it. A worker id in a ledger is a string nobody recognises, and the pairing of account
 * and model is the thing being checked when somebody opens this at all.
 */
export function pieceSettings(
  task: Pick<Task, 'kind' | 'childDefaults' | 'constraints' | 'priority'>,
  fleet: FleetEntry[]
): Array<{ label: string; value: string }> {
  if (task.kind !== 'plan') return []
  const defaults = task.childDefaults ?? {}
  const fallback = task.constraints?.pieceConstraints ?? {}
  const ids = (
    defaults.workerIds?.length
      ? defaults.workerIds
      : fallback.workerIds?.length
        ? fallback.workerIds
        : defaults.workerId
          ? [defaults.workerId]
          : fallback.workerId
            ? [fallback.workerId]
            : []
  ).filter((id): id is string => !!id)
  const models = defaults.modelsByWorker ?? fallback.modelsByWorker ?? {}
  const efforts = defaults.effortsByWorker ?? fallback.effortsByWorker ?? {}

  const rows: Array<{ label: string; value: string }> = []
  rows.push({
    label: 'workers',
    value:
      ids.length === 0
        ? // ⚠️ Said plainly rather than left blank. "Nobody chose" and "the pane does not know" look
          // identical when the row is empty, and only one of them is true here.
          'any account the scheduler picks'
        : ids
            .map((id) => {
              const label = fleet.find((f) => f.worker.id === id)?.worker.label ?? id.slice(0, 8)
              const model = models[id]
              const effort = efforts[id]
              const named = modelLabel(model ?? null, effort ?? null)
              return named ? `${label} · ${named}` : label
            })
            .join(', ')
  })
  const single = ids.length <= 1 ? (defaults.model ?? fallback.model ?? null) : null
  if (single) {
    rows.push({ label: 'model', value: modelLabel(single, defaults.effort ?? fallback.effort ?? null) ?? single })
  }
  rows.push({ label: 'priority', value: defaults.priority ?? task.priority })
  if (defaults.finishPolicy) rows.push({ label: 'finish', value: defaults.finishPolicy })
  if (defaults.sessionSharing) rows.push({ label: 'conversation', value: defaults.sessionSharing })
  if (defaults.maxChildren) rows.push({ label: 'fan-out', value: `up to ${defaults.maxChildren} pieces` })
  return rows
}

/**
 * Keep a task's valid model pin when changing its worker; otherwise return to inheritance.
 *
 * ⛔ Do not copy `worker.defaultModel` here. Multi-pool workers such as Antigravity resolve their
 * default from `defaultModels` and current quota, so copying the single-model legacy field pins a
 * task to a different model than the worker's configured default.
 */
export function reassignmentModel(model: string, offeredModels: ReadonlyArray<{ id: string }>): string {
  return model && offeredModels.some((offered) => offered.id === model) ? model : ''
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
 * **The one ordering rule for everything in the thread: when it finished, then when it started.**
 *
 * ⛔ **Sorting by start time reads the timeline wrong whenever two things overlap**, and in this
 * thread they overlap constantly — a compaction happens *inside* the run that asked for it, so the
 * two always share a start and never share an end. Measured on t231, 2026-09-05: run 2 ran
 * 16:44:24–16:55:19 and its compaction ran 16:44:26–16:47:06. Ordered on `startedAt` the run came
 * first by two seconds, so the operator read a compaction that had visibly finished at 16:47 printed
 * *below* a run still going at 16:55. Ordered on the end, the compaction lands above the run that
 * outlived it, which is the order the events actually concluded in and the order a person reading
 * top-to-bottom expects.
 *
 * ⚠️ **Unfinished sorts last, and that is not a fallback — it is the answer.** Something still
 * running has not ended yet, so it will end after everything that already has. `Infinity` says
 * exactly that; `0` or `Date.now()` would each be a guess at a fact nobody has.
 *
 * ⚠️ The start time breaks ties rather than being ignored: two entries that ended in the same
 * millisecond — or two that are both still open — still have an order, and it is a stable one.
 */
export function byEndThenStart(
  a: { end: number | null; start: number },
  b: { end: number | null; start: number }
): number {
  const ended = (a.end ?? Number.POSITIVE_INFINITY) - (b.end ?? Number.POSITIVE_INFINITY)
  // ⛔ `Infinity - Infinity` is `NaN`, and a comparator that returns `NaN` orders nothing. Two open
  //    entries are tied on the end and fall through to the start, which is what the guard is for.
  if (ended !== 0 && !Number.isNaN(ended)) return ended
  return a.start - b.start
}

/**
 * Sorts runs into chronological order (oldest first, newest last) for display in the thread.
 *
 * ⛔ **Old top, new bottom.** The backend stores and returns runs newest-first (`order by started_at desc`)
 * so that `runs[0]` is the latest attempt for session resolution. The UI thread reads top-to-bottom
 * in time order — attempt 1 first, attempt 2 next — matching how a person reads a timeline.
 *
 * ⚠️ Ordered on the end, like everything else in the thread — see `byEndThenStart`. Attempts rarely
 * overlap, so this usually agrees with `startedAt`; it is held to the one rule anyway, because an
 * ordering that is right for a different reason is one refactor away from being wrong.
 */
export function chronologicalRuns<T extends Pick<Run, 'startedAt' | 'endedAt'>>(runs: T[]): T[] {
  return [...runs].sort((a, b) =>
    byEndThenStart(
      { end: a.endedAt ?? null, start: a.startedAt },
      { end: b.endedAt ?? null, start: b.startedAt }
    )
  )
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

export type TimelineItem = { ts: number; endTs: number | null } & (
  | { kind: 'run'; run: Run }
  | { kind: 'compaction'; compaction: Compaction }
  | { kind: 'review'; review: QualityReview }
)

/**
 * Merges runs, compactions and quality reviews into one chronological timeline (oldest first).
 *
 * ⛔ **A review is one entry, not two.** It *is* a `runs` row — that is how its tokens are metered
 * and how it earns a number in this list — so the run half is filtered out here and the review half
 * rendered instead. Without the filter every review would appear twice, once as `#N Run` with a
 * reviewer's model on somebody else's task.
 *
 * ⛔ **Ordered on when each entry finished** — `byEndThenStart`, which carries the argument. A
 * compaction runs *inside* the run that asked for it, so start times separate the two by seconds
 * while end times separate them by minutes, and only the end puts them in the order they concluded.
 *
 * ⚠️ Every kind reports both ends, and each one's `null` means the same thing: still open. A run
 * has no `endedAt` until it stops; a compaction has no `landedAt` until its boundary arrives, which
 * is the asked-and-never-landed case `compaction.ts` exists to keep on the record; a review has no
 * `completedAt` until it is graded.
 */
export function chronologicalTimeline(
  runs: Run[] = [],
  compactions: Compaction[] = [],
  reviews: QualityReview[] = []
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...runs
      .filter((r) => r.kind === 'work')
      .map((r) => ({ kind: 'run' as const, run: r, ts: r.startedAt, endTs: r.endedAt ?? null })),
    ...compactions.map((c) => ({
      kind: 'compaction' as const,
      compaction: c,
      ts: c.askedAt ?? c.ts,
      endTs: c.landedAt ?? null
    })),
    ...reviews.map((r) => ({
      kind: 'review' as const,
      review: r,
      ts: r.createdAt,
      endTs: r.completedAt ?? null
    }))
  ]
  return items.sort((a, b) =>
    byEndThenStart({ end: a.endTs, start: a.ts }, { end: b.endTs, start: b.ts })
  )
}

/** Whether the task stopped because of a merge or rebase conflict. */
export function isConflictedTask(task: Pick<Task, 'holdReason'>): boolean {
  return /conflict/i.test(task.holdReason ?? '')
}

/** Whether the task stopped because project verification checks failed. */
export function isChecksFailedTask(task: Pick<Task, 'holdReason'>): boolean {
  return /checks? failed|verification failed/i.test(task.holdReason ?? '')
}

/**
 * Whether the task stopped with uncommitted work on its workspace or branch.
 *
 * ⛔ Deliberately excludes "the trunk has uncommitted changes": that is a trunk blockage (the operator's
 * working tree is dirty), not uncommitted work by the agent, and dispatching an agent to commit on the
 * task branch would send it to fix something that is not broken.
 */
export function isUncommittedTask(task: Pick<Task, 'holdReason'>): boolean {
  const reason = task.holdReason ?? ''
  if (/the trunk has uncommitted/i.test(reason)) return false
  return /workspace has uncommitted|file\(s\) are uncommitted|changes on .* are uncommitted|cannot be asked after its turn ends|rescue|stash/i.test(
    reason
  )
}

/** Whether the task tripped the trunk tripwire (the trunk moved during this run and this branch is empty). */
export function isTrunkMovedTask(task: Pick<Task, 'holdReason'>): boolean {
  return /trunk moved.*branch is empty/i.test(task.holdReason ?? '')
}

/**
 * Whether a human in awaiting_human should be offered "Retry landing".
 *
 * ⛔ A branch carrying no commits must never offer "Retry landing": `relandTask` requires real commits
 * (`decision.kind === 'land'`) and fails immediately if `unlandedCommits === 0`.
 *
 * ⚠️ Bare `/trunk/i` was a trap (measured on t157, 2026-09-03): it matched "the trunk moved during this
 * run and this branch is empty", offering a button that was guaranteed to fail with "Retry landing
 * failed: carries no commits".
 */
export function canRelandTask(task: Pick<Task, 'branch' | 'holdReason'>): boolean {
  if (!task.branch) return false
  const reason = task.holdReason ?? ''
  if (isConflictedTask(task)) return false
  if (isChecksFailedTask(task)) return false
  if (isUncommittedTask(task)) return false
  if (isTrunkMovedTask(task)) return false
  if (/no commits|nothing to land|branch is empty/i.test(reason)) return false
  if (/Retry landing failed/i.test(reason)) return false
  return /landing failed|not merged|wait(ed|ing) for a turn|would not fast-forward|trunk was busy|clean trunk|the trunk is busy|the trunk has uncommitted/i.test(
    reason
  )
}
