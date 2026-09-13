import { describe, expect, it } from 'vitest'
import { RPC_COMPATIBILITY_SPAN, RPC_VERSION, acceptsRpcVersion, desktopPairingLink, negotiateRpcVersion, parseDesktopPairing } from './rpcversion'

describe('rpc version negotiation', () => {
  it('keeps compatibility to one version either way', () => {
    // ⛔ Raising `max` means raising `min` with it; see RPC_COMPATIBILITY_SPAN.
    expect(RPC_VERSION.max - RPC_VERSION.min).toBeLessThanOrEqual(RPC_COMPATIBILITY_SPAN)
    expect(RPC_VERSION.min).toBeGreaterThanOrEqual(1)
  })

  it('uses the newest version both ends speak', () => {
    expect(negotiateRpcVersion({ min: 1, max: 2 }, { min: 1, max: 2 })).toEqual({ ok: true, version: 2, remoteNeedsUpgrade: false })
    // The client is older: it uses v1 and the remote is not the one that needs an upgrade.
    expect(negotiateRpcVersion({ min: 1, max: 1 }, { min: 1, max: 2 })).toEqual({ ok: true, version: 1, remoteNeedsUpgrade: false })
    // The remote is older: it works on v1, and says so.
    expect(negotiateRpcVersion({ min: 1, max: 2 }, { min: 1, max: 1 })).toEqual({ ok: true, version: 1, remoteNeedsUpgrade: true })
  })

  it('refuses when nothing overlaps, naming which side to upgrade', () => {
    const remoteTooOld = negotiateRpcVersion({ min: 3, max: 3 }, { min: 1, max: 2 })
    expect(remoteTooOld.ok).toBe(false)
    expect(!remoteTooOld.ok && remoteTooOld.reason).toMatch(/Upgrade Warmstart on the remote/)
    const localTooOld = negotiateRpcVersion({ min: 1, max: 2 }, { min: 3, max: 3 })
    expect(!localTooOld.ok && localTooOld.reason).toMatch(/on this computer/)
  })

  it('refuses a remote that declares no usable range', () => {
    expect(negotiateRpcVersion({ min: 1, max: 1 }, undefined).ok).toBe(false)
    expect(negotiateRpcVersion({ min: 1, max: 1 }, { min: 2, max: 1 }).ok).toBe(false)
  })

  it('accepts only a requested version inside its own range', () => {
    expect(acceptsRpcVersion({ min: 1, max: 2 }, '2')).toBe(2)
    expect(acceptsRpcVersion({ min: 1, max: 2 }, '3')).toBeNull()
    expect(acceptsRpcVersion({ min: 2, max: 2 }, '1')).toBeNull()
    expect(acceptsRpcVersion({ min: 1, max: 2 }, undefined)).toBeNull()
    expect(acceptsRpcVersion({ min: 1, max: 2 }, '1.5')).toBeNull()
  })
})

describe('desktop pairing input', () => {
  it('reads the host link, keeping only the origin', () => {
    const link = desktopPairingLink('https://host.tail.ts.net:8787', 'ABCD2345')
    expect(parseDesktopPairing(link)).toEqual({ origin: 'https://host.tail.ts.net:8787', code: 'ABCD2345' })
  })

  it('takes an address and a typed code, defaulting the scheme to https', () => {
    expect(parseDesktopPairing('host.tail.ts.net:8787', ' abcd2345 ')).toEqual({ origin: 'https://host.tail.ts.net:8787', code: 'ABCD2345' })
  })

  it('refuses plain http before a code is spent', () => {
    expect(parseDesktopPairing('http://192.168.1.4:8787', 'ABCD2345')).toHaveProperty('error')
  })

  it('refuses a missing or malformed code', () => {
    expect(parseDesktopPairing('https://host.tail.ts.net:8787')).toHaveProperty('error')
    expect(parseDesktopPairing('https://host.tail.ts.net:8787', 'short')).toHaveProperty('error')
  })
})
