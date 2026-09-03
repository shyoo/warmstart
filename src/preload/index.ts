import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  IPC,
  type AgentyardApi,
  type AppInfo,
  type DaemonUiStatus,
  type UiSettings
} from '@shared/ipc.js'
import type { DaemonEvent, RpcMethod, RpcParams, RpcResult } from '@shared/protocol.js'

/**
 * The only thing the renderer can reach.
 *
 * Sandboxed and context-isolated, so this file is CommonJS at build time - see AGENTS.md before
 * "fixing" that. Nothing here forwards a credential; `rpc` is a message to the main process, which
 * holds the daemon token.
 */
const api: AgentyardApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  daemonStatus: () => ipcRenderer.invoke(IPC.daemonStatus) as Promise<DaemonUiStatus>,
  startDaemon: () => ipcRenderer.invoke(IPC.daemonStart) as Promise<DaemonUiStatus>,
  rpc: <M extends RpcMethod>(method: M, params?: RpcParams<M>) =>
    ipcRenderer.invoke(IPC.rpc, method, params) as Promise<RpcResult<M>>,
  onDaemonStatus(handler) {
    const listener = (_e: unknown, status: DaemonUiStatus) => handler(status)
    ipcRenderer.on(IPC.statusPush, listener)
    return () => ipcRenderer.removeListener(IPC.statusPush, listener)
  },
  onDaemonEvent(handler) {
    const listener = (_e: unknown, event: DaemonEvent) => handler(event)
    ipcRenderer.on(IPC.eventPush, listener)
    return () => ipcRenderer.removeListener(IPC.eventPush, listener)
  },
  getUiSettings: () => ipcRenderer.invoke(IPC.uiSettingsGet) as Promise<UiSettings>,
  setUiSettings: (patch) => ipcRenderer.invoke(IPC.uiSettingsSet, patch) as Promise<UiSettings>,
  setZoomFactor: (factor: number) => {
    webFrame.setZoomFactor(factor)
  },
  getZoomFactor: () => {
    return webFrame.getZoomFactor()
  },
  pickFolders: () => ipcRenderer.invoke(IPC.pickFolders) as Promise<string[]>
}

contextBridge.exposeInMainWorld('agentyard', api)
