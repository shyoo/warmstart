import { useState } from 'react'
import type { Session } from '@shared/protocol'
import { isWorkerSubscriptionExpired, quotaFreshness } from '@shared/tasks'
import type { FleetEntry } from '../lib/daemon'
import {
  readFleetCollapsed,
  readFleetDensity,
  writeFleetCollapsed,
  writeFleetDensity,
  type FleetDensity
} from '../lib/prefs'
import { cardStatus, gaugedSessions, shortWindowLabels } from '../lib/fleetcard'
import { Working } from '../lib/taskview'
import { AgentIcon } from './AgentIcon'
import { cacheUrgency, countdown, percent, quotaUrgency, tokens } from '../lib/format'

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
 *
 * ⚠️ Where the label goes is its own constraint, and `fleetcard.ts` holds it: the age lives in the
 * corner of the head row, never in a row of its own, because a card that grows a line the minute a
 * reading turns fifteen minutes old and loses it again on the next probe moves the whole strip
 * while the operator is reading it.
 */
export function FleetStrip({
  fleet,
  now,
  onProbe
}: {
  fleet: FleetEntry[]
  now: number
  /** Re-read one account’s usage window. Resolves when the reading has landed. */
  onProbe: (workerId: string) => Promise<unknown>
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(readFleetCollapsed)
  const [density, setDensity] = useState(readFleetDensity)
  const narrow = density === 'narrow'

  const toggleDensity = () => {
    setDensity((d) => {
      const next: FleetDensity = d === 'narrow' ? 'wide' : 'narrow'
      writeFleetDensity(next)
      return next
    })
  }

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
        <div className="fleet-rail">
          <span className="fleet-label">Fleet</span>
          {/* This changes the density of the cards; Hide remains the control below the strip. */}
          <button
            type="button"
            className="fleet-density-btn"
            onClick={toggleDensity}
            aria-pressed={narrow}
            title={
              narrow
                ? 'Show each gauge with its name again'
                : 'Condense every card to bars and numbers, so more of the fleet fits on the strip'
            }
          >
            {narrow ? 'Wide' : 'Narrow'}
          </button>
        </div>
        <div className="fleet-content">
          {activeFleet.length === 0 ? (
            <span className="fleet-empty">
              {fleet.length === 0 ? 'no workers configured' : 'no active workers'}
            </span>
          ) : (
            <div className="fleet-cards">
              {activeFleet.map((entry) => (
                <WorkerCard
                  key={entry.worker.id}
                  entry={entry}
                  now={now}
                  narrow={narrow}
                  onProbe={onProbe}
                />
              ))}
            </div>
          )}
        </div>
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
 *
 * ⛔ Only sessions with a reading reach this - `gaugedSessions` holds back the ones with no turn
 * yet, and the card's corner says one is starting. A row of the same shape carrying the word
 * `starting…` instead of a number appeared and vanished on its own and resized the whole strip.
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
  // ⚠️ Display only — `session.purpose` stays `'work'` on the wire. "Work" read as a chore label
  // beside "idle"; the state this session is actually in is that it's doing something.
  const purposeLabel = session.purpose === 'work' ? 'active' : session.purpose

  return (
    <div
      className={`gauge gauge--session${isIdle ? ' gauge--idle' : ''}`}
      title={
        `session ${session.id}\n${isIdle ? 'idle (warmed up)' : purposeLabel} · ${session.transport} transport\n${session.cwd}\n` +
        (hasCacheClock
          ? 'the bar shows how much of the context window is used (ctx/win)\n' +
            'the clock is what is left of this session\u2019s prompt cache TTL\n' +
            'ctx is how full the window is now \u2014 a level, not a total, and not a task\u2019s token count'
          : 'the bar shows how much of the context window is used (no cache clock on this adapter)\n' +
            'ctx is how full the window is now \u2014 a level, not a total, and not a task\u2019s token count')
      }
    >
      <span className="gauge-label">{isIdle ? 'idle' : purposeLabel}</span>
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

/**
 * The manual probe, drawn rather than typed.
 *
 * ⛔ An SVG in the same idiom as the collapse chevron above — `stroke="currentColor"`, no fill,
 * round caps — so it inherits the corner’s faint colour and dims with the card. The emoji this
 * replaces (🔃) carries its own colour, which no theme can turn down: on the dark surface it was the
 * brightest thing on a strip whose entire job is to make *numbers* the brightest thing on it.
 */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* An open circle, so the arrowhead has somewhere to sit. */}
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2v3h-3" />
    </svg>
  )
}

/**
 * ⭐ `narrow` is a single class and nothing else — every difference it makes is in the stylesheet.
 * That is deliberate: condensing removes *naming*, never measurement, so there is no second set of
 * rows to render and no second layout to keep in step with this one. Both densities draw the same
 * DOM, which is also what keeps the card-height rule below true in both.
 *
 * ⚠️ Which is why the probe button below stays in both densities. It is not naming — it is the one
 * control on this card, and a condensed strip is exactly where an operator is most likely to spot a
 * reading that has gone stale and want a fresh one.
 */
