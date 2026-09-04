import { useCallback, useEffect, useState } from 'react'
import type { CostModelSummary, CostReport } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { age, countdown, money, tokens } from '../lib/format'

/**
 * Analytics > Cost Model
 *
 * Explains what cost is in this multi-agent controller, why it matters,
 * how it is computed (token normalization, shrinkage, compaction reserves),
 * and reports the current values per worker and active models.
 */
export function CostModel({ now }: { now: number }): React.JSX.Element {
  const [report, setReport] = useState<CostReport | null>(null)
  const [models, setModels] = useState<CostModelSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [costReport, costModels] = await Promise.all([
        rpc('cost.report'),
        rpc('costmodel.list')
      ])
      setReport(costReport)
      setModels(costModels)
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
          <h2>Cost Model</h2>
          <p className="panel-sub">
            The economics of layered money (subscription allocation + overage spend), token normalization, agent efficiency multipliers, and quota preservation across your fleet.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="num dim">
            cost {objective.cost.toFixed(2)} · velocity {objective.velocity.toFixed(2)} · quality{' '}
            {objective.quality.toFixed(2)}
          </span>
          <p className="dim" style={{ margin: 'var(--sp-1) 0 0', fontSize: 'var(--text-dense)' }}>
            Cost axis ({objective.cost.toFixed(2)}) balances billable dollars and quota against speed
          </p>
        </div>
      </header>

      {/* ---------------- 1. What a Run Costs in Money ---------------- */}
      <section className="doc-section">
        <h3>1. What a Run Costs in Money</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Every completed run is priced in <strong>layered money</strong>: billable dollars reflect real expenses
          incurred rather than hypothetical list rates.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Subscription Allocation</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              <code>subscriptionUsd</code> is the amortised share of a flat monthly subscription window consumed by a run. It attributes subscription value across tasks proportionally.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Overage Cash</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              <code>overageUsd</code> captures direct out-of-pocket money spent beyond subscriptions: pay-as-you-go purses, Anthropic extra usage, or cloud credits with published rates.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>List Price (Excluded)</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              <code>listUsd</code> shows what token volume would cost at standard API market rates. It is strictly benchmark information and never added into billable <code>RunPrice.usd</code>.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Honest Pricing</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              If neither a subscription window nor a spend meter reported usage, the price is <code>n/a</code> with an explicit cause. Unpriced work is never disguised as free ($0.00).
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- 2. Where the Money Is Measured ---------------- */}
      <section className="doc-section">
        <h3>2. Where the Money Is Measured (Spend Meters)</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Live pay-as-you-go spend meters probed from worker accounts (overage cash, cloud credits, and extra usage).
          Credits without an authoritative dollar conversion are displayed as <code>n/a</code>, never assumed as free.
        </p>

        {report.spend.length === 0 ? (
          <p className="dim">No spend meters configured across the fleet.</p>
        ) : (
          <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Meter</th>
                <th>Balance / Reading</th>
                <th className="tbl-num">Dollar Value</th>
                <th>Direction</th>
                <th>Last Sampled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.spend.flatMap((w) => {
                if (w.meters.length === 0) {
                  return [
                    <tr key={`${w.workerId}-none`}>
                      <td className="tbl-strong">{w.label}</td>
                      <td className="dim" colSpan={4}>No spend meters reported by adapter</td>
                      <td className="num">{w.sampledAt ? age(now - w.sampledAt) : 'never'}</td>
                      <td>
                        {w.error ? (
                          <span className="warn" title={w.error}>Probe failed</span>
                        ) : (
                          <span className="dim">none</span>
                        )}
                      </td>
                    </tr>
                  ]
                }
                return w.meters.map((m) => {
                  const dollarValue = m.balance === null
                    ? null
                    : m.unit === 'usd'
                      ? m.balance
                      : m.usdPerUnit !== null
                        ? m.balance * m.usdPerUnit
                        : null
                  return (
                    <tr key={`${w.workerId}-${m.id}`}>
                      <td className="tbl-strong">{w.label}</td>
                      <td>
                        <span>{m.label}</span>{' '}
                        <span className="dim mono" style={{ fontSize: 'var(--text-dense)' }}>({m.unit})</span>
                      </td>
                      <td className="num">
                        {m.balance !== null ? `${m.balance.toLocaleString()} ${m.unit}` : <span className="warn">unknown</span>}
                      </td>
                      <td className="num tbl-num">
                        {dollarValue !== null ? (
                          money(dollarValue)
                        ) : (
                          <span className="dim" title={m.unit === 'credits' ? 'No published credits-to-dollars conversion; unpriceable' : 'No balance reading'}>n/a</span>
                        )}
                      </td>
                      <td className="dim">
                        {m.direction === 'balance_falls' ? 'Drawdown (balance falls)' : 'Counter (spend rises)'}
                      </td>
                      <td className="num">{w.sampledAt ? age(now - w.sampledAt) : 'never'}</td>
                      <td>
                        {w.error ? (
                          <span className="warn" title={w.error}>Error</span>
                        ) : m.balance !== null ? (
                          <span className="status state-ok">Active</span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- 3. Active Cost Models ---------------- */}
      <section className="doc-section">
        <h3>3. Active Cost Models Loaded in Daemon</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          All registered models are on <code>channel: &quot;subscription&quot;</code> with relative cache ratios. No{' '}
          <code>channel: &quot;api&quot;</code> cost model file is loaded yet (token per-MTok cash rates are null; billable
          money is tracked via subscriptions and spend meters).
        </p>
        {models.length === 0 ? (
          <p className="dim">No cost models registered.</p>
        ) : (
          <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
            <thead>
              <tr>
                <th>Model ID</th>
                <th>Provider</th>
                <th>Effective From</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td className="tbl-strong mono">{m.id}</td>
                  <td>{m.provider}</td>
                  <td className="num">{m.effectiveFrom}</td>
                  <td>
                    <span className={`tag ${m.source === 'builtin' ? 'tag--ok' : ''}`}>
                      {m.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- 4. Token Normalization & Fallback Mechanics ---------------- */}
      <section className="doc-section">
        <h3>4. Token Normalization &amp; Fallback Mechanics</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          When money pricing is unavailable or when comparing raw model efficiency, usage is normalized to{' '}
          <strong>input-token-equivalents</strong>. The scheduler prioritizes money estimates first, deterministically
          falling back to token normalization when dollar pricing cannot be established.
        </p>

        <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
          <thead>
            <tr>
              <th>Metric / Mechanism</th>
              <th>Formula / Derivation</th>
              <th>Operational Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="tbl-strong">Priced Tokens</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                Input + (Output × R_out) + (CacheRead × R_read) + (CacheWrite × R_write)
              </td>
              <td className="dim">
                Normalizes all token types so prompt cache hits (~90% cheaper) and outputs (3×–5× more expensive) are compared fairly.
              </td>
            </tr>
            <tr>
              <td className="tbl-strong">Estimator Fallback</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                Money-first → Token-fallback
              </td>
              <td className="dim">
                Task planning estimates cost in dollars when historical USD data exists; falls back to fleet-neutral priced tokens when unpriced.
              </td>
            </tr>
            <tr>
              <td className="tbl-strong">Priceless / n/a Causes</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                window_reset, no_reading, unpriced_plan, no_window, no_plan, no_meter
              </td>
              <td className="dim">
                Explicit reasons why a run cannot be priced. A window reset or unmetered run publishes its cause rather than asserting $0.00.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ---------------- 5. Quota Windows & Compaction Reserves ---------------- */}
      <section className="doc-section">
        <h3>5. Quota Windows &amp; Compaction Reserves</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          <strong>Can each account still afford to save what it holds?</strong> When an agent builds up a
          large context (e.g. 50k–200k tokens), compacting that session requires remaining quota. If an account
          exhausts its quota window, running <code>/compact</code> fails, stranding all accumulated progress.
        </p>

        <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Window Quota</th>
              <th>Resets</th>
              <th>Compaction Reserve</th>
              <th className="tbl-num">Tokens to Save</th>
              <th>Status Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.workers.map((w) => {
              const res = report.reserves.find((r) => r.workerId === w.workerId)
              return (
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
                    {w.windowResetsAt ? countdown(w.windowResetsAt, now) : '—'}
                  </td>
                  <td>
                    {res ? (
                      <span className={`status ${RESERVE_TONE[res.verdict]}`}>
                        {res.verdict === 'ok'
                          ? 'Reserve Held (Safe)'
                          : res.verdict === 'at_risk'
                            ? 'At Risk (Low Quota)'
                            : 'Unknown'}
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="num tbl-num">
                    {res ? (res.requiredTokens > 0 ? tokens(res.requiredTokens) : '0') : '—'}
                  </td>
                  <td className="dim">
                    {res?.reason ?? w.remainingBasis}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {/* ---------------- 6. The Cache Clock ---------------- */}
      <section className="doc-section">
        <h3>6. Live Cache Clock Decisions</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          The scheduler re-evaluates active sessions every tick. If human latency is low, keeping a session
          warm saves expensive cold starts. If time is running out, it triggers <code>/compact</code> or lets
          it expire.
        </p>
        {report.decisions.length === 0 ? (
          <p className="dim">No live sessions holding a prompt cache currently.</p>
        ) : (
          <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
            <thead>
              <tr>
                <th>Session</th>
                <th>Action</th>
                <th className="tbl-num">Context Size</th>
                <th className="tbl-num">Expires In</th>
                <th className="tbl-num">Est. Cost</th>
                <th>Reason</th>
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

      {/* ---------------- 7. What Each Agent Costs ---------------- */}
      <section className="doc-section">
        <h3>7. What Each Agent Costs (Learned Efficiency Factors)</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Priced in input-token-equivalents and USD from completed runs. The estimator multiplies a fleet-neutral task
          size (<span className="num">{tokens(report.costFactors.neutralPriced)}</span> priced tokens;{' '}
          <span className="num">{report.costFactors.usdSamples}</span> runs priced in USD) by these multipliers.
        </p>

        {report.costFactors.keys.length === 0 ? (
          <p className="dim">Nothing has completed yet, so every agent is assumed to cost the same.</p>
        ) : (
          <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
            <thead>
              <tr>
                <th>Adapter CLI</th>
                <th>Model</th>
                <th className="tbl-num">Multiplier</th>
                <th className="tbl-num">Median Cost (Tokens)</th>
                <th className="tbl-num">Median Cost (USD)</th>
                <th>Learned From</th>
                <th>Observed Data &amp; Shrinkage</th>
              </tr>
            </thead>
            <tbody>
              {report.costFactors.keys.map((k) => (
                <tr key={`${k.adapterId}/${k.model ?? '?'}`}>
                  <td className="tbl-strong">{k.adapterId}</td>
                  <td>{k.model ?? <span className="dim">model not recorded</span>}</td>
                  <td className="num tbl-num">×{k.factor.toFixed(2)}</td>
                  <td className="num tbl-num">{tokens(k.medianPriced)}</td>
                  <td className="num tbl-num">
                    {k.medianUsd !== null ? money(k.medianUsd) : <span className="dim">n/a</span>}
                    {k.usdSamples > 0 && (
                      <span className="dim" style={{ fontSize: 'var(--text-dense)', marginLeft: 'var(--sp-1)' }}>
                        ({k.usdSamples})
                      </span>
                    )}
                  </td>
                  {/* ⛔ Which series the multiplier beside it was actually measured in. A ×12
                      learned from dollars and a ×12 learned from priced tokens are different claims,
                      and the number alone cannot tell them apart. */}
                  <td>
                    {k.learnedFrom === 'usd' ? (
                      <span className="tag tag--ok" title={`Measured in dollars, over the ${k.usdSamples} run(s) on this rung that could be priced.`}>
                        USD
                      </span>
                    ) : (
                      <span
                        className="tag"
                        title={
                          k.usdSamples > 0
                            ? `Only ${k.usdSamples} run(s) on this rung could be priced — too few to learn a dollar ratio from, so the multiplier falls back to priced tokens.`
                            : 'No run on this rung could be priced in money, so the multiplier falls back to priced tokens.'
                        }
                      >
                        tokens
                      </span>
                    )}
                  </td>
                  <td className="dim">
                    {k.samples} run{k.samples === 1 ? '' : 's'} ({k.usdSamples} in USD) · raw ratio ×{k.ratio.toFixed(2)} shrunk to ×{k.factor.toFixed(2)}
                    {k.assumed ? ' · cache multipliers assumed' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note">
          <strong>Warm vs. Cold Separation:</strong> A warm session start costs significantly less than a cold
          start. Warmth is factored out first (currently ×{report.costFactors.warmFactor.toFixed(2)} warm from{' '}
          {report.costFactors.warmSamples} runs, ×{report.costFactors.coldFactor.toFixed(2)} cold from{' '}
          {report.costFactors.coldSamples} runs) so an agent that often inherits warm context is not
          mistakenly considered cheaper.
        </p>

        <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)', marginTop: 'var(--sp-3)' }}>
          <h4 style={{ margin: '0 0 var(--sp-2)', fontSize: 'var(--text-body)', fontWeight: 600 }}>
            How efficiency multipliers and dollar costs are calculated in plain English:
          </h4>
          <ol style={{ margin: '0 0 var(--sp-2)', paddingLeft: 'var(--sp-4)', fontSize: 'var(--text-dense)', color: 'var(--color-text-dim)', lineHeight: 1.6 }}>
            <li>
              <strong>Layered Money &amp; Token Normalization:</strong> Runs record billable dollars (subscription share + overage cash) alongside normalized priced tokens (input-token-equivalents).
            </li>
            <li>
              <strong>Fleet Baseline Comparison:</strong> Each rung is divided by the fleet&rsquo;s median run to
              get a raw ratio. That comparison is made <strong>in dollars</strong> once a rung has three
              priced runs (fleet median{' '}
              {report.costFactors.neutralUsd !== null ? money(report.costFactors.neutralUsd) : <span className="dim">n/a</span>}
              ), and falls back to priced tokens below that ({tokens(report.costFactors.neutralPriced)}). The
              <em> Learned From</em> column above says which one each multiplier actually came from.
            </li>
            <li>
              <strong>Sample Shrinkage (Why the multiplier isn&rsquo;t just the raw ratio):</strong> With few runs, variance is high. Empirical Bayesian shrinkage (formula: <code>ratio^(N / (N+5))</code>) pulls the factor towards 1.0 until sample size N grows. Dollar medians are tracked alongside tokens with their own sample counts (<code>usdSamples</code>).
            </li>
            <li>
              <strong>Warm vs. Cold Starts Separated:</strong> Reusing a warm session context costs far less than a fresh cold start. Warmth is separated out first (currently ×{report.costFactors.warmFactor.toFixed(2)} warm vs ×{report.costFactors.coldFactor.toFixed(2)} cold) so an agent that inherits warm sessions isn&rsquo;t mistakenly credited as being cheaper.
            </li>
          </ol>
        </div>
      </section>
    </div>
  )
}

const MOVE_LABEL: Record<string, string> = {
  dispatch: 'send it work',
  keepalive: 'keep alive',
  compact: 'compact',
  revive_compact: 'wake it to compact',
  let_expire: 'let it expire',
  handoff_close: 'hand off and close',
  none: 'nothing yet'
}

const MOVE_TONE: Record<string, string> = {
  dispatch: 'state-ok',
  keepalive: 'state-running',
  compact: 'state-warn',
  revive_compact: 'state-warn',
  let_expire: 'state-idle',
  handoff_close: 'state-human',
  none: 'state-idle'
}

const RESERVE_TONE: Record<string, string> = {
  ok: 'state-ok',
  at_risk: 'state-danger',
  unknown: 'state-warn'
}
