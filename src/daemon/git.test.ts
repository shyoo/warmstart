import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GIT_MAX_BUFFER, git, tryGit } from './git.js'

/**
 * The one git runner, and the whitespace rule that is the reason it is one.
 *
 * ⛔ Four modules carried a private copy of these four lines. Two ate leading whitespace and two did
 * not, and git has output where a leading space is data — which is a silent wrong answer, not a
 * crash. These checks are against a **real repository**, because *what does git actually print* is
 * the whole question and a stubbed child process would only prove the string handling.
 */

let dir: string
let repo: string

const run = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-git-'))
  repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: dir, stdio: 'ignore' })
  run(repo, 'config', 'user.email', 'test@example.com')
  run(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'kept.txt'), 'one\n')
  run(repo, 'add', '.')
  run(repo, 'commit', '-q', '-m', 'first')
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

describe('the shared git runner', () => {
  it('strips the trailing newline git puts on everything', async () => {
    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  /**
   * ⛔ The bug the four copies disagreed about. `git status --porcelain` reports an unstaged edit as
   * `␣M path` — the first column is the *index* status and the space means "nothing staged". A
   * `.trim()` here drops that column, turning ` M` into `M`, which reads as staged-modified, and on
   * a two-character code like ` R` it turns a rename into something else entirely. Worse, whatever
   * parses it by fixed offset then reads the filename starting one character in.
   */
  it('keeps the leading space porcelain uses as data', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\n')
    const out = await git(repo, ['status', '--porcelain'])
    expect(out).toBe(' M kept.txt')
    expect(out.startsWith(' M')).toBe(true)
    run(repo, 'checkout', '--', 'kept.txt')
  })

  it('keeps blank lines and indentation inside a multi-line answer', async () => {
    const out = await git(repo, ['log', '--format=%B', '-1'])
    expect(out).toBe('first')
  })

  it('throws when git does, rather than answering with an empty string', async () => {
    await expect(git(repo, ['rev-parse', 'no-such-ref'])).rejects.toThrow()
  })

  it('is generous enough not to make a large diff look like a broken git', () => {
    // ⚠️ A number, not a feeling: the three it replaced were 8MB, 8MB and 16MB, and the failure
    // when one is too small is ENOBUFS reported as git failing.
    expect(GIT_MAX_BUFFER).toBe(64 * 1024 * 1024)
  })
})

describe('tryGit', () => {
  it('answers null where git said no', async () => {
    expect(await tryGit(repo, ['rev-parse', 'no-such-ref'])).toBeNull()
  })

  it('answers normally where git said yes', async () => {
    expect(await tryGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  /** ⚠️ Not a general error swallow — a repository that is not one is still `null`, not a throw. */
  it('answers null outside a repository', async () => {
    expect(await tryGit(dir, ['rev-parse', 'HEAD'])).toBeNull()
  })
})
