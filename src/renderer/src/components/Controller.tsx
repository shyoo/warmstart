import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerReport } from '@shared/protocol'
import type { ChatMessage } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { age, tokens } from '../lib/format'

/**
 * The controller.
 *
 * Two halves, and the order is deliberate: the **conversation** first, because that is what an
 * operator came here for, and the **ledger** below it, because a judgment layer that cannot say what
 * it decided and what that cost is one you either over-trust or turn off.
 *
 * ⛔ A fallback is shown as an ordinary outcome, not an error. Falling back *is* the design working:
 * the deterministic answer fired because nothing better was available. A fleet whose every consult
 * falls back still makes progress — it just makes it with less judgment.
 */
export function Controller({ now }: { now: number }): React.JSX.Element {
  const [report, setReport] = useState<ControllerReport | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, history] = await Promise.all([rpc('controller.report', {}), rpc('chat.history', {})])
      setReport(next)
      setMessages(history)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => clearInterval(timer)
  }, [refresh])

  useDaemonEvents((event) => {
    if (event.type === 'chat.message') {
      setMessages((prev) =>
        prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]
      )
      setBusy(false)
    }
    if (event.type === 'consult.changed') void refresh()
  })

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setBusy(true)
    try {
      const result = await rpc('chat.send', { text })
      if (!result.ok) {
        setBusy(false)
        setError(result.reason ?? 'the controller could not be reached')
      }
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const available = report?.controllers.some((c) => c.available) ?? false

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Controller</h2>
          <p className="panel-sub">
            The judgment layer. It is never in the critical path — every question it is asked has a
            deterministic answer that fires on a timer if it does not reply.
          </p>
        </div>
        <span className="num dim">
          {report ? `${report.usedThisHour}/${report.hourlyCap} this hour` : '—'}
          {report && report.pending > 0 ? ` · ${report.pending} waiting` : ''}
        </span>
      </header>

      {error && <div className="alert">{error}</div>}

      {report && report.controllers.length === 0 && (
        <div className="empty-inline">
          <p>No account is designated a controller.</p>
          <p className="dim">
            Set one to <strong>controller</strong> or <strong>both</strong> in Workers. Until then
            every judgment call takes its deterministic answer — plans wait for you to break them up,
            repeatedly failing tasks park for you, and agent-filed work stays a draft. Nothing stalls.
          </p>
        </div>
      )}

      <section className="doc-section">
        <h3>Conversation</h3>
        <div className="thread thread--chat">
          {messages.length === 0 ? (
            <p className="dim">
              Ask it about the fleet, or tell it to file, rescope or promote work. Its tool use goes
              through the Approvals bar, the same as an agent’s.
            </p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`msg msg--${m.role}`}>
                <span className="msg-role">{m.role === 'controller' ? 'ctrl' : m.role}</span>
                <span className="msg-text">{m.text}</span>
              </div>
            ))
          )}
          {busy && <p className="dim">Thinking…</p>}
          <div ref={threadEnd} />
        </div>

        <div className="form-row">
          <input
            className="form-wide"
            value={draft}
            placeholder={
              available ? 'Say something to the controller' : 'No controller account is available'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) void send()
            }}
          />
          <div>
            <button className="btn btn--primary" disabled={!draft.trim()} onClick={() => void send()}>
              Send
            </button>
            <button
              className="btn btn--ghost"
              title="Close the session and start again. This throws away a warm prompt cache — worth it when the conversation has drifted, but it is a real cost."
              onClick={() => void rpc('chat.reset', {}).then(refresh)}
            >
              Reset
            </button>
          </div>
        </div>
      </section>

      <section className="doc-section">
        <h3>Judgment calls</h3>
        {!report || report.recent.length === 0 ? (
          <p className="dim">Nothing has needed judgment yet.</p>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Question</th>
                  <th>Result</th>
                  <th className="tbl-num">Spent</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.recent.map((c) => (
                  <tr key={c.id}>
                    <td className="dim num">{age(now - c.createdAt)}</td>
                    <td className="tbl-strong">{KIND_LABEL[c.kind] ?? c.kind}</td>
                    <td>
                      <span className={`status ${STATUS_TONE[c.status] ?? ''}`}>
                        {c.status === 'fallback' ? 'fell back' : c.status}
                      </span>
                    </td>
                    <td className="num tbl-num">{tokens(c.spentTokens || null)}</td>
                    <td className="dim">
                      {c.outcome ?? '—'}
                      {c.fallbackReason ? ` (${c.fallbackReason})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">
              <strong>{tokens(report.spentTokens)}</strong> spent on judgment across these{' '}
              {report.recent.length}, {report.fallbacks} of which took the deterministic answer.
            </p>
          </>
        )}
      </section>

      {report && report.controllers.length > 0 && (
        <section className="doc-section">
          <h3>Who can be asked</h3>
          <table className="tbl">
            <tbody>
              {report.controllers.map((c) => (
                <tr key={c.workerId}>
                  <td className="tbl-strong">{c.label}</td>
                  <td className="dim">{c.role}</td>
                  <td>
                    <span className={`status ${c.available ? 'state-ok' : 'state-idle'}`}>
                      {c.available ? 'ready' : 'not now'}
                    </span>
                  </td>
                  <td className="dim">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            <strong>Leadership delegation is just the gates.</strong> An account near the top of its
            window stops being chosen and the next question routes elsewhere; when none is left, the
            deterministic answer is used. Nothing special happens at the floor — that <em>is</em> the
            floor.
          </p>
        </section>
      )}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  decompose: 'break this up',
  triage: 'why does it keep failing',
  gate: 'should this task exist',
  route: 'which worker'
}

const STATUS_TONE: Record<string, string> = {
  pending: 'state-running',
  answered: 'state-ok',
  fallback: 'state-idle',
  failed: 'state-warn'
}
