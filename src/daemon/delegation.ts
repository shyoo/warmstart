import { randomUUID } from 'node:crypto'
import { db, rows } from './db.js'
import { emit } from './events.js'
import { tryGit } from './git.js'
import { log } from './log.js'
import { addMessage, getTask, isIntegrationParent, isSplitWork, messagesFor, requireTask, runsFor } from './tasks.js'
import type { MandateOperation, Task, TaskStatus } from '@shared/tasks.js'

/**
 * Delegation from any task (t704): a work task or a conversation hands part of its work to other
 * agents with `task_split`, the way a planner does, and reviews what comes back.
 *
 * ⛔ **Nothing is merged into the caller for it.** A plan can have its pieces fast-forwarded into
 * its branch because the planner is parked while they run. A conversation is not — it keeps talking,
 * in a live worktree holding that branch — and `merge-branch` frees such a slot by rescue-committing
 * and detaching it, which would switch the tree out from under the agent. So every delegated piece
 * finishes as `commit-and-verify` on its own branch (cut from the caller's), and the caller merges
 * what it wants with `git` on the review turn it is woken for.
 *
 * ⚠️ The authority is the task's own `spawn_tasks` — the thread's Delegate switch writes it, and
 * `createTask` already refuses a task without it. The prompt only reflects it.
 */

const SETTLED: TaskStatus[] = ['completed', 'failed', 'cancelled']
const SPAWN: MandateOperation = 'spawn_tasks'

export interface Delegation {
  id: string
  /** The task that delegated. */
  taskId: string
  childIds: string[]
  /** Filed in answer to a person's `/delegate`, so no approval card was raised. */
  requested: boolean
  createdAt: number
  /** When the caller was told every piece had settled. ⛔ Written before it is woken. */
  reportedAt: number | null
}

interface DelegationRow {
  id: string
  task_id: string
  child_ids_json: string
  requested: number
  created_at: number
  reported_at: number | null
}

const fromRow = (r: DelegationRow): Delegation => ({
  id: r.id,
  taskId: r.task_id,
  childIds: JSON.parse(r.child_ids_json) as string[],
  requested: r.requested === 1,
  createdAt: r.created_at,
  reportedAt: r.reported_at
})

export function recordDelegation(taskId: string, childIds: string[], requested: boolean): Delegation {
  const row: DelegationRow = {
    id: randomUUID(),
    task_id: taskId,
    child_ids_json: JSON.stringify(childIds),
    requested: requested ? 1 : 0,
    created_at: Date.now(),
    reported_at: null
  }
  db()
    .prepare('insert into delegations (id, task_id, child_ids_json, requested, created_at, reported_at) values (?,?,?,?,?,?)')
    .run(row.id, row.task_id, row.child_ids_json, row.requested, row.created_at, row.reported_at)
  return fromRow(row)
}

export function delegationsFor(taskId: string): Delegation[] {
  return rows<DelegationRow>(
    db().prepare('select * from delegations where task_id = ? order by created_at').all(taskId)
  ).map(fromRow)
}

/** The delegation a piece was filed by, or null for every task that is not a delegated piece. */
export function delegationOfChild(childId: string): Delegation | null {
  // ⚠️ A LIKE over a JSON array, narrowed by the quoted id: ids are uuids, so one cannot be a
  // substring of another, and the table holds one row per `task_split` a person saw — small.
  const found = rows<DelegationRow>(
    db().prepare('select * from delegations where child_ids_json like ?').all(`%"${childId}"%`)
  )
  return found.length > 0 ? fromRow(found[0]!) : null
}

export function delegationOn(task: Pick<Task, 'mandate'>): boolean {
  return task.mandate.allowed.includes(SPAWN)
}

/**
 * Why this task may not delegate with `task_split`, or null when it may.
 *
 * ⚠️ Asked only of a task that is not a plan or a debate — those file their split through their own
 * contract. A piece of one of them is refused too: its branch already merges into a plan branch, and
 * a second level of integration is a topology nothing here reviews.
 */
