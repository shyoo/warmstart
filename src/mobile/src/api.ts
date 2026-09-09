import type { DaemonEvent, RpcMethod, RpcParams, RpcResult } from '@shared/protocol'
import { createTokenStore, isPairingFailure, type TokenStorage, type TokenStore } from './lib/auth.js'

/**
 * The phone app's only way to reach the daemon: `POST /remote/rpc` with the device token, and
 * `GET /remote/events` over a WebSocket for live refresh.
 *
 * ⛔ Typed end to end against `RpcMap`: a renamed RPC still fails the build here, and a method
 * the remote policy denies is a 403 — a bug in the caller, never retried, never worked around.
 */
export class RemoteError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'RemoteError'
    this.status = status
  }
}

function browserStorage(): TokenStorage {
  const storage = (globalThis as Record<string, unknown>).localStorage as TokenStorage | undefined
  if (storage) return storage
  // ⛔ Import-time only: the module must load where there is no DOM (vitest runs in node), so
  // outside a browser the token lives in memory for the life of the import instead.
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  }
}

export const store: TokenStore = createTokenStore(browserStorage())

let listeners: Array<() => void> = []
export function onAuthChange(listener: () => void): () => void {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function pairedOut(): never {
  store.clear()
  for (const l of listeners) l()
  throw new RemoteError('This device is no longer paired. Pair again to continue.', 401)
}

async function post(path: string, body: unknown, token: string | null): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    })
  } catch {
    throw new RemoteError('The daemon did not answer. Check the address and that remote access is on.', null)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new RemoteError(`The daemon answered ${res.status} with no JSON body.`, res.status)
  }
  return { status: res.status, json }
}

/** Redeem a pairing code. The token is stored and never returned to any screen. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const { status, json } = await post('/remote/pair', { code: code.trim(), label: label.trim() || 'Phone' }, null)
  if (status === 401) throw new RemoteError('That code was not accepted. Make a fresh one on the desktop.', 401)
  if (status === 429) throw new RemoteError('Too many attempts — wait a minute and try again.', 429)
  if (status !== 200 || typeof json !== 'object' || json === null || !('token' in json)) {
    throw new RemoteError('Pairing failed. Make a fresh code on the desktop and try again.', status)
  }
  store.set(String(json.token))
}

export async function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const token = store.get()
  if (!token) pairedOut()
  const { status, json } = await post('/remote/rpc', { id: `m${Date.now().toString(36)}`, method, params }, token)
  if (isPairingFailure(status)) pairedOut()
  if (status === 403) throw new RemoteError(`The daemon refuses '${method}' over remote access.`, 403)
  if (status !== 200 || typeof json !== 'object' || json === null) {
    throw new RemoteError(`The daemon answered ${status}.`, status)
  }
  const body = json as { ok?: boolean; result?: unknown; error?: { message?: string } }
  if (body.ok !== true) throw new RemoteError(body.error?.message ?? 'The daemon refused the call.', status)
  return body.result as RpcResult<M>
}

const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000]

/**
 * The live refresh socket. Reconnects with backoff after any drop — the pattern from
 * `src/main/daemon.ts`, minus the endpoint re-read: this app has exactly one address, the one
 * that served it. Callers refresh on `question.opened`, `approval.opened`, `task.changed` and
 * `quota.changed`; anything else is ignored here.
 */
export type EventsStatus = 'connecting' | 'live' | 'retrying'

export function connectEvents(options: {
  onEvent: (event: DaemonEvent) => void
  onStatus?: (status: EventsStatus) => void
}): () => void {
  const { onEvent, onStatus } = options
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = (): void => {
    if (closed) return
    const token = store.get()
    if (!token) return
    onStatus?.(attempt === 0 ? 'connecting' : 'retrying')
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    // ⛔ The token travels in the query because browsers cannot set headers on a WebSocket
    // handshake; the server reads the header first where both are present.
    ws = new WebSocket(`${scheme}://${location.host}/remote/events?token=${encodeURIComponent(token)}`)
    ws.onmessage = (message) => {
      try {
        onEvent(JSON.parse(String(message.data)) as DaemonEvent)
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    }
    ws.onopen = () => {
      attempt = 0
      onStatus?.('live')
    }
    ws.onclose = () => {
      ws = null
      if (closed || !store.get()) return
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
      attempt += 1
      timer = setTimeout(connect, delay)
    }
    ws.onerror = () => {
      // 'close' always follows; reconnecting is handled there.
    }
  }
  connect()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    ws?.close()
    ws = null
  }
}
