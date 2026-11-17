import { afterEach, describe, expect, it } from 'vitest'
import { antigravityEnv } from './adapters/antigravity-cli.js'

/**
 * t1400: agy's background auto-updater opened a visible Windows Terminal window during quota probes.
 * The value is `true` because agy 1.5.10 ignored `1` (measured 2026-11-16, see `antigravityEnv`).
 */
describe('antigravityEnv', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('turns off agy’s auto-updater with the one value agy accepts', () => {
    expect(antigravityEnv().AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
  })

  it('overrides an inherited value agy would not honour', () => {
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '1'
    expect(antigravityEnv().AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
  })

  it('still drops a vendor API key', () => {
    process.env.GEMINI_API_KEY = 'leaked'
    expect(antigravityEnv().GEMINI_API_KEY).toBeUndefined()
  })
})
