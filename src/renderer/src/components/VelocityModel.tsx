import { useCallback, useEffect, useState } from 'react'
import type { VelocityReport } from '@shared/routing'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { duration } from '../lib/format'
import { errorMessage } from '@shared/errors.js'
import { Eq, M } from './Math'
import { weightFormulaTex } from '../lib/tex'

/**
 * Analytics > Routing Model > Velocity.
 *
 * ⛔ **Two questions, kept apart, because they fail differently.** *Can this account take work right
 * now* is a gate — capacity, a quota window, a sign-in — and answering it wrong holds a task
 * indefinitely. *How long does this account take* is a learned preference that only ever breaks a
 * tie. A single "velocity score" merging the two would make a slow-but-free worker look ineligible
 * and an unavailable-but-fast one look ready.
 */
export function VelocityModel(): React.JSX.Element {
  const [report, setReport] = useState<VelocityReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setReport(await rpc('routing.velocity'))
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
    if (event.type === 'session.changed' || event.type === 'quota.changed') void refresh()
  })

  if (error) return <div className="alert">{error}</div>
  if (!report) return <p className="dim">Reading what the fleet has measured about its own pace…</p>

  const { objective } = report

  return (
    <div className="stack">
      <section className="doc-section">
        <h3>4.1 How the scheduler finds an available worker</h3>
        <p className="panel-sub">
          Availability is an eligibility <strong>gate</strong>, not a preference score. Before calculating
          scores, each account is verified against core operational constraints. An account that fails any gate
          is disqualified immediately so the task can dispatch to an available candidate without delay.
        </p>
        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 9.</strong> The eligibility gates, in the order they are asked.
          </caption>
          <thead>
            <tr>
              <th>Gate</th>
              <th>What it asks</th>
              <th>What happens when it fails</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="tbl-strong">Task constraints</td>
              <td>Did the task pin an account, a set of accounts, or an adapter?</td>
              <td className="dim">Everything else is skipped silently — this is a request, not a preference</td>
            </tr>
            <tr>
              <td className="tbl-strong">Account fitness</td>
              <td>
                Disabled, occupied by a person, no CLI installed, checkably signed out, or held out
                after a run that produced nothing
              </td>
              <td className="dim">Discarded, with the reason shown on the task row</td>
            </tr>
            <tr>
              <td className="tbl-strong">Capabilities</td>
              <td>Does the adapter have every capability the task declared it needs?</td>
              <td className="dim">Discarded. ⛔ Asked as capabilities, never as adapter names</td>
            </tr>
            <tr>
              <td className="tbl-strong">Concurrency</td>
              <td>
                Live <em>work</em> sessions against <code>maxConcurrent</code>. Consults, chats and
                probes are short and bounded separately, so they are not counted here.
              </td>
              <td className="dim">Held until a slot frees</td>
            </tr>
            <tr>
              <td className="tbl-strong">Quota water mark</td>
              <td>
                Is the applicable window — the pool this task&rsquo;s <em>model</em> would draw on, not
                every window the account has — at or above the high-water mark?
              </td>
              <td className="dim">
                Held until the window resets, and the reset time is read off the very sample that
                refused it. ⚠️ The one gate a person may overrule by hand
              </td>
            </tr>
          </tbody>
        </table>
        <p className="panel-sub">
          Only the surviving accounts are scored. Being <em>available</em> earns an account no bonus
          points; it qualifies the candidate to be evaluated.
        </p>
      </section>

      <section className="doc-section">
        <h3>4.2 Velocity score impact</h3>
        <p className="panel-sub">
          Increasing the <code>velocity</code> weight in your objective influences routing in three ways:
        </p>
        <ul className="doc-list">
          <li>
            <strong>It lowers the penalty on cold starts.</strong>{' '}
            <M tex="\lambda_{\mathrm{cold}} = 0.8 + 2.0\,c - 0.7\,v" />. High-velocity routing stops
            waiting for accounts with warm caches and prefers immediate dispatch to any idle worker.
          </li>
          <li>
            <strong>It raises effective concurrency.</strong> Above 0.5 velocity, configured worker
            concurrency doubles to favor parallel throughput over serial cache reuse.
          </li>
          <li>
            <strong>It increases the weight of measured pace.</strong>{' '}
            <M tex={`\\lambda_{\\mathrm{pace}} = ${weightFormulaTex(report.paceFormula)}`} />,
            currently <span className="num">{report.paceWeight.toFixed(3)}</span> at velocity{' '}
            {objective.velocity.toFixed(2)}.
          </li>
        </ul>
      </section>

      <section className="doc-section">
        <h3>4.3 The pace term — learned from task completion history</h3>
        <p className="panel-sub">
          The scheduler tracks historical task completion durations per agent and model, favoring faster
          accounts when other factors are balanced:
        </p>
        <ul className="doc-list">
          <li>
            <strong>Active time, never wall-clock.</strong> If a task starts, pauses waiting for user input,
            and resumes later, only the active agent execution time is counted. All elapsed wall-clock
            duration waiting for external input is excluded.
          </li>
          <li>
            <strong>Normalized against the fleet baseline.</strong> The baseline is the geometric mean of
            active time across all finished tasks, preventing disproportionate skew from uneven task counts.
          </li>
          <li>
            <strong>Bayesian shrinkage based on sample count.</strong>{' '}
            <M tex="f = r^{\,n/(n+4)}" /> in log space, ensuring equal moderation for both fast and slow outliers.
            A single finished task cannot produce an ungrounded multiplier.
          </li>
        </ul>
        <Eq
          n="7"
          tex="x_{\mathrm{pace}} \;=\; \operatorname{clamp}\!\left(-\frac{\ln f}{\ln 4},\; -1,\; +1\right), \qquad f = \left(\frac{\tilde{t}_{\text{agent, model}}}{\bar{t}_{\text{fleet}}}\right)^{n/(n+4)}"
        />
        <p className="panel-sub">
          so <M tex="+1" /> is measured four times faster than the fleet&rsquo;s median task,{' '}
          <M tex="0" /> is exactly at the median — or nothing measured yet — and <M tex="-1" /> is
          four times slower; the contribution is{' '}
          <M tex={`+${report.paceWeight.toFixed(3)} \\times x_{\\mathrm{pace}}`} /> at this
          objective.
        </p>
        <p className="dim">
          ⛔ This is the only <em>signed</em> value in the whole score, and deliberately: every other
          term measures a quantity with a floor — there is no such thing as less-than-no prompt cache
          — while pace has a real middle. A penalty-only reading would score the fleet&rsquo;s fastest
          agent identically to its median one, which is precisely the discrimination the term exists
          to add. ⚠️ An unmeasured key scores <strong>0</strong>, never a guess, exactly as an
          untrustworthy quota reading does.
        </p>
        <div className="notice">
          <strong>What this cannot tell you.</strong> Nothing in the data separates &ldquo;that agent
          is slow&rdquo; from &ldquo;that agent gets the long tasks&rdquo;. No task on this fleet has
          been completed twice on two different keys, so the comparison a controlled experiment would
          give does not exist. That is why the factor is shrunk, why the weight is modest, and why the
          basis is printed beside every number below rather than the number standing alone.
        </div>
      </section>

      <section className="doc-section">
        <h3>4.4 This fleet, right now</h3>
        <div className="metric-grid">
          <div className="metric-tile">
            <div className="metric-tile-value">
              {report.neutralActiveMs > 0 ? duration(report.neutralActiveMs) : 'n/a'}
            </div>
            <div className="metric-tile-label">fleet median task (geometric mean, active time)</div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile-value">{report.samples}</div>
            <div className="metric-tile-label">finished tasks the factors are learned from</div>
          </div>
          <div className="metric-tile">
            <div className="metric-tile-value">{report.paceWeight.toFixed(3)}</div>
            <div className="metric-tile-label">pace weight = {report.paceFormula}</div>
          </div>
        </div>

        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 10.</strong> Every account, its availability, and the pace term it would
            score right now.
          </caption>
          <thead>
            <tr>
              <th>Account</th>
              <th>Available?</th>
              <th className="tbl-num">Running</th>
              <th className="tbl-num">Window</th>
              <th className="tbl-num">Median task</th>
              <th className="tbl-num">n</th>
              <th className="tbl-num">Factor</th>
              <th className="tbl-num">Pace value</th>
              <th className="tbl-num">Contribution</th>
            </tr>
          </thead>
          <tbody>
            {report.workers.map((w) => (
              <tr key={w.workerId} title={w.basis}>
                <td className="tbl-strong">
                  {w.label} <span className="dim">{w.adapterId}</span>
                </td>
                <td className={w.unavailable ? 'warn' : ''}>
                  {w.unavailable ?? (w.running >= w.maxConcurrent ? 'at capacity' : 'yes')}
                </td>
                <td className="tbl-num num">
                  {w.running}/{w.maxConcurrent}
                </td>
                <td className="tbl-num num dim">
                  {w.windowPercent === null
                    ? 'not trusted'
                    : `${Math.round(w.windowPercent)}% ${w.windowLabel ?? ''}`}
                </td>
                <td className="tbl-num num">
                  {w.medianActiveMs === null ? 'n/a' : duration(w.medianActiveMs)}
                </td>
                <td className="tbl-num num">{w.samples}</td>
                <td className="tbl-num num">
                  {w.samples === 0 ? <span className="dim">unmeasured</span> : `×${w.factor.toFixed(2)}`}
                </td>
                <td className="tbl-num num">
                  {w.value >= 0 ? '+' : '−'}
                  {Math.abs(w.value).toFixed(2)}
                </td>
                <td className="tbl-num num">
                  {w.value >= 0 ? '+' : '−'}
                  {Math.abs(w.value * report.paceWeight).toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="dim">
          Hover over any row to view its derivation. A factor above ×1 is slower than the fleet median,
          while a factor below ×1 indicates faster execution.
        </p>
      </section>
    </div>
  )
}
