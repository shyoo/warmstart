import type {
  Conversation,
  ConversationRun,
  ConversationTask,
  SessionState
} from '@shared/protocol.js'
import type { RunOutcome } from '@shared/tasks.js'
import { db, rows } from './db.js'
import { getProject } from './projects.js'
import { listWorkers } from './workers.js'

/**
 * What each conversation has been used for.
 *
 * ⛔ **Derived, never stored.** Which tasks a conversation served is a fact about the `runs` table,
 * and a cached copy would be one more thing to keep in step with it — the class of bug migration 5
 * already had to repair once, on counters that only ever added. This is a join, asked when somebody
 * opens the page.
 *
 * ⚠️ The whole reason this view exists: once a session can outlive the task that opened it, "which
 * conversation is this task in, and who else has been in it?" stops being answerable from the task
 * list. A conversation with three tasks against it is either the cost saving working or two agents
 * reading work they should not have been shown, and those look identical from every other screen.
 */

interface Row {
  session_id: string
  vendor_session_id: string | null
  adapter_id: string
  worker_id: string
  project_id: string | null
  cwd: string
  state: SessionState
  current_branch: string | null
  context_tokens: number | null
  started_at: number
  closed_at: number | null
  purpose: string
}

/**
 * One run, as the row it was written as.
 *
 * ⛔ **Per run, not grouped per task.** The old query did `group by session_id, task_id`, which threw
 * away the only sequence anybody wants to review: one conversation here took nine turns across
 * several attempts at its task, and the page rendered that as the single line `1 task`. Grouping is
 * now done in TypeScript, from rows that still remember what order they happened in.
 */
interface RunRow {
  run_id: string
  session_id: string
  task_id: string
  seq: number
  title: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  started_warm: number | null
  model: string | null
  tokens: number | null
}

/**
 * Every work conversation, newest first, with what it served.
 *
 * ⛔ `purpose = 'work'` only. A login terminal, a usage probe and a consult are all sessions and none
 * of them is a *conversation* in the sense this page is about — listing them would bury the twenty
 * rows somebody came to read under a hundred they did not.
 */
/**
 * How many rows this will return, whatever it was asked for.
 *
 * ⛔ A bound, not a paging feature. This page can be asked for every session an install has ever
 * opened, and an unbounded `limit` is a request to serialise the database into a websocket frame.
 * Exported so the clamp is checkable without inserting five hundred rows to observe it.
 */
export function conversationLimit(asked?: number): number {
  return Math.min(Math.max(asked ?? 50, 1), 500)
}

