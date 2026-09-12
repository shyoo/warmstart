import { describe, expect, it } from 'vitest'
import { mergedHeadMayRetire, normalizePullRequest } from './deliveries.js'

const SHA = 'a'.repeat(40)

describe('pull request observations', () => {
  it('distinguishes open, closed without merge, and squash-merged delivery', () => {
    const identity = { baseRefName: 'main', headRefName: 'warmstart/t375-work', headRefOid: SHA }
    expect(normalizePullRequest({ ...identity, state: 'OPEN' }).state).toBe('open')
    expect(normalizePullRequest({ ...identity, state: 'CLOSED' }).state).toBe('closed_unmerged')
    expect(normalizePullRequest({
      ...identity,
      state: 'MERGED',
      mergedAt: '2026-09-12T00:00:00Z',
      mergeCommit: { oid: 'b'.repeat(40) }
    })).toEqual({
      state: 'merged',
      target: 'main',
      branch: 'warmstart/t375-work',
      headSha: SHA,
      mergeSha: 'b'.repeat(40)
    })
  })

  it('refuses a merged observation that cannot name its accepted commit', () => {
    expect(() => normalizePullRequest({
      state: 'MERGED',
      baseRefName: 'main',
      headRefName: 'warmstart/t375-work',
      headRefOid: SHA,
      mergedAt: '2026-09-12T00:00:00Z'
    })).toThrow(/without its merge commit/)
  })

  it('retires only the exact accepted head when no worktree holds it', () => {
    expect(mergedHeadMayRetire(SHA, SHA, null)).toBe(true)
    expect(mergedHeadMayRetire('b'.repeat(40), SHA, null)).toBe(false)
    expect(mergedHeadMayRetire(SHA, SHA, 'C:/work/ws1')).toBe(false)
  })
})
