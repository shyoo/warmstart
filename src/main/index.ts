import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type AppInfo, type DaemonUiStatus, type UiSettings } from '@shared/ipc.js'
import type { DaemonEvent, RpcMethod } from '@shared/protocol.js'
import { DaemonClient, daemonScriptPath, type DaemonStatus } from './daemon.js'
import { DEFAULT_UI_SETTINGS, readUiSettings, writeUiSettings } from './uisettings.js'
import { dataDir } from '../daemon/paths.js'

const dirname = join(fileURLToPath(import.meta.url), '..')

/**
 * Electron main is a window host and the daemon's only client.
 *
 * The scheduler, the PTYs, the SQLite store and the MCP server all live in `orchestratord`
 * (src/daemon) so that closing this window stops nothing. Native modules stay out of here for the
 * same reason: an Electron upgrade must not be able to break a running fleet.
 */

const daemon = new DaemonClient()
const windows = new Set<WebContents>()

let uiSettings: UiSettings = { ...DEFAULT_UI_SETTINGS }
let tray: Tray | null = null

/**
 * ⛔ The difference between *the window closed* and *the app is quitting*.
 *
 * With a tray, closing the window hides it. So `close` has to be intercepted - and something has
 * to tell the interception that this particular close is the real one, or Quit would hide the
 * window and leave the app running with no way to reach it and no way out.
 */
let quitting = false

/**
 * ⛔ **A window the test suite drives but nobody looks at.**
 *
 * L3 runs the real app over the DevTools protocol, which is the whole point of it — a hidden window
 * still loads the renderer, still runs React, and still computes layout, so `innerText` and
 * `getBoundingClientRect` answer exactly as they do on screen. What it must *not* do is open a
 * 1440x900 window on the operator's desktop and take the focus off whatever they were typing into,
 * several times per suite, on a machine that is also running agents.
 *
 * ⚠️ **Read once, at the show sites only.** Nothing else about the app changes: the daemon starts,
 * the IPC is wired, the tray setting is honoured. A headless mode that also skipped work would be
 * testing a different application from the one that ships.
 *
 * ⛔ Never `app.isPackaged`-derived or NODE_ENV-derived. `npm run dev` must open a window, and the
 * packaging suite launches the *packaged* binary, so the only thing that can distinguish a test run
 * is the test saying so.
 */
const headless = process.env.MULTI_AGENT_CONTROLLER_HEADLESS === '1'

// Electron's default userData is `<appdata>/multi_agent_controller`, which is exactly where the fleet database
// lives - so Chromium's caches would sit next to it, and anyone clearing a cache directory could
// take the fleet with it. Give the UI its own subdirectory. Must run before `app.whenReady`.
app.setPath('userData', join(dataDir(), 'ui'))

// ⛔ Single instance lock: launching the app while an instance is already running (e.g. in tray)
// must focus the existing window immediately and exit, rather than starting a duplicate process
// that collides on userData and waits 20s for an existing orchestratord lock.
if (!headless) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      showWindow()
    })
  }
}

// This app has no menu-driven features, so the default File/Edit/View/Window bar Electron
// generates automatically is just noise. Windows/Linux lose the bar entirely; macOS keeps its
// required minimal app menu (Quit, etc.) since the OS enforces one.
Menu.setApplicationMenu(null)

function toUiStatus(status: DaemonStatus): DaemonUiStatus {
  switch (status.state) {
    case 'connected':
      return {
        state: 'connected',
        pid: status.endpoint.pid,
        port: status.endpoint.port,
        version: status.endpoint.version,
        connectedAt: status.connectedAt
      }
    case 'error':
      return { state: 'error', message: status.message }
    default:
      return { state: status.state }
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of windows) {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
}

/**
 * The window icon, which only Linux needs from us.
 *
 * ⚠️ Windows reads the icon compiled into the .exe and macOS reads the bundle's `.icns`; on Linux
 * neither exists, so a `BrowserWindow` with no `icon` gets Electron's default in the task switcher
 * even though the .desktop entry is correct. Shipped via `extraResources` because `files:` carries
 * only `out/`, so `resources/icon.png` is not otherwise inside the app.
 */
function windowIcon(): string | undefined {
  if (process.platform !== 'linux') return undefined
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(dirname, '..', '..', 'resources', 'icon.png')
}

/**
 * The window, whether it exists or not.
 *
 * ⚠️ `getAllWindows()[0]` rather than a module-level handle: the window can be closed and recreated
 * (macOS `activate`, and the tray's Open), and a stale reference to a destroyed BrowserWindow throws
 * from inside Electron the moment anything reads a property off it - the same failure the `closed`
 * handler below is already careful about.
 */
function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function showWindow(): void {
  const win = mainWindow()
  if (!win) {
    createWindow()
    return
  }
  // ⚠️ Headless: the window exists and is driven, so "show it" is honoured as far as it can be —
  // everything except putting it on the screen and taking the focus.
  if (headless) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Quit for real: stop the daemon first, then let Electron go.
 *
 * ⛔ **Asked, never killed.** The daemon shuts itself down over its own RPC - it stops the loops,
 * closes the sessions, releases the lock and clears the endpoint file. Reading `orchestratord.json`
 * for a pid and killing it would be the one thing AGENTS.md forbids outright, and it would leave a
 * lock file and a half-written database behind besides.
 *
 * ⚠️ **Shutting the daemon down ends every running agent.** So when any work is in flight this asks
 * a person first. A quit that silently discards an hour of an agent's context because a window was
 * closed is not a preference anybody set.
 */
async function stopDaemonAndQuit(): Promise<void> {
  try {
    const live = await daemon.rpc('session.list', undefined)
    const working = Array.isArray(live) ? live.filter((s) => s.purpose === 'work').length : 0
    if (working > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Stop them and quit', 'Leave them running', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        message: `${working} agent ${working === 1 ? 'session is' : 'sessions are'} still running.`,
        detail:
          'Quitting stops orchestratord, which ends them. Their work so far is saved, but the ' +
          'context each one is holding is not - a stopped session starts cold next time.\n\n' +
          'Leave them running to quit the window only. Turn the tray on if you want that to be ' +
          'the normal behaviour.'
      })
      if (response === 2) return
      if (response === 1) {
        quitting = true
        app.quit()
        return
      }
    }
    await daemon.rpc('daemon.shutdown', undefined)
  } catch {
    // ⚠️ Not reachable, or it refused. Quit anyway: an app that cannot be closed because its
    // background service is unwell is a worse failure than a daemon left running, and Doctor says
    // where to look.
  }
  quitting = true
  app.quit()
}

