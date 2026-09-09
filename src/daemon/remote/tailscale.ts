import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../which.js'
import { run } from '../spawn.js'
import { paths } from '../paths.js'
import { errorMessage } from '@shared/errors.js'

export interface TailscaleInfo { installed: boolean; hostname: string | null; ipv4: string | null; certAvailable: boolean; certPath: string | null; keyPath: string | null; error: string | null; certError: string | null }

/** Probe Tailscale opportunistically. Its absence and an HTTPS-disabled tailnet are normal. */
export async function tailscaleInfo(): Promise<TailscaleInfo> {
  const binary = which('tailscale')
  if (!binary) return { installed: false, hostname: null, ipv4: null, certAvailable: false, certPath: null, keyPath: null, error: null, certError: null }
  try {
    const { stdout } = await run(binary, ['status', '--json'], { timeout: 5000, windowsHide: true })
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    const hostname = status.Self?.DNSName?.replace(/\.$/, '') ?? null
    const ipv4 = status.Self?.TailscaleIPs?.find((ip) => /^100\./.test(ip)) ?? null
    if (!hostname) return { installed: true, hostname: null, ipv4, certAvailable: false, certPath: null, keyPath: null, error: null, certError: null }
    const dir = join(paths.root, 'remote')
    const certPath = join(dir, 'tailscale.crt'), keyPath = join(dir, 'tailscale.key')
    let certError: string | null = null
    try {
      mkdirSync(dir, { recursive: true })
      // `tailscale cert` refreshes the short-lived certificate. Its refusal is actionable (usually
      // a tailnet setting or ACL) and must reach the person who just pressed Re-check.
      await run(binary, ['cert', `--cert-file=${certPath}`, `--key-file=${keyPath}`, hostname], { timeout: 10000, windowsHide: true })
    } catch (err) {
      const stderr = typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
      certError = stderr || errorMessage(err)
    }
    const certAvailable = existsSync(certPath) && existsSync(keyPath)
    return { installed: true, hostname, ipv4, certAvailable, certPath: certAvailable ? certPath : null, keyPath: certAvailable ? keyPath : null, error: null, certError: certAvailable ? null : certError }
  } catch (err) {
    // A failed local API query is not evidence the user failed to sign in. In particular, Windows
    // can deny this process access to Tailscale's protected service pipe.
    const stderr = typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
    return { installed: true, hostname: null, ipv4: null, certAvailable: false, certPath: null, keyPath: null, error: stderr || errorMessage(err), certError: null }
  }
}
