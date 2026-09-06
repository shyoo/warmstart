import { useCallback, useEffect, useRef, useState } from 'react'
import type { ControllerReport } from '@shared/protocol'
import type { RoutingDecision } from '@shared/routing'
import type { ChatMessage, Consult, ConsultKind } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { isSubmitKey, useUiSettings } from '../lib/uisettings'
import { duration, tokens, when } from '../lib/format'
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

/**
 * A row in the unified judgment-call ledger.
 *
 * ⚠️ Two kinds of event belong here: controller consults (LLM-backed judgment calls) and
 * tool-dispatched routing decisions (where the scoring arithmetic decided without asking a
 * controller). The user asked for both, so they can see every routing choice — scored and
 * explained — not only the ones that spent tokens.
 *
 * ⛔ `controller` basis routing decisions are already shown as `route` consult rows. We therefore
 * skip them here: showing both would double-count the same event.
 */
type JudgmentRow =
  | { kind: 'consult'; id: string; ts: number; data: Consult }
  | { kind: 'tool-dispatch'; id: string; ts: number; data: RoutingDecision }

function toRows(consults: Consult[], toolDispatches: RoutingDecision[]): JudgmentRow[] {
  const rows: JudgmentRow[] = [
    ...consults.map((c): JudgmentRow => ({ kind: 'consult', id: c.id, ts: c.createdAt, data: c })),
    // ⛔ Skip controller-basis decisions — those are already in the consults table as `route` rows.
    ...toolDispatches
      .filter((d) => d.basis !== 'controller')
      .map((d): JudgmentRow => ({ kind: 'tool-dispatch', id: d.id, ts: d.decidedAt, data: d }))
  ]
  rows.sort((a, b) => b.ts - a.ts)
  return rows
}

const TOOL_DISPATCH_FETCH = 40

