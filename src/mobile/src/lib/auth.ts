/**
 * The phone app's half of pairing. The device token lives in `localStorage` under one key and
 * is never shown again after pairing — the pair screen redeems the code and forgets it.
 *
 * ⛔ The store takes its storage as a parameter so the 401 state machine is unit-testable without
 * a DOM. Production passes `localStorage`.
 */
export interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DEVICE_TOKEN_KEY = 'warmstart.device-token'

export interface TokenStore {
  get(): string | null
  set(token: string): void
  clear(): void
}

export function createTokenStore(storage: TokenStorage): TokenStore {
  return {
    get: () => storage.getItem(DEVICE_TOKEN_KEY),
    set: (token: string) => storage.setItem(DEVICE_TOKEN_KEY, token),
    clear: () => storage.removeItem(DEVICE_TOKEN_KEY)
  }
}

/**
 * Which HTTP failures mean "pair again". A 401 is the revoked-or-unknown device; anything else
 * (403, 404, 429, 5xx, unreachable) is a problem with this call, and clearing the token over it
 * would log the operator out for a server hiccup.
 */
export function isPairingFailure(status: number | null): boolean {
  return status === 401
}
