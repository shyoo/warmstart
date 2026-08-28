import { useCallback, useEffect, useState } from 'react'
import type { CostReport, Settings } from '@shared/protocol'
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

  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('cost.report'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // ⚠️ The answer from the daemon is what lands in state, never the value that was clicked. A
  // toggle that paints itself green and leaves the fleet unchanged is exactly the disagreement
  // this page exists to make impossible.
  const setSwitch = useCallback(
    async (key: keyof Settings, next: boolean) => {
      setSaving(true)
      try {
        // ⚠️ A partial patch of one key. Round-tripping the whole object would let this panel
        // overwrite a switch somebody threw in another window between the read and the write.
        const settings = await rpc('settings.set', { [key]: next })
        setReport((r) => (r ? { ...r, settings } : r))
        setError(null)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [refresh]
  )

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
  const { autoCompact, autoPreempt, autoRunawayStop } = report.settings

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
        <h3>Automatic compaction</h3>
        <SwitchRow
          label="Automatic compaction"
          on={autoCompact}
          busy={saving}
          onToggle={() => void setSwitch('autoCompact', !autoCompact)}
          state={
            autoCompact
              ? 'the clock may compact a session when the arithmetic favours it.'
              : 'the clock never compacts on its own. A session that would have been compacted' +
                ' hands off and closes instead, including when the reserve is at risk.'
          }
        >
          Compaction is what stops a long session being stranded when a quota window closes, so this
          is on by default — running out of room to <em>save</em> is the one loss that is not
          recoverable. Turn it off when compaction is not reaching your sessions: on the{' '}
          <code>stream</code> transport it is <strong>unverified</strong> whether <code>/compact</code>{' '}
          is honoured at all, and every attempt that is not costs real tokens. This switch is
          fleet-wide and takes effect on the next tick.
        </SwitchRow>
      </section>

      {/*
        ⛔ Two switches, not one. Both stop a live run, but they rest on different evidence and are
        trustworthy to different degrees — so an operator bringing this fleet up gradually can have
        the measured one without the inferred one.
      */}
      <section className="doc-section">
        <h3>Stopping a run early</h3>
        <SwitchRow
          label="Wrap up before a quota window closes"
          on={autoPreempt}
          busy={saving}
          onToggle={() => void setSwitch('autoPreempt', !autoPreempt)}
          state={
            autoPreempt
              ? 'a run inside the margin is told to commit and hand off, then parked until the reset.'
              : 'runs are left alone at a window boundary and are cut off mid-thought when it closes.'
          }
        >
          On by default: this is the intervention the tool exists to make, and it acts on a{' '}
          <em>measured</em> reset time rather than a guess. The task goes to{' '}
          <code>paused_quota</code> carrying the reset as its resume time, so it restarts itself —
          nothing is cancelled. With this off, a run caught by a closing window loses its
          uncommitted work and the next session pays to rediscover the branch.
        </SwitchRow>
        <SwitchRow
          label="Stop a run that is far past its estimate"
          on={autoRunawayStop}
          busy={saving}
          onToggle={() => void setSwitch('autoRunawayStop', !autoRunawayStop)}
          state={
            autoRunawayStop
              ? 'a run past 3× the estimate is wrapped up and handed back to you.'
              : 'a long run is never stopped for cost alone. Nothing else changes.'
          }
        >
          <strong>Off by default, deliberately.</strong> The estimate is a median over completed runs
          and the overrun is counted in raw tokens — which on these CLIs are ~98% cache reads, and
          those accumulate with how <em>long</em> a session is rather than how wasteful. Measured on
          t5 (2026-08-28): 6,271,722 tokens against an estimate of 1,557,974 was called a runaway at
          4.0×, of which 6,155,066 were cache reads and 27,338 were output. Turn this on once the
          factor is measured in cost rather than tokens.
        </SwitchRow>
      </section>

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

/**
 * One operator switch: the control, what it is doing right now, and why it is set that way.
 *
 * ⚠️ The state line is written in the present tense of the *current* setting, not as a description of
 * the feature. "The clock never compacts on its own" tells you what your fleet is doing; "toggles
 * automatic compaction" tells you what the button is, which you can already see.
 */
function SwitchRow({
  label,
  on,
  busy,
  onToggle,
  state,
  children
}: {
  label: string
  on: boolean
  busy: boolean
  onToggle: () => void
  state: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={busy}
        className={`switch ${on ? 'switch--on' : ''}`}
        onClick={onToggle}
      >
        <span className="switch-knob" />
      </button>
      <div>
        <p className="switch-state">
          <strong>{label}</strong> · {on ? 'On' : 'Off'}
          <span className="dim"> — {state}</span>
        </p>
        <p className="note">{children}</p>
      </div>
    </div>
  )
}
