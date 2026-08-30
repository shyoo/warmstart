import type { ClockDecision, Objective } from '@shared/tasks.js'
import type { Session, Settings } from '@shared/protocol.js'
import { db } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import { clearClockMove, closeSession, listSessions, markClockMove, sendPrompt } from './sessions.js'
import { getTask, listTasks, runForSession, setTaskHandoff } from './tasks.js'
import { reserveState } from './reserve.js'
import { policy } from './objective.js'
import { settings as fleetSettings } from './settings.js'
import { log } from './log.js'

/**
 * The cache clock.
 *
 * A warm prompt cache is an **asset with an expiry date**. Left alone it lapses, and rebuilding it
 * costs `2.0·C` against the `0.1·C` a read costs. The single most consequential fact in
 * `docs/cost-model.md`: **a cache read refreshes the TTL for free** - so a session that is *used*
 * never pays a rebuild, and a trivial turn buys another whole hour for `0.1·C`.
 *
 * Six moves, evaluated in order, just before the cache lapses:
 *
 * ```
 * 1. queued work scores well against this session  -> DISPATCH   an expiring asset becomes work at 0.1x
 * 2. awaiting_human, reply expected within ~2h     -> KEEPALIVE
 * 3. expected idle in ~1h..2h                      -> KEEPALIVE
 * 4. idle > ~2h, ctx > 60k, since_compact > 25k    -> COMPACT
 * 5. the compaction reserve is at risk             -> COMPACT NOW, regardless
 * 6. otherwise                                     -> let it expire; if it holds work, HANDOFF first
 * ```
 *
 * Moves 2 and 3 exist only because reads refresh the TTL; move 1 exists only because there is a queue
 * to pull from. Between them they are the largest saving this tool offers over running a
 * pre-compaction watchdog next to manually driven windows.
 */

/**
 * The decision window. Compaction takes ~2 minutes and has been measured at 2.7 - so the last
 * moment a compaction still fits inside the hour is around T+53m, not T+58m.
 */
export const DECIDE_BEFORE_EXPIRY_MS = 15 * 60 * 1000
export const LAST_CHANCE_MS = 7 * 60 * 1000

/**
 * How long a move is given to land before the clock will consider it again.
 *
 * ⛔ This is the fix for a real loop, not a defensive guess. The clock ticks every 10s (TICK_MS) and
 * `decide()` reads nothing but the session row, so a move whose effect takes minutes to appear is a
 * move that gets re-issued every tick until it does. Measured on this machine 2026-08-26: session
 * c17ce7, 68001 context tokens, sent `/compact` thirteen times in two minutes with an identical
 * reason each time.
 *
 * ⚠️ Compaction has been measured at 139k · 116k · 161k ms and the spread matters more than the
 * mean, so this sits well past the slowest sample rather than near the average. A keepalive is one
 * short turn and settles far sooner.
 */
export const COMPACT_SETTLE_MS = 4 * 60 * 1000
export const KEEPALIVE_SETTLE_MS = 90 * 1000

/**
 * How many times a move is re-issued before the clock stops believing in it.
 *
 * ⚠️ Two, not one: a single failure can be a dropped keystroke on a PTY. A third attempt would be
 * the clock insisting against evidence, which is the behaviour being fixed. ⛔ Whether `/compact` is
 * honoured as a user message on the `stream` transport is **unverified** - HANDOFF R6 - and this is
 * what makes that uncertainty survivable: if it is not, the session gives up after two attempts and
 * falls back to handoff-and-close instead of spending forever.
 */
export const MAX_MOVE_ATTEMPTS = 2

const KEEPALIVE_PROMPT =
  'Reply with the single word: ok. Do not use any tools, do not read any files, and do not start ' +
  'any work. This message exists only to keep this session warm.'

const WRAP_UP_PROMPT =
  'Before this session ends: call the `handoff` tool with a short note saying what you were ' +
  'doing, what is done, and what the next step is. Commit anything that compiles first.'

/** Human latency straddles the one-hour TTL almost perfectly, so it is worth measuring rather than assuming. */
const DEFAULT_HUMAN_LATENCY_MS = 45 * 60 * 1000

