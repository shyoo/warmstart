import { useCallback, useEffect, useState } from 'react'
import type { DoctorReport } from '@shared/protocol'
import { rpc } from '../lib/daemon'
import { age } from '../lib/format'

/**
 * Doctor.
 *
 * The question this answers is "why is nothing happening?", and it answers it with facts rather
 * than a spinner: which CLIs were found and at what version, which accounts are actually signed in,
 * how old each quota reading is, and which cost model is in force. Every warning names the thing to
 * fix.
 */
export function Doctor(): React.JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    try {
      setReport(await rpc('doctor.run'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Doctor</h2>
          <p className="panel-sub">What Multi Agent Controller can see, and what it cannot.</p>
        </div>
        <button className="btn" disabled={running} onClick={() => void run()}>
          {running ? 'Checking…' : 'Re-check'}
        </button>
      </header>

      {error && <div className="alert">{error}</div>}
      {!report ? (
        <p className="dim">Checking…</p>
      ) : (
        <>
          {report.warnings.length > 0 && (
            <ul className="warnings">
              {report.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <Section title="Daemon">
            <dl className="kv">
              <dt>version</dt>
              <dd className="num">{report.daemon.version}</dd>
              <dt>pid</dt>
              <dd className="num">{report.daemon.pid}</dd>
              <dt>port</dt>
              <dd className="num">127.0.0.1:{report.daemon.port}</dd>
              <dt>uptime</dt>
              <dd className="num">{Math.round(report.daemon.uptimeMs / 60000)}m</dd>
              <dt>database</dt>
              <dd className="mono kv-path">{report.daemon.dbPath}</dd>
            </dl>
          </Section>

          <Section title="Agent CLIs">
            <table className="tbl">
              <tbody>
                {report.adapters.map((a) => (
                  <tr key={a.adapterId}>
                    <td className="tbl-strong">{a.adapterId}</td>
                    <td>
                      {a.found ? (
                        <span className="ok">found</span>
                      ) : (
                        <span className="warn">not on PATH</span>
                      )}
                    </td>
                    <td className="num">{a.version ?? '--'}</td>
                    <td className="mono kv-path">{a.path ?? a.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Workers">
            {report.workers.length === 0 ? (
              <p className="dim">None commissioned yet.</p>
            ) : (
              <table className="tbl">
                <tbody>
                  {report.workers.map((w) => (
                    <tr key={w.workerId}>
                      <td className="tbl-strong">{w.label}</td>
                      <td>
                        {w.loggedIn === true ? (
                          <span className="ok">signed in</span>
                        ) : w.loggedIn === false ? (
                          <span className="warn">not signed in</span>
                        ) : (
                          <span className="dim">unknown</span>
                        )}
                      </td>
                      <td>
                        {w.isolationRootExists ? (
                          <span className="dim">root ok</span>
                        ) : (
                          <span className="warn">root missing</span>
                        )}
                      </td>
                      <td className="num">
                        {w.lastQuota && w.lastQuota.windows.length > 0 ? (
                          <>
                            {w.lastQuota.windows.map((q) => `${q.label} ${Math.round(q.percent)}%`).join(' · ')}
                            <span className="dim"> · {age(Date.now() - w.lastQuota.sampledAt)}</span>
                          </>
                        ) : (
                          <span className="warn">no reading</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Cost models">
            <table className="tbl">
              <tbody>
                {report.costModels.map((m) => (
                  <tr key={m.id}>
                    <td className="tbl-strong mono">{m.id}</td>
                    <td className="dim">from {m.effectiveFrom}</td>
                    <td className="dim">{m.source}</td>
                    <td className="mono kv-path">{m.path ?? 'compiled in'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <p className="note">
            <strong>On quota readings.</strong> Claude Code has no free live usage probe: the slash
            command spends a real turn, so it reads the CLI&rsquo;s own cache instead and shows
            you how old it is. An old reading is reported as <em>unknown</em> rather than as a number,
            because a stale percentage makes the compaction reserve look satisfied when it is not.
          </p>
        </>
      )}
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="doc-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}
