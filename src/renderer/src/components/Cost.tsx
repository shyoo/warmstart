import { useCallback, useEffect, useState } from 'react'
import type { CostReport } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { tokens } from '../lib/format'

/**
 * Overview > Dashboard: What each agent costs
 *
 * Streamlined cost view focusing on learned relative agent efficiency factors,
 * explaining in user-friendly terms how multipliers (e.g. ×2.91) are calculated
 * from normalized priced tokens and sample shrinkage.
 */
export function Cost({ onOpenCostModel }: { now?: number; onOpenCostModel?: () => void }): React.JSX.Element {
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
            Learned agent cost factors across your fleet. Token usage is normalized into
            input-token-equivalents and adjusted with statistical shrinkage to prevent small sample counts
            from skewing estimates.
          </p>
        </div>
        <span className="num dim">
          cost {objective.cost.toFixed(2)} · velocity {objective.velocity.toFixed(2)} · quality{' '}
          {objective.quality.toFixed(2)}
        </span>
      </header>

      <section className="doc-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-2)' }}>
          <h3 style={{ margin: 0 }}>What each agent costs</h3>
          {onOpenCostModel && (
            <button className="btn" style={{ fontSize: 'var(--text-dense)', padding: 'var(--sp-1) var(--sp-2)' }} onClick={onOpenCostModel}>
              View Full Cost Model in Analytics →
            </button>
          )}
        </div>

        <p className="panel-sub" style={{ marginBottom: 'var(--sp-3)' }}>
          Learned from completed runs, priced in input-token-equivalents so cache reads count for
          what they cost rather than for how many there were. The estimator multiplies a
          fleet-neutral task size (
          <span className="num">{tokens(report.costFactors.neutralPriced)}</span> priced tokens) by these multipliers.
        </p>

        {report.costFactors.keys.length === 0 ? (
          <p className="dim">Nothing has completed yet, so every agent is assumed to cost the same.</p>
        ) : (
          <table className="tbl" style={{ marginBottom: 'var(--sp-3)' }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th className="tbl-num">Multiplier</th>
                <th className="tbl-num">Median Run Cost</th>
                <th>Observed Runs</th>
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
                    {k.samples} run{k.samples === 1 ? '' : 's'} · measured ×{k.ratio.toFixed(2)}
                    {k.assumed ? ' · cache multipliers assumed' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="card" style={{ padding: 'var(--sp-3)', background: 'var(--color-surface)', marginTop: 'var(--sp-3)' }}>
          <h4 style={{ margin: '0 0 var(--sp-2)', fontSize: 'var(--text-body)', fontWeight: 600 }}>
            How the multiplier (e.g. ×2.91) is calculated in plain English:
          </h4>
          <ol style={{ margin: '0 0 var(--sp-2)', paddingLeft: 'var(--sp-4)', fontSize: 'var(--text-dense)', color: 'var(--color-text-dim)', lineHeight: 1.6 }}>
            <li>
              <strong>Priced Token Normalization:</strong> Raw tokens are converted into input-token-equivalents.
              Cache reads are 90% cheaper, output tokens are 3×–5× more expensive, and cache writes are 1.25×.
            </li>
            <li>
              <strong>Fleet Baseline Comparison:</strong> The system finds the median priced tokens across all tasks
              in the fleet ({tokens(report.costFactors.neutralPriced)}). An agent whose median run is 1.2M tokens has a raw ratio of ~3.5×.
            </li>
            <li>
              <strong>Sample Shrinkage (Why the number isn&rsquo;t just the raw ratio):</strong> If an agent only ran 2 or 3 tasks,
              those tasks might just have been unusually large. The system applies shrinkage (formula: <code>ratio^(N / (N+5))</code>)
              which pulls the multiplier closer to 1.0 until more runs (N) are completed. This is why a raw ratio of 3.5× with 8 runs becomes an applied multiplier of <strong>×2.91</strong>.
            </li>
            <li>
              <strong>Warm vs. Cold Starts Separated:</strong> Reusing a warm session context costs far less than a fresh cold start.
              Warmth is separated out first (currently ×{report.costFactors.warmFactor.toFixed(2)} warm vs ×{report.costFactors.coldFactor.toFixed(2)} cold) so an agent that inherits warm sessions isn&rsquo;t mistakenly credited as being cheaper.
            </li>
          </ol>
        </div>
      </section>
    </div>
  )
}
