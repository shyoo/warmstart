import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_VERSION } from '@shared/rpcversion'
import type { DaemonClient } from './daemon'
import { parseRemotes, type Sealer } from './remotes'
import { helloRemote, pairRemote, type RemoteClient, type RemoteClientState } from './remoteclient'
import { TargetManager } from './targets'

class FakeLocal extends EventEmitter {
  calls: string[] = []
  getStatus() {
    return { state: 'connected', endpoint: { pid: 1, port: 2, version: 'v' }, connectedAt: 3 } as const
  }
  async rpc(method: string) {
    this.calls.push(method)
    return 'local'
  }
}

class FakeRemote extends EventEmitter {
  status: RemoteClientState = { state: 'disconnected' }
  calls: string[] = []
  disposed = false
  constructor(readonly origin: string, readonly token: string) {
    super()
  }
  getStatus() {
    return this.status
  }
  async connect() {
    this.status = { state: 'connected', appVersion: '9.9.9', rpcVersion: 1, remoteNeedsUpgrade: true, connectedAt: 1 }
    this.emit('status', this.status)
  }
  async rpc(method: string) {
    this.calls.push(method)
    return 'remote'
  }
  dispose() {
    this.disposed = true
  }
}

const sealer: Sealer = { available: () => true, seal: (p) => `sealed:${p}`, open: (s) => s.replace(/^sealed:/, '') }

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'targets-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function manager(overrides: Partial<ConstructorParameters<typeof TargetManager>[0]> = {}) {
  const local = new FakeLocal()
  const remotes: FakeRemote[] = []
  const pair = vi.fn(async () => ({ token: 'tok', deviceId: 'dev-1', hello: { app: 'warmstart' as const, appVersion: '9.9.9', rpc: RPC_VERSION } }))
  const m = new TargetManager({
    local: local as unknown as DaemonClient,
    file: join(dir, 'remotes.json'),
    sealer,
    pair,
    deviceLabel: 'laptop',
    remoteFactory: (origin, token) => {
      const r = new FakeRemote(origin, token)
      remotes.push(r)
      return r as unknown as RemoteClient
    },
    ...overrides
  })
  return { m, local, remotes, pair }
}

