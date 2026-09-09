import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as store from '../db.js'
import { remoteConfig, remoteProjects, setRemoteConfig, setRemoteProject } from './config.js'
import { listRemoteDevices, mintDevice, revokeDevice, verifyDevice } from './devices.js'
import { issuePairingCode, redeemPairingCode } from './pairing.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-')); store.openDb(join(dir, 'remote.db')) })
afterEach(() => { store.closeDb(); rmSync(dir, { recursive: true, force: true }) })
describe('remote storage', () => {
  it('defaults off and stores explicit config and project enablement', () => {
    expect(remoteConfig().enabled).toBe(false)
    setRemoteConfig('enabled', true)
    expect(remoteConfig().enabled).toBe(true)
    expect(remoteProjects().has('project')).toBe(false)
    setRemoteProject('project', true)
    expect(remoteProjects().has('project')).toBe(true)
  })
  it('keeps only a hash, and revocation prevents verification', () => {
    const { device, token } = mintDevice('phone')
    expect(verifyDevice(token)?.id).toBe(device.id)
    expect(JSON.stringify(store.db().prepare('select token_hash from remote_devices').all())).not.toContain(token)
    revokeDevice(device.id)
    expect(verifyDevice(token)).toBeNull()
    expect(listRemoteDevices()[0]?.revokedAt).not.toBeNull()
  })
  it('redeems a short pairing code only once and honours expiry', () => {
    const issued = issuePairingCode(100)
    expect(redeemPairingCode(issued.code, 'phone', 'addr', 101)?.token).toMatch(/^[0-9a-f]{64}$/)
    expect(redeemPairingCode(issued.code, 'other', 'addr', 101)).toBeNull()
    const expired = issuePairingCode(100)
    expect(redeemPairingCode(expired.code, 'late', 'addr', expired.expiresAt + 1)).toBeNull()
  })
  it('replays the remote table migration', () => {
    store.db().exec(`pragma user_version = ${store.versionBefore('create table if not exists remote_config')}`)
    store.closeDb()
    expect(() => store.openDb(join(dir, 'remote.db'))).not.toThrow()
  })
})
