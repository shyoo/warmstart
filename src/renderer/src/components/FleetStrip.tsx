import type { FleetEntry } from '../lib/daemon'
import { cacheUrgency, countdown, age, percent, quotaUrgency, tokens } from '../lib/format'

/**
 * What the operator currently holds in their head, made visible: how much of each account's window
 * is spent, when it resets, and how long each live session's prompt cache has left.
 *
 * ⚠️ The staleness treatment is the point of this component, not a detail. A quota reading whose age
 * is unknown-or-old is rendered as unknown, never as a confident number - a stale percentage makes
 * the compaction reserve look satisfied when it is not, and that failure strands context.
 */
export function FleetStrip({ fleet, now }: { fleet: FleetEntry[]; now: number }): React.JSX.Element {
  if (fleet.length === 0) {
    return (
      <div className="fleet">
        <span className="fleet-label">Fleet</span>
        <span className="fleet-empty">no workers configured</span>
      </div>
    )
  }

  return (
    <div className="fleet">
      <span className="fleet-label">Fleet</span>
      <div className="fleet-cards">
        {fleet.map((entry) => (
          <WorkerCard key={entry.worker.id} entry={entry} now={now} />
        ))}
      </div>
    </div>
  )
}

function WorkerCard({ entry, now }: { entry: FleetEntry; now: number }): React.JSX.Element {
  const { worker, quota, sessions } = entry
  const stale = quota?.stale ?? true
  const windows = quota?.windows ?? []

  return (
    <div className={`wcard${worker.enabled ? '' : ' wcard--off'}`}>
      <div className="wcard-head">
        <span className="wcard-name">{worker.label}</span>
        {worker.humanOccupied && <span className="tag tag--human">human</span>}
        {!worker.enabled && <span className="tag">off</span>}
      </div>

      {windows.length === 0 || stale ? (
        <div className="wcard-unknown">
          <span className="dot dot--down" />
          quota unknown
          {quota?.ageMs !== undefined && quota.windows.length > 0 && (
            <span className="num wcard-agenote"> · last seen {age(quota.ageMs)}</span>
          )}
        </div>
      ) : (
        windows.map((w) => (
          <div className="gauge" key={w.id}>
            <span className="gauge-label">{w.label}</span>
            <span className="bar">
              <span
                className={`bar-fill bar-fill--${quotaUrgency(w.percent)}`}
                style={{ width: `${Math.min(100, Math.max(2, w.percent))}%` }}
              />
            </span>
            <span className="num gauge-value">{percent(w.percent)}</span>
            <span className="num gauge-reset">{countdown(w.resetsAt, now)}</span>
          </div>
        ))
      )}

      {sessions.length > 0 && (
        <div className="wcard-sessions">
          {sessions.map((s) => (
            <span key={s.id} className="chip" title={`${s.cwd}\n${s.transport} transport`}>
              <span className="mono">{s.id.slice(0, 4)}</span>
              <span className={`num chip-clock chip-clock--${cacheUrgency(s.cacheExpiresAt, now)}`}>
                {countdown(s.cacheExpiresAt, now)}
              </span>
              <span className="num chip-ctx">{tokens(s.contextTokens)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
