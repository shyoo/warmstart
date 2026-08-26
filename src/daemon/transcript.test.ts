import { describe, expect, it } from 'vitest'
import { contextOf, sumUsage } from './transcript.js'
import { encodeProjectDir } from './adapters/claude-code.js'

/**
 * Metering has to be exact - every scheduling gate downstream is arithmetic over these numbers, and
 * the three traps in docs/cost-model.md §6 are all silent when you get them wrong. These fixtures
 * are shaped from real transcript records sampled 2026-08-25.
 */

describe('sumUsage', () => {
  it('sums iterations[] and ignores the top level, which excludes compaction sampling', () => {
    // The top level reports one iteration's worth; iterations[] carries both. Reading the top level
    // undercounts exactly the events that matter most.
    const totals = sumUsage({
      input_tokens: 2,
      output_tokens: 690,
      cache_read_input_tokens: 186_145,
      cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 },
      iterations: [
        {
          input_tokens: 2,
          output_tokens: 690,
          cache_read_input_tokens: 186_145,
          cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 }
        },
        {
          input_tokens: 0,
          output_tokens: 5631,
          cache_read_input_tokens: 331_874,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }
        }
      ]
    })

    expect(totals.output).toBe(690 + 5631)
    expect(totals.cacheRead).toBe(186_145 + 331_874)
    expect(totals.cacheWrite1h).toBe(3981)
  })

  it('falls back to the top level when there are no iterations', () => {
    const totals = sumUsage({
      input_tokens: 12,
      output_tokens: 40,
      cache_read_input_tokens: 900,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 25 }
    })
    expect(totals).toMatchObject({ input: 12, output: 40, cacheRead: 900 })
  })

  it('keeps the two cache TTLs apart, because they price at 2.0x and 1.25x', () => {
    const totals = sumUsage({
      cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 1000 }
    })
    expect(totals.cacheWrite1h).toBe(4000)
    expect(totals.cacheWrite5m).toBe(1000)
  })

  it('attributes an undifferentiated older cache_creation to the default TTL rather than losing it', () => {
    const totals = sumUsage({ cache_creation_input_tokens: 2048 })
    expect(totals.cacheWrite1h).toBe(2048)
    expect(totals.cacheWrite5m).toBe(0)
  })

  it('reads thinking tokens once per turn, not once per iteration', () => {
    const totals = sumUsage({
      output_tokens_details: { thinking_tokens: 237 },
      iterations: [{ output_tokens: 100 }, { output_tokens: 200 }]
    })
    expect(totals.thinking).toBe(237)
    expect(totals.output).toBe(300)
  })
})

describe('contextOf', () => {
  it('counts everything the model was holding when it answered', () => {
    const totals = sumUsage({
      input_tokens: 2,
      cache_read_input_tokens: 186_145,
      cache_creation: { ephemeral_1h_input_tokens: 3981, ephemeral_5m_input_tokens: 0 }
    })
    expect(contextOf(totals)).toBe(190_128)
  })
})

describe('encodeProjectDir', () => {
  it('matches the on-disk name Claude Code uses', () => {
    // Verified against a real transcript directory on 2026-08-25: every character that is not a
    // letter or a digit becomes a dash, including the drive colon and every separator.
    expect(encodeProjectDir('C:\\code\\my_project')).toBe('C--code-my-project')
    expect(encodeProjectDir('/home/x/proj.v2')).toBe('-home-x-proj-v2')
  })
})
