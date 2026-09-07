import type { Worker } from '@shared/protocol.js'
import { adapter } from './adapters/index.js'

/**
 * Is this account fit to be handed a turn at all?
 *
 * ⛔ **One list, because there were two and they drifted.** The scheduler grew a gate for a worker
 * that work does not survive on — an expired subscription, measured by a run that produced nothing —
 * and the controller never got it. So an account the scheduler had already quarantined stayed
 * *"ready"* on the Controller panel and was picked for judgment call after judgment call, each one
 * spending the only loop in the daemon that spends tokens to discover the same thing again.
 *
 * ⚠️ Everything here is about the **account** and nothing about the task or the question. That is
 * what makes it shareable, and it is the line to hold: a gate that needs to know what is being asked
 * belongs at the call site, not in here. The scheduler adds capability and concurrency gates; the
 * controller adds transport, rate limit and its own quota water mark.
 *
 * The sentence comes back whole, worker label included, because it is shown to a person on two
 * different panels and *"disabled"* on its own answers nothing.
 */
export interface AccountRefusal {
  /** The sentence, worker label included — what `accountUnavailability` has always returned. */
  why: string
  /**
   * Is this the kind of refusal that **nothing but a person** will change?
   *
   * ⛔ **The distinction t268 turned on** (2026-09-07). A task pinned to a worker whose CLI could
   * not be found sat at `ready` with *"Muse Code is not installed"* on its row, tick after tick,
   * indistinguishable from a task waiting behind a busy account — and the operator's question was
   * the right one: *how does that ever unblock itself?* It does not. The scheduler escalates a
   * task whose every refusal is standing to `awaiting_human`, which is the resting state that says
   * *this needs you* and can be answered.
   *
   * ⚠️ `true` only where **waiting cannot help**. The two refusals a person is already holding in
   * their hand — a disabled account and a human-occupied one — stay `false` on purpose: they are
   * switches the operator flipped knowingly and reads on the fleet card, and escalating every task
   * queued behind an hour of hands-on use would be noise. `suspect` stays `false` for the same
   * reason from the other end: a probe or a turn clears it, and both happen without a person.
   */
  standing: boolean
}

export function accountRefusal(worker: Worker): AccountRefusal | null {
  // Retired is not a state anything should be choosing from — `listWorkers()` already excludes it —
  // but a caller holding an older row would otherwise sail past every other gate.
  if (worker.retiredAt) return { why: `${worker.label} is retired`, standing: true }

  if (!worker.enabled) return { why: `${worker.label} disabled`, standing: false }

  // Quota is tracked on a human-occupied worker and never spent by agentyard.
  if (worker.humanOccupied) return { why: `${worker.label} human-occupied`, standing: false }

  // A filesystem lookup, so it is free to ask every tick. Without it the caller spawns, fails, and
  // reports a failure it could have read off the disk.
  //
  // ⚠️ Standing, but a *bridged* adapter answers `false` until its first background probe returns —
  // which is why the escalation this feeds waits out a grace period rather than acting on the first
  // tick after a restart. See `STANDING_HOLD_GRACE_MS`.
  const ad = adapter(worker.adapterId)
  if (!ad.isInstalled()) return { why: `${ad.info.label} is not installed`, standing: true }

  // ⚠️ `=== false`, from the stored field. `null` means unknown and is deliberately allowed through:
  // Antigravity's credential lives in the OS keyring and is unknowable by design, and refusing
  // unknown would make it unusable for both work and judgment.
  if (worker.identity?.loggedIn === false) {
    return { why: `${worker.label} is not signed in`, standing: true }
  }

  if (worker.identity?.subscriptionExpired === true) {
    return { why: `${worker.label} subscription expired`, standing: true }
  }

  // ⛔ The last turn given to this account died without producing anything. A *measured* verdict,
  // not a guess from identity: an expired subscription answers `auth status` exactly as a live one
  // does, so nothing free can tell them apart and only a turn can. Held out until somebody re-probes
  // it or something on it produces a turn. See workers.ts.
  if (worker.health?.state === 'suspect') {
    return { why: `${worker.label} is held out: ${worker.health.reason}`, standing: false }
  }

  return null
}

/** The sentence alone, for every caller that only ever wanted that. */
export function accountUnavailability(worker: Worker): string | null {
  return accountRefusal(worker)?.why ?? null
}
