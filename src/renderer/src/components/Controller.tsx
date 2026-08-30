import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerReport } from '@shared/protocol'
import type { ChatMessage, Consult, ConsultKind } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { age, duration, tokens, when } from '../lib/format'
import { Working } from '../lib/taskview'

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
  const [openConsultId, setOpenConsultId] = useState<string | null>(null)
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
            <p className="dim">Ask it about the fleet, or tell it to file, rescope or promote work.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`msg msg--${m.role}`}>
                <span className="msg-role">
                  {m.role === 'controller' ? 'ctrl' : m.role}
                  {/* The same clock the task thread carries: a conversation held across a working
                      day cannot be read without one. */}
                  <span className="msg-when" title={new Date(m.ts).toLocaleString()}>
                    {when(m.ts)}
                  </span>
                </span>
                <span className="msg-text">{m.text}</span>
              </div>
            ))
          )}
          {/* ⚠️ A live bubble in the thread, not a line of grey text under it — the controller is
              answering *here*, in sequence, and marked as unfinished for as long as that is true. */}
          {busy && (
            <div className="msg msg--controller msg--live">
              <span className="msg-role">ctrl</span>
              <span className="msg-text">
                <span className="dim">thinking</span>
                <Working />
              </span>
            </div>
          )}
          <div ref={threadEnd} />
        </div>

        {/*
          ⚠️ `.compose`, not `.form-row`. That is a three-column grid built for a labelled settings
          form, and this row has no label — so the input was laid into the 110px label track and the
          Send/Reset pair was painted over the top of the placeholder, which is why "No controller
          account is available" read as if it had a button sitting on it. Same layout the task
          thread's composer uses, so the two read as the same control.
        */}
        <div className="compose">
          <div className="compose-row">
            <input
              value={draft}
              disabled={!available}
              placeholder={
                available ? 'Say something to the controller' : 'No controller account is available'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void send()
              }}
            />
            <button
              className="btn btn--primary"
              disabled={busy || !available || !draft.trim()}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button
              className="btn btn--ghost"
              title="Close the session and start again. This throws away a warm prompt cache — worth it when the conversation has drifted, but it is a real cost."
              onClick={() => void rpc('chat.reset', {}).then(refresh)}
            >
              Reset
            </button>
          </div>
          <p className="compose-hint">
            {available
              ? 'Enter sends. Its tool use goes through the Approvals bar, the same as an agent’s.'
              : 'Every controller account is out of window or not designated. Judgment calls take ' +
                'their deterministic answer until one is back — nothing stalls, it just waits.'}
          </p>
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
                  <th style={{ width: '80px' }}>When</th>
                  <th style={{ width: '110px' }}>Type</th>
                  <th style={{ width: '160px' }}>Subject</th>
                  <th style={{ width: '120px' }}>Evaluator</th>
                  <th style={{ width: '90px' }}>Result</th>
                  <th className="tbl-num" style={{ width: '70px' }}>Spent</th>
                  <th>Decision &amp; Rationale</th>
                  <th style={{ width: '30px' }} />
                </tr>
              </thead>
              <tbody>
                {report.recent.map((c) => {
                  const isOpen = openConsultId === c.id
                  return (
                    <ConsultRowItem
                      key={c.id}
                      consult={c}
                      now={now}
                      isOpen={isOpen}
                      onToggle={() => setOpenConsultId(isOpen ? null : c.id)}
                    />
                  )
                })}
              </tbody>
            </table>
            <p className="note">
              <strong>{tokens(report.spentTokens)}</strong> spent on judgment across these{' '}
              {report.recent.length}, {report.fallbacks} of which took the deterministic answer. Click
              any judgment call to inspect the full decision rationale, subtasks, or prompt telemetry.
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

