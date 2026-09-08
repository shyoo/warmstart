import { Fragment, useCallback, useEffect, useState } from 'react'
import type { RoutingCandidate, RoutingDecision } from '@shared/routing'
import { OBJECTIVE_PRESET_LABELS, presetOf } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { when } from '../lib/format'
import { errorMessage } from '@shared/errors.js'

/**
 * Analytics > Routing Model > Overview.
 *
 * ⛔ **Every number on this page is read back from the ledger, never recomputed.** A score was
 * produced against windows, prompt caches and context sizes that existed for one scheduler tick and
 * are gone by the time anybody opens this tab; re-deriving one now would print a plausible number
 * that answers a different question. The daemon stores the whole breakdown at dispatch — see
 * `routingdecisions.ts` — and this renders it.
 *
 * ⚠️ The worked example below is arithmetic on the constants, not on live data, and is labelled as
 * such. It exists so the table underneath it can be read; it is not evidence about this fleet.
 */

const PAGE = 5

export function RoutingOverview(): React.JSX.Element {
  const [page, setPage] = useState(0)
  const [decisions, setDecisions] = useState<RoutingDecision[]>([])
  const [total, setTotal] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await rpc('routing.decisions', { limit: PAGE, offset: page * PAGE })
      setDecisions(result.decisions)
      setTotal(result.total)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [page])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ⚠️ A decision is written at dispatch, so the event that means "there may be a new one" is a task
  // changing state — not a turn, which fires many times inside a run that was already routed.
  useDaemonEvents((event) => {
    if (event.type === 'task.changed' && page === 0) void refresh()
  })

  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <div className="stack">
      <section className="doc-section">
        <h3>1. What a routing decision is</h3>
        <p className="panel-sub">
          Every tick, the scheduler asks one question of every account that could take a task:{' '}
          <strong>how much would I prefer to run this here, rather than anywhere else?</strong> The
          answer is a single number — a <em>score</em> — and the highest one wins.
        </p>
        <p className="panel-sub">
          A score is a plain sum. There is no normalisation, no cap and no logarithm anywhere in it,
          so a gap of 0.2 is exactly twice a gap of 0.1 and means only that one account is preferred
          by that much:
        </p>
        <pre className="code-block">score = Σ ( ± weight<sub>term</sub> × value<sub>term</sub> )</pre>
        <p className="panel-sub">
          The <strong>value</strong> is what was measured about <em>this account, for this task,
          right now</em> — minutes of prompt cache left, percent of a quota window used, how full a
          conversation&rsquo;s context is. The <strong>weight</strong> is how much that measurement
          is worth to you, and it is identical for every account being compared, because it comes
          from your objective vector alone.
        </p>
      </section>

      <section className="doc-section">
        <h3>2. Where the weights come from</h3>
        <p className="panel-sub">
          You do not set weights. You set three numbers that sum to 1 — <strong>quality</strong>,{' '}
          <strong>cost</strong> and <strong>velocity</strong> — in Settings &rsaquo; Global, or per
          project, or per task. Every weight is a published formula over those three:
        </p>
        <pre className="code-block">
{`balanced  =  quality 0.40 · cost 0.30 · velocity 0.30

cacheWarmth = 1.0 + 2.2×cost − 0.6×velocity →  1.0 + 0.66 − 0.18  =  1.48
contextHeld = 0.8 + 1.0×cost + 0.4×quality  →  0.8 + 0.30 + 0.16  =  1.26
cold      = 0.8 + 2.0×cost − 0.7×velocity   →  0.8 + 0.60 − 0.21  =  1.19
quotaRisk = 0.5 + 1.2×cost                  →  0.5 + 0.36         =  0.86
pace      = 0.3 + 1.7×velocity              →  0.3 + 0.51         =  0.81
contextRot= 0.6 + 1.6×quality               →  0.6 + 0.64         =  1.24`}
        </pre>
        <p className="panel-sub">
          Turn <code>cost</code> up and <code>cacheWarmth</code> grows: the scheduler starts hugging live
          prompt caches and serialising work onto one conversation. Turn <code>velocity</code> up and{' '}
          <code>cold</code> shrinks while <code>pace</code> grows: it stops waiting for the cheap
          moment, and starts preferring whichever agent history says finishes fastest. Nothing here
          is a mode or a switch — every term is a continuous function of the three numbers you set.
        </p>
        <p className="dim">
          ⚠️ <code>cacheWarmth</code> and <code>contextHeld</code> are not the same term twice.{' '}
          <code>contextHeld</code> is binary — does a conversation carrying this task&rsquo;s context
          exist at all, live or closed-and-reopenable. <code>cacheWarmth</code> is continuous — how
          much of that conversation&rsquo;s prompt-cache TTL is still unspent. A reopenable
          conversation whose prefix has lapsed scores <code>contextHeld 1 · cacheWarmth 0</code>: it
          still remembers the task, it just no longer comes with a discount.
        </p>
      </section>

      <section className="doc-section">
        <h3>3. A worked example</h3>
        <p className="panel-sub">
          Two accounts, one task, the balanced vector above. <strong>A</strong> already holds this
          task&rsquo;s conversation with 30 minutes of a 60-minute cache left, and is at 70% of its
          five-hour window. <strong>B</strong> is idle, has nothing to reuse, and is at 10%.
        </p>
        <div className="two-col">
          <table className="tbl">
            <thead>
              <tr>
                <th>Account A (warm)</th>
                <th className="tbl-num">value</th>
                <th className="tbl-num">× weight</th>
                <th className="tbl-num">= contrib</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>cacheWarmth</td><td className="tbl-num num">0.50</td><td className="tbl-num num">+1.480</td><td className="tbl-num num">+0.740</td></tr>
              <tr><td>contextHeld</td><td className="tbl-num num">1.00</td><td className="tbl-num num">+1.260</td><td className="tbl-num num">+1.260</td></tr>
              <tr><td>cold</td><td className="tbl-num num">0.00</td><td className="tbl-num num">−1.190</td><td className="tbl-num num">−0.000</td></tr>
              <tr><td>quotaRisk</td><td className="tbl-num num">0.29</td><td className="tbl-num num">−0.860</td><td className="tbl-num num">−0.249</td></tr>
              <tr><td className="tbl-strong">TOTAL</td><td /><td /><td className="tbl-num num tbl-strong">+1.751</td></tr>
            </tbody>
          </table>
          <table className="tbl">
            <thead>
              <tr>
                <th>Account B (cold)</th>
                <th className="tbl-num">value</th>
                <th className="tbl-num">× weight</th>
                <th className="tbl-num">= contrib</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>cacheWarmth</td><td className="tbl-num num">0.00</td><td className="tbl-num num">+1.480</td><td className="tbl-num num">+0.000</td></tr>
              <tr><td>contextHeld</td><td className="tbl-num num">0.00</td><td className="tbl-num num">+1.260</td><td className="tbl-num num">+0.000</td></tr>
              <tr><td>cold</td><td className="tbl-num num">1.00</td><td className="tbl-num num">−1.190</td><td className="tbl-num num">−1.190</td></tr>
              <tr><td>quotaRisk</td><td className="tbl-num num">0.00</td><td className="tbl-num num">−0.860</td><td className="tbl-num num">−0.000</td></tr>
              <tr><td className="tbl-strong">TOTAL</td><td /><td /><td className="tbl-num num tbl-strong">−1.190</td></tr>
            </tbody>
          </table>
        </div>
        <p className="dim">
          A wins by 2.94, and the reason is legible: reusing a conversation that already holds the
          task is worth far more than the quota headroom B has spare. Push <code>cost</code> to 0.7
          and A&rsquo;s lead widens; push <code>velocity</code> to 0.7 and it narrows, because a cold
          start stops being expensive when starting sooner is the point. ⚠️ Illustrative arithmetic
          on the published constants — not a measurement of this fleet.
        </p>
      </section>

      <section className="doc-section">
        <h3>4. When the arithmetic cannot decide</h3>
        <p className="panel-sub">
          Two scores within <strong>ε</strong> of each other are treated as no difference at all. For
          a task small enough that a controller turn would cost more than the difference is worth,
          the top score simply wins. For a large one, the scheduler asks the controller agent —
          handing it every candidate&rsquo;s live terms, and discarding any answer that names an
          account which is no longer a candidate by the time the answer arrives. Those decisions are
          marked <span className="tag">controller</span> below.
        </p>
      </section>

      <section className="doc-section">
        <h3>5. The last {PAGE} routing decisions</h3>
        <p className="panel-sub">
          One row per dispatch, written at the moment the task was handed over. Open a row to see the
          full term-by-term derivation for every account that was in the running — the same
          arithmetic that ordered them, stored rather than recomputed.
        </p>

        {error ? (
          <div className="alert">{error}</div>
        ) : decisions.length === 0 ? (
          <p className="dim">
            {total === 0
              ? 'Nothing has been dispatched since routing decisions started being recorded. The next task the scheduler hands out will appear here.'
              : 'No decisions on this page.'}
          </p>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Task</th>
                  <th>Chose</th>
                  <th className="tbl-num">Score</th>
                  <th className="tbl-num">Margin</th>
                  <th>Objective</th>
                  <th>Basis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => {
                  const ranked = [...d.candidates].sort((a, b) => b.score - a.score)
                  const winner = ranked.find((c) => c.chosen) ?? ranked[0]
                  const runnerUp = ranked.find((c) => c !== winner)
                  const margin =
                    winner && runnerUp ? winner.score - runnerUp.score : null
                  const preset = presetOf(d.objective)
                  const open = expanded === d.id
                  return (
                    <Fragment key={d.id}>
                      <tr>
                        <td className="tbl-when">{when(d.decidedAt)}</td>
                        <td className="tbl-title-cell">
                          <div className="tbl-title" title={d.taskTitle}>
                            <span className="tbl-strong">t{d.taskSeq ?? '?'}</span> {d.taskTitle}
                          </div>
                        </td>
                        <td>
                          {d.chosenLabel ?? '—'}
                          {d.warm && <span className="tag tag--ok" style={{ marginLeft: 'var(--sp-1)' }}>warm</span>}
                        </td>
                        <td className="tbl-num num">{winner ? winner.score.toFixed(3) : '—'}</td>
                        <td className="tbl-num num" title={`ε = ${d.epsilon}`}>
                          {margin === null ? (
                            <span className="dim">only one</span>
                          ) : margin <= d.epsilon ? (
                            <span className="warn">{margin.toFixed(3)} ≤ ε</span>
                          ) : (
                            margin.toFixed(3)
                          )}
                        </td>
                        <td className="dim" title={preset ? OBJECTIVE_PRESET_LABELS[preset] : 'custom vector'}>
                          {preset ?? 'custom'}
                        </td>
                        <td>
                          <span className="tag">{d.basis}</span>
                        </td>
                        <td className="tbl-actions">
                          <button className="btn btn--ghost" onClick={() => setExpanded(open ? null : d.id)}>
                            {open ? 'Hide' : 'Show the arithmetic'}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8}>
                            <DecisionDetail decision={d} ranked={ranked} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>

            <div className="pager">
              <button className="btn btn--ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                ← Newer
              </button>
              <span className="dim">
                Page {page + 1} of {pages} · {total} decision{total === 1 ? '' : 's'} recorded
              </span>
              <button
                className="btn btn--ghost"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Older →
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/**
 * One decision, in full: the vector, every weight's derivation, and every candidate's terms.
 *
 * ⚠️ **Zero terms are printed, not dropped.** A derivation showing only what contributed reads as
 * though the rest had been weighed and found small — printing `0.00` beside its basis is what shows
 * that a term is not small but *unmeasurable on this fleet*, which is exactly the finding that made
 * the scheduler publish these bases in the first place.
 */
function DecisionDetail({
  decision,
  ranked
}: {
  decision: RoutingDecision
  ranked: RoutingCandidate[]
}): React.JSX.Element {
  const { objective } = decision
  return (
    <div className="stack" style={{ padding: 'var(--sp-2) 0' }}>
      <div className="notice">
        <strong>Objective in force:</strong>{' '}
        <span className="num">
          quality {objective.quality.toFixed(2)} · cost {objective.cost.toFixed(2)} · velocity{' '}
          {objective.velocity.toFixed(2)}
        </span>
        . Higher score wins; the scale is linear and unitless. A gap of {decision.epsilon} or less
        counts as no difference at all.
      </div>

      <table className="tbl">
        <thead>
          <tr>
            <th>Weight</th>
            <th>= f(objective)</th>
            <th className="tbl-num">Value here</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(decision.weights).map(([name, value]) => (
            <tr key={name}>
              <td className="tbl-strong">{name}</td>
              <td className="mono dim">{decision.weightFormulas[name] ?? 'fixed'}</td>
              <td className="tbl-num num">{value.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ranked.map((candidate) => (
        <div key={candidate.workerId}>
          <h4 className="doc-h4">
            {candidate.chosen ? '★ ' : ''}
            {candidate.label}
            <span className="dim">
              {' '}
              — {candidate.adapterId}
              {candidate.model ? `/${candidate.model}` : ''} ·{' '}
              {candidate.warm ? 'already holds this task’s context' : 'cold start'}
              {candidate.quotaUnverified ? ' · quota reading not trustworthy' : ''}
            </span>
            <span className="num" style={{ float: 'right' }}>
              {candidate.score.toFixed(3)}
            </span>
          </h4>
          <table className="tbl">
            <thead>
              <tr>
                <th>Term</th>
                <th className="tbl-num">value</th>
                <th className="tbl-num">× weight</th>
                <th className="tbl-num">= contrib</th>
                <th>why the value is that</th>
              </tr>
            </thead>
            <tbody>
              {candidate.terms.map((term) => (
                <tr key={term.name}>
                  <td className="tbl-strong">{term.name}</td>
                  <td className="tbl-num num">{term.value.toFixed(2)}</td>
                  <td className="tbl-num num">
                    {term.sign < 0 ? '−' : '+'}
                    {term.weight.toFixed(3)}
                  </td>
                  <td className="tbl-num num">
                    {term.contribution >= 0 ? '+' : '−'}
                    {Math.abs(term.contribution).toFixed(3)}
                  </td>
                  <td className="dim">{term.basis}</td>
                </tr>
              ))}
              <tr>
                <td className="tbl-strong">TOTAL</td>
                <td /><td /><td className="tbl-num num tbl-strong">
                  {candidate.score >= 0 ? '+' : '−'}
                  {Math.abs(candidate.score).toFixed(3)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
