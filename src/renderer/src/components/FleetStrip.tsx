import { useState } from 'react'
import type { Session } from '@shared/protocol'
import type { FleetEntry } from '../lib/daemon'
import { readFleetCollapsed, writeFleetCollapsed } from '../lib/prefs'
import { AgentIcon } from './AgentIcon'
import {
  cacheUrgency,
  countdown,
  age,
  percent,
  quotaUrgency,
  tokens
} from '../lib/format'

/**
 * Context-fill fraction for sessions with no cache clock.
 *
 * ⛔ Stream-metered adapters (Antigravity) set `contextTokens` from each turn's usage but never set
 * `lastRequestStartedAt`, so `cacheRemaining()` always returns null and the bar stays empty even
 * when 671k/1.0M is visible in text. For these sessions the only fill signal is the window level,
 * which is what `contextFill` returns — null when either operand is absent or zero so the bar is
 * not drawn as full when it is actually unmeasured.
 */
function contextFill(session: Pick<Session, 'contextTokens' | 'contextWindow'>): number | null {
  const { contextTokens: ctx, contextWindow: win } = session
  if (!ctx || !win) return null
  return Math.max(0, Math.min(1, ctx / win))
}

/**
 * What the operator currently holds in their head, made visible: how much of each account's window
 * is spent, when it resets, and how long each live session's prompt cache has left.
 *
 * ⚠️ The staleness treatment is the point of this component, not a detail — but *marked* is not the
 * same as *hidden*, and this drew the distinction in the wrong place until 2026-08-28. A reading
 * past `STALE_AFTER_MS` (15 minutes) was replaced by the words `quota unknown`, so every account
 * read as unmeasured for the first minutes after a launch, and an account nobody had probed in a day
 * looked identical to one that had never been probed at all. Those are different states and the
 * operator acts on them differently.
 *
 * ⛔ The invariant that actually matters is unchanged and does not live here: **nothing downstream
 * may consume a stale percentage.** `reserveState` refuses one, and a gate satisfied by a stale
 * number is what strands context (`docs/cost-model.md` §5). A person reading a number that says
 * *stale* beside it is not a gate. So the last known reading is shown, labelled, and dimmed.
 */
