import { useCallback, useEffect, useState } from 'react'
import type { CostReport } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { age, countdown, tokens } from '../lib/format'

/**
 * Cost.
 *
 * ⛔ Every number here is shown **with its basis**. A scheduler that spends money on your behalf and
 * cannot say why is one you will either over-trust or turn off, and both are worse than a number with
 * an honest caveat attached.
 *
 * The two questions this answers: *why is that session still open?* and *can this account still
 * afford to save what it is holding?*
 */
export function Cost({ now }: { now: number }): React.JSX.Element {
  const [report, setReport] = useState<CostReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('cost.report'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  useDaemonEvents((event) => {
    if (event.type === 'session.changed' || event.type === 'turn') void refresh()
  })

  if (error) return <div className="panel"><div className="alert">{error}</div></div>
  if (!report) return <div className="panel"><p className="dim">Reading the cost model…</p></div>

  const { objective } = report

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Cost</h2>
          <p className="panel-sub">
            What the scheduler believes, and on what basis. A warm prompt cache is an asset with an
            expiry date — most of what this page shows is the arithmetic of not wasting one.
          </p>
        </div>
        <span className="num dim">
          cost {objective.cost.toFixed(2)} · velocity {objective.velocity.toFixed(2)} · quality{' '}
          {objective.quality.toFixed(2)}
        </span>
      </header>

      <section className="doc-section">
        <h3>The cache clock, right now</h3>
        {report.decisions.length === 0 ? (
          <p className="dim">No live sessions, so there is nothing holding a cache open.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Session</th>
                <th>Would do</th>
                <th className="tbl-num">Context</th>
                <th className="tbl-num">Expires</th>
                <th className="tbl-num">Cost</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {report.decisions.map((d) => (
                <tr key={d.sessionId}>
                  <td className="mono">{d.sessionId.slice(0, 6)}</td>
                  <td>
                    <span className={`status ${MOVE_TONE[d.move] ?? ''}`}>{MOVE_LABEL[d.move]}</span>
                  </td>
                  <td className="num tbl-num">{tokens(d.contextTokens)}</td>
                  <td className="num tbl-num">{d.expiresAt ? countdown(d.expiresAt, now) : '—'}</td>
                  <td className="num tbl-num">{d.estimatedCost ? tokens(d.estimatedCost) : '—'}</td>
                  <td className="dim">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="doc-section">
        <h3>Can each account still save what it holds?</h3>
        <table className="tbl">
          <tbody>
            {report.reserves.map((r) => {
              const worker = report.workers.find((w) => w.workerId === r.workerId)
              return (
                <tr key={r.workerId}>
                  <td className="tbl-strong">{worker?.label ?? r.workerId.slice(0, 8)}</td>
                  <td>
                    <span className={`status ${RESERVE_TONE[r.verdict]}`}>
                      {r.verdict === 'ok'
                        ? 'reserve held'
                        : r.verdict === 'at_risk'
                          ? 'at risk'
                          : 'unknown'}
                    </span>
                  </td>
                  <td className="num tbl-num">{r.liveSessions} live</td>
                  <td className="num tbl-num">{tokens(r.requiredTokens)} to save</td>
                  <td className="dim">{r.reason}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="note">
          <strong>Why this matters more than it looks.</strong> <code>/compact</code> fails at true
          100%. An account that runs out while holding a large session strands that context — it
          cannot be compacted, cannot continue, and its cache lapses long before the window resets.
          Running out of room to <em>finish</em> is recoverable; running out of room to <em>save</em>{' '}
          is not.
        </p>
      </section>

      <section className="doc-section">
        <h3>Windows</h3>
        <table className="tbl">
          <tbody>
            {report.workers.map((w) => (
              <tr key={w.workerId}>
                <td className="tbl-strong">{w.label}</td>
                <td className="num">
                  {w.remainingTokens !== null ? (
                    `${tokens(w.remainingTokens)} left`
                  ) : (
                    <span className="warn">size unknown</span>
                  )}
                </td>
                <td className="num">
                  {w.windowResetsAt ? `resets in ${countdown(w.windowResetsAt, now)}` : '—'}
                </td>
                <td>
                  {w.liveRateLimitStatus ? (
                    <span className={w.liveRateLimitStatus === 'allowed' ? 'ok' : 'warn'}>
                      {w.liveRateLimitStatus}
                    </span>
                  ) : (
                    <span className="dim">no live signal yet</span>
                  )}
                </td>
                <td className="dim">
                  {w.remainingBasis}
                  {w.windowResetSource ? ` · reset from ${w.windowResetSource}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h3>What it has done</h3>
        <p className="panel-sub">
          Median time you take to answer:{' '}
          <span className="num">{Math.round(report.medianHumanLatencyMs / 60000)} minutes</span> —
          measured from your own answers, and the reason a session waiting on you is worth keeping
          warm.
        </p>
        {report.recent.length === 0 ? (
          <p className="dim">Nothing yet.</p>
        ) : (
          <table className="tbl">
            <tbody>
              {report.recent.map((e, i) => (
                <tr key={`${e.sessionId}-${e.ts}-${i}`}>
                  <td className="dim num">{age(now - e.ts)}</td>
                  <td className="mono">{e.sessionId.slice(0, 6)}</td>
                  <td>
                    <span className={`status ${MOVE_TONE[e.move] ?? ''}`}>{MOVE_LABEL[e.move]}</span>
                  </td>
                  <td className="num tbl-num">{e.estimatedCost ? tokens(e.estimatedCost) : '—'}</td>
                  <td className="dim">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const MOVE_LABEL: Record<string, string> = {
  dispatch: 'send it work',
  keepalive: 'keep alive',
  compact: 'compact',
  let_expire: 'let it expire',
  handoff_close: 'hand off and close',
  none: 'nothing yet'
}

const MOVE_TONE: Record<string, string> = {
  dispatch: 'state-ok',
  keepalive: 'state-running',
  compact: 'state-warn',
  let_expire: 'state-idle',
  handoff_close: 'state-human',
  none: 'state-idle'
}

const RESERVE_TONE: Record<string, string> = {
  ok: 'state-ok',
  at_risk: 'state-danger',
  unknown: 'state-warn'
}
