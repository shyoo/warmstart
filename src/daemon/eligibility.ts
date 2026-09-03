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
export function accountUnavailability(worker: Worker): string | null {
  // Retired is not a state anything should be choosing from — `listWorkers()` already excludes it —
  // but a caller holding an older row would otherwise sail past every other gate.
  if (worker.retiredAt) return `${worker.label} is retired`

  if (!worker.enabled) return `${worker.label} disabled`

  // Quota is tracked on a human-occupied worker and never spent by agentyard.
  if (worker.humanOccupied) return `${worker.label} human-occupied`

  // A filesystem lookup, so it is free to ask every tick. Without it the caller spawns, fails, and
  // reports a failure it could have read off the disk.
  const ad = adapter(worker.adapterId)
  if (!ad.isInstalled()) return `${ad.info.label} is not installed`

  // ⚠️ `=== false`, from the stored field. `null` means unknown and is deliberately allowed through:
  // Antigravity's credential lives in the OS keyring and is unknowable by design, and refusing
  // unknown would make it unusable for both work and judgment.
  if (worker.identity?.loggedIn === false) return `${worker.label} is not signed in`

  if (worker.identity?.subscriptionExpired === true) {
    return `${worker.label} subscription expired`
  }

  // ⛔ The last turn given to this account died without producing anything. A *measured* verdict,
  // not a guess from identity: an expired subscription answers `auth status` exactly as a live one
  // does, so nothing free can tell them apart and only a turn can. Held out until somebody re-probes
  // it or something on it produces a turn. See workers.ts.
  if (worker.health?.state === 'suspect') {
    return `${worker.label} is held out: ${worker.health.reason}`
  }

  return null
}
