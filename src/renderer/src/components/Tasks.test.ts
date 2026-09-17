import { describe, expect, it } from 'vitest'
import { prBannerHeading, prLabelFrom, qualityWho } from './Tasks.js'

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

describe('prBannerHeading', () => {
  it('formats single and multiple pending pull request headings', () => {
    expect(prBannerHeading(1)).toBe('Pending pull request')
    expect(prBannerHeading(2)).toBe('2 pending pull requests')
    expect(prBannerHeading(5)).toBe('5 pending pull requests')
  })
})

describe('prLabelFrom', () => {
  it('extracts PR number from GitHub pull request URLs', () => {
    expect(prLabelFrom('https://github.com/shyoo/awardtracker/pull/375')).toBe('PR #375')
    expect(prLabelFrom('https://github.com/owner/repo/pull/1')).toBe('PR #1')
  })

  it('falls back to PR when URL does not contain pull number', () => {
    expect(prLabelFrom('https://github.com/owner/repo')).toBe('PR')
  })
})