export function delegationRefusal(task: Task): string | null {
  if (isIntegrationParent(task)) return null
  if (task.kind !== 'work' && task.kind !== 'conversation') {
    return `t${task.seq} is a ${task.kind} task, which cannot delegate`
  }
  if (isSplitWork(task)) {
    return (
      `t${task.seq} is itself a piece of a plan or a debate, so it cannot delegate further. ` +
      'If the piece is too big, say so with `ask_human`.'
    )
  }
  if (!delegationOn(task)) {
    return (
      `delegation is off for t${task.seq}. Do the work yourself, or ask the person to switch ` +
      'Delegate on for this thread.'
    )
  }
  return null
}

/**
 * Did the person's latest message ask for a delegation that has not been filed yet?
 *
 * ⛔ **This is what lets a `/delegate` skip the approval card, and it is narrow on purpose.** The
 * person's own command is the consent — but only for the delegation it asked for. Once one
 * delegation has been filed in answer to it, the next `task_split` is the agent's own idea again
 * and raises the card like any other.
 */
export function pendingDelegateRequest(taskId: string): boolean {
  const last = messagesFor(taskId).filter((m) => m.role === 'human').at(-1)
  if (!last || last.event !== 'command.delegate') return false
  return !delegationsFor(taskId).some((d) => d.requested && d.createdAt >= last.ts)
}

/**
 * The thread's Delegate switch.
 *
 * ⛔ **Never wider than the parent.** Turning it on for a task whose own parent cannot spawn would
 * be a person's preference widening authority an agent's chain had already narrowed, so it is
 * refused with the reason. Off is always allowed: narrowing is the cheap direction.
 *
 * ⚠️ It does not touch the session's MCP config — `task_split` stays registered and the daemon
 * refuses it — so switching costs no prompt-cache prefix. The agent is told on its next turn by the
 * `delegation.toggled` message, which travels in the prompt like any undelivered note.
 */
export function setDelegation(taskId: string, on: boolean): Task {
  const task = requireTask(taskId)
  if (delegationOn(task) === on) return task
  if (on && task.parentTaskId) {
    const parent = getTask(task.parentTaskId)
    if (parent && !delegationOn(parent)) {
      throw new Error(
        `t${task.seq} was filed by t${parent.seq}, which cannot delegate, so it cannot be given that authority here`
      )
    }
  }
  const allowed = on ? [...task.mandate.allowed, SPAWN] : task.mandate.allowed.filter((op) => op !== SPAWN)
  db()
    .prepare('update tasks set mandate_json = ?, updated_at = ? where id = ?')
    .run(JSON.stringify({ ...task.mandate, allowed }), Date.now(), task.id)
  addMessage(task.id, 'system', on ? 'Delegation switched on' : 'Delegation switched off', null, [], {
    event: 'delegation.toggled',
    detail: on
      ? 'The person switched delegation on for this thread: you may hand work to other agents with `task_split` again.'
      : 'The person switched delegation off for this thread: do not call `task_split`; do the work yourself.'
  })
  const next = requireTask(task.id)
  emit({ type: 'task.changed', task: next })
  return next
}

/** How a delegation's caller is woken. Passed in, so this module reads no scheduler binding. */
export interface DelegationWaker {
  /** Put the report into the caller's live session; false when there is none. */
  deliver(taskId: string, messageId: number, text: string): boolean
  /** Start a new run on the caller's thread. */
  requeue(taskId: string): unknown
}

/**
 * When the last piece of a delegation settles, tell its caller how every piece turned out — and,
 * for a conversation, wake it to review them.
 *
 * ⛔ **The ask is recorded before the wake, with a compare-and-set.** `reported_at` is written only
 * if it was still null, so two pieces settling together cannot both wake the caller — the loop
 * AGENTS.md names.
 *
 * ⚠️ A work task is not woken here. It is `blocked` on `settled` edges onto its pieces, exactly
 * like a planner, and `setStatus` admits it; the report written here is the undelivered note its
 * next run's prompt carries.
 */
