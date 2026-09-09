import type { RemoteBind } from '@shared/protocol.js'
import { db, row, rows } from '../db.js'

export interface RemoteConfig { enabled: boolean; bind: RemoteBind; port: number; tlsCertPath: string | null; tlsKeyPath: string | null }
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = { enabled: false, bind: 'tailscale', port: 8787, tlsCertPath: null, tlsKeyPath: null }
type Listener = <K extends keyof RemoteConfig>(key: K, value: RemoteConfig[K]) => void
const listeners: Listener[] = []
export function onRemoteConfigChange(listener: Listener): () => void { listeners.push(listener); return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) } }
export function remoteConfig(): RemoteConfig {
  const out = { ...DEFAULT_REMOTE_CONFIG }
  for (const key of Object.keys(out) as Array<keyof RemoteConfig>) {
    const r = row<{ value: string }>(db().prepare('select value from remote_config where key = ?').get(key))
    if (!r) continue
    try { (out as Record<string, unknown>)[key] = JSON.parse(r.value) } catch { /* unwritten/corrupt uses default */ }
  }
  return out
}
export function setRemoteConfig<K extends keyof RemoteConfig>(key: K, value: RemoteConfig[K]): RemoteConfig {
  db().prepare(`insert into remote_config (key,value,updated_at) values (?,?,?) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`).run(key, JSON.stringify(value), Date.now())
  for (const listener of listeners) listener(key, value)
  return remoteConfig()
}
export function remoteProjects(): Set<string> { return new Set(rows<{ project_id: string }>(db().prepare('select project_id from remote_projects where enabled = 1').all()).map((r) => r.project_id)) }
export function setRemoteProject(projectId: string, enabled: boolean): void { db().prepare(`insert into remote_projects (project_id,enabled,updated_at) values (?,?,?) on conflict(project_id) do update set enabled=excluded.enabled,updated_at=excluded.updated_at`).run(projectId, enabled ? 1 : 0, Date.now()) }
export interface RemoteListenerInfo { listening: boolean; secure: boolean; urls: string[]; tailscale: { installed: boolean; hostname: string | null; certAvailable: boolean; error: string | null; certError: string | null } | null }
let listenerInfo: (() => RemoteListenerInfo) | null = null
let listenerRefresh: (() => Promise<void>) | null = null
export function setRemoteListenerInfo(provider: (() => RemoteListenerInfo) | null): void { listenerInfo = provider }
export function remoteListenerInfo(): RemoteListenerInfo { return listenerInfo?.() ?? { listening: false, secure: false, urls: [], tailscale: null } }
/** Ask the remote listener to probe Tailscale now, rather than returning its last observation. */
export function setRemoteListenerRefresh(refresh: (() => Promise<void>) | null): void { listenerRefresh = refresh }
export async function refreshRemoteListener(): Promise<void> { await listenerRefresh?.() }
