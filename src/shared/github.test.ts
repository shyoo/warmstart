import { describe, expect, it } from 'vitest'
import { cloneDirectoryName, cloneSourceFor, parseGitHubRepo } from './github'

/**
 * ⛔ The two halves of a fork's pull request — `--repo <owner/repo>` and `--head <owner>:<branch>` —
 * are read out of remote URLs by this parser, so every spelling git or gh writes a remote in has to
 * come out the same, and nothing that is not github.com may come out at all.
 */
describe('reading a GitHub repository (t897)', () => {
  it('reads every spelling a remote or a person uses', () => {
    const want = { owner: 'Optiscaler-Client', repo: 'Optiscaler-Client' }
    expect(parseGitHubRepo('Optiscaler-Client/Optiscaler-Client')).toEqual(want)
    expect(parseGitHubRepo('https://github.com/Optiscaler-Client/Optiscaler-Client')).toEqual(want)
    expect(parseGitHubRepo('https://github.com/Optiscaler-Client/Optiscaler-Client.git')).toEqual(want)
    expect(parseGitHubRepo('https://github.com/Optiscaler-Client/Optiscaler-Client/')).toEqual(want)
    expect(parseGitHubRepo('git@github.com:Optiscaler-Client/Optiscaler-Client.git')).toEqual(want)
    expect(parseGitHubRepo('ssh://git@github.com/Optiscaler-Client/Optiscaler-Client.git')).toEqual(want)
  })

  it('reads nothing that is not a repository on github.com', () => {
    expect(parseGitHubRepo('C:\\Dev\\thing')).toBeNull()
    expect(parseGitHubRepo('/srv/git/thing.git')).toBeNull()
    expect(parseGitHubRepo('./a/b')).toBeNull()
    expect(parseGitHubRepo('https://gitlab.com/a/b')).toBeNull()
    expect(parseGitHubRepo('https://github.com/a/b/tree/main')).toBeNull()
    expect(parseGitHubRepo('')).toBeNull()
  })

  it('clones GitHub over https and anything else verbatim', () => {
    expect(cloneSourceFor('a/b')).toBe('https://github.com/a/b.git')
    expect(cloneSourceFor(' C:\\repos\\b.git ')).toBe('C:\\repos\\b.git')
  })

  it('names the clone directory the way git clone would', () => {
    expect(cloneDirectoryName('git@github.com:a/Some.Repo.git')).toBe('Some.Repo')
    expect(cloneDirectoryName('C:\\repos\\thing.git')).toBe('thing')
    expect(cloneDirectoryName('')).toBeNull()
  })
})
