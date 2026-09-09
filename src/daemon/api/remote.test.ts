import { describe, expect, it } from 'vitest'
import { pairingUrl } from './remote.js'

describe('pairingUrl', () => {
  it('keeps the one-time code in the phone app hash route', () => {
    expect(pairingUrl('https://machine.tailnet.ts.net:8787', 'AB C/12')).toBe(
      'https://machine.tailnet.ts.net:8787/#/pair?code=AB%20C%2F12'
    )
  })
})
