import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../which.js'
import { run } from '../spawn.js'
import { paths } from '../paths.js'
import { errorMessage } from '@shared/errors.js'

export interface TailscaleInfo { installed: boolean; hostname: string | null; ipv4: string | null; certAvailable: boolean; certPath: string | null; keyPath: string | null; error: string | null; certError: string | null; certTimedOut: boolean }

/**
 * How long to wait for `tailscale cert`.
 *
 * ⛔ Not a round guess. A *first* issuance is an ACME exchange with Let's Encrypt, and on this
 * machine it took **36.1s** measured (2026-09-08, tailscale 1.x, `shyoo-12700k.taild143f.ts.net`);
 * a re-run against the cached certificate took **0.16s**. The old 10s budget killed every cold
 * issuance and reported the kill as a tailnet misconfiguration. The slow path runs once per
 * certificate lifetime, so the ceiling costs nothing in the common case.
 */
const CERT_TIMEOUT_MS = 120_000

/** Probe Tailscale opportunistically. Its absence and an HTTPS-disabled tailnet are normal. */
export async function tailscaleInfo(): Promise<TailscaleInfo> {
  const binary = which('tailscale')
  if (!binary) return { installed: false, hostname: null, ipv4: null, certAvailable: false, certPath: null, keyPath: null, error: null, certError: null, certTimedOut: false }
  try {
    const { stdout } = await run(binary, ['status', '--json'], { timeout: 5000, windowsHide: true })
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    const hostname = status.Self?.DNSName?.replace(/\.$/, '') ?? null
    const ipv4 = status.Self?.TailscaleIPs?.find((ip) => /^100\./.test(ip)) ?? null
    if (!hostname) return { installed: true, hostname: null, ipv4, certAvailable: false, certPath: null, keyPath: null, error: null, certError: null, certTimedOut: false }
    const dir = join(paths.root, 'remote')
    const certPath = join(dir, 'tailscale.crt'), keyPath = join(dir, 'tailscale.key')
    let certError: string | null = null, certTimedOut = false
    try {
      mkdirSync(dir, { recursive: true })
      // `tailscale cert` refreshes the short-lived certificate. Its refusal is actionable (usually
      // a tailnet setting or ACL) and must reach the person who just pressed Re-check.
      await run(binary, ['cert', `--cert-file=${certPath}`, `--key-file=${keyPath}`, hostname], { timeout: CERT_TIMEOUT_MS, windowsHide: true })
    } catch (err) {
      const stderr = typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
      // ⛔ A command *we* killed is not a refusal by Tailscale. `execFile` reports its own timeout
      // as a bare "Command failed:" with empty stderr, which reads exactly like a denied request —
      // so say who stopped it, or the operator goes looking in the admin console for nothing.
      certTimedOut = typeof err === 'object' && err !== null && 'killed' in err && err.killed === true
      certError = certTimedOut
        ? `Warmstart stopped waiting after ${Math.round(CERT_TIMEOUT_MS / 1000)}s.`
        : stderr || errorMessage(err)
    }
    const certAvailable = existsSync(certPath) && existsSync(keyPath)
    return { installed: true, hostname, ipv4, certAvailable, certPath: certAvailable ? certPath : null, keyPath: certAvailable ? keyPath : null, error: null, certError: certAvailable ? null : certError, certTimedOut: certAvailable ? false : certTimedOut }
  } catch (err) {
    // A failed local API query is not evidence the user failed to sign in. In particular, Windows
    // can deny this process access to Tailscale's protected service pipe.
    const stderr = typeof err === 'object' && err !== null && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : ''
    return { installed: true, hostname: null, ipv4: null, certAvailable: false, certPath: null, keyPath: null, error: stderr || errorMessage(err), certError: null, certTimedOut: false }
  }
}
