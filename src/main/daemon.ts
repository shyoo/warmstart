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

  getStatus(): DaemonStatus {
    return this.status
  }

  private setStatus(status: DaemonStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /** Attach to a running daemon, or start one and wait for it to answer. */
  async ensure(daemonScript: string): Promise<DaemonStatus> {
    if (this.status.state === 'connected') return this.status
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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

    this.setStatus({ state: 'error', message: 'orchestratord did not answer within 20s' })
    return this.status
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
    const res = await fetch(`http://127.0.0.1:${this.endpoint.port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.endpoint.token}`
      },
      body: JSON.stringify({ id: this.nextId++, method, params })
    })
    if (!res.ok) throw new Error(`orchestratord returned HTTP ${res.status}`)
    const body = (await res.json()) as RpcResponse
    if (!body.ok) throw new Error(body.error.message)
    return body.result as RpcResult<M>
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    this.socket = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Where electron-vite puts the daemon bundle, next to the main process bundle. */
export function daemonScriptPath(mainDir: string): string {
  return join(mainDir, 'orchestratord.js')
}