export function Controller(_props: { now: number }): React.JSX.Element {
  const { settings } = useUiSettings()
  const [report, setReport] = useState<ControllerReport | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [toolDispatches, setToolDispatches] = useState<RoutingDecision[]>([])
  const threadEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, history, routingPage] = await Promise.all([
        rpc('controller.report', { limit: pageSize, offset: page * pageSize }),
        rpc('chat.history', {}),
        // ⚠️ Fetch enough routing decisions to give the merged view enough to paginate. We fetch a
        // fixed-size window rather than paginating separately, because the merge sorts by time and
        // a separately-paginated pair would interleave in ways that confuse a pager.
        rpc('routing.decisions', { limit: TOOL_DISPATCH_FETCH, offset: 0 })
      ])
      setReport(next)
      setMessages(history)
      setToolDispatches(routingPage.decisions)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [page, pageSize])

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
    if (event.type === 'task.changed') void refresh()
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

  // ⚠️ Merge consult rows with tool-dispatched routing rows, then paginate the merged list.
  const allRows = report ? toRows(report.recent, toolDispatches) : []

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
                  {m.role === 'controller' ? 'CONTROLLER' : m.role.toUpperCase()}
                  {m.role === 'controller' && m.workerLabel ? ` · ${m.workerLabel}` : ''}
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
              <span className="msg-role">CONTROLLER</span>
              <span className="msg-text">
                <span className="dim">thinking</span>
                <Working />
              </span>
            </div>
          )}
          <div ref={threadEnd} />
        </div>

        {/* `.compose` has no label track, unlike the settings form grid. */}
        <div className="compose">
          <div className="compose-row">
            <textarea
              className="compose-input"
              rows={1}
              value={draft}
              disabled={!available}
              placeholder={
                available ? 'Say something to the controller' : 'No controller account is available'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitKey(e, settings.enterBehavior) && draft.trim() && !busy && available) {
                  e.preventDefault()
                  void send()
                }
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
              disabled={messages.length === 0}
              title="Clear the messages shown here. The controller session remains available for the next message."
              onClick={() => void rpc('chat.clear', {}).then(refresh)}
            >
              Clear
            </button>
          </div>
          <p className="compose-hint">
            {available
              ? "Enter sends. Its tool use goes through the Attention bar, the same as an agent\u2019s."
              : 'Every controller account is out of window or not designated. Judgment calls take ' +
                'their deterministic answer until one is back — nothing stalls, it just waits.'}
          </p>
        </div>
      </section>

      <section className="doc-section">
        <h3>Judgment calls</h3>
        {!report || allRows.length === 0 ? (
          <p className="dim">Nothing has needed judgment yet.</p>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '180px' }}>When</th>
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
                {allRows.map((row) => {
                  const isOpen = openRowId === row.id
                  if (row.kind === 'consult') {
                    return (
                      <ConsultRowItem
                        key={row.id}
                        consult={row.data}
                        isOpen={isOpen}
                        onToggle={() => setOpenRowId(isOpen ? null : row.id)}
                      />
                    )
                  }
                  return (
                    <ToolDispatchRow
                      key={row.id}
                      decision={row.data}
                      isOpen={isOpen}
                      onToggle={() => setOpenRowId(isOpen ? null : row.id)}
                    />
                  )
                })}
              </tbody>
            </table>
            <div className="form-actions" style={{ justifyContent: 'space-between' }}>
              <span className="note">
                Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, report.total)} of {report.total}
              </span>
              <span className="form-actions">
                <label className="dim">
                  Per page{' '}
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value))
                      setPage(0)
                    }}
                  >
                    {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
                <button className="btn btn--ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <button className="btn btn--ghost" disabled={(page + 1) * pageSize >= report.total} onClick={() => setPage((p) => p + 1)}>Next</button>
              </span>
            </div>
            <p className="note">
              <strong>{tokens(report.spentTokens)}</strong> spent on judgment across these{' '}
              {report.recent.length}, {report.fallbacks} of which took the deterministic answer. Click
              any judgment call to inspect the full decision rationale, subtasks, or prompt telemetry.
              Tool-dispatched rows show scoring arithmetic and cost no tokens.
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

// ---------------------------------------------------------------------------- consult row (controller-backed)

function ConsultRowItem({
  consult: c,
  isOpen,
  onToggle
}: {
  consult: Consult
  isOpen: boolean
  onToggle: () => void
}): React.JSX.Element {
  const subjectTitle = truncate(c.subjectTitle ?? '', 52)
  const subjectDisplay = c.subjectSeq !== null && c.subjectSeq !== undefined
    ? `t${c.subjectSeq}${subjectTitle ? ` · ${subjectTitle}` : ''}`
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
          {new Date(c.createdAt).toLocaleString()}
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

// ---------------------------------------------------------------------------- tool-dispatch row

/**
 * A routing decision made by the scoring arithmetic, with no controller consulted.
 *
 * ⚠️ The evaluator is "Tool" because the tool itself picked the winner — no LLM was asked.
 * The decision rationale shows the winning score and candidate count, and on expand shows the full
 * ranked candidate table with every term available, exactly as in the Analytics › Routing overview.
 *
 * ⛔ `controller` basis decisions are deliberately skipped from this component's callers; those
 * events already appear as `route` consult rows elsewhere in the same table.
 */
function ToolDispatchRow({
  decision: d,
  isOpen,
  onToggle
}: {
  decision: RoutingDecision
  isOpen: boolean
  onToggle: () => void
}): React.JSX.Element {
  const ranked = [...d.candidates].sort((a, b) => b.score - a.score)
  const winner = ranked.find((c) => c.chosen) ?? ranked[0]
  const subjectDisplay = d.taskSeq !== null && d.taskSeq !== undefined
    ? `t${d.taskSeq}${d.taskTitle ? ` · ${truncate(d.taskTitle, 40)}` : ''}`
    : '—'
  const rationale = winner
    ? `${d.chosenLabel ?? winner.workerId.slice(0, 8)} · score ${winner.score.toFixed(3)} · ${d.candidates.length} candidate${d.candidates.length === 1 ? '' : 's'}`
    : '—'

  return (
    <>
      <tr
        className={`consult-row ${isOpen ? 'consult-row--open' : ''}`}
        onClick={onToggle}
        title="Click to view full candidate scoring breakdown"
      >
        <td className="dim num tbl-when" title={new Date(d.decidedAt).toLocaleString()}>
          {new Date(d.decidedAt).toLocaleString()}
        </td>
        <td>
          <span className="consult-kind-tag">Route</span>
        </td>
        <td className="mono" title={d.taskTitle}>
          {subjectDisplay}
        </td>
        <td className="dim">Tool</td>
        <td>
          <span className="status state-ok">
            {BASIS_LABEL[d.basis] ?? d.basis}
          </span>
        </td>
        <td className="num tbl-num dim">—</td>
        <td>
          <span className="tbl-strong">{rationale}</span>
        </td>
        <td className="dim text-center">
          {isOpen ? '▼' : '▶'}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={8} className="consult-detail-cell">
            <ToolDispatchDetailPane decision={d} ranked={ranked} />
          </td>
        </tr>
      )}
    </>
  )
}

