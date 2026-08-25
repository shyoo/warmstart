import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppInfo } from '@shared/ipc'

const dirname = join(fileURLToPath(import.meta.url), '..')

/**
 * Electron main is a window host and nothing more.
 *
 * The scheduler, the PTYs, the SQLite store and the MCP server all live in `orchestratord`
 * (M1, src/daemon) so that closing this window stops nothing. Native modules stay out of here
 * for the same reason: an Electron upgrade must not be able to break a running fleet.
 */

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
  ipcMain.handle('app:info', (): AppInfo => ({
    name: 'agentyard',
    version: app.getVersion(),
    platform: process.platform,
    // M1 replaces this by reading the daemon's published endpoint file.
    daemonEndpoint: null
  }))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On Windows and Linux, closing the window quits the app — but from M1 this only ends the UI.
  // orchestratord keeps running, which is the entire point of the split.
  if (process.platform !== 'darwin') app.quit()
})
