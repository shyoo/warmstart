import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RemoteDevice } from '@shared/protocol.js'
import { db, row, rows } from '../db.js'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
interface DeviceRow { id: string; label: string; token_hash: string; created_at: number; last_seen_at: number | null; last_address: string | null; revoked_at: number | null }
const device = (r: DeviceRow): RemoteDevice => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, lastAddress: r.last_address, revokedAt: r.revoked_at })
// ⚠️ `revoked_at is null` stays in every query: rows revoked by a build from before t353 are still
// tombstones in somebody's database, and they must neither list nor verify.
export function listRemoteDevices(): RemoteDevice[] { return rows<DeviceRow>(db().prepare('select * from remote_devices where revoked_at is null order by created_at').all()).map(device) }
export function mintDevice(label: string): { device: RemoteDevice; token: string } { const id = randomUUID(), token = randomBytes(32).toString('hex'), now = Date.now(); db().prepare('insert into remote_devices (id,label,token_hash,created_at) values (?,?,?,?)').run(id, label, hash(token), now); return { device: device({ id, label, token_hash: '', created_at: now, last_seen_at: null, last_address: null, revoked_at: null }), token } }
export function verifyDevice(token: string): RemoteDevice | null { const r = row<DeviceRow>(db().prepare('select * from remote_devices where token_hash = ? and revoked_at is null').get(hash(token))); if (!r) return null; const a = Buffer.from(r.token_hash, 'hex'), b = Buffer.from(hash(token), 'hex'); return a.length === b.length && timingSafeEqual(a, b) ? device(r) : null }
export function touchDevice(id: string, address: string): void { db().prepare('update remote_devices set last_seen_at=?, last_address=? where id=? and revoked_at is null').run(Date.now(), address, id) }
/**
 * ⛔ A delete, not a tombstone (t353). A revoked row could do nothing — not verify, not be touched,
 * not be un-revoked — so all it did was sit in Paired devices with a disabled button beside it. The
 * token hash goes with it, which is the one thing a revocation must not leave behind anyway.
 */
export function revokeDevice(id: string): void { db().prepare('delete from remote_devices where id=?').run(id) }
