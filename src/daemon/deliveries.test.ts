import { describe, expect, it } from 'vitest'
import { holderVerdict, mergedHeadMayRetire, normalizePullRequest, pullRequestUrlIn } from './deliveries.js'

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

/**
 * ⛔ t389, 2026-09-12. gh's "already exists" error quotes the whole `gh pr create` command line —
 * title and body — before its own URL, and the title named the issue being fixed. The first-URL
 * rule recorded `…/issues/133` as the delivery, and `gh pr view` failed on it every sweep.
 */
describe('finding the pull request URL in what gh printed', () => {
  it('takes gh’s own pull request URL, not an issue URL the quoted command line mentioned first', () => {
    const msg =
      'Command failed: C:\\Program Files\\GitHub CLI\\gh.EXE pr create --title t389: Can you help fixing ' +
      'https://github.com/shyoo/awardtracker/issues/133 ? --body See https://github.com/shyoo/awardtracker/issues/133\n' +
      'a pull request for branch "warmstart/t389-x" into branch "main" already exists:\n' +
      'https://github.com/shyoo/awardtracker/pull/139\n'
    expect(pullRequestUrlIn(msg)).toBe('https://github.com/shyoo/awardtracker/pull/139')
  })

  it('finds nothing where there is no pull request, rather than the nearest URL', () => {
    expect(pullRequestUrlIn('see https://github.com/shyoo/awardtracker/issues/133')).toBeUndefined()
  })

  it('reads the plain URL `gh pr create` prints on success', () => {
    expect(pullRequestUrlIn('https://github.com/o/r/pull/7\n')).toBe('https://github.com/o/r/pull/7')
  })
})

/**
 * ⛔ Which worktree a merged branch may be stepped off. t389's branch was held by the operator's own
 * trunk; the sweep refused in silence for as long as that lasted. Refusing is still right there — what
 * changed is that the refusal names the checkout and the command.
 */
describe('a worktree standing on a merged branch', () => {
  const base = { branch: 'warmstart/t389-x', target: 'main', heldBy: 'C:/Dev/awardtracker' }

  it('never switches a checkout that is not a pool member, and says what to run there', () => {
    const verdict = holderVerdict({ ...base, poolMember: false, claimed: false, dirty: false })
    expect(verdict).toEqual({
      detach: false,
      reason: expect.stringContaining('`C:/Dev/awardtracker` has `warmstart/t389-x` checked out') as string
    })
    expect(verdict.detach === false && verdict.reason).toContain('`git switch main`')
  })

  it('leaves a pool member a task is holding, and one with uncommitted files', () => {
    expect(holderVerdict({ ...base, poolMember: true, claimed: true, dirty: false }).detach).toBe(false)
    expect(holderVerdict({ ...base, poolMember: true, claimed: false, dirty: true }).detach).toBe(false)
  })

  it('steps an idle, clean pool member off it', () => {
    expect(holderVerdict({ ...base, poolMember: true, claimed: false, dirty: false })).toEqual({ detach: true })
  })
})
