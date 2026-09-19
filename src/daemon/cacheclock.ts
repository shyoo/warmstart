import { poolVerdict, resolveAutoCompact, windowsForPool, type ClockDecision, type Objective } from '@shared/tasks.js'
import type { Session, Settings, Worker } from '@shared/protocol.js'
import { db } from './db.js'
import { costModel } from './costmodel.js'
import { adapter } from './adapters/index.js'
import {
  clearClockMove,
  closeSession,
  hasOpenRun,
  listSessions,
  markClockMove,
  sendPrompt,
  spawnSession,
  warmClosedConversations,
  whyNoSession
} from './sessions.js'
import {
  addMessage,
  getTask,
  lastRunForSession,
  listTasks,
  quotaOverridden,
  runForSession,
  setTaskHandoff
} from './tasks.js'
import { noteCompactionAsked, onCompactionLanded } from './compaction.js'
import { getWorker, spendingCreditsOn } from './workers.js'
import { reserveState } from './reserve.js'
import { policy } from './objective.js'
import { settings as fleetSettings } from './settings.js'
import { accountRefusal } from './eligibility.js'
import { lastQuota, refusalRateLimit } from './quota.js'
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
 * 5b. a queued task wants to borrow it, and it is too full to lend  -> COMPACT NOW
 * 6. otherwise                                     -> let it expire; if it holds work, HANDOFF first
 * ```
 *
 * Moves 2 and 3 exist only because reads refresh the TTL; move 1 exists only because there is a queue
 * to pull from. Between them they are the largest saving this tool offers over running a
 * pre-compaction watchdog next to manually driven windows.
 *
 * And one move that acts on a session with **no process at all**, in a second pass:
 *
 * ```
 * 7. closed, prefix still warm, a task parked on a clock -> REVIVE, COMPACT, close it again
 * ```
 *
 * ⛔ Every move above needs a process to send a prompt to, so a conversation *between* two runs of a
 * task is one the loop can never reach - and it is precisely the conversation that sits still while
 * its hour of TTL runs out. Move 7 is that gap, and the reason it is worth a spawn is that a
 * compaction bought while the prefix is warm reads it at `0.1·C`, where the same compaction after it
 * lapses pays `~1.25·C` to rebuild it first. See `decideRevive`.
 */

/**
 * The decision window. Compaction takes ~2 minutes and has been measured at 2.7 - so the last
 * moment a compaction still fits inside the hour is around T+53m, not T+58m.
 *
 * ⚠️ These two are the **one-hour** values, kept as constants because that is what every existing
 * caller and test means by them. A provider with a shorter TTL gets them scaled: see
 * `decideBeforeExpiryMs`.
 */
export const DECIDE_BEFORE_EXPIRY_MS = 15 * 60 * 1000
export const LAST_CHANCE_MS = 7 * 60 * 1000

/**
 * The same two windows, as a fraction of whatever TTL the provider actually declares.
 *
 * ⛔ **A quarter of the TTL, not fifteen minutes.** Against OpenAI's 30-minute prefix a flat 15
 * minutes is *half the window*, so the clock would spend half of every codex conversation's life in
 * its decision phase — and `LAST_CHANCE_MS` at 7 minutes would sit almost on top of it, leaving
 * about thirty seconds between "start deciding" and "last chance". The ratios below are anchored so
 * that a 3,600,000ms TTL reproduces 15m and 7m exactly: Anthropic sees no change at all, and a
 * shorter provider gets windows in proportion to what it has.
 *
 * ⚠️ Scaling down is safe in a way scaling up would not be. These windows exist to leave room for a
 * move to *finish* before the prefix lapses, and the moves have real durations that do not shrink
 * with the TTL — a compaction still takes ~2 minutes. `REVIVE_COMPACT_FLOOR_MS` is the guard that
 * matters there and it stays absolute, so a window too small to fit a compaction declines to start
 * one rather than starting one it cannot finish.
 */
export function decideBeforeExpiryMs(ttlMs: number | null): number {
  return ttlMs === null ? DECIDE_BEFORE_EXPIRY_MS : ttlMs / 4
}

export function lastChanceMs(ttlMs: number | null): number {
  return ttlMs === null ? LAST_CHANCE_MS : (ttlMs * 7) / 60
}

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
export interface IdleEstimate {
  ms: number
  because: string
  /**
   * Whether this is a **measurement** or a placeholder.
   *
   * ⛔ **The distinction that made move 4 unreachable.** Four of the five branches below derive
   * `ms` from something real - a median over answered approvals, a queue that is non-empty right
   * now, a `not_before` somebody set, an empty fleet. The fifth derives it from nothing: "some other
   * task is in flight" says this session might be wanted and cannot say when. That branch returned
   * exactly the two-hour break-even, and `compactThresholdMs` is that same break-even plus an
   * objective adjustment - so on the shipped default (2.02h) the placeholder lost every comparison
   * it was ever in, and under `velocity` (2.38h) it lost by more. Compaction was reachable only
   * when the whole fleet was idle and `ms` was infinite. Measured 2026-08-31: `autoCompact` on
   * since 07:48Z, a session at 278k context, and the newest row in `clock_events` dated
   * 2026-08-27 - the last day nothing at all was running.
   *
   * ⚠️ Substituting the break-even for the estimate is a category error rather than a cautious
   * default. This function answers *when will this session be wanted*; answering it with *where the
   * decision flips* hands the entire decision to whichever way the comparison happens to be written.
   */
  confident: boolean
}

export function expectedIdleMs(session: Session, now = Date.now()): IdleEstimate {
  const run = runForSession(session.id)
  const task = run?.taskId ? getTask(run.taskId) : null

  if (run && !run.endedAt && task?.status === 'running') {
    return {
      ms: 0,
      because: 'this session is actively executing a run',
      confident: true
    }
  }

  if (task?.status === 'awaiting_human') {
    const median = medianHumanLatencyMs()
    return {
      ms: median,
      because: `waiting on a person (median reply ${Math.round(median / 60000)}m)`,
      confident: true
    }
  }

  const tasks = listTasks()
  // ⛔ **`ready` is eligibility, not availability, and reading it as availability suppressed the
  // whole clock.** A task the scheduler passes over every tick — every account at capacity, or over
  // the quota water mark — keeps the status `ready` and gains a `hold_until` saying when that could
  // change. Counting it as *work queued now* answers "when is this session wanted?" with zero, and
  // zero skips moves 2, 3 and 4 for every live session in the fleet.
  //
  // ⭐ Measured on t71, 2026-09-01T00:31Z: held at *"ClaudeThird at 92% of its Claude 5h window"*
  // against a window resetting **2h29m** later, and priced as imminent for the whole of it. The
  // correct reading is the opposite one — 2h29m is comfortably past the ~2h compaction break-even,
  // so a large context should be compacted precisely *because* nothing can run.
  //
  // ⚠️ `holdUntil` in the future only. A hold with no clock behind it (at capacity, a routing
  // question open) can end on the next tick and still counts as ready now.
  const heldUntil = (t: (typeof tasks)[number]): number | null =>
    t.holdUntil && t.holdUntil > now ? t.holdUntil : null

  const ready = tasks.filter((t) => t.status === 'ready' && heldUntil(t) === null)
  if (ready.length > 0) {
    // Work is queued now; whether it lands on *this* session is the scheduler's call, but the session
    // is plainly wanted soon either way.
    return { ms: 0, because: `${ready.length} task(s) ready now`, confident: true }
  }

  // ⛔ Three ways a task can be waiting on a clock, and all three are real queued work. Only the
  // first was counted: a task parked at `paused_quota` carries `not_before = resetsAt` and was
  // invisible here, so a fleet whose entire queue had been preempted by a closing window read as
  // *"nothing queued"* — the branch that returns infinity and lets every prefix lapse.
  const upcoming = tasks
    .map((t) => {
      if (t.status === 'scheduled' || t.status === 'paused_quota') {
        return t.notBefore && t.notBefore > now ? t.notBefore - now : null
      }
      if (t.status === 'ready') return heldUntil(t) === null ? null : (heldUntil(t) as number) - now
      return null
    })
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b)
  if (upcoming[0] !== undefined) {
    return {
      ms: upcoming[0],
      because: `next task can start in ${Math.round(upcoming[0] / 60000)}m`,
      confident: true
    }
  }

  const blocked = tasks.filter((t) => t.status === 'blocked' || t.status === 'running')
  if (blocked.length > 0) {
    // ⚠️ The placeholder. Kept at the break-even so the number still reads sensibly wherever it
    // is displayed, but flagged, because it is not an estimate of anything.
    return {
      ms: 2 * 60 * 60 * 1000,
      because: `${blocked.length} task(s) in flight may unblock work`,
      confident: false
    }
  }

  return { ms: Number.POSITIVE_INFINITY, because: 'nothing queued', confident: true }
}

export interface ClockContext {
  objective: Objective
  /** A session the scheduler has already decided to send work to. Move 1, without re-deriving it. */
  dispatchTargets?: Set<string>
  /**
   * Sessions a queued task in the same project would borrow, but for how full they are. Move 5b.
   *
   * ⛔ Handed in by the scheduler rather than derived here, for the same reason `dispatchTargets`
   * is: whether a conversation may be lent to a particular task is `sharing.ts`'s question, it
   * depends on leases and workspaces the clock does not track, and a second implementation of it
   * living here is a second answer waiting to disagree with the first.
   */
  borrowWanted?: Set<string>
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

  // ⚠️ `revive_compact` is a compaction with a process start in front of it, so it is judged by the
  // same evidence and given the same settle window plus the spawn — never by "a turn happened",
  // which a revived session produces just by opening.
  const compacting = move === 'compact' || move === 'revive_compact'
  const landed = compacting
    ? session.tokensSinceCompact < (session.clockMoveContext ?? Number.POSITIVE_INFINITY)
    : (session.lastRequestStartedAt ?? 0) > at
  if (landed) return 'landed'

  const settle = compacting ? COMPACT_SETTLE_MS : KEEPALIVE_SETTLE_MS
  return now - at < settle ? 'in_flight' : 'ignored'
}

/**
 * Is this context big enough, and grown enough since the last one, for a compaction to buy anything?
 *
 * ⛔ Both halves, and they catch different mistakes. Size alone would compact a long-lived session
 * that was compacted a moment ago; growth alone would compact a tiny one that had merely doubled.
 */
function worthCompactingNow(session: Session, model: ReturnType<typeof costModel>): boolean {
  return (
    (session.contextTokens ?? 0) > model.compaction.breakeven_context_tokens &&
    session.tokensSinceCompact > model.compaction.min_tokens_since_compact
  )
}

/**
 * May this conversation be compacted at all — the fleet switch, and the task's override of it.
 *
 * ⛔ **One function, because five call sites is five chances to disagree.** `settings.autoCompact` is
 * consulted by move 4, move 5 (reserve at risk), move 5b (too full to lend), move 7 (`decideRevive`)
 * and `compactOnResume`, and AGENTS.md already carries the rule those five exist to satisfy: *a
 * global switch is off everywhere or it is a lie*. A per-task override that reached only some of
 * them would be the same lie told the other way round — a control that appears to be on and mostly
 * is not. So the fleet switch is no longer read directly anywhere; every one of the five asks this.
 *
 * ⛔ **A permission, never an instruction.** `on` does not mean *compact*, it means *you may*. Every
 * other gate is untouched and still has to agree: `worthCompactingNow` (context past the break-even
 * and grown enough since the last one), the cache TTL window, the reserve, and a cost model that can
 * price the compaction. A task switched on gets its compaction scheduled at exactly the moment, and
 * on exactly the terms, the fleet switch would have scheduled it.
 *
 * ⛔ **Which task, when a conversation has held several.** The most recent run on the session, open
 * or ended — `lastRunForSession`. A borrowed conversation is being *used* by whoever is talking in
 * it now, and their preference is the live one; a conversation between runs belongs to the task that
 * will come back to it, which is that same last run. The alternative — the union or intersection of
 * every task that ever touched it — would make a task's own control depend on strangers, and
 * `sharing.ts` is already the place that decides who may be in a conversation together.
 *
 * ⚠️ The `source` comes back so the refusal can say *which* switch said no. "Automatic compaction is
 * switched off" sends somebody to Settings > Global; when it was this task's own override that
 * decided, that sentence is a wild goose chase.
 */
export function mayCompact(
  session: Session,
  fleetAutoCompact: boolean,
  /**
   * ⛔ **The credit stand-down, and it outranks every switch below it — but only for `'quota'`.**
   * ⚠️ Only ever true when the fleet switch *and* this worker's own vendor-reported credit status
   * agree — see `spendingCreditsOn`.
   */
  spendCreditsPastLimit = false,
  /**
   * ⛔ **Why this compaction was proposed, and the reason credits cannot simply switch compaction
   * off.** This app compacts for two unrelated ends through one gate. `'quota'` is the maintenance
   * kind — the reserve is at risk, or a warm prefix is being traded for a cheaper one — and it
   * exists to keep a conversation inside the window it is billed against. `'context'` is the
   * conversation's *own size*: a resumed session too large to carry cheaply, or one a queued task
   * cannot borrow until it shrinks. Nothing about buying credits makes a context window bigger.
   *
   * ⛔ So credits stand down `'quota'` only. Standing down both — which is what the first draft did
   * — reads as the simpler rule and buys a real failure: a long conversation on a credit-spending
   * account would lose the one intervention that keeps it under its own ceiling, and the next turn
   * fails outright rather than being wrapped up. The operator's call, 2026-09-07.
   */
  motive: CompactionMotive = 'quota'
): { allowed: boolean; source: CompactionSource } {
  if (motive === 'quota' && spendingCreditsOn(getWorker(session.workerId), spendCreditsPastLimit)) {
    return { allowed: false, source: 'credits' }
  }
  const run = lastRunForSession(session.id)
  const task = run?.taskId ? getTask(run.taskId) : null
  const { autoCompact, source } = resolveAutoCompact(task, fleetAutoCompact)
  return { allowed: autoCompact === 'on', source }
}

/** Which control said no. ⚠️ Carried so a refusal can name it — see `compactionOffBecause`. */
export type CompactionSource = 'task' | 'fleet' | 'credits'

/**
 * What a proposed compaction is *for*. See the `motive` parameter of `mayCompact`.
 *
 * ⚠️ Defaulted to `'quota'` at every caller that does not say, because that is the kind the credit
 * stand-down is about and defaulting the other way would silence it by omission.
 */
export type CompactionMotive = 'quota' | 'context'

/** The sentence a refusal uses, so the operator is sent to the control that actually said no. */
function compactionOffBecause(source: CompactionSource): string {
  if (source === 'task') return 'this task is set never to compact'
  if (source === 'credits') {
    return (
      'this worker is spending usage credits past its plan limit, so there is no window left to ' +
      'protect by compacting'
    )
  }
  return 'automatic compaction is switched off'
}

/**
 * How long a resumed conversation waits for its compaction before the prompt goes in regardless.
 *
 * ⚠️ The same window a clock-issued compaction gets to settle in, for the same reason: measured
 * compactions on this machine took 110s, 115s, 139s, 116s and 161s, and the spread matters more than
 * the mean. ⛔ It is a *bound*, not a delay — the boundary record wakes the prompt the instant it
 * arrives, and this only decides how long the run is willing to be held up by a `/compact` that may
 * never be honoured at all (HANDOFF R6).
 */
export const RESUME_COMPACT_WAIT_MS = COMPACT_SETTLE_MS

export interface ResumeCompaction {
  compact: boolean
  /** Why, in one line — for the ledger, the thread and the log alike. */
  reason: string
  estimatedCost: number | null
}

/**
 * A lapsed, oversized conversation is not a useful resume candidate.
 *
 * Its prefix is no longer cheap to read, and compacting it would first rebuild that whole prefix
 * only to throw it away. Starting a new conversation is the only option that neither repeats that
 * expensive compaction nor carries an already-too-large history into the next run. This is kept
 * beside `compactOnResume`: both answer what a closed conversation should do at dispatch.
 */
export function startFreshOnResume(session: Session, now = Date.now()): boolean {
  if (session.cacheExpiresAt === null || session.cacheExpiresAt > now) return false
  const model = costModel(adapter(session.adapterId).info.policy.costModelId)
  return worthCompactingNow(session, model)
}

/**
 * Should this conversation be compacted *before* the next run's prompt is put into it?
 *
 * ⛔ **The gap the cache clock structurally cannot see.** `runCacheClock` iterates live and idle
 * sessions, because every move it has is a prompt and a prompt needs a process to receive it. A
 * conversation whose process has exited — preempted, closed, crashed — is therefore invisible to it,
 * and *that is exactly the conversation that sits still for hours and then gets resumed*. Measured on
 * t92, 2026-09-01: run 2 was preempted at 21:35 on a quota warning, the process exited, and the
 * conversation sat closed for two hours with **no `clock_events` row of any kind**; run 3 resumed it
 * at 23:40 into an 84k context that had never been compacted and read **15.7M** cache tokens over the
 * next twenty minutes. Nothing was broken in the clock. The session simply was not one it was
 * allowed to look at.
 *
 * ⭐ **Resume time is the honest moment to pay for it, and the only one.** Compacting a closed
 * conversation on spec would mean spawning a process, paying a full context read, and hoping somebody
 * wants the conversation later — speculative spending on an account that may well have been preempted
 * for being out of quota in the first place. Here there is no speculation left: a task has been
 * dispatched, the account has already passed the dispatch gate, the conversation is being revived
 * whatever happens, and every turn of the run about to start reads this prefix.
 *
 * ⚠️ The same two-part `worthCompactingNow` test the clock uses, deliberately: a conversation is
 * compacted before a resume on exactly the terms it would have been compacted on while idle. This
 * adds a moment to the policy, never a second policy.
 *
 * ⛔ **Warm resumes are declined.** Compacting a conversation whose prefix is still comfortably
 * warm (> `decideBeforeExpiryMs(ttl)`, >15m on a 1h TTL) discards an asset readable at 0.1·C, pays
 * ~2.0·C to write a new summary, and stalls the operator ~2 minutes for context that regrows within
 * minutes (measured t130, 2026-09-02: 121k shrunk to 30k was back to 88k in 6m). The prompt going
 * in will read the warm prefix and refresh the TTL for free.
 *
 * ⛔ **And lapsed resumes are declined, which is the correction of 2026-09-05.** The gate above used
 * to have two regions and needed three: it declined a warm prefix, and let *everything else* through
 * — folding "inside the last quarter of the TTL", which is the cheapest moment a compaction ever has,
 * together with "lapsed hours ago", which is the dearest. `decideRevive` already says so in as many
 * words, and `REVIVE_COMPACT_FLOOR_MS` already refuses to *start* a compaction that would land after
 * the lapse for exactly this reason; this path simply never asked.
 *
 * ⭐ **Measured on t231, 2026-09-05.** Run 1 failed at 10:46 and the process exited. The
 * conversation sat closed for six hours — its prefix lapsed at ~11:46, unattended — and run 2 resumed
 * it at 16:44:24. Two seconds later this function asked for a compaction of 306,801 tokens, which
 * landed at 16:47:06: **2m40s of the operator's wall clock, spent before the run's own prompt was
 * allowed in**, to leave 38,235 tokens behind. What that bought was a cold rebuild of the entire
 * 306k prefix at ~1.25·C — paid *in order to discard it* — followed by an agent with no context that
 * had to re-read the files it had just been holding. Not compacting pays that same cold rebuild
 * exactly once, on the run's own first prompt, and then reads it warm at 0.1·C for every turn after.
 *
 * ⚠️ **The counter-argument, stated rather than hidden.** Over a *long* run a smaller prefix does win
 * on arithmetic alone: at 306k → 38k the crossover is around ten turns. It is refused anyway, because
 * the arithmetic assumes the summary holds — and the regrowth measured on t130 says it does not. The
 * agent buys the context back within minutes, so the fleet pays the cold rebuild, the summary, and
 * the re-reading, and arrives where it started. The cheap moment to compact this conversation was
 * ~11:31, while the prefix was still warm and nobody was waiting; `decideRevive` owns that moment.
 * When it is missed, the honest answer is to run on the context we have, not to buy a small one at
 * the worst price on the operator's time.
 *
 * ⚠️ **A `null` `cacheExpiresAt` is not a lapse.** It is an unmeasured prefix — an adapter that never
 * reported one — and reading unknown as expired would silently switch this path off for a whole
 * provider. Only a reading that says the prefix is gone is treated as one.
 */
export function compactOnResume(
  session: Session,
  settings: Settings,
  now = Date.now()
): ResumeCompaction {
  const info = adapter(session.adapterId).info
  const no = (reason: string): ResumeCompaction => ({ compact: false, reason, estimatedCost: null })

  if (!info.capabilities.manualCompact) return no(`${info.label} cannot be asked to compact`)
  // ⛔ Two independent declarations, and getting this one wrong costs the run its instructions: on a
  // one-shot session `/compact` would consume the single prompt stdin has room for and the task's
  // own prompt would never arrive. No adapter declares both today; that is not a reason to rely on it.
  if (info.capabilities.streamPrompts === 'once') {
    return no(`${info.label} takes one prompt per session, so a compaction would eat it`)
  }
  // ⛔ Off means off here too, and the task's own override is read alongside the fleet switch — see
  // `mayCompact`. This is the last-resort compaction, so a task told never to compact must not
  // acquire one simply by being resumed.
  //
  // ⚠️ `'context'`: what is being weighed here is the conversation's own size on the way back in, not
  // the window it is billed against, so usage credits do not stand it down. An account spending past
  // its plan limit still has the same context ceiling as one that is not.
  const permission = mayCompact(
    session,
    settings.autoCompact,
    settings.spendCreditsPastLimit,
    'context'
  )
  if (!permission.allowed) return no(compactionOffBecause(permission.source))

  const model = costModel(info.policy.costModelId)
  if (!worthCompactingNow(session, model)) {
    return no(
      `${session.contextTokens ?? 0} tokens of context, ${session.tokensSinceCompact} of it since ` +
        'the last compaction - not enough to be worth one'
    )
  }

  // ⭐ Warmth gate: if the prefix is still comfortably warm, declining compaction allows the upcoming
  // prompt to read the warm prefix at 0.1·C and refresh the TTL for free, avoiding a costly ~2.0·C
  // rebuild and a 2-minute stall. Inside the last quarter of the TTL, compaction proceeds.
  const ttlMs = model.cacheTtlMs()
  const untilExpiry = (session.cacheExpiresAt ?? 0) - now
  if (session.cacheExpiresAt !== null && untilExpiry > decideBeforeExpiryMs(ttlMs)) {
    return no(
      `prefix is still warm (${Math.round(untilExpiry / 60000)}m of TTL left) - ` +
        'the prompt will refresh it for free'
    )
  }
  // ⛔ **And a lapsed prefix is declined too, which is the other end of the same gate.** See the
  //    header note above for the argument; this is the branch that enforces it.
  if (session.cacheExpiresAt !== null && untilExpiry <= 0) {
    return no(
      `prefix lapsed ${Math.round(-untilExpiry / 60000)}m ago - compacting now would pay a cold ` +
        'rebuild of the whole context in order to throw that context away'
    )
  }

  const cost = model.costOfCompact(session)
  if (cost === null) return no('this cost model cannot price a compaction')

  return {
    compact: true,
    reason:
      `resuming a conversation carrying ${session.contextTokens ?? 0} tokens of context, ` +
      `${session.tokensSinceCompact} of it since the last compaction - every turn of this run ` +
      'would read that prefix',
    estimatedCost: Math.round(cost)
  }
}

// ---------------------------------------------------------------------------- before it lapses

/**
 * How long before the prefix lapses the clock starts trying to revive-and-compact.
 *
 * ⚠️ The same 15 minutes a live session gets, and for a stronger reason: this move has a **process
 * start** in front of the compaction. ~30s to spawn and reach stdin, plus a compaction measured at
 * 110s · 115s · 139s · 161s, is four minutes at the slow end — so the decision is taken at about
 * **T+45m** of a one-hour TTL, which leaves the headroom the operator asked for and still lands well
 * inside the window.
 *
 * ⚠️ **The one-hour value, and no longer the thing `decideRevive` compares against.** It reads
 * `decideBeforeExpiryMs(model.cacheTtlMs())` instead, so a provider with a shorter prefix gets a
 * proportionally shorter run-up. This constant remains what that function returns for a 60-minute
 * TTL, which is what the tests and the prose above mean by it.
 */
export const REVIVE_COMPACT_BEFORE_MS = DECIDE_BEFORE_EXPIRY_MS

/**
 * And the point past which it is no longer worth starting.
 *
 * ⛔ A compaction that finishes *after* the prefix has lapsed bought nothing: the cached read it was
 * trying to be paid for is gone, and the work becomes the same work the resume path would do later
 * for the same price. Below this the clock declines rather than starting what it cannot finish.
 */
export const REVIVE_COMPACT_FLOOR_MS = 5 * 60 * 1000

/**
 * Should this conversation be woken up, compacted, and put back down — before its prefix lapses?
 *
 * ⭐ **Compacting early and compacting late are not the same purchase.** A compaction has to read the
 * whole conversation, and what that read costs depends entirely on whether the vendor still holds the
 * prefix:
 *
 * ```
 * at T+45m, prefix still warm : the compaction reads a cached prefix        0.1·C
 * at T+2h,  prefix has lapsed : the same compaction rebuilds it first      ~1.25·C, then reads
 * ```
 *
 * ⛔ **This is the correction that made the move necessary.** `compactOnResume` compacts a
 * conversation at the moment it is revived for work, which for a task parked on a five-hour window is
 * *hours* after the one-hour TTL ran out — precisely when the compaction is at its most expensive and
 * every chance to be cheap has expired. Measured on t92 (2026-09-01): preempted 21:35, resumed 23:40,
 * prefix lapsed at ~22:35 in the middle of a gap where nothing looked at the conversation at all. The
 * moment worth acting on was ~22:20, while the cache this fleet had already paid for was still there.
 *
 * ⚠️ **`compactOnResume` is not replaced, and the two cannot both fire.** A landed compaction zeroes
 * `tokensSinceCompact`, so a conversation compacted here fails `worthCompactingNow` at resume and is
 * left alone. The resume path stays the last resort for what this cannot cover: a daemon that was not
 * running, a prefix that had already lapsed, a task with no clock on it.
 *
 * ⛔ **Only a conversation somebody is provably coming back to, and provably not yet.** Reviving costs
 * a real spawn on a real account, so the bar is a task parked on a clock — `paused_quota` or
 * `scheduled` with a `not_before` far enough out that `admit()` cannot make it dispatchable while the
 * compaction is in flight. That one test does three jobs: it proves the conversation has a future, it
 * proves the spend is not speculative, and it removes the race where the scheduler dispatches into the
 * session mid-compaction and the agent reads its instructions out of a summary.
 */
function poolForModel(worker: Worker, model: string | null): string | null {
  if (!model) return null
  try {
    return costModel(adapter(worker.adapterId).info.policy.costModelId).modelSpec(model)?.pool ?? null
  } catch {
    return null
  }
}

export function decideRevive(session: Session, ctx: ClockContext): ClockDecision {
  const now = ctx.now ?? Date.now()
  const info = adapter(session.adapterId).info
  const expiry = session.cacheExpiresAt
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

  if (!expiry) return nothing('no cached prefix to save')

  // ⛔ Ahead of everything else, exactly as in `decide()`: this move spawns a process, and a 10s tick
  // against a four-minute compaction would otherwise start twenty-four of them.
  const outcome = moveOutcome(session, now)
  if (outcome === 'in_flight') {
    const waited = Math.round((now - (session.clockMoveAt ?? now)) / 1000)
    return nothing(`${session.clockMove} was requested ${waited}s ago and has not landed yet`)
  }
  if (outcome === 'ignored' && session.clockMoveAttempts >= MAX_MOVE_ATTEMPTS) {
    // ⛔ The clock stops insisting here too, and there is nothing to fall back to: a conversation with
    // no process has no session to take a handoff from. It is left to lapse, and the resume path deals
    // with whatever is left of it.
    return nothing(
      `${session.clockMove} was asked for ${session.clockMoveAttempts} times and never landed - ` +
        'leaving this conversation alone'
    )
  }

  if (!info.capabilities.resumeSession) return nothing(`${info.label} cannot resume a conversation`)
  if (!info.capabilities.manualCompact) return nothing(`${info.label} cannot be asked to compact`)
  if (info.capabilities.streamPrompts === 'once') {
    return nothing(`${info.label} takes one prompt per session`)
  }
  // ⛔ Off means off, here as everywhere else the clock spends — fleet switch or task override.
  //
  // ⚠️ `'quota'`: reviving an idle conversation to compact it while it is cheap is maintenance done
  // to protect a budget. On an account deliberately spending past that budget it buys nothing and
  // costs a process, so credits stand it down.
  const permission = mayCompact(
    session,
    ctx.settings?.autoCompact ?? true,
    ctx.settings?.spendCreditsPastLimit ?? false,
    'quota'
  )
  if (!permission.allowed) return nothing(compactionOffBecause(permission.source))

  const model = costModel(info.policy.costModelId)
  if (!worthCompactingNow(session, model)) {
    return nothing(
      `${session.contextTokens ?? 0} tokens of context, ${session.tokensSinceCompact} of it since ` +
        'the last compaction - not enough to be worth a process'
    )
  }
  const compactCost = model.costOfCompact(session)
  if (compactCost === null) return nothing('this cost model cannot price a compaction')

  // ⛔ **Never two processes on one conversation.** The row says closed; a run that has not ended says
  // somebody is mid-turn in it regardless, and the two disagree exactly when it matters.
  if (hasOpenRun(session.id)) return nothing('a run is still open against this conversation')

  const worker = getWorker(session.workerId)
  if (!worker) return nothing('the account that holds this conversation is gone')
  const unavailable = whyNoSession(worker, 'work')
  if (unavailable) return nothing(unavailable)
  const unfit = accountRefusal(worker)
  if (unfit) return nothing(unfit.why)

  const refused = refusalRateLimit(worker.id, now)
  if (refused) {
    return nothing(
      `worker '${worker.label}' has an active vendor refusal (${refused.status} on ${refused.windowId})`
    )
  }

  // Who is coming back to it, and when.
  const lastRun = lastRunForSession(session.id)
  const task = lastRun?.taskId ? getTask(lastRun.taskId) : null
  if (!task || task.deletedAt) return nothing('no task is waiting on this conversation')
  if (task.status !== 'paused_quota' && task.status !== 'scheduled') {
    // ⚠️ Includes `ready`. A ready task is one the scheduler may dispatch on its very next tick, and
    // the dispatch path compacts what it revives — so the honest answer is to let it, rather than to
    // race it with a process of our own.
    return nothing(`t${task.seq} is ${task.status}, not parked on a clock`)
  }

  const onCredits = spendingCreditsOn(worker, ctx.settings?.spendCreditsPastLimit ?? false)
  if (!onCredits) {
    const quota = lastQuota(worker.id)
    if (quota && quota.windows.length > 0) {
      const pool = poolForModel(worker, session.model)
      const verdict = poolVerdict(windowsForPool(quota.windows, pool), now)
      if (verdict.blocking) {
        const override = quotaOverridden(task, now)
        if (verdict.blocking.exhausted || !override) {
          return nothing(
            `worker '${worker.label}' is at ${Math.round(verdict.blocking.window.percent)}% of its ` +
              `${verdict.blocking.window.label ?? 'quota'} window - not enough room to revive and compact`
          )
        }
      }
    }
  }
  const releaseIn = (task.notBefore ?? 0) - now
  if (releaseIn <= RESUME_COMPACT_WAIT_MS) {
    return nothing(
      `t${task.seq} can start again in ${Math.max(0, Math.round(releaseIn / 1000))}s - too soon to ` +
        'hold a compaction in front of it'
    )
  }

  const untilExpiry = expiry - now
  if (untilExpiry > decideBeforeExpiryMs(model.cacheTtlMs())) {
    return nothing(`${Math.round(untilExpiry / 60000)}m of TTL left - nothing to decide yet`)
  }
  if (untilExpiry < REVIVE_COMPACT_FLOOR_MS) {
    // ⚠️ Not a failure, and not silence either: the conversation now belongs to `compactOnResume`,
    // which compacts it when the task comes back, at the higher price.
    return nothing(
      `only ${Math.round(untilExpiry / 60000)}m of TTL left - a spawn and a compaction do not fit, ` +
        'so this is left for the resume to compact'
    )
  }

  return {
    ...base,
    move: 'revive_compact',
    reason:
      `t${task.seq} comes back in ${Math.round(releaseIn / 60000)}m, and this prefix lapses in ` +
      `${Math.round(untilExpiry / 60000)}m - compacting ${session.contextTokens ?? 0} tokens now ` +
      'reads a cache that is still warm, where the same compaction after it lapses pays to rebuild ' +
      'the prefix first',
    expectedIdleMs: releaseIn,
    estimatedCost: Math.round(compactCost)
  }
}

export function decide(session: Session, ctx: ClockContext): ClockDecision {
  const now = ctx.now ?? Date.now()
  const model = costModel(adapter(session.adapterId).info.policy.costModelId)
  const caps = adapter(session.adapterId).info.capabilities
  // ⚠️ The provider's own TTL, so `keepaliveFloorMs` means "the TTL covers it" on every provider
  // rather than only on the one whose TTL happens to be an hour.
  const cost = policy(ctx.objective, model.cacheTtlMs() ?? undefined)
  const expiry = session.cacheExpiresAt
  const contextTokens = session.contextTokens ?? 0

  const run = runForSession(session.id) ?? lastRunForSession(session.id)
  const task = run?.taskId ? getTask(run.taskId) : null
  const quotaOverrideActive = task ? quotaOverridden(task, now) : false

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

  /**
   * Can this session be spoken to at all?
   *
   * ⛔ **`handoff_close` is a prompt**, and a `streamPrompts: 'once'` CLI has already read its stdin
   * to EOF and will exit at the end of the turn it is on. `sendPrompt` throws for exactly this, so
   * every fallback below that reaches for a handoff would raise, be caught by `runCacheClock`, and
   * be tried again on the next tick - a warning every ten seconds and a handoff that never lands.
   *
   * ⚠️ It became reachable when codex gained a cache clock: with no `cache_expires_at` these
   * sessions returned at the top of this function and no branch below had ever seen one. Saying
   * "there is nothing to take a handoff through" is the honest answer, and it costs nothing: such a
   * session closes itself when its single turn ends, which is the release the move was after.
   */
  const canBePrompted = caps.streamPrompts !== 'once'
  const noChannel = `${adapter(session.adapterId).info.label} reads one prompt and exits, so there is no channel to take a handoff through`

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
    if (!canBePrompted) return nothing(noChannel)
    if (hasOpenRun(session.id) || quotaOverrideActive) {
      return nothing(
        `${session.clockMove} was asked for ${session.clockMoveAttempts} times and never landed, ` +
          `but ${hasOpenRun(session.id) ? 'a run is currently open' : 'the quota gate is overridden by hand'} on this session - not closing`
      )
    }
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

  // ⚠️ Off means off, including here. A switch that quietly kept compacting "just for safety" would
  // be a lie told by the one screen whose whole claim is that it shows what the scheduler really
  // does. `compactAllowed` therefore gates move 5 and move 5b as well as move 4 - and a provider
  // that *cannot* compact and a fleet that has been *told not to* end in the same place, which is
  // the fallback that already existed for the first case.
  //
  // ⛔ **The switch is no longer only the fleet's.** `mayCompact` resolves task → fleet, so a task
  // can be told to compact on a fleet that is not, or told not to on a fleet that is. It answers
  // *may we*, and nothing below it changes: `worthSaving`, the TTL window, the reserve and the cost
  // model still decide whether this particular compaction buys anything.
  //
  // ⛔ **Two permissions, because two of the three moves below are not asking the same question.**
  // Moves 4 and 5 compact to protect the quota window; move 5b compacts because a queued task cannot
  // borrow a conversation this large. Only the first kind stands down on usage credits — see the
  // `motive` parameter of `mayCompact`.
  const permission = mayCompact(
    session,
    ctx.settings?.autoCompact ?? true,
    ctx.settings?.spendCreditsPastLimit ?? false,
    'quota'
  )
  const borrowPermission = mayCompact(
    session,
    ctx.settings?.autoCompact ?? true,
    ctx.settings?.spendCreditsPastLimit ?? false,
    'context'
  )
  const compactAllowed = caps.manualCompact && permission.allowed
  const borrowCompactAllowed = caps.manualCompact && borrowPermission.allowed
  const compactOff = caps.manualCompact && !permission.allowed

  // Move 5 first: a reserve breach is not a preference, and it does not wait for the clock.
  //
  // ⛔ **`worthCompactingNow`, and the reserve alone is not enough without it.** Until t73 the
  // verdict could only come from a token comparison nothing on this fleet could compute, so this
  // branch had never run and "at risk with any context at all" was safe by never happening. The
  // percentage rung makes it reachable, and reachable it stays true for *hours* - a whole window,
  // not an instant - so a condition that ignored what the last compaction did would send `/compact`
  // every four minutes until the window reset. That is the 2026-08-26 repeat with a new trigger.
  // The growth half of `worthCompactingNow` is what ends it: a landed compaction zeroes
  // `tokensSinceCompact`, and this stops asking until the session has grown enough to be worth
  // asking about again.
  const reserve = reserveState(session.workerId)
  const worthSaving = worthCompactingNow(session, model)
  if (reserve.verdict === 'at_risk' && contextTokens > 0 && worthSaving) {
    if (quotaOverrideActive) {
      return nothing(
        `compaction reserve at risk (${reserve.reason}), but the quota gate is overridden by hand` +
          (task ? ` for t${task.seq}` : '')
      )
    }
    if (hasOpenRun(session.id)) {
      return nothing(`compaction reserve at risk (${reserve.reason}), but a run is currently open on this session`)
    }
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
    if (!canBePrompted) return nothing(`compaction reserve at risk - ${reserve.reason} - but ${noChannel}`)
    return {
      ...base,
      move: 'handoff_close',
      reason:
        (compactOff
          ? `compaction reserve at risk and ${compactionOffBecause(permission.source)} - ${reserve.reason}.`
          : `compaction reserve at risk and this provider cannot compact - ${reserve.reason}.`) +
        ' Taking a handoff and releasing the session instead.',
      expectedIdleMs: null,
      estimatedCost: model.costOfKeepalive(session) ?? 0
    }
  }

  // Move 5b. Somebody is waiting on this conversation, and the only thing in its way is its size.
  //
  // ⭐ **Wanted now beats idle later, and no other move can say so.** Moves 2-4 all reason from
  // `expectedIdleMs` — how long until this session is *likely* to be used — and a conversation a
  // queued task has already been refused is not idle in that sense at all. Compacting it is not
  // speculative maintenance: there is a named task that will join it on the next tick and skip a
  // ~41.5k-token cold start, against a compaction of roughly the same size paid once. ⛔ Placed
  // above the TTL window on purpose: the queue does not wait for a prefix to be near expiry, and a
  // conversation with fifty minutes of TTL left is exactly the one worth shrinking, since the
  // borrower gets the rest of that hour for free.
  //
  // ⚠️ `worthSaving` still gates it, and it is what stops the loop. A landed compaction zeroes
  // `tokensSinceCompact`, so a conversation that stays over the share ceiling even after compacting
  // is asked once and then left alone rather than asked every four minutes forever.
  // ⚠️ `borrowCompactAllowed`, not `compactAllowed`: this is the size of the conversation against
  // what a waiting task needs, which usage credits do not change.
  if (ctx.borrowWanted?.has(session.id) && contextTokens > 0 && worthSaving && borrowCompactAllowed) {
    const compactCost = model.costOfCompact(session)
    if (compactCost !== null) {
      return {
        ...base,
        move: 'compact',
        reason:
          'a queued task in this project would borrow this conversation but it is too full to ' +
          `lend - ${contextTokens} tokens of context is worth ${Math.round(compactCost)} to shrink`,
        expectedIdleMs: 0,
        estimatedCost: Math.round(compactCost)
      }
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

  const ttlMs = model.cacheTtlMs()
  const untilExpiry = expiry - now
  if (untilExpiry > decideBeforeExpiryMs(ttlMs)) {
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
  //
  // ⛔ `=== 'ok'`, not `!== 'unknown'`. Written when `at_risk` could never occur, the old test read
  // as "anything but unknown is fine" and would now let a *breached* reserve buy the most expensive
  // move here - paying by the hour to hold a prefix open on the one account that cannot afford it.
  // A session gets here at all only when move 5 found nothing worth compacting.
  const mayKeepalive = reserve.verdict === 'ok' || cost.keepaliveWhenQuotaUnknown

  // ⛔ **A guess does not get to buy an expensive keepalive.** Holding a warm prefix costs `0.1·C`
  // *every hour, for as long as the guess is wrong*, and on a large context that is the most
  // expensive thing this loop can choose: 278k tokens of context bills about 28k an hour to sit
  // still. Where the estimate is a real one, paying that is a considered bet. Where it is the
  // in-flight placeholder it is a bet on a number nobody computed - so a context already past the
  // compaction break-even skips moves 2 and 3 entirely and is decided by move 4, which costs about
  // the same once and then stops costing.
  //
  // ⚠️ Only for a context worth compacting. A small one still keepalives: there the hourly cost is
  // small and a compaction would buy almost nothing.
  //
  // ⚠️ Deliberately **not** conditioned on `compactAllowed`. With automatic compaction switched off
  // this falls to the `compactOff` branch below, which says so in words - and "this would have
  // compacted, and did not, because you turned that off" is the whole reason that branch exists. If
  // the guard included the switch, the one case that needed the sentence could never produce it.
  const guessing = !idle.confident && worthSaving

  // Moves 2 and 3.
  if (!guessing && idle.ms >= cost.keepaliveFloorMs && idle.ms < cost.compactThresholdMs) {
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
  const worthCompacting = compactCost !== null && worthSaving
  const pastThreshold = idle.ms >= cost.compactThresholdMs || guessing
  if (pastThreshold && worthCompacting && compactAllowed) {
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
  if (pastThreshold && worthCompacting && compactOff) {
    return nothing(
      `would compact (${contextTokens} tokens, ${idle.because}) but ` +
        compactionOffBecause(permission.source)
    )
  }

  // Move 6.
  if (untilExpiry <= lastChanceMs(ttlMs)) {
    const run = runForSession(session.id)
    if (run?.taskId && canBePrompted) {
      if (hasOpenRun(session.id) || quotaOverrideActive) {
        return nothing(
          `prefix expiring in ${Math.round(untilExpiry / 1000)}s, but ` +
            (hasOpenRun(session.id) ? 'a run is currently open' : 'the quota gate is overridden by hand') +
            ' - not taking a handoff'
        )
      }
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
 * ⛔ Every decision that *acts* is recorded. "Why is this session still open?" and "why did that
 * cost 30k?" have to be answerable months later from data rather than from somebody's memory of
 * what the rules were that week.
 *
 * ⚠️ **`move: 'none'` is deliberately not written, and this comment used to claim otherwise.** The
 * clock ticks every 10s against every live session, so recording the no-ops would add ~8,600 rows
 * per session per day saying "nothing to decide yet" - a table too big to read is not an audit
 * trail. What a person actually wants to know is whether a compaction happened, and that is
 * answered by `compactions`, which records the ask as well as the outcome.
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
    if (decision.move === 'none') {
      if (outcome === 'ignored' && session.clockMoveAttempts >= MAX_MOVE_ATTEMPTS) {
        clearClockMove(session.id)
      }
      continue
    }

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

  // The second pass: conversations with no process at all, whose prefix has not lapsed yet.
  //
  // ⛔ Separate from the loop above and deliberately so. Every move in that loop is a prompt to a
  // running process; the only move available here is to *start* one, which is a different decision
  // with a different bar — see `decideRevive`. Folding the two together would mean one `decide()`
  // whose branches disagreed about whether a session even exists.
  for (const session of warmClosedConversations(withSettings.now ?? Date.now())) {
    const now = withSettings.now ?? Date.now()
    const outcome = moveOutcome(session, now)
    if (outcome === 'landed') {
      log.info(`${session.clockMove} landed on ${session.id.slice(0, 8)}`)
      clearClockMove(session.id)
    }
    const decision = decideRevive(
      outcome === 'landed' ? { ...session, clockMove: null } : session,
      withSettings
    )
    decisions.push(decision)
    if (decision.move === 'none') continue

    record(decision)
    try {
      await reviveAndCompact(session, decision)
      acted++
    } catch (err) {
      // ⛔ Nothing is marked. A spawn that threw never happened, and remembering it as an outstanding
      // move would keep the clock waiting four minutes for a compaction nobody asked for.
      log.warn(`cache clock could not revive ${session.id.slice(0, 8)} to compact it:`, err)
    }
  }

  return { decisions, acted }
}

/** A revived CLI needs the same moment before it reads stdin that a fresh one does. */
const SPAWN_TO_PROMPT_MS = 2500

/**
 * Wake a conversation, compact it, and put it back down.
 *
 * ⛔ **Put back down, always.** The session is closed on the boundary and closed again on the timeout,
 * because a live work session with no run and no workspace claim is a state nothing else in this
 * daemon expects: the claim was released when the conversation ended, so leaving the process up would
 * offer the scheduler a warm session in a worktree that may since have been claimed by another task
 * and checked out onto another branch. Reviving costs one spawn; that is the whole price paid here.
 *
 * ⚠️ **`post_tokens` stays null for this move.** The size a compaction left behind is only knowable
 * from a *later* turn (see `fillPostTokens`), and this conversation is closed before it can take one.
 * Buying that measurement would mean paying for an extra turn to learn a number nothing acts on.
 *
 * ⚠️ The compaction is metered on the session, and on no run: there is no open run to attribute it to,
 * and inventing one would put tokens in a run's ledger that the run did not spend.
 */
async function reviveAndCompact(session: Session, decision: ClockDecision): Promise<void> {
  const info = adapter(session.adapterId).info
  const nextAttempts =
    (session.clockMove === 'revive_compact' || session.clockMove === 'compact'
      ? session.clockMoveAttempts
      : 0) + 1

  const revived = spawnSession({
    workerId: session.workerId,
    cwd: session.cwd,
    transport: session.transport,
    purpose: 'work',
    projectId: session.projectId,
    ...(session.model ? { model: session.model } : {}),
    // ⛔ Only where the CLI can be told one — the same rule `SpawnOptions.effort` states.
    ...(info.capabilities.selectableEffort && session.effort ? { effort: session.effort } : {}),
    // ⛔ The same row, the same conversation. `--resume` reuses the id, which is why everything below
    // can go on addressing this session by the id it already had.
    resume: session
  })

  // ⛔ After the spawn, never before: the resume path clears `clock_move` on the way in, so a mark
  // written first would be wiped by the very thing it exists to guard.
  markClockMove(revived.id, 'revive_compact', session.tokensSinceCompact, nextAttempts)

  const run = lastRunForSession(session.id)
  noteCompactionAsked({
    sessionId: session.id,
    taskId: run?.taskId ?? null,
    reason: decision.reason,
    preTokens: decision.contextTokens
  })
  if (run?.taskId) {
    addMessage(run.taskId, 'system', `Woke the conversation to compact it (≈${decision.estimatedCost} tokens)`, null, [], {
      event: 'compaction',
      detail:
        `Woke this conversation up to compact it: ${decision.reason}. It costs about ` +
        `${decision.estimatedCost} tokens now, against a rebuild of the whole prefix if it is left ` +
        'until this task starts again. The session is closed again as soon as it lands.'
    })
  }
  log.info(
    `reviving ${session.id.slice(0, 8)} to compact it: ${decision.reason} ` +
      `(~${decision.estimatedCost} tokens)`
  )

  // ⚠️ One ending, whichever arrives first. The boundary is the good one; the timeout is the honest
  // one, because whether `/compact` is honoured on the stream transport is still unmeasured (R6).
  let settled = false
  let stopWaiting = (): void => {}
  const done = (why: string, landed: boolean): void => {
    if (settled) return
    settled = true
    stopWaiting()
    clearTimeout(timer)
    if (landed) {
      clearClockMove(session.id)
    }
    try {
      closeSession(session.id)
    } catch (err) {
      log.warn(`could not close ${session.id.slice(0, 8)} after compacting it:`, err)
    }
    log.info(`${session.id.slice(0, 8)}: ${why}`)
  }

  const timer = setTimeout(
    () => done('the compaction never landed - closing the conversation again', false),
    RESUME_COMPACT_WAIT_MS
  )
  stopWaiting = onCompactionLanded(session.id, () =>
    done('compacted while its prefix was still warm - closing the conversation again', true)
  )

  setTimeout(() => {
    try {
      sendPrompt(session.id, '/compact', [], { housekeeping: true })
    } catch (err) {
      log.warn(`could not send /compact to the revived ${session.id.slice(0, 8)}:`, err)
      done('the /compact could not be sent - closing the conversation again', false)
    }
  }, SPAWN_TO_PROMPT_MS)
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
      // ⚠️ `housekeeping`: this is the daemon speaking, not the agent waking itself up, and
      // `resumeIdleConversation` must not bill the reply as a turn of the task's own.
      sendPrompt(session.id, KEEPALIVE_PROMPT, [], { housekeeping: true })
      log.info(
        `keepalive on ${session.id.slice(0, 8)}: ${decision.reason} (~${decision.estimatedCost} tokens)`
      )
      break

    case 'compact': {
      // ⚠️ Sent as a user message on the session's own input channel. That `/compact` is honoured
      // this way on the stream transport is **inferred from the CLI's slash-command handling and not
      // yet measured** - see HANDOFF R6. If it turns out not to be, the fallback is handoff + close,
      // which is already implemented below.
      sendPrompt(session.id, '/compact', [], { housekeeping: true })
      // ⛔ Written down *before* it is known to have worked, and that is the point: a request that
      // was never honoured is the finding, and a ledger that only recorded successes could not
      // report it. `landedAt` stays null until a boundary record arrives.
      // ⛔ The open run's task, else the last run's. Between runs there is no open run, and that
      // is exactly when this move fires — t446's 17:18 ask on t445's idle session recorded
      // `task_id` null and never appeared on the task's thread, while the visible preemption ask
      // read as failed forever. The same fallback `reviveAndCompact` already uses.
      const run = runForSession(session.id) ?? lastRunForSession(session.id)
      noteCompactionAsked({
        sessionId: session.id,
        taskId: run?.taskId ?? null,
        reason: decision.reason,
        preTokens: decision.contextTokens
      })
      if (run?.taskId) {
        addMessage(
          run.taskId,
          'system',
          `Compacting (≈${fmt(decision.contextTokens)} tokens)`,
          null,
          [],
          {
            event: 'compaction',
            detail:
              `Compacting this session: ${decision.reason}. Context is ${fmt(decision.contextTokens)} ` +
              `tokens; this costs about ${fmt(decision.estimatedCost)} and makes every turn after it ` +
              'read a smaller prefix.'
          }
        )
      }
      log.info(
        `compacting ${session.id.slice(0, 8)}: ${decision.reason} (~${decision.estimatedCost} tokens)`
      )
      break
    }

    case 'handoff_close': {
      sendPrompt(session.id, WRAP_UP_PROMPT, [], { housekeeping: true })
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

/** Tokens, for a sentence rather than a table: `278275` reads as noise, `278k` reads as a size. */
function fmt(n: number | null): string {
  if (n === null) return 'an unknown number of'
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
