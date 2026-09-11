import { describe, expect, it } from 'vitest'
import type { QualityKey } from '@shared/quality.js'
import { groupKeys } from './QualityModel.js'

function key(adapterId: string, model: string | null, samples = 1): QualityKey {
  return {
    adapterId,
    model,
    samples,
    clean: samples,
    mixedAuthorship: 0,
    blindingLeaks: 0,
    composite: 7,
    cleanComposite: 7,
    best: 7,
    worst: 7,
    dimensions: {},
    lastGradedAt: null
  }
}

/**
 * t361: the scored table was one flat list ordered by score, which put *Opus 5 · Claude Code* three
 * rows away from *Sonnet 5 · Claude Code* and left the reader to regroup it by eye.
 */
describe('groupKeys', () => {
  const labels = { 'claude-code': 'Claude Code', 'openai-compatible': 'Codex CLI' }

  it('groups by agent, agents by label, models by label within each', () => {
    const groups = groupKeys(
      [
        key('openai-compatible', 'gpt-5.6'),
        key('claude-code', 'claude-sonnet-5'),
        key('claude-code', 'claude-opus-5')
      ],
      labels
    )
    expect(groups.map((g) => g.label)).toEqual(['Claude Code', 'Codex CLI'])
    expect(groups[0]?.keys.map((k) => k.model)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('sums the reviews under each agent and puts an unrecorded model last in its group', () => {
    const groups = groupKeys([key('claude-code', null, 2), key('claude-code', 'claude-opus-5', 3)], labels)
    expect(groups[0]?.reviews).toBe(5)
    expect(groups[0]?.keys.map((k) => k.model)).toEqual(['claude-opus-5', null])
  })

  it('names an adapter this build no longer labels by its id rather than dropping it', () => {
    expect(groupKeys([key('gone', 'm')], labels)[0]?.label).toBe('gone')
  })
})
