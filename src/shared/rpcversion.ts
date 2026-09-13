/**
 * The RPC protocol version a desktop and a remote Warmstart agree on before one drives the other.
 *
 * ⛔ **A range, not a number, and the two ends negotiate.** A client's renderer is its own build, so
 * it can call a method the remote daemon does not have yet — the phone never had this problem,
 * because the host serves the phone its bundle. Each side declares the oldest and newest protocol it
 * still speaks; the newest one both speak is used, and a pair with nothing in common refuses to
 * connect rather than failing call by call.
 *
 * ⚠️ **Bumping it.** A change a client from the previous version could not survive (a method removed
 * or reshaped, an event renamed) raises `max`. The server keeps answering the old shape until `min`
 * is raised past it, and the client gates what it calls on the negotiated version. Raising `min` is
 * how the compatibility burden is dropped, and it is exactly what makes an old peer refuse.
 *
 * ⛔ **At most one version either way** (operator, 2026-09-13). `max - min` never exceeds
 * `RPC_COMPATIBILITY_SPAN`, so raising `max` to N+1 raises `min` to N in the same change: two builds
 * one protocol apart still work together, and nobody maintains a very old shape for ever.
 * `rpcversion.test.ts` fails the build on a wider range.
 */
export const RPC_COMPATIBILITY_SPAN = 1

export interface RpcVersionRange {
  min: number
  max: number
}

export const RPC_VERSION: RpcVersionRange = { min: 1, max: 1 }

/** The header a desktop client puts the negotiated version on, for every call and the event socket. */
export const RPC_VERSION_HEADER = 'x-warmstart-rpc'

/** What `/remote/hello` answers, before any credential exists. */
export interface RemoteHello {
  app: 'warmstart'
  appVersion: string
  rpc: RpcVersionRange
}

export type RpcNegotiation =
  | {
      ok: true
      version: number
      /** The remote's newest protocol is older than ours: it works, but the remote needs upgrading. */
      remoteNeedsUpgrade: boolean
    }
  | { ok: false; reason: string }

function validRange(range: RpcVersionRange | null | undefined): range is RpcVersionRange {
  return (
    !!range &&
    Number.isInteger(range.min) &&
    Number.isInteger(range.max) &&
    range.min >= 1 &&
    range.min <= range.max
  )
}

export function negotiateRpcVersion(local: RpcVersionRange, remote: RpcVersionRange | null | undefined): RpcNegotiation {
  if (!validRange(remote)) {
    return { ok: false, reason: 'The remote did not say which protocol versions it speaks. Upgrade Warmstart on that machine.' }
  }
  const version = Math.min(local.max, remote.max)
  if (version < Math.max(local.min, remote.min)) {
    return remote.max < local.min
      ? { ok: false, reason: `The remote speaks protocol v${remote.min}–v${remote.max}; this app needs at least v${local.min}. Upgrade Warmstart on the remote.` }
      : { ok: false, reason: `The remote needs protocol v${remote.min} or newer; this app speaks up to v${local.max}. Upgrade Warmstart on this computer.` }
  }
  return { ok: true, version, remoteNeedsUpgrade: remote.max < local.max }
}

/** Whether a server whose range is `local` answers a client that asked for `requested`. */
export function acceptsRpcVersion(local: RpcVersionRange, requested: string | string[] | undefined): number | null {
  const raw = Array.isArray(requested) ? requested[0] : requested
  if (!raw || !/^\d+$/.test(raw)) return null
  const version = Number(raw)
  return version >= local.min && version <= local.max ? version : null
}

/** The address and one-time code a desktop pairs with. */
export interface DesktopPairingInput {
  origin: string
  code: string
}

/**
 * Read what the operator pasted into **Add remote**: the pairing link the host shows, or an address
 * and a code typed separately.
 *
 * ⛔ **HTTPS only, and nothing but an origin survives.** A desktop token authorises spawning
 * processes on the host, so it never travels over plain HTTP — a `http://` address is refused here,
 * before a code is spent on it. A path or query on the pasted address is dropped rather than trusted.
 */
export function parseDesktopPairing(address: string, code?: string): DesktopPairingInput | { error: string } {
  const trimmed = address.trim()
  if (!trimmed) return { error: 'Paste the pairing link, or type the address shown on the other computer.' }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return { error: 'That is not an address.' }
  }
  if (url.protocol !== 'https:') {
    return { error: 'A remote Warmstart is reached over HTTPS only. Use the https://…ts.net address it shows.' }
  }
  const fromLink = new URLSearchParams(url.hash.replace(/^#[^?]*\?/, '')).get('code')
  const chosen = (code?.trim() || fromLink || '').toUpperCase()
  if (!/^[0-9A-Z]{8}$/.test(chosen)) {
    return { error: 'Enter the eight-character pairing code shown on the other computer.' }
  }
  return { origin: url.origin, code: chosen }
}

/** The link the host shows for a desktop to paste. A phone app opening it finds no such route. */
export function desktopPairingLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/#/desktop-pair?code=${encodeURIComponent(code)}`
}