function WorkerCard({
  entry,
  now,
  narrow,
  onProbe
}: {
  entry: FleetEntry
  now: number
  narrow: boolean
  onProbe: (workerId: string) => Promise<unknown>
}): React.JSX.Element {
  const { worker, quota, sessions } = entry
  /**
   * ⛔ Recomputed against the ticking clock, not read off the payload. `ageMs` and `stale` are
   * stamped on when the daemon *sends* a reading, so a card patched by a `quota.changed` event kept
   * saying "read 2m ago" for as long as nothing else arrived — and a reading that was fresh when it
   * landed never went stale on screen at all. That is the half of t86 the operator can see: the
   * other half was readings that were never sent (see `storeAndPublish`).
   */
  const { stale } = quotaFreshness(quota, now)
  const windows = quota?.windows ?? []
  /**
   * ⚠️ The pool name comes off the rows when the rows are still telling apart without it, and the
   * label column narrows to match. On a one-pool account every row began with the card's own title
   * — `Muse 5h` under a card headed *Muse* — and a column sized for Antigravity's two-pool
   * `Claude/GPT 5h` then held that repetition in whitespace taken from the bar beside it. The full
   * label is still on the row's tooltip, and Antigravity keeps it on the row.
   */
  const shortLabels = shortWindowLabels(windows.map((w) => w.label))
  const suspect = worker.health?.state === 'suspect' ? worker.health : null
  const subscriptionExpired =
    isWorkerSubscriptionExpired(worker) ||
    /subscription.*expired|disabled claude subscription access/i.test(quota?.error ?? '')

  const maxDisplay = 3
  const gauged = gaugedSessions(sessions)
  const displayedSessions = gauged.slice(0, maxDisplay)
  const overflowCount = gauged.length - displayedSessions.length
  const status = cardStatus(entry, now, sessions)

  /**
   * ⚠️ In-flight, held here rather than read off the corner. The corner turns to `probing` from a
   * *session*, which the daemon only publishes once the probe has actually started — a second and a
   * third click fit comfortably in that gap, and each one spends a real CLI invocation.
   */
  const [probing, setProbing] = useState(false)
  const probe = (): void => {
    if (probing) return
    setProbing(true)
    // ⛔ The reading arrives as a `quota.changed` event, so there is nothing to do with the result
    // here, and nothing to catch: `worker.probe` resolves with a failure *inside* its payload, and
    // the corner is what says so once the daemon has recorded it.
    void onProbe(worker.id).finally(() => setProbing(false))
  }

  const isSubscriptionExpired = isWorkerSubscriptionExpired(worker)

  return (
    <div className={`wcard${worker.enabled ? '' : ' wcard--off'}${narrow ? ' wcard--narrow' : ''}`}>
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
            {isSubscriptionExpired ? 'expired' : suspect.needsReauth ? 'sign in' : 'no work'}
          </span>
        )}
        {/* ⛔ The corner, and the only place on this card where a *transient* fact is allowed to
            appear. The head row is drawn whatever happens, so the age of a reading and the fact
            that a probe is in flight cost nothing to say here and cannot resize the card the way
            they did as rows of their own. ⚠️ Right-aligned by `margin-left: auto`, so it stays in
            the corner however many tags precede it. */}
        {status && (
          <span
            className={`wcard-status${status.kind === 'age' && status.failing ? ' wcard-status--failing' : ''}`}
            title={status.title}
            aria-label={status.label}
          >
            {status.kind === 'pending' ? (
              <Working />
            ) : (
              <>
                {status.failing && <span className="dot dot--down" />}
                <span className="num">{status.label}</span>
              </>
            )}
          </span>
        )}
        {/* ⛔ Drawn whether or not there is a status beside it, and never conditionally mounted: a
            button that appeared only once a card went stale would add and remove itself from the
            head row on a fifteen-minute timer, which is the strip-moving bug the corner exists to
            avoid. */}
        <button
          type="button"
          className="wcard-refresh"
          onClick={probe}
          disabled={probing}
          aria-label={`Refresh usage for ${worker.label}`}
          title="Read this account’s usage window now"
        >
          <RefreshIcon />
        </button>
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

      {subscriptionExpired ? (
        <div className="wcard-unknown wcard-unknown--expired">
          <span className="dot dot--bad" />
          Subscription expired
        </div>
      ) : windows.length === 0 ? (
        !suspect && (
          <div className="wcard-unknown">
            {worker.adapterId === 'local-llm' ? (
              worker.identity?.loggedIn === true && !quota?.error ? (
                <>
                  <span className="dot dot--ok" />
                  endpoint alive
                </>
              ) : worker.identity?.loggedIn === false || quota?.error ? (
                <>
                  <span className="dot dot--down" />
                  endpoint offline
                </>
              ) : (
                <>
                  <span className="dot dot--down" />
                  endpoint unprobed
                </>
              )
            ) : (
              <>
                <span className="dot dot--down" />
                quota unknown
              </>
            )}
          </div>
        )
      ) : (
        /* ⚠️ Dimmed as a whole, so the numbers read as *last known* rather than as current. The age
           itself is in the corner of the head row, because "stale" alone does not tell you whether
           to wait for the next probe or go and press one - and because a line that appears under
           these bars the minute a reading turns fifteen minutes old resizes every card in the strip
           on a timer. */
        <div
          className={`wcard-windows${stale ? ' wcard-windows--stale' : ''}${shortLabels ? ' wcard-windows--terse' : ''}`}
        >
          {windows.map((w, i) => (
            <div className="gauge" key={w.id} title={w.label}>
              <span className="gauge-label">{shortLabels ? shortLabels[i] : w.label}</span>
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
      )}

      {/* ⛔ The rule is load-bearing, not decoration. Everything above it is the **account**: one
          quota, shared by every session on it, and it survives the session ending. Everything below
          is **one live session**: its own context, its own cache clock, gone when it closes. Four
          gauges of identical shape with nothing between them read as four measurements of one
          thing, and they are not — that is the confusion this line exists to end. */}
      {displayedSessions.length > 0 && (
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
              title={`${overflowCount} more measured conversation(s) on this worker`}
            >
              +{overflowCount} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}
