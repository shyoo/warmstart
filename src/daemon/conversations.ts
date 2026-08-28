import type { Conversation, ConversationTask } from '@shared/protocol.js'
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
  state: string
  current_branch: string | null
  context_tokens: number | null
  started_at: number
  closed_at: number | null
  purpose: string
}

interface ServedRow {
  session_id: string
  task_id: string
  seq: number
  title: string
  runs: number
  first_at: number
  last_at: number
  started_warm: number | null
  tokens: number
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

  // ⚠️ One query for every session's tasks rather than one per session. A page that issued N+1
  // queries would be fine at twenty conversations and unusable at the five hundred this can return.
  const ids = sessions.map((s) => s.session_id)
  const served = rows<ServedRow>(
    db()
      .prepare(
        `select r.session_id, r.task_id, t.seq, t.title,
                count(*) as runs,
                min(r.started_at) as first_at,
                max(r.started_at) as last_at,
                max(r.started_warm) as started_warm,
                sum(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens)
                  as tokens
           from runs r join tasks t on t.id = r.task_id
          where r.session_id in (${ids.map(() => '?').join(',')})
          group by r.session_id, r.task_id
          order by first_at`
      )
      .all(...ids)
  )

  const bySession = new Map<string, ConversationTask[]>()
  for (const r of served) {
    const list = bySession.get(r.session_id) ?? []
    list.push({
      taskId: r.task_id,
      seq: r.seq,
      title: r.title,
      runs: r.runs,
      firstAt: r.first_at,
      lastAt: r.last_at,
      // ⛔ Null stays null. A run recorded before `started_warm` existed answered nothing, and
      // rendering it as a cold start would put a measurement nobody took beside ones that were taken.
      startedWarm: r.started_warm === null ? null : r.started_warm === 1,
      tokens: r.tokens ?? 0
    })
    bySession.set(r.session_id, list)
  }

  const workers = new Map(listWorkers().map((w) => [w.id, w.label]))

  return sessions.map((s) => {
    const tasks = bySession.get(s.session_id) ?? []
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
      taskCount: tasks.length
    }
  })
}