export function medianHumanLatencyMs(): number {
  const row = db()
    .prepare(
      `select answered_at - asked_at as latency
         from approvals
        where answered_by = 'human' and answered_at is not null
        order by latency
        limit 1
       offset (select count(*) / 2 from approvals where answered_by = 'human' and answered_at is not null)`
    )
    .get() as { latency: number } | undefined
  return row?.latency && row.latency > 0 ? row.latency : DEFAULT_HUMAN_LATENCY_MS
}

/**
 * How long before this session is likely to be wanted again.
 *
 * ⚠️ Everything downstream is only as good as this, and it cannot be made much better without real
 * queue history - so it is deliberately coarse and deliberately *stated*, rather than a confident
 * number nobody can audit. It improves as `runs` and `approvals` accumulate.
 */
export function expectedIdleMs(session: Session, now = Date.now()): { ms: number; because: string } {
  const run = runForSession(session.id)
  const task = run?.taskId ? getTask(run.taskId) : null

  if (task?.status === 'awaiting_human') {
    const median = medianHumanLatencyMs()
    return { ms: median, because: `waiting on a person (median reply ${Math.round(median / 60000)}m)` }
  }

  const tasks = listTasks()
  const ready = tasks.filter((t) => t.status === 'ready')
  if (ready.length > 0) {
    // Work is queued now; whether it lands on *this* session is the scheduler's call, but the session
    // is plainly wanted soon either way.
    return { ms: 0, because: `${ready.length} task(s) ready now` }
  }

  const upcoming = tasks
    .filter((t) => t.status === 'scheduled' && t.notBefore && t.notBefore > now)
    .map((t) => (t.notBefore ?? 0) - now)
    .sort((a, b) => a - b)
  if (upcoming[0] !== undefined) {
    return { ms: upcoming[0], because: `next scheduled task in ${Math.round(upcoming[0] / 60000)}m` }
  }

  const blocked = tasks.filter((t) => t.status === 'blocked' || t.status === 'running')
  if (blocked.length > 0) {
    // Something is in flight and may unblock work. Two hours is the measured break-even, so this
    // deliberately sits on it rather than inventing precision.
    return { ms: 2 * 60 * 60 * 1000, because: `${blocked.length} task(s) in flight may unblock work` }
  }

  return { ms: Number.POSITIVE_INFINITY, because: 'nothing queued' }
}

export interface ClockContext {
  objective: Objective
  /** A session the scheduler has already decided to send work to. Move 1, without re-deriving it. */
  dispatchTargets?: Set<string>
  now?: number
  /** Fleet switches. Read once per tick and passed in, so one tick cannot disagree with itself. */
  settings?: Settings
}

/**
 * What became of the move the clock last asked for on this session.
 *
 * ⛔ "It landed" is answered with evidence specific to the move, never with "a turn happened". An
 * agent that replies *"I don't understand /compact"* has produced a perfectly good turn and
 * compacted nothing, and on the `stream` transport that is a live possibility rather than a
 * hypothetical - HANDOFF R6 has never been run.
 *
 *  - `compact`   landed when `tokensSinceCompact` has fallen below what it was when we asked.
 *                `recordCompaction()` zeroes it on a real `compact_boundary` record.
 *  - `keepalive` landed when the TTL moved: that is the entire point of the move, and a cache read
 *                refreshes it.
 */
type MoveOutcome = 'none' | 'in_flight' | 'landed' | 'ignored'

export function moveOutcome(session: Session, now: number): MoveOutcome {
  const { clockMove: move, clockMoveAt: at } = session
  if (!move || !at) return 'none'

  const landed =
    move === 'compact'
      ? session.tokensSinceCompact < (session.clockMoveContext ?? Number.POSITIVE_INFINITY)
      : (session.lastRequestStartedAt ?? 0) > at
  if (landed) return 'landed'

  const settle = move === 'compact' ? COMPACT_SETTLE_MS : KEEPALIVE_SETTLE_MS
  return now - at < settle ? 'in_flight' : 'ignored'
}

