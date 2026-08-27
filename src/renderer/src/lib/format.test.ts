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

describe('a provider that has no usage probe at all', () => {
  it('says the reading is not reported, never that it is unknown', () => {
    // ⛔ A fifth state, and collapsing it into the fourth is what made a healthy Antigravity worker
    // read as broken. "unknown" is the word for a reading somebody can go and get; this provider
    // exposes usage only inside an interactive session or a running IDE, so there is nothing to
    // press, ever. Measured 2026-08-27: the operator's report was "antigravity's usage quota seems
    // always shown up as unknown" — which was true, and which the panel had no way of explaining.
    const gap = quotaGap({ windows: [], error: 'Antigravity exposes usage only…' }, 'none')
    expect(gap?.label).toBe('not reported')
    expect(gap?.hint).toMatch(/nothing to retry/i)
    // ⚠️ And it must not advise an action, because there is not one.
    expect(gap?.hint).not.toMatch(/probe again|start a session/i)
  })

  it('still uses the ordinary wording for a provider that does have a probe', () => {
    expect(quotaGap({ windows: [], error: 'EACCES' }, 'cli')?.label).toBe('unknown')
    expect(quotaGap(null, 'cli')?.label).toBe('never probed')
  })

  it('is unchanged when the caller does not know the adapter', () => {
    // The parameter is optional; every existing caller keeps its behaviour.
    expect(quotaGap({ windows: [], error: 'EACCES' })?.label).toBe('unknown')
  })
})
