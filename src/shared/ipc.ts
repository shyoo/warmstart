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

/** The update file is downloaded and checksum-verified, never installed by Warmstart itself. */
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'downloading' | 'downloaded' | 'unavailable' | 'error'

export interface AppUpdateState {
  phase: UpdatePhase
  currentVersion: string
  version: string | null
  assetName: string | null
  downloadedBytes: number
  totalBytes: number | null
  message: string | null
}

export type EnterBehavior = 'send' | 'newline'
export type ThemePreference = 'system' | 'light' | 'dark'

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

  /** The colour scheme for this window; System follows prefers-color-scheme live. */
  theme: ThemePreference

  /**
   * Raise an OS notification when a task wants a person, finishes, or fails.
   *
   * ⛔ **The setting the pitch already promised.** "File a task and walk away" is only true if
   * something comes and gets you: with the window behind other work — or hidden to the tray, which
   * `tray` above makes the ordinary case — the approval strip and the questions list are only seen
   * by somebody already looking at them.
   *
   * ⚠️ A *window* preference and not a fleet one, which is why it is here and not in `Settings`:
   * two machines attached to one daemon should not have to agree about whether this one beeps.
   */
  notifications: boolean
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  tray: false,
  enterBehavior: 'send',
  theme: 'system',
  // ⚠️ On by default. The whole point is the person who walked away, and a notification setting
  // nobody found is the same as not having built it.
  notifications: true
}

/** What a notification says, and where clicking it goes. */
export interface NotifyRequest {
  title: string
  body: string
  /** The task to open when the notification is clicked. */
  taskId: string
}

export type DaemonUiStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'connected'; pid: number; port: number; version: string; connectedAt: number }
  | { state: 'error'; message: string }

export interface AgentyardApi {
  getAppInfo(): Promise<AppInfo>
  getUpdateStatus(): Promise<AppUpdateState>
  /** Opens the folder containing a checksum-verified installer. Never runs it. */
  showDownloadedUpdate(): Promise<boolean>
  onUpdateStatus(handler: (status: AppUpdateState) => void): () => void
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
  /**
   * Raise an OS notification. Resolves `false` when the platform cannot show one.
   *
   * ⛔ The renderer decides *when*, because it is the process that already has the fleet state; main
   * decides *whether it can* and owns the window it would raise. Neither half is useful alone.
   */
  notify(request: NotifyRequest): Promise<boolean>
  /** A notification was clicked: open this task. */
  onNotificationActivate(handler: (taskId: string) => void): () => void
}

export const IPC = {
  appInfo: 'app:info',
  updateStatus: 'app:update-status',
  updateShowDownloaded: 'app:update-show-downloaded',
  updatePush: 'app:update-push',
  daemonStatus: 'daemon:status',
  daemonStart: 'daemon:start',
  rpc: 'daemon:rpc',
  statusPush: 'daemon:status-push',
  eventPush: 'daemon:event-push',
  uiSettingsGet: 'ui:settings-get',
  uiSettingsSet: 'ui:settings-set',
  pickFolders: 'attachment:pick-folders',
  notify: 'ui:notify',
  notificationActivate: 'ui:notification-activate'
} as const