export function reportDelegationIfSettled(childId: string, wake: DelegationWaker): void {
  const delegation = delegationOfChild(childId)
  if (!delegation || delegation.reportedAt !== null) return
  const pieces = delegation.childIds.map((id) => getTask(id)).filter((t): t is Task => !!t)
  if (pieces.some((p) => !SETTLED.includes(p.status))) return

  const claimed = db()
    .prepare('update delegations set reported_at = ? where id = ? and reported_at is null')
    .run(Date.now(), delegation.id)
  if (Number(claimed.changes) === 0) return

  const caller = getTask(delegation.taskId)
  if (!caller) return
  const report = delegationReport(caller, pieces)
  const id = addMessage(caller.id, 'system', report.headline, null, [], {
    event: 'delegation.settled',
    detail: report.body
  })
  emit({ type: 'task.changed', task: caller })
  log.info(`t${caller.seq}: delegated ${pieces.map((p) => `t${p.seq}`).join(', ')} settled`)

  if (caller.kind !== 'conversation') return
  // ⚠️ Only a conversation that is working or resting on its turn is woken. One the person stopped,
  // or one that has finished, keeps the report as a note for whenever it next runs. One resting
  // `blocked` on these pieces (t713) needs nothing here: its `settled` edges have already admitted it
  // to `ready`, before this listener ran, and the report is the next thing its turn reads.
  if (caller.status === 'running' || caller.status === 'assigned') {
    wake.deliver(caller.id, id, `${report.headline}\n${report.body}`)
  } else if (caller.status === 'awaiting_human') {
    wake.requeue(caller.id)
  }
}

/** The run note a completed piece reported with `task_complete`, when there is one. */
function completionNote(taskId: string): string | null {
  const run = runsFor(taskId).find((r) => r.outcome === 'completed' && r.note)
  return run?.note?.trim() || null
}

export function delegationReport(caller: Task, pieces: Task[]): { headline: string; body: string } {
  const headline =
    'Delegated work came back: ' + pieces.map((p) => `t${p.seq} ${p.status}`).join(', ')
  const lines = pieces.map((p) => {
    const label = (p.titleSummary ?? p.title.split(/\r?\n/)[0] ?? '').slice(0, 160)
    const where = p.status === 'completed' ? (p.branch ? ` on \`${p.branch}\`` : ' with no branch') : ''
    const why =
      p.status === 'completed'
        ? (completionNote(p.id) ? ` — ${completionNote(p.id)}` : '')
        : ` — ${p.holdReason ?? 'no reason recorded'}`
    return `  t${p.seq} · ${p.status}${where}${why}: ${label}`
  })
  const conversation = caller.kind === 'conversation'
  const body = [
    'How each piece turned out:',
    ...lines,
    '',
    'Review what came back before relying on it — `task_read` with a piece’s t-number shows its ' +
      'thread. Each completed piece was committed and checked on its own branch, cut from yours, and ' +
      'nothing has been merged for you: merge each one you want into your own branch with ' +
      '`git merge <branch>` in your workspace, resolve any conflict, and re-run the checks. Do not ' +
      'redo a failed piece yourself unless the person asks; say what failed.',
    conversation
      ? 'Then tell the person what came back and what you merged. If you decide not to use a ' +
        'completed piece, say why; when you later land, name it in `land_work`’s `set_aside`.'
      : 'Then finish the task as your instructions say.'
  ].join('\n')
  return { headline, body }
}

/**
 * Why landing this task's branch now would lose delegated work, or null when it would not.
 *
 * ⛔ **Pieces still running are always a refusal.** They were cut from this branch and a conversation
 * landing retires it. ⚠️ `checkMerged` adds the second half, for the agent's own `land_work`: a
 * completed piece whose branch is not in HEAD and that the agent did not name in `setAside`. A
 * person pressing Land is not second-guessed about merges they can see for themselves.
 *
 * ⚠️ Only delegations reported since this thread last landed are checked for merges. Anything
 * earlier was answered at that landing, and a piece set aside then would otherwise block for ever.
 */