function ConsultRowItem({
  consult: c,
  now,
  isOpen,
  onToggle
}: {
  consult: Consult
  now: number
  isOpen: boolean
  onToggle: () => void
}): React.JSX.Element {
  const subjectDisplay = c.subjectSeq !== null && c.subjectSeq !== undefined
    ? `t${c.subjectSeq}${c.subjectTitle ? ` · ${c.subjectTitle}` : ''}`
    : c.subjectId
      ? c.subjectId.slice(0, 8)
      : '—'

  return (
    <>
      <tr
        className={`consult-row ${isOpen ? 'consult-row--open' : ''}`}
        onClick={onToggle}
        title="Click to view detailed decision, rationale, and prompt telemetry"
      >
        <td className="dim num tbl-when" title={new Date(c.createdAt).toLocaleString()}>
          {age(now - c.createdAt)}
        </td>
        <td>
          <span className="consult-kind-tag">{KIND_LABEL[c.kind] ?? c.kind}</span>
        </td>
        <td className="mono" title={c.subjectTitle ?? c.subjectId ?? ''}>
          {subjectDisplay}
        </td>
        <td className="dim">
          {c.workerLabel ?? (c.workerId ? c.workerId.slice(0, 8) : '—')}
        </td>
        <td>
          <span className={`status ${STATUS_TONE[c.status] ?? ''}`}>
            {c.status === 'fallback' ? 'fell back' : c.status}
          </span>
        </td>
        <td className="num tbl-num">{tokens(c.spentTokens || null)}</td>
        <td>
          <span className="tbl-strong">{c.outcome ?? '—'}</span>
          {c.fallbackReason && (
            <span className="dim"> ({c.fallbackReason})</span>
          )}
        </td>
        <td className="dim text-center">
          {isOpen ? '▼' : '▶'}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={8} className="consult-detail-cell">
            <ConsultDetailPane consult={c} />
          </td>
        </tr>
      )}
    </>
  )
}

