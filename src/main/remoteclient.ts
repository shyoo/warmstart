import { EventEmitter } from 'node:events'
import WebSocket, { type RawData } from 'ws'
import type { DaemonEvent, RpcMethod, RpcParams, RpcResponse, RpcResult } from '@shared/protocol.js'
import {
  RPC_VERSION,
  RPC_VERSION_HEADER,
  negotiateRpcVersion,
  type RemoteHello,
  type RpcNegotiation
} from '@shared/rpcversion.js'
import { errorMessage } from '@shared/errors.js'

/**
 * Main's client for **another computer's** Warmstart, over that computer's remote listener.
 *
 * The same two jobs `DaemonClient` does for this computer's daemon — answer `rpc` and relay events —
 * with three differences that are the point of it: every byte goes over HTTPS/WSS to a tailnet
 * hostname with a real certificate; the credential is a revocable per-device token rather than the
 * loopback token; and before anything else the two ends agree on a protocol version.
 */

export type RemoteClientState =
  | { state: 'connecting' }
  | { state: 'connected'; appVersion: string; rpcVersion: number; remoteNeedsUpgrade: boolean; connectedAt: number }
  | { state: 'refused'; message: string; appVersion: string | null }
  | { state: 'error'; message: string }
  | { state: 'disconnected' }

/** The last value repeats. Reconnecting re-runs the handshake, so a remote that upgraded is re-negotiated. */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const
const HELLO_TIMEOUT_MS = 10_000

type FetchLike = typeof fetch

function frameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

