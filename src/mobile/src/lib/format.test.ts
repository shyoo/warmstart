import { describe, expect, it } from 'vitest'
import { duration, price, quotaAge, quotaLine, quotaTone, relTime, shortTitle, statusTone } from './format.js'

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

describe('phone row formatting', () => {
  it('prefers a summary and safely shortens paragraph prompts', () => {
    expect(shortTitle('  Short summary  ', 'long prompt')).toBe('Short summary')
    expect(shortTitle(null, 'one\n two   three', 12)).toBe('one two thr…')
  })

  it('formats moving active time and priced beliefs compactly', () => {
    expect(duration(30_000, NOW - 90_000, NOW)).toBe('2m')
    expect(duration(3_600_000, null, NOW)).toBe('1h')
    expect(price(null)).toBe('n/a')
    expect(price(0.004)).toBe('<$0.01')
    expect(price(1.2, true, true)).toBe('~$1.20+')
  })

  it('maps state and quota pressure to the shared visual vocabulary', () => {
    expect(statusTone('running')).toBe('active')
    expect(statusTone('awaiting_human')).toBe('human')
    expect(statusTone('completed')).toBe('success')
    expect(quotaTone(74.9)).toBe('ok')
    expect(quotaTone(75)).toBe('warn')
    expect(quotaTone(92)).toBe('danger')
  })
})
