import { mintDevice } from './devices.js'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TTL = 120_000
let pending: { code: string; expiresAt: number; used: boolean } | null = null
export function issuePairingCode(now = Date.now()): { code: string; expiresAt: number } { let code = ''; for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!; pending = { code, expiresAt: now + TTL, used: false }; return { code, expiresAt: pending.expiresAt } }
export function redeemPairingCode(code: string, label: string, _address: string, now = Date.now()): ReturnType<typeof mintDevice> | null { if (!pending || pending.used || pending.expiresAt < now || pending.code !== code) return null; pending.used = true; return mintDevice(label) }
