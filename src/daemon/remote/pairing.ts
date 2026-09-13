import type { RemoteDeviceKind } from '@shared/protocol.js'
import { mintDevice } from './devices.js'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TTL = 120_000
/**
 * One live code per kind. ⛔ The kind belongs to the code the host issued, and redeeming checks it:
 * a phone code presented as a desktop pairing (or the reverse) fails without being spent, so a code
 * shown for a phone can never mint a credential with desktop authority.
 */
const pending = new Map<RemoteDeviceKind, { code: string; expiresAt: number; used: boolean }>()
export function issuePairingCode(now = Date.now(), kind: RemoteDeviceKind = 'phone'): { code: string; expiresAt: number; kind: RemoteDeviceKind } { let code = ''; for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!; const entry = { code, expiresAt: now + TTL, used: false }; pending.set(kind, entry); return { code, expiresAt: entry.expiresAt, kind } }
export function redeemPairingCode(code: string, label: string, _address: string, now = Date.now(), kind: RemoteDeviceKind = 'phone'): ReturnType<typeof mintDevice> | null { const entry = pending.get(kind); if (!entry || entry.used || entry.expiresAt < now || entry.code !== code) return null; entry.used = true; return mintDevice(label, kind) }
