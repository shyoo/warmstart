import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  LOCAL_TARGET,
  type DaemonUiStatus,
  type PairRemoteRequest,
  type TargetEvent,
  type TargetSummary,
  type TargetsState
} from '@shared/ipc.js'
import type { DaemonEvent, RpcMethod, RpcParams, RpcResult } from '@shared/protocol.js'
import { parseDesktopPairing } from '@shared/rpcversion.js'
import { errorMessage } from '@shared/errors.js'
import type { DaemonClient, DaemonStatus } from './daemon.js'
import { RemoteClient, pairRemote, type RemoteClientState } from './remoteclient.js'
import { defaultRemoteLabel, readRemotes, writeRemotes, type RemotesFile, type Sealer, type StoredRemote } from './remotes.js'

/**
 * Which computer the window is showing, and the plumbing that makes that one choice true everywhere.
 *
 * ⛔ **This computer's daemon stays connected whichever is on screen.** Main still owns its lifecycle
 * (tray, Quit, the stop-and-quit prompt), and its notifications must still arrive while a remote is
 * being looked at — its `task.changed` events go out as *background* events for exactly that.
 *
 * ⚠️ **Only the selected remote is connected** (operator, t419). An unselected remote costs nothing
 * and notifies nobody.
 */

type RemoteFactory = (origin: string, token: string) => RemoteClient
type Pair = typeof pairRemote

export interface TargetManagerOptions {
  local: DaemonClient
  file: string
  sealer: Sealer
  remoteFactory?: RemoteFactory
  pair?: Pair
  /** This computer's name, as the remote will list it under its paired devices. */
  deviceLabel?: string
}

export function localUiStatus(status: DaemonStatus): DaemonUiStatus {
  switch (status.state) {
    case 'connected':
      return { state: 'connected', pid: status.endpoint.pid, port: status.endpoint.port, version: status.endpoint.version, connectedAt: status.connectedAt }
    case 'error':
      return { state: 'error', message: status.message }
    default:
      return { state: status.state }
  }
}

export function remoteUiStatus(remote: StoredRemote, status: RemoteClientState): DaemonUiStatus {
  switch (status.state) {
    case 'connected': {
      const url = new URL(remote.origin)
      return {
        state: 'connected',
        pid: 0,
        port: Number(url.port) || 443,
        version: status.appVersion,
        connectedAt: status.connectedAt,
        remote: { label: remote.label, url: remote.origin }
      }
    }
    case 'refused':
    case 'error':
      return { state: 'error', message: `${remote.label}: ${status.message}` }
    case 'connecting':
      return { state: 'starting' }
    default:
      return { state: 'stopped' }
  }
}

export class TargetManager extends EventEmitter {
  private file: RemotesFile
  private client: RemoteClient | null = null
  /** Why the selected remote's credential could not be opened, which no retry will change. */
  private unlockError: string | null = null
  private readonly remoteFactory: RemoteFactory
  private readonly pairImpl: Pair

  constructor(private readonly options: TargetManagerOptions) {
    super()
    this.file = readRemotes(options.file)
    this.remoteFactory = options.remoteFactory ?? ((origin, token) => new RemoteClient(origin, token))
    this.pairImpl = options.pair ?? pairRemote
    options.local.on('status', () => {
      if (this.file.selected === LOCAL_TARGET) this.emit('status', this.activeStatus())
      this.emit('targets', this.state())
    })
    options.local.on('event', (event: DaemonEvent) => {
      if (this.file.selected === LOCAL_TARGET) this.emit('event', event)
      else if (event.type === 'task.changed') this.emit('background', { targetId: LOCAL_TARGET, label: 'This computer', event } satisfies TargetEvent)
    })
  }

  /** Connect to the remote the window was last showing. Call once main is ready. */
  start(): void {
    const remote = this.selectedRemote()
    if (remote) this.openClient(remote)
  }

  activeId(): string {
    return this.file.selected
  }

  private selectedRemote(): StoredRemote | null {
    return this.file.remotes.find((r) => r.id === this.file.selected) ?? null
  }

  private clientStatus(): RemoteClientState {
    if (this.unlockError) return { state: 'refused', message: this.unlockError, appVersion: null }
    return this.client?.getStatus() ?? { state: 'disconnected' }
  }

  activeStatus(): DaemonUiStatus {
    const remote = this.selectedRemote()
    if (!remote) return localUiStatus(this.options.local.getStatus())
    return remoteUiStatus(remote, this.clientStatus())
  }

  state(): TargetsState {
    const local = this.options.local.getStatus()
    const targets: TargetSummary[] = [
      {
        id: LOCAL_TARGET,
        label: 'This computer',
        kind: 'local',
        url: null,
        state: local.state === 'connected' ? 'connected' : local.state === 'starting' ? 'connecting' : local.state === 'error' ? 'error' : 'disconnected',
        message: local.state === 'error' ? local.message : null,
        remoteAppVersion: null,
        rpcVersion: null,
        remoteNeedsUpgrade: false,
        pairedAt: null
      },
      ...this.file.remotes.map((remote): TargetSummary => {
        const status: RemoteClientState = remote.id === this.file.selected ? this.clientStatus() : { state: 'disconnected' }
        return {
          id: remote.id,
          label: remote.label,
          kind: 'remote',
          url: remote.origin,
          state: status.state,
          message:
            status.state === 'error' || status.state === 'refused'
              ? status.message
              : status.state === 'connected' && status.remoteNeedsUpgrade
                ? `${remote.label} runs Warmstart ${status.appVersion}, which speaks an older protocol than this app. It works for now — upgrade Warmstart on that computer.`
                : null,
          remoteAppVersion: status.state === 'connected' ? status.appVersion : status.state === 'refused' ? status.appVersion : null,
          rpcVersion: status.state === 'connected' ? status.rpcVersion : null,
          remoteNeedsUpgrade: status.state === 'connected' && status.remoteNeedsUpgrade,
          pairedAt: remote.pairedAt
        }
      })
    ]
    return { active: this.file.selected, targets, canStoreCredentials: this.options.sealer.available() }
  }