/**
 * ⛔ Drawn, not shipped. The tray needs a small square icon and `resources/icon.png` is a 512px app
 * icon; scaling it down per platform is more moving parts than one path can carry. A generated mark
 * is legible at 16px, matches the accent, and cannot go missing from a package.
 */
function trayImage(): Electron.NativeImage {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<rect x="3" y="6" width="26" height="6" rx="3" fill="#7aa2f7"/>' +
    '<rect x="3" y="14" width="18" height="6" rx="3" fill="#7aa2f7" opacity="0.75"/>' +
    '<rect x="3" y="22" width="10" height="6" rx="3" fill="#7aa2f7" opacity="0.5"/>' +
    '</svg>'
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
}

function applyTraySetting(): void {
  if (uiSettings.tray && !tray) {
    tray = new Tray(trayImage())
    tray.setToolTip('Multi Agent Controller')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Multi Agent Controller', click: () => showWindow() },
        { type: 'separator' },
        // ⚠️ Says what it does. "Quit" beside a tray icon reads as "close the tray", and the one
        // thing an operator must not discover by accident is that it also stopped the scheduler.
        { label: 'Quit and stop the daemon', click: () => void stopDaemonAndQuit() }
      ])
    )
    // The ordinary gesture on Windows and Linux; macOS opens the menu on click by convention.
    tray.on('click', () => showWindow())
    return
  }
  if (!uiSettings.tray && tray) {
    tray.destroy()
    tray = null
  }
}

function createWindow(): BrowserWindow {
  const icon = windowIcon()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(icon ? { icon } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    // Matches --color-bg in tokens.css so the window does not flash white before paint.
    backgroundColor: '#0e1013',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (!headless) {
    win.once('ready-to-show', () => win.show())
  }

  // ⛔ Capture the WebContents now; do not read `win.webContents` from the `closed` handler.
  //
  // By the time `closed` fires the native object is gone, and *reading the property* throws
  // `Object has been destroyed` from inside Electron's own emit - which surfaces to the user as
  // "A JavaScript error occurred in the main process" when they close the window. The Set is keyed
  // by this reference, so holding it is also the only way the delete can match.
  const wc = win.webContents
  windows.add(wc)
  win.on('closed', () => windows.delete(wc))

  // ⛔ Only with a tray, and only when this is not the quit itself. Without the `quitting`
  // guard, Quit would hide the window and leave an app nobody can reach or exit.
  win.on('close', (event) => {
    if (!uiSettings.tray || quitting) return
    event.preventDefault()
    win.hide()
  })

  // Never navigate the shell itself; external links go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(dirname, '../renderer/index.html'))
  }

  return win
}

void app.whenReady().then(() => {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      name: 'Multi Agent Controller',
      version: app.getVersion(),
      platform: process.platform
    })
  )

  ipcMain.handle(IPC.daemonStatus, (): DaemonUiStatus => toUiStatus(daemon.getStatus()))

  ipcMain.handle(IPC.uiSettingsGet, (): UiSettings => uiSettings)

  ipcMain.handle(IPC.uiSettingsSet, (_event, patch: Partial<UiSettings>): UiSettings => {
    uiSettings = writeUiSettings({ ...uiSettings, ...patch })
    // ⚠️ Applied immediately. A tray toggle that needed a restart to take effect would be
    // indistinguishable from one that did not work.
    applyTraySetting()
    return uiSettings
  })

  ipcMain.handle(IPC.daemonStart, async (): Promise<DaemonUiStatus> => {
    return toUiStatus(await daemon.ensure(daemonScriptPath(dirname)))
  })

  // The renderer names a method; it never names a host, a port or a token.
  ipcMain.handle(IPC.rpc, (_event, method: RpcMethod, params: unknown) =>
    daemon.rpc(method, params as never)
  )

  daemon.on('status', (status: DaemonStatus) => broadcast(IPC.statusPush, toUiStatus(status)))
  daemon.on('event', (event: DaemonEvent) => broadcast(IPC.eventPush, event))

  uiSettings = readUiSettings()
  applyTraySetting()
  createWindow()

  // Start the daemon in the background: the window should paint immediately and fill in, not wait.
  void daemon.ensure(daemonScriptPath(dirname))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // With a tray, the window is hidden rather than closed, so reaching here at all means there is
  // no tray to get back from - and then closing the window has to mean what it looks like it
  // means. ⛔ Leaving a detached scheduler running with no window and no icon is how an operator
  // ends up hunting a pid to get their machine back.
  if (uiSettings.tray) return
  if (process.platform !== 'darwin') void stopDaemonAndQuit()
})

// macOS: the app stays alive with no windows, so this is the only path Cmd-Q takes.
app.on('before-quit', () => {
  quitting = true
  daemon.dispose()
})