export function listConversations(opts: { projectId?: string; limit?: number } = {}): Conversation[] {
  const limit = conversationLimit(opts.limit)
  const args: string[] = []
  let where = "where s.purpose = 'work'"
  if (opts.projectId) {
    where += ' and s.project_id = ?'
    args.push(opts.projectId)
  }

  const sessions = rows<Row>(
    db()
      .prepare(
        `select s.id as session_id, s.vendor_session_id, s.adapter_id, s.worker_id, s.project_id,
                s.cwd, s.state, s.current_branch, s.context_tokens, s.started_at, s.closed_at,
                s.purpose
           from sessions s ${where}
          order by s.started_at desc
          limit ?`
      )
      .all(...args, limit)
  )
  if (sessions.length === 0) return []

  // ⚠️ One query for every session's runs rather than one per session. A page that issued N+1
  // queries would be fine at twenty conversations and unusable at the five hundred this can return.
  const ids = sessions.map((s) => s.session_id)
  const served = rows<RunRow>(
    db()
      .prepare(
        // ⚠️ `title` is coalesced to the controller's one-line label where there is one, because
        // `t.title` is the *prompt* and this page draws it in a single-line button. The task's own
        // screens are where the full text belongs; here it would fill the row and say nothing.
        `select r.id as run_id, r.session_id, r.task_id, t.seq,
                coalesce(t.title_summary, t.title) as title,
                r.started_at, r.ended_at, r.outcome, r.started_warm, r.model,
                r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens
                  as tokens
           from runs r join tasks t on t.id = r.task_id
          where r.session_id in (${ids.map(() => '?').join(',')})
          order by r.started_at, r.rowid`
      )
      .all(...ids)
  )

  // ⚠️ Grouped in insertion order, which the `order by` above made chronological. A Map preserves
  // it, so the tasks come out in the order the conversation first met them and each one's runs come
  // out in the order they ran — without a second sort that could disagree with the query's.
  const bySession = new Map<string, Map<string, ConversationTask>>()
  for (const r of served) {
    const run: ConversationRun = {
      runId: r.run_id,
      taskId: r.task_id,
      seq: r.seq,
      title: r.title,
      startedAt: r.started_at,
      // ⚠️ Null means *still going*, and only that. A run whose row has no end is in flight.
      endedAt: r.ended_at,
      outcome: (r.outcome as RunOutcome | null) ?? null,
      // ⛔ Null stays null. A run recorded before `started_warm` existed answered nothing, and
      // rendering it as a cold start would put a measurement nobody took beside ones that were taken.
      startedWarm: r.started_warm === null ? null : r.started_warm === 1,
      tokens: r.tokens ?? 0,
      model: r.model
    }
    const tasksHere = bySession.get(r.session_id) ?? new Map<string, ConversationTask>()
    const existing = tasksHere.get(r.task_id)
    if (existing) {
      existing.runs += 1
      existing.lastAt = run.startedAt
      existing.tokens += run.tokens
      // ⚠️ Warm if *any* run of this task in here was warm, which is what `max(started_warm)` said
      // before and still means "did this task ever continue in here rather than start over".
      if (run.startedWarm !== null) {
        existing.startedWarm = existing.startedWarm === true || run.startedWarm
      }
      existing.timeline.push(run)
    } else {
      tasksHere.set(r.task_id, {
        taskId: r.task_id,
        seq: r.seq,
        title: r.title,
        runs: 1,
        firstAt: run.startedAt,
        lastAt: run.startedAt,
        startedWarm: run.startedWarm,
        tokens: run.tokens,
        timeline: [run]
      })
    }
    bySession.set(r.session_id, tasksHere)
  }

  const workers = new Map(listWorkers().map((w) => [w.id, w.label]))

  return sessions.map((s) => {
    const tasks = [...(bySession.get(s.session_id)?.values() ?? [])]
    const runs = tasks.flatMap((t) => t.timeline)
    return {
      sessionId: s.session_id,
      // ⚠️ The vendor's id where the CLI named its own conversation, ours where it took ours. This
      // is the string somebody types after `--resume` or `--conversation`, so it has to be the real
      // one rather than whichever we happen to file it under.
      conversationId: s.vendor_session_id ?? s.session_id,
      adapterId: s.adapter_id,
      workerId: s.worker_id,
      workerLabel: workers.get(s.worker_id) ?? s.worker_id.slice(0, 8),
      projectId: s.project_id,
      projectName: s.project_id ? (getProject(s.project_id)?.name ?? null) : null,
      cwd: s.cwd,
      state: s.state,
      currentBranch: s.current_branch,
      contextTokens: s.context_tokens,
      startedAt: s.started_at,
      closedAt: s.closed_at,
      tasks,
      // ⭐ The number this page exists to make visible. One task is the ordinary case; more than one
      // means a conversation was shared, which is either the saving working or a disclosure nobody
      // intended — and it is invisible from every other screen.
      taskCount: tasks.length,
      // ⭐ Beside it, the number that actually varies. Measured 2026-08-31: `taskCount` is 1 for
      // every conversation this fleet has ever opened, and `runCount` has been as high as nine.
      runCount: runs.length,
      outcome: conversationOutcome(runs),
      tokens: runs.reduce((sum, r) => sum + r.tokens, 0)
    }
  })
}

/**
 * What became of the work in a conversation, from the runs it served.
 *
 * ⛔ **Deliberately not `sessions.state`.** That column is a fact about a *process* — and until
 * migration 27 a wrong one, since killing a session we ourselves asked to stop exits non-zero and was
 * recorded as `failed`. Even repaired, "the process was closed" says nothing about whether the work
 * succeeded, and "did this succeed?" is the question somebody opens this page with.
 *
 * ⚠️ A run still in flight (`outcome: null`) is not an opinion either way, so it is skipped rather
 * than counted as a disagreement — otherwise every conversation would read `mixed` the moment it
 * started a second turn.
 *
 * ⛔ `failed` beats everything. A conversation where one run failed and three succeeded is not a
 * success with an asterisk; it is a conversation with a failure in it, and the whole point of the
 * column is that somebody scanning for trouble finds it.
 */
export function conversationOutcome(
  runs: Array<Pick<ConversationRun, 'outcome'>>
): RunOutcome | 'mixed' | null {
  const settled = runs.map((r) => r.outcome).filter((o): o is RunOutcome => o !== null)
  if (settled.length === 0) return null
  if (settled.includes('failed')) return 'failed'
  const first = settled[0]!
  return settled.every((o) => o === first) ? first : 'mixed'
}
