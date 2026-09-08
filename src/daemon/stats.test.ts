import { describe, expect, it } from 'vitest'
import { median, medianFloat } from './stats.js'

describe('median', () => {
  it('returns null rather than a measurement for an empty series', () => {
    expect(median([])).toBeNull()
    expect(medianFloat([])).toBeNull()
  })

  it('sorts without changing its input and rounds only integral series', () => {
    const values = [9, 1, 4, 7]
    expect(median(values)).toBe(6)
    expect(medianFloat(values)).toBe(5.5)
    expect(values).toEqual([9, 1, 4, 7])
  })
})