function ConsultDetailPane({ consult: c }: { consult: Consult }): React.JSX.Element {
  const durationMs = c.startedAt && c.endedAt ? c.endedAt - c.startedAt : null
  const answer = (c.answer && typeof c.answer === 'object' ? c.answer : {}) as Record<string, unknown>

  return (
    <div className="consult-detail-pane">
      {/* Telemetry metadata bar */}
      <div className="consult-meta-bar">
        {c.subjectId && (
          <div className="consult-meta-item">
            Subject:{' '}
            <strong>
              {c.subjectSeq !== null && c.subjectSeq !== undefined ? `t${c.subjectSeq}` : ''}
              {c.subjectTitle ? ` ${c.subjectTitle}` : ` (${c.subjectId})`}
            </strong>
          </div>
        )}
        <div className="consult-meta-item">
          Evaluator:{' '}
          <strong>{c.workerLabel ?? (c.workerId ? c.workerId : 'Deterministic Fallback')}</strong>
        </div>
        {c.sessionId && (
          <div className="consult-meta-item">
            Session: <span className="mono">{c.sessionId.slice(0, 8)}</span>
          </div>
        )}
        {durationMs !== null && (
          <div className="consult-meta-item">
            Duration: <span className="num">{duration(durationMs)}</span>
          </div>
        )}
        <div className="consult-meta-item">
          Spent: <span className="num">{tokens(c.spentTokens)} tokens</span>
        </div>
        <div className="consult-meta-item">
          Recorded: <span className="dim">{when(c.createdAt)}</span>
        </div>
      </div>

      {/* Decision & Rationale view */}
      <div className="consult-decision-block">
        <ConsultAnswerBody kind={c.kind} status={c.status} answer={answer} outcome={c.outcome} fallbackReason={c.fallbackReason} />
      </div>

      {/* Prompt and raw JSON inspector */}
      {c.question && (
        <details className="consult-accordion">
          <summary>Prompt sent to controller</summary>
          <pre className="consult-accordion-body">{c.question}</pre>
        </details>
      )}

      {c.answer !== null && c.answer !== undefined && (
        <details className="consult-accordion">
          <summary>Raw JSON answer</summary>
          <pre className="consult-accordion-body">{JSON.stringify(c.answer, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

function ConsultAnswerBody({
  kind,
  status,
  answer,
  outcome,
  fallbackReason
}: {
  kind: ConsultKind
  status: string
  answer: Record<string, unknown>
  outcome: string | null
  fallbackReason: string | null
}): React.JSX.Element {
  if (status === 'fallback') {
    return (
      <div className="consult-why-box consult-why-box--fallback">
        <div className="consult-why-title">Deterministic Fallback Applied</div>
        <div>
          <strong>Outcome:</strong> {outcome ?? '—'}
        </div>
        {fallbackReason && (
          <div className="dim" style={{ marginTop: '4px' }}>
            <strong>Reason for fallback:</strong> {fallbackReason}
          </div>
        )}
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="consult-why-box consult-why-box--failed">
        <div className="consult-why-title">Judgment Call Dropped / Failed</div>
        <div>{outcome ?? fallbackReason ?? 'The consult was cancelled or dropped.'}</div>
      </div>
    )
  }

  const why = typeof answer.why === 'string' ? answer.why.trim() : null
  const note = typeof answer.note === 'string' ? answer.note.trim() : null

  switch (kind) {
    case 'decompose': {
      const children = Array.isArray(answer.children) ? (answer.children as Array<Record<string, unknown>>) : []
      return (
        <div>
          {note && (
            <div className="consult-why-box" style={{ marginBottom: 'var(--sp-2)' }}>
              <div className="consult-why-title">Controller Planning Note</div>
              <div>{note}</div>
            </div>
          )}
          <div className="side-label">
            Generated {children.length} draft task{children.length === 1 ? '' : 's'} in dependency order:
          </div>
          <div className="consult-subtasks">
            {children.map((child, i) => {
              const deps = Array.isArray(child.dependsOn) ? (child.dependsOn as number[]) : []
              return (
                <div key={i} className="consult-subtask-card">
                  <div className="consult-subtask-header">
                    <span className="consult-subtask-title">
                      <span className="mono dim" style={{ marginRight: '6px' }}>
                        #{i + 1}
                      </span>
                      {typeof child.title === 'string' && child.title.trim() ? child.title.trim() : 'Untitled'}
                    </span>
                    <div className="consult-subtask-tags">
                      {deps.length > 0 && (
                        <span>
                          Depends on {deps.map((d) => `#${d + 1}`).join(', ')}
                        </span>
                      )}
                      {typeof child.estTokens === 'number' && child.estTokens > 0 && (
                        <span className="num">~{tokens(child.estTokens)}</span>
                      )}
                    </div>
                  </div>
                  {typeof child.acceptance === 'string' && child.acceptance.trim() && (
                    <div className="consult-subtask-acceptance">
                      <span className="dim">Done when:</span> {child.acceptance.trim()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    case 'triage': {
      const action = typeof answer.action === 'string' ? answer.action : 'unknown'
      const prompt = typeof answer.prompt === 'string' ? answer.prompt : null
      const model = typeof answer.model === 'string' ? answer.model : null
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <div className="consult-why-box">
            <div className="consult-why-title">Triage Action: {action.toUpperCase()}</div>
            {why && <div><strong>Rationale:</strong> {why}</div>}
            {model && <div style={{ marginTop: '4px' }}><strong>Target Model:</strong> <span className="mono">{model}</span></div>}
          </div>
          {prompt && (
            <div>
              <div className="side-label">Rewritten Instruction for Next Run:</div>
              <div className="consult-code-preview">{prompt}</div>
            </div>
          )}
        </div>
      )
    }

    case 'gate': {
      const verdict = typeof answer.verdict === 'string' ? answer.verdict : 'unknown'
      const title = typeof answer.title === 'string' ? answer.title : null
      return (
        <div className="consult-why-box">
          <div className="consult-why-title">Gate Verdict: {verdict.toUpperCase()}</div>
          {why && <div><strong>Rationale:</strong> {why}</div>}
          {title && <div style={{ marginTop: '4px' }}><strong>Rescoped Title:</strong> &ldquo;{title}&rdquo;</div>}
        </div>
      )
    }

    case 'route': {
      const workerId = typeof answer.workerId === 'string' ? answer.workerId : null
      return (
        <div className="consult-why-box">
          <div className="consult-why-title">Routing Decision</div>
          {workerId && <div><strong>Selected Worker:</strong> <span className="mono">{workerId}</span></div>}
          {why && <div style={{ marginTop: '4px' }}><strong>Rationale:</strong> {why}</div>}
        </div>
      )
    }
  }
}

const KIND_LABEL: Record<string, string> = {
  decompose: 'Break up',
  triage: 'Triage',
  gate: 'Gate',
  route: 'Route'
}

const STATUS_TONE: Record<string, string> = {
  pending: 'state-running',
  answered: 'state-ok',
  fallback: 'state-idle',
  failed: 'state-warn'
}

