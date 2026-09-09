import type { RemoteStatus } from '@shared/protocol'

export function countdown(expiresAt: number, now = Date.now()): string { const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000)); return seconds === 0 ? 'expired' : `${seconds}s remaining` }
export function addressLabel(url: string): string { return url.startsWith('https://') ? 'Encrypted Tailscale address — private to your tailnet, not public. The phone must also be connected to Tailscale. Install it to the home screen and receive notifications.' : 'Unencrypted LAN address — do not install it and it cannot alert you while the phone is away.' }
export function tailscaleStep(status: RemoteStatus): string {
  if (!status.tailscale?.installed) return 'Install Tailscale, then sign in to your tailnet.'
  if (status.tailscale.error) return `Tailscale is installed, but its local service could not be read: ${status.tailscale.error} Check that the Tailscale service is running and this app may access it, then re-check.`
  if (!status.tailscale.hostname) return 'Tailscale is installed but not logged in. Sign in, then re-check.'
  if (status.tailscale.certError && /local-tailscaled\.sock|\\\\pipe\\.*Tailscale/i.test(status.tailscale.certError) && /access is denied/i.test(status.tailscale.certError)) {
    return `Tailscale's local Windows service denied the certificate request: ${status.tailscale.certError} Update Tailscale, then confirm \`tailscale status\` works from your normal user terminal before re-checking.`
  }
  // A timeout is our own doing, not the tailnet's. Sending the operator to the admin console for it
  // is the wrong instruction: the first issuance is a slow ACME exchange and re-checking finishes it.
  if (status.tailscale.certTimedOut) return `Tailscale did not finish issuing this machine's HTTPS certificate in time: ${status.tailscale.certError} The first issuance is a slow exchange with the certificate authority; re-check to try again.`
  if (status.tailscale.certError) return `Tailscale could not issue this machine's HTTPS certificate: ${status.tailscale.certError} Check the tailnet HTTPS setting and this device's certificate permission, then re-check.`
  if (!status.tailscale.certAvailable) return 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then re-check.'
  return 'Tailscale is ready for encrypted phone access.'
}
