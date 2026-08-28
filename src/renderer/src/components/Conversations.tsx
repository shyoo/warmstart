import { useCallback, useEffect, useState } from 'react'
import type { Conversation } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { tokens, when } from '../lib/format'

/**
 * Which conversation served which tasks.
 *
 * ⛔ **This page exists because one number is invisible everywhere else: how many tasks have been in
 * one conversation.** A task's own pane says which conversation it is in; nothing said who *else* had
 * been in it. Once a session outlives the task that opened it, that is the difference between the
 * cost saving working and two agents having read work nobody meant to show them, and the two look
 * identical from the task list.
 *
 * ⚠️ Read-only, deliberately. The only honest actions here would be "run a task in this conversation",
 * which the task pane already offers, and "close it", which the cache clock owns — and a close button
 * beside a live agent is an invitation to kill a run by tidying up.
 */
export function Conversations(): React.JSX.Element {
  const [rowsData, setRows] = useState<Conversation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRows(await rpc('conversation.list', {}))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A run starting or ending is what changes this page, so it follows the same events the task list
  // does rather than polling.
  useDaemonEvents((event) => {
    if (event.type === 'run.changed' || event.type === 'session.changed') void refresh()
  })

  const live = rowsData.filter((c) => c.state !== 'closed' && c.state !== 'failed')
  const shared = rowsData.filter((c) => c.taskCount > 1)

  return (
    <section>
      <header className="page-head">
        <h1>Conversations</h1>
        <p className="note">
          Every agent conversation this fleet has opened, and what each one was used for.{' '}
          <strong>{live.length}</strong> live · <strong>{shared.length}</strong> served more than one
          task. ⚠️ A conversation with several tasks against it was <em>shared</em> — the agent in it
          saw all of their work. See <code>docs/sessions.md</code>.
        </p>
      </header>

      {error && <div className="alert">{error}</div>}

      {rowsData.length === 0 ? (
        <p className="note">No conversations yet. One is opened the first time a task is dispatched.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>conversation</th>
              <th>account</th>
              <th>project</th>
              <th>branch</th>
              <th className="num">context</th>
              <th className="num">tasks</th>
              <th>state</th>
              <th>started</th>
            </tr>
          </thead>
          <tbody>
            {rowsData.map((c) => (
              <ConversationRow
                key={c.sessionId}
                conversation={c}
                expanded={open === c.sessionId}
                onToggle={() => setOpen(open === c.sessionId ? null : c.sessionId)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ConversationRow({
  conversation: c,
  expanded,
  onToggle
}: {
  conversation: Conversation
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const closed = c.state === 'closed' || c.state === 'failed'
  return (
    <>
      <tr className={closed ? 'row-dim' : ''} onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td>
          {/* ⚠️ The vendor's id, not ours — this is the string that goes after `--resume` or
              `--conversation`, so it is the one worth being able to copy out of here. */}
          <span className="mono" title={c.conversationId}>
            {c.conversationId.slice(0, 8)}
          </span>{' '}
          <span className="dim">{c.adapterId}</span>
        </td>
        <td>{c.workerLabel}</td>
        <td>{c.projectName ?? <span className="dim">—</span>}</td>
        <td className="mono">
          {c.currentBranch ? (
            c.currentBranch.replace(/^multi-agent-controller\//, '')
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td className="num">{tokens(c.contextTokens)}</td>
        <td className="num">
          {/* ⭐ The one number this page is for. Anything above 1 is a shared conversation. */}
          {c.taskCount > 1 ? (
            <strong title="Shared — the agent in this conversation saw every one of these tasks.">
              {c.taskCount}
            </strong>
          ) : (
            c.taskCount
          )}
        </td>
        <td>
          <span className={closed ? 'dim' : 'state-running'}>{c.state}</span>
        </td>
        <td className="dim">{when(c.startedAt)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8}>
            <div className="side-runs">
              <div className="side-label">{c.cwd}</div>
              {c.tasks.length === 0 ? (
                <p className="note">
                  No run has been recorded against this conversation. It was opened and never used —
                  a dispatch that failed before its first turn.
                </p>
              ) : (
                c.tasks.map((t) => (
                  <div className="side-run" key={t.taskId}>
                    <div className="side-run-head">
                      <span className="mono">t{t.seq}</span>
                      <span>{t.title}</span>
                      {/* ⛔ Nothing at all when it was never recorded, rather than `new`. */}
                      {t.startedWarm !== null && (
                        <span className={t.startedWarm ? 'ok' : 'dim'}>
                          {t.startedWarm ? 'warm' : 'new'}
                        </span>
                      )}
                    </div>
                    <div className="side-run-body num">
                      <span>
                        {t.runs} run{t.runs === 1 ? '' : 's'}
                      </span>
                      <span>{tokens(t.tokens || null)} spent</span>
                      <span className="dim">{when(t.firstAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
