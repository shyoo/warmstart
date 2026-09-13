import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCAL_TARGET } from '@shared/ipc.js'

/**
 * The remote Warmstarts this computer has paired with, and which one the window is showing.
 *
 * ⛔ **Main's file, not the daemon's database** (operator, t419). A remote's device token authorises
 * spawning processes on that computer. The fleet database is read by every agent this computer runs,
 * so a token kept there would hand each of them a key to the other machine; and main must be able to
 * reach a remote while this computer's own daemon is not answering.
 *
 * ⛔ **Encrypted or not at all.** The token is sealed with Electron `safeStorage` (DPAPI, Keychain, the
 * desktop keyring). Where that is unavailable — including Linux's `basic_text` fallback, which is
 * not encryption — pairing is refused, never quietly stored in plain text.
 */

export interface StoredRemote {
  id: string
  label: string
  /** `https://host.tailnet.ts.net:port`, origin only. */
  origin: string
  /** The id the remote gave this computer's credential, so forgetting can ask it to revoke. */
  deviceId: string
  /** The device token, sealed by `safeStorage`, base64. */
  sealedToken: string
  pairedAt: number
}

export interface RemotesFile {
  selected: string
  remotes: StoredRemote[]
}

/** The one thing this module needs from `safeStorage`, so it can be tested without Electron. */
export interface Sealer {
  available(): boolean
  seal(plain: string): string
  open(sealed: string): string
}

export const EMPTY_REMOTES: RemotesFile = { selected: LOCAL_TARGET, remotes: [] }

function validRemote(value: unknown): value is StoredRemote {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.label === 'string' &&
    typeof r.origin === 'string' && r.origin.startsWith('https://') &&
    typeof r.deviceId === 'string' &&
    typeof r.sealedToken === 'string' && r.sealedToken.length > 0 &&
    typeof r.pairedAt === 'number'
  )
}

/**
 * ⚠️ Never throws, and field by field: a file from a newer build or a text editor must not be able
 * to open a connection to an `http://` address or select a remote that is not in the list.
 */
export function parseRemotes(text: string | null): RemotesFile {
  if (!text) return { ...EMPTY_REMOTES, remotes: [] }
  try {
    const parsed = JSON.parse(text) as Partial<RemotesFile>
    const remotes = Array.isArray(parsed.remotes) ? parsed.remotes.filter(validRemote) : []
    const selected = typeof parsed.selected === 'string' && remotes.some((r) => r.id === parsed.selected) ? parsed.selected : LOCAL_TARGET
    return { selected, remotes }
  } catch {
    return { ...EMPTY_REMOTES, remotes: [] }
  }
}

export function readRemotes(file: string): RemotesFile {
  try {
    return parseRemotes(existsSync(file) ? readFileSync(file, 'utf8') : null)
  } catch {
    return { ...EMPTY_REMOTES, remotes: [] }
  }
}

/** Written to a sibling and renamed over, so a crash mid-write cannot lose every pairing at once. */
export function writeRemotes(file: string, next: RemotesFile): RemotesFile {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  return next
}

/** A label for a remote nobody named: the first DNS label of its tailnet hostname. */
export function defaultRemoteLabel(origin: string): string {
  try {
    return new URL(origin).hostname.split('.')[0] || origin
  } catch {
    return origin
  }
}