function ToolDispatchDetailPane({
  decision: d,
  ranked
}: {
  decision: RoutingDecision
  ranked: RoutingDecision['candidates']
}): React.JSX.Element {
  return (
    <div className="consult-detail-pane">
      <div className="consult-meta-bar">
        {d.taskSeq !== null && d.taskSeq !== undefined && (
          <div className="consult-meta-item">
            Subject: <strong>t{d.taskSeq}{d.taskTitle ? ` ${truncate(d.taskTitle, 60)}` : ''}</strong>
          </div>
        )}
        <div className="consult-meta-item">
          Evaluator: <strong>Tool (scoring arithmetic — no LLM consulted)</strong>
        </div>
        <div className="consult-meta-item">
          Basis: <strong>{BASIS_LABEL[d.basis] ?? d.basis}</strong>
        </div>
        <div className="consult-meta-item">
          Objective:{' '}
          <span className="num">
            quality {d.objective.quality.toFixed(2)} · cost {d.objective.cost.toFixed(2)} · velocity{' '}
            {d.objective.velocity.toFixed(2)}
          </span>
        </div>
        <div className="consult-meta-item">
          Spent: <span className="dim">0 tokens (tool decision)</span>
        </div>
        <div className="consult-meta-item">
          Recorded: <span className="dim">{when(d.decidedAt)}</span>
        </div>
      </div>

      <div className="consult-decision-block">
        <div className="consult-why-box">
          <div className="consult-why-title">
            Routing Decision — {BASIS_LABEL[d.basis] ?? d.basis}
          </div>
          <div>
            <strong>Winner:</strong>{' '}
            {d.chosenLabel ?? d.chosenWorkerId?.slice(0, 8) ?? '—'}
            {d.warm && <span className="tag tag--ok" style={{ marginLeft: 'var(--sp-1)' }}>warm</span>}
          </div>
          <div style={{ marginTop: '4px' }} className="dim">
            {BASIS_DETAIL[d.basis] ?? ''}
          </div>
        </div>
      </div>

      {/* Full candidate table, identical to what RoutingOverview shows on expand */}
      <div style={{ marginTop: 'var(--sp-2)' }}>
        <div className="side-label">
          Candidate scores ({ranked.length} evaluated, higher wins):
        </div>
        {ranked.map((candidate) => (
          <div key={candidate.workerId} style={{ marginTop: 'var(--sp-2)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-1)', marginBottom: 'var(--sp-1)' }}>
              <strong>{candidate.chosen ? '★ ' : ''}{candidate.label}</strong>
              <span className="dim">
                — {candidate.adapterId}
                {candidate.model ? `/${candidate.model}` : ''} ·{' '}
                {candidate.warm ? 'warm' : 'cold'}
                {candidate.quotaUnverified ? ' · quota unverified' : ''}
              </span>
              <span className="num" style={{ marginLeft: 'auto' }}>
                {candidate.score >= 0 ? '+' : ''}{candidate.score.toFixed(3)}
              </span>
            </div>
            {candidate.terms.length > 0 && (
              <table className="tbl" style={{ fontSize: '0.85em' }}>
                <thead>
                  <tr>
                    <th>Term</th>
                    <th className="tbl-num">value</th>
                    <th className="tbl-num">× weight</th>
                    <th className="tbl-num">= contrib</th>
                    <th>basis</th>
                  </tr>
                </thead>
                <tbody>
                  {candidate.terms.map((term) => (
                    <tr key={term.name}>
                      <td className="tbl-strong">{term.name}</td>
                      <td className="tbl-num num">{term.value.toFixed(2)}</td>
                      <td className="tbl-num num">
                        {term.sign < 0 ? '−' : '+'}{term.weight.toFixed(3)}
                      </td>
                      <td className="tbl-num num">
                        {term.contribution >= 0 ? '+' : '−'}{Math.abs(term.contribution).toFixed(3)}
                      </td>
                      <td className="dim">{term.basis}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="tbl-strong">TOTAL</td>
                    <td /><td />
                    <td className="tbl-num num tbl-strong">
                      {candidate.score >= 0 ? '+' : '−'}{Math.abs(candidate.score).toFixed(3)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------- shared helpers

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

// ---------------------------------------------------------------------------- consult detail

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
          <pre className="consult-accordion-body consult-accordion-body--prompt">{c.question}</pre>
        </details>
      )}

      {/*
        The working behind the answer, for a person only.
        ⛔ Deliberately *not* in the prompt above: the legend and the per-candidate term tables are
        how a routing decision gets checked rather than believed, and the controller does not need
        them to pick between two ids. Sending them billed every routing consult for about a hundred
        lines it could not act on.
      */}
      {c.detail && (
        <details className="consult-accordion">
          <summary>Score derivation (not sent — debugging only)</summary>
          <pre className="consult-accordion-body">{c.detail}</pre>
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
  /**
   * ⚠️ Shown for every kind, because every kind may carry one. Four of the five questions ask for a
   * label alongside their real answer, and a person auditing a routing decision should be able to see
   * that it also renamed a row — a change to the board that no other part of this panel would report.
   */
  const summary = typeof answer.summary === 'string' ? answer.summary.trim() : null

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
          {summary && (
            <div className="consult-why-box" style={{ marginBottom: 'var(--sp-2)' }}>
              <div className="consult-why-title">Task Label</div>
              <div>&ldquo;{summary}&rdquo;</div>
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
          {summary && (
            <div className="dim" style={{ marginTop: '4px' }}>
              <strong>Task label:</strong> &ldquo;{summary}&rdquo;
            </div>
          )}
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
        {summary && (
          <div className="dim" style={{ marginTop: '4px' }}>
            <strong>Task label:</strong> &ldquo;{summary}&rdquo;
          </div>
        )}
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
        {summary && (
          <div className="dim" style={{ marginTop: '4px' }}>
            <strong>Task label:</strong> &ldquo;{summary}&rdquo;
          </div>
        )}
        </div>
      )
    }

    case 'title': {
      return (
        <div className="consult-why-box">
          <div className="consult-why-title">Task Label</div>
          {summary ? (
            <div>&ldquo;{summary}&rdquo;</div>
          ) : (
            <div className="dim">No usable one-line label came back; the task still shows its prompt.</div>
          )}
        </div>
      )
    }
  }
}

const KIND_LABEL: Record<string, string> = {
  decompose: 'Break up',
  triage: 'Triage',
  gate: 'Gate',
  route: 'Route',
  title: 'Label'
}

const STATUS_TONE: Record<string, string> = {
  pending: 'state-running',
  answered: 'state-ok',
  fallback: 'state-idle',
  failed: 'state-warn'
}

/**
 * Human-readable name for each routing basis — what the tool used to decide.
 *
 * ⚠️ `controller` is not in this map on purpose; controller-basis decisions show up as `route`
 * consult rows and are not rendered by ToolDispatchRow at all.
 */
const BASIS_LABEL: Record<string, string> = {
  score: 'dispatched',
  pinned: 'dispatched',
  sticky: 'dispatched',
  explore: 'explore'
}

/** One line explaining what the basis means, shown in the expanded detail pane. */
const BASIS_DETAIL: Record<string, string> = {
  score: 'The scoring arithmetic separated the candidates clearly; the highest score won.',
  pinned: 'The task named its worker or model explicitly; one candidate, no comparison.',
  sticky: 'The task already had a live conversation on this account; keeping it beat any comparison.',
  explore: 'ε-greedy exploration: the scheduler tried a non-top-scoring candidate to gather data.'
}
