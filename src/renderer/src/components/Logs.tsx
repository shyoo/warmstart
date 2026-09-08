import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogFile, LogLevel } from '@shared/protocol'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { age } from '../lib/format'
import { errorMessage } from '@shared/errors.js'

/**
 * What the daemon is doing, and did.
 *
 * ⛔ **The premise of this product is unattended progress**, which means the operator is by
 * definition not watching when most of it happens. Until 2026-08-28 there was no answer to *when did
 * it probe that account*, *why is nothing being dispatched*, or *what did it do overnight*: the
 * daemon wrote a log file that nothing in the app displayed and no screen mentioned, and only `warn`
 * and `error` were forwarded to a UI that rendered neither.
 *
 * Two halves, deliberately:
 *
 *  - **Live**, from `log` events, with the recent past filled in from the daemon's ring buffer so a
 *    panel opened after the interesting minute still shows it.
 *  - **On disk**, one file per day, listed here with a path. ⚠️ The files are *listed*, never read
 *    into this view: a day of a busy fleet is megabytes, and a React list is the wrong tool for it.
 *    The buffer covers what a person reads on screen; the files cover the rest.
 */

/** ⚠️ Bounded here as well as in the daemon. Unbounded log state is a memory leak with a nice UI. */
const MAX_LINES = 2000

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function Logs({ now }: { now: number }): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [files, setFiles] = useState<{ directory: string; files: LogFile[] } | null>(null)
  const [level, setLevel] = useState<LogLevel>('info')
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const scroller = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    try {
      const [tail, onDisk] = await Promise.all([
        rpc('log.tail', { limit: MAX_LINES, level: 'debug' }),
        rpc('log.files')
      ])
      setEntries(tail)
      setFiles(onDisk)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useDaemonEvents((event) => {
    if (event.type !== 'log') return
    setEntries((prev) => {
      const next = [...prev, { ts: event.ts, level: event.level, message: event.message }]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  })

  const shown = useMemo(() => {
    const min = ORDER[level]
    const needle = filter.trim().toLowerCase()
    return entries.filter(
      (e) => ORDER[e.level] >= min && (!needle || e.message.toLowerCase().includes(needle))
    )
  }, [entries, level, filter])

  // ⚠️ Only while following. Yanking the viewport to the bottom under somebody who has scrolled up to
  // read something is the single most annoying thing a log view can do.
  useEffect(() => {
    if (!follow) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shown, follow])

  return (
    <div className="panel">
      <header className="panel-head">
        <div>
          <h2>Logs</h2>
          <p className="panel-sub">
            What the scheduler, the quota poller and the sessions are doing — live, and kept on disk a
            day at a time. This is the record of the hours nobody was watching, which is most of them.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          Reload
        </button>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="log-controls">
        <label className="log-control">
          <span className="dim">level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
            <option value="debug">debug and up</option>
            <option value="info">info and up</option>
            <option value="warn">warn and up</option>
            <option value="error">errors only</option>
          </select>
        </label>
        <input
          className="log-filter"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="log-control">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span>follow</span>
        </label>
        <span className="num dim">
          {shown.length} of {entries.length} line(s)
        </span>
      </div>

      {/* ⚠️ `debug` is offered even though the daemon usually will not send any. The level is chosen
          at the daemon by MULTI_AGENT_CONTROLLER_LOG_LEVEL, so this filter narrows what arrives and
          can never widen it — said below, because an empty debug view is otherwise a bug report. */}
      <div className="log-view" ref={scroller}>
        {shown.length === 0 ? (
          <p className="dim">
            {entries.length === 0
              ? 'Nothing logged yet. The daemon writes a line when it dispatches, probes an account, ' +
                'or changes a task’s state.'
              : 'Nothing at this level matches. Widen the level or clear the filter.'}
          </p>
        ) : (
          shown.map((e, i) => (
            <div className={`log-line log-line--${e.level}`} key={`${e.ts}-${i}`}>
              <span className="num log-time">{stamp(e.ts)}</span>
              <span className={`log-level log-level--${e.level}`}>{e.level}</span>
              <span className="log-message">{e.message}</span>
            </div>
          ))
        )}
      </div>

      <section className="doc-section">
        <h3>On disk</h3>
        <p className="note">
          One file per day in <code>{files?.directory ?? 'the data directory'}</code>, kept for two
          weeks. ⛔ Nothing in this app deletes them on request — the point of a record of an
          unattended fleet is that it is still there afterwards. Open one in an editor for anything
          older than the {MAX_LINES} lines above.
        </p>
        {files && files.files.length > 0 ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>File</th>
                <th className="tbl-num">Size</th>
                <th className="tbl-num">Last written</th>
              </tr>
            </thead>
            <tbody>
              {files.files.map((f) => (
                <tr key={f.name}>
                  <td className="mono">{f.name}</td>
                  <td className="num tbl-num">{Math.max(1, Math.round(f.bytes / 1024))} KB</td>
                  <td className="num tbl-num">{age(now - f.modifiedAt)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dim">No log files yet.</p>
        )}
      </section>
    </div>
  )
}

/** Local time, to the second. ⚠️ A log is read against a wall clock, never against UTC. */
function stamp(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}
