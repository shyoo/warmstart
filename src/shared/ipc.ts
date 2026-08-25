import type { DaemonEvent, RpcMethod, RpcParams, RpcResult } from './protocol.js'

/**
 * The renderer's window onto the app.
 *
 * Deliberately thin, and deliberately indirect: every `rpc` call is forwarded by the main process to
 * orchestratord. The renderer holds no port and no token, because it is the surface that displays
 * untrusted agent output.
 */

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

export type DaemonUiStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'connected'; pid: number; port: number; version: string; connectedAt: number }
  | { state: 'error'; message: string }

export interface AgentyardApi {
  getAppInfo(): Promise<AppInfo>
  daemonStatus(): Promise<DaemonUiStatus>
  /** Start orchestratord if it is not already running, then attach. Safe to call repeatedly. */
  startDaemon(): Promise<DaemonUiStatus>
  rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  onDaemonStatus(handler: (status: DaemonUiStatus) => void): () => void
  onDaemonEvent(handler: (event: DaemonEvent) => void): () => void
}

export const IPC = {
  appInfo: 'app:info',
  daemonStatus: 'daemon:status',
  daemonStart: 'daemon:start',
  rpc: 'daemon:rpc',
  statusPush: 'daemon:status-push',
  eventPush: 'daemon:event-push'
} as const
