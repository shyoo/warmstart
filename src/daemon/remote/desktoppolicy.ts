import type { RpcMethod } from '@shared/protocol.js'
import { RPC_VERSION, acceptsRpcVersion } from '@shared/rpcversion.js'

/**
 * What a paired **desktop** may do: everything this machine's own window may, minus a short list.
 *
 * ⛔ **Parity is the operator's decision (t419, 2026-09-13), and it is a lot of authority.** A desktop
 * token reaches `session.write`, `worker.create`, `project.add` and `settings.set`, so whoever holds
 * one can run code on this machine as this user — the same power the loopback token has, reachable
 * from the tailnet. That is why it is a separate switch from phones, TLS-only, issued only from a
 * code shown on *this* screen, and listed beside the phones where it can be revoked.
 *
 * The exceptions, each for a reason rather than for caution:
 * - `daemon.shutdown` — stopping the fleet ends every live agent and is the host operator's call; the
 *   remote window's Quit is always about its own computer.
 * - `agent.*` — the MCP identity of a running session. It is minted into the session's own config by
 *   this daemon, and no desktop surface calls it. ⚠️ Denied by prefix, so a future `agent.` method is
 *   denied without anybody remembering to list it.
 * - `remote.subscribe` — a phone's Web Push subscription, bound to the calling device.
 */
export const DESKTOP_DENIED = {
  'daemon.shutdown': 'Stopping the daemon from another computer is not allowed; quit Warmstart on that machine.',
  'remote.subscribe': 'Push subscriptions belong to paired phones.'
} as const satisfies Partial<Record<RpcMethod, string>>

export function desktopRefusal(method: RpcMethod): string | null {
  if (method.startsWith('agent.')) return `'${method}' is an agent's MCP identity and is never reachable from another computer.`
  return (DESKTOP_DENIED as Partial<Record<RpcMethod, string>>)[method] ?? null
}

/** Everything a desktop request is judged on besides its token. */
export interface DesktopRequestFacts {
  desktopsEnabled: boolean
  /** The connection is TLS. */
  encrypted: boolean
  /** The value of the `x-warmstart-rpc` header. */
  rpcVersion: string | string[] | undefined
}

/**
 * Whether a request carrying a valid desktop token may go further, as an HTTP status and a sentence.
 *
 * ⛔ **TLS or nothing.** The Tailscale listener only speaks TLS when the tailnet certificate is there;
 * set to LAN it serves plain HTTP, and a desktop token must never cross that. Refused here rather than
 * trusted to the client, which already refuses `http://`.
 */
export function desktopGate(facts: DesktopRequestFacts): { ok: false; status: 403 | 426; error: string } | { ok: true; version: number } {
  if (!facts.desktopsEnabled) return { ok: false, status: 403, error: 'paired desktops are switched off on this computer' }
  if (!facts.encrypted) return { ok: false, status: 403, error: 'a desktop connects over HTTPS only' }
  const version = acceptsRpcVersion(RPC_VERSION, facts.rpcVersion)
  if (version === null) return { ok: false, status: 426, error: `this computer speaks protocol v${RPC_VERSION.min}–v${RPC_VERSION.max}` }
  return { ok: true, version }
}
