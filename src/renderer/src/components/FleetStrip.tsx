import type { Session } from '@shared/protocol'
import type { FleetEntry } from '../lib/daemon'
import {
  cacheRemaining,
  cacheUrgency,
  countdown,
  age,
  percent,
  quotaUrgency,
  tokens
} from '../lib/format'

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
 * One session, drawn as a gauge so it reads against the account's windows above it.
 *
 * ⚠️ It used to say `c760 57:46 0`, which is three true numbers and no way to know what any of them
 * means. The id prefix is the least useful of the three to a person reading the strip and is the one
 * that led, so the chip read as a fault code; it now lives in the tooltip, where it is still there
 * for anyone matching a chip to a row in Sessions.
 *
 * ⛔ **The bar is the cache, not the context.** The two numbers on this row measure different things
 * and only one of them is a countdown: the fill and the clock are the same quantity seen twice, so
 * they can never disagree. Filling the bar by context and putting the cache clock beside it would
 * make a row whose bar and timer move independently, which is unreadable at a glance.
 *
 * ⛔ A context of zero is not rendered as `0`. Zero metered tokens means the transcript has recorded
 * no turn yet — a session that has just started, or one that never got going — and `0` reads as a
 * measurement rather than as an absence. `tokens()` already draws unknown as `--` for exactly this
 * reason; the same must be true one level up.
 */
function SessionGauge({ session, now }: { session: Session; now: number }): React.JSX.Element {
  const ctx = session.contextTokens
  const window = session.contextWindow
  const left = cacheRemaining(session, now)
  const urgency = cacheUrgency(session.cacheExpiresAt, now)

  return (
    <div
      className="gauge gauge--session"
      title={
        `session ${session.id}\n${session.purpose} · ${session.transport} transport\n${session.cwd}\n` +
        'the bar and the clock are both what is left of this session’s prompt cache\n' +
        // ⛔ Said here because the two numbers get compared. `ctx` is how full the window is
        // now and falls when the session compacts; a task's token count is a running total of
        // everything it ever spent, and only grows. They are not the same quantity.
        'ctx is how full the window is now — a level, not a total, and not a task’s token count'
      }
    >
      <span className="gauge-label">{session.purpose}</span>
      <span className="bar">
        {left !== null && (
          <span
            className={`bar-fill bar-fill--cache-${urgency}`}
            style={{ width: `${Math.max(2, left * 100)}%` }}
          />
        )}
      </span>
      <span className="num gauge-value">
        {ctx ? `${tokens(ctx)}${window ? `/${tokens(window)}` : ''}` : 'no turn yet'}
      </span>
      <span className={`num gauge-reset gauge-reset--${urgency}`}>
        {countdown(session.cacheExpiresAt, now)}
      </span>
    </div>
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
        {/* ⛔ Two different states, and the difference is what the operator does next. `sign in`
            means the account needs re-authenticating and the button that fixes it is one panel
            away; `no work` means something else killed the run and the reason below says what.
            ⚠️ The adapter decided which - never a substring match out here. */}
        {suspect && (
          <span className="tag tag--suspect" title={suspect.reason}>
            {suspect.needsReauth ? 'sign in' : 'no work'}
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

      {/* ⛔ The rule is load-bearing, not decoration. Everything above it is the **account**: one
          quota, shared by every session on it, and it survives the session ending. Everything below
          is **one live session**: its own context, its own cache clock, gone when it closes. Four
          gauges of identical shape with nothing between them read as four measurements of one
          thing, and they are not — that is the confusion this line exists to end. */}
      {sessions.length > 0 && (
        <div className="wcard-sessions">
          <div className="wcard-rule">
            <span>sessions</span>
          </div>
          {sessions.map((s) => (
            <SessionGauge key={s.id} session={s} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