export async function delegationLandingBlocker(
  taskId: string,
  workspacePath: string | null,
  opts: { checkMerged: boolean; setAside?: number[] }
): Promise<string | null> {
  const delegations = delegationsFor(taskId)
  if (delegations.length === 0) return null
  const pieces = (ids: string[]): Task[] => ids.map((id) => getTask(id)).filter((t): t is Task => !!t)

  const open = pieces(delegations.flatMap((d) => d.childIds)).filter((p) => !SETTLED.includes(p.status))
  if (open.length > 0) {
    const named = open.map((p) => `t${p.seq}`).join(', ')
    return (
      `delegated pieces are still running (${named}). They were cut from this branch, and landing ` +
      'retires it. Wait until they settle — you will be told — or ask the person to cancel them.'
    )
  }
  if (!opts.checkMerged || !workspacePath) return null

  const lastLanded = messagesFor(taskId)
    .filter((m) => m.event === 'landing.landed')
    .at(-1)?.ts ?? 0
  const recent = delegations.filter((d) => d.reportedAt !== null && d.reportedAt > lastLanded)
  const setAside = new Set(opts.setAside ?? [])
  const unmerged: Task[] = []
  for (const piece of pieces(recent.flatMap((d) => d.childIds))) {
    if (piece.status !== 'completed' || !piece.branch || setAside.has(piece.seq)) continue
    const tip = await tryGit(workspacePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${piece.branch}`])
    if (!tip) continue
    const inHead = await tryGit(workspacePath, ['merge-base', '--is-ancestor', tip.trim(), 'HEAD'])
    if (inHead === null) unmerged.push(piece)
  }
  if (unmerged.length === 0) return null
  return (
    `the work of ${unmerged.map((p) => `t${p.seq} (\`${p.branch}\`)`).join(', ')} is not in this ` +
    'branch. Merge each with `git merge <branch>` and re-run the checks, or — if you reviewed it and ' +
    'chose not to use it — pass its number in `set_aside`.'
  )
}

/**
 * What the agent is told about delegation in its opening contract, where it may delegate.
 *
 * ⚠️ One clause, named only where it applies — `task_split` is registered for every session, and
 * this is what makes a work task or a conversation aware it can use it.
 */
export function delegationClause(conversation: boolean): string {
  return (
    'You may delegate: if part of this work would be better done by another agent — in parallel, ' +
    'or on a cheaper model — commit what the pieces will need, then call `task_split` with a ' +
    'self-contained instruction for each piece (optionally a `class` hint: low, med or high). The ' +
    'person approves the pieces before anything is filed. Each piece is committed and checked on ' +
    'its own branch, cut from yours, and nothing is merged for you: when every piece has settled ' +
    'you are told how each turned out and you merge what you want yourself. ' +
    (conversation
      ? 'The conversation carries on while they run. '
      : 'This task waits while they run and you are started again when they settle. ') +
    'Do not delegate what you would finish sooner yourself.'
  )
}

/**
 * A person's `/delegate` message, as the agent receives it.
 *
 * ⚠️ Two versions, from `capabilities.mcp` and never from an adapter name. An agent with no MCP has
 * no `task_split`, so it is asked for the instructions in its reply instead — a channel it has.
 */
export function delegateCommandPrompt(text: string, mcp: boolean): string {
  const asked = text.trim() || '(what you and the person have just been discussing)'
  const lead =
    'The person used /delegate: they want the following handed to other agents rather than done by ' +
    'you in this session.\n\n' +
    asked +
    '\n\n'
  if (!mcp) {
    return (
      lead +
      'This CLI has no Warmstart tools for filing work, so write a self-contained instruction for ' +
      'each piece in your reply — one piece if it is one job — so the person can file them. Do not ' +
      'do the delegated work yourself.'
    )
  }
  return (
    lead +
    'Prepare the delegation: work out the pieces — one if it is one job, several with dependency ' +
    'edges if it splits — commit anything they will need from your workspace, and call `task_split` ' +
    'once with a self-contained instruction for each, because the agent that runs a piece has not ' +
    'read this conversation. Because the person asked, the pieces are filed without a further ' +
    'approval card. Do not do the delegated work yourself; when `task_split` returns, do what its ' +
    'reply says.'
  )
}
