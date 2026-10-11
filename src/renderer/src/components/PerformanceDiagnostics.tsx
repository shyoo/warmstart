import { useState } from 'react'
import type { PerformanceSnapshot } from '@shared/performance'
import { rpc } from '../lib/daemon'
import { uiTimings } from '../lib/performance'
import { errorMessage } from '@shared/errors'

export function PerformanceDiagnostics(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<{ daemon: PerformanceSnapshot; ui: PerformanceSnapshot } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capture = async (): Promise<void> => {
    setBusy(true)
    try {
      const daemon = await rpc('diagnostics.performance')
      setSnapshot({ daemon, ui: uiTimings().snapshot() }); setError(null)
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }
  const exportSnapshot = (): void => {
    if (!snapshot) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'warmstart-performance.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="doc-section performance-diagnostics">
    <h3>Performance diagnostics</h3>
    <p className="dim">Local timing, counts and response sizes. No prompts or transcript content. Capture after reproducing a delay.</p>
    <div className="row-actions">
      <button className="btn" disabled={busy} onClick={() => void capture()}>{busy ? 'Capturing…' : 'Capture timings'}</button>
      <button className="btn btn--secondary" disabled={!snapshot} onClick={exportSnapshot}>Export timings</button>
    </div>
    {error && <div className="alert">{error}</div>}
    {snapshot && <>
      <p className="dim">Captured {new Date(snapshot.daemon.generatedAt).toLocaleTimeString()}. Percentiles/max cover the most recent {snapshot.daemon.sampleLimit} samples per stage; counts and bytes are cumulative. Missing samples mean unmeasured.</p>
      <p className="dim">Loop busy: {snapshot.daemon.loopBusyPercent == null ? 'unmeasured' : `${snapshot.daemon.loopBusyPercent.toFixed(1)}%`} {snapshot.daemon.loopSampledAt ? `(sampled ${new Date(snapshot.daemon.loopSampledAt).toLocaleTimeString()})` : ''}</p>
      <p className="dim">Open runs at capture: {snapshot.daemon.openRuns ? `${snapshot.daemon.openRuns.work} work · ${snapshot.daemon.openRuns.reviews} reviews` : 'unmeasured'}. Open is not a measurement of CPU activity.</p>
      <p className="dim">UI RPC includes IPC, daemon queueing and response delivery. RPC total starts at handler dispatch; sync covers the handler’s initial synchronous work, encode covers JSON serialization. Loop delay includes the 20 ms probe interval. Browser event samples include reported interactions ≥16 ms; they are not a full-session INP score.</p>
      <table className="tbl"><thead><tr><th>Stage</th><th>Count</th><th>p50</th><th>p95</th><th>Max</th><th>Pending / peak</th><th>Bytes</th><th>Last sample</th></tr></thead>
        <tbody>{[...snapshot.ui.rows, ...snapshot.daemon.rows].map((row) => {
          const format = (value: number | null): string => value === null ? '—' : `${value.toFixed(1)} ms`
          return <tr key={row.label}><td>{row.label}</td><td>{row.count}</td><td>{format(row.p50Ms)}</td><td>{format(row.p95Ms)}</td><td>{format(row.maxMs)}</td><td>{row.pending} / {row.peakPending}</td><td>{row.bytes ?? '—'}</td><td>{row.lastAt ? new Date(row.lastAt).toLocaleTimeString() : '—'}</td></tr>
        })}</tbody>
      </table>
    </>}
  </section>
}
