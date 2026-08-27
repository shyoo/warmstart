import { log } from './log.js'

/**
 * How something inside the daemon asks the daemon to stop.
 *
 * ⛔ **A request the daemon grants itself, never a signal from outside.** The alternative — the app
 * reading `orchestratord.json` for a pid and killing it — is the exact shape this project refuses
 * everywhere else: a pid can be reused, and a process matching a recorded pid is not the same claim
 * as a process this app started. Here the daemon does its own winding down, in the one function that
 * already knows how: stop the poller and both loops, close the tailers, close the sessions, release
 * the lock, clear the endpoint, close the database.
 *
 * ⚠️ It is deliberately a hook rather than an import. `index.ts` builds `shutdown()` after the server
 * is listening — the server has to exist before there is anything to close — so the API cannot import
 * it directly without a cycle.
 */

let handler: ((reason: string) => void) | null = null

export function onShutdownRequest(fn: (reason: string) => void): void {
  handler = fn
}

/** @returns whether anything was listening. `false` means the daemon is already on its way down. */
export function requestShutdown(reason: string): boolean {
  if (!handler) {
    log.warn(`shutdown requested (${reason}) with nothing wired to do it`)
    return false
  }
  // ⚠️ On the next tick, so the RPC that asked can be answered before the socket closes underneath
  // it. A caller that gets a dropped connection instead of a reply cannot tell "stopped" from
  // "never received it", and that is precisely the question it is asking.
  setTimeout(() => handler?.(reason), 50).unref()
  return true
}
