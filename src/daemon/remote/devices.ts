import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RemoteDevice } from '@shared/protocol.js'
import { db, row, rows } from '../db.js'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
interface DeviceRow { id: string; label: string; token_hash: string; created_at: number; last_seen_at: number | null; last_address: string | null; revoked_at: number | null }
const device = (r: DeviceRow): RemoteDevice => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, lastAddress: r.last_address, revokedAt: r.revoked_at })
export function listRemoteDevices(): RemoteDevice[] { return rows<DeviceRow>(db().prepare('select * from remote_devices order by created_at').all()).map(device) }
export function mintDevice(label: string): { device: RemoteDevice; token: string } { const id = randomUUID(), token = randomBytes(32).toString('hex'), now = Date.now(); db().prepare('insert into remote_devices (id,label,token_hash,created_at) values (?,?,?,?)').run(id, label, hash(token), now); return { device: device({ id, label, token_hash: '', created_at: now, last_seen_at: null, last_address: null, revoked_at: null }), token } }
export function verifyDevice(token: string): RemoteDevice | null { const r = row<DeviceRow>(db().prepare('select * from remote_devices where token_hash = ? and revoked_at is null').get(hash(token))); if (!r) return null; const a = Buffer.from(r.token_hash, 'hex'), b = Buffer.from(hash(token), 'hex'); return a.length === b.length && timingSafeEqual(a, b) ? device(r) : null }
export function touchDevice(id: string, address: string): void { db().prepare('update remote_devices set last_seen_at=?, last_address=? where id=? and revoked_at is null').run(Date.now(), address, id) }
export function revokeDevice(id: string): void { db().prepare('update remote_devices set revoked_at=? where id=?').run(Date.now(), id) }
