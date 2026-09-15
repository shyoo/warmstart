import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import WebSocket, { type RawData } from 'ws'
import type {
  DaemonEndpoint,
  DaemonEvent,
  RpcMethod,
  RpcParams,
  RpcResponse,
  RpcResult
} from '@shared/protocol.js'
import { readEndpoint } from '../daemon/lock.js'
import { augmentPath } from '../daemon/which.js'
import { errorMessage } from '@shared/errors.js'

/**
 * The Electron side of the daemon relationship.
 *
 * Two jobs: make sure an orchestratord exists, and be the only thing that talks to it. The renderer
 * goes through IPC and never learns the port or the token - see AGENTS.md.
 *
 * Attaching to a daemon this app did not start is the normal case, not an edge case: the fleet is
 * supposed to outlive the window.
 */

export type DaemonStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'connected'; endpoint: Omit<DaemonEndpoint, 'token'>; connectedAt: number }
  | { state: 'error'; message: string }

const STARTUP_TIMEOUT_MS = 20_000

/**
 * How long to wait before trying the whole `ensure` again, per consecutive failure.
 *
 * ⛔ **A startup that times out must not be a dead end.** `ensure` used to set `state: 'error'` and
 * stop there, and nothing else could ever call it again: `scheduleReconnect` is wired to the
 * WebSocket `close` event, and on this path no socket was ever opened. One slow start - a cold
 * 244MB unsigned binary being scanned, a 37MB database opening, or a spawn refused because the
 * previous daemon still held the lock - left the window disconnected until the operator quit and
 * relaunched. The renderer compounds it: `refreshProjects` returns early on `if (!connected)` and
 * is only re-run when `connected` changes, so the fleet stayed empty with no way back.
 *
 * ⚠️ Backs off rather than hammering. Each attempt may spawn another daemon, and while the lock
 * makes a duplicate exit harmlessly, spawning a process every two seconds forever is not a cost
 * worth paying to recover from something that is usually over within one retry. The last value
 * repeats, so it settles into a slow poll instead of giving up.
 */
const ENSURE_RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const

/**
 * The text of one WebSocket frame.
 *
 * ⚠️ `ws` hands a message over as `Buffer | ArrayBuffer | Buffer[]` - which of the three depends on
 * how the frame arrived, not on anything this end chose. Only the first survives `String()`; the
 * other two become "[object ArrayBuffer]" and a comma-joined mess, and `JSON.parse` then throws
 * into a deliberately silent catch. The event is simply lost, with nothing to read afterwards.
 */
function frameText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

export class DaemonClient extends EventEmitter {
  private endpoint: DaemonEndpoint | null = null
  private socket: WebSocket | null = null
  private nextId = 1
  private status: DaemonStatus = { state: 'stopped' }
  private reconnectTimer: NodeJS.Timeout | null = null
  private disposed = false
  /** Remembered so a retry can spawn without the caller being around to pass it again. */
  private daemonScript: string | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryAttempt = 0

  getStatus(): DaemonStatus {
    return this.status
  }

  private setStatus(status: DaemonStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /** Attach to a running daemon, or start one and wait for it to answer. */
  async ensure(daemonScript: string): Promise<DaemonStatus> {
    this.daemonScript = daemonScript
    if (this.status.state === 'connected') return this.status
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.setStatus({ state: 'starting' })

    const existing = readEndpoint()
    if (existing && (await this.alive(existing))) {
      this.attach(existing)
      return this.status
    }

    if (!existsSync(daemonScript)) {
      const message = `orchestratord build missing at ${daemonScript} - run npm run build`
      this.setStatus({ state: 'error', message })
      return this.status
    }

    // ELECTRON_RUN_AS_NODE turns this same binary into a plain Node process, so a packaged app needs
    // no system Node and native modules match the ABI already shipped. detached + unref is what lets
    // the fleet outlive the window that started it.
    const child = spawn(process.execPath, [daemonScript], {
      env: { ...process.env, PATH: augmentPath(process.env.PATH), ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(250)
      const published = readEndpoint()
      if (published && published.pid !== existing?.pid && (await this.alive(published))) {
        this.attach(published)
        return this.status
      }
    }

    // ⚠️ Still `error`, because it still is not connected and the UI must say so - but no longer
    // final. The retry is what turns "quit and relaunch" back into "wait a moment".
    this.setStatus({
      state: 'error',
      message: `orchestratord did not answer within ${STARTUP_TIMEOUT_MS / 1000}s - retrying`
    })
    this.scheduleEnsureRetry()
    return this.status
  }

  /**
   * Try `ensure` again after a backoff, until it connects or the app goes away.
   *
   * ⛔ Never while connected, and never twice at once: a second timer would double the spawn rate
   * on every failure and the two would drift apart.
   */
  private scheduleEnsureRetry(): void {
    const script = this.daemonScript
    if (this.disposed || this.retryTimer || !script) return
    const wait =
      ENSURE_RETRY_BACKOFF_MS[Math.min(this.retryAttempt, ENSURE_RETRY_BACKOFF_MS.length - 1)]
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed || this.status.state === 'connected') return
      void this.ensure(script)
    }, wait)
    // Timers must not hold the process open on their own: quitting mid-backoff should quit.
    this.retryTimer.unref?.()
  }