  private persist(next: RemotesFile): void {
    this.file = writeRemotes(this.options.file, next)
  }

  private closeClient(): void {
    this.unlockError = null
    this.client?.dispose()
    this.client = null
  }

  private openClient(remote: StoredRemote): void {
    this.closeClient()
    let token: string
    try {
      token = this.options.sealer.open(remote.sealedToken)
    } catch (err) {
      // ⚠️ A credential sealed under another OS user or a reset keychain cannot be opened again. Say
      // so; the fix is to pair again, and nothing is gained by retrying.
      this.unlockError = `The stored credential could not be unlocked (${errorMessage(err)}). Forget this computer and pair again.`
      return
    }
    const client = this.remoteFactory(remote.origin, token)
    this.client = client
    client.on('status', () => {
      if (this.client !== client) return
      this.emit('status', this.activeStatus())
      this.emit('targets', this.state())
    })
    client.on('event', (event: DaemonEvent) => {
      if (this.client === client) this.emit('event', event)
    })
    void client.connect()
  }

  select(id: string): TargetsState {
    if (id === this.file.selected) return this.state()
    const remote = this.file.remotes.find((r) => r.id === id)
    if (id !== LOCAL_TARGET && !remote) throw new Error('That computer is not paired with this one.')
    this.closeClient()
    this.persist({ ...this.file, selected: remote ? remote.id : LOCAL_TARGET })
    if (remote) this.openClient(remote)
    this.emit('status', this.activeStatus())
    this.emit('targets', this.state())
    return this.state()
  }

  /** Try the selected remote again now, rather than waiting out the backoff. */
  retry(): void {
    const remote = this.selectedRemote()
    if (!remote) return
    if (this.client) void this.client.connect()
    else this.openClient(remote)
  }

  async pair(request: PairRemoteRequest): Promise<TargetsState> {
    if (!this.options.sealer.available()) {
      throw new Error('This computer cannot store the credential encrypted (no OS keychain is available), so pairing is refused rather than keeping it in plain text.')
    }
    const input = parseDesktopPairing(request.address, request.code)
    if ('error' in input) throw new Error(input.error)
    if (this.file.remotes.some((r) => r.origin === input.origin)) {
      throw new Error(`${input.origin} is already paired. Forget it first to pair it again.`)
    }
    const paired = await this.pairImpl({ origin: input.origin, code: input.code, deviceLabel: this.options.deviceLabel ?? hostname() })
    const remote: StoredRemote = {
      id: randomUUID(),
      label: request.label?.trim() || defaultRemoteLabel(input.origin),
      origin: input.origin,
      deviceId: paired.deviceId,
      sealedToken: this.options.sealer.seal(paired.token),
      pairedAt: Date.now()
    }
    this.persist({ ...this.file, remotes: [...this.file.remotes, remote] })
    this.emit('targets', this.state())
    return this.state()
  }

  /**
   * Forget a remote here, and ask that computer to revoke this one's credential first.
   *
   * ⚠️ Best effort on the far side: a remote that cannot be reached still gets forgotten here, and its
   * operator can revoke the device from their own Paired devices list — which the result says.
   */
  async forget(id: string): Promise<TargetsState> {
    const remote = this.file.remotes.find((r) => r.id === id)
    if (!remote) return this.state()
    const wasActive = this.file.selected === id
    if (wasActive && this.client?.getStatus().state === 'connected') {
      try {
        await Promise.race([
          this.client.rpc('remote.revokeDevice', { id: remote.deviceId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5_000).unref?.())
        ])
      } catch {
        // Forgotten here regardless; see the note above.
      }
    }
    if (wasActive) this.closeClient()
    this.persist({ selected: wasActive ? LOCAL_TARGET : this.file.selected, remotes: this.file.remotes.filter((r) => r.id !== id) })
    this.emit('status', this.activeStatus())
    this.emit('targets', this.state())
    return this.state()
  }

  /**
   * ⛔ `targetId` is the computer the renderer believed it was on when it made the call. A call that
   * arrives after a switch is refused, never delivered to whichever computer is now on screen — a
   * `task.cancel` meant for one machine must not land on the other.
   */
  async rpc<M extends RpcMethod>(method: M, params: RpcParams<M> | undefined, targetId?: string): Promise<RpcResult<M>> {
    if (targetId !== undefined && targetId !== this.file.selected) {
      throw new Error('Warmstart switched to another computer before this request was sent, so it was not sent.')
    }
    if (this.file.selected === LOCAL_TARGET) return this.options.local.rpc(method, params)
    if (!this.client) throw new Error('not connected to the selected computer')
    return this.client.rpc(method, params)
  }

  dispose(): void {
    this.closeClient()
  }
}
