import { describe, expect, it } from 'vitest'
import { RPC_VERSION } from '@shared/rpcversion.js'
import { desktopGate, desktopRefusal } from './desktoppolicy.js'
import { REMOTE_METHODS } from './policy.js'

describe('desktop policy', () => {
  it('allows what the phone may not, because a desktop has parity', () => {
    for (const m of ['session.write', 'worker.create', 'settings.set', 'task.delete', 'project.add', 'task.diffFile'] as const) {
      expect(REMOTE_METHODS[m]).toBe('deny')
      expect(desktopRefusal(m)).toBeNull()
    }
  })

  it('denies shutdown, a phone push subscription, and every agent identity method', () => {
    expect(desktopRefusal('daemon.shutdown')).toMatch(/quit Warmstart on that machine/)
    expect(desktopRefusal('remote.subscribe')).not.toBeNull()
    for (const m of ['agent.taskRead', 'agent.complete', 'agent.land'] as const) expect(desktopRefusal(m)).not.toBeNull()
  })

  it('keeps the new desktop switch off the phone', () => {
    expect(REMOTE_METHODS['remote.setDesktopsEnabled']).toBe('deny')
  })

  it('refuses a desktop token while desktops are off, over plain HTTP, or on a protocol it does not speak', () => {
    const ok = { desktopsEnabled: true, encrypted: true, rpcVersion: String(RPC_VERSION.max) }
    expect(desktopGate(ok)).toEqual({ ok: true, version: RPC_VERSION.max })
    expect(desktopGate({ ...ok, desktopsEnabled: false })).toMatchObject({ status: 403 })
    expect(desktopGate({ ...ok, encrypted: false })).toMatchObject({ status: 403 })
    expect(desktopGate({ ...ok, rpcVersion: undefined })).toMatchObject({ status: 426 })
    expect(desktopGate({ ...ok, rpcVersion: String(RPC_VERSION.max + 1) })).toMatchObject({ status: 426 })
  })
})
