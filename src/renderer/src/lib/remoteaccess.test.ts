import { describe, expect, it } from 'vitest'
import type { RemoteStatus } from '@shared/protocol'
import { addressLabel, countdown, tailscaleStep } from './remoteaccess'

const status = (tailscale: RemoteStatus['tailscale']): RemoteStatus =>
  ({ tailscale }) as RemoteStatus

describe('remote access presentation', () => {
  it('counts a pairing code down to expiry', () => {
    expect(countdown(1200, 0)).toBe('2s remaining')
    expect(countdown(0, 0)).toBe('expired')
  })

  it('says plainly what each address can and cannot do', () => {
    expect(addressLabel('http://192.168.1.2:8787')).toMatch(/Unencrypted/)
    expect(addressLabel('https://desk.tailnet.ts.net:8787')).toMatch(/private to your tailnet.*phone must also be connected to Tailscale/)
  })

  it('names the one next step, never the whole setup at once', () => {
    expect(tailscaleStep(status(null))).toMatch(/Install Tailscale/)
    expect(tailscaleStep(status({ installed: true, hostname: null, certAvailable: false, error: null, certError: null, certTimedOut: false }))).toMatch(/Sign in/)
    expect(tailscaleStep(status({ installed: true, hostname: null, certAvailable: false, error: 'Access is denied.', certError: null, certTimedOut: false }))).toMatch(/could not be read.*Access is denied/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: 'local-tailscaled.sock: Tailscale service: Access is denied.', certTimedOut: false }))).toMatch(/local Windows service denied.*Update Tailscale.*tailscale status/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: 'certificate is not permitted', certTimedOut: false }))).toMatch(/could not issue.*certificate is not permitted/)
    // ⛔ A cert request we killed on our own timer must not be presented as a tailnet
    // misconfiguration: nothing in the admin console would fix it (t321 → t322, 2026-09-08).
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: 'Multi Agent Controller stopped waiting after 120s.', certTimedOut: true }))).toMatch(/did not finish issuing.*re-check to try again/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: 'Multi Agent Controller stopped waiting after 120s.', certTimedOut: true }))).not.toMatch(/tailnet HTTPS setting/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: null, certTimedOut: false }))).toMatch(/HTTPS certificates/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: true, error: null, certError: null, certTimedOut: false }))).toMatch(/ready/)
  })
})