export function decide(session: Session, ctx: ClockContext): ClockDecision {
  const now = ctx.now ?? Date.now()
  const model = costModel(adapter(session.adapterId).info.policy.costModelId)
  const caps = adapter(session.adapterId).info.capabilities
  const cost = policy(ctx.objective)
  const expiry = session.cacheExpiresAt
  const contextTokens = session.contextTokens ?? 0

  const base = {
    sessionId: session.id,
    contextTokens: session.contextTokens,
    expiresAt: expiry
  }
  const nothing = (reason: string): ClockDecision => ({
    ...base,
    move: 'none',
    reason,
    expectedIdleMs: null,
    estimatedCost: null
  })

  if (!expiry) return nothing('no cached prefix yet - nothing to preserve')

  // ⛔ Before anything else: has the clock already asked this session to do something, and is that
  // request still outstanding? Every move below spends tokens, and `decide()` has no memory of its
  // own - so this is the only thing standing between a 10s tick and a move re-issued twelve times
  // before the first one could land. It is checked ahead of the reserve because a reserve breach
  // does not make a second simultaneous compaction any more useful than the first.
  const outcome = moveOutcome(session, now)
  if (outcome === 'in_flight') {
    const waited = Math.round((now - (session.clockMoveAt ?? now)) / 1000)
    return nothing(
      `${session.clockMove} was requested ${waited}s ago and has not landed yet - ` +
        'waiting for it rather than asking twice'
    )
  }
  if (outcome === 'ignored' && session.clockMoveAttempts >= MAX_MOVE_ATTEMPTS) {
    // ⛔ The clock stops insisting. Whatever it asked for is demonstrably not happening on this
    // session, and the honest move is the one that always works: get the context out and let the
    // prefix go. Saying so in words matters - "compaction is not reaching this session" is what
    // closes HANDOFF R6 the day somebody reads it.
    return {
      ...base,
      move: 'handoff_close',
      reason:
        `${session.clockMove} was asked for ${session.clockMoveAttempts} times and never landed - ` +
        'this session is not honouring it, so taking a handoff and releasing it instead',
      expectedIdleMs: null,
      estimatedCost: model.costOfKeepalive(session) ?? 0
    }
  }

  // ⚠️ Off means off, including here. A global switch that quietly kept compacting "just for
  // safety" would be a lie told by the one screen whose whole claim is that it shows what the
  // scheduler really does. `compactAllowed` therefore gates move 5 as well as move 4 - and a
  // provider that *cannot* compact and a fleet that has been *told not to* end in the same place,
  // which is the fallback that already existed for the first case.
  const compactAllowed = caps.manualCompact && (ctx.settings?.autoCompact ?? true)
  const compactOff = caps.manualCompact && !(ctx.settings?.autoCompact ?? true)

  // Move 5 first: a reserve breach is not a preference, and it does not wait for the clock.
  const reserve = reserveState(session.workerId)
  if (reserve.verdict === 'at_risk' && contextTokens > 0) {
    const compactCost = compactAllowed ? model.costOfCompact(session) : null
    if (compactCost !== null) {
      return {
        ...base,
        move: 'compact',
        reason: `compaction reserve at risk - ${reserve.reason}`,
        expectedIdleMs: null,
        estimatedCost: Math.round(compactCost)
      }
    }
    // ⛔ M5 found this hole. A provider with no compaction used to fall straight through here and do
    // *nothing* while its reserve was breached - the one situation the reserve exists to catch. The
    // move that is always available is to get the work out before the context is stranded.
    return {
      ...base,
      move: 'handoff_close',
      reason:
        (compactOff
          ? `compaction reserve at risk and automatic compaction is switched off - ${reserve.reason}.`
          : `compaction reserve at risk and this provider cannot compact - ${reserve.reason}.`) +
        ' Taking a handoff and releasing the session instead.',
      expectedIdleMs: null,
      estimatedCost: model.costOfKeepalive(session) ?? 0
    }
  }

  // ⛔ Everything below trades tokens for a warmer cache, which requires knowing what a cache costs.
  // Where the provider does not price one - Google bills storage per token-hour, OpenAI caches
  // server-side with no client-controlled TTL - there is no lever to pull, and acting on an invented
  // number would be worse than not acting. Work, preemption and handoffs are unaffected.
  if (!model.canPriceCache()) {
    return nothing(
      `${model.provider} does not expose a priced, steerable cache, so there is nothing to buy here`
    )
  }

  const untilExpiry = expiry - now
  if (untilExpiry > DECIDE_BEFORE_EXPIRY_MS) {
    return nothing(`${Math.round(untilExpiry / 60000)}m of TTL left - nothing to decide yet`)
  }
  if (untilExpiry <= 0) return nothing('the prefix has already lapsed')

  // Move 1. An expiring asset turned into work is the cheapest outcome available.
  if (ctx.dispatchTargets?.has(session.id)) {
    return {
      ...base,
      move: 'dispatch',
      reason: 'queued work scored well against this session',
      expectedIdleMs: 0,
      estimatedCost: Math.round(model.costOfKeepalive(session) ?? 0)
    }
  }

  const idle = expectedIdleMs(session, now)
  // Non-null past the canPriceCache() gate above; compaction can still be absent on its own.
  const keepaliveCost = Math.round(model.costOfKeepalive(session) ?? 0)
  const compactable = model.costOfCompact(session)
  const compactCost = compactable === null ? null : Math.round(compactable)

  // ⚠️ Spending to hold a cache open on an account whose remaining budget is unknown is a gamble.
  // Whether it is one worth taking is a property of the objective, not a fixed rule.
  const mayKeepalive = reserve.verdict !== 'unknown' || cost.keepaliveWhenQuotaUnknown

  // Moves 2 and 3.
  if (idle.ms >= cost.keepaliveFloorMs && idle.ms <= cost.compactThresholdMs) {
    if (mayKeepalive) {
      return {
        ...base,
        move: 'keepalive',
        reason: `${idle.because} - one read refreshes the TTL for ${keepaliveCost} tokens`,
        expectedIdleMs: idle.ms,
        estimatedCost: keepaliveCost
      }
    }
    return nothing(
      `would keepalive (${idle.because}) but this worker's remaining budget is unknown, ` +
        'and the objective declines that gamble'
    )
  }

  // Move 4.
  const worthCompacting =
    compactCost !== null &&
    contextTokens > model.compaction.breakeven_context_tokens &&
    session.tokensSinceCompact > model.compaction.min_tokens_since_compact
  if (idle.ms > cost.compactThresholdMs && worthCompacting && compactAllowed) {
    return {
      ...base,
      move: 'compact',
      reason:
        `${idle.because} - past the ~2h break-even, and ${contextTokens} tokens of context is ` +
        `worth ${compactCost} to shrink`,
      expectedIdleMs: idle.ms,
      estimatedCost: compactCost
    }
  }
  // ⚠️ Said out loud rather than falling through silently. "It would have compacted, and did not,
  // because you turned that off" is the sentence that stops somebody debugging a growing context
  // for an hour - and it is only honest because the switch is the *only* reason.
  if (idle.ms > cost.compactThresholdMs && worthCompacting && compactOff) {
    return nothing(
      `would compact (${contextTokens} tokens, ${idle.because}) but automatic compaction is ` +
        'switched off'
    )
  }

  // Move 6.
  if (untilExpiry <= LAST_CHANCE_MS) {
    const run = runForSession(session.id)
    if (run?.taskId) {
      return {
        ...base,
        move: 'handoff_close',
        reason: `letting this lapse, but it holds a task - taking a handoff first (${idle.because})`,
        expectedIdleMs: idle.ms,
        estimatedCost: keepaliveCost
      }
    }
    return {
      ...base,
      move: 'let_expire',
      reason: `${idle.because} - both moves would be pure waste`,
      expectedIdleMs: idle.ms === Number.POSITIVE_INFINITY ? null : idle.ms,
      estimatedCost: 0
    }
  }

  return nothing(`${idle.because} - waiting for the last-chance window`)
}

