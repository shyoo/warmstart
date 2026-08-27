import type { Session } from '@shared/protocol'
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

/**
 * What a session chip says.
 *
 * ⚠️ It used to say `c760 57:46 0`, which is three true numbers and no way to know what any of them
 * means. The id prefix is the least useful of the three to a person reading the strip and is the one
 * that led, so the chip read as a fault code; it now lives in the tooltip, where it is still there
 * for anyone matching a chip to a row in Sessions.
 *
 * ⛔ A context of zero is not rendered as `0`. Zero metered tokens means the transcript has recorded
 * no turn yet — a session that has just started, or one that never got going — and `0` reads as a
 * measurement rather than as an absence. `tokens()` already draws unknown as `--` for exactly this
 * reason; the same must be true one level up.
 */
function SessionChip({ session, now }: { session: Session; now: number }): React.JSX.Element {
  const ctx = session.contextTokens
  return (
    <span
      className="chip"
      title={
        `session ${session.id}\n${session.purpose} · ${session.transport} transport\n${session.cwd}\n` +
        'the clock is what is left of this session’s prompt cache\n' +
        // ⛔ Said here because the two numbers get compared. `ctx` is how full the window is
        // now and falls when the session compacts; a task's token count is a running total of
        // everything it ever spent, and only grows. They are not the same quantity.
        'ctx is how full the window is now — a level, not a total, and not a task’s token count'
      }
    >
      <span className="chip-purpose">{session.purpose}</span>
      <span className={`num chip-clock chip-clock--${cacheUrgency(session.cacheExpiresAt, now)}`}>
        cache {countdown(session.cacheExpiresAt, now)}
      </span>
      <span className="num chip-ctx">{ctx ? `${tokens(ctx)} ctx` : 'no turn yet'}</span>
    </span>
  )
}

function WorkerCard({ entry, now }: { entry: FleetEntry; now: number }): React.JSX.Element {
  const { worker, quota, sessions } = entry
  const stale = quota?.stale ?? true
  const windows = quota?.windows ?? []
  const suspect = worker.health?.state === 'suspect' ? worker.health : null

  return (
    <div className={`wcard${worker.enabled ? '' : ' wcard--off'}`}>
      <div className="wcard-head">
        <span className="wcard-name">{worker.label}</span>
        {worker.humanOccupied && <span className="tag tag--human">human</span>}
        {!worker.enabled && <span className="tag">off</span>}
        {suspect && (
          <span className="tag tag--suspect" title={suspect.reason}>
            no work
          </span>
        )}
      </div>

      {/* ⛔ Above the quota gauges, because it outranks them. An account that cannot run anything has
          a percentage that is true and irrelevant, and burying the reason under it is how this fleet
          spent an afternoon routing work to a worker that could not take it. */}
      {suspect && <div className="wcard-suspect">{suspect.reason}</div>}

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
            <SessionChip key={s.id} session={s} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
