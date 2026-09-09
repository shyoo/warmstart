import type { Api, ApiContext } from './support.js'
import { listProjects, requireProject } from '../projects.js'
import { refreshRemoteListener, remoteConfig, remoteListenerInfo, remoteProjects, setRemoteConfig, setRemoteProject } from '../remote/config.js'
import { listRemoteDevices, revokeDevice } from '../remote/devices.js'
import { issuePairingCode } from '../remote/pairing.js'
import { dropDeviceSubscriptions, unsubscribePush, vapidKeys } from '../remote/push.js'

type RemoteMethod =
  | 'remote.status'
  | 'remote.recheck'
  | 'remote.setEnabled'
  | 'remote.setBind'
  | 'remote.setProject'
  | 'remote.pairingCode'
  | 'remote.revokeDevice'
  | 'remote.pushKey'
  | 'remote.subscribe'
  | 'remote.unsubscribe'

function status() {
  const config = remoteConfig(), info = remoteListenerInfo(), enabled = remoteProjects()
  return {
    enabled: config.enabled,
    bind: config.bind,
    port: config.port,
    ...info,
    projects: listProjects().map((p) => ({ id: p.id, name: p.name, enabled: enabled.has(p.id) })),
    devices: listRemoteDevices()
  }
}

/** The QR destination is the public shell plus its one-time code, never an API route. */
export function pairingUrl(base: string, code: string): string {
  return `${base.replace(/\/$/, '')}/#/pair?code=${encodeURIComponent(code)}`
}

export function apiRemote(_ctx: ApiContext): Pick<Api, RemoteMethod> {
  return {
    'remote.status': () => status(),
    'remote.recheck': async () => { await refreshRemoteListener(); return status() },
    'remote.setEnabled': (p) => { setRemoteConfig('enabled', p.enabled); return status() },
    'remote.setBind': (p) => { setRemoteConfig('bind', p.bind); if (p.port !== undefined) setRemoteConfig('port', p.port); return status() },
    'remote.setProject': (p) => { requireProject(p.projectId); setRemoteProject(p.projectId, p.enabled); return status() },
    'remote.pairingCode': () => {
      const pairing = issuePairingCode()
      const current = status()
      const base = current.urls[0] ?? `http://localhost:${current.port}`
      return { ...pairing, url: pairingUrl(base, pairing.code) }
    },
    'remote.revokeDevice': (p) => {
      revokeDevice(p.id)
      // ⛔ And its notifications. A revoked phone that kept receiving pushes would still be told
      // what the fleet is doing, which is exactly what revoking was meant to stop.
      dropDeviceSubscriptions(p.id)
      return { ok: true }
    },
    'remote.pushKey': () => ({ publicKey: vapidKeys().publicKey }),
    // ⛔ Served by the remote listener, which is the only caller that knows *which device* is
    // asking — and a subscription with no device behind it could not be revoked with one.
    // `src/daemon/remote/server.ts` answers this before dispatch; reaching here is a bug.
    'remote.subscribe': () => { throw new Error('remote.subscribe is answered by the remote listener, which knows the calling device') },
    'remote.unsubscribe': (p) => { unsubscribePush(p.endpoint); return { ok: true } }
  }
}
