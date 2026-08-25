import { app, BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type AppInfo, type DaemonUiStatus } from '@shared/ipc.js'
import type { DaemonEvent, RpcMethod } from '@shared/protocol.js'
import { DaemonClient, daemonScriptPath, type DaemonStatus } from './daemon.js'
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

// Electron's default userData is `<appdata>/agentyard`, which is exactly where the fleet database
// lives - so Chromium's caches would sit next to it, and anyone clearing a cache directory could
// take the fleet with it. Give the UI its own subdirectory. Must run before `app.whenReady`.
app.setPath('userData', join(dataDir(), 'ui'))

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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

  win.once('ready-to-show', () => win.show())
  windows.add(win.webContents)
  win.on('closed', () => windows.delete(win.webContents))

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

app.whenReady().then(() => {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      name: 'agentyard',
      version: app.getVersion(),
      platform: process.platform
    })
  )

  ipcMain.handle(IPC.daemonStatus, (): DaemonUiStatus => toUiStatus(daemon.getStatus()))

  ipcMain.handle(IPC.daemonStart, async (): Promise<DaemonUiStatus> => {
    return toUiStatus(await daemon.ensure(daemonScriptPath(dirname)))
  })

  // The renderer names a method; it never names a host, a port or a token.
  ipcMain.handle(IPC.rpc, (_event, method: RpcMethod, params: unknown) =>
    daemon.rpc(method, params as never)
  )

  daemon.on('status', (status: DaemonStatus) => broadcast(IPC.statusPush, toUiStatus(status)))
  daemon.on('event', (event: DaemonEvent) => broadcast(IPC.eventPush, event))

  createWindow()

  // Start the daemon in the background: the window should paint immediately and fill in, not wait.
  void daemon.ensure(daemonScriptPath(dirname))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Closing the window ends the UI only. orchestratord keeps running, which is the entire point of
  // the split: quota windows are hours long and progress should not depend on a window being open.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => daemon.dispose())