  private async alive(endpoint: DaemonEndpoint): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
        headers: { authorization: `Bearer ${endpoint.token}` },
        signal: AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private attach(endpoint: DaemonEndpoint): void {
    this.endpoint = endpoint
    // A success clears the backoff, so the next bad start gets the fast retry rather than the slow
    // one this session happened to end on.
    this.retryAttempt = 0
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const { token: _token, ...safe } = endpoint
    this.setStatus({ state: 'connected', endpoint: safe, connectedAt: Date.now() })
    this.connectEvents()
  }

  private connectEvents(): void {
    if (!this.endpoint || this.disposed) return
    const { port, token } = this.endpoint
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, {
      headers: { authorization: `Bearer ${token}` }
    })
    this.socket = ws

    ws.on('message', (raw) => {
      try {
        this.emit('event', JSON.parse(frameText(raw)) as DaemonEvent)
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    })
    ws.on('close', () => this.scheduleReconnect())
    ws.on('error', () => {
      // 'close' always follows; reconnecting is handled there.
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.revalidate()
    }, 2000)
  }

  /** The daemon may have restarted on a new port. Re-read the endpoint before reconnecting. */
  private async revalidate(): Promise<void> {
    const published = readEndpoint()
    if (published && (await this.alive(published))) {
      this.endpoint = published
      const { token: _token, ...safe } = published
      this.setStatus({ state: 'connected', endpoint: safe, connectedAt: Date.now() })
      this.connectEvents()
    } else {
      this.setStatus({ state: 'stopped' })
      this.scheduleReconnect()
    }
  }

  async rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
    if (!this.endpoint) throw new Error('orchestratord is not connected')
    const startedAt = Date.now()
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.endpoint.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.endpoint.token}`
        },
        body: JSON.stringify({ id: this.nextId++, method, params })
      })
    } catch (err) {
      // ⛔ **`fetch` reports every transport fault as the same three words**, and the renderer showed
      // them raw: *"Error invoking remote method 'daemon:rpc': TypeError: fetch failed"* told an
      // operator neither which call broke nor whether the daemon was down, slow or had dropped the
      // socket — three problems with three different answers. The cause is one property away and
      // was being discarded. See `applyLoopbackTimeouts` for the fault this was hiding.
      throw new Error(transportFailure(method, err, Date.now() - startedAt), { cause: err })
    }
    if (!res.ok) throw new Error(`orchestratord returned HTTP ${res.status}`)
    const body = (await res.json()) as RpcResponse
    if (!body.ok) throw new Error(body.error.message)
    return body.result as RpcResult<M>
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.socket?.close()
    this.socket = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * What to say when the call never reached an answer.
 *
 * ⚠️ **The method, the cause and how long it waited — all three, because each one changes what the
 * operator should do.** `ECONNREFUSED` is a daemon that is not there and the Start button is the
 * answer; `ECONNRESET` after two seconds is a dropped keep-alive socket and retrying is; a headers
 * timeout after five minutes is a daemon that is alive and overloaded, and neither of those helps.
 * ⛔ Never invents a diagnosis: an error whose cause carries no `code` is reported by its message,
 * and one that carries neither is reported as unexplained rather than guessed at.
 */
export function transportFailure(method: string, err: unknown, elapsedMs: number): string {
  const cause = (err as { cause?: unknown })?.cause
  // undici nests: `TypeError: fetch failed` → cause `Error { code }`, or an `AggregateError` whose
  // `errors[0]` carries the code (that is the shape a refused connect arrives in).
  const inner =
    cause instanceof AggregateError ? (cause.errors[0] as unknown) : cause
  const code = (inner as { code?: unknown })?.code
  const detail =
    typeof code === 'string' && code
      ? code
      : inner instanceof Error && inner.message
        ? inner.message
        : errorMessage(err)
  return `could not reach orchestratord for '${method}' after ${Math.round(elapsedMs / 1000)}s (${detail})`
}

/** Where electron-vite puts the daemon bundle, next to the main process bundle. */
export function daemonScriptPath(mainDir: string): string {
  return join(mainDir, 'orchestratord.js')
}
