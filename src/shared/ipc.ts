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

export type EnterBehavior = 'send' | 'newline'

/**
 * Preferences the app owns rather than the fleet.
 *
 * ⛔ Separate from `Settings` in protocol.ts on purpose. Those live in the daemon's database and
 * change what the *scheduler* does; these are read by the main process and change what the *window*
 * does - including whether closing it leaves the daemon running, which main must be able to decide
 * when the daemon is not answering.
 */
export interface UiSettings {
  /**
   * Keep a tray icon, and treat closing the window as hiding it.
   *
   * ⚠️ Also decides what quitting does to the fleet. Off: quitting asks orchestratord to shut down,
   * so nothing is left behind and there is no daemon to hunt for later. On: the daemon keeps running
   * and the tray is how you get the window back. Quit from the tray menu always stops everything.
   */
  tray: boolean

  /**
   * How the Enter key behaves in prompt and message inputs across the app.
   * - `'send'`: Pressing Enter sends the prompt immediately; Shift+Enter adds a new line.
   * - `'newline'`: Pressing Enter adds a new line; ⌘/Ctrl+Enter sends the prompt.
   */
  enterBehavior: EnterBehavior
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  tray: false,
  enterBehavior: 'send'
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
  getUiSettings(): Promise<UiSettings>
  /** ⚠️ A partial patch, and the whole object comes back - the same shape as `settings.set`. */
  setUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  pickFolders(): Promise<string[]>
}

export const IPC = {
  appInfo: 'app:info',
  daemonStatus: 'daemon:status',
  daemonStart: 'daemon:start',
  rpc: 'daemon:rpc',
  statusPush: 'daemon:status-push',
  eventPush: 'daemon:event-push',
  uiSettingsGet: 'ui:settings-get',
  uiSettingsSet: 'ui:settings-set',
  pickFolders: 'attachment:pick-folders'
} as const
