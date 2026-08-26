import { describe, expect, it } from 'vitest'
import { quotaGap } from './format'

describe('quotaGap', () => {
  it('says what would produce a reading when the account has never been used', () => {
    const gap = quotaGap({
      windows: [],
      error: 'no cachedUsageUtilization in .claude.json'
    })
    expect(gap?.label).toBe('no usage data yet')
    // ⛔ The hint has to name the action. "unknown" was already true and already useless.
    expect(gap?.hint).toMatch(/start a session/i)
    // The adapter's own words survive, so a real failure is still diagnosable from the tooltip.
    expect(gap?.hint).toContain('cachedUsageUtilization')
  })

  it('keeps an unrecognised probe failure as a failure rather than as advice', () => {
    const gap = quotaGap({ windows: [], error: 'EACCES reading .claude.json' })
    expect(gap?.label).toBe('unknown')
    expect(gap?.hint).toContain('EACCES')
  })

  it('distinguishes never-probed from probed-and-empty', () => {
    expect(quotaGap(null)?.label).toBe('never probed')
  })

  it('refuses to show a stale number as current, and says how old it is', () => {
    const gap = quotaGap({ windows: [{}], ageMs: 20 * 60 * 1000, stale: true })
    expect(gap?.label).toBe('stale')
    expect(gap?.hint).toContain('20m ago')
  })

  it('returns null when there is a real number for the caller to render', () => {
    expect(quotaGap({ windows: [{}], ageMs: 1000, stale: false })).toBeNull()
  })
})