// ---------------------------------------------------------------------------- execution

export interface ClockResult {
  decisions: ClockDecision[]
  acted: number
}

/**
 * Evaluate every live session and act.
 *
 * ⛔ Every decision is recorded, including the ones that did nothing. "Why is this session still
 * open?" and "why did that cost 30k?" have to be answerable months later from data rather than from
 * somebody's memory of what the rules were that week.
 */
export async function runCacheClock(ctx: ClockContext): Promise<ClockResult> {
  const decisions: ClockDecision[] = []
  let acted = 0

  // ⚠️ Read once per tick, not once per session. Two sessions in one sweep disagreeing about
  // whether compaction is on would be indefensible in the ledger they both write to.
  const withSettings: ClockContext = { ...ctx, settings: ctx.settings ?? fleetSettings() }

  for (const session of listSessions()) {
    if (session.state !== 'live' && session.state !== 'idle') continue
    // ⛔ A consult is a single turn that closes itself. Keeping one alive would pay to hold a cache
    // whose only possible reader has already gone. A `chat` session is the opposite case and is very
    // much the clock's business: it is warm precisely because a person is slow to reply.
    // ⛔ A probe belongs here too: it exists for fifteen seconds and holds no prefix worth paying
    // to keep alive.
    if (
      session.purpose === 'consult' ||
      session.purpose === 'login' ||
      session.purpose === 'probe'
    ) {
      continue
    }
    // A move that has landed is retired here rather than inside `decide()`, which stays a pure
    // function of the row it is handed - the property that makes it testable and the reason the
    // repeat had to be fixed with state rather than with a cleverer condition.
    const now = withSettings.now ?? Date.now()
    const outcome = moveOutcome(session, now)
    if (outcome === 'landed') {
      log.info(`${session.clockMove} landed on ${session.id.slice(0, 8)}`)
      clearClockMove(session.id)
    }

    const decision = decide(outcome === 'landed' ? { ...session, clockMove: null } : session, withSettings)
    decisions.push(decision)
    if (decision.move === 'none') continue

    record(decision)
    if (decision.move === 'dispatch' || decision.move === 'let_expire') continue

    try {
      await execute(session, decision)
      // ⛔ Written down *after* the send and only on success, because this is the record that stops
      // the next tick repeating it. A move that threw was never issued and must not be remembered
      // as though it were - that would be the mirror-image bug, a session that never gets its
      // compaction because a failed attempt is still counted as outstanding.
      if (decision.move === 'keepalive' || decision.move === 'compact') {
        markClockMove(session.id, decision.move, session.tokensSinceCompact)
      }
      acted++
    } catch (err) {
      log.warn(`cache clock could not ${decision.move} on ${session.id.slice(0, 8)}:`, err)
    }
  }

  return { decisions, acted }
}

