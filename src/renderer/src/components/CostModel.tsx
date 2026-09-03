import { useCallback, useEffect, useState } from 'react'
import type { CostModelSummary, CostReport } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { countdown, tokens } from '../lib/format'

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
            The economics of token caching, agent efficiency multipliers, and quota preservation
            across your fleet.
          </p>
        </div>
        <span className="num dim">
          cost {objective.cost.toFixed(2)} · velocity {objective.velocity.toFixed(2)} · quality{' '}
          {objective.quality.toFixed(2)}
        </span>
      </header>

      {/* ---------------- 1. What is Cost & Why it Matters ---------------- */}
      <section className="doc-section">
        <h3>1. What is Cost &amp; Why It Matters</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          LLM providers don&rsquo;t bill all tokens at the same rate. An output token typically costs 3× to 5×
          more than an input token, while reusing a prompt from cache (a cache read) costs only ~10% of standard
          input. To make fair comparisons, the system converts all token usage into{' '}
          <strong>input-token-equivalents</strong>.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Task Routing</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              The scheduler routes tasks to the worker and existing session that minimizes billable spend while
              meeting velocity and quality targets.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Cache Clock Control</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Prompt caches expire (usually after 5 to 60 minutes). The cache clock decides whether to keep a
              session warm, compact it, or let it expire based on human response latency.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Compaction Reserves</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Running <code>/compact</code> requires token quota. If an account reaches 100% quota while holding
              a large context, that context is stranded and lost forever.
            </p>
          </div>
          <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)' }}>
            <h4 style={{ margin: '0 0 var(--sp-1)', fontSize: 'var(--text-body)', fontWeight: 600 }}>Budget Estimation</h4>
            <p className="dim" style={{ margin: 0, fontSize: 'var(--text-dense)' }}>
              Historical task runs calibrate cost expectations for new tasks on particular agent CLIs and models.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- 2. How Costs Are Computed ---------------- */}
      <section className="doc-section">
        <h3>2. How Costs Are Computed</h3>
        <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Formula / Derivation</th>
              <th>Why it is computed this way</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="tbl-strong">Priced Tokens</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                Input + (Output × R_out) + (CacheRead × R_read) + (CacheWrite × R_write)
              </td>
              <td className="dim">
                Normalizes all token types to input-token-equivalents so cache reads (90% cheaper) don&rsquo;t
                distort cost comparisons.
              </td>
            </tr>
            <tr>
              <td className="tbl-strong">Agent Multiplier (e.g. ×2.91)</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                Factor = Ratio^(N / (N + 5))
              </td>
              <td className="dim">
                Measures median priced cost per run relative to fleet baseline. Empirical Bayesian shrinkage
                pulls the factor towards 1.0 when sample size N is low, preventing a few long runs from
                unfairly penalizing an agent.
              </td>
            </tr>
            <tr>
              <td className="tbl-strong">Compaction Reserve</td>
              <td className="mono" style={{ fontSize: 'var(--text-dense)' }}>
                RequiredTokens = ContextSize + SafetyMargin
              </td>
              <td className="dim">
                Guarantees the account retains sufficient remaining window quota to run <code>/compact</code>{' '}
                before the window expires.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ---------------- 3. Active Cost Models ---------------- */}
      <section className="doc-section">
        <h3>3. Active Cost Models Loaded in Daemon</h3>
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

      {/* ---------------- 4. Quota Windows & Compaction Reserves ---------------- */}
      <section className="doc-section">
        <h3>4. Quota Windows &amp; Compaction Reserves</h3>
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

      {/* ---------------- 5. The Cache Clock ---------------- */}
      <section className="doc-section">
        <h3>5. Live Cache Clock Decisions</h3>
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

      {/* ---------------- 6. What Each Agent Costs ---------------- */}
      <section className="doc-section">
        <h3>6. What Each Agent Costs (Learned Efficiency Factors)</h3>
        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Priced in input-token-equivalents from completed runs. The estimator multiplies a fleet-neutral task
          size (<span className="num">{tokens(report.costFactors.neutralPriced)}</span> priced tokens) by these
          multipliers.
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
                <th className="tbl-num">Median Run Cost</th>
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
                  <td className="dim">
                    {k.samples} run{k.samples === 1 ? '' : 's'} (raw ratio ×{k.ratio.toFixed(2)} shrunk to ×{k.factor.toFixed(2)})
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
