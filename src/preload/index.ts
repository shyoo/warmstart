import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  IPC,
  type AgentyardApi,
  type AppInfo,
  type AppUpdateState,
  type DaemonUiStatus,
  type TargetEvent,
  type TargetsState,
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
  getUpdateStatus: () => ipcRenderer.invoke(IPC.updateStatus) as Promise<AppUpdateState>,
  showDownloadedUpdate: () => ipcRenderer.invoke(IPC.updateShowDownloaded) as Promise<boolean>,
  onUpdateStatus(handler) {
    const listener = (_e: unknown, status: AppUpdateState) => handler(status)
    ipcRenderer.on(IPC.updatePush, listener)
    return () => ipcRenderer.removeListener(IPC.updatePush, listener)
  },
  daemonStatus: () => ipcRenderer.invoke(IPC.daemonStatus) as Promise<DaemonUiStatus>,
  startDaemon: () => ipcRenderer.invoke(IPC.daemonStart) as Promise<DaemonUiStatus>,
  rpc: <M extends RpcMethod>(method: M, params?: RpcParams<M>, targetId?: string) =>
    ipcRenderer.invoke(IPC.rpc, method, params, targetId) as Promise<RpcResult<M>>,
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
  pickFolders: () => ipcRenderer.invoke(IPC.pickFolders) as Promise<string[]>,
  notify: (request) => ipcRenderer.invoke(IPC.notify, request) as Promise<boolean>,
  onNotificationActivate(handler) {
    const listener = (_e: unknown, taskId: string, targetId: string) => handler(taskId, targetId)
    ipcRenderer.on(IPC.notificationActivate, listener)
    return () => ipcRenderer.removeListener(IPC.notificationActivate, listener)
  },
  getTargets: () => ipcRenderer.invoke(IPC.targetsGet) as Promise<TargetsState>,
  onTargets(handler) {
    const listener = (_e: unknown, state: TargetsState) => handler(state)
    ipcRenderer.on(IPC.targetsPush, listener)
    return () => ipcRenderer.removeListener(IPC.targetsPush, listener)
  },
  selectTarget: (id) => ipcRenderer.invoke(IPC.targetSelect, id) as Promise<TargetsState>,
  // ⚠️ A pairing code and an address cross here; the token they are exchanged for never comes back.
  pairRemote: (request) => ipcRenderer.invoke(IPC.targetPair, request) as Promise<TargetsState>,
  forgetRemote: (id) => ipcRenderer.invoke(IPC.targetForget, id) as Promise<TargetsState>,
  onBackgroundEvent(handler) {
    const listener = (_e: unknown, event: TargetEvent) => handler(event)
    ipcRenderer.on(IPC.backgroundEventPush, listener)
    return () => ipcRenderer.removeListener(IPC.backgroundEventPush, listener)
  }
}

contextBridge.exposeInMainWorld('agentyard', api)