export function FleetStrip({ fleet, now }: { fleet: FleetEntry[]; now: number }): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(readFleetCollapsed)

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      writeFleetCollapsed(next)
      return next
    })
  }

  const activeFleet = fleet.filter((entry) => entry.worker.enabled)

  return (
    <div className={`fleet-wrap${collapsed ? ' fleet-wrap--collapsed' : ''}`}>
      <div className="fleet">
        <span className="fleet-label">Fleet</span>
        {activeFleet.length === 0 ? (
          <span className="fleet-empty">
            {fleet.length === 0 ? 'no workers configured' : 'no active workers'}
          </span>
        ) : (
          <div className="fleet-cards">
            {activeFleet.map((entry) => (
              <WorkerCard key={entry.worker.id} entry={entry} now={now} />
            ))}
          </div>
        )}
      </div>
      <div className="fleet-toggle-bar">
        <button
          type="button"
          className="fleet-toggle-btn"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show fleet strip' : 'Hide fleet strip'}
          title={collapsed ? 'Show fleet strip' : 'Hide fleet strip'}
        >
          <span>{collapsed ? 'Show fleet' : 'Hide'}</span>
          <svg
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {collapsed ? <path d="M3 6 L8 11 L13 6" /> : <path d="M3 10 L8 5 L13 10" />}
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * One session, drawn as a gauge so it reads against the account's windows above it.
 *
 * The bar shows context window fill (contextTokens/contextWindow) with quota-urgency coloring.
 * For sessions with a cache clock (PTY sessions), the countdown in the rightmost column shows
 * prompt cache TTL remaining. For sessions without a cache clock (stream sessions), the countdown
 * column is blank.
 *
 * Active sessions lead; warmed-up idle/closed sessions are displayed with a slight dimming.
 */
function SessionGauge({ session, now }: { session: Session; now: number }): React.JSX.Element {
  const ctx = session.contextTokens
  const win = session.contextWindow
  const hasCacheClock = session.cacheExpiresAt !== null
  const fill = contextFill(session)
  const cacheUrgencyClass = cacheUrgency(session.cacheExpiresAt, now)
  const ctxUrgencyClass = ctx && win ? quotaUrgency((ctx / win) * 100) : 'ok'
  const fillClass = `bar-fill--${ctxUrgencyClass}`
  const isIdle = session.state === 'closed' || session.state === 'idle'

  if (!ctx) {
    return (
      <div
        className={`gauge gauge--session gauge--waiting${isIdle ? ' gauge--idle' : ''}`}
        title={`session ${session.id}\n${isIdle ? 'idle' : session.purpose} · ${session.transport} transport\n${session.cwd}`}
      >
        <span className="gauge-label">{isIdle ? 'idle' : session.purpose}</span>
        <span className="wcard-agenote">
          {session.purpose === 'probe' ? 'reading the window…' : isIdle ? 'idle' : 'starting…'}
        </span>
      </div>
    )
  }

  return (
    <div
      className={`gauge gauge--session${isIdle ? ' gauge--idle' : ''}`}
      title={
        `session ${session.id}\n${isIdle ? 'idle (warmed up)' : session.purpose} · ${session.transport} transport\n${session.cwd}\n` +
        (hasCacheClock
          ? 'the bar shows how much of the context window is used (ctx/win)\n' +
            'the clock is what is left of this session\u2019s prompt cache TTL\n' +
            'ctx is how full the window is now \u2014 a level, not a total, and not a task\u2019s token count'
          : 'the bar shows how much of the context window is used (no cache clock on this adapter)\n' +
            'ctx is how full the window is now \u2014 a level, not a total, and not a task\u2019s token count')
      }
    >
      <span className="gauge-label">{isIdle ? 'idle' : session.purpose}</span>
      <span className="bar">
        {fill !== null && (
          <span
            className={`bar-fill ${fillClass}`}
            style={{ width: `${Math.max(2, fill * 100)}%` }}
          />
        )}
      </span>
      {/* ⚠️ No `no turn yet` fallback here any more — a session without one never reaches this. */}
      <span className="num gauge-value">
        {tokens(ctx)}
        {win ? `/${tokens(win)}` : ''}
      </span>
      <span className={`num gauge-reset gauge-reset--${hasCacheClock ? cacheUrgencyClass : ctxUrgencyClass}`}>
        {hasCacheClock ? countdown(session.cacheExpiresAt, now) : ''}
      </span>
    </div>
  )
}

function WorkerCard({ entry, now }: { entry: FleetEntry; now: number }): React.JSX.Element {
  const { worker, quota, sessions } = entry
  const stale = quota?.stale ?? true
  const windows = quota?.windows ?? []
  const suspect = worker.health?.state === 'suspect' ? worker.health : null

  const maxDisplay = 3
  const displayedSessions = sessions.slice(0, maxDisplay)
  const overflowCount = sessions.length - displayedSessions.length

  return (
    <div className={`wcard${worker.enabled ? '' : ' wcard--off'}`}>
      <div className="wcard-head">
        <AgentIcon adapterId={worker.adapterId} className="wcard-icon" />
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

      {/* ⛔ The *fact* outranks the quota gauges and still leads — burying it is how this fleet spent
          an afternoon routing work to a worker that could not take it. What no longer leads is the
          raw text. ⚠️ A CLI's failure is a paragraph of escape codes and vendor prose; four cards
          wide it pushed the numbers off the strip and was unreadable anyway. The tag above says
          which kind, this says there is a reason, and the reason itself is one hover or one click
          away in Settings > Workers, which is where the operator has to go to act on it. */}
      {suspect && (
        <div className="wcard-suspect" title={`${suspect.reason}\n\nSettings > Workers has the rest.`}>
          <span className="dot dot--bad" />
          error · see Settings &gt; Workers
        </div>
      )}

      {windows.length === 0 ? (
        !suspect && (
          <div className="wcard-unknown">
            <span className="dot dot--down" />
            quota unknown
          </div>
        )
      ) : (
        <>
          {/* ⚠️ Dimmed as a whole, so the numbers read as *last known* rather than as current. The
              note carries the age, because "stale" alone does not tell you whether to wait for the
              next probe or go and press one. */}
          <div className={stale ? 'wcard-windows wcard-windows--stale' : 'wcard-windows'}>
            {windows.map((w) => (
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
            ))}
          </div>
          {stale && (
            <div
              className={quota?.error ? 'wcard-stale wcard-stale--failing' : 'wcard-stale'}
              title={
                quota?.error
                  ? 'Every check since has failed, so this is the last reading that worked and ' +
                    `the newest attempt did not: ${quota.error}`
                  : 'Older than fifteen minutes, so nothing the scheduler gates on will use it — ' +
                    'but old is not wrong. The CLI rewrites its usage cache when it does work, so ' +
                    'an idle account keeps its last number and its window is not moving either. A ' +
                    'fresh one is taken when a task is about to run here, or when you press Probe.'
              }
            >
              {/* ⛔ Two states, one used to be printed for both. Old because nobody has used this
                  account is ordinary and reads as a plain age; old because every check since has
                  failed is a fault and keeps the dot and the colour. Printing `stale` for both sent
                  the operator to Probe accounts that were fine. */}
              {quota?.error && <span className="dot dot--down" />}
              read {age(quota?.ageMs ?? 0)}
              {quota?.error && <span className="wcard-agenote"> · last check failed</span>}
            </div>
          )}
        </>
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
          {displayedSessions.map((s) => (
            <SessionGauge key={s.id} session={s} now={now} />
          ))}
          {overflowCount > 0 && (
            <div
              className="wcard-more-sessions"
              title={`${overflowCount} more active/idle conversation(s) on this worker`}
            >
              +{overflowCount} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}
