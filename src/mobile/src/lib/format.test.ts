import { describe, expect, it } from 'vitest'
import { quotaAge, quotaLine, relTime } from './format.js'

const NOW = 1_700_000_000_000

describe('relTime', () => {
  it('reads both directions with the units a countdown needs', () => {
    expect(relTime(NOW, NOW)).toBe('just now')
    expect(relTime(NOW + 5 * 60_000, NOW)).toBe('in 5m')
    expect(relTime(NOW - 2 * 60_000, NOW)).toBe('2m ago')
    expect(relTime(NOW + 2 * 3_600_000, NOW)).toBe('in 2h')
    expect(relTime(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
  })
})

describe('quotaLine', () => {
  it('names every window with its percent, and says so when there are none', () => {
    expect(quotaLine([{ label: '5h', percent: 62.4 }, { label: '7d', percent: 41 }])).toBe('5h 62% · 7d 41%')
    expect(quotaLine([])).toBe('no windows')
  })
})

describe('quotaAge', () => {
  it('reads the age, never a bare number', () => {
    expect(quotaAge(NOW - 120_000, NOW)).toBe('read 2m ago')
    expect(quotaAge(null, NOW)).toBe('no reading')
  })
})
