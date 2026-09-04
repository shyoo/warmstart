import { useCallback, useEffect, useState } from 'react'
import type { VelocityReport } from '@shared/routing'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { duration } from '../lib/format'

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
      setError(err instanceof Error ? err.message : String(err))
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
        <h3>1. How the scheduler finds an available worker</h3>
        <p className="panel-sub">
          Availability is a <strong>gate</strong>, not a score. Before anything is weighed, every
          account is asked a series of yes/no questions, and failing one discards it outright rather
          than merely making it less attractive — a task that cannot run on account A may run on
          account B <em>right now</em>, and queueing behind A would be the wrong answer.
        </p>
        <table className="tbl">
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
          Only the survivors are scored. Being <em>available</em> earns an account nothing on its own;
          it earns the right to be compared.
        </p>
      </section>

      <section className="doc-section">
        <h3>2. What velocity buys you in the score</h3>
        <p className="panel-sub">
          Raising <code>velocity</code> in your objective vector does three separate things, none of
          them a switch:
        </p>
        <ul className="doc-list">
          <li>
            <strong>It makes a cold start cheap.</strong> <code>cold = 0.8 + 2.0×cost − 0.7×velocity</code>
            . Velocity-weighted work stops waiting for the account holding a warm prompt cache and
            takes whichever one is free.
          </li>
          <li>
            <strong>It doubles effective concurrency.</strong> Above 0.5 velocity, a worker&rsquo;s
            configured concurrency is multiplied by two — cost-weighted work serialises onto warm
            sessions instead.
          </li>
          <li>
            <strong>It makes measured pace matter.</strong>{' '}
            <code>pace = {report.paceFormula}</code>, currently{' '}
            <span className="num">{report.paceWeight.toFixed(3)}</span> at velocity{' '}
            {objective.velocity.toFixed(2)}.
          </li>
        </ul>
      </section>

      <section className="doc-section">
        <h3>3. The pace term — learned from what tasks actually took</h3>
        <p className="panel-sub">
          The scheduler keeps a per-agent, per-model median of how long a finished task has actually
          taken, and prefers the faster account when nothing else separates two candidates. Three
          things make that number honest:
        </p>
        <ul className="doc-list">
          <li>
            <strong>Active time, never wall-clock.</strong> A task dispatched at 09:00, blocked on a
            question at 09:04 and answered at 17:00 took four minutes of agent work and eight hours of
            your day. Only the four minutes are counted — every stretch spent waiting on a person is
            subtracted, including the stretches <em>inside</em> a run, which a naive{' '}
            <code>ended − started</code> misses entirely.
          </li>
          <li>
            <strong>A ratio against the fleet&rsquo;s own centre, not an absolute.</strong> The middle
            is the geometric mean of every finished task&rsquo;s active time — not the median, because
            run counts are wildly uneven and a pooled median lands inside whichever agent has done the
            most work.
          </li>
          <li>
            <strong>Shrunk towards 1 by how few samples it rests on.</strong>{' '}
            <code>factor = ratio^(n/(n+4))</code>, in log space so that ×4 and ×¼ are pulled by the
            same proportion. One finished task can never mint a 4× multiplier.
          </li>
        </ul>
        <pre className="code-block">
{`value  = −log(factor) / log(4),  clamped to [−1, +1]
       = +1  measured 4x faster than the fleet's median task
       =  0  exactly at the median — or nothing measured yet
       = −1  measured 4x slower

contribution = +${report.paceWeight.toFixed(3)} × value`}
        </pre>
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
        <h3>4. This fleet, right now</h3>
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

        <table className="tbl">
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
          Hover a row for the derivation in words. A factor above ×1 is slower than this
          fleet&rsquo;s centre and costs the account score; below ×1 is faster and earns it.
        </p>
      </section>
    </div>
  )
}
