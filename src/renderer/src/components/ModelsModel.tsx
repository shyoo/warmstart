import { useCallback, useEffect, useState } from 'react'
import type { BenchmarkSourceRef, ModelReport } from '@shared/routing'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { money } from '../lib/format'
import { errorMessage } from '@shared/errors.js'
import { Eq, M } from './Math'
import { weightFormulaTex } from '../lib/tex'

/**
 * Analytics > Routing Model > Models.
 *
 * ⛔ **The fleet can now answer a question none of the other three axes can: why *that model*, not
 * only why *that account*.** Routing scores `(worker, model)` pairs, and two of its twelve terms —
 * `fitness` and `price` — exist only at that granularity. A page that stayed one row per worker would
 * have nowhere to show either.
 */

const REQUIRED_BY_BAND: Record<'low' | 'medium' | 'high', number> = { low: 0.35, medium: 0.55, high: 0.75 }

function fmtScore(n: number | null): string {
  return n === null ? 'unmeasured' : n.toFixed(2)
}

/**
 * Where one row's prior came from: the leaderboard's name, linked to it where the benchmark file
 * gives a URL.
 *
 * ⚠️ A family match carries no source of its own — the prior is a mapping from a neighbouring model,
 * not a published figure for this one — so it says so rather than borrowing the family's link.
 */
function PriorSource({
  name,
  prior,
  basis,
  sources
}: {
  name: string | null
  prior: number | null
  basis: string
  sources: BenchmarkSourceRef[]
}): React.JSX.Element {
  if (!name) {
    // A prior with no source is a family match — a mapping from a neighbouring model id, which is
    // not a published figure for this one and must not borrow the neighbour's link.
    return <span title={basis}>{prior === null ? 'none' : 'inferred, family match'}</span>
  }
  const src = sources.find((s) => s.name === name)
  if (!src) return <span>{name}</span>
  return (
    <a href={src.url} target="_blank" rel="noreferrer" title={`${src.url} — retrieved ${src.retrieved}`}>
      {src.name}
    </a>
  )
}

