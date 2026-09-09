/**
 * Whether this phone can be alerted, and what to say when it cannot.
 *
 * ⛔ Web Push needs a **secure context**, which `http://192.168.x.x` and `http://100.x.x.x` are
 * not — so on a plain LAN address `PushManager` is not merely blocked, it does not exist. The
 * honest thing is to say so and name the fix, rather than showing a control that cannot work.
 */
export type NotifyState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'insecure'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'off' }
  | { kind: 'on' }

export interface NotifyEnvironment {
  isSecureContext: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  permission: 'default' | 'granted' | 'denied'
  subscribed: boolean
}

export function notifyState(env: NotifyEnvironment): NotifyState {
  if (!env.isSecureContext) {
    return {
      kind: 'insecure',
      reason: 'This address is not encrypted, so the phone will not accept notifications. Open the https:// Tailscale address instead.'
    }
  }
  if (!env.hasServiceWorker || !env.hasPushManager) {
    return { kind: 'unsupported', reason: 'This browser cannot receive notifications. Add the app to your home screen and open it from there.' }
  }
  if (env.permission === 'denied') {
    return { kind: 'denied', reason: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.' }
  }
  return env.subscribed ? { kind: 'on' } : { kind: 'off' }
}

/**
 * The VAPID key as `pushManager.subscribe` wants it: raw bytes, not base64url text.
 *
 * ⚠️ Returns an `ArrayBuffer` rather than a view — `applicationServerKey` is typed against
 * `ArrayBuffer` specifically, and a `Uint8Array` over a possibly-shared buffer does not satisfy it.
 */
export function decodeVapidKey(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** A `PushSubscription` reduced to the three fields the daemon stores. */
export function subscriptionFields(subscription: PushSubscription): { endpoint: string; p256dh: string; auth: string } {
  const encode = (buffer: ArrayBuffer | null): string => {
    const bytes = new Uint8Array(buffer ?? new ArrayBuffer(0))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return {
    endpoint: subscription.endpoint,
    p256dh: encode(subscription.getKey('p256dh')),
    auth: encode(subscription.getKey('auth'))
  }
}
