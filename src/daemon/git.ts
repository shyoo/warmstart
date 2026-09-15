import { run } from './spawn.js'
import { spawnEnv, which } from './which.js'

/**
 * The one way this daemon shells out to git.
 *
 * ⛔ **One runner, because four of them disagreed.** `landing.ts`, `review.ts`, `taskcommits.ts` and
 * `worktrees.ts` each carried a private `git(cwd, args)` — the same four lines, differing only in a
 * `maxBuffer` (8MB, 16MB, 64MB) nobody had chosen on purpose and in *how much whitespace they ate*.
 * Two called `.trim()` and two called `.replace(/\s+$/, '')`, which are not the same function: `trim`
 * removes **leading** whitespace too, and git has output where a leading space is data. `git status
 * --porcelain` reports an unstaged edit as `␣M file.ts`, so a `trim()` on that turns a modified file
 * into a renamed one and drops the first character of a filename off the front of a report. That
 * exact bug was found and fixed once in `worktrees.ts`; the other three copies were never told.
 *
 * ⚠️ **Trailing only, always.** Callers want the newline git puts at the end of everything gone, and
 * nothing else. Anything that genuinely wants the leading whitespace gone can say so at its own call
 * site, where the reason is visible.
 *
 * ⚠️ **One buffer, and it is the largest of the four.** The three sizes were a rough guess at the
 * output each caller expected, and the failure mode when the guess is low is `ENOBUFS` — a landing
 * that reports git as broken because a diff was big. 64MB costs nothing until it is used, and the
 * commands that could approach it (`git diff` over a whole branch) already ran under it.
 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** Run git in `cwd` and return stdout with trailing whitespace removed. Throws if git does. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const binary = which('git') ?? 'git'
  const { stdout } = await run(binary, args, { cwd, env: spawnEnv(), maxBuffer: GIT_MAX_BUFFER })
  return stdout.replace(/\s+$/, '')
}

/**
 * The same, answering `null` where git would have thrown.
 *
 * ⚠️ For questions whose *no* is an ordinary answer — `rev-parse` on a ref that does not exist, a
 * remote that is not configured. ⛔ Not a general error swallow: a caller that cannot tell "git said
 * no" from "git could not run" should use `git` and let the failure surface.
 */
export async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}