async function execute(session: Session, decision: ClockDecision): Promise<void> {
  // ⛔ Every move below is a *prompt*, and a `streamPrompts: 'once'` session has no input left to
  // put one on once its turn has started - there is no warm prefix to refresh on a CLI that exits
  // after one turn. `sendPrompt` says so by throwing; the clock's job is to notice and move on, not
  // to take the tick down with it.
  try {
    await executeMove(session, decision)
  } catch (err) {
    log.warn(`clock move '${decision.move}' on ${session.id.slice(0, 8)} was refused:`, err)
  }
}

async function executeMove(session: Session, decision: ClockDecision): Promise<void> {
  switch (decision.move) {
    case 'keepalive':
      // The cheapest possible turn: a read of the whole prefix, which refreshes the TTL, plus a
      // one-word completion. ⛔ It must not invite tool use - that would turn 0.1·C into real work.
      sendPrompt(session.id, KEEPALIVE_PROMPT)
      log.info(
        `keepalive on ${session.id.slice(0, 8)}: ${decision.reason} (~${decision.estimatedCost} tokens)`
      )
      break

    case 'compact':
      // ⚠️ Sent as a user message on the session's own input channel. That `/compact` is honoured
      // this way on the stream transport is **inferred from the CLI's slash-command handling and not
      // yet measured** - see HANDOFF R6. If it turns out not to be, the fallback is handoff + close,
      // which is already implemented below.
      sendPrompt(session.id, '/compact')
      log.info(
        `compacting ${session.id.slice(0, 8)}: ${decision.reason} (~${decision.estimatedCost} tokens)`
      )
      break

    case 'handoff_close': {
      sendPrompt(session.id, WRAP_UP_PROMPT)
      // Give the wrap-up a turn to land before the prefix lapses; the handoff tool writes it.
      setTimeout(() => {
        const run = runForSession(session.id)
        if (run?.taskId) {
          const task = getTask(run.taskId)
          if (task && !task.handoffNote) {
            setTaskHandoff(
              run.taskId,
              'The session was closed when its prompt cache lapsed. No handoff was recorded.'
            )
          }
        }
        closeSession(session.id)
      }, 90_000)
      break
    }

    default:
      break
  }
}

function record(decision: ClockDecision): void {
  db()
    .prepare(
      `insert into clock_events (session_id, move, reason, context_tokens, expected_idle_ms,
                                 estimated_cost, ts)
       values (?,?,?,?,?,?,?)`
    )
    .run(
      decision.sessionId,
      decision.move,
      decision.reason,
      decision.contextTokens,
      decision.expectedIdleMs === null || !Number.isFinite(decision.expectedIdleMs)
        ? null
        : Math.round(decision.expectedIdleMs),
      decision.estimatedCost,
      Date.now()
    )
}
