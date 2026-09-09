import type { RemoteStatus } from '@shared/protocol'

export function countdown(expiresAt: number, now = Date.now()): string { const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000)); return seconds === 0 ? 'expired' : `${seconds}s remaining` }
export function addressLabel(url: string): string { return url.startsWith('https://') ? 'Encrypted Tailscale address — install it to your home screen and receive notifications.' : 'Unencrypted LAN address — do not install it and it cannot alert you while the phone is away.' }
export function tailscaleStep(status: RemoteStatus): string { if (!status.tailscale?.installed) return 'Install Tailscale, then sign in to your tailnet.'; if (!status.tailscale.hostname) return 'Tailscale is installed but not logged in. Sign in, then re-check.'; if (!status.tailscale.certAvailable) return 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then re-check.'; return 'Tailscale is ready for encrypted phone access.' }
