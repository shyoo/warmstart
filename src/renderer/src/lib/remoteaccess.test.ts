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
    expect(tailscaleStep(status({ installed: true, hostname: null, certAvailable: false, error: null, certError: null }))).toMatch(/Sign in/)
    expect(tailscaleStep(status({ installed: true, hostname: null, certAvailable: false, error: 'Access is denied.', certError: null }))).toMatch(/could not be read.*Access is denied/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: 'certificate is not permitted' }))).toMatch(/could not issue.*certificate is not permitted/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: false, error: null, certError: null }))).toMatch(/HTTPS certificates/)
    expect(tailscaleStep(status({ installed: true, hostname: 'desk.ts.net', certAvailable: true, error: null, certError: null }))).toMatch(/ready/)
  })
})
