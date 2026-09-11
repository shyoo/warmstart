import { describe, expect, it } from 'vitest'
import { qualityWho } from './Tasks.js'

/**
 * The Quality cell's tooltip names who produced the number. ⚠️ Before t359 a task rated only by
 * the operator showed `—` in the column at all; now that the rating is in the mean, the tooltip must
 * not credit it to "another agent".
 */
describe('qualityWho', () => {
  it('names the operator when the only grade is theirs', () => {
    expect(qualityWho({ qualityReviewCount: 1, qualityManualCount: 1, qualityReviewer: null })).toBe('Your rating')
  })

  it('names the peer adapter for a single peer review', () => {
    expect(qualityWho({ qualityReviewCount: 1, qualityManualCount: 0, qualityReviewer: 'openai-compatible' })).toBe(
      'Scored by openai-compatible'
    )
    expect(qualityWho({ qualityReviewCount: 1, qualityManualCount: 0, qualityReviewer: null })).toBe(
      'Scored by another agent'
    )
  })

  it('says how the average splits when the rating is one of several grades', () => {
    expect(qualityWho({ qualityReviewCount: 2, qualityManualCount: 1, qualityReviewer: 'openai-compatible' })).toBe(
      'Average of 2 grades (1 peer review and your rating)'
    )
    expect(qualityWho({ qualityReviewCount: 3, qualityManualCount: 1, qualityReviewer: 'openai-compatible' })).toBe(
      'Average of 3 grades (2 peer reviews and your rating)'
    )
    expect(qualityWho({ qualityReviewCount: 2, qualityManualCount: 0, qualityReviewer: 'openai-compatible' })).toBe(
      'Average of 2 grades'
    )
  })
})