describe('target manager', () => {
  it('starts on this computer with nothing paired', () => {
    const { m } = manager()
    expect(m.state().active).toBe('local')
    expect(m.state().targets.map((t) => t.kind)).toEqual(['local'])
  })

  it('pairs, seals the token on disk, and never puts it in the state the renderer sees', async () => {
    const { m, pair } = manager()
    const state = await m.pair({ address: 'https://desk.tail.ts.net:8787/#/desktop-pair?code=ABCD2345' })
    expect(pair).toHaveBeenCalledWith({ origin: 'https://desk.tail.ts.net:8787', code: 'ABCD2345', deviceLabel: 'laptop' })
    expect(state.targets[1]).toMatchObject({ label: 'desk', url: 'https://desk.tail.ts.net:8787', kind: 'remote' })
    expect(JSON.stringify(state)).not.toContain('tok')
    const onDisk = readFileSync(join(dir, 'remotes.json'), 'utf8')
    expect(onDisk).toContain('sealed:tok')
  })

  it('refuses to pair where the credential could not be kept encrypted', async () => {
    const { m, pair } = manager({ sealer: { ...sealer, available: () => false } })
    await expect(m.pair({ address: 'https://desk.tail.ts.net:8787', code: 'ABCD2345' })).rejects.toThrow(/plain text/)
    expect(pair).not.toHaveBeenCalled()
  })

  it('routes rpc and events to the selected computer, and keeps local task changes as background events', async () => {
    const { m, local, remotes } = manager()
    const state = await m.pair({ address: 'https://desk.tail.ts.net:8787', code: 'ABCD2345' })
    const remoteId = state.targets[1]!.id
    const events: unknown[] = []
    const background: unknown[] = []
    m.on('event', (e) => events.push(e))
    m.on('background', (e) => background.push(e))

    m.select(remoteId)
    await Promise.resolve()
    expect(remotes[0]!.token).toBe('tok')
    expect(await m.rpc('fleet.list', undefined, remoteId)).toBe('remote')
    expect(m.activeStatus()).toMatchObject({ state: 'connected', remote: { label: 'desk' } })
    expect(m.state().targets[1]!.remoteNeedsUpgrade).toBe(true)
    expect(m.state().targets[1]!.message).toMatch(/upgrade Warmstart on that computer/)

    local.emit('event', { type: 'task.changed', task: { id: 't1' } })
    local.emit('event', { type: 'session.data', sessionId: 's', data: 'x' })
    expect(events).toEqual([])
    expect(background).toEqual([{ targetId: 'local', label: 'This computer', event: { type: 'task.changed', task: { id: 't1' } } }])

    remotes[0]!.emit('event', { type: 'log' })
    expect(events).toEqual([{ type: 'log' }])
  })

  it('refuses a call made for the computer the window has just switched away from', async () => {
    const { m, local } = manager()
    const state = await m.pair({ address: 'https://desk.tail.ts.net:8787', code: 'ABCD2345' })
    m.select(state.targets[1]!.id)
    await expect(m.rpc('task.cancel', { id: 't' }, 'local')).rejects.toThrow(/switched to another computer/)
    expect(local.calls).toEqual([])
  })

  it('remembers the selection, and forgetting the selected remote revokes it there and returns home', async () => {
    const { m, remotes } = manager()
    const state = await m.pair({ address: 'https://desk.tail.ts.net:8787', code: 'ABCD2345' })
    const id = state.targets[1]!.id
    m.select(id)
    expect(parseRemotes(readFileSync(join(dir, 'remotes.json'), 'utf8')).selected).toBe(id)
    await Promise.resolve()
    const after = await m.forget(id)
    expect(remotes[0]!.calls).toEqual(['remote.revokeDevice'])
    expect(remotes[0]!.disposed).toBe(true)
    expect(after.active).toBe('local')
    expect(after.targets).toHaveLength(1)
  })
})

describe('remote store', () => {
  it('drops anything that is not an https remote, and a selection that names nobody', () => {
    const parsed = parseRemotes(
      JSON.stringify({
        selected: 'gone',
        remotes: [
          { id: 'a', label: 'a', origin: 'http://x', deviceId: 'd', sealedToken: 's', pairedAt: 1 },
          { id: 'b', label: 'b', origin: 'https://y', deviceId: 'd', sealedToken: 's', pairedAt: 1 }
        ]
      })
    )
    expect(parsed.remotes.map((r) => r.id)).toEqual(['b'])
    expect(parsed.selected).toBe('local')
    expect(parseRemotes('not json')).toEqual({ selected: 'local', remotes: [] })
  })
})

describe('remote pairing client', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('negotiates before spending the code, and refuses a remote with no protocol in common', async () => {
    const fetchImpl = vi.fn(async () => json(200, { app: 'warmstart', appVersion: '0.1.0', rpc: { min: RPC_VERSION.max + 5, max: RPC_VERSION.max + 5 } }))
    await expect(pairRemote({ origin: 'https://h', code: 'ABCD2345', deviceLabel: 'me' }, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Upgrade Warmstart on this computer/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks for a desktop credential and refuses anything else', async () => {
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/remote/hello')) return json(200, { app: 'warmstart', appVersion: '1', rpc: RPC_VERSION })
      bodies.push(JSON.parse(init?.body as string))
      return json(200, { token: 't', deviceId: 'd', kind: 'phone' })
    })
    await expect(pairRemote({ origin: 'https://h', code: 'ABCD2345', deviceLabel: 'me' }, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/desktop credential/)
    expect(bodies).toEqual([{ code: 'ABCD2345', label: 'me', kind: 'desktop' }])
  })

  it('reads an older Warmstart that serves its phone shell for /remote/hello as not accepting desktops', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', { status: 200 }))
    await expect(helloRemote('https://h', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/accepts desktops/)
  })
})
