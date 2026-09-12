/**
 * Turning a run's stream usage records into **one turn's** usage and **one context level**.
 *
 * ⛔ **A CLI's terminal usage record is not always the turn's cost.** Measured 2026-09-03 against
 * `agy` 1.1.25, driving three prompts down one conversation and reading the raw NDJSON:
 *
 * | run | steps (`step_update.usage.input_tokens`) | `result.usage.input_tokens` |
 * |---|---|---|
 * | 1 (new conversation) | 14,687 + 14,947 + 15,151 | **44,785** |
 * | 2 (`--continue`)     | 15,599                   | **60,384** |
 * | 3 (`--continue`)     | 15,825                   | **76,209** |
 *
 * Two facts fall out, and both were being read wrong:
 *
 * 1. ⛔ **`result.usage` is cumulative over the whole conversation, not the turn.** 44,785 + 15,599
 *    = 60,384, and 60,384 + 15,825 = 76,209, exactly. Crediting it once per turn bills turn 1 again
 *    on turn 2 and twice more on turn 3 — a session's recorded spend grows quadratically in its
 *    number of turns. This is what put 4.7M into one Antigravity session's `tokens_since_compact`
 *    while its own last reading said 1.38M.
 * 2. ⛔ **Neither figure is the context window level.** `result.usage.input_tokens` is a *sum of
 *    prompt sizes* across every model invocation, which is why the session gauge read `1.1M/1.0M`
 *    and `2.0M/1.0M`. The prompt size at the **last** model call is the fill level, and it is only
 *    ever visible on a step record.
 *
 * ⭐ The rule this module applies is a fact about the *records*, not about a vendor: **if a run
 * emitted per-call usage, the sum of those calls is the turn and the last of them is the context
 * level; if it emitted none, the terminal record is all there is and is taken as the turn.** No
 * adapter is named here — see AGENTS.md, "never branch on an adapter name". Today only
 * `antigravity-cli` emits non-final usage; `openai-compatible` (codex) and `local-llm` emit one
 * terminal record each, so they take the fallback path and are unchanged.
 *
 * ⚠️ `input` and `cacheRead` are **disjoint** categories, so the context level is their sum. That is
 * not assumed from the vendor's docs, it is forced by stored data: session `f88c6fe8`'s last turn
 * reported 1,384,180 input against 23,169,687 cache reads. A counter that included cached tokens in
 * `input` could not be 17x smaller than the cached count over the same calls.
 */
import type { StreamUsage } from './stream.js'

const ZERO: StreamUsage = { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 }

interface Accumulator {
  /** Sum over every model call seen so far in this run. */
  total: StreamUsage
  /** Prompt size at the most recent model call — the context window fill level. */
  lastContext: number
  calls: number
}

/** Keyed by session id: a run belongs to one session, and one session runs one turn at a time. */
const perSession = new Map<string, Accumulator>()

function add(a: StreamUsage, b: StreamUsage): StreamUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

/** Record one model call's usage, from a non-final `usage` stream event. */
export function noteStepUsage(sessionId: string, usage: StreamUsage): void {
  const acc = perSession.get(sessionId) ?? { total: ZERO, lastContext: 0, calls: 0 }
  perSession.set(sessionId, {
    total: add(acc.total, usage),
    lastContext: usage.input + usage.cacheRead,
    calls: acc.calls + 1
  })
}

export interface TurnUsage {
  /** What this turn cost. Billed once. */
  usage: StreamUsage
  /**
   * How full the model's context window was when the turn ended, or null when the run emitted no
   * per-call usage and there is therefore nothing to say. ⚠️ Null is a verdict — the caller falls
   * back to the terminal record clamped to the window, and must not read null as zero.
   */
  contextTokens: number | null
}

/**
 * Close out a run: return the turn's usage and context level, and forget the run.
 *
 * ⚠️ Consumes the accumulator, so a replayed terminal record cannot double-count the steps. The
 * `turns` table dedupes as well, one layer down.
 */
export function takeTurnUsage(sessionId: string, final: StreamUsage): TurnUsage {
  const acc = perSession.get(sessionId)
  perSession.delete(sessionId)
  if (!acc || acc.calls === 0) return { usage: final, contextTokens: null }
  return { usage: acc.total, contextTokens: acc.lastContext }
}

/**
 * What a run that never reached its terminal record had already spent, or null if nothing.
 *
 * ⛔ **A turn that was cut off still cost what its calls cost.** `takeTurnUsage` is reached from the
 * terminal `usage` record, so a run stopped mid-turn — cancelled, preempted, or killed by a person
 * who decided it was stuck — used to hand its whole accumulator to `forgetStreamUsage` and bill
 * nothing. ⚠️ Measured on t366, 2026-09-11: 47 minutes on `antigravity-cli`, nine model responses in
 * the conversation, and the run reads `0 in / 0 out / 0 cached` with its price *"no reading"*. Zero is
 * not what it cost, and a fleet that prices its own history cannot learn from a row that says so.
 *
 * ⛔ **It cannot double-count, by construction.** The accumulator exists only while no terminal
 * record has consumed it, and consuming it here deletes it too. A run that ended normally has nothing
 * left for this to find, which is why it returns null rather than zeroes.
 *
 * ⚠️ `contextTokens` is the last call's prompt size, exactly as in a completed turn: the window was
 * that full when the process went away, whatever the turn went on to do.
 */
export function takeUnfinishedTurn(sessionId: string): TurnUsage | null {
  const acc = perSession.get(sessionId)
  if (!acc || acc.calls === 0) return null
  perSession.delete(sessionId)
  return { usage: acc.total, contextTokens: acc.lastContext }
}

/** Drop a session's part-built run. Called when the process exits without a terminal record. */
export function forgetStreamUsage(sessionId: string): void {
  perSession.delete(sessionId)
}
