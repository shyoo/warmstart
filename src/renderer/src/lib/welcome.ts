import { appKey } from './storagekeys'

const WELCOME_KEY = appKey('welcomeComplete')

export function welcomePending(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(WELCOME_KEY) !== 'true'
  } catch {
    return false
  }
}

export function completeWelcome(): void {
  try {
    window.localStorage?.setItem(WELCOME_KEY, 'true')
  } catch {
    // A blocked preference must not trap somebody in the tour.
  }
}