export function ModelsModel(): React.JSX.Element {
  const [report, setReport] = useState<ModelReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('routing.models'))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 20_000)
    return () => clearInterval(timer)
  }, [refresh])

  useDaemonEvents((event) => {
    if (event.type === 'worker.changed' || event.type === 'quota.changed') void refresh()
  })

  if (error) return <div className="alert">{error}</div>
  if (!report) return <p className="dim">Reading what the fleet knows about each model it could run…</p>

  const routableCount = report.rows.filter((r) => r.routable).length

  return (
    <div className="stack">
      <section className="doc-section">
        <h3>5.1 A candidate is a (worker, model) pair, not an account</h3>
        <p className="panel-sub">
          Every other axis on this tab scores <em>accounts</em> — which one is free, which one is
          fast, which one has a warm cache. This one exists because an account is not one thing:
          <code> claude-code</code> alone prices three models eight times apart, and a scheduler that
          could only choose the account had no way to prefer an economical model for a typo fix and a
          more capable model for an architectural rewrite.
        </p>
        <p className="panel-sub">
          <strong>Opt-in, and inert until touched.</strong> Every worker&rsquo;s <em>routable
          models</em> allowlist starts empty, which resolves to exactly the one model that worker
          already defaults to — never &ldquo;every model this adapter can price&rdquo;. Widening it is
          a Settings &rsaquo; Workers control; nothing here changes what a worker runs until an
          operator adds a second model to its list.
        </p>
        {/* ⛔ The single most important fact on this page, and it is not derivable from the table.
            Every fitness and price number below is computed and displayed either way; whether
            routing *reads* them is this line. Printing a leaderboard that nothing consults, without
            saying nothing consults it, is the failure the Quality tab was built to avoid. */}
        <p className={report.active ? 'panel-sub' : 'alert'}>
          {report.active ? (
            <>
              <strong>Live.</strong> At least one worker has a routable-models allowlist, so{' '}
              <code>fitness</code> and <code>price</code> are scoring every candidate in every routing
              decision fleet-wide.
            </>
          ) : (
            <>
              <strong>Not scoring anything yet.</strong> No worker has a routable-models allowlist, so{' '}
              <code>fitness</code> and <code>price</code> are held at exactly 0 for every candidate and
              routing is running the same arithmetic it ran before this tab existed. The numbers below
              are real and nothing reads them. Add a second model to any worker in Settings &rsaquo;
              Workers to switch both terms on for the whole fleet.
            </>
          )}
        </p>
        <div className="metric-grid">
          <div className="metric-tile">
            <div className="metric-tile-value">{routableCount}</div>
            <div className="metric-tile-label">routable pair(s) across the fleet</div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile-value">{report.rows.length}</div>
            <div className="metric-tile-label">priced pair(s) shown below, routable or not</div>
          </div>
        </div>
      </section>

      <section className="doc-section">
        <h3>5.2 Fitness — a sufficiency bar, not a leaderboard</h3>
        <p className="panel-sub">
          <M tex={`\\lambda_{\\mathrm{fitness}} = ${weightFormulaTex(report.fitnessFormula)}`} />,
          currently <span className="num">{report.fitnessWeight.toFixed(3)}</span> at quality{' '}
          {report.objective.quality.toFixed(2)}. Its value is not how good the model is — it is
          whether the model clears the bar this task&rsquo;s <strong>complexity band</strong> sets:
        </p>
        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 11.</strong> The sufficiency bar per complexity band.
          </caption>
          <thead>
            <tr>
              <th>Complexity band</th>
              <th className="tbl-num">Required fitness</th>
            </tr>
          </thead>
          <tbody>
            {(['low', 'medium', 'high'] as const).map((band) => (
              <tr key={band}>
                <td className="tbl-strong">{band}</td>
                <td className="tbl-num num">{REQUIRED_BY_BAND[band].toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="panel-sub">
          Clearing the bar earns the full bonus; a model at 0.95 fitness on a task that needed 0.35
          earns exactly what a model at 0.40 does. A more expensive model receives no additional fitness
          bonus over a lower-cost model that satisfies the task requirements, allowing <code>price</code> to
          arbitrate between candidates that clear the sufficiency bar. Falling short costs proportionally,
          reaching 0 at a quarter-point under the bar.
        </p>
        <Eq
          n="8"
          tex="x_{\mathrm{fitness}} \;=\; \max\!\left(0,\; 1 - \frac{\max(0,\; \rho_{\text{band}} - \phi)}{0.25}\right)"
        />
        <p className="dim">
          where <M tex="\rho_{\text{band}}" /> is the required fitness from Table 11 and{' '}
          <M tex="\phi" /> the blended fitness of Eq. 9.
        </p>
      </section>

      <section className="doc-section">
        <h3>5.3 Where the blended fitness number comes from</h3>
        <p className="panel-sub">
          Each model&rsquo;s fitness starts from a checked-in <strong>benchmark prior</strong> —
          published where a leaderboard scores this exact id, honestly <em>inferred</em> from a
          neighbouring or predecessor model where none does, and <code>null</code> where neither
          exists. This fleet&rsquo;s own peer reviews are blended in, shrunk toward that prior in log
          space:
        </p>
        <Eq
          n="9"
          tex="\phi \;=\; \pi^{\,K/(n+K)} \cdot \mu^{\,n/(n+K)}, \qquad K = 8,\; n = \text{clean reviews}"
        />
        <p className="dim">
          with <M tex="\pi" /> the benchmark prior and <M tex="\mu" /> this fleet&rsquo;s measured
          clean composite, both on a 0–1 scale.
        </p>
        <p className="panel-sub">
          <strong>K = 8 is deliberately higher</strong> than the estimator&rsquo;s cost factor (K=5) or
          the pace factor (K=4): a quality composite is graded by a peer LLM against a rubric nobody
          has calibrated across providers or reviewers, which makes it the least measured of the three
          quantities this fleet shrinks. A single clean review moves the value only about 11% of the
          way off the prior; it takes on the order of twenty before the measured number dominates.
        </p>
        <div className="notice">
          <strong>Three honest gaps, not one.</strong> A prior marked <em>inferred</em> is a mapping
          from a neighbouring model, not a measurement of this one. Nothing calibrates a review
          composite across providers, and no task on this fleet has ever been run twice on two models
          — so a fitness gap between vendors is <em>suggestive</em>, never evidential. And a pair with
          neither a prior nor a clean review scores <strong>0</strong> for fitness, which is{' '}
          <em>unmeasured</em>, not <em>bad</em>: exploration below is the only thing that gives it a
          first sample.
        </div>
      </section>

      <section className="doc-section">
        <h3>5.4 Price — logarithmic distance from the cheapest candidate in the field</h3>
        <p className="panel-sub">
          <M tex={`\\lambda_{\\mathrm{price}} = ${weightFormulaTex(report.priceFormula)}`} />,
          currently <span className="num">{report.priceWeight.toFixed(3)}</span> at cost{' '}
          {report.objective.cost.toFixed(2)}. Every candidate in one decision is compared to the
          cheapest estimate in that same field — never to a fixed dollar figure, since what counts as
          expensive depends entirely on what else is on offer this tick.
        </p>
        <Eq
          n="10"
          tex="x_{\mathrm{price}} \;=\; \operatorname{clamp}\!\left(\frac{\ln\left(\hat{C}(w,m) / \min_{(w',m')} \hat{C}(w',m')\right)}{\ln 8},\; 0,\; 1\right)"
        />
        <p className="dim">
          0 for the cheapest candidate, 1.0 at 8× its cost or beyond. Priced in dollars when every
          candidate in the field has a money estimate; falls back to priced tokens for the whole field
          the moment one candidate does not, so a model that cannot yet be priced in money never reads
          as free by comparison.
        </p>
      </section>

      <section className="doc-section">
        <h3>5.5 Exploration — spending a little to stop the score starving itself</h3>
        <p className="panel-sub">
          A model with no prior and no clean review scores 0 for fitness, so the arithmetic alone would
          never route to it — and a model that never runs is never measured, which looks like evidence
          and is only silence. <strong>Model exploration</strong> is off by default
          (<code>modelExploration</code>) and, when switched on, occasionally swaps the arithmetic&rsquo;s
          winner for another routable model on the <em>same</em> worker, at the configured rate
          (<code>modelExplorationRate</code>, default 0.10) — preferring an unmeasured model over a
          measured one so the sample actually buys information.
        </p>
        <p className="dim">
          Never fires on a pinned model, a warm or sticky session, a <code>plan</code> task, a
          high-complexity task, or a worker with only one routable model. An explored dispatch is
          recorded with <code>basis: &lsquo;explore&rsquo;</code> in the routing ledger and posts a
          note to the task thread, so it is never silently indistinguishable from the arithmetic&rsquo;s
          own choice.
        </p>
      </section>

      <section className="doc-section">
        <h3>5.6 This fleet, right now</h3>
        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 12.</strong> Every priced (account, model) pair on this fleet and the
            numbers behind its <code>fitness</code> and <code>price</code> terms.
          </caption>
          <thead>
            <tr>
              <th>Account</th>
              <th>Model</th>
              <th>Routable?</th>
              <th className="tbl-num">Prior</th>
              <th>Prior source</th>
              <th className="tbl-num">Clean composite</th>
              <th className="tbl-num">Fitness</th>
              <th className="tbl-num">Est. cost/task</th>
              <th className="tbl-num">Pace</th>
              <th className="tbl-num">Pool</th>
              <th className="tbl-num">Dispatches</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={11} className="dim">
                  No worker on this fleet can price a model yet.
                </td>
              </tr>
            )}
            {report.rows.map((r) => (
              <tr
                key={`${r.workerId}:${r.model}`}
                title={`${r.priorBasis}\n\n${r.fitnessBasis}`}
                className={r.routable ? '' : 'dim'}
              >
                <td className="tbl-strong">
                  {r.label} <span className="dim">{r.adapterId}</span>
                </td>
                <td>{r.model}</td>
                <td>{r.routable ? 'yes' : 'not on allowlist'}</td>
                <td className="tbl-num num">{r.prior === null ? 'unknown' : r.prior.toFixed(2)}</td>
                <td className="dim">
                  <PriorSource
                    name={r.priorSource}
                    prior={r.prior}
                    basis={r.priorBasis}
                    sources={report.benchmarkSources}
                  />
                </td>
                <td className="tbl-num num">
                  {r.cleanComposite === null ? 'n/a' : `${r.cleanComposite.toFixed(1)} (n=${r.cleanSamples})`}
                </td>
                <td className="tbl-num num">{fmtScore(r.fitness)}</td>
                <td className="tbl-num num">{money(r.costUsd)}</td>
                <td className="tbl-num num">
                  {r.paceFactor === null ? 'unmeasured' : `×${r.paceFactor.toFixed(2)} (n=${r.paceSamples})`}
                </td>
                <td className="tbl-num num dim">
                  {r.pool === null
                    ? '—'
                    : r.poolPercent === null
                      ? `${r.pool}, not trusted`
                      : `${r.pool} ${Math.round(r.poolPercent)}%`}
                </td>
                <td className="tbl-num num">
                  {r.dispatches}
                  {r.explorations > 0 ? ` (${r.explorations} explored)` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim">
          Hover over any row to view the benchmark prior and blended fitness derivation. A dimmed
          row indicates a model supported by the provider that is not currently enabled on the worker allowlist.
        </p>
      </section>

      <section className="doc-section">
        <h3>5.7 Where the priors came from</h3>
        <p className="panel-sub">
          Every number in the <strong>Prior</strong> column above was read off one of these, on the
          date shown, and checked in as data — never typed from memory. A model whose source reads{' '}
          <em>inferred</em> was matched to a family prefix rather than scored in its own right, and a
          model no file names at all reads <code>unknown</code>, which is not a score of zero. Drop an
          updated file into the data directory&rsquo;s <code>benchmarks/</code> folder to supersede the
          one compiled into the app.
        </p>
        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 13.</strong> The leaderboards behind the benchmark priors.
          </caption>
          <thead>
            <tr>
              <th>Source</th>
              <th>Benchmark file</th>
              <th>Retrieved</th>
            </tr>
          </thead>
          <tbody>
            {report.benchmarkSources.length === 0 && (
              <tr>
                <td colSpan={3} className="dim">
                  No benchmark file is loaded, so no model on this fleet has a prior.
                </td>
              </tr>
            )}
            {report.benchmarkSources.map((src) => (
              <tr key={`${src.fileId}:${src.name}`}>
                <td className="tbl-strong">
                  {/* ⛔ `target="_blank"` so `setWindowOpenHandler` in the main process hands the URL
                      to the real browser; an in-window navigation would replace the app. */}
                  <a href={src.url} target="_blank" rel="noreferrer" title={src.url}>
                    {src.name}
                  </a>
                </td>
                <td className="dim">
                  {src.fileId} <span className="dim">(as of {src.effectiveFrom})</span>
                </td>
                <td className="dim">{src.retrieved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