/** Read what a remote says about itself, and whether this app can talk to it. */
export async function helloRemote(origin: string, fetchImpl: FetchLike = fetch): Promise<{ hello: RemoteHello; negotiation: RpcNegotiation }> {
  let res: Response
  try {
    res = await fetchImpl(`${origin}/remote/hello`, { signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(unreachable(origin, err), { cause: err })
  }
  if (res.status === 404) {
    // An older Warmstart serves its phone shell for every unknown path, which is HTML, not a 404 —
    // but a 404 still means the same thing: nothing there speaks this protocol.
    throw new Error(`${origin} is not a Warmstart that accepts desktops. Upgrade Warmstart on that computer.`)
  }
  const body = (await res.json().catch(() => null)) as Partial<RemoteHello> | null
  if (!res.ok || !body || body.app !== 'warmstart') {
    throw new Error(`${origin} did not answer as a Warmstart that accepts desktops. Check the address, and upgrade Warmstart on that computer.`)
  }
  const hello: RemoteHello = { app: 'warmstart', appVersion: String(body.appVersion ?? 'unknown'), rpc: body.rpc as RemoteHello['rpc'] }
  return { hello, negotiation: negotiateRpcVersion(RPC_VERSION, hello.rpc) }
}

/**
 * Spend a desktop pairing code.
 *
 * ⚠️ The handshake comes first, so a pair that could never talk refuses before the code is used up.
 */
export async function pairRemote(
  input: { origin: string; code: string; deviceLabel: string },
  fetchImpl: FetchLike = fetch
): Promise<{ token: string; deviceId: string; hello: RemoteHello }> {
  const { hello, negotiation } = await helloRemote(input.origin, fetchImpl)
  if (!negotiation.ok) throw new Error(negotiation.reason)
  let res: Response
  try {
    res = await fetchImpl(`${input.origin}/remote/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code, label: input.deviceLabel, kind: 'desktop' }),
      signal: AbortSignal.timeout(HELLO_TIMEOUT_MS)
    })
  } catch (err) {
    throw new Error(unreachable(input.origin, err), { cause: err })
  }
  const body = (await res.json().catch(() => null)) as { token?: string; deviceId?: string; kind?: string; error?: string } | null
  if (res.status === 401) throw new Error('That pairing code was not accepted. Codes work once and last two minutes — generate a new one.')
  if (res.status === 429) throw new Error('Too many pairing attempts from this computer. Wait a minute and try again.')
  if (!res.ok || !body?.token || !body.deviceId) throw new Error(body?.error ?? `pairing failed with HTTP ${res.status}`)
  // ⛔ A server that minted anything but a desktop credential is not one this client will keep.
  if (body.kind !== 'desktop') throw new Error('The remote did not issue a desktop credential. Upgrade Warmstart on that computer.')
  return { token: body.token, deviceId: body.deviceId, hello }
}

function unreachable(origin: string, err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause
  const inner = cause instanceof AggregateError ? (cause.errors[0] as unknown) : cause
  const code = (inner as { code?: unknown })?.code
  const detail = typeof code === 'string' ? code : inner instanceof Error ? inner.message : errorMessage(err)
  return `Could not reach ${origin} (${detail}). Both computers must be signed in to the same tailnet, and Warmstart must be running there.`
}

export class RemoteClient extends EventEmitter {
  private status: RemoteClientState = { state: 'disconnected' }
  private socket: WebSocket | null = null
  private timer: NodeJS.Timeout | null = null
  private attempt = 0
  private disposed = false
  private nextId = 1
  /** Bumped by every connect, so a slow handshake from a superseded attempt cannot attach. */
  private generation = 0

  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    super()
  }

  getStatus(): RemoteClientState {
    return this.status
  }

  private setStatus(status: RemoteClientState): void {
    this.status = status
    this.emit('status', status)
  }

  private headers(version: number): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, [RPC_VERSION_HEADER]: String(version) }
  }

  /** Handshake, prove the credential, open the event socket. Safe to call again at any time. */
  async connect(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.closeSocket()
    this.setStatus({ state: 'connecting' })
    try {
      const { hello, negotiation } = await helloRemote(this.origin, this.fetchImpl)
      if (generation !== this.generation || this.disposed) return
      if (!negotiation.ok) {
        // ⛔ Terminal until something changes: retrying cannot make two protocol ranges overlap.
        this.setStatus({ state: 'refused', message: negotiation.reason, appVersion: hello.appVersion })
        return
      }
      const health = await this.fetchImpl(`${this.origin}/remote/health`, {
        headers: this.headers(negotiation.version),
        signal: AbortSignal.timeout(HELLO_TIMEOUT_MS)
      })
      if (generation !== this.generation || this.disposed) return
      if (health.status === 401) {
        this.setStatus({ state: 'refused', message: 'That computer no longer recognises this one — its pairing was revoked there. Forget it here and pair again.', appVersion: hello.appVersion })
        return
      }
      if (health.status === 403) {
        const body = (await health.json().catch(() => null)) as { error?: string } | null
        this.setStatus({ state: 'error', message: `That computer refused the connection: ${body?.error ?? 'forbidden'}. Turn on Allow paired desktops there.` })
        this.scheduleReconnect()
        return
      }
      if (!health.ok) throw new Error(`the remote answered HTTP ${health.status}`)
      this.openSocket(generation, hello.appVersion, negotiation.version, negotiation.remoteNeedsUpgrade)
    } catch (err) {
      if (generation !== this.generation || this.disposed) return
      this.setStatus({ state: 'error', message: errorMessage(err) })
      this.scheduleReconnect()
    }
  }

  private openSocket(generation: number, appVersion: string, rpcVersion: number, remoteNeedsUpgrade: boolean): void {
    const url = `${this.origin.replace(/^https:/, 'wss:')}/remote/events`
    const ws = new WebSocket(url, { headers: this.headers(rpcVersion) })
    this.socket = ws
    ws.on('open', () => {
      if (generation !== this.generation) return
      this.attempt = 0
      this.setStatus({ state: 'connected', appVersion, rpcVersion, remoteNeedsUpgrade, connectedAt: Date.now() })
    })
    ws.on('message', (raw) => {
      try {
        this.emit('event', JSON.parse(frameText(raw)) as DaemonEvent)
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    })
    ws.on('close', () => {
      if (generation !== this.generation || this.disposed) return
      this.socket = null
      if (this.status.state === 'connected') this.setStatus({ state: 'error', message: 'The connection to that computer dropped. Reconnecting…' })
      this.scheduleReconnect()
    })
    ws.on('error', (err) => {
      // 'close' follows; say why first, so the status is not a bare "dropped".
      if (generation === this.generation && this.status.state !== 'connected') this.setStatus({ state: 'error', message: errorMessage(err) })
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.timer) return
    const wait = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, wait)
    this.timer.unref?.()
  }

  async rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
    const status = this.status
    if (status.state !== 'connected') {
      throw new Error(status.state === 'refused' || status.state === 'error' ? status.message : `not connected to ${this.origin}`)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.origin}/remote/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers(status.rpcVersion) },
        body: JSON.stringify({ id: this.nextId++, method, params })
      })
    } catch (err) {
      throw new Error(`could not reach ${this.origin} for '${method}': ${unreachable(this.origin, err)}`, { cause: err })
    }
    const body = (await res.json().catch(() => null)) as (RpcResponse & { error?: unknown }) | { error?: string } | null
    if (res.status === 426) {
      // The remote changed version under a live connection: re-negotiate rather than keep failing.
      void this.connect()
      throw new Error(`${this.origin} was upgraded and no longer speaks this protocol version. Reconnecting…`)
    }
    if (res.status === 401) {
      void this.connect()
      throw new Error('That computer no longer recognises this one.')
    }
    if (!res.ok) {
      const message = body && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`
      throw new Error(`${this.origin} refused '${method}': ${message}`)
    }
    const rpcBody = body as RpcResponse
    if (!rpcBody.ok) throw new Error(rpcBody.error.message)
    return rpcBody.result as RpcResult<M>
  }

  private closeSocket(): void {
    const ws = this.socket
    this.socket = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => undefined)
      ws.close()
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.closeSocket()
    this.removeAllListeners()
  }
}
