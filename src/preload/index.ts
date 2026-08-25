import { contextBridge, ipcRenderer } from 'electron'
import type { AgentyardApi, AppInfo } from '@shared/ipc'

const api: AgentyardApi = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
}

// contextIsolation is on and sandbox is on; this is the only bridge the renderer gets.
contextBridge.exposeInMainWorld('agentyard', api)
